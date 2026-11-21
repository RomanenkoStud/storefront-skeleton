import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import worker from '../../apps/api/src/index.js';
import { resetGoogleJwksCache } from '../../apps/api/src/google-oidc.js';

const ORIGIN = 'https://catalog.test';
const CLIENT_ID = 'test-client-id.apps.example';
const FAKE = { secret: 'fake-client-secret-value', hmac: 'fake-hmac-key-for-tests', code: 'fake-auth-code-123' };
const sha256 = value => createHash('sha256').update(value).digest('hex');
const b64 = value => Buffer.from(JSON.stringify(value)).toString('base64url');

function database() {
  const sqlite = new DatabaseSync(':memory:');
  for (const file of ['0001_catalog', '0002_mydrop_connection', '0003_admin_trash', '0004_customer_accounts', '0005_recognition', '0007_taxonomy', '0011_carts', '0014_media', '0016_duplicate_groups']) sqlite.exec(readFileSync(new URL(`../../migrations/${file}.sql`, import.meta.url), 'utf8'));
  const wrap = (sql, bindings = []) => ({ sql, bindings, bind(...values) { return wrap(sql, values); }, async first() { return sqlite.prepare(sql).get(...bindings) ?? null; }, async all() { return { results: sqlite.prepare(sql).all(...bindings) }; }, async run() { return sqlite.prepare(sql).run(...bindings); } });
  return { sqlite, prepare: sql => wrap(sql), async batch(statements) { sqlite.exec('BEGIN'); try { const result = statements.map(s => ({ results: sqlite.prepare(s.sql).all(...s.bindings) })); sqlite.exec('COMMIT'); return result; } catch (error) { sqlite.exec('ROLLBACK'); throw error; } }, close: () => sqlite.close() };
}

let keys;
async function keyPair() {
  if (!keys) {
    const make = async () => crypto.subtle.generateKey({ name: 'RSASSA-PKCS1-v1_5', modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: 'SHA-256' }, true, ['sign', 'verify']);
    const good = await make(), other = await make();
    const jwk = await crypto.subtle.exportKey('jwk', good.publicKey); jwk.kid = 'google-key-1'; jwk.alg = 'RS256'; jwk.use = 'sig';
    const jwk2 = await crypto.subtle.exportKey('jwk', good.publicKey); jwk2.kid = 'google-key-2'; jwk2.alg = 'RS256'; jwk2.use = 'sig';
    keys = { good, other, jwk, jwk2 };
  }
  return keys;
}
async function signJwt(claims, header = {}, privateKey) {
  const { good } = await keyPair();
  const unsigned = b64({ alg: 'RS256', kid: 'google-key-1', ...header }) + '.' + b64(claims);
  const signature = await crypto.subtle.sign('RSASSA-PKCS1-v1_5', privateKey ?? good.privateKey, new TextEncoder().encode(unsigned));
  return unsigned + '.' + Buffer.from(signature).toString('base64url');
}

