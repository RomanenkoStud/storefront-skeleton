import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { readFileSync, readdirSync } from 'node:fs';
import worker from '../../apps/api/src/index.js';

// Own in-memory D1 stand-in built from every migration (never a live database).
const fixture = readFileSync(new URL('../../fixtures/easydrop-sample.xml', import.meta.url), 'utf8');
const KEY = '9876543210123456789', PID = '4455667', LINK = `https://easydrop.one/prom-export?key=${KEY}&pid=${PID}`, FEED_URL = LINK;
const XML = { 'Content-Type': 'application/xml; charset=utf-8' };
function database() {
  const sqlite = new DatabaseSync(':memory:');
  const dir = new URL('../../migrations/', import.meta.url);
  for (const file of readdirSync(dir).filter(f => f.endsWith('.sql')).sort()) sqlite.exec(readFileSync(new URL(file, dir), 'utf8'));
  const wrap = (sql, bindings = []) => ({ sql, bindings, bind(...v) { return wrap(sql, v); }, async first() { return sqlite.prepare(sql).get(...bindings) ?? null; }, async all() { return { results: sqlite.prepare(sql).all(...bindings) }; }, async run() { return sqlite.prepare(sql).run(...bindings); } });
  return { prepare: sql => wrap(sql), async batch(statements) { sqlite.exec('BEGIN'); try { const r = statements.map(s => sqlite.prepare(s.sql).run(...s.bindings)); sqlite.exec('COMMIT'); return r; } catch (e) { sqlite.exec('ROLLBACK'); throw e; } }, close: () => sqlite.close() };
}
let jwt;
async function token() {
  if (!jwt) { const pair = await crypto.subtle.generateKey({ name: 'RSASSA-PKCS1-v1_5', modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: 'SHA-256' }, true, ['sign', 'verify']); const jwk = await crypto.subtle.exportKey('jwk', pair.publicKey); jwk.kid = 'test-key'; jwk.alg = 'RS256'; jwt = { pair, jwk }; }
  const enc = v => Buffer.from(JSON.stringify(v)).toString('base64url');
  const unsigned = enc({ alg: 'RS256', kid: 'test-key' }) + '.' + enc({ iss: 'https://your-team.cloudflareaccess.com', aud: ['catalog-audience'], email: 'manager@example.com', exp: Math.floor(Date.now() / 1000) + 3600 });
  return unsigned + '.' + Buffer.from(await crypto.subtle.sign('RSASSA-PKCS1-v1_5', jwt.pair.privateKey, new TextEncoder().encode(unsigned))).toString('base64url');
}
// feedFactory(url, options) -> Response; records every outbound call. Anything else is refused (no network).
async function setup(t, feedFactory, { link = LINK } = {}) {
  const env = { DB: database(), CF_ACCESS_TEAM_NAME: 'your-team', CF_ACCESS_AUD: 'catalog-audience', APP_ENV: 'production', MYDROP_API_KEY: 'mydrop-test-key' };
  t.after(() => env.DB.close());
  await token();
  const calls = [], original = globalThis.fetch, ctl = { factory: feedFactory };
  globalThis.fetch = async (url, options) => {
    url = String(url);
    if (url.includes('/cdn-cgi/access/certs')) return new Response(JSON.stringify({ keys: [jwt.jwk] }), { headers: { 'Content-Type': 'application/json' } });
    calls.push({ url, options });
    if (url.startsWith('https://easydrop.one/') || url.startsWith('https://backend.mydrop.com.ua/')) return ctl.factory(url, options);
    throw new Error('unexpected network call');
  };
  t.after(() => { globalThis.fetch = original; });
  const cookie = 'CF_Authorization=' + await token();
  async function call(path, method = 'GET', body) {
    const headers = { Origin: 'https://catalog.test', Cookie: cookie };
    if (body !== undefined) headers['Content-Type'] = 'application/json';
    const response = await worker.fetch(new Request('https://catalog.test' + path, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) }), env);
    return { response, data: (response.headers.get('Content-Type') || '').includes('json') ? await response.json() : await response.text() };
  }
  const body = link ? { name: 'ED Shop', provider: 'easydrop', feedUrl: link } : { name: 'ED Shop', provider: 'easydrop', feedUrl: LINK };
  const created = await call('/api/admin/suppliers', 'POST', body);
  assert.equal(created.response.status, 201);
  const supplier = created.data;
  if (!link) await env.DB.prepare('UPDATE suppliers SET feed_key=NULL,feed_pid=NULL WHERE id=?').bind(supplier.id).run();
  const path = `/api/admin/suppliers/${supplier.id}/sync`;
  const sync = () => call(path, 'POST', {});
  const reset = () => env.DB.prepare('UPDATE suppliers SET last_api_request_at=NULL WHERE id=?').bind(supplier.id).run();
  const products = async () => (await call('/api/admin/products')).data.items;
  const dump = async () => JSON.stringify(await env.DB.prepare('SELECT * FROM products ORDER BY external_id').all().then(r => r.results));
  const runs = async () => (await call('/api/admin/sync-runs')).data.items;
  return { env, call, supplier, sync, reset, products, dump, runs, calls, ctl, path };
}
const apiCatalog = { categories: [{ id: 90210, title: 'Кросівки', parent_id: null }], products: [{ id: 553311, title: 'Кросівки Lorem Air', sku: 'ld-1245', category_id: 90210, drop_price: 950.15, price: 1400, description: 'Опис', sizes_available: true, is_set: false, sizes: [{ id: 77001, title: '42', formatted: '42', real_count_dropshipper: 1, images: [] }], images: [{ id: 88001, full_url: 'https://backend.mydrop.com.ua/vendor/products/uploads/example.jpg' }] }] };
const apiResponse = () => new Response(JSON.stringify(apiCatalog), { headers: { 'Content-Type': 'application/json' } });
const xml = (body, headers = XML, status = 200) => () => new Response(body, { status, headers });
const img = n => `<image>https://easydrop.one/media/uploads/images/base/${n}.jpg</image>`;
const item = ({ id = '1001', group = '9', price = '1000', size = '40', qty = '2', images = img('a') } = {}) =>
  `<item id="${id}" group_id="${group}" available="true"><categoryId>c1</categoryId><name>Name ${group}</name><priceuah>${price}</priceuah><description>&lt;p&gt;A&lt;/p&gt;</description>${images}<param name="Розмір" unit="">${size}</param><available>true</available><quantity_in_stock>${qty}</quantity_in_stock></item>`;
