import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash, createHmac } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { PREFIX, bytes, buildSnapshot, cityShardKey, classify, encodeKeyPath, normalizeCoordinates, normalizeText, reduceRecord } from '../../packages/catalog/delivery.js';
import { ENDPOINT, SyncError, canonicalQuery, createMemoryTransport, createRestTransport, createS3Transport, STAGING_BUCKET, parseArgs, parseListXml, runSync, selectTransport, signV4 } from '../../tools/np-catalog-sync.mjs';
import { STAGING_R2_BUCKET_NAME, STAGING_NP_CATALOG_BUCKET_NAME } from '../../tools/cloudflare-config.mjs';
import { KYIV, guid, record, syntheticUpstream, upstreamFetch } from '../fixtures/nova-poshta/records.js';

const NOW = new Date('2026-11-17T00:30:00Z');
const NEW_ID = '20261117T003000Z', PREV_ID = '20261116T003000Z', OLD_ID = '20261110T003000Z';
const noSleep = () => Promise.resolve();
const sync = (over = {}) => runSync({ args: {}, env: {}, sleep: noSleep, now: () => NOW, ...over });
const rejects = (promise, pattern) => assert.rejects(promise, error => { assert.ok(error instanceof SyncError, String(error)); if (pattern) assert.match(error.message, pattern); return true; });
const seedManifest = (map, over = {}, id = PREV_ID) => map.set(`${PREFIX}current.json`, bytes(JSON.stringify({ version: 1, snapshotId: id, generatedAt: '2026-11-16T00:30:00.000Z', points: 12, cities: 4, branches: 8, postomats: 4, cityLetters: [], source: 's', ...over })));
const many = (count, category = 'Branch', cityRef = KYIV, start = 0) => Array.from({ length: count }, (_, i) => record({ Ref: `m${start + i}`, Number: String(start + i + 1), CategoryOfWarehouse: category, CityRef: cityRef }));

test('allowlist, status, DenyToSelect, dedupe, text, number and coordinate normalization', () => {
  const kinds = Object.fromEntries(['Branch', 'Store', 'Postomat', 'DropOff', 'Fulfillment', 'OtherOperating', 'Mystery', undefined].map(c => [String(c), classify({ CategoryOfWarehouse: c })]));
  assert.deepEqual(kinds, { Branch: 'branch', Store: 'branch', Postomat: 'postomat', DropOff: null, Fulfillment: null, OtherOperating: null, Mystery: null, undefined: null });
  assert.equal(reduceRecord(record({ WarehouseStatus: 'NotWorking' })), null);
  assert.equal(reduceRecord(record({ DenyToSelect: '1' })), null);
  assert.equal(reduceRecord(record({ rawRef: 'nope' })), null);
  assert.equal(reduceRecord(record({ CityRef: 'nope' })), null);
  assert.equal(normalizeText("  Кам'янське​ \t\n  ‘тест’ "), 'Камʼянське ʼтестʼ');
  assert.equal(normalizeText('é'), 'é');
  const r = reduceRecord(record({ Number: '12345678', Description: 'x'.repeat(300), Latitude: '50.123456789', Longitude: '30.1' }));
  assert.equal(r.point.number, null);
  assert.equal([...r.point.name].length, 200);
  assert.deepEqual([r.point.lat, r.point.lon], [50.12346, 30.1]);
  for (const [lat, lon] of [['0', '30'], ['50', '0'], ['43.9', '30'], ['53.1', '30'], ['50', '21.9'], ['50', '41.1'], ['x', '30'], [undefined, undefined]]) assert.deepEqual(normalizeCoordinates(lat, lon), { lat: null, lon: null }, `${lat},${lon}`);
  assert.equal(reduceRecord(record({ Number: '007' })).point.number, '007');
  assert.equal(classify(record({ CategoryOfWarehouse: 'Postomat', TypeOfWarehouse: 'Branch type' })), 'postomat');
});

