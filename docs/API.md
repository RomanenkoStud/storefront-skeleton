# API reference

This reference describes the Worker API in `apps/api/src/index.js`. Route permissions come from `ADMIN_ROUTES` in `apps/api/src/permissions.js`.

## 1. Conventions

**Base paths.** Public JSON is under `/api/*`. The manager API is `/api/auth/*` and `/api/admin/*`. `/api/staff/admin/*` mirrors every `/api/admin/*` route. Other base paths are `/api/cart/*` (checkout), `/api/account/*` (customer), `/api/staff/*` (staff sign-in) and `/api/delivery/np/*` (Nova Post; it works without D1). Files and HTML are `/media/*`, `/products/:slug`, `/sitemap.xml` and `/robots.txt`.

**JSON.**
- Requests and responses use JSON (`application/json; charset=utf-8`). Multipart uploads are the only exception. Most collections return `{items:[...]}`. Cart lists return `{carts:[...]}`.
- Every non-GET `/api/*` request must send an `Origin` equal to the request origin. Otherwise the API returns `403 Same-origin request required`. `/api/cart/*` does this check itself.
- Admin JSON bodies have a limit of 2 MB. A body that is not a JSON object gives `400`. A wrong `Content-Type` gives `415`. Most write routes reject unknown keys with `400`.
- Times are ISO-8601 UTC strings. Dashboard days use the `Europe/Kyiv` calendar.

**Errors.** The API uses two error styles:
- Catalog, admin, account and staff routes return `{error:"<human text>", code?}`. `code` is a stable value on image routes, for example `too-large`.
- Cart, delivery, visit, order, dashboard and infra routes return `{error:"<snake_case_code>", ...}`.
- Admin dispatch order: authentication (`401`), route match (`404`, or `405` with `Allow`), permission (`403 Not permitted for your role`), then the handler. An unexpected failure gives `500 {error:"Internal server error"}`.

**Money.** Amounts are integers in minor units (kopecks) with `currency:"UAH"`. Field names end in `Minor`, for example `priceMinor`. Infra renewals also accept `USD` and `EUR`. Infra cost estimates are the only exception: they use decimal US dollars (`costUsd`).

**Caching and headers.**
- The default is `Cache-Control: no-store`. Nova Post `200` responses are `public, max-age=300`. Section 3.1 gives the `/media/*` rules.
- The Worker keeps `GET /api/products` and `GET /sitemap.xml` in the colo Cache API for 60 seconds. The key is origin plus path, so the query string has no effect. Browsers get `Cache-Control: no-cache`.
- A successful non-GET request under `/admin`, `/api/admin`, `/api/auth` or `/api/staff/admin` purges the local colo copies. The maximum staleness elsewhere is 60 seconds.
- All responses get `X-Content-Type-Options: nosniff`, `Referrer-Policy: strict-origin-when-cross-origin` and `X-Frame-Options: DENY`.
- Private paths (`/admin`, `/account`, `/staff`, `/cart`, `/api/cart`, `/api/admin`, `/api/auth`, `/api/account`, `/api/staff` and their subpaths) get `X-Robots-Tag: noindex, nofollow` and `no-store`. Their HTML also gets a robots `<meta>` tag. On staging, every response is `noindex`.

**Rate limits.**

| Scope | Limit | Response |
| --- | --- | --- |
| `POST /api/cart/checkout` | 10 per client IP in 10 minutes | `429 rate_limited`, `Retry-After` |
| Google start / callback | Customer: 20 / 30, staff: 10 / 20, per IP in 10 minutes | `429`, `Retry-After` |
| Profile writes / staff management writes | 60 per customer / 30 per actor, per hour | `429`, `Retry-After` |
| `POST /api/visit` | 120 new sessions per IP per hour | `204`. The server does not record the visit. |
| Supplier sync (MyDrop, EasyDrop) | 1 feed request per supplier in 15 minutes | `429`. No fetch occurs. |

## 2. Authentication

