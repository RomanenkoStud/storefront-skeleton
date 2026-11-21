// Campaign pictures (ADR-0015): campaign picture library, scene id and the public /media/campaign rule.
// Synthetic in-memory D1 and R2 only; nothing touches live data.
import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { readFileSync, readdirSync } from 'node:fs';
import worker from '../../apps/api/src/index.js';
import { ADMIN_ROUTES } from '../../apps/api/src/permissions.js';
import { pictureHeader } from '../../apps/api/src/campaign-pictures.js';
import { photoUrl } from '../../apps/api/src/domain.js';

const dir = new URL('../../migrations/', import.meta.url);
const U = c => `${c.repeat(8)}-${c.repeat(4)}-${c.repeat(4)}-${c.repeat(4)}-${c.repeat(12)}`;
const HOST = 'http://localhost';
const PNG_SIG = [137, 80, 78, 71, 13, 10, 26, 10];
const be = n => [n >>> 24, (n >>> 16) & 255, (n >>> 8) & 255, n & 255];
const chunk = (name, data = []) => [...be(data.length), ...[...name].map(c => c.charCodeAt(0)), ...data, 0, 0, 0, 0];
// colorType 6 = RGBA, 2 = RGB; extra chunks go after IHDR.
const png = (w = 600, h = 800, colorType = 6, extra = [], pad = 0) => new Uint8Array([...PNG_SIG, ...chunk('IHDR', [...be(w), ...be(h), 8, colorType, 0, 0, 0]), ...extra, ...chunk('IDAT', new Array(pad).fill(1)), ...chunk('IEND')]);
const riff = (fourcc, payload) => new Uint8Array([...[..."RIFF"].map(c => c.charCodeAt(0)), 0, 0, 0, 0, ...[..."WEBP"].map(c => c.charCodeAt(0)), ...[...fourcc].map(c => c.charCodeAt(0)), payload.length, 0, 0, 0, ...payload]);
const le24 = n => [n & 255, (n >> 8) & 255, (n >> 16) & 255];
const webpX = (w, h, alpha = true) => riff('VP8X', [alpha ? 0x10 : 0, 0, 0, 0, ...le24(w - 1), ...le24(h - 1)]);
const webpL = (w, h, alpha = true) => { const bits = ((w - 1) | ((h - 1) << 14) | ((alpha ? 1 : 0) << 28)) >>> 0; return riff('VP8L', [0x2f, bits & 255, (bits >>> 8) & 255, (bits >>> 16) & 255, bits >>> 24]); };

