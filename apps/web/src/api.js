export const staffEntry = (pathname = globalThis.location?.pathname || '') => pathname === '/staff' || pathname.startsWith('/staff/');
export function apiPath(path, pathname = globalThis.location?.pathname || '') {
  if (!staffEntry(pathname)) return path;
  if (path === '/api/auth/session') return '/api/staff/session';
  return /^\/api\/admin(?:[/?]|$)/.test(path) ? path.replace('/api/admin', '/api/staff/admin') : path;
}
export async function api(path, options = {}) {
  const response = await fetch(apiPath(path), {
    credentials: 'same-origin',
    ...options,
    headers: { ...(options.body && !(options.body instanceof FormData) ? { 'Content-Type': 'application/json' } : {}), ...options.headers },
    body: options.body instanceof FormData || options.body === undefined ? options.body : JSON.stringify(options.body),
  });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) {
    const error = new Error(body.error || `Помилка запиту (${response.status}). Спробуйте ще раз.`);
    error.status = response.status;
    if (typeof body.code === 'string') error.code = body.code;
    error.reauth = body.reauth === true;
    if (error.reauth && typeof window !== 'undefined') window.dispatchEvent(new Event('staff-reauth-required'));
    throw error;
  }
  return body;
}

export const money = (minor = 0) => new Intl.NumberFormat('uk-UA', { style: 'currency', currency: 'UAH', maximumFractionDigits: 2 }).format(minor / 100);
export const date = (value) => value ? new Intl.DateTimeFormat('uk-UA', { dateStyle: 'short', timeStyle: 'short' }).format(new Date(value)) : 'Ще не синхронізовано';
