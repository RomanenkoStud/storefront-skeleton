// Read-only calls to our own Nova Poshta snapshot (ADR-0011 section 4). Keyless, same-origin, GET only.
// Coordinates never reach this module: its only inputs are a city query, a city Ref and a kind.

export const UNAVAILABLE_TEXT = 'Довідник Нової пошти зараз недоступний.';
const DEFAULT_ERROR_TEXT = 'Не вдалося завантажити дані. Спробуйте ще раз.';

/** Fixed Ukrainian text per documented error code or status. Server text is never shown. */
export const ERROR_TEXT = {
  catalog_unavailable: UNAVAILABLE_TEXT,
  invalid_request: 'Перевірте запит і спробуйте ще раз.',
  not_found: DEFAULT_ERROR_TEXT,
  method_not_allowed: DEFAULT_ERROR_TEXT,
};
const NETWORK_CODE = 'network';
const BAD_RESPONSE_CODE = 'bad_response';

export class NpApiError extends Error {
  constructor({ status = 0, code = '', unavailable = false }) {
    super(unavailable ? UNAVAILABLE_TEXT : ERROR_TEXT[code] || DEFAULT_ERROR_TEXT);
    this.name = 'NpApiError';
    this.status = status;
    this.code = code;
    /** true: the picker must disable itself (503 catalog_unavailable, network failure, unreadable body). */
    this.unavailable = unavailable;
  }
}

export const isAbort = error => error?.name === 'AbortError';

const isText = v => typeof v === 'string' && v !== '';
const coordinate = v => (typeof v === 'number' && Number.isFinite(v) ? v : null);
const count = v => (Number.isInteger(v) && v >= 0 ? v : 0);
/** Drops malformed items instead of letting them reach the UI: a city or point needs a text ref and name. */
function cleanCity(item) {
  if (!item || !isText(item.ref) || !isText(item.name)) return null;
  return { ref: item.ref, name: item.name, area: typeof item.area === 'string' ? item.area : '', branches: count(item.branches), postomats: count(item.postomats) };
}
function cleanPoint(item) {
  if (!item || !isText(item.ref) || !isText(item.name)) return null;
  if (item.number !== null && typeof item.number !== 'string') return null;
  return { ref: item.ref, number: item.number, name: item.name, lat: coordinate(item.lat), lon: coordinate(item.lon) };
}

async function getJson(fetchImpl, url, signal, clean) {
  let response;
  try {
    response = await fetchImpl(url, { method: 'GET', headers: { Accept: 'application/json' }, signal });
  } catch (error) {
    if (isAbort(error)) throw error;
    throw new NpApiError({ code: NETWORK_CODE, unavailable: true });
  }
  let body = null;
  try { body = await response.json(); } catch (error) { if (isAbort(error)) throw error; }
  if (!response.ok) {
    const code = typeof body?.error === 'string' ? body.error : '';
    throw new NpApiError({ status: response.status, code, unavailable: response.status === 503 || code === 'catalog_unavailable' });
  }
  if (!body || typeof body !== 'object' || !Array.isArray(body.items)) throw new NpApiError({ status: response.status, code: BAD_RESPONSE_CODE, unavailable: true });
  return { ...body, items: body.items.map(clean).filter(Boolean) };
}

/** @returns {{searchCities(q, opts?): Promise<{generatedAt, items}>, loadPoints(cityRef, kind, opts?): Promise<{cityRef, kind, generatedAt, items}>}} */
export function createNpApi(fetchImpl = (...args) => globalThis.fetch(...args)) {
  return {
    searchCities(q, { signal } = {}) {
      return getJson(fetchImpl, `/api/delivery/np/cities?${new URLSearchParams({ q })}`, signal, cleanCity);
    },
    loadPoints(cityRef, kind, { signal } = {}) {
      return getJson(fetchImpl, `/api/delivery/np/warehouses?${new URLSearchParams({ cityRef, kind })}`, signal, cleanPoint);
    },
  };
}

const shared = createNpApi();
export const searchCities = (q, options) => shared.searchCities(q, options);
export const loadPoints = (cityRef, kind, options) => shared.loadPoints(cityRef, kind, options);