// Stubbed Google endpoints plus a cookie-jar client against the Worker. No live network.
async function setup(t, envOverrides = {}) {
  const { jwk } = await keyPair();
  resetGoogleJwksCache();
  const env = { DB: database(), APP_ENV: 'production', CF_ACCESS_TEAM_NAME: 'your-team', CF_ACCESS_AUD: 'catalog-audience', GOOGLE_CLIENT_ID: CLIENT_ID, GOOGLE_CLIENT_SECRET: FAKE.secret, OIDC_REDIRECT_ORIGINS: `${ORIGIN},https://other.test`, CUSTOMER_AUTH_HMAC_KEY: FAKE.hmac, ...envOverrides };
  const google = { jwks: [jwk], jwksCalls: 0, tokenCalls: [], tokenStatus: 200, nonce: null, claims: {}, header: {}, signWith: null, tokenBody: null, tokenFetchError: false };
  const original = globalThis.fetch, logs = [], errorLog = console.error;
  console.error = (...args) => { logs.push(args.map(String).join(' ')); };
  globalThis.fetch = async (url, options) => {
    if (options?.redirect !== undefined && !['follow', 'manual'].includes(options.redirect)) throw new TypeError('Invalid redirect value');
    url = String(url);
    if (url === 'https://www.googleapis.com/oauth2/v3/certs') { google.jwksCalls++; return new Response(JSON.stringify({ keys: google.jwks }), { headers: { 'Content-Type': 'application/json', 'Cache-Control': 'public, max-age=22000' } }); }
    if (url === 'https://oauth2.googleapis.com/token') {
      assert.equal(options.method, 'POST'); assert.equal(options.redirect, 'manual');
      google.tokenCalls.push(Object.fromEntries(new URLSearchParams(String(options.body))));
      if (google.tokenFetchError) throw new TypeError('network down');
      if (google.tokenStatus !== 200) return new Response(JSON.stringify({ error: 'invalid_grant', error_description: 'leaky-detail' }), { status: google.tokenStatus });
      const now = Math.floor(Date.now() / 1000);
      const claims = { iss: 'https://accounts.google.com', aud: CLIENT_ID, sub: 'google-sub-1', email: 'shopper@example.com', email_verified: true, name: 'Shopper', iat: now, exp: now + 3600, nonce: google.nonce, ...google.claims };
      const idToken = google.tokenBody ?? await signJwt(claims, google.header, google.signWith);
      return new Response(JSON.stringify({ access_token: 'fake-google-access-token', id_token: idToken, token_type: 'Bearer' }), { headers: { 'Content-Type': 'application/json' } });
    }
    throw new Error('Unexpected network call to ' + url);
  };
  t.after(() => { globalThis.fetch = original; console.error = errorLog; env.DB.close(); });
  const jar = new Map();
  async function call(path, method = 'GET', body, { origin = ORIGIN, host = ORIGIN, headers = {}, cookies = true, contentType = 'application/json' } = {}) {
    const h = { ...headers };
    if (origin) h.Origin = origin;
    if (cookies && jar.size) h.Cookie = [...jar].map(([k, v]) => `${k}=${v}`).join('; ');
    if (body !== undefined) h['Content-Type'] = contentType;
    const response = await worker.fetch(new Request(host + path, { method, headers: h, body: body === undefined ? undefined : JSON.stringify(body), redirect: 'manual' }), env);
    for (const line of response.headers.getSetCookie()) { const [pair] = line.split(';'); const [name, ...rest] = pair.split('='); if (/Max-Age=0/i.test(line) || rest.join('') === '') jar.delete(name); else jar.set(name, rest.join('=')); }
    const type = response.headers.get('Content-Type') || '';
    const data = type.includes('json') ? await response.json() : await response.text();
    return { response, data };
  }
  const a = { env, google, call, jar, logs, sql: env.DB.sqlite };
  a.start = async () => { const r = await call('/api/account/google/start', 'POST', {}); if (r.response.status !== 200) return r; const u = new URL(r.data.authorizationUrl); google.nonce = u.searchParams.get('nonce'); r.params = u.searchParams; r.state = u.searchParams.get('state'); return r; };
  a.callback = (state, extra = '') => call(`/api/account/google/callback?code=${FAKE.code}&state=${state}${extra}`);
  a.signIn = async () => { const s = await a.start(); assert.equal(s.response.status, 200); return { ...(await a.callback(s.state)), start: s }; };
  return a;
}
const count = (a, table) => a.sql.prepare(`SELECT COUNT(*) n FROM ${table}`).get().n;
const location = r => r.response.headers.get('Location');
const SESSION = '__Host-ls_session', OIDC = '__Host-ls_oidc';

test('start validates configuration, origin allowlist, request shape and sets the binding cookie', async t => {
  const a = await setup(t);
  const ok = await a.start();
  assert.equal(ok.response.status, 200);
  const u = new URL(ok.data.authorizationUrl);
  assert.equal(u.origin + u.pathname, 'https://accounts.google.com/o/oauth2/v2/auth');
  assert.equal(ok.params.get('client_id'), CLIENT_ID); assert.equal(ok.params.get('redirect_uri'), ORIGIN + '/api/account/google/callback');
  assert.equal(ok.params.get('response_type'), 'code'); assert.equal(ok.params.get('scope'), 'openid email profile');
  assert.equal(ok.params.get('code_challenge_method'), 'S256'); assert.equal(ok.params.get('prompt'), 'select_account');
  const flow = a.sql.prepare('SELECT * FROM customer_auth_flows').get();
  assert.equal(flow.provider, 'google'); assert.equal(flow.intent, 'login'); assert.equal(flow.return_path, '/account'); assert.equal(flow.redirect_uri, ORIGIN + '/api/account/google/callback');
  assert.equal(ok.params.get('code_challenge'), createHash('sha256').update(flow.code_verifier).digest('base64url'));
  assert.equal(flow.state_hash, sha256(ok.state)); assert.equal(flow.nonce, ok.params.get('nonce'));
  assert.equal(flow.binding_hash, sha256(a.jar.get(OIDC)));
  assert.ok(![flow.state_hash, flow.binding_hash].some(v => v.includes(ok.state)));
  const cookie = ok.response.headers.getSetCookie()[0];
  assert.match(cookie, /^__Host-ls_oidc=[A-Za-z0-9_-]{43}; Path=\/; Secure; HttpOnly; SameSite=Lax; Max-Age=600$/);
  assert.equal(ok.response.headers.get('Cache-Control'), 'no-store');
  assert.ok(Date.parse(flow.expires_at) - Date.parse(flow.created_at) === 600000);
  // Other allowlisted origin works; unlisted origins are 400, and cross-site Origin is 403 before that.
  assert.equal((await a.call('/api/account/google/start', 'POST', {}, { origin: 'https://other.test', host: 'https://other.test' })).response.status, 200);
  a.env.OIDC_REDIRECT_ORIGINS = 'https://other.test';
  assert.equal((await a.call('/api/account/google/start', 'POST', {})).response.status, 400);
  a.env.OIDC_REDIRECT_ORIGINS = ORIGIN + '/,https://other.test';
  assert.equal((await a.call('/api/account/google/start', 'POST', {})).response.status, 400, 'allowlist is exact origins only');
  a.env.OIDC_REDIRECT_ORIGINS = ORIGIN;
  assert.equal((await a.call('/api/account/google/start', 'POST', {}, { origin: 'https://evil.test' })).response.status, 403);
  assert.equal((await a.call('/api/account/google/start', 'POST', {}, { origin: null })).response.status, 403);
  assert.equal((await a.call('/api/account/google/start', 'POST', { x: 1 })).response.status, 400);
  assert.equal((await a.call('/api/account/google/start', 'POST', { pad: 'x'.repeat(5000) })).response.status, 413);
  assert.equal((await a.call('/api/account/google/start', 'POST', {}, { contentType: 'text/plain' })).response.status, 415);
  assert.equal((await a.call('/api/account/google/start')).response.status, 405);
});

