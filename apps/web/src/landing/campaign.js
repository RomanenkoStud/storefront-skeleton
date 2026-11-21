// Pure helpers for the campaign band. Every fact (category, in-stock count, brands, from-price) is computed from the
// loaded products; nothing here is hardcoded copy about stock.
import { formatPrice } from '../../../../packages/catalog/price.js';
import { DEFAULT_SCENE_ID, getScene, sceneLayout } from '../../../../packages/catalog/campaign-scenes.js';

export const MAX_BRANDS = 4;
export const inStock = p => (p?.variants || []).some(v => v.stock > 0);

// Ukrainian plural of "модель": 1 модель, 2-4 моделі, 5-20 моделей, 21 модель ...
export function modelsLabel(n) {
  const m10 = n % 10, m100 = n % 100;
  const word = m10 === 1 && m100 !== 11 ? 'модель' : m10 >= 2 && m10 <= 4 && (m100 < 12 || m100 > 14) ? 'моделі' : 'моделей';
  return `${n} ${word}`;
}

// Picture library + rail cut-outs (ADR-0015 Decision 3). Library pictures first (staff order), then the rail cut-outs
// front, angle, side (L3 "mix"), de-duplicated by src. Set to false for library-only once a category has a picture.
export const MIX_RAIL_FALLBACK = true;
const LIBRARY_SRC = /^\/media\/campaign\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.(?:png|webp)$/;
const isPicture = x => x && typeof x.src === 'string' && Number.isFinite(x.w) && Number.isFinite(x.h) && x.w > 0 && x.h > 0;
// rail: rail-media.json "clothes" [{categoryId, front, side, angle}]; libraryPictures: public { categoryId: [{src,w,h}] }.
// Returns [{ categoryId, pictures: [{src,w,h}] }] for every category with at least one picture.
export function campaignArt(rail, libraryPictures) {
  const lib = new Map();
  if (libraryPictures && typeof libraryPictures === 'object') {
    for (const [categoryId, list] of Object.entries(libraryPictures)) {
      // Only the public campaign media path is accepted, so a bad payload cannot point an <img> elsewhere.
      if (Array.isArray(list)) lib.set(categoryId, list.filter(x => isPicture(x) && LIBRARY_SRC.test(x.src)));
    }
  }
  const railBy = new Map((Array.isArray(rail) ? rail : []).filter(r => r && r.categoryId).map(r => [r.categoryId, r]));
  const ids = [...new Set([...railBy.keys(), ...lib.keys()])];
  return ids.map(categoryId => {
    const own = lib.get(categoryId) || [];
    const cut = railBy.get(categoryId);
    const fallback = cut && (MIX_RAIL_FALLBACK || !own.length) ? [cut.front, cut.angle, cut.side].filter(isPicture) : [];
    const seen = new Set();
    const pictures = [...own, ...fallback].filter(x => !seen.has(x.src) && seen.add(x.src)).map(x => ({ src: x.src, w: x.w, h: x.h }));
    return { categoryId, pictures };
  }).filter(a => a.pictures.length);
}

// Slots for the view: the scene (unknown or unavailable ids fall back to the default) and the layout for the number of
// pictures, filled in rank order. Pure so it can be unit-tested without a DOM.
export function resolveScene(scene) {
  const resolved = typeof scene === 'string' ? getScene(scene) : scene;
  return resolved && resolved.available !== false ? resolved : getScene(DEFAULT_SCENE_ID);
}
const vars = (o, p) => ({ [`--${p}x`]: o.x, [`--${p}y`]: o.y, [`--${p}w`]: o.w, [`--${p}h`]: o.h, [`--${p}z`]: o.z, [`--${p}r`]: o.r });
export function sceneSlots(scene, pictures) {
  const sc = resolveScene(scene);
  const seen = new Set();
  const list = Array.isArray(pictures) ? pictures.filter(x => isPicture(x) && !seen.has(x.src) && seen.add(x.src)) : []; // unique src: it is the React key
  const layout = sceneLayout(sc, list.length);
  if (!layout) return { scene: sc, slots: [] };
  const slots = layout.desktop.map((d, i) => {
    const m = layout.mobile[i];
    return { picture: list[i], mobileOff: !m, desktop: d, mobile: m || null, style: { ...vars(d, ''), ...(m ? vars(m, 'm') : {}) } };
  });
  return { scene: sc, slots };
}

