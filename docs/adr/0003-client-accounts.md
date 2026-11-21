# ADR-0003: Client accounts, sessions and customer data

Status:

- **Accepted (sign-in method):** customers sign in with their Google account, using Google OAuth 2.0 / OpenID Connect (authorization code + PKCE, server-side in the Worker). The lead decided this.
- **Proposed:** everything else in this record. That covers the session, separation, schema and API design (pending review and merge), Telegram linking (see [ADR-0004](0004-telegram-account-linking.md)), and PII retention, deletion and export values (pending a lead decision).
- **Open lead question:** whether any non-Google fallback sign-in is needed.


## Context

The client cabinet epic adds customer accounts. Customers can store contact details, link Telegram and save a Nova Poshta branch or postomat preference. There is still no checkout, payment or order routing (docs/PRODUCT.md).

The only existing authenticated principal is the manager. Cloudflare Access issues RS256 JWTs, and `apps/api/src/auth.js` verifies them against the team JWKS, issuer, `CF_ACCESS_AUD` and `exp`. ADR-0001, `AGENTS.md` and `docs/ARCHITECTURE.md` forbid password login and self-issued sessions for managers. Customers need a separate identity and session model that never weakens or blurs the manager boundary.

Stack constraints:

- **Runtime.** One ESM Cloudflare Worker (`apps/api/src/index.js`). The API is same-origin JSON. A global `checkOrigin` applies to non-GET `/api/*` requests, and `readJson` requires a JSON content type. JSON responses are `no-store`; errors are `{error:string}`. The Worker sets global security headers.
- **Database.** D1, with migrations `0001`–`0003`.
- **Hosts.** Two serve the app: `example.com` and the `workers.dev` host.
- **Cost.** The README budget assumes Workers Paid.
- **Vendors.** No email or SMS vendor is approved.

## Options considered

