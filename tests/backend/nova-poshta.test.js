import test from 'node:test';
import assert from 'node:assert/strict';
import worker from '../../apps/api/src/index.js';
import { handleDelivery, resolvePoint } from '../../apps/api/src/nova-poshta.js';
import { PREFIX, buildSnapshot, reduceRecord } from '../../packages/catalog/delivery.js';
import { KAMIANSKE, KYIV, LVIV, guid, loadSnapshot, r2Stub, record, syntheticUpstream } from '../fixtures/nova-poshta/records.js';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fullSizeReduced } from '../fixtures/nova-poshta/fullsize.js';

const SID = '20261117T003000Z', HOST = 'http://localhost';
const build = records => buildSnapshot(records.map(reduceRecord).filter(Boolean), SID);
const setup = (records = syntheticUpstream(), options) => { const map = new Map(), bucket = r2Stub(map, options), snap = build(records); loadSnapshot(map, snap); return { map, bucket, snap, env: { MEDIA: bucket } }; };
const call = async (env, path, init) => { const r = await worker.fetch(new Request(HOST + path, init), env); const text = await r.text(); return { status: r.status, headers: r.headers, text, json: () => JSON.parse(text) }; };
const throwingDb = new Proxy({}, { get() { throw new Error('D1 must not be touched'); } });
const cityRecords = (names, extra = {}) => names.map((name, i) => record({ Ref: `c${i}-${name}`, CityRef: guid(`nm-${name}`), CityDescription: name, ...extra }));

test('cities: shard by first letter, prefix match, exact first, bigger first, cap 20, apostrophes, empty letter', async () => {
  const { env, bucket } = setup(syntheticUpstream());
  let r = await call(env, '/api/delivery/np/cities?q=%D0%BA'.replace('%D0%BA', encodeURIComponent('ки')));
  assert.equal(r.status, 200);
  assert.deepEqual(r.json(), { generatedAt: '2026-11-17T00:30:00.000Z', items: [{ ref: KYIV, name: 'Київ', area: 'Київська', branches: 5, postomats: 3 }] });
  for (const q of ["Кам'янське", 'Кам’янське', "  кам'янс  ", 'КАМʼ']) { r = await call(env, `/api/delivery/np/cities?q=${encodeURIComponent(q)}`); assert.deepEqual(r.json().items.map(c => c.ref), [KAMIANSKE], q); }
  r = await call(env, `/api/delivery/np/cities?q=${encodeURIComponent('к')}%20`); assert.equal(r.status, 400, 'one character after trim');
  assert.deepEqual((await call(env, `/api/delivery/np/cities?q=${encodeURIComponent('ку')}`)).json().items, []);
  bucket.calls.length = 0;
  r = await call(env, `/api/delivery/np/cities?q=${encodeURIComponent('яя')}`);
  assert.deepEqual(r.json().items, []); assert.equal(r.status, 200);
  assert.ok(!bucket.calls.some(c => c.key.includes('/cities/')), 'an unlisted letter reads no shard');
  // ranking and cap
  const names = ['Кам', ...Array.from({ length: 25 }, (_, i) => `Кам${String(i).padStart(2, '0')}`)];
  const records = [...cityRecords(names), ...Array.from({ length: 5 }, (_, i) => record({ Ref: `extra${i}`, Number: String(i), CityRef: guid('nm-Кам07'), CityDescription: 'Кам07' }))];
  const big = setup(records);
  const items = (await call(big.env, `/api/delivery/np/cities?q=${encodeURIComponent('кам')}`)).json().items;
  assert.equal(items.length, 20);
  assert.equal(items[0].name, 'Кам', 'exact match first');
  assert.equal(items[1].name, 'Кам07', 'then the bigger city');
});

