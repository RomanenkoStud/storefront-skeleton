#!/usr/bin/env node
// Nova Poshta branch/postomat catalog sync (ADR-0011 section 3). Keyless, no dependencies.
// Pulls Address.getWarehouses, reduces it, builds the snapshot (packages/catalog/delivery.js) and publishes it to R2
// through the S3 API (automation), the Cloudflare REST API (local runs only) or a local directory (--out).
// Nothing here ever logs a key, token, secret or upstream body.
import { createHash, createHmac } from 'node:crypto';
import { mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PREFIX, SNAPSHOT_ID, bytes, buildSnapshot, encodeKeyPath, parseManifest, reduceRecord, rfc3986, snapshotIdFor, snapshotTime } from '../packages/catalog/delivery.js';

export const ENDPOINT = 'https://api.novaposhta.ua/v2.0/json/';
export const PAGE_SIZE = 500, PULL_CONCURRENCY = 2, UPLOAD_CONCURRENCY = 4, REQUEST_TIMEOUT_MS = 30000, ATTEMPTS = 3;
// Nova Poshta's totalCount has been observed to exceed the records it actually returns (55,311 vs 55,309 on 2026-11-18, last page short).
// A shortfall up to this bound is accepted only when every page before the last was full and the last page came back short.
export const TOTAL_SLACK = total => Math.max(10, Math.floor(total * 0.001));
export const DROP_FLOOR = 0.8, MIN_AGE_MS = 600000, MAX_PAGE_BYTES = 16 * 1024 * 1024;
export const STAGING_BUCKET = 'storefront-skeleton-np-catalog-staging';
const CONTENT_TYPE = 'application/json; charset=utf-8';
const SNAPSHOT_KEY = /^np-catalog\/v1\/(\d{8}T\d{6}Z)\//;

export class SyncError extends Error {}
const mb = n => (n / 1048576).toFixed(2);
const ms = n => `${Math.round(n)}ms`;

// ---- SigV4 (R2: region auto, service s3, path-style) ------------------------------------------
const sha256Hex = data => createHash('sha256').update(data).digest('hex');
const hmac = (key, data) => createHmac('sha256', key).update(data).digest();
export function canonicalQuery(query) {
  return Object.entries(query).map(([k, v]) => [rfc3986(k), rfc3986(String(v))]).sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : a[1] < b[1] ? -1 : a[1] > b[1] ? 1 : 0)).map(([k, v]) => `${k}=${v}`).join('&');
}
// Returns the headers to send (including Authorization) plus the canonical request, for tests. `path` is already percent-encoded once.
export function signV4({ method, host, path, query = {}, headers = {}, payloadHash, accessKeyId, secretAccessKey, region = 'auto', service = 's3', amzDate, includeContentSha = true }) {
  const date = amzDate.slice(0, 8);
  const all = { host, 'x-amz-date': amzDate, ...(includeContentSha ? { 'x-amz-content-sha256': payloadHash } : {}) };
  for (const [k, v] of Object.entries(headers)) all[k.toLowerCase()] = String(v).trim().replace(/\s+/g, ' ');
  const names = Object.keys(all).sort();
  const canonicalHeaders = names.map(n => `${n}:${all[n]}\n`).join('');
  const signedHeaders = names.join(';');
  const canonicalRequest = [method, path, canonicalQuery(query), canonicalHeaders, signedHeaders, payloadHash].join('\n');
  const scope = `${date}/${region}/${service}/aws4_request`;
  const toSign = ['AWS4-HMAC-SHA256', amzDate, scope, sha256Hex(canonicalRequest)].join('\n');
  const signingKey = hmac(hmac(hmac(hmac(`AWS4${secretAccessKey}`, date), region), service), 'aws4_request');
  const signature = createHmac('sha256', signingKey).update(toSign).digest('hex');
  return { canonicalRequest, signature, headers: { ...all, authorization: `AWS4-HMAC-SHA256 Credential=${accessKeyId}/${scope}, SignedHeaders=${signedHeaders}, Signature=${signature}` } };
}
const unescapeXml = text => text.replace(/&(#x[0-9a-f]+|#\d+|amp|lt|gt|quot|apos);/gi, (_, e) => {
  const map = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" };
  if (e[0] !== '#') return map[e.toLowerCase()];
  return String.fromCodePoint(e[1].toLowerCase() === 'x' ? parseInt(e.slice(2), 16) : Number(e.slice(1)));
});
export function parseListXml(xml) {
  const keys = [...xml.matchAll(/<Contents>[\s\S]*?<Key>([\s\S]*?)<\/Key>[\s\S]*?<\/Contents>/g)].map(m => unescapeXml(m[1]));
  const truncated = /<IsTruncated>\s*true\s*<\/IsTruncated>/i.test(xml);
  const next = /<NextContinuationToken>([\s\S]*?)<\/NextContinuationToken>/.exec(xml);
  return { keys, truncated, next: next ? unescapeXml(next[1]) : null };
}

