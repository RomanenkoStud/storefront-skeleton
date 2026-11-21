// Profile calls for the delivery preference (ADR-0011 sections 5 and 11, docs/API.md).
// The body is only {deliveryPreference:{warehouseRef, note}} or {deliveryPreference:null}; display fields never leave the browser.

const GUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
export const NOTE_MAX = 200;

const STATUS_TEXT = {
  400: 'Не вдалося зберегти пункт. Оберіть його зі списку й спробуйте ще раз.',
  401: 'Увійдіть в акаунт, щоб зберегти пункт.',
  429: 'Забагато спроб. Спробуйте ще раз трохи пізніше.',
  503: 'Довідник Нової пошти зараз недоступний. Спробуйте пізніше.',
};

function failure(status, retryAfter = null) {
  const error = new Error(STATUS_TEXT[status] || 'Не вдалося виконати запит. Спробуйте ще раз.');
  error.status = status;
  error.retryAfter = retryAfter;
  return error;
}

async function request(path, options, fetchImpl) {
  let response;
  try {
    response = await fetchImpl(path, { credentials: 'same-origin', ...options, headers: { Accept: 'application/json', ...(options.body ? { 'Content-Type': 'application/json' } : {}) } });
  } catch {
    throw failure(0);
  }
  const body = await response.json().catch(() => ({}));
  if (!response.ok) throw failure(response.status, response.headers?.get?.('Retry-After') ?? null);
  return body;
}

/** The only body the preference PATCH may carry. Throws a status-400 error for input the server would reject anyway. */
export function buildPreferenceBody(warehouseRef, note) {
  if (warehouseRef === null || warehouseRef === undefined) return { deliveryPreference: null };
  const ref = typeof warehouseRef === 'string' ? warehouseRef.trim().toLowerCase() : '';
  if (!GUID.test(ref)) throw failure(400);
  const preference = { warehouseRef: ref };
  if (note !== undefined) {
    const text = note === null ? '' : String(note).trim();
    if ([...text].length > NOTE_MAX) throw failure(400);
    preference.note = text || null;
  }
  return { deliveryPreference: preference };
}

export const fetchProfile = (fetchImpl = (...a) => globalThis.fetch(...a)) => request('/api/account/profile', { method: 'GET' }, fetchImpl);

/** Resolves the updated Profile. Rejects with {status, retryAfter, message}; status 0 is a network failure. */
export function saveDeliveryPreference(warehouseRefOrNull, note, fetchImpl = (...a) => globalThis.fetch(...a)) {
  let body;
  try { body = buildPreferenceBody(warehouseRefOrNull, note); } catch (error) { return Promise.reject(error); }
  return request('/api/account/profile', { method: 'PATCH', body: JSON.stringify(body) }, fetchImpl);
}

/** Contacts used to prefill the checkout recipient (three-part ПІБ): {lastName, firstName, middleName, phone}; '' clears a field (sent as null). displayName is left untouched. */
export function buildContactsBody({ lastName, firstName, middleName, phone }) {
  const clean = value => String(value ?? '').trim() || null;
  return { lastName: clean(lastName), firstName: clean(firstName), middleName: clean(middleName), phone: clean(phone) };
}
export function saveContacts(contacts, fetchImpl = (...a) => globalThis.fetch(...a)) {
  return request('/api/account/profile', { method: 'PATCH', body: JSON.stringify(buildContactsBody(contacts)) }, fetchImpl);
}