| Option | Cost / vendor | Privacy | Ops / security | Outcome |
| --- | --- | --- | --- | --- |
| **Google OIDC (code + PKCE)** | $0. Needs a Google Cloud OAuth client (consent screen, redirect URIs). | Google learns about sign-ins. We receive `sub`, email and name. | No passwords stored. Recovery and MFA are Google's. Standard ID token verification against the Google JWKS, the same pattern as the Access RS256/JWKS check. Depends on Google. | **Accepted by the lead.** |
| Telegram OIDC as primary identity | $0. Needs a bot and BotFather Client Secret. | Minimal (`sub`). | Same machinery. | Not chosen for sign-in. Telegram is used for **linking only** (ADR-0004). |
| Self-hosted email + password (WebCrypto PBKDF2, D1 sessions) | $0. | We would hold password hashes. | Workers historically cap PBKDF2 at 100k iterations ([workerd#1346](https://github.com/cloudflare/workerd/issues/1346)), below OWASP's 600k. No reset without an email vendor. We would own lockout and enumeration handling. | **Rejected.** Any fallback is an open lead question. |
| Email magic link / OTP | Needs a transactional email vendor (cost, DPA, DNS). | The vendor processes customer email addresses. | Deliverability and abuse handling fall on us. | Not chosen. Needs a vendor decision. |
| Cloudflare Access for customers | Per-seat Zero Trust pricing. | Access identity providers see customers. | Built for gating a workforce. It would merge customer and manager principals on `CF_Authorization`. | **Rejected.** |

## Decision

### Google sign-in adapter (Accepted method; design for review)

**Configuration:**

- `GOOGLE_CLIENT_ID`: a plain Worker variable.
- `GOOGLE_CLIENT_SECRET`: a Worker secret, server-only. It is never placed in the bundle, logs or responses.
- `OIDC_REDIRECT_ORIGINS`: a plain variable listing the exact allowed origins, `https://example.com` and the `workers.dev` origin. An HTTP loopback origin is honoured only when `APP_ENV === "development"`.
- If any of these are missing in a production-like environment (see the environment rule below), `/api/account/google/*` responds `503 {error}` (fail closed).

**Fixed endpoints.** These are hardcoded constants. They are not fetched dynamically from the discovery document, so there is no dynamic-host trust.

- Authorization: `https://accounts.google.com/o/oauth2/v2/auth`
- Token: `https://oauth2.googleapis.com/token`
- JWKS: `https://www.googleapis.com/oauth2/v3/certs`

**OAuth client (done).** The lead has created the Google OAuth "Web application" client. `GOOGLE_CLIENT_ID` is stored as a GitHub Actions variable and `GOOGLE_CLIENT_SECRET` as a GitHub Actions secret. A separate deploy-wiring task binds them into the Worker at deploy time. The authorized redirect URIs are:

- `https://example.com/api/account/google/callback`
- `https://<worker>.workers.dev/api/account/google/callback`

Open question: whether a `www` host also needs a redirect URI.

Forward reference: a staging host (`staging.example.com`) will need its own `OIDC_REDIRECT_ORIGINS` entry and Google redirect URI.

A local development client, if wanted, is separate. Production credentials are never used locally.

1. **Start: `POST /api/account/google/start {}`.** Requires the same-Origin check and is throttled per IP.
   - The request origin must be in `OIDC_REDIRECT_ORIGINS`; otherwise respond `400`. `redirect_uri` is `<origin>/api/account/google/callback`.
   - Generate 32-byte random values for `state`, `nonce`, the PKCE `code_verifier` and a browser binding token.
   - Insert a `customer_auth_flows` row with provider `google`, intent `login`, hashes of the state and binding, the verifier, the nonce, the redirect URI, the fixed return path `/account`, and expiry now + 10 minutes.
   - Set `__Host-ls_oidc=<binding>; Path=/; Secure; HttpOnly; SameSite=Lax; Max-Age=600`.
   - Return `{authorizationUrl}` with `client_id`, `redirect_uri`, `response_type=code`, `scope=openid email profile`, `state`, `nonce`, `code_challenge` (S256), `code_challenge_method=S256` and `prompt=select_account`.
2. **Callback: `GET /api/account/google/callback?code&state` (or `?error&state`).**
   - Atomically consume the flow (`DELETE … WHERE state_hash=? AND provider='google' AND intent='login' RETURNING …`).
   - No matching row (unknown, already consumed, or wrong provider/intent) → `303` to `/account?status=error&reason=invalid`.
   - A matched row whose binding cookie hash does not match, or which has expired → `reason=expired`.
   - A provider `error` → `reason=denied`.
   - Clear `__Host-ls_oidc`.
   - Callback GETs only finish a flow that a POST started.
3. **Token exchange.** `POST` to the token endpoint, form-encoded, with `code`, `code_verifier`, the stored `redirect_uri`, `grant_type=authorization_code` and client credentials.
   - Fixed host, `redirect:'manual'`, 10-second timeout, bounded response size.
   - Only the `id_token` is used. The access token is discarded and never stored, and no refresh token is requested.
4. **`id_token` verification.**
   - Header: `alg` must be `RS256`, and `kid` must be a string of at most 200 characters.
   - Signature: verify with the WebCrypto RS256 key from the JWKS.
   - `iss` must be `https://accounts.google.com` or `accounts.google.com`.
   - `aud`: either a string equal to `GOOGLE_CLIENT_ID`, or an array that contains it. In the array case, `azp` must be present and equal `GOOGLE_CLIENT_ID`. If `azp` is present in the string case, it must also equal the client ID.
   - `exp` must be finite and greater than now.
   - `iat` must not be more than 60 seconds in the future and no older than 10 minutes.
   - `nonce` is **required** and must equal the stored nonce.
   - `sub` must be a non-empty string of at most 255 characters.
5. **Identity and email.**
   - Identity is keyed by `(provider='google', subject=sub)` and **never by email**.
   - Email changes at Google do not move accounts. Accounts are never auto-merged by matching email.
   - `email` is stored as the display handle only when `email_verified === true`. Otherwise the handle is null. `email_verified` never authorizes anything.
   - `name` may prefill `displayName` only when the profile has none. `picture` and `hd` are not stored.
6. **Session.**
   - A known `sub` signs in; an unknown `sub` creates `customers` and `customer_identities` rows (implicit sign-up).
   - Issue a fresh session with a rotated token, deleting any token the browser presented, and set `authenticated_at` to now.
   - Respond `303` to `/account?status=signed-in`.
   - Re-authentication for sensitive actions means running this flow again.
7. **JWKS caching and rotation.**
   - Cache keys per Worker isolate, honouring `Cache-Control: max-age`. The TTL is clamped to between 5 minutes and 24 hours, defaulting to 1 hour.
   - On an unknown `kid`, refetch once, at most once per minute per isolate. Then reject.
   - Keep the key list bounded (≤50 keys). Never trust `jku` or `x5u` headers.
   - This verifier is separate from the Access verifier. Any shared JWT helper takes explicit issuer and audience parameters, so neither verifier can accept the other's tokens.

### Strict separation from manager authentication

- **Distinct principals.** Customers and managers have no shared table, no `role` column, and no endpoint, flag or migration that turns a customer into a manager.
- **Routes.** Customer APIs live only under `/api/account/*`, and the cabinet only under `/account` and `/account/*`.
- **Manager routes never accept customer sessions.** `/api/admin/*`, `/admin*`, private `/media/*` access and `GET /api/auth/session` resolve identity only through `auth.js` `identity()`, which reads `CF-Access-Jwt-Assertion` or `CF_Authorization`. They never read the customer cookie.
- **Customer routes ignore Cloudflare Access.** `/api/account/*` resolves only the customer session cookie. A valid Access JWT or `AUTH_DEV_BYPASS=true` grants no customer identity.
- **Modules.** Customer code is in new modules (`customer-auth.js`, `google-oidc.js`, `customer-profile.js`, `telegram-link.js`). `auth.js` remains manager-only.
- **Cloudflare Access scope.**
  - The manager Access application keeps exactly the current manager paths: `/admin`, `/admin/*`, `/api/admin/*` and `/api/auth/*`, on both `example.com` and the `workers.dev` host.
  - It must never include `/account`, `/account/*` or `/api/account/*`.
  - **Lead constraint:** any Access re-scoping must keep the currently allowed manager identities and requires explicit lead approval.

### Session cookie and lifecycle

- **Environment rule (ADR-0005).** Every `APP_ENV` other than `"development"` is production-like. That includes `"staging"` and an unset value. Production-like means:
  - missing configuration fails closed;
  - `__Host-` cookies are always used;
  - dev cookie names (`ls_session_dev`, `ls_oidc_dev`) and HTTP loopback redirect origins are allowed only when `APP_ENV === "development"` and the request hostname is loopback.
- **Cookie.** In every production-like environment: `__Host-ls_session=<token>; Path=/; Secure; HttpOnly; SameSite=Lax; Max-Age=<remaining absolute lifetime>`, with no `Domain`. Only when `APP_ENV === "development"` on a loopback hostname are the cookies `ls_session_dev` and `ls_oidc_dev`, without `Secure`.
- **Token.** 32 random bytes, base64url. D1 stores only the SHA-256 hash as the primary key. The token never appears in URLs, logs or JSON.
- **Expiry.** 7-day sliding idle expiry and 30-day absolute expiry. `last_seen_at` is refreshed at most hourly.
- **Rotation.** The token rotates on sign-in and on linking or unlinking an identity. The token the browser presented is always deleted, so there is no fixation.
- **Limits.** At most 10 sessions per customer; the oldest is evicted. `authenticated_at` supports a 10-minute recent-authentication window for unlinking and account deletion.
- **Logout and revocation.** Logout deletes the row and clears the cookie. "Sign out everywhere" deletes all of the customer's sessions. Deleting or disabling an account deletes its sessions.
- **Cleanup.** Expired sessions, flows and throttle buckets are deleted opportunistically in bounded batches. A scheduled cleanup would be a separate, ordered change to the shared `scheduled()` block.

### CSRF and redirects

- **Existing rules.** Keep the same-Origin check on non-GET `/api/*` and the JSON content type. `SameSite=Lax` is defense in depth.
- **OIDC callbacks.** These are the only state-changing GETs. They are protected by a single-use state bound to the cookie, PKCE S256 and a nonce, which also prevents login CSRF.
- **Return targets.** Return paths come from a fixed allowlist (`/account`). Callers cannot supply return URLs, so there are no open redirects.

### Throttling and enumeration

- **Storage.** D1 fixed-window counters (`customer_auth_throttle`). Keys are HMAC-SHA256 values computed with the `CUSTOMER_AUTH_HMAC_KEY` Worker secret over `CF-Connecting-IP` or the customer ID, so raw IPs are never stored. Production-like environments fail closed if the key is missing.
- **Default limits:**
  - OIDC start: 20 per IP per 10 minutes
  - callback: 30 per IP per 10 minutes
  - profile writes: 60 per customer per hour
- **Over limit.** `429 {error}` with `Retry-After`.
- **Enumeration.** No local credentials exist, so there is no password lockout and no email-enumeration surface. An unknown Google `sub` simply becomes a new account.
- **Possible later additions.** The Workers Rate Limiting binding or Turnstile.

### PII minimization, retention, deletion and export (values pending a lead decision)

- **Collected data:**
  - Google `sub`.
  - Verified Google email as a display handle.
  - An optional display name, which may be prefilled from `name`.
  - A Ukrainian phone number, contact email and Nova Poshta preference, all customer-entered.
  - A Telegram OIDC `sub`, if the customer links Telegram.
- **Not collected:** addresses, payment data, IP history, Google pictures or tokens.
- **Proposed retention.** Sessions until expiry. Flow states 10 minutes. Throttle buckets 24 hours. Audit events while the account exists.
- **Deletion.** `DELETE /api/account` hard-deletes the customer and, by cascade, all customer rows. Alternatively, the lead may keep anonymized audit events for a fixed period. Google access is not revoked server-side, because no Google token is stored; the customer can remove the app in their Google account settings.
- **Export.** `GET /api/account/export` returns all stored customer fields, without hashes or secrets.
- **Manager visibility.** This epic adds no manager endpoint that reads customer PII.
- **Privacy notice.** The text is the lead's. It is linked at sign-in and in the cabinet before QA sign-off.

### Logging and redaction

Follow the existing pattern: `console.error` logs only the error class or name.

- **Never logged:** session tokens or hashes; OIDC `code`, `state`, `code_verifier`, `nonce` or `id_token`; client secrets; emails, phones, `sub` values or raw IPs; request bodies.
- **Audit rows.** The actor is `customer:<uuid>`. Only changed field names are recorded, never values.
- **Upstream errors.** Messages from Google, Telegram and Nova Poshta map to fixed messages.

### D1 schema sketch and migration ordering

D1 enforces foreign keys, so `ON DELETE CASCADE` implements deletion. Migrations merge strictly in numeric order.

**`migrations/0004_customer_accounts.sql`**:

```sql
CREATE TABLE customers (id TEXT PRIMARY KEY, status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','disabled')), created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
CREATE TABLE customer_identities (id TEXT PRIMARY KEY, customer_id TEXT NOT NULL REFERENCES customers(id) ON DELETE CASCADE, provider TEXT NOT NULL CHECK (provider IN ('google','telegram')), subject TEXT NOT NULL, display_handle TEXT, created_at TEXT NOT NULL, last_used_at TEXT, UNIQUE(provider,subject), UNIQUE(customer_id,provider));
CREATE TABLE customer_sessions (token_hash TEXT PRIMARY KEY, customer_id TEXT NOT NULL REFERENCES customers(id) ON DELETE CASCADE, created_at TEXT NOT NULL, authenticated_at TEXT NOT NULL, last_seen_at TEXT NOT NULL, idle_expires_at TEXT NOT NULL, absolute_expires_at TEXT NOT NULL);
CREATE INDEX customer_sessions_customer ON customer_sessions(customer_id);
CREATE INDEX customer_sessions_expiry ON customer_sessions(absolute_expires_at);
CREATE TABLE customer_auth_flows (binding_hash TEXT PRIMARY KEY, state_hash TEXT NOT NULL UNIQUE, provider TEXT NOT NULL CHECK (provider IN ('google','telegram')), intent TEXT NOT NULL CHECK (intent IN ('login','link')), customer_id TEXT REFERENCES customers(id) ON DELETE CASCADE, code_verifier TEXT NOT NULL, nonce TEXT NOT NULL, redirect_uri TEXT NOT NULL, return_path TEXT NOT NULL, created_at TEXT NOT NULL, expires_at TEXT NOT NULL, CHECK ((provider='google' AND intent='login') OR (provider='telegram' AND intent='link' AND customer_id IS NOT NULL)));
CREATE TABLE customer_auth_throttle (bucket TEXT NOT NULL, key_hmac TEXT NOT NULL, window_start INTEGER NOT NULL, count INTEGER NOT NULL, PRIMARY KEY (bucket,key_hmac,window_start));
CREATE TABLE customer_audit_events (id TEXT PRIMARY KEY, customer_id TEXT NOT NULL REFERENCES customers(id) ON DELETE CASCADE, action TEXT NOT NULL, fields TEXT NOT NULL DEFAULT '[]', created_at TEXT NOT NULL);
CREATE INDEX customer_audit_customer ON customer_audit_events(customer_id,created_at);
```

Telegram links are `customer_identities` rows with `provider='telegram'`, so Telegram linking needs no migration of its own. The Google identity is the sign-in identity and cannot be unlinked; deleting the account is the alternative.

**`migrations/0005_customer_profile.sql`** (merged only after 0004):

```sql
CREATE TABLE customer_profiles (customer_id TEXT PRIMARY KEY REFERENCES customers(id) ON DELETE CASCADE, display_name TEXT, phone_e164 TEXT, contact_email TEXT, np_type TEXT CHECK (np_type IS NULL OR np_type IN ('branch','postomat')), np_city_name TEXT, np_city_ref TEXT, np_warehouse_number TEXT, np_warehouse_ref TEXT, np_note TEXT, np_source TEXT CHECK (np_source IS NULL OR np_source IN ('manual','np-api')), updated_at TEXT NOT NULL);
```

A later Nova Poshta reference cache takes the next free migration number when it is scheduled.

> **Superseded in part by [ADR-0011](0011-nova-post-delivery-point.md).** The planned Nova Poshta cache task was never created; the lookup work moved to ADR-0011. The reference copy is an R2 snapshot written by a sync script, not a D1 cache. Migration `0012_delivery_point.sql` adds `np_warehouse_name` and `np_origin` to `customer_profiles`. The profile table itself is in `migrations/0006_customer_profile.sql`, not `0005`.

### Nova Poshta preference shape

`NovaPoshtaPreference`:

```text
{type:"branch"|"postomat", cityName:string, cityRef?:string|null, warehouseNumber?:string|null, warehouseRef?:string|null, note?:string|null, source:"manual"|"np-api"}
```

- **`type`**: required. A `branch` is a відділення, including cargo branches. A `postomat` is a поштомат.
- **`cityName`**:
  - Normalize Unicode to NFC, trim, and collapse internal whitespace.
  - Convert apostrophe variants (`'` U+0027, `’` U+2019, `‘` U+2018, `` ` `` U+0060) to the Ukrainian apostrophe `ʼ` (U+02BC) before validation.
  - Then require 1–100 characters drawn from Ukrainian and Latin letters, digits, spaces, `ʼ` and `-.,()`. No control characters.
- **`warehouseNumber`**: a string matching `^[0-9]{1,6}$`. It is not numeric arithmetic.
- **`cityRef`, `warehouseRef`**: Nova Poshta API 2.0 `Ref` GUIDs matching `^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$`, case-insensitive, stored lowercase.
- **Required location**: at least one of `warehouseNumber` or `warehouseRef`.
- **`note`**: plain text, at most 200 characters, no control characters except a single newline.
- **`source`**: set by the server. It is `manual` until a Nova Poshta lookup verifies the refs with `Address.getWarehouses`, then `np-api`. Client refs are unverified hints.

  > **Superseded by ADR-0011 §5–§6.** The Nova Poshta lookup moved to ADR-0011. The preference input is now `{warehouseRef, note?}`, validated against the local Nova Poshta catalog; every new write has `source:"np-api"`. Every row written under this record has `source:"manual"`, including client-supplied Refs; such legacy rows are displayed but never prefilled.
- **Clearing**: `deliveryPreference: null` clears all `np_*` columns.

Refs are the stable keys in Nova Poshta API 2.0 (`Address.getCities`, `Address.getWarehouses` with `CityRef`, and `TypeOfWarehouseRef` to separate postomats). The human-readable name and number are kept alongside them. Postomat type refs are discovered with `Address.getWarehouseTypes`, never hardcoded.

> **Superseded by ADR-0011 §2.** The spike found that `TypeOfWarehouse` does not separate postomats cleanly. Points are classified by an allowlist on `CategoryOfWarehouse` (`Postomat` → `postomat`; `Branch` and `Store` → `branch`; `DropOff`, `Fulfillment` and anything else are excluded). `getWarehouseTypes` is not used.

For the Nova Poshta lookup, a thin in-house `fetch` client is preferred over a third-party SDK. It POSTs to `https://api.novaposhta.ua/v2.0/json/` with a timeout, a size bound and a server-only `NOVA_POSHTA_API_KEY`. Candidate open-source libraries were reported to the orchestrator.

> **Superseded by ADR-0011.** The lead decided that only the branch list is needed and that there is no business account (L1: no API key). There is no Worker client: a keyless sync script copies the branch list into R2, and the Worker reads only that copy. The script sends `NOVA_POSHTA_API_KEY` only if it is ever set.

### `/api/account/*` contract draft

**Conventions** (from docs/API.md):

- JSON with `{error:string}` errors. Every response carries `Cache-Control: no-store`.
- Non-GET requests need the same `Origin` and an `application/json` body.
- A missing or expired session returns `401 {error:"Sign-in required"}`, except on `GET /api/account/session`, which never returns 401. Throttled requests return `429` with `Retry-After`.
- Every query is scoped to the session's customer. Unknown body keys are rejected with `400`.
- Callback `reason` values:
  - `invalid`: no flow row matches the `state` with the expected provider and intent. This covers an unknown, already consumed, or wrong-provider/intent state.
  - `expired`: a row matched, but the binding cookie does not match or the row has expired.
  - `denied`: the provider returned `error`.
  - `conflict` (Telegram only): the Telegram identity is linked to another customer, or this customer already has a different Telegram identity.

| Method / path | Body | Success | Notable errors |
| --- | --- | --- | --- |
| `GET /api/account/session` | – | `200 {authenticated:false}` or `{authenticated:true,customer:Customer}` | none (never 401) |
| `POST /api/account/google/start` | `{}` | `200 {authorizationUrl}` and sets `__Host-ls_oidc` | 400 origin not allowed; 429; 503 not configured |
| `GET /api/account/google/callback?code&state` | – | `303` to `/account?status=signed-in` | `303` to `/account?status=error&reason=expired\|denied\|invalid` |
| `POST /api/account/telegram/start` | `{}` | `200 {authorizationUrl}` (ADR-0004) | 401; 429; 503 |
| `GET /api/account/telegram/callback?code&state` | – | `303` to `/account?status=linked` | `303` to `/account?status=error&reason=expired\|denied\|invalid\|conflict` |
| `POST /api/account/logout` | `{}` | `200 {authenticated:false}` and clears the cookie | none (idempotent) |
| `POST /api/account/sessions/revoke-all` | `{}` | `200 {revoked:number}` and clears the cookie | 401 |
| `GET /api/account/profile` | – | `200 Profile` | 401 |
| `PATCH /api/account/profile` | `{displayName?,lastName?,firstName?,middleName?,phone?,contactEmail?,deliveryPreference?}`; `null` clears a field | `200 Profile` | 400; 401; 429 |
| `DELETE /api/account/telegram` | `{confirm:true}` | `200 Profile` | 401; 403 if not recently authenticated |
| `GET /api/account/export` | – | `200 {customer,identities,profile,auditEvents}` | 401 |
| `DELETE /api/account` | `{confirm:true}` | `200 {deleted:true}` and clears the cookie | 401; 403 if not recently authenticated |

**Types:**

- `Customer`: `{id,displayName:string|null,signInEmail:string|null,providers:string[],createdAt}`. `signInEmail` is the verified Google email handle.
- `Profile`: `{displayName:string|null,lastName:string|null,firstName:string|null,middleName:string|null,phone:string|null,contactEmail:string|null,deliveryPreference:NovaPoshtaPreference|null,telegram:{linked:boolean,handle:string|null,linkedAt:string|null},updatedAt:string|null}`.

**Field rules:**

- `displayName`: 1–80 characters, trimmed, no control characters.
- `lastName`, `firstName`, `middleName`: the ПІБ parts that prefill the checkout recipient; the checkout recipient rule applies (1–40 Cyrillic/Latin letters, ʼ ' ’, hyphen or single space only between letters). See [docs/API.md](../API.md).
- `phone`: normalized to `+380XXXXXXXXX` from `+380…`, `380…` or `0XXXXXXXXX` input.
- `contactEmail`: at most 254 characters and a simple `local@domain.tld` shape. It is unverified and labelled so in the UI. It is never auto-filled from Google.

**Indexing.** Policy: `robots.txt` stays allow-all with no `Disallow`.

- `/account`, `/account/*` and `/api/account/*` receive `X-Robots-Tag: noindex, nofollow` from the shared private-path noindex rule (`isPrivatePath`).
- The account SPA document carries `<meta name="robots" content="noindex, nofollow">`, injected by the private-path Worker HTML rewrite.
- The private-path indexing change adds `/account` and `/account/*` to `run_worker_first`.
- `sitemap.xml` never lists account paths.

### OWASP ASVS 4.0.3 Level 1 mapping

Scope: customer accounts. Verify the IDs against ASVS 4.0.3 during review. Remapping to ASVS 5.0 is a follow-up.

| ASVS | Requirement | How this design meets it |
| --- | --- | --- |
| V2.1–2.5 (passwords, recovery) | Local credential rules | N/A. No local passwords. Authentication, recovery and MFA are delegated to Google. |
| 2.2.1 | Anti-automation | D1 throttles on start, callback and writes; 429 with Retry-After |
| 3.1.1 | No session token in URL | Cookie only. Callback redirects carry a status code only. |
| 3.2.1 / 3.2.2 / 3.2.3 | New token at sign-in, ≥64-bit entropy, cookie storage | 256-bit random token, rotated at sign-in and on identity changes |
| 3.3.1 / 3.3.2 | Logout/expiry invalidates; periodic re-auth | Server-side delete; 7-day idle and 30-day absolute expiry |
| 3.4.1–3.4.5 | Secure, HttpOnly, SameSite, `__Host-`, Path | `__Host-ls_session; Path=/; Secure; HttpOnly; SameSite=Lax` |
| 3.5.3 (L2, informative) | Signed tokens validated | ID token: RS256 signature, `iss`, `aud`/`azp`, `exp`, `iat`, nonce |
| 3.7.1 | Re-auth for sensitive actions | 10-minute `authenticated_at` window for unlink and deletion |
| 4.1.1 / 4.1.3 / 4.1.5 | Server-side enforcement, least privilege, fail closed | Per-request customer resolver; no roles; missing config gives 503 |
| 4.2.1 | IDOR | Every query scoped to the session's `customer_id`; no customer IDs in paths |
| 4.2.2 | CSRF | Same-Origin check + JSON + SameSite=Lax + OIDC state/PKCE/nonce |
| 5.1.3 / 5.1.4 | Allowlist and structured validation | Bounded field rules; unknown keys rejected |
| 7.4.1 | Generic errors | Fixed `{error}` and `reason` values; no upstream detail |
| 8.3.1 | Sensitive data not in URL | Tokens in cookie or body only; the OIDC `code` is single-use at the provider |
| 8.3.2 | Export and delete | `GET /api/account/export`, `DELETE /api/account` |
| 14.4.x | Security headers | Existing global headers plus `no-store` and `noindex` on private paths |

## Consequences

- **New trust boundary.** Customer identity is a new, separately tested boundary. Reviewers check both negative paths: an Access JWT or the dev bypass is never a customer identity, and a customer cookie is never a manager identity.
- **Sign-in dependency.** Sign-in depends on Google availability; the catalog and manager cabinet do not.
- **New external hosts.** The Worker calls `oauth2.googleapis.com` and `www.googleapis.com` (and, for linking, `oauth.telegram.org`) on fixed hosts with timeouts.
- **Tests.** Tests use a locally generated RSA key pair and stubbed token and JWKS endpoints. No live Google calls run in CI. Live sign-in stays unverified until deploy wiring binds the lead-created client into the Worker.
- **Sensitive data.** D1 holds customer PII for the first time, so D1 backups and exports become sensitive.
- **Secrets.** New Worker secrets are `GOOGLE_CLIENT_SECRET`, `CUSTOMER_AUTH_HMAC_KEY` and `TELEGRAM_CLIENT_SECRET` (ADR-0004). New plain variables are `GOOGLE_CLIENT_ID`, `TELEGRAM_CLIENT_ID` and `OIDC_REDIRECT_ORIGINS`. The deploy secret-binding tooling (`tools/cloudflare-secrets.mjs`, `.github/workflows/ci.yml` and their test) must be extended in a separately owned, ordered task. The lead provisions the values, and they are never recorded.
- **Shared-file integration order:**
  1. `apps/api/src/index.js` `/api/account` routing block (accounts first, then profile and Telegram linking)
  2. `migrations/0004` then `0005`
  3. secret-binding tooling
- **Contract source.** This endpoint table is the single source of status codes. docs/API.md mirrors it.
- **Manager rule.** The "no password login or self-issued session" rule applies to **manager** authentication (ADR-0001 is unchanged for managers). Customers use Google-federated sign-in with Worker-issued opaque sessions.

## Revisit triggers

- A fallback sign-in is requested.
- Checkout or orders are introduced (order PII, ASVS L2).
- Google changes its issuers, keys or consent rules.
- A manager-side customer support view is requested.
- Abuse is observed.
- ASVS 5.0 adoption.
- The number of customers makes D1 session writes a material cost.
