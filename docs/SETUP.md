# Deployment setup from zero

This guide tells you how to deploy Lorem Store to your own Cloudflare account through GitHub Actions. Every name in this guide comes from the code:

- `wrangler.jsonc`
- `tools/cloudflare-config.mjs` and `tools/cloudflare-secrets.mjs`
- `tools/staging-verified.mjs` and `tools/configure-staff-key.mjs`
- `.github/workflows/*.yml`
- `.dev.vars.example`

Menu names in the GitHub, Cloudflare and Google dashboards can change. The menu paths in this guide are approximate.

For local work you do not need this guide. See the quick start in [README.md](../README.md).

## Overview

| Environment | Branch | Worker | D1 database | Host | Manager access |
| --- | --- | --- | --- | --- | --- |
| Staging | `staging` | `storefront-skeleton-staging` | `storefront-skeleton-staging` | `staging.example.com` | Cloudflare Access on the whole host |
| Production | `main` | `storefront-skeleton` | `storefront-skeleton` | `example.com` | Cloudflare Access on the manager paths |

- Staging and production use one Cloudflare account. Each has its own Worker, D1 database, R2 buckets and API token.
- A push to `staging` deploys staging (`staging.yml`).
- A merge into `main` deploys production (`ci.yml`). This happens only if the promoted branch head is live on staging.
- Staging has no cron. Production runs the Worker cron `*/5 * * * *` (supplier sync and order data retention).

## 1. Prerequisites

| Item | Use |
| --- | --- |
| Node.js 22.13 or later, npm | Local commands (`package.json` `engines`) |
| A GitHub account | The repository and GitHub Actions |
| A Cloudflare account | Workers, D1, R2, Zero Trust Access |
| A domain on Cloudflare DNS | Production host and staging host |
| A Google Cloud project | OAuth clients for customer and staff sign-in |
| Wrangler (in `devDependencies`) | Run it with `npx wrangler`, after `npm ci` |
| Optional: a MyDrop dropshipper account | Supplier API key (`MYDROP_API_KEY`) |

Log in to Wrangler for the provisioning steps:

```bash
npm ci
npx wrangler login
npx wrangler whoami
```

### 1.1 Use your own domain

The staging host and the default production origin are fixed in the code. Before you deploy to a real domain, replace `example.com` in these places, in one reviewed PR:

| File | Value to change |
| --- | --- |
| `wrangler.jsonc` | `env.staging.vars`: `OIDC_REDIRECT_ORIGINS`, `STAFF_OIDC_REDIRECT_ORIGINS`, `ADMIN_HOST` |
| `tools/cloudflare-config.mjs` | `DEFAULT_OIDC_REDIRECT_ORIGINS`, `STAGING_ORIGIN`, `STAGING_ADMIN_HOST` |
| `.github/workflows/staging.yml` | The two `https://staging.example.com` values in the step "Access gate smoke checks" |
| `apps/web/index.html` | The `og:image` URL |
| `tests/backend/*.test.js` | Tests that assert these values (for example `staging-config.test.js`, `staging-worker.test.js`) |

Then run `npm run check` and `npm test`. If you also change the Worker names, change `WORKER_NAME` in `tools/configure-staff-key.mjs`, the `STAGING_*` constants in `tools/cloudflare-config.mjs`, the worker name in `apps/api/src/infra.js`, `ENVS` in `tools/card-thumbnails-core.mjs` and the literal names in `staging.yml`.

## 2. GitHub repository

1. Create a new repository. Push this code to the branch `main`.
2. Do not create the branch `staging` yet. Its creation is a push, and it starts `staging.yml` at once. You create it in step 8.1, after the secrets are set.
3. Open **Settings > General > Pull Requests**:
   1. Turn on **Allow merge commits**. Use **Create a merge commit** for every merge. The staging gate needs the task branch head to be an ancestor of the staging deploy commit. A squash merge or a rebase merge into `staging` breaks this.
   2. Turn **off** **Automatically delete head branches**. You promote the same branch to `main` after the staging test. GitHub must not delete it after the `staging` merge.
