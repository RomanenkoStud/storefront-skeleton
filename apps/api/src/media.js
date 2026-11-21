// R2 media tracking, reference rules, dedup and cleanup. Contract: docs/API.md "Media library and storage cleanup".
// Invariant: an object is deleted only when it has a media_objects row and, in the same D1 statement that removes that row,
// no product photo (any product, including Trash), cart line or tracked lineage references it. R2 is deleted after the row.
import { fail } from './domain.js';
import { publicEntriesFor } from './merged.js';
import { auditStatement } from './permissions.js';

export const MEDIA_KEY = /^[a-f0-9-]+\.(?:jpg|png|webp)$/;
export const GRACE_HOURS = 24;
const SCAN_PAGE = 20, CLEANUP_LIMIT = 200;
const now = () => new Date().toISOString();
export const mediaKey = url => typeof url === 'string' && url.startsWith('/media/') && MEDIA_KEY.test(url.slice(7)) ? url.slice(7) : null;
export async function sha256Hex(bytes) {
  return Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', bytes)), b => b.toString(16).padStart(2, '0')).join('');
}
const parse = value => { try { return JSON.parse(value || '{}') ?? {}; } catch { return {}; } };
export const effectivePhotos = row => parse(row.overrides_json).photos ?? parse(row.source_json).photos ?? [];
function productKeys(row) {
  const keys = new Set();
  for (const url of [...(parse(row.source_json).photos || []), ...(parse(row.overrides_json).photos || [])]) { const key = mediaKey(url); if (key) keys.add(key); }
  return keys;
}
function lineageOf(meta) {
  if (!meta) return { kind: 'unknown', productId: null, originalKey: null, cutoutKey: null };
  const originalKey = mediaKey(meta.originalUrl), cutoutKey = mediaKey(meta.cutoutUrl);
  const kind = meta.templateId || cutoutKey ? 'normalized' : originalKey ? 'cutout' : 'unknown';
  return { kind, productId: typeof meta.productId === 'string' ? meta.productId : null, originalKey, cutoutKey };
}

// ---- tracking and dedup
export function trackStatement(env, { key, size, contentType, sha256, kind, productId = null, originalKey = null, cutoutKey = null, createdAt = now(), scanned = false }) {
  return env.DB.prepare(`INSERT INTO media_objects(key,size,content_type,sha256,kind,product_id,original_key,cutout_key,created_at,scanned_at) VALUES(?,?,?,?,?,?,?,?,?,?)
    ON CONFLICT(key) DO UPDATE SET size=excluded.size,content_type=excluded.content_type,sha256=excluded.sha256,
      kind=CASE WHEN media_objects.kind='unknown' THEN excluded.kind ELSE media_objects.kind END,
      product_id=coalesce(media_objects.product_id,excluded.product_id),original_key=coalesce(media_objects.original_key,excluded.original_key),
      cutout_key=coalesce(media_objects.cutout_key,excluded.cutout_key),scanned_at=coalesce(excluded.scanned_at,media_objects.scanned_at)`)
    .bind(key, size, contentType, sha256, kind, productId, originalKey, cutoutKey, createdAt, scanned ? now() : null);
}
// Reuse an existing object only when it still exists in R2, then touch it so cleanup's grace period protects the new use.
async function reuse(env, candidate) {
  if (!candidate || !await env.MEDIA.head(candidate.key)) return null;
  await env.DB.prepare('UPDATE media_objects SET touched_at=? WHERE key=?').bind(now(), candidate.key).run();
  return candidate.key;
}
// Stores bytes, or returns the key of an existing object with identical content and identical lineage.
// Plain objects (uploads, archived originals) dedup across products; lineage objects only within the same product and parents.
export async function storeMedia(env, bytes, { ext, contentType, kind, productId = null, originalKey = null, cutoutKey = null, customMetadata, dedup = true }) {
  const sha256 = await sha256Hex(bytes);
  if (dedup) {
    const plain = kind === 'upload' || kind === 'original';
    const candidate = plain
      ? await env.DB.prepare("SELECT key FROM media_objects WHERE sha256=? AND content_type=? AND kind IN ('upload','original','unknown') AND product_id IS NULL AND original_key IS NULL AND cutout_key IS NULL ORDER BY created_at LIMIT 1").bind(sha256, contentType).first()
      : await env.DB.prepare('SELECT key FROM media_objects WHERE sha256=? AND content_type=? AND kind=? AND product_id IS ? AND original_key IS ? AND cutout_key IS ? ORDER BY created_at LIMIT 1').bind(sha256, contentType, kind, productId, originalKey, cutoutKey).first();
    const existing = await reuse(env, candidate);
    if (existing) return { key: existing, sha256, deduplicated: true };
  }
  const key = `${crypto.randomUUID()}.${ext}`;
  await env.MEDIA.put(key, bytes, { httpMetadata: { contentType }, ...(customMetadata ? { customMetadata } : {}) });
  await trackStatement(env, { key, size: bytes.byteLength, contentType, sha256, kind, productId, originalKey, cutoutKey }).run();
  return { key, sha256, deduplicated: false };
}

