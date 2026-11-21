/**
 * Shared cart contract (ADR-0007). Pure and dependency-free: used by the Worker API
 * and the browser. Prices are integer kopecks; the server is authoritative.
 *
 * Duplicate policy: the SERVER rejects duplicate (productId,size) lines
 * (problem code "duplicate_line"); the CLIENT merges via addLocalLine so the
 * browser never submits duplicates.
 */
export const CROCKFORD_ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
export const CODE_PREFIX = 'SS';
export const CODE_SYMBOLS = 8;
export const LOCAL_CART_KEY = 'ls_cart_v1';
export const LOCAL_CART_VERSION = 1;
export const MAX_LINES = 20;
export const MIN_QUANTITY = 1;
export const MAX_QUANTITY = 10;
export const MAX_RECENT_CODES = 20;
export const MAX_SIZE_LENGTH = 100;
export const MAX_ID_LENGTH = 128;

export const CART_STATUSES = Object.freeze(['submitted', 'verified', 'sent_to_suppliers', 'completed', 'cancelled']);
// «Виконано» (completed) follows sent_to_suppliers only and is terminal, like cancelled.
export const CART_TRANSITIONS = Object.freeze({
  submitted: Object.freeze(['verified', 'cancelled']),
  verified: Object.freeze(['sent_to_suppliers', 'cancelled']),
  sent_to_suppliers: Object.freeze(['completed']),
  completed: Object.freeze([]),
  cancelled: Object.freeze([]),
});
export const TERMINAL_STATUSES = Object.freeze(CART_STATUSES.filter(s => CART_TRANSITIONS[s].length === 0));

/**
 * Retention of the order's personal data (ADR-0007 "Retention"): the recipient (rcpt_*) and the
 * Nova Poshta point (dp_*) of a cart are erased CLOSED_DAYS after the cart reaches a closed status
 * (by status_changed_at), and at the latest MAX_DAYS after creation for a cart that is never closed.
 * The only place these numbers live; the Worker job, the UI and the tests import them.
 */
export const ORDER_PD_RETENTION = Object.freeze({ closedDays: 14, maxDays: 90, batchLimit: 200 });
export const CLOSED_STATUSES = Object.freeze(['completed', 'cancelled']);
export const PD_ERASED_LABEL = 'Персональні дані видалено (термін зберігання)';

export function isCartStatus(value) { return typeof value === 'string' && CART_STATUSES.includes(value); }
export function canTransition(from, to) { return isCartStatus(from) && isCartStatus(to) && CART_TRANSITIONS[from].includes(to); }
export function isTerminalStatus(status) { return TERMINAL_STATUSES.includes(status); }

/** Rejection-free sampling: 256 is a multiple of 32, so masking 5 bits of a byte is unbiased. 8 symbols = 40 bits. */
function defaultRandomBytes(length) {
  const bytes = new Uint8Array(length);
  globalThis.crypto.getRandomValues(bytes);
  return bytes;
}
/** @param {(length:number)=>Uint8Array} [randomBytes] returns `length` random bytes. */
export function generateCode(randomBytes = defaultRandomBytes) {
  const bytes = randomBytes(CODE_SYMBOLS);
  if (!bytes || bytes.length < CODE_SYMBOLS) throw new Error('Random source returned too few bytes.');
  let body = '';
  for (let i = 0; i < CODE_SYMBOLS; i++) body += CROCKFORD_ALPHABET[bytes[i] & 31];
  return formatCode(body);
}
/** body: 8 canonical symbols -> SS-XXXX-XXXX. Throws on a malformed body. */
export function formatCode(body) {
  const value = typeof body === 'string' ? body : '';
  if (value.length !== CODE_SYMBOLS || [...value].some(c => !CROCKFORD_ALPHABET.includes(c))) throw new TypeError('Invalid cart code body.');
  return `${CODE_PREFIX}-${value.slice(0, 4)}-${value.slice(4)}`;
}
/** Returns canonical SS-XXXX-XXXX or null for malformed input. */
export function normalizeCode(input) {
  if (typeof input !== 'string' || input.length > 64) return null;
  let value = input.normalize('NFKC').toUpperCase().replace(/[\s\-\u2010-\u2015._]+/g, '').replace(/[IL]/g, '1').replace(/O/g, '0');
  if (value.length === CODE_SYMBOLS + CODE_PREFIX.length && value.startsWith(CODE_PREFIX)) value = value.slice(CODE_PREFIX.length);
  if (value.length !== CODE_SYMBOLS || [...value].some(c => !CROCKFORD_ALPHABET.includes(c))) return null;
  return formatCode(value);
}
export function isValidCode(input) { return normalizeCode(input) !== null; }

const CONTROL_CHARS = /[\u0000-\u001F\u007F]/;
const SLUG_PATTERN = /^[a-z0-9][a-z0-9-]{0,149}$/;
function safePhoto(value) {
  if (typeof value !== 'string' || !value || value.length > 2048 || CONTROL_CHARS.test(value)) return null;
  if (value.startsWith('/') && !value.startsWith('//') && !value.includes('\\')) return value;
  if (!value.startsWith('https://')) return null;
  try { return new URL(value).protocol === 'https:' ? value : null; } catch { return null; }
}
function cleanString(value, max) {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed && trimmed.length <= max && !CONTROL_CHARS.test(trimmed) ? trimmed : null;
}
export function isValidQuantity(value) { return Number.isInteger(value) && value >= MIN_QUANTITY && value <= MAX_QUANTITY; }

/**
 * Validates a checkout request body's lines. Returns {ok, lines, problems}.
 * problems: [{index:number|null, code, field?}]; index null = whole cart.
 * Codes: lines_required, too_many_lines, invalid_line, invalid_product_id, invalid_size, invalid_quantity, duplicate_line.
 * `lines` (normalized {productId,size,quantity}) is only meaningful when ok.
 */