4. Open **Settings > Actions > General**:
   1. Allow GitHub Actions for the repository. If you allow only selected actions, allow `actions/checkout`, `actions/setup-node`, `actions/upload-artifact`, `actions/download-artifact` and `actions/github-script`.
   2. Under **Workflow permissions**, select **Read repository contents and packages permissions**. Each workflow declares its own `permissions` block (`contents: read`, and `actions: read`, `pull-requests: read` for the gate).
5. Optional: add branch protection for `main` and `staging` if your plan supports it. Require the CI jobs `Verify tested commit` and `Require feature tested on staging`.

> The workflows use repository secrets and variables, not GitHub environments. All staging values have the prefix `STAGING_`.

## 3. Cloudflare resources

Get the account ID from the Cloudflare dashboard (the account overview) or from `npx wrangler whoami`. It is 32 hex characters. Put it in the secret `CLOUDFLARE_ACCOUNT_ID`.

### 3.1 D1 databases

```bash
npx wrangler d1 create storefront-skeleton
npx wrangler d1 create storefront-skeleton-staging
npx wrangler d1 info storefront-skeleton-staging
```

| Database | Record the UUID in |
| --- | --- |
| `storefront-skeleton` | Variable `CLOUDFLARE_D1_DATABASE_ID` |
| `storefront-skeleton-staging` | Variable `STAGING_D1_DATABASE_ID` |

- Do not put the real UUID in `wrangler.jsonc`. The committed UUID is a placeholder. The deploy writes the real UUID into a generated config file (`wrangler.production.json`, `wrangler.staging.json`).
- The staging deploy checks that the name `storefront-skeleton-staging` resolves to `STAGING_D1_DATABASE_ID`. The two UUIDs must be different.
- You do not apply migrations by hand. Each deploy applies them.

### 3.2 R2 buckets

R2 is optional for a first deploy, but uploads, cutouts and thumbnails return `503` without the `MEDIA` binding. The Nova Poshta picker needs its own bucket in production.

```bash
npx wrangler r2 bucket create storefront-skeleton-media
npx wrangler r2 bucket create storefront-skeleton-media-staging
npx wrangler r2 bucket create storefront-skeleton-np-catalog
npx wrangler r2 bucket create storefront-skeleton-np-catalog-staging
```

| Bucket | Binding | Variable | Rule |
| --- | --- | --- | --- |
| `storefront-skeleton-media` | `MEDIA` (production) | `CLOUDFLARE_R2_BUCKET` | Any valid name. `storefront-skeleton-media` is the default of the thumbnail tool. |
| `storefront-skeleton-media-staging` | `MEDIA` (staging) | `STAGING_R2_BUCKET` | Must be exactly this name. Needs `CLOUDFLARE_R2_BUCKET` set. |
| `storefront-skeleton-np-catalog` | `NP_CATALOG` (production) | `NP_CATALOG_BUCKET` | Any valid name. Must differ from `CLOUDFLARE_R2_BUCKET`. |
| `storefront-skeleton-np-catalog-staging` | `NP_CATALOG` (staging) | `STAGING_NP_CATALOG_BUCKET` | Must be exactly this name. Needs `NP_CATALOG_BUCKET` set. |

If a variable is empty, the deploy does not add that binding.

### 3.3 API tokens

Create custom API tokens in the Cloudflare dashboard (user profile, API Tokens). Scope each token to your account only. The deploy tokens need no zone or DNS permission, because you add the custom domains in the dashboard (step 4).

The permissions below come from the commands that each workflow runs. Use the smallest set that works for you.

| Token | Secret | Account permissions | Used by |
| --- | --- | --- | --- |
| Production deploy | `CLOUDFLARE_API_TOKEN` | Workers Scripts: Edit; D1: Edit; Workers R2 Storage: Edit | `ci.yml` deploy (`wrangler deploy`, `wrangler d1 migrations apply --remote`), `configure-staff-key.yml` (Worker secrets API) |
| Staging deploy | `STAGING_CLOUDFLARE_API_TOKEN` | Workers Scripts: Edit; D1: Edit; Workers R2 Storage: Edit | `staging.yml` (`wrangler d1 list`, `wrangler d1 execute`, `wrangler r2 bucket info`, migrations, deploy) |
| Production thumbnails (optional) | `THUMBS_CLOUDFLARE_API_TOKEN` | D1: Edit; Workers R2 Storage: Edit | `card-thumbnails.yml` |
| Staging thumbnails (optional) | `STAGING_THUMBS_CLOUDFLARE_API_TOKEN` | D1: Edit; Workers R2 Storage: Edit | `card-thumbnails.yml` |
| Analytics (optional) | `CF_ANALYTICS_API_TOKEN`, `STAGING_CF_ANALYTICS_API_TOKEN` | Account Analytics: Read | Worker infrastructure page in the cabinet |

