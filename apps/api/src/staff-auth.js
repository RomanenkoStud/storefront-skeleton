// Staff sign-in (ADR-0006): Google OIDC, staff sessions and the /api/staff/* self-service endpoints.
// Deliberately never imports auth.js or customer-auth.js: Access identities and customer sessions are not staff credentials,
// and this module reads only the __Host-ls_staff cookie. Flows and sessions live in their own tables.
import { HttpError, fail } from './domain.js';
import { googleStaffConfig, authorizationUrl, exchangeCode, verifyGoogleIdToken, randomToken, sha256Hex } from './google-oidc.js';
import { permissionsFor } from './permissions.js';

const MIN = 60000, IDLE_MS = 30 * MIN, ABSOLUTE_MS = 12 * 3600000, REFRESH_MS = MIN, FLOW_MS = 10 * MIN, RECENT_MS = 10 * MIN, MAX_SESSIONS = 5;
const STAFF_MAX_IAT_AGE_SECONDS = 300;
const LOOPBACK = ['localhost', '127.0.0.1', '[::1]'];
const TOKEN_SHAPE = /^[A-Za-z0-9_-]{43}$/, STATE_SHAPE = /^[A-Za-z0-9_-]{16,128}$/;
const iso = ms => new Date(ms).toISOString();
const json = (data, status = 200, headers = {}) => new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', ...headers } });
class ThrottleError extends HttpError { constructor(retryAfter) { super(429, 'Too many attempts; retry later'); this.retryAfter = retryAfter; } }

// ---- cookies -------------------------------------------------------------------------------
// Only APP_ENV=development on a loopback host is dev mode; anything else (production, staging, unset) is production-like.
export const staffDevMode = (request, env) => env.APP_ENV === 'development' && LOOPBACK.includes(new URL(request.url).hostname);
const cookieNames = (request, env) => staffDevMode(request, env) ? { session: 'ls_staff_dev', oidc: 'ls_staff_oidc_dev' } : { session: '__Host-ls_staff', oidc: '__Host-ls_staff_oidc' };
const cookie = (request, env, name, value, maxAge, sameSite) => `${name}=${value}; Path=/; ${staffDevMode(request, env) ? '' : 'Secure; '}HttpOnly; SameSite=${sameSite}; Max-Age=${maxAge}`;
const sessionCookie = (request, env, value, maxAge) => cookie(request, env, cookieNames(request, env).session, value, maxAge, 'Strict');
const oidcCookie = (request, env, value, maxAge) => cookie(request, env, cookieNames(request, env).oidc, value, maxAge, 'Lax');
function readCookie(request, name) {
  for (const part of (request.headers.get('Cookie') ?? '').split(';')) { const [key, ...rest] = part.trim().split('='); if (key === name) return rest.join('='); }
  return null;
}
function withCookies(response, cookies) { for (const line of cookies) response.headers.append('Set-Cookie', line); return response; }