test('snapshot layout: every pack range parses to its slice, ref shards match, ordering, empty objects, cityLetters', () => {
  const reduced = syntheticUpstream().map(reduceRecord).filter(Boolean);
  const snap = buildSnapshot(reduced, NEW_ID), get = key => snap.objects.get(key);
  const text = key => new TextDecoder().decode(get(key));
  assert.deepEqual(snap.manifest, { version: 1, snapshotId: NEW_ID, generatedAt: '2026-11-17T00:30:00.000Z', points: 12, cities: 4, branches: 8, postomats: 4, cityLetters: ['к', 'л', 'м'], source: 'api.novaposhta.ua/v2.0 Address.getWarehouses' });
  for (let i = 0; i < 16; i++) { assert.ok(get(`points/${i.toString(16)}.json`) instanceof Uint8Array); assert.equal(typeof JSON.parse(text(`points/${i.toString(16)}.idx.json`)), 'object'); }
  for (let i = 0; i < 256; i++) assert.ok(get(`refs/${i.toString(16).padStart(2, '0')}.json`));
  assert.ok([...snap.objects.keys()].some(k => k.startsWith('points/') && get(k).length === 0), 'an empty pack is still written');
  assert.deepEqual([...snap.objects.keys()].filter(k => k.startsWith('cities/')).sort(), snap.manifest.cityLetters.map(l => `cities/${cityShardKey(l)}.json`).sort());
  assert.ok(snap.objects.has('cities/%D0%BA.json'), 'the shard key keeps a literal percent');
  let slices = 0;
  for (let i = 0; i < 16; i++) {
    const pack = get(`points/${i.toString(16)}.json`), index = JSON.parse(text(`points/${i.toString(16)}.idx.json`));
    let covered = 0;
    for (const [cityRef, kinds] of Object.entries(index)) for (const [kind, [offset, length]] of Object.entries(kinds)) {
      const slice = JSON.parse(new TextDecoder().decode(pack.subarray(offset, offset + length)));
      assert.equal(slice.cityRef, cityRef); assert.equal(slice.kind, kind); assert.equal(slice.generatedAt, snap.manifest.generatedAt);
      assert.equal(parseInt(cityRef[0], 16), i);
      for (const point of slice.items) assert.deepEqual(JSON.parse(text(`refs/${point.ref.slice(0, 2)}.json`))[point.ref], { cityRef, cityName: reduced.find(r => r.point.ref === point.ref).cityName, kind, number: point.number, name: point.name });
      covered += length; slices++;
    }
    assert.equal(covered, pack.length, 'slices tile the pack exactly');
  }
  assert.equal(slices, 6);
  const [kOffset, kLength] = JSON.parse(text(`points/${KYIV[0]}.idx.json`))[KYIV].branch;
  const kyiv = JSON.parse(new TextDecoder().decode(get(`points/${KYIV[0]}.json`).subarray(kOffset, kOffset + kLength)));
  assert.deepEqual(kyiv.items.map(p => p.number), ['2', '2', '5', '10', null], 'numeric order, null last, ref tiebreak');
  assert.ok(kyiv.items[0].ref < kyiv.items[1].ref);
  const shard = JSON.parse(text('cities/%D0%BA.json'));
  assert.deepEqual(shard.map(c => c.name), ['Київ', 'Камʼянське'], 'bigger city first; both apostrophes fold to U+02BC');
  const refShards = [...snap.objects.entries()].filter(([k]) => k.startsWith('refs/')).flatMap(([, v]) => Object.keys(JSON.parse(new TextDecoder().decode(v))));
  assert.equal(refShards.length, 12);
});

test('keyless pull body, keyed body, paging with at most two in flight, endpoint and no redirects', async () => {
  const records = many(1700);
  const keyless = upstreamFetch(records), memory = createMemoryTransport();
  const result = await sync({ fetch: keyless, transport: memory });
  assert.equal(keyless.state.calls.length, 4);
  for (const call of keyless.state.calls) {
    assert.equal(call.url, ENDPOINT); assert.equal(call.init.redirect, 'manual'); assert.ok(!('apiKey' in call.body), 'keyless body has no apiKey key');
    assert.deepEqual(call.body, { modelName: 'Address', calledMethod: 'getWarehouses', methodProperties: { Limit: '500', Page: String(call.body.methodProperties.Page), Language: 'UA' } });
  }
  assert.deepEqual(keyless.state.calls.map(c => c.body.methodProperties.Page).sort(), ['1', '2', '3', '4']);
  assert.equal(keyless.state.calls[0].body.methodProperties.Page, '1', 'page 1 first, for totalCount');
  assert.equal(keyless.state.maxInFlight, 2);
  assert.equal(result.stats.points, 1700); assert.equal(result.pulled.pages, 4);
  const keyed = upstreamFetch(many(10));
  await sync({ fetch: keyed, transport: createMemoryTransport(), env: { NOVA_POSHTA_API_KEY: 'sekret-np-key' } });
  assert.equal(keyed.state.calls[0].body.apiKey, 'sekret-np-key');
});