test('warehouses: stored bytes streamed unparsed, empty for an absent city or kind, uppercase cityRef normalized', async () => {
  const { env, snap, bucket } = setup();
  const idx = JSON.parse(new TextDecoder().decode(snap.objects.get(`points/${KYIV[0]}.idx.json`)));
  const [offset, length] = idx[KYIV].postomat, stored = new TextDecoder().decode(snap.objects.get(`points/${KYIV[0]}.json`).subarray(offset, offset + length));
  const parse = JSON.parse, parsed = [];
  JSON.parse = (text, ...rest) => { parsed.push(String(text).slice(0, 40)); return parse(text, ...rest); };
  let r;
  try { r = await call(env, `/api/delivery/np/warehouses?cityRef=${KYIV.toUpperCase()}&kind=postomat`); } finally { JSON.parse = parse; }
  assert.equal(r.status, 200); assert.equal(r.text, stored, 'byte-identical to the stored slice');
  assert.ok(parsed.length > 0 && parsed.every(p => !p.startsWith('{"cityRef"')), 'pack slices (which start with {"cityRef") never go through JSON.parse; manifest and index do');
  assert.equal(bucket.calls.at(-1).opts.range.offset, offset);
  assert.deepEqual(r.json().items.map(p => p.number), ['1001', '1002', '1003']);
  assert.deepEqual(r.json().items[1], { ref: r.json().items[1].ref, number: '1002', name: r.json().items[1].name, lat: null, lon: null });
  for (const [ref, kind] of [[LVIV, 'postomat'], [guid('nobody'), 'branch'], ['__proto__'.padEnd(36, '0'), 'branch']]) {
    const empty = ref.length === 36 && /^[0-9a-f-]+$/.test(ref) ? await call(env, `/api/delivery/np/warehouses?cityRef=${ref}&kind=${kind}`) : null;
    if (empty) assert.deepEqual(empty.json(), { cityRef: ref, kind, generatedAt: '2026-11-17T00:30:00.000Z', items: [] });
  }
  assert.equal((await call(env, `/api/delivery/np/warehouses?cityRef=${LVIV}&kind=branch`)).json().items.length, 1);
});

test('invalid queries are 400; unknown path 404; other methods 405 with Allow; headers; errors are not cacheable', async () => {
  const { env } = setup();
  const bad = ['/api/delivery/np/cities', '/api/delivery/np/cities?q=', '/api/delivery/np/cities?q=a', `/api/delivery/np/cities?q=${'a'.repeat(51)}`, '/api/delivery/np/cities?q=ab&x=1', '/api/delivery/np/cities?q=ab&q=cd', '/api/delivery/np/cities?q=a%00b', '/api/delivery/np/cities?q=%3Cscript%3E', '/api/delivery/np/cities?q=a%2Fb',
    '/api/delivery/np/warehouses', `/api/delivery/np/warehouses?cityRef=${KYIV}`, `/api/delivery/np/warehouses?kind=branch`, `/api/delivery/np/warehouses?cityRef=nope&kind=branch`, `/api/delivery/np/warehouses?cityRef=${KYIV}&kind=store`, `/api/delivery/np/warehouses?cityRef=${KYIV}&kind=branch&extra=1`, `/api/delivery/np/warehouses?cityRef=${KYIV}&cityRef=${LVIV}&kind=branch`, `/api/delivery/np/warehouses?cityRef=${KYIV}&kind=Branch`];
  for (const path of bad) { const r = await call(env, path); assert.equal(r.status, 400, path); assert.deepEqual(r.json(), { error: 'invalid_request' }); assert.equal(r.headers.get('Cache-Control'), 'no-store'); }
  for (const path of ['/api/delivery', '/api/delivery/', '/api/delivery/np', '/api/delivery/np/cities/', '/api/delivery/np/other', '/api/delivery/x/cities?q=ab']) { const r = await call(env, path); assert.equal(r.status, 404, path); assert.deepEqual(r.json(), { error: 'not_found' }); }
  for (const method of ['POST', 'PUT', 'DELETE', 'PATCH', 'HEAD']) { const r = await call(env, '/api/delivery/np/cities?q=ki', { method }); assert.equal(r.status, 405, method); assert.equal(r.headers.get('Allow'), 'GET'); }
  assert.equal((await call(env, '/api/delivery/np/cities?q=%zz')).status, 400, 'malformed percent-encoding is a query error, not a crash');
  const ok = await call(env, `/api/delivery/np/cities?q=${encodeURIComponent('ки')}`);
  assert.equal(ok.headers.get('Cache-Control'), 'public, max-age=300'); assert.equal(ok.headers.get('X-Robots-Tag'), 'noindex');
  assert.equal(ok.headers.get('Content-Type'), 'application/json; charset=utf-8'); assert.equal(ok.headers.get('X-Content-Type-Options'), 'nosniff');
  const w = await call(env, `/api/delivery/np/warehouses?cityRef=${KYIV}&kind=branch`);
  assert.equal(w.headers.get('Cache-Control'), 'public, max-age=300'); assert.equal(w.headers.get('Content-Type'), 'application/json; charset=utf-8'); assert.equal(w.headers.get('X-Robots-Tag'), 'noindex');
  assert.equal((await call(env, '/api/delivery/np/other', { method: 'POST' })).status, 404, 'unknown path wins over method');
  assert.equal((await call(env, '/api/delivery/np/cities?q=a', { method: 'POST' })).status, 405, 'method wins over query');
});

