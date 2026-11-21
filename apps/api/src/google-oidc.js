// Google OpenID Connect adapter (ADR-0003). Customer sign-in only; independent from the Cloudflare Access verifier in auth.js.
export const GOOGLE_AUTH_URL = 'https://accounts.google.com/o/oauth2/v2/auth';
const TOKEN_URL = 'https://oauth2.googleapis.com/token';
const JWKS_URL = 'https://www.googleapis.com/oauth2/v3/certs';
const ISSUERS = ['https://accounts.google.com', 'accounts.google.com'];
const MAX_BODY = 100000, MAX_KEYS = 50;

let cache = null; // {keys, expires, fetchedAt} per Worker isolate
export function resetGoogleJwksCache() { cache = null; }

function base64Url(bytes) { return btoa(String.fromCharCode(...bytes)).replaceAll('+', '-').replaceAll('/', '_').replaceAll('=', ''); }
function decodeBase64Url(value) {
  if (typeof value !== 'string' || !/^[A-Za-z0-9_-]+$/.test(value)) throw new Error('Invalid base64url');
  return Uint8Array.from(atob(value.replaceAll('-', '+').replaceAll('_', '/')), char => char.charCodeAt(0));
}
function decodeJson(value) { return JSON.parse(new TextDecoder().decode(decodeBase64Url(value))); }
export const randomToken = () => base64Url(crypto.getRandomValues(new Uint8Array(32)));
export async function sha256Hex(value) { return [...new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value)))].map(b => b.toString(16).padStart(2, '0')).join(''); }
export async function pkceChallenge(verifier) { return base64Url(new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier)))); }

function oauthConfig(idValue, secretValue, originsValue, allowLoopbackHttp) {
  const clientId = typeof idValue === 'string' ? idValue.trim() : '';
  const clientSecret = typeof secretValue === 'string' ? secretValue.trim() : '';
  const origins = [];
  for (const entry of String(originsValue ?? '').split(',').map(value => value.trim()).filter(Boolean)) {
    try {
      const url = new URL(entry);
      const loopback = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
      if (url.origin === entry && (url.protocol === 'https:' || (url.protocol === 'http:' && loopback && allowLoopbackHttp))) origins.push(entry);
    } catch { /* ignore malformed entries */ }
  }
  if (!clientId || !clientSecret || !origins.length) return null;
  return { clientId, clientSecret, origins };
}
export function googleConfig(env, allowLoopbackHttp = false) { return oauthConfig(env.GOOGLE_CLIENT_ID, env.GOOGLE_CLIENT_SECRET, env.OIDC_REDIRECT_ORIGINS, allowLoopbackHttp); }
// Staff sign-in (ADR-0006) reads only the staff variables, never the customer client.
export function googleStaffConfig(env, allowLoopbackHttp = false) { return oauthConfig(env.GOOGLE_STAFF_CLIENT_ID, env.GOOGLE_STAFF_CLIENT_SECRET, env.STAFF_OIDC_REDIRECT_ORIGINS, allowLoopbackHttp); }

export async function authorizationUrl({ clientId, redirectUri, state, nonce, verifier, scope = 'openid email profile' }) {
  const url = new URL(GOOGLE_AUTH_URL);
  url.search = new URLSearchParams({ client_id: clientId, redirect_uri: redirectUri, response_type: 'code', scope, state, nonce, code_challenge: await pkceChallenge(verifier), code_challenge_method: 'S256', prompt: 'select_account' }).toString();
  return url.href;
}

async function readLimited(response) {
  const reader = response.body?.getReader(); if (!reader) throw new Error('Empty response');
  const chunks = []; let size = 0;
  try { while (true) { const { done, value } = await reader.read(); if (done) break; size += value.byteLength; if (size > MAX_BODY) { await reader.cancel(); throw new Error('Response too large'); } chunks.push(value); } } finally { reader.releaseLock(); }
  const bytes = new Uint8Array(size); let offset = 0; for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length; }
  return new TextDecoder().decode(bytes);
}