test('retries with backoff, then aborts without publishing on a failed page, short pull, bad body and zero points', async () => {
  const sleeps = [], sleep = d => { sleeps.push(d); return Promise.resolve(); };
  const memory = createMemoryTransport();
  await sync({ fetch: upstreamFetch(many(1100), { failPage: (p, a) => (p === 2 && a < 3 ? (a === 1 ? 503 : 'throw') : null) }), transport: memory, sleep });
  assert.deepEqual(sleeps, [500, 1000]); assert.ok(memory.map.has(`${PREFIX}current.json`));
  const cases = [
    ['a page failing every attempt', upstreamFetch(many(1100), { failPage: p => (p === 3 ? 500 : null) }), /Page 3 failed after 3 attempts/],
    ['success:false', upstreamFetch(many(10), { success: false }), /Page 1 failed/],
    ['missing data array', upstreamFetch(many(10), { noData: true }), /Page 1 failed/],
    ['fewer records than totalCount', upstreamFetch(many(1100), { totalCount: 1700 }), /Incomplete pull: received 1100 of 1700/],
  ];
  for (const [name, fetch, pattern] of cases) {
    const m = createMemoryTransport();
    await rejects(sync({ fetch, transport: m, sleep: noSleep }), pattern);
    assert.equal(m.log.filter(e => e[0] !== 'get').length, 0, `${name}: nothing uploaded or deleted`);
  }
  const redirected = createMemoryTransport();
  await rejects(sync({ fetch: async () => new Response(null, { status: 303, headers: { location: 'https://evil.example/x' } }), transport: redirected }), /HTTP 303/);
  const zero = createMemoryTransport();
  await rejects(sync({ fetch: upstreamFetch([record({ CategoryOfWarehouse: 'DropOff' }), record({ DenyToSelect: '1', Ref: 'z' })]), transport: zero }), /no points remain/);
  assert.equal(zero.log.filter(e => e[0] === 'put').length, 0);
  // Upstream totalCount slightly above what the full pages return (observed live): accepted within TOTAL_SLACK.
  const slack = await sync({ fetch: upstreamFetch(many(1100), { totalCount: 1102 }), transport: createMemoryTransport() });
  assert.equal(slack.stats.points, 1100);
  // Beyond the slack, or with a short page before the last, it still aborts.
  await rejects(sync({ fetch: upstreamFetch(many(1100), { totalCount: 1111 }), transport: createMemoryTransport(), sleep: noSleep }), /Incomplete pull: received 1100 of 1111/);
  // Same live shape with an empty last page is accepted too.
  assert.equal((await sync({ fetch: upstreamFetch(many(1000), { totalCount: 1005 }), transport: createMemoryTransport() })).stats.points, 1000);
  // A page before the last that comes back short means records went missing mid-list: abort even within the slack.
  const base = upstreamFetch(many(1100), { totalCount: 1102 });
  const shortMiddle = async (url, init) => {
    const response = await base(url, init);
    if (JSON.parse(init.body).methodProperties.Page !== '1') return response;
    const json = await response.json(); json.data = json.data.slice(1);
    return new Response(JSON.stringify(json), { status: 200, headers: { 'Content-Type': 'application/json' } });
  };
  await rejects(sync({ fetch: shortMiddle, transport: createMemoryTransport(), sleep: noSleep }), /Incomplete pull: received 1099 of 1102/);
  // totalCount is compared with raw received records, so filtering never makes a complete pull look incomplete.
  const filtered = await sync({ fetch: upstreamFetch([...many(3), ...many(5, 'DropOff', KYIV, 100)]), transport: createMemoryTransport() });
  assert.equal(filtered.stats.points, 3);
});

