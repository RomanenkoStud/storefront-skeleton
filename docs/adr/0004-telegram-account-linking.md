# ADR-0004: Telegram account linking

Status: **Proposed.** The lead registered the bot's trusted origins and provisioning the credentials (see "Lead-provided setup"). Telegram is used for **account linking only**. Customer sign-in is Google OIDC, accepted by the lead (see [ADR-0003](0003-client-accounts.md)). This ADR itself authorizes no further BotFather change or secret provisioning.

## Context

Customers can link a Telegram account to their cabinet profile. Later, the same link might let the shop contact them through a bot. The integration must:

- prove the customer controls the Telegram account;
- resist replay;
- support unlinking;
- keep every Telegram credential server-only (a Worker secret), never in the repository, the browser bundle or logs.

The task brief assumed the legacy Login Widget. The official documentation has changed:

- Telegram now offers **"Log in with Telegram" as standard OpenID Connect**: authorization code flow with PKCE S256, discovery at `https://oauth.telegram.org/.well-known/openid-configuration`, and ID tokens signed RS256 by default and published at `https://oauth.telegram.org/.well-known/jwks.json`.
- The iframe widget, verified by HMAC over the bot token, is documented as **archived/legacy**.

Sources: [Log In With Telegram](https://core.telegram.org/bots/telegram-login), [OIDC discovery](https://oauth.telegram.org/.well-known/openid-configuration), [legacy widget](https://core.telegram.org/widgets/login-legacy).

## Options

| Option | How it proves control | Replay / expiry | Credentials | Trade-offs |
| --- | --- | --- | --- | --- |
| **(A) Legacy Login Widget** | The browser receives `id, first_name, last_name, username, photo_url, auth_date, hash`. The server builds a data-check-string (fields sorted alphabetically, `key=value`, joined by `\n`) and compares `hex(HMAC_SHA256(data_check_string, SHA256(bot_token)))` to `hash` in constant time. | Only an `auth_date` freshness window. No server nonce, so a captured payload can be replayed within the window unless used hashes are stored. | Bot token (full bot control) is used as the verification key. Domain is set with `/setdomain`. | Archived. Third-party iframe and script on our page. Weakest replay story. The bot token is far more powerful than needed for verification. |
| **(B) Telegram OIDC (code + PKCE)** | The server redirects to `oauth.telegram.org/auth` with `state`, `code_challenge` (S256) and `nonce`. The callback `code` is exchanged server-to-server at `/token` with HTTP Basic `client_id:client_secret`. The `id_token` is verified as RS256 against the JWKS, with `iss=https://oauth.telegram.org`, `aud=<client_id>`, `exp`, recent `iat` and `nonce`. | Single-use server-stored `state` bound to a cookie, plus a PKCE verifier and nonce, with a 10-minute expiry. Codes are single-use at Telegram. | Numeric Client ID (the bot ID; public; *not* the bot username) and a separate Client Secret, both shown in the @BotFather mini app → bot → Login Widget. Trusted origins (scheme + host only, no paths) are registered there. **No bot token is needed for linking.** | Current standard. Same code + PKCE + JWKS machinery as the Google sign-in adapter (ADR-0003). Redirect flow needs no third-party script (the popup library would also need relaxed COOP). |
| **(C) Bot deep link** | The server issues a random nonce. The customer opens `https://t.me/<bot>?start=<nonce>` (payload ≤64 characters, `[A-Za-z0-9_-]`). The bot webhook receives `/start <nonce>` with `from.id` and `chat.id`, and links them. | Single-use, hashed-at-rest nonce with a 10-minute expiry. The webhook authenticates with the `X-Telegram-Bot-Api-Secret-Token` header set via `setWebhook secret_token`. | Bot token plus a webhook secret. Needs a public webhook route and `setWebhook` operations. | Gives a chat the bot can message, which is useful for future notifications. More moving parts: update handling, a public endpoint, and bot token custody. Linking happens out-of-band, so the UI must poll. |

## Recommendation (proposed)

Use **(B) Telegram OIDC, server-side redirect flow** for linking only. Telegram is never a sign-in method; customers sign in with Google (ADR-0003). Keep (C) as a later, separate decision if bot notifications are wanted; it would need `telegram:bot_access` scope or a deep link plus the bot token. Reject (A), because it is archived and has a weaker replay model.

### Flow and checks

1. **Start.** `POST /api/account/telegram/start {}` (the intent is always `link`) requires a customer session and passes the same-Origin check.
   - The server creates 32-byte random values: `state`, `nonce`, PKCE `code_verifier` and a browser binding token.
   - It stores `customer_auth_flows` with provider `telegram`, intent `link`, hashes of the state and binding, `customer_id`, verifier, nonce, the redirect URI, the fixed return path `/account` and `expires_at = now + 10 min`.
   - It sets `__Host-ls_oidc=<binding>; Path=/; Secure; HttpOnly; SameSite=Lax; Max-Age=600`. The `__Host-` prefix requires `Path=/`. Lax still sends the cookie on Telegram's top-level redirect back to us. `ls_oidc_dev` is used only when `APP_ENV === "development"` on a loopback hostname. Every other `APP_ENV`, including `staging` and unset, is production-like (ADR-0003 environment rule, ADR-0005).
   - It returns `{authorizationUrl}` for `https://oauth.telegram.org/auth` with `client_id`, `redirect_uri=<request origin>/api/account/telegram/callback` (the origin must be both a registered trusted origin and in `OIDC_REDIRECT_ORIGINS`), `response_type=code`, `scope=openid` (add `profile` only if the lead wants the username shown), `state`, `nonce`, `code_challenge` and `code_challenge_method=S256`.
2. **Callback.** `GET /api/account/telegram/callback?code&state`.
   - Atomically consume the flow (`DELETE … WHERE state_hash=? AND provider='telegram' AND intent='link' RETURNING …`).
   - No matching row (unknown, already consumed, or wrong provider/intent) → `303` to `/account?status=error&reason=invalid`.
   - A matched row whose binding cookie hash does not match, or which has expired → `reason=expired`.
   - The current customer session must belong to the flow's `customer_id`.
   - A provider `error` → `reason=denied`.
   - Clear `__Host-ls_oidc`.
3. **Token exchange.** `POST https://oauth.telegram.org/token` (form-encoded, Basic auth). Use a fixed host, `redirect: 'manual'`, a 10-second timeout and a bounded response size.
   - Body: `grant_type=authorization_code`, `code`, `redirect_uri`, `client_id`, `code_verifier`.
   - Header: `Authorization: Basic base64(client_id:client_secret)`. Discovery also lists `client_secret_post`; use Basic, as documented.
4. **Verify the `id_token`.**
   - `alg` must be in an allowlist: `RS256`. `ES256` is added only if the lead explicitly switches it and the allowlist is updated. The algorithm is selected in BotFather → Login Widget → Advanced; keep RS256. `EdDSA` and `ES256K` are not allowlisted; they also disable the profile and phone scopes.
   - Look up `kid` in the JWKS, which is cached for 1 hour and refreshed once on a miss.
   - Check the signature, `iss === "https://oauth.telegram.org"`, `exp > now`, and that `iat` is no more than 60 s in the future and no older than 600 s.
   - `aud`: a string equal to `String(client_id)`, or an array containing it. In the array case `azp` must be present and equal to `client_id`; if `azp` is present in the string case it must also match. This is the same rule as the Google adapter in ADR-0003. Telegram issues `aud` as the bot ID in string form (e.g. `"123456789"`); compare it to `String(TELEGRAM_CLIENT_ID)`. Config parsing rejects a non-numeric `TELEGRAM_CLIENT_ID` (`^[0-9]+$`, fail closed), which guards against configuring the bot username by mistake.
   - `nonce`: always sent in the authorization request. If the token contains a `nonce` claim, it must equal the stored nonce. Telegram's manual-flow documentation does not show the nonce being echoed, so requiring the claim to be present is a **live-verification item**. If live testing shows Telegram echoes it, make it mandatory. Without it, single-use state plus PKCE remain the binding. (For Google, nonce is always required.)
   - `sub` must be a non-empty string of at most 64 characters.
   - Reject anything else. This verifier is independent of the Access verifier.
5. **Link.**
   - Insert `customer_identities(provider='telegram', subject=sub, display_handle=preferred_username if the profile scope was granted)`.
   - Uniqueness conflicts:
     - If the Telegram identity is already linked to another customer, redirect with `reason=conflict`, without revealing which customer.
     - If this customer already has a different Telegram identity linked, return a conflict; the customer must unlink first.
   - Rotate the session, write the audit event `telegram.link`, and redirect `303` to `/account?status=linked` (the same target as ADR-0003 and docs/API.md).
6. **No sign-in through Telegram.** The callback never creates customers or sessions for a visitor without a session. A Telegram identity never authenticates a customer.

### Unlink

- `DELETE /api/account/telegram {confirm:true}` requires `authenticated_at` within the last 10 minutes; otherwise it returns `403`, and the UI asks the customer to sign in with Google again.
- Unlinking never strands an account, because Google is always the sign-in identity.
- On success, delete the identity row, rotate the session and audit `telegram.unlink`. Nothing is sent to Telegram; the customer can revoke the app on Telegram's side.

### Identifier and PII

The link key is the OIDC `sub`. The numeric Telegram `id`, name, username and photo are not stored unless the `profile` scope is approved. `phone` is never requested in this epic. The phone number in the cabinet profile is entered by the customer, not taken from Telegram.

## Lead-provided setup (closed)

- The lead owns the bot in BotFather. Its display name and logo should match the shop.
- **Trusted origins** (BotFather → Login Widget → Trusted origins) take **origins only (scheme + host, no paths)**.
  - Registered: `https://example.com` and the Worker's `workers.dev` origin.
  - `https://staging.example.com` must be added later.
  - Our `redirect_uri` is `<origin>/api/account/telegram/callback`, and Telegram validates it against the trusted origin.
  - **Live-verification item:** whether Telegram also requires or matches the exact callback path.
  - The legacy `/setdomain` command is not used.
  - Add a separate development bot or origin only if needed; never reuse production credentials locally.
- `TELEGRAM_CLIENT_ID`: provisioned by the lead. It is the numeric Login Widget Client ID, not the bot username.
- `TELEGRAM_CLIENT_SECRET`: provisioned by the lead. It is the Login Widget Client Secret, **never** the Bot API token from BotFather's `/newbot` or `/token` commands. The bot token is not needed for this design and is not stored anywhere: not in GitHub, Worker secrets or local files.
- Custody: `TELEGRAM_CLIENT_ID` is a GitHub repository variable and `TELEGRAM_CLIENT_SECRET` a GitHub repository secret, both already provisioned. Both are bound into the Worker by the existing secret-binding deployment path. If (C) is chosen later, the bot token and webhook secret become additional Worker secrets. No values are recorded in Beads, git, logs or handoffs.
- Scope: `openid` only (recommended), or `openid profile` to show the Telegram username. This remains a lead choice for the linking implementation.

## Consequences

- The Worker makes outbound calls to `oauth.telegram.org` (token and JWKS) on fixed hosts with timeouts. A Telegram outage blocks linking only; sign-in (Google) and the rest of the store are unaffected.
- The secret is a Client Secret with narrow scope instead of the full bot token. Rotating it in BotFather requires a Worker secret update and redeploy.
- Tests use a locally generated RSA key pair and a stubbed JWKS and token endpoint. No live Telegram calls run in CI. A live link stays unverified until deploy wiring binds the provisioned credentials and a real link is exercised.

## Revisit triggers

- Telegram deprecates or changes its OIDC claims or algorithms.
- Bot notifications or order messages are requested; then evaluate (C) or `telegram:bot_access`.
- Mini App integration is requested.
- The Google and Telegram OIDC clients diverge enough, or converge enough, to justify sharing or separating a JWT/OIDC helper (its own reviewed task).
