// Pure helpers for manual products (no React) so they can be unit-tested directly in node.
// Money is integer kopiyky; hryvnia input is parsed from the string, never through floating point.
export const MAX_PHOTO_BYTES = 20 * 1024 * 1024;
export const PHOTO_TYPES = ['image/jpeg', 'image/png', 'image/webp'];
export const MAX_PHOTOS = 20;
export const MAX_MINOR = 100000000;
export const MAX_BRAND = 100;
const SERVER_MESSAGES = [
  [/price cannot be below cost/i, 'Ціна не може бути нижчою за закупівлю.'],
  [/invalid price/i, 'Некоректна ціна.'],
  [/invalid cost/i, 'Некоректна закупівля.'],
  [/invalid brand/i, 'Некоректний бренд.'],
  [/duplicate sizes?/i, 'Розміри не мають повторюватися.'],
  [/invalid (variants?|sizes?|stock)/i, 'Некоректні розміри або кількість.'],
  [/invalid title/i, 'Некоректна назва.'],
  [/manual suppliers have no feed/i, 'У ручних постачальників немає фіду для синхронізації.'],
  [/supplier not found/i, 'Постачальника не знайдено.'],
  [/product not found/i, 'Товар не знайдено.'],
];
/** Maps common server error messages to Ukrainian; unknown messages pass through unchanged. */
export function serverMessage(message) {
  const text = String(message ?? '');
  return SERVER_MESSAGES.find(([pattern]) => pattern.test(text))?.[1] || text;
}

/** "1299", "1299.5", "1299,50" -> 129900 | 129950 | 129950. Anything else -> null. */
export function parseHryvniaToMinor(value) {
  const text = String(value ?? '').trim();
  const match = /^(\d{1,9})(?:[.,](\d{1,2}))?$/.exec(text);
  if (!match) return null;
  return Number(match[1]) * 100 + Number((match[2] || '').padEnd(2, '0') || 0);
}
/** 129950 -> "1299.50", 129900 -> "1299". Integer arithmetic only. */
export function minorToHryvnia(minor) {
  if (!Number.isInteger(minor) || minor < 0) return '';
  const whole = Math.floor(minor / 100), cents = minor % 100;
  return cents ? `${whole}.${String(cents).padStart(2, '0')}` : String(whole);
}

export const emptySizeRow = (size = '') => ({ size, stock: '' });
export const ONE_SIZE = 'Один розмір';

/** Validates size rows; returns {variants, error}. Sizes are trimmed, unique (case-insensitive), stock an integer >= 0. */
export function validateVariants(rows) {
  const list = (rows || []).map(row => ({ size: String(row.size ?? '').trim(), stock: String(row.stock ?? '').trim() }));
  if (!list.length) return { error: 'Додайте щонайменше один розмір.' };
  const seen = new Set(), variants = [];
  for (const row of list) {
    if (!row.size) return { error: 'Вкажіть назву кожного розміру.' };
    if (row.size.length > 40) return { error: 'Назва розміру має бути не довшою за 40 символів.' };
    if (!/^\d{1,6}$/.test(row.stock)) return { error: `Кількість для розміру «${row.size}» має бути цілим числом від 0.` };
    const key = row.size.toLowerCase();
    if (seen.has(key)) return { error: `Розмір «${row.size}» повторюється.` };
    seen.add(key);
    variants.push({ size: row.size, stock: Number(row.stock) });
  }
  return { variants };
}

/** Client-side check mirroring the server upload limits. Returns an error string or ''. */
export function photoFileError(file) {
  if (!PHOTO_TYPES.includes(file.type)) return `«${file.name}»: дозволені лише JPEG, PNG або WebP.`;
  if (file.size > MAX_PHOTO_BYTES) return `«${file.name}»: файл завеликий, максимум 20 МБ.`;
  if (file.size === 0) return `«${file.name}»: порожній файл.`;
  return '';
}

/** Validates the add-product form. Returns {body, errors:{field:message}}; body is the POST payload (without photos). */
export function buildProductBody(form) {
  const errors = {};
  const title = String(form.title ?? '').trim();
  if (!form.supplierId) errors.supplierId = 'Оберіть постачальника.';
  if (!title) errors.title = 'Вкажіть назву.';
  else if (title.length > 200) errors.title = 'Назва має бути не довшою за 200 символів.';
  const priceMinor = parseHryvniaToMinor(form.price);
  if (priceMinor === null || priceMinor <= 0) errors.price = 'Вкажіть ціну в гривнях, наприклад 1299 або 1299.50.';
  else if (priceMinor > MAX_MINOR) errors.price = 'Ціна занадто велика (максимум 1 000 000 ₴).';
  let costMinor;
  if (String(form.cost ?? '').trim() !== '') {
    costMinor = parseHryvniaToMinor(form.cost);
    if (costMinor === null) errors.cost = 'Закупівля: число в гривнях, наприклад 800 або 800.50.';
    else if (costMinor > MAX_MINOR) errors.cost = 'Закупівля занадто велика (максимум 1 000 000 ₴).';
    else if (priceMinor !== null && costMinor > priceMinor) errors.cost = 'Закупівля не може бути більшою за ціну.';
  }
  const { variants, error: variantError } = validateVariants(form.sizes);
  if (variantError) errors.sizes = variantError;
  const body = { supplierId: form.supplierId, title, priceMinor, variants };
  const description = String(form.description ?? '').trim();
  if (description) body.description = description;
  if (form.categoryId) body.categoryId = form.categoryId;
  const brand = String(form.brand ?? '').trim();
  if (brand.length > MAX_BRAND) errors.brand = `Бренд має бути не довшим за ${MAX_BRAND} символів.`;
  if (brand) body.brand = brand;
  if (costMinor !== undefined) body.costMinor = costMinor;
  return { body, errors };
}

/** Validates the manual "Source" section of the editor; returns {body, errors} for PATCH /source. */
export function buildSourceBody(form) {
  const errors = {};
  const title = String(form.title ?? '').trim();
  if (!title) errors.title = 'Вкажіть назву.';
  let costMinor;
  const cost = parseHryvniaToMinor(form.cost);
  if (cost === null) errors.cost = 'Закупівля: число в гривнях, наприклад 800 або 800.50.';
  else if (cost > MAX_MINOR) errors.cost = 'Закупівля занадто велика (максимум 1 000 000 ₴).';
  else costMinor = cost;
  const { variants, error } = validateVariants(form.sizes);
  if (error) errors.sizes = error;
  return { errors, body: { title, description: String(form.description ?? '').trim(), costMinor, variants, photos: [...(form.photos || [])] } };
}

export const isManualSupplier = supplier => supplier?.provider === 'manual';
