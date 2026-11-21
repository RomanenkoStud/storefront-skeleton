# Lorem Store

Lorem Store is a case-study skeleton of a Ukrainian dropshipping storefront. It has a public catalog, a manager cabinet and a delivery setup for AI coding agents. Managers import supplier products, curate them and publish a selection. Customers build a cart and get a cart code; a manager then places the supplier order by hand. There is no online payment.

All data in this repository is fictional: the shop, the brands, the products, the photos and the legal texts.

## Features

- **Supplier import:** MyDrop (dropshipper API), EasyDrop (prom-export feed) and manual suppliers. The sync is idempotent and keeps manager edits separate from supplier data.
- **Manager cabinet:** products, prices (markup or override), categories, brand recognition, duplicate review, bulk actions, Trash, media library, storefront settings, orders, staff and audit.
- **Storefront:** landing, catalog with filters, product pages with structured data, sitemap, cart-code checkout and a Nova Poshta delivery-point picker.
- **Accounts:** owners through Cloudflare Access; staff (owner or manager role) and customers through separate Google sign-in flows.
- **Photos:** R2 uploads, background removal and template fit in the browser, nightly WebP card thumbnails.
- **Delivery:** staging-first release flow with a CI gate. Agent profiles, Beads tracking and one Git worktree per task.

## Stack

| Layer | Technology |
| --- | --- |
| Frontend | React 19, Vite (`apps/web`) |
| Backend | Cloudflare Worker, ESM (`apps/api`) |
| Database | Cloudflare D1 (SQLite), migrations in `migrations/` |
| Files | Cloudflare R2 (`MEDIA` for photos, `NP_CATALOG` for Nova Poshta data) |
| Auth | Cloudflare Access (owners), Google OIDC (staff, customers) |
| CI/CD | GitHub Actions |
| Tests | Node test scripts (`tests/backend`, `tests/frontend`), Playwright (`tests/e2e`) |

## Repository layout

| Path | Content |
| --- | --- |
| `apps/api/src` | Worker: routes, auth, sync, carts, media, scheduled jobs |
| `apps/web/src` | Storefront, manager cabinet, customer cabinet, cart |
| `packages/catalog` | Pure modules shared by the Worker and the browser |
| `migrations/` | D1 schema migrations |
| `fixtures/` | Demo catalog and photos, synthetic supplier feeds (`mydrop-demo.json`, `easydrop-sample.xml`) |
| `tests/` | Backend, frontend and browser tests |
| `tools/` | Checks, deploy config, secrets, demo seed, worktree helper, sync and thumbnail scripts |
| `.github/workflows/` | CI, deploy, staging and scheduled jobs |
| `.claude/` | Agent profiles (`agents/`) and skills (`skills/`) |
| `docs/` | Product, architecture, API, setup, workflow, ADRs, design, legal |

## Local quick start

You need Node 22.13 or later and npm. You do not need a Cloudflare account for local work.

```bash
npm ci
cp .dev.vars.example .dev.vars   # enables the loopback development bypass
npm run db:migrate               # local D1; also seeds the category tree and recognition rules
npm run seed:demo                # demo supplier, products and photos
npm run dev                      # builds the web app and starts the Worker on port 8787
```

1. Open `http://localhost:8787` for the storefront.
2. Open `http://localhost:8787/admin` for the cabinet. The loopback development bypass signs you in as the owner `dev@localhost`. It works only with `AUTH_DEV_BYPASS=true`, `APP_ENV=development` and a loopback host.
3. For hot reload, keep the Worker running and run `npm run dev:web` in a second terminal. Vite serves on port 5173 and proxies `/api` and `/media` to port 8787.

`npm run seed:demo` writes to the local D1 and uploads the demo photos one by one to the local R2 `MEDIA` binding (`storefront-skeleton-media`). It takes about a minute. It is idempotent. Options: `--dry-run`, `--persist-to <dir>`, `--config <file>`, `--bucket <name>`. It touches Cloudflare only with `--remote`.

## Checks and tests

