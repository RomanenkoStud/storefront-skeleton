/**
 * Checkout recipient («Отримувач»; three-part ПІБ). Pure and dependency-free: shared by the Worker API and the browser.
 * The phone rule is the customer-profile rule (ADR-0003), so a stored profile phone always passes checkout.
 * Results name the field and never echo the value: recipient data is personal data.
 */
export const RECIPIENT_NAME_MAX = 80; // the free-form profile displayName (cleanVisibleName)
const INVISIBLE = /[\p{Cc}\p{Cf}]/u; // controls plus format characters: bidi overrides/isolates, zero-width, BOM
const VISIBLE = /[\p{L}\p{N}\p{P}\p{S}]/u;

/** '+380XXXXXXXXX' for a Ukrainian number written as +380…, 380… or 0… (spaces, dashes and brackets ignored); null otherwise. */
export function normalizeUaPhone(value) {
  if (typeof value !== 'string') return null;
  const match = /^(?:\+380|380|0)(\d{9})$/.exec(value.normalize('NFC').trim().replace(/[\s\-()]/g, ''));
  return match ? `+380${match[1]}` : null;
}

/** Trimmed, NFC, single-spaced name or null when it is not 1-80 visible characters without control/format characters. */
export function cleanVisibleName(value, max = RECIPIENT_NAME_MAX) {
  if (typeof value !== 'string') return null;
  const v = value.normalize('NFC').trim();
  const length = [...v].length;
  if (!length || length > max || INVISIBLE.test(v) || !VISIBLE.test(v)) return null;
  return v;
}

/**
 * One part of ПІБ: «Прізвище», «Імʼя» or «По батькові». Trimmed, NFC, runs of spaces collapsed to one;
 * 1-40 characters of Cyrillic or Latin letters, with an apostrophe (ʼ ' ’), a hyphen or a single space allowed only
 * between letters. No digits, punctuation, control or invisible characters. Null when invalid.
 */
export const RECIPIENT_PART_MAX = 40;
export const RECIPIENT_NAME_FIELDS = Object.freeze(['lastName', 'firstName', 'middleName']);
const LETTER = String.raw`(?:(?=\p{L})[\p{Script=Cyrillic}\p{Script=Latin}])`; // a letter of either script: excludes Ⅷ (Nl) and ҂ (So)
const NAME_PART = new RegExp(String.raw`^${LETTER}(?:${LETTER}|\p{M})*(?:[ 'ʼ’-]${LETTER}(?:${LETTER}|\p{M})*)*$`, 'u');
export function recipientNamePart(value) {
  if (typeof value !== 'string') return null;
  const v = value.normalize('NFC').replace(/[ \t\u00A0\u3000]+/g, ' ').trim();
  const length = [...v].length;
  return length && length <= RECIPIENT_PART_MAX && NAME_PART.test(v) ? v : null;
}
/** «Прізвище Імʼя По батькові» for a recipient with all three parts; a legacy single-field recipient keeps its single `name`; '' otherwise. */
export function recipientFullName(recipient) {
  if (!recipient || typeof recipient !== 'object') return '';
  const parts = RECIPIENT_NAME_FIELDS.map(field => recipient[field]);
  if (parts.every(part => typeof part === 'string' && part)) return parts.join(' ');
  return typeof recipient.name === 'string' ? recipient.name : '';
}

export const RECIPIENT_KEYS = Object.freeze([...RECIPIENT_NAME_FIELDS, 'phone']);
/**
 * Validates a checkout recipient {lastName, firstName, middleName, phone}: every key is required.
 * Returns {ok:true, recipient:{lastName, firstName, middleName, phone}} with the phone in E.164,
 * or {ok:false, fields:[...]} naming the invalid fields in form order ('recipient' when the shape itself is wrong).
 */
export function validateRecipient(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return { ok: false, fields: ['recipient'] };
  if (Object.keys(value).some(key => !RECIPIENT_KEYS.includes(key))) return { ok: false, fields: ['recipient'] };
  const recipient = {}, fields = [];
  for (const field of RECIPIENT_NAME_FIELDS) { recipient[field] = recipientNamePart(value[field]); if (!recipient[field]) fields.push(field); }
  recipient.phone = normalizeUaPhone(value.phone);
  if (!recipient.phone) fields.push('phone');
  return fields.length ? { ok: false, fields } : { ok: true, recipient };
}