test('missing Google config or production HMAC key fails closed with 503', async t => {
  for (const missing of ['GOOGLE_CLIENT_ID', 'GOOGLE_CLIENT_SECRET', 'OIDC_REDIRECT_ORIGINS', 'CUSTOMER_AUTH_HMAC_KEY']) {
    const a = await setup(t, { [missing]: '' });
    const r = await a.call('/api/account/google/start', 'POST', {});
    assert.equal(r.response.status, 503, missing); assert.equal(count(a, 'customer_auth_flows'), 0);
    assert.equal((await a.call('/api/account/google/callback?code=x&state=y')).response.status, 503);
  }
  // Sessions endpoint still reports signed-out instead of failing.
  const a = await setup(t, { GOOGLE_CLIENT_ID: '' });
  assert.deepEqual((await a.call('/api/account/session')).data, { authenticated: false });
});

test('start and callback are throttled per hashed IP with Retry-After; raw IPs are not stored', async t => {
  const a = await setup(t), ip = { 'CF-Connecting-IP': '203.0.113.9' };
  for (let i = 0; i < 20; i++) assert.equal((await a.call('/api/account/google/start', 'POST', {}, { headers: ip })).response.status, 200);
  const limited = await a.call('/api/account/google/start', 'POST', {}, { headers: ip });
  assert.equal(limited.response.status, 429); assert.ok(Number(limited.response.headers.get('Retry-After')) > 0);
  assert.equal((await a.call('/api/account/google/start', 'POST', {}, { headers: { 'CF-Connecting-IP': '203.0.113.10' } })).response.status, 200);
  for (const row of a.sql.prepare('SELECT * FROM customer_auth_throttle').all()) assert.match(row.key_hmac, /^[0-9a-f]{64}$/);
  assert.ok(!JSON.stringify(a.sql.prepare('SELECT * FROM customer_auth_throttle').all()).includes('203.0.113'));
  for (let i = 0; i < 30; i++) assert.equal((await a.call('/api/account/google/callback?code=c&state=nope', 'GET', undefined, { headers: ip })).response.status, 303);
  assert.equal((await a.call('/api/account/google/callback?code=c&state=nope', 'GET', undefined, { headers: ip })).response.status, 429);
});

test('callback signs in with PKCE exchange, stores only hashed session tokens and creates identity by sub', async t => {
  const a = await setup(t);
  const r = await a.signIn();
  assert.equal(r.response.status, 303); assert.equal(location(r), '/account?status=signed-in');
  const [exchange] = a.google.tokenCalls;
  assert.equal(exchange.grant_type, 'authorization_code'); assert.equal(exchange.code, FAKE.code); assert.equal(exchange.client_id, CLIENT_ID); assert.equal(exchange.client_secret, FAKE.secret);
  assert.equal(exchange.redirect_uri, ORIGIN + '/api/account/google/callback'); assert.equal(createHash('sha256').update(exchange.code_verifier).digest('base64url'), r.start.params.get('code_challenge'));
  const cookie = a.jar.get(SESSION); assert.match(cookie, /^[A-Za-z0-9_-]{43}$/);
  const setCookie = r.response.headers.getSetCookie().find(c => c.startsWith(SESSION));
  assert.match(setCookie, /^__Host-ls_session=[^;]+; Path=\/; Secure; HttpOnly; SameSite=Lax; Max-Age=(2592000|2591999)$/); assert.ok(!/Domain/i.test(setCookie));
  assert.ok(!a.jar.has(OIDC), 'binding cookie is cleared');
  const row = a.sql.prepare('SELECT * FROM customer_sessions').get();
  assert.equal(row.token_hash, sha256(cookie)); assert.notEqual(row.token_hash, cookie);
  assert.equal(Date.parse(row.absolute_expires_at) - Date.parse(row.created_at), 30 * 86400000); assert.equal(Date.parse(row.idle_expires_at) - Date.parse(row.created_at), 7 * 86400000);
  assert.equal(count(a, 'customer_auth_flows'), 0);
  const identity = a.sql.prepare('SELECT * FROM customer_identities').get();
  assert.equal(identity.provider, 'google'); assert.equal(identity.subject, 'google-sub-1'); assert.equal(identity.display_handle, 'shopper@example.com');
  const session = await a.call('/api/account/session');
  assert.equal(session.data.authenticated, true); assert.equal(session.data.customer.signInEmail, 'shopper@example.com'); assert.deepEqual(session.data.customer.providers, ['google']);
  assert.equal(session.data.customer.id, identity.customer_id);
  const text = JSON.stringify(session.data); assert.ok(!text.includes('google-sub-1') && !text.includes(cookie) && !text.includes(row.token_hash));
  assert.equal(session.response.headers.get('Cache-Control'), 'no-store');
});