test('delivery routes are dispatched before the recognition load and the D1 check', async () => {
  const { env } = setup();
  for (const DB of [undefined, throwingDb]) {
    const withDb = { ...env, DB, APP_ENV: 'production' };
    assert.equal((await call(withDb, `/api/delivery/np/cities?q=${encodeURIComponent('ки')}`)).status, 200);
    assert.equal((await call(withDb, `/api/delivery/np/warehouses?cityRef=${KYIV}&kind=branch`)).status, 200);
    assert.equal((await call(withDb, '/api/delivery/np/cities?q=a')).status, 400);
    assert.equal((await call(withDb, '/api/delivery/np/cities?q=ab', { method: 'POST', headers: { Origin: 'https://evil.example' } })).status, 405, 'before the global origin check');
  }
  assert.equal((await call({ DB: throwingDb }, '/api/delivery/np/cities?q=ab')).status, 503);
  assert.equal((await call({}, '/api/health')).status, 200);
  const outside = await call({ ...env }, '/api/cart/checkout', { method: 'POST' });
  assert.equal(outside.status, 503, 'other /api paths still need a database');
});

test('503 catalog_unavailable: no binding, no manifest, bad manifest, missing objects, short ranges, failing bucket; nothing leaks', async () => {
  const logged = [], err = console.error; console.error = (...a) => logged.push(a.join(' '));
  try {
    const good = setup(), q = `/api/delivery/np/cities?q=${encodeURIComponent('ки')}`, w = `/api/delivery/np/warehouses?cityRef=${KYIV}&kind=branch`;
    const expect503 = async (env, path, label) => { const r = await call(env, path); assert.equal(r.status, 503, label); assert.deepEqual(r.json(), { error: 'catalog_unavailable' }); assert.equal(r.headers.get('Cache-Control'), 'no-store'); };
    await expect503({}, q, 'no binding'); await expect503({ MEDIA: {} }, w, 'broken binding');
    await expect503({ MEDIA: r2Stub() }, q, 'no manifest');
    const withManifest = manifest => { const s = setup(); s.map.set(`${PREFIX}current.json`, JSON.stringify(manifest)); return s.env; };
    for (const m of [{ ...good.snap.manifest, version: 2 }, { ...good.snap.manifest, snapshotId: '2026-11-17' }, { ...good.snap.manifest, snapshotId: '../x' }, 'not an object']) { await expect503(withManifest(m), q, JSON.stringify(m).slice(0, 30)); await expect503(withManifest(m), w, 'warehouses'); }
    const rawBad = setup(); rawBad.map.set(`${PREFIX}current.json`, '{'); await expect503(rawBad.env, q, 'unparseable manifest');
    const missing = key => { const s = setup(); s.map.delete(`${PREFIX}${SID}/${key}`); return s.env; };
    await expect503(missing('cities/%D0%BA.json'), q, 'listed city shard missing');
    await expect503(missing(`points/${KYIV[0]}.idx.json`), w, 'index missing');
    await expect503(missing(`points/${KYIV[0]}.json`), w, 'pack missing');
    await expect503(setup(undefined, { shortRange: key => key.endsWith(`points/${KYIV[0]}.json`) }).env, w, 'short range');
    await expect503(setup(undefined, { badSize: key => key.endsWith(`points/${KYIV[0]}.json`) }).env, w, 'object smaller than the range');
    await expect503(setup(undefined, { failGet: () => true }).env, q, 'bucket error');
    const badIdx = setup(); badIdx.map.set(`${PREFIX}${SID}/points/${KYIV[0]}.idx.json`, JSON.stringify({ [KYIV]: { branch: [0, -1] } })); await expect503(badIdx.env, w, 'invalid range in index');
    const badShard = setup(); badShard.map.set(`${PREFIX}${SID}/cities/%D0%BA.json`, '{"not":"an array"}'); await expect503(badShard.env, q, 'invalid shard');
    assert.ok(logged.length > 0 && logged.every(line => /catalog_unavailable/.test(line) && !line.includes(KYIV) && !line.includes('%D0')), 'logs name only the error class');
  } finally { console.error = err; }
});

