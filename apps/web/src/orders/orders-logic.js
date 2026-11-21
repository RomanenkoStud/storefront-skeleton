import { api } from '../api.js';
import { normalizeCode, CART_STATUSES, ORDER_PD_RETENTION, PD_ERASED_LABEL } from '../../../../packages/catalog/cart.js';
import { formatPhone } from '../cart/checkout-steps.js';
import { normalizeUaPhone } from '../../../../packages/catalog/recipient.js';

export { PD_ERASED_LABEL };

export const PAGE_SIZE = 40;
export const NOTE_MAX = 500;
export const STATUS_LABELS = {
  submitted: 'Подано',
  verified: 'Перевірено',
  sent_to_suppliers: 'Передано постачальникам',
  completed: 'Виконано',
  cancelled: 'Скасовано',
};
export const STATUS_FILTERS = [['', 'Усі статуси'], ...CART_STATUSES.map(s => [s, STATUS_LABELS[s]])];
export const ACTION_LABELS = {
  verified: 'Перевірити',
  sent_to_suppliers: 'Позначити як передане постачальникам',
  completed: 'Позначити як виконане',
  cancelled: 'Скасувати кошик',
};
export const ERROR_LABELS = {
  invalid_code: 'Некоректний код кошика.',
  not_found: 'Кошик із таким кодом не знайдено.',
  invalid_transition: 'Цей перехід статусу недоступний.',
  invalid_request: 'Некоректний запит. Перевірте нотатку (до 500 символів).',
  status_conflict: 'Статус кошика вже змінили.',
};
export const statusLabel = status => STATUS_LABELS[status] || status || '—';
export const errorText = error => ERROR_LABELS[error?.message] || error?.message || 'Не вдалося виконати запит. Спробуйте ще раз.';

/** Forgiving lookup: returns {code} or {error} for inline feedback. */
export function parseLookup(input) {
  const raw = String(input ?? '').trim();
  if (!raw) return { error: 'Введіть код кошика, наприклад SS-7K2M-9QXD.' };
  const code = normalizeCode(raw);
  return code ? { code } : { error: 'Код має вигляд SS-XXXX-XXXX (8 символів: цифри та літери без I, L, O, U).' };
}

export function listPath({ status = '', q = '', page = 1 } = {}) {
  const params = new URLSearchParams();
  if (CART_STATUSES.includes(status)) params.set('status', status);
  const query = String(q).trim();
  if (query) params.set('q', query);
  params.set('page', String(Math.max(1, Number.isInteger(page) ? page : 1)));
  return `/api/admin/carts?${params}`;
}
export const detailPath = code => `/api/admin/carts/${encodeURIComponent(code)}`;
export const pageCount = (total, pageSize = PAGE_SIZE) => Math.max(1, Math.ceil((total || 0) / pageSize));

export const listCarts = filters => api(listPath(filters));
export async function loadCart(code) { return (await api(detailPath(code))).cart; }

/**
 * POSTs a transition with optimistic concurrency. Resolves {cart} or, on 409,
 * {conflict:true, cart} where cart is the freshly reloaded current state.
 */
export async function changeStatus(cart, status, note = '') {
  const body = { status, expectedStatus: cart.status };
  const trimmed = String(note).trim();
  if (trimmed) body.note = trimmed.slice(0, NOTE_MAX);
  try {
    return { cart: (await api(`${detailPath(cart.code)}/status`, { method: 'POST', body })).cart };
  } catch (error) {
    if (error.status !== 409) throw error;
    return { conflict: true, cart: await loadCart(cart.code) };
  }
}

/** Groups lines by supplier, keeping first-seen order. */
export function groupBySupplier(lines = []) {
  const groups = new Map();
  for (const line of lines) {
    const key = line.supplierId ?? line.supplierName ?? '';
    if (!groups.has(key)) groups.set(key, { supplierId: line.supplierId, supplierName: line.supplierName || 'Без назви', lines: [], quantity: 0, costMinor: 0, costKnown: true });
    const group = groups.get(key);
    group.lines.push(line);
    group.quantity += line.quantity;
    if (line.unitCostMinor == null) group.costKnown = false; else group.costMinor += line.unitCostMinor * line.quantity;
  }
  return [...groups.values()];
}

const moneyText = minor => (minor / 100).toFixed(2);
/** Plain-text hand-off for one supplier, to paste into a manual order. */
export function supplierSummary(group, cart) {
  const rows = group.lines.map((l, i) => [
    `${i + 1}. ${l.title}`,
    `   Артикул постачальника: ${l.externalProductId}`,
    `   Розмір: ${l.size}; кількість: ${l.quantity}`,
    `   Закупівля: ${l.unitCostMinor == null ? 'невідомо' : `${moneyText(l.unitCostMinor)} ${cart.currency || 'UAH'}`}`,
    `   ID варіантів: ${(l.variantIds || []).join(', ') || '—'}`,
  ].join('\n'));
  return [`Замовлення ${cart.code} — ${group.supplierName}`, `Позицій: ${group.lines.length}, одиниць: ${group.quantity}`, ...rows].join('\n');
}

export const canOperate = (permissions = []) => permissions.includes('orders.operate');
export const visibleActions = (cart, permissions = []) => canOperate(permissions) ? (cart?.allowedTransitions || []).filter(s => ACTION_LABELS[s]) : [];

// ---- order personal data: the order's own recipient and Nova Poshta point, shown to everyone with orders.read ----
export const POINT_KIND_LABELS = { branch: 'Відділення', postomat: 'Поштомат' };
export const NOTE_PRIVACY_HINT = 'Не записуйте в нотатку ПІБ, телефон чи адресу клієнта: нотатка не видаляється разом із персональними даними.';
export const RETENTION_HINT = `ПІБ, телефон і пункт доставки видаляються через ${ORDER_PD_RETENTION.closedDays} днів після статусу «Виконано» або «Скасовано», а якщо замовлення не закрили — через ${ORDER_PD_RETENTION.maxDays} днів після створення.`;
export const isErased = cart => Boolean(cart?.personalDataErasedAt);
/** {name, phone (display), tel (E.164 for a tel: link, or null)} for a StaffCartRecipient; null without one. */
export function recipientView(recipient) {
  if (!recipient?.name || !recipient.phone) return null;
  return { name: recipient.name, phone: formatPhone(recipient.phone), tel: normalizeUaPhone(recipient.phone) || null };
}
/** {kind: «Поштомат №1001», city, name} for a StaffCartDelivery; null without one. */
export function deliveryView(delivery) {
  if (!delivery?.cityName) return null;
  const kind = POINT_KIND_LABELS[delivery.type] || 'Нова пошта';
  return { kind: delivery.warehouseNumber ? `${kind} №${delivery.warehouseNumber}` : kind, city: delivery.cityName, name: delivery.warehouseName || '' };
}
/** One-line list texts. */
export const recipientShort = cart => { const r = recipientView(cart?.recipient); return isErased(cart) ? 'Видалено' : r ? `${r.name}, ${r.phone}` : '—'; };
export const deliveryShort = cart => { const d = deliveryView(cart?.delivery); return isErased(cart) ? 'Видалено' : d ? `${d.kind}, ${d.city}` : '—'; };