// art: [{ categoryId, pictures: [{src,w,h}] }] from campaignArt(). Only categories with a picture can headline the band
// so the pictures always match the words. Deterministic: most in-stock items wins, ties go to the smaller category id.
// settings (admin "Вітрина"): { mode: 'auto'|'category'|'off', categoryId, excluded[] }.
// 'off' hides the band; 'category' pins one category while it has in-stock items, otherwise the automatic pick runs;
// 'excluded' removes categories (and their subcategories) from the automatic pick, e.g. shorts in winter.
export function pickCampaign(products, taxonomy, art, settings = null) {
  if (settings?.mode === 'off') return null;
  const available = new Map((art || []).filter(a => a && Array.isArray(a.pictures) && a.pictures.length).map(a => [a.categoryId, a]));
  // Same membership rule as the catalog's category filter (descendants and aliases), so the band's numbers equal what the CTA shows.
  const matches = taxonomy?.matches || ((id, parent) => id === parent);
  const sellable = p => inStock(p) && Number.isFinite(Number(p.priceMinor)) && p.priceMinor !== null && Number(p.priceMinor) > 0;
  const pool = (products || []).filter(p => p && sellable(p));
  const ranked = [...available.keys()]
    .map(categoryId => ({ categoryId, items: pool.filter(p => matches(p.categoryId || 'unclassified', categoryId)), label: taxonomy?.getCategory?.(categoryId)?.label }))
    .filter(c => c.items.length && c.label)
    .sort((a, b) => b.items.length - a.items.length || (a.categoryId < b.categoryId ? -1 : 1));
  const excluded = Array.isArray(settings?.excluded) ? settings.excluded : [];
  const pinned = settings?.mode === 'category' && settings.categoryId ? ranked.find(c => c.categoryId === settings.categoryId) : null;
  const top = pinned || ranked.find(c => !excluded.some(ex => c.categoryId === ex || matches(c.categoryId, ex)));
  if (!top) return null;
  const tally = new Map();
  for (const p of top.items) if (p.brand) tally.set(p.brand, (tally.get(p.brand) || 0) + 1);
  const brands = [...tally.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0], 'uk')).slice(0, MAX_BRANDS).map(([b]) => b);
  const minPriceMinor = Math.min(...top.items.map(p => Number(p.priceMinor)));
  const cut = available.get(top.categoryId);
  return {
    categoryId: top.categoryId, label: top.label, count: top.items.length, brands,
    minPriceMinor: Number.isFinite(minPriceMinor) ? minPriceMinor : null,
    images: cut.pictures,
  };
}

// "22 моделі в наявності. Dölor, Excepteur. Від 2 500 грн."
export function campaignLead(c) {
  const parts = [`${modelsLabel(c.count)} в наявності.`];
  if (c.brands.length) parts.push(`${c.brands.join(', ')}.`);
  if (c.minPriceMinor !== null) parts.push(`Від ${formatPrice(c.minPriceMinor)}.`);
  return parts.join(' ');
}

export function campaignHref(categoryId) { return `/?category=${encodeURIComponent(categoryId)}&available=1#catalog`; }

// Public storefront settings (campaign + ticker), fetched once per page load. Any failure means the defaults.
let settingsPromise = null;
export function loadStorefrontSettings(fetcher = () => fetch('/api/storefront', { credentials: 'same-origin' }).then(r => (r.ok ? r.json() : {}))) {
  settingsPromise ||= Promise.resolve().then(fetcher).then(data => (data && typeof data === 'object' ? data : {})).catch(() => ({}));
  return settingsPromise;
}
export const loadCampaignSettings = () => loadStorefrontSettings().then(d => d.campaign || null);
export const DEFAULT_TICKER_ITEMS = ['НОВІ НАДХОДЖЕННЯ', 'STREETWEAR', 'LOREM STORE'];
export function tickerItems(ticker) {
  if (ticker?.enabled === false) return [];
  const items = Array.isArray(ticker?.items) ? ticker.items.filter(x => typeof x === 'string' && x.trim()) : [];
  return items.length ? items : DEFAULT_TICKER_ITEMS;
}