test('__proto__ and constructor never match as city refs or point refs', async () => {
  const { env } = setup();
  assert.equal((await call(env, `/api/delivery/np/cities?q=${encodeURIComponent('__proto__')}`)).status, 400);
  assert.equal(await resolvePoint(env, '__proto__'), null); assert.equal(await resolvePoint(env, 'constructor'), null);
  const proto = setup(); proto.map.set(`${PREFIX}${SID}/points/0.idx.json`, '{}');
  const ref = '0'.repeat(8) + '-0000-0000-0000-000000000000';
  assert.deepEqual((await call(proto.env, `/api/delivery/np/warehouses?cityRef=${ref}&kind=branch`)).json().items, []);
  // a prototype-named key in the shard JSON must not resolve through the prototype chain either
  const hostile = setup(); hostile.map.set(`${PREFIX}${SID}/refs/00.json`, '{}');
  assert.equal(await resolvePoint(hostile.env, ref), null);
  const withProto = setup(); withProto.map.set(`${PREFIX}${SID}/points/0.idx.json`, '{"__proto__":{"branch":[0,5]}}');
  assert.deepEqual((await call(withProto.env, `/api/delivery/np/warehouses?cityRef=${ref}&kind=branch`)).json().items, []);
});

test('resolvePoint: shard lookup, snapshot copy, unavailable errors; manifest cached for 60 s per bucket and failures never cached', async () => {
  const { env, bucket, snap } = setup();
  const ref = JSON.parse(new TextDecoder().decode([...snap.objects].find(([k, v]) => k.startsWith('refs/') && v.length > 2)[1]));
  const [wref, expected] = Object.entries(ref)[0];
  assert.deepEqual(await resolvePoint(env, wref.toUpperCase()), { cityRef: expected.cityRef, cityName: expected.cityName, kind: expected.kind, number: expected.number, name: expected.name });
  assert.equal(await resolvePoint(env, guid('missing')), null); assert.equal(await resolvePoint(env, 'not-a-guid'), null); assert.equal(await resolvePoint(env, undefined), null);
  await assert.rejects(resolvePoint({}, wref), { message: 'catalog_unavailable' });
  const missingShard = setup(); missingShard.map.delete(`${PREFIX}${SID}/refs/${wref.slice(0, 2)}.json`);
  await assert.rejects(resolvePoint(missingShard.env, wref), { message: 'catalog_unavailable' });
  // cache with an injected clock
  const clock = { t: 1000 }, fresh = setup(), request = () => new Request(`${HOST}/api/delivery/np/cities?q=${encodeURIComponent('ки')}`), opts = { now: () => clock.t };
  const manifestReads = () => fresh.bucket.calls.filter(c => c.key === `${PREFIX}current.json`).length;
  await handleDelivery(request(), fresh.env, opts); await handleDelivery(request(), fresh.env, opts); assert.equal(manifestReads(), 1);
  clock.t += 59999; await handleDelivery(request(), fresh.env, opts); assert.equal(manifestReads(), 1);
  clock.t += 2; await handleDelivery(request(), fresh.env, opts); assert.equal(manifestReads(), 2);
  const other = setup(); await handleDelivery(request(), other.env, opts); assert.equal(other.bucket.calls.filter(c => c.key === `${PREFIX}current.json`).length, 1, 'separate bucket, separate cache');
  const flaky = setup(); let down = true; flaky.bucket.get = (orig => async (k, o) => { if (down) throw new Error('down'); return orig(k, o); })(flaky.bucket.get);
  assert.equal((await handleDelivery(request(), flaky.env, opts)).status, 503); down = false;
  assert.equal((await handleDelivery(request(), flaky.env, opts)).status, 200, 'a failed read is not cached');
  // NP_CATALOG takes precedence over MEDIA
  const dedicated = setup(), decoy = r2Stub();
  assert.equal((await call({ MEDIA: decoy, NP_CATALOG: dedicated.bucket }, `/api/delivery/np/cities?q=${encodeURIComponent('ки')}`)).status, 200);
});

test('/media/ never serves np-catalog keys, even with a privileged credential', async () => {
  const { env, map } = setup();
  map.set('np-catalog/v1/current.json', '{"x":1}');
  for (const path of ['/media/np-catalog/v1/current.json', '/media/np-catalog%2Fv1%2Fcurrent.json', `/media/np-catalog/v1/${SID}/cities/%25D0%25BA.json`]) {
    for (const extra of [{}, { APP_ENV: 'development', AUTH_DEV_BYPASS: 'true' }]) {
      const r = await call({ ...env, ...extra }, path); assert.equal(r.status, 404, path); assert.ok(!r.text.includes('"x":1'));
    }
  }
});

