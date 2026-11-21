// Customer accounts (ADR-0003): provider-independent session core plus the Google sign-in flow.
// Deliberately never imports auth.js: manager identity (Cloudflare Access, AUTH_DEV_BYPASS) is not a customer identity.
import { HttpError, fail } from './domain.js';
import { handleProfile, handleExport, handleDelete } from './customer-profile.js';
import { accountCarts } from './carts.js';
import { googleConfig, authorizationUrl, exchangeCode, verifyGoogleIdToken, randomToken, sha256Hex } from './google-oidc.js';

const DAY = 86400000, IDLE_MS = 7 * DAY, ABSOLUTE_MS = 30 * DAY, REFRESH_MS = 3600000, FLOW_MS = 600000, MAX_SESSIONS = 10;
const LOOPBACK = ['localhost', '127.0.0.1', '[::1]'];
const TOKEN_SHAPE = /^[A-Za-z0-9_-]{43}$/, STATE_SHAPE = /^[A-Za-z0-9_-]{16,128}$/;
const iso = ms => new Date(ms).toISOString();
const json = (data, status = 200, headers = {}) => new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', ...headers } });
class ThrottleError extends HttpError { constructor(retryAfter) { super(429, 'Too many attempts; retry later'); this.retryAfter = retryAfter; } }

// ---- cookies -------------------------------------------------------------------------------
// Only APP_ENV=development on a loopback host is dev mode; anything else (production, staging, unset) is production-like.
export const devMode = (request, env) => env.APP_ENV === 'development' && LOOPBACK.includes(new URL(request.url).hostname);
const cookieNames = (request, env) => devMode(request, env) ? { session: 'ls_session_dev', oidc: 'ls_oidc_dev' } : { session: '__Host-ls_session', oidc: '__Host-ls_oidc' };
function cookie(request, env, name, value, maxAge) { return `${name}=${value}; Path=/; ${devMode(request, env) ? '' : 'Secure; '}HttpOnly; SameSite=Lax; Max-Age=${maxAge}`; }
function readCookie(request, name) {
  for (const part of (request.headers.get('Cookie') ?? '').split(';')) { const [key, ...rest] = part.trim().split('='); if (key === name) return rest.join('='); }
  return null;
}
function withCookies(response, cookies) { for (const line of cookies) response.headers.append('Set-Cookie', line); return response; }

// ---- request helpers -----------------------------------------------------------------------
export async function readJsonObject(request, limit = 4096) {
  if (!request.headers.get('Content-Type')?.startsWith('application/json')) fail('Content-Type application/json required', 415);
  if (Number(request.headers.get('Content-Length')) > limit) fail('Request too large', 413);
  const reader = request.body?.getReader(), chunks = []; let size = 0;
  if (reader) try { while (true) { const { done, value } = await reader.read(); if (done) break; size += value.byteLength; if (size > limit) { await reader.cancel(); fail('Request too large', 413); } chunks.push(value); } } finally { reader.releaseLock(); }
  const bytes = new Uint8Array(size); let offset = 0; for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length; }
  let data; try { data = JSON.parse(new TextDecoder().decode(bytes)); } catch { fail('Invalid JSON'); }
  if (!data || typeof data !== 'object' || Array.isArray(data)) fail('JSON object required');
  return data;
}
async function readEmptyJson(request) { if (Object.keys(await readJsonObject(request)).length) fail('Unexpected field'); }
async function hmacHex(secret, value) {
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  return [...new Uint8Array(await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(value)))].map(b => b.toString(16).padStart(2, '0')).join('');
}
// Production (and any non-loopback host) fails closed without the HMAC key; loopback development uses a fixed local key.
export function hmacSecret(request, env) {
  if (typeof env.CUSTOMER_AUTH_HMAC_KEY === 'string' && env.CUSTOMER_AUTH_HMAC_KEY.trim()) return env.CUSTOMER_AUTH_HMAC_KEY;
  if (devMode(request, env)) return 'local-development-throttle-key';
  fail('Customer sign-in is not configured', 503);
}
export async function throttle(env, secret, bucket, subject, limit, windowSeconds) {
  const seconds = Math.floor(Date.now() / 1000), windowStart = seconds - seconds % windowSeconds;
  const row = await env.DB.prepare('INSERT INTO customer_auth_throttle(bucket,key_hmac,window_start,count) VALUES(?,?,?,1) ON CONFLICT(bucket,key_hmac,window_start) DO UPDATE SET count=count+1 RETURNING count').bind(bucket, await hmacHex(secret, `${bucket}:${subject}`), windowStart).first();
  if (row.count > limit) throw new ThrottleError(Math.max(1, windowStart + windowSeconds - seconds));
}
export const clientIp = request => request.headers.get('CF-Connecting-IP') || 'unknown';
async function cleanup(env) {
  const now = iso(Date.now());
  try {
    await env.DB.batch([
      env.DB.prepare('DELETE FROM customer_auth_flows WHERE binding_hash IN (SELECT binding_hash FROM customer_auth_flows WHERE expires_at<? LIMIT 50)').bind(now),
      env.DB.prepare('DELETE FROM customer_sessions WHERE token_hash IN (SELECT token_hash FROM customer_sessions WHERE absolute_expires_at<=? OR idle_expires_at<=? LIMIT 50)').bind(now, now),
      env.DB.prepare('DELETE FROM customer_auth_throttle WHERE rowid IN (SELECT rowid FROM customer_auth_throttle WHERE window_start<? LIMIT 50)').bind(Math.floor(Date.now() / 1000) - 86400),
    ]);
  } catch { console.error('Customer cleanup failed'); }
}