// ---- public authorization: one indexed lookup instead of scanning every published product
// Candidates come from the indexed media_refs lookup; a product that is a member of a confirmed duplicate group is
// then confirmed through the merged storefront (publicEntriesFor), so only photos the storefront shows are public.
// `withRecognition(env)` supplies the settings/taxonomy the projection needs; it is awaited only when a candidate exists.
export async function isPublicMedia(env, path, withRecognition = async e => e) {
  const key = mediaKey(path); if (!key) return false;
  const { results } = await env.DB.prepare("SELECT p.id,p.source_json,p.overrides_json FROM media_refs r JOIN products p ON p.id=r.product_id JOIN suppliers s ON s.id=p.supplier_id WHERE r.key=? AND s.enabled=1 AND s.deleted_at IS NULL AND p.deleted_at IS NULL AND json_extract(p.overrides_json,'$.published')=1").bind(key).all();
  const ids = results.filter(row => effectivePhotos(row).includes(path)).map(row => row.id);
  if (!ids.length) return false;
  const { items } = await publicEntriesFor(await withRecognition(env), ids);
  return items.some(entry => entry.product.photos.includes(path));
}

// ---- liveness
// Roots: every product photo (media_refs) and every cart line photo. Live = roots plus their lineage, transitively.
// Untracked live objects have unknown lineage in D1, so their R2 metadata is read; an unscanned object is never deletable.
export async function liveness(env) {
  const [refRows, carts, objects] = await Promise.all([
    env.DB.prepare("SELECT r.key,p.id,coalesce(json_extract(p.overrides_json,'$.title'),json_extract(p.source_json,'$.title')) AS title,p.deleted_at,json_extract(p.overrides_json,'$.published') AS published FROM media_refs r JOIN products p ON p.id=r.product_id").all().then(r => r.results),
    env.DB.prepare("SELECT photo,COUNT(*) AS n FROM cart_lines WHERE photo GLOB '/media/?*' GROUP BY photo").all(),
    env.DB.prepare('SELECT * FROM media_objects').all()
  ]);
  const byKey = new Map(objects.results.map(row => [row.key, row]));
  const referencedBy = new Map(), cartLines = new Map();
  for (const row of refRows) { if (!referencedBy.has(row.key)) referencedBy.set(row.key, []); referencedBy.get(row.key).push({ id: row.id, title: row.title || row.id, deleted: !!row.deleted_at, published: row.published === 1 && !row.deleted_at }); }
  for (const row of carts.results) { const key = mediaKey(row.photo); if (key) cartLines.set(key, (cartLines.get(key) || 0) + row.n); }
  const lineage = new Map();
  for (const row of objects.results) lineage.set(row.key, [row.original_key, row.cutout_key].filter(Boolean));
  const live = new Set(), queue = [...referencedBy.keys(), ...cartLines.keys()];
  while (queue.length) {
    const key = queue.pop(); if (live.has(key)) continue; live.add(key);
    if (!lineage.has(key) && env.MEDIA) { const l = lineageOf((await env.MEDIA.head(key))?.customMetadata); lineage.set(key, [l.originalKey, l.cutoutKey].filter(Boolean)); }
    for (const parent of lineage.get(key) || []) if (!live.has(parent)) queue.push(parent);
  }
  const keptBy = new Map();
  for (const [key, parents] of lineage) for (const parent of parents) { if (!keptBy.has(parent)) keptBy.set(parent, []); keptBy.get(parent).push(key); }
  return { byKey, referencedBy, cartLines, live, keptBy };
}