// ---- transports: {get(key) -> Uint8Array|null, put(key, bytes), list(prefix) -> keys, delete(key)} -------
async function guarded(fetchImpl, url, init, what) {
  let response;
  try { response = await fetchImpl(url, { ...init, redirect: 'manual', signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) }); }
  catch (error) { throw new SyncError(`${what} failed (${error?.name ?? 'Error'})`); }
  return response;
}
export function createS3Transport({ accountId, bucket, accessKeyId, secretAccessKey, fetch: fetchImpl = globalThis.fetch, now = () => new Date() }) {
  const host = `${accountId}.r2.cloudflarestorage.com`;
  const call = async (method, key, { query = {}, body, what, contentType } = {}) => {
    const path = `/${rfc3986(bucket)}${key === null ? '' : `/${encodeKeyPath(key)}`}`;
    const payloadHash = sha256Hex(body ?? '');
    const amzDate = now().toISOString().replace(/[-:]/g, '').replace(/\.\d{3}Z$/, 'Z');
    const { headers } = signV4({ method, host, path, query, headers: contentType ? { 'content-type': contentType } : {}, payloadHash, accessKeyId, secretAccessKey, amzDate });
    delete headers.host;
    const qs = canonicalQuery(query);
    return guarded(fetchImpl, `https://${host}${path}${qs ? `?${qs}` : ''}`, { method, headers, body }, what);
  };
  return {
    kind: 's3',
    async get(key) {
      const r = await call('GET', key, { what: 'R2 read' });
      if (r.status === 404) return null;
      if (!r.ok) throw new SyncError(`R2 read failed (HTTP ${r.status})`);
      return new Uint8Array(await r.arrayBuffer());
    },
    async put(key, data) {
      const r = await call('PUT', key, { body: data, contentType: CONTENT_TYPE, what: 'R2 upload' });
      if (!r.ok) throw new SyncError(`R2 upload failed (HTTP ${r.status})`);
    },
    async delete(key) {
      const r = await call('DELETE', key, { what: 'R2 delete' });
      if (!r.ok && r.status !== 404) throw new SyncError(`R2 delete failed (HTTP ${r.status})`);
    },
    async list(prefix) {
      const keys = [];
      let token = null;
      do {
        const r = await call('GET', null, { query: { 'list-type': 2, prefix, ...(token ? { 'continuation-token': token } : {}) }, what: 'R2 list' });
        if (!r.ok) throw new SyncError(`R2 list failed (HTTP ${r.status})`);
        const page = parseListXml(await r.text());
        keys.push(...page.keys);
        token = page.truncated ? page.next : null;
        if (page.truncated && !token) throw new SyncError('R2 list was truncated without a continuation token');
      } while (token);
      return keys;
    },
  };
}
// Cloudflare REST API (local runs only). The list endpoint and its cursor shape are written from the public documentation and are not verified against a live bucket.
export function createRestTransport({ accountId, bucket, token, fetch: fetchImpl = globalThis.fetch }) {
  const base = `https://api.cloudflare.com/client/v4/accounts/${rfc3986(accountId)}/r2/buckets/${rfc3986(bucket)}/objects`;
  const auth = { Authorization: `Bearer ${token}` };
  return {
    kind: 'rest',
    async get(key) {
      const r = await guarded(fetchImpl, `${base}/${encodeKeyPath(key)}`, { headers: auth }, 'R2 read');
      if (r.status === 404) return null;
      if (!r.ok) throw new SyncError(`R2 read failed (HTTP ${r.status})`);
      return new Uint8Array(await r.arrayBuffer());
    },
    async put(key, data) {
      const r = await guarded(fetchImpl, `${base}/${encodeKeyPath(key)}`, { method: 'PUT', headers: { ...auth, 'Content-Type': CONTENT_TYPE }, body: data }, 'R2 upload');
      if (!r.ok) throw new SyncError(`R2 upload failed (HTTP ${r.status})`);
    },
    async delete(key) {
      const r = await guarded(fetchImpl, `${base}/${encodeKeyPath(key)}`, { method: 'DELETE', headers: auth }, 'R2 delete');
      if (!r.ok && r.status !== 404) throw new SyncError(`R2 delete failed (HTTP ${r.status})`);
    },
    async list(prefix) {
      const keys = [];
      let cursor = null;
      for (let guard = 0; guard < 1000; guard++) {
        const qs = new URLSearchParams({ prefix, per_page: '1000', ...(cursor ? { cursor } : {}) });
        const r = await guarded(fetchImpl, `${base}?${qs}`, { headers: auth }, 'R2 list');
        if (!r.ok) throw new SyncError(`R2 list failed (HTTP ${r.status})`);
        let body;
        try { body = await r.json(); } catch { throw new SyncError('R2 list returned invalid JSON'); }
        for (const item of Array.isArray(body?.result) ? body.result : []) if (typeof item?.key === 'string') keys.push(item.key);
        const info = body?.result_info ?? {};
        cursor = info.cursor && (info.is_truncated ?? true) ? info.cursor : null;
        if (!cursor) return keys;
      }
      throw new SyncError('R2 list did not finish');
    },
  };
}
// Local directory, for --out. Keys map straight to paths; no Cloudflare credential is ever consulted.
export function createFileTransport(root) {
  const base = resolve(root);
  const path = key => { const full = resolve(base, key); if (!full.startsWith(`${base}/`)) throw new SyncError('Unsafe object key'); return full; };
  return {
    kind: 'file',
    async get(key) { try { return new Uint8Array(await readFile(path(key))); } catch (e) { if (e?.code === 'ENOENT') return null; throw new SyncError('Local read failed'); } },
    async put(key, data) { const p = path(key); await mkdir(dirname(p), { recursive: true }); await writeFile(p, data); },
    async delete(key) { await rm(path(key), { force: true }); },
    async list(prefix) {
      const out = [];
      const walk = async dir => {
        let entries;
        try { entries = await readdir(dir, { withFileTypes: true }); } catch (e) { if (e?.code === 'ENOENT') return; throw e; }
        for (const entry of entries) { const full = join(dir, entry.name); if (entry.isDirectory()) await walk(full); else out.push(full.slice(base.length + 1)); }
      };
      await walk(base);
      return out.filter(key => key.startsWith(prefix));
    },
  };
}
export function createMemoryTransport(map = new Map(), options = {}) {
  const log = options.log ?? [];
  return {
    kind: 'memory', map, log,
    async get(key) { log.push(['get', key]); if (options.failGet?.(key)) throw new SyncError('memory read failed'); return map.has(key) ? map.get(key) : null; },
    async put(key, data) { log.push(['put', key]); if (options.failPut?.(key)) throw new SyncError('memory upload failed'); map.set(key, data); },
    async delete(key) { log.push(['delete', key]); map.delete(key); },
    async list(prefix) { return [...map.keys()].filter(k => k.startsWith(prefix)).sort(); },
  };
}

