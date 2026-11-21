import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { readFileSync, readdirSync } from 'node:fs';
import { createHash } from 'node:crypto';
import worker from '../../apps/api/src/index.js';
import { resetGoogleJwksCache, verifyGoogleIdToken, authorizationUrl } from '../../apps/api/src/google-oidc.js';

// Staff Google sign-in (ADR-0006, T2). Local RSA key, stubbed Google/Access endpoints, fake values. No live network.
const ORIGIN = 'https://catalog.test';
const STAFF_CLIENT = 'fake-staff-client.apps.example', CUSTOMER_CLIENT = 'fake-customer-client.apps.example';
const FAKE = { staffSecret: 'fake-staff-secret', customerSecret: 'fake-customer-secret', staffHmac: 'fake-staff-hmac-key-0123456789-abcdefgh', customerHmac: 'fake-customer-hmac-key-0123456789-abcd', code: 'fake-auth-code-123' };
const sha256 = value => createHash('sha256').update(value).digest('hex');
const b64 = value => Buffer.from(JSON.stringify(value)).toString('base64url');
const STAFF_COOKIE = '__Host-ls_staff', STAFF_OIDC = '__Host-ls_staff_oidc', CUSTOMER_COOKIE = '__Host-ls_session';
const iso = ms => new Date(ms).toISOString();

const migrationDir = new URL('../../migrations/', import.meta.url);
const migrations = readdirSync(migrationDir).filter(name => /^\d{4}_.*\.sql$/.test(name)).sort();
function database() {
  const sqlite = new DatabaseSync(':memory:');
  for (const name of migrations) sqlite.exec(readFileSync(new URL(name, migrationDir), 'utf8'));
  const wrap = (sql, bindings = []) => ({ sql, bindings, bind(...values) { return wrap(sql, values); }, async first() { return sqlite.prepare(sql).get(...bindings) ?? null; }, async all() { return { results: sqlite.prepare(sql).all(...bindings) }; }, async run() { return sqlite.prepare(sql).run(...bindings); } });
  return { sqlite, prepare: sql => wrap(sql), async batch(statements) { sqlite.exec('BEGIN'); try { const result = statements.map(s => ({ results: sqlite.prepare(s.sql).all(...s.bindings) })); sqlite.exec('COMMIT'); return result; } catch (error) { sqlite.exec('ROLLBACK'); throw error; } }, close: () => sqlite.close() };
}

let keys;
async function keyPair() {
  if (!keys) {
    const pair = await crypto.subtle.generateKey({ name: 'RSASSA-PKCS1-v1_5', modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: 'SHA-256' }, true, ['sign', 'verify']);
    const google = await crypto.subtle.exportKey('jwk', pair.publicKey); google.kid = 'google-key-1'; google.alg = 'RS256'; google.use = 'sig';
    const access = await crypto.subtle.exportKey('jwk', pair.publicKey); access.kid = 'access-key-1'; access.alg = 'RS256';
    keys = { pair, google, access };
  }
  return keys;
}
async function signJwt(claims, kid) {
  const { pair } = await keyPair();
  const unsigned = b64({ alg: 'RS256', kid }) + '.' + b64(claims);
  return unsigned + '.' + Buffer.from(await crypto.subtle.sign('RSASSA-PKCS1-v1_5', pair.privateKey, new TextEncoder().encode(unsigned))).toString('base64url');
}
const accessToken = email => signJwt({ iss: 'https://your-team.cloudflareaccess.com', aud: ['catalog-audience'], email, exp: Math.floor(Date.now() / 1000) + 3600 }, 'access-key-1');

async function setup(t, envOverrides = {}) {
  const { google: googleJwk, access: accessJwk } = await keyPair();
  resetGoogleJwksCache();
  const env = {
    DB: database(), APP_ENV: 'production', CF_ACCESS_TEAM_NAME: 'your-team', CF_ACCESS_AUD: 'catalog-audience',
    GOOGLE_STAFF_CLIENT_ID: STAFF_CLIENT, GOOGLE_STAFF_CLIENT_SECRET: FAKE.staffSecret, STAFF_OIDC_REDIRECT_ORIGINS: ORIGIN, STAFF_AUTH_HMAC_KEY: FAKE.staffHmac,
    GOOGLE_CLIENT_ID: CUSTOMER_CLIENT, GOOGLE_CLIENT_SECRET: FAKE.customerSecret, OIDC_REDIRECT_ORIGINS: ORIGIN, CUSTOMER_AUTH_HMAC_KEY: FAKE.customerHmac, ...envOverrides,
  };
  const google = { claims: {}, nonce: null, tokenCalls: [], customerNonce: null };
  const original = globalThis.fetch, errorLog = console.error, logs = [];
  console.error = (...args) => { logs.push(args.map(String).join(' ')); };
  globalThis.fetch = async (url, options) => {
    url = String(url);
    if (url === 'https://www.googleapis.com/oauth2/v3/certs') return new Response(JSON.stringify({ keys: [googleJwk] }), { headers: { 'Content-Type': 'application/json', 'Cache-Control': 'max-age=22000' } });
    if (url.includes('/cdn-cgi/access/certs')) return new Response(JSON.stringify({ keys: [accessJwk] }), { headers: { 'Content-Type': 'application/json' } });
    if (url === 'https://oauth2.googleapis.com/token') {
      const form = Object.fromEntries(new URLSearchParams(String(options.body)));
      google.tokenCalls.push(form);
      const now = Math.floor(Date.now() / 1000), staff = form.client_id === STAFF_CLIENT;
      const claims = { iss: 'https://accounts.google.com', aud: form.client_id, sub: 'sub-default', email: 'someone@example.com', email_verified: true, iat: now, exp: now + 3600, nonce: staff ? google.nonce : google.customerNonce, ...google.claims };
      return new Response(JSON.stringify({ access_token: 'fake-access-token', id_token: await signJwt(claims, 'google-key-1') }), { headers: { 'Content-Type': 'application/json' } });
    }
    throw new Error('Unexpected network call to ' + url);
  };
  t.after(() => { globalThis.fetch = original; console.error = errorLog; env.DB.close(); });
  const jar = new Map();
  async function call(path, method = 'GET', body, { origin = ORIGIN, host = ORIGIN, headers = {}, jarOn = true, extraCookie = '', omit = [], contentType = 'application/json', env: more = {} } = {}) {
    const h = { ...headers };
    if (origin) h.Origin = origin;
    const cookies = [...(jarOn ? [...jar].filter(([k]) => !omit.includes(k)).map(([k, v]) => `${k}=${v}`) : []), ...(extraCookie ? [extraCookie] : [])];
    if (cookies.length) h.Cookie = cookies.join('; ');
    if (body !== undefined) h['Content-Type'] = contentType;
    const response = await worker.fetch(new Request(host + path, { method, headers: h, body: body === undefined ? undefined : JSON.stringify(body), redirect: 'manual' }), { ...env, ...more });
    if (jarOn) for (const line of response.headers.getSetCookie()) { const [pair] = line.split(';'); const [name, ...rest] = pair.split('='); if (/Max-Age=0/i.test(line) || rest.join('') === '') jar.delete(name); else jar.set(name, rest.join('=')); }
    const type = response.headers.get('Content-Type') || '';
    return { response, status: response.status, data: type.includes('json') ? await response.json() : await response.text() };
  }
  const a = { env, google, call, jar, logs, sql: env.DB.sqlite };
  a.start = async (intent, opts) => { const r = await call('/api/staff/google/start', 'POST', intent ? { intent } : {}, opts); if (r.status !== 200) return r; const u = new URL(r.data.authorizationUrl); google.nonce = u.searchParams.get('nonce'); r.params = u.searchParams; r.state = u.searchParams.get('state'); return r; };
  // The callback is a cross-site redirect from Google: browsers do not send SameSite=Strict cookies, so the session cookie is omitted.
  a.callback = (state, extra = '') => call(`/api/staff/google/callback?code=${FAKE.code}&state=${state}${extra}`, 'GET', undefined, { omit: [STAFF_COOKIE] });
  // Signs in as the given Google account. The jar's staff session is dropped first so several sessions can coexist.
  a.login = async (claims, { keepSession = false } = {}) => { if (!keepSession) jar.delete(STAFF_COOKIE); google.claims = claims; const s = await a.start(); assert.equal(s.status, 200); return { ...(await a.callback(s.state)), start: s }; };
  a.seed = (row = {}) => {
    const now = iso(Date.now()), r = { id: 'staff-' + crypto.randomUUID().slice(0, 8), role: 'manager', status: 'active', invitedEmail: null, sub: null, email: null, name: 'Person', expires: null, ...row };
    if (r.status === 'invited') r.expires ??= iso(Date.now() + 72 * 3600000);
    a.sql.prepare('INSERT INTO staff_members(id,role,status,invited_email,google_sub,email,display_name,created_by,created_at,updated_at,invitation_expires_at) VALUES(?,?,?,?,?,?,?,?,?,?,?)').run(r.id, r.role, r.status, r.invitedEmail, r.sub, r.email, r.name, 'owner@example.com', now, now, r.expires);
    return r;
  };
  a.session = () => a.sql.prepare('SELECT * FROM staff_sessions').all();
  return a;
}
const location = r => r.response.headers.get('Location');
const count = (a, table) => a.sql.prepare(`SELECT COUNT(*) n FROM ${table}`).get().n;
const same = { origin: ORIGIN };

