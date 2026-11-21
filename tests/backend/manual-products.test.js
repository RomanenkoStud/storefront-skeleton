import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { readFileSync, readdirSync } from 'node:fs';
import worker from '../../apps/api/src/index.js';
import { randomBytes, createHash } from 'node:crypto';
import { photoUrl } from '../../apps/api/src/domain.js';

// Own in-memory D1 stand-in built from the migrations (never a live database) and a mocked R2 bucket.
const dir = new URL('../../migrations/', import.meta.url);
const files = readdirSync(dir).filter(name => /^\d{4}_.*\.sql$/.test(name)).sort();
function wrapDb(sqlite) {
  const wrap = (sql, bindings = []) => ({ sql, bindings, bind(...v) { return wrap(sql, v); }, async first() { return sqlite.prepare(sql).get(...bindings) ?? null; }, async all() { return { results: sqlite.prepare(sql).all(...bindings) }; }, async run() { return sqlite.prepare(sql).run(...bindings); } });
  return { sqlite, prepare: sql => wrap(sql), async batch(statements) { sqlite.exec('BEGIN'); try { const r = statements.map(s => sqlite.prepare(s.sql).run(...s.bindings)); sqlite.exec('COMMIT'); return r; } catch (e) { sqlite.exec('ROLLBACK'); throw e; } }, close: () => sqlite.close() };
}
function database() {
  const sqlite = new DatabaseSync(':memory:');
  for (const name of files) sqlite.exec(readFileSync(new URL(name, dir), 'utf8'));
  return wrapDb(sqlite);
}
function bucket() {
  const objects = new Map();
  return { objects, async put(key, bytes, options) { objects.set(key, { bytes, ...options }); }, async head(key) { return objects.get(key) ?? null; }, async get(key) { const o = objects.get(key); return o ? { body: new Response(o.bytes).body, httpMetadata: o.httpMetadata, customMetadata: o.customMetadata } : null; } };
}
const PNG = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10, 0, 0, 0, 13, 73, 72, 68, 82]);
const ORIGIN = 'http://localhost';

async function setup(t, { media = true } = {}) {
  const db = database(), MEDIA = media ? bucket() : undefined, outbound = [], original = globalThis.fetch;
  globalThis.fetch = async url => { outbound.push(String(url)); throw new Error('no network in tests'); };
  t.after(() => { globalThis.fetch = original; db.close(); });
  const base = { DB: db, MEDIA, APP_ENV: 'development', AUTH_DEV_BYPASS: 'true', MYDROP_API_KEY: 'k' };
  const envs = { owner: { ...base, DEV_STAFF_ROLE: 'owner' }, manager: { ...base, DEV_STAFF_ROLE: 'manager' }, anon: { DB: db, MEDIA, APP_ENV: 'production', CF_ACCESS_TEAM_NAME: 'your-team', CF_ACCESS_AUD: 'catalog-audience' } };
  async function call(who, path, method = 'GET', body, { origin = ORIGIN, headers = {}, raw } = {}) {
    const h = { ...headers }; if (origin) h.Origin = origin;
    if (body !== undefined && !raw) h['Content-Type'] = 'application/json';
    const response = await worker.fetch(new Request(`http://localhost${path}`, { method, headers: h, body: raw ?? (body === undefined ? undefined : JSON.stringify(body)) }), envs[who]);
    const type = response.headers.get('Content-Type') || '';
    return { status: response.status, data: type.includes('json') ? await response.json() : await response.text() };
  }
  const upload = (who, productId, file, name = 'p.png') => { const form = new FormData(); if (file) form.set('file', new File([file], name)); return call(who, `/api/admin/products/${productId}/photos`, 'POST', undefined, { raw: form }); };
  const manual = (await call('manager', '/api/admin/suppliers/manual', 'POST', { name: 'Own stock' })).data;
  return { db, call, upload, envs, outbound, manual, MEDIA };
}
const good = supplierId => ({ supplierId, title: 'Куртка', description: 'Опис', category: 'Куртки', priceMinor: 150000, costMinor: 100000, variants: [{ size: 'S', stock: 2 }, { size: 'M', stock: 0 }] });
const revision = ctx => ctx.db.sqlite.prepare('SELECT catalog_revision r FROM recognition_state WHERE id=1').get().r;