| Command | Purpose |
| --- | --- |
| `npm run check` | Syntax check of Worker, tools and packages; bindings; design tokens |
| `npm test` | Backend and frontend unit tests |
| `npm run build` | Production build of the web app |
| `npm run deploy:check` | Build and Worker dry-run bundle |
| `npx playwright install chromium`, then `npm run test:e2e` | Browser tests on port 8788 with isolated D1 state in `.wrangler/e2e` |

The repository ships without Playwright screenshot baselines, and the browser specs were not re-run after the placeholder content was added. Create the baselines on your first run with `npx playwright test --update-snapshots`, then fix any spec that still asserts old demo content.

CI runs `check`, `test`, `build`, local migrations and the dry-run bundle. Browser tests are not part of CI.

## Agent workflow

The repository is set up for delivery by AI coding agents (Claude Code).

- **Profiles** are in `.claude/agents`: orchestrator, project-manager, architect, backend, frontend, implementer, reviewer and qa. Start the lead agent with `claude --agent orchestrator --settings tools/orchestrator-settings.json`. `/tick` runs one delivery cycle.
- **Tracking** uses Beads (`bd`). Only the orchestrator writes to the tracker. `npm run kanban` shows the board in the terminal, `npm run kanban:web` in the browser.
- **Worktrees:** each task has its own branch and sibling worktree (`tools/agent-worktree.sh create <role> <ticket>`). No agent works in the main checkout.
- **Release:** a task PR goes to `staging` first. After the staging test, the same branch goes to `main`.

The rules are in [AGENTS.md](AGENTS.md) and [docs/WORKFLOW.md](docs/WORKFLOW.md).

## Deployment

All deployments run in GitHub Actions. Nothing deploys from a task branch.

| Workflow | Trigger | Action |
| --- | --- | --- |
| `ci.yml` | PR, push to `main`, manual | Checks. On `main`: the staging gate, then the production deploy |
| `staging.yml` | Push to `staging`, manual from `staging` | Deploys the staging Worker |
| `deploy.yml` | Manual from `main` | Runs the full `ci.yml` pipeline |
| `np-catalog.yml` | Daily, manual | Copies the Nova Poshta directory to R2 |
| `card-thumbnails.yml` | Daily, manual | Generates WebP card thumbnails |
| `configure-staff-key.yml` | Manual from deployed `main` | Adds a missing production `STAFF_AUTH_HMAC_KEY` |

To deploy your own copy, follow [docs/SETUP.md](docs/SETUP.md). It covers the GitHub repository, Cloudflare D1, R2, Access and API tokens, Google OAuth clients, every secret and variable, the first deploy and troubleshooting.

## Documentation

| Document | Content |
| --- | --- |
| [docs/PRODUCT.md](docs/PRODUCT.md) | Product scope and behavior |
| [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) | Modules, data ownership, auth, storage, jobs, caching |
| [docs/API.md](docs/API.md) | HTTP API contract |
| [docs/SETUP.md](docs/SETUP.md) | Deployment from zero |
| [docs/WORKFLOW.md](docs/WORKFLOW.md) | Agent worktrees, PRs and release |
| [docs/INTEGRATIONS.md](docs/INTEGRATIONS.md) | Supplier feeds, sync rules, Nova Poshta data |
| [docs/MEDIA.md](docs/MEDIA.md) | Photos, background removal, normalization, thumbnails |
| [docs/adr/](docs/adr/README.md) | Architecture decision records |
| [docs/design/DESIGN.md](docs/design/DESIGN.md) | Visual design system |
| [docs/legal/privacy-notice.uk.md](docs/legal/privacy-notice.uk.md) | Privacy notice template (Ukrainian) |
| [AGENTS.md](AGENTS.md) | Rules for coding agents |

## Licence

MIT. See [LICENSE](LICENSE).

## Disclaimer

Lorem Store is not a real shop. The names, brands, products, prices, images, supplier data and legal texts in this repository are fictional placeholders. `example.com` is a reserved example domain. Any resemblance to real businesses or products is a coincidence. The privacy notice is a template, not legal advice; an operator must write their own.