export async function exchangeCode(config, { code, verifier, redirectUri }) {
  const response = await fetch(TOKEN_URL, {
    method: 'POST', redirect: 'manual', signal: AbortSignal.timeout(10000),
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
    body: new URLSearchParams({ grant_type: 'authorization_code', code, code_verifier: verifier, redirect_uri: redirectUri, client_id: config.clientId, client_secret: config.clientSecret }),
  });
  if (!response.ok) { await response.body?.cancel(); throw new Error('Token exchange rejected'); }
  const body = JSON.parse(await readLimited(response));
  if (!body || typeof body.id_token !== 'string' || body.id_token.length > 16000) throw new Error('No ID token'); // access/refresh tokens are discarded
  return body.id_token;
}

async function loadKeys(now) {
  const response = await fetch(JWKS_URL, { redirect: 'manual', signal: AbortSignal.timeout(10000), headers: { Accept: 'application/json' } });
  if (!response.ok) { await response.body?.cancel(); throw new Error('Google keys unavailable'); }
  const body = JSON.parse(await readLimited(response));
  if (!Array.isArray(body?.keys) || body.keys.length > MAX_KEYS) throw new Error('Invalid Google keys');
  const maxAge = Number(/max-age=(\d+)/i.exec(response.headers.get('Cache-Control') ?? '')?.[1]);
  const ttl = Math.min(86400, Math.max(300, Number.isFinite(maxAge) ? maxAge : 3600)) * 1000;
  cache = { keys: body.keys, expires: now + ttl, fetchedAt: now };
}
async function keyFor(kid, now) {
  if (!cache || cache.expires <= now) await loadKeys(now);
  let jwk = cache.keys.find(key => key?.kid === kid);
  if (!jwk && now - cache.fetchedAt >= 60000) { await loadKeys(now); jwk = cache.keys.find(key => key?.kid === kid); }
  return jwk;
}

// Returns {sub,email}. email is non-null only when Google asserts email_verified === true. Throws on any invalid token.
export async function verifyGoogleIdToken(token, { clientId, nonce, maxIatAgeSeconds = 600 }) {
  if (typeof token !== 'string' || token.length > 16000 || typeof nonce !== 'string' || !nonce || typeof clientId !== 'string' || !clientId) throw new Error('Invalid token');
  const parts = token.split('.'); if (parts.length !== 3) throw new Error('Invalid token');
  const header = decodeJson(parts[0]), payload = decodeJson(parts[1]);
  if (header.alg !== 'RS256' || typeof header.kid !== 'string' || !header.kid || header.kid.length > 200) throw new Error('Invalid header');
  const now = Date.now(), seconds = Math.floor(now / 1000);
  if (!ISSUERS.includes(payload.iss)) throw new Error('Invalid issuer');
  const audiences = Array.isArray(payload.aud) ? payload.aud : [payload.aud];
  if (!audiences.includes(clientId)) throw new Error('Invalid audience');
  if (Array.isArray(payload.aud) ? payload.azp !== clientId : (payload.azp !== undefined && payload.azp !== clientId)) throw new Error('Invalid authorized party');
  if (typeof payload.exp !== 'number' || !Number.isFinite(payload.exp) || payload.exp <= seconds) throw new Error('Expired');
  if (typeof payload.iat !== 'number' || !Number.isFinite(payload.iat) || payload.iat > seconds + 60 || payload.iat < seconds - maxIatAgeSeconds) throw new Error('Invalid issue time');
  if (typeof payload.nonce !== 'string' || payload.nonce !== nonce) throw new Error('Invalid nonce');
  if (typeof payload.sub !== 'string' || !payload.sub || payload.sub.length > 255) throw new Error('Invalid subject');
  const jwk = await keyFor(header.kid, now);
  if (!jwk || jwk.kty !== 'RSA' || (jwk.alg && jwk.alg !== 'RS256') || (jwk.use && jwk.use !== 'sig')) throw new Error('Unknown key');
  const key = await crypto.subtle.importKey('jwk', jwk, { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' }, false, ['verify']);
  if (!await crypto.subtle.verify('RSASSA-PKCS1-v1_5', key, decodeBase64Url(parts[2]), new TextEncoder().encode(`${parts[0]}.${parts[1]}`))) throw new Error('Bad signature');
  const email = payload.email_verified === true && typeof payload.email === 'string' && payload.email.length <= 320 && /^\S+@\S+\.\S+$/.test(payload.email) ? payload.email : null;
  return { sub: payload.sub, email };
}
