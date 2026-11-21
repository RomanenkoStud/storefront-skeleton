import { normalizeSize } from '../../../packages/catalog/sizes.js';
export { normalizeSize };
import { inStockSizes } from './cart/cart-store.js';
import { categoryMatches } from '../../../packages/catalog/taxonomy.js';

// `shown` is how many cards the grid renders: PAGE_SIZE * pages, kept in the URL as `shown` (omitted at the default).
export const PAGE_SIZE = 24;
export const MAX_SHOWN = PAGE_SIZE * 100;
export const EMPTY_FILTERS = { q: '', category: '', brands: [], sizes: [], min: '', max: '', available: false, sort: 'new', shown: PAGE_SIZE };
const SORTS = ['new', 'price-asc', 'price-desc', 'title'];
// Invalid, fractional, negative or oversized values fall back to a whole number of pages within [PAGE_SIZE, MAX_SHOWN].
export function parseShown(value) {
  if (!/^\d+$/.test(value || '')) return PAGE_SIZE;
  return Math.min(MAX_SHOWN, Math.max(PAGE_SIZE, Math.ceil(Number(value) / PAGE_SIZE) * PAGE_SIZE));
}
// Any change other than an explicit `shown` goes back to the first page of results.
export function changeFilters(current, patch) {
  const next = typeof patch === 'function' ? patch(current) : { ...current, ...patch };
  const explicit = typeof patch !== 'function' && Object.hasOwn(patch, 'shown');
  return explicit ? { ...next, shown: parseShown(String(next.shown)) } : { ...next, shown: PAGE_SIZE };
}
export function readFilters(search = '') {
  const p = new URLSearchParams(search);
  const price = key => /^\d+(\.\d{1,2})?$/.test(p.get(key) || '') ? p.get(key) : '';
  return { q: p.get('q') || '', category: p.get('category') || '', brands: [...new Set(p.getAll('brand').filter(Boolean))], sizes: [...new Set(p.getAll('size').filter(Boolean))], min: price('min'), max: price('max'), available: p.get('available') === '1', sort: SORTS.includes(p.get('sort')) ? p.get('sort') : 'new', shown: parseShown(p.get('shown')) };
}
export function writeFilters(filters) {
  const p = new URLSearchParams();
  if (filters.q) p.set('q', filters.q);
  if (filters.category) p.set('category', filters.category);
  for (const value of filters.brands) p.append('brand', value);
  for (const value of filters.sizes) p.append('size', value);
  if (filters.min !== '') p.set('min', filters.min);
  if (filters.max !== '') p.set('max', filters.max);
  if (filters.available) p.set('available', '1');
  if (filters.sort !== 'new') p.set('sort', filters.sort);
  if (filters.shown > PAGE_SIZE) p.set('shown', String(parseShown(String(filters.shown))));
  return p.toString();
}
// Pass-through kept for its callers (the old ?intro switch is gone; a stale ?intro= in a URL is ignored and dropped on rewrite).
export function withPreserved(query, search = '') { return query; }
// Default sort: in-stock first, sold-out (no variant with stock, same rule as the card) after; each group newest updatedAt first.
const soldOut = p => inStockSizes(p.variants).length === 0;
const newestFirst = (a, b) => (soldOut(a) - soldOut(b)) || (Date.parse(b.updatedAt) || 0) - (Date.parse(a.updatedAt) || 0);
export function filterProducts(products, f, taxonomy=null) {
  return products.filter(p => (!f.q || `${p.title} ${p.description} ${p.brand || ''} ${p.category || ''}`.toLocaleLowerCase('uk-UA').includes(f.q.toLocaleLowerCase('uk-UA')))
    && (!f.category || categoryMatches(p.categoryId || 'unclassified', f.category,taxonomy))
    && (!f.brands.length || f.brands.includes(p.brand))
    && (!f.sizes.length || p.variants?.some(v => v.stock > 0 && f.sizes.includes(normalizeSize(v.size))))
    && (!f.available || p.variants?.some(v => v.stock > 0))
    && (f.min === '' || p.priceMinor >= Math.round(Number(f.min) * 100))
    && (f.max === '' || p.priceMinor <= Math.round(Number(f.max) * 100)))
    .sort((a,b) => f.sort === 'price-asc' ? a.priceMinor - b.priceMinor : f.sort === 'price-desc' ? b.priceMinor - a.priceMinor : f.sort === 'title' ? a.title.localeCompare(b.title, 'uk') : newestFirst(a, b));
}