// Removes the row only if nothing references the key at this instant, then deletes R2. Returns the deleted row or null.
// A reused (deduplicated) object was touched by the write that reuses it; it is never deleted within the grace period,
// so a dedup reuse cannot race a concurrent delete. `graceBefore` additionally protects recently created orphans.
const graceCutoff = () => new Date(Date.now() - GRACE_HOURS * 3600_000).toISOString();
async function guardedDelete(env, key, { graceBefore = null } = {}) {
  const row = await env.DB.prepare(`DELETE FROM media_objects WHERE key=?1
      AND NOT EXISTS (SELECT 1 FROM media_refs WHERE key=?1)
      AND NOT EXISTS (SELECT 1 FROM cart_lines WHERE photo=?2)
      AND NOT EXISTS (SELECT 1 FROM media_objects o WHERE o.key<>?1 AND (o.original_key=?1 OR o.cutout_key=?1))
      AND (touched_at IS NULL OR touched_at < ?4)
      AND (?3 IS NULL OR coalesce(touched_at,created_at) < ?3)
    RETURNING key,size,original_key,cutout_key`).bind(key, `/media/${key}`, graceBefore, graceCutoff()).first();
  if (!row) return null;
  try { await env.MEDIA.delete(key); } catch { console.error('R2 media delete failed; the object stays untracked until the next scan'); }
  return row;
}

// Deletes the given keys and then their lineage, when nothing keeps them alive. Never throws: a product write already happened.
export async function deleteUnreferenced(env, keys, reason) {
  if (!env.MEDIA || !keys.size) return [];
  const deleted = [];
  try {
    // Only tracked objects can ever be deleted; skip the liveness walk (R2 heads for untracked keys) when none is tracked.
    const candidates = [...keys];
    const tracked = await env.DB.prepare(`SELECT COUNT(*) AS n FROM media_objects WHERE key IN (${candidates.map(() => '?').join(',')})`).bind(...candidates).first();
    if (!tracked?.n) return [];
    const { live } = await liveness(env);
    const pending = [...keys];
    while (pending.length) {
      const key = pending.shift();
      if (live.has(key) || deleted.includes(key)) continue;
      const row = await guardedDelete(env, key);
      if (row) { deleted.push(key); for (const parent of [row.original_key, row.cutout_key]) if (parent && !live.has(parent)) pending.push(parent); }
    }
    if (deleted.length) await auditStatement(env, 'media.delete', deleted[0], undefined, { keys: deleted, reason }).run();
  } catch (error) { console.error('Media cleanup after product change failed', error?.name || 'Error'); }
  return deleted;
}