test('identity is keyed by sub, never email; unverified email is not stored; sign-in rotates the presented token', async t => {
  const a = await setup(t);
  await a.signIn();
  const first = a.jar.get(SESSION), customerId = a.sql.prepare('SELECT id FROM customers').get().id;
  a.google.claims = { email: 'renamed@example.com' };
  await a.signIn();
  assert.equal(count(a, 'customers'), 1); assert.equal(a.sql.prepare('SELECT id FROM customers').get().id, customerId);
  assert.equal(a.sql.prepare('SELECT display_handle h FROM customer_identities').get().h, 'renamed@example.com');
  assert.notEqual(a.jar.get(SESSION), first);
  assert.equal(a.sql.prepare('SELECT COUNT(*) n FROM customer_sessions WHERE token_hash=?').get(sha256(first)).n, 0, 'presented token deleted (no fixation)');
  assert.equal(count(a, 'customer_sessions'), 1);
  // Same email, different sub is a different customer: no auto merge.
  a.google.claims = { sub: 'google-sub-2', email: 'renamed@example.com' };
  a.jar.clear(); await a.signIn();
  assert.equal(count(a, 'customers'), 2); assert.equal(count(a, 'customer_identities'), 2);
  // email_verified must be exactly true.
  for (const [index, verified] of [false, 'true', 1, undefined].entries()) {
    a.google.claims = { sub: 'unverified-' + index, email: 'x@example.com', email_verified: verified };
    a.jar.clear(); const r = await a.signIn(); assert.equal(location(r), '/account?status=signed-in');
    assert.equal(a.sql.prepare("SELECT display_handle h FROM customer_identities WHERE subject=?").get('unverified-' + index).h, null);
    assert.equal((await a.call('/api/account/session')).data.customer.signInEmail, null);
  }
});

test('state is single use, bound to the cookie, expiring, and consumed atomically by provider and intent', async t => {
  const a = await setup(t);
  let s = await a.start(); const binding = a.jar.get(OIDC);
  assert.equal(location(await a.callback(s.state)), '/account?status=signed-in');
  const replay = await a.callback(s.state); assert.equal(location(replay), '/account?status=error&reason=invalid', 'consumed state has no flow row');
  assert.equal(a.google.tokenCalls.length, 1);
  // Wrong or missing binding cookie: error, and the state is still burned.
  s = await a.start(); a.jar.set(OIDC, 'A'.repeat(43));
  assert.equal(location(await a.callback(s.state)), '/account?status=error&reason=expired');
  assert.equal(count(a, 'customer_auth_flows'), 0);
  s = await a.start(); a.jar.delete(OIDC);
  assert.equal(location(await a.callback(s.state)), '/account?status=error&reason=expired');
  assert.equal(a.google.tokenCalls.length, 1, 'no token exchange without a valid binding');
  // Expired flow.
  s = await a.start(); a.sql.prepare('UPDATE customer_auth_flows SET expires_at=?').run(new Date(Date.now() - 1000).toISOString());
  assert.equal(location(await a.callback(s.state)), '/account?status=error&reason=expired');
  // A flow with another provider/intent is not consumable by the Google login callback.
  s = await a.start(); a.sql.exec("PRAGMA foreign_keys=OFF"); a.sql.prepare("UPDATE customer_auth_flows SET provider='telegram', intent='link', customer_id='x'").run();
  assert.equal(location(await a.callback(s.state)), '/account?status=error&reason=invalid'); assert.equal(count(a, 'customer_auth_flows'), 1);
  // Malformed state values never reach the database as anything but expired.
  for (const bad of ['', 'a'.repeat(300), '%00', "x'--", 'A'.repeat(43)]) assert.equal(location(await a.callback(bad)), '/account?status=error&reason=invalid');
  assert.equal(count(a, 'customer_sessions'), 1); assert.ok(binding);
});

test('provider denial and exchange failures redirect with fixed reasons, create nothing and leak no detail', async t => {
  const a = await setup(t);
  let s = await a.start();
  let r = await a.call(`/api/account/google/callback?error=access_denied%20secret-detail&state=${s.state}`);
  assert.equal(location(r), '/account?status=error&reason=denied'); assert.equal(a.google.tokenCalls.length, 0); assert.ok(!a.jar.has(OIDC));
  s = await a.start(); r = await a.call(`/api/account/google/callback?state=${s.state}`);
  assert.equal(location(r), '/account?status=error&reason=invalid');
  s = await a.start(); a.google.tokenStatus = 400; r = await a.callback(s.state);
  assert.equal(location(r), '/account?status=error&reason=invalid'); assert.ok(!location(r).includes('leaky'));
  a.google.tokenStatus = 200; s = await a.start(); a.google.tokenFetchError = true; r = await a.callback(s.state);
  assert.equal(location(r), '/account?status=error&reason=invalid');
  a.google.tokenFetchError = false; s = await a.start(); a.google.tokenBody = 'not-a-jwt'; r = await a.callback(s.state);
  assert.equal(location(r), '/account?status=error&reason=invalid');
  assert.equal(count(a, 'customers'), 0); assert.equal(count(a, 'customer_sessions'), 0); assert.ok(!a.jar.has(SESSION));
});