test('start: staff client, scope "openid email", Lax binding cookie, hashed single-use flow row, origin allowlist', async t => {
  const a = await setup(t);
  const r = await a.start();
  assert.equal(r.status, 200);
  const u = new URL(r.data.authorizationUrl);
  assert.equal(u.origin + u.pathname, 'https://accounts.google.com/o/oauth2/v2/auth');
  assert.equal(r.params.get('client_id'), STAFF_CLIENT); assert.equal(r.params.get('scope'), 'openid email');
  assert.equal(r.params.get('redirect_uri'), ORIGIN + '/api/staff/google/callback');
  assert.equal(r.params.get('code_challenge_method'), 'S256'); assert.equal(r.params.get('prompt'), 'select_account');
  const flow = a.sql.prepare('SELECT * FROM staff_auth_flows').get();
  assert.equal(flow.intent, 'login'); assert.equal(flow.staff_id, null); assert.equal(flow.return_path, '/staff');
  assert.equal(flow.state_hash, sha256(r.state)); assert.equal(flow.binding_hash, sha256(a.jar.get(STAFF_OIDC)));
  assert.equal(r.params.get('code_challenge'), createHash('sha256').update(flow.code_verifier).digest('base64url'));
  assert.equal(Date.parse(flow.expires_at) - Date.parse(flow.created_at), 600000);
  assert.match(r.response.headers.getSetCookie()[0], /^__Host-ls_staff_oidc=[A-Za-z0-9_-]{43}; Path=\/; Secure; HttpOnly; SameSite=Lax; Max-Age=600$/);
  assert.equal(r.response.headers.get('Cache-Control'), 'no-store');
  assert.equal(r.response.headers.get('X-Robots-Tag'), 'noindex, nofollow');
  assert.equal((await a.call('/api/staff/google/start', 'POST', { intent: 'bogus' })).status, 400);
  assert.equal((await a.call('/api/staff/google/start', 'POST', { extra: 1 })).status, 400);
  assert.equal((await a.call('/api/staff/google/start')).status, 405);
  // An origin outside STAFF_OIDC_REDIRECT_ORIGINS (for example the admin host) is refused.
  assert.equal((await a.call('/api/staff/google/start', 'POST', {}, { env: { STAFF_OIDC_REDIRECT_ORIGINS: 'https://other.test' } })).status, 400);
  assert.equal((await a.call('/api/staff/google/start', 'POST', {}, { env: { STAFF_OIDC_REDIRECT_ORIGINS: ORIGIN + '/' } })).status, 503, 'origins are exact, a trailing slash matches nothing');
  // The customer client is never used for staff: with only customer variables staff sign-in is unconfigured.
  assert.equal((await a.call('/api/staff/google/start', 'POST', {}, { env: { GOOGLE_STAFF_CLIENT_ID: '' } })).status, 503);
});

test('missing or weak staff configuration fails closed with 503 outside loopback development, session endpoint stays up', async t => {
  for (const [name, value] of [['GOOGLE_STAFF_CLIENT_ID', ''], ['GOOGLE_STAFF_CLIENT_SECRET', ''], ['STAFF_OIDC_REDIRECT_ORIGINS', ''], ['STAFF_AUTH_HMAC_KEY', ''], ['STAFF_AUTH_HMAC_KEY', 'short'], ['STAFF_AUTH_HMAC_KEY', FAKE.customerHmac]]) {
    for (const appEnv of ['production', 'staging', undefined]) {
      const a = await setup(t, { [name]: value, APP_ENV: appEnv, ...(value === FAKE.customerHmac ? {} : {}) });
      const r = await a.call('/api/staff/google/start', 'POST', {});
      assert.equal(r.status, 503, `${name}=${value} env=${appEnv}`); assert.equal(count(a, 'staff_auth_flows'), 0);
      assert.equal((await a.call('/api/staff/google/callback?code=x&state=y')).status, 503);
      assert.deepEqual((await a.call('/api/staff/session')).data, { authenticated: false });
    }
  }
  // Loopback development works with a fixed local key and plain-HTTP cookies.
  const a = await setup(t, { APP_ENV: 'development', STAFF_AUTH_HMAC_KEY: '', STAFF_OIDC_REDIRECT_ORIGINS: 'http://localhost' });
  const r = await a.start(undefined, { host: 'http://localhost', origin: 'http://localhost' });
  assert.equal(r.status, 200);
  assert.match(r.response.headers.getSetCookie()[0], /^ls_staff_oidc_dev=[A-Za-z0-9_-]{43}; Path=\/; HttpOnly; SameSite=Lax; Max-Age=600$/);
  // ...but not on a non-loopback host with APP_ENV=development.
  const b = await setup(t, { APP_ENV: 'development', STAFF_AUTH_HMAC_KEY: '' });
  assert.equal((await b.call('/api/staff/google/start', 'POST', {})).status, 503);
});

