// Manual suppliers and products: pure validation helpers. A manual supplier has no feed; its products are
// created and edited by managers. Prices are integer kopiyky and the server computes the retail price (cost + fixed markup).
import { fail, text, integer, validateSource } from './domain.js';

export const MANUAL_PRODUCT_FIELDS = ['supplierId', 'title', 'description', 'category', 'categoryId', 'brand', 'priceMinor', 'costMinor', 'variants', 'photos'];
export const MANUAL_SOURCE_FIELDS = ['title', 'description', 'category', 'costMinor', 'variants', 'photos'];

export function rejectUnknown(body, allowed) {
  for (const key of Object.keys(body)) if (!allowed.includes(key)) fail(`Unknown field: ${key}`);
}

const hex = value => Array.from(new TextEncoder().encode(value), b => b.toString(16).padStart(2, '0')).join('').slice(0, 40);
// Stable from the size: the same size always maps to the same id, so cart allocations and source edits stay consistent.
export function variantIdFor(size) {
  const slug = size.normalize('NFKC').toLowerCase().replace(/[^\p{L}\p{N}]+/gu, '-').replace(/^-|-$/g, '').slice(0, 60);
  return `v-${slug || hex(size)}`;
}
// `existing` is the current source variants: a size that already exists keeps its id; a new size gets a unique one.
export function manualVariants(input, existing = []) {
  if (!Array.isArray(input) || !input.length || input.length > 100) fail('Supply 1–100 variants');
  const bySize = new Map(existing.map(v => [v.size, v.id])), used = new Set(), seen = new Set(), result = [];
  const sizes = input.map(v => {
    if (!v || typeof v !== 'object' || Array.isArray(v)) fail('Invalid variant');
    rejectUnknown(v, ['size', 'stock']);
    return { size: text(v.size, 'size', 100, false), stock: integer(v.stock, 'stock', 1000000) };
  });
  for (const { size } of sizes) { if (seen.has(size)) fail(`Duplicate size: ${size}`); seen.add(size); }
  for (const { size } of sizes) if (bySize.has(size)) used.add(bySize.get(size));
  for (const { size, stock } of sizes) {
    let id = bySize.get(size);
    if (!id) {
      const base = variantIdFor(size);
      id = base;
      for (let n = 2; used.has(id) || [...bySize.values()].includes(id); n++) id = `${base}-${n}`;
      used.add(id);
    }
    result.push({ id, size, stock });
  }
  return result;
}

function photosInput(value) {
  if (!Array.isArray(value) || value.length > 30) fail('Invalid photos');
  return value;
}

// Returns {source, overrides} for a new product. The browser's priceMinor is only the requested retail price.
export function manualProductFromRequest(body, externalId) {
  const title = text(body.title, 'title', 300, false);
  const priceMinor = integer(body.priceMinor, 'price', 100000000);
  const costMinor = body.costMinor === undefined ? priceMinor : integer(body.costMinor, 'cost');
  if (priceMinor <= 0) fail('Price must be positive');
  if (priceMinor < costMinor) fail('Price cannot be below cost');
  const source = validateSource({
    externalId, title, description: body.description ?? '', category: body.category ?? '', costMinor, currency: 'UAH',
    photos: body.photos === undefined ? [] : photosInput(body.photos), variants: manualVariants(body.variants)
  });
  const overrides = { markupType: 'fixed', markupValue: priceMinor - costMinor };
  if (body.categoryId !== undefined && body.categoryId !== null) overrides.categoryId = body.categoryId;
  if (body.brand !== undefined && body.brand !== null && String(body.brand).trim() !== '') overrides.brand = body.brand;
  return { source, overrides };
}

export function manualSourcePatch(body, current) {
  const keys = Object.keys(body);
  if (!keys.length) fail('Supply at least one field to change');
  rejectUnknown(body, MANUAL_SOURCE_FIELDS);
  const next = { ...current };
  if (body.title !== undefined) next.title = text(body.title, 'title', 300, false);
  if (body.description !== undefined) next.description = body.description;
  if (body.category !== undefined) next.category = body.category;
  if (body.costMinor !== undefined) next.costMinor = integer(body.costMinor, 'cost');
  if (body.photos !== undefined) next.photos = photosInput(body.photos);
  if (body.variants !== undefined) next.variants = manualVariants(body.variants, current.variants);
  return validateSource({ ...next, currency: 'UAH' });
}

export const MANUAL_NO_FEED = 'Manual suppliers have no feed to sync';
