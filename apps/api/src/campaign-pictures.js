// Campaign pictures (ADR-0015 Decision 3): staff-managed cut-out pictures per category for the campaign band.
// Rows are staff data in campaign_pictures; files live in R2 MEDIA under campaign/<uuid>.<ext>.
import { fail } from './domain.js';
import { actorLabel } from './permissions.js';
import { getCategory } from '../../../packages/catalog/taxonomy.js';

export const PICTURE_LIMITS = Object.freeze({ bytes: 2000000, body: 2200000, perCategory: 12, total: 300, minSide: 64, maxSide: 1600 });
export const CAMPAIGN_KEY = /^campaign\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.(png|webp)$/;
const NO_ALPHA = 'Потрібна картинка з прозорим фоном';
const PNG = [137, 80, 78, 71, 13, 10, 26, 10];
const ascii = (b, from, to) => String.fromCharCode(...b.slice(from, to));
const u32be = (b, i) => ((b[i] << 24) | (b[i + 1] << 16) | (b[i + 2] << 8) | b[i + 3]) >>> 0;
const u24le = (b, i) => b[i] | (b[i + 1] << 8) | (b[i + 2] << 16);
const missing = e => /no such table/i.test(String(e?.message));

// Magic bytes, size and alpha are read from the file header only (never trusted from the client).
export function pictureHeader(bytes) {
  if (bytes.length >= 33 && PNG.every((v, i) => bytes[i] === v) && ascii(bytes, 12, 16) === 'IHDR') {
    const colorType = bytes[25];
    let alpha = colorType === 4 || colorType === 6;
    for (let at = 8; !alpha && at + 8 <= bytes.length;) { // tRNS is only legal before the image data
      const name = ascii(bytes, at + 4, at + 8);
      if (name === 'tRNS') alpha = true;
      if (name === 'IDAT' || name === 'IEND') break;
      at += 12 + u32be(bytes, at);
    }
    return { ext: 'png', type: 'image/png', width: u32be(bytes, 16), height: u32be(bytes, 20), alpha };
  }
  if (bytes.length >= 25 && ascii(bytes, 0, 4) === 'RIFF' && ascii(bytes, 8, 12) === 'WEBP') {
    const kind = ascii(bytes, 12, 16);
    const base = { ext: 'webp', type: 'image/webp' };
    if (kind === 'VP8X' && bytes.length >= 30) return { ...base, animated: !!(bytes[20] & 0x02), width: u24le(bytes, 24) + 1, height: u24le(bytes, 27) + 1, alpha: !!(bytes[20] & 0x10) };
    if (kind === 'VP8L' && bytes[20] === 0x2f) {
      const bits = (bytes[21] | (bytes[22] << 8) | (bytes[23] << 16) | (bytes[24] << 24)) >>> 0;
      return { ...base, width: (bits & 0x3fff) + 1, height: ((bits >>> 14) & 0x3fff) + 1, alpha: !!((bits >>> 28) & 1) };
    }
    if (kind === 'VP8 ' && bytes.length >= 30 && bytes[23] === 0x9d && bytes[24] === 0x01 && bytes[25] === 0x2a) return { ...base, width: (bytes[26] | (bytes[27] << 8)) & 0x3fff, height: (bytes[28] | (bytes[29] << 8)) & 0x3fff, alpha: false };
  }
  return null;
}

const view = (row, taxonomy, principal) => ({ id: row.id, categoryId: getCategory(row.category_id, taxonomy)?.id ?? row.category_id, src: `/media/${row.media_key}`, w: row.width, h: row.height, position: row.position, createdAt: row.created_at, actor: actorLabel(principal, row.actor) });
const all = async env => (await env.DB.prepare('SELECT * FROM campaign_pictures ORDER BY position,created_at,id').all()).results;

const allOr503 = async env => { try { return await all(env); } catch (e) { if (missing(e)) fail('Picture library is not available yet', 503); throw e; } };

// Missing table (code deployed before the migration) behaves like an empty library.
export async function listPictures(env, taxonomy) {
  try { return (await all(env)).map(row => view(row, taxonomy, env.PRINCIPAL)); } catch (e) { if (missing(e)) return []; throw e; }
}

