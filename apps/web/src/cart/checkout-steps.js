// Three-step checkout: Кошик → Отримувач → Доставка. Pure helpers, no React, no storage.
// The recipient draft lives in React state only: ADR-0007 keeps personal data out of the browser cart (ls_cart_v1).
import { normalizeUaPhone, recipientNamePart, recipientFullName, RECIPIENT_NAME_FIELDS, RECIPIENT_PART_MAX } from '../../../../packages/catalog/recipient.js';

export const STEPS = Object.freeze([
  Object.freeze({ id: 'items', label: 'Кошик', title: 'Ваш кошик' }),
  Object.freeze({ id: 'recipient', label: 'Отримувач', title: 'Отримувач' }),
  Object.freeze({ id: 'delivery', label: 'Доставка', title: 'Доставка' }),
]);
export const STEP_IDS = STEPS.map(s => s.id);
export { RECIPIENT_PART_MAX, RECIPIENT_NAME_FIELDS };
export const stepIndex = id => Math.max(0, STEP_IDS.indexOf(id));
export const stepOf = id => STEPS[stepIndex(id)];
export const nextStep = id => STEP_IDS[Math.min(STEP_IDS.length - 1, stepIndex(id) + 1)];
export const prevStep = id => STEP_IDS[Math.max(0, stepIndex(id) - 1)];
/** «Крок 2 з 3: Отримувач» for the heading's screen-reader prefix and the indicator. */
export const stepCaption = id => `Крок ${stepIndex(id) + 1} з ${STEPS.length}`;

/** ПІБ inputs in form order: each one is required. */
export const RECIPIENT_NAME_INPUTS = Object.freeze([
  Object.freeze({ field: 'lastName', label: 'Прізвище', slug: 'last-name', autoComplete: 'family-name' }),
  Object.freeze({ field: 'firstName', label: 'Імʼя', slug: 'first-name', autoComplete: 'given-name' }),
  Object.freeze({ field: 'middleName', label: 'По батькові', slug: 'middle-name', autoComplete: 'additional-name' }),
]);
const LETTERS_RULE = 'лише літери, апостроф, дефіс або пробіл, до 40 символів.';
export const RECIPIENT_ERRORS = Object.freeze({
  lastName: `Вкажіть прізвище: ${LETTERS_RULE}`,
  firstName: `Вкажіть імʼя: ${LETTERS_RULE}`,
  middleName: `Вкажіть по батькові: ${LETTERS_RULE}`,
  phone: 'Вкажіть мобільний номер України, наприклад 050 123 45 67.',
});
export const EMPTY_RECIPIENT = Object.freeze({ lastName: '', firstName: '', middleName: '', phone: '' });
/** {lastName?, firstName?, middleName?, phone?} error texts in form order (the first key gets focus); empty object when it can be submitted. */
export function recipientErrors(draft) {
  const errors = {};
  for (const field of RECIPIENT_NAME_FIELDS) if (!recipientNamePart(draft?.[field] ?? '')) errors[field] = RECIPIENT_ERRORS[field];
  if (!normalizeUaPhone(draft?.phone ?? '')) errors.phone = RECIPIENT_ERRORS.phone;
  return errors;
}
/** The {lastName, firstName, middleName, phone} the checkout body carries (phone in E.164), or null when the draft is invalid. */
export function recipientInput(draft) {
  const out = {};
  for (const field of RECIPIENT_NAME_FIELDS) { out[field] = recipientNamePart(draft?.[field] ?? ''); if (!out[field]) return null; }
  out.phone = normalizeUaPhone(draft?.phone ?? '');
  return out.phone ? out : null;
}
/** Only a known signed-in session sends the recipient (mirrors checkoutDelivery); anonymous visitors keep it in the manager message. */
export const checkoutRecipient = ({ signed, draft }) => (signed === true ? recipientInput(draft) : null);

/**
 * Profile → draft prefill: the three ПІБ parts and the stored E.164 phone shown as 0XXXXXXXXX. A single-field
 * displayName is never split by guessing: without stored parts the name inputs stay empty. Null when touched or nothing to fill.
 */