- Use a separate token for each row. You can then revoke one without the others.
- The Nova Poshta job does not use an API token. It uses an R2 S3 key pair (see step 9.1).
- If you do not use R2, the deploy tokens do not need the R2 permission.

## 4. Custom domains

The config has no `routes` entry. Staging sets `workers_dev: false` and `preview_urls: false`. Add the hosts in the dashboard after the first deploy of each Worker (step 8).

1. Create the Access applications first (step 5). A host must not be public before Access protects it.
2. Open **Workers & Pages > storefront-skeleton-staging > Settings > Domains & Routes**. Add the custom domain `staging.example.com`. Cloudflare creates the DNS record and the certificate.
3. Open **Workers & Pages > storefront-skeleton > Settings > Domains & Routes**. Add the custom domain `example.com` (and `www.example.com` if you need it).
4. On the staging Worker, make sure that the `workers.dev` route and Preview URLs are disabled.
5. Set the variable `CATALOG_PRODUCTION_URL` to `https://example.com`. Set `STAGING_URL` and `STAGING_ADMIN_URL` to `https://staging.example.com`. Then the smoke checks run on the next deploy.

> The production config does not set `workers_dev`. If the `workers.dev` route of `storefront-skeleton` stays on, the manager paths are reachable there without the Access application. The Worker still verifies the Access JWT on every manager request, so such a request fails. A later `wrangler deploy` can turn the route on again, because the config does not turn it off.

## 5. Cloudflare Zero Trust Access

1. Open **Zero Trust**. Find the team domain `<team>.cloudflareaccess.com` in the Zero Trust settings. Put the `<team>` part in the variable `CF_ACCESS_TEAM_NAME`. Both environments share it.
2. Add a login method (for example One-time PIN or Google) in **Settings > Authentication**.
3. Create the **production** application: **Access > Applications > Add > Self-hosted**.
   1. Domain `example.com` with these paths: `/admin`, `/admin/*`, `/api/admin/*`, `/api/auth/*`.
   2. Do not add other paths. The storefront, `/api/products`, `/api/health`, `/account`, `/api/account/*`, `/staff` and `/api/staff/*` must stay outside Access. The production smoke checks call some of them without a token.
   3. Add an Allow policy for the owner emails only. Every Access identity is an owner.
   4. Save. Copy the **Application Audience (AUD) Tag**. Put it in the variable `CF_ACCESS_AUD`.
4. Create the **staging** application: **Self-hosted**.
   1. Domain `staging.example.com`, empty path (the whole host).
   2. Add an Allow policy for the owners and the testers.
   3. Cookie settings: Binding Cookie off, SameSite Lax, HTTP Only on.
   4. Copy the AUD tag. Put it in the variable `STAGING_CF_ACCESS_AUD`. It must differ from `CF_ACCESS_AUD`.
5. Both AUD tags are 64 hex characters. The deploy fails if one has another format.

The Worker verifies the RS256 JWT itself, with issuer `https://<team>.cloudflareaccess.com`, the audience and the expiry. Without `CF_ACCESS_TEAM_NAME` and `CF_ACCESS_AUD`, manager routes fail closed.

## 6. Google OAuth clients

Customers and staff use different clients and different cookies. In **Google Cloud Console > APIs & Services**:

1. Configure the OAuth consent screen. Add `example.com` to the authorized domains. The scopes are `openid`, `email` and `profile`. If the publishing status is Testing, add your testers as test users.
2. Create the OAuth clients. Use the type **Web application** for each.