test('migration 0018 keeps every row, indexes, triggers and foreign keys on a populated database', () => {
  const sqlite = new DatabaseSync(':memory:');
  for (const name of files.filter(n => n < '0018')) sqlite.exec(readFileSync(new URL(name, dir), 'utf8'));
  sqlite.exec(`INSERT INTO suppliers(id,name,url,enabled,created_at,connection_id,last_api_request_at,provider) VALUES('s1','MD','https://mydrop.com.ua/a',1,'t','123',99,'mydrop');
    INSERT INTO suppliers(id,name,url,enabled,created_at,provider,feed_key,feed_pid,feed_updated_at) VALUES('s2','ED','easydrop:s2',1,'t','easydrop','999','7','t');
    INSERT INTO products(id,supplier_id,external_id,source_json,slug,updated_at) VALUES('p1','s1','e1','{}','p-1','t'),('p2','s2','e2','{}','p-2','t');
    INSERT INTO sync_runs(id,supplier_id,status,created_at) VALUES('r1','s1','synced','t');
    INSERT INTO carts(id,code,status,item_count,total_minor,created_at,updated_at,status_changed_at) VALUES('c1','CODE12345678','submitted',1,100,'t','t','t');`);
  const count = sql => sqlite.prepare(sql).get().n, before = { suppliers: count('SELECT count(*) n FROM suppliers'), rev: count('SELECT catalog_revision n FROM recognition_state') };
  assert.throws(() => sqlite.exec("INSERT INTO suppliers(id,name,url,created_at,provider) VALUES('x','M','manual:x','t','manual')"), /CHECK/);
  sqlite.exec('BEGIN'); sqlite.exec(readFileSync(new URL('0018_manual_supplier.sql', dir), 'utf8')); sqlite.exec('COMMIT');
  assert.equal(count('SELECT count(*) n FROM suppliers'), before.suppliers);
  assert.equal(count('SELECT count(*) n FROM products'), 2); assert.equal(count('SELECT count(*) n FROM sync_runs'), 1); assert.equal(count('SELECT count(*) n FROM carts'), 1);
  assert.deepEqual(sqlite.prepare('PRAGMA foreign_key_check').all(), []);
  assert.equal(count('SELECT catalog_revision n FROM recognition_state'), before.rev, 'the copy does not bump the revision');
  assert.deepEqual(sqlite.prepare("SELECT connection_id,last_api_request_at,feed_key,feed_pid FROM suppliers WHERE id IN ('s1','s2') ORDER BY id").all().map(r => ({ ...r })), [{ connection_id: '123', last_api_request_at: 99, feed_key: null, feed_pid: null }, { connection_id: null, last_api_request_at: null, feed_key: '999', feed_pid: '7' }]);
  const objects = sqlite.prepare("SELECT type,name FROM sqlite_master WHERE tbl_name='suppliers' AND name NOT LIKE 'sqlite_%' ORDER BY name").all().map(r => r.name);
  assert.deepEqual(objects, ['recognition_suppliers_delete', 'recognition_suppliers_insert', 'recognition_suppliers_update', 'suppliers', 'suppliers_deleted', 'suppliers_easydrop_key']);
  assert.ok(!sqlite.prepare("SELECT name FROM sqlite_master WHERE name LIKE 'suppliers_%' AND name NOT IN ('suppliers_deleted','suppliers_easydrop_key')").all().length, 'no leftover helper tables');
  assert.match(sqlite.prepare("SELECT sql FROM sqlite_master WHERE name='products'").get().sql, /REFERENCES suppliers\(id\)/);
  assert.match(sqlite.prepare("SELECT sql FROM sqlite_master WHERE name='sync_runs'").get().sql, /REFERENCES suppliers\(id\)/);
  sqlite.exec("UPDATE suppliers SET name='MD2' WHERE id='s1'");
  assert.equal(count('SELECT catalog_revision n FROM recognition_state'), before.rev + 1, 'supplier trigger still bumps the revision');
  sqlite.exec("INSERT INTO suppliers(id,name,url,created_at,provider) VALUES('s3','M','manual:s3','t','manual')");
  assert.equal(count('SELECT catalog_revision n FROM recognition_state'), before.rev + 2);
  assert.throws(() => sqlite.exec("INSERT INTO suppliers(id,name,url,created_at,provider) VALUES('s4','M','manual:s4','t','bogus')"), /CHECK/);
  assert.throws(() => sqlite.exec("INSERT INTO suppliers(id,name,url,created_at,provider,feed_key) VALUES('s5','E','easydrop:s5','t','easydrop','999')"), /UNIQUE/, 'easydrop key index survives');
  assert.throws(() => sqlite.exec("INSERT INTO products(id,supplier_id,external_id,source_json,slug,updated_at) VALUES('p9','nope','e','{}','p-9','t')"), /FOREIGN KEY/);
});