// ---- request helpers -----------------------------------------------------------------------
async function readJsonObject(request, limit = 4096) {
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
// Outside loopback development the key must be a distinct 32+ character secret; otherwise sign-in fails closed with 503.
function hmacSecret(request, env) {
  const key = typeof env.STAFF_AUTH_HMAC_KEY === 'string' ? env.STAFF_AUTH_HMAC_KEY.trim() : '';
  if (staffDevMode(request, env)) return key || 'local-development-staff-throttle-key';
  if (key.length >= 32 && key !== String(env.CUSTOMER_AUTH_HMAC_KEY ?? '').trim()) return key;
  fail('Staff sign-in is not configured', 503);
}
export async function staffThrottle(env, secret, bucket, subject, limit, windowSeconds) {
  const seconds = Math.floor(Date.now() / 1000), windowStart = seconds - seconds % windowSeconds;
  const row = await env.DB.prepare('INSERT INTO staff_auth_throttle(bucket,key_hmac,window_start,count) VALUES(?,?,?,1) ON CONFLICT(bucket,key_hmac,window_start) DO UPDATE SET count=count+1 RETURNING count').bind(bucket, await hmacHex(secret, `${bucket}:${subject}`), windowStart).first();
  if (row.count > limit) throw new ThrottleError(Math.max(1, windowStart + windowSeconds - seconds));
}
const clientIp = request => request.headers.get('CF-Connecting-IP') || 'unknown';
async function cleanup(env) {
  const now = iso(Date.now());
  try {
    await env.DB.batch([
      env.DB.prepare('DELETE FROM staff_auth_flows WHERE binding_hash IN (SELECT binding_hash FROM staff_auth_flows WHERE expires_at<? LIMIT 50)').bind(now),
      env.DB.prepare('DELETE FROM staff_sessions WHERE token_hash IN (SELECT token_hash FROM staff_sessions WHERE absolute_expires_at<=? OR idle_expires_at<=? LIMIT 50)').bind(now, now),
      env.DB.prepare('DELETE FROM staff_auth_throttle WHERE rowid IN (SELECT rowid FROM staff_auth_throttle WHERE window_start<? LIMIT 50)').bind(Math.floor(Date.now() / 1000) - 86400),
    ]);
  } catch { console.error('Staff cleanup failed'); }
}

// ---- sessions ------------------------------------------------------------------------------
// Resolves only the staff session cookie and re-reads the member on every request: the role is live and a member that is
// no longer active loses the session immediately. Returns {principal, tokenHash, stale}; stale means a cookie was presented but unusable.
export async function resolveStaffPrincipal(request, env) {
  const token = readCookie(request, cookieNames(request, env).session);
  if (!token) return { principal: null, stale: false };
  if (!TOKEN_SHAPE.test(token)) return { principal: null, stale: true };
  return resolveByHash(env, await sha256Hex(token));
}
async function resolveByHash(env, tokenHash) {
  const nowMs = Date.now(), now = iso(nowMs);
  const row = await env.DB.prepare('SELECT s.*, m.status, m.role, m.display_name, m.email FROM staff_sessions s JOIN staff_members m ON m.id=s.staff_id WHERE s.token_hash=?').bind(tokenHash).first();
  if (!row) return { principal: null, stale: true };
  if (row.status !== 'active' || !['owner', 'manager'].includes(row.role) || row.idle_expires_at <= now || row.absolute_expires_at <= now) {
    await env.DB.prepare('DELETE FROM staff_sessions WHERE token_hash=?').bind(tokenHash).run();
    return { principal: null, stale: true };
  }
  if (nowMs - Date.parse(row.last_seen_at) >= REFRESH_MS) {
    const idle = iso(nowMs + IDLE_MS);
    await env.DB.prepare('UPDATE staff_sessions SET last_seen_at=?,idle_expires_at=? WHERE token_hash=?').bind(now, idle < row.absolute_expires_at ? idle : row.absolute_expires_at, tokenHash).run();
  }
  return { principal: { type: 'staff', role: row.role, actor: `staff:${row.staff_id}`, staffId: row.staff_id, sessionTokenHash: tokenHash, authenticatedAt: row.authenticated_at, displayName: row.display_name, email: row.email }, tokenHash, session: row, stale: false };
}
export const clearStaffSessionCookie = (request, env) => sessionCookie(request, env, '', 0);
// The 401 for the /api/staff/admin mount, clearing a stale cookie.
export const staffUnauthorized = (request, env, stale) => withCookies(json({ error: 'Staff sign-in required' }, 401), stale ? [clearStaffSessionCookie(request, env)] : []);

// Audit rows are written as INSERT...SELECT so they exist only when the member row is active (and, for `bound`, was bound in this batch).
const auditFor = (env, action, sub, now, extra = '', bind = []) => env.DB.prepare(`INSERT INTO audit_events(id,actor,action,resource_id,created_at,actor_type,actor_role) SELECT ?, 'staff:'||id, ?, id, ?, 'staff', role FROM staff_members WHERE google_sub=? AND status='active'${extra}`).bind(crypto.randomUUID(), action, now, sub, ...bind);
const capStatement = (env, where, bind) => env.DB.prepare(`DELETE FROM staff_sessions WHERE staff_id=${where} AND token_hash NOT IN (SELECT token_hash FROM staff_sessions WHERE staff_id=${where} ORDER BY created_at DESC, rowid DESC LIMIT ${MAX_SESSIONS})`).bind(...bind, ...bind);

// ---- Google sign-in ------------------------------------------------------------------------
async function googleStart(request, env) {
  const config = googleStaffConfig(env, staffDevMode(request, env)); if (!config) fail('Staff sign-in is not configured', 503);
  const secret = hmacSecret(request, env);
  const origin = new URL(request.url).origin;
  if (!config.origins.includes(origin) || request.headers.get('Origin') !== origin) fail('This origin is not allowed for sign-in', 400);
  const body = await readJsonObject(request);
  if (Object.keys(body).some(key => key !== 'intent') || (body.intent !== undefined && !['login', 'reauth'].includes(body.intent))) fail('Invalid request');
  const intent = body.intent ?? 'login';
  await staffThrottle(env, secret, 'google-start', clientIp(request), 10, 600);
  // The start request is same-origin, so it carries the Strict cookie; the callback will not. Bind the session to the flow here.
  let staffId = null, sessionHash = null;
  const current = await resolveStaffPrincipal(request, env);
  if (intent === 'reauth') {
    if (!current.principal) return staffUnauthorized(request, env, current.stale);
    staffId = current.principal.staffId;
  }
  if (current.principal) sessionHash = current.tokenHash;
  await cleanup(env);
  const state = randomToken(), nonce = randomToken(), verifier = randomToken(), binding = randomToken(), nowMs = Date.now(), redirectUri = `${origin}/api/staff/google/callback`;
  await env.DB.prepare("INSERT INTO staff_auth_flows(binding_hash,state_hash,intent,staff_id,code_verifier,nonce,redirect_uri,return_path,created_at,expires_at,session_token_hash) VALUES(?,?,?,?,?,?,?,'/staff',?,?,?)").bind(await sha256Hex(binding), await sha256Hex(state), intent, staffId, verifier, nonce, redirectUri, iso(nowMs), iso(nowMs + FLOW_MS), sessionHash).run();
  return withCookies(json({ authorizationUrl: await authorizationUrl({ clientId: config.clientId, redirectUri, state, nonce, verifier, scope: 'openid email' }) }), [oidcCookie(request, env, binding, FLOW_MS / 1000)]);
}

function redirect(request, env, path, cookies = []) {
  const response = new Response(null, { status: 303, headers: { Location: path, 'Cache-Control': 'no-store' } });
  return withCookies(response, [oidcCookie(request, env, '', 0), ...cookies]);
}
const failedRedirect = (request, env, reason, cookies = []) => redirect(request, env, `/staff?status=error&reason=${reason}`, cookies);

// Login: the invitation is matched only while no row holds this sub, by exact lowercase verified email, within its window.
// Everything happens in one batch; the session row is inserted only if an active row for this sub exists afterwards.
// Returns the new token, or null (not_allowed). A UNIQUE violation also means not_allowed.
async function signIn(env, { sub, email }, presentedHash) {
  const token = randomToken(), tokenHash = await sha256Hex(token), nowMs = Date.now(), now = iso(nowMs);
  const statements = [
    env.DB.prepare("UPDATE staff_members SET google_sub=?,email=?,status='active',activated_at=?,invitation_expires_at=NULL,updated_at=? WHERE status='invited' AND invited_email=lower(?) AND invitation_expires_at>? AND google_sub IS NULL AND NOT EXISTS (SELECT 1 FROM staff_members x WHERE x.google_sub=?) RETURNING id").bind(sub, email, now, now, email, now, sub),
    env.DB.prepare("UPDATE staff_members SET email=COALESCE(?,email),last_sign_in_at=?,updated_at=? WHERE google_sub=? AND status='active'").bind(email, now, now, sub),
    env.DB.prepare("INSERT INTO staff_sessions(token_hash,staff_id,created_at,authenticated_at,last_seen_at,idle_expires_at,absolute_expires_at) SELECT ?, id, ?, ?, ?, ?, ? FROM staff_members WHERE google_sub=? AND status='active' RETURNING token_hash").bind(tokenHash, now, now, now, iso(nowMs + IDLE_MS), iso(nowMs + ABSOLUTE_MS), sub),
    env.DB.prepare('DELETE FROM staff_sessions WHERE token_hash=? AND EXISTS (SELECT 1 FROM staff_sessions WHERE token_hash=?)').bind(presentedHash ?? '', tokenHash),
    capStatement(env, '(SELECT id FROM staff_members WHERE google_sub=?)', [sub]),
    auditFor(env, 'staff.activate', sub, now, ' AND activated_at=?', [now]),
    auditFor(env, 'staff.signin', sub, now),
  ];
  let results;
  try { results = await env.DB.batch(statements); } catch (error) { if (/UNIQUE/i.test(String(error?.message))) return null; throw error; }
  return results[2].results.length === 1 ? token : null;
}
async function deniedAudit(env) {
  try { await env.DB.prepare("INSERT INTO audit_events(id,actor,action,resource_id,created_at,actor_type,actor_role) VALUES(?,'staff-signin','staff.signin.denied','-',?,'system',NULL)").bind(crypto.randomUUID(), iso(Date.now())).run(); } catch { console.error('Staff audit failed'); }
}

// Reauth: the callback is a cross-site top-level redirect, so the Strict session cookie is NOT sent. The session was bound to the
// flow at start (session_token_hash); it is re-resolved from that hash, must still be active, belong to flow.staff_id and to the
// verified sub. It rotates with a fresh authenticated_at but keeps its absolute expiry, so recent sign-in never extends 12 hours.
async function reauth(env, flow, { sub }) {
  const oldHash = flow.session_token_hash;
  const { principal, session } = oldHash ? await resolveByHash(env, oldHash) : { principal: null };
  if (!principal) return 'invalid';
  if (principal.staffId !== flow.staff_id) return 'mismatch';
  const token = randomToken(), tokenHash = await sha256Hex(token), nowMs = Date.now(), now = iso(nowMs);
  const results = await env.DB.batch([
    env.DB.prepare("INSERT INTO staff_sessions(token_hash,staff_id,created_at,authenticated_at,last_seen_at,idle_expires_at,absolute_expires_at) SELECT ?, s.staff_id, s.created_at, ?, ?, MIN(?, s.absolute_expires_at), s.absolute_expires_at FROM staff_sessions s JOIN staff_members m ON m.id=s.staff_id WHERE s.token_hash=? AND s.staff_id=? AND m.status='active' AND m.google_sub=? AND s.absolute_expires_at>? RETURNING token_hash").bind(tokenHash, now, now, iso(nowMs + IDLE_MS), oldHash, flow.staff_id, sub, now),
    env.DB.prepare('DELETE FROM staff_sessions WHERE token_hash=? AND EXISTS (SELECT 1 FROM staff_sessions WHERE token_hash=?)').bind(oldHash, tokenHash),
    env.DB.prepare("UPDATE staff_members SET last_sign_in_at=?,updated_at=? WHERE id=? AND google_sub=? AND status='active' AND EXISTS (SELECT 1 FROM staff_sessions WHERE token_hash=?)").bind(now, now, flow.staff_id, sub, tokenHash),
    env.DB.prepare("INSERT INTO audit_events(id,actor,action,resource_id,created_at,actor_type,actor_role) SELECT ?, 'staff:'||id, 'staff.reauth', id, ?, 'staff', role FROM staff_members WHERE id=? AND google_sub=? AND status='active' AND EXISTS (SELECT 1 FROM staff_sessions WHERE token_hash=?)").bind(crypto.randomUUID(), now, flow.staff_id, sub, tokenHash),
  ]);
  if (results[0].results.length !== 1) return 'mismatch';
  return { token, absolute: Date.parse(session.absolute_expires_at) };
}

async function googleCallback(request, env, url) {
  const config = googleStaffConfig(env, staffDevMode(request, env)); if (!config) fail('Staff sign-in is not configured', 503);
  await staffThrottle(env, hmacSecret(request, env), 'google-callback', clientIp(request), 20, 600);
  const names = cookieNames(request, env), state = url.searchParams.get('state'), binding = readCookie(request, names.oidc);
  if (!state || !STATE_SHAPE.test(state)) return failedRedirect(request, env, 'invalid');
  // Single use: the state row is consumed atomically before anything else is checked.
  const flow = await env.DB.prepare('DELETE FROM staff_auth_flows WHERE state_hash=? RETURNING *').bind(await sha256Hex(state)).first();
  if (!flow) return failedRedirect(request, env, 'invalid');
  if (!binding || !TOKEN_SHAPE.test(binding) || await sha256Hex(binding) !== flow.binding_hash) return failedRedirect(request, env, 'invalid');
  if (flow.expires_at <= iso(Date.now())) return failedRedirect(request, env, 'expired');
  if (url.searchParams.has('error')) return failedRedirect(request, env, 'denied');
  if (new URL(flow.redirect_uri).origin !== url.origin) return failedRedirect(request, env, 'invalid');
  const code = url.searchParams.get('code');
  if (!code || code.length > 2048) return failedRedirect(request, env, 'invalid');
  try {
    const idToken = await exchangeCode(config, { code, verifier: flow.code_verifier, redirectUri: flow.redirect_uri });
    const profile = await verifyGoogleIdToken(idToken, { clientId: config.clientId, nonce: flow.nonce, maxIatAgeSeconds: STAFF_MAX_IAT_AGE_SECONDS });
    if (flow.intent === 'reauth') {
      const result = await reauth(env, flow, profile);
      if (typeof result === 'string') return failedRedirect(request, env, result);
      return redirect(request, env, '/staff?status=reauthenticated', [sessionCookie(request, env, result.token, Math.max(1, Math.floor((result.absolute - Date.now()) / 1000)))]);
    }
    const token = await signIn(env, profile, flow.session_token_hash); // the old session comes from the flow, never from the cookie
    if (!token) { await deniedAudit(env); return failedRedirect(request, env, 'not_allowed'); }
    return redirect(request, env, '/staff?status=signed-in', [sessionCookie(request, env, token, ABSOLUTE_MS / 1000)]);
  } catch (error) {
    console.error('Staff Google sign-in failed', error?.name || 'Error'); // never log messages: they may carry provider detail
    return failedRedirect(request, env, 'invalid');
  }
}

// ---- router (everything under /api/staff/* except the /api/staff/admin mount) ----------------
const ROUTES = { '/api/staff/session': ['GET'], '/api/staff/google/start': ['POST'], '/api/staff/google/callback': ['GET'], '/api/staff/logout': ['POST'], '/api/staff/sessions/revoke-all': ['POST'] };
export async function handleStaff(request, env) {
  const url = new URL(request.url), path = url.pathname, method = request.method;
  try {
    if (!ROUTES[path]) fail('Endpoint not found', 404);
    if (!ROUTES[path].includes(method)) fail('Method not allowed', 405);
    const clear = () => clearStaffSessionCookie(request, env);
    if (path === '/api/staff/session') {
      const { principal, session, stale } = await resolveStaffPrincipal(request, env);
      if (!principal) return withCookies(json({ authenticated: false }), stale ? [clear()] : []);
      return json({ authenticated: true, staff: { id: principal.staffId, displayName: principal.displayName, email: principal.email, role: principal.role, permissions: permissionsFor(principal), authenticatedAt: session.authenticated_at, recentAuth: Date.now() - Date.parse(session.authenticated_at) <= RECENT_MS } });
    }
    if (path === '/api/staff/google/start') return await googleStart(request, env);
    if (path === '/api/staff/google/callback') return await googleCallback(request, env, url);
    await readEmptyJson(request);
    if (path === '/api/staff/logout') {
      const presented = readCookie(request, cookieNames(request, env).session);
      if (presented && TOKEN_SHAPE.test(presented)) await env.DB.prepare('DELETE FROM staff_sessions WHERE token_hash=?').bind(await sha256Hex(presented)).run();
      return withCookies(json({ authenticated: false }), presented ? [clear()] : []);
    }
    const { principal, stale } = await resolveStaffPrincipal(request, env);
    if (!principal) return staffUnauthorized(request, env, stale);
    const results = await env.DB.batch([
      env.DB.prepare('DELETE FROM staff_sessions WHERE staff_id=? RETURNING token_hash').bind(principal.staffId),
      env.DB.prepare("INSERT INTO audit_events(id,actor,action,resource_id,created_at,actor_type,actor_role) VALUES(?,?,'staff.sessions.revoke',?,?,'staff',?)").bind(crypto.randomUUID(), principal.actor, principal.staffId, iso(Date.now()), principal.role),
    ]);
    return withCookies(json({ revoked: results[0].results.length }), [clear()]);
  } catch (error) {
    if (error?.retryAfter) return json({ error: error.message }, 429, { 'Retry-After': String(error.retryAfter) });
    throw error;
  }
}