function setup(t, { migrate = true } = {}) {
  const sqlite = new DatabaseSync(':memory:');
  for (const f of readdirSync(dir).filter(n => /^\d{4}_.*\.sql$/.test(n)).sort()) if (migrate || f !== '0023_campaign_pictures.sql') sqlite.exec(readFileSync(new URL(f, dir), 'utf8'));
  t.after(() => sqlite.close());
  let failNextInsert = false;
  const wrap = (sql, bindings = []) => ({ sql, bindings, bind(...v) { return wrap(sql, v); }, async first() { return sqlite.prepare(sql).get(...bindings) ?? null; }, async all() { return { results: sqlite.prepare(sql).all(...bindings) }; }, async run() { const r = sqlite.prepare(sql).run(...bindings); return { meta: { changes: Number(r.changes) } }; } });
  const DB = { prepare: sql => wrap(sql), async batch(statements) {
    if (failNextInsert && statements.some(s => /INSERT INTO campaign_pictures/.test(s.sql))) { failNextInsert = false; throw new Error('D1 unavailable'); }
    sqlite.exec('BEGIN');
    try { const out = statements.map(s => ({ meta: { changes: Number(sqlite.prepare(s.sql).run(...s.bindings).changes) } })); sqlite.exec('COMMIT'); return out; } catch (e) { sqlite.exec('ROLLBACK'); throw e; }
  } };
  const store = new Map(); let failDelete = false;
  const MEDIA = { async put(k, v, o) { store.set(k, { body: v, httpMetadata: o?.httpMetadata }); }, async get(k) { return store.get(k) ?? null; }, async delete(k) { if (failDelete) throw new Error('R2 down'); store.delete(k); } };
  const call = async (path, { method = 'GET', body, role, form, headers = {}, env = {}, origin = HOST } = {}) => {
    const h = { Origin: origin, 'CF-Connecting-IP': '203.0.113.7', ...headers };
    let payload;
    if (form) payload = form; else if (body !== undefined) { h['Content-Type'] = 'application/json'; payload = JSON.stringify(body); }
    const e = { DB, MEDIA, APP_ENV: 'development', CUSTOMER_AUTH_HMAC_KEY: 'k', ...(role ? { AUTH_DEV_BYPASS: 'true', DEV_STAFF_ROLE: role } : {}), ...env };
    const r = await worker.fetch(new Request(HOST + path, { method, headers: h, body: payload }), e);
    const type = r.headers.get('Content-Type') || '';
    return { status: r.status, headers: r.headers, data: type.includes('json') ? await r.json() : await r.arrayBuffer() };
  };
  const upload = (bytes, categoryId = 'zip-hoodies', { role = 'owner', name = 'a.png', type = 'image/png', ...rest } = {}) => {
    const form = new FormData(); form.set('file', new File([bytes], name, { type })); if (categoryId !== null) form.set('categoryId', categoryId);
    return call('/api/admin/storefront/pictures', { method: 'POST', form, role, ...rest });
  };
  const rows = () => sqlite.prepare('SELECT * FROM campaign_pictures ORDER BY category_id,position').all();
  const audits = a => sqlite.prepare('SELECT * FROM audit_events WHERE action=? ORDER BY rowid').all(a);
  return { sqlite, call, upload, rows, audits, store, failInsert: () => { failNextInsert = true; }, failDeletes: () => { failDelete = true; } };
}

test('migration 0023 matches ADR-0015', t => {
  const { sqlite } = setup(t);
  const cols = sqlite.prepare('PRAGMA table_info(campaign_pictures)').all().map(c => c.name);
  assert.deepEqual(cols, ['id', 'category_id', 'media_key', 'width', 'height', 'position', 'actor', 'created_at']);
  assert.ok(sqlite.prepare("PRAGMA index_list(campaign_pictures)").all().some(i => i.name === 'campaign_pictures_category'));
  const ins = (key, w, h) => sqlite.prepare("INSERT INTO campaign_pictures VALUES(?,?,?,?,?,0,'a','t')").run(key, 'c', key, w, h);
  ins('a', 64, 1600);
  assert.throws(() => ins('b', 63, 100), /CHECK/);
  assert.throws(() => ins('c', 100, 1601), /CHECK/);
  assert.throws(() => sqlite.prepare("INSERT INTO campaign_pictures VALUES('z','c','a',100,100,0,'a','t')").run(), /UNIQUE/);
});

test('header parsing: PNG, WebP VP8X/VP8L, alpha detection', () => {
  assert.deepEqual(pictureHeader(png(600, 800)), { ext: 'png', type: 'image/png', width: 600, height: 800, alpha: true });
  assert.equal(pictureHeader(png(600, 800, 2)).alpha, false);
  assert.equal(pictureHeader(png(600, 800, 2, chunk('tRNS', [0, 0, 0, 0, 0, 0]))).alpha, true, 'tRNS counts');
  assert.equal(pictureHeader(png(600, 800, 2, [], 10)).alpha, false, 'tRNS after IDAT is not looked for');
  assert.deepEqual(pictureHeader(webpX(1200, 900)), { ext: 'webp', type: 'image/webp', animated: false, width: 1200, height: 900, alpha: true });
  assert.equal(pictureHeader(webpX(100, 100, false)).alpha, false);
  assert.deepEqual(pictureHeader(webpL(640, 480)), { ext: 'webp', type: 'image/webp', width: 640, height: 480, alpha: true });
  assert.equal(pictureHeader(webpL(640, 480, false)).alpha, false);
  assert.equal(pictureHeader(new Uint8Array([0xff, 0xd8, 0xff, 0xe0, ...new Array(40).fill(0)])), null);
  assert.equal(pictureHeader(new Uint8Array(5)), null);
});