test('permissions: manager creates manual suppliers and products; anonymous, customer cookie and cross-origin are refused; suppliers.manage stays owner-only', async t => {
  const ctx = await setup(t), supplier = ctx.manual;
  assert.deepEqual({ provider: supplier.provider, url: supplier.url, feed: supplier.feed, connectionId: supplier.connectionId, enabled: supplier.enabled }, { provider: 'manual', url: `manual:${supplier.id}`, feed: null, connectionId: null, enabled: true });
  const before = JSON.stringify(ctx.db.sqlite.prepare('SELECT * FROM suppliers').all());
  for (const [path, method, body] of [['/api/admin/suppliers/manual', 'POST', { name: 'X' }], ['/api/admin/products', 'POST', good(supplier.id)]]) {
    assert.equal((await ctx.call('anon', path, method, body)).status, 401);
    assert.equal((await ctx.call('anon', path, method, body, { headers: { Cookie: '__Host-ls_session=abc; __Host-ls_staff=abc' } })).status, 401);
    assert.equal((await ctx.call('manager', path, method, body, { origin: 'https://evil.test' })).status, 403);
    assert.equal((await ctx.call('manager', path, method, body, { origin: null })).status, 403);
  }
  assert.equal(JSON.stringify(ctx.db.sqlite.prepare('SELECT * FROM suppliers').all()), before);
  assert.equal(ctx.db.sqlite.prepare('SELECT count(*) n FROM products').get().n, 0);
  assert.equal((await ctx.call('manager', `/api/admin/suppliers/${supplier.id}`, 'PATCH', { name: 'Renamed' })).status, 403);
  assert.equal((await ctx.call('manager', `/api/admin/suppliers/${supplier.id}`, 'DELETE', { confirm: true })).status, 403);
  assert.equal((await ctx.call('manager', '/api/admin/suppliers', 'POST', { provider: 'manual', name: 'X' })).status, 403);
  assert.equal((await ctx.call('owner', '/api/admin/suppliers', 'POST', { provider: 'manual', name: 'X' })).status, 400);
  assert.equal((await ctx.call('owner', `/api/admin/suppliers/${supplier.id}`, 'PATCH', { name: 'Renamed', enabled: true })).data.name, 'Renamed');
  const audit = ctx.db.sqlite.prepare("SELECT actor_role FROM audit_events WHERE action='supplier.create'").all();
  assert.equal(audit.length, 1); assert.equal(audit[0].actor_role, 'manager');
  assert.equal((await ctx.call('manager', '/api/admin/suppliers/manual', 'POST', { name: 'X', url: 'https://mydrop.com.ua/x' })).status, 400);
  assert.equal((await ctx.call('manager', '/api/admin/suppliers/manual', 'POST', { name: ' ' })).status, 400);
  assert.equal((await ctx.call('manager', '/api/admin/suppliers/manual', 'POST', { name: 'X', enabled: 'no' })).status, 400);
});