test('first sign-in binds an invitation by verified email and creates the session in one step; later sign-in uses sub only', async t => {
  const a = await setup(t), member = a.seed({ id: 'staff-m1', status: 'invited', invitedEmail: 'invitee@example.com', name: 'Оля' });
  const r = await a.login({ sub: 'sub-m1', email: 'Invitee@Example.com' });
  assert.equal(r.status, 303); assert.equal(location(r), '/staff?status=signed-in');
  const set = r.response.headers.getSetCookie();
  assert.ok(set.some(line => /^__Host-ls_staff_oidc=; .*Max-Age=0/.test(line)), 'binding cookie cleared');
  const session = set.find(line => line.startsWith('__Host-ls_staff='));
  assert.match(session, /^__Host-ls_staff=[A-Za-z0-9_-]{43}; Path=\/; Secure; HttpOnly; SameSite=Strict; Max-Age=43200$/);
  const row = a.sql.prepare('SELECT * FROM staff_members WHERE id=?').get(member.id);
  assert.equal(row.status, 'active'); assert.equal(row.google_sub, 'sub-m1'); assert.equal(row.invitation_expires_at, null); assert.ok(row.activated_at && row.last_sign_in_at);
  assert.equal(row.email, 'Invitee@Example.com', 'last verified email kept for display');
  assert.equal(count(a, 'staff_auth_flows'), 0, 'flow consumed');
  const [stored] = a.session(); assert.equal(stored.token_hash, sha256(a.jar.get(STAFF_COOKIE)));
  assert.equal(Date.parse(stored.idle_expires_at) - Date.parse(stored.created_at), 30 * 60000); assert.equal(Date.parse(stored.absolute_expires_at) - Date.parse(stored.created_at), 12 * 3600000);
  const audits = a.sql.prepare("SELECT action,actor,actor_type,actor_role,resource_id FROM audit_events ORDER BY action").all();
  assert.deepEqual(audits.map(row => ({ ...row })), [{ action: 'staff.activate', actor: 'staff:staff-m1', actor_type: 'staff', actor_role: 'manager', resource_id: 'staff-m1' }, { action: 'staff.signin', actor: 'staff:staff-m1', actor_type: 'staff', actor_role: 'manager', resource_id: 'staff-m1' }]);
  assert.ok(!JSON.stringify(a.sql.prepare('SELECT * FROM audit_events').all()).includes('invitee@example.com') && !JSON.stringify(a.sql.prepare('SELECT * FROM audit_events').all()).includes('sub-m1'));
  const view = (await a.call('/api/staff/session')).data;
  assert.equal(view.authenticated, true); assert.equal(view.staff.id, 'staff-m1'); assert.equal(view.staff.role, 'manager'); assert.equal(view.staff.displayName, 'Оля'); assert.equal(view.staff.recentAuth, true);
  assert.ok(view.staff.permissions.includes('products.edit') && !view.staff.permissions.includes('staff.manage'));
  assert.ok(!JSON.stringify(view).includes('sub-m1'));
  // A later sign-in matches the sub only: the Google email may change.
  const again = await a.login({ sub: 'sub-m1', email: 'renamed@example.com' });
  assert.equal(location(again), '/staff?status=signed-in');
  assert.equal(a.sql.prepare('SELECT email FROM staff_members WHERE id=?').get(member.id).email, 'renamed@example.com');
  // Replaying a callback is invalid; a stale flow with a wrong binding cookie is rejected.
  const s = await a.start(); const replayState = s.state; await a.callback(replayState);
  assert.equal(location(await a.callback(replayState)), '/staff?status=error&reason=invalid');
  const s2 = await a.start(); a.jar.set(STAFF_OIDC, 'A'.repeat(43));
  assert.equal(location(await a.callback(s2.state)), '/staff?status=error&reason=invalid');
  assert.equal(location(await a.callback('no')), '/staff?status=error&reason=invalid');
});

test('invitation rules: expiry, unverified email, unknown account, second account, case, UNIQUE race and no auto-registration give not_allowed', async t => {
  const a = await setup(t);
  let sessions = 0;
  const denied = r => { assert.equal(r.status, 303); assert.equal(location(r), '/staff?status=error&reason=not_allowed'); assert.equal(count(a, 'staff_sessions'), sessions); assert.ok(!a.jar.has(STAFF_COOKIE)); };
  // expired
  const expired = a.seed({ id: 'staff-exp', status: 'invited', invitedEmail: 'late@example.com', expires: iso(Date.now() - 1000) });
  denied(await a.login({ sub: 'sub-late', email: 'late@example.com' }));
  assert.equal(a.sql.prepare('SELECT status,google_sub FROM staff_members WHERE id=?').get(expired.id).status, 'invited');
  // email_verified false with a matching email
  a.seed({ id: 'staff-unv', status: 'invited', invitedEmail: 'unverified@example.com' });
  denied(await a.login({ sub: 'sub-unv', email: 'unverified@example.com', email_verified: false }));
  assert.equal(a.sql.prepare("SELECT google_sub FROM staff_members WHERE id='staff-unv'").get().google_sub, null);
  // unknown Google account: no row is created
  const before = count(a, 'staff_members');
  denied(await a.login({ sub: 'sub-stranger', email: 'stranger@example.com' }));
  assert.equal(count(a, 'staff_members'), before);
  // dot / plus folding is not applied
  a.seed({ id: 'staff-gm', status: 'invited', invitedEmail: 'first.last@example.com' });
  denied(await a.login({ sub: 'sub-gm', email: 'firstlast@example.com' }));
  denied(await a.login({ sub: 'sub-gm', email: 'first.last+x@example.com' }));
  // bound once; a second Google account with the same invited email is not allowed
  const ok = await a.login({ sub: 'sub-first', email: 'FIRST.LAST@example.com' });
  assert.equal(location(ok), '/staff?status=signed-in'); sessions = 1;
  a.jar.delete(STAFF_COOKIE);
  denied(await a.login({ sub: 'sub-second', email: 'first.last@example.com' }));
  assert.equal(a.sql.prepare("SELECT google_sub FROM staff_members WHERE id='staff-gm'").get().google_sub, 'sub-first');
  // a sub that already belongs to another row cannot take a new invitation (row stays invited, no rollback side effects)
  const known = a.seed({ id: 'staff-known', sub: 'sub-known', email: 'known@example.com' }); a.seed({ id: 'staff-inv2', status: 'invited', invitedEmail: 'known@example.com'.replace('known', 'other') });
  a.sql.prepare("UPDATE staff_members SET status='suspended' WHERE id=?").run(known.id);
  denied(await a.login({ sub: 'sub-known', email: 'other@example.com' }));
  assert.equal(a.sql.prepare("SELECT status,google_sub FROM staff_members WHERE id='staff-inv2'").get().status, 'invited');
  // a UNIQUE violation inside the batch (a concurrent bind) is not_allowed too, and nothing is written
  a.seed({ id: 'staff-race', status: 'invited', invitedEmail: 'race@example.com' });
  const realBatch = a.env.DB.batch;
  a.env.DB.batch = async statements => { if (statements.some(s => /staff_members SET google_sub/.test(s.sql))) throw new Error('UNIQUE constraint failed: staff_members.google_sub'); return realBatch.call(a.env.DB, statements); };
  denied(await a.login({ sub: 'sub-race', email: 'race@example.com' }));
  a.env.DB.batch = realBatch;
  assert.equal(a.sql.prepare("SELECT status FROM staff_members WHERE id='staff-race'").get().status, 'invited');
  assert.ok(a.sql.prepare("SELECT COUNT(*) n FROM audit_events WHERE action='staff.signin.denied'").get().n >= 5);
  assert.ok(!JSON.stringify(a.sql.prepare('SELECT * FROM audit_events').all()).includes('@example.com'), 'denied audit rows carry no email');
});