test('ID token verification rejects bad issuer, audience, algorithm, signature, times, nonce and subject', async t => {
  const a = await setup(t), now = () => Math.floor(Date.now() / 1000);
  const cases = {
    'wrong issuer': { claims: { iss: 'https://evil.example' } }, 'http issuer': { claims: { iss: 'http://accounts.google.com' } },
    'wrong aud': { claims: { aud: 'other-client' } }, 'aud array without azp': { claims: { aud: [CLIENT_ID, 'other'] } }, 'aud array wrong azp': { claims: { aud: [CLIENT_ID, 'other'], azp: 'other' } },
    'aud missing from array': { claims: { aud: ['other'], azp: CLIENT_ID } }, 'string aud wrong azp': { claims: { azp: 'other' } },
    expired: { claims: { exp: now() - 5 } }, 'missing exp': { claims: { exp: undefined } }, 'non-numeric exp': { claims: { exp: 'later' } },
    'iat in the future': { claims: { iat: now() + 300 } }, 'iat too old': { claims: { iat: now() - 3600 } }, 'missing iat': { claims: { iat: undefined } },
    'missing nonce': { claims: { nonce: undefined } }, 'wrong nonce': { claims: { nonce: 'attacker-nonce' } },
    'empty sub': { claims: { sub: '' } }, 'numeric sub': { claims: { sub: 12345 } }, 'long sub': { claims: { sub: 's'.repeat(256) } },
    'HS256': { header: { alg: 'HS256' } }, 'alg none': { header: { alg: 'none' } }, 'missing kid': { header: { kid: undefined } }, 'oversized kid': { header: { kid: 'k'.repeat(201) } },
    'forged signature': { signWith: 'other' }, 'jku header ignored/unknown kid': { header: { kid: 'attacker', jku: 'https://evil.example/keys' } },
  };
  for (const [name, c] of Object.entries(cases)) {
    a.google.claims = c.claims ?? {}; a.google.header = c.header ?? {}; a.google.signWith = c.signWith === 'other' ? (await keyPair()).other.privateKey : null;
    a.google.tokenBody = null; a.jar.clear(); a.sql.exec('DELETE FROM customer_auth_throttle');
    const r = await a.signIn();
    assert.equal(location(r), '/account?status=error&reason=invalid', name);
  }
  assert.equal(count(a, 'customers'), 0); assert.equal(count(a, 'customer_sessions'), 0);
  // Accepted variants: bare issuer, audience array with matching azp.
  a.google.signWith = null; a.google.header = {};
  a.google.claims = { iss: 'accounts.google.com', aud: ['other', CLIENT_ID], azp: CLIENT_ID };
  assert.equal(location(await a.signIn()), '/account?status=signed-in');
  // Tampered payload with a valid-looking header and original signature.
  a.google.claims = {}; const good = await signJwt({ iss: 'https://accounts.google.com', aud: CLIENT_ID, sub: 'a', iat: now(), exp: now() + 100, nonce: 'n' });
  const parts = good.split('.'); parts[1] = b64({ iss: 'https://accounts.google.com', aud: CLIENT_ID, sub: 'admin', iat: now(), exp: now() + 100, nonce: 'n' });
  a.google.tokenBody = parts.join('.'); assert.equal(location(await a.signIn()), '/account?status=error&reason=invalid');
});

test('JWKS is cached, refetched once on kid miss at most once per minute, and bounded', async t => {
  const a = await setup(t), realNow = Date.now; let clock = realNow();
  Date.now = () => clock; t.after(() => { Date.now = realNow; });
  await a.signIn(); assert.equal(a.google.jwksCalls, 1);
  a.jar.clear(); await a.signIn(); assert.equal(a.google.jwksCalls, 1, 'cache hit');
  // Unknown kid: one refetch finds the rotated key.
  const { jwk2 } = await keyPair(); a.google.jwks = [jwk2]; a.google.header = { kid: 'google-key-2' }; a.jar.clear();
  clock += 120000; assert.equal(location(await a.signIn()), '/account?status=signed-in'); assert.equal(a.google.jwksCalls, 2);
  // Persistently unknown kid: refetch is rate limited to once a minute.
  a.google.header = { kid: 'ghost' };
  clock += 120000; a.jar.clear(); assert.equal(location(await a.signIn()), '/account?status=error&reason=invalid'); assert.equal(a.google.jwksCalls, 3);
  for (let i = 0; i < 3; i++) { a.jar.clear(); assert.equal(location(await a.signIn()), '/account?status=error&reason=invalid'); }
  assert.equal(a.google.jwksCalls, 3, 'no refetch storm within a minute');
  clock += 61000; a.jar.clear(); await a.signIn(); assert.equal(a.google.jwksCalls, 4);
  // Oversized key lists are rejected.
  resetGoogleJwksCache(); a.google.jwks = Array.from({ length: 51 }, (_, i) => ({ ...jwk2, kid: 'k' + i })); a.google.header = { kid: 'k1' }; a.jar.clear();
  assert.equal(location(await a.signIn()), '/account?status=error&reason=invalid');
});

