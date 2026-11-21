// staff-chosen images that replace the shipped storefront renders, one per category and slot.
// front/side/angle = a hanger on the landing rack, shoe = a pair on the rack shelf, poster = the category tile in the
// product grid. Rows are staff data in storefront_images; files live in R2 MEDIA under storefront/<uuid>.<ext>.
// The shipped renders (apps/web/src/rail-media.json) stay the fallback for every slot without a row.
import { fail } from './domain.js';
import { actorLabel } from './permissions.js';
import { getCategory } from '../../../packages/catalog/taxonomy.js';
import { readPictureUpload } from './campaign-pictures.js';

export const IMAGE_SLOTS = Object.freeze(['front', 'side', 'angle', 'shoe', 'poster']);
export const STOREFRONT_KEY = /^storefront\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.(png|webp)$/;
const missing = e => /no such table/i.test(String(e?.message));
const resolved = (row, taxonomy) => getCategory(row.category_id, taxonomy)?.id ?? null;
const all = async env => (await env.DB.prepare('SELECT * FROM storefront_images ORDER BY category_id,slot').all()).results;

const view = (row, taxonomy, principal) => ({ categoryId: resolved(row, taxonomy) ?? row.category_id, known: !!resolved(row, taxonomy), slot: row.slot, src: `/media/${row.media_key}`, w: row.width, h: row.height, updatedAt: row.updated_at, actor: actorLabel(principal, row.actor) });

// Missing table (code deployed before migration 0025) behaves like no overrides.
export async function listImages(env, taxonomy) {
  try { return (await all(env)).map(row => view(row, taxonomy, env.PRINCIPAL)); } catch (e) { if (missing(e)) return []; throw e; }
}

// Public projection: { [resolvedCategoryId]: { [slot]: {src,w,h} } }; categories unknown to the taxonomy are omitted.
export async function publicImages(env, taxonomy) {
  let rows;
  try { rows = await all(env); } catch (e) { if (missing(e)) return {}; throw e; }
  const out = {};
  for (const row of rows) {
    const id = resolved(row, taxonomy);
    if (!id || !IMAGE_SLOTS.includes(row.slot)) continue;
    (out[id] ||= {})[row.slot] ??= { src: `/media/${row.media_key}`, w: row.width, h: row.height };
  }
  return out;
}

export async function isPublicStorefrontKey(env, key) {
  if (!STOREFRONT_KEY.test(key)) return false;
  try { return !!(await env.DB.prepare('SELECT 1 AS ok FROM storefront_images WHERE media_key=?').bind(key).first()); } catch { return false; }
}

function target(taxonomy, categoryId, slot) {
  if (typeof categoryId !== 'string' || !categoryId) fail('categoryId is required');
  if (!IMAGE_SLOTS.includes(slot)) fail(`slot must be one of ${IMAGE_SLOTS.join(', ')}`);
  const node = getCategory(categoryId, taxonomy);
  if (!node) fail('Unknown category');
  return node.id;
}

const audit = (env, action, at, details) => {
  const p = env.PRINCIPAL;
  return env.DB.prepare('INSERT INTO audit_events(id,actor,action,resource_id,created_at,actor_type,actor_role,details_json) VALUES(?,?,?,?,?,?,?,?)')
    .bind(crypto.randomUUID(), p?.actor ?? 'system', action, `${details.categoryId}:${details.slot}`, at, p?.type ?? 'system', p?.role ?? null, JSON.stringify(details));
};
const current = (env, categoryId, slot) => env.DB.prepare('SELECT * FROM storefront_images WHERE category_id=? AND slot=?').bind(categoryId, slot).first();

// PUT multipart {categoryId, slot, file}: sets or replaces one slot. The replaced file is deleted after the row moves.
export async function setImage(request, env, readBounded) {
  const { form, bytes, header } = await readPictureUpload(request, env, readBounded);
  const taxonomy = env.RECOGNITION?.taxonomy;
  const slot = form.get('slot'), categoryId = target(taxonomy, form.get('categoryId'), slot);
  let before;
  try { before = await current(env, categoryId, slot); } catch (e) { if (missing(e)) fail('Storefront images are not available yet', 503); throw e; }
  const key = `storefront/${crypto.randomUUID()}.${header.ext}`, at = new Date().toISOString();
  await env.MEDIA.put(key, bytes, { httpMetadata: { contentType: header.type } });
  try {
    await env.DB.batch([
      env.DB.prepare('INSERT INTO storefront_images(category_id,slot,media_key,width,height,actor,updated_at) VALUES(?,?,?,?,?,?,?) ON CONFLICT(category_id,slot) DO UPDATE SET media_key=excluded.media_key,width=excluded.width,height=excluded.height,actor=excluded.actor,updated_at=excluded.updated_at')
        .bind(categoryId, slot, key, header.width, header.height, env.PRINCIPAL?.actor ?? 'system', at),
      audit(env, 'storefront.image.set', at, { categoryId, slot, src: `/media/${key}`, w: header.width, h: header.height, replaced: before ? `/media/${before.media_key}` : null }),
    ]);
  } catch (error) {
    await env.MEDIA.delete(key).catch(() => {}); // without a row the key is never public
    throw error;
  }
  if (before && before.media_key !== key) await env.MEDIA.delete(before.media_key).catch(() => {});
  return view(await current(env, categoryId, slot), taxonomy, env.PRINCIPAL);
}

// DELETE: the slot goes back to the shipped render. Stored ids are matched as written (a redirected category keeps its row).
export async function resetImage(params, env) {
  const slot = params.slot, categoryId = typeof params.categoryId === 'string' ? decodeURIComponent(params.categoryId) : '';
  if (!IMAGE_SLOTS.includes(slot)) fail(`slot must be one of ${IMAGE_SLOTS.join(', ')}`);
  let rows;
  try { rows = await all(env); } catch (e) { if (missing(e)) fail('Storefront images are not available yet', 503); throw e; }
  const taxonomy = env.RECOGNITION?.taxonomy;
  const row = rows.find(r => r.slot === slot && (r.category_id === categoryId || resolved(r, taxonomy) === categoryId));
  if (!row) fail('Image not found', 404);
  const at = new Date().toISOString();
  await env.DB.batch([
    env.DB.prepare('DELETE FROM storefront_images WHERE category_id=? AND slot=?').bind(row.category_id, slot),
    audit(env, 'storefront.image.reset', at, { categoryId: row.category_id, slot, src: `/media/${row.media_key}` }),
  ]);
  await env.MEDIA?.delete(row.media_key).catch(() => {});
  return { reset: { categoryId: row.category_id, slot } };
}