test('authorization: manager 403, owner ok, customer cookie and anonymous rejected, cross-origin refused', async t => {
  const a = setup(t);
  for (const [path, method] of [['/api/admin/storefront/pictures', 'POST'], ['/api/admin/storefront/pictures/order', 'PUT'], ['/api/admin/storefront/pictures/x', 'DELETE']]) {
    const route = ADMIN_ROUTES.find(r => r.method === method && r.pattern === path.replace('/api/admin', '').replace('/x', '/:id'));
    assert.equal(route.permission, 'settings.manage');
  }
  assert.equal((await a.upload(png(), 'zip-hoodies', { role: 'manager' })).status, 403);
  assert.equal((await a.call('/api/admin/storefront/pictures/order', { method: 'PUT', role: 'manager', body: { categoryId: 'zip-hoodies', ids: [] } })).status, 403);
  assert.equal((await a.call('/api/admin/storefront/pictures/x', { method: 'DELETE', role: 'manager' })).status, 403);
  assert.equal((await a.upload(png(), 'zip-hoodies', { role: null })).status, 401, 'anonymous');
  assert.equal((await a.upload(png(), 'zip-hoodies', { role: null, headers: { Cookie: '__Host-ls_customer=abc; ls_customer=abc' } })).status, 401, 'customer cookie is never a credential');
  assert.equal((await a.upload(png(), 'zip-hoodies', { origin: 'https://evil.example' })).status, 403, 'cross-origin mutation');
  assert.equal(a.rows().length + a.store.size, 0, 'nothing written by rejected calls');
  assert.equal((await a.upload(png())).status, 201);
});

test('upload validation: 503, 415, 413, 400 and 409 branches', async t => {
  const a = setup(t);
  assert.equal((await a.upload(png(), 'zip-hoodies', { env: { MEDIA: undefined } })).status, 503);
  assert.equal((await a.call('/api/admin/storefront/pictures', { method: 'POST', role: 'owner', body: {} })).status, 415, 'non-multipart');
  assert.equal((await a.upload(new Uint8Array([0xff, 0xd8, 0xff, 0xe0, ...new Array(60).fill(0)]), 'zip-hoodies', { name: 'a.jpg' })).status, 415, 'jpeg');
  assert.equal((await a.upload(png(600, 800, 2))).status, 415, 'png without alpha');
  assert.equal((await a.upload(webpX(600, 800, false), 'zip-hoodies', { name: 'a.webp' })).status, 415, 'webp without alpha');
  assert.equal((await a.upload(png(600, 800, 6, [], 2000000))).status, 413, 'over 2,000,000 bytes');
  assert.equal((await a.upload(png(63, 800))).status, 400);
  assert.equal((await a.upload(png(600, 1601))).status, 400);
  assert.equal((await a.upload(png(), 'no-such-category')).status, 400);
  assert.equal((await a.upload(png(), 'outerwear')).status, 400, 'parent (non-leaf) category');
  assert.equal((await a.upload(png(), null)).status, 400, 'missing categoryId');
  assert.equal(a.rows().length + a.store.size, 0);
  const ok = await a.upload(webpL(620, 900), 'zip-hoodies', { name: 'a.webp' });
  assert.equal(ok.status, 201);
  const p = ok.data.picture;
  assert.match(p.src, /^\/media\/campaign\/[a-f0-9-]{36}\.webp$/);
  assert.deepEqual([p.categoryId, p.w, p.h, p.position], ['zip-hoodies', 620, 900, 0]);
  assert.ok(a.store.has(p.src.slice('/media/'.length)));
  assert.equal(a.store.get(p.src.slice('/media/'.length)).httpMetadata.contentType, 'image/webp');
  assert.equal(JSON.parse(a.audits('storefront.picture.add')[0].details_json).src, p.src);
});

