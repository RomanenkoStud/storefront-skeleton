// Pure price and availability helpers for the cart page.
import { inStockSizes } from './cart-store.js';

export const lineTotal = line => (Number.isSafeInteger(line?.priceMinor) ? line.priceMinor * line.quantity : null);
/** {total, complete}: complete only when every line has a known price. */
export function cartSum(lines) {
  let total = 0, complete = true;
  for (const l of lines) { const t = lineTotal(l); if (t === null) complete = false; else total += t; }
  return { total, complete };
}
/** True when the server total differs from the exact local sum shown before submit. */
export const priceDrifted = (localTotal, serverTotal) => Number.isSafeInteger(localTotal) && Number.isSafeInteger(serverTotal) && localTotal !== serverTotal;
/**
 * catalog: Map productId -> freshly loaded product. A line is flagged only when its product loaded but the size is no
 * longer in stock. Products that failed to load (including 404: renamed slugs 404 on the API) are never flagged.
 */
export function lineUnavailable(line, catalog) {
  const product = catalog.get(line.productId);
  return !!product && !inStockSizes(product.variants).some(s => s.size === line.size);
}
/** One boolean per line, aligned with `lines`. */
export const unavailableFlags = (lines, catalog) => lines.map(l => lineUnavailable(l, catalog));
/** Fetches each unique slug (read-only) with a small concurrency limit; every failure is ignored. */
export async function loadCatalogHints(lines, fetchProduct, limit = 4) {
  const slugs = [...new Set(lines.map(l => l.slug).filter(Boolean))].slice(0, 20);
  const found = [];
  let next = 0;
  async function worker() {
    while (next < slugs.length) {
      const slug = slugs[next++];
      try { found.push(await fetchProduct(slug)); } catch { /* keep stored hints */ }
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, slugs.length) }, worker));
  return { found };
}
