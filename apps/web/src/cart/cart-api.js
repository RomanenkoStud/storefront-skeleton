// Same-origin cart calls. Unlike api(), these expose Retry-After and per-line problems.

import { MAX_QUANTITY } from '../../../../packages/catalog/cart.js';
import { lineKey } from './cart-store.js';
import { fromPreference, toDeliveryInput } from '../delivery/np-picker-logic.js';
import { recipientLine, TERMS_ACCEPTED_LINE } from './checkout-steps.js';

export function parseAddParams(search) {
  const params = new URLSearchParams(search || '');
  const slug = params.get('add');
  if (!slug) return null;
  const qty = Number.parseInt(params.get('qty') || '1', 10);
  return { slug: slug.trim(), size: (params.get('size') || '').trim(), qty: Number.isInteger(qty) && qty > 0 ? Math.min(qty, MAX_QUANTITY) : 1 };
}
export function cleanedCartUrl(pathname, search, hash = '') {
  const params = new URLSearchParams(search || '');
  for (const k of ['add', 'size', 'qty']) params.delete(k);
  const rest = params.toString();
  return `${pathname}${rest ? `?${rest}` : ''}${hash}`;
}

async function request(path, options, fetchImpl) {
  const response = await fetchImpl(path, { credentials: 'same-origin', ...options, headers: { Accept: 'application/json', ...(options?.body ? { 'Content-Type': 'application/json' } : {}) } });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) {
    const error = new Error(body.error || `Помилка запиту (${response.status}).`);
    error.status = response.status;
    error.code = body.error || '';
    error.problems = Array.isArray(body.problems) ? body.problems : [];
    error.retryAfter = response.headers?.get?.('Retry-After') ?? null;
    throw error;
  }
  return body;
}

export const fetchProduct = (slug, fetchImpl = globalThis.fetch) => request(`/api/products/${encodeURIComponent(slug)}`, { method: 'GET' }, fetchImpl);
export const fetchAccountCarts = (fetchImpl = globalThis.fetch) => request('/api/account/carts', { method: 'GET' }, fetchImpl);
/** Resolves {cart}. Rejects with {status, code, problems, retryAfter}. */
export function checkout(lines, fetchImpl = globalThis.fetch, { delivery = null, recipient = null } = {}) {
  const payload = { lines: lines.map(l => ({ productId: l.productId, size: l.size, quantity: l.quantity })) };
  if (delivery?.warehouseRef) payload.delivery = { warehouseRef: delivery.warehouseRef }; // ADR-0011 s8: only {warehouseRef}; omitted when there is no point
  // signed-in only (checkoutRecipient); exactly the four keys, never a display `name`.
  if (recipient?.lastName && recipient?.firstName && recipient?.middleName && recipient?.phone) payload.recipient = { lastName: recipient.lastName, firstName: recipient.firstName, middleName: recipient.middleName, phone: recipient.phone };
  const body = JSON.stringify(payload);
  return request('/api/cart/checkout', { method: 'POST', body }, fetchImpl);
}

