import { fail, validateSource } from './domain.js';
import { isEasyDropImageUrl } from './image-processing.js';

/** Bounded EasyDrop prom-export reader and normalizer. Pure: no I/O.
 * Output matches normalizeMyDrop: {items: SourceItem[], skipped: [{externalId, reason}]}. */
export const EASYDROP_LIMITS = { bytes: 12 * 1024 * 1024, items: 20000, products: 5000, categories: 5000, nodes: 400000, text: 1024 * 1024, totalText: 8 * 1024 * 1024, tag: 65536, variants: 100, photos: 30, title: 300, description: 20000, category: 200, depth: 8 };
export const EASYDROP_SKIP_REASONS = {
  id: 'некоректний або повторний ID позиції',
  title: 'немає назви',
  price_missing: 'немає priceuah',
  price_invalid: 'некоректна або нульова priceuah',
  price_mismatch: 'різні ціни розмірів',
  variants: 'понад 100 розмірів',
  sizes_invalid: 'відсутній розмір у товару з кількома позиціями',
  published_invalid: 'оновлення зламало б опублікований товар (залишено як є)',
  invalid: 'некоректні дані товару'
};
const NO_CATEGORY = 'Без категорії';
class Skip extends Error { constructor(reason) { super(reason); this.reason = reason; } }
const bad = message => fail(`Invalid EasyDrop feed: ${message}`, 422);