// ---- sessions ------------------------------------------------------------------------------
function sessionStatements(env, customerId, tokenHash, presentedHash, nowMs) {
  const statements = [];
  if (presentedHash) statements.push(env.DB.prepare('DELETE FROM customer_sessions WHERE token_hash=?').bind(presentedHash));
  const now = iso(nowMs);
  statements.push(env.DB.prepare('INSERT INTO customer_sessions(token_hash,customer_id,created_at,authenticated_at,last_seen_at,idle_expires_at,absolute_expires_at) VALUES(?,?,?,?,?,?,?)').bind(tokenHash, customerId, now, now, now, iso(nowMs + IDLE_MS), iso(nowMs + ABSOLUTE_MS)));
  statements.push(env.DB.prepare('DELETE FROM customer_sessions WHERE customer_id=? AND token_hash NOT IN (SELECT token_hash FROM customer_sessions WHERE customer_id=? ORDER BY created_at DESC, rowid DESC LIMIT ?)').bind(customerId, customerId, MAX_SESSIONS));
  return statements;
}
// `fields` are field names only, never values.
function audit(env, customerId, action, nowMs, fields = []) { return env.DB.prepare('INSERT INTO customer_audit_events(id,customer_id,action,fields,created_at) VALUES(?,?,?,?,?)').bind(crypto.randomUUID(), customerId, action, JSON.stringify(fields), iso(nowMs)); }

// Resolves only the customer session cookie. Returns {customerId,tokenHash,authenticatedAt}, or null with stale=true if a cookie was presented but unusable.
export async function resolveCustomerSession(request, env) {
  const token = readCookie(request, cookieNames(request, env).session);
  if (!token) return { session: null, stale: false };
  if (!TOKEN_SHAPE.test(token)) return { session: null, stale: true };
  const tokenHash = await sha256Hex(token), nowMs = Date.now(), now = iso(nowMs);
  const row = await env.DB.prepare('SELECT s.*, c.status FROM customer_sessions s JOIN customers c ON c.id=s.customer_id WHERE s.token_hash=?').bind(tokenHash).first();
  if (!row) return { session: null, stale: true };
  if (row.status !== 'active' || row.idle_expires_at <= now || row.absolute_expires_at <= now) {
    await env.DB.prepare('DELETE FROM customer_sessions WHERE token_hash=?').bind(tokenHash).run();
    return { session: null, stale: true };
  }
  if (nowMs - Date.parse(row.last_seen_at) >= REFRESH_MS) {
    const idle = iso(nowMs + IDLE_MS);
    await env.DB.prepare('UPDATE customer_sessions SET last_seen_at=?,idle_expires_at=? WHERE token_hash=?').bind(now, idle < row.absolute_expires_at ? idle : row.absolute_expires_at, tokenHash).run();
  }
  return { session: { customerId: row.customer_id, tokenHash, authenticatedAt: row.authenticated_at }, stale: false };
}
export async function requireCustomer(request, env) {
  const { session } = await resolveCustomerSession(request, env);
  if (!session) fail('Sign-in required', 401);
  return session;
}
async function customerView(env, customerId) {
  const rows = (await env.DB.prepare('SELECT c.created_at, i.provider, i.display_handle FROM customers c JOIN customer_identities i ON i.customer_id=c.id WHERE c.id=? ORDER BY i.provider').bind(customerId).all()).results;
  if (!rows.length) return null;
  return { id: customerId, displayName: null, signInEmail: rows.find(row => row.provider === 'google')?.display_handle ?? null, providers: rows.map(row => row.provider), createdAt: rows[0].created_at };
}

