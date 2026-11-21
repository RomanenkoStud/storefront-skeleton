// campaign picture library: browser pipeline (trim, downscale, encode) and admin data helpers.
// Pure where possible (ADR-0015 Decision 3). The canvas/Worker steps are injected so everything below is unit-tested in Node.
import { transparentFraction, isDegenerateMask, DEGENERATE_MESSAGE, ALPHA_TRANSPARENT_BELOW, MIN_TRANSPARENT } from './cutout-photo.js';
import { resolveCategoryId } from '../../../packages/catalog/taxonomy-context.js';

export { isDegenerateMask, DEGENERATE_MESSAGE };
export const MAX_SIDE = 1200, RETRY_SIDE = 900, MIN_SIDE = 64, MAX_BYTES = 2000000, PAD = 0.02;
export const MAX_FILE_BYTES = 20 * 1024 * 1024, MAX_PER_CATEGORY = 12;
export const NO_ALPHA_MESSAGE = 'Потрібна картинка з прозорим фоном: увімкніть «Прибрати фон» або оберіть PNG/WebP із прозорістю.';
export const TOO_BIG_MESSAGE = 'Картинка завелика навіть після стискання (понад 2 МБ). Оберіть простішу картинку.';
export const TOO_SMALL_MESSAGE = 'Предмет на картинці надто малий (менше 64 px після обрізання). Оберіть більшу картинку.';
export const EMPTY_MESSAGE = 'На картинці немає видимого предмета (усе прозоре).';

// Bounding box of pixels that are visible (alpha at or above the same threshold the mask check calls transparent).
export function alphaBounds(rgba, width, height) {
  let x0 = width, y0 = height, x1 = -1, y1 = -1;
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
    if (rgba[(y * width + x) * 4 + 3] >= ALPHA_TRANSPARENT_BELOW) { if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y; }
  }
  return x1 < 0 ? null : { x: x0, y: y0, w: x1 - x0 + 1, h: y1 - y0 + 1 };
}

// Grow the box by 2% of its own width/height on every side, clamped to the image.
export function padBounds(box, width, height, pad = PAD) {
  const px = Math.ceil(box.w * pad), py = Math.ceil(box.h * pad);
  const x = Math.max(0, box.x - px), y = Math.max(0, box.y - py);
  return { x, y, w: Math.min(width, box.x + box.w + px) - x, h: Math.min(height, box.y + box.h + py) - y };
}

// Long side at most maxSide; never upscale.
export function targetSize(width, height, maxSide = MAX_SIDE) {
  const scale = Math.min(1, maxSide / Math.max(width, height));
  return { width: Math.max(1, Math.round(width * scale)), height: Math.max(1, Math.round(height * scale)) };
}

// Without background removal the file must already carry transparency (at least 1% transparent pixels).
export function transparencyError(rgba) { return transparentFraction(rgba) >= MIN_TRANSPARENT ? '' : NO_ALPHA_MESSAGE; }

// Crop rectangle for an RGBA image: trimmed to the alpha box plus padding. Throws a Ukrainian message when empty.
export function cropFor(rgba, width, height) {
  const box = alphaBounds(rgba, width, height);
  if (!box) throw new Error(EMPTY_MESSAGE);
  return padBounds(box, width, height);
}

// Encode plan. render(maxSide) -> {width,height,...canvas}; encode(canvas, type, quality) -> Blob.
// WebP q0.9 first; a blob whose type is not image/webp means the browser silently fell back, so PNG is used instead.
// Over 2,000,000 bytes retries once at a 900 px long side, then fails. Sides must stay within the server's 64..1600.
export async function encodePicture(crop, { render, encode }) {
  for (const side of [MAX_SIDE, RETRY_SIDE]) {
    const size = targetSize(crop.w, crop.h, side);
    if (Math.min(size.width, size.height) < MIN_SIDE) throw new Error(TOO_SMALL_MESSAGE);
    const canvas = await render(side);
    let blob = await encode(canvas, 'image/webp', 0.9);
    if (!blob || blob.type !== 'image/webp') blob = await encode(canvas, 'image/png');
    if (blob && blob.size <= MAX_BYTES) return { blob, width: size.width, height: size.height, type: blob.type };
  }
  throw new Error(TOO_BIG_MESSAGE);
}