export function recipientPrefill(profile, touched = false) {
  if (touched || !profile) return null;
  const draft = {};
  for (const field of RECIPIENT_NAME_FIELDS) draft[field] = typeof profile[field] === 'string' ? profile[field] : '';
  const e164 = normalizeUaPhone(profile.phone ?? '');
  draft.phone = e164 ? `0${e164.slice(4)}` : '';
  return Object.values(draft).some(Boolean) ? draft : null;
}
/** «+380501234567» → «+380 50 123 45 67» for display; other values unchanged. */
export function formatPhone(value) {
  const e164 = normalizeUaPhone(value ?? '');
  if (!e164) return value ?? '';
  const d = e164.slice(4);
  return `+380 ${d.slice(0, 2)} ${d.slice(2, 5)} ${d.slice(5, 7)} ${d.slice(7)}`;
}
/** «Отримувач: Прізвище Імʼя По батькові, +380 …» for an entered draft, a stored cart recipient or a legacy single-field one ({name}); '' otherwise. */
export function recipientLine(recipient) {
  const name = recipientFullName(recipient);
  return name && recipient?.phone ? `Отримувач: ${name}, ${formatPhone(recipient.phone)}` : '';
}

/** Prepayment from the public storefront settings: a positive safe integer of kopecks, otherwise 0 (line hidden). */
export const prepaymentMinorOf = settings => {
  const v = settings?.checkout?.prepaymentMinor;
  return Number.isSafeInteger(v) && v > 0 ? v : 0;
};
/**
 * What the items step shows: null when there is no prepayment; otherwise {prepaymentMinor, remainderMinor}.
 * remainderMinor (paid on receipt) is only given for a fully priced cart whose total exceeds the prepayment.
 */
export function prepaymentView(prepaymentMinor, total, priced) {
  if (!Number.isSafeInteger(prepaymentMinor) || prepaymentMinor <= 0) return null;
  const remainderMinor = priced && Number.isSafeInteger(total) && total > prepaymentMinor ? total - prepaymentMinor : null;
  return { prepaymentMinor, remainderMinor };
}

/** Which step a failed checkout returns to: line problems → items, recipient → recipient, delivery → delivery; otherwise stay. */
export function stepForError(error, current = 'delivery') {
  if (error?.code === 'invalid_recipient') return 'recipient';
  if (['delivery_unavailable', 'delivery_catalog_unavailable', 'invalid_delivery'].includes(error?.code)) return 'delivery';
  if ((error?.status === 400 || error?.status === 409) && Array.isArray(error.problems) && error.problems.length) return 'items';
  if (['invalid_cart', 'cart_unavailable'].includes(error?.code)) return 'items';
  return current;
}
/** Whether a step can be entered: later steps need lines; the delivery step also needs a valid recipient. */
export function canEnter(id, { lineCount, draft }) {
  if (id === 'items') return true;
  if (!lineCount) return false;
  return id === 'recipient' || !Object.keys(recipientErrors(draft)).length;
}

// Buyer disclaimer (items step) and the required terms checkbox (delivery step). Copy is a placeholder.
// the disclaimer is a prominent warning block (headline + body) at the top of the «Кошик» step; informational only.
export const BUYER_NOTICE_HEADLINE = 'Тестове попередження';
export const BUYER_NOTICE_TEXT = 'Лорем іпсум — тестовий текст попередження для покупця.';
/** The label reads TERMS_LABEL_PREFIX + link(TERMS_LINK_TEXT); the link opens the published delivery & exchange policy. */
export const TERMS_LABEL_PREFIX = 'Я приймаю ';
export const TERMS_LINK_TEXT = 'умови оплати та доставки';
export const TERMS_HREF = '/#delivery';
export const TERMS_ERROR = 'Щоб отримати код кошика, позначте, що приймаєте умови.';
/** The manager-message line for a checkout whose terms box was ticked (client-side only; the API contract is unchanged). */
export const TERMS_ACCEPTED_LINE = 'Умови оплати та доставки прийнято.';
/** Error text when the box is not ticked, '' when the checkout may go on. */
export const termsError = accepted => (accepted === true ? '' : TERMS_ERROR);
