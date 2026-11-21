// Card thumbnails (migration 0019). Derived data written only by tools/card-thumbnails.mjs.
// Public rule: a thumbnail is public if and only if its source photo is the FIRST photo of a product the storefront
// currently shows, so a thumbnail can never expose a photo of an unpublished, deleted or non-primary product.
// <sha256(source url) 32 hex>-<sha256(source bytes + params) 16 hex>.card.webp: the key changes whenever the bytes can change,
// so a stored thumbnail is never overwritten and may be cached as immutable. Built by tools/card-thumbnails-core.mjs.
import { publicEntriesFor } from './merged.js';
export const CARD_THUMBNAIL_KEY = /^[a-f0-9]{32}-[a-f0-9]{16}\.card\.webp$/;
export const isCardThumbnailKey = key => CARD_THUMBNAIL_KEY.test(key);

// The table may not exist yet (code deployed before the migration) or may fail: the storefront then serves originals.
async function lookup(env, sql, ...bindings) {
  try { return (await env.DB.prepare(sql).bind(...bindings).all()).results; } catch { return []; }
}

/** Adds `cardPhoto` (thumbnail URL or null) to public products with one query for the whole list. */
export async function withCardPhotos(env, products) {
  const rows = await lookup(env, "SELECT source_url,url FROM photo_derivatives WHERE variant='card' AND url IS NOT NULL");
  const bySource = new Map(rows.map(r => [r.source_url, r.url]));
  return products.map(product => ({ ...product, cardPhoto: bySource.get(product.photos[0]) ?? null }));
}
export async function withCardPhoto(env, product) {
  const rows = product.photos[0] ? await lookup(env, "SELECT url FROM photo_derivatives WHERE variant='card' AND source_url=? AND url IS NOT NULL", product.photos[0]) : [];
  return { ...product, cardPhoto: rows[0]?.url ?? null };
}

// The public projection's first photo in SQL: `overrides.photos ?? source.photos`, element 0. An overlay array
// (even an empty one) replaces the source photos; only a missing or null overlay falls back to the source.
export const firstPhotoSql = (alias = 'p') => `CASE WHEN json_type(${alias}.overrides_json,'$.photos')='array' THEN json_extract(${alias}.overrides_json,'$.photos[0]') ELSE json_extract(${alias}.source_json,'$.photos[0]') END`;

/**
 * Authorizes an anonymous request for `/media/<key>.card.webp`. Cheap path first: one indexed lookup of the key, and a
 * miss ends there (no product is read). On a hit only the eligible published products whose first photo is the source
 * are loaded, and publicEntriesFor (same visibility rules as publicCatalog: drafts, trash, disabled or deleted suppliers,
 * non-primary group members) must show an entry whose photos[0] is that source.
 */
export async function isPublicCardThumbnail(env, path) {
  const rows = await lookup(env, "SELECT source_url FROM photo_derivatives WHERE variant='card' AND url=?", path);
  if (!rows.length) return false;
  const source = rows[0].source_url;
  const candidates = await lookup(env, `SELECT p.id FROM products p JOIN suppliers s ON s.id=p.supplier_id WHERE s.enabled=1 AND s.deleted_at IS NULL AND p.deleted_at IS NULL AND json_extract(p.overrides_json,'$.published')=1 AND ${firstPhotoSql('p')}=? LIMIT 40`, source);
  if (!candidates.length) return false;
  const { items } = await publicEntriesFor(env, candidates.map(r => r.id));
  return items.some(entry => entry.product.photos[0] === source);
}