const feed = (...items) => `<?xml version="1.0"?><shop><catalog><category id="c1">Brand | Model</category></catalog><items>${items.join('\n')}</items></shop>`;

test('happy path: fixture creates unpublished drafts with variants, stock and kopeck prices; mixed-price product is reported', async t => {
  const a = await setup(t, xml(fixture));
  const r = await a.sync();
  assert.equal(r.response.status, 200);
  assert.equal(r.data.status, 'synced');
  assert.equal(r.data.imported, 4);
  assert.equal(r.data.skippedCount, 1);
  assert.deepEqual(r.data.skippedIds, ['10005']);
  assert.match(r.data.skippedNote, /Пропущено 1 з 5 товарів: різні ціни розмірів — 1/);
  // fetched exactly once, with the stored key/pid, manual redirects and a timeout signal
  assert.equal(a.calls.length, 1);
  assert.equal(a.calls[0].url, FEED_URL);
  assert.equal(a.calls[0].options.redirect, 'manual');
  assert.ok(a.calls[0].options.signal);
  const items = await a.products();
  assert.equal(items.length, 4);
  assert.ok(items.every(p => !p.published && !p.deletedAt));
  const one = items.find(p => p.externalId === '10001');
  assert.equal(one.source.costMinor, 265000);
  assert.equal(one.source.variants.length, 11);
  assert.deepEqual(one.source.variants.slice(0, 3).map(v => [v.size, v.stock]), [['36', 0], ['37', 2], ['38', 5]]);
  assert.deepEqual((await a.call('/api/products')).data.items, []);
  const run = (await a.runs()).find(x => x.status === 'synced');
  assert.equal(run.imported, 4);
  assert.match(run.error, /Пропущено 1 з 5/);
  const supplier = (await a.call('/api/admin/suppliers')).data.items.find(s => s.id === a.supplier.id);
  assert.equal(supplier.lastSyncStatus, 'synced');
});

