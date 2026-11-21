// Cross-supplier duplicate detection. Pure and deterministic: no network, no model calls.
// Input is a list of admin projections reduced to matching fields; output is candidate groups with evidence
// that a manager reviews. Decisions (confirmed groups, rejected pairs) are passed in and always win.

// A key (photo, code, title token) repeated within one supplier is a placeholder, colourway family or generic word,
// so it is not evidence. Keys spread across many suppliers stay usable: popular items are the likeliest duplicates.
// The totals only bound comparison work.
export const DUPLICATE_LIMITS = Object.freeze({ groupSize: 20, keyPerSupplier: 3, keyProducts: 60, tokenPerSupplier: 6, tokenProducts: 120 });
export const TITLE_MATCH = Object.freeze({ overlap: 0.8, sharedTokens: 3 });

const fold = value => String(value ?? '').normalize('NFKC').toLowerCase().replace(/ё/g, 'е').replace(/[ʼ'’‘`´"«»“”]/g, '');
// Measurement suffixes are not model codes ("250ml", "30cm").
const UNIT = /^\d+(?:[.,]\d+)?(?:ml|mm|cm|m|kg|g|l|gb|tb|pcs|шт|мл|см|мм|кг|г|л)$/;

/** Word tokens of a title: letters/digits, at least 2 characters, or any digit run (model numbers such as "1"). */
export function titleTokens(title) {
  const words = fold(title).match(/[\p{L}\p{N}]+/gu) || [];
  return [...new Set(words.filter(word => word.length >= 2 || /\d/.test(word)))];
}

/**
 * Manufacturer/model codes in a title, such as "QA2291-100", "TB-0001" or "574 v2" style tokens.
 * A code is a separator-joined Latin/digit token whose compact form has 5–24 characters, at least one digit,
 * and either a Latin letter or at least 6 digits. Sizes ("36-45"), years and units do not qualify.
 */
export function modelCodes(title) { return [...codeInfo(title).codes]; }
function codeInfo(title) {
  const found = new Set(), bases = new Map();
  const ok = (raw, compact) => compact.length >= 5 && compact.length <= 24 && /\d/.test(compact) && !UNIT.test(raw) && (/[a-z]/.test(compact) || compact.replace(/\D/g, '').length >= 6);
  const add = (raw, compact) => { if (ok(raw, compact)) found.add(compact); };
  const folded = fold(title);
  for (const raw of folded.match(/[a-z0-9]+(?:[-/._][a-z0-9]+)*/g) || []) {
    const full = raw.replace(/[-/._]/g, '');
    add(raw, full);
    // The base style code also matches on its own: "QA2291-100" ~ "QA2291 100". Its full code is remembered so
    // two different colourways ("QA2291-100" vs "QA2291-001") do not match on the shared base.
    const parts = raw.split(/[-/._]/);
    if (parts.length > 1) for (const part of parts) if (/[a-z]/.test(part) && /\d/.test(part) && ok(part, part)) { found.add(part); if (ok(raw, full)) bases.set(part, full); }
  }
  const words = folded.match(/[\p{L}\p{N}]+/gu) || [];
  for (let i = 0; i + 1 < words.length; i++) {
    const [word, next] = [words[i], words[i + 1]];
    // A short letter prefix separated by a space joins the following number: "FS 7001" ~ "FS-7001". Years are not codes.
    if (/^[a-z]{1,4}$/.test(word) && /^\d{3,8}$/.test(next) && !/^(?:19|20)\d\d$/.test(next)) add(word + next, word + next);
    // A style code followed by a space-separated colour number is a full code too: "LX4410 006" ~ "LX4410-006".
    if (/[a-z]/.test(word) && /\d/.test(word) && ok(word, word) && /^\d{3}$/.test(next) && ok(word + next, word + next)) { found.add(word + next); bases.set(word, word + next); }
  }
  return { codes: found, bases };
}

// Colour words (Ukrainian stems and English). Two titles naming only different colours are different colourways.
const COLOURS = [['white', /^(?:white|біл|off-?white)/], ['black', /^(?:black|чорн)/], ['grey', /^(?:gr[ae]y|сір)/], ['brown', /^(?:brown|корич)/], ['green', /^(?:green|olive|зелен|оливк|хакі|khaki)/], ['blue', /^(?:blue|navy|син|блакит)/], ['red', /^(?:red|червон|бордо)/], ['pink', /^(?:pink|рожев)/], ['beige', /^(?:beige|cream|бежев|кремов)/], ['yellow', /^(?:yellow|жовт)/], ['orange', /^(?:orange|помаранч|оранж)/], ['purple', /^(?:purple|violet|фіолет|бузков)/], ['silver', /^(?:silver|срібл)/], ['gold', /^(?:gold|золот)/]];
export function colours(title) {
  const found = new Set();
  for (const token of titleTokens(title)) for (const [name, pattern] of COLOURS) if (pattern.test(token)) found.add(name);
  return [...found];
}

const pairKey = (a, b) => (a < b ? `${a}|${b}` : `${b}|${a}`);
const brandKey = value => (typeof value === 'string' && value.trim() ? fold(value).trim() : null);
const rootCategory = path => (Array.isArray(path) && path.length && path[0] ? fold(path[0]) : null);

function index(products, keysOf, perSupplier, total) {
  const map = new Map();
  for (const product of products) for (const key of keysOf(product)) { const list = map.get(key) || []; list.push(product); map.set(key, list); }
  for (const [key, list] of map) {
    const counts = new Map();
    for (const product of list) counts.set(product.supplierId, (counts.get(product.supplierId) || 0) + 1);
    if (counts.size < 2 || list.length > total || Math.max(...counts.values()) > perSupplier) map.delete(key);
  }
  return map;
}

/**
 * Find candidate groups.
 * @param {Array<{id:string,supplierId:string,title:string,brand?:string|null,categoryPath?:string[],categoryId?:string,photos?:string[]}>} products
 *   active (not trashed) products of non-deleted suppliers; `title` and `photos` should be the supplier source values.
 * @param {{rejectedPairs?:Iterable<[string,string]>, groups?:Array<{id:string,productIds:string[]}>}} decisions
 * @returns {Array<{key:string,groupId:string|null,productIds:string[],confidence:'high'|'medium',pairs:Array}>}
 */
export function findDuplicateCandidates(products, { rejectedPairs = [], groups = [] } = {}) {
  const rejected = new Set([...rejectedPairs].map(([a, b]) => pairKey(a, b)));
  const groupOf = new Map();
  for (const group of groups) for (const productId of group.productIds) groupOf.set(productId, group.id);
  const prepared = products.map(p => ({
    ...p,
    tokens: titleTokens(p.title),
    ...(({ codes, bases }) => ({ codes: [...codes], bases }))(codeInfo(p.title)),
    photoSet: [...new Set((p.photos || []).filter(url => typeof url === 'string' && /^https:/.test(url)))],
    brandKey: brandKey(p.brand),
    colours: colours(p.title),
    root: p.categoryId === 'unclassified' ? null : rootCategory(p.categoryPath)
  }));
  const byId = new Map(prepared.map(p => [p.id, p]));

  // Blocking: only products sharing a photo, a code, or two rare title tokens are compared.
  const { keyPerSupplier, keyProducts, tokenPerSupplier, tokenProducts } = DUPLICATE_LIMITS;
  const photos = index(prepared, p => p.photoSet, keyPerSupplier, keyProducts);
  const codes = index(prepared, p => p.codes, keyPerSupplier, keyProducts);
  const tokens = index(prepared, p => p.tokens, tokenPerSupplier, tokenProducts);
  const evidence = new Map();
  const note = (a, b, reason) => {
    if (a.supplierId === b.supplierId) return;
    const key = pairKey(a.id, b.id);
    if (rejected.has(key)) return;
    const ga = groupOf.get(a.id), gb = groupOf.get(b.id);
    if (ga && gb) return; // Already decided (same group) or two confirmed groups: never auto-merge groups.
    let entry = evidence.get(key);
    if (!entry) { entry = { a: a.id < b.id ? a.id : b.id, b: a.id < b.id ? b.id : a.id, reasons: [] }; evidence.set(key, entry); }
    if (!entry.reasons.some(r => r.kind === reason.kind && r.value === reason.value)) entry.reasons.push(reason);
  };
  for (const list of photos.values()) for (let i = 0; i < list.length; i++) for (let j = i + 1; j < list.length; j++) note(list[i], list[j], { kind: 'photo' });
  for (const [code, list] of codes) for (let i = 0; i < list.length; i++) for (let j = i + 1; j < list.length; j++) {
    const a = list[i], b = list[j];
    if (a.bases.has(code) && b.bases.has(code) && a.bases.get(code) !== b.bases.get(code)) continue; // different colourways
    note(a, b, { kind: 'code', value: code });
  }
  const shared = new Map();
  for (const list of tokens.values()) for (let i = 0; i < list.length; i++) for (let j = i + 1; j < list.length; j++) {
    if (list[i].supplierId === list[j].supplierId) continue;
    const key = pairKey(list[i].id, list[j].id);
    shared.set(key, (shared.get(key) || 0) + 1);
  }
  for (const [key, count] of shared) {
    if (count < 2) continue;
    const [x, y] = key.split('|'), a = byId.get(x), b = byId.get(y);
    const common = a.tokens.filter(t => b.tokens.includes(t)).length;
    const overlap = common / Math.min(a.tokens.length, b.tokens.length);
    const identical = common === a.tokens.length && common === b.tokens.length && common >= 2;
    const sameBrand = !!a.brandKey && a.brandKey === b.brandKey;
    if (identical || (sameBrand && common >= TITLE_MATCH.sharedTokens && overlap >= TITLE_MATCH.overlap)) note(a, b, { kind: 'title', score: Math.round(overlap * 100) / 100 });
  }

  // Conflicts veto weak evidence: different known brands always, different top-level categories unless a photo is shared.
  const pairs = [];
  for (const entry of evidence.values()) {
    const a = byId.get(entry.a), b = byId.get(entry.b);
    if (a.brandKey && b.brandKey && a.brandKey !== b.brandKey) continue;
    const photo = entry.reasons.some(r => r.kind === 'photo');
    if (!photo && a.root && b.root && a.root !== b.root) continue;
    // Different colourways of one model: both name colours and share none. A shared photo or full code overrides.
    const fullCode = entry.reasons.some(r => r.kind === 'code' && [...a.bases.values()].includes(r.value) && [...b.bases.values()].includes(r.value));
    if (!photo && !fullCode && a.colours.length && b.colours.length && !a.colours.some(c => b.colours.includes(c))) continue;
    const strong = photo || entry.reasons.some(r => r.kind === 'code');
    if (a.brandKey && a.brandKey === b.brandKey) entry.reasons.push({ kind: 'brand', value: a.brand.trim() });
    pairs.push({ ...entry, confidence: strong ? 'high' : 'medium' });
  }

  // Union-find; a confirmed group acts as one node so new matches become an "add to group" proposal.
  const parent = new Map();
  const find = x => { while (parent.get(x) !== x) { parent.set(x, parent.get(parent.get(x))); x = parent.get(x); } return x; };
  const node = productId => { const n = groupOf.has(productId) ? `g:${groupOf.get(productId)}` : productId; if (!parent.has(n)) parent.set(n, n); return n; };
  // Each component remembers the colours its members name; two components naming only different colours are
  // different colourways and are not chained through a colourless title.
  const tint = new Map();
  const tintOf = n => tint.get(n) ?? new Set(n.startsWith('g:') ? [] : byId.get(n).colours);
  const union = (x, y) => {
    const rx = find(x), ry = find(y); if (rx === ry) return true; if (rx.startsWith('g:') && ry.startsWith('g:')) return false;
    const cx = tintOf(rx), cy = tintOf(ry);
    if (cx.size && cy.size && ![...cx].some(c => cy.has(c))) return false;
    const [child, root] = ry.startsWith('g:') ? [rx, ry] : [ry, rx];
    parent.set(child, root); tint.set(root, new Set([...cx, ...cy])); return true;
  };
  const accepted = [];
  // Stable order: strong pairs first, then by IDs, so a chain through two groups is cut deterministically.
  pairs.sort((p, q) => (p.confidence === q.confidence ? 0 : p.confidence === 'high' ? -1 : 1) || p.a.localeCompare(q.a) || p.b.localeCompare(q.b));
  for (const pair of pairs) if (union(node(pair.a), node(pair.b))) accepted.push(pair);

  const components = new Map();
  for (const pair of accepted) {
    const root = find(node(pair.a));
    let component = components.get(root);
    if (!component) { component = { ids: new Set(), pairs: [] }; components.set(root, component); }
    component.ids.add(pair.a); component.ids.add(pair.b); component.pairs.push(pair);
  }
  const result = [];
  for (const [root, component] of components) {
    const groupId = root.startsWith('g:') ? root.slice(2) : null;
    const productIds = [...component.ids].filter(productId => !groupId || groupOf.get(productId) !== groupId).sort();
    if (!productIds.length) continue;
    const groupMembers = groupId ? groups.find(g => g.id === groupId).productIds.filter(productId => byId.has(productId)).sort() : [];
    if (!groupId && new Set(productIds.map(productId => byId.get(productId).supplierId)).size < 2) continue;
    const confidence = component.pairs.some(p => p.confidence === 'high') ? 'high' : 'medium';
    result.push({ key: groupId ? `g:${groupId}:${productIds.join(',')}` : productIds.join(','), groupId, groupProductIds: groupMembers, productIds, confidence, pairs: component.pairs.map(({ a, b, reasons, confidence: c }) => ({ a, b, reasons, confidence: c })) });
  }
  return result.sort((x, y) => (x.confidence === y.confidence ? 0 : x.confidence === 'high' ? -1 : 1) || (y.productIds.length + y.groupProductIds.length) - (x.productIds.length + x.groupProductIds.length) || x.key.localeCompare(y.key));
}

export { pairKey };