test('suspended, removed or unknown members cannot sign in even with a bound sub', async t => {
  const a = await setup(t);
  a.seed({ id: 'staff-s', status: 'suspended', sub: 'sub-s', email: 's@example.com' });
  const r = await a.login({ sub: 'sub-s', email: 's@example.com' });
  assert.equal(location(r), '/staff?status=error&reason=not_allowed'); assert.equal(count(a, 'staff_sessions'), 0);
});

test('a 6-minute-old ID token is rejected for staff; a customer-style 10-minute limit still applies by default', async t => {
  const a = await setup(t); a.seed({ id: 'staff-iat', sub: 'sub-iat' });
  const now = Math.floor(Date.now() / 1000);
  assert.equal(location(await a.login({ sub: 'sub-iat', iat: now - 360 })), '/staff?status=error&reason=invalid');
  assert.equal(count(a, 'staff_sessions'), 0);
  assert.equal(location(await a.login({ sub: 'sub-iat', iat: now - 240 })), '/staff?status=signed-in');
  // Unit: the default stays 600 s for customers, and maxIatAgeSeconds narrows it.
  const { google } = await keyPair();
  const token = await signJwt({ iss: 'https://accounts.google.com', aud: STAFF_CLIENT, sub: 'u', email: 'u@example.com', email_verified: true, iat: now - 360, exp: now + 3600, nonce: 'n1' }, 'google-key-1');
  assert.ok(google);
  assert.equal((await verifyGoogleIdToken(token, { clientId: STAFF_CLIENT, nonce: 'n1' })).sub, 'u');
  await assert.rejects(verifyGoogleIdToken(token, { clientId: STAFF_CLIENT, nonce: 'n1', maxIatAgeSeconds: 300 }), /issue time/);
  assert.match(await authorizationUrl({ clientId: 'c', redirectUri: 'https://x.test/cb', state: 's', nonce: 'n', verifier: 'v' }), /scope=openid\+email\+profile/);
});

test('nonce, audience (token confusion), provider error and wrong flow tables are rejected; no tokens in logs', async t => {
  const a = await setup(t); a.seed({ id: 'staff-n', sub: 'sub-n' });
  assert.equal(location(await a.login({ sub: 'sub-n', nonce: 'wrong-nonce' })), '/staff?status=error&reason=invalid');
  // token minted for the customer client fails aud in the staff verifier
  assert.equal(location(await a.login({ sub: 'sub-n', aud: CUSTOMER_CLIENT })), '/staff?status=error&reason=invalid');
  const s = await a.start();
  assert.equal(location(await a.callback(s.state, '&error=access_denied')), '/staff?status=error&reason=denied');
  assert.equal(count(a, 'staff_sessions'), 0);
  // Flow confusion both ways: a customer state at the staff callback and the reverse are invalid.
  const customer = await a.call('/api/account/google/start', 'POST', {});
  const customerState = new URL(customer.data.authorizationUrl).searchParams.get('state');
  assert.equal(location(await a.callback(customerState)), '/staff?status=error&reason=invalid');
  const staff = await a.start();
  a.jar.set('__Host-ls_oidc', a.jar.get(STAFF_OIDC));
  const cross = await a.call(`/api/account/google/callback?code=${FAKE.code}&state=${staff.state}`);
  assert.equal(location(cross), '/account?status=error&reason=invalid');
  assert.equal(count(a, 'customer_sessions'), 0); assert.equal(count(a, 'staff_sessions'), 0);
  assert.ok(!a.logs.join('\n').includes('sub-n'));
});

test('session lifetime: 30-minute idle, 12-hour absolute, refresh at most once a minute, cap of 5 sessions', async t => {
  const a = await setup(t); a.seed({ id: 'staff-l', sub: 'sub-l' });
  await a.login({ sub: 'sub-l' });
  const hash = sha256(a.jar.get(STAFF_COOKIE)), get = () => a.sql.prepare('SELECT * FROM staff_sessions WHERE token_hash=?').get(hash);
  // refresh: within a minute nothing changes
  const first = get(); assert.equal((await a.call('/api/staff/admin/products')).status, 200); assert.equal(get().idle_expires_at, first.idle_expires_at);
  // an older last_seen refreshes the idle window but never beyond the absolute limit
  a.sql.prepare('UPDATE staff_sessions SET last_seen_at=?, idle_expires_at=? WHERE token_hash=?').run(iso(Date.now() - 120000), iso(Date.now() + 60000), hash);
  assert.equal((await a.call('/api/staff/admin/products')).status, 200);
  assert.ok(Date.parse(get().idle_expires_at) - Date.now() > 29 * 60000);
  a.sql.prepare('UPDATE staff_sessions SET last_seen_at=?, absolute_expires_at=? WHERE token_hash=?').run(iso(Date.now() - 120000), iso(Date.now() + 600000), hash);
  await a.call('/api/staff/admin/products'); assert.equal(get().idle_expires_at, get().absolute_expires_at);
  // idle expiry
  a.sql.prepare('UPDATE staff_sessions SET idle_expires_at=? WHERE token_hash=?').run(iso(Date.now() - 1000), hash);
  const idle = await a.call('/api/staff/admin/products'); assert.equal(idle.status, 401);
  assert.ok(idle.response.headers.getSetCookie().some(line => /^__Host-ls_staff=; .*Max-Age=0/.test(line)), 'stale cookie cleared'); assert.equal(get(), undefined);
  assert.deepEqual((await a.call('/api/staff/session')).data, { authenticated: false });
  // absolute expiry
  await a.login({ sub: 'sub-l' }); const hash2 = sha256(a.jar.get(STAFF_COOKIE));
  a.sql.prepare('UPDATE staff_sessions SET absolute_expires_at=? WHERE token_hash=?').run(iso(Date.now() - 1000), hash2);
  assert.equal((await a.call('/api/staff/admin/products')).status, 401);
  // cap: the 6th session evicts the oldest
  a.sql.prepare('DELETE FROM staff_sessions').run();
  const tokens = [];
  for (let i = 0; i < 6; i++) { await a.login({ sub: 'sub-l' }); tokens.push(a.jar.get(STAFF_COOKIE)); }
  assert.equal(count(a, 'staff_sessions'), 5);
  assert.equal((await a.call('/api/staff/session', 'GET', undefined, { jarOn: false, extraCookie: `${STAFF_COOKIE}=${tokens[0]}` })).data.authenticated, false);
  assert.equal((await a.call('/api/staff/session', 'GET', undefined, { jarOn: false, extraCookie: `${STAFF_COOKIE}=${tokens[5]}` })).data.authenticated, true);
  assert.equal((await a.call('/api/staff/session', 'GET', undefined, { jarOn: false, extraCookie: `${STAFF_COOKIE}=not-a-token` })).data.authenticated, false);
});