test('limits: 12 per category and 300 in total', async t => {
  const a = setup(t);
  for (let i = 0; i < 12; i++) assert.equal((await a.upload(png())).status, 201);
  assert.deepEqual(a.rows().map(r => r.position), [...Array(12).keys()]);
  const before = a.store.size;
  const r = await a.upload(png());
  assert.equal(r.status, 409);
  assert.equal(a.store.size, before, 'no orphan object on 409');
  assert.equal((await a.upload(png(), 'shorts')).status, 201, 'other categories unaffected');
  const total = setup(t);
  const ins = total.sqlite.prepare("INSERT INTO campaign_pictures VALUES(?,?,?,100,100,0,'a','t')");
  for (let i = 0; i < 300; i++) ins.run('id' + i, 'cat' + (i % 30), 'campaign/k' + i);
  assert.equal((await total.upload(png())).status, 409, '300 total');
  assert.equal(total.rows().length, 300);
});

test('D1 failure on insert deletes the R2 object; an R2 delete failure leaves a private orphan', async t => {
  const a = setup(t);
  a.failInsert();
  const r = await a.upload(png());
  assert.equal(r.status, 500);
  assert.equal(a.store.size, 0, 'object removed');
  assert.equal(a.rows().length, 0);
  assert.equal(a.audits('storefront.picture.add').length, 0);
  const ok = (await a.upload(png())).data.picture;
  a.failDeletes();
  a.sqlite.prepare("DELETE FROM campaign_pictures").run();
  const pub = await a.call(ok.src);
  assert.equal(pub.status, 404, 'object without a row is never public');
});

test('order and delete: exact id set, renumbering, audits, R2 cleanup', async t => {
  const a = setup(t);
  const ids = [];
  for (let i = 0; i < 3; i++) ids.push((await a.upload(png(600 + i, 800))).data.picture.id);
  await a.upload(png(), 'shorts');
  const order = body => a.call('/api/admin/storefront/pictures/order', { method: 'PUT', role: 'owner', body });
  assert.equal((await order({ categoryId: 'zip-hoodies', ids: ids.slice(0, 2) })).status, 409, 'subset');
  assert.equal((await order({ categoryId: 'zip-hoodies', ids: [...ids, 'extra'] })).status, 409, 'superset');
  assert.equal((await order({ categoryId: 'zip-hoodies', ids: [ids[0], ids[0], ids[1]] })).status, 409, 'duplicates');
  assert.equal((await order({ categoryId: 'zip-hoodies', ids: [...ids.slice(0, 2), a.rows().find(r => r.category_id === 'shorts').id] })).status, 409, 'foreign id');
  assert.equal((await order({ categoryId: 'zip-hoodies', ids: 'x' })).status, 400);
  const res = await order({ categoryId: 'zip-hoodies', ids: [ids[2], ids[0], ids[1]] });
  assert.equal(res.status, 200);
  assert.deepEqual(res.data.pictures.map(p => p.id), [ids[2], ids[0], ids[1]]);
  assert.deepEqual(res.data.pictures.map(p => p.position), [0, 1, 2]);
  assert.equal(a.audits('storefront.picture.order').length, 1);
  const del = await a.call('/api/admin/storefront/pictures/' + ids[2], { method: 'DELETE', role: 'owner' });
  assert.deepEqual(del.data, { deleted: ids[2] });
  assert.deepEqual(a.rows().filter(r => r.category_id === 'zip-hoodies').map(r => [r.id, r.position]), [[ids[0], 0], [ids[1], 1]]);
  assert.equal(a.store.size, 3, 'R2 object removed');
  assert.equal(JSON.parse(a.audits('storefront.picture.remove')[0].details_json).categoryId, 'zip-hoodies');
  assert.equal((await a.call('/api/admin/storefront/pictures/nope', { method: 'DELETE', role: 'owner' })).status, 404);
});

