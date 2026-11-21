import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { readFileSync, readdirSync } from 'node:fs';
import worker from '../../apps/api/src/index.js';
import { productProjection } from '../../apps/api/src/domain.js';
import { mergeCatalog, allocate } from '../../apps/api/src/merged.js';

// Synthetic fixtures only; invented suppliers, titles and URLs.
const row = (id, supplier, cost, variants, overrides = {}, group = null) => ({
  id, supplier_id: supplier, supplier_name: 'Supplier ' + supplier, external_id: 'EXT-' + id, slug: 'slug-' + id, updated_at: '2026-01-01T00:00:00Z', duplicate_group_id: group,
  source_json: JSON.stringify({ externalId: 'EXT-' + id, title: 'Title ' + id, description: 'd', category: 'Кросівки', costMinor: cost, currency: 'UAH', photos: [`https://img.test/${id}.jpg`], variants }),
  overrides_json: JSON.stringify({ markupType: 'fixed', markupValue: 50000, ...overrides })
});
const v = (id, size, stock) => ({ id, size, stock });
const project = (r, publicOnly) => productProjection(r, Date.now(), publicOnly);

test('merge: primary is the published in-stock member with the lowest cost; stock sums by normalized size', () => {
  const rows = [
    row('cheap-empty', 'A', 90000, [v('a1', '42', 0)], { published: true }, 'g'),
    row('mid', 'B', 120000, [v('b1', '42', 2), v('b2', '43', 1)], { published: true }, 'g'),
    row('other', 'C', 100000, [v('c1', 'EU 42', 3), v('c2', '44', 5), v('c3', '45', 9)], { published: true, hiddenSizes: ['45'] }, 'g'),
    row('draft', 'D', 80000, [v('d1', '42', 7)], { published: false }, 'g'),
    row('loss', 'E', 500000, [v('e1', '42', 7)], { published: true }, 'g'),
    row('single', 'A', 50000, [v('s1', 'M', 1)], { published: true }),
    row('hidden-single', 'B', 50000, [v('h1', 'M', 1)], { published: false })
  ];
  const { items, byProductId, bySlug } = mergeCatalog(rows, project);
  assert.equal(items.length, 2);
  const merged = items.find(e => e.groupId === 'g');
  assert.equal(merged.primaryId, 'other', 'cheapest published member has no stock and the draft never counts, so the cheapest in-stock published member is shown');
  assert.equal(merged.product.title, 'Title other');
  assert.equal(merged.product.priceMinor, 150000, "primary's own markup on its own cost");
  assert.deepEqual(merged.product.variants, [{ size: 'EU 42', stock: 5 }, { size: '44', stock: 5 }, { size: '43', stock: 1 }], "labels from the primary; its hidden size, the draft and the member costing more than the shown price do not count");
  assert.ok(!('supplierId' in merged.product) && !('source' in merged.product), 'public shape only');
  assert.equal(byProductId.get('draft'), undefined, 'a draft member is not reachable');
  assert.equal(byProductId.get('loss'), undefined);
  assert.equal(bySlug.get('slug-cheap-empty').product.slug, 'slug-other');
  assert.deepEqual(merged.members.map(m => m.row.id), ['cheap-empty', 'other', 'mid'], 'fill order is by cost');
  // No published member: the group is not on the storefront at all.
  assert.equal(mergeCatalog([row('x', 'A', 1, [v('x1', 'M', 1)], {}, 'h'), row('y', 'B', 1, [v('y1', 'M', 1)], {}, 'h')], project).items.length, 0);
});

test('allocate: cheapest suppliers first, exact sizes for single products, merged labels for groups', () => {
  const rows = [
    row('p', 'A', 120000, [v('p42', '42', 2)], { published: true }, 'g'),
    row('q', 'B', 100000, [v('q42', 'EU 42', 1), v('q42b', '42', 1)], { published: true }, 'g'),
    row('r', 'C', 110000, [v('r42', '42', 4)], { published: true }, 'g')
  ];
  const entry = mergeCatalog(rows, project).items[0];
  assert.equal(entry.primaryId, 'q');
  assert.deepEqual(entry.product.variants, [{ size: 'EU 42', stock: 8 }]);
  const result = allocate(entry, 'EU 42', 5);
  assert.ok(result.ok);
  assert.deepEqual(result.allocations.map(a => [a.productId, a.quantity, a.unitCostMinor]), [['q', 2, 100000], ['r', 3, 110000]]);
  assert.deepEqual(result.allocations[0].variantIds, ['q42', 'q42b']);
  assert.ok(allocate(entry, 'EU 42', 8).ok, 'all 8 units across three suppliers');
  assert.deepEqual(allocate(entry, 'EU 42', 9), { ok: false, code: 'insufficient_stock', available: 8 });
  assert.equal(allocate(entry, '42', 1).code, 'size_unavailable', 'a merged product is ordered by its shown size labels');
  const single = mergeCatalog([row('s', 'A', 1, [v('s1', 'EU 42', 1)], { published: true })], project).items[0];
  assert.ok(allocate(single, 'EU 42', 1).ok);
  assert.equal(allocate(single, '42', 1).code, 'size_unavailable', 'single products keep exact matching');
});

