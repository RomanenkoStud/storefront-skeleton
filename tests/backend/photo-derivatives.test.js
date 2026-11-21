import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { readFileSync, readdirSync } from 'node:fs';
import worker from '../../apps/api/src/index.js';

// Synthetic fixtures only: invented suppliers and photo URLs, in-memory D1 and R2.
const migrationDir = new URL('../../migrations/', import.meta.url);
function database() {
  const sqlite = new DatabaseSync(':memory:');
  for (const name of readdirSync(migrationDir).filter(n => /^\d{4}_.*\.sql$/.test(n)).sort()) sqlite.exec(readFileSync(new URL(name, migrationDir), 'utf8'));
  const wrap = (sql, bindings = []) => ({ sql, bindings, bind(...x) { return wrap(sql, x); }, async first() { return sqlite.prepare(sql).get(...bindings) ?? null; }, async all() { return { results: sqlite.prepare(sql).all(...bindings) }; }, async run() { return sqlite.prepare(sql).run(...bindings); } });
  return { sqlite, prepare: sql => wrap(sql), async batch(statements) { sqlite.exec('BEGIN'); try { const result = statements.map(s => sqlite.prepare(s.sql).run(...s.bindings)); sqlite.exec('COMMIT'); return result; } catch (error) { sqlite.exec('ROLLBACK'); throw error; } }, close: () => sqlite.close() };
}
const HOST = 'http://localhost';
const ORIGINAL = '/media/aaaaaaaa-0000-4000-8000-000000000001.png';
const THUMB = '/media/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa-1111111111111111.card.webp';
const SECOND = '/media/bbbbbbbb-0000-4000-8000-000000000002.png';
const SECOND_THUMB = '/media/bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb-2222222222222222.card.webp';
const DRAFT = '/media/cccccccc-0000-4000-8000-000000000003.png';
const DRAFT_THUMB = '/media/cccccccccccccccccccccccccccccccc-3333333333333333.card.webp';
const item = (externalId, photos) => ({ externalId, title: 'Fakeshoe ' + externalId, description: 'Synthetic', category: 'Кросівки', costMinor: 100000, currency: 'UAH', photos, variants: [{ id: externalId + '-42', size: '42', stock: 2 }] });

async function setup(t) {
  const db = database();
  const store = new Map();
  const MEDIA = { async get(key) { return store.has(key) ? { body: store.get(key), httpMetadata: { contentType: 'image/webp' } } : null; } };
  for (const url of [ORIGINAL, THUMB, SECOND, SECOND_THUMB, DRAFT, DRAFT_THUMB, '/media/' + 'f'.repeat(32) + '-' + '6'.repeat(16) + '.card.webp']) store.set(url.slice('/media/'.length), 'bytes');
  t.after(() => db.close());
  const privateEnv = { DB: db, MEDIA, APP_ENV: 'development', AUTH_DEV_BYPASS: 'true', DEV_STAFF_ROLE: 'owner', CUSTOMER_AUTH_HMAC_KEY: 'fake-hmac' };
  const publicEnv = { DB: db, MEDIA, APP_ENV: 'production', CUSTOMER_AUTH_HMAC_KEY: 'fake-hmac' };
  const call = (env, path, { method = 'GET', body } = {}) => worker.fetch(new Request(HOST + path, { method, headers: { Origin: HOST, 'CF-Connecting-IP': '203.0.113.9', ...(body ? { 'Content-Type': 'application/json' } : {}) }, body: body && JSON.stringify(body) }), env);
  const admin = (path, options) => call(privateEnv, '/api/admin' + path, options);
  const supplier = (await (await admin('/suppliers', { method: 'POST', body: { name: 'Synthetic', url: 'https://mydrop.com.ua/synthetic_one' } })).json()).id;
  await admin(`/suppliers/${supplier}/import`, { method: 'POST', body: { items: [item('P-1', [ORIGINAL, 'https://img.test/second.jpg']), item('P-2', ['https://img.test/p2.jpg', SECOND]), item('D-1', [DRAFT])] } });
  const ids = Object.fromEntries(db.sqlite.prepare('SELECT id,external_id FROM products').all().map(r => [r.external_id, r.id]));
  for (const ext of ['P-1', 'P-2']) assert.equal((await admin(`/products/${ids[ext]}`, { method: 'PATCH', body: { published: true, markupType: 'fixed', markupValue: 50000 } })).status, 200);
  const derive = (source, url) => db.sqlite.prepare("INSERT INTO photo_derivatives (source_url,variant,url,width,height,bytes,source_bytes,created_at) VALUES (?,?,?,?,?,?,?,?)").run(source, 'card', url, 600, 800, 40000, 900000, '2026-01-01T00:00:00Z');
  return { db, privateEnv, publicEnv, call, admin, ids, derive };
}