| Client | Authorized redirect URI | Client ID goes to | Client secret goes to |
| --- | --- | --- | --- |
| Customer, production | `https://example.com/api/account/google/callback` | Variable `GOOGLE_CLIENT_ID` | Secret `GOOGLE_CLIENT_SECRET` |
| Customer, staging | `https://staging.example.com/api/account/google/callback` | Variable `STAGING_GOOGLE_CLIENT_ID` | Secret `STAGING_GOOGLE_CLIENT_SECRET` |
| Staff, production | `https://example.com/api/staff/google/callback` | Variable `GOOGLE_STAFF_CLIENT_ID` | Secret `GOOGLE_STAFF_CLIENT_SECRET` |
| Staff, staging | `https://staging.example.com/api/staff/google/callback` | Variable `STAGING_GOOGLE_STAFF_CLIENT_ID` | Secret `STAGING_GOOGLE_STAFF_CLIENT_SECRET` |

3. Generate the session keys. Use a new random value for each key:

```bash
node -e "console.log(require('node:crypto').randomBytes(32).toString('base64url'))"
```

| Secret | Rule |
| --- | --- |
| `CUSTOMER_AUTH_HMAC_KEY`, `STAGING_CUSTOMER_AUTH_HMAC_KEY` | Not empty. Never share a key between environments. |
| `STAFF_AUTH_HMAC_KEY`, `STAGING_STAFF_AUTH_HMAC_KEY` | At least 32 characters. Must differ from the customer key of the same environment. |

- Production origins default to `https://example.com`. Set `OIDC_REDIRECT_ORIGINS` or `STAFF_OIDC_REDIRECT_ORIGINS` only for other origins: a comma-separated list of HTTPS origins with no path and no trailing slash.
- Staging origins are fixed to `https://staging.example.com`.
- Customer and staff sign-in are optional at deploy time. If a value is missing, the deploy writes a warning with the name, and that sign-in answers `503`.

## 7. GitHub secrets and variables

Add these in **Settings > Secrets and variables > Actions**. The list contains every `secrets.*` and `vars.*` name in `.github/workflows/*.yml`: 21 secrets and 18 variables. "Required" means that the workflow fails without it.

| Name | Type | Required | Where to get it |
| --- | --- | --- | --- |
| `CLOUDFLARE_ACCOUNT_ID` | Secret | Yes (all Cloudflare jobs) | Step 3 |
| `CLOUDFLARE_API_TOKEN` | Secret | Yes (production) | Step 3.3, production deploy token |
| `MYDROP_API_KEY` | Secret | Yes (production) | MyDrop dropshipper integrations (step 10). The production deploy refuses to run without it. |
| `CLOUDFLARE_D1_DATABASE_ID` | Variable | Yes (production and staging) | Step 3.1. Staging reads it to prove that its UUID differs. |
| `CF_ACCESS_TEAM_NAME` | Variable | Yes (production and staging) | Step 5.1 |
| `CF_ACCESS_AUD` | Variable | Yes (production and staging) | Step 5.3. Staging reads it to prove that its AUD differs. |
| `CLOUDFLARE_R2_BUCKET` | Variable | No; yes if `STAGING_R2_BUCKET` is set | Step 3.2 |
| `NP_CATALOG_BUCKET` | Variable | No; yes if `STAGING_NP_CATALOG_BUCKET` is set | Step 3.2 |
| `CATALOG_PRODUCTION_URL` | Variable | No | `https://example.com` after step 4. Enables production smoke checks. |
| `GOOGLE_CLIENT_ID` | Variable | No | Step 6 |
| `GOOGLE_CLIENT_SECRET` | Secret | No | Step 6 |
| `CUSTOMER_AUTH_HMAC_KEY` | Secret | No | Step 6.3 |
| `OIDC_REDIRECT_ORIGINS` | Variable | No | Step 6. Default `https://example.com`. |
| `GOOGLE_STAFF_CLIENT_ID` | Variable | No | Step 6 |
| `GOOGLE_STAFF_CLIENT_SECRET` | Secret | No | Step 6 |
| `STAFF_AUTH_HMAC_KEY` | Secret | No | Step 6.3, or the staff key job (step 9.3) |
| `STAFF_OIDC_REDIRECT_ORIGINS` | Variable | No | Step 6. Default `https://example.com`. |
| `TELEGRAM_CLIENT_SECRET` | Secret | No | Bound to the Worker if set. Telegram linking is not implemented. |
| `CF_ANALYTICS_API_TOKEN` | Secret | No | Step 3.3, analytics token |
| `THUMBS_CLOUDFLARE_API_TOKEN` | Secret | No | Step 3.3, production thumbnails token |
| `NP_CATALOG_R2_ACCESS_KEY_ID` | Secret | No | Step 9.1 |
| `NP_CATALOG_R2_SECRET_ACCESS_KEY` | Secret | No | Step 9.1 |
| `STAGING_CLOUDFLARE_API_TOKEN` | Secret | Yes (staging) | Step 3.3, staging deploy token |
| `STAGING_D1_DATABASE_ID` | Variable | Yes (staging) | Step 3.1 |
| `STAGING_CF_ACCESS_AUD` | Variable | Yes (staging) | Step 5.4 |
| `STAGING_R2_BUCKET` | Variable | No | Exactly `storefront-skeleton-media-staging` |
| `STAGING_NP_CATALOG_BUCKET` | Variable | No | Exactly `storefront-skeleton-np-catalog-staging` |
| `STAGING_URL` | Variable | No | Exactly `https://staging.example.com`, after step 4 |
| `STAGING_ADMIN_URL` | Variable | No | Exactly `https://staging.example.com`, after step 4 |
| `STAGING_GOOGLE_CLIENT_ID` | Variable | No | Step 6 |
| `STAGING_GOOGLE_CLIENT_SECRET` | Secret | No | Step 6 |
| `STAGING_CUSTOMER_AUTH_HMAC_KEY` | Secret | No | Step 6.3 |
| `STAGING_GOOGLE_STAFF_CLIENT_ID` | Variable | No | Step 6 |
| `STAGING_GOOGLE_STAFF_CLIENT_SECRET` | Secret | No | Step 6 |
| `STAGING_STAFF_AUTH_HMAC_KEY` | Secret | No | Step 6.3 |
| `STAGING_CF_ANALYTICS_API_TOKEN` | Secret | No | Step 3.3, analytics token |
| `STAGING_THUMBS_CLOUDFLARE_API_TOKEN` | Secret | No | Step 3.3, staging thumbnails token |
| `STAGING_NP_CATALOG_R2_ACCESS_KEY_ID` | Secret | No | Step 9.1 |
| `STAGING_NP_CATALOG_R2_SECRET_ACCESS_KEY` | Secret | No | Step 9.1 |