test('re-sync preserves manager overrides and publication, retains omitted products and is repeatable', async t => {
  let body = feed(item({ id: '1', group: '10', price: '1000' }), item({ id: '2', group: '20', price: '2000' }));
  const a = await setup(t, () => new Response(body, { headers: XML }));
  assert.equal((await a.sync()).data.imported, 2);
  const p = (await a.products()).find(x => x.externalId === '10');
  assert.equal((await a.call(`/api/admin/products/${p.id}`, 'PATCH', { published: true, markupType: 'fixed', markupValue: 5000, title: 'Manager title' })).response.status, 200);
  const before = await a.products();
  // repeat identical feed: same rows, same overlays
  await a.reset();
  assert.equal((await a.sync()).data.imported, 2);
  assert.equal((await a.products()).length, 2);
  // price change at the source, product 20 omitted from the feed
  body = feed(item({ id: '1', group: '10', price: '1500' }));
  await a.reset();
  const r = await a.sync();
  assert.equal(r.data.imported, 1);
  const after = await a.products();
  assert.equal(after.length, 2, 'omitted product retained');
  const kept = after.find(x => x.externalId === '10');
  assert.equal(kept.id, p.id);
  assert.equal(kept.published, true);
  assert.equal(kept.overrides.title, 'Manager title');
  assert.equal(kept.overrides.markupValue, 5000);
  assert.equal(kept.source.costMinor, 150000);
  assert.deepEqual(after.find(x => x.externalId === '20').source, before.find(x => x.externalId === '20').source);
  assert.equal((await a.call('/api/products')).data.items.length, 1);
});

test('a refresh that would break a published product keeps it and reports it', async t => {
  let body = feed(item({ id: '1', group: '10' }), item({ id: '2', group: '20' }));
  const a = await setup(t, () => new Response(body, { headers: XML }));
  await a.sync();
  const p = (await a.products()).find(x => x.externalId === '10');
  assert.equal((await a.call(`/api/admin/products/${p.id}`, 'PATCH', { published: true })).response.status, 200);
  body = feed(item({ id: '1', group: '10', images: '' }), item({ id: '2', group: '20', price: '3000' }));
  await a.reset();
  const r = await a.sync();
  assert.equal(r.response.status, 200);
  assert.equal(r.data.imported, 1);
  assert.equal(r.data.skippedCount, 1);
  assert.deepEqual(r.data.skippedIds, ['10']);
  assert.match(r.data.skippedNote, /залишено як є\) — 1/);
  const kept = (await a.products()).find(x => x.id === p.id);
  assert.equal(kept.published, true);
  assert.equal(kept.source.photos.length, 1);
});

test('a key-only link (no pid) is accepted and synced by key alone', async t => {
  const keyOnly = `https://easydrop.one/prom-export?key=${KEY}`;
  const a = await setup(t, xml(fixture), { link: keyOnly });
  const row = await a.env.DB.prepare('SELECT feed_key,feed_pid FROM suppliers WHERE id=?').bind(a.supplier.id).first();
  assert.deepEqual({ ...row }, { feed_key: KEY, feed_pid: null });
  const r = await a.sync();
  assert.equal(r.data.status, 'synced');
  assert.equal(r.data.imported, 4);
  assert.equal(a.calls.length, 1);
  assert.equal(a.calls[0].url, keyOnly);
});

test('15 minute cooldown is persisted and a second request does not fetch', async t => {
  const a = await setup(t, xml(fixture));
  assert.equal((await a.sync()).response.status, 200);
  const second = await a.sync();
  assert.equal(second.response.status, 429);
  assert.equal(a.calls.length, 1);
  await a.env.DB.prepare('UPDATE suppliers SET last_api_request_at=? WHERE id=?').bind(Date.now() - 899000, a.supplier.id).run();
  assert.equal((await a.sync()).response.status, 429);
  await a.env.DB.prepare('UPDATE suppliers SET last_api_request_at=? WHERE id=?').bind(Date.now() - 901000, a.supplier.id).run();
  assert.equal((await a.sync()).response.status, 200);
  assert.equal(a.calls.length, 2);
});