test('manifest pre-read: 404 is a first run; read errors and invalid manifests abort; 80% rules; --force', async () => {
  const feed = () => upstreamFetch([...many(10), ...many(10, 'Postomat', KYIV, 50)]);
  const first = createMemoryTransport();
  const r = await sync({ fetch: feed(), transport: first });
  assert.equal(r.previous, null);
  // read error: abort, nothing uploaded
  const broken = createMemoryTransport(new Map(), { failGet: () => true });
  await rejects(sync({ fetch: feed(), transport: broken }), /Cannot read the current manifest/);
  assert.equal(broken.log.filter(e => e[0] === 'put').length, 0);
  for (const bad of ['{', '[]', JSON.stringify({ version: 2, snapshotId: PREV_ID, cityLetters: [] }), JSON.stringify({ version: 1, snapshotId: 'x', cityLetters: [] }), ...[undefined, -1, 1.5, '12', null].map(points => JSON.stringify({ version: 1, snapshotId: PREV_ID, cityLetters: [], points }))]) {
    const m = createMemoryTransport(new Map([[`${PREFIX}current.json`, bytes(bad)]]));
    await rejects(sync({ fetch: feed(), transport: m }), /manifest is invalid/);
    assert.equal(m.log.filter(e => e[0] === 'put').length, 0);
  }
  // total drop below 80%
  const drop = new Map(); seedManifest(drop, { points: 26, branches: 13, postomats: 13 });
  await rejects(sync({ fetch: feed(), transport: createMemoryTransport(drop) }), /points 20 < 80% of 26/);
  // exactly 80% passes
  const edge = new Map(); seedManifest(edge, { points: 25, branches: 12, postomats: 12 });
  await sync({ fetch: feed(), transport: createMemoryTransport(edge) });
  // per-kind drop although the total holds
  const kind = new Map(); seedManifest(kind, { points: 20, branches: 5, postomats: 15 });
  const kindFeed = upstreamFetch([...many(15), ...many(5, 'Postomat', KYIV, 50)]);
  await rejects(sync({ fetch: kindFeed, transport: createMemoryTransport(kind) }), /postomats 5 < 80% of 15/);
  // previous manifest without per-kind counts: only the total applies
  const legacy = new Map(); seedManifest(legacy, { points: 20, branches: undefined, postomats: undefined });
  await sync({ fetch: upstreamFetch([...many(2), ...many(18, 'Postomat', KYIV, 50)]), transport: createMemoryTransport(legacy) });
  // --force skips only the 80% checks
  const forced = new Map(); seedManifest(forced, { points: 260, branches: 130, postomats: 130 });
  const out = await sync({ fetch: feed(), transport: createMemoryTransport(forced), args: { force: true } });
  assert.match(out.summary, /forced=true/);
  const forcedBroken = createMemoryTransport(new Map(), { failGet: () => true });
  await rejects(sync({ fetch: feed(), transport: forcedBroken, args: { force: true } }), /Cannot read/);
  await rejects(sync({ fetch: upstreamFetch([record({ CategoryOfWarehouse: 'DropOff' })]), transport: createMemoryTransport(), args: { force: true } }), /no points remain/);
  // --force also treats an unparseable manifest as missing, locally only
  const garbled = createMemoryTransport(new Map([[`${PREFIX}current.json`, bytes('not json')]]));
  const recovered = await sync({ fetch: feed(), transport: garbled, args: { force: true } });
  assert.equal(recovered.previous, null);
  // ...but with no valid previous manifest nothing is deleted, so the last good snapshot survives
  const lastGood = new Map([[`${PREFIX}current.json`, bytes('not json')], [`${PREFIX}${OLD_ID}/points/0.json`, bytes('last good')]]);
  const guarded = createMemoryTransport(lastGood);
  await sync({ fetch: feed(), transport: guarded, args: { force: true } });
  assert.ok(lastGood.has(`${PREFIX}${OLD_ID}/points/0.json`)); assert.equal(guarded.log.filter(e => e[0] === 'delete').length, 0);
  await rejects(sync({ fetch: feed(), transport: createMemoryTransport(), args: { force: true }, env: { GITHUB_ACTIONS: 'true' } }), /local runs only/);
});