Rules:
- Staging never reads `MYDROP_API_KEY`, `CLOUDFLARE_API_TOKEN` or a production sign-in secret. Do not create a staging MyDrop secret.
- The deploy rejects `AUTH_DEV_BYPASS` and `DEV_STAFF_ROLE` in staging and production. Use them only in your local `.dev.vars`.
- Cloudflare keeps a Worker secret that a later deploy does not send. To remove one, delete it in the dashboard or with `npx wrangler secret delete`.

## 8. First deploy

### 8.1 Staging

1. Make sure that steps 3, 5 and 7 are complete for staging. Staging validation also needs `CLOUDFLARE_D1_DATABASE_ID` and `CF_ACCESS_AUD`. Leave `STAGING_URL` and `STAGING_ADMIN_URL` empty for now.
2. Create the branch `staging` from `main` and push it. If it already exists, run **Deploy staging** manually from `staging`. The workflow:
   1. Rejects any ref other than `refs/heads/staging`.
   2. Runs `npm run check`, `npm test` and `npm run build`.
   3. Validates all staging inputs and writes `wrangler.staging.json` (`node tools/cloudflare-config.mjs --staging`).
   4. Checks the D1 name and UUID, the R2 bucket and the migration history.
   5. Applies the migrations and deploys code, assets and secrets in one step (`node tools/cloudflare-secrets.mjs --staging-deploy`).
   6. If `STAGING_URL` is set, checks that the host redirects to `https://<team>.cloudflareaccess.com/`.
3. Add the staging custom domain (step 4). Set `STAGING_URL` and `STAGING_ADMIN_URL`. Run **Deploy staging** again. The Access smoke checks must pass.
4. Open `https://staging.example.com/admin`. Sign in through Access. You are an owner.
5. Optional: put demo data on staging. Create a supplier in the cabinet and import `fixtures/mydrop-demo.json`. Never copy production data to staging.

### 8.2 Production and the staging gate