const FAILURES = {
  '302 redirect': () => new Response(null, { status: 302, headers: { Location: 'https://evil.test/?k=1' } }),
  '404': () => new Response('nope', { status: 404, headers: XML }),
  '500': () => new Response('boom', { status: 500, headers: XML }),
  'HTML 200 login page': () => new Response('<html><body>Login</body></html>', { status: 200, headers: { 'Content-Type': 'text/html; charset=utf-8' } }),
  'missing content type': () => new Response(new Uint8Array(feed(item()).split('').map(c => c.charCodeAt(0))), { status: 200 }),
  'oversized body (streamed, no Content-Length)': () => new Response(new ReadableStream({ pull(c) { c.enqueue(new Uint8Array(1024 * 1024).fill(32)); } }), { status: 200, headers: XML }),
  'oversized Content-Length': () => new Response('x', { status: 200, headers: { ...XML, 'Content-Length': String(13 * 1024 * 1024) } }),
  'timeout': () => { throw new DOMException('The operation timed out', 'TimeoutError'); },
  'body stalls after headers (timeout over the body)': () => { return new Response(new ReadableStream({ start(c) { c.enqueue(new TextEncoder().encode('<?xml version="1.0"?><shop>')); } }), { status: 200, headers: XML }); },
  'body stream error': () => new Response(new ReadableStream({ start(c) { c.error(new Error('socket reset')); } }), { status: 200, headers: XML }),
  'empty feed': xml('<?xml version="1.0"?><shop><catalog></catalog><items></items></shop>'),
  'malformed XML': xml('<shop><catalog></catalog><items><item id="1"></shop>'),
  'forbidden DOCTYPE': xml('<?xml version="1.0"?><!DOCTYPE shop [<!ENTITY a "b">]><shop></shop>'),
  'every product skipped': xml(feed(item({ id: '1', group: '5', price: '0' }), item({ id: '2', group: '6', price: 'abc' })))
};
for (const [name, factory] of Object.entries(FAILURES)) {
  test(`failure: ${name} records a failed run and writes nothing`, async t => {
    const a = await setup(t, FAILURES['404']);
    a.ctl.factory = xml(feed(item({ id: '1', group: '10' }), item({ id: '2', group: '20' })));
    assert.equal((await a.sync()).response.status, 200);
    const before = await a.dump();
    await a.reset();
    a.ctl.factory = factory;
    const timeout = AbortSignal.timeout;
    if (name.startsWith('body stalls')) AbortSignal.timeout = () => { const c = new AbortController(); setTimeout(() => c.abort(new DOMException('timed out', 'TimeoutError')), 50); return c.signal; };
    let r;
    try { r = await a.sync(); } finally { AbortSignal.timeout = timeout; }
    assert.equal(r.response.status, 422, name);
    assert.equal(await a.dump(), before, 'inventory untouched');
    const run = (await a.runs()).find(x => x.status === 'failed');
    assert.ok(run, 'failed run recorded');
    assert.equal(run.imported, 0);
    const supplier = (await a.call('/api/admin/suppliers')).data.items.find(s => s.id === a.supplier.id);
    assert.equal(supplier.lastSyncStatus, 'failed');
    assert.ok(supplier.lastSyncError);
    assert.deepEqual((await a.call('/api/products')).data.items, []);
  });
}

test('supplier with no feed configured fails cleanly without fetching or claiming the cooldown', async t => {
  const a = await setup(t, xml(fixture), { link: null });
  const r = await a.sync();
  assert.equal(r.response.status, 409);
  assert.match(r.data.error, /not configured/);
  assert.equal(a.calls.length, 0);
  const row = await a.env.DB.prepare('SELECT last_api_request_at,last_sync_status FROM suppliers WHERE id=?').bind(a.supplier.id).first();
  assert.equal(row.last_api_request_at, null);
  assert.equal(row.last_sync_status, 'blocked');
});

test('canary key never appears in stored errors, run rows, responses, logs or thrown messages', async t => {
  const logs = [];
  const spies = ['log', 'error', 'warn', 'info'].map(k => { const o = console[k]; console[k] = (...args) => { logs.push(args.map(String).join(' ')); }; return () => { console[k] = o; }; });
  t.after(() => spies.forEach(restore => restore()));
  const canaryKey = '8675309867530986753', canaryPid = '5550123';
  const a = await setup(t, xml(fixture), { link: `https://easydrop.one/prom-export?key=${canaryKey}&pid=${canaryPid}` });
  const seen = [];
  const scenarios = [
    () => new Response(null, { status: 302, headers: { Location: `https://easydrop.one/prom-export?key=${canaryKey}&pid=${canaryPid}` } }),
    () => new Response(`not found: key=${canaryKey}`, { status: 404, headers: XML }),
    () => new Response(`<html>${canaryKey}</html>`, { headers: { 'Content-Type': 'text/html' } }),
    (url) => { throw new TypeError(`fetch failed for ${url}`); },
    (url) => { throw new DOMException(`timed out ${url}`, 'TimeoutError'); },
    xml(`<shop><x key="${canaryKey}"></shop>`),
    xml(fixture)
  ];
  for (const factory of scenarios) {
    await a.reset();
    a.ctl.factory = factory;
    const r = await a.sync();
    seen.push(JSON.stringify(r.data), r.response.headers.get('Location') || '');
  }
  const supplierList = await a.call('/api/admin/suppliers');
  seen.push(JSON.stringify(supplierList.data), JSON.stringify(await a.runs()));
  seen.push(...(await a.env.DB.prepare('SELECT * FROM sync_runs').all()).results.map(r => JSON.stringify(r)));
  const row = await a.env.DB.prepare('SELECT last_sync_error FROM suppliers WHERE id=?').bind(a.supplier.id).first();
  seen.push(String(row.last_sync_error), ...logs);
  seen.push(...(await a.env.DB.prepare('SELECT * FROM audit_events').all().then(r => r.results.map(x => JSON.stringify(x)))));
  for (const text of seen) { assert.ok(!text.includes(canaryKey), 'key leaked'); assert.ok(!text.includes(canaryPid), 'pid leaked'); assert.ok(!text.includes('prom-export'), 'url leaked'); }
  assert.ok(seen.length > 10);
});