test('upload order, at most four in flight, all fixed objects even when empty, cityLetters match', async () => {
  let inFlight = 0, max = 0;
  const log = [], map = new Map();
  const transport = { ...createMemoryTransport(map, { log }), async put(key, data) { log.push(['put', key]); inFlight++; max = Math.max(max, inFlight); await new Promise(r => setTimeout(r, 1)); inFlight--; map.set(key, data); } };
  await sync({ fetch: upstreamFetch(syntheticUpstream()), transport });
  const puts = log.filter(e => e[0] === 'put').map(e => e[1]);
  assert.equal(puts.at(-1), `${PREFIX}current.json`); assert.equal(puts.filter(k => k === `${PREFIX}current.json`).length, 1);
  assert.ok(puts.slice(0, -1).every(k => k.startsWith(`${PREFIX}${NEW_ID}/`)));
  assert.equal(max, 4);
  assert.equal(puts.filter(k => /\/points\/[0-9a-f]\.json$/.test(k)).length, 16);
  assert.equal(puts.filter(k => /\/points\/[0-9a-f]\.idx\.json$/.test(k)).length, 16);
  assert.equal(puts.filter(k => /\/refs\/[0-9a-f]{2}\.json$/.test(k)).length, 256);
  const manifest = JSON.parse(new TextDecoder().decode(map.get(`${PREFIX}current.json`)));
  assert.deepEqual(puts.filter(k => k.includes('/cities/')).map(k => k.split('/cities/')[1]).sort(), manifest.cityLetters.map(l => `${cityShardKey(l)}.json`).sort());
  const failing = createMemoryTransport(new Map(), { failPut: key => key.includes('/refs/80.json') });
  await rejects(sync({ fetch: upstreamFetch(syntheticUpstream()), transport: failing }), /upload failed/);
  assert.ok(!failing.map.has(`${PREFIX}current.json`), 'current.json is never written after a failed upload');
});

test('retention: only old, non-matching-free snapshot prefixes are deleted; young orphans, photos and the previous snapshot survive', async () => {
  const photo = `${guid('p1')}.jpg`, png = `${guid('p2')}.png`;
  const orphanId = '20261116T120000Z', youngId = '20261117T002500Z'; // 5 minutes before NOW
  const seed = () => {
    const map = new Map([[photo, bytes('jpg')], [png, bytes('png')], [`${PREFIX}notes.txt`, bytes('keep')], [`${PREFIX}${PREV_ID}x/odd.json`, bytes('keep')], ['np-catalog/v2/current.json', bytes('{}')]]);
    seedManifest(map);
    for (const id of [PREV_ID, OLD_ID, orphanId, youngId]) map.set(`${PREFIX}${id}/points/0.json`, bytes(id));
    return map;
  };
  const map = seed(), transport = createMemoryTransport(map);
  const out = await sync({ fetch: upstreamFetch(syntheticUpstream()), transport });
  const keys = [...map.keys()];
  assert.ok(!keys.some(k => k.startsWith(`${PREFIX}${OLD_ID}/`)), 'older snapshot gone');
  assert.ok(!keys.some(k => k.startsWith(`${PREFIX}${orphanId}/`)), 'old orphan gone');
  for (const survivor of [photo, png, `${PREFIX}current.json`, `${PREFIX}notes.txt`, `${PREFIX}${PREV_ID}x/odd.json`, 'np-catalog/v2/current.json', `${PREFIX}${PREV_ID}/points/0.json`, `${PREFIX}${youngId}/points/0.json`, `${PREFIX}${NEW_ID}/points/0.json`]) assert.ok(map.has(survivor), survivor);
  assert.equal(out.deleted, 2);
  assert.ok(transport.log.filter(e => e[0] === 'delete').every(e => e[1].startsWith(`${PREFIX}${OLD_ID}/`) || e[1].startsWith(`${PREFIX}${orphanId}/`)));
  // previous comes from the manifest, never from listing order: a lexically newer orphan cannot displace it
  const m2 = seed(); m2.set(`${PREFIX}20261116T230000Z/points/0.json`, bytes('newer orphan'));
  await sync({ fetch: upstreamFetch(syntheticUpstream()), transport: createMemoryTransport(m2) });
  assert.ok(m2.has(`${PREFIX}${PREV_ID}/points/0.json`) && !m2.has(`${PREFIX}20261116T230000Z/points/0.json`));
  // nothing is deleted when publishing fails
  const m3 = seed(), failing = createMemoryTransport(m3, { failPut: key => key.endsWith('current.json') });
  await rejects(sync({ fetch: upstreamFetch(syntheticUpstream()), transport: failing }), /upload failed/);
  assert.equal(failing.log.filter(e => e[0] === 'delete').length, 0);
  assert.ok(m3.has(`${PREFIX}${OLD_ID}/points/0.json`));
});