test('owner-only edits on a manual supplier accept only name and enabled; Trash and restore work', async t => {
  const ctx = await setup(t), url = `/api/admin/suppliers/${ctx.manual.id}`;
  for (const body of [{ connectionId: '12' }, { feedUrl: 'https://easydrop.one/prom-export?key=1' }, { provider: 'mydrop' }]) assert.equal((await ctx.call('owner', url, 'PATCH', body)).status, 400, JSON.stringify(body));
  assert.equal((await ctx.call('owner', url, 'PATCH', { enabled: false })).data.enabled, false);
  assert.equal((await ctx.call('owner', url, 'DELETE', { confirm: true })).status, 200);
  assert.equal((await ctx.call('owner', `${url}/restore`, 'POST', {})).data.provider, 'manual');
});

test('create product: server-computed price, generated ids, unpublished, audited, catalog revision bumps', async t => {
  const ctx = await setup(t), revBefore = revision(ctx);
  const created = await ctx.call('manager', '/api/admin/products', 'POST', { ...good(ctx.manual.id), categoryId: 'jackets', brand: ' Lorem ', photos: [] });
  assert.equal(created.status, 201, JSON.stringify(created.data));
  const product = created.data;
  assert.equal(product.priceMinor, 150000); assert.equal(product.published, false); assert.equal(product.supplierId, ctx.manual.id);
  assert.match(product.externalId, /^m-[a-f0-9]{16}$/);
  assert.deepEqual(product.source.variants.map(v => [v.id, v.size, v.stock]), [['v-s', 'S', 2], ['v-m', 'M', 0]]);
  assert.equal(product.source.costMinor, 100000); assert.equal(product.source.currency, 'UAH');
  assert.deepEqual(product.overrides, { markupType: 'fixed', markupValue: 50000, categoryId: 'jackets', brand: 'Lorem' });
  assert.equal(product.categoryId, 'jackets'); assert.match(product.slug, /-[0-9a-f-]{36}$/);
  assert.ok(revision(ctx) > revBefore);
  assert.equal(ctx.db.sqlite.prepare("SELECT count(*) n FROM audit_events WHERE action='product.create' AND resource_id=?").get(product.id).n, 1);
  assert.equal(ctx.db.sqlite.prepare('SELECT count(*) n FROM sync_runs').get().n, 0);
  const defaulted = (await ctx.call('manager', '/api/admin/products', 'POST', { supplierId: ctx.manual.id, title: 'T', priceMinor: 999, variants: [{ size: 'Один розмір', stock: 1 }, { size: '42/43', stock: 1 }] })).data;
  assert.equal(defaulted.source.costMinor, 999); assert.deepEqual(defaulted.overrides, { markupType: 'fixed', markupValue: 0 });
  assert.deepEqual(defaulted.source.variants.map(v => v.id), ['v-один-розмір', 'v-42-43']);
  const listed = (await ctx.call('manager', '/api/admin/products')).data.items.map(p => p.id);
  assert.ok(listed.includes(product.id));
});

test('create product validation: unknown fields, minor units, price below cost, variants, supplier rules', async t => {
  const ctx = await setup(t), id = ctx.manual.id;
  const post = body => ctx.call('manager', '/api/admin/products', 'POST', body);
  const bad = [
    { ...good(id), published: true }, { ...good(id), externalId: 'x' }, { ...good(id), priceMinor: 1500.5 }, { ...good(id), priceMinor: '1500' }, { ...good(id), costMinor: 10.5 },
    { ...good(id), priceMinor: 99999, costMinor: 100000 }, { ...good(id), priceMinor: 0, costMinor: 0 }, { ...good(id), priceMinor: -1 }, { ...good(id), title: '  ' }, { ...good(id), title: undefined },
    { ...good(id), variants: [] }, { ...good(id), variants: [{ size: 'S', stock: 1 }, { size: 'S', stock: 2 }] }, { ...good(id), variants: [{ size: 'S', stock: -1 }] }, { ...good(id), variants: [{ size: 'S', stock: 1.5 }] },
    { ...good(id), variants: [{ size: 'S', stock: 1, id: 'x' }] }, { ...good(id), photos: ['http://insecure.example/a.jpg'] }, { ...good(id), photos: 'x' }, { ...good(id), categoryId: 'no-such-category' },
    { ...good(id), supplierId: undefined }, { ...good(id), supplierId: 5 }
  ];
  for (const body of bad) assert.equal((await post(body)).status, 400, JSON.stringify(body));
  assert.equal((await post({ ...good('missing') })).status, 404);
  const mydrop = (await ctx.call('owner', '/api/admin/suppliers', 'POST', { name: 'Demo', url: 'https://mydrop.com.ua/seg', connectionId: '1' })).data;
  assert.equal((await post(good(mydrop.id))).status, 409);
  assert.equal((await ctx.call('owner', `/api/admin/suppliers/${id}`, 'DELETE', { confirm: true })).status, 200);
  assert.equal((await post(good(id))).status, 409, 'supplier in Trash');
  assert.equal(ctx.db.sqlite.prepare('SELECT count(*) n FROM products').get().n, 0);
});

