// Pure helpers: staff-chosen storefront images (rack + poster tiles) over the shipped renders, and the sale banner.
// Public payload: GET /api/storefront -> storefrontImages { [categoryId]: { front, side, angle, shoe, poster } }, banner.

// Only the public storefront media path is accepted, so a bad payload cannot point an <img> elsewhere.
const STOREFRONT_SRC = /^\/media\/storefront\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.(?:png|webp)$/;
export const RACK_SLOTS = Object.freeze(['front', 'angle', 'side']);
const isImage = x => !!x && typeof x.src === 'string' && STOREFRONT_SRC.test(x.src) && Number.isFinite(x.w) && Number.isFinite(x.h) && x.w > 0 && x.h > 0;
const pick = x => ({ src: x.src, w: x.w, h: x.h });

/** { categoryId: { slot: {src,w,h} } } with every invalid entry dropped. */
export function cleanImages(raw) {
  const out = {};
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return out;
  for (const [id, slots] of Object.entries(raw)) {
    if (!slots || typeof slots !== 'object') continue;
    for (const [slot, v] of Object.entries(slots)) if (isImage(v)) (out[id] ||= {})[slot] = pick(v);
  }
  return out;
}

/**
 * The rack with overrides. The shipped side/angle renders belong to a different garment, so a replaced front never
 * keeps them: without its own side it turns on the side face as the new front (foreshortened like its neighbours);
 * the angle face is only used for a real three-quarter picture (on it a front picture would face the viewer flat).
 * A shoe slot replaces the shelf pair.
 */
export function rackWithImages(rail, images) {
  const own = cleanImages(images);
  const clothes = (rail?.clothes || []).map(x => {
    const o = own[x.categoryId];
    if (!o || !RACK_SLOTS.some(s => o[s])) return x;
    const front = o.front || x.front;
    const replaced = !!o.front;
    return { ...x, front, angle: o.angle || (replaced ? undefined : x.angle), side: o.side || (replaced ? front : x.side) };
  });
  const shoes = (rail?.shoes || []).map(x => { const o = own[x.categoryId]?.shoe; return o ? { ...x, ...o } : x; });
  return { ...rail, clothes, shoes };
}

/** Poster tile cut-out per category: poster override, then the (possibly replaced) rack front or shoe. */
export function posterCutouts(rail, images) {
  const own = cleanImages(images), rack = rackWithImages(rail, own);
  const out = Object.fromEntries([...rack.clothes.map(x => [x.categoryId, x.front]), ...rack.shoes.map(x => [x.categoryId, { src: x.src, w: x.w, h: x.h }])]);
  for (const [id, slots] of Object.entries(own)) if (slots.poster) out[id] = slots.poster;
  return out;
}

// Same rule as the server: a page of this shop ("/..."), never another host.
export const isSameSitePath = x => typeof x === 'string' && /^\/(?![/\\])[^\s<>"]*$/.test(x);

/** The banner to render, or null. The server already applies the schedule; endsAt is re-checked for long-open tabs. */
export function bannerView(banner, now = Date.now()) {
  if (!banner || typeof banner !== 'object' || typeof banner.text !== 'string' || !banner.text.trim()) return null;
  if (typeof banner.endsAt === 'string' && Date.parse(banner.endsAt) <= now) return null;
  const link = isSameSitePath(banner.linkHref) && typeof banner.linkLabel === 'string' && banner.linkLabel.trim();
  return { text: banner.text.trim(), linkHref: link ? banner.linkHref : '', linkLabel: link ? banner.linkLabel.trim() : '' };
}

// Admin form: ISO <-> <input type="datetime-local"> value in the browser's local time. Empty stays empty.
const pad = n => String(n).padStart(2, '0');
export function toLocalInput(iso) {
  if (!iso) return '';
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? '' : `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}
export const fromLocalInput = v => (v ? new Date(v).toISOString() : null);