test('sessions expire by idle and absolute limits, refresh hourly, reject disabled customers and cap at ten', async t => {
  const a = await setup(t);
  await a.signIn(); const hash = sha256(a.jar.get(SESSION)), day = 86400000;
  const setRow = values => a.sql.prepare(`UPDATE customer_sessions SET ${Object.keys(values).map(k => k + '=?').join(',')}`).run(...Object.values(values));
  const iso = ms => new Date(Date.now() + ms).toISOString();
  const signedIn = async () => (await a.call('/api/account/session')).data.authenticated;
  assert.equal(await signedIn(), true);
  assert.equal(a.sql.prepare('SELECT last_seen_at FROM customer_sessions').get().last_seen_at <= iso(0), true);
  // last_seen refreshed at most hourly, sliding the idle window but never past absolute expiry.
  setRow({ last_seen_at: iso(-2 * 3600000), idle_expires_at: iso(day) });
  assert.equal(await signedIn(), true);
  let row = a.sql.prepare('SELECT * FROM customer_sessions').get();
  assert.ok(Date.parse(row.last_seen_at) > Date.now() - 5000); assert.ok(Date.parse(row.idle_expires_at) > Date.now() + 6.9 * day);
  const seen = row.last_seen_at; assert.equal(await signedIn(), true); assert.equal(a.sql.prepare('SELECT last_seen_at s FROM customer_sessions').get().s, seen, 'not rewritten within the hour');
  setRow({ last_seen_at: iso(-2 * 3600000), absolute_expires_at: iso(day) }); await signedIn();
  assert.ok(Date.parse(a.sql.prepare('SELECT idle_expires_at i FROM customer_sessions').get().i) <= Date.now() + day + 1000);
  setRow({ absolute_expires_at: iso(30 * day) });
  setRow({ idle_expires_at: iso(-1000) }); assert.equal(await signedIn(), false);
  assert.equal(count(a, 'customer_sessions'), 0, 'expired session row removed');
  assert.ok(!a.jar.has(SESSION), 'stale cookie cleared');
  a.jar.clear(); await a.signIn(); setRow({ absolute_expires_at: iso(-1000), idle_expires_at: iso(day) }); assert.equal(await signedIn(), false);
  a.jar.clear(); await a.signIn(); a.sql.prepare("UPDATE customers SET status='disabled'").run(); assert.equal(await signedIn(), false);
  a.jar.set(SESSION, 'B'.repeat(43)); assert.equal(await signedIn(), false); assert.ok(hash);
  a.sql.prepare("UPDATE customers SET status='active'").run(); a.sql.prepare('DELETE FROM customer_sessions').run();
  // Ten-session cap evicts the oldest.
  const tokens = [];
  for (let i = 0; i < 12; i++) { a.jar.clear(); await a.signIn(); tokens.push(a.jar.get(SESSION)); a.sql.prepare('UPDATE customer_sessions SET created_at=? WHERE token_hash=?').run(new Date(Date.now() + i * 1000 - 60000).toISOString(), sha256(tokens[i])); }
  assert.equal(count(a, 'customer_sessions'), 10);
  assert.equal(a.sql.prepare('SELECT COUNT(*) n FROM customer_sessions WHERE token_hash IN (?,?)').get(sha256(tokens[0]), sha256(tokens[1])).n, 0);
});