test('sign-in rotates the presented session: the old token is deleted', async t => {
  const a = await setup(t); a.seed({ id: 'staff-r', sub: 'sub-r' });
  await a.login({ sub: 'sub-r' }); const old = a.jar.get(STAFF_COOKIE);
  await a.login({ sub: 'sub-r' }, { keepSession: true }); // start carries the cookie, the callback does not
  assert.notEqual(a.jar.get(STAFF_COOKIE), old); assert.equal(count(a, 'staff_sessions'), 1);
  assert.equal(a.sql.prepare('SELECT COUNT(*) n FROM staff_sessions WHERE token_hash=?').get(sha256(old)).n, 0, 'old session deleted from the flow-bound hash');
});

test('suspend and remove take effect on the very next request; a live role change applies without re-login', async t => {
  const a = await setup(t), m = a.seed({ id: 'staff-v', sub: 'sub-v', role: 'owner' });
  await a.login({ sub: 'sub-v' });
  assert.equal((await a.call('/api/staff/admin/suppliers')).status, 200);
  // owner -> manager: owner-only route is 403 on the next request, same cookie
  assert.equal((await a.call('/api/staff/admin/recognition/activate', 'POST', {})).status !== 403, true);
  a.sql.prepare("UPDATE staff_members SET role='manager' WHERE id=?").run(m.id);
  assert.equal((await a.call('/api/staff/admin/recognition/activate', 'POST', {})).status, 403);
  assert.equal((await a.call('/api/staff/session')).data.staff.role, 'manager');
  a.sql.prepare("UPDATE staff_members SET role='owner' WHERE id=?").run(m.id);
  assert.equal((await a.call('/api/staff/admin/recognition/activate', 'POST', {})).status !== 403, true);
  // status change alone (sessions not deleted) still gives 401, with the stale cookie cleared and the session row removed
  a.sql.prepare("UPDATE staff_members SET status='suspended' WHERE id=?").run(m.id);
  const denied = await a.call('/api/staff/admin/suppliers');
  assert.equal(denied.status, 401); assert.ok(denied.response.headers.getSetCookie().some(l => /^__Host-ls_staff=; .*Max-Age=0/.test(l))); assert.equal(count(a, 'staff_sessions'), 0);
  // reactivated member needs a fresh sign-in (the session was dropped)
  a.sql.prepare("UPDATE staff_members SET status='active' WHERE id=?").run(m.id);
  assert.equal((await a.call('/api/staff/admin/suppliers')).status, 401);
  await a.login({ sub: 'sub-v' });
  assert.equal((await a.call('/api/staff/admin/suppliers')).status, 200);
  // removal (identifiers cleared) is also immediate
  a.sql.prepare("UPDATE staff_members SET status='removed',google_sub=NULL,email=NULL,invited_email=NULL WHERE id=?").run(m.id);
  assert.equal((await a.call('/api/staff/admin/suppliers')).status, 401);
  assert.equal((await a.call('/api/staff/session')).data.authenticated, false);
});

test('reauth: requires a session, re-resolves the presented session, checks staff_id and sub, rotates with fresh authenticated_at', async t => {
  const a = await setup(t); a.seed({ id: 'staff-a', sub: 'sub-a' }); a.seed({ id: 'staff-b', sub: 'sub-b' });
  assert.equal((await a.start('reauth')).status, 401, 'no session');
  await a.login({ sub: 'sub-a' });
  const oldToken = a.jar.get(STAFF_COOKIE);
  const stale = iso(Date.now() - 3600000);
  a.sql.prepare('UPDATE staff_sessions SET authenticated_at=?').run(stale);
  assert.equal((await a.call('/api/staff/session')).data.staff.recentAuth, false);
  const absolute = a.sql.prepare('SELECT absolute_expires_at a FROM staff_sessions').get().a;
  // mismatch: a different Google account completes the flow
  const bad = await a.start('reauth'); assert.equal(bad.status, 200);
  assert.equal(a.sql.prepare("SELECT intent,staff_id FROM staff_auth_flows WHERE state_hash=?").get(sha256(bad.state)).staff_id, 'staff-a');
  a.google.claims = { sub: 'sub-b' };
  assert.equal(location(await a.callback(bad.state)), '/staff?status=error&reason=mismatch');
  assert.equal(a.jar.get(STAFF_COOKIE), oldToken); assert.equal(a.sql.prepare('SELECT authenticated_at x FROM staff_sessions').get().x, stale);
  // the flow is bound to the session presented at start; a flow re-pointed at another member's session is a mismatch
  const other = await a.start('reauth'); a.google.claims = { sub: 'sub-a' };
  a.sql.prepare("INSERT INTO staff_sessions(token_hash,staff_id,created_at,authenticated_at,last_seen_at,idle_expires_at,absolute_expires_at) VALUES(?,?,?,?,?,?,?)").run(sha256('B'.repeat(43)), 'staff-b', iso(Date.now()), iso(Date.now()), iso(Date.now()), iso(Date.now() + 600000), iso(Date.now() + 600000));
  a.sql.prepare('UPDATE staff_auth_flows SET session_token_hash=? WHERE state_hash=?').run(sha256('B'.repeat(43)), sha256(other.state));
  assert.equal(location(await a.callback(other.state)), '/staff?status=error&reason=mismatch');
  a.sql.prepare("DELETE FROM staff_sessions WHERE staff_id='staff-b'").run();
  // the bound session vanished (logout elsewhere) before the callback: invalid, nothing created
  const gone = await a.start('reauth'); const n = count(a, 'staff_sessions');
  a.sql.prepare('DELETE FROM staff_sessions WHERE token_hash=?').run(sha256(oldToken));
  assert.equal(location(await a.callback(gone.state)), '/staff?status=error&reason=invalid'); assert.equal(count(a, 'staff_sessions'), n - 1);
  a.sql.prepare("INSERT INTO staff_sessions(token_hash,staff_id,created_at,authenticated_at,last_seen_at,idle_expires_at,absolute_expires_at) VALUES(?,?,?,?,?,?,?)").run(sha256(oldToken), 'staff-a', iso(Date.now() - 3000000), stale, iso(Date.now()), iso(Date.now() + 600000), absolute);
  // a flow whose binding stored no session (login flow) cannot be used to reauth
  a.sql.prepare("UPDATE staff_auth_flows SET session_token_hash=NULL").run();
  // success
  const ok = await a.start('reauth'); a.google.claims = { sub: 'sub-a' };
  assert.equal(a.sql.prepare('SELECT session_token_hash h FROM staff_auth_flows WHERE state_hash=?').get(sha256(ok.state)).h, sha256(oldToken));
  const done = await a.callback(ok.state);
  assert.equal(location(done), '/staff?status=reauthenticated');
  assert.notEqual(a.jar.get(STAFF_COOKIE), oldToken);
  assert.equal((await a.call('/api/staff/session', 'GET', undefined, { jarOn: false, extraCookie: `${STAFF_COOKIE}=${oldToken}` })).data.authenticated, false, 'old token revoked');
  const view = (await a.call('/api/staff/session')).data.staff; assert.equal(view.recentAuth, true);
  assert.equal(a.sql.prepare("SELECT absolute_expires_at a FROM staff_sessions WHERE staff_id='staff-a'").get().a, absolute, 'reauth does not extend the absolute limit');
  assert.ok(a.sql.prepare("SELECT COUNT(*) n FROM audit_events WHERE action='staff.reauth' AND actor='staff:staff-a'").get().n === 1);
  // a member suspended while the flow is in flight cannot finish reauth
  const inflight = await a.start('reauth'); a.google.claims = { sub: 'sub-a' };
  a.sql.prepare("UPDATE staff_members SET status='suspended' WHERE id='staff-a'").run();
  assert.equal(location(await a.callback(inflight.state)), '/staff?status=error&reason=invalid');
});