const PROBLEM_TEXT = {
  product_unavailable: 'Товар більше недоступний. Видаліть його з кошика.',
  size_unavailable: 'Цього розміру більше немає. Видаліть рядок і оберіть інший розмір.',
  insufficient_stock: available => (Number.isInteger(available) && available > 0 ? `Доступно лише ${available} шт. Зменште кількість.` : 'Недостатньо в наявності. Зменште кількість.'),
  invalid_quantity: 'Кількість має бути від 1 до 10.',
  invalid_size: 'Оберіть розмір.',
  invalid_product_id: 'Некоректний товар. Видаліть рядок.',
  invalid_line: 'Некоректний рядок. Видаліть його.',
  duplicate_line: 'Такий розмір уже є в кошику. Об’єднайте рядки.',
};
export function problemText(problem) {
  const t = PROBLEM_TEXT[problem?.code];
  return typeof t === 'function' ? t(problem.available) : t || 'Перевірте цей рядок.';
}
/** Maps per-line problems onto line indexes. Returns {byLine: {[index]: {code,text,available?}}, general: string[]}. */
export function mapProblems(problems, lineCount) {
  const byLine = {}, general = [];
  for (const p of Array.isArray(problems) ? problems : []) {
    if (Number.isInteger(p.index) && p.index >= 0 && p.index < lineCount) byLine[p.index] = { code: p.code, text: problemText(p), available: p.available };
    else general.push(p.code === 'too_many_lines' ? 'У кошику забагато позицій (максимум 20).' : p.code === 'lines_required' ? 'Кошик порожній.' : problemText(p));
  }
  return { byLine, general };
}
/** Like mapProblems but keyed by productId+size of the SUBMITTED lines, so later edits cannot shift the mapping. */
export function mapProblemsToLines(problems, submitted) {
  const { byLine, general } = mapProblems(problems, submitted.length);
  const byKey = {};
  for (const [index, problem] of Object.entries(byLine)) byKey[lineKey(submitted[index])] = problem;
  return { byKey, general };
}
export const DELIVERY_ERROR_TEXT = {
  delivery_unavailable: 'Цей пункт більше не приймає посилки. Оберіть інший.',
  delivery_catalog_unavailable: 'Довідник Нової пошти зараз недоступний. Можна оформити кошик без пункту доставки.',
  invalid_delivery: 'Перевірте пункт доставки.',
};
/** The delivery-specific error code of a checkout failure, or '' (400/409 also carry per-line problems). */
export const deliveryErrorCode = error => (Object.hasOwn(DELIVERY_ERROR_TEXT, error?.code) ? error.code : '');
/** Origin hint for the prefilled favourite (ADR-0011 s8). Only np-api preferences are prefilled. */
export const prefillHint = preference => (preference?.origin === 'checkout' ? 'Пункт з вашого останнього замовлення' : 'Ваш улюблений пункт');
export const ANONYMOUS_HINT = 'Пункт буде додано до повідомлення для менеджера. Увійдіть, щоб ми його запамʼятали.';
/** What the body may carry: only a signed-in session (known) with a chosen point; anonymous, unknown session or no point -> null. */
export const checkoutDelivery = ({ signed, point, withoutPoint = false }) => (signed === true && !withoutPoint ? toDeliveryInput(point) : null);
/** Prefill from a profile: {value, ref, hint} only for an np-api preference with a Ref and only before the user touched the picker. */
export function prefillFromProfile(profile, touched = false) {
  if (touched) return null;
  const value = fromPreference(profile?.deliveryPreference);
  return value ? { value, ref: value.warehouseRef, origin: profile.deliveryPreference.origin ?? null, hint: prefillHint(profile.deliveryPreference) } : null;
}
export const OVERRIDE_HINT = 'Зміна діє лише для цього замовлення.';
export const REMEMBER_HINT = 'Цей пункт запамʼятаємо для наступних замовлень.';
/** Hint under the picker. signed: true | false | null (unknown); prefilled: result of prefillFromProfile. */
export function deliveryHint({ signed, point, prefilled }) {
  if (signed === false) return ANONYMOUS_HINT;
  if (signed !== true || !point) return '';
  if (prefilled && prefilled.ref === point.warehouseRef) return prefilled.hint;
  return prefilled?.origin === 'cabinet' ? OVERRIDE_HINT : REMEMBER_HINT;
}
export const RECIPIENT_ERROR_TEXT = 'Перевірте прізвище, імʼя, по батькові та номер телефону отримувача.';
export function checkoutErrorText(error) {
  const delivery = deliveryErrorCode(error);
  if (delivery) return DELIVERY_ERROR_TEXT[delivery];
  if (error?.code === 'invalid_recipient') return RECIPIENT_ERROR_TEXT;
  if (error?.status === 429) {
    const s = Number.parseInt(error.retryAfter, 10);
    return Number.isFinite(s) && s > 0 ? `Забагато спроб. Спробуйте ще раз приблизно за ${Math.max(1, Math.ceil(s / 60))} хв.` : 'Забагато спроб. Спробуйте ще раз трохи пізніше.';
  }
  if (error?.status === 400 || error?.status === 409) return 'Деякі позиції потребують уваги. Виправте їх і повторіть.';
  if (error?.status === 403 || error?.status === 415) return 'Запит відхилено. Оновіть сторінку й спробуйте ще раз.';
  return 'Не вдалося створити код кошика. Перевірте з’єднання й спробуйте ще раз. Кошик збережено.';
}

/** «Доставка: Нова пошта, {cityName}, {warehouseName}» for a CartDelivery or PickerValue; '' without a point. */
export function deliveryLine(point) {
  if (!point?.cityName) return '';
  return `Доставка: Нова пошта, ${point.cityName}, ${point.warehouseName || `№${point.warehouseNumber ?? ''}`}`;
}
/** termsAccepted: the checkout's terms box was ticked in this browser; adds TERMS_ACCEPTED_LINE before the closing request. */
export function managerMessage(cart, formatMoney = v => `${v / 100} ₴`, point = cart.delivery, recipient = cart.recipient, termsAccepted = false) {
  const delivery = deliveryLine(point), contact = recipientLine(recipient);
  const lines = (cart.lines || []).map(l => `- ${l.title} (${l.size}) × ${l.quantity}`).join('\n');
  return `Вітаю! Це мій код кошика на Lorem Store: ${cart.code}.\n${lines ? `Склад:\n${lines}\n` : ''}Сума: ${formatMoney(cart.totalMinor)}.\n${contact ? `${contact}\n` : ''}${delivery ? `${delivery}\n` : ''}${termsAccepted === true ? `${TERMS_ACCEPTED_LINE}\n` : ''}Будь ласка, перевірте замовлення.`;
}

/** Clipboard with a textarea/execCommand fallback. Returns true when copied. */
export async function copyText(text, env = globalThis) {
  try {
    if (env.navigator?.clipboard?.writeText) { await env.navigator.clipboard.writeText(text); return true; }
  } catch { /* fall through to the legacy path */ }
  try {
    const doc = env.document;
    if (!doc?.createElement) return false;
    const previous = doc.activeElement;
    const area = doc.createElement('textarea');
    area.value = text; area.setAttribute('readonly', ''); area.style.position = 'fixed'; area.style.opacity = '0';
    doc.body.appendChild(area); area.select();
    const ok = doc.execCommand?.('copy') === true;
    doc.body.removeChild(area);
    previous?.focus?.();
    return ok;
  } catch { return false; }
}

export const ADD_STATUS_TEXT = {
  added: 'Додано до кошика.',
  merged: 'Кількість збільшено в наявній позиції.',
  capped: 'Додано до максимуму: 10 шт. однієї позиції.',
  stock_capped: 'Додано стільки, скільки є в наявності.',
  full: 'Кошик заповнений (максимум 20 позицій). Оформіть його або видаліть позицію.',
  unavailable: 'Цього розміру немає в наявності.',
  invalid: 'Оберіть розмір.',
  no_size: 'Оберіть розмір на сторінці товару.',
};