// ---- product hooks (called from products.update and products.purge)
// A newly added /media photo must still exist, so a stale editor cannot save a reference to a deleted object.
export async function requireNewMediaExists(env, row, overrides) {
  if (!env.MEDIA) return;
  const before = productKeys(row), after = productKeys({ ...row, overrides_json: JSON.stringify(overrides) });
  for (const key of after) {
    if (before.has(key)) continue;
    const tracked = await env.DB.prepare('SELECT 1 AS ok FROM media_objects WHERE key=?').bind(key).first();
    if (!tracked && !await env.MEDIA.head(key)) fail(`Photo /media/${key} no longer exists. Reopen the product and choose the photos again.`, 409);
  }
}
export function removedMediaKeys(row, overrides) {
  const after = productKeys({ ...row, overrides_json: JSON.stringify(overrides) });
  return new Set([...productKeys(row)].filter(key => !after.has(key)));
}
export async function purgeProduct(env, row) {
  if (!row.deleted_at) fail('Only a product in Trash can be permanently deleted', 409);
  const keys = productKeys(row), at = now(), purgeId = crypto.randomUUID();
  // Every statement is gated on the row still being in Trash at write time, through the tombstone inserted first,
  // so a concurrent restore leaves the product fully intact and the request reports 409.
  const claimed = "EXISTS (SELECT 1 FROM product_tombstones WHERE product_id=? AND purged_at=?)";
  const principal = env.PRINCIPAL;
  const results = await env.DB.batch([
    env.DB.prepare('INSERT OR IGNORE INTO product_tombstones(supplier_id,external_id,product_id,purged_at) SELECT supplier_id,external_id,id,? FROM products WHERE id=? AND deleted_at IS NOT NULL').bind(at, row.id),
    env.DB.prepare(`DELETE FROM slug_redirects WHERE product_id=? AND ${claimed}`).bind(row.id, row.id, at),
    env.DB.prepare(`DELETE FROM recognition_applications WHERE product_id=? AND ${claimed}`).bind(row.id, row.id, at),
    env.DB.prepare(`DELETE FROM products WHERE id=? AND deleted_at IS NOT NULL AND ${claimed}`).bind(row.id, row.id, at),
    env.DB.prepare(`INSERT INTO audit_events(id,actor,action,resource_id,created_at,actor_type,actor_role,details_json) SELECT ?,?,?,?,?,?,?,? WHERE ${claimed}`)
      .bind(purgeId, principal?.actor ?? 'system', 'product.purge', row.id, at, principal?.type ?? 'system', principal?.role ?? null, JSON.stringify({ externalId: row.external_id, supplierId: row.supplier_id, mediaKeys: [...keys] }), row.id, at)
  ]);
  if (!(results[3]?.meta?.changes ?? results[3]?.changes)) fail('Product changed (restored or already deleted); reload and try again', 409);
  return { purged: true, mediaDeleted: (await deleteUnreferenced(env, keys, 'purge')).length };
}

// ---- media library
function duplicateGroups(byKey, state) {
  const groups = new Map();
  for (const row of byKey.values()) if (row.sha256) { const id = `${row.sha256}|${row.content_type}`; if (!groups.has(id)) groups.set(id, []); groups.get(id).push(row); }
  const result = new Map();
  for (const members of groups.values()) {
    if (members.length < 2) continue;
    const immutable = row => (state.cartLines.get(row.key) || 0) > 0 || (state.keptBy.get(row.key) || []).length > 0;
    const rank = row => [immutable(row) ? 0 : 1, state.live.has(row.key) ? 0 : 1, row.created_at, row.key];
    const sorted = [...members].sort((a, b) => { const x = rank(a), y = rank(b); for (let i = 0; i < x.length; i++) if (x[i] !== y[i]) return x[i] < y[i] ? -1 : 1; return 0; });
    for (const row of sorted.slice(1)) result.set(row.key, sorted[0]);
  }
  return result;
}
const sameLineage = (a, b) => (a.product_id ?? null) === (b.product_id ?? null) && (a.original_key ?? null) === (b.original_key ?? null) && (a.cutout_key ?? null) === (b.cutout_key ?? null);
function mergeBlock(row, survivor, state, sourceKeys) {
  if ((state.cartLines.get(row.key) || 0) > 0) return 'cart';
  if ((state.keptBy.get(row.key) || []).length) return 'lineage';
  if (!sameLineage(row, survivor)) return 'lineage-mismatch';
  if (sourceKeys.has(row.key)) return 'supplier-source';
  return null;
}
async function sourceMediaKeys(env) {
  const { results } = await env.DB.prepare("SELECT DISTINCT substr(j.value,8) AS key FROM products p, json_each(p.source_json,'$.photos') j WHERE j.type='text' AND j.value GLOB '/media/?*'").all();
  return new Set(results.map(row => row.key));
}
export async function mediaLibrary(env) {
  const state = await env.DB.prepare('SELECT last_scan_at FROM media_state WHERE id=1').first();
  const base = { storageAvailable: !!env.MEDIA, graceHours: GRACE_HOURS, lastScanAt: state?.last_scan_at ?? null };
  const lv = await liveness(env), dups = duplicateGroups(lv.byKey, lv), sourceKeys = await sourceMediaKeys(env);
  const graceBefore = new Date(Date.now() - GRACE_HOURS * 3600_000).toISOString();
  const keys = new Set([...lv.byKey.keys(), ...lv.referencedBy.keys(), ...lv.cartLines.keys()]);
  const items = [...keys].map(key => {
    const row = lv.byKey.get(key), live = lv.live.has(key), survivor = dups.get(key);
    const orphan = !!row && !live, recent = orphan && (row.touched_at || row.created_at) >= graceBefore;
    const reason = survivor ? mergeBlock(row, survivor, lv, sourceKeys) : null;
    return { key, url: `/media/${key}`, tracked: !!row, size: row?.size ?? null, contentType: row?.content_type ?? null, kind: row?.kind ?? 'unknown', sha256: row?.sha256 ?? null,
      createdAt: row?.created_at ?? null, productId: row?.product_id ?? null, referencedBy: lv.referencedBy.get(key) || [], cartLines: lv.cartLines.get(key) || 0,
      keptBy: lv.keptBy.get(key) || [], live, orphan, recent, duplicateOf: survivor?.key ?? null, mergeable: !!survivor && !reason, reason };
  }).sort((a, b) => (b.createdAt || '').localeCompare(a.createdAt || '') || a.key.localeCompare(b.key));
  const sum = list => list.reduce((n, item) => n + (item.size || 0), 0), tracked = items.filter(i => i.tracked);
  const orphans = items.filter(i => i.orphan), duplicates = items.filter(i => i.duplicateOf);
  return { ...base, summary: { objectCount: tracked.length, totalBytes: sum(tracked), liveCount: items.filter(i => i.live).length, liveBytes: sum(items.filter(i => i.live)),
    orphanCount: orphans.length, orphanBytes: sum(orphans), recentOrphanCount: orphans.filter(i => i.recent).length, duplicateCount: duplicates.length, duplicateBytes: sum(duplicates),
    untrackedCount: items.filter(i => !i.tracked).length }, items };
}

