# ADR-0005: Staging environment at staging.example.com

Status: **Proposed** (the lead accepts or amends). Revised after review. This record authorizes no provisioning, spending, Access change or deployment. The lead provisions resources using the [provisioning checklist](#provisioning-checklist-for-the-lead) below. A separate task implements the repository changes.

Current code: staging now deploys on every push to the `staging` branch (`.github/workflows/staging.yml`), and production requires the promoted head to be live on staging (`tools/staging-verified.mjs`). Section (b) below records the original manual-dispatch decision.


## Owner amendment: production sample products

The owner approved one exception to "the production D1 must never leave its environment": a small, approved set of product rows was copied from production into the staging D1 to test picture normalization. Only `products` rows were copied, under a new staging-only supplier "Prod sample (staging copy)" with no MyDrop connection. No customer, staff, cart, audit or supplier-connection data was copied. Each copy's `photos` override was reset to `null`, so it shows the original supplier photo URLs and references no production R2 objects. Its `categoryId` was set explicitly. Any further copying needs a new owner decision.

## Owner amendment: same-host admin

This amendment supersedes the two-host manager design, separate manager AUD, and gate-host manager-path 404 described below. The owner requires the actual cabinet at `https://staging.example.com/admin`, with the same admin members as production and no redirect.

- One whole-host Access application protects `staging.example.com`, including `/admin`, `/admin/*`, `/api/admin/*`, `/api/auth/*`, assets and storefront routes. Its allow policy exactly preserves the current production admin identities; no tester/everyone/bypass rule is added.
- `STAGING_CF_ACCESS_AUD` is this staging application's audience, read from Cloudflare by exact hostname and verified against its policy. The Worker continues signature, issuer, audience and expiry validation on private requests. No production audience or unsigned header is trusted.
- `ADMIN_HOST` is `staging.example.com`. Admin HTML and private APIs use the same origin. Other hosts still receive 404 for manager paths. The older `staging-admin` resource is not an alternative manager entry and grants no access to the new audience.
- `STAGING_URL` and `STAGING_ADMIN_URL` both equal `https://staging.example.com`; their smoke checks request `/` and `/admin` respectively. Both must redirect anonymous visitors to the staging Access application.
- Keep SameSite Lax, HTTP Only on and Binding Cookie off. No overlapping path applications are needed. All existing noindex, isolated database/secrets, disabled preview URLs and no-sync rules remain.
- Provisioning now uses the one existing whole-host staging gate with the current admin allowlist, verifies its audience, updates the staging repository audience/admin URL, and dispatches the reviewed staging workflow. Production Access remains unchanged. Authenticated browser QA must confirm `/admin`, assets, `/api/auth/session` and private reads/mutations share the same Access identity.

The original two-host decision below is retained as historical rationale; its conflicting instructions no longer apply.

## Context

The lead wants to test features at `staging.example.com` before they merge into `main`. Merging into `main` deploys production automatically.

The current state:

- **Production pipeline.** `.github/workflows/ci.yml` verifies a commit. Its `deploy` job runs only for `refs/heads/main` on `push` or `workflow_dispatch`. It validates inputs with `tools/cloudflare-config.mjs`, which writes the ignored `wrangler.production.json`. It applies remote D1 migrations, then deploys code, assets and the `MYDROP_API_KEY` secret in one version with `tools/cloudflare-secrets.mjs --deploy` (`wrangler deploy --secrets-file`). `.github/workflows/deploy.yml` is a manual wrapper that calls `ci.yml`.
- **Configuration.** All values are repository-level GitHub secrets and variables, such as `CLOUDFLARE_D1_DATABASE_ID` and `CF_ACCESS_AUD`. The decision assumed a private repository on GitHub Free. On that plan, branch protection is unavailable, and GitHub documents environment secrets and variables as unavailable for private repositories. Required reviewers and deployment-branch rules on environments are also unavailable.
- **Shared Cloudflare account.** The account can also hold other production resources, including unrelated production D1 databases.
- **Wrangler config.** `wrangler.jsonc` is parsed with `JSON.parse`, both by `tools/check.mjs` and by the config generator, so it must stay comment-free. It has one top-level Worker (`storefront-skeleton`), a D1 binding `DB` with a placeholder UUID, `vars.APP_ENV=development`, a production cron (six-hourly when written; now every 5 minutes with an hourly per-supplier sync), and `assets.run_worker_first` as a path list. Static assets outside that list are served without running the Worker.
- **Indexing.** Production robots policy is allow-all. Private paths get `X-Robots-Tag: noindex, nofollow` from `isPrivatePath`.
- **Manager authentication.** `apps/api/src/auth.js` accepts a Cloudflare Access RS256 JWT for `CF_ACCESS_TEAM_NAME` and `CF_ACCESS_AUD`. It prefers the `CF-Access-Jwt-Assertion` header over the first `CF_Authorization` cookie. The development bypass requires `AUTH_DEV_BYPASS=true`, `APP_ENV !== "production"` **and** a loopback hostname.
- **Production Access.** The production Access application covers `/admin`, `/admin/*`, `/api/admin/*` and `/api/auth/*` and allows only the manager identities. It stays untouched by this ADR.
- **Customer accounts.** ADR-0003 adds Google OIDC customer sign-in. It introduces `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, `OIDC_REDIRECT_ORIGINS` and `CUSTOMER_AUTH_HMAC_KEY`, plus the callback `/api/account/google/callback`. Several of its fail-closed rules are worded "in production".
- **Real data.** The real supplier inventory and the production D1 must never leave their environment.

## Decisions

### (a) Separate Wrangler environment and resources

Add `env.staging` to `wrangler.jsonc`, and leave all top-level (production) keys byte-for-byte unchanged.

Wrangler environments work like this ([configuration reference](https://developers.cloudflare.com/workers/wrangler/configuration/)):

- **Inheritable keys.** An environment inherits these unless it overrides them: `name`, `main`, `compatibility_date`, `compatibility_flags`, `account_id`, `workers_dev`, `preview_urls`, `route`/`routes`, `triggers`, `assets`, `observability`, `limits`, `build`, `rules` and similar. An override replaces the key; it should not be relied on to deep-merge.
- **Non-inheritable keys.** These must be declared in each environment: `vars`, `define`, `d1_databases`, `r2_buckets`, `kv_namespaces`, `durable_objects`, `services`, `queues`, `secrets` and the other bindings. A binding the staging environment does not declare simply does not exist there. It never falls back to production.
- **Top-level only.** Some keys cannot appear in an environment, for example `keep_vars`, `send_metrics` and `site`.

The `env.staging` block must set or override:

| Key | Staging value | Why |
| --- | --- | --- |
| `name` | `storefront-skeleton-staging` | Separate Worker script, versions, secrets and logs |
| `workers_dev`, `preview_urls` | `false` | The only entry points are the two Access-gated custom domains. A `workers.dev` URL would bypass the gate. |
| `triggers` | `{ "crons": [] }` | Inheritable, so it must be emptied explicitly. Staging never runs scheduled supplier sync. |
| `assets` | Same as top level, but with `"run_worker_first": true` | Every response, including hashed static assets, passes through the Worker so it can get the staging noindex header (d) |
| `d1_databases` | `[{binding:"DB", database_name:"storefront-skeleton-staging", database_id:<placeholder>, migrations_dir:"migrations"}]` | Staging D1 only |
| `r2_buckets` | Omitted by default. If used, exactly `storefront-skeleton-media-staging`. | Without R2, uploads return the existing 503. The production bucket is never bound. |
| `vars` | `APP_ENV:"staging"`, `OIDC_REDIRECT_ORIGINS:"https://staging.example.com"`, `ADMIN_HOST:"staging-admin.example.com"`, plus empty `CF_ACCESS_TEAM_NAME`, `CF_ACCESS_AUD` and `GOOGLE_CLIENT_ID` placeholders | Non-inheritable. There is never an `AUTH_DEV_BYPASS` key. |
| `routes` | Not declared | The lead attaches both custom domains (`staging.example.com` and `staging-admin.example.com`) once in the dashboard, so the CI token needs no zone permissions |

**Generated config.** As in production, the committed placeholder UUID is never deployed.

- `tools/cloudflare-config.mjs` gains a staging generator. It writes a **flattened**, ignored `wrangler.staging.json` at the repository root. Relative `main`, `assets.directory` and `migrations_dir` paths resolve from the config file's directory, which is why the file goes at the root.
- **What goes into it.** The generator copies an **explicit allowlist** of inheritable top-level keys, then applies `env.staging`.
  - It sets `send_metrics: false`.
  - It never copies a top-level binding-type key. That covers every non-inheritable key listed above, and any key it does not recognise.
  - It fails if any binding-type key that exists at top level is not declared in `env.staging`. A new production binding then forces an explicit staging decision instead of silently leaking or vanishing.
- **Commands.** The output has no `env` key and no production bindings. Every staging command uses `--config wrangler.staging.json` and needs no `--env`. Forgetting `--env` therefore cannot fall through to production.
- **Production generator.** It deletes `env`, so `wrangler.production.json` stays exactly as it is today.
- **How repository values reach the Worker.** The generator fills the placeholders in the staging `vars`. These are plain Worker variables, not secrets.

  | Repository value | Staging Worker var |
  | --- | --- |
  | `CF_ACCESS_TEAM_NAME` | `CF_ACCESS_TEAM_NAME` |
  | `STAGING_CF_ACCESS_AUD` | `CF_ACCESS_AUD` |
  | `STAGING_GOOGLE_CLIENT_ID`, when set | `GOOGLE_CLIENT_ID` |

  Secrets reach the Worker only through the secrets file (c).

**Local checks.** The staging generator fails closed unless all of these hold. None of them need the network.

- **Names and flags.**
  - `name === "storefront-skeleton-staging"`.
  - `vars.APP_ENV === "staging"`, and `AUTH_DEV_BYPASS` is absent.
  - `vars.OIDC_REDIRECT_ORIGINS === "https://staging.example.com"`.
  - `vars.ADMIN_HOST === "staging-admin.example.com"`.
  - `triggers.crons` is empty, and `workers_dev` and `preview_urls` are `false`.
- **D1.**
  - The D1 `database_name` is `storefront-skeleton-staging`.
  - `STAGING_D1_DATABASE_ID` is a valid UUID and not the placeholder.
  - The production variable `CLOUDFLARE_D1_DATABASE_ID` is **non-empty** and different from `STAGING_D1_DATABASE_ID`.
- **R2, if `STAGING_R2_BUCKET` is set.**
  - It equals `storefront-skeleton-media-staging`.
  - `CLOUDFLARE_R2_BUCKET` is non-empty and different. Consequence: staging R2 needs the production bucket variable to be configured.
- **Access audience.**
  - `STAGING_CF_ACCESS_AUD` is 64 hex characters.
  - It differs from the production variable `CF_ACCESS_AUD`, which must also be non-empty. Reading that variable for the comparison is allowed.

**Remote identity checks.** These run in the staging workflow, with the staging token, before the history check and before migrations.

- **D1.** Resolve the database by **name**, for example with `wrangler d1 info storefront-skeleton-staging --json` or `wrangler d1 list --json`. Require exactly one match, and require its UUID to equal `STAGING_D1_DATABASE_ID`. Otherwise fail closed. Proving the ID differs from the catalog production UUID is not enough, because the account can hold other production databases. A mistyped ID could point at any of them.
- **R2.** If R2 is used, confirm the bucket `storefront-skeleton-media-staging` exists (for example with `wrangler r2 bucket info`). The binding is by name, and the name allowlist above prevents binding any other bucket.

**Production-like posture.** Staging must be as strict as production. Code today checks `APP_ENV === "production"`, and ADR-0003 has fail-closed checks worded "in production". Contract for new security checks: any `APP_ENV` other than the explicit local value `development` is production-like. This covers fail-closed missing configuration, `__Host-` cookies and no development cookie names.

- ADR-0003 and the customer-accounts implementation must include tests with `APP_ENV='staging'`. Those tasks are already being updated.
- The existing bypass stays safe on staging because staging is never a loopback hostname. The generator also rejects `AUTH_DEV_BYPASS` as defence in depth.

### (b) Deploy trigger: manual `workflow_dispatch` (recommended)

| Option | For | Against |
| --- | --- | --- |
| Push to a long-lived `staging` branch | Familiar; automatic | Needs someone to merge feature branches into `staging`, which is a second integration branch that drifts from `main`. Resetting it needs force-push, which is forbidden. Any push deploys, and branches that are tested together tangle. Agents pushing to it would amount to deploying. |
| PR label (`pull_request: labeled`) | Tied to a reviewed PR | Breaks the current invariant that pull-request runs never receive deployment credentials. Each PR revision redeploys while labelled, and several labelled PRs race for one staging slot. Label permission is weaker than write permission. |
| **`workflow_dispatch` of a chosen branch** | One explicit human action deploys exactly one reviewed SHA. Needs no merge. Fits "test before main". Keeps PR runs credential-free. Single-slot and auditable. | Manual. The branch must already contain the staging workflow. The run can only check for a green CI run and cannot enforce human review. |

Decision: `.github/workflows/staging.yml` with `on: workflow_dispatch` **only**, run against the branch selected in "Use workflow from".

- **Who triggers.** The lead, or the orchestrator only under an explicit lead instruction for that deployment. Workers never trigger it.
- **Branch requirements.** The branch must be `main` or have an **open PR** against `main`. Task branches created before the staging change merges must first take a normal merge from `main`. Rebasing is not allowed.
- **CI-green gate.** The run fails unless the GitHub API shows a workflow run of `.github/workflows/ci.yml` with all of these:
  - `head_sha` equal to the dispatched `github.sha`;
  - event `pull_request` (for a task branch with its open PR) or `push` to `main`;
  - status `completed` and conclusion `success`.

  This needs `actions: read`, plus `pull-requests: read` for the open-PR lookup.
- **Repeated checks.** The run then repeats `npm run check`, `npm test`, `npm run build` and a staging dry run. End-to-end tests are left to PR CI.
- **No reuse of `ci.yml`.** The workflow must **not** call `ci.yml` (`uses: ./.github/workflows/ci.yml`). In a called workflow, `github.ref` and `github.event_name` are the caller's. A staging dispatch from `main` would therefore satisfy the production `deploy` condition and deploy production.
- **Concurrency.** Group `cloudflare-staging`, with `cancel-in-progress: false`. The last successful dispatch owns staging. The step summary records the branch, SHA and PR.
- **Credentials.** The workflow never references production-only credentials: `secrets.MYDROP_API_KEY` or `secrets.CLOUDFLARE_API_TOKEN`. It reads the non-secret production variables `CLOUDFLARE_D1_DATABASE_ID`, `CLOUDFLARE_R2_BUCKET` and `CF_ACCESS_AUD` only to prove inequality.
- **Smoke check.** This is conditional on a `STAGING_URL` repository variable, which must equal exactly `https://staging.example.com`. When the variable is unset, for example on the first deploy before the custom domain is attached, the step is skipped and the run summary says so. When it is set, an unauthenticated `GET` with `redirect: manual` must return 302 or 303 to `https://<CF_ACCESS_TEAM_NAME>.cloudflareaccess.com/…`. That proves the gate is in front of the Worker. Any 2xx response fails the run as an exposed host. The same check runs for `STAGING_ADMIN_URL`, which must equal exactly `https://staging-admin.example.com`, and is skipped while that variable is unset. Both checks are unauthenticated. The manager-path 404 on the gate host sits behind the gate, so it is covered by QA rather than by the smoke check.

Trust boundary, stated honestly: on GitHub Free, any workflow on any pushed branch can read repository secrets, and the Cloudflare API token is account-scoped. Isolation therefore rests on trusted writers, the generator assertions, the remote identity checks and this workflow's structure. It is not enforced by GitHub server-side.

### (c) Variables and secrets

GitHub resolves a same-named secret or variable at environment level first, then repository level. If a "staging" environment value were missing, the **production** repository value would silently apply. So every staging-specific value uses a distinct `STAGING_` name, and production names are never reused for staging values.

- **On GitHub Free (the assumed plan).** Store these as repository-level secrets and variables. A GitHub "staging" environment cannot hold secrets or variables for a private repository on this plan.
- **After an upgrade to Pro or Team.** Move them into an environment named `staging` under the same names and add `environment: staging` to the job. Deployment-branch rules then become available too.

| Name | Kind | Value / policy |
| --- | --- | --- |
| `STAGING_CLOUDFLARE_API_TOKEN` | Secret | Separate token with the production token's permission set: Workers Scripts edit, D1 edit, and R2 edit if used. Revocable on its own. It is still account-scoped, so it is not a hard isolation boundary. |
| `CLOUDFLARE_ACCOUNT_ID` | Secret (existing) | Same account. Reused, not duplicated. |
| `STAGING_D1_DATABASE_ID` | Variable | UUID of `storefront-skeleton-staging`. Checked remotely by name. |
| `STAGING_R2_BUCKET` | Variable, optional | Exactly `storefront-skeleton-media-staging`, and only if uploads are tested |
| `CF_ACCESS_TEAM_NAME` | Variable (existing) | Same Zero Trust team. Not secret. |
| `STAGING_CF_ACCESS_AUD` | Variable | 64-hex audience tag of the **staging manager** Access application on the admin host (e). Never equal to production's. Written into Worker var `CF_ACCESS_AUD`. |
| `STAGING_URL` | Variable | `https://staging.example.com`. Set only after the custom domain is attached. Enables the gate-host smoke check. |
| `STAGING_ADMIN_URL` | Variable | `https://staging-admin.example.com`. Set only after the admin custom domain is attached. Enables the admin-host smoke check. |
| `STAGING_GOOGLE_CLIENT_ID` | Variable | Client ID of the separate staging OAuth client (f). Written into Worker var `GOOGLE_CLIENT_ID`. |
| `STAGING_GOOGLE_CLIENT_SECRET` | Secret | Uploaded as Worker secret `GOOGLE_CLIENT_SECRET` |
| `STAGING_CUSTOMER_AUTH_HMAC_KEY` | Secret | Fresh random key of at least 32 bytes, uploaded as Worker secret `CUSTOMER_AUTH_HMAC_KEY`. Never equal to the production key. |
| `APP_ENV`, `OIDC_REDIRECT_ORIGINS`, `ADMIN_HOST` | Committed `env.staging.vars` | `staging`, `https://staging.example.com` and `staging-admin.example.com`. Not secret, and fixed. |

- **`AUTH_DEV_BYPASS`.** Never set on staging, and rejected by the generator.
- **Secret upload.** Secrets are uploaded atomically with the version, using the existing `--secrets-file` mechanism through a staging mode of `tools/cloudflare-secrets.mjs`. Wrangler keeps existing secrets that are missing from the file. Removing a staging secret needs an explicit `wrangler secret delete --name storefront-skeleton-staging`.
- **Customer-auth values before ADR-0003 merges.** `GOOGLE_*` and `CUSTOMER_AUTH_HMAC_KEY` are optional until the customer-account code merges. The Worker's fail-closed 503 covers a missing client. Once the code merges, the staging generator requires them.
- **`MYDROP_API_KEY`: none on staging.** The key is account-wide, and any MyDrop import, even read-only, writes real supplier products, costs and identifiers into a less-protected database. That contradicts "never copy the real products". Without the key, sync reports the existing actionable error. Revisit only with a separate MyDrop test account or a synthetic supplier stub.
- **Telegram (ADR-0004).** Linking stays unconfigured on staging until a separate staging bot or client exists. The production bot is never reused.

### (d) No indexing anywhere on the staging host

These rules are keyed on `env.APP_ENV === "staging"`. Production code paths and output stay unchanged, and production keeps its allow-all robots policy on purpose.

- **Header.** The final response wrapper in `fetch()` sets `X-Robots-Tag: noindex, nofollow` on **every** response: success, error, 404, redirect, assets and HTML. This works only because the staging `assets.run_worker_first` is `true`. The production path list does not change.
- **Alternative to `run_worker_first: true`.** A zone Response Header Transform Rule for the `staging.example.com` hostname would add the header without Worker invocations for assets. It is not chosen: it lives outside the repository and its review, and the zone is shared with production. The lead may add one as extra defence.
- **`robots.txt`.** Returns exactly `User-agent: *\nDisallow: /\n`, with no `Sitemap:` line.
- **`sitemap.xml`.** Returns 404, so there is no sitemap.
- **Canonical URLs.** They stay derived from the request origin, so staging never names production URLs. Together with noindex, no staging URL is indexable.
- **Access gate.** The whole-host Access gate (e) already hides content from crawlers. These rules are defence in depth in case Access is ever misconfigured or removed.

### (e) Cloudflare Access: a gate host plus a separate manager host (recommended)

| Option | For | Against |
| --- | --- | --- |
| **Whole staging host behind Access, cabinet on a separate manager host** | One Access application per hostname, which is Access's documented clean model, so no cookie is shared between applications. Unreleased features, synthetic data and staging sign-ups are invisible to the public. | A second custom domain and Access application. Testers use Access seats. Unauthenticated smoke checks can only verify the gates. Differs from production's path-based layout. |
| Whole host behind Access, both applications on one host (path-based manager app) | Same URLs as production | **Broken by design.** A `CF_Authorization` cookie has a single `Path`, but the manager application has four roots: `/admin`, `/admin/*`, `/api/admin/*` and `/api/auth/*`. Cloudflare documents that a login at one path must re-authenticate at another. Cabinet fetches to `/api/admin/*` and `/api/auth/session` would carry only the gate cookie (wrong AUD), get a cross-origin redirect to the Access login and fail. No documented shared-host setting fixes this. |
| Manager paths only (production layout) | Mirrors production exactly; public smoke checks work | Exposes pre-review code and features publicly. Anyone could create staging customer accounts, which means unmanaged personal data. Only noindex protects it. |

Decision: two **new** self-hosted Access applications, **one per hostname**. Both hostnames are custom domains of the same staging Worker. The production application, its hostnames and its policy stay untouched.

1. **Staging gate application** on `staging.example.com`.
   - **Path:** the whole host (empty path).
   - **Policy:** Allow the lead, the manager identities and named testers.
   - **AUD:** the Worker does **not** trust this application's AUD.
   - **Customers:** this host is the customer-facing staging site. It is the only `OIDC_REDIRECT_ORIGINS` origin and the only Google redirect host. Customers never use the admin host.
2. **Staging manager application** on `staging-admin.example.com`.
   - **Path:** the whole host (empty path).
   - **Policy:** Allow, with exactly the same manager identities as production. Reuse the existing reusable policy if it is one; otherwise the lead re-enters the same identities. They are not recorded in docs.
   - **AUD:** its audience tag becomes `STAGING_CF_ACCESS_AUD`. The staging generator writes it into the Worker var `CF_ACCESS_AUD`, so `auth.js` stays unchanged.
   - **Why separate:** it is a separate application rather than a third hostname on the production application. A shared AUD would let tokens minted on staging verify on production and the other way round.

**Manager paths on the gate host are denied in the Worker (recommended).**

- **The rule.** `env.staging.vars` commits `ADMIN_HOST: "staging-admin.example.com"`. When `ADMIN_HOST` is set and the request hostname differs from it, the Worker returns `404 {error}` for `/admin`, `/admin/*`, `/api/admin/*` and `/api/auth/*` before any authentication or assets lookup. The response still carries the usual headers, including noindex.
- **Production and development.** `ADMIN_HOST` is unset, so behaviour is unchanged. The production generator replaces `vars` entirely and never sets it.
- **Why not Access.** An Access Block application or policy on those paths of the gate host would also work. It is not chosen: it lives outside the repository and its tests, and a path-based app on the gate host brings back the cookie complexity above.
- **Tester tokens.** A tester token has the gate AUD, so `auth.js` would reject it anyway. The 404 also removes the confusing broken cabinet from the gate host.

**Host-agnostic otherwise.** Both hostnames serve the same Worker: storefront, assets and APIs. On the admin host, the whole site requires a manager Access login, and the cabinet's same-origin fetches carry that application's cookie and assertion header. Customer sign-in on the admin host fails closed with the existing `400 origin not allowed`, because that origin is not in `OIDC_REDIRECT_ORIGINS`.

**Cookie settings** (both applications): Binding Cookie **off** (not verified), SameSite **Lax** (the Google callback below is a top-level cross-site GET, and `Strict` would bounce it through login), HTTP Only on. Cookie Path Attribute is not needed, because each application covers a whole host.

**Required QA case.**

1. As a manager on `https://staging-admin.example.com/admin`, load the cabinet, including all `/assets/*` requests and several `/api/admin/*` and `/api/auth/session` fetches. There must be no redirect, CORS or 401 failures. Browse the storefront on the admin host and return to `/admin`; there must be no re-authentication loop.
2. On `staging.example.com`, `/admin` and `/api/admin/*` return the Worker 404.
3. A tester can pass the gate host, cannot pass the admin host's Access, and has no cabinet anywhere.

**Alternative, only if QA proves it works: shared-host layout.** A path-based manager application on `staging.example.com`, as in production. Because of the single-Path cookie limit described above, it is expected to fail for cabinet API fetches. Try it only as an explicit experiment, and adopt it only if the QA case passes unchanged. If adopted, `ADMIN_HOST` is removed.

**Google customer sign-in through the gate.** This is expected to work; it is verified.

1. The tester passes the gate and holds the gate host's cookie.
2. `POST /api/account/google/start` is a same-origin fetch, so the cookie is sent.
3. Google redirects the browser with a top-level cross-site `GET` to `https://staging.example.com/api/account/google/callback?code&state`. Browsers send `SameSite=Lax` cookies on top-level navigations, so Access admits the callback and the Worker finishes the flow. ADR-0003's `__Host-ls_oidc` cookie is also `Lax`.
4. If the Access session has expired mid-flow, Access sends the tester through its login and back to the original callback URL. The flow still completes inside its 10-minute window.

Under ADR-0003, `/api/account/*` resolves only the customer session and ignores the Access JWT the gate adds. Customers and managers stay separate on staging too.

**Approval.** Creating or changing any Access application needs explicit lead approval. Agents never perform it.

### (f) Google OAuth client: separate staging client (recommended)

Staging runs code that has not yet merged and that the lead deploys before review completes. It should not hold the production client secret. A separate "Web application" client in the same Google Cloud project shares the consent screen and test-user list, costs nothing and keeps the production redirect list minimal.

The lead adds exactly one authorized redirect URI to the staging client: `https://staging.example.com/api/account/google/callback`. The consent screen's authorized domains must include `example.com`; an authorized domain covers its subdomains. If the lead instead chooses a shared client, the same URI is added to the production client. `STAGING_GOOGLE_CLIENT_ID` and the secret then equal production's, and the staging secret's blast radius becomes production's. If the consent screen is in "Testing" publishing status, testers must be listed as Google test users.

### (g) Staging migrations and data

Each run follows this order:

1. Run the CI-green and open-PR gate.
2. Generate `wrangler.staging.json` and run the local checks.
3. Build, and run a staging dry run.
4. **Remote identity checks:** D1 by name, and R2 if used (a).
5. **History check.** Read `d1_migrations` from the staging D1 and fail if it lists a migration that is missing from the deployed ref. This happens when an earlier dispatch deployed a branch whose migration never reached `main`.
6. `npx --no-install wrangler d1 migrations apply DB --remote --config wrangler.staging.json`.
7. Deploy with secrets.
8. Run the gate smoke checks, for each of `STAGING_URL` and `STAGING_ADMIN_URL` that is set.

Migrations always run before deploy, and only with the staging config. The staging workflow contains no production config, ID or command, apart from the read-only inequality checks. Migrations stay forward-only and keep the shared numeric order. Do not edit applied migration files.

The staging D1 is disposable. When the history check fails or the schema drifts, the lead resets staging: delete and recreate `storefront-skeleton-staging`, update `STAGING_D1_DATABASE_ID`, then redispatch. A guarded reset workflow is a later option (see revisit triggers).

Data rules:

- **Seed data is synthetic only.** Use `fixtures/mydrop-demo.json`, imported through the staging cabinet, plus future clearly synthetic fixtures. Fixture products start as drafts, as everywhere.
- **Never copy real data.** Never `d1 export` or `d1 execute` production into staging, and never copy a local database with real inventory, its files or `.wrangler` state.
- **No real supplier data.** There is no MyDrop sync (c).
- **Personal data.** Staging customer accounts are real Google identities of the lead and testers, so the staging D1 holds tester personal data and must be treated as sensitive. Delete accounts through `DELETE /api/account`, or reset the database.

### (h) Cost, rollback and teardown

**Cost.** Assumption (checked; current figures are on the [Workers](https://developers.cloudflare.com/workers/platform/pricing/), [D1](https://developers.cloudflare.com/d1/platform/pricing/) and [D1 limits](https://developers.cloudflare.com/d1/platform/limits/) pages): no new paid plan is needed.

| Service | Cost impact of staging (assumption, checked) |
| --- | --- |
| Workers Paid ($5/month per account) | Already covers any number of Worker scripts. Staging traffic is small and falls within the included requests and CPU, so the additional cost is about $0. |
| Workers Free | Staging shares the account-wide daily request limit with production. `run_worker_first: true` makes every staging asset request count as a Worker request. A staging load test could exhaust production's daily quota, so do not load-test staging on the Free plan. |
| D1 | One more database. Free allows 10 databases, 500 MB each and 5 GB per account. Paid includes far more. Synthetic data is tiny. Daily read/write quotas on Free are shared across the account. |
| R2 (optional) | Within free storage and operations for synthetic photos |
| Access | Free for up to 50 users. Testers use seats. |
| GitHub Actions | Private repositories on Free have a limited monthly minutes allowance. Each dispatch takes a few minutes; there are no automatic runs. |
| Google OAuth client | $0 |

**Rollback.**

- **Code.** Redispatch an earlier reviewed SHA, or run `npx wrangler rollback --name storefront-skeleton-staging`, always naming the staging script.
- **Data.** D1 is not rolled back with code. Reset staging (g) if a schema is incompatible.
- **Production.** Unaffected throughout.

**Teardown** (lead-run, naming staging resources explicitly, including both custom domains; never run any of these commands without `staging` in the target):

1. Remove the staging custom domain or domains.
2. `wrangler delete --name storefront-skeleton-staging`
3. `wrangler d1 delete storefront-skeleton-staging`
4. Delete the optional `storefront-skeleton-media-staging` bucket.
5. Delete both staging Access applications. The production application stays.
6. Delete the staging Google OAuth client, or the staging redirect URI if the client is shared.
7. Delete the `STAGING_*` GitHub secrets and variables and the staging API token.
8. Remove `staging.yml` and `env.staging` in a reviewed PR.

## Provisioning checklist for the lead

Run these in order after this ADR is accepted. Agents perform none of them. Record IDs, audience tags and secret or variable **names**, never secret values or manager identities.

1. **Confirm plans.** Check the Cloudflare Workers plan (Free or Paid). Confirm the GitHub plan; Free means no environment secrets and no deployment-branch rules, so use repository-level `STAGING_*` values.
2. **D1.** Run `npx wrangler d1 create storefront-skeleton-staging` and record the UUID. Confirm with `npx wrangler d1 info storefront-skeleton-staging` that the name resolves to that UUID.
3. **R2 (optional, only if uploads are tested).** Run `npx wrangler r2 bucket create storefront-skeleton-media-staging`. This requires the production `CLOUDFLARE_R2_BUCKET` variable to be set.
4. **API token.** Create a Cloudflare API token for staging, with Workers Scripts edit, D1 edit, and R2 edit only if step 3 was done. No zone or DNS permissions.
5. **Access applications.** These need explicit lead approval, and must exist before any DNS for either host. Create one application per hostname.
   - a. **Staging gate application.** Self-hosted, hostname `staging.example.com`, empty path (the whole host).
     - Allow policy: the lead, the manager identities and the named testers.
     - Cookie settings: Binding Cookie **off**, SameSite **Lax**, HTTP Only on.
   - b. **Staging manager application.** Self-hosted, hostname `staging-admin.example.com`, empty path (the whole host).
     - Allow policy: exactly the same manager identities as production. Reuse the reusable policy if available.
     - Cookie settings: Binding Cookie **off**, SameSite **Lax**, HTTP Only on.
     - Record the audience tag.
   - c. Do not modify the production Access application.
6. **Google.** In the same Google Cloud project, create a "Web application" OAuth client for staging.
   - Add exactly one authorized redirect URI: `https://staging.example.com/api/account/google/callback`. Use no admin-host URI; customers never use the admin host.
   - Confirm the consent screen's authorized domains include `example.com`.
   - If publishing status is Testing, add testers as test users.
   - If you choose a shared client instead, add the URI to the production client.
7. **GitHub repository secrets.** Create `STAGING_CLOUDFLARE_API_TOKEN` (from step 4), `STAGING_GOOGLE_CLIENT_SECRET` and `STAGING_CUSTOMER_AUTH_HMAC_KEY` (fresh random, at least 32 bytes, never the production key). Keep the existing `CLOUDFLARE_ACCOUNT_ID`. Create no staging MyDrop secret.
8. **GitHub repository variables.**
   - Create `STAGING_D1_DATABASE_ID` (from step 2), `STAGING_CF_ACCESS_AUD` (from step 5b) and `STAGING_GOOGLE_CLIENT_ID`.
   - Create `STAGING_R2_BUCKET` only if step 3 was done.
   - Do **not** set `STAGING_URL` or `STAGING_ADMIN_URL` yet.
   - Confirm the existing production variables `CLOUDFLARE_D1_DATABASE_ID` and `CF_ACCESS_AUD` are set, and `CLOUDFLARE_R2_BUCKET` if R2 is used. Their presence is required for the staging inequality checks.
   - Keep the existing `CF_ACCESS_TEAM_NAME`.
9. **First deploy** (after the staging change merges). Dispatch **Deploy staging** from `main`. This creates the Worker `storefront-skeleton-staging`. The smoke checks are skipped.
10. **Custom domains.** In the Workers dashboard, open `storefront-skeleton-staging`, go to Domains & Routes and add **two** custom domains: `staging.example.com` and `staging-admin.example.com`. Cloudflare creates the DNS records and certificates. On the same page, confirm the `workers.dev` route and Preview URLs are **disabled**.
11. **Enable the smoke checks.** Set the repository variables `STAGING_URL=https://staging.example.com` and `STAGING_ADMIN_URL=https://staging-admin.example.com`, then redispatch **Deploy staging** from `main`. Both smoke checks must pass, which proves each host has Access in front of the Worker.
12. **Seed.** Sign in as a manager on `https://staging-admin.example.com/admin` and import only `fixtures/mydrop-demo.json`.
13. **Record and hand over.** Record the D1 UUID, the manager application's audience tag and the names of the variables and secrets. Hand over to staging QA, including the Access QA case in (e).

## Consequences

- **Two hostnames.** Staging has a customer-facing gate host and a manager-only admin host, unlike production's single path-based layout. Manager-path Access behaviour is therefore not a production replica.
- **Testing before merge.** The lead can test any CI-green branch that has an open PR, on a production-like host, without merging. The main-merge production pipeline is unchanged.
- **Single slot.** Staging is one slot: the last dispatch wins. Staging D1 schema history can diverge from `main`, which the history check (g) detects. Reset is a manual lead action.
- **Repository changes**:
  - `env.staging` in `wrangler.jsonc`
  - the staging generator, the staging secrets mode and the production `env` stripping in `tools/`
  - the staging noindex branch and the `ADMIN_HOST` manager-path 404 in `apps/api/src/index.js`
  - `.github/workflows/staging.yml`
  - tests, `.gitignore` and `package.json` scripts
- **Shared-file ordering.**
  - `wrangler.jsonc` and `apps/api/src/index.js` follow the private-path indexing change.
  - `tools/cloudflare-secrets.mjs` and its test are also targets of ADR-0003's secret-binding task, so those two changes must be ordered.
  - `docs/adr/README.md` and `docs/ARCHITECTURE.md` conflict with the customer-accounts docs branch, because both branches append to them. The conflict is resolved at integration by a normal merge from `main`.
- **Contract for future security checks.** Treat any `APP_ENV` other than `development` as production-like. Tests cover `APP_ENV='staging'`.
- **Unverified until staging QA.**
  - The two-host Access layout: the cabinet on the admin host, and the manager-path 404 on the gate host.
  - The Google callback through the gate.
  - The disabled `workers.dev` and preview URLs.

## Revisit triggers

- The two-host layout proves impractical, or Cloudflare documents a shared-host multi-path cookie model: re-evaluate the shared-host alternative in (e).
- The GitHub plan is upgraded: move values into an environment named `staging` and add deployment-branch rules.
- More than one feature needs staging at the same time: per-PR preview Workers or Worker preview URLs, with a gate.
- Frequent schema resets: add a guarded staging-reset workflow.
- Testers need the manager cabinet.
- A MyDrop test account or a synthetic supplier stub becomes available.
- Telegram linking needs staging verification.
- Load or performance testing is required, which needs the Workers Paid plan and probably a separate account.
- Access seat usage approaches the free tier.
- Cloudflare changes how environments inherit keys, how secrets files behave or how Access cookies are scoped.

## Staff mount implementation note

The staff continuation exposes `/staff` and `/api/staff/*` on the current staging host for invited Google staff. The existing whole-host staging Access gate and `/admin` owner cabinet remain as established by the same-host admin amendment. Passing Access alone does not authenticate the staff mount; it reads only its staff cookie. No Access allowlist or destination change accompanies this feature. This supersedes the historical two-host descriptions above for current routing.