| Route prefix | Credential | Rules |
| --- | --- | --- |
| `/admin`, `/api/admin/*`, `/api/auth/*` | Cloudflare Access JWT in `CF-Access-Jwt-Assertion` or the `CF_Authorization` cookie (RS256, issuer, audience, expiry) | An Access principal is always `owner`. If `ADMIN_HOST` is set, these prefixes give `404` on other hosts. |
| Same prefixes, local only | Dev bypass | Needs `AUTH_DEV_BYPASS=true`, `APP_ENV=development` and a loopback host. The role is `DEV_STAFF_ROLE` (`owner` by default, or `manager`). |
| `/staff`, `/api/staff/*`, `/api/staff/admin/*` | `__Host-ls_staff` session cookie (`ls_staff_dev` in local development) from staff Google sign-in | The Worker never accepts Access or customer cookies here. The role is `owner` or `manager`. |
| `/api/account/*` | `__Host-ls_session` cookie (`ls_session_dev` in local development) from customer Google OIDC | The Worker never accepts Access, the bypass or staff cookies here. |
| Public routes | None | `/media/*` also accepts Access or a staff session with `media.read` (see 3.1). |

**Roles.** `owner` has every permission. `manager` has `catalog.read`, `products.edit`, `products.price`, `products.publish`, `products.trash`, `media.upload`, `media.read`, `taxonomy.edit`, `recognition.draft`, `recognition.apply`, `suppliers.sync`, `suppliers.manual`, `products.create`, `orders.read` and `orders.operate`. These permissions are owner-only: `products.purge`, `media.manage`, `taxonomy.delete`, `recognition.activate`, `suppliers.manage`, `settings.manage`, `staff.read`, `staff.manage`, `audit.read`, `analytics.read` and `infra.read`.

**Manager session routes.**

| Method | Path | Permission | Purpose and fields |
| --- | --- | --- | --- |
| GET | `/api/auth/session` | Access, optional | `{authenticated, email?, role?, permissions[], provider:"cloudflare-access", loginUrl:"/admin", logoutUrl:"/cdn-cgi/access/logout"}` |
| any | `/api/auth/login`, `/api/auth/logout` | public | Always `405`. Sign in through `/admin`. Sign out through `/cdn-cgi/access/logout`. |

In the tables below, a path that starts with `/admin/...` is relative to `/api`. The Worker also serves the same route at `/api/staff/admin/...`.

## 3. Endpoints

### 3.1 Public catalog, media and sitemap

| Method | Path | Permission | Purpose and key fields |
| --- | --- | --- | --- |
| GET | `/api/health` | public | `{ok:true}`. It does not read D1. |
| GET | `/api/products` | public | `{items: PublicProduct[]}`. Newest first. Cached for 60 seconds. |
| GET | `/api/products/:slug` | public | One `PublicProduct`, or `404`. A hidden member slug of a merged group returns the shown product. |
| GET | `/api/taxonomy` | public | `{revision, tree, nodes, options, redirects}` |
| GET | `/api/storefront` | public | `{campaign:{mode,categoryId,excluded,sceneId}, ticker:{enabled,items}, checkout:{prepaymentMinor}, campaignPictures, banner, storefrontImages}` |
| POST | `/api/visit` | public, same origin | Body `{type:"view"\|"leave", path, ref?}` as JSON or `text/plain`, at most 2 KB. Always `204` for valid input. The server ignores bots, `DNT`/`Sec-GPC` requests and private paths. |
| GET | `/media/:key` | public or private (see below) | R2 bytes |
| GET | `/products/:slug` | public | Server HTML page with an add-to-cart `GET /cart` form. An old slug or a hidden group member gives `301`. |
| GET | `/sitemap.xml` | public | Published product URLs. Cached for 60 seconds. `404` on staging. |
| GET | `/robots.txt` | public | `Allow: /` and `Sitemap:`. On staging: `Disallow: /`. |

`PublicProduct` = `{id, title, description, category, categoryId, categoryPath, brand, slug, priceMinor, currency, photos, cardPhoto, variants:[{size,stock}], promoText, freeShipping, seoTitle, seoDescription, updatedAt}`. It never contains source data, cost, supplier IDs, external IDs or internal variant IDs.
- The public catalog shows only published, live products of enabled suppliers that are not in Trash. A confirmed duplicate group shows as one product. Its `variants` are the sum, by size, of the contributing members.
- `cardPhoto` is a small WebP thumbnail of `photos[0]`, or `null`. The server does not cache the thumbnail.

**Media access.**
- Keys: `<uuid>.jpg|png|webp` (uploads), `<id>.card.webp` (card thumbnails), `campaign/<uuid>.png|webp` and `storefront/<uuid>.png|webp`. A product photo is public only while a published, visible product uses it. A campaign or storefront picture is public only while its settings row holds the key. Other keys give `404`.
- Public product photos are `public, max-age=31536000, immutable` with an `ETag`, and conditional requests can get `304`. Campaign and storefront pictures are `public, max-age=3600`.
- Access or staff `media.read` can read any key. These responses are always `no-store`.