test('manual suppliers have no feed: sync and import return 409 without a run, fetch or cooldown claim; cron and sync-connected skip them', async t => {
  const ctx = await setup(t), id = ctx.manual.id;
  for (const who of ['owner', 'manager']) {
    const sync = await ctx.call(who, `/api/admin/suppliers/${id}/sync`, 'POST', {});
    assert.equal(sync.status, 409); assert.deepEqual(sync.data, { error: 'Manual suppliers have no feed to sync' });
    const imported = await ctx.call(who, `/api/admin/suppliers/${id}/import`, 'POST', { items: [{ externalId: 'x', title: 'T', costMinor: 1, currency: 'UAH', photos: [], variants: [{ id: 'a', size: 'S', stock: 1 }] }] });
    assert.equal(imported.status, 409); assert.deepEqual(imported.data, { error: 'Manual suppliers have no feed to sync' });
  }
  await ctx.call('owner', `/api/admin/suppliers/${id}`, 'PATCH', { enabled: false });
  assert.equal((await ctx.call('owner', `/api/admin/suppliers/${id}/sync`, 'POST', {})).status, 409, 'refused before the disabled check');
  assert.equal(ctx.db.sqlite.prepare('SELECT count(*) n FROM sync_runs').get().n, 0);
  assert.equal(ctx.db.sqlite.prepare('SELECT count(*) n FROM products').get().n, 0);
  assert.equal(ctx.db.sqlite.prepare('SELECT last_api_request_at a, last_sync_at s FROM suppliers WHERE id=?').get(id).a, null);
  await ctx.call('owner', `/api/admin/suppliers/${id}`, 'PATCH', { enabled: true });
  const pending = [];
  await worker.scheduled({}, ctx.envs.owner, { waitUntil: p => pending.push(p) }); await Promise.all(pending);
  assert.equal(ctx.db.sqlite.prepare('SELECT count(*) n FROM sync_runs').get().n, 0);
  assert.deepEqual(ctx.outbound, [], 'no outbound request for a manual supplier');
  assert.equal((await ctx.call('owner', '/api/admin/suppliers/sync-connected', 'POST', {})).status, 422, 'connected sync only talks to MyDrop (unreachable here) and never matches manual rows');
  assert.equal(ctx.db.sqlite.prepare("SELECT provider FROM suppliers WHERE id=?").get(id).provider, 'manual');
});

