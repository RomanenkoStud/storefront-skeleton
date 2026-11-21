// Same-origin account calls. Unlike api(), these expose Retry-After and never throw on network failure ambiguity.

let sessionPromise = null;

async function post(path) {
  const response = await fetch(path, { method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': 'application/json' }, body: '{}' });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) {
    const error = new Error(body.error || `Помилка запиту (${response.status}).`);
    error.status = response.status;
    error.retryAfter = response.headers.get('Retry-After');
    throw error;
  }
  return body;
}

/** One session request per page load, shared by the header and the account page. */
export function fetchSession(force = false) {
  if (!sessionPromise || force) {
    sessionPromise = fetch('/api/account/session', { credentials: 'same-origin', headers: { Accept: 'application/json' } })
      .then(r => (r.ok ? r.json() : { authenticated: false, failed: true }))
      .catch(() => ({ authenticated: false, failed: true }));
  }
  return sessionPromise;
}
export const startGoogle = () => post('/api/account/google/start');
export const logout = () => post('/api/account/logout');
export const revokeAll = () => post('/api/account/sessions/revoke-all');
