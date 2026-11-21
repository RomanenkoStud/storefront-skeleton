#!/usr/bin/env node
// Compress the MAIN (first) photo of every published product into a small WebP "card" thumbnail.
// The storefront card tile uses it; the product page keeps the untouched original.
//
//   node tools/card-thumbnails.mjs [--env prod|staging] [--limit N] [--dry-run] [--force] [--no-prune]
//
// Defaults: --env prod, --limit 300. Idempotent: a photo that already has a 'card' row in photo_derivatives is skipped
// (--force regenerates). Thumbnails go to R2 under a content-addressed key <sha256(url)>-<hash>.card.webp and are recorded in photo_derivatives (migration 0019).
// Needs THUMBS_CLOUDFLARE_API_TOKEN (D1 edit + R2 read/write, see docs/MEDIA.md) and CLOUDFLARE_ACCOUNT_ID.
// Optional: THUMBS_D1_DATABASE_ID (skips the database lookup, needed when the token cannot list databases),
// THUMBS_D1_DATABASE, THUMBS_R2_BUCKET (override the default names). Never uses the deploy tokens.
// Exit code is non-zero only for systemic failure: bad config, or Cloudflare D1/R2 calls failing (see isSystemicFailure).
// Broken photos (supplier 404, not an image) are logged per item and never change the exit code.
import { CARD_THUMBNAIL_KEY, firstPhotoSql } from '../apps/api/src/photo-derivatives.js';
import { safeDownload } from './safe-download.mjs';
import { appendFileSync, readFileSync } from 'node:fs';
import {
  CONCURRENCY, ENVS, MAX_EDGE, MAX_SOURCE_BYTES, QUALITY, VARIANT, findStale, formatBytes, imageType, isSystemicFailure,
  paramsString, parseArgs, selectCandidates, sha256, sourceKind, swapPlan, thumbnailUrl, worthKeeping,
} from './card-thumbnails-core.mjs';

const FETCH_TIMEOUT_MS = 30000;
// SQL twin of firstPhoto(): the first element of `overrides.photos ?? source.photos`.
const FIRST_PHOTO = firstPhotoSql('p');

/** A failed Cloudflare D1/R2 call (as opposed to a broken photo): counts toward the systemic-failure exit code. */
class InfraError extends Error {}

function config(opts) {
  const token = process.env.THUMBS_CLOUDFLARE_API_TOKEN; // dedicated token only: the deploy tokens are never read
  if (!token) throw new Error('THUMBS_CLOUDFLARE_API_TOKEN is not set');
  const account = process.env.CLOUDFLARE_ACCOUNT_ID;
  if (!account) throw new Error('CLOUDFLARE_ACCOUNT_ID is not set');
  const env = ENVS[opts.env];
  return { token, account, db: process.env.THUMBS_D1_DATABASE || env.db, dbId: process.env.THUMBS_D1_DATABASE_ID || null, bucket: process.env.THUMBS_R2_BUCKET || env.bucket };
}

/** Defence in depth: the job can only ever write or delete thumbnail objects, never an original. */
function assertCardKey(key) { if (!CARD_THUMBNAIL_KEY.test(key)) throw new Error(`refusing to touch non-thumbnail key ${key}`); }

function cloudflare(cfg) {
  const base = `https://api.cloudflare.com/client/v4/accounts/${cfg.account}`;
  const call = (path, init = {}) => fetch(base + path, { ...init, headers: { Authorization: `Bearer ${cfg.token}`, ...(init.headers || {}) }, signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
  const json = async (path, init) => {
    const res = await call(path, init);
    const body = await res.json().catch(() => ({}));
    if (!res.ok || body.success === false) throw new InfraError(`Cloudflare API ${path.split('?')[0]}: ${res.status} ${JSON.stringify(body.errors || body).slice(0, 200)}`);
    return body.result;
  };
  let dbId = cfg.dbId;
  const database = async () => {
    if (dbId) return dbId;
    const list = await json(`/d1/database?name=${encodeURIComponent(cfg.db)}&per_page=50`);
    const found = list.find(d => d.name === cfg.db);
    if (!found) throw new InfraError(`D1 database ${cfg.db} not found`);
    return (dbId = found.uuid);
  };
  const sql = async (query, params = []) => (await json(`/d1/database/${await database()}/query`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ sql: query, params }) }))[0];
  const objectPath = key => `/r2/buckets/${cfg.bucket}/objects/${encodeURIComponent(key)}`;
  return {
    sql,
    getObject: async key => { const res = await call(objectPath(key)); if (res.status === 404) throw new Error(`original ${key} is missing from R2`); if (!res.ok) throw new InfraError(`R2 read ${key}: ${res.status}`); return readCapped(res); },
    putObject: async (key, body, type) => { assertCardKey(key); const res = await call(objectPath(key), { method: 'PUT', headers: { 'Content-Type': type }, body }); if (!res.ok) throw new InfraError(`R2 upload ${key}: ${res.status}`); },
    deleteObject: async key => { assertCardKey(key); const res = await call(objectPath(key), { method: 'DELETE' }); if (!res.ok && res.status !== 404) throw new InfraError(`R2 delete ${key}: ${res.status}`); },
  };
}