export function selectTransport(env, args) {
  if (args.out) return createFileTransport(args.out); // never touches Cloudflare, whatever the environment holds
  const bucket = env.NP_CATALOG_BUCKET || (args.staging ? STAGING_BUCKET : '');
  if (!bucket) throw new SyncError('No bucket: set NP_CATALOG_BUCKET or pass --staging; the photo bucket is never a default');
  if (!env.CLOUDFLARE_ACCOUNT_ID) throw new SyncError('CLOUDFLARE_ACCOUNT_ID is required');
  const accessKeyId = env.NP_CATALOG_R2_ACCESS_KEY_ID, secretAccessKey = env.NP_CATALOG_R2_SECRET_ACCESS_KEY;
  if (accessKeyId && secretAccessKey) return createS3Transport({ accountId: env.CLOUDFLARE_ACCOUNT_ID, bucket, accessKeyId, secretAccessKey, fetch: args.fetch, now: args.now });
  if (env.GITHUB_ACTIONS === 'true') throw new SyncError('In GitHub Actions only the dedicated R2 S3 credentials are accepted; CLOUDFLARE_API_TOKEN is ignored');
  if (env.CLOUDFLARE_API_TOKEN) return createRestTransport({ accountId: env.CLOUDFLARE_ACCOUNT_ID, bucket, token: env.CLOUDFLARE_API_TOKEN, fetch: args.fetch });
  throw new SyncError('No R2 credentials: set the NP_CATALOG_R2_* pair, or CLOUDFLARE_API_TOKEN for a local run');
}