export async function scanMedia(env, body) {
  if (!env.MEDIA) fail('Photo storage is not configured', 503);
  if (body.cursor != null && (typeof body.cursor !== 'string' || body.cursor.length > 2000)) fail('Invalid scan cursor');
  const page = await env.MEDIA.list({ limit: SCAN_PAGE, include: ['httpMetadata', 'customMetadata'], ...(body.cursor ? { cursor: body.cursor } : {}) });
  let added = 0;
  for (const listed of page.objects) {
    if (!MEDIA_KEY.test(listed.key)) continue;
    const known = await env.DB.prepare('SELECT sha256 FROM media_objects WHERE key=?').bind(listed.key).first();
    if (known?.sha256) continue;
    const object = await env.MEDIA.get(listed.key); if (!object) continue;
    const bytes = new Uint8Array(await new Response(object.body).arrayBuffer());
    const meta = object.customMetadata ?? listed.customMetadata, l = lineageOf(meta);
    const uploaded = object.uploaded ?? listed.uploaded, createdAt = uploaded ? new Date(uploaded).toISOString() : now();
    await trackStatement(env, { key: listed.key, size: bytes.byteLength, contentType: object.httpMetadata?.contentType ?? listed.httpMetadata?.contentType ?? null, sha256: await sha256Hex(bytes),
      kind: l.kind, productId: l.productId, originalKey: l.originalKey, cutoutKey: l.cutoutKey, createdAt, scanned: true }).run();
    added++;
  }
  const done = !page.truncated;
  if (done) await env.DB.batch([env.DB.prepare('UPDATE media_state SET last_scan_at=? WHERE id=1').bind(now()), auditStatement(env, 'media.scan', 'media', undefined, { lastPageAdded: added })]);
  return { scanned: page.objects.length, added, cursor: done ? null : page.cursor, done };
}

