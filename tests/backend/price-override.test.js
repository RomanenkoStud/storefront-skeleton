import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { readFileSync, readdirSync } from 'node:fs';
import worker from '../../apps/api/src/index.js';
import { withRoleMatrixForTests } from '../../apps/api/src/permissions.js';
import { productProjection } from '../../apps/api/src/domain.js';

// Synthetic in-memory D1 only; nothing touches live inventory.
const dir = new URL('../../migrations/', import.meta.url);
function database() {
  const sqlite = new DatabaseSync(':memory:');
  for (const f of readdirSync(dir).filter(n => /^\d{4}_.*\.sql$/.test(n)).sort()) sqlite.exec(readFileSync(new URL(f, dir), 'utf8'));
  const wrap = (sql, bindings = []) => ({ sql, bindings, bind(...v) { return wrap(sql, v); }, async first() { return sqlite.prepare(sql).get(...bindings) ?? null; }, async all() { return { results: sqlite.prepare(sql).all(...bindings) }; }, async run() { return sqlite.prepare(sql).run(...bindings); } });
  return { sqlite, prepare: sql => wrap(sql), async batch(st) { sqlite.exec('BEGIN'); try { const r = st.map(s => sqlite.prepare(s.sql).run(...s.bindings)); sqlite.exec('COMMIT'); return r; } catch (e) { sqlite.exec('ROLLBACK'); throw e; } }, close: () => sqlite.close() };
}
const HOST = 'http://localhost';
const FEED = 'https://easydrop.one/prom-export?key=9876543210123456789&pid=4455667';
const source = (id, cost = 10000) => ({ externalId: id, title: 'Coat ' + id, description: 'd', category: 'Coats', costMinor: cost, currency: 'UAH', photos: ['https://example.com/' + id + '.jpg'], variants: [{ id: 'v-' + id, size: 'M', stock: 3 }] });

function setup(t) {
  const db = database(); t.after(() => db.close());
  const s = db.sqlite;
  s.prepare("INSERT INTO suppliers(id,name,url,enabled,created_at) VALUES('sup1','Shop','https://mydrop.com.ua/s',1,'2026-01-01T00:00:00Z')").run();
  const add = (id, cost, overrides = {}) => s.prepare('INSERT INTO products(id,supplier_id,external_id,source_json,overrides_json,slug,updated_at) VALUES(?,?,?,?,?,?,?)').run(id, 'sup1', 'ext-' + id, JSON.stringify(source(id, cost)), JSON.stringify({ published: true, markupType: 'fixed', markupValue: 5000, ...overrides }), 'coat-' + id, '2026-01-01T00:00:00Z');
  add('a', 10000); add('b', 20000, { priceOverrideMinor: 3000 }); add('c', 30000);
  const call = async (path, { method = 'GET', body, role, env = {} } = {}) => {
    const headers = { Origin: HOST, 'CF-Connecting-IP': '203.0.113.7' };
    if (body !== undefined) headers['Content-Type'] = 'application/json';
    const e = { DB: db, APP_ENV: 'development', CUSTOMER_AUTH_HMAC_KEY: 'k', ...(role ? { AUTH_DEV_BYPASS: 'true', DEV_STAFF_ROLE: role } : {}), ...env };
    const r = await worker.fetch(new Request(HOST + path, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) }), e);
    const type = r.headers.get('Content-Type') || '';
    return { status: r.status, data: type.includes('json') ? await r.json() : await r.text() };
  };
  const patch = (id, body, role = 'owner') => call('/api/admin/products/' + id, { method: 'PATCH', body, role });
  const stored = id => JSON.parse(s.prepare('SELECT overrides_json FROM products WHERE id=?').get(id).overrides_json);
  return { db, call, patch, stored };
}