// ---- API on an isolated in-memory D1 -------------------------------------------------------------
const migrationDir = new URL('../../migrations/', import.meta.url);
function database() {
  const sqlite = new DatabaseSync(':memory:');
  for (const name of readdirSync(migrationDir).filter(n => /^\d{4}_.*\.sql$/.test(n)).sort()) sqlite.exec(readFileSync(new URL(name, migrationDir), 'utf8'));
  const wrap = (sql, bindings = []) => ({ sql, bindings, bind(...x) { return wrap(sql, x); }, async first() { return sqlite.prepare(sql).get(...bindings) ?? null; }, async all() { return { results: sqlite.prepare(sql).all(...bindings) }; }, async run() { return sqlite.prepare(sql).run(...bindings); } });
  return { sqlite, prepare: sql => wrap(sql), async batch(statements) { sqlite.exec('BEGIN'); try { const result = statements.map(s => sqlite.prepare(s.sql).run(...s.bindings)); sqlite.exec('COMMIT'); return result; } catch (error) { sqlite.exec('ROLLBACK'); throw error; } }, close: () => sqlite.close() };
}
const HOST = 'http://localhost';
const source = (externalId, title, cost, variants) => ({ externalId, title, description: 'Synthetic', category: 'Кросівки', costMinor: cost, currency: 'UAH', photos: [`https://img.test/${externalId}.jpg`], variants });
async function setup(t) {
  const db = database();
  t.after(() => db.close());
  const env = { DB: db, APP_ENV: 'development', AUTH_DEV_BYPASS: 'true', DEV_STAFF_ROLE: 'owner', CUSTOMER_AUTH_HMAC_KEY: 'fake-hmac' };
  const request = async (path, { method = 'GET', body, ip = '203.0.113.9' } = {}) => {
    const headers = { Origin: HOST, 'CF-Connecting-IP': ip };
    if (body !== undefined) headers['Content-Type'] = 'application/json';
    const response = await worker.fetch(new Request(HOST + path, { method, headers, body: body === undefined ? undefined : JSON.stringify(body), redirect: 'manual' }), env);
    const type = response.headers.get('Content-Type') || '';
    return { status: response.status, headers: response.headers, data: type.includes('json') ? await response.json() : await response.text() };
  };
  const admin = (path, options) => request('/api/admin' + path, options);
  const supplier = async (name, slug) => (await admin('/suppliers', { method: 'POST', body: { name, url: `https://mydrop.com.ua/${slug}` } })).data.id;
  const s1 = await supplier('Synthetic One', 'synthetic_one'), s2 = await supplier('Synthetic Two', 'synthetic_two');
  await admin(`/suppliers/${s1}/import`, { method: 'POST', body: { items: [source('A-1', 'Fakeshoe Glide FS-7001', 150000, [{ id: 'a42', size: '42', stock: 1 }, { id: 'a43', size: '43', stock: 0 }])] } });
  await admin(`/suppliers/${s2}/import`, { method: 'POST', body: { items: [source('B-1', 'Fakeshoe Glide FS 7001 white', 140000, [{ id: 'b42', size: '42', stock: 3 }, { id: 'b43', size: '43', stock: 2 }])] } });
  const ids = Object.fromEntries(db.sqlite.prepare('SELECT id,external_id FROM products').all().map(r => [r.external_id, r.id]));
  const slugs = Object.fromEntries(db.sqlite.prepare('SELECT external_id,slug FROM products').all().map(r => [r.external_id, r.slug]));
  // Both published with their own markup; B-1 is cheaper, so it becomes the shown product once grouped.
  for (const ext of ['A-1', 'B-1']) assert.equal((await admin(`/products/${ids[ext]}`, { method: 'PATCH', body: { published: true, markupType: 'fixed', markupValue: 60000 } })).status, 200);
  return { db, env, request, admin, ids, slugs, s1, s2 };
}

test('API: a confirmed group is one storefront product with summed stock; members redirect; dissolving restores', async t => {
  const { request, admin, ids, slugs } = await setup(t);
  assert.equal((await request('/api/products')).data.items.length, 2, 'before grouping both show');
  const { data: { groupId } } = await admin('/duplicates/groups', { method: 'POST', body: { productIds: [ids['A-1'], ids['B-1']] } });
  const items = (await request('/api/products')).data.items;
  assert.equal(items.length, 1);
  assert.equal(items[0].slug, slugs['B-1']);
  assert.equal(items[0].priceMinor, 200000);
  assert.deepEqual(items[0].variants, [{ size: '42', stock: 4 }, { size: '43', stock: 2 }]);
  for (const key of ['supplierId', 'externalId', 'source', 'costMinor']) assert.ok(!JSON.stringify(items[0]).includes(`"${key}"`), key);
  assert.equal((await request(`/api/products/${slugs['A-1']}`)).data.slug, slugs['B-1'], 'API resolves a member slug to the shown product');
  const hidden = await request(`/products/${slugs['A-1']}`);
  assert.equal(hidden.status, 301);
  assert.equal(hidden.headers.get('Location'), `${HOST}/products/${slugs['B-1']}`);
  const page = await request(`/products/${slugs['B-1']}`);
  assert.equal(page.status, 200);
  assert.match(page.data, /type="radio" name="size" value="42"/);
  const sitemap = (await request('/sitemap.xml')).data;
  assert.ok(sitemap.includes(slugs['B-1']) && !sitemap.includes(slugs['A-1']));
  const overview = (await admin('/duplicates')).data;
  assert.deepEqual(overview.groups[0].storefront, { visible: true, primaryId: ids['B-1'], slug: slugs['B-1'], priceMinor: 200000, sizes: [{ size: '42', stock: 4 }, { size: '43', stock: 2 }] });
  await admin(`/duplicates/groups/${groupId}`, { method: 'DELETE', body: {} });
  assert.equal((await request('/api/products')).data.items.length, 2, 'dissolving restores the separate listings');
});

