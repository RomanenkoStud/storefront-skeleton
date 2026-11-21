// storefront image overrides (rack + poster slots), the public /media/storefront rule and the sale banner.
// Synthetic in-memory D1 and R2 only; nothing touches live data.
import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { readFileSync, readdirSync } from 'node:fs';
import worker from '../../apps/api/src/index.js';
import { ADMIN_ROUTES } from '../../apps/api/src/permissions.js';
import { validateBanner, normalizeBanner, activeBanner } from '../../apps/api/src/storefront-settings.js';

const dir = new URL('../../migrations/', import.meta.url);
const HOST = 'http://localhost';
const PNG_SIG = [137, 80, 78, 71, 13, 10, 26, 10];
const be = n => [n >>> 24, (n >>> 16) & 255, (n >>> 8) & 255, n & 255];
const chunk = (name, data = []) => [...be(data.length), ...[...name].map(c => c.charCodeAt(0)), ...data, 0, 0, 0, 0];
const png = (w = 500, h = 700, colorType = 6) => new Uint8Array([...PNG_SIG, ...chunk('IHDR', [...be(w), ...be(h), 8, colorType, 0, 0, 0]), ...chunk('IDAT', [1]), ...chunk('IEND')]);

function setup(t, { migrate = true } = {}) {
  const sqlite = new DatabaseSync(':memory:');
  for (const f of readdirSync(dir).filter(n => /^\d{4}_.*\.sql$/.test(n)).sort()) if (migrate || f !== '0025_storefront_images.sql') sqlite.exec(readFileSync(new URL(f, dir), 'utf8'));
  t.after(() => sqlite.close());
  let failNext = false;
  const wrap = (sql, bindings = []) => ({ sql, bindings, bind(...v) { return wrap(sql, v); }, async first() { return sqlite.prepare(sql).get(...bindings) ?? null; }, async all() { return { results: sqlite.prepare(sql).all(...bindings) }; }, async run() { const r = sqlite.prepare(sql).run(...bindings); return { meta: { changes: Number(r.changes) } }; } });
  const DB = { prepare: sql => wrap(sql), async batch(statements) {
    if (failNext) { failNext = false; throw new Error('D1 unavailable'); }
    sqlite.exec('BEGIN');
    try { const out = statements.map(s => ({ meta: { changes: Number(sqlite.prepare(s.sql).run(...s.bindings).changes) } })); sqlite.exec('COMMIT'); return out; } catch (e) { sqlite.exec('ROLLBACK'); throw e; }
  } };
  const store = new Map();
  const MEDIA = { async put(k, v, o) { store.set(k, { body: v, httpMetadata: o?.httpMetadata }); }, async get(k) { return store.get(k) ?? null; }, async delete(k) { store.delete(k); } };
  const call = async (path, { method = 'GET', body, role, form, env = {} } = {}) => {
    const h = { Origin: HOST, 'CF-Connecting-IP': '203.0.113.7' };
    let payload;
    if (form) payload = form; else if (body !== undefined) { h['Content-Type'] = 'application/json'; payload = JSON.stringify(body); }
    const e = { DB, MEDIA, APP_ENV: 'development', CUSTOMER_AUTH_HMAC_KEY: 'k', ...(role ? { AUTH_DEV_BYPASS: 'true', DEV_STAFF_ROLE: role } : {}), ...env };
    const r = await worker.fetch(new Request(HOST + path, { method, headers: h, body: payload }), e);
    const type = r.headers.get('Content-Type') || '';
    return { status: r.status, headers: r.headers, data: type.includes('json') ? await r.json() : await r.arrayBuffer() };
  };
  const put = (bytes, categoryId = 'zip-hoodies', slot = 'front', role = 'owner') => {
    const form = new FormData(); form.set('file', new File([bytes], 'a.png', { type: 'image/png' }));
    if (categoryId !== null) form.set('categoryId', categoryId); if (slot !== null) form.set('slot', slot);
    return call('/api/admin/storefront/images', { method: 'PUT', form, role });
  };
  const rows = () => sqlite.prepare('SELECT * FROM storefront_images ORDER BY category_id,slot').all();
  const audits = a => sqlite.prepare('SELECT * FROM audit_events WHERE action=? ORDER BY rowid').all(a);
  return { sqlite, call, put, rows, audits, store, failBatch: () => { failNext = true; } };
}

test('routes are owner-only', () => {
  for (const id of ['storefront.banner', 'storefront.images.set', 'storefront.images.reset']) assert.equal(ADMIN_ROUTES.find(r => r.id === id)?.permission, 'settings.manage', id);
});