// Full pipeline in the browser. process = processImage (background removal); retryCpu = one WebAssembly retry after a
// degenerate (blank/full) mask, as for product cut-outs. Progress is reported through onProgress.
export const MAX_DECODE_SIDE = 3000;
export const MEMORY_MESSAGE = 'Не вистачило пам’яті браузера для цієї картинки. Оберіть менший файл або закрийте зайві вкладки.';
// Decode with the long side capped at MAX_DECODE_SIDE so a 20 MB photo never allocates a full-resolution RGBA buffer.
async function bitmapOf(source) {
  const probe = await createImageBitmap(source);
  const size = targetSize(probe.width, probe.height, MAX_DECODE_SIDE);
  if (size.width === probe.width && size.height === probe.height) return { bitmap: probe, scaled: false };
  try { return { bitmap: await createImageBitmap(probe, { resizeWidth: size.width, resizeHeight: size.height, resizeQuality: 'high' }), scaled: true }; } finally { probe.close(); }
}
// The same cap before background removal, so the model also works on the capped image (its result keeps that size).
async function capped(file) {
  const { bitmap, scaled } = await bitmapOf(file);
  try {
    if (!scaled) return file;
    const canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
    canvas.getContext('2d').drawImage(bitmap, 0, 0);
    const blob = await canvas.convertToBlob({ type: 'image/png' }); canvas.width = 0; return blob;
  } finally { bitmap.close(); }
}
async function decode(source) {
  const { bitmap } = await bitmapOf(source);
  const full = new OffscreenCanvas(bitmap.width, bitmap.height), ctx = full.getContext('2d', { willReadFrequently: true });
  ctx.drawImage(bitmap, 0, 0);
  const rgba = ctx.getImageData(0, 0, bitmap.width, bitmap.height).data;
  bitmap.close();
  return { full, rgba, width: full.width, height: full.height };
}
// Decoding/allocation failures (huge or corrupt images, low memory) get one clear message; aborts pass through.
const guard = promise => promise.catch(e => { throw e?.name === 'AbortError' ? e : new Error(MEMORY_MESSAGE); });
export async function preparePicture(file, { removeBackground = true, process, retryCpu, onProgress, signal } = {}) {
  if (!file || !/^image\/(png|jpeg|webp)$/.test(file.type)) throw new Error('Оберіть зображення JPEG, PNG або WebP.');
  if (file.size > MAX_FILE_BYTES) throw new Error('Файл завеликий (понад 20 МБ).');
  const aborted = () => { if (signal?.aborted) throw new DOMException('Скасовано', 'AbortError'); };
  const decode2 = source => guard(decode(source));
  let image = null, canvas = null;
  try {
    const input = removeBackground ? await guard(capped(file)) : file;
    image = removeBackground ? await decode2(await process(input, { onProgress, signal })) : await decode2(input);
    aborted();
    if (removeBackground && isDegenerateMask(image.rgba) && retryCpu) {
      const again = retryCpu(input, { onProgress, signal });
      if (again) { image.full.width = 0; image = await decode2(await again); aborted(); }
    }
    if (removeBackground && isDegenerateMask(image.rgba)) throw new Error(DEGENERATE_MESSAGE);
    if (!removeBackground) { const message = transparencyError(image.rgba); if (message) throw new Error(message); }
    const crop = cropFor(image.rgba, image.width, image.height);
    const render = maxSide => {
      if (canvas) canvas.width = 0;
      const size = targetSize(crop.w, crop.h, maxSide); canvas = new OffscreenCanvas(size.width, size.height);
      const c = canvas.getContext('2d'); c.imageSmoothingQuality = 'high';
      c.drawImage(image.full, crop.x, crop.y, crop.w, crop.h, 0, 0, size.width, size.height);
      return canvas;
    };
    return await encodePicture(crop, { render, encode: (c, type, quality) => c.convertToBlob({ type, quality }) });
  } finally { if (image) image.full.width = 0; if (canvas) canvas.width = 0; }
}

export async function uploadPicture(api, categoryId, blob, name = 'picture') {
  const form = new FormData();
  form.set('categoryId', categoryId);
  form.set('file', blob, `${name}.${blob.type === 'image/png' ? 'png' : 'webp'}`);
  return (await api('/api/admin/storefront/pictures', { method: 'POST', body: form })).picture;
}

// ---- admin data helpers (flat admin rows -> library / groups / options) ----
const byPosition = (a, b) => a.position - b.position;
// Admin rows {id,categoryId,src,w,h,position} -> the public shape { categoryId: [{src,w,h}] } in display order.
export function libraryFromRows(rows) {
  const out = {};
  for (const r of [...(rows || [])].sort(byPosition)) (out[r.categoryId] ||= []).push({ src: r.src, w: r.w, h: r.h });
  return out;
}
export const leafCategories = taxonomy => [...(taxonomy?.index?.values() || [])].filter(n => !n.children?.length).map(n => ({ id: n.id, label: n.label, path: n.path }));
// Rows grouped under existing categories (resolved through redirects) versus rows whose category is gone.
export function groupRows(rows, taxonomy) {
  const live = {}, deleted = [];
  for (const r of [...(rows || [])].sort(byPosition)) {
    const id = resolveCategoryId(r.categoryId, taxonomy);
    if (taxonomy?.index?.has(id)) (live[id] ||= []).push(r); else deleted.push(r);
  }
  return { live, deleted };
}
// Categories that gained children after pictures were uploaded: their pictures stay in use, but new uploads are refused.
export function legacyOptions(taxonomy, rows) {
  const { live } = groupRows(rows, taxonomy), leaves = new Set(leafCategories(taxonomy).map(c => c.id));
  return Object.keys(live).filter(id => !leaves.has(id)).map(id => ({ id, label: taxonomy.index.get(id).label, count: live[id].length })).sort((a, b) => a.label.localeCompare(b.label, 'uk'));
}
// After a cancelled/finished batch: items of that batch that never started are dropped, so nothing stays queued forever.
export const dropQueued = (pending, keys) => pending.filter(p => !(p.status === 'queued' && keys.includes(p.key)));
// Select options: every leaf category with its library picture count, labelled by name; sorted by label.
export function pictureOptions(taxonomy, rows) {
  const { live } = groupRows(rows, taxonomy);
  return leafCategories(taxonomy).map(c => ({ ...c, count: live[c.id]?.length || 0 })).sort((a, b) => a.label.localeCompare(b.label, 'uk'));
}
// Fallback pictures of a category that are not already in its library, greyed after the library pictures.
export function railFallbacks(rail, categoryId, library = []) {
  const cut = (rail || []).find(r => r.categoryId === categoryId);
  if (!cut) return [];
  const have = new Set(library.map(p => p.src));
  return [cut.front, cut.angle, cut.side].filter(p => p && p.src && !have.has(p.src)).map(p => ({ src: p.src, w: p.w, h: p.h }));
}
// Move the item at i by d (-1 up, +1 down); returns the ids in the new order, or null when it cannot move.
export function reorderIds(ids, i, d) {
  const j = i + d;
  if (j < 0 || j >= ids.length) return null;
  const next = [...ids]; [next[i], next[j]] = [next[j], next[i]]; return next;
}