`ci.yml` deploys production only when the `main` commit is the merge commit of a pull request, and the head of that pull request is already live on staging. The job `Require feature tested on staging` checks this with `tools/staging-verified.mjs`:

1. It finds the newest successful `staging.yml` run on the `staging` branch (event `push` or `workflow_dispatch`).
2. It checks that the PR head commit is that deploy commit or one of its ancestors.
3. On a PR into `main`, it gives an early result. On a push to `main`, it blocks the deploy.

So the first push of the code to `main` does not deploy production. The gate fails by design, because no pull request exists. To make the first production deploy:

1. Make sure that the production secrets and variables in step 7 are set.
2. Create a task branch from `main`, for example `task/first-release`. Add one commit (for example a change to `README.md`). A PR needs at least one commit.
3. Open a PR from the task branch into `staging`. Merge it with a merge commit. Wait for **Deploy staging** to pass. Test on staging.
4. Open a second PR from the **same, unchanged** branch into `main`. The check `Require feature tested on staging` must pass.
5. Merge it with a merge commit. `ci.yml` runs on `main`:
   1. `Verify tested commit`: check, test, build, local migrations, dry-run bundle.
   2. `Require feature tested on staging`: the gate again.
   3. `Deploy verified main to production`: rejects a superseded `main` commit, validates inputs (`node tools/cloudflare-config.mjs`), applies D1 migrations, deploys with `node tools/cloudflare-secrets.mjs --deploy`, then runs read-only smoke checks if `CATALOG_PRODUCTION_URL` is set.
6. Add the production custom domain (step 4). Set `CATALOG_PRODUCTION_URL`. Run **Deploy Cloudflare** (`deploy.yml`) from `main` to repeat the pipeline with smoke checks.

A new commit on the task branch must go through `staging` again before you promote it. Never merge `staging` into a task branch. The full rules are in [WORKFLOW.md](WORKFLOW.md).

## 9. Optional jobs

All optional jobs run only from `main`. Each job writes a notice and succeeds when its credentials are missing.

### 9.1 Nova Poshta catalog

`np-catalog.yml` runs daily at 00:30 UTC and on manual dispatch. It copies the Nova Poshta branch and postomat list into R2 with `tools/np-catalog-sync.mjs`. The Worker reads it through the `NP_CATALOG` binding. No Nova Poshta key is necessary.

1. Create the buckets and set `NP_CATALOG_BUCKET` and `STAGING_NP_CATALOG_BUCKET` (step 3.2). Deploy again, so that the Worker gets the binding.
2. In the R2 section of the dashboard, create one R2 API token for each bucket with **Object Read & Write**, scoped to that bucket only.
3. Put the key pairs in `NP_CATALOG_R2_ACCESS_KEY_ID`, `NP_CATALOG_R2_SECRET_ACCESS_KEY`, `STAGING_NP_CATALOG_R2_ACCESS_KEY_ID` and `STAGING_NP_CATALOG_R2_SECRET_ACCESS_KEY`.
4. Run **Nova Poshta catalog sync** manually from `main`. Read the step summary.

Locally, `npm run np:sync -- --out <dir>` writes to a directory and does not touch Cloudflare.

### 9.2 Card thumbnails

`card-thumbnails.yml` compresses the first photo of each published product into a WebP card thumbnail. The schedule (01:40 UTC) runs production only. A manual dispatch selects `production` or `staging`, a `limit` and `dry_run`.

1. Create `THUMBS_CLOUDFLARE_API_TOKEN` and `STAGING_THUMBS_CLOUDFLARE_API_TOKEN` (step 3.3). The job uses the variables `CLOUDFLARE_D1_DATABASE_ID`, `CLOUDFLARE_R2_BUCKET`, `STAGING_D1_DATABASE_ID` and `STAGING_R2_BUCKET`.
2. Run the job for `staging` with `dry_run` on. Read the summary. Run it again with `dry_run` off.
3. Do the same for `production`.

Details and rollback are in [MEDIA.md](MEDIA.md).

### 9.3 Production staff key

`configure-staff-key.yml` adds a missing production `STAFF_AUTH_HMAC_KEY` to the Worker `storefront-skeleton`. It never rotates an existing key.

