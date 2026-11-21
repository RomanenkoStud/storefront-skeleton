# Architecture

This document describes the system as it runs now. The API contract is in [API.md](API.md). Decision records are in [adr/](adr/README.md).

## Runtime and modules

| Part | Path | Role |
| --- | --- | --- |
| Web app | `apps/web/src` | React and Vite. Ukrainian storefront, manager cabinet (`/admin`, `/staff`), customer cabinet (`/account`) and cart (`/cart`). Built into `apps/web/dist`. |
| Worker | `apps/api/src/index.js` | ESM Cloudflare Worker. Routes, public projection, product HTML, sitemap, robots, media serving, cache and `scheduled()`. |
| Domain | `apps/api/src/domain.js` | Source validation, override validation, price calculation and product projection. |
| Suppliers | `mydrop.js`, `easydrop.js`, `easydrop-link.js`, `manual.js` | Feed adapters and manual-supplier validation. |
| Auth | `auth.js`, `staff-auth.js`, `customer-auth.js`, `google-oidc.js`, `permissions.js` | Access JWTs, staff and customer Google sign-in, permission matrix and route table. |
| Catalog features | `taxonomy.js`, `recognition.js`, `duplicates.js`, `merged.js` | Category tree, category and brand inference, duplicate review and merged listings. |
| Orders | `carts.js`, `order-retention.js`, `nova-poshta.js` | Cart-code checkout, manager order workflow, personal-data erasure and delivery points. |
| Media | `media.js`, `image-processing.js`, `photo-derivatives.js` | R2 uploads, references, cleanup, cutouts, normalized photos and card thumbnails. |
| Storefront content | `storefront-settings.js`, `storefront-images.js`, `campaign-pictures.js` | Campaign band, ticker, checkout text, banner and image overrides. |
| Owner pages | `analytics.js`, `infra.js` | Cookieless visit statistics, sales metrics, infrastructure usage and renewals. |
| Shared | `packages/catalog` | Pure modules for the Worker and the browser: taxonomy, cart, sizes, price format, duplicates, picture fit and templates, scenes, delivery. |
| Database | `migrations/` | D1 (SQLite) schema. Apply migrations in order. Never edit an applied migration. |
| Tools | `tools/` | Checks, deploy config, secrets, worktrees, Nova Poshta sync, card thumbnails. |

## Data ownership

Two sources write product data. The supplier snapshot (CRM/source data) comes from the feed. The manager overlay holds manager overrides. They live in separate columns (`products.source_json` and `products.overrides_json`) and never overwrite each other.

| Data | Owner | Written by | Sync behavior |
| --- | --- | --- | --- |
| Identity `(supplier_id, external_id)`, title, description, category, cost, photos, variants, sizes, stock | Supplier snapshot | Feed import (validated upsert) | Replaced on change; unchanged sources are not rewritten |
| Source of a product of a `manual` supplier | Manager (no feed) | `POST /products`, `PATCH /products/:id/source` | Never synced or imported over |
| Publication, title, description, category, brand, slug, photos, hidden sizes, promotion, SEO, tags | Manager overlay | `PATCH /products/:id`, bulk actions | Preserved |
| Markup (`markupType`, `markupValue`) and price override (`priceOverrideMinor`) | Manager overlay (`products.price`) | `PATCH /products/:id` | Preserved; retail price recalculated |
| Retail price, public availability, active promotion, merged listing | Derived public projection | Computed per request | Recomputed; never stored |
| Duplicate groups and "different item" decisions | Manager workflow (`products.edit`) | Duplicate review | Preserved |
| Recognition versions and category tree | Managers and owners | Recognition and taxonomy pages | Not touched by sync |
| Sync runs, `last_sync_*` | Sync engine | Sync | Appended and timestamped |
| Card thumbnails (`photo_derivatives`) | Thumbnail job | `tools/card-thumbnails.mjs` | Derived; safe to drop and regenerate |
| Media inventory (`media_objects`, `media_refs`) | Media module | Uploads, triggers, scan | Not written by import |
| Draft cart | Customer browser (`localStorage` `ls_cart_v1`) | Storefront | Never sent before checkout |
| Cart snapshot (`carts`, `cart_lines`, allocations) | Cart module | `POST /api/cart/checkout` | Immutable; later sync or overrides never change it |
| Cart status, manager note | Manager workflow (`orders.operate`) | Order page | Audited status machine |
| Customer account, sessions, profile, delivery preference | Customer | `/api/account/*` | Never in public or manager responses |
| Staff members, sessions, invitations | Owners | Team page | Separate from customer tables |
| Storefront settings, campaign pictures, storefront images | Owners (`settings.manage`) | Storefront settings | Never touched by sync |
| Nova Poshta snapshot (R2 `np-catalog/v1/`) | Sync script | `tools/np-catalog-sync.mjs` | Reference data; staff never edit it |

