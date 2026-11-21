# ADR-0006: Staff roles and staff Google sign-in

Status: **Proposed**. The lead accepts or amends this record. It authorizes no Cloudflare Access change, Google Cloud change, secret provisioning or deployment. The lead-only steps are in [Lead-only actions](#lead-only-actions). The decisions the lead must make are in [Lead decisions](#lead-decisions).

This record amends a rule that ADR-0001, `AGENTS.md`, `docs/ARCHITECTURE.md` and `docs/PRODUCT.md` state today: managers get no self-issued session. The lead asked for staff Google sign-in. After acceptance, the orchestrator updates those rule texts in a separately owned docs change. Until then, the current rules apply.

## Context

- **One principal today.** Every identity that the Cloudflare Access manager application admits is a full manager. `apps/api/src/auth.js` `identity()` verifies the Access RS256 JWT (team JWKS, issuer, `CF_ACCESS_AUD`, `exp`, `nbf`, email claim). It reads the `CF-Access-Jwt-Assertion` header or the `CF_Authorization` cookie. It returns `{email}`. `AUTH_DEV_BYPASS=true` returns `dev@localhost` on a loopback hostname when `APP_ENV !== "production"`.
- **The admin router.** `apps/api/src/index.js` handles `/api/admin/*` as one `if` chain. It calls `identity()` once, sets `AUDIT_ACTOR` to the verified email and then matches paths. Any authenticated identity may call any route. An unmatched admin path falls through to the global `404`. `serveMedia` uses `authenticated()` to reveal draft uploads. `/admin` pages require `authenticated()`.
- **Edge gate.** The production Access application protects `/admin`, `/admin/*`, `/api/admin/*` and `/api/auth/*` on `example.com` and the `workers.dev` host. Its Allow policy admits the two current Access-allowed owner identities. Access re-scoping needs explicit lead approval.
- **Customers.** Customers use Google OIDC (ADR-0003, `customer-auth.js`, `google-oidc.js`). Customers have their own tables (`migrations/0004`, `0006`), the cookies `__Host-ls_session` and `__Host-ls_oidc`, and `/api/account/*`. Customer code never imports `auth.js`.
- **Audit.** `audit_events(id,actor,action,resource_id,created_at)` stores a bare actor string. `recognition.js` and `taxonomy.js` write the same table. They also bind preview tokens to `AUDIT_ACTOR` (`preview.actor!==env.AUDIT_ACTOR`).
- **Staging (ADR-0005; implemented).** Staging has a gate host, `staging.example.com`, gated for the whole host for the lead, the managers and the testers. It also has an admin host, `ADMIN_HOST=staging-admin.example.com`, with its own Access application.
  - When `ADMIN_HOST` is set and the request host differs, `route()` in `index.js` returns `404` for `MANAGER_PREFIXES = ['/admin','/api/admin','/api/auth']` before anything else runs.
  - `env.staging` sets `assets.run_worker_first: true`. The production `run_worker_first` stays a path list.
- **Migrations.** `0001`–`0007` exist. The next free number is `0008`.
- **Orders.** There is no order domain yet. Order permissions are reserved names here and take effect when orders exist.

Lead requirements:

1. **Owner (super admin).** Any identity that the Access manager application authenticates. Owners have full rights, including staff management.
2. **Manager.** Operates orders once they exist. Creates, edits and publishes items. Creates and edits categories. A manager has no staff management, settings, deploy or integration configuration, supplier credentials or other owner-only areas.
3. **Staff Google sign-in.** Owners and managers can also sign in with Google. This uses a separate staff session and cookie that a customer session can never satisfy, even for the same Google account or email. Staff identity is a verified Google `sub` matched against an owner-managed staff table. Access sign-in keeps working for owners.

## Options considered

### How Access and Google staff sign-in coexist

| Option | Access change | Edge protection of existing paths | Google-only staff can work | Notes |
| --- | --- | --- | --- | --- |
| **A2. Separate un-gated staff mount: `/staff` and `/api/staff/*`, with the admin route table mounted twice** | **None** | Unchanged. `/admin`, `/api/admin/*` and `/api/auth/*` stay gated exactly as today. | Yes | One route table serves `/api/admin/<r>` (Access principal only) and `/api/staff/admin/<r>` (staff cookie only). The prefix decides which credential is read. **Recommended.** |
| A1. Un-gate `/api/admin/*`, which then accepts either the Access JWT or the staff cookie | The lead removes `/api/admin/*` from the Access application destinations | Lost for `/api/admin/*`. It relies only on the Worker, as `/api/account/*` already does. | Yes | Safe in either order, because the current Worker already returns 401 without a valid Access JWT (see [A1 fallback](#a1-fallback-un-gate-apiadmin)). One API prefix, but it mixes two credential types on one route. |
| B. Keep everything gated and add managers to the Access policy | Owner-managed policy edits on every hire | Unchanged | No Google sign-in | Contradicts the lead's Google requirement. Every manager would become an owner by the "any Access identity is an owner" rule, unless the D1 table also keys roles by Access email. Rejected. |
| C. Separate staff host, for example `staff.example.com` | None on the production application. Needs a new custom domain and DNS. | Unchanged | Yes | Cleanest cookie isolation. But it adds a hostname, OAuth origins, staging hosts and canonical/robots handling for a small team. Rejected for now; see revisit triggers. |

### Google OAuth client

| Option | Consent screen | `aud` | Secret blast radius | Outcome |
| --- | --- | --- | --- | --- |
| **Separate "Web application" client in the same Google Cloud project** | Shared. The consent screen is per project, so branding and the test-user list are the same. | Different from the customer client | A staff secret leak does not affect customers, and the reverse | **Recommended.** $0 and one dashboard action. |
| Reuse the customer client and add the staff redirect URI | Shared | Same `aud` | Shared | Acceptable fallback. Separation then rests on the separate flow tables, nonces, `redirect_uri` binding at the code exchange and server-side-only token handling. The code reads separate variable names, so this is a configuration choice and not a code change. |
| Separate Google Cloud project | Separate (for example "Lorem Store staff") | Different | Separate | More setup, and a second consent screen to maintain. Not needed. |

### Can the staff table downgrade or suspend an Access identity?

| Option | For | Against | Outcome |
| --- | --- | --- | --- |
| **Access identity is always an owner. D1 cannot change it.** | Matches the lead's definition. D1 can never lock the lead out. No email-keyed authorization in D1. Works with an empty staff table, so no migration step is needed. | Removing or suspending an owner needs a lead change to the Access policy, plus revoking that user's Access sessions in Zero Trust. | **Recommended.** |
| D1 overlay keyed by the Access email (downgrade or suspend) | Owners could be managed in the app | Email-keyed authorization. A bad or compromised D1 write could lock out every owner. Needs a bootstrap seed containing emails. | Rejected |
| Owner list in config (`OWNER_EMAILS`) | Explicit | Duplicates the Access policy, puts emails in configuration, and drifts | Rejected |

### Flow and session storage

| Option | Outcome |
| --- | --- |
| **New tables `staff_sessions`, `staff_auth_flows` and `staff_auth_throttle`** | **Chosen.** The customer flow table has a `customer_id` foreign key and CHECKs tied to customer intents. Separate tables make cross-consumption structurally impossible: the staff callback can only `DELETE … RETURNING` from `staff_auth_flows`. |
| Reuse `customer_auth_flows` with `intent='staff-login'` | Rejected. A single bug in a provider or intent predicate would let one flow finish the other. It also breaks ADR-0003's "customer tables hold no manager data". |

### Audit storage

| Option | Outcome |
| --- | --- |
| **Extend `audit_events` with `actor_type`, `actor_role` and `details_json`** | **Chosen.** One owner audit view. The existing writers in `index.js`, `recognition.js` and `taxonomy.js` gain the columns through one helper. Old rows keep `NULL`. |
| Separate `staff_audit` table | Rejected. It would split the audit view and duplicate the actor model. |

## Decision

### 1. Roles and principals

There are two roles, `owner` and `manager`, and three ways to become a staff principal. A principal is computed per request and is never stored client-side.

| Principal | How it is resolved | Role | Actor string (`audit_events.actor`) | `actor_type` |
| --- | --- | --- | --- | --- |
| Access owner | A valid Access JWT, on Access-mounted paths only (`/api/admin/*`, `/api/auth/session`, `/admin*` pages, private `/media/*`) | Always `owner` | The verified email, unchanged for continuity with existing rows | `access` |
| Staff member | A valid `__Host-ls_staff` session joined to an `active` `staff_members` row, on staff-mounted paths only (`/api/staff/*`, private `/media/*`) | `staff_members.role`, read on every request | `staff:<staff_members.id>` | `staff` |
| Development bypass | `AUTH_DEV_BYPASS=true`, `APP_ENV === "development"` and a loopback hostname, on Access-mounted paths only | `DEV_STAFF_ROLE` (`owner` by default, or `manager`). Any other value disables the bypass. | `dev@localhost` | `dev` |

Rules:

- **Customers are never principals.** No staff resolver reads `__Host-ls_session`. No customer resolver reads `__Host-ls_staff`, the Access JWT or the bypass. This is ADR-0003's rule, extended to the new cookie.
- **The prefix decides the credential.**
  - `/api/admin/*` resolves only the Access JWT or the bypass. It ignores `__Host-ls_staff`.
  - `/api/staff/*` resolves only `__Host-ls_staff`. It ignores Access JWTs and the bypass.
  - A request that carries every credential gets exactly the credential for its prefix.
  - Private `/media/*` GETs are read-only. They accept either staff credential (the Access JWT first, then the staff cookie), never the customer cookie.
- **The bypass tightens to ADR-0005's environment rule.** `APP_ENV === "development"` replaces `APP_ENV !== "production"`, so `staging` and an unset value are production-like. The config generators keep rejecting `AUTH_DEV_BYPASS`, and also reject `DEV_STAFF_ROLE`, for production and staging.
- **Owners in D1.** A staff row may hold `role='owner'`. This is how an owner signs in with Google. Access owners invite their own Google account like anyone else. The migration seeds no row and no email.

### 2. Permission matrix

Permissions are strings. A role is a fixed set of them in `apps/api/src/permissions.js`. Handlers never test role names; they test permissions. That way the lead can change a manager boundary by editing one matrix line.

| Area | Permission | Owner | Manager | Notes |
| --- | --- | --- | --- | --- |
| Catalog read: products (active and Trash), suppliers list, sync runs, taxonomy | `catalog.read` | yes | yes | For managers, the Supplier projection omits `connectionId` (MyDrop connection configuration). |
| Products: edit overlays (title, description, category, brand, photos, sizes, promo, SEO, slug) | `products.edit` | yes | yes | |
| Products: markup type and value | `products.price` | yes | yes (D5c) | Checked when the PATCH body contains `markupType` or `markupValue`. |
| Products: publish and unpublish (single PATCH `published` or bulk) | `products.publish` | yes | yes | |
| Trash: move a product to Trash, restore a product (single and bulk) | `products.trash` | yes | yes (D5b) | Reversible. Restore yields a draft. |
| Media upload | `media.upload` | yes | yes | |
| Private media read (draft uploads) | `media.read` | yes | yes | |
| Categories: create, rename, move, reorder (preview and apply) | `taxonomy.edit` | yes | yes | |
| Categories: delete (retire with a replacement) | `taxonomy.delete` | yes | no (D5d) | Irreversible: a retired ID can never be reused. |
| Recognition: read, save drafts, preview | `recognition.draft` | yes | yes | No product or active-rule change |
| Recognition: selected apply (1–50 products, non-manual fields only) | `recognition.apply` | yes | yes | Catalog editing at item scale |
| Recognition: activate a version for the whole catalog, including rollback | `recognition.activate` | yes | no | A global settings change that affects published products |
| Suppliers: per-supplier sync, JSON import | `suppliers.sync` | yes | yes (D5a) | Uses the server key, never exposes it. Imports are drafts. The 15-minute cooldown applies. |
| Suppliers: create, rename, enable or disable, set `connectionId`, Trash, restore, connected-supplier discovery | `suppliers.manage` | yes | no | MyDrop connection and supplier configuration |
| Supplier credentials (`MYDROP_API_KEY`), deploy and integration configuration, Access, Google clients | none | outside the app | outside the app | These are never exposed by any API. The lead provisions them through GitHub and Cloudflare. |
| Settings (future global settings) | `settings.manage` | yes | no | Reserved |
| Orders: view and operate (future) | `orders.read`, `orders.operate` | yes | yes | Reserved. Money-moving actions such as refunds get their own owner-only permission when orders are designed. |
| Staff: list | `staff.read` | yes | no | |
| Staff: invite, change role, rename, suspend, reactivate, remove, revoke sessions | `staff.manage` | yes | no | Recent authentication is required. Owner-role changes need an Access principal (D4). |
| Audit view | `audit.read` | yes | no | |

### 3. Route table, enforcement order and default deny

`apps/api/src/permissions.js` exports `ROLE_PERMISSIONS`, `can(principal, permission)` and `requirePermission(principal, permission)`, which returns `403 {error:"Not permitted for your role"}`. It also exports `ADMIN_ROUTES`, an ordered array of `{id, method, pattern, permission}`. `index.js` attaches handlers by `id` in a single `ADMIN_HANDLERS` map. It fails at module load if any route has no handler, or any handler has no route.

The dispatcher `dispatchAdmin(request, env, principal, subpath)` serves both mounts. The full order for a private API request is:

0. **Before the dispatcher, in `route()`, unchanged:**
   - On staging, the `ADMIN_HOST` 404 for `MANAGER_PREFIXES`.
   - Then the global same-Origin check for non-GET `/api/*` (`403`).
   - So a cross-origin mutation is `403` even for anonymous callers.
1. **Resolve the principal for the prefix.** If there is none, respond `401`: "Cloudflare Access manager login required" on `/api/admin/*`, or "Staff sign-in required" on `/api/staff/admin/*`. Authentication comes before routing, so unauthenticated callers cannot enumerate routes.
2. **Match `(method, subpath)` in `ADMIN_ROUTES`.** If the path is unknown, respond `404`. If the path is known but the method is not, respond `405`. Nothing outside the table can run.
3. **Check `requirePermission(principal, route.permission)`.**
4. **Run the handler** with `env.PRINCIPAL` set to `{type, role, actor, staffId?, authenticatedAt?}`, and with `AUDIT_ACTOR` set from it, so the preview-token binding keeps working.
5. **Body-dependent checks inside the handler.** These run before any write and are listed in the table below.

The role is re-read on every request. A role change between a taxonomy or recognition preview and its apply is enforced at apply time.

Every existing `/api/admin/*` route is mapped below. The subpath is relative to `/api/admin` or `/api/staff/admin`.

| # | Method and subpath | Permission | Body-dependent check |
| --- | --- | --- | --- |
| 1 | `GET /taxonomy` | `catalog.read` | |
| 2 | `POST /taxonomy/preview` | `taxonomy.edit` | `operation.type==='delete'` also requires `taxonomy.delete` |
| 3 | `POST /taxonomy/apply` | `taxonomy.edit` | The stored `operation_json.type==='delete'` also requires `taxonomy.delete` |
| 4 | `GET /recognition` | `recognition.draft` | |
| 5 | `POST /recognition/drafts` | `recognition.draft` | |
| 6 | `POST /recognition/preview` | `recognition.draft` | |
| 7 | `POST /recognition/apply` | `recognition.apply` | |
| 8 | `POST /recognition/activate` | `recognition.activate` | |
| 9 | `POST /suppliers/sync-connected` | `suppliers.manage` | |
| 10 | `GET /suppliers` (`?deleted=1`) | `catalog.read` | Omits `connectionId` without `suppliers.manage` |
| 11 | `POST /suppliers` | `suppliers.manage` | |
| 12 | `PATCH /suppliers/:id` | `suppliers.manage` | |
| 13 | `DELETE /suppliers/:id` | `suppliers.manage` | |
| 14 | `POST /suppliers/:id/restore` | `suppliers.manage` | |
| 15 | `POST /suppliers/:id/import` | `suppliers.sync` | |
| 16 | `POST /suppliers/:id/sync` | `suppliers.sync` | |
| 17 | `GET /products` (`?deleted=1`) | `catalog.read` | |
| 18 | `POST /products/bulk` | `products.edit` | Per body action: `publish` and `unpublish` require `products.publish`; `delete` and `restore` require `products.trash`. An unknown action is `400`. |
| 19 | `DELETE /products/:id` | `products.trash` | |
| 20 | `POST /products/:id/restore` | `products.trash` | |
| 21 | `PATCH /products/:id` | `products.edit` | `published` also requires `products.publish`. `markupType` or `markupValue` also requires `products.price`. |
| 22 | `POST /media` | `media.upload` | |
| 23 | `GET /sync-runs` | `catalog.read` | |
| 24 | `GET /staff` (new) | `staff.read` | |
| 25 | `POST /staff` (new) | `staff.manage` | Recent auth. `role:'owner'` needs an Access principal (D4). |
| 26 | `PATCH /staff/:id` (new) | `staff.manage` | Recent auth. Not self. Granting, changing or removing `owner` needs Access. |
| 27 | `POST /staff/:id/suspend`, `/reactivate`, `/reinvite`, `/sessions/revoke` (new) | `staff.manage` | Recent auth. Not self. An owner target needs Access. |
| 28 | `DELETE /staff/:id` (new) | `staff.manage` | Recent auth, `{confirm:true}`, not self. An owner target needs Access. |
| 29 | `GET /audit` (new) | `audit.read` | |

Private routes outside the table:

| Route | Rule |
| --- | --- |
| `GET /api/auth/session` | Access principal or bypass only. Adds `role` and `permissions` to today's response. |
| `/api/auth/login`, `/api/auth/logout` | `405`, unchanged |
| `/admin`, `/admin/*` pages | An Access principal or the bypass, as today |
| `/staff`, `/staff/*` pages | A static SPA shell, `noindex`, with no data. Every data call is authorized by the API. |
| `GET /media/:key` | Published photos are public. Otherwise a staff principal with `media.read` is required. |
| `/api/staff/session`, `/api/staff/google/*`, `/api/staff/logout` | Self-service staff authentication (§5) |

**Test plan: every private route enforces a permission.** These go in `tests/backend/permissions.test.js` plus the staff tests:

1. **Inventory snapshot.** The test holds a reviewed literal list of `[method, subpath, permission]` and `deepEqual`s it with `ADMIN_ROUTES`. A new route cannot ship without a reviewed permission, and changing a permission changes a test.
2. **Matrix.** For every table route and both mounts, the principals and expected results are:

   | Principal | Expected |
   | --- | --- |
   | Anonymous | `401` |
   | Customer cookie only | `401` |
   | Access JWT on `/api/staff/admin` | `401` |
   | Staff cookie on `/api/admin` | `401` |
   | Manager | `403` for owner-only permissions; not `401`/`403` otherwise |
   | Owner (Access and staff) | not `401`/`403` |

   Every non-GET test request sends a same-origin `Origin` and JSON content type, so these results come from the dispatcher and not from the global Origin check. A separate case asserts a cross-origin mutation is `403` before authentication.

   For every `403`, assert that nothing in D1 changed: row counts of `products`, `suppliers`, `audit_events`, `staff_members` and `staff_sessions`, `taxonomy_state.revision` and `recognition_state`.
3. **Default deny.** An unknown subpath returns `404` for an owner and `401` for anonymous. A wrong method returns `405` for an owner and `401` for anonymous.
4. **Body-dependent checks.**
   - A manager's taxonomy delete preview returns `403`.
   - An owner's taxonomy delete preview applied by a manager token returns `403`. The token is also actor-bound, so it is `409` for any other actor.
   - A manager's bulk `publish` and `unpublish` follow `products.publish`, and bulk `delete` and `restore` follow `products.trash` (D5b).
   - A manager's PATCH with `markupValue` follows `products.price`.
   - A manager's recognition activate returns `403`.
5. **Static guard.** `index.js` contains the string `'/api/admin/'` only in the mount line, and the handler map keys equal the route IDs.
6. **Live role change.** Demote an owner staff row to manager. The next request with the same session is `403` on an owner route.

### 4. Access identities

- **Access is always owner** (recommended, D3). Removing an owner means the lead edits the Access policy and revokes that user's sessions in Zero Trust.
- **Not listed in the staff UI.** The staff UI shows Access owners as "Власники через Cloudflare Access (керуються поза застосунком)". The app cannot list them; their actions appear in the audit view.
- **Recent authentication for Access principals.** Cloudflare documents that application tokens refresh automatically within the global session. `iat` therefore does not reliably mark sign-in time, so it is **not** used for step-up. Access owners therefore perform `staff.manage` with **no recent-auth guard**. They are bounded only by the Access application session duration, which the lead sets. This is a residual risk the lead must accept or change (D11). Recommended lead step: set that duration to 24 hours or less. Owner-role changes are restricted to Access principals (D4).

### 5. Staff Google sign-in

New module `apps/api/src/staff-auth.js` holds the session core, flow, cookies and throttle. Like `customer-auth.js`, it never imports `auth.js` or `customer-auth.js`. It reuses `google-oidc.js` primitives: `authorizationUrl`, `exchangeCode`, `verifyGoogleIdToken`, `randomToken`, `sha256Hex` and the JWKS cache. It does so through a new `googleStaffConfig(env, allowLoopbackHttp)` that reads only the staff variables. Google signing keys are the same for every client, so the shared JWKS cache is correct. `aud` is checked against the staff client ID.

**Configuration** (a missing value in a production-like environment means `503` on `/api/staff/google/*`; Access owners are unaffected):

| Name | Kind | Purpose |
| --- | --- | --- |
| `GOOGLE_STAFF_CLIENT_ID` | Worker var (from a GitHub variable) | Staff OAuth client. May equal `GOOGLE_CLIENT_ID` only if the lead chooses the shared-client fallback. |
| `GOOGLE_STAFF_CLIENT_SECRET` | Worker secret | Server-only |
| `STAFF_OIDC_REDIRECT_ORIGINS` | Worker var | Exact HTTPS origins. Production default: `https://example.com` only. An HTTP loopback origin is honoured only in development. |
| `STAFF_AUTH_HMAC_KEY` | Worker secret | 32+ random bytes for throttle keys. Never equal to `CUSTOMER_AUTH_HMAC_KEY`. Development on loopback uses a fixed local key. |
| `DEV_STAFF_ROLE` | Local `.dev.vars` only | `owner` (default) or `manager`. Rejected by the production and staging generators. |

**Endpoints** (all under `/api/staff/*`, which is not gated by Access):

1. **`POST /api/staff/google/start {intent?:"login"|"reauth"}`.**
   - Same-Origin, JSON. The origin must be in `STAFF_OIDC_REDIRECT_ORIGINS`.
   - Throttled to 10 per IP per 10 minutes.
   - `intent:"reauth"` requires a current staff session and stores its `staff_id`.
   - Generate `state`, `nonce`, the PKCE verifier and the binding token (32 random bytes each).
   - Insert a `staff_auth_flows` row with hashed state and binding, the fixed `redirect_uri=<origin>/api/staff/google/callback`, the fixed `return_path` (`/staff`), and expiry now + 10 minutes.
   - Set `__Host-ls_staff_oidc=<binding>; Path=/; Secure; HttpOnly; SameSite=Lax; Max-Age=600`.
   - Return `{authorizationUrl}` with `scope=openid email`, S256, `state`, `nonce` and `prompt=select_account`.
   - T2 adds an optional `scope` parameter to `google-oidc.js` `authorizationUrl`. Its default stays `openid email profile`, so the customer flow is unchanged. The staff flow passes `openid email`, because the display name comes from the owner-entered staff row.
2. **`GET /api/staff/google/callback?code&state`.**
   - Throttled to 20 per IP per 10 minutes.
   - Atomically `DELETE FROM staff_auth_flows WHERE state_hash=? RETURNING *`. Then check, in this order: the binding cookie hash, expiry, the provider `error`, and the origin.
   - Exchange the code with the stored `redirect_uri` and the staff client. Verify the ID token with the staff client ID and the flow nonce. The `iss`, `aud`/`azp`, `exp` and `sub` rules are those of ADR-0003.
   - **Fresher `iat`.** The staff flow requires `iat` no more than 60 seconds in the future and **no older than 5 minutes**. ADR-0003 allows 10 minutes for customers.
   - **`reauth` re-checks.** For `intent:"reauth"`, the callback re-resolves the session cookie presented on the callback. It must be valid and its member `active`; its `staff_id` must equal `flow.staff_id`; and the verified `sub` must equal that member's `google_sub`. Any failure gives `mismatch` (or `invalid` without a session), with no session change.
   - Clear `__Host-ls_staff_oidc`.
   - Redirect `303` to `/staff?status=signed-in`, `reauthenticated`, or `error&reason=invalid|expired|denied|not_allowed|mismatch`.
3. **Identity binding** (in one D1 batch):
   - **Known `sub`.** A row with `google_sub=sub` and `status='active'` signs in. A `suspended` or `removed` row, or a missing row with no matching invitation, gives `not_allowed`. Email is ignored, and the last verified email is stored only as a display handle.
   - **First sign-in.** Only when no row has this `sub`, and only if `email_verified === true` (`verifyGoogleIdToken` returns `email:null` otherwise). Run `UPDATE staff_members SET google_sub=?, email=?, status='active', activated_at=?, invitation_expires_at=NULL WHERE status='invited' AND invited_email=lower(?) AND invitation_expires_at>? AND google_sub IS NULL RETURNING id`. Matching is an exact lowercase comparison with no Gmail dot or plus folding.
     - The same D1 batch creates the session with `INSERT INTO staff_sessions(…) SELECT ?, id, … FROM staff_members WHERE google_sub=? AND status='active'`, plus the audit row. A session therefore exists only if the bind (or an earlier bind of this `sub`) produced an active row.
     - If the `UPDATE` matched zero rows, or the `INSERT … SELECT` inserted none, the result is `not_allowed`.
     - A `UNIQUE` violation is also `not_allowed`. It means a concurrent sign-in or a second account bound first. The whole batch rolls back.
   - **After binding.** Only the `sub` matters. A changed Google email does not move or lose access. A new invitation for the same email cannot attach a second `sub` while an active row exists, because of the partial unique indexes.
   - **No sign-up.** An unknown Google account never creates a staff row.
   - **`reauth`.** The verified `sub` must equal the session's bound `sub`, otherwise `mismatch` with no session change. On success the session rotates with a fresh `authenticated_at`.
4. **`GET /api/staff/session`.** Never returns 401. It returns `{authenticated:false}` or `{authenticated:true,staff:{id,displayName,email,role,permissions:string[],authenticatedAt,recentAuth:boolean}}`.
5. **`POST /api/staff/logout {}`.** Deletes the presented session and clears the cookie. Idempotent.
6. **`POST /api/staff/sessions/revoke-all {}`.** Deletes all of the caller's sessions.
7. **`/api/staff/admin/*`.** The route table from §3 with the staff principal.

**Session** (shorter than customer sessions; ASVS 4.0.3 3.3.2 Level 2):

- **Cookie.** In production-like environments: `__Host-ls_staff=<token>; Path=/; Secure; HttpOnly; SameSite=Strict; Max-Age=<remaining absolute>`. Development on loopback: `ls_staff_dev` and `ls_staff_oidc_dev`, without `Secure`.
- **Why `Strict` works.** The cross-site Google redirect lands on the callback, which only needs the `Lax` binding cookie. The `303` to `/staff` loads a static shell, and the shell's same-origin fetches carry the `Strict` cookie.
- **Amendment: reauth session binding.** The callback is a cross-site top-level navigation from `accounts.google.com`, so browsers do **not** send the `Strict` `__Host-ls_staff` cookie to it. The callback therefore cannot read the session from the cookie.
  - `migrations/0009_staff_flow_session.sql` adds the nullable `staff_auth_flows.session_token_hash`.
  - `POST /api/staff/google/start` is same-origin and does carry the cookie. For `intent:"reauth"` it requires a valid active session and stores its token hash in the flow. For `login` it stores the presented session's hash, if any.
  - The callback re-resolves the session from the stored hash, never from the cookie. The session must still exist and be active, its `staff_id` must equal `flow.staff_id`, and the verified `sub` must equal the member's `google_sub`; otherwise `mismatch` (or `invalid` if the session is gone). On success it rotates. On `login` the stored old session is deleted.
  - The binding cookie `__Host-ls_staff_oidc` stays `Lax`, so it is the only cookie the callback relies on.
- **Token.** 32 random bytes. D1 stores the SHA-256 hash as the primary key.
- **Expiry and refresh.** 30-minute idle and 12-hour absolute expiry (D6). `last_seen_at` is refreshed at most once a minute.
- **Rotation and limits.** The token rotates on sign-in and re-auth, and the presented token is always deleted, so there is no fixation. At most 5 sessions per staff member; the oldest is evicted.
- **Live status.** Every request joins `staff_members` and requires `status='active'`, then reads the role.
- **Revocation.** Suspend and remove delete all of that member's `staff_sessions` **and `staff_auth_flows`** rows in the same batch as the status change, so the effect is immediate and an in-flight `reauth` cannot complete. A role change takes effect on the next request without revocation.
- **Recent auth.** `authenticated_at` within 10 minutes. It is required for every `staff.manage` action by a staff principal.
  - **What it proves.** A completed staff Google flow, with an ID token issued within the last 5 minutes. This is proof of current control of the Google account, **not** proof that the user re-entered a credential.
  - **Why not more.** Google ignores `prompt=login` (only `none`, `consent` and `select_account` are documented). `max_age` and `auth_time` are not documented for Google, so neither is relied on. Otherwise respond `403 {error:"Recent sign-in required",reauth:true}` and the UI runs the `reauth` flow.

**Strict separation, tested both ways:**

- A customer session never yields staff rights, and a staff session never yields customer rights (`/api/account/*` ignores `__Host-ls_staff`).
- A customer `state` presented at the staff callback is `invalid`, and the reverse. The flow tables are distinct and the redirect URIs differ, which Google binds to the code.
- A token minted for the customer client fails `aud` in the staff verifier when the clients are separate.
- The same Google account may be both a customer and a staff member. These remain two unrelated records, with no join or lookup by email or `sub` across them.
- The bypass never applies to `/api/staff/*` or `/api/account/*`.

**CSRF and same-origin.**

- The existing same-Origin check on non-GET `/api/*` and the JSON content type stay, together with `SameSite=Strict`.
- There are no CORS headers, so cross-origin JSON needs a preflight that fails.
- The only state-changing GET is the callback, and it is protected by state, binding cookie, PKCE and nonce. This also blocks login CSRF.
- The `__Host-` prefix stops a sibling subdomain, such as staging, from planting or overwriting the cookie. A sibling subdomain is same-site, so `Strict` does not stop its requests. The Origin check does: the Origin would be `https://staging.example.com`.
- Return paths are fixed, so there are no open redirects.

### 6. Staff management API (owner)

The new routes 24–29 of §3 are available on both mounts. Bodies reject unknown keys.

| Method and path | Body | Success | Notable errors |
| --- | --- | --- | --- |
| `GET /api/admin/staff` | – | `200 {items:StaffMember[]}` | 401, 403 |
| `POST /api/admin/staff` | `{email,displayName,role}` | `201 StaffMember` (`status:"invited"`, `invitationExpiresAt` now + 72 h) | 400, 403 (role owner without Access, or no recent auth), 409 (an active or invited row exists for the email), 429 |
| `PATCH /api/admin/staff/:id` | `{role?,displayName?}` | `200 StaffMember` | 403 (self, owner rule, recent auth), 404, 409 (removed) |
| `POST /api/admin/staff/:id/suspend` | `{}` | `200 StaffMember`, sessions deleted | 403, 404, 409 (not active) |
| `POST /api/admin/staff/:id/reactivate` | `{}` | `200 StaffMember` | 403, 404, 409 (not suspended) |
| `POST /api/admin/staff/:id/reinvite` | `{}` | `200 StaffMember` with a new expiry | 403, 404, 409 (not invited) |
| `POST /api/admin/staff/:id/sessions/revoke` | `{}` | `200 {revoked:number}` | 403, 404 |
| `DELETE /api/admin/staff/:id` | `{confirm:true}` | `200 {removed:true}`. Sessions deleted, status `removed`, `google_sub`, `email` and `invited_email` set to `NULL` | 400, 403, 404 |
| `GET /api/admin/audit?before=<iso>&limit=<1-100>` | – | `200 {items:AuditEvent[],next:string\|null}` | 401, 403 |

- **`StaffMember`.** `{id,displayName,role:"owner"|"manager",status:"invited"|"active"|"suspended",email:string|null,invitedEmail:string|null,invitationExpiresAt,createdBy,createdAt,updatedAt,lastSignInAt,activeSessions:number}`. `google_sub` is never returned. Removed rows are not listed.
- **`AuditEvent`.** `{id,actor,actorType,actorRole,action,resourceId,details,createdAt}`. For a staff actor, `actor` resolves to a display name. Raw emails appear only for Access actors.
- **No email is sent**, because no vendor is approved. The owner tells the invitee to open `https://example.com/staff` and sign in with Google using the invited address.
- **Owner-safety rules.**
  1. No self-targeted role change, suspension, removal or session revocation through these routes. Self sign-out uses `/api/staff/logout`.
  2. Creating an `owner` row, granting or removing `owner`, and suspending or removing an owner row all require an **Access principal** (D4).
  3. Lockout is structurally impossible. Access owners are owners regardless of D1, so the app has no "last owner" counter. Rule 2 also prevents a compromised Google owner session from removing the other owners.
  4. At most 50 non-removed staff rows.
- **Throttle.** Staff-management writes are limited to 30 per actor per hour, using `staff_auth_throttle`.

### 7. Data: `migrations/0008_staff.sql`

The migration is additive only. No data step runs, and no email or identity is seeded. With an empty `staff_members` table, Access owners keep full access exactly as today.

```sql
-- Staff roles and staff Google sign-in (ADR-0006). Separate from customer tables; no seed rows.
CREATE TABLE staff_members (
  id TEXT PRIMARY KEY,
  role TEXT NOT NULL CHECK (role IN ('owner','manager')),
  status TEXT NOT NULL CHECK (status IN ('invited','active','suspended','removed')),
  invited_email TEXT,            -- lowercase; matched once at first sign-in; NULL after removal
  google_sub TEXT,               -- NULL until first sign-in and after removal
  email TEXT,                    -- last verified Google email, display only
  display_name TEXT NOT NULL,
  created_by TEXT NOT NULL,      -- actor string
  created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
  invitation_expires_at TEXT, activated_at TEXT, last_sign_in_at TEXT, suspended_at TEXT, removed_at TEXT,
  CHECK (status <> 'invited' OR (google_sub IS NULL AND invited_email IS NOT NULL AND invitation_expires_at IS NOT NULL)),
  CHECK (status NOT IN ('active','suspended') OR google_sub IS NOT NULL),
  CHECK (status <> 'removed' OR (google_sub IS NULL AND invited_email IS NULL AND email IS NULL))
);
CREATE UNIQUE INDEX staff_members_sub ON staff_members(google_sub) WHERE google_sub IS NOT NULL;
CREATE UNIQUE INDEX staff_members_invited_email ON staff_members(invited_email) WHERE invited_email IS NOT NULL AND status IN ('invited','active','suspended');
CREATE TABLE staff_sessions (token_hash TEXT PRIMARY KEY, staff_id TEXT NOT NULL REFERENCES staff_members(id) ON DELETE CASCADE, created_at TEXT NOT NULL, authenticated_at TEXT NOT NULL, last_seen_at TEXT NOT NULL, idle_expires_at TEXT NOT NULL, absolute_expires_at TEXT NOT NULL);
CREATE INDEX staff_sessions_staff ON staff_sessions(staff_id);
CREATE INDEX staff_sessions_expiry ON staff_sessions(absolute_expires_at);
CREATE TABLE staff_auth_flows (binding_hash TEXT PRIMARY KEY, state_hash TEXT NOT NULL UNIQUE, intent TEXT NOT NULL CHECK (intent IN ('login','reauth')), staff_id TEXT REFERENCES staff_members(id) ON DELETE CASCADE, code_verifier TEXT NOT NULL, nonce TEXT NOT NULL, redirect_uri TEXT NOT NULL, return_path TEXT NOT NULL CHECK (return_path = '/staff'), created_at TEXT NOT NULL, expires_at TEXT NOT NULL, CHECK ((intent='login' AND staff_id IS NULL) OR (intent='reauth' AND staff_id IS NOT NULL)));
CREATE TABLE staff_auth_throttle (bucket TEXT NOT NULL, key_hmac TEXT NOT NULL, window_start INTEGER NOT NULL, count INTEGER NOT NULL, PRIMARY KEY (bucket,key_hmac,window_start));
ALTER TABLE audit_events ADD COLUMN actor_type TEXT CHECK (actor_type IS NULL OR actor_type IN ('access','staff','dev','system'));
ALTER TABLE audit_events ADD COLUMN actor_role TEXT CHECK (actor_role IS NULL OR actor_role IN ('owner','manager'));
ALTER TABLE audit_events ADD COLUMN details_json TEXT;
CREATE INDEX audit_events_created ON audit_events(created_at);
```

Removal keeps the row as a tombstone, so `staff:<id>` actors in old audit rows still resolve to a display name. Removal clears the identifiers, so re-inviting the same person creates a new row.

**Audit.** Every staff-principal write records `actor`, `actor_type` and `actor_role`. This covers every existing `audit()` and recognition `event()` call; one shared helper takes `env.PRINCIPAL`. Scheduled sync writes `system`. Staff events also put changed field names and role transitions in `details_json`, but never emails or `sub` values. The staff events are:

- `staff.invite`, `staff.reinvite`
- `staff.role.change` (details `{from,to}`), `staff.rename`
- `staff.suspend`, `staff.reactivate`, `staff.remove`
- `staff.sessions.revoke`
- `staff.signin`, `staff.reauth`, `staff.activate` (the first binding)
- `staff.signin.denied`, without the email

### 8. Staging (ADR-0005)

- **`env.staging.vars`.** Adds `STAFF_OIDC_REDIRECT_ORIGINS: "https://staging.example.com"`. The generator writes `STAGING_GOOGLE_STAFF_CLIENT_ID` into `GOOGLE_STAFF_CLIENT_ID`. The secrets file maps `STAGING_GOOGLE_STAFF_CLIENT_SECRET` to `GOOGLE_STAFF_CLIENT_SECRET` and `STAGING_STAFF_AUTH_HMAC_KEY` to `STAFF_AUTH_HMAC_KEY`, never production values. The generator rejects `DEV_STAFF_ROLE` and `AUTH_DEV_BYPASS`.
- **Staff Google sign-in runs on the gate host** (`staging.example.com/staff`). A tester needs a gate seat **and** a staging staff invitation. The admin host stays the Access-owner cabinet at `/admin`.
- **This amends ADR-0005's gate-host rule.** ADR-0005 says the cabinet is unavailable on the gate host. Under A2, `/staff` and `/api/staff/admin/*` **are reachable on the gate host** for invited, signed-in staff, with each role's permissions. Testers who pass the gate but have no staff row get `401`.
  - `MANAGER_PREFIXES` (`/admin`, `/api/admin`, `/api/auth`) stay **unchanged**. T1 and T2 must not add `/staff` or `/api/staff` to them.
  - T4 updates the README staging section. T8 adds an amendment note to ADR-0005. On the admin host, `POST /api/staff/google/start` fails with `400 origin not allowed`.
- **Separate data.** The staging D1 has its own `staff_members`. Invitations are created there by an Access owner on the admin host.
- **Google redirect URIs:**
  - production: `https://example.com/api/staff/google/callback`
  - staging: `https://staging.example.com/api/staff/google/callback`
  - `workers.dev`: none by default (D9). If the lead wants it, add `https://<worker>.workers.dev/api/staff/google/callback` and that origin to `STAFF_OIDC_REDIRECT_ORIGINS`.
- **Local development.** Use the bypass with `DEV_STAFF_ROLE`, or a separate development client. Production credentials are never used locally.

### 9. Deploy safety and ordering

- **No Access change is required (A2).** The deploy cannot open `/api/admin/*`: it stays gated at the edge, and the Worker still rejects requests without a valid Access JWT.
- **The new `/api/staff/*` surface is closed on first deploy.** With an empty `staff_members` table, no staff session can exist. The callback returns `not_allowed` for everyone. Every `/api/staff/admin/*` request returns `401`.
- **Merge order.** The migration and the route table (T1) merge before the staff mount (T2). Because the main-merge pipeline applies migrations before code, every deployed revision has its schema.
- **Post-deploy smoke checks** (T4 extends the existing read-only production smoke step):
  - `GET /api/staff/admin/products` without credentials must be `401`.
  - `GET /api/staff/session` must be `{authenticated:false}`.
  - `GET /api/admin/products` without credentials must not be `2xx`. Today it is a `302` to Access.
  - Any `2xx` on the first or third check fails the job.

### A1 fallback: un-gate `/api/admin/*`

This applies only if the lead chooses A1 over A2. Under A1, `/api/admin/*` accepts either credential, the `/api/staff/admin` mount is dropped, and the frontend uses one prefix.

1. **Precheck (read-only).** In Zero Trust › Access › Applications › the catalog manager application › Settings › Cookie settings, confirm **Cookie Path Attribute is off**. With it off, `CF_Authorization` is scoped to the host and is sent to an un-gated `/api/admin/*`. With it on, owners would get `401` from the Worker until it is turned off.
2. **Change.** In the application's destinations, remove `example.com/api/admin/*` and `<worker>.workers.dev/api/admin/*`. Keep `/admin`, `/admin/*` and `/api/auth/*` on both hosts. Leave the Allow policy unchanged, with both owner identities. The audience tag does not change.
3. **Why order does not matter.** Before and after the A1 code deploy, the Worker returns `401` on `/api/admin/*` without a valid Access JWT (`identity()` → `verifyAccessJWT` with the configured AUD). The staff cookie is accepted only after the A1 code ships, and only for active staff rows. There is therefore no window in which unauthenticated requests succeed.
4. **Verify.** `curl -si https://example.com/api/admin/products` returns the Worker's `401` JSON (before the change, it returns a `302` to Access). Owners still load `/admin`. Any `2xx` means you restore the destination immediately.

## Security: OWASP ASVS 4.0.3 mapping (Level 2 for staff)

Verify the IDs against ASVS 4.0.3 during review. Remapping to 5.0 is a follow-up.

| ASVS | Requirement | Design |
| --- | --- | --- |
| 1.4.1 / 1.4.4 / 1.4.5 | Trusted enforcement points, a single access-control mechanism, attribute-based checks | One route table and dispatcher. Permissions, not role names. Server-side only. |
| 2.x | Local credentials | None. Google and Access are the authenticators. |
| 2.2.1 | Anti-automation | D1 throttles on start, callback and staff writes |
| 3.2.1–3.2.3 | Fresh, high-entropy token in a cookie | 256-bit token, rotated on sign-in and re-auth, hash stored |
| 3.3.1 / 3.3.2 (L2) / 3.3.4 | Logout invalidates. Re-auth every 12 h or after 30 min idle. Sessions can be terminated. | Server-side delete. 30 min idle and 12 h absolute. Owner session revocation and self revoke-all. |
| 3.4.1–3.4.5 | Cookie attributes | `__Host-ls_staff; Path=/; Secure; HttpOnly; SameSite=Strict` |
| 3.5.3 | Signed tokens validated | ID token: RS256, `iss`, `aud`/`azp` against the staff client, `exp`, `iat`, nonce |
| 3.7.1 | Re-auth before sensitive actions | Partially met. A staff session needs proof of current Google account control: a fresh staff Google flow within 10 minutes, with an ID token issued within 5 minutes. Google may complete it silently, so this is not a forced credential re-entry. Owner-role changes need Access. Access owners have no step-up (D11). |
| 4.1.1 / 4.1.2 / 4.1.3 / 4.1.5 | Server enforcement, role not client-controlled, least privilege, fail closed | The role is read from D1 per request. The manager matrix is minimal. Unknown routes give `404`. Missing config gives `503` on staff sign-in. |
| 4.2.1 | IDOR | Staff routes take IDs, but only `staff.manage` holders reach them. `google_sub` is never exposed. |
| 4.2.2 | CSRF | Origin check, JSON, `SameSite=Strict`, `__Host-`. The callback is protected by state, binding, PKCE and nonce. |
| 4.3.1 (L2) | Admin interfaces use MFA | Access policy (the lead's IdP settings). For Google staff, 2-Step Verification is required by policy but cannot be verified from the ID token (D7). |
| 5.1.3 / 5.1.4 | Input validation | Bounded fields. Unknown keys rejected. Lowercase email validation. |
| 7.1.1 / 7.1.2 / 7.2.x | No secrets or PII in logs; audit of security events | Logs carry the error class only. Audit records actor, type and role for every write, sign-in and staff change. |
| 8.3.1 / 8.3.4 | Sensitive data handling | No tokens in URLs. Staff PII is visible only to owners. |

**Privilege-escalation tests** (in addition to §3):

1. **Customer to staff.** A customer cookie, including one belonging to a Google account that also has an active staff row, gives `401` on `/api/admin/*` and `/api/staff/*`, and `{authenticated:false}` from `/api/staff/session`.
2. **Staff to customer.** A staff cookie gives `401` on `/api/account/profile`, and `/api/account/session` reports unauthenticated.
3. **Self-escalation.** A manager PATCHing their own `role` gets `403`. A manager calling `POST /staff` gets `403`.
4. **Mass assignment.** `POST` and `PATCH` with `status`, `googleSub`, `id` or `createdBy` are rejected with `400`.
5. **Google owner limits.** A Google-session owner creating an owner, promoting to owner, or suspending or removing an owner gets `403`. Self-targeted actions get `403`. A stale `authenticated_at` gives `403` with `reauth:true`.
6. **Invitation edge cases.**
   - `email_verified:false` with a matching email: not bound.
   - Expired invitation: `not_allowed`.
   - A second Google account using the same invited email after binding: `not_allowed`.
   - Email case variants: bound once.
7. **Suspension and removal.** Sessions are deleted in the same batch. The next request with the old cookie gets `401`, and the stale cookie is cleared.
8. **Flow confusion.**
   - A customer flow `state` at the staff callback, and the reverse: `invalid`.
   - A staff `reauth` returning a different `sub`: `mismatch`.
   - A replayed callback: `invalid`.
9. **Token confusion.** An ID token with the customer `aud` fails in the staff verifier.
10. **Bypass.** `AUTH_DEV_BYPASS` gives no principal on non-loopback hosts, with `APP_ENV` set to `staging`, `production` or unset, or on `/api/staff/*`. `DEV_STAFF_ROLE=admin` disables the bypass.
11. **Preview tokens.** An owner preview applied by another actor gives `409`. A manager applying an owner's taxonomy-delete preview gives `403`.

**PII.**

- **What is stored.** Staff rows hold the invited email, the last verified Google email, the display name and the Google `sub`. They are visible only with `staff.read`. Logs never contain emails, `sub` values, tokens or raw IPs; throttle keys are HMACs.
- **Removal** clears the identifiers. Retention of the tombstone and audit rows is a lead decision (D8).
- **No customer data.** This ADR adds no staff access to customer data. Orders will need a separate decision.
- **Existing actor columns.** `recognition_versions.actor`, `recognition_applications.actor` and `taxonomy_changes.actor` show actor strings to managers through `catalog.read`/`recognition.draft`. For Access owners these are emails. Lead decision D12: recommended is that T1 projects Access actors as display labels for every principal without `audit.read`. An example label is «Власник (Access)». Owners keep the raw actor.

## Consequences

- **Trust boundaries.** There are now three principals: Access owner, staff session and customer session. Two of them are Worker-issued sessions. Reviewers must check the prefix-to-credential rule in both directions.
- **The manager boundary changes.** "Managers get no self-issued session" no longer holds for Google staff. Access owners are unchanged. The rule texts in `AGENTS.md`, `docs/ARCHITECTURE.md` and `docs/PRODUCT.md` must be updated after acceptance (a follow-up docs task).
- **Two URL prefixes.** One handler set serves both `/api/admin/*` and `/api/staff/admin/*`. The frontend chooses a base from its entry path: `/admin` uses `/api/admin`, and `/staff` uses `/api/staff/admin`.
- **No Access change** under the recommendation. The lead's work is the Google client plus three GitHub values.
- **Existing owners are untouched.** Access owners see no change and need no migration step. The audit actor stays the email for them.
- **Unverified until QA with lead-provisioned credentials:** live staff Google sign-in, and the staging gate-host callback. Tests use locally generated RSA keys and stubbed Google endpoints, as ADR-0003 does.

## Task breakdown for the PM

Owned paths are exclusive unless they are listed as shared. Shared files merge in the stated order. A later task takes a normal merge from `main` before its PR.

| ID | Role | Scope | Owned paths | Depends on | Acceptance |
| --- | --- | --- | --- | --- | --- |
| T1 | backend | Permission model, route table, Access→owner mapping, bypass role, audit columns, migration | new `apps/api/src/permissions.js`, new `migrations/0008_staff.sql`, new `tests/backend/permissions.test.js`; shared `apps/api/src/index.js` (admin dispatcher, `audit()` helper, `/api/auth/session` fields, supplier projection), `apps/api/src/auth.js` (principal shape, `DEV_STAFF_ROLE`, `APP_ENV==='development'`), `apps/api/src/recognition.js` and `apps/api/src/taxonomy.js` (audit helper, body checks), `package.json` (test script only), `tests/backend/catalog.test.js` (bypass-condition update) | ADR acceptance; migration number 0008 reserved | `MANAGER_PREFIXES` and the `ADMIN_HOST` check stay unchanged, and the staging-worker tests stay green. §3 tests 1–6 pass using `DEV_STAFF_ROLE=manager` and `owner`. Existing tests stay green. Access owners have unchanged behaviour. Every write row has `actor_type` and `actor_role`. |
| T2 | backend | Staff Google OIDC, sessions, `/api/staff/*` mount, private media | new `apps/api/src/staff-auth.js`, new `tests/backend/staff-auth.test.js`; shared `apps/api/src/google-oidc.js` (additive `googleStaffConfig`), `apps/api/src/index.js` (`/api/staff` routing, `isPrivatePath` adds `/staff` and `/api/staff`, `serveMedia`), `wrangler.jsonc` (production top-level `run_worker_first` list only adds `/staff` and `/staff/*`; `env.staging` already has `run_worker_first: true` and is not edited), `package.json` | T1 | Start/callback/session/logout/revoke-all and `reauth` per §5. Separation tests 1, 2, 8, 9 and 10 pass. A suspended member's next request gets `401`. `APP_ENV='staging'` fails closed. |
| T3 | backend | Staff management API and audit view | new `apps/api/src/staff-admin.js`, new `tests/backend/staff-admin.test.js`; shared `apps/api/src/permissions.js` (routes 24–29), `apps/api/src/index.js` (handler map entries), `package.json` | T1, T2 | §6 contract. Owner-safety rules. Escalation tests 3–7. Audit events with details. A manager gets `403` on every route. |
| T4 | backend (deploy config) | New variables and secrets, staging mapping, smoke checks, README | shared `tools/cloudflare-config.mjs`, `tools/cloudflare-secrets.mjs`, `tests/backend/cloudflare-secrets.test.js`, `.github/workflows/ci.yml` (production smoke step), `README.md` (secrets table, Access paths, staff sign-in, staging section: staff sign-in on the gate host and the new `STAGING_*` staff values), `wrangler.jsonc` `env.staging.vars` (`STAFF_OIDC_REDIRECT_ORIGINS`) | T2; ordered with any open deploy-wiring change to the same tools | Missing staff values warn and never block a deploy. `DEV_STAFF_ROLE` is rejected. Staging uses only `STAGING_*` values. The §9 smoke checks are present. |
| T5 | frontend | Staff entry and role-aware cabinet | new `apps/web/src/StaffSignIn.jsx`; shared `apps/web/src/main.jsx` (route `/staff`, nav and actions hidden by `permissions`, reason messages), `apps/web/src/api.js` (base prefix from entry path, `reauth` handling) | T1 (session contract); T2 for live integration (mocks before then) | `/staff` shows "Увійти через Google" and the Ukrainian `reason` messages. `/admin` links to `/staff`. A manager sees no supplier-manage, recognition-activate, category-delete or staff controls. The server still returns `403` when they are forced. |
| T6 | frontend | Owner staff management UI and audit view | new `apps/web/src/StaffManager.jsx`, new `apps/web/src/AuditLog.jsx`; shared `apps/web/src/main.jsx` (tab registration only) | T3, T5 | Invite, role change, suspend, reactivate, reinvite, remove (with confirmation), and revoke sessions. Re-auth prompt on `reauth:true`. Owner-row actions disabled for Google owners, with an explanation. Hidden for managers. Accessible labels and keyboard operation. |
| T7 | qa | Escalation and coexistence | new `tests/e2e/staff.spec.js`, isolated fixture D1 | T3, T6 | The §3 matrix through the UI and API. An Access owner and a Google manager side by side. Customer/staff separation with the same Google account (stubbed). Live Google sign-in is reported as unverified until the lead provisions the client. |
| T8 | docs (orchestrator-assigned) | Rule texts after acceptance | `AGENTS.md`, `docs/ARCHITECTURE.md`, `docs/PRODUCT.md`, `docs/API.md` (Proposed → implemented), `docs/adr/0005-staging-environment.md` (amendment note: staff mount reachable on the gate host) | ADR acceptance; after T3 | Rules state the three principals and the prefix-to-credential rule |

**Shared-file order:**

- **`apps/api/src/index.js`:** T1, then T2, then T3. The merged `ADMIN_HOST` block and `MANAGER_PREFIXES` stay unchanged.
- **`apps/api/src/auth.js`:** T1 only. T2 and T3 must not import it, except that `index.js` calls `identity()` for the Access mount and media.
- **`package.json`:** T1, then T2, then T3. Each adds only its test file to `scripts.test`. The Telegram-linking task also edits `scripts.test`: whichever merges second keeps both test entries. No dependency changes, so `package-lock.json` is untouched.
- **`apps/api/src/permissions.js`:** T1 creates it, T3 extends it.
- **`migrations/0008_staff.sql`:** T1 only. Later schema needs take `0009`.
- **`wrangler.jsonc`:** T2 (the production `run_worker_first` list), then T4 (`env.staging.vars.STAFF_OIDC_REDIRECT_ORIGINS`).
- **`apps/web/src/main.jsx`:** T5, then T6.
- **Tools, CI and README:** T4, serialized with the other deploy-tooling tasks.

## Lead-only actions

These follow the recommended options (A2, separate client). Agents perform none of them. Record names and IDs, never secret values or identities.

1. **Cloudflare Access: no change.** Optionally confirm, read-only, that the production manager application's destinations are exactly `/admin`, `/admin/*`, `/api/admin/*` and `/api/auth/*` on both hosts, and that none covers `/staff` or `/api/staff/*`. Both owner identities stay in the Allow policy.
   - **Recommended:** set the production manager application's session duration to 24 hours or less. Do the same on the staging admin application. This is the only bound on Access owners' staff-management actions (D11).
2. **Google Cloud,** in the same project as the customer client:
   - a. Create an OAuth client of type "Web application", for example named "Lorem Store staff".
   - b. Authorized redirect URI: `https://example.com/api/staff/google/callback`. No JavaScript origins are needed. Add `https://<worker>.workers.dev/api/staff/google/callback` only if D9 is "yes".
   - c. Confirm the consent screen's authorized domains include `example.com`. If publishing status is "Testing", add every staff Google account as a test user.
   - d. Staging, when staging is provisioned: either create a separate staging staff client with exactly `https://staging.example.com/api/staff/google/callback`, or add that URI to the staging customer client (the staging-only shared-client fallback).
3. **GitHub repository values:**
   - variable `GOOGLE_STAFF_CLIENT_ID`
   - secret `GOOGLE_STAFF_CLIENT_SECRET`
   - secret `STAFF_AUTH_HMAC_KEY`: fresh random, 32+ bytes, different from `CUSTOMER_AUTH_HMAC_KEY`
   - optional variable `STAFF_OIDC_REDIRECT_ORIGINS`, only if it differs from `https://example.com`
   - staging: `STAGING_GOOGLE_STAFF_CLIENT_ID` (variable), `STAGING_GOOGLE_STAFF_CLIENT_SECRET` and `STAGING_STAFF_AUTH_HMAC_KEY` (secrets)
4. **After T3 and T6 deploy:**
   - Sign in at `/admin` through Access. Open «Команда» and invite each manager with the Google email they will use, and invite your own Google account as owner if wanted.
   - Tell invitees to open `https://example.com/staff` within 72 hours.
5. **To remove an owner:** edit the Access policy, then revoke that user's Access sessions in Zero Trust › Users. Also remove any `owner` staff row for them from the «Команда» page while signed in through Access.

If the lead chooses A1 instead, perform the [A1 fallback](#a1-fallback-un-gate-apiadmin) steps; they are safe before or after deploy.

## Lead decisions

| ID | Decision | Options | Recommendation |
| --- | --- | --- | --- |
| D1 | Coexistence layout | A2 staff mount (no Access change) / A1 un-gate `/api/admin/*` / B managers in Access / C staff host | **A2** |
| D2 | Staff Google client | Separate client in the same project / reuse the customer client | **Separate client** |
| D3 | Can D1 downgrade or suspend Access identities? | No, Access is always owner / D1 overlay by email | **No** |
| D4 | Who may create, promote, demote, suspend or remove **owner** staff rows | Access owners only / any owner, including Google owners | **Access owners only.** Google owners manage managers. |
| D5 | Manager boundary details: (a) per-supplier sync and JSON import; (b) product Trash and restore; (c) markup and price; (d) category delete | Allow or deny each | (a) allow, (b) allow (reversible), (c) allow, audited (flip `products.price` to owner-only if you want price control), (d) **owner only** |
| D6 | Staff session lifetime and invitation expiry | 30 min idle / 12 h absolute / 72 h invite (ASVS L2), or longer, for example 8 h idle / 7 days absolute | **30 min / 12 h / 72 h** |
| D7 | 2-Step Verification for staff Google accounts | Policy requirement (unverifiable) / Google Workspace with enforced 2SV (paid; would also allow `hd` checks) | **Policy requirement now.** Revisit with Workspace. |
| D8 | Retention after staff removal | Keep the tombstone (display name, role history in audit) indefinitely / anonymize the display name after N months | **Keep the tombstone without identifiers.** Revisit with the PII policy. |
| D9 | Staff sign-in on the `workers.dev` host | No / yes, with an extra redirect URI and origin | **No** |
| D10 | Audit view audience | Owners only / managers see their own actions | **Owners only** |
| D11 | Recent auth for Access owners performing `staff.manage` | Accept the residual risk, bounded by the Access session duration / require owners to use a Google staff session with recent auth for staff management / shorter Access session | **Accept**, with the Access session duration at 24 hours or less. Owner-row changes stay Access-only (D4). |
| D12 | Access owners' emails in the recognition and taxonomy actor fields visible to managers | Accept / project display labels for principals without `audit.read` | **Project labels in T1.** Owners keep raw actors. |

## Revisit triggers

- Orders ship: define `orders.*`, owner-only money-moving actions, and manager access to customer PII (ASVS L2 for order data).
- More than about 10 staff, or a need for granular roles: add custom roles over the same permission strings.
- Google Workspace adoption: enforce `hd` and 2SV, and consider Workspace as the Access IdP.
- A2's double mount causes confusion, or Cloudflare offers per-path policy exemptions inside one application: re-evaluate A1 or C.
- A security incident involving a Google staff account: consider making Access mandatory for owners and Google sign-in managers-only.
- Cloudflare documents a reliable authentication-time claim for Access tokens: add a recent-auth check for Access owners.
- ASVS 5.0 adoption.
