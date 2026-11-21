# ADR-0007: Customer cart and cart-code checkout

Status: **Proposed**. **Partly superseded by [ADR-0011](0011-nova-post-delivery-point.md)** (Proposed): the checkout body may carry an optional Nova Poshta `delivery` point (`{warehouseRef}`, resolved against our local Nova Poshta catalog), which is stored only for signed-in checkouts; see [ADR-0011 Supersession](0011-nova-post-delivery-point.md#supersession) for the exact clauses. The recipient amendment there adds an optional signed-in-only `recipient` (ПІБ and phone, as three separate name parts) on the same terms. The defaults below are the orchestrator's design brief, refined where the code required it. Open questions Q1–Q6 are listed in [Open questions](#open-questions); their defaults apply until the lead answers them. **Amended (lead decisions):** Q1 is answered **yes** (managers see the order's own recipient and delivery point), a fifth status `completed` («Виконано») follows `sent_to_suppliers`, and the order's personal data is erased by a retention job (an explicit exception to the immutability rule); see [Amendment: order completion and retention](#amendment-order-completion-and-retention). This record authorizes no payment provider, no supplier order API, no notification channel and no secret provisioning.

Contract sources, in order of precedence: this record, then [docs/API.md](../API.md#customer-cart-and-cart-code-checkout-adr-0007). The shared pure contract lives in `packages/catalog/cart.js`, and the schema lives in `migrations/0011_carts.sql` and the handlers in `apps/api/src/carts.js`. This record describes what that code implements. The orchestrator's decisions on the points where the first implementation differed from the design are in [Resolved decisions](#resolved-decisions).

## Context

- **No checkout exists.** `docs/PRODUCT.md` says "no checkout/payments/order routing". The Worker product page (`seoHtml` in `apps/api/src/index.js`) says «Онлайн-оформлення замовлення та оплата поки недоступні». Customers currently tell a manager what they want outside the system.
- **Products and sizes.** `PublicProduct.variants` is `[{size, stock}]`. Hidden sizes are removed, and internal variant IDs are never public (`productProjection` in `apps/api/src/domain.js`). Price is per product: `priceMinor`, integer kopecks, UAH, from `retailPrice(source.costMinor, markupType, markupValue)`. Promotions are display text only and never change the price. A product has 1–100 variants. Sizes are not guaranteed to be unique within a product; variant IDs are. `PublicProduct.id` is the product row ID, which is already public.
- **Public predicate.** A product is public when it is published (`overrides_json.$.published = 1`), not in Trash (`products.deleted_at IS NULL`), and its supplier is enabled and not in Trash (`publicRows`/`publicProduct` in `index.js`).
- **Rendering.** `/products/:slug` is Worker-rendered HTML with no JavaScript. The React SPA (`apps/web/src/main.jsx`) owns `/`, `/account`, `/admin` and `/staff`.
- **Customer accounts exist** (ADR-0003). Google OIDC, `/api/account/*`, cookie `__Host-ls_session` (`ls_session_dev` on loopback development). `resolveCustomerSession(request, env)` in `apps/api/src/customer-auth.js` reads only that cookie. Account export and deletion live in `apps/api/src/customer-profile.js` (`handleExport`, `handleDelete`); deletion is a hard delete batch that ends with `DELETE FROM customers`. `PRODUCT.md` forbids customer data in manager responses without a separate decision.
- **Staff permissions** `orders.read` and `orders.operate` exist in `apps/api/src/permissions.js` for both `owner` and `manager`. Admin routes are the single table `ADMIN_ROUTES`, mounted at `/api/admin/*` (Access JWT or loopback bypass) and `/api/staff/admin/*` (staff cookie) through `dispatchAdmin`: 401, then 404/405, then 403. `auditStatement(env, action, resourceId, at, details)` is the single audit writer. `actorLabel(principal, actor)` hides Access emails from principals without `audit.read` (ADR-0006 D12).
- **Throttling.** `throttle(env, secret, bucket, subject, limit, windowSeconds)` is exported from `customer-auth.js`. It stores HMAC-keyed buckets in `customer_auth_throttle`. Before this epic, `hmacSecret(request, env)` and `clientIp(request)` were module-private; the cart task exports them. `hmacSecret` fails closed with 503 when `CUSTOMER_AUTH_HMAC_KEY` is missing outside loopback development.
- **Origin guard.** `route()` in `index.js` calls `checkOrigin(request)` for every non-GET/HEAD/OPTIONS `/api/*` request before any route matching. It returns `403 {error:"Same-origin request required"}`. The cart router handles `/api/cart/*` before this check and checks the origin inside the cart handler.
- **Private paths.** `PRIVATE_PREFIXES` in `index.js` drives `noindex, nofollow` plus `no-store`, including the robots meta injection into SPA HTML. `wrangler.jsonc` `assets.run_worker_first` lists the private SPA paths; `tests/backend/seo-private-paths.test.js` enforces it.
- **Migrations.** `0010` was the latest before this epic; `0011_carts.sql` is the next.

## Options considered

### Where the draft cart lives

| Option | Outcome |
| --- | --- |
| **Browser `localStorage` only until checkout** | **Chosen.** No server state, cookie or personal data before the customer explicitly checks out. Works for anonymous visitors. Display fields are hints; the server re-prices at checkout. |
| Server-side draft cart keyed by a cookie | Rejected. Creates an anonymous tracking identifier, a write path for every click and a storage-growth and abuse surface, with no payment flow that needs it. |
| Server-side draft cart only for signed-in customers | Rejected for now. Two code paths; sync conflicts across devices. Revisit when cross-device carts are requested. |

### What checkout produces

| Option | Outcome |
| --- | --- |
| **Immutable snapshot with a short human code that the customer sends to a manager** | **Chosen.** Fits the manual dropshipping process. No payment, no contact capture, no supplier API. |
| Contact form (name, phone, delivery) on checkout | Rejected. Collects personal data from anonymous visitors before a PII policy for orders exists (Q1). *ADR-0011 captures a delivery point (no name, phone or note) for signed-in checkouts only. The recipient amendment (see ADR-0011 Supersession) adds recipient name (Прізвище, Імʼя, По батькові) and phone, stored for signed-in checkouts only; an anonymous visitor's recipient stays in the browser and goes only into the client-side manager message.* |
| Online payment | Out of scope; no provider is approved. |

### Duplicate lines in the checkout request

| Option | Outcome |
| --- | --- |
| **Server rejects duplicates (`duplicate_line`); the client merges** | **Chosen** (`validateCheckoutLines` and `addLocalLine`). Merging on the server could silently exceed the per-line limit of 10 and hides client bugs. |
| Server merges duplicates | Rejected for the reasons above. |

### Status-change audit storage

| Option | Outcome |
| --- | --- |
| **Reuse `audit_events` with `action='cart.status'`** | **Chosen**. One owner audit view (`GET /api/admin/audit`), the existing actor, type and role columns, and no new table. |
| Separate `cart_events` table | Rejected. Splits the audit view and duplicates the actor model, as ADR-0006 already argued. |

### Cart code

| Option | Outcome |
| --- | --- |
| **`SS-XXXX-XXXX`: 8 Crockford base32 symbols, 40 random bits** | **Chosen.** Easy to read aloud and type into a messenger. Ambiguous letters are excluded. With no public lookup the code is a reference, not a secret, so 40 bits give ample collision headroom. |
| UUID or 128-bit token | Rejected. Too long for a customer to copy into a chat or read on the phone. |
| Sequential number | Rejected. Leaks order volume and invites guessing. |

## Decision

### 1. Local draft cart (`ls_cart_v1`)

- **Storage.** `localStorage` key `ls_cart_v1` (`LOCAL_CART_KEY`). Value: JSON `{version:1, lines:LocalLine[], recent:RecentCart[]}`. Use `parseLocalCart` and `serializeLocalCart` from `packages/catalog/cart.js` for every read and write.
- **`LocalLine`.** `{productId, size, quantity, slug, title, priceMinor, photo}`.
  - `productId` (trimmed, 1–128 characters), `size` (trimmed, 1–100 characters, `MAX_SIZE_LENGTH`, matching the domain variant size limit) and `quantity` (integer 1–10) are required. C0 control characters and DEL are rejected in `productId` and `size`. A line that fails them is dropped.
  - `slug`, `title` (cut to 300 characters), `priceMinor` (non-negative safe integer or `null`) and `photo` are **non-authoritative display hints**. The server never reads them.
  - `slug` must use the catalog slug charset (`^[a-z0-9][a-z0-9-]{0,149}$`, as in `domain.js`), otherwise it becomes `""`.
  - `photo` is kept only if it is an `https:` URL or a same-origin path starting with `/` (not `//`, no backslash, no control characters, at most 2048 characters). Otherwise it becomes `null`. This prevents `javascript:`, `data:` or other schemes from local storage reaching an `<img>` or a link.
- **Merging.** `addLocalLine` merges lines with the same `(productId, size)`, caps the quantity at 10 (`capped:true`), and refuses a 21st distinct line (`full:true`). `addLocalLine` sanitizes the incoming line the same way. When it merges, an empty or missing display field in the new line keeps the existing value. Parsing also merges duplicates.
- **`RecentCart`.** `{code, createdAt, itemCount, totalMinor}` from successful checkout responses, newest first, unique by code, at most 20 (`MAX_RECENT_CODES`). Codes are normalized on read and entries with invalid codes are dropped. The other fields are coerced: `createdAt` is cut to 40 characters (`""` if not a string), and `itemCount` and `totalMinor` become `0` unless they are non-negative safe integers.
- **Corrupt data.** Invalid JSON, a non-object or a different `version` yields an empty cart. Parsing never throws.
- **After checkout.** On `201`, `cartStore.completeCheckout(cart, submittedLines)` (`apps/web/src/cart/cart-store.js`) removes only the submitted lines and quantities: it subtracts each submitted quantity from the matching `(productId, size)` line, so lines and units added in another tab or during the request remain. It then stores the summary in `recent` and shows the confirmation from the response. If storage is unavailable, the cart works in memory only. The cart shows exact prices with no "approximate" label. On every `/cart` visit the client refreshes each line's price and title from the public catalog (`GET /api/products/:slug`, read-only) and marks lines that are unavailable or out of stock. The stored hints are only a fallback until that refresh completes; the server still re-prices authoritatively at checkout.
- **Privacy.** The local cart contains no personal data. The recent-codes section of `/cart` (`apps/web/src/cart/CartPage.jsx`) is shown only when the list is not empty. It notes that the list is stored only in this browser («Список зберігається лише в цьому браузері. На спільному пристрої очистіть його.») and has a «Очистити список кодів» button. After confirmation in a `ConfirmDialog` («Очистити список кодів?»), the button calls `cartStore.clearRecent()`, and the polite `.cart-live` status region announces «Список кодів очищено.»
- **No server state, cookie or personal data** is created before checkout.

### 2. Checkout: `POST /api/cart/checkout`

Body: `{lines:[{productId, size, quantity}]}`. The exact JSON shapes are in docs/API.md.

**Processing order** (the first failing step answers). `/api/cart/*` is routed in `index.js` before the global `checkOrigin`, and `handleCart` runs:

1. Path other than `/api/cart/checkout` → `404 {error:"not_found"}`. Method other than `POST` → `405 {error:"method_not_allowed"}` with `Allow: POST`.
2. `Origin` must equal the request origin → otherwise `403 {error:"forbidden_origin"}`.
3. `Content-Type` must start with `application/json` → otherwise `415 {error:"json_required"}`.
4. Throttle (§10) → `429 {error:"rate_limited"}` with `Retry-After`. Every attempt that reaches this step counts, including invalid ones. Then a bounded throttle cleanup runs (at most 50 rows older than 24 hours; failures are logged and ignored).
5. Body: at most 64 KiB → otherwise `413 {error:"payload_too_large"}`. It must be a JSON object whose only key is `lines` → otherwise `400 {error:"invalid_request"}`. *ADR-0011 also allows an optional `delivery` key and adds steps 6a (`invalid_delivery`) and 8a (`delivery_unavailable`, `delivery_catalog_unavailable`).*
6. Shape: `validateCheckoutLines(body.lines)`. Any problem → `400 {error:"invalid_cart", problems}`.
   - Every problem, here and in step 7, has the shape `{index, code, field?, min?, max?, firstIndex?, available?}`. All problems are reported at once.
   - Codes: `lines_required`, `too_many_lines` (`max`), `invalid_line`, `invalid_product_id`, `invalid_size`, `invalid_quantity` (`min`, `max`), `duplicate_line` (`firstIndex`).
   - `index` is the zero-based position of the line in the request, or `null` for whole-cart problems.
   - Product IDs and sizes are trimmed; C0 control characters and DEL are rejected (`invalid_product_id`, `invalid_size`). Sizes are 1–100 characters and product IDs 1–128.
7. Catalog state: read every requested product with the public predicate, in one query by ID. For each line:
   - The product is not public (unknown ID, draft, Trash, supplier disabled or in Trash) → `product_unavailable`.
   - No source variant that is not in `hiddenSizes` has `size === line.size` → `size_unavailable`.
   - `available` = the sum of stock over those visible variants. Stock is a validated non-negative integer (`domain.js`). `quantity > available` → `insufficient_stock` with `available` (`0` means out of stock).
   - Any problem → `409 {error:"cart_unavailable", problems}`, covering every failing line. Nothing is written (**all-or-nothing**).
8. Customer session: `resolveCustomerSession`. A valid session binds the cart (§5). A missing, stale or invalid cookie means an anonymous checkout. The cart endpoint sets **no cookies**.
9. Pricing on the server only: `unitPriceMinor` = the projected `priceMinor` at this moment. `lineTotalMinor = unitPriceMinor × quantity`. `totalMinor` = the sum. `itemCount` = the sum of quantities (1–200). A total that is not a safe integer → `409 {error:"Cart total exceeds limit"}`. `currency` is the product currency (`UAH`). Browser prices are never read.
10. Snapshot and insert (§3, §4) → `201 {cart}`.

**Stock is not reserved or decremented.** Checkout records a request. The manager verifies availability with the supplier (`verified`).

The read in step 7 and the insert in step 10 are not one transaction (D1 offers only batches). The snapshot is what step 7 observed. A concurrent catalog edit can make it differ from current data; the manager checks this during verification (Q6).

### 3. Snapshot schema (`migrations/0011_carts.sql`)

The tables below are as first committed. *ADR-0011 adds the snapshot columns `dp_type`, `dp_city_name`, `dp_city_ref`, `dp_warehouse_number`, `dp_warehouse_ref` and `dp_warehouse_name` (migration `0012`), set at insert and cleared only on account deletion.* Every integer column also has a `typeof(col) = 'integer'` CHECK, so SQLite type affinity cannot store reals or text there. A row is an **immutable snapshot**: after the insert, only `status`, `status_changed_at`, `status_actor`, `manager_note` and `updated_at` change, plus `customer_id` becoming `NULL` through the foreign key on account deletion. No endpoint deletes carts or lines. **Exceptions (personal data only):** account deletion sets the customer's `dp_*` and `rcpt_*` to `NULL` (ADR-0011 §8), and the retention job sets `dp_*` and `rcpt_*` to `NULL` and `pd_erased_at` to the run time. Nothing else in the row or its lines is ever rewritten. Migration 0027 rebuilt `carts` (to widen the status CHECK) and added `pd_erased_at`.

`carts`

| Column | Type and constraint | Meaning | Visibility |
| --- | --- | --- | --- |
| `id` | `TEXT PRIMARY KEY` | `crypto.randomUUID()` | internal, never in responses |
| `code` | `TEXT NOT NULL UNIQUE CHECK (length(code)=12)` | Stored **formatted**: `SS-XXXX-XXXX` | public to the cart holder and staff |
| `status` | `TEXT NOT NULL DEFAULT 'submitted' CHECK (status IN ('submitted','verified','sent_to_suppliers','completed','cancelled'))` (`completed` since migration 0027) | §7 | customer and staff |
| `customer_id` | `TEXT REFERENCES customers(id) ON DELETE SET NULL` | Bound customer, or `NULL` | **never returned**. Staff see only `bound:boolean`. |
| `item_count` | `INTEGER NOT NULL CHECK (item_count BETWEEN 1 AND 200)` | Sum of quantities | customer and staff |
| `total_minor` | `INTEGER NOT NULL CHECK (total_minor >= 0)` | Sum of line totals, kopecks | customer and staff |
| `currency` | `TEXT NOT NULL DEFAULT 'UAH'` | | customer and staff |
| `created_at` | `TEXT NOT NULL` | ISO UTC checkout time | customer and staff |
| `updated_at` | `TEXT NOT NULL` | Last row change | staff |
| `status_changed_at` | `TEXT NOT NULL` | Equals `created_at` until the first transition | staff |
| `status_actor` | `TEXT` | Audit actor of the last transition; `NULL` while `submitted` | staff, through `actorLabel` |
| `manager_note` | `TEXT` | Latest manager note, at most 500 characters (enforced by the API) | **staff only** |

`cart_lines` (`PRIMARY KEY (cart_id, position)`, `UNIQUE (cart_id, product_id, size)`, `cart_id REFERENCES carts(id) ON DELETE CASCADE`)

| Column | Type and constraint | Meaning | Visibility |
| --- | --- | --- | --- |
| `cart_id` | `TEXT NOT NULL` | Parent cart | internal |
| `position` | `INTEGER NOT NULL CHECK (position >= 0 AND position < 20)` | Zero-based request index; output order | internal (array order) |
| `product_id` | `TEXT NOT NULL` | `PublicProduct.id`. Deliberately **no foreign key**, so the snapshot survives product changes. | public |
| `slug` | `TEXT NOT NULL` | Slug at checkout | public |
| `title` | `TEXT NOT NULL` | Effective public title at checkout | public |
| `size` | `TEXT NOT NULL` | Requested public size label | public |
| `quantity` | `INTEGER NOT NULL CHECK (quantity BETWEEN 1 AND 10)` | | public |
| `unit_price_minor` | `INTEGER NOT NULL CHECK (unit_price_minor >= 0)` | Server retail price | public |
| `line_total_minor` | `INTEGER NOT NULL CHECK (line_total_minor >= 0)` | `unit × quantity` | public |
| `photo` | `TEXT` | First effective public photo, or `NULL` | public |
| `supplier_id` | `TEXT NOT NULL` | **PRIVATE** | staff only |
| `supplier_name` | `TEXT NOT NULL` | **PRIVATE**. `suppliers.name` at checkout | staff only |
| `external_product_id` | `TEXT NOT NULL` | **PRIVATE**. `products.external_id` (the MyDrop product ID) | staff only |
| `variant_ids_json` | `TEXT NOT NULL DEFAULT '[]'` | **PRIVATE**. JSON array of the IDs of the visible source variants with this size that had positive stock at checkout, in source order | staff only |
| `unit_cost_minor` | `INTEGER CHECK (unit_cost_minor IS NULL OR unit_cost_minor >= 0)` | **PRIVATE**. `source.costMinor` at checkout | staff only |

Indexes: `carts(created_at DESC, id DESC)`, `carts(status, created_at DESC, id DESC)`, partial `carts(customer_id, created_at DESC) WHERE customer_id IS NOT NULL`, `cart_lines(product_id)`, and `audit_events(resource_id, created_at)` for the per-cart audit history.

**Projection rule.** Responses are built by explicit allowlists: `PublicCartLine` for public and customer responses, `StaffCartLine` for staff (docs/API.md). The private columns, `customer_id`, `manager_note`, `status_actor` and the internal `id` must never appear in `/api/cart/*` or `/api/account/*` responses. Tests assert the absence of each private key.

### 4. Cart code

- **Format.** `SS-XXXX-XXXX`: the prefix `SS`, then 8 symbols of the Crockford base32 alphabet `0123456789ABCDEFGHJKMNPQRSTVWXYZ` (no `I`, `L`, `O`, `U`), split 4 + 4 by hyphens. The stored and returned form is always this formatted string.
- **Generation** (`generateCode`). 8 bytes from `crypto.getRandomValues`; each symbol is `ALPHABET[byte & 31]`. Because 256 is a multiple of 32, masking is exactly uniform (no modulo bias, no rejection needed). That is 40 bits. `Math.random` is never used.
- **Uniqueness.** The insert relies on `UNIQUE(code)`. The cart and its lines are inserted in one D1 batch. On a `UNIQUE` violation **on `carts.code`**, a new code is generated and the batch retried, up to 5 attempts in total. Then `503 {error:"code_unavailable"}`, which is logged. Any other error is not retried. With 2^40 codes, about one collision is expected per million carts; five consecutive collisions are practically impossible.
- **Never reused.** Carts are never deleted by the application, so a code identifies one cart forever.
- **Normalization** (`normalizeCode`, used by every lookup):
  1. Reject non-strings and input longer than 64 characters.
  2. Apply Unicode NFKC (folds full-width letters and digits), then uppercase.
  3. Remove whitespace, ASCII hyphens, the dashes U+2010–U+2015, dots and underscores, as messengers and manual retyping insert them.
  4. Map `I` and `L` to `1`, and `O` to `0` (Crockford decoding).
  5. If 10 symbols remain and they start with `SS`, drop that prefix. An 8-symbol body that happens to start with `SS` is kept.
  6. Exactly 8 alphabet symbols must remain (`U` is rejected), otherwise the input is invalid (`null`).
  7. Return the formatted `SS-XXXX-XXXX`.
- **Presentation.** The confirmation shows the code in large monospace text with a copy button, plus a prefilled message for the manager. `managerMessage` (`apps/web/src/cart/cart-api.js`) builds it from the response: «Вітаю! Це мій код кошика на Lorem Store: SS-XXXX-XXXX.», then «Склад:» with one line per item (`- title (size) × quantity`), then «Сума: …» and «Будь ласка, перевірте замовлення.» The message is composed by the client.
- **Not a credential.** There is no public lookup by code (Q5). Possession of a code proves nothing. Managers must not treat it as proof of identity.

### 5. Customer profile binding

- At checkout, a valid customer session sets `carts.customer_id`, and the response has `bound:true`. Anonymous checkout always works and gives `bound:false`. The cart endpoint never reads Access JWTs, the dev bypass or the staff cookie.
- **`GET /api/account/carts`** (customer session) lists the customer's own carts, newest first, at most 100, each with its public lines. It joins the `ROUTES` table in `customer-auth.js`: `401 {error:"unauthenticated"}` without a session (a stale cookie is cleared), `405` for other methods.
- **Export.** `GET /api/account/export` gains `carts`. `handleAccount` in `customer-auth.js` wraps the `handleExport` response; `customer-profile.js` is unchanged. It contains **all** bound carts, without the 100-cart cap of `GET /api/account/carts`.
- **Deletion.** `DELETE /api/account` unbinds: `carts.customer_id` becomes `NULL` through `REFERENCES customers(id) ON DELETE SET NULL`, and the snapshot stays for the manager. `handleDelete` is unchanged. D1 enforces foreign keys, and this is verified on local D1 and in `tests/backend/carts.test.js`. Follow-up: an explicit `UPDATE carts SET customer_id=NULL WHERE customer_id=?` in the deletion batch, as defense in depth.
- **No claiming.** An anonymous cart cannot be attached to an account by code in this epic (Q5).
- **Manager boundary.** *Superseded (Q1 = yes).* Staff responses expose `bound:boolean` and the order's own snapshot: the recipient (`rcpt_*`: Прізвище, Імʼя, По батькові or the legacy single name, and the phone) and the delivery point (`dp_type`, `dp_city_name`, `dp_warehouse_number`, `dp_warehouse_name`; not the Nova Poshta Refs), to every principal with `orders.read`. They still never expose the customer ID, the sign-in email, identities or any profile data (contacts, display name, the remembered Nova Poshta preference). Viewing is not audited (no read audit, §6). Original text: staff responses expose only `bound:boolean`, never the customer ID, name, email, phone or Nova Poshta preference.

### 6. Manager endpoints

Three entries join `ADMIN_ROUTES`, so they are served under both `/api/admin` and `/api/staff/admin`, with the existing 401 → 404/405 → 403 order:

| Route ID | Method and subpath | Permission |
| --- | --- | --- |
| `carts.list` | `GET /carts?status=&q=&page=` | `orders.read` |
| `carts.get` | `GET /carts/:code` | `orders.read` |
| `carts.status` | `POST /carts/:code/status` | `orders.operate` |

- **List.** Newest first (`created_at DESC, id DESC`, matching the indexes), 40 per page, `{carts, page, pageSize:40, total}`.
  - `status` is optional and must be one of the five statuses (four before the completion amendment).
  - `q` is optional: a **partial, case-insensitive substring** match on the code body (orchestrator decision; the T5 UI depends on it). The input is cut to 64 characters, then folded the same way as `normalizeCode`: NFKC, uppercase, strip whitespace, `-`, U+2010–U+2015, `.` and `_`, map `I`/`L` to `1` and `O` to `0`, and drop a leading `SS`. LIKE wildcards are escaped. The fragment is matched against the 8-symbol body (the code without `SS-` and hyphens). A fragment longer than 8 symbols matches nothing; an empty folded fragment applies no filter.
  - `page` is an integer of at least 1 (1–5 digits), default 1. A page past the end returns an empty `carts`.
  - An invalid `status` or `page` → `400 invalid_request`.
- **Detail.** `:code` is URL-decoded, then normalized. Invalid → `400 invalid_code`. Unknown → `404 not_found`. The response includes the private supplier fields, `bound`, `statusActor` (through `actorLabel`), `managerNote` and `allowedTransitions` (`CART_TRANSITIONS[status]`; the UI additionally hides actions without `orders.operate`). Since the completion amendment the list and detail also carry `recipient`, `delivery` and `personalDataErasedAt` (the manager boundary in §5). No customer account data.
- **Status change.** §7.
- **No read audit**, consistent with other admin reads.

### 7. Status machine

```
submitted ──► verified ──► sent_to_suppliers ──► completed   (terminal)
    │            │
    └────────────┴──────► cancelled                         (terminal)
```

- The transitions are exactly `CART_TRANSITIONS` in `cart.js`: `submitted → verified | cancelled`, `verified → sent_to_suppliers | cancelled` and `sent_to_suppliers → completed`. `completed` and `cancelled` are terminal; `sent_to_suppliers` was terminal before the completion amendment and now only leads to `completed` (it still cannot be cancelled). There is no way back and no customer cancellation in this epic. `completed` uses the same endpoint, permission (`orders.operate`), concurrency guard and `cart.status` audit as every other transition.
- **Request.** `POST …/carts/:code/status` with `{status, expectedStatus, note?}`. `note` is a string of at most 500 characters **after trimming**, or `null`. A note that is non-empty after trimming replaces `manager_note`. An omitted, `null` or blank note keeps the existing note (`COALESCE`). There is no way to clear a note; this is the accepted contract.
- **Order of checks.** The admin preconditions run first, as for every admin route: the global origin check on `POST` (`403 {error:"Same-origin request required"}`), then authentication (`401`), then route matching (`404`/`405`), then the permission check (`403`). The handler then checks:
  1. `invalid_code` (400).
  2. `json_required` (415).
  3. Body read, at most 8 KiB. An oversize, malformed or non-object body → `invalid_request` (400).
  4. Unknown keys, non-status values or a bad note → `invalid_request` (400).
  5. `canTransition(expectedStatus, status)` is false → `invalid_transition` (400).
  6. Cart missing → `not_found` (404).
  7. Current status differs from `expectedStatus` → `409 {error:"status_conflict", currentStatus}`.
- **Optimistic concurrency.** The update is `UPDATE carts SET status=?, status_changed_at=?, updated_at=?, status_actor=?, manager_note=COALESCE(?,manager_note) WHERE code=? AND status=?expectedStatus`.
- **Audit.** In the **same D1 batch**, `INSERT INTO audit_events … SELECT … WHERE changes() > 0` writes `action='cart.status'`, `resource_id` = the code, and `details_json={from, to, noteChanged}`, with the actor, type and role of `env.PRINCIPAL`. `noteChanged` is `true` when a non-blank note was supplied. **Note text is never written to audit**, because it may contain personal data.
- **Conflicts.** There are two kinds of `409 status_conflict`:
  - If the guarded `UPDATE` matched no row, nothing changes and no audit row is written.
  - After the batch, the handler re-reads the cart (`carts.js`). If the re-read does not show this transition with this request's `status_changed_at`, it also answers `409` with the re-read `currentStatus`. This can follow a transition that was applied and audited, for example when another manager changed the cart again in between.
  - In either case the client reloads the cart and shows its current state.
- **Success.** `200 {cart}` in the detail shape.

### 8. Manual supplier hand-off

`sent_to_suppliers` only records that a manager has placed the supplier orders by hand, for example in the MyDrop cabinet. The Worker makes no MyDrop order API call, sends no message or notification, and changes no stock (Q3, Q4). The manager view groups lines by `supplierId`, in first-appearance order. Each group shows `supplierName`, and each line its `externalProductId`, `size`, `quantity`, `unitCostMinor` and `variantIds`, so that ordering by hand is quick. The supplier hand-off text that the manager UI copies contains no retail prices.

### 9. Lifetime

There is no expiry. A cart stays `submitted` until a manager acts (Q2). The cart and its lines are kept; its personal data is not: the recipient and delivery point snapshot is erased 14 days after the cart reaches `completed` or `cancelled`, and at the latest 90 days after creation. An unbound cart holds no personal data.

### 10. Throttling

- Checkout: bucket `cart-checkout`, subject `clientIp(request)` (`CF-Connecting-IP`), **10 attempts per 600 seconds**, through `throttle(env, hmacSecret(request, env), …)` and the `customer_auth_throttle` table. `429 {error:"rate_limited"}` with `Retry-After` in seconds.
- `hmacSecret` and `clientIp` are exported from `customer-auth.js`. Outside loopback development, a missing `CUSTOMER_AUTH_HMAC_KEY` makes checkout fail closed with `503 {error:"Customer sign-in is not configured"}`, so staging and production need that existing secret.
- `GET /api/account/carts` and the admin routes are not throttled (session-scoped; consistent with existing reads).

### 11. Pages, indexing and caching

- **`/cart`** is an SPA route in `apps/web`. `PRIVATE_PREFIXES` gains `/cart` and `/api/cart`, so `/cart`, `/cart/*` and `/api/cart/*` get `X-Robots-Tag: noindex, nofollow`, `Cache-Control: no-store` and the injected robots meta. `wrangler.jsonc` production `run_worker_first` gains `/cart` and `/cart/*` (`/api/*` is already listed; staging is already `true`). The sitemap never lists `/cart`. `robots.txt` stays allow-all.
- **`/api/cart/*`** has one route, `POST /api/cart/checkout`. Another method on it → `405`; any other `/api/cart/*` path → `404`. Every response is `no-store` (also via the private-path rule).
- **No-JS product page form.** `seoHtml` adds `cartForm(product)` under «Розміри та наявність», before the sizes list: a `GET` form to `/cart` with a hidden `add=<slug>`, a `<fieldset>` with `<legend>Оберіть розмір</legend>` and one labelled `size` radio per distinct visible size whose summed stock is positive (the first radio has `required`; none is pre-checked), a labelled `qty` number input «Кількість» (`min=1 max=10 value=1`), and the button «Додати до кошика». With no in-stock size there is no form. All values are escaped with `escapeHtml`.
- **SPA `/cart?add=<slug>&size=<size>&qty=<n>`.** `parseAddParams` (`cart-api.js`) clamps `qty` above 10 to 10 and falls back to 1 for missing, non-numeric or non-positive values. The SPA fetches `GET /api/products/:slug`. `cartStore.addProduct` accepts only a visible size with positive stock, merges through `addLocalLine` with `product.id` and the display hints, and caps the line at the available stock (`stock_capped`). It shows a notice «`{title}, {size}: Додано до кошика.`», or the status text for `merged`, `capped`, `stock_capped`, `full`, `unavailable` or a missing size. It then calls `history.replaceState` with `cleanedCartUrl`, which removes only `add`, `size` and `qty` and keeps other parameters and the hash, so a reload does not add the item again. The parameters never cause a server write.
- **React storefront cards** may offer the same action with a size picker. They use the same `addLocalLine`.
- **Product page note text** changes from «Онлайн-оформлення замовлення та оплата поки недоступні» to «Оформіть кошик — ви отримаєте код кошика. Надішліть його менеджеру, і він підтвердить наявність та доставку.»

## Remaining differences from existing conventions

The cart endpoints follow the orchestrator's pinned shapes. These differences from older endpoints remain:

1. **Account 401 wording.** `GET /api/account/carts` answers `401 {error:"unauthenticated"}`. The other `/api/account/*` routes still answer `401 {error:"Sign-in required"}` (ADR-0003). Account clients should rely on the `401` status.
2. **Collection key.** docs/API.md says collections return `{items}`. The cart endpoints use `{carts}`.
3. **Error style.** Existing endpoints return human-readable `error` strings. The cart endpoints return snake_case machine codes, except the shared paths: admin authentication and permission errors, the global origin check on admin `POST`s, the throttle-key `503` ("Customer sign-in is not configured") and the safe-integer `409` ("Cart total exceeds limit").

## Resolved decisions

The orchestrator settled the differences found in the first implementation. They are implemented and are part of the contract above.

| ID | Topic | Decision |
| --- | --- | --- |
| D1 | Note text in audit | Not stored. `details_json` is `{from, to, noteChanged}`. |
| D2 | Clearing a manager note | Accepted as built: a blank or missing note keeps the existing one. The 500-character limit applies to the trimmed note. |
| D3 | Unknown top-level checkout keys | `400 {error:"invalid_request"}` |
| D4 | No unique code after 5 attempts | `503 {error:"code_unavailable"}` |
| D5 | Carts in the account export | All bound carts. `GET /api/account/carts` stays capped at 100. |
| D6 | Product page note | «Оформіть кошик — ви отримаєте код кошика. Надішліть його менеджеру, і він підтвердить наявність та доставку.» |

Also decided:
- Admin `q` uses `normalizeCode`-style folding against the code body (§6).
- Checkout runs a bounded throttle cleanup (§2).
- The supplier hand-off text copied from the manager UI excludes retail prices (§8).
- The lead removed the payment sentence («Онлайн-оплати немає.») from the product page note and the approximate-price wording from the cart; the frontend shows exact prices. The SPA confirmation and the SPA detail note now follow D6 and drop «зв’яжеться з вами».
- A checkout idempotency key is a tracked follow-up (P3). Until then, a retried request after a lost `201` creates a second cart.

## Consequences

- **First order data.** The catalog now stores order snapshots. Supplier costs and IDs are copied into `cart_lines`, which are private to staff with `orders.read`. Managers already see costs through `catalog.read` on `AdminProduct`, so no new audience gains access.
- **Supplier snapshot and manager overlay stay separate.** Checkout only reads the projection; it never writes `products` or `suppliers`.
- **No reservation.** Two customers can check out the last item. Managers resolve this during verification.
- **Customer separation holds.** Staff see `bound` and, since the completion amendment, the order's own recipient and point snapshot, never account or profile data. Customer routes never return private columns. The cart endpoint reads only the customer cookie.
- **New failure mode.** Checkout needs `CUSTOMER_AUTH_HMAC_KEY` in production-like environments. Without it, checkout returns `503` but browsing is unaffected.
- **Spam surface.** Anonymous checkout lets anyone create `submitted` carts, bounded per IP by the throttle. A distributed source could still fill the list; see the revisit triggers.
- **The checkout price may still differ from the price shown.** The cart refreshes prices from the public catalog on each visit, but the server re-prices authoritatively at checkout and the confirmation always shows server prices. If the confirmed total differs from what was shown, the confirmation shows «Ціну оновлено».
- **Snapshot drift** from the current catalog is not shown in this epic (Q6).

## Shared-file ownership for the epic

| Task | Owns |
| --- | --- |
| T1 (this) | `docs/adr/0007-customer-cart-checkout.md`, `docs/adr/README.md`, `docs/API.md`, `docs/ARCHITECTURE.md`, `docs/PRODUCT.md` |
| T2 | `migrations/0011_carts.sql`, `packages/catalog/cart.js`, contract tests, test stubs, `package.json` test list |
| T3 | `apps/api/src/carts.js`, `apps/api/src/index.js`, `apps/api/src/permissions.js`, `apps/api/src/customer-auth.js` (`customer-profile.js` unchanged), `wrangler.jsonc`, `tests/backend/carts.test.js`, `tests/backend/seo-private-paths.test.js` |
| T4 | `apps/web/src/cart/*`, `Storefront.jsx`, `main.jsx`, `apps/web/src/account/*`, `streetwear.css`, `tests/frontend/cart.test.js` |
| T5 | `apps/web/src/orders/*`, `styles.css`, `tests/frontend/orders.test.js` |

## Open questions

Each default applies until the lead answers. The orchestrator tracks them in Beads.

| ID | Question | Default applied |
| --- | --- | --- |
| Q1 | Should managers see the bound customer's contact and Nova Poshta details on a bound cart? | **Answered: yes**. Owners and managers see the order's own recipient and point snapshot; never the account, its email or profile. |
| Q2 | Cart code expiry and retention | No code expiry. Personal data retention decided: 14 days after `completed`/`cancelled`, at most 90 days after creation. |
| Q3 | Automated supplier order routing through the MyDrop order API | Manual. `sent_to_suppliers` is a status only. |
| Q4 | Notify managers of new checkouts (Telegram, email) | None. Managers poll the list. |
| Q5 | Anonymous status lookup by code, and claiming an anonymous cart into an account | Not offered. |
| Q6 | Price and stock drift between checkout and verification: show current values next to the snapshot? | Snapshot only. Comparison is a follow-up. |

## Revisit triggers

- The lead answers any of Q1–Q6.
- Spam carts appear despite the per-IP throttle: add a global hourly cap, a proof-of-work or a CAPTCHA-free challenge, or require sign-in.
- Q5 adds a public lookup by code: add a dedicated per-IP throttle and reconsider the 40-bit length.
- Payments or delivery booking are introduced: a new ADR for order PII, money capture and ASVS L2 for order data.
- Customers ask for carts across devices: reconsider a server-side draft for signed-in customers.
- Managers need to edit a note without changing status, or add internal comments: add a separate note endpoint with its own audit action.
- Managers start putting personal data into `manager_note`: the note is not erased by retention, so add a note retention rule or a stricter input check.
- Defense in depth for immutability: add `BEFORE UPDATE` triggers on `cart_lines` and on the snapshot columns of `carts`, plus a trigger enforcing `CART_TRANSITIONS`, in a later migration. This needs verification that D1 migrations apply them.

## Amendment: order completion and retention

Lead decisions, implemented by migration `0027_order_completed_retention.sql`, `packages/catalog/cart.js` (`CART_TRANSITIONS`, `ORDER_PD_RETENTION`, `CLOSED_STATUSES`), `apps/api/src/carts.js`, `apps/api/src/order-retention.js` and `apps/web/src/orders/*`.

1. **Q1 answered yes.** Every staff principal with `orders.read` (owner and manager) sees, on the order list and detail, «Отримувач» (Прізвище Імʼя По батькові or the legacy name, and the phone) and «Доставка» (type, city, branch or postomat number, warehouse name). Projection by explicit allowlists in `carts.js` (`staffRecipientOf`, `staffDeliveryOf`): no customer ID, email, identities, profile data or Nova Poshta Refs. Existing audit behaviour is kept: staff reads are not audited.
2. **Status `completed` («Виконано»).** Only from `sent_to_suppliers`, terminal, `orders.operate`, audited as `cart.status` `{from:"sent_to_suppliers", to:"completed", noteChanged}`. SQLite cannot alter the inline status CHECK of `0011`, so `0027` rebuilds `carts`. On D1 foreign keys are always enforced and `defer_foreign_keys` does not defer `ON DELETE CASCADE`, so dropping `carts` while `cart_lines` referenced it would delete every line. The migration therefore copies `cart_lines` into a constraint-free backup and drops it, rebuilds `carts` (explicit column lists, new `pd_erased_at`), renames it, recreates `cart_lines` with its original definition, restores the rows and recreates all indexes. No trigger or view references these tables. Verified by `tests/backend/carts.test.js` (populated database: rows, lines, columns, foreign keys, indexes, CHECKs, `SET NULL`/`CASCADE`) and once on local D1 through `wrangler d1 migrations apply --local`.
3. **Retention of order personal data.** The cart's `rcpt_*` and `dp_*` are set to `NULL` 14 days after the cart reaches `completed` or `cancelled` (`status_changed_at`), and as a backstop 90 days after `created_at` for a cart that is never closed. `purgeExpiredOrderPersonalData(env, now)` runs first in the Worker `scheduled` handler (production cron in `wrangler.jsonc`), at most 200 carts per run, oldest first, idempotent, and marks each erased row with `pd_erased_at`. A run that erased something writes one `audit_events` row `cart.pd-retention` (actor `system`) with counts only. Staff and the customer see «Персональні дані видалено (термін зберігання)». **Immutability exception:** this job and account deletion are the only writers of the snapshot columns after checkout, and both only set personal data to `NULL`. `manager_note` is kept; managers must not put personal data in it, and the note field says so. The staging Worker has no cron (deliberately: it would also start supplier sync on staging), so the job does not run on staging.
4. **Privacy notice.** `docs/legal/privacy-notice.uk.md` is a template. The operator writes the real notice, which must describe the order data, who sees it and these periods.