Rules:
- A `null` override inherits the supplier value. An empty string is an intentional curated value.
- New products are drafts. Publication requires valid effective fields and a positive price.
- A disabled or trashed supplier hides its products. Their publication flags stay saved.
- Trash sets `deleted_at`. Sync and supplier discovery never clear it.
- A purged product leaves a tombstone. Sync never creates it again.

## Pricing
1. Money is integer kopecks (UAH). The server calculates every price.
2. `retailPrice` adds a fixed markup to the cost, or adds a percentage rounded once to the nearest kopeck.
3. If `priceOverrideMinor` is a positive integer, it replaces the calculated price. `null` returns to cost plus markup.
4. Sync replaces the supplier snapshot, including the cost. The saved markup or override then gives the new retail price.
5. Supplier cost appears only in manager responses and the private cart copy. Public responses never contain it.
6. In a merged duplicate listing, a member whose cost is above the shown price is excluded. Checkout never fills a line at a loss.

## Supplier sync
- MyDrop uses the dropshipper API with the server secret `MYDROP_API_KEY` and an explicit connection ID for each supplier.
- EasyDrop uses a prom-export feed. Its private key is stored in `suppliers.feed_key`, never in responses, errors, runs or logs.
- The feed key is in the request URL, so Workers fetch tracing (`observability.traces`) stays off.
- Both adapters validate the whole payload and import atomically. A failed or partial feed never deletes products or reports an empty success.
- A persisted 15-minute cooldown applies to each supplier API request.
- Details and limits are in [INTEGRATIONS.md](INTEGRATIONS.md).

## Authentication boundaries

| Principal | Entry | Credential | Accepted on | Role |
| --- | --- | --- | --- | --- |
| Owner | `/admin` | Cloudflare Access JWT (`CF_Authorization` or assertion header; RS256, issuer, `CF_ACCESS_AUD`, `exp`) | `/admin`, `/api/admin/*`, `/api/auth/*` | Always `owner` |
| Staff | `/staff` | `__Host-ls_staff` (SameSite=Strict, 30 min idle, 12 h maximum) | `/staff`, `/api/staff/*`, `/api/staff/admin/*` | `owner` or `manager`, read from D1 on each request |
| Customer | `/account` | `__Host-ls_session` (SameSite=Lax, 7 days idle, 30 days maximum) | `/api/account/*`, signed-in checkout | Customer only |
| Development | loopback | `AUTH_DEV_BYPASS=true` and `APP_ENV=development` | Access-mounted routes only | `DEV_STAFF_ROLE`: `owner` (default) or `manager` |

- The path prefix selects the credential. No route reads two kinds of credential, except private `/media/*`, which accepts Access or staff with `media.read`.
- Handlers check permission strings from `permissions.js`, never role names. A route without an entry in `ADMIN_ROUTES` is denied.
- The order of checks is authentication (401), route (404/405), then permission (403).
- Managers lack these owner permissions: staff, supplier configuration, recognition activation, category deletion, purge, media cleanup, settings, audit, dashboard and infrastructure.
- Staff invitations expire after 72 hours. Suspension or removal revokes sessions at once.
- Missing production Access settings fail closed. `APP_ENV` values other than `development` are production-like.
- Mutations need a same-origin request. JSON endpoints require `application/json`. Throttles store HMAC-keyed buckets. Logs never contain tokens, emails, phones, `sub` values or raw IPs.
- Every staff write records the actor and role in `audit_events`.
- Customer identity is keyed by provider and Google `sub`, never by email.
- Session cookies hold opaque random tokens. D1 stores only their SHA-256 hash.