/** Reads a response body up to MAX_SOURCE_BYTES; rejects larger downloads instead of buffering them. */
async function readCapped(res) {
  const declared = Number(res.headers.get('content-length'));
  if (declared > MAX_SOURCE_BYTES) throw new Error(`image is ${declared} bytes, over the ${MAX_SOURCE_BYTES} byte cap`);
  const chunks = [];
  let size = 0;
  for await (const chunk of res.body) {
    size += chunk.length;
    if (size > MAX_SOURCE_BYTES) { await res.body.cancel?.().catch(() => {}); throw new Error(`image is over the ${MAX_SOURCE_BYTES} byte cap`); }
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

async function download(kind, cf) {
  if (kind.kind === 'r2') return cf.getObject(kind.key);
  return safeDownload(kind.url, { timeoutMs: FETCH_TIMEOUT_MS, maxBytes: MAX_SOURCE_BYTES }); // public https only, every hop and address checked, no credentials
}

async function makeThumbnail(input) {
  const { default: sharp } = await import('sharp'); // dev-only dependency; never imported by the Worker or web bundle
  const { data, info } = await sharp(input, { failOn: 'error', limitInputPixels: 120e6 })
    .rotate()
    .resize({ width: MAX_EDGE, height: MAX_EDGE, fit: 'inside', withoutEnlargement: true })
    .webp({ quality: QUALITY }) // alpha is kept: cut-outs are transparent
    .toBuffer({ resolveWithObject: true });
  return { data, width: info.width, height: info.height };
}

async function processOne(sourceUrl, cf, opts, existingUrl) {
  const kind = sourceKind(sourceUrl);
  if (kind.kind === 'unsupported') return { status: 'failed', reason: 'unsupported URL' };
  const input = await download(kind, cf);
  if (!imageType(input)) return { status: 'failed', reason: 'not a JPEG/PNG/WebP image' };
  const thumb = await makeThumbnail(input);
  const keep = worthKeeping(input.length, thumb.data.length);
  const sourceHash = sha256(input), url = keep ? thumbnailUrl(sourceUrl, sourceHash) : null;
  const result = { status: keep ? 'created' : 'skipped', sourceBytes: input.length, bytes: keep ? thumb.data.length : 0 };
  if (opts.dryRun) return result;
  const now = new Date().toISOString();
  // Keys are content-addressed and never overwritten with different bytes. Order: new object, then the row, then the old object.
  for (const step of swapPlan(existingUrl, url, opts.force)) {
    if (step === 'put-new') await cf.putObject(url.slice('/media/'.length), thumb.data, 'image/webp');
    else if (step === 'update-row') await cf.sql(
      'INSERT OR REPLACE INTO photo_derivatives (source_url,variant,url,width,height,bytes,source_bytes,source_hash,params,created_at) VALUES (?,?,?,?,?,?,?,?,?,?)',
      [sourceUrl, VARIANT, url, keep ? thumb.width : null, keep ? thumb.height : null, keep ? thumb.data.length : null, input.length, sourceHash, paramsString(), now]);
    else await cf.deleteObject(existingUrl.slice('/media/'.length));
  }
  return result;
}

async function pool(items, size, worker) {
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(size, items.length) }, async () => {
    while (next < items.length) { const item = items[next++]; await worker(item); }
  }));
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  if (opts.help) {
    console.log(readFileSync(new URL(import.meta.url), 'utf8').split('\n').slice(1, 12).map(l => l.replace(/^\/\/ ?/, '')).join('\n'));
    return 0;
  }
  const cfg = config(opts), cf = cloudflare(cfg), label = ENVS[opts.env].label;
  console.log(`Card thumbnails (${label}${opts.dryRun ? ', dry run' : ''}${opts.force ? ', force' : ''}), limit ${opts.limit}`);

  // Published, non-deleted products of enabled suppliers. Duplicate-group non-primary members are included: harmless,
  // the Worker only serves a thumbnail whose source is the first photo of what the storefront currently shows.
  const published = (await cf.sql(
    `SELECT ${FIRST_PHOTO} AS first_photo, d.source_url IS NOT NULL AND d.params = ? AS has_derivative, d.url AS derivative_url FROM products p JOIN suppliers s ON s.id=p.supplier_id
     LEFT JOIN photo_derivatives d ON d.source_url=${FIRST_PHOTO} AND d.variant='card'
     WHERE s.enabled=1 AND s.deleted_at IS NULL AND p.deleted_at IS NULL AND json_extract(p.overrides_json,'$.published')=1 ORDER BY p.updated_at DESC,p.id`, [paramsString()])).results;
  const existing = new Map(published.filter(r => r.first_photo && r.derivative_url).map(r => [r.first_photo, r.derivative_url]));
  const { total, pending, selected } = selectCandidates(published, { force: opts.force, limit: opts.limit });
  console.log(`${total} distinct main photos, ${pending} need a thumbnail, processing ${selected.length}`);

  const stats = { created: 0, skipped: 0, failed: 0, infraFailed: 0, sourceBytes: 0, bytes: 0, pruned: 0 };
  await pool(selected, CONCURRENCY, async url => {
    try {
      const r = await processOne(url, cf, opts, existing.get(url) ?? null);
      if (r.status === 'failed') throw new Error(r.reason);
      stats[r.status]++;
      if (r.status === 'created') { stats.sourceBytes += r.sourceBytes; stats.bytes += r.bytes; }
      console.log(`  ${r.status === 'created' ? 'ok     ' : 'no gain '} ${url} ${formatBytes(r.sourceBytes)} -> ${r.status === 'created' ? formatBytes(r.bytes) : 'kept original'}`);
    } catch (error) {
      stats.failed++;
      if (error instanceof InfraError) stats.infraFailed++;
      console.warn(`  FAILED  ${url}: ${error.message}`); // per-item, never aborts the run
    }
  });

  if (opts.prune && !opts.dryRun) {
    try {
      const live = new Set((await cf.sql(`SELECT ${FIRST_PHOTO} AS first_photo FROM products p WHERE p.deleted_at IS NULL`)).results.map(r => r.first_photo).filter(Boolean));
      const stale = findStale((await cf.sql('SELECT source_url,url FROM photo_derivatives WHERE variant=?', [VARIANT])).results, live);
      for (const d of stale) {
        // Row first: the Worker stops advertising it, then the object goes. A crash in between only leaves an orphan object.
        await cf.sql('DELETE FROM photo_derivatives WHERE source_url=? AND variant=?', [d.source_url, VARIANT]);
        if (d.url) await cf.deleteObject(d.url.slice('/media/'.length));
        stats.pruned++;
      }
    } catch (error) {
      // Cloudflare errors while pruning count as one failed unit of work toward the exit code, and are visible in the log.
      console.warn(`::warning::Pruning stale thumbnails failed: ${error.message}`);
      stats.pruneAttempts = 1;
      if (error instanceof InfraError) stats.infraFailed++;
    }
  }

  const saved = stats.sourceBytes - stats.bytes;
  const summary = `Card thumbnails (${label}${opts.dryRun ? ', dry run' : ''}): ${total} main photos, ${pending} pending, ${stats.created} ${opts.dryRun ? 'would be created' : 'created'}, ${stats.skipped} not smaller (kept original), ${stats.failed} failed (${stats.infraFailed} Cloudflare), ${stats.pruned} stale pruned. Bytes ${formatBytes(stats.sourceBytes)} -> ${formatBytes(stats.bytes)}${stats.sourceBytes ? ` (saved ${formatBytes(saved)}, ${Math.round(100 * saved / stats.sourceBytes)}%)` : ''}.${pending > selected.length ? ` ${pending - selected.length} remain for the next run.` : ''}`;
  console.log(summary);
  if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, `${summary}\n`);
  return isSystemicFailure({ attempted: selected.length + (stats.pruneAttempts || 0), infraFailed: stats.infraFailed }) ? 1 : 0;
}

main().then(code => process.exit(code), error => { console.error(`Card thumbnails failed: ${error.message}`); process.exit(1); });