test('public serving rule and projections', async t => {
  const a = setup(t);
  const p = (await a.upload(png(620, 900))).data.picture;
  const key = p.src.slice('/media/'.length);
  const anon = await a.call(p.src);
  assert.equal(anon.status, 200);
  assert.equal(anon.headers.get('Cache-Control'), 'public, max-age=3600');
  assert.equal(anon.headers.get('Content-Type'), 'image/png');
  assert.equal((await a.call('/media/campaign/' + U('a') + '.png')).status, 404, 'unknown key');
  assert.equal((await a.call('/media/campaign/../' + key.slice(9))).status, 404);
  assert.equal((await a.call('/media/campaign/' + key.slice(9).replace('.png', '.jpg'))).status, 404, 'jpg never');
  // Access/media.read callers keep reading; they get no public cache header.
  const staff = await a.call(p.src, { role: 'owner' });
  assert.equal(staff.status, 200);
  assert.equal(staff.headers.get('Cache-Control'), 'no-store');
  // storefront projection: src/w/h only, grouped by id, no ids/actors/positions
  const pub = (await a.call('/api/storefront')).data;
  assert.deepEqual(pub.campaignPictures, { 'zip-hoodies': [{ src: p.src, w: 620, h: 900 }] });
  assert.equal(pub.campaign.sceneId, 'fan');
  // admin projection
  const adm = (await a.call('/api/admin/storefront', { role: 'manager' })).data;
  assert.equal(adm.campaign.sceneId, 'fan');
  assert.deepEqual(Object.keys(adm.pictures[0]).sort(), ['actor', 'categoryId', 'createdAt', 'h', 'id', 'position', 'src', 'w']);
  // deleting the row makes the key non-public at once
  a.sqlite.prepare('DELETE FROM campaign_pictures').run();
  assert.equal((await a.call(p.src)).status, 404);
  // a row in a category absent from the taxonomy is omitted from the public projection but listed for staff
  a.sqlite.prepare("INSERT INTO campaign_pictures VALUES('x','retired-cat','campaign/" + U('b') + ".png',100,100,0,'a','t')").run();
  assert.deepEqual((await a.call('/api/storefront')).data.campaignPictures, {});
  assert.equal((await a.call('/api/admin/storefront', { role: 'owner' })).data.pictures[0].categoryId, 'retired-cat');
  assert.equal((await a.call('/media/campaign/' + U('b') + '.png')).status, 404, 'row without object');
});

test('missing table: storefront returns {}, media is 404, nothing throws', async t => {
  const a = setup(t, { migrate: false });
  const pub = await a.call('/api/storefront');
  assert.equal(pub.status, 200);
  assert.deepEqual(pub.data.campaignPictures, {});
  assert.equal((await a.call('/media/campaign/' + U('c') + '.webp')).status, 404);
  assert.deepEqual((await a.call('/api/admin/storefront', { role: 'owner' })).data.pictures, []);
});

test('photoUrl still rejects campaign picture URLs', () => {
  assert.throws(() => photoUrl('/media/campaign/' + U('a') + '.webp'));
});

test('sceneId: omit keeps stored, explicit changes, unknown 400', async t => {
  const a = setup(t);
  const put = body => a.call('/api/admin/storefront/campaign', { method: 'PUT', role: 'owner', body });
  assert.equal((await put({ mode: 'auto', sceneId: 'rail' })).data.campaign.sceneId, 'rail');
  assert.equal((await put({ mode: 'off' })).data.campaign.sceneId, 'rail', 'stale admin tab keeps the scene');
  assert.equal(JSON.parse(a.sqlite.prepare("SELECT value_json FROM storefront_settings WHERE key='campaign'").get().value_json).sceneId, 'rail');
  assert.equal((await put({ mode: 'auto', sceneId: 'hooks' })).data.campaign.sceneId, 'hooks');
  assert.equal((await put({ mode: 'auto', sceneId: 'nope' })).status, 400);
  assert.equal((await put({ mode: 'auto', sceneId: 'floor' })).status, 400, 'unavailable');
  assert.equal((await a.call('/api/storefront')).data.campaign.sceneId, 'hooks');
  assert.equal(JSON.parse(a.audits('storefront.campaign').at(-1).details_json).sceneId, 'hooks');
  // legacy stored row without sceneId
  a.sqlite.prepare("UPDATE storefront_settings SET value_json='{\"mode\":\"auto\",\"categoryId\":null,\"excluded\":[]}' WHERE key='campaign'").run();
  assert.equal((await a.call('/api/storefront')).data.campaign.sceneId, 'fan');
  assert.equal((await put({ mode: 'auto' })).data.campaign.sceneId, 'fan');
});