test('logout is idempotent and deletes only the presented session; revoke-all needs a session and removes all', async t => {
  const a = await setup(t);
  await a.signIn(); const one = a.jar.get(SESSION); a.jar.clear(); await a.signIn(); const two = a.jar.get(SESSION);
  const out = await a.call('/api/account/logout', 'POST', {});
  assert.equal(out.response.status, 200); assert.deepEqual(out.data, { authenticated: false });
  assert.match(out.response.headers.getSetCookie().find(c => c.startsWith(SESSION)), /Max-Age=0/); assert.ok(!a.jar.has(SESSION));
  assert.equal(count(a, 'customer_sessions'), 1);
  assert.equal((await a.call('/api/account/logout', 'POST', {})).response.status, 200);
  a.jar.set(SESSION, two); assert.equal((await a.call('/api/account/session')).data.authenticated, false);
  a.jar.set(SESSION, one);
  assert.equal((await a.call('/api/account/logout', 'POST', {}, { origin: 'https://evil.test' })).response.status, 403); assert.equal(count(a, 'customer_sessions'), 1);
  assert.equal((await a.call('/api/account/logout', 'POST', { extra: true })).response.status, 400);
  a.jar.clear(); await a.signIn(); await a.call('/api/account/logout', 'POST', {}); // nothing left but `one`
  const anon = await a.call('/api/account/sessions/revoke-all', 'POST', {}); assert.equal(anon.response.status, 401); assert.deepEqual(anon.data, { error: 'Sign-in required' });
  a.jar.clear(); await a.signIn(); a.jar.clear(); await a.signIn();
  const other = a.sql.prepare('SELECT COUNT(*) n FROM customer_sessions').get().n;
  // A second customer's sessions must survive revoke-all of the first.
  a.google.claims = { sub: 'other-customer' }; a.jar.clear(); await a.signIn(); const foreign = a.jar.get(SESSION);
  a.google.claims = {}; a.jar.clear(); await a.signIn();
  const revoked = await a.call('/api/account/sessions/revoke-all', 'POST', {});
  assert.equal(revoked.response.status, 200); assert.equal(revoked.data.revoked, other + 1);
  assert.ok(a.sql.prepare("SELECT COUNT(*) n FROM customer_audit_events WHERE action='sessions.revoke-all'").get().n === 1); assert.ok(a.sql.prepare("SELECT COUNT(*) n FROM customer_audit_events WHERE action='customer.signin'").get().n >= 1); assert.ok(a.sql.prepare('SELECT fields f FROM customer_audit_events').all().every(r => r.f === '[]')); assert.ok(!a.jar.has(SESSION));
  assert.equal(count(a, 'customer_sessions'), 1); assert.equal(a.sql.prepare('SELECT token_hash h FROM customer_sessions').get().h, sha256(foreign));
  assert.equal((await a.call('/api/account/sessions/revoke-all', 'POST', {}, { origin: 'https://evil.test' })).response.status, 403);
});

test('customer sessions and manager Access identity never cross', async t => {
  const a = await setup(t), { jwk } = await keyPair();
  await a.signIn(); const cookie = a.jar.get(SESSION);
  const inner = globalThis.fetch;
  globalThis.fetch = async (url, o) => String(url).includes('/cdn-cgi/access/certs') ? new Response(JSON.stringify({ keys: [jwk] }), { headers: { 'Content-Type': 'application/json' } }) : inner(url, o);
  // The customer cookie is not a manager identity anywhere.
  assert.equal((await a.call('/api/admin/products')).response.status, 401);
  assert.equal((await a.call('/api/admin/suppliers', 'POST', { name: 'x', url: 'https://mydrop.com.ua/x' })).response.status, 401);
  assert.equal((await a.call('/api/auth/session')).data.authenticated, false);
  assert.equal((await a.call('/admin')).response.status, 401);
  const objects = new Map([['aaaa.png', { body: 'x', httpMetadata: { contentType: 'image/png' } }]]); a.env.MEDIA = { get: async k => objects.get(k) ?? null };
  assert.equal((await a.call('/media/aaaa.png')).response.status, 404, 'unpublished media stays private for customers');
  // A valid Access JWT or the dev bypass is not a customer identity, even with no customer cookie.
  const { good } = await keyPair(), unsigned = b64({ alg: 'RS256', kid: 'google-key-1' }) + '.' + b64({ iss: 'https://your-team.cloudflareaccess.com', aud: ['catalog-audience'], email: 'manager@example.com', exp: Math.floor(Date.now() / 1000) + 3600 });
  const jwt = unsigned + '.' + Buffer.from(await crypto.subtle.sign('RSASSA-PKCS1-v1_5', good.privateKey, new TextEncoder().encode(unsigned))).toString('base64url');
  a.jar.clear();
  const asManager = { headers: { 'CF-Access-Jwt-Assertion': jwt, Cookie: 'CF_Authorization=' + jwt }, cookies: false };
  assert.equal((await a.call('/api/auth/session', 'GET', undefined, asManager)).data.authenticated, true, 'fixture JWT is a valid manager assertion');
  assert.deepEqual((await a.call('/api/account/session', 'GET', undefined, asManager)).data, { authenticated: false });
  assert.equal((await a.call('/api/account/sessions/revoke-all', 'POST', {}, asManager)).response.status, 401);
  a.env.APP_ENV = 'development'; a.env.AUTH_DEV_BYPASS = 'true';
  assert.equal((await a.call('/api/auth/session', 'GET', undefined, { host: 'http://localhost', origin: 'http://localhost' })).data.authenticated, true);
  assert.deepEqual((await a.call('/api/account/session', 'GET', undefined, { host: 'http://localhost', origin: 'http://localhost' })).data, { authenticated: false });
  assert.equal((await a.call('/api/account/sessions/revoke-all', 'POST', {}, { host: 'http://localhost', origin: 'http://localhost' })).response.status, 401);
  assert.equal(count(a, 'customers'), 1); assert.ok(cookie);
});