### 3.2 Cart and checkout

| Method | Path | Permission | Purpose and key fields |
| --- | --- | --- | --- |
| POST | `/api/cart/checkout` | public; a customer session is optional | Body `{lines:[{productId,size,quantity}], delivery?:{warehouseRef}\|null, recipient?:{lastName,firstName,middleName,phone}\|null}`. Response `201 {cart:{code,status:"submitted",createdAt,itemCount,totalMinor,currency,bound,delivery,recipient,lines:PublicCartLine[]}}` |

<a id="customer-cart-and-cart-code-checkout-adr-0007"></a>`PublicCartLine` = `{productId, slug, title, size, quantity, unitPriceMinor, lineTotalMinor, photo}`. The cart summary is `{code, status, createdAt, itemCount, totalMinor, currency}`.

Rules:
- The browser keeps the draft cart (`localStorage` `ls_cart_v1`). The server has no cart state before checkout. It calculates all prices from the public catalog and never accepts browser prices. It does not reserve stock.
- `lines`: 1 to 20 lines. `quantity` is an integer from 1 to 10. Each `(product, size)` pair can occur only once.
- `productId` can be any member of a visible duplicate group. The line then uses the shown product's ID, slug and price. The server takes the quantity from the cheapest suppliers that have stock.
- The handler checks in this order: path (`404 not_found`), method (`405 method_not_allowed`), origin (`403 forbidden_origin`), content type (`415 json_required`), throttle (`429 rate_limited`), size over 64 KiB (`413 payload_too_large`), keys (`400 invalid_request`), lines (`400 invalid_cart` with `problems`), delivery (`400 invalid_delivery`), recipient (`400 invalid_recipient` with `fields`), catalog state (`409 cart_unavailable` with `problems`).
- `problems[]` = `{index, code, field?, min?, max?, firstIndex?, available?}`. Catalog codes: `product_unavailable`, `size_unavailable`, `insufficient_stock`, `duplicate_line`.
- Anonymous checkout: the server ignores `delivery` and does not store `recipient`.
- Signed-in checkout: the server finds `delivery.warehouseRef` in the local Nova Post snapshot. A missing point gives `409 delivery_unavailable`. A missing snapshot gives `503 delivery_catalog_unavailable`. The server stores the point and the recipient on the cart. The point also becomes the profile delivery preference, unless the customer chose a favourite in the cabinet (`origin:"cabinet"`).
- `code` is `SS-XXXX-XXXX` (Crockford base32). Lookups normalize case, separators, `I`/`L` to `1` and `O` to `0`.
- **Prepayment.** `checkout.prepaymentMinor` from `/api/storefront` is a display value on the cart step only. A value of `0` hides it. The server does not store it on carts, and it does not change prices.

### 3.3 Customer account

All routes need the `__Host-ls_session` cookie, except `session`, `google/*` and `logout`. A missing session gives `401 {error:"Sign-in required"}` (`401 {error:"unauthenticated"}` on `carts`).

| Method | Path | Permission | Purpose and key fields |
| --- | --- | --- | --- |
| GET | `/api/account/session` | session, optional | `{authenticated:false}` or `{authenticated:true, customer:{id,displayName,signInEmail,providers,createdAt}}`. Never `401`. |
| POST | `/api/account/google/start` | public, same origin | Body `{}`. Returns `{authorizationUrl}` and sets the OIDC binding cookie (10 minutes, PKCE S256). |
| GET | `/api/account/google/callback` | public | `303` to `/account?status=signed-in`, or to `/account?status=error&reason=expired\|denied\|invalid` |
| POST | `/api/account/logout` | public, same origin | Body `{}`. Returns `{authenticated:false}` and clears the cookie. |
| POST | `/api/account/sessions/revoke-all` | session | Body `{}`. Returns `{revoked}` and clears the cookie. |
| GET | `/api/account/profile` | session | `Profile` |
| PATCH | `/api/account/profile` | session | Body: any of `displayName, lastName, firstName, middleName, phone, contactEmail, deliveryPreference`. `null` clears a field. Returns `Profile`. |
| GET | `/api/account/export` | session | `{customer, identities, profile, auditEvents, carts}`: all stored data, with all carts |
| GET | `/api/account/carts` | session | `{carts: CustomerCart[]}`, newest first, at most 100 |
| DELETE | `/api/account` | session, recent sign-in | Body `{confirm:true}`. The Google sign-in must be in the last 10 minutes (else `403`). Clears the cookie. |