// ---- Google sign-in ------------------------------------------------------------------------
async function googleStart(request, env) {
  const config = googleConfig(env, devMode(request, env)); if (!config) fail('Google sign-in is not configured', 503);
  const secret = hmacSecret(request, env);
  const origin = new URL(request.url).origin;
  if (!config.origins.includes(origin) || request.headers.get('Origin') !== origin) fail('This origin is not allowed for sign-in', 400);
  await readEmptyJson(request);
  await throttle(env, secret, 'google-start', clientIp(request), 20, 600);
  await cleanup(env);
  const state = randomToken(), nonce = randomToken(), verifier = randomToken(), binding = randomToken(), nowMs = Date.now(), redirectUri = `${origin}/api/account/google/callback`;
  await env.DB.prepare("INSERT INTO customer_auth_flows(binding_hash,state_hash,provider,intent,customer_id,code_verifier,nonce,redirect_uri,return_path,created_at,expires_at) VALUES(?,?,'google','login',NULL,?,?,?,'/account',?,?)").bind(await sha256Hex(binding), await sha256Hex(state), verifier, nonce, redirectUri, iso(nowMs), iso(nowMs + FLOW_MS)).run();
  return withCookies(json({ authorizationUrl: await authorizationUrl({ clientId: config.clientId, redirectUri, state, nonce, verifier }) }), [cookie(request, env, cookieNames(request, env).oidc, binding, FLOW_MS / 1000)]);
}

function redirect(request, env, path, cookies = []) {
  const response = new Response(null, { status: 303, headers: { Location: path, 'Cache-Control': 'no-store' } });
  return withCookies(response, [cookie(request, env, cookieNames(request, env).oidc, '', 0), ...cookies]);
}
const failedRedirect = (request, env, reason) => redirect(request, env, `/account?status=error&reason=${reason}`);

async function signInGoogle(env, { sub, email }, presentedToken) {
  const find = () => env.DB.prepare("SELECT i.id, i.customer_id, c.status FROM customer_identities i JOIN customers c ON c.id=i.customer_id WHERE i.provider='google' AND i.subject=?").bind(sub).first();
  const token = randomToken(), tokenHash = await sha256Hex(token), presentedHash = TOKEN_SHAPE.test(presentedToken ?? '') ? await sha256Hex(presentedToken) : null, nowMs = Date.now(), now = iso(nowMs);
  let existing = await find();
  if (!existing) {
    const customerId = crypto.randomUUID();
    try {
      await env.DB.batch([
        env.DB.prepare('INSERT INTO customers(id,status,created_at,updated_at) VALUES(?,?,?,?)').bind(customerId, 'active', now, now),
        env.DB.prepare("INSERT INTO customer_identities(id,customer_id,provider,subject,display_handle,created_at,last_used_at) VALUES(?,?,'google',?,?,?,?)").bind(crypto.randomUUID(), customerId, sub, email, now, now),
        audit(env, customerId, 'customer.signup', nowMs),
        ...sessionStatements(env, customerId, tokenHash, presentedHash, nowMs),
      ]);
      return token;
    } catch (error) { existing = await find(); if (!existing) throw error; } // lost a concurrent first-sign-in race
  }
  if (existing.status !== 'active') throw new Error('Customer disabled');
  await env.DB.batch([env.DB.prepare('UPDATE customer_identities SET display_handle=?,last_used_at=? WHERE id=?').bind(email, now, existing.id), audit(env, existing.customer_id, 'customer.signin', nowMs), ...sessionStatements(env, existing.customer_id, tokenHash, presentedHash, nowMs)]);
  return token;
}