test('source PATCH: manual products only, stable variant ids, markup stays, publication rules, Trash', async t => {
  const ctx = await setup(t), post = (await ctx.call('manager', '/api/admin/products', 'POST', good(ctx.manual.id))).data, url = `/api/admin/products/${post.id}/source`;
  assert.equal((await ctx.call('anon', url, 'PATCH', { title: 'x' })).status, 401);
  assert.equal((await ctx.call('manager', url, 'PATCH', { title: 'x' }, { origin: 'https://evil.test' })).status, 403);
  for (const body of [{}, { published: true }, { overrides: {} }, { priceMinor: 1 }, { costMinor: 1.5 }, { title: '' }, { variants: [] }, { variants: [{ size: 'S', stock: 1 }, { size: 'S', stock: 1 }] }, { photos: ['ftp://x'] }, { currency: 'USD' }])
    assert.equal((await ctx.call('manager', url, 'PATCH', body)).status, 400, JSON.stringify(body));
  const revBefore = revision(ctx);
  const edited = await ctx.call('manager', url, 'PATCH', { title: 'Нова назва', costMinor: 120000, variants: [{ size: 'M', stock: 5 }, { size: 'L', stock: 1 }, { size: 'S', stock: 9 }] });
  assert.equal(edited.status, 200, JSON.stringify(edited.data));
  assert.deepEqual(edited.data.source.variants.map(v => [v.id, v.size, v.stock]), [['v-m', 'M', 5], ['v-l', 'L', 1], ['v-s', 'S', 9]]);
  assert.equal(edited.data.priceMinor, 120000 + 50000, 'markup stays when cost changes');
  assert.deepEqual(edited.data.overrides, post.overrides); assert.equal(edited.data.slug, post.slug); assert.equal(edited.data.published, false);
  assert.ok(revision(ctx) > revBefore);
  assert.equal(ctx.db.sqlite.prepare("SELECT count(*) n FROM audit_events WHERE action='product.source.update' AND resource_id=?").get(post.id).n, 1);
  // A published product cannot be made unpublishable through its source.
  assert.equal((await ctx.call('owner', `/api/admin/products/${post.id}`, 'PATCH', { photos: ['https://example.com/a.jpg'], published: true })).status, 200);
  assert.equal((await ctx.call('manager', url, 'PATCH', { title: 'Інша' })).status, 200);
  assert.equal((await ctx.call('manager', url, 'PATCH', { variants: [{ size: 'S', stock: 1 }] })).status, 200);
  // Non-manual product and Trash.
  const mydrop = (await ctx.call('owner', '/api/admin/suppliers', 'POST', { name: 'Demo', url: 'https://mydrop.com.ua/seg', connectionId: '1' })).data;
  await ctx.call('owner', `/api/admin/suppliers/${mydrop.id}/import`, 'POST', { items: [{ externalId: 'x', title: 'T', description: '', category: 'c', costMinor: 100, currency: 'UAH', photos: [], variants: [{ id: 'a', size: 'S', stock: 1 }] }] });
  const foreign = ctx.db.sqlite.prepare('SELECT id,source_json FROM products WHERE supplier_id=?').get(mydrop.id);
  const refused = await ctx.call('manager', `/api/admin/products/${foreign.id}/source`, 'PATCH', { title: 'Hacked' });
  assert.equal(refused.status, 409); assert.equal(ctx.db.sqlite.prepare('SELECT source_json FROM products WHERE id=?').get(foreign.id).source_json, foreign.source_json);
  assert.equal((await ctx.call('manager', '/api/admin/products/nope/source', 'PATCH', { title: 'x' })).status, 404);
  assert.equal((await ctx.call('owner', `/api/admin/products/${post.id}`, 'DELETE', { confirm: true })).status, 200);
  assert.equal((await ctx.call('manager', url, 'PATCH', { title: 'In Trash' })).status, 409, 'product in Trash');
});