- `Profile` = `{displayName, lastName, firstName, middleName, phone, contactEmail, deliveryPreference, telegram, updatedAt}`. The server normalizes `phone` to `+380XXXXXXXXX`. Each name part has 1 to 40 Cyrillic or Latin letters. `displayName` has at most 80 characters.
- `deliveryPreference` input is `{warehouseRef, note?}` or `null`. The server copies the point data from the Nova Post snapshot. An unknown Ref gives `400`. A missing snapshot gives `503`.
- `CustomerCart` = cart summary plus `{delivery, recipient, personalDataErasedAt, lines:PublicCartLine[]}`. Account deletion clears the recipient and delivery data of the customer's carts. Then it unbinds the carts and keeps the line snapshots.

### 3.4 Admin products

| Method | Path | Permission | Purpose and key fields |
| --- | --- | --- | --- |
| GET | `/admin/products` | `catalog.read` | `{items: AdminProduct[]}`. `?deleted=1` lists Trash. |
| POST | `/admin/products` | `products.create` and `products.price` | Creates a manual product. Body `{supplierId, title, description?, category?, categoryId?, brand?, priceMinor, costMinor?, variants:[{size,stock}], photos?}`. Returns `201 AdminProduct` (unpublished). |
| PATCH | `/admin/products/:id` | `products.edit`; `products.publish` for `published`; `products.price` for `markupType`, `markupValue`, `priceOverrideMinor` | Body: `ProductOverrides` fields. Returns `AdminProduct`. |
| PATCH | `/admin/products/:id/source` | `products.create`; `products.price` for `costMinor` | Manual products only (else `409`). Body `{title?, description?, category?, costMinor?, variants?, photos?}` |
| POST | `/admin/products/bulk` | `products.edit`, plus `products.publish` or `products.trash` by action | Body `{ids (1 to 50), action:"publish"\|"unpublish"\|"delete"\|"restore", confirm?}`. Returns `{updated, action}`. |
| POST | `/admin/products/bulk-tags` | `products.edit` | Body `{ids (1 to 50), add?, remove?}`. Returns `{updated, matched}`. |
| DELETE | `/admin/products/:id` | `products.trash` | Body `{confirm:true}`. Moves the product to Trash and unpublishes it. Returns `{deleted:true}`. |
| POST | `/admin/products/:id/restore` | `products.trash` | Body `{}`. Restores the product as a draft. |
| DELETE | `/admin/products/:id/permanent` | `products.purge` | Body `{confirm:true}`. Returns `{purged:true, mediaDeleted}`. |
| POST | `/admin/products/:id/photos` | `media.upload` | Multipart `file` (JPEG, PNG or WebP, at most 20 MB). Returns `201 {url}`. Does not change the product. |
| GET | `/admin/products/:id/image?url=` | `media.read` | Original image bytes for a photo of this product. Private. At most 20 MB. |
| GET | `/admin/products/:id/image-originals` | `media.read` | `{originals, lineage, storageAvailable}` |
| POST | `/admin/products/:id/cutout` | `media.upload` | Multipart `sourceUrl`, `originalHash`, `file` (PNG, at most 20 MB). Returns `201 {url, originalUrl}`. |
| POST | `/admin/products/:id/normalized` | `media.upload` | Multipart `sourceUrl`, `sourceHash`, `recipe` (at most 1024 bytes), `file` (PNG at canvas size). Returns `201 {url, cutoutUrl, originalUrl}`. |
| GET | `/admin/duplicates` | `catalog.read` | `{candidates, groups, rejections, products, totals}`. Each group has `storefront:{visible,primaryId,slug,priceMinor,sizes}`. |
| POST | `/admin/duplicates/groups` | `products.edit` | Body `{productIds, groupId?, rejectIds?}`. Returns `{groupId, productIds, added, rejected}`: `201` for a new group, `200` when it adds products. |
| DELETE | `/admin/duplicates/groups/:id` | `products.edit` | Body `{}`. Dissolves the group. Returns `{dissolved:true, productIds}`. |
| DELETE | `/admin/duplicates/groups/:id/members/:productId` | `products.edit` | Body `{}`. Removes one member. Returns `{removed, dissolved, productIds}`. The server dissolves a group with fewer than 2 members. |
| POST | `/admin/duplicates/rejections` | `products.edit` | Body `{productIds}` (2 to 20). Marks the products as different items. Returns `{rejectedPairs}`. |
| DELETE | `/admin/duplicates/rejections` | `products.edit` | Body `{productIds:[a,b]}`. Returns the pair to review. Returns `{restored:true}`. |
| GET | `/admin/taxonomy` | `catalog.read` | Same shape as `/api/taxonomy` |
| POST | `/admin/taxonomy/preview` | `taxonomy.edit` | Body `{operation:{type:"create"\|"update"\|"delete", ...}}`. Returns `{token, impact, ...}`. |
| POST | `/admin/taxonomy/apply` | `taxonomy.edit` | Body `{token, confirm:true}` |
| GET | `/admin/recognition` | `recognition.draft` | `{activeVersion, versions, applications, defaults}` |
| POST | `/admin/recognition/drafts` | `recognition.draft` | Body `{settings}`. Saves an immutable draft version. |
| POST | `/admin/recognition/preview` | `recognition.draft` | Body `{versionId, ids?}`. Returns `{token, changed, ambiguous, publishedAffected, samples, ...}`. |
| POST | `/admin/recognition/apply` | `recognition.apply` | Body `{versionId, ids, token, confirm:true}` |
| POST | `/admin/recognition/activate` | `recognition.activate` | Body `{versionId, token, confirm:true}`. Needs a preview of all products. |