test('validation: null or safe integer 1..100000000 only', async t => {
  const { patch, stored } = setup(t);
  for (const bad of [0, -1, 1.5, '100', '', 'null', true, false, [], {}, 100000001, Number.MAX_SAFE_INTEGER + 1]) {
    const r = await patch('a', { priceOverrideMinor: bad });
    assert.equal(r.status, 400, `rejects ${JSON.stringify(bad)}`);
  }
  assert.equal('priceOverrideMinor' in stored('a'), false, 'nothing stored by rejected writes');
  for (const ok of [1, 4999, 100000000]) assert.equal((await patch('a', { priceOverrideMinor: ok })).status, 200);
  assert.equal((await patch('a', { priceOverrideMinor: null })).status, 200);
  assert.equal(stored('a').priceOverrideMinor, null);
});

test('override wins, may be below cost, and null restores the computed price; admin fields exposed', async t => {
  const { patch, call } = setup(t);
  let r = await patch('a', { priceOverrideMinor: 7000 }); // cost 10000, below cost
  assert.equal(r.status, 200);
  assert.deepEqual([r.data.priceMinor, r.data.computedPriceMinor, r.data.priceOverridden], [7000, 15000, true]);
  const list = (await call('/api/admin/products', { role: 'owner' })).data.items;
  assert.deepEqual([list.find(p => p.id === 'c').priceMinor, list.find(p => p.id === 'c').computedPriceMinor, list.find(p => p.id === 'c').priceOverridden], [35000, 35000, false]);
  assert.equal(list.find(p => p.id === 'b').priceMinor, 3000, 'seeded override on a legacy-shaped row');
  r = await patch('a', { priceOverrideMinor: null });
  assert.deepEqual([r.data.priceMinor, r.data.computedPriceMinor, r.data.priceOverridden], [15000, 15000, false]);
  // markup edits do not disturb the override; the computed price follows the markup
  await patch('a', { priceOverrideMinor: 7000 });
  r = await patch('a', { markupValue: 1000 });
  assert.deepEqual([r.data.priceMinor, r.data.computedPriceMinor], [7000, 11000]);
});

test('markup overflow with an override still projects; without one it still fails', () => {
  const row = o => ({ id: 'x', supplier_id: 's', external_id: 'e', slug: 'x', updated_at: 't', source_json: JSON.stringify(source('x', 99000000)), overrides_json: JSON.stringify({ markupType: 'fixed', markupValue: 99000000, ...o }) });
  const p = productProjection(row({ priceOverrideMinor: 500 }));
  assert.deepEqual([p.priceMinor, p.computedPriceMinor, p.priceOverridden], [500, null, true]);
  assert.throws(() => productProjection(row({})), /exceeds limit/);
});

test('public JSON and product page use the override and never leak computed price, cost or overrides', async t => {
  const { patch, call } = setup(t);
  await patch('a', { priceOverrideMinor: 7000 });
  const list = (await call('/api/products')).data.items, a = list.find(p => p.id === 'a');
  assert.equal(a.priceMinor, 7000);
  const one = (await call('/api/products/coat-a')).data;
  assert.equal(one.priceMinor, 7000);
  for (const v of [a, one]) for (const k of ['computedPriceMinor', 'priceOverridden', 'priceOverrideMinor', 'costMinor', 'source', 'overrides']) assert.equal(k in v, false, k);
  const text = JSON.stringify(list) + JSON.stringify(one);
  assert.equal(text.includes('computedPriceMinor') || text.includes('priceOverrid') || text.includes('costMinor'), false);
  const page = (await call('/products/coat-a')).data;
  assert.match(page, /"price":"70\.00"/); assert.match(page, /class="price">(?:70\.00 ₴|70[\s\u00a0]грн)</);
  assert.equal(page.includes('150.00') || /150[\s\u00a0]грн/.test(page) || page.includes('computedPrice') || page.includes('costMinor'), false);
  // storefront min/max filtering and price sorting run client-side on this public priceMinor
  // (apps/web/src/catalog-filters.js); the API contract they rely on is that priceMinor is the effective price.
  assert.deepEqual(list.map(p => [p.id, p.priceMinor]).sort(), [['a', 7000], ['b', 3000], ['c', 35000]]);
});