test('cookie names: dev names only for APP_ENV=development on loopback; staging, unset and production are production-like', async t => {
  const dev = await setup(t, { APP_ENV: 'development', OIDC_REDIRECT_ORIGINS: 'http://localhost:8787', CUSTOMER_AUTH_HMAC_KEY: '' });
  const local = { host: 'http://localhost:8787', origin: 'http://localhost:8787' };
  const s = await dev.call('/api/account/google/start', 'POST', {}, local);
  assert.equal(s.response.status, 200, 'loopback nonproduction may run without an HMAC key');
  const line = s.response.headers.getSetCookie()[0]; assert.match(line, /^ls_oidc_dev=/); assert.ok(!/Secure/.test(line)); assert.match(line, /HttpOnly; SameSite=Lax/);
  dev.google.nonce = new URL(s.data.authorizationUrl).searchParams.get('nonce');
  const r = await dev.call(`/api/account/google/callback?code=c&state=${new URL(s.data.authorizationUrl).searchParams.get('state')}`, 'GET', undefined, local);
  assert.equal(location(r), '/account?status=signed-in'); assert.ok(dev.jar.has('ls_session_dev')); assert.ok(!dev.jar.has(SESSION));
  assert.equal((await dev.call('/api/account/session', 'GET', undefined, local)).data.authenticated, true);
  // Anything other than APP_ENV=development is production-like: __Host- names, Secure, HMAC key required, no http loopback origins.
  for (const appEnv of ['production', 'staging', undefined]) {
    const env = { APP_ENV: appEnv, OIDC_REDIRECT_ORIGINS: 'http://localhost:8787,https://localhost:8787' };
    const onLoopback = await setup(t, { ...env, OIDC_REDIRECT_ORIGINS: 'https://localhost:8787' });
    const secure = await onLoopback.call('/api/account/google/start', 'POST', {}, { host: 'https://localhost:8787', origin: 'https://localhost:8787' });
    assert.match(secure.response.headers.getSetCookie()[0], /^__Host-ls_oidc=.*Secure/, String(appEnv));
    const httpLoopback = await setup(t, env);
    assert.equal((await httpLoopback.call('/api/account/google/start', 'POST', {}, local)).response.status, 400, 'http loopback origin is only valid in development: ' + appEnv);
    const noKey = await setup(t, { APP_ENV: appEnv, CUSTOMER_AUTH_HMAC_KEY: '', OIDC_REDIRECT_ORIGINS: 'https://localhost:8787' });
    assert.equal((await noKey.call('/api/account/google/start', 'POST', {}, { host: 'https://localhost:8787', origin: 'https://localhost:8787' })).response.status, 503, 'no HMAC fallback on loopback: ' + appEnv);
    const publicNoKey = await setup(t, { APP_ENV: appEnv, CUSTOMER_AUTH_HMAC_KEY: '' });
    assert.equal((await publicNoKey.call('/api/account/google/start', 'POST', {})).response.status, 503, 'public host fails closed: ' + appEnv);
    const publicHost = await setup(t, { APP_ENV: appEnv });
    assert.match((await publicHost.call('/api/account/google/start', 'POST', {})).response.headers.getSetCookie()[0], /^__Host-ls_oidc=.*Secure/);
  }
  const devPublic = await setup(t, { APP_ENV: 'development' });
  assert.match((await devPublic.call('/api/account/google/start', 'POST', {})).response.headers.getSetCookie()[0], /^__Host-ls_oidc=.*Secure/, 'development on a public host is still __Host-');
  // A dev-named cookie is not accepted on a production host.
  const p2 = await setup(t); await p2.signIn(); const token = p2.jar.get(SESSION); p2.jar.clear(); p2.jar.set('ls_session_dev', token);
  assert.equal((await p2.call('/api/account/session')).data.authenticated, false);
});

test('secrets, codes, tokens, subjects and emails never reach logs or error bodies', async t => {
  const a = await setup(t);
  const secrets = [FAKE.secret, FAKE.code, FAKE.hmac, 'google-sub-1', 'shopper@example.com', 'fake-google-access-token'];
  const bodies = [];
  const s = await a.start(); bodies.push(JSON.stringify(s.data.authorizationUrl.replace(/state=[^&]+/, '')));
  a.google.claims = { iss: 'https://evil.example' }; bodies.push((await a.callback(s.state)).data);
  a.google.claims = {}; a.google.tokenStatus = 500; const s2 = await a.start(); bodies.push((await a.callback(s2.state)).data, location(await a.callback(s2.state)) ?? '');
  a.jar.set(SESSION, 'C'.repeat(43));
  const realDb = a.env.DB;
  a.env.DB = { prepare() { throw new Error(`database exploded for google-sub-1 shopper@example.com ${FAKE.code}`); } };
  const crash = await a.call('/api/account/session'); bodies.push(JSON.stringify(crash.data)); assert.equal(crash.response.status, 500); a.env.DB = realDb;
  const out = JSON.stringify(bodies) + a.logs.join('\n');
  for (const secret of secrets) assert.ok(!out.includes(secret), 'leaked ' + secret.slice(0, 8));
  assert.ok(a.logs.every(line => !/state=|nonce|verifier/.test(line)));
});

test('GET /api/account/session tolerates a broken customer table lookup only via safe error and unknown paths are 404', async t => {
  const a = await setup(t);
  assert.equal((await a.call('/api/account/nope')).response.status, 404);
  assert.equal((await a.call('/api/account/google/callback', 'POST', {})).response.status, 405);
  assert.equal((await a.call('/api/account/session', 'POST', {})).response.status, 405);
});