`AdminProduct` = the `PublicProduct` fields plus `{supplierId, externalId, source, overrides, computedPriceMinor, priceOverridden, deletedAt, classificationSuggestion, tags}`.

`ProductOverrides` = `{published, title, description, category, categoryId, brand, slug, markupType:"fixed"|"percent", markupValue, priceOverrideMinor, photos, hiddenSizes, promoText, freeShipping, promoStartsAt, promoEndsAt, seoTitle, seoDescription, tags}`. All fields are optional. `null` resets a field to the source or inferred value.

Rules:
- **Publication.** A published product must have a title, a category, `priceMinor > 0`, at least one photo and at least one visible variant. A write that breaks this rule gives `400`. This rule applies to `PATCH`, bulk publish, import and source changes.
- **Price.** `priceMinor` is `cost + markup`, or `priceOverrideMinor` when it is set (1 to 100000000). A change to the override writes the `product.price.override` or `product.price.reset` audit event.
- **Slug.** A new slug must be unique (else `409`). The old slug becomes a `301` redirect. **Tags.** Tags are internal and never public. A change that customers cannot see does not change `updatedAt`, so the storefront order stays the same.
- **Bulk.** The server validates all products before it writes. A failure applies nothing. `delete` needs `confirm:true`. A product of a supplier in Trash gives `409`. A product in Trash gives `409` for `publish`, `unpublish` and `delete`. A product that is not in Trash gives `409` for `restore`.
- **Purge confirmation.** A permanent delete needs `{confirm:true}`, and the product must already be in Trash (else `409`). The server writes a tombstone, so import and sync never create the product again. The server deletes unreferenced owned media. Past carts keep their snapshot.
- **Recognition and taxonomy previews.** A token expires after 15 minutes. It is single use and belongs to the actor. Any catalog change after the preview gives `409`. Manual overrides always take priority over inferred values. **Duplicates.** A group holds 2 to 20 products, at most one product from each supplier. Products in Trash cannot join (`409`).

### 3.5 Suppliers and sync

| Method | Path | Permission | Purpose and key fields |
| --- | --- | --- | --- |
| GET | `/admin/suppliers` | `catalog.read` | `{items: Supplier[], autoSync:{intervalMinutes:60}\|null}`. `?deleted=1` lists Trash. `autoSync` is `null` outside production. |
| POST | `/admin/suppliers` | `suppliers.manage` | MyDrop: `{name, url, connectionId?, enabled?}`. EasyDrop: `{provider:"easydrop", name, feedUrl, enabled?}`. Returns `201 Supplier`. |
| POST | `/admin/suppliers/manual` | `suppliers.manual` | Body `{name, enabled?}`. Returns `201 Supplier` with `provider:"manual"`. |
| PATCH | `/admin/suppliers/:id` | `suppliers.manage` | Body `{name?, enabled?}`, plus `connectionId?` (MyDrop) or `feedUrl?` (EasyDrop). `provider` cannot change. |
| DELETE | `/admin/suppliers/:id` | `suppliers.manage` | Body `{confirm:true}`. Moves the supplier to Trash and disables it. Returns `{deleted, affectedProducts, publishedProducts}`. |
| POST | `/admin/suppliers/:id/restore` | `suppliers.manage` | Body `{}`. Restores the supplier as disabled. |
| POST | `/admin/suppliers/:id/import` | `suppliers.sync` | Body `{items: SourceItem[]}` (1 to 200). Returns `{imported, skippedDeleted?}`. |
| POST | `/admin/suppliers/:id/sync` | `suppliers.sync` | Body `{}`. Returns `{status:"synced", imported, skippedCount?, skippedIds?, skippedNote?}`, or `202 {status:"pending", progress, retryAfterSeconds}` |
| POST | `/admin/suppliers/sync-connected` | `suppliers.manage` | Body `{}`. Finds MyDrop connections. Returns `{total, added, updated, unchanged, skipped}`. It does not import products. |
| GET | `/admin/sync-runs` | `catalog.read` | `{items:[{id, supplierId, status, imported, error, createdAt}]}`, latest 100 |