test('scheduled rotation syncs EasyDrop and MyDrop together, skips unconfigured and disabled EasyDrop rows', async t => {
  const a = await setup(t, xml(fixture));
    const my = (await a.call('/api/admin/suppliers', 'POST', { name: 'Lorem Supply', url: 'https://mydrop.com.ua/demo_shop' })).data;
  await a.call(`/api/admin/suppliers/${my.id}`, 'PATCH', { connectionId: '12345' });
  const nofeed = (await a.call('/api/admin/suppliers', 'POST', { name: 'ED none', provider: 'easydrop', feedUrl: 'https://easydrop.one/prom-export?key=111&pid=222' })).data;
  await a.env.DB.prepare('UPDATE suppliers SET feed_key=NULL,feed_pid=NULL WHERE id=?').bind(nofeed.id).run();
  const off = (await a.call('/api/admin/suppliers', 'POST', { name: 'ED off', provider: 'easydrop', feedUrl: 'https://easydrop.one/prom-export?key=333&pid=444' })).data;
  await a.call(`/api/admin/suppliers/${off.id}`, 'PATCH', { enabled: false });
  a.ctl.factory = url => url.startsWith('https://easydrop.one/') ? new Response(fixture, { headers: XML }) : apiResponse();
  // Never-synced suppliers have unknown size, so each runs as the first of its own tick.
  for (let i = 0; i < 2; i++) { const tasks = []; await worker.scheduled({}, a.env, { waitUntil: p => tasks.push(p) }); await Promise.all(tasks); }
  assert.deepEqual(a.calls.map(c => c.url.split('/')[2]).sort(), ['backend.mydrop.com.ua', 'easydrop.one']);
  const list = (await a.call('/api/admin/suppliers')).data.items;
  assert.equal(list.find(s => s.id === a.supplier.id).lastSyncStatus, 'synced');
  assert.equal(list.find(s => s.id === my.id).lastSyncStatus, 'synced');
  assert.equal(list.find(s => s.id === nofeed.id).lastSyncStatus, null);
  assert.equal(list.find(s => s.id === off.id).lastSyncStatus, null);
  const products = await a.products();
  assert.equal(products.filter(p => p.supplierId === a.supplier.id).length, 4);
  assert.equal(products.filter(p => p.supplierId === my.id).length, 1);
});

test('unchanged MyDrop sync still works and never requests the EasyDrop host', async t => {
  const a = await setup(t, apiResponse);
  const my = (await a.call('/api/admin/suppliers', 'POST', { name: 'Lorem Supply', url: 'https://mydrop.com.ua/demo_shop' })).data;
  await a.call(`/api/admin/suppliers/${my.id}`, 'PATCH', { connectionId: '12345' });
  const r = await a.call(`/api/admin/suppliers/${my.id}/sync`, 'POST', {});
  assert.equal(r.response.status, 200);
  assert.deepEqual(r.data, { status: 'synced', imported: 1 });
  assert.equal((await a.products()).filter(p => p.supplierId === my.id)[0].source.costMinor, 95015);
  assert.equal(a.calls.length, 1);
  assert.ok(a.calls[0].url.startsWith('https://backend.mydrop.com.ua/'));
  assert.equal(a.calls[0].options.headers['X-API-KEY'], 'mydrop-test-key');
});

test('a skipped non-numeric group is reported under a distinct ID that cannot collide with an imported product', async t => {
  const lone = item({ id: '5', group: '' });
  const a = await setup(t, xml(feed(lone, item({ id: '6', group: 'o:5', price: '1000' }))));
  const r = await a.sync();
  assert.equal(r.response.status, 200);
  assert.equal(r.data.imported, 1);
  assert.deepEqual(r.data.skippedIds, ['x:o:5']);
  assert.deepEqual((await a.products()).map(p => p.externalId), ['o:5']);
});