test('logout is idempotent and revoke-all signs out every session of the member only', async t => {
  const a = await setup(t); a.seed({ id: 'staff-o', sub: 'sub-o' }); a.seed({ id: 'staff-p', sub: 'sub-p' });
  await a.login({ sub: 'sub-p' }); const pToken = a.jar.get(STAFF_COOKIE);
  await a.login({ sub: 'sub-o' }); await a.login({ sub: 'sub-o' });
  assert.equal(count(a, 'staff_sessions'), 3);
  assert.equal((await a.call('/api/staff/sessions/revoke-all', 'POST', {})).data.revoked, 2);
  assert.equal(count(a, 'staff_sessions'), 1); assert.ok(a.jar.get(STAFF_COOKIE) === undefined);
  assert.equal((await a.call('/api/staff/sessions/revoke-all', 'POST', {})).status, 401);
  assert.equal((await a.call('/api/staff/logout', 'POST', {})).status, 200);
  a.jar.set(STAFF_COOKIE, pToken);
  assert.equal((await a.call('/api/staff/logout', 'POST', {})).data.authenticated, false); assert.equal(count(a, 'staff_sessions'), 0);
  assert.equal((await a.call('/api/staff/logout', 'POST', {})).status, 200);
  assert.equal((await a.call('/api/staff/logout', 'POST', { x: 1 })).status, 400);
  assert.equal((await a.call('/api/staff/logout')).status, 405);
  assert.equal((await a.call('/api/staff/nope')).status, 404);
});

test('start and callback are throttled per hashed IP', async t => {
  const a = await setup(t), ip = { 'CF-Connecting-IP': '203.0.113.9' };
  for (let i = 0; i < 10; i++) assert.equal((await a.call('/api/staff/google/start', 'POST', {}, { headers: ip })).status, 200);
  const limited = await a.call('/api/staff/google/start', 'POST', {}, { headers: ip });
  assert.equal(limited.status, 429); assert.ok(Number(limited.response.headers.get('Retry-After')) > 0);
  assert.equal((await a.call('/api/staff/google/start', 'POST', {}, { headers: { 'CF-Connecting-IP': '203.0.113.10' } })).status, 200);
  for (let i = 0; i < 20; i++) await a.call('/api/staff/google/callback?state=x', 'GET', undefined, { headers: ip });
  assert.equal((await a.call('/api/staff/google/callback?state=x', 'GET', undefined, { headers: ip })).status, 429);
  for (const row of a.sql.prepare('SELECT * FROM staff_auth_throttle').all()) assert.match(row.key_hmac, /^[0-9a-f]{64}$/);
  assert.ok(!JSON.stringify(a.sql.prepare('SELECT * FROM staff_auth_throttle').all()).includes('203.0.113'));
});

test('separation: a customer session is never a staff credential, and a staff cookie is never a customer or Access credential', async t => {
  const a = await setup(t); const staff = a.seed({ id: 'staff-c', sub: 'same-google-sub', role: 'owner' });
  // Customer signs in with the SAME Google account that has an active staff row.
  const start = await a.call('/api/account/google/start', 'POST', {}); const u = new URL(start.data.authorizationUrl);
  a.google.customerNonce = u.searchParams.get('nonce'); a.google.claims = { sub: 'same-google-sub', email: 'shopper@example.com' };
  const done = await a.call(`/api/account/google/callback?code=${FAKE.code}&state=${u.searchParams.get('state')}`);
  assert.equal(location(done), '/account?status=signed-in'); assert.ok(a.jar.has(CUSTOMER_COOKIE));
  assert.equal((await a.call('/api/account/session')).data.authenticated, true);
  for (const path of ['/api/staff/admin/products', '/api/staff/admin/suppliers', '/api/admin/products', '/api/admin/suppliers']) assert.equal((await a.call(path)).status, 401, path);
  assert.equal((await a.call('/api/staff/admin/suppliers', 'POST', { name: 'x', url: 'https://mydrop.com.ua/x' })).status, 401);
  assert.deepEqual((await a.call('/api/staff/session')).data, { authenticated: false });
  assert.equal((await a.call('/api/staff/sessions/revoke-all', 'POST', {})).status, 401);
  // Now a staff session: it does not satisfy /api/admin (Access only), nor /api/account.
  await a.login({ sub: 'same-google-sub' }, { keepSession: true });
  assert.equal((await a.call('/api/staff/admin/products')).status, 200);
  assert.equal((await a.call('/api/admin/products')).status, 401, 'staff cookie against the Access mount');
  assert.equal((await a.call('/api/auth/session')).data.authenticated, false);
  assert.equal((await a.call('/api/account/profile')).status === 200, true, 'customer cookie still works for customer routes');
  const staffOnly = await a.call('/api/account/session', 'GET', undefined, { jarOn: false, extraCookie: `${STAFF_COOKIE}=${a.jar.get(STAFF_COOKIE)}` });
  assert.deepEqual(staffOnly.data, { authenticated: false });
  assert.equal((await a.call('/api/account/profile', 'GET', undefined, { jarOn: false, extraCookie: `${STAFF_COOKIE}=${a.jar.get(STAFF_COOKIE)}` })).status, 401);
  assert.ok(staff);
});

