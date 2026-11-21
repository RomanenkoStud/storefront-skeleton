// Fresh-drop pick for the hero (ADR-0014, lead default L-2). Pure and deterministic.
import { inStockSizes } from '../cart/cart-store.js';

export const FRESH_DROP_COUNT = 3;
const stamp = value => Date.parse(value) || 0;
const group = item => (item?.categoryId && item.categoryId !== 'unclassified' ? item.categoryId : 'unclassified');

export function isFreshEligible(item) {
  return !!item?.photos?.[0] && Number.isSafeInteger(item.priceMinor) && item.priceMinor > 0 && inStockSizes(item.variants).length > 0;
}

/**
 * In stock, has a photo, price above zero; newest updatedAt first (slug breaks ties).
 * One item per category first (newest of each), then the places left are filled with the next newest overall.
 * With a single category that is strictly the newest items (lead decision L-2).
 */
export function pickFreshDrop(items, count = FRESH_DROP_COUNT) {
  const eligible = (Array.isArray(items) ? items : []).filter(isFreshEligible)
    .sort((a, b) => (stamp(b.updatedAt) - stamp(a.updatedAt)) || (String(a.slug) < String(b.slug) ? -1 : String(a.slug) > String(b.slug) ? 1 : 0));
  const firstPerGroup = [];
  const seen = new Set();
  for (const item of eligible) {
    const key = group(item);
    if (!seen.has(key)) { seen.add(key); firstPerGroup.push(item); }
  }
  const picks = firstPerGroup.slice(0, count);
  for (const item of eligible) { if (picks.length >= count) break; if (!picks.includes(item)) picks.push(item); }
  return picks;

}

/** "1 річ", "2 речі", "5 речей", "21 річ": Ukrainian plural for the catalog count. */
export function thingsLabel(n) {
  const last = n % 10, tens = n % 100;
  const word = tens >= 11 && tens <= 14 ? 'речей' : last === 1 ? 'річ' : last >= 2 && last <= 4 ? 'речі' : 'речей';
  return `${n} ${word}`;
}