test('scheduled rotation excludes a trashed EasyDrop supplier that has a feed: no fetch, no run', async t => {
  const a = await setup(t, xml(fixture));
  await a.env.DB.prepare("UPDATE suppliers SET deleted_at='2026-01-01T00:00:00Z' WHERE id=?").bind(a.supplier.id).run();
  const tasks = [];
  await worker.scheduled({}, a.env, { waitUntil: p => tasks.push(p) });
  await Promise.all(tasks);
  assert.equal(a.calls.length, 0);
  assert.equal((await a.env.DB.prepare('SELECT COUNT(*) AS n FROM sync_runs').first()).n, 0);
});

test('an unsupported entity name is capped before it is persisted to run errors', async t => {
  const a = await setup(t, xml(feed(item({ id: '1', group: '10' }).replace('Name 10', `Name &${'x'.repeat(5000)};`))));
  const r = await a.sync();
  assert.equal(r.response.status, 422);
  const row = await a.env.DB.prepare('SELECT last_sync_error FROM suppliers WHERE id=?').bind(a.supplier.id).first();
  assert.ok(row.last_sync_error.length < 150, row.last_sync_error.length);
  assert.ok(r.data.error.length < 150);
  assert.ok(!r.data.error.includes('x'.repeat(33)));
});

test('scheduled sync defers further suppliers once the per-invocation query budget is spent, then runs them next tick', async t => {
  const big = group => feed(...Array.from({ length: 850 }, (_, i) => item({ id: `${group}${i}`, group: `${group}${i}` })));
  const a = await setup(t, url => new Response(url.includes('key=111') ? big(1) : big(2), { headers: XML }));
  await a.env.DB.prepare("UPDATE suppliers SET feed_key='111',last_sync_at='2026-01-01T00:00:00Z' WHERE id=?").bind(a.supplier.id).run();
  const second = (await a.call('/api/admin/suppliers', 'POST', { name: 'ED 2', provider: 'easydrop', feedUrl: 'https://easydrop.one/prom-export?key=222&pid=9' })).data;
  await a.env.DB.prepare("UPDATE suppliers SET last_sync_at='2026-02-01T00:00:00Z' WHERE id=?").bind(second.id).run();
  const tick = async () => { const tasks = []; await worker.scheduled({}, a.env, { waitUntil: p => tasks.push(p) }); await Promise.all(tasks); };
  await tick();
  assert.equal(a.calls.length, 1);
  assert.ok(a.calls[0].url.includes('key=111'));
  let list = (await a.call('/api/admin/suppliers')).data.items;
  assert.equal(list.find(s => s.id === a.supplier.id).lastSyncStatus, 'synced');
  assert.equal(list.find(s => s.id === second.id).lastSyncStatus, null);
  await tick();
  assert.equal(a.calls.length, 2, 'deferred supplier is now oldest and runs first');
  assert.ok(a.calls[1].url.includes('key=222'));
  list = (await a.call('/api/admin/suppliers')).data.items;
  assert.equal(list.find(s => s.id === second.id).lastSyncStatus, 'synced');
});

async function twoSuppliers(t, firstProducts, secondExisting, secondFeedSize, { nullSync = false } = {}) {
  const big = (g, n) => feed(...Array.from({ length: n }, (_, i) => item({ id: `${g}${i}`, group: `${g}${i}` })));
  const a = await setup(t, url => new Response(url.includes('key=111') ? big(1, firstProducts) : big(2, secondFeedSize), { headers: XML }));
  await a.env.DB.prepare(nullSync ? "UPDATE suppliers SET feed_key='111' WHERE id=?" : "UPDATE suppliers SET feed_key='111',last_sync_at='2026-01-01T00:00:00Z' WHERE id=?").bind(a.supplier.id).run();
  const second = (await a.call('/api/admin/suppliers', 'POST', { name: 'ED 2', provider: 'easydrop', feedUrl: 'https://easydrop.one/prom-export?key=222&pid=9' })).data;
  if (!nullSync) await a.env.DB.prepare("UPDATE suppliers SET last_sync_at='2026-02-01T00:00:00Z' WHERE id=?").bind(second.id).run();
  for (let i = 0; i < secondExisting; i++) await a.env.DB.prepare("INSERT INTO products(id,supplier_id,external_id,source_json,overrides_json,slug,updated_at) VALUES(?,?,?,'{}','{}',?,'2026-01-01T00:00:00Z')").bind(`seed${i}`, second.id, `old${i}`, `seed-${i}`).run();
  const tick = async () => { const tasks = []; await worker.scheduled({}, a.env, { waitUntil: p => tasks.push(p) }); await Promise.all(tasks); };
  return { a, second, tick };
}