- `Supplier` = `{id, name, provider:"mydrop"|"easydrop"|"manual", url, connectionId, feed, enabled, deletedAt, productCount, publishedCount, createdAt, lastSyncAt, lastSuccessAt, lastSyncStatus, lastSyncError}`.
- Principals without `suppliers.manage` do not get `connectionId`, and `feed` contains only `{configured}`. The response never contains the EasyDrop key, `pid` or feed link. `feed.keyLast4` is the only part of the key that it shows.
- `SourceItem` = `{externalId, title, description, category, costMinor, currency:"UAH", photos, variants:[{id,size,stock}]}`.

Sync rules:
- **Idempotency.** Import and sync upsert by `(supplier, externalId)`. When the source is the same as the stored one, the server writes nothing and `updatedAt` stays the same. A repeated sync of the same feed changes nothing.
- **Override preservation.** Import and sync replace only the source snapshot. Overrides (price, markup, photos, tags, publication, category, brand) stay the same.
- A refreshed source can make a published product invalid. Import then gives `400`. Sync keeps the old row and reports it in `skippedIds`.
- Import and sync skip products in Trash and products with a tombstone. Sync never restores them.
- A MyDrop sync needs `MYDROP_API_KEY` and a `connectionId` (else `422`). An EasyDrop sync needs a feed link (else `409`). The EasyDrop feed must be XML with HTTP 200 and at most 12 MB.
- A disabled supplier gives `400`. A manual supplier gives `409` for `import` and `sync`. A sync can import at most 5000 products in one batch.
- A failed sync gives `422`. The server records a failed run and does not change the inventory. Error text never contains credentials or feed URLs.

### 3.6 Media library

| Method | Path | Permission | Purpose and key fields |
| --- | --- | --- | --- |
| POST | `/admin/media` | `media.upload` | Multipart `file` (JPEG, PNG or WebP, at most 5 MB). Returns `201 {url, deduplicated?}`. Identical content reuses the existing object. |
| GET | `/admin/media` | `media.read` | `{storageAvailable, graceHours, lastScanAt, summary, items:[{key, url, tracked, size, kind, referencedBy, cartLines, live, orphan, recent, duplicateOf, mergeable, reason, ...}]}` |
| POST | `/admin/media/scan` | `media.manage` | Body `{cursor?}`. Returns `{scanned, added, cursor, done}`. Repeat until `done`. It never deletes. |
| POST | `/admin/media/cleanup` | `media.manage` | Body `{confirm:true, orphans:[key], duplicates:[key]}` (at most 200 keys). Returns `{deleted, merged, skipped, freedBytes}`. |

- An object is live when a product (also in Trash), a cart line or the lineage of a live object refers to it. The server never deletes a live object. It does not delete an orphan younger than `graceHours` (24).
- The server merges a duplicate only when no cart or lineage refers to it. It first moves product photo references to the surviving key.
- When `PATCH /admin/products/:id` removes a `/media` photo, the server deletes the unreferenced object. A purge does the same.

### 3.7 Storefront settings and campaign