test('photo upload: type sniffing, size and storage errors with stable codes, key and serving conventions', async t => {
  const ctx = await setup(t), product = (await ctx.call('manager', '/api/admin/products', 'POST', good(ctx.manual.id))).data;
  assert.equal((await ctx.upload('anon', product.id, PNG)).status, 401);
  const ok = await ctx.upload('manager', product.id, PNG);
  assert.equal(ok.status, 201); assert.match(ok.data.url, /^\/media\/[a-f0-9-]+\.png$/); assert.equal(photoUrl(ok.data.url), ok.data.url);
  const stored = ctx.MEDIA.objects.get(ok.data.url.slice('/media/'.length));
  assert.equal(stored.httpMetadata.contentType, 'image/png'); assert.deepEqual(stored.customMetadata, { productId: product.id });
  assert.ok(!('originalUrl' in stored.customMetadata) && !('cutoutUrl' in stored.customMetadata));
  assert.equal(ctx.db.sqlite.prepare("SELECT count(*) n FROM audit_events WHERE action='media.upload'").get().n, 1);
  const jpeg = await ctx.upload('manager', product.id, new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 1, 2]), 'x.jpg'); assert.match(jpeg.data.url, /\.jpg$/);
  const webp = await ctx.upload('manager', product.id, new Uint8Array([...'RIFF'].map(c => c.charCodeAt(0)).concat([1, 0, 0, 0], [...'WEBP'].map(c => c.charCodeAt(0)))), 'x.webp'); assert.match(webp.data.url, /\.webp$/);
  const text = await ctx.upload('manager', product.id, new TextEncoder().encode('<svg onload=alert(1)>'), 'x.png');
  assert.equal(text.status, 415); assert.equal(text.data.code, 'not-image');
  assert.equal((await ctx.upload('manager', product.id, null)).status, 400);
  assert.equal((await ctx.upload('manager', product.id, null)).data.code, 'missing-file');
  assert.equal((await ctx.call('manager', `/api/admin/products/${product.id}/photos`, 'POST', {})).status, 415);
  const big = new Uint8Array(20_000_001); big.set(PNG);
  const huge = await ctx.upload('manager', product.id, big); assert.equal(huge.status, 413); assert.equal(huge.data.code, 'too-large');
  assert.equal((await ctx.upload('manager', 'nope', PNG)).status, 404);
  assert.equal(ctx.MEDIA.objects.size, 3, 'rejected uploads store nothing');
  // The uploaded path is accepted for the product, readable through the admin image route and usable by the public media route only once published.
  assert.equal((await ctx.call('manager', `/api/admin/products/${product.id}/source`, 'PATCH', { photos: [ok.data.url] })).status, 200);
  const image = await worker.fetch(new Request(`http://localhost/api/admin/products/${product.id}/image?url=${encodeURIComponent(ok.data.url)}`), ctx.envs.manager);
  assert.equal(image.status, 200); assert.equal(image.headers.get('Content-Type'), 'image/png');
  assert.equal((await worker.fetch(new Request(`http://localhost${ok.data.url}`), ctx.envs.anon)).status, 404, 'private until a published product uses it');
  const without = await setup(t, { media: false }), p2 = (await without.call('manager', '/api/admin/products', 'POST', good(without.manual.id))).data;
  const unavailable = await without.upload('manager', p2.id, PNG); assert.equal(unavailable.status, 503); assert.equal(unavailable.data.code, 'storage-unavailable');
});

test('public projections never expose cost, supplier or external IDs of manual products; unpublished and disabled stay hidden', async t => {
  const ctx = await setup(t), product = (await ctx.call('manager', '/api/admin/products', 'POST', { ...good(ctx.manual.id), categoryId: 'jackets', photos: ['https://example.com/a.jpg'] })).data;
  const publicEnv = path => worker.fetch(new Request(`http://localhost${path}`), { ...ctx.envs.owner, AUTH_DEV_BYPASS: 'false', APP_ENV: 'production' });
  const list = async () => (await (await publicEnv('/api/products')).json()).items;
  assert.deepEqual(await list(), [], 'created unpublished');
  assert.equal((await publicEnv(`/products/${product.slug}`)).status, 404);
  assert.equal((await ctx.call('manager', `/api/admin/products/${product.id}`, 'PATCH', { published: true })).status, 200);
  const items = await list(); assert.equal(items.length, 1);
  const text = JSON.stringify(items);
  assert.equal(items[0].priceMinor, 150000);
  for (const secret of ['100000', product.externalId, ctx.manual.id, 'costMinor', 'supplierId', 'externalId', 'source', 'overrides']) assert.ok(!text.includes(secret), `leaked ${secret}`);
  const detail = await (await publicEnv(`/api/products/${product.slug}`)).text();
  for (const secret of [product.externalId, ctx.manual.id, 'costMinor', 'supplierId']) assert.ok(!detail.includes(secret), `detail leaked ${secret}`);
  const page = await (await publicEnv(`/products/${product.slug}`)).text();
  assert.ok(!page.includes(product.externalId) && !page.includes(ctx.manual.id));
  assert.equal((await ctx.call('owner', `/api/admin/suppliers/${ctx.manual.id}`, 'PATCH', { enabled: false })).status, 200);
  assert.deepEqual(await list(), [], 'disabled supplier hides its products');
  await ctx.call('owner', `/api/admin/suppliers/${ctx.manual.id}`, 'PATCH', { enabled: true });
  assert.equal((await ctx.call('manager', `/api/admin/products/${product.id}`, 'PATCH', { published: false })).status, 200);
  assert.deepEqual(await list(), []);
});