const ENTITIES = { lt: '<', gt: '>', amp: '&', quot: '"', apos: "'" };
function decode(value) {
  if (!value.includes('&')) return value;
  return value.replace(/&(?:#(\d{1,7})|#[xX]([0-9a-fA-F]{1,6})|([A-Za-z]+));/g, (_, dec, hex, name) => {
    if (name) { if (!Object.hasOwn(ENTITIES, name)) bad(`unsupported entity &${name.slice(0, 32)};`); return ENTITIES[name]; }
    const code = dec ? Number(dec) : parseInt(hex, 16);
    if (code === 9 || code === 10 || code === 13 || (code >= 32 && code <= 0xd7ff) || (code >= 0xe000 && code <= 0x10ffff && code !== 0xfffe && code !== 0xffff)) return String.fromCodePoint(code);
    return bad('invalid character reference');
  });
}
// After decoding, a remaining bare "&" that is not part of a reference means malformed input.
function checkAmpersands(raw) {
  if (!raw.includes('&')) return;
  if (/&(?!(?:#\d{1,7}|#[xX][0-9a-fA-F]{1,6}|[A-Za-z]+);)/.test(raw)) bad('stray ampersand');
}
const text = raw => { checkAmpersands(raw); return decode(raw); };

const TAG = /<(\/?)([A-Za-z_][A-Za-z0-9_.-]*)((?:\s+[A-Za-z_:][A-Za-z0-9_.:-]*\s*=\s*(?:"[^"<]*"|'[^'<]*'))*)\s*(\/?)>/y;
const ATTR = /([A-Za-z_:][A-Za-z0-9_.:-]*)\s*=\s*(?:"([^"]*)"|'([^']*)')/g;

/** Minimal XML reader: elements, attributes, text, comments, one leading XML declaration.
 * Rejects DOCTYPE, ENTITY, CDATA, processing instructions, unknown entities and nesting beyond the cap. */
export function parseXml(input) {
  let source;
  if (typeof input === 'string') { source = input; if (source.length > EASYDROP_LIMITS.bytes || new TextEncoder().encode(source).length > EASYDROP_LIMITS.bytes) fail('EasyDrop feed exceeds the 12 MB limit', 422); }
  else if (input instanceof ArrayBuffer || ArrayBuffer.isView(input)) {
    if (input.byteLength > EASYDROP_LIMITS.bytes) fail('EasyDrop feed exceeds the 12 MB limit', 422);
    try { source = new TextDecoder('utf-8', { fatal: true }).decode(input); } catch { bad('not valid UTF-8'); }
  } else bad('feed must be text');
  if (source.charCodeAt(0) === 0xfeff) source = source.slice(1);
  let pos = 0;
  const decl = /^<\?xml\s[^<>?]*\?>/.exec(source);
  if (decl) pos = decl[0].length;
  const root = { name: '#root', attrs: {}, children: [], text: '' }, stack = [root];
  const n = source.length;
  let nodes = 0, itemNodes = 0, totalText = 0;
  while (pos < n) {
    const lt = source.indexOf('<', pos);
    const end = lt === -1 ? n : lt;
    if (end > pos) {
      if (end - pos > EASYDROP_LIMITS.text) bad('text node too long');
      totalText += end - pos;
      if (totalText > EASYDROP_LIMITS.totalText) bad('too much text');
      const raw = source.slice(pos, end), top = stack[stack.length - 1];
      if (top === root) { if (raw.trim()) bad('text outside the root element'); }
      else if (top.children.length === 0 || raw.trim()) top.text += text(raw);
      pos = end;
      if (lt === -1) break;
    }
    if (source.startsWith('<!--', pos)) {
      const close = source.indexOf('-->', pos + 4);
      if (close === -1) bad('unterminated comment');
      pos = close + 3; continue;
    }
    if (source.startsWith('<!', pos) || source.startsWith('<?', pos)) bad('DOCTYPE, ENTITY, CDATA and processing instructions are not allowed');
    const gt = source.indexOf('>', pos);
    if (gt === -1 || gt - pos > EASYDROP_LIMITS.tag) bad('malformed markup');
    TAG.lastIndex = pos;
    let m;
    try { m = TAG.exec(source); } catch (e) { if (e instanceof RangeError) bad('malformed markup'); throw e; }
    if (!m) bad('malformed markup');
    pos = TAG.lastIndex;
    const [, closing, name, attrSource, selfClose] = m;
    if (closing) {
      if (selfClose || attrSource.trim() || stack.length < 2 || stack[stack.length - 1].name !== name) bad('mismatched closing tag');
      stack.pop(); continue;
    }
    const attrs = {};
    if (attrSource) { ATTR.lastIndex = 0; let a; while ((a = ATTR.exec(attrSource))) { if (Object.hasOwn(attrs, a[1])) bad('duplicate attribute'); attrs[a[1]] = text(a[2] ?? a[3]); } }
    const node = { name, attrs, children: [], text: '' }, parent = stack[stack.length - 1];
    if (parent === root && root.children.length) bad('multiple root elements');
    if (++nodes > EASYDROP_LIMITS.nodes) bad('too many elements');
    if (name === 'item' && stack.length === 3 && parent.name === 'items' && ++itemNodes > EASYDROP_LIMITS.items) fail('EasyDrop feed exceeds the 20000-item limit', 422);
    parent.children.push(node);
    if (!selfClose) { if (stack.length > EASYDROP_LIMITS.depth) bad('nesting too deep'); stack.push(node); }
  }
  if (stack.length !== 1) bad('unclosed element');
  if (!root.children.length) bad('no root element');
  return root.children[0];
}

const collapse = value => value.replace(/\s+/g, ' ').trim();
const clip = (value, max) => value.length > max ? value.slice(0, max).trim() : value;
const child = (node, name) => node.children.find(c => c.name === name);

/** Exact decimal UAH -> integer kopecks (half-up on the third decimal). Whole numbers, "." or "," decimals. */
export function easydropUahToMinor(value) {
  const input = typeof value === 'string' ? value.trim().replace(',', '.') : '';
  if (!/^\d{1,9}(?:\.\d+)?$/.test(input)) throw new Skip('price_invalid');
  const [whole, fraction = ''] = input.split('.');
  const minor = Number(whole) * 100 + Number((fraction + '00').slice(0, 2)) + (Number(fraction[2] || '0') >= 5 ? 1 : 0);
  if (minor <= 0 || minor > 100000000) throw new Skip('price_invalid');
  return minor;
}

function stockOf(item) {
  // Quantity counts only when at least one availability flag is present and every present flag is "true".
  const flags = [item.attrs.available, child(item, 'available')?.text].filter(v => v !== undefined).map(v => v.trim().toLowerCase());
  if (!flags.length || !flags.every(f => f === 'true')) return 0;
  const q = child(item, 'quantity_in_stock')?.text.trim();
  if (q === undefined || !/^\d{1,9}$/.test(q)) return 0;
  return Math.min(Number(q), 1000000);
}

const HTML_MAX = 4 * EASYDROP_LIMITS.description;
const BLOCK_TAG = /^(?:br\b|\/(?:p|div|li|tr|h[1-6])\b)/i;
const HTML_ENTITY = /&(?:#(\d{1,7})|#[xX]([0-9a-fA-F]{1,6})|(lt|gt|amp|quot|apos|nbsp));/g;
/** HTML (already entity-decoded by the XML layer) -> plain text; block ends become newlines.
 * Linear time: input is bounded first and tags are found with a single forward indexOf scan.
 * Only tag-shaped sequences (`<x`, `</x`, `<!`) are removed, so "a < b" keeps its text. */
export function htmlToText(html) {
  if (html.length > HTML_MAX) html = html.slice(0, HTML_MAX);
  const n = html.length;
  let out = '', i = 0, gt = -1;
  while (i < n) {
    const lt = html.indexOf('<', i);
    if (lt === -1) { out += html.slice(i); break; }
    out += html.slice(i, lt);
    if (gt <= lt) { gt = html.indexOf('>', lt + 1); if (gt === -1) { out += html.slice(lt); break; } }
    const next = html.indexOf('<', lt + 1), c = html.charCodeAt(lt + 1);
    const shaped = c === 33 || c === 47 || (c >= 65 && c <= 90) || (c >= 97 && c <= 122);
    if (!shaped || (next !== -1 && next < gt)) { out += '<'; i = lt + 1; continue; }
    if (BLOCK_TAG.test(html.slice(lt + 1, Math.min(gt, lt + 12)))) out += '\n';
    i = gt + 1;
  }
  out = out.replace(HTML_ENTITY, (m, dec, hex, name) => {
    if (name) return { lt: '<', gt: '>', amp: '&', quot: '"', apos: "'", nbsp: ' ' }[name.toLowerCase()];
    const code = dec ? Number(dec) : parseInt(hex, 16);
    return code >= 32 && code <= 0x10ffff && !(code >= 0xd800 && code <= 0xdfff) ? String.fromCodePoint(code) : m;
  });
  return out.split('\n').map(l => l.replace(/[ \t ]+/g, ' ').trim()).filter(Boolean).join('\n');
}

const easydropImageUrl = value => (isEasyDropImageUrl(value) ? value : null);

function buildProduct(externalId, items, categories) {
  const first = items[0];
  const title = collapse(items.map(i => child(i, 'name')?.text ?? '').find(t => collapse(t)) ?? '');
  if (!title) throw new Skip('title');
  const prices = new Set();
  for (const item of items) {
    const p = child(item, 'priceuah');
    if (!p || !p.text.trim()) throw new Skip('price_missing');
    prices.add(easydropUahToMinor(p.text));
  }
  if (prices.size > 1) throw new Skip('price_mismatch');
  const costMinor = [...prices][0];
  const categoryId = child(first, 'categoryId')?.text.trim();
  const category = clip(collapse(categories.get(categoryId) ?? ''), EASYDROP_LIMITS.category) || NO_CATEGORY;
  const bySize = new Map();
  for (const item of items) {
    const params = item.children.filter(c => c.name === 'param' && (c.attrs.name === 'Розмір' || c.attrs.name === 'Размер'));
    let size = collapse(params[0]?.text ?? '');
    if (!size) { if (items.length > 1) throw new Skip('sizes_invalid'); size = 'Один розмір'; }
    size = clip(size, 100);
    const variant = { id: item.attrs.id, size, stock: stockOf(item) };
    const key = size.toLowerCase(), existing = bySize.get(key);
    // A repeated size label keeps the item with the most stock (first wins ties).
    if (!existing || variant.stock > existing.stock) bySize.set(key, variant);
  }
  const variants = [...bySize.values()];
  if (variants.length > EASYDROP_LIMITS.variants) throw new Skip('variants');
  const photos = [];
  for (const item of items) for (const img of item.children) {
    if (img.name !== 'image' || photos.length >= EASYDROP_LIMITS.photos) continue;
    const url = easydropImageUrl(img.text.trim());
    if (url && !photos.includes(url)) photos.push(url);
  }
  const description = clip(htmlToText(items.map(i => child(i, 'description')?.text ?? '').find(t => t.trim()) ?? ''), EASYDROP_LIMITS.description);
  try { return validateSource({ externalId, title: clip(title, EASYDROP_LIMITS.title), description, category, costMinor, currency: 'UAH', photos, variants }); }
  catch { throw new Skip('invalid'); }
}

/** Parse and normalize an EasyDrop prom-export. Whole-feed problems (size, shape, zero items,
 * caps, forbidden markup) throw HttpError 422; a product that cannot be represented is skipped
 * with a counted reason. Returns {items, skipped, stats}. */
export function normalizeEasyDrop(input) {
  const shop = parseXml(input);
  if (shop.name !== 'shop') bad('root element must be <shop>');
  const catalog = child(shop, 'catalog'), list = child(shop, 'items');
  if (!catalog || !list) bad('missing <catalog> or <items>');
  const rawItems = list.children.filter(c => c.name === 'item');
  if (!rawItems.length) bad('feed contains no items');
  if (rawItems.length > EASYDROP_LIMITS.items) fail('EasyDrop feed exceeds the 20000-item limit', 422);
  const categories = new Map();
  for (const c of catalog.children) if (c.name === 'category' && c.attrs.id) {
    if (categories.size >= EASYDROP_LIMITS.categories) bad('too many categories');
    categories.set(c.attrs.id.trim(), c.text);
  }
  const itemCounts = new Map(), groups = new Map();
  for (const item of rawItems) {
    const id = (item.attrs.id ?? '').trim();
    item.attrs.id = id;
    if (id) itemCounts.set(id, (itemCounts.get(id) || 0) + 1);
    const group = (item.attrs.group_id ?? '').trim();
    // Items without a group are their own product; "o:" cannot collide with numeric group IDs.
    if (group && !/^\d{1,18}$/.test(group)) {
      const key = `x:${group}`;
      if (!groups.has(key)) groups.set(key, { externalId: key.slice(0, 100), items: [item], bad: 'id' }); else groups.get(key).items.push(item);
      continue;
    }
    const key = group || (id ? `o:${id}` : null);
    if (key === null) { groups.set(`#noid${groups.size}`, { externalId: null, items: [item], bad: 'id' }); continue; }
    const entry = groups.get(key) ?? { externalId: key, items: [], bad: null };
    if (!groups.has(key)) groups.set(key, entry);
    entry.items.push(item);
  }
  if (groups.size > EASYDROP_LIMITS.products) fail('EasyDrop feed exceeds the 5000-product sync limit', 422);
  const items = [], skipped = [];
  for (const { externalId, items: members, bad: preset } of groups.values()) {
    try {
      if (preset) throw new Skip(preset);
      // A duplicated item ID is ambiguous (order routing uses it): skip the products involved.
      if (externalId.length > 200 || members.some(i => !i.attrs.id || i.attrs.id.length > 200 || itemCounts.get(i.attrs.id) > 1)) throw new Skip('id');
      items.push(buildProduct(externalId, members, categories));
    } catch (error) {
      if (!(error instanceof Skip)) throw error;
      skipped.push({ externalId, reason: error.reason });
    }
  }
  return { items, skipped, stats: { items: rawItems.length, products: groups.size, categories: categories.size } };
}

/** Human-readable run note, same format as MyDrop's skippedSummary. */
export function easydropSkippedSummary(skipped, total) {
  if (!skipped.length) return null;
  const counts = new Map();
  for (const s of skipped) counts.set(s.reason, (counts.get(s.reason) || 0) + 1);
  return `Пропущено ${skipped.length} з ${total} товарів: ${[...counts].map(([r, n]) => `${EASYDROP_SKIP_REASONS[r] || r} — ${n}`).join('; ')}`;
}