test('checkout prices the line with the override (and the cart snapshot keeps supplier cost)', async t => {
  const { patch, call, db } = setup(t);
  await patch('a', { priceOverrideMinor: 7000 });
  const r = await call('/api/cart/checkout', { method: 'POST', body: { lines: [{ productId: 'a', size: 'M', quantity: 2 }, { productId: 'c', size: 'M', quantity: 1 }] } });
  assert.equal(r.status, 201);
  assert.equal(r.data.cart.lines[0].unitPriceMinor, 7000);
  assert.equal(r.data.cart.totalMinor, 7000 * 2 + 35000);
  assert.equal(db.sqlite.prepare("SELECT unit_cost_minor FROM cart_lines WHERE product_id='a'").get().unit_cost_minor, 10000);
});

test('publication validates the effective price: override keeps a product publishable', async t => {
  const { patch, call, db } = setup(t);
  db.sqlite.prepare("UPDATE products SET overrides_json=? WHERE id='c'").run(JSON.stringify({ published: false, priceOverrideMinor: 1 }));
  assert.equal((await patch('c', { published: true })).status, 200);
  assert.equal((await call('/api/products')).data.items.find(p => p.id === 'c').priceMinor, 1);
  const bulk = await call('/api/admin/products/bulk', { method: 'POST', role: 'owner', body: { action: 'unpublish', ids: ['c'] } });
  assert.equal(bulk.status, 200);
  assert.equal((await call('/api/admin/products', { role: 'owner' })).data.items.find(p => p.id === 'c').overrides.priceOverrideMinor, 1, 'bulk lifecycle keeps the override');
});

test('permission: products.price required; denied writes change nothing, bulk cannot set prices', async t => {
  const { patch, stored, db, call } = setup(t);
  const before = JSON.stringify(stored('a')), audits = () => db.sqlite.prepare('SELECT COUNT(*) n FROM audit_events').get().n;
  await withRoleMatrixForTests({ manager: ['catalog.read', 'products.edit'] }, async () => {
    assert.equal((await patch('a', { priceOverrideMinor: 100 }, 'manager')).status, 403);
    assert.equal((await patch('a', { priceOverrideMinor: null }, 'manager')).status, 403, 'even a null reset needs the permission');
    assert.equal((await patch('a', { title: 'ok' }, 'manager')).status, 200, 'other edits still allowed');
  });
  assert.equal(stored('a').priceOverrideMinor, undefined); assert.equal(stored('a').title, 'ok');
  assert.equal(audits(), 1, 'only the unrelated product.update was audited');
  assert.equal((await patch('a', { priceOverrideMinor: 100 }, 'manager')).status, 200, 'default manager holds products.price');
  const bulk = await call('/api/admin/products/bulk', { method: 'POST', role: 'owner', body: { action: 'publish', ids: ['b'], priceOverrideMinor: 1 } });
  assert.equal(bulk.status, 200);
  assert.equal(stored('b').priceOverrideMinor, 3000, 'bulk never writes price fields');
  assert.ok(before);
});