async function googleCallback(request, env, url) {
  const config = googleConfig(env, devMode(request, env)); if (!config) fail('Google sign-in is not configured', 503);
  await throttle(env, hmacSecret(request, env), 'google-callback', clientIp(request), 30, 600);
  const names = cookieNames(request, env), state = url.searchParams.get('state'), binding = readCookie(request, names.oidc);
  if (!state || !STATE_SHAPE.test(state)) return failedRedirect(request, env, 'invalid');
  // Single use: the state row is consumed atomically before anything else is checked.
  const flow = await env.DB.prepare("DELETE FROM customer_auth_flows WHERE state_hash=? AND provider='google' AND intent='login' RETURNING *").bind(await sha256Hex(state)).first();
  if (!flow) return failedRedirect(request, env, 'invalid');
  if (!binding || !TOKEN_SHAPE.test(binding) || await sha256Hex(binding) !== flow.binding_hash || flow.expires_at <= iso(Date.now()) || new URL(flow.redirect_uri).origin !== url.origin) return failedRedirect(request, env, 'expired');
  if (url.searchParams.has('error')) return failedRedirect(request, env, 'denied');
  const code = url.searchParams.get('code');
  if (!code || code.length > 2048) return failedRedirect(request, env, 'invalid');
  try {
    const idToken = await exchangeCode(config, { code, verifier: flow.code_verifier, redirectUri: flow.redirect_uri });
    const profile = await verifyGoogleIdToken(idToken, { clientId: config.clientId, nonce: flow.nonce });
    const token = await signInGoogle(env, profile, readCookie(request, names.session));
    return redirect(request, env, '/account?status=signed-in', [cookie(request, env, names.session, token, ABSOLUTE_MS / 1000)]);
  } catch (error) {
    console.error('Google sign-in failed', error?.name || 'Error'); // never log messages: they may carry provider detail
    return failedRedirect(request, env, 'invalid');
  }
}

// ---- router --------------------------------------------------------------------------------
const ROUTES = { '/api/account/session': ['GET'], '/api/account/google/start': ['POST'], '/api/account/google/callback': ['GET'], '/api/account/logout': ['POST'], '/api/account/sessions/revoke-all': ['POST'], '/api/account/profile': ['GET', 'PATCH'], '/api/account/export': ['GET'], '/api/account/carts': ['GET'], '/api/account': ['DELETE'] };
export async function handleAccount(request, env) {
  const url = new URL(request.url), path = url.pathname, method = request.method, names = cookieNames(request, env);
  try {
    if (!ROUTES[path]) fail('Endpoint not found', 404);
    if (!ROUTES[path].includes(method)) fail('Method not allowed', 405);
    const clear = () => cookie(request, env, names.session, '', 0);
    if (path === '/api/account/session') {
      const { session, stale } = await resolveCustomerSession(request, env);
      const customer = session ? await customerView(env, session.customerId) : null;
      return withCookies(json(customer ? { authenticated: true, customer } : { authenticated: false }), stale ? [clear()] : []);
    }
    if (path === '/api/account/google/start') return await googleStart(request, env);
    if (path === '/api/account/google/callback') return await googleCallback(request, env, url);
    if (path === '/api/account/carts') {
      const { session, stale } = await resolveCustomerSession(request, env);
      if (!session) return withCookies(json({ error: 'unauthenticated' }, 401), stale ? [clear()] : []);
      return json({ carts: await accountCarts(env, session.customerId) });
    }
    if (path === '/api/account/profile' || path === '/api/account/export' || path === '/api/account') {
      const { session, stale } = await resolveCustomerSession(request, env);
      if (!session) return withCookies(json({ error: 'Sign-in required' }, 401), stale ? [clear()] : []);
      const ctx = { customerId: session.customerId, authenticatedAt: session.authenticatedAt, json, readJsonObject, audit, customerView: id => customerView(env, id), throttle: (bucket, limit, windowSeconds) => throttle(env, hmacSecret(request, env), bucket, session.customerId, limit, windowSeconds) };
      if (path === '/api/account/export') {
        const exported = await handleExport(env, ctx);
        return ctx.json({ ...await exported.json(), carts: await accountCarts(env, session.customerId, null) }, 200, { 'Content-Disposition': exported.headers.get('Content-Disposition') });
      }
      if (path === '/api/account') return withCookies(await handleDelete(request, env, ctx), [clear()]);
      return await handleProfile(request, env, ctx);
    }
    await readEmptyJson(request);
    const { session, stale } = await resolveCustomerSession(request, env);
    if (path === '/api/account/logout') {
      const presented = readCookie(request, names.session);
      if (presented && TOKEN_SHAPE.test(presented)) await env.DB.prepare('DELETE FROM customer_sessions WHERE token_hash=?').bind(await sha256Hex(presented)).run();
      return withCookies(json({ authenticated: false }), presented ? [clear()] : []);
    }
    if (!session) return withCookies(json({ error: 'Sign-in required' }, 401), stale ? [clear()] : []);
    const results = await env.DB.batch([env.DB.prepare('DELETE FROM customer_sessions WHERE customer_id=? RETURNING token_hash').bind(session.customerId), audit(env, session.customerId, 'sessions.revoke-all', Date.now())]);
    const revoked = results[0].results.length;
    return withCookies(json({ revoked }), [clear()]);
  } catch (error) {
    if (error?.retryAfter) return json({ error: error.message }, 429, { 'Retry-After': String(error.retryAfter) });
    throw error;
  }
}