// ---- pull -----------------------------------------------------------------------------------
async function fetchPage({ fetch: fetchImpl, env, sleep }, page) {
  const body = { ...(env.NOVA_POSHTA_API_KEY ? { apiKey: env.NOVA_POSHTA_API_KEY } : {}), modelName: 'Address', calledMethod: 'getWarehouses', methodProperties: { Limit: String(PAGE_SIZE), Page: String(page), Language: 'UA' } };
  let reason = 'unknown';
  for (let attempt = 1; attempt <= ATTEMPTS; attempt++) {
    if (attempt > 1) await sleep(500 * 2 ** (attempt - 2));
    try {
      const response = await fetchImpl(ENDPOINT, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body), redirect: 'manual', signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) });
      if (response.status !== 200) { reason = `HTTP ${response.status}`; continue; }
      if (Number(response.headers?.get?.('content-length')) > MAX_PAGE_BYTES) { reason = 'response too large'; continue; }
      const raw = new Uint8Array(await response.arrayBuffer());
      if (raw.length > MAX_PAGE_BYTES) { reason = 'response too large'; continue; }
      const text = new TextDecoder().decode(raw);
      let json;
      try { json = JSON.parse(text); } catch { reason = 'invalid JSON'; continue; }
      if (!json || json.success !== true || !Array.isArray(json.data)) { reason = 'unsuccessful response'; continue; }
      return { data: json.data, total: Number(json.info?.totalCount), bytes: raw.length };
    } catch (error) { reason = error?.name === 'TimeoutError' ? 'timeout' : 'network error'; }
  }
  throw new SyncError(`Page ${page} failed after ${ATTEMPTS} attempts (${reason})`);
}

export async function pullAll(ctx) {
  const t0 = ctx.clock();
  const reduced = [];
  let received = 0, upstreamBytes = 0, pages = 0;
  const sizes = new Map();
  const take = (result, page) => { sizes.set(page, result.data.length); received += result.data.length; upstreamBytes += result.bytes; pages++; for (const record of result.data) { const r = reduceRecord(record); if (r) reduced.push(r); } };
  const first = await fetchPage(ctx, 1);
  if (!Number.isSafeInteger(first.total) || first.total < 0) throw new SyncError('Upstream reported no valid totalCount');
  take(first, 1);
  const totalPages = Math.max(1, Math.ceil(first.total / PAGE_SIZE));
  let next = 2, failure = null;
  const worker = async () => {
    while (!failure && next <= totalPages) {
      const page = next++;
      try { take(await fetchPage(ctx, page), page); } catch (error) { failure ??= error; }
    }
  };
  await Promise.all(Array.from({ length: Math.min(PULL_CONCURRENCY, Math.max(0, totalPages - 1)) }, worker));
  if (failure) throw failure;
  if (received < first.total) {
    let fullBeforeLast = true;
    for (let page = 1; page < totalPages; page++) if (sizes.get(page) !== PAGE_SIZE) fullBeforeLast = false;
    const lastShort = (sizes.get(totalPages) ?? 0) < PAGE_SIZE;
    if (!(fullBeforeLast && lastShort && first.total - received <= TOTAL_SLACK(first.total))) {
      throw new SyncError(`Incomplete pull: received ${received} of ${first.total} records`);
    }
  }
  return { reduced, received, total: first.total, pages, upstreamBytes, ms: ctx.clock() - t0 };
}