test('full-size layout: cities, resolvePoint and warehouses stay within the Workers Free CPU budget (cold and warm manifest cache)', async () => {
  // NP_SNAPSHOT_DIR points at a real `--out` layout (the live QA snapshot); without it a deterministic synthetic full-size layout is built.
  const map = new Map(), dir = process.env.NP_SNAPSHOT_DIR, bucket = r2Stub(map);
  let kyivRef, firstRef, expectedKyiv;
  if (dir) {
    const walk = d => readdirSync(d, { withFileTypes: true }).flatMap(e => (e.isDirectory() ? walk(join(d, e.name)) : [join(d, e.name)]));
    for (const file of walk(dir)) map.set(file.slice(dir.length + 1), new Uint8Array(readFileSync(file)));
    const manifest = JSON.parse(new TextDecoder().decode(map.get(`${PREFIX}current.json`)));
    kyivRef = '8d5a980d-391c-11dd-90d9-001a92567626'; expectedKyiv = null;
    firstRef = Object.keys(JSON.parse(new TextDecoder().decode(map.get(`${PREFIX}${manifest.snapshotId}/refs/80.json`))))[0];
  } else {
    const reduced = fullSizeReduced(), snap = buildSnapshot(reduced, SID);
    loadSnapshot(map, snap); kyivRef = reduced[0].cityRef; firstRef = reduced[0].point.ref; expectedKyiv = 7423;
  }
  const env = { MEDIA: bucket };
  const time = async (fn, runs = 30) => { const samples = []; for (let i = 0; i < runs; i++) { const t0 = process.hrtime.bigint(); await fn(); samples.push(Number(process.hrtime.bigint() - t0) / 1e6); } samples.sort((a, b) => a - b); return { median: samples[runs >> 1], max: samples.at(-1) }; };
  // CPU excluding I/O: the stub returns pre-decoded text for JSON objects and an empty stream for the ranged pack read
  // (the Worker streams it without reading it), so object copying and decoding by the stub are not counted.
  const texts = new Map();
  const timing = () => ({ calls: [], async get(key, opts) {
    if (!map.has(key)) return null;
    if (opts?.range) return { size: opts.range.offset + opts.range.length, range: { offset: opts.range.offset, length: opts.range.length }, body: new Response('').body, text: async () => '' };
    if (!texts.has(key)) texts.set(key, typeof map.get(key) === 'string' ? map.get(key) : new TextDecoder().decode(map.get(key)));
    return { size: 0, body: null, text: async () => texts.get(key) };
  } });
  const fast = timing();
  const ok200 = async promise => assert.equal((await promise).status, 200, 'the timed path is the 200 path, not an error path');
  const run = path => () => ok200(worker.fetch(new Request(HOST + path), { MEDIA: fast }));
  const results = {};
  results.citiesCold = await time(() => ok200(worker.fetch(new Request(`${HOST}/api/delivery/np/cities?q=${encodeURIComponent('к')}%D0%B0`), { MEDIA: timing() })));
  results.citiesWarm = await time(run(`/api/delivery/np/cities?q=${encodeURIComponent('ка')}`));
  results.warehousesCold = await time(() => ok200(worker.fetch(new Request(`${HOST}/api/delivery/np/warehouses?cityRef=${kyivRef}&kind=postomat`), { MEDIA: timing() })));
  results.warehousesWarm = await time(run(`/api/delivery/np/warehouses?cityRef=${kyivRef}&kind=postomat`));
  results.resolveCold = await time(() => resolvePoint({ MEDIA: timing() }, firstRef));
  results.resolveWarm = await time(() => resolvePoint({ MEDIA: fast }, firstRef));
  console.log('np-cpu-ms', JSON.stringify(results, (k, v) => (typeof v === 'number' ? Math.round(v * 1000) / 1000 : v)));
  const kyiv = await worker.fetch(new Request(`${HOST}/api/delivery/np/warehouses?cityRef=${kyivRef}&kind=postomat`), { MEDIA: bucket });
  const kyivItems = JSON.parse(await kyiv.text()).items.length;
  assert.ok(expectedKyiv ? kyivItems === expectedKyiv : kyivItems > 1000, `Kyiv postomats: ${kyivItems}`);
  for (const key of ['citiesCold', 'citiesWarm', 'resolveCold', 'resolveWarm']) assert.ok(results[key].median < 2 * 5, `${key} median ${results[key].median} ms (2 ms budget, 5x slack for shared CI)`);
  for (const key of ['warehousesCold', 'warehousesWarm']) assert.ok(results[key].median < 1 * 5, `${key} median ${results[key].median} ms (1 ms budget, 5x slack)`);
});