test('API: a disabled member supplier or trashed member drops out of the merged stock', async t => {
  const { request, admin, ids, slugs, s2 } = await setup(t);
  await admin('/duplicates/groups', { method: 'POST', body: { productIds: [ids['A-1'], ids['B-1']] } });
  await admin(`/suppliers/${s2}`, { method: 'PATCH', body: { enabled: false } });
  let items = (await request('/api/products')).data.items;
  assert.equal(items.length, 1);
  assert.equal(items[0].slug, slugs['A-1'], 'the remaining published member is shown');
  assert.deepEqual(items[0].variants, [{ size: '42', stock: 1 }, { size: '43', stock: 0 }]);
  await admin(`/suppliers/${s2}`, { method: 'PATCH', body: { enabled: true } });
  await admin(`/products/${ids['A-1']}`, { method: 'DELETE', body: { confirm: true } });
  items = (await request('/api/products')).data.items;
  assert.deepEqual(items.map(i => [i.slug, i.variants]), [[slugs['B-1'], [{ size: '42', stock: 3 }, { size: '43', stock: 2 }]]]);
});

test('API: checkout fills a merged line from the cheapest suppliers and shows the split to staff only', async t => {
  const { db, request, admin, ids } = await setup(t);
  await admin('/duplicates/groups', { method: 'POST', body: { productIds: [ids['A-1'], ids['B-1']] } });
  // The customer cart still holds the hidden member's ID: it resolves to the shown product.
  const checkout = await request('/api/cart/checkout', { method: 'POST', body: { lines: [{ productId: ids['A-1'], size: '42', quantity: 4 }] } });
  assert.equal(checkout.status, 201, JSON.stringify(checkout.data));
  const [line] = checkout.data.cart.lines;
  assert.equal(line.productId, ids['B-1']);
  assert.equal(line.unitPriceMinor, 200000);
  assert.ok(!JSON.stringify(checkout.data).includes('supplier'), 'no supplier data in the customer response');
  const stored = db.sqlite.prepare('SELECT supplier_id,unit_cost_minor,allocations_json FROM cart_lines').get();
  assert.deepEqual(JSON.parse(stored.allocations_json).map(a => [a.productId, a.quantity, a.unitCostMinor]), [[ids['B-1'], 3, 140000], [ids['A-1'], 1, 150000]]);
  assert.equal(stored.unit_cost_minor, 140000);
  const detail = (await admin(`/carts/${checkout.data.cart.code}`)).data.cart;
  assert.deepEqual(detail.lines.map(l => [l.supplierName, l.quantity, l.externalProductId, l.unitCostMinor, l.merged]), [['Synthetic Two', 3, 'B-1', 140000, true], ['Synthetic One', 1, 'A-1', 150000, true]]);
  // Too much, and two lines that resolve to the same product and size.
  assert.equal((await request('/api/cart/checkout', { method: 'POST', body: { lines: [{ productId: ids['B-1'], size: '42', quantity: 5 }] } })).data.problems[0].code, 'insufficient_stock');
  const dup = await request('/api/cart/checkout', { method: 'POST', body: { lines: [{ productId: ids['A-1'], size: '43', quantity: 1 }, { productId: ids['B-1'], size: '43', quantity: 1 }] } });
  assert.equal(dup.status, 409);
  assert.deepEqual(dup.data.problems, [{ index: 1, code: 'duplicate_line', field: 'size', firstIndex: 0 }]);
});

test('API: ungrouped checkout is unchanged (no allocations stored)', async t => {
  const { db, request, ids } = await setup(t);
  assert.equal((await request('/api/cart/checkout', { method: 'POST', body: { lines: [{ productId: ids['B-1'], size: '42', quantity: 2 }] } })).status, 201);
  const stored = db.sqlite.prepare('SELECT supplier_id,external_product_id,variant_ids_json,allocations_json FROM cart_lines').get();
  assert.equal(stored.allocations_json, null);
  assert.equal(stored.external_product_id, 'B-1');
  assert.deepEqual(JSON.parse(stored.variant_ids_json), ['b42']);
});