test('animated WebP is rejected with 415', async t => {
  const a = setup(t);
  const animated = riff('VP8X', [0x12, 0, 0, 0, ...le24(599), ...le24(799)]); // alpha + animation flags
  assert.equal(pictureHeader(animated).animated, true);
  assert.equal((await a.upload(animated, 'zip-hoodies', { name: 'a.webp' })).status, 415);
  assert.equal(a.rows().length + a.store.size, 0);
});

test('campaign key must be a full 8-4-4-4-12 uuid', async t => {
  const a = setup(t);
  a.sqlite.prepare("INSERT INTO campaign_pictures VALUES('x','zip-hoodies',?,100,100,0,'a','t')").run('campaign/' + 'a'.repeat(36) + '.png');
  a.store.set('campaign/' + 'a'.repeat(36) + '.png', { body: new Uint8Array([1]) });
  assert.equal((await a.call('/media/campaign/' + 'a'.repeat(36) + '.png')).status, 404, 'dashes-free blob is not a uuid');
});

test('managers and anonymous callers see actor labels, owners the raw actor', async t => {
  const a = setup(t);
  await a.upload(png());
  a.sqlite.prepare("UPDATE campaign_pictures SET actor='boss@example.com'").run();
  a.sqlite.prepare("INSERT INTO storefront_settings VALUES('ticker','{\"enabled\":true,\"items\":[\"X\"]}','boss@example.com','t') ON CONFLICT(key) DO UPDATE SET actor='boss@example.com'").run();
  a.sqlite.prepare("UPDATE storefront_settings SET actor='boss@example.com'").run();
  const manager = (await a.call('/api/admin/storefront', { role: 'manager' })).data;
  assert.ok(!JSON.stringify(manager).includes('boss@example.com'), 'no raw email for managers');
  assert.equal(manager.pictures[0].actor, 'Власник (Access)');
  const owner = (await a.call('/api/admin/storefront', { role: 'owner' })).data;
  assert.equal(owner.pictures[0].actor, 'boss@example.com');
  assert.equal(owner.tickerActor, 'boss@example.com');
});

test('order and delete return 503 when the table is missing', async t => {
  const a = setup(t, { migrate: false });
  assert.equal((await a.call('/api/admin/storefront/pictures/order', { method: 'PUT', role: 'owner', body: { categoryId: 'shorts', ids: [] } })).status, 503);
  assert.equal((await a.call('/api/admin/storefront/pictures/x', { method: 'DELETE', role: 'owner' })).status, 503);
});

test('delete is atomic: audit only when a row was removed, renumber in the same batch', async t => {
  const a = setup(t);
  const ids = [];
  for (let i = 0; i < 3; i++) ids.push((await a.upload(png())).data.picture.id);
  // a failing renumber rolls the whole delete back (no row loss, no audit)
  a.sqlite.exec("CREATE TRIGGER boom BEFORE UPDATE ON campaign_pictures BEGIN SELECT RAISE(ABORT,'boom'); END");
  assert.equal((await a.call('/api/admin/storefront/pictures/' + ids[0], { method: 'DELETE', role: 'owner' })).status, 500);
  assert.equal(a.rows().length, 3);
  assert.equal(a.audits('storefront.picture.remove').length, 0);
  assert.equal(a.store.size, 3, 'object kept when D1 rolled back');
  a.sqlite.exec('DROP TRIGGER boom');
  assert.equal((await a.call('/api/admin/storefront/pictures/' + ids[0], { method: 'DELETE', role: 'owner' })).status, 200);
  assert.deepEqual(a.rows().map(r => r.position), [0, 1]);
  assert.equal(a.audits('storefront.picture.remove').length, 1);
  // a second delete of the same id (a race lost) is a 404 and writes no second audit
  assert.equal((await a.call('/api/admin/storefront/pictures/' + ids[0], { method: 'DELETE', role: 'owner' })).status, 404);
  assert.equal(a.audits('storefront.picture.remove').length, 1);
});
