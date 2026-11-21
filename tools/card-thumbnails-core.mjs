// Pure, dependency-free parts of tools/card-thumbnails.mjs: selection, key naming, size decision,
// argument parsing, safety checks. No network, no sharp, so they can be unit-tested.
import { createHash } from 'node:crypto';

export const VARIANT = 'card';
// Long edge of the thumbnail. The card is a 3:4 portrait; on a phone (2 columns, ~180 CSS px wide, ~240 high, DPR 2-3)
// it needs 360-540 x 480-720 device pixels, on the widest desktop layout (3 columns, ~470 CSS px) 470 x 627 at 1x.
// 800 px on the long edge covers all of that and ~1.3x on the largest card, and is still far below the 270 KB-1.9 MB originals.
export const MAX_EDGE = 800;
export const QUALITY = 75;
export const DEFAULT_LIMIT = 300;
export const MAX_LIMIT = 5000;
export const CONCURRENCY = 4;
export const MAX_SOURCE_BYTES = 25 * 1024 * 1024;
export const ENVS = {
  prod: { label: 'production', db: 'storefront-skeleton', bucket: 'storefront-skeleton-media' },
  staging: { label: 'staging', db: 'storefront-skeleton-staging', bucket: 'storefront-skeleton-media-staging' },
};

export function parseArgs(argv) {
  const opts = { env: 'prod', limit: DEFAULT_LIMIT, dryRun: false, force: false, prune: true, help: false };
  const number = (name, value) => {
    if (!/^[0-9]+$/.test(value ?? '')) throw new Error(`${name} needs a positive whole number`);
    const n = Number(value);
    if (n < 1 || n > MAX_LIMIT) throw new Error(`${name} must be between 1 and ${MAX_LIMIT}`);
    return n;
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--env') opts.env = argv[++i];
    else if (a === '--limit') opts.limit = number('--limit', argv[++i]);
    else if (a === '--dry-run') opts.dryRun = true;
    else if (a === '--force') opts.force = true;
    else if (a === '--no-prune') opts.prune = false;
    else if (a === '-h' || a === '--help') opts.help = true;
    else throw new Error(`Unknown option ${a}`);
  }
  if (!ENVS[opts.env]) throw new Error('--env must be prod or staging');
  return opts;
}

/** First photo of the public projection: `overrides.photos ?? source.photos`, element 0 (see productProjection). */
export function firstPhoto(overrides, source) {
  const photos = overrides?.photos ?? source?.photos;
  const first = Array.isArray(photos) ? photos[0] : undefined;
  return typeof first === 'string' && first ? first : null;
}

const MEDIA_ORIGINAL = /^\/media\/([a-f0-9-]+)\.(jpg|png|webp)$/;

/** Classifies a photo URL the tool is willing to read: R2 media path, public https URL, or unsupported. */
export function sourceKind(url) {
  if (typeof url !== 'string') return { kind: 'unsupported' };
  const media = MEDIA_ORIGINAL.exec(url);
  if (media) return { kind: 'r2', key: `${media[1]}.${media[2]}` };
  try {
    const u = new URL(url);
    if (u.protocol !== 'https:' || u.username || u.password || (u.port && u.port !== '443')) return { kind: 'unsupported' };
    const host = u.hostname.toLowerCase();
    // The runner must never be pointed at internal addresses by a supplier-supplied URL.
    if (host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.internal') || host.endsWith('.local') || !host.includes('.') || /^[\d.]+$/.test(host) || host.startsWith('[')) return { kind: 'unsupported' };
    return { kind: 'https', url: u.href };
  } catch { return { kind: 'unsupported' }; }
}

// Bump PARAMS_VERSION whenever the encoder pipeline changes in a way not captured by the numbers below.
export const PARAMS_VERSION = 1;
export const paramsString = () => `${VARIANT}:v${PARAMS_VERSION}:${MAX_EDGE}:${QUALITY}:webp`;
export const sha256 = data => createHash('sha256').update(data).digest('hex');

/**
 * Content-addressed thumbnail key `<32 hex of sha256(source url)>-<16 hex of sha256(source bytes + params)>.card.webp`
 * (matches CARD_THUMBNAIL_KEY in apps/api/src/photo-derivatives.js). It changes whenever the source bytes or the encoder
 * params change, so an object is never overwritten with different bytes and can be cached as immutable.
 */
export function thumbnailKey(sourceUrl, sourceHash, params = paramsString()) {
  const content = createHash('sha256').update(sourceHash).update('\0').update(params).digest('hex').slice(0, 16);
  return `${sha256(sourceUrl).slice(0, 32)}-${content}.${VARIANT}.webp`;
}
export const thumbnailUrl = (sourceUrl, sourceHash, params) => `/media/${thumbnailKey(sourceUrl, sourceHash, params)}`;

/** Swap order for a regenerated thumbnail: upload new, point the row at it, only then delete the old object. */
export function swapPlan(oldUrl, newUrl, force = false) {
  const steps = [];
  if (newUrl && (force || newUrl !== oldUrl)) steps.push('put-new'); // --force re-uploads even an unchanged key, healing a missing object
  steps.push('update-row');
  if (oldUrl && oldUrl !== newUrl) steps.push('delete-old');
  return steps;
}

/**
 * rows: [{ first_photo, has_derivative }] (has_derivative: a row exists made with the CURRENT params) for published, non-deleted products of enabled suppliers.
 * Returns distinct source URLs that still need a thumbnail, in first-seen order, at most `limit`.
 */
export function selectCandidates(rows, { force = false, limit = DEFAULT_LIMIT } = {}) {
  const seen = new Set(), out = [];
  for (const row of rows) {
    const url = row.first_photo;
    if (!url || seen.has(url)) continue;
    seen.add(url);
    if (!force && row.has_derivative) continue;
    out.push(url);
  }
  return { total: seen.size, pending: out.length, selected: out.slice(0, limit) };
}

/** Derivatives whose source is no longer the first photo of any live product: harmless, but pruned to save storage. */
export function findStale(derivatives, livePhotos) {
  const live = livePhotos instanceof Set ? livePhotos : new Set(livePhotos);
  return derivatives.filter(d => !live.has(d.source_url));
}

/** A thumbnail is only kept when it is strictly smaller than the original. */
export const worthKeeping = (sourceBytes, thumbBytes) => Number.isFinite(sourceBytes) && Number.isFinite(thumbBytes) && thumbBytes > 0 && thumbBytes < sourceBytes;

/** Image magic check. Only JPEG, PNG and WebP are processed. */
export function imageType(buf) {
  if (!buf || buf.length < 12) return null;
  if (buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return 'image/jpeg';
  if ([137, 80, 78, 71, 13, 10, 26, 10].every((v, i) => buf[i] === v)) return 'image/png';
  if (buf.toString('latin1', 0, 4) === 'RIFF' && buf.toString('latin1', 8, 12) === 'WEBP') return 'image/webp';
  return null;
}

/**
 * Systemic failure means our own infrastructure is broken: every attempted unit of work failed on a Cloudflare D1/R2 call
 * (credentials, outage). Failures of the photo itself (supplier 404, not an image, cannot be decoded, blocked host) are
 * item-level and never affect the exit code, otherwise a few permanently broken supplier URLs, which are reselected every
 * night, would turn the nightly run red forever.
 */
export function isSystemicFailure({ attempted, infraFailed = 0 }) {
  return attempted >= 1 && infraFailed === attempted;
}

export const formatBytes = n => n >= 1048576 ? `${(n / 1048576).toFixed(1)} MB` : n >= 1024 ? `${(n / 1024).toFixed(0)} KB` : `${n} B`;
