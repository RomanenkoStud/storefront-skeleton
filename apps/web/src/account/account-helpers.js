// Pure helpers for the client account UI (no DOM or React).

const CALLBACK_REASONS = {
  invalid: 'Не вдалося підтвердити вхід. Спробуйте ще раз.',
  expired: 'Час входу минув. Спробуйте увійти ще раз.',
  denied: 'Вхід скасовано. Ви не надали доступ у Google.',
};
const GENERIC_ERROR = 'Не вдалося увійти. Спробуйте ще раз.';

/** Maps /account?status=...&reason=... to a message, or null when there is nothing to show. */
export function callbackMessage(search = '') {
  const params = new URLSearchParams(search);
  const status = params.get('status');
  if (status === 'signed-in') return { type: 'success', text: 'Ви успішно увійшли в кабінет.' };
  if (status === 'error') {
    const reason = params.get('reason');
    return { type: 'error', text: Object.prototype.hasOwnProperty.call(CALLBACK_REASONS, reason) ? CALLBACK_REASONS[reason] : GENERIC_ERROR };
  }
  return null;
}

/** Removes status/reason (only) from a query string and returns the cleaned URL suffix. */
export function cleanedUrl(pathname, search = '', hash = '') {
  const params = new URLSearchParams(search);
  params.delete('status');
  params.delete('reason');
  const query = params.toString();
  return `${pathname}${query ? `?${query}` : ''}${hash}`;
}

/** Retry-After seconds (or HTTP date) to whole seconds; null when unusable. */
export function parseRetryAfter(value, now = Date.now()) {
  if (value === null || value === undefined || value === '') return null;
  const seconds = Number(value);
  if (Number.isFinite(seconds) && seconds >= 0) return Math.ceil(seconds);
  const at = Date.parse(value);
  return Number.isNaN(at) ? null : Math.max(0, Math.ceil((at - now) / 1000));
}

/** Friendly Ukrainian message for a failed sign-in start. */
export function startErrorMessage(status, retryAfter = null) {
  if (status === 503) return 'Вхід тимчасово недоступний. Спробуйте пізніше.';
  if (status === 429) {
    const wait = parseRetryAfter(retryAfter);
    return wait ? `Забагато спроб. Спробуйте ще раз приблизно через ${wait} с.` : 'Забагато спроб. Спробуйте трохи пізніше.';
  }
  if (status === undefined || status === null || status === 0) return 'Немає зв’язку із сервером. Перевірте інтернет і спробуйте ще раз.';
  return 'Не вдалося розпочати вхід. Спробуйте ще раз.';
}

/** Production: only https://accounts.google.com. Loopback http is allowed only when the page itself is on loopback. */
const LOOPBACK = ['localhost', '127.0.0.1', '[::1]'];
export function safeAuthorizationUrl(value, pageHostname = '') {
  try {
    const url = new URL(value);
    if (url.protocol === 'https:' && url.hostname === 'accounts.google.com' && url.port === '' && !url.username && !url.password) return url.toString();
    if (LOOPBACK.includes(pageHostname) && LOOPBACK.includes(url.hostname) && (url.protocol === 'http:' || url.protocol === 'https:')) return url.toString();
    return null;
  } catch { return null; }
}

/** Short visible handle: first non-empty of signInEmail, displayName. */
export function customerHandle(customer) {
  return customer?.signInEmail || customer?.displayName || 'Кабінет';
}

export const PROVIDER_LABELS = { google: 'Google', telegram: 'Telegram' };
export function providerLabels(providers = []) {
  return providers.map(p => PROVIDER_LABELS[p] || p);
}

// ---- Cabinet delivery card (ADR-0011 sections 5-7) ----

import { NOTE_MAX } from '../delivery/profile-delivery.js';
export { NOTE_MAX };
export const ORIGIN_LABELS = Object.freeze({ cabinet: 'Улюблений', checkout: 'Запамʼятали з останнього замовлення' });
export const LEGACY_PROMPT = 'Оберіть пункт із довідника, щоб використовувати його для замовлень';
const KIND_LABELS = { branch: 'Відділення', postomat: 'Поштомат' };

/** Fixed texts per failed profile save. Only cabinet-specific overrides (401, network) differ from the shared client texts. */
const SAVE_TEXT = {
  400: 'Не вдалося зберегти пункт. Оберіть його зі списку й спробуйте ще раз.',
  429: 'Забагато спроб. Спробуйте ще раз трохи пізніше.',
  503: 'Довідник Нової пошти зараз недоступний. Спробуйте пізніше.',
};
export function deliveryErrorMessage(status) {
  if (status === 401) return 'Сесія завершена. Оновіть сторінку й увійдіть знову.';
  if (!status) return 'Немає зв’язку із сервером. Перевірте інтернет і спробуйте ще раз.';
  return SAVE_TEXT[status] || 'Не вдалося виконати запит. Спробуйте ще раз.';
}
export const DELIVERY_LOAD_ERROR = 'Не вдалося завантажити доставку. Оновіть сторінку.';
export const NOTE_RULE_MESSAGE = 'Примітка може мати щонайбільше два рядки й лише звичайні символи.';

/** Readable point text from any stored point (preference or cart delivery); tolerates legacy rows without name or Ref. */
export function pointText(point) {
  if (!point || !point.cityName) return '';
  const kind = KIND_LABELS[point.type] || 'Нова пошта';
  const place = point.warehouseName || (point.warehouseNumber ? `№${point.warehouseNumber}` : '');
  return place ? `${kind}, ${point.cityName}: ${place}` : `${kind}, ${point.cityName}`;
}

/**
 * What the cabinet card shows for a Profile.deliveryPreference.
 * kind: 'none' | 'legacy' (read-only, never a favourite) | 'favourite'.
 * canPromote: an auto-remembered (origin "checkout") favourite can become a cabinet favourite.
 */
export function deliveryView(preference) {
  if (!preference || !preference.cityName) return { kind: 'none' };
  if (preference.source !== 'np-api' || !preference.warehouseRef) {
    return { kind: 'legacy', text: pointText(preference), note: preference.note || null, prompt: LEGACY_PROMPT };
  }
  return {
    kind: 'favourite', text: pointText(preference), note: preference.note || null,
    originLabel: ORIGIN_LABELS[preference.origin] || ORIGIN_LABELS.cabinet, canPromote: preference.origin === 'checkout',
  };
}

/** Code points, as the server counts them. */
export const noteLength = text => [...String(text ?? '')].length;

/** Note as typed -> the value to send: trimmed string, or null when blank. Mirrors the server rules; returns {error} otherwise. */
export function noteForSave(text) {
  const trimmed = String(text ?? '').trim();
  if (!trimmed) return { note: null };
  if (noteLength(trimmed) > NOTE_MAX) return { error: `Примітка має бути не довшою за ${NOTE_MAX} символів.` };
  if (/[^\P{Cc}\n]/u.test(trimmed) || /\p{Cf}/u.test(trimmed) || !/[\p{L}\p{N}\p{P}\p{S}]/u.test(trimmed) || trimmed.split('\n').length > 2) return { error: NOTE_RULE_MESSAGE };
  return { note: trimmed };
}

/** Delivery line for a cart in the cabinet list. */
export function cartDeliveryText(delivery) {
  return delivery ? pointText(delivery) || 'Пункт не вказано' : 'Пункт доставки не обрано';
}