test('migration 0019 keeps derivatives separate from snapshot and overlay and rejects bad rows', async t => {
  const { db } = await setup(t);
  const columns = db.sqlite.prepare('PRAGMA table_info(photo_derivatives)').all().map(c => c.name);
  assert.deepEqual(columns, ['source_url', 'variant', 'url', 'width', 'height', 'bytes', 'source_bytes', 'source_hash', 'params', 'created_at']);
  assert.throws(() => db.sqlite.prepare("INSERT INTO photo_derivatives (source_url,variant,url,created_at) VALUES ('x','huge','/media/a.card.webp','t')").run());
  assert.throws(() => db.sqlite.prepare("INSERT INTO photo_derivatives (source_url,variant,url,created_at) VALUES ('x','card','/media/a.card.webp','t')").run(), /CHECK/);
  db.sqlite.prepare("INSERT INTO photo_derivatives (source_url,variant,url,created_at) VALUES ('x','card',NULL,'t')").run();
  db.sqlite.prepare("INSERT INTO photo_derivatives (source_url,variant,url,created_at) VALUES ('y','card',NULL,'t')").run();
});

test('public list and detail carry cardPhoto only when a derivative exists for the first photo', async t => {
  const { publicEnv, call, derive } = await setup(t);
  const before = (await (await call(publicEnv, '/api/products')).json()).items;
  assert.equal(before.length, 2);
  for (const p of before) assert.equal(p.cardPhoto, null);
  derive(ORIGINAL, THUMB);
  derive('https://img.test/second.jpg', '/media/dddddddddddddddddddddddddddddddd-4444444444444444.card.webp'); // not P-1's FIRST photo of another product: P-1's second photo
  derive(SECOND, SECOND_THUMB); // P-2's second photo, not its first
  const items = (await (await call(publicEnv, '/api/products')).json()).items;
  const byTitle = Object.fromEntries(items.map(p => [p.title, p]));
  assert.equal(byTitle['Fakeshoe P-1'].cardPhoto, THUMB);
  assert.equal(byTitle['Fakeshoe P-2'].cardPhoto, null, 'a thumbnail of a later photo is not the card photo');
  assert.equal(byTitle['Fakeshoe P-1'].photos[0], ORIGINAL, 'photos keep the original');
  const detail = await (await call(publicEnv, `/api/products/${byTitle['Fakeshoe P-1'].slug}`)).json();
  assert.equal(detail.cardPhoto, THUMB);
  assert.deepEqual(detail.photos, [ORIGINAL, 'https://img.test/second.jpg']);
  for (const key of ['supplierId', 'externalId', 'source', 'costMinor']) assert.ok(!JSON.stringify(items).includes(`"${key}"`), key);
});

test('a NULL url row ("not smaller") never becomes a cardPhoto', async t => {
  const { publicEnv, call, db } = await setup(t);
  db.sqlite.prepare("INSERT INTO photo_derivatives (source_url,variant,url,created_at) VALUES (?, 'card', NULL, 't')").run(ORIGINAL);
  const items = (await (await call(publicEnv, '/api/products')).json()).items;
  assert.ok(items.every(p => p.cardPhoto === null));
});

test('the storefront still works when the derivatives table is missing', async t => {
  const { publicEnv, call, db } = await setup(t);
  db.sqlite.exec('DROP TABLE photo_derivatives');
  const response = await call(publicEnv, '/api/products');
  assert.equal(response.status, 200);
  assert.ok((await response.json()).items.every(p => p.cardPhoto === null));
});

test('serving: thumbnail of a published first photo is public; unpublished, later-photo, unknown and malformed keys are 404', async t => {
  const { publicEnv, privateEnv, call, derive } = await setup(t);
  derive(ORIGINAL, THUMB);
  derive(SECOND, SECOND_THUMB); // second photo of published P-2
  derive(DRAFT, DRAFT_THUMB); // first photo of an unpublished draft
  assert.equal((await call(publicEnv, THUMB)).status, 200);
  assert.equal((await call(publicEnv, THUMB)).headers.get('Content-Type'), 'image/webp');
  assert.equal((await call(publicEnv, DRAFT_THUMB)).status, 404, 'unpublished product: no leak through the thumbnail');
  assert.equal((await call(publicEnv, SECOND_THUMB)).status, 404, 'only the FIRST photo is exposed as a thumbnail');
  assert.equal((await call(publicEnv, '/media/eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee-5555555555555555.card.webp')).status, 404, 'unknown key');
  assert.equal((await call(publicEnv, '/media/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa-1111111111111111.card.png')).status, 404, 'wrong extension');
  assert.equal((await call(publicEnv, '/media/..%2Fx.card.webp')).status, 404);
  assert.equal((await call(publicEnv, '/media/aaaaaaaa-0000-4000-8000-000000000001.card.webp')).status, 404, 'old key shape is no longer accepted');
  assert.equal((await call(privateEnv, '/media/aaaaaaaa-0000-4000-8000-000000000001.card.webp')).status, 404, 'not even for staff');
  assert.equal((await call(publicEnv, DRAFT)).status, 404, 'existing original rule unchanged');
  assert.equal((await call(publicEnv, ORIGINAL)).status, 200);
  assert.equal((await call(privateEnv, DRAFT_THUMB)).status, 200, 'staff/Access identity keeps reading private media');
});