// ---- transports ---------------------------------------------------------------------------------
const hex = data => createHash('sha256').update(data).digest('hex');
test('SigV4 matches the published AWS test-suite vector (get-vanilla)', () => {
  const { signature, canonicalRequest, headers } = signV4({ method: 'GET', host: 'example.amazonaws.com', path: '/', payloadHash: hex(''), accessKeyId: 'AKIDEXAMPLE', secretAccessKey: 'wJalrXUtnFEMI/K7MDENG+bPxRfiCYEXAMPLEKEY', region: 'us-east-1', service: 'service', amzDate: '20150830T123600Z', includeContentSha: false });
  assert.equal(canonicalRequest, ['GET', '/', '', 'host:example.amazonaws.com\nx-amz-date:20150830T123600Z\n', 'host;x-amz-date', 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855'].join('\n'));
  assert.equal(signature, '5fa00fa31553b73ebf1942676e86291e8372ff2a2260956d9b8aae1d763fbf31');
  assert.equal(headers.authorization, 'AWS4-HMAC-SHA256 Credential=AKIDEXAMPLE/20150830/us-east-1/service/aws4_request, SignedHeaders=host;x-amz-date, Signature=5fa00fa31553b73ebf1942676e86291e8372ff2a2260956d9b8aae1d763fbf31');
});

test('SigV4 for R2: region auto, service s3, path-style, literal canonical request, independent HMAC chain, Cyrillic shard key', () => {
  const key = `${PREFIX}${NEW_ID}/cities/${cityShardKey('к')}.json`; // contains a literal %D0%BA
  assert.ok(key.endsWith('/cities/%D0%BA.json'));
  const path = `/media/${encodeKeyPath(key)}`;
  assert.equal(path, '/media/np-catalog/v1/20261117T003000Z/cities/%25D0%25BA.json');
  const body = bytes('[]'), payloadHash = hex(body), amzDate = '20261117T003000Z';
  const { canonicalRequest, signature, headers } = signV4({ method: 'PUT', host: 'acct123.r2.cloudflarestorage.com', path, headers: { 'content-type': 'application/json; charset=utf-8' }, payloadHash, accessKeyId: 'AKIAEXAMPLE', secretAccessKey: 'secret-key-for-test', amzDate });
  const expected = `PUT\n/media/np-catalog/v1/20261117T003000Z/cities/%25D0%25BA.json\n\ncontent-type:application/json; charset=utf-8\nhost:acct123.r2.cloudflarestorage.com\nx-amz-content-sha256:${payloadHash}\nx-amz-date:20261117T003000Z\n\ncontent-type;host;x-amz-content-sha256;x-amz-date\n${payloadHash}`;
  assert.equal(canonicalRequest, expected);
  const h = (k, d) => createHmac('sha256', k).update(d).digest();
  const stringToSign = `AWS4-HMAC-SHA256\n20261117T003000Z\n20261117/auto/s3/aws4_request\n${hex(expected)}`;
  const k = h(h(h(h('AWS4secret-key-for-test', '20261117'), 'auto'), 's3'), 'aws4_request');
  assert.equal(signature, createHmac('sha256', k).update(stringToSign).digest('hex'));
  assert.match(headers.authorization, /^AWS4-HMAC-SHA256 Credential=AKIAEXAMPLE\/20261117\/auto\/s3\/aws4_request, SignedHeaders=content-type;host;x-amz-content-sha256;x-amz-date, Signature=[0-9a-f]{64}$/);
  assert.equal(canonicalQuery({ prefix: 'np-catalog/v1/', 'list-type': 2, 'continuation-token': "a+b/c='" }), "continuation-token=a%2Bb%2Fc%3D%27&list-type=2&prefix=np-catalog%2Fv1%2F");
  assert.equal(encodeKeyPath("a/b!*'()c"), 'a/b%21%2A%27%28%29c');
});

test('S3 transport: signed path-style requests, double-encoded shard key, ListObjectsV2 XML pages, 404 reads', async () => {
  const calls = [];
  const fetch = async (url, init) => {
    calls.push({ url, init });
    const u = new URL(url);
    if (init.method === 'GET' && u.searchParams.get('list-type') === '2') {
      const token = u.searchParams.get('continuation-token');
      return new Response(token ? '<ListBucketResult><IsTruncated>false</IsTruncated><Contents><Key>np-catalog/v1/b&amp;c.json</Key></Contents></ListBucketResult>'
        : '<ListBucketResult><IsTruncated>true</IsTruncated><NextContinuationToken>tok+/=</NextContinuationToken><Contents><Key>np-catalog/v1/a.json</Key><Size>1</Size></Contents><Contents><Key>np-catalog/v1/%D0%BA.json</Key></Contents></ListBucketResult>');
    }
    return new Response(init.method === 'GET' ? null : '', { status: init.method === 'GET' ? 404 : 200 });
  };
  const t = createS3Transport({ accountId: 'acct123', bucket: 'media', accessKeyId: 'AKIAEXAMPLE', secretAccessKey: 'secret-key-for-test', fetch, now: () => NOW });
  await t.put(`${PREFIX}${NEW_ID}/cities/%D0%BA.json`, bytes('[]'));
  assert.equal(calls[0].url, 'https://acct123.r2.cloudflarestorage.com/media/np-catalog/v1/20261117T003000Z/cities/%25D0%25BA.json');
  assert.equal(calls[0].init.redirect, 'manual');
  assert.equal(calls[0].init.headers['x-amz-content-sha256'], hex('[]'));
  assert.equal(calls[0].init.headers['content-type'], 'application/json; charset=utf-8');
  assert.ok(!('host' in calls[0].init.headers));
  assert.equal(await t.get(`${PREFIX}current.json`), null);
  assert.deepEqual(await t.list(PREFIX), ['np-catalog/v1/a.json', 'np-catalog/v1/%D0%BA.json', 'np-catalog/v1/b&c.json']);
  const listCalls = calls.filter(c => c.url.includes('list-type'));
  assert.equal(listCalls.length, 2);
  assert.match(listCalls[1].url, /continuation-token=tok%2B%2F%3D/);
  await t.delete(`${PREFIX}x.json`);
  assert.deepEqual(parseListXml('<IsTruncated>false</IsTruncated>'), { keys: [], truncated: false, next: null });
  const failing = createS3Transport({ accountId: 'acct123', bucket: 'media', accessKeyId: 'AKIAEXAMPLE', secretAccessKey: 'secret-key-for-test', fetch: async () => new Response('SecretAccessKey=secret-key-for-test', { status: 403 }), now: () => NOW });
  await assert.rejects(failing.put('k', bytes('x')), error => { assert.equal(error.message, 'R2 upload failed (HTTP 403)'); assert.ok(!/secret|AKIA/.test(error.message)); return true; });
});

test('REST transport encodes each key segment again; list follows the cursor', async () => {
  const calls = [];
  let lists = 0;
  const fetch = async (url, init) => { calls.push({ url, init }); if (init.method === undefined && url.includes('?')) { lists++; return Response.json({ result: lists === 1 ? [{ key: 'a' }] : [{ key: 'b' }], result_info: lists === 1 ? { cursor: 'c1', is_truncated: true } : {} }); } return new Response('', { status: 200 }); };
  const t = createRestTransport({ accountId: 'acct123', bucket: 'media', token: 'tok-secret', fetch });
  await t.put(`${PREFIX}${NEW_ID}/cities/%D0%BA.json`, bytes('[]'));
  assert.equal(calls[0].url, 'https://api.cloudflare.com/client/v4/accounts/acct123/r2/buckets/media/objects/np-catalog/v1/20261117T003000Z/cities/%25D0%25BA.json');
  assert.equal(calls[0].init.headers.Authorization, 'Bearer tok-secret');
  assert.deepEqual(await t.list(PREFIX), ['a', 'b']);
  assert.match(calls[2].url, /cursor=c1/);
});

test('transport selection: --out never builds a Cloudflare transport; Actions refuses the API token; credentials stay out of errors', async () => {
  const creds = { CLOUDFLARE_ACCOUNT_ID: 'acct123', CLOUDFLARE_API_TOKEN: 'tok-secret-value', NP_CATALOG_BUCKET: 'media', CLOUDFLARE_R2_BUCKET: 'media' };
  assert.equal(selectTransport(creds, { out: '/x/y' }).kind, 'file');
  assert.equal(selectTransport(creds, {}).kind, 'rest');
  assert.equal(selectTransport({ ...creds, NP_CATALOG_R2_ACCESS_KEY_ID: 'a', NP_CATALOG_R2_SECRET_ACCESS_KEY: 'b' }, {}).kind, 's3');
  for (const env of [{ ...creds, GITHUB_ACTIONS: 'true' }]) assert.throws(() => selectTransport(env, {}), error => { assert.ok(error instanceof SyncError); assert.ok(!error.message.includes('tok-secret-value')); return true; });
  assert.equal(selectTransport({ ...creds, GITHUB_ACTIONS: 'true', NP_CATALOG_R2_ACCESS_KEY_ID: 'a', NP_CATALOG_R2_SECRET_ACCESS_KEY: 'b' }, {}).kind, 's3');
  // Actions with only the API token refuses to upload anything, end to end
  const upstream = upstreamFetch(many(3));
  await rejects(runSync({ args: {}, env: { ...creds, GITHUB_ACTIONS: 'true' }, fetch: upstream, sleep: noSleep, now: () => NOW }), /only the dedicated R2 S3 credentials/);
  assert.equal(upstream.state.calls.length, 0, 'refused before any request');
  assert.throws(() => selectTransport({ CLOUDFLARE_ACCOUNT_ID: 'a', CLOUDFLARE_API_TOKEN: 't' }, {}), /No bucket/);
  assert.equal(selectTransport({ CLOUDFLARE_ACCOUNT_ID: 'a', CLOUDFLARE_API_TOKEN: 't' }, { staging: true }).kind, 'rest');
  assert.equal(STAGING_BUCKET, STAGING_NP_CATALOG_BUCKET_NAME, 'the staging default stays in step with cloudflare-config');
  assert.notEqual(STAGING_BUCKET, STAGING_R2_BUCKET_NAME, 'never the photo bucket');
  // Bucket resolution: explicit variable, else --staging constant; CLOUDFLARE_R2_BUCKET is never a default.
  const bucketOf = (env, args) => { const t = selectTransport({ CLOUDFLARE_ACCOUNT_ID: 'a', NP_CATALOG_R2_ACCESS_KEY_ID: 'k', NP_CATALOG_R2_SECRET_ACCESS_KEY: 's', ...env }, { ...args, fetch: async url => { bucketOf.url = String(url); return new Response('<ListBucketResult/>'); } }); return t.list('np-catalog/').then(() => bucketOf.url); };
  assert.match(await bucketOf({ NP_CATALOG_BUCKET: 'my-np' }, {}), /\/my-np\?/);
  assert.match(await bucketOf({}, { staging: true }), new RegExp(`/${STAGING_BUCKET}\\?`));
  assert.match(await bucketOf({ NP_CATALOG_BUCKET: 'my-np' }, { staging: true }), /\/my-np\?/);
  assert.throws(() => selectTransport({ CLOUDFLARE_ACCOUNT_ID: 'a', CLOUDFLARE_API_TOKEN: 't', CLOUDFLARE_R2_BUCKET: 'photos' }, {}), /No bucket/);
  assert.deepEqual(parseArgs(['--out', 'd', '--force', '--staging']), { out: 'd', staging: true, force: true });
  assert.throws(() => parseArgs(['--nope']), SyncError);
});

test('--out writes the exact layout to a directory, ignores Cloudflare credentials and returns the summary', async () => {
  const base = join(process.env.TMPDIR ?? '.claude/tmp/runtime'); await mkdir(base, { recursive: true });
  const dir = await mkdtemp(join(base, 'np-out-'));
  try {
    const guardFetch = upstreamFetch(syntheticUpstream());
    const result = await sync({ fetch: guardFetch, args: { out: dir }, env: { CLOUDFLARE_API_TOKEN: 'tok', CLOUDFLARE_ACCOUNT_ID: 'a', GITHUB_ACTIONS: 'true' } });
    assert.equal(guardFetch.state.calls.every(c => c.url === ENDPOINT), true, 'only Nova Poshta was contacted');
    const manifest = JSON.parse(await readFile(join(dir, PREFIX, 'current.json'), 'utf8'));
    assert.equal(manifest.snapshotId, NEW_ID);
    assert.equal(JSON.parse(await readFile(join(dir, PREFIX, NEW_ID, 'cities', '%D0%BA.json'), 'utf8')).length, 2);
    assert.equal((await readFile(join(dir, PREFIX, NEW_ID, 'points', `${KYIV[0]}.json`))).length > 0, true);
    assert.match(result.summary, /^snapshot=20261117T003000Z pages=1 upstreamMB=[\d.]+ received=22 points=12 branches=8 postomats=4 cities=4 objects=\d+ uploadedMB=[\d.]+ deleted=0 pullMs=\d+ms buildMs=\d+ms uploadMs=\d+ms$/);
    assert.ok(!/tok|apiKey/.test(result.summary));
    // a second run in the same directory sees the first as its previous snapshot
    const again = await runSync({ args: { out: dir }, env: {}, fetch: upstreamFetch(syntheticUpstream()), sleep: noSleep, now: () => new Date('2026-11-18T00:30:00Z') });
    assert.equal(again.previous.snapshotId, NEW_ID);
  } finally { await rm(dir, { recursive: true, force: true }); }
});