test('audit: distinct override/reset events with actor and details, alongside product.update; no event when unchanged', async t => {
  const { patch, db } = setup(t);
  const events = () => db.sqlite.prepare("SELECT action,actor,actor_role,details_json FROM audit_events WHERE resource_id='a' ORDER BY rowid").all();
  await patch('a', { priceOverrideMinor: 7000 }, 'manager');
  await patch('a', { priceOverrideMinor: 7000 }, 'manager'); // unchanged
  await patch('a', { priceOverrideMinor: 6000 }, 'manager');
  await patch('a', { priceOverrideMinor: null }, 'manager');
  await patch('a', { priceOverrideMinor: null }, 'manager'); // unchanged
  await patch('a', { title: 'x' }, 'manager'); // unrelated
  const ev = events();
  assert.deepEqual(ev.map(e => e.action), ['product.update', 'product.price.override', 'product.update', 'product.update', 'product.price.override', 'product.update', 'product.price.reset', 'product.update', 'product.update']);
  const price = ev.filter(e => e.action.startsWith('product.price'));
  assert.deepEqual(price.map(e => JSON.parse(e.details_json)), [{ fromMinor: null, toMinor: 7000, computedMinor: 15000 }, { fromMinor: 7000, toMinor: 6000, computedMinor: 15000 }, { fromMinor: 6000, toMinor: null, computedMinor: 15000 }]);
  assert.ok(price.every(e => e.actor_role === 'manager' && e.actor));
});

test('source reimport (POST /suppliers/:id/import) preserves the override and source cost updates', async t => {
  const { patch, call, stored } = setup(t);
  await patch('a', { priceOverrideMinor: 7000 });
  for (const cost of [12000, 12000]) { // repeatable
    const r = await call('/api/admin/suppliers/sup1/import', { method: 'POST', role: 'owner', body: { items: [source('ext-a', cost)] } });
    assert.equal(r.status, 200);
  }
  assert.equal(stored('a').priceOverrideMinor, 7000);
  const p = (await call('/api/admin/products', { role: 'owner' })).data.items.find(x => x.id === 'a');
  assert.deepEqual([p.priceMinor, p.priceOverridden], [7000, true]);
});

test('EasyDrop sync preserves the override while the feed cost changes', async t => {
  const db = database(); t.after(() => db.close());
  let price = '1000';
  const original = globalThis.fetch; t.after(() => { globalThis.fetch = original; });
  const feed = () => `<?xml version="1.0"?><shop><catalog><category id="c1">Brand | Model</category></catalog><items><item id="1" group_id="10" available="true"><categoryId>c1</categoryId><name>N</name><priceuah>${price}</priceuah><description>&lt;p&gt;A&lt;/p&gt;</description><image>https://easydrop.one/media/uploads/images/base/a.jpg</image><param name="Розмір" unit="">40</param><available>true</available><quantity_in_stock>2</quantity_in_stock></item></items></shop>`;
  globalThis.fetch = async url => { if (String(url).startsWith('https://easydrop.one/')) return new Response(feed(), { headers: { 'Content-Type': 'application/xml' } }); throw new Error('unexpected network call'); };
  const env = { DB: db, APP_ENV: 'development', AUTH_DEV_BYPASS: 'true', DEV_STAFF_ROLE: 'owner' };
  const call = async (path, method = 'GET', body) => { const r = await worker.fetch(new Request(HOST + path, { method, headers: { Origin: HOST, ...(body ? { 'Content-Type': 'application/json' } : {}) }, body: body && JSON.stringify(body) }), env); return { status: r.status, data: await r.json() }; };
  const sup = (await call('/api/admin/suppliers', 'POST', { name: 'ED', provider: 'easydrop', feedUrl: FEED })).data;
  assert.equal((await call(`/api/admin/suppliers/${sup.id}/sync`, 'POST', {})).data.imported, 1);
  const id = (await call('/api/admin/products')).data.items[0].id;
  assert.equal((await call('/api/admin/products/' + id, 'PATCH', { priceOverrideMinor: 90000, published: true })).status, 200);
  price = '1500';
  db.sqlite.prepare('UPDATE suppliers SET last_api_request_at=NULL WHERE id=?').run(sup.id);
  assert.equal((await call(`/api/admin/suppliers/${sup.id}/sync`, 'POST', {})).data.imported, 1);
  const p = (await call('/api/admin/products')).data.items[0];
  assert.equal(p.source.costMinor, 150000);
  assert.deepEqual([p.priceMinor, p.priceOverridden, p.overrides.priceOverrideMinor, p.published], [90000, true, 90000, true]);
});