test('regressions: unpublishable source edit leaves source_json unchanged; staff session mount; customer cookie; products.price gate', async t => {
  const ctx = await setup(t), product = (await ctx.call('manager', '/api/admin/products', 'POST', { ...good(ctx.manual.id), photos: ['https://example.com/a.jpg'] })).data;
  assert.equal((await ctx.call('manager', `/api/admin/products/${product.id}`, 'PATCH', { published: true })).status, 200);
  const stored = () => ctx.db.sqlite.prepare('SELECT source_json FROM products WHERE id=?').get(product.id).source_json, before = stored();
  assert.equal((await ctx.call('manager', `/api/admin/products/${product.id}/source`, 'PATCH', { photos: [] })).status, 400);
  assert.equal(stored(), before);
  // Customer cookie alone is not a credential on any new route.
  for (const [path, method, body] of [['/api/admin/suppliers/manual', 'POST', { name: 'X' }], ['/api/admin/products', 'POST', good(ctx.manual.id)], [`/api/admin/products/${product.id}/source`, 'PATCH', { title: 'x' }]])
    assert.equal((await ctx.call('anon', path, method, body, { headers: { Cookie: '__Host-ls_session=' + 'a'.repeat(43) } })).status, 401, path);
  // Staff session cookie on the /api/staff/admin mount, production-style env (non-dev cookie name).
  const sqlite = ctx.db.sqlite, now = new Date().toISOString(), later = new Date(Date.now() + 3600000).toISOString(), token = randomBytes(32).toString('base64url');
  sqlite.prepare('INSERT INTO staff_members(id,role,status,invited_email,google_sub,email,display_name,created_by,created_at,updated_at,invitation_expires_at) VALUES(?,?,?,?,?,?,?,?,?,?,?)').run('st1', 'manager', 'active', null, 'sub-1', 'm@example.com', 'M', 'o', now, now, null);
  sqlite.prepare('INSERT INTO staff_sessions VALUES(?,?,?,?,?,?,?)').run(createHash('sha256').update(token).digest('hex'), 'st1', now, now, now, later, later);
  const staff = (path, method, body, raw) => worker.fetch(new Request(`http://localhost/api/staff/admin${path}`, { method, headers: { Origin: ORIGIN, Cookie: '__Host-ls_staff=' + token, ...(raw ? {} : { 'Content-Type': 'application/json' }) }, body: raw ?? JSON.stringify(body) }), ctx.envs.anon);
  const supplier = await staff('/suppliers/manual', 'POST', { name: 'Via staff' }); assert.equal(supplier.status, 201);
  const sid = (await supplier.json()).id;
  const created = await staff('/products', 'POST', good(sid)); assert.equal(created.status, 201);
  const pid = (await created.json()).id;
  assert.equal((await staff(`/products/${pid}/source`, 'PATCH', { costMinor: 120000 })).status, 200);
  const form = new FormData(); form.set('file', new File([PNG], 'p.png'));
  assert.equal((await staff(`/products/${pid}/photos`, 'POST', undefined, form)).status, 201);
  assert.equal(sqlite.prepare("SELECT actor_role r FROM audit_events WHERE action='product.create'").all().some(r => r.r === 'manager'), true);
  // products.price gates both create and cost edits (a role without it is refused with no write).
  const { withRoleMatrixForTests, ROLE_PERMISSIONS } = await import('../../apps/api/src/permissions.js');
  await withRoleMatrixForTests({ manager: ROLE_PERMISSIONS.manager.filter(p => p !== 'products.price') }, async () => {
    const count = () => sqlite.prepare('SELECT count(*) n FROM products').get().n, n = count();
    assert.equal((await ctx.call('manager', '/api/admin/products', 'POST', good(sid))).status, 403); assert.equal(count(), n);
    assert.equal((await ctx.call('manager', `/api/admin/products/${pid}/source`, 'PATCH', { costMinor: 1 })).status, 403);
    assert.equal((await ctx.call('manager', `/api/admin/products/${pid}/source`, 'PATCH', { title: 'Allowed' })).status, 200);
  });
});