test('serving: unpublishing the product or changing its first photo withdraws the thumbnail', async t => {
  const { publicEnv, call, admin, ids, derive } = await setup(t);
  derive(ORIGINAL, THUMB);
  assert.equal((await call(publicEnv, THUMB)).status, 200);
  await admin(`/products/${ids['P-1']}`, { method: 'PATCH', body: { photos: ['https://img.test/second.jpg', ORIGINAL] } });
  assert.equal((await call(publicEnv, THUMB)).status, 404, 'the source is no longer the first photo');
  await admin(`/products/${ids['P-1']}`, { method: 'PATCH', body: { photos: [ORIGINAL] } });
  assert.equal((await call(publicEnv, THUMB)).status, 200);
  await admin(`/products/${ids['P-1']}`, { method: 'PATCH', body: { published: false } });
  assert.equal((await call(publicEnv, THUMB)).status, 404);
});

test('managers cannot attach a thumbnail key as a product photo', async t => {
  const { admin, ids } = await setup(t);
  const response = await admin(`/products/${ids['D-1']}`, { method: 'PATCH', body: { photos: [THUMB] } });
  assert.equal(response.status, 400);
});

const spy = env => { const seen = []; return { seen, env: { ...env, DB: { ...env.DB, prepare: sql => { seen.push(sql); return env.DB.prepare(sql); } } } }; };

test('serving: a miss is answered from the indexed derivative lookup alone, with no product or catalog read', async t => {
  const { publicEnv, call, derive } = await setup(t);
  derive(ORIGINAL, THUMB);
  const miss = spy(publicEnv);
  assert.equal((await call(miss.env, '/media/' + 'e'.repeat(32) + '-' + '5'.repeat(16) + '.card.webp')).status, 404);
  assert.ok(miss.seen.length >= 1 && miss.seen.some(sql => /FROM photo_derivatives/.test(sql)) && miss.seen.every(sql => !/FROM products|JOIN suppliers/.test(sql)), miss.seen.join(' | '));
  const hit = spy(publicEnv);
  assert.equal((await call(hit.env, THUMB)).status, 200);
  assert.ok(!hit.seen.some(sql => /ORDER BY p\.updated_at/.test(sql) && !/IN \(/.test(sql)), 'a hit never loads the whole public catalog');
});

test('serving: an overlay with an empty photo list means no first photo, so the source thumbnail is withdrawn', async t => {
  const { publicEnv, call, db, ids, derive } = await setup(t);
  derive(ORIGINAL, THUMB);
  assert.equal((await call(publicEnv, THUMB)).status, 200);
  db.sqlite.prepare("UPDATE products SET overrides_json=json_set(overrides_json,'$.photos',json('[]')) WHERE id=?").run(ids['P-1']);
  assert.equal((await call(publicEnv, THUMB)).status, 404);
});

test('serving: a non-primary member of a duplicate group does not expose its own thumbnail; the shown product does', async t => {
  const { publicEnv, call, admin, ids, db, derive } = await setup(t);
  const other = (await (await admin('/suppliers', { method: 'POST', body: { name: 'Synthetic Two', url: 'https://mydrop.com.ua/synthetic_two' } })).json()).id;
  await admin(`/suppliers/${other}/import`, { method: 'POST', body: { items: [item('P-3', ['https://img.test/p3.jpg'])] } });
  const p3 = db.sqlite.prepare("SELECT id FROM products WHERE external_id='P-3'").get().id;
  assert.equal((await admin(`/products/${p3}`, { method: 'PATCH', body: { published: true, markupType: 'fixed', markupValue: 50000 } })).status, 200);
  const T3 = '/media/' + 'f'.repeat(32) + '-' + '6'.repeat(16) + '.card.webp';
  derive(ORIGINAL, THUMB); derive('https://img.test/p3.jpg', T3);
  assert.equal((await admin('/duplicates/groups', { method: 'POST', body: { productIds: [ids['P-1'], p3] } })).status, 201);
  const shown = (await (await call(publicEnv, '/api/products')).json()).items.filter(p => [ORIGINAL, 'https://img.test/p3.jpg'].includes(p.photos[0]));
  assert.equal(shown.length, 1, 'the group is one storefront product');
  const [shownThumb, hiddenThumb] = shown[0].photos[0] === ORIGINAL ? [THUMB, T3] : [T3, THUMB];
  assert.equal((await call(publicEnv, shownThumb)).status, 200);
  assert.equal((await call(publicEnv, hiddenThumb)).status, 404);
});