export function validateCheckoutLines(input) {
  const problems = [];
  if (!Array.isArray(input) || input.length === 0) return { ok: false, lines: [], problems: [{ index: null, code: 'lines_required' }] };
  if (input.length > MAX_LINES) problems.push({ index: null, code: 'too_many_lines', max: MAX_LINES });
  const lines = [];
  const seen = new Map();
  input.slice(0, MAX_LINES).forEach((raw, index) => {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) { problems.push({ index, code: 'invalid_line' }); return; }
    const productId = cleanString(raw.productId, MAX_ID_LENGTH);
    const size = cleanString(raw.size, MAX_SIZE_LENGTH);
    let bad = false;
    if (!productId) { problems.push({ index, code: 'invalid_product_id', field: 'productId' }); bad = true; }
    if (!size) { problems.push({ index, code: 'invalid_size', field: 'size' }); bad = true; }
    if (!isValidQuantity(raw.quantity)) { problems.push({ index, code: 'invalid_quantity', field: 'quantity', min: MIN_QUANTITY, max: MAX_QUANTITY }); bad = true; }
    if (bad) return;
    const key = JSON.stringify([productId, size]);
    if (seen.has(key)) { problems.push({ index, code: 'duplicate_line', field: 'size', firstIndex: seen.get(key) }); return; }
    seen.set(key, index);
    lines.push({ productId, size, quantity: raw.quantity });
  });
  return { ok: problems.length === 0, lines: problems.length ? [] : lines, problems };
}

/** Client-side: merges into an existing line, capping quantity at MAX_QUANTITY. Returns {lines, added, capped, full}. */
export function addLocalLine(lines, line) {
  const list = Array.isArray(lines) ? lines.slice() : [];
  const clean = sanitizeLocalLine({ ...(line && typeof line === 'object' ? line : {}), quantity: isValidQuantity(line?.quantity) ? line.quantity : MIN_QUANTITY });
  if (!clean) return { lines: list, added: false, capped: false, full: false };
  line = clean;
  const qty = clean.quantity;
  const at = list.findIndex(l => l.productId === line.productId && l.size === line.size);
  if (at >= 0) {
    const sum = list[at].quantity + qty;
    const old = list[at];
    const keep = (next, prev, empty) => (next === empty || next === undefined ? prev : next);
    list[at] = {
      ...old,
      slug: keep(line.slug, old.slug, ''), title: keep(line.title, old.title, ''),
      photo: keep(line.photo, old.photo, null), priceMinor: keep(line.priceMinor, old.priceMinor, null),
      quantity: Math.min(sum, MAX_QUANTITY),
    };
    return { lines: list, added: true, capped: sum > MAX_QUANTITY, full: false };
  }
  if (list.length >= MAX_LINES) return { lines: list, added: false, capped: false, full: true };
  list.push({ ...line, quantity: qty });
  return { lines: list, added: true, capped: false, full: false };
}

function sanitizeLocalLine(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const productId = cleanString(raw.productId, MAX_ID_LENGTH);
  const size = cleanString(raw.size, MAX_SIZE_LENGTH);
  if (!productId || !size || !isValidQuantity(raw.quantity)) return null;
  return {
    productId, size, quantity: raw.quantity,
    slug: typeof raw.slug === 'string' && SLUG_PATTERN.test(raw.slug) ? raw.slug : '',
    title: typeof raw.title === 'string' ? raw.title.slice(0, 300) : '',
    priceMinor: Number.isSafeInteger(raw.priceMinor) && raw.priceMinor >= 0 ? raw.priceMinor : null,
    photo: safePhoto(raw.photo),
  };
}
function sanitizeRecent(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const code = normalizeCode(raw.code);
  if (!code) return null;
  return {
    code,
    createdAt: typeof raw.createdAt === 'string' ? raw.createdAt.slice(0, 40) : '',
    itemCount: Number.isSafeInteger(raw.itemCount) && raw.itemCount >= 0 ? raw.itemCount : 0,
    totalMinor: Number.isSafeInteger(raw.totalMinor) && raw.totalMinor >= 0 ? raw.totalMinor : 0,
  };
}
export function emptyLocalCart() { return { version: LOCAL_CART_VERSION, lines: [], recent: [] }; }

/** Never throws on corrupt/unknown-version data: returns an empty cart; drops bad lines; dedupes (merging) and caps. */
export function parseLocalCart(text) {
  let data;
  try { data = typeof text === 'string' ? JSON.parse(text) : text; } catch { return emptyLocalCart(); }
  if (!data || typeof data !== 'object' || Array.isArray(data) || data.version !== LOCAL_CART_VERSION) return emptyLocalCart();
  let lines = [];
  for (const raw of Array.isArray(data.lines) ? data.lines : []) {
    const line = sanitizeLocalLine(raw);
    if (line) lines = addLocalLine(lines, line).lines;
  }
  const recent = [];
  for (const raw of Array.isArray(data.recent) ? data.recent : []) {
    const item = sanitizeRecent(raw);
    if (item && !recent.some(r => r.code === item.code)) recent.push(item);
    if (recent.length >= MAX_RECENT_CODES) break;
  }
  return { version: LOCAL_CART_VERSION, lines, recent };
}
/** Returns the JSON string to store under LOCAL_CART_KEY (sanitized round trip). */
export function serializeLocalCart(cart) {
  const parsed = parseLocalCart({ version: LOCAL_CART_VERSION, lines: cart?.lines, recent: cart?.recent });
  return JSON.stringify(parsed);
}
