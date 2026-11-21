// Nova Poshta delivery points (ADR-0011): read-only endpoints over our own R2 snapshot. The Worker never calls Nova Poshta.
// Dispatched at the top of route() before recognition and the D1 check, so nothing here may touch env.DB.
import { PREFIX, KINDS, GUID, cityLetter, cityShardKey, normalizeQuery, parseManifest, searchCities } from '../../../packages/catalog/delivery.js';

const MANIFEST_TTL_MS = 60000;
const JSON_HEADERS = { 'Content-Type': 'application/json; charset=utf-8', 'X-Robots-Tag': 'noindex' };
const manifests = new WeakMap(); // bucket object -> {manifest, at}; only successful reads are cached

export class CatalogUnavailable extends Error { constructor() { super('catalog_unavailable'); this.name = 'CatalogUnavailable'; } }
const bucketOf = env => env?.NP_CATALOG ?? env?.MEDIA ?? null;

// ok responses are cacheable for five minutes; errors never are.
const ok = (body, extra = {}) => new Response(body, { status: 200, headers: { ...JSON_HEADERS, 'Cache-Control': 'public, max-age=300', ...extra } });
const error = (code, status, extra = {}) => new Response(JSON.stringify({ error: code }), { status, headers: { ...JSON_HEADERS, 'Cache-Control': 'no-store', ...extra } });

async function readJson(bucket, key) {
  let object;
  try { object = await bucket.get(key); } catch { throw new CatalogUnavailable(); }
  if (!object) throw new CatalogUnavailable();
  try { return JSON.parse(await object.text()); } catch { throw new CatalogUnavailable(); }
}
async function manifestOf(env, now) {
  const bucket = bucketOf(env);
  if (!bucket || typeof bucket.get !== 'function') throw new CatalogUnavailable();
  const cached = manifests.get(bucket);
  if (cached && now() - cached.at < MANIFEST_TTL_MS) return { bucket, manifest: cached.manifest };
  let object;
  try { object = await bucket.get(`${PREFIX}current.json`); } catch { throw new CatalogUnavailable(); }
  if (!object) throw new CatalogUnavailable();
  let text;
  try { text = await object.text(); } catch { throw new CatalogUnavailable(); }
  const manifest = parseManifest(text);
  if (!manifest) throw new CatalogUnavailable();
  manifests.set(bucket, { manifest, at: now() });
  return { bucket, manifest };
}

async function cities(env, url, now) {
  const params = [...url.searchParams.keys()];
  const raw = url.searchParams.getAll('q');
  const q = params.length === 1 && raw.length === 1 ? normalizeQuery(raw[0]) : null;
  if (q === null) return error('invalid_request', 400);
  const { bucket, manifest } = await manifestOf(env, now);
  const letter = cityLetter(q);
  let items = [];
  if (manifest.cityLetters.includes(letter)) {
    const shard = await readJson(bucket, `${PREFIX}${manifest.snapshotId}/cities/${cityShardKey(letter)}.json`);
    if (!Array.isArray(shard)) throw new CatalogUnavailable();
    items = searchCities(shard, q);
  }
  return ok(JSON.stringify({ generatedAt: manifest.generatedAt, items }));
}

async function warehouses(env, url, now) {
  const keys = [...url.searchParams.keys()];
  const refs = url.searchParams.getAll('cityRef'), kinds = url.searchParams.getAll('kind');
  const cityRef = refs.length === 1 ? refs[0].toLowerCase() : null, kind = kinds.length === 1 ? kinds[0] : null;
  if (keys.length !== 2 || !cityRef || !GUID.test(cityRef) || !KINDS.includes(kind)) return error('invalid_request', 400);
  const { bucket, manifest } = await manifestOf(env, now);
  const h = cityRef[0];
  const index = await readJson(bucket, `${PREFIX}${manifest.snapshotId}/points/${h}.idx.json`);
  if (!index || typeof index !== 'object' || Array.isArray(index)) throw new CatalogUnavailable();
  const range = Object.hasOwn(index, cityRef) && index[cityRef] && typeof index[cityRef] === 'object' && Object.hasOwn(index[cityRef], kind) ? index[cityRef][kind] : null;
  if (!range) return ok(JSON.stringify({ cityRef, kind, generatedAt: manifest.generatedAt, items: [] }));
  const [offset, length] = Array.isArray(range) ? range : [];
  if (!Number.isSafeInteger(offset) || !Number.isSafeInteger(length) || offset < 0 || length <= 0) throw new CatalogUnavailable();
  let object;
  try { object = await bucket.get(`${PREFIX}${manifest.snapshotId}/points/${h}.json`, { range: { offset, length } }); } catch { throw new CatalogUnavailable(); }
  // On a ranged read `size` is the whole object; the served part is in `range`. Anything but the exact slice is a short or shifted read.
  if (!object?.body || object.range?.offset !== offset || object.range?.length !== length || !Number.isSafeInteger(object.size) || object.size < offset + length) throw new CatalogUnavailable();
  return ok(object.body); // streamed unchanged, never parsed
}

export async function handleDelivery(request, env, { now = Date.now } = {}) {
  const url = new URL(request.url);
  const handler = url.pathname === '/api/delivery/np/cities' ? cities : url.pathname === '/api/delivery/np/warehouses' ? warehouses : null;
  if (!handler) return error('not_found', 404);
  if (request.method !== 'GET') return error('method_not_allowed', 405, { Allow: 'GET' });
  try { return await handler(env, url, now); }
  catch (e) {
    if (e instanceof CatalogUnavailable) { console.error('Delivery catalog request failed: catalog_unavailable'); return error('catalog_unavailable', 503); }
    throw e;
  }
}

// Used by profile and checkout writes: the catalog point for a Ref, or null. Throws CatalogUnavailable when the snapshot cannot be read.
export async function resolvePoint(env, warehouseRef, { now = Date.now } = {}) {
  const ref = typeof warehouseRef === 'string' ? warehouseRef.toLowerCase() : '';
  if (!GUID.test(ref)) return null;
  const { bucket, manifest } = await manifestOf(env, now);
  const shard = await readJson(bucket, `${PREFIX}${manifest.snapshotId}/refs/${ref.slice(0, 2)}.json`);
  if (!shard || typeof shard !== 'object' || Array.isArray(shard)) throw new CatalogUnavailable();
  if (!Object.hasOwn(shard, ref)) return null;
  const p = shard[ref];
  if (!p || (p.kind !== 'branch' && p.kind !== 'postomat') || typeof p.cityRef !== 'string' || typeof p.cityName !== 'string' || typeof p.name !== 'string') throw new CatalogUnavailable();
  return { cityRef: p.cityRef, cityName: p.cityName, kind: p.kind, number: typeof p.number === 'string' ? p.number : null, name: p.name };
}
