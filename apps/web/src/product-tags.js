// Internal manager tags (admin only; the server never sends them to customers).
// Mirrors the server rules in apps/api/src/domain.js normalizeTags so the editor rejects early.
// NO_TAGS contains a control character, which the server never accepts in a tag, so it cannot collide.
export const TAG_MAX_COUNT = 20, TAG_MAX_LENGTH = 40, NO_TAGS = '\u0000untagged';
const INVALID = /[\p{Cc}\p{Cf}\p{Co}\p{Cs}\p{Cn}]/u, MEANINGFUL = /[\p{L}\p{N}]/u;
export const tagKey = tag => String(tag).normalize('NFC').trim().replace(/\s+/g, ' ').toLocaleLowerCase('uk');
const byLabel = (a, b) => a.localeCompare(b, 'uk', { sensitivity: 'base' });

/** Adds comma/Enter-separated input to the list; returns {tags, error}. */
export function addTags(current, input) {
  const tags = [...current], seen = new Set(tags.map(tagKey));
  for (const raw of String(input).split(',')) {
    const tag = raw.normalize('NFC').trim().replace(/\s+/g, ' ');
    if (!tag || seen.has(tagKey(tag))) continue;
    if (INVALID.test(tag) || !MEANINGFUL.test(tag)) return { tags: current, error: 'Мітка містить недопустимі символи або не має літер чи цифр.' };
    if (tag.length > TAG_MAX_LENGTH) return { tags: current, error: `Мітка задовга: до ${TAG_MAX_LENGTH} символів.` };
    if (tags.length >= TAG_MAX_COUNT) return { tags: current, error: `Не більше ${TAG_MAX_COUNT} міток на товар.` };
    seen.add(tagKey(tag)); tags.push(tag);
  }
  return { tags, error: '' };
}

/** Every tag in use, one spelling per case-insensitive key, sorted A–Я. */
export function tagsInUse(products) {
  const labels = new Map();
  for (const product of products) for (const tag of product.tags ?? []) if (!labels.has(tagKey(tag))) labels.set(tagKey(tag), tag);
  return [...labels.values()].sort(byLabel);
}

export function matchesTagFilter(product, filter) {
  if (!filter) return true;
  const tags = product.tags ?? [];
  return filter === NO_TAGS ? tags.length === 0 : tags.some(tag => tagKey(tag) === tagKey(filter));
}

/** Sort for the admin list: '' keeps server order; 'tags' groups by alphabetically first tag, untagged last. */
export function sortProducts(products, order) {
  if (order !== 'tags') return products;
  const first = p => [...(p.tags ?? [])].sort(byLabel)[0];
  return products.map((p, i) => [p, i]).sort(([a, i], [b, j]) => {
    const x = first(a), y = first(b);
    if (x && y) return byLabel(x, y) || i - j;
    return (x ? 0 : 1) - (y ? 0 : 1) || i - j;
  }).map(([p]) => p);
}