// Public projection: only src/w/h, grouped by resolved category id, at most 12 each, unknown categories omitted.
export async function publicPictures(env, taxonomy) {
  let rows;
  try { rows = await all(env); } catch (e) { if (missing(e)) return {}; throw e; }
  const out = {};
  for (const row of rows.sort((a, b) => a.position - b.position)) {
    const node = getCategory(row.category_id, taxonomy);
    if (!node) continue;
    const list = out[node.id] ??= [];
    if (list.length < PICTURE_LIMITS.perCategory) list.push({ src: `/media/${row.media_key}`, w: row.width, h: row.height });
  }
  return out;
}

// One indexed lookup; a missing table or any failure means not public.
export async function isPublicCampaignKey(env, key) {
  if (!CAMPAIGN_KEY.test(key)) return false;
  try { return !!(await env.DB.prepare('SELECT 1 AS ok FROM campaign_pictures WHERE media_key=?').bind(key).first()); } catch { return false; }
}

function leafCategory(taxonomy, categoryId) {
  if (typeof categoryId !== 'string' || !categoryId) fail('categoryId is required');
  const node = getCategory(categoryId, taxonomy);
  if (!node) fail('Unknown category');
  if (node.children?.length) fail('Pictures can only be added to a category without subcategories');
  return node.id;
}
// Stored ids that resolve to the same category (the id as chosen may since have been redirected).
const sameCategory = (rows, taxonomy, id) => rows.filter(row => (getCategory(row.category_id, taxonomy)?.id ?? row.category_id) === id);
const auditIf = (env, action, resourceId, at, details, existsSql, ...existsArgs) => {
  const p = env.PRINCIPAL;
  return env.DB.prepare(`INSERT INTO audit_events(id,actor,action,resource_id,created_at,actor_type,actor_role,details_json) SELECT ?,?,?,?,?,?,?,? WHERE ${existsSql}`)
    .bind(crypto.randomUUID(), p?.actor ?? 'system', action, resourceId, at, p?.type ?? 'system', p?.role ?? null, JSON.stringify(details), ...existsArgs);
};
const changes = result => result?.meta?.changes ?? result?.changes ?? 0;

// Bounded multipart read + server-side header checks shared by every staff picture upload.
export async function readPictureUpload(request, env, readBounded) {
  if (!env.MEDIA) fail('Photo storage is not configured', 503);
  const contentType = request.headers.get('Content-Type') ?? '';
  if (!contentType.startsWith('multipart/form-data')) fail('Multipart image upload required', 415);
  const body = await readBounded(request, PICTURE_LIMITS.body);
  let form;
  try { form = await new Response(body, { headers: { 'Content-Type': contentType } }).formData(); } catch { fail('Invalid multipart image upload'); }
  const file = form.get('file');
  if (!file || typeof file.arrayBuffer !== 'function' || file.size === 0) fail('Supply a PNG or WebP picture');
  if (file.size > PICTURE_LIMITS.bytes) fail('Picture is larger than 2 MB', 413);
  const bytes = new Uint8Array(await file.arrayBuffer());
  const header = pictureHeader(bytes);
  if (!header) fail('Only PNG and WebP pictures are accepted', 415);
  if (header.animated) fail('Animated WebP is not supported', 415);
  const { minSide, maxSide } = PICTURE_LIMITS;
  if (![header.width, header.height].every(n => n >= minSide && n <= maxSide)) fail(`Picture sides must be ${minSide}-${maxSide} px`);
  if (!header.alpha) fail(NO_ALPHA, 415);
  return { form, bytes, header };
}