test('pre-start estimate: 780 products then an existing 930-product supplier defers the second, which runs first next tick', async t => {
  const { a, second, tick } = await twoSuppliers(t, 780, 930, 930);
  await tick();
  assert.equal(a.calls.length, 1);
  assert.ok(a.calls[0].url.includes('key=111'));
  await tick();
  assert.equal(a.calls.length, 2);
  assert.ok(a.calls[1].url.includes('key=222'));
});

test('pre-start estimate: two small suppliers both run in one tick', async t => {
  const { a, second, tick } = await twoSuppliers(t, 20, 30, 30);
  await tick();
  assert.equal(a.calls.length, 2);
  const list = (await a.call('/api/admin/suppliers')).data.items;
  assert.equal(list.find(s => s.id === second.id).lastSyncStatus, 'synced');
});

test('pre-start estimate: a zero-product supplier with a last_sync_at is treated as unknown, deferred behind a 780 sync, and runs first next tick', async t => {
  const { a, tick } = await twoSuppliers(t, 780, 0, 930);
  await tick();
  assert.equal(a.calls.length, 1);
  assert.ok(a.calls[0].url.includes('key=111'));
  await tick();
  assert.equal(a.calls.length, 2);
  assert.ok(a.calls[1].url.includes('key=222'));
});

test('two never-synced suppliers run one per tick and both are done after two ticks', async t => {
  const { a, second, tick } = await twoSuppliers(t, 700, 0, 930, { nullSync: true });
  await tick();
  assert.equal(a.calls.length, 1);
  await tick();
  assert.equal(a.calls.length, 2);
  assert.notEqual(a.calls[0].url, a.calls[1].url);
  const list = (await a.call('/api/admin/suppliers')).data.items;
  assert.ok(list.every(s => s.lastSyncStatus === 'synced'));
});

test('unexpected errors report stage and error name, scrubbed of key, pid and URL everywhere', async t => {
  const logs = [];
  const spy = console.error; console.error = (...args) => { logs.push(args.map(String).join(' ')); };
  t.after(() => { console.error = spy; });
  const key = '8675309867530986753', pid = '5550123', url = `https://easydrop.one/prom-export?key=${key}&pid=${pid}`;
  const a = await setup(t, xml(fixture), { link: url });
  const realDb = a.env.DB;
  const cases = [
    { stage: 'fetch', name: 'TypeError', factory: u => { throw new TypeError(`Failed to fetch ${u} (key=${key}, pid=${pid})`); } },
    { stage: 'import', name: 'Error', factory: xml(fixture), batch: () => { throw new Error(`D1_ERROR: statement too large near key=${key} pid=${pid} for ${url} id ${key}`); } },
    { stage: 'parse', name: 'HttpError', factory: xml('<shop><catalog></catalog><items>'), expectHttp: true },
    { stage: 'read', name: 'Error', factory: () => new Response(new ReadableStream({ start(c) { c.error(new Error(`socket reset ${url}`)); } }), { status: 200, headers: XML }) }
  ];
  const seen = [];
  for (const c of cases) {
    await a.reset();
    a.ctl.factory = c.factory;
    let thrown = false;
    a.env.DB = c.batch ? { prepare: sql => realDb.prepare(sql), batch: s => { if (!thrown) { thrown = true; return c.batch(); } return realDb.batch(s); } } : realDb;
    const r = await a.sync();
    a.env.DB = realDb;
    assert.equal(r.response.status, 422);
    if (!c.expectHttp) { assert.match(r.data.error, new RegExp(`failed at ${c.stage} \\(${c.name}:`)); assert.ok(r.data.error.length < 260); }
    seen.push(JSON.stringify(r.data));
  }
  seen.push(...(await realDb.prepare('SELECT * FROM sync_runs').all()).results.map(r => JSON.stringify(r)));
  seen.push(JSON.stringify((await realDb.prepare('SELECT last_sync_error FROM suppliers').first())));
  seen.push(...(await realDb.prepare('SELECT * FROM audit_events').all()).results.map(r => JSON.stringify(r)));
  seen.push(...logs);
  assert.ok(logs.some(l => l.includes('EasyDrop sync failed') && l.includes('import')));
  for (const text of seen) { assert.ok(!text.includes(key), 'key leaked'); assert.ok(!text.includes(pid), 'pid leaked'); assert.ok(!text.includes('prom-export'), 'url leaked'); }
});