// ---- guard, upload, retention ------------------------------------------------------------------
export async function readPrevious(transport, { force }) {
  let data;
  try { data = await transport.get(`${PREFIX}current.json`); }
  catch (error) { throw new SyncError(`Cannot read the current manifest (${error instanceof SyncError ? error.message : 'error'}); nothing uploaded`); }
  if (data === null) return null;
  const manifest = parseManifest(new TextDecoder().decode(data));
  if (manifest) return manifest;
  if (force) return null; // --force (local only) treats an unparseable manifest as missing
  throw new SyncError('The current manifest is invalid; nothing uploaded (a person can re-run locally with --force after checking)');
}
export function dropReasons(previous, stats) {
  if (!previous) return [];
  const out = [];
  const check = (label, before, after) => { if (Number.isFinite(before) && before > 0 && after < before * DROP_FLOOR) out.push(`${label} ${after} < 80% of ${before}`); };
  check('points', previous.points, stats.points);
  check('branches', previous.branches, stats.branches); // no previous per-kind count: only the total check applies
  check('postomats', previous.postomats, stats.postomats);
  return out;
}
async function pool(items, limit, fn) {
  let i = 0, failure = null;
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (!failure && i < items.length) { const item = items[i++]; try { await fn(item); } catch (error) { failure ??= error; } }
  }));
  if (failure) throw failure;
}
export async function upload(transport, snapshot, onPut) {
  const entries = [...snapshot.objects.entries()];
  await pool(entries, UPLOAD_CONCURRENCY, async ([key, data]) => { await transport.put(`${PREFIX}${snapshot.manifest.snapshotId}/${key}`, data); onPut?.(data.length); });
  const manifest = bytes(JSON.stringify(snapshot.manifest));
  await transport.put(`${PREFIX}current.json`, manifest); // written last: this publishes the snapshot
  onPut?.(manifest.length);
  return entries.length + 1;
}
// Delete only snapshot prefixes that are neither the new nor the previous one and at least 10 minutes old.
export async function retain(transport, { newId, previousId, nowMs }) {
  const keys = await transport.list(PREFIX), doomed = [];
  for (const key of keys) {
    const m = SNAPSHOT_KEY.exec(key);
    if (!m || m[1] === newId || m[1] === previousId) continue;
    if (!SNAPSHOT_ID.test(m[1]) || nowMs - snapshotTime(m[1]) < MIN_AGE_MS) continue;
    doomed.push(key);
  }
  await pool(doomed, UPLOAD_CONCURRENCY, key => transport.delete(key));
  return doomed.length;
}

export function parseArgs(argv) {
  const args = { out: null, staging: false, force: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--out') { args.out = argv[++i]; if (!args.out) throw new SyncError('--out needs a directory'); }
    else if (a === '--staging') args.staging = true;
    else if (a === '--force') args.force = true;
    else throw new SyncError(`Unknown argument ${a}`);
  }
  return args;
}

// Returns {summary, snapshot, ...}; throws SyncError (exit 1) without publishing when any safety check fails.
export async function runSync({ args = {}, env = process.env, fetch: fetchImpl = globalThis.fetch, sleep = d => new Promise(r => setTimeout(r, d)), now = () => new Date(), clock = () => performance.now(), transport } = {}) {
  if (args.force && env.GITHUB_ACTIONS === 'true') throw new SyncError('--force is for local runs only');
  const nowDate = now();
  const store = transport ?? selectTransport(env, { ...args, fetch: fetchImpl, now });
  const previous = await readPrevious(store, { force: args.force });
  const ctx = { fetch: fetchImpl, env, sleep, clock };
  const pulled = await pullAll(ctx);
  const buildStart = clock();
  const snapshotId = snapshotIdFor(nowDate);
  if (previous?.snapshotId === snapshotId) throw new SyncError('A snapshot with this ID already exists; retry in a few seconds');
  const snapshot = buildSnapshot(pulled.reduced, snapshotId);
  const buildMs = clock() - buildStart;
  if (snapshot.stats.points === 0) throw new SyncError('Rejected: no points remain after filtering; nothing uploaded');
  const drops = dropReasons(previous, snapshot.stats);
  if (drops.length && !args.force) throw new SyncError(`Rejected: ${drops.join('; ')}; nothing uploaded (verify the drop, then run locally with --force)`);
  const uploadStart = clock();
  let uploadedBytes = 0;
  const objects = await upload(store, snapshot, n => { uploadedBytes += n; });
  const uploadMs = clock() - uploadStart;
  // Without a valid previous manifest the last good snapshot is unknown, so nothing may be deleted.
  const deleted = !previous ? 0 : await retain(store, { newId: snapshotId, previousId: previous?.snapshotId ?? null, nowMs: nowDate.getTime() });
  const { stats } = snapshot;
  const summary = `snapshot=${snapshotId} pages=${pulled.pages} upstreamMB=${mb(pulled.upstreamBytes)} received=${pulled.received} points=${stats.points} branches=${stats.branches} postomats=${stats.postomats} cities=${stats.cities} objects=${objects} uploadedMB=${mb(uploadedBytes)} deleted=${deleted} pullMs=${ms(pulled.ms)} buildMs=${ms(buildMs)} uploadMs=${ms(uploadMs)}${args.force ? ' forced=true' : ''}`;
  return { summary, snapshot, stats, pulled, objects, uploadedBytes, deleted, previous };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const { summary } = await runSync({ args: parseArgs(process.argv.slice(2)) });
    console.log(summary);
  } catch (error) {
    console.error(error instanceof SyncError ? error.message : 'Unexpected sync failure');
    process.exitCode = 1;
  }
}