## Storage
- **D1** (`DB`): all records. Public queries repeat the partial-index predicates exactly: `p.deleted_at IS NULL AND json_extract(p.overrides_json,'$.published')=1`.
- Filter suppliers with `+p.supplier_id IN (...)`. The unary `+` stops a full product scan. Sort large lists in the Worker.
- A migration that adds a supplier column must recreate the `recognition_suppliers_update` trigger with that column.
- **R2 `MEDIA`**: uploads, cutouts, normalized photos, card thumbnails, campaign pictures and storefront images. Without it, uploads return 503.
- **R2 `NP_CATALOG`**: the Nova Poshta snapshot. When `NP_CATALOG` is not bound, the Worker reads `MEDIA`.
- Media rules (details in [MEDIA.md](MEDIA.md)):
  1. Uploads are JPEG, PNG or WebP, at most 5 MB, checked by file signature.
  2. An upload stays private until a published product uses its URL.
  3. A card thumbnail is public only if its source is the first photo of a public product.
  4. Campaign and storefront images are public only while a row holds their key.
  5. The Worker never deletes a referenced object, including photos of trashed products and cart lines.
  6. Removing a photo from a product removes the reference only. External supplier images are never deleted.

## Scheduled jobs

| Job | Where | Schedule | Work |
| --- | --- | --- | --- |
| Supplier sync and retention | Worker `scheduled()` | Production `*/5 * * * *`; staging has no cron | See steps below |
| Nova Poshta snapshot | `np-catalog.yml` | Daily 00:30 UTC | Writes the R2 snapshot. Skips with a notice when R2 keys are missing. |
| Card thumbnails | `card-thumbnails.yml` | Daily 01:40 UTC (production) | Compresses first photos to WebP. Skips when its token is missing. |

Each Worker tick:
1. Erase order personal data 14 days after completion or cancellation, or 90 days after creation.
2. Select at most 5 enabled MyDrop suppliers and EasyDrop suppliers with a feed key.
3. A supplier is due 55 minutes after its last run, or 15 minutes after a pending MyDrop export. The oldest runs first.
4. Run suppliers within a budget of 800 D1 queries. The first supplier always runs. Deferred suppliers go first on the next tick.

## Caching
- `GET /api/products` and `/sitemap.xml` stay in the colo Cache API for 60 seconds. The cache key ignores the query string.
- A successful manager or staff mutation purges the local colo copy. Other colos can be stale for up to 60 seconds.
- Public product media use `max-age=31536000, immutable`. Campaign and storefront images use `max-age=3600`. Private responses use `no-store`.
- Recognition settings and taxonomy load once for each request. No global cache keeps an old version.

## SEO and indexing
- The Worker renders `/products/<slug>` with canonical metadata and Product structured data. Old slugs redirect with 301.
- The sitemap lists published products only. Production `robots.txt` allows all.
- Private paths (`/admin`, `/staff`, `/account`, `/cart` and their APIs) get `noindex, nofollow` and `no-store`.

## Environments

| | Local | Staging | Production |
| --- | --- | --- | --- |
| Worker | `wrangler dev` | `storefront-skeleton-staging` | `storefront-skeleton` |
| Host | `localhost:8787` | `staging.example.com` | `example.com` |
| D1 | local `.wrangler` state | `storefront-skeleton-staging` | `storefront-skeleton` |
| Data | fixtures | synthetic only; no MyDrop key | live supplier inventory |
| Auth | loopback bypass | whole-host Access gate; `ADMIN_HOST` | path-scoped Access application |
| Cron | none | none | `*/5 * * * *` |
| Indexing | n/a | all `noindex`; `robots.txt` disallows all; no sitemap | normal |

- Staging config is generated as `wrangler.staging.json` by `tools/cloudflare-config.mjs`. It never copies a production binding, ID, audience or bypass flag.
- Production config is generated as `wrangler.production.json` with the real D1 UUID. Never deploy the committed placeholder UUID.
