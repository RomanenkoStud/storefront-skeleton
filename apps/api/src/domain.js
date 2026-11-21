import { getCategory, suggestClassification } from '../../../packages/catalog/taxonomy.js';
export class HttpError extends Error { constructor(status, message) { super(message); this.status = status; } }
export const fail = (message, status = 400) => { throw new HttpError(status, message); };
export function text(value, field, max = 500, empty = true) {
  if (typeof value !== 'string' || value.length > max || (!empty && !value.trim())) fail(`Invalid ${field}`);
  return value.trim();
}
export function integer(value, field, max = 100000000) {
  if (!Number.isSafeInteger(value) || value < 0 || value > max) fail(`Invalid ${field}`);
  return value;
}
export function photoUrl(value) {
  if (typeof value === 'string' && /^\/media\/[a-f0-9-]+\.(jpg|png|webp)$/.test(value)) return value;
  try { const u = new URL(value); if (u.protocol === 'https:' && !u.username && !u.password && u.href.length < 2048) return u.href; } catch {}
  fail('Photos must be HTTPS URLs or uploaded media paths');
}
export function supplierUrl(value) {
  try { const u = new URL(value); if (u.protocol === 'https:' && u.hostname === 'mydrop.com.ua' && !u.port && !u.username && !u.password && /^\/[a-zA-Z0-9_-]+\/?$/.test(u.pathname) && !u.search && !u.hash) return `https://mydrop.com.ua/${u.pathname.split('/')[1]}`; } catch {}
  fail('Use a supplier URL such as https://mydrop.com.ua/demo_shop');
}
export function validateSource(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail('Invalid source item');
  if (value.currency !== 'UAH') fail('Only UAH is supported');
  if (!Array.isArray(value.photos) || value.photos.length > 30) fail('Invalid photos');
  if (!Array.isArray(value.variants) || !value.variants.length || value.variants.length > 100) fail('Supply 1–100 variants');
  const variants = value.variants.map(v => { if (!v || typeof v !== 'object' || Array.isArray(v)) fail('Invalid variant'); return { id: text(v.id, 'variant ID', 200, false), size: text(v.size, 'size', 100, false), stock: integer(v.stock, 'stock', 1000000) }; });
  if (new Set(variants.map(v => v.id)).size !== variants.length) fail('Duplicate variant IDs');
  return { externalId: text(value.externalId, 'external ID', 200, false), title: text(value.title, 'title', 300, false), description: text(value.description ?? '', 'description', 20000), category: text(value.category ?? '', 'category', 200), costMinor: integer(value.costMinor, 'cost'), currency: 'UAH', photos: value.photos.map(photoUrl), variants };
}
const keys = new Set(['published','title','description','category','categoryId','brand','slug','markupType','markupValue','priceOverrideMinor','photos','hiddenSizes','promoText','freeShipping','promoStartsAt','promoEndsAt','seoTitle','seoDescription','tags']);
// Internal manager tags: free text, never public. Trimmed, inner whitespace collapsed, deduplicated ignoring case (first spelling wins).
export const TAG_LIMITS = Object.freeze({ count: 20, length: 40 });
export function normalizeTags(value) {
  if (!Array.isArray(value)) fail('Tags must be a list');
  if (value.length > TAG_LIMITS.count) fail(`Use up to ${TAG_LIMITS.count} tags`);
  const seen = new Set(), tags = [];
  for (const raw of value) {
    const tag = text(raw, 'tag', 200, false).normalize('NFC').replace(/\s+/g, ' ');
    if (tag.length > TAG_LIMITS.length || /[\p{Cc}\p{Cf}\p{Co}\p{Cs}\p{Cn}]/u.test(tag) || !/[\p{L}\p{N}]/u.test(tag)) fail(`Tags must be 1–${TAG_LIMITS.length} printable characters`);
    const key = tag.toLocaleLowerCase('uk');
    if (!seen.has(key)) { seen.add(key); tags.push(tag); }
  }
  return tags;
}
export function validateOverrides(patch, existing = {}, taxonomy = null) {
  if (!patch || typeof patch !== 'object' || Array.isArray(patch)) fail('Invalid overrides');
  for (const key of Object.keys(patch)) if (!keys.has(key)) fail(`Unknown field: ${key}`);
  const result = { ...existing };
  for (const [key, value] of Object.entries(patch)) {
    if (['published','freeShipping'].includes(key)) { if (typeof value !== 'boolean') fail(`Invalid ${key}`); }
    else if (key === 'categoryId') { const category=value===null?null:getCategory(value,taxonomy); if(value!==null&&!category)fail('Select a canonical category or unclassified'); }
    else if (key === 'brand') { if(value!==null)text(value,key,100); }
    else if (key === 'markupType') { if (!['fixed','percent'].includes(value)) fail('Invalid markup mode'); }
    else if (key === 'markupValue') integer(value, key, 100000000);
    else if (key === 'priceOverrideMinor') { if (value !== null) { integer(value, key, 100000000); if (value < 1) fail(`Invalid ${key}`); } }
    else if (key === 'slug') { if (typeof value !== 'string' || !/^[a-z0-9][a-z0-9-]{0,149}$/.test(value)) fail('Slug must contain lowercase Latin letters, numbers and hyphens'); }
    else if (key === 'photos') { if (value !== null && (!Array.isArray(value) || value.length > 30)) fail('Invalid photos'); if (value) result[key] = value.map(photoUrl); }
    else if (key === 'hiddenSizes') { if (!Array.isArray(value) || value.length > 100) fail('Invalid hidden sizes'); result[key] = [...new Set(value.map(v => text(v, 'size', 100, false)))]; }
    else if (key === 'tags') result[key] = normalizeTags(value);
    else if (['promoStartsAt','promoEndsAt'].includes(key)) { if (value !== null && (typeof value !== 'string' || !/^\d{4}-\d\d-\d\dT.*(?:Z|[+-]\d\d:\d\d)$/.test(value) || !Number.isFinite(Date.parse(value)))) fail(`Invalid ${key}`); }
    else if (['title','description','category'].includes(key) && value === null) {}
    else text(value, key, key === 'description' ? 20000 : key === 'seoDescription' ? 500 : 300);
    if (!['photos','hiddenSizes','tags'].includes(key)) result[key] = value;
    else if (key === 'photos' && value === null) result[key] = null;
  }
  if(Object.prototype.hasOwnProperty.call(patch,'categoryId')&&patch.categoryId===null)result.category=null;
  if(typeof result.brand==='string')result.brand=result.brand.trim();
  if (result.promoStartsAt && result.promoEndsAt && Date.parse(result.promoStartsAt) >= Date.parse(result.promoEndsAt)) fail('Promotion end must follow start');
  return result;
}
export function retailPrice(cost, type = 'fixed', markup = 0) {
  integer(cost, 'cost'); integer(markup, 'markup');
  const price = type === 'percent' ? cost + Math.round(cost * markup / 100) : cost + markup;
  if (!Number.isSafeInteger(price) || price > 100000000) fail('Retail price exceeds limit');
  return price;
}
export function productProjection(row, now = Date.now(), publicOnly = false, recognitionSettings = null, taxonomy = null) {
  const source = JSON.parse(row.source_json), o = JSON.parse(row.overrides_json);
  const active = (!o.promoStartsAt || Date.parse(o.promoStartsAt) <= now) && (!o.promoEndsAt || now < Date.parse(o.promoEndsAt));
  const title = o.title ?? source.title;
  const classificationSuggestion=suggestClassification(source,recognitionSettings,row.supplier_id,taxonomy);
  const categoryOverridden=typeof o.categoryId==='string'||typeof o.category==='string';
  const brandOverridden=typeof o.brand==='string';
  // Canonical category selection wins over legacy free-text edits. A null ID
  // restores inference; legacy category text remains backwards compatible.
  const legacySuggestion=typeof o.category==='string'?suggestClassification({...source,category:o.category,title:''}):null;
  const legacy=legacySuggestion?getCategory(legacySuggestion.categoryId,taxonomy):null;
  const canonical=typeof o.categoryId==='string'?getCategory(o.categoryId,taxonomy):null;
  const categoryId=canonical?.id??legacy?.id??classificationSuggestion.categoryId;
  const categoryPath=canonical?.path??legacy?.path??classificationSuggestion.categoryPath;
  const category=canonical?.label??o.category??(classificationSuggestion.categoryId==='unclassified'?source.category:classificationSuggestion.category);
  const brand=brandOverridden?o.brand:classificationSuggestion.brand;
  // Manager price override (integer minor units) wins over cost+markup; null/absent inherits. If the markup
  // computation overflows but an override is set, the product still projects with computedPriceMinor=null.
  const overridden = typeof o.priceOverrideMinor === 'number';
  let computedPriceMinor;
  try { computedPriceMinor = retailPrice(source.costMinor, o.markupType, o.markupValue); } catch (error) { if (!overridden) throw error; computedPriceMinor = null; }
  const priceMinor = overridden ? o.priceOverrideMinor : computedPriceMinor;
  const product = { id: row.id, title, description: o.description ?? source.description, category, categoryId, categoryPath:[...categoryPath], brand, slug: row.slug, priceMinor, currency: source.currency, photos: o.photos ?? source.photos, variants: source.variants.filter(v => !(o.hiddenSizes ?? []).includes(v.size)).map(v => ({size:v.size,stock:v.stock})), promoText: active ? (o.promoText ?? '') : '', freeShipping: active && !!o.freeShipping, seoTitle: o.seoTitle || title, seoDescription: o.seoDescription || (o.description ?? source.description).slice(0,160), updatedAt:row.updated_at };
  return publicOnly ? product : { ...product, tags: Array.isArray(o.tags) ? o.tags : [], supplierId: row.supplier_id, externalId:row.external_id, source, overrides:o, classificationSuggestion, categoryOverridden, brandOverridden, deletedAt:row.deleted_at??null, published:!!o.published, computedPriceMinor, priceOverridden:overridden };
}
export function slugFor(source, id) {
  const title = source.title.normalize('NFKD').toLowerCase().replace(/[^a-z0-9]+/g,'-').replace(/^-|-$/g,'').slice(0,80) || 'product';
  return `${title}-${id}`;
}
export function escapeHtml(value) { return String(value).replace(/[&<>"']/g, ch => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[ch])); }