| Method | Path | Permission | Purpose and key fields |
| --- | --- | --- | --- |
| GET | `/admin/storefront` | `catalog.read` | Campaign, ticker, checkout and banner values with `*UpdatedAt` and `*Actor`, plus `pictures[]` and `images[]` |
| PUT | `/admin/storefront/campaign` | `settings.manage` | Body `{mode:"auto"\|"category"\|"off", categoryId?, excluded?, sceneId?}`. Without `sceneId`, the stored scene stays the same. |
| PUT | `/admin/storefront/ticker` | `settings.manage` | Body `{enabled, items}` (at most 8 phrases of 40 characters) |
| PUT | `/admin/storefront/checkout` | `settings.manage` | Body `{prepaymentMinor}`: an integer from 0 to 10000000 |
| PUT | `/admin/storefront/banner` | `settings.manage` | Body `{enabled, text, linkLabel, linkHref, startsAt, endsAt}`. Public only while enabled and inside its time window. |
| POST | `/admin/storefront/pictures` | `settings.manage` | Multipart `file`, `categoryId`. Returns `201 {picture:{id,categoryId,src,w,h,position,createdAt,actor}}`. |
| PUT | `/admin/storefront/pictures/order` | `settings.manage` | Body `{categoryId, ids}`: all picture IDs of the category. Returns `{pictures}`. |
| DELETE | `/admin/storefront/pictures/:id` | `settings.manage` | Returns `{deleted:id}`. |
| PUT | `/admin/storefront/images` | `settings.manage` | Multipart `categoryId`, `slot` (`front`, `angle`, `side`, `shoe`, `poster`), `file`. Returns `{image}`. |
| DELETE | `/admin/storefront/images/:categoryId/:slot` | `settings.manage` | Returns `{reset:{categoryId, slot}}`. The storefront then uses the shipped image. |

- Picture and image files must be PNG or WebP, with transparency, not animated, 64 to 1600 px on each side, and at most 2 MB.
- You can add pictures only to a category without subcategories. The limits are 12 pictures for each category and 300 in total (`409`). Without `audit.read`, an actor that is an email address shows as `Власник (Access)`.

### 3.8 Orders

| Method | Path | Permission | Purpose and key fields |
| --- | --- | --- | --- |
| GET | `/admin/carts?status=&q=&page=` | `orders.read` | `{carts, page, pageSize:40, total}`. `q` is part of a code. |
| GET | `/admin/carts/:code` | `orders.read` | `{cart: AdminCart}`. `400 invalid_code`, `404 not_found`. |
| POST | `/admin/carts/:code/status` | `orders.operate` | Body `{status, expectedStatus, note?}`. Returns `{cart: AdminCart}`. |

- `AdminCart` = cart summary plus `{bound, updatedAt, statusChangedAt, statusActor, managerNote, recipient, delivery, personalDataErasedAt, allowedTransitions, lines}`.
- Staff lines add `{supplierId, supplierName, externalProductId, variantIds, unitCostMinor}`. The API shows a merged line once for each supplier part, with `merged:true` and `sourceProductId`.
- Staff views never show the customer ID, the account email or profile data. `delivery` has no Nova Post Refs. Transitions: `submitted` to `verified` or `cancelled`; `verified` to `sent_to_suppliers` or `cancelled`; `sent_to_suppliers` to `completed`.
- The stored status must equal `expectedStatus` (else `409 status_conflict` with `currentStatus`). A transition that is not in the table gives `400 invalid_transition`.
- A non-blank `note` (at most 500 characters) replaces the manager note. A blank note or no note keeps the old note. Each transition writes the `cart.status` audit event. A status change does not send a message and does not change stock.

### 3.9 Dashboard, analytics and infrastructure

| Method | Path | Permission | Purpose and key fields |
| --- | --- | --- | --- |
| GET | `/admin/dashboard?days=7\|30\|90&scope=confirmed\|open` | `analytics.read` | `{range, visits, sales, catalog, conversion, renewals}`. `renewals` is empty without `infra.read`. |
| GET | `/admin/infra?refresh=1` | `infra.read` | `{plan, planUpdatedAt, environment, today, pricing, d1, r2, cloudflare, estimate:{lines, totalUsd, complete}, renewals}` |
| PUT | `/admin/infra/plan` | `settings.manage` | Body `{plan:"workers_paid"\|"workers_free"}` |
| POST | `/admin/infra/renewals` | `settings.manage` | Body `{kind:"domain"\|"subscription"\|"other", name, dueDate, costMinor?, currency?, autoRenew?, notes?}`. Returns `201`. |
| PATCH | `/admin/infra/renewals/:id` | `settings.manage` | Body: any renewal field |
| DELETE | `/admin/infra/renewals/:id` | `settings.manage` | Body `{confirm:true}`. Returns `{deleted:true}`. |

- `scope=confirmed` counts carts with the status `verified`, `sent_to_suppliers` or `completed`. `scope=open` counts `submitted`, `verified` and `sent_to_suppliers`. An unknown infra measurement gives a `null` cost. The server does not guess a cost.
- Visits do not use cookies. The visitor key is a hash with a salt that changes each day. The server does not store the IP address or the user agent. The server keeps visit data for 395 days.

### 3.10 Staff and roles