export async function addPicture(request, env, readBounded) {
  const { form, bytes, header } = await readPictureUpload(request, env, readBounded);
  const taxonomy = env.RECOGNITION?.taxonomy;
  const categoryId = leafCategory(taxonomy, form.get('categoryId'));
  let existing;
  try { existing = await all(env); } catch (e) { if (missing(e)) fail('Picture library is not available yet', 503); throw e; }
  const group = sameCategory(existing, taxonomy, categoryId);
  if (group.length >= PICTURE_LIMITS.perCategory || existing.length >= PICTURE_LIMITS.total) fail(`Limit reached: ${PICTURE_LIMITS.perCategory} pictures per category, ${PICTURE_LIMITS.total} in total`, 409);
  const id = crypto.randomUUID(), key = `campaign/${crypto.randomUUID()}.${header.ext}`, at = new Date().toISOString();
  const ids = [...new Set([categoryId, ...group.map(r => r.category_id)])], marks = ids.map(() => '?').join(',');
  const src = `/media/${key}`;
  await env.MEDIA.put(key, bytes, { httpMetadata: { contentType: header.type } });
  let results;
  try {
    // The caps are re-checked inside the INSERT so concurrent uploads cannot overshoot; the audit row exists only if the insert did.
    results = await env.DB.batch([
      env.DB.prepare(`INSERT INTO campaign_pictures(id,category_id,media_key,width,height,position,actor,created_at) SELECT ?,?,?,?,?,COALESCE(MAX(position)+1,0),?,? FROM campaign_pictures WHERE category_id IN (${marks}) HAVING COUNT(*)<? AND (SELECT COUNT(*) FROM campaign_pictures)<?`)
        .bind(id, categoryId, key, header.width, header.height, env.PRINCIPAL?.actor ?? 'system', at, ...ids, PICTURE_LIMITS.perCategory, PICTURE_LIMITS.total),
      auditIf(env, 'storefront.picture.add', id, at, { id, categoryId, src, w: header.width, h: header.height }, 'EXISTS(SELECT 1 FROM campaign_pictures WHERE id=?)', id),
    ]);
  } catch (error) {
    await env.MEDIA.delete(key).catch(() => {}); // a failed delete leaves a private orphan: without a row the key is never public
    throw error;
  }
  if (!changes(results[0])) {
    await env.MEDIA.delete(key).catch(() => {});
    fail(`Limit reached: ${PICTURE_LIMITS.perCategory} pictures per category, ${PICTURE_LIMITS.total} in total`, 409);
  }
  const row = await env.DB.prepare('SELECT * FROM campaign_pictures WHERE id=?').bind(id).first();
  return view(row, taxonomy, env.PRINCIPAL);
}

export async function orderPictures(body, env) {
  if (!body || typeof body !== 'object' || Array.isArray(body) || Object.keys(body).some(k => !['categoryId', 'ids'].includes(k))) fail('Send {categoryId, ids}');
  const taxonomy = env.RECOGNITION?.taxonomy;
  if (typeof body.categoryId !== 'string' || !body.categoryId) fail('categoryId is required');
  const categoryId = getCategory(body.categoryId, taxonomy)?.id ?? body.categoryId;
  if (!Array.isArray(body.ids) || body.ids.some(x => typeof x !== 'string')) fail('ids must be a list of picture ids');
  const group = sameCategory(await allOr503(env), taxonomy, categoryId);
  const have = new Set(group.map(r => r.id));
  if (!group.length) fail('No pictures in this category', 404);
  if (body.ids.length !== have.size || new Set(body.ids).size !== body.ids.length || body.ids.some(x => !have.has(x))) fail('ids must be exactly the category pictures', 409);
  const at = new Date().toISOString();
  await env.DB.batch([
    ...body.ids.map((pid, position) => env.DB.prepare('UPDATE campaign_pictures SET position=? WHERE id=?').bind(position, pid)),
    auditIf(env, 'storefront.picture.order', categoryId, at, { categoryId, ids: body.ids }, 'changes()>0'), // only if the last UPDATE touched a row
  ]);
  return { pictures: (await listPictures(env, taxonomy)).filter(p => p.categoryId === categoryId).sort((a, b) => a.position - b.position) };
}

export async function removePicture(id, env) {
  const taxonomy = env.RECOGNITION?.taxonomy;
  let row, rows;
  try {
    row = await env.DB.prepare('SELECT * FROM campaign_pictures WHERE id=?').bind(id).first();
    rows = row ? await all(env) : [];
  } catch (e) { if (missing(e)) fail('Picture library is not available yet', 503); throw e; }
  if (!row) fail('Picture not found', 404);
  const at = new Date().toISOString(), src = `/media/${row.media_key}`;
  const rest = sameCategory(rows, taxonomy, getCategory(row.category_id, taxonomy)?.id ?? row.category_id).filter(r => r.id !== id).sort((a, b) => a.position - b.position);
  // One batch: delete the row (the key stops being public), audit only if that DELETE removed a row (changes()),
  // then renumber the rest. The R2 object goes afterwards; a failed delete leaves a private orphan.
  await env.DB.batch([
    env.DB.prepare('DELETE FROM campaign_pictures WHERE id=?').bind(id),
    auditIf(env, 'storefront.picture.remove', id, at, { id, categoryId: row.category_id, src }, 'changes()>0'),
    ...rest.map((r, i) => env.DB.prepare('UPDATE campaign_pictures SET position=? WHERE id=? AND position<>?').bind(i, r.id, i)),
  ]);
  await env.MEDIA?.delete(row.media_key).catch(() => {});
  return { deleted: id };
}