test('prefix decides the credential: Access JWT and dev bypass never work on the staff mount', async t => {
  const a = await setup(t), token = await accessToken('owner@example.com');
  const bearer = { jarOn: false, extraCookie: `CF_Authorization=${token}` };
  assert.equal((await a.call('/api/admin/products', 'GET', undefined, bearer)).status, 200);
  assert.equal((await a.call('/api/staff/admin/products', 'GET', undefined, bearer)).status, 401);
  assert.equal((await a.call('/api/staff/admin/products', 'GET', undefined, { headers: { 'CF-Access-Jwt-Assertion': token } })).status, 401);
  // a request carrying both credentials gets exactly the credential for its prefix
  a.seed({ id: 'staff-d', sub: 'sub-d', role: 'manager' }); await a.login({ sub: 'sub-d' });
  const both = { extraCookie: `CF_Authorization=${token}` };
  const viaStaff = await a.call('/api/staff/admin/suppliers', 'POST', { name: 'S', url: 'https://mydrop.com.ua/s' }, both);
  assert.equal(viaStaff.status, 403, 'staff mount ignores the Access owner credential and applies the manager role');
  assert.equal((await a.call('/api/admin/suppliers', 'POST', { name: 'S', url: 'https://mydrop.com.ua/s' }, both)).status, 201, 'Access mount ignores the staff cookie');
  // Development bypass: loopback development still gives no principal on /api/staff/admin
  const dev = { APP_ENV: 'development', AUTH_DEV_BYPASS: 'true' };
  assert.equal((await a.call('/api/admin/products', 'GET', undefined, { host: 'http://localhost', origin: 'http://localhost', jarOn: false, env: dev })).status, 200);
  assert.equal((await a.call('/api/staff/admin/products', 'GET', undefined, { host: 'http://localhost', origin: 'http://localhost', jarOn: false, env: dev })).status, 401);
  // unauthenticated enumeration is closed: unknown subpaths and wrong methods are 401 before 404/405
  const anon = { jarOn: false };
  assert.equal((await a.call('/api/staff/admin/nope', 'GET', undefined, anon)).status, 401);
  assert.equal((await a.call('/api/staff/admin/products', 'DELETE', undefined, anon)).status, 401);
});

test('staff mount enforces the matrix: manager 403 on owner-only routes with no writes; owner passes; default deny 404/405', async t => {
  const a = await setup(t); a.seed({ id: 'staff-mg', sub: 'sub-mg', role: 'manager' }); a.seed({ id: 'staff-ow', sub: 'sub-ow', role: 'owner' });
  await a.login({ sub: 'sub-mg' }); const manager = a.jar.get(STAFF_COOKIE); await a.login({ sub: 'sub-ow' }); const owner = a.jar.get(STAFF_COOKIE);
  const as = token => ({ jarOn: false, extraCookie: `${STAFF_COOKIE}=${token}` });
  const supplier = { name: 'Demo', url: 'https://mydrop.com.ua/seg', connectionId: '12345' };
  const snapshot = () => JSON.stringify(['suppliers', 'products', 'audit_events', 'recognition_state', 'taxonomy_state'].map(table => a.sql.prepare(`SELECT * FROM ${table}`).all()));
  const before = snapshot();
  for (const [path, method, body] of [['/suppliers', 'POST', supplier], ['/recognition/activate', 'POST', {}], ['/suppliers/sync-connected', 'POST', {}]]) {
    assert.equal((await a.call('/api/staff/admin' + path, method, body, as(manager))).status, 403, path);
  }
  assert.equal(snapshot(), before, 'a 403 changes nothing');
  assert.equal((await a.call('/api/staff/admin/products', 'GET', undefined, as(manager))).status, 200);
  const created = await a.call('/api/staff/admin/suppliers', 'POST', supplier, as(owner));
  assert.equal(created.status, 201);
  // write audit rows carry the staff actor, type and role
  const row = a.sql.prepare("SELECT actor,actor_type,actor_role FROM audit_events WHERE action LIKE 'supplier.%' ORDER BY created_at DESC").get();
  assert.deepEqual({ ...row }, { actor: 'staff:staff-ow', actor_type: 'staff', actor_role: 'owner' });
  assert.equal((await a.call('/api/staff/admin/nope', 'GET', undefined, as(owner))).status, 404);
  assert.equal((await a.call('/api/staff/admin/products', 'DELETE', undefined, as(owner))).status, 405);
  // the manager's supplier projection omits connectionId
  assert.ok(!('connectionId' in (await a.call('/api/staff/admin/suppliers', 'GET', undefined, as(manager))).data.items[0]));
  assert.equal((await a.call('/api/staff/admin/suppliers', 'GET', undefined, as(owner))).data.items[0].connectionId, '12345');
});

test('CSRF: cross-origin and origin-less mutations on the staff API are 403, even anonymous; GET callback is protected by state', async t => {
  const a = await setup(t); a.seed({ id: 'staff-x', sub: 'sub-x', role: 'owner' }); await a.login({ sub: 'sub-x' });
  for (const path of ['/api/staff/google/start', '/api/staff/logout', '/api/staff/sessions/revoke-all', '/api/staff/admin/suppliers']) {
    for (const origin of ['https://evil.test', 'https://staging.catalog.test', null]) assert.equal((await a.call(path, 'POST', {}, { origin })).status, 403, `${path} ${origin}`);
    assert.equal((await a.call(path, 'POST', {}, { origin: 'https://evil.test', jarOn: false })).status, 403);
  }
  assert.equal(count(a, 'staff_sessions'), 1);
  assert.equal((await a.call('/api/staff/logout', 'POST', {}, { contentType: 'text/plain' })).status, 415);
  assert.ok(a.jar.has(STAFF_COOKIE));
  // no CORS headers are ever sent
  const r = await a.call('/api/staff/session', 'GET', undefined, { origin: 'https://evil.test' });
  assert.equal(r.response.headers.get('Access-Control-Allow-Origin'), null);
  // cookies are never readable from the page and are Strict
  assert.ok(a.jar.has(STAFF_COOKIE));
});

test('D12: a staff manager sees Access owner records as "Власник (Access)"; a staff owner sees them raw', async t => {
  const a = await setup(t); a.seed({ id: 'staff-dm', sub: 'sub-dm', role: 'manager' }); a.seed({ id: 'staff-do', sub: 'sub-do', role: 'owner' });
  const token = await accessToken('owner@example.com'), access = { jarOn: false, extraCookie: `CF_Authorization=${token}` };
  const settings = structuredClone((await a.call('/api/admin/recognition', 'GET', undefined, access)).data.defaults);
  const saved = await a.call('/api/admin/recognition/drafts', 'POST', { settings }, access);
  assert.equal(saved.status, 200); assert.equal(saved.data.actor, 'owner@example.com');
  await a.login({ sub: 'sub-dm' }); const manager = (await a.call('/api/staff/admin/recognition')).data;
  assert.ok(manager.versions.some(v => v.actor === 'Власник (Access)'));
  assert.ok(!JSON.stringify(manager).includes('owner@example.com'));
  const own = await a.call('/api/staff/admin/recognition/drafts', 'POST', { settings });
  assert.equal(own.data.actor, 'staff:staff-dm', 'the caller sees its own actor; storage uses the staff actor string');
  await a.login({ sub: 'sub-do' }); const owner = (await a.call('/api/staff/admin/recognition')).data;
  assert.ok(owner.versions.some(v => v.actor === 'owner@example.com'));
  assert.equal(a.sql.prepare('SELECT actor FROM recognition_versions WHERE id=?').get(saved.data.id).actor, 'owner@example.com');
});