| Method | Path | Permission | Purpose and key fields |
| --- | --- | --- | --- |
| GET | `/api/staff/session` | staff cookie, optional | `{authenticated:false}` or `{authenticated:true, staff:{id, displayName, email, role, permissions, authenticatedAt, recentAuth}}`. Never `401`. |
| POST | `/api/staff/google/start` | public, same origin | Body `{intent?:"login"\|"reauth"}`. Returns `{authorizationUrl}`. |
| GET | `/api/staff/google/callback` | public | `303` to `/staff?status=signed-in\|reauthenticated`, or to `/staff?status=error&reason=...` |
| POST | `/api/staff/logout` | public | Body `{}`. Returns `{authenticated:false}`. |
| POST | `/api/staff/sessions/revoke-all` | staff cookie | Body `{}`. Returns `{revoked}`. |
| GET | `/admin/staff` | `staff.read` | `{items: StaffMember[]}` |
| POST | `/admin/staff` | `staff.manage` | Body `{email, displayName, role:"owner"\|"manager"}`. Returns `201`. The invitation expires after 72 hours. |
| PATCH | `/admin/staff/:id` | `staff.manage` | Body `{displayName?, role?}` |
| POST | `/admin/staff/:id/suspend` | `staff.manage` | Body `{}`. Revokes all sessions of the member. |
| POST | `/admin/staff/:id/reactivate` | `staff.manage` | Body `{}` |
| POST | `/admin/staff/:id/reinvite` | `staff.manage` | Body `{}`. Gives a new 72-hour invitation. |
| POST | `/admin/staff/:id/sessions/revoke` | `staff.manage` | Body `{}`. Returns `{revoked}`. |
| DELETE | `/admin/staff/:id` | `staff.manage` | Body `{confirm:true}`. Returns `{removed:true}`. |
| GET | `/admin/audit?before=&limit=` | `audit.read` | `{items, next}`. `limit` is 1 to 100 (the default is 50). Send `next` as the next `before`. |

- `StaffMember` = `{id, displayName, role, status, email, invitedEmail, invitationExpiresAt, createdBy, createdAt, updatedAt, lastSignInAt, activeSessions}`.
- A staff session expires after 30 minutes without use or after 12 hours in total. On first sign-in, only an invited email with a verified Google address can bind to a member. After that, the Google `sub` identifies the member.
- A staff session must have a Google sign-in in the last 10 minutes to do management writes. Otherwise the API returns `403 {error, reauth:true}`. A change to an owner, or to the owner role, needs an Access principal. No action can target your own account. The limit is 50 members.

### 3.11 Nova Post

| Method | Path | Permission | Purpose and key fields |
| --- | --- | --- | --- |
| GET | `/api/delivery/np/cities?q=` | public | `{generatedAt, items:[{ref, name, area, branches, postomats}]}`. At most 20 cities. `q` is 2 to 50 characters. |
| GET | `/api/delivery/np/warehouses?cityRef=&kind=branch\|postomat` | public | `{cityRef, kind, generatedAt, items:[{ref, number, name, lat, lon}]}` |

- The server reads only its own R2 snapshot (`np-catalog/v1/` in `NP_CATALOG`). It never calls Nova Post.
- Other methods give `405 method_not_allowed`. Any other query parameter gives `400 invalid_request`. A missing snapshot gives `503 catalog_unavailable`. Refs are lowercase GUIDs. The API accepts uppercase input. The browser never sends coordinates to the server, and the server never stores them.

## 4. Scheduled jobs

| Schedule | Job | Data |
| --- | --- | --- |
| Worker cron `*/5 * * * *` (production only; staging has no cron) | 1. Order personal-data retention | Erases recipient and delivery data on carts 14 days after `completed` or `cancelled`, and 90 days after creation for open carts. At most 200 carts each run. Sets `personalDataErasedAt`. Writes one `cart.pd-retention` audit event with counts only. A failure does not stop the supplier sync. |
| Same tick, after retention | 2. Supplier sync | Syncs up to 5 enabled MyDrop and EasyDrop suppliers that are due. A supplier is due 55 minutes after its last run, or 15 minutes after a `pending` run. The query budget is 800 for each tick. The job never syncs manual suppliers. It uses the same rules as `POST /admin/suppliers/:id/sync`. |
| GitHub Actions `30 0 * * *` (`np-catalog.yml`) | Nova Post snapshot | Writes the R2 snapshot that `/api/delivery/np/*` and checkout read |
| GitHub Actions `40 1 * * *` (`card-thumbnails.yml`, production) | Card thumbnails | Makes the WebP `cardPhoto` images for published products |
