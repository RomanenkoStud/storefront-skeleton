import { inStockSizes } from '../cart/cart-store.js';
import { formatPrice } from '../../../../packages/catalog/price.js';

// A tile takes one grid slot after every 11 products, so tiles sit at slots 12, 24, 36...
// 12 slots divide into whole rows at 2, 3, 4 and 6 columns, so a tile never leaves a hole in the middle of the grid.
export const POSTER_EVERY = 11;
export const POSTER_MIN_PRODUCTS = 12;
const MIN_CATEGORY_ITEMS = 3;

/** Search, category, brand, size, price or availability narrowing. Sort and paging are not filters. */
export function postersSuppressed(filters = {}) {
  return !!(filters.q || filters.category || filters.brands?.length || filters.sizes?.length || filters.min !== '' && filters.min != null || filters.max !== '' && filters.max != null || filters.available);
}

/** "1 річ", "2 речі", "5 речей" (Ukrainian plural). */
export function itemsLabel(n, pairs = false) {
  const m10 = n % 10, m100 = n % 100;
  const one = m10 === 1 && m100 !== 11, few = m10 >= 2 && m10 <= 4 && (m100 < 12 || m100 > 14);
  return `${n} ${pairs ? (one ? 'пара' : few ? 'пари' : 'пар') : (one ? 'річ' : few ? 'речі' : 'речей')}`;
}

/**
 * Categories a tile can advertise, computed from the loaded catalog: in-stock count and from-price per category.
 * Only categories with a rack cut-out qualify (no type-only tiles); by size, ties by id so the order is stable.
 */
export function posterCategories(products, { getCategory, cutouts = {} } = {}) {
  // Grouped by the canonical category id so aliases share one tile; "unclassified" never gets one.
  const groups = new Map();
  for (const p of products || []) {
    if (!p?.categoryId || inStockSizes(p.variants).length === 0) continue;
    const node = getCategory?.(p.categoryId);
    if (!node || node.id === 'unclassified') continue;
    const g = groups.get(node.id) || { node, count: 0, fromMinor: Infinity };
    g.count += 1;
    const price = Number(p.priceMinor);
    if (price > 0) g.fromMinor = Math.min(g.fromMinor, price);
    groups.set(node.id, g);
  }
  const out = [];
  for (const [id, g] of groups) {
    const node = g.node;
    const cutout = cutouts[id] || null;
    if (!cutout || g.count < MIN_CATEGORY_ITEMS || !Number.isFinite(g.fromMinor)) continue; // cut-outs only: no type-only tiles
    out.push({ id, label: node.label, pairs: !!node.ancestors?.includes('footwear'), kicker: node.path?.length > 1 ? node.path[node.path.length - 2] : '', count: g.count, fromMinor: g.fromMinor, price: formatPrice(g.fromMinor), cutout });
  }
  return out.sort((a, b) => b.count - a.count || (a.id < b.id ? -1 : 1));
}

/**
 * Pure: returns the shown products with poster tiles mixed in, `{ poster: true, key, tone, ...category }`.
 * ctx = { products (whole catalog), filters, getCategory, cutouts }. No tiles while filtering/searching or with fewer
 * than 12 products shown; a category appears at most once; a tile never ends the list.
 */
export function withPosters(items, ctx = {}) {
  const list = Array.isArray(items) ? items : [];
  if (list.length < POSTER_MIN_PRODUCTS || postersSuppressed(ctx.filters)) return list;
  const categories = posterCategories(ctx.products, ctx);
  const out = [];
  let tile = 0;
  list.forEach((item, i) => {
    out.push(item);
    const more = i + 1 < list.length;
    if ((i + 1) % POSTER_EVERY === 0 && more && tile < categories.length) {
      out.push({ poster: true, key: `poster-${categories[tile].id}`, tone: tile % 2 ? 'moss' : 'lime', ...categories[tile] });
      tile += 1;
    }
  });
  return out;
}