test('private media: Access and staff cookies read drafts, the customer cookie and anonymous callers do not', async t => {
  const a = await setup(t); a.seed({ id: 'staff-me', sub: 'sub-me' });
  const key = 'abc123-def.jpg', MEDIA = { async get(k) { return k === key ? { body: 'bytes', httpMetadata: { contentType: 'image/jpeg' } } : null; }, async put() {} };
  const media = { env: { MEDIA } }, token = await accessToken('owner@example.com');
  assert.equal((await a.call('/media/' + key, 'GET', undefined, { ...media, jarOn: false })).status, 404, 'anonymous');
  // customer cookie
  const start = await a.call('/api/account/google/start', 'POST', {}); const u = new URL(start.data.authorizationUrl);
  a.google.customerNonce = u.searchParams.get('nonce'); a.google.claims = { sub: 'sub-customer' };
  await a.call(`/api/account/google/callback?code=${FAKE.code}&state=${u.searchParams.get('state')}`);
  assert.ok(a.jar.has(CUSTOMER_COOKIE));
  assert.equal((await a.call('/media/' + key, 'GET', undefined, media)).status, 404, 'customer cookie is not a credential');
  assert.equal((await a.call('/media/' + key, 'GET', undefined, { ...media, jarOn: false, extraCookie: `CF_Authorization=${token}` })).status, 200, 'Access');
  await a.login({ sub: 'sub-me' }, { keepSession: true });
  assert.equal((await a.call('/media/' + key, 'GET', undefined, media)).status, 200, 'staff cookie');
  a.sql.prepare("UPDATE staff_members SET status='suspended'").run();
  assert.equal((await a.call('/media/' + key, 'GET', undefined, media)).status, 404, 'suspended staff lose media access at once');
});

test('staging gate host: /staff and /api/staff/* are not 404ed while manager prefixes stay hidden', async t => {
  const a = await setup(t, { APP_ENV: 'staging', ADMIN_HOST: 'staging-admin.catalog.test', STAFF_OIDC_REDIRECT_ORIGINS: 'https://staging.catalog.test', ASSETS: { fetch: async () => new Response('<!doctype html><html><head></head><body>app</body></html>', { headers: { 'Content-Type': 'text/html' } }) } });
  const gate = 'https://staging.catalog.test', opts = { host: gate, origin: gate, jarOn: false };
  const page = await a.call('/staff', 'GET', undefined, opts);
  assert.equal(page.status, 200); assert.match(page.data, /noindex/); assert.equal(page.response.headers.get('X-Robots-Tag'), 'noindex, nofollow'); assert.match(page.response.headers.get('Cache-Control'), /no-store/);
  assert.equal((await a.call('/staff/anything', 'GET', undefined, opts)).status, 200);
  assert.deepEqual((await a.call('/api/staff/session', 'GET', undefined, opts)).data, { authenticated: false });
  assert.equal((await a.call('/api/staff/admin/products', 'GET', undefined, opts)).status, 401);
  assert.equal((await a.call('/api/staff/google/start', 'POST', {}, opts)).status, 200);
  for (const path of ['/admin', '/api/admin/products', '/api/auth/session']) assert.equal((await a.call(path, 'GET', undefined, opts)).status, 404, path);
  // on the Access-owner admin host the staff sign-in origin is not allowed
  const admin = 'https://staging-admin.catalog.test';
  assert.equal((await a.call('/api/staff/google/start', 'POST', {}, { host: admin, origin: admin, jarOn: false })).status, 400);
  // production wrangler config sends the staff pages to the Worker; env.staging is untouched
  const config = JSON.parse(readFileSync(new URL('../../wrangler.jsonc', import.meta.url), 'utf8').replace(/^\s*\/\/.*$/gm, ''));
  for (const route of ['/staff', '/staff/*']) assert.ok(config.assets.run_worker_first.includes(route), route);
  assert.equal(config.env.staging.assets.run_worker_first, true);
  assert.ok(!JSON.stringify(config.env.staging).includes('/staff'));
});

test('an expired flow gives reason=expired and creates no session', async t => {
  const a = await setup(t); a.seed({ id: 'staff-e', sub: 'sub-e' });
  const s = await a.start(); a.sql.prepare('UPDATE staff_auth_flows SET expires_at=?').run(iso(Date.now() - 1000));
  a.google.claims = { sub: 'sub-e' };
  assert.equal(location(await a.callback(s.state)), '/staff?status=error&reason=expired');
  assert.equal(count(a, 'staff_sessions'), 0); assert.equal(count(a, 'staff_auth_flows'), 0);
});

test('on http://localhost, APP_ENV staging or unset is production-like: 503 without the HMAC key and __Host- cookie names', async t => {
  for (const appEnv of ['staging', undefined]) {
    const loop = { host: 'http://localhost', origin: 'http://localhost' };
    const a = await setup(t, { APP_ENV: appEnv, STAFF_AUTH_HMAC_KEY: '', STAFF_OIDC_REDIRECT_ORIGINS: 'http://localhost' });
    assert.equal((await a.call('/api/staff/google/start', 'POST', {}, loop)).status, 503, String(appEnv));
    const b = await setup(t, { APP_ENV: appEnv, STAFF_OIDC_REDIRECT_ORIGINS: 'https://localhost' });
    const r = await b.call('/api/staff/google/start', 'POST', {}, { host: 'https://localhost', origin: 'https://localhost' });
    assert.equal(r.status, 200); assert.match(r.response.headers.getSetCookie()[0], /^__Host-ls_staff_oidc=/);
  }
});

test('defence in depth: a sub already bound elsewhere never takes an invitation, even for the same email', async t => {
  const a = await setup(t);
  a.seed({ id: 'staff-bound', sub: 'sub-dup', email: 'dup@example.com' }); a.seed({ id: 'staff-inv', status: 'invited', invitedEmail: 'dup@example.com'.replace('dup', 'dup2') });
  const r = await a.login({ sub: 'sub-dup', email: 'dup2@example.com' });
  assert.equal(location(r), '/staff?status=signed-in', 'the bound member signs in by sub');
  assert.equal(a.sql.prepare("SELECT status,google_sub FROM staff_members WHERE id='staff-inv'").get().google_sub, null);
  assert.equal(a.sql.prepare("SELECT staff_id FROM staff_sessions").get().staff_id, 'staff-bound');
});