test('set, replace and reset a slot; public projection and media rule', async t => {
  const a = setup(t);
  const first = await a.put(png(500, 700));
  assert.equal(first.status, 200, JSON.stringify(first.data));
  assert.equal(first.data.image.slot, 'front');
  assert.match(first.data.image.src, /^\/media\/storefront\/[0-9a-f-]{36}\.png$/);
  const key1 = first.data.image.src.slice(7);
  assert.ok(a.store.has(key1));
  const anon = await a.call(first.data.image.src);
  assert.equal(anon.status, 200);
  assert.equal(anon.headers.get('Cache-Control'), 'public, max-age=3600');
  // Replace: one row, new key, old file gone and no longer public.
  const second = await a.put(png(300, 600));
  assert.equal(second.status, 200);
  assert.equal(a.rows().length, 1);
  assert.ok(!a.store.has(key1), 'replaced file deleted');
  assert.equal((await a.call(first.data.image.src)).status, 404);
  await a.put(png(200, 200), 'sneakers', 'shoe');
  await a.put(png(400, 400), 'zip-hoodies', 'poster');
  const pub = (await a.call('/api/storefront')).data;
  assert.deepEqual(Object.keys(pub.storefrontImages).sort(), ['sneakers', 'zip-hoodies']);
  assert.deepEqual(pub.storefrontImages['zip-hoodies'].front, { src: second.data.image.src, w: 300, h: 600 });
  assert.deepEqual(Object.keys(pub.storefrontImages['zip-hoodies'].poster), ['src', 'w', 'h'], 'public payload is src/w/h only');
  assert.equal(pub.banner, null, 'banner is off by default');
  const admin = (await a.call('/api/admin/storefront', { role: 'owner' })).data;
  assert.equal(admin.images.length, 3);
  assert.deepEqual(admin.banner, normalizeBanner(null));
  assert.equal(a.audits('storefront.image.set').length, 4);
  // Reset back to the shipped render.
  const reset = await a.call('/api/admin/storefront/images/zip-hoodies/front', { method: 'DELETE', role: 'owner' });
  assert.equal(reset.status, 200);
  assert.equal(a.rows().filter(r => r.slot === 'front').length, 0);
  assert.equal((await a.call(second.data.image.src)).status, 404);
  assert.equal(a.audits('storefront.image.reset').length, 1);
  assert.equal((await a.call('/api/admin/storefront/images/zip-hoodies/front', { method: 'DELETE', role: 'owner' })).status, 404);
});

test('upload validation and permissions', async t => {
  const a = setup(t);
  assert.equal((await a.put(png(), 'zip-hoodies', 'front', 'manager')).status, 403, 'managers cannot change storefront images');
  assert.equal((await a.put(png(), 'zip-hoodies', 'back')).status, 400, 'unknown slot');
  assert.equal((await a.put(png(), 'no-such-category')).status, 400);
  assert.equal((await a.put(png(), null)).status, 400);
  assert.equal((await a.put(png(500, 700, 2))).status, 415, 'needs transparency');
  assert.equal((await a.put(png(20, 700))).status, 400, 'too small');
  assert.equal((await a.put(new Uint8Array([1, 2, 3, 4]))).status, 415);
  assert.equal(a.rows().length, 0);
  assert.equal(a.store.size, 0);
  a.failBatch();
  await assert.rejects(async () => { const r = await a.put(png()); if (r.status >= 500) throw new Error(String(r.status)); }, /5\d\d/);
  assert.equal(a.store.size, 0, 'file removed when the row was not written');
});

test('database without migration 0025 behaves like no overrides', async t => {
  const a = setup(t, { migrate: false });
  const pub = (await a.call('/api/storefront')).data;
  assert.deepEqual(pub.storefrontImages, {});
  assert.deepEqual((await a.call('/api/admin/storefront', { role: 'owner' })).data.images, []);
  assert.equal((await a.put(png())).status, 503);
  assert.equal(a.store.size, 0);
});

test('banner validation and active window', async t => {
  assert.throws(() => validateBanner({ enabled: true, text: '' }), /text/);
  assert.throws(() => validateBanner({ enabled: true, text: 'x', linkHref: 'https://evil.example', linkLabel: 'go' }), /Link/);
  assert.throws(() => validateBanner({ enabled: true, text: 'x', linkHref: '//evil.example', linkLabel: 'go' }), /Link/);
  assert.throws(() => validateBanner({ enabled: true, text: 'x', linkHref: '/sale' }), /both/);
  assert.throws(() => validateBanner({ enabled: true, text: 'x'.repeat(91) }), /90/);
  assert.throws(() => validateBanner({ enabled: true, text: 'x', startsAt: '2026-11-28T00:00:00Z', endsAt: '2026-11-27T00:00:00Z' }), /end after/);
  assert.throws(() => validateBanner({ enabled: true, text: 'x', color: 'red' }), /Unknown field/);
  const b = validateBanner({ enabled: true, text: '  BLACK  FRIDAY: безкоштовна доставка ', linkLabel: 'Дивитись', linkHref: '/?available=1#catalog', startsAt: '2026-11-27T00:00:00+02:00', endsAt: '2026-12-01T00:00:00+02:00' });
  assert.equal(b.text, 'BLACK FRIDAY: безкоштовна доставка');
  assert.equal(b.startsAt, '2026-11-26T22:00:00.000Z');
  assert.equal(activeBanner(b, new Date('2026-11-26T21:59:59Z')), null, 'before start');
  assert.deepEqual(activeBanner(b, new Date('2026-11-28T12:00:00Z')), { text: b.text, linkLabel: 'Дивитись', linkHref: '/?available=1#catalog', endsAt: '2026-11-30T22:00:00.000Z' });
  assert.equal(activeBanner(b, new Date('2026-11-30T22:00:00Z')), null, 'end is exclusive');
  assert.equal(activeBanner({ ...b, enabled: false }, new Date('2026-11-28T12:00:00Z')), null);
  assert.equal(normalizeBanner({ enabled: true, text: 'x', linkHref: 'javascript:alert(1)', linkLabel: 'x' }).linkHref, '', 'stored bad links are dropped');

  const a = setup(t);
  assert.equal((await a.call('/api/admin/storefront/banner', { method: 'PUT', role: 'manager', body: { enabled: true, text: 'x' } })).status, 403);
  const saved = await a.call('/api/admin/storefront/banner', { method: 'PUT', role: 'owner', body: { enabled: true, text: 'Безкоштовна доставка' } });
  assert.equal(saved.status, 200, JSON.stringify(saved.data));
  assert.deepEqual((await a.call('/api/storefront')).data.banner, { text: 'Безкоштовна доставка', linkLabel: '', linkHref: '' });
  assert.equal(a.audits('storefront.banner').length, 1);
});