1. Make sure that the current `main` head has a successful production deploy.
2. Run **Configure production staff key** from `main`. Select `configure-production-staff-key` as the confirmation.
3. The job generates 32 random bytes in memory and sends them to the Cloudflare Worker secrets API with `CLOUDFLARE_API_TOKEN`.

If you set the secret `STAFF_AUTH_HMAC_KEY` in GitHub, each deploy sends that value instead. Use one method only.

## 10. Supplier keys

| Supplier | Configuration | Where |
| --- | --- | --- |
| MyDrop | Secret `MYDROP_API_KEY` (production only) | MyDrop dropshipper account, Integrations. The Worker sends it in the `X-API-KEY` header. |
| EasyDrop | No secret. A manager pastes the prom-export link of each supplier in the cabinet. | The link has the form `https://easydrop.one/prom-export?key=<digits>&pid=<digits>`. The Worker stores the key in D1. |
| Manual | None | Managers create the products in the cabinet. |

Suppliers are optional for the shop, but the production deploy needs `MYDROP_API_KEY` to be a non-empty value. If you do not use MyDrop, set a placeholder value. MyDrop syncs then fail with an error for MyDrop suppliers only. Locally, put the key in `.dev.vars` as `MYDROP_API_KEY` (see `.dev.vars.example`). Details are in [INTEGRATIONS.md](INTEGRATIONS.md).

## 11. Troubleshooting

| Symptom | Cause | Action |
| --- | --- | --- |
| `Set repository secret ... before deploying` | A required secret is missing or has a line break. | Add the secret (step 7). Paste it without a trailing newline. |
| `Set CLOUDFLARE_D1_DATABASE_ID to the provisioned production D1 UUID.` | The variable is empty, malformed or the placeholder UUID. | Copy the UUID from `npx wrangler d1 info storefront-skeleton`. |
| `Configure CF_ACCESS_TEAM_NAME and the catalog Access application CF_ACCESS_AUD.` | Team name or AUD is missing or malformed. | Use only the `<team>` part. The AUD is 64 hex characters. |
| `STAGING_... must differ from ...` | A staging value equals the production value. | Create separate staging resources. |
| `STAGING_R2_BUCKET must be exactly storefront-skeleton-media-staging.` | The staging bucket names are fixed. | Use the exact name, or change the constants (step 1.1). |
| `Expected exactly one D1 database named storefront-skeleton-staging` | The staging database is missing, or the token sees another account. | Create it (step 3.1). Check `CLOUDFLARE_ACCOUNT_ID`. |
| `Staging D1 has migrations missing from this ref` | Staging got a migration from a branch that `main` does not have. | Recreate the staging D1, update `STAGING_D1_DATABASE_ID` and deploy again. |
| `... did not redirect to the Access login` or `host is exposed` | The staging Access application does not cover the whole host. | Fix the application (step 5.4). |
| `No successful staging deploy exists` or `head ... is not on staging` | The PR head is not live on staging. | Merge the same head into `staging` with a merge commit, wait for the deploy, then promote. |
| `Main commit ... is not the merge commit of a pull request` | Somebody pushed directly to `main`. | Promote through a PR (step 8.2). |
| `Main has advanced; this older tested commit will not replace production.` | A newer `main` commit exists. | Wait for the newest `main` run. |
| Staging deploy fails at `Verify the staging R2 bucket exists` | The bucket is missing, or the token has no R2 permission. | Create the bucket or add the permission. |
| Customer or staff sign-in answers `503` | Client ID, secret or HMAC key is missing, or the staff key is too short or equals the customer key. | Read the deploy warning. Set the values (step 6). |
| Google says `redirect_uri_mismatch` | The client has no redirect URI for this host. | Add the exact URI from step 6. |
| `/admin` answers `401` or `403` in production | Your identity is not in the Access policy, or the AUD is wrong. | Check the policy and `CF_ACCESS_AUD`. |
| Uploads answer `503` | No `MEDIA` binding. | Set `CLOUDFLARE_R2_BUCKET` or `STAGING_R2_BUCKET` and deploy again. |
| A scheduled job shows only a notice | Its credentials are not set. | Add them (step 9). This is the expected behavior. |
| GitHub deleted the task branch after the `staging` merge | Auto-delete of head branches is on. | Turn it off (step 2.3). Restore the branch from the PR page. |