function keyList(value, label) {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.some(key => typeof key !== 'string' || !MEDIA_KEY.test(key))) fail(`Invalid ${label} keys`);
  return [...new Set(value)];
}
export async function cleanupMedia(env, body) {
  if (!env.MEDIA) fail('Photo storage is not configured', 503);
  if (body.confirm !== true) fail('Explicit confirm:true is required for cleanup');
  const orphans = keyList(body.orphans, 'orphan'), duplicates = keyList(body.duplicates, 'duplicate').filter(key => !orphans.includes(key));
  if (!orphans.length && !duplicates.length) fail('Choose media to clean up');
  if (orphans.length + duplicates.length > CLEANUP_LIMIT) fail(`Clean up at most ${CLEANUP_LIMIT} files at a time`);
  const graceBefore = new Date(Date.now() - GRACE_HOURS * 3600_000).toISOString();
  const deleted = [], merged = [], skipped = [];let freedBytes = 0;
  // Duplicates first: repoint product photos to the survivor, then delete the copy.
  if (duplicates.length) {
    const lv = await liveness(env), dups = duplicateGroups(lv.byKey, lv), sourceKeys = await sourceMediaKeys(env);
    for (const key of duplicates) {
      const row = lv.byKey.get(key), survivor = dups.get(key);
      if (!row) { skipped.push({ key, reason: 'untracked' }); continue; }
      if (!survivor) { skipped.push({ key, reason: 'not-duplicate' }); continue; }
      const block = mergeBlock(row, survivor, lv, sourceKeys);
      if (block) { skipped.push({ key, reason: block === 'cart' || block === 'lineage' ? 'immutable-reference' : block }); continue; }
      if (!await env.MEDIA.head(survivor.key)) { skipped.push({ key, reason: 'missing' }); continue; }
      const products = (await env.DB.prepare('SELECT p.id,p.overrides_json FROM media_refs r JOIN products p ON p.id=r.product_id WHERE r.key=?').bind(key).all()).results;
      let changed = null, repointed = 0;
      for (const product of products) {
        const overrides = parse(product.overrides_json), from = `/media/${key}`, to = `/media/${survivor.key}`;
        if (!Array.isArray(overrides.photos)) continue;
        const photos = [...new Set(overrides.photos.map(url => url === from ? to : url))];
        const result = await env.DB.batch([
          // The survivor's row can only disappear through guardedDelete, which re-checks references, so this closes the race.
          env.DB.prepare('UPDATE products SET overrides_json=?,updated_at=? WHERE id=? AND overrides_json=? AND EXISTS (SELECT 1 FROM media_objects WHERE key=?)').bind(JSON.stringify({ ...overrides, photos }), now(), product.id, product.overrides_json, survivor.key),
          auditStatement(env, 'product.update', product.id, undefined, { mediaMerge: { from, to } })
        ]);
        if (!(result[0]?.meta?.changes ?? result[0]?.changes)) { changed = (await env.DB.prepare('SELECT 1 AS ok FROM media_objects WHERE key=?').bind(survivor.key).first()) ? 'changed' : 'missing'; break; }
        repointed++;
      }
      if (changed) { skipped.push({ key, reason: changed }); continue; }
      // A copy nothing referenced is an orphan and keeps the orphan grace period.
      const gone = await guardedDelete(env, key, products.length ? {} : { graceBefore });
      if (!gone && !products.length && (row.touched_at || row.created_at) >= graceBefore) { skipped.push({ key, reason: 'recent' }); continue; }
      if (!gone) { skipped.push({ key, reason: row.touched_at && row.touched_at >= graceCutoff() ? 'recent' : 'referenced' }); continue; }
      merged.push({ key, into: survivor.key, products: repointed }); freedBytes += gone.size || 0;
    }
  }
  if (orphans.length) {
    const { live, byKey } = await liveness(env);
    let pending = [];
    for (const key of orphans) {
      if (!byKey.has(key)) skipped.push({ key, reason: 'untracked' });
      else if (live.has(key)) skipped.push({ key, reason: 'referenced' });
      else if ((byKey.get(key).touched_at || byKey.get(key).created_at) >= graceBefore) skipped.push({ key, reason: 'recent' });
      else pending.push(key);
    }
    // Lineage children of other selected orphans become deletable once those are gone, so retry until no progress.
    for (let progress = true; pending.length && progress;) {
      progress = false; const next = [];
      for (const key of pending) { const gone = await guardedDelete(env, key, { graceBefore }); if (gone) { deleted.push(key); freedBytes += gone.size || 0; progress = true; } else next.push(key); }
      pending = next;
    }
    for (const key of pending) skipped.push({ key, reason: 'referenced' });
  }
  await auditStatement(env, 'media.cleanup', 'media', undefined, { deleted: deleted.length, merged: merged.length, skipped: skipped.length, freedBytes, keys: [...deleted, ...merged.map(m => m.key)].slice(0, 200) }).run();
  return { deleted, merged, skipped, freedBytes };
}