// the cron ticks every 5 minutes; each supplier is due about hourly.
test('scheduled sync skips a supplier synced under 55 minutes ago and runs it once due; pending retries after 15 minutes', async t => {
  const a = await setup(t, xml(fixture));
  const tick = async () => { const tasks = []; await worker.scheduled({}, a.env, { waitUntil: p => tasks.push(p) }); await Promise.all(tasks); };
  const ago = minutes => new Date(Date.now() - minutes * 60000).toISOString();
  const set = (status, minutes) => a.env.DB.prepare('UPDATE suppliers SET last_sync_status=?,last_sync_at=?,last_api_request_at=NULL WHERE id=?').bind(status, ago(minutes), a.supplier.id).run();
  await set('synced', 10); await tick();
  assert.equal(a.calls.length, 0, 'recently synced supplier is not due');
  await set('failed', 30); await tick();
  assert.equal(a.calls.length, 0, 'a failed run also waits for the hourly slot');
  await set('pending', 20); await tick();
  assert.equal(a.calls.length, 1, 'a pending MyDrop export is retried after 15 minutes');
  await set('synced', 56); await tick();
  assert.equal(a.calls.length, 2, 'due after 55 minutes');
  const s = (await a.call('/api/admin/suppliers')).data;
  assert.deepEqual(s.autoSync, { intervalMinutes: 60 });
});

test('autoSync is null outside production', async t => {
  const a = await setup(t, xml(fixture));
  a.env.APP_ENV = 'staging';
  assert.equal((await a.call('/api/admin/suppliers')).data.autoSync, null);
});

test('lastSuccessAt keeps the last successful refresh when a later run fails', async t => {
  const a = await setup(t, xml(fixture));
  assert.equal((await a.call('/api/admin/suppliers')).data.items[0].lastSuccessAt, null);
  assert.equal((await a.sync()).response.status, 200);
  const first = (await a.call('/api/admin/suppliers')).data.items[0];
  assert.ok(first.lastSuccessAt);
  await a.reset();
  a.ctl.factory = xml('nope', { 'Content-Type': 'text/html' });
  assert.equal((await a.sync()).response.status, 422);
  const after = (await a.call('/api/admin/suppliers')).data.items[0];
  assert.equal(after.lastSyncStatus, 'failed');
  assert.equal(after.lastSuccessAt, first.lastSuccessAt);
  assert.ok(after.lastSyncAt > after.lastSuccessAt);
});

test('re-syncing an unchanged feed does not rewrite products (updated_at stays); a changed price does', async t => {
  const a = await setup(t, xml(feed(item({ id: '1', group: '10' }), item({ id: '2', group: '20' }))));
  assert.equal((await a.sync()).data.imported, 2);
  const stamp = () => a.env.DB.prepare('SELECT external_id,updated_at FROM products ORDER BY external_id').all().then(r => r.results);
  const before = await stamp();
  await new Promise(r => setTimeout(r, 5));
  await a.reset();
  a.ctl.factory = xml(feed(item({ id: '1', group: '10' }), item({ id: '2', group: '20', price: '1500' })));
  assert.equal((await a.sync()).data.imported, 2);
  const after = await stamp();
  assert.equal(after[0].updated_at, before[0].updated_at, 'unchanged product keeps updated_at');
  assert.notEqual(after[1].updated_at, before[1].updated_at, 'changed product is rewritten');
  assert.equal((await a.products()).find(p => p.externalId === '20').source.costMinor, 150000);
});

test('a sync with an unchanged feed does not bump catalog_revision (open previews stay valid); a rename still does', async t => {
  const a = await setup(t, xml(fixture));
  assert.equal((await a.sync()).response.status, 200);
  const rev = async () => (await a.env.DB.prepare('SELECT catalog_revision AS r FROM recognition_state WHERE id=1').first()).r;
  const before = await rev();
  await a.reset();
  await a.env.DB.prepare("UPDATE suppliers SET last_sync_at='2026-01-01T00:00:00Z' WHERE id=?").bind(a.supplier.id).run();
  const tasks = []; await worker.scheduled({}, a.env, { waitUntil: p => tasks.push(p) }); await Promise.all(tasks);
  assert.equal(a.calls.length, 2, 'scheduled sync ran');
  assert.equal(await rev(), before);
  await a.call(`/api/admin/suppliers/${a.supplier.id}`, 'PATCH', { name: 'ED Renamed' });
  assert.ok(await rev() > before);
});
