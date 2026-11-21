import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { readFileSync, readdirSync } from 'node:fs';
import worker from '../../apps/api/src/index.js';
import { findDuplicateCandidates, modelCodes, titleTokens, colours } from '../../packages/catalog/duplicates.js';

// Synthetic fixtures only; invented brands, codes and URLs.
const p = (id, supplierId, title, extra = {}) => ({ id, supplierId, title, brand: null, categoryId: 'shoes', categoryPath: ['Взуття'], photos: [`https://img.test/${id}.jpg`], ...extra });

test('model codes ignore sizes, years and units but keep manufacturer codes', () => {
  assert.deepEqual(modelCodes("Testbrand Runner One 'Fake Grey' TB-0001"), ['tb0001']);
  assert.deepEqual(modelCodes('Кросівки Fakeshoe QA2291-100 білі 36-45 2024'), ['qa2291100', 'qa2291']);
  assert.deepEqual(modelCodes('Fakeshoe FS 7001'), ['fs7001']);
  assert.deepEqual(modelCodes('Пляшка 750ml 30cm'), []);
  assert.deepEqual(modelCodes('Артикул 1234567'), ['1234567']);
  assert.deepEqual(titleTokens('Fake Aero Glide 1 «білі»'), ['fake', 'aero', 'glide', '1', 'білі']);
});

test('detection: cross-supplier only, evidence-backed, brand and category conflicts veto', () => {
  const products = [
    p('a1', 'A', 'Кросівки Fakeshoe Glide QA2291-100 білі', { brand: 'Fakeshoe' }),
    p('b1', 'B', 'Fakeshoe Glide QA2291 100 white чоловічі', { brand: 'Fakeshoe' }),
    p('a2', 'A', 'Кросівки Fakeshoe Glide QA2291-100 чорні', { brand: 'Fakeshoe' }), // same supplier as a1: never paired with it
    p('c1', 'C', 'Худі Testwear Basic Oversize', { brand: 'Testwear', categoryPath: ['Одяг'], photos: ['https://img.test/shared.jpg'] }),
    p('d1', 'D', 'Testwear Basic Oversize худі сіре', { brand: 'Testwear', categoryPath: ['Одяг'], photos: ['https://img.test/shared.jpg'] }),
    p('e1', 'E', 'Худі Otherbrand Basic Oversize', { brand: 'Otherbrand', categoryPath: ['Одяг'], photos: ['https://img.test/shared.jpg'] }), // brand conflict
    p('f1', 'F', 'Кепка Fakeshoe Glide QA2291-100', { brand: 'Fakeshoe', categoryPath: ['Аксесуари'] }), // category conflict, code only
    p('g1', 'G', 'Сумка Plain Tote', { categoryPath: ['Аксесуари'] }),
    p('h1', 'H', 'Сумка Plain Tote', { categoryPath: ['Аксесуари'] }) // identical title, no brand: medium
  ];
  const candidates = findDuplicateCandidates(products);
  const sets = candidates.map(c => c.productIds.join(','));
  assert.deepEqual(sets.sort(), ['a1,b1', 'c1,d1', 'g1,h1'].sort(), 'a2 is the black colourway of the white a1/b1');
  const shoes = candidates.find(c => c.productIds.includes('b1'));
  assert.equal(shoes.confidence, 'high');
  assert.ok(shoes.pairs.every(pair => products.find(x => x.id === pair.a).supplierId !== products.find(x => x.id === pair.b).supplierId));
  assert.ok(shoes.pairs.some(pair => pair.reasons.some(r => r.kind === 'code' && r.value === 'qa2291')));
  assert.ok(candidates.find(c => c.productIds.includes('c1')).pairs[0].reasons.some(r => r.kind === 'photo'));
  assert.equal(candidates.find(c => c.productIds.includes('g1')).confidence, 'medium');
  // Deterministic: same input order-independent output.
  assert.deepEqual(findDuplicateCandidates([...products].reverse()), candidates);
});

test('decisions win: rejected pairs never resurface; confirmed groups become add-to-group proposals', () => {
  const products = [p('a', 'A', 'Fakeshoe Glide QA2291-100'), p('b', 'B', 'Fakeshoe Glide QA2291-100'), p('c', 'C', 'Fakeshoe Glide QA2291-100')];
  assert.deepEqual(findDuplicateCandidates(products, { rejectedPairs: [['b', 'a'], ['a', 'c'], ['b', 'c']] }), []);
  const proposal = findDuplicateCandidates(products, { groups: [{ id: 'g1', productIds: ['a', 'b'] }] });
  assert.equal(proposal.length, 1);
  assert.equal(proposal[0].groupId, 'g1');
  assert.deepEqual(proposal[0].productIds, ['c']);
  assert.deepEqual(proposal[0].groupProductIds, ['a', 'b']);
  assert.deepEqual(findDuplicateCandidates(products, { groups: [{ id: 'g1', productIds: ['a', 'b', 'c'] }] }), []);
  // Two confirmed groups are never merged automatically.
  const four = [...products, p('d', 'D', 'Fakeshoe Glide QA2291-100')];
  assert.deepEqual(findDuplicateCandidates(four, { groups: [{ id: 'g1', productIds: ['a', 'b'] }, { id: 'g2', productIds: ['c', 'd'] }] }), []);
});

test('keys repeated inside one supplier are not evidence; keys spread over many suppliers are', () => {
  // A placeholder photo used by one supplier on many products.
  const placeholder = Array.from({ length: 5 }, (_, i) => p(`x${i}`, 'S0', `Item ${i}`, { photos: ['https://img.test/placeholder.jpg'] }));
  assert.deepEqual(findDuplicateCandidates([...placeholder, p('y', 'S1', 'Other', { photos: ['https://img.test/placeholder.jpg'] })]), []);
  // A popular item carried by 12 suppliers is one candidate, not dropped.
  const popular = Array.from({ length: 12 }, (_, i) => p(`z${i}`, `S${i}`, `Fakeshoe Glide QQ12345 ${i}`));
  const [candidate, ...rest] = findDuplicateCandidates(popular);
  assert.equal(rest.length, 0);
  assert.equal(candidate.productIds.length, 12);
  assert.equal(candidate.confidence, 'high');
});

test('different colourways of one style do not match on the shared base code', () => {
  assert.deepEqual(findDuplicateCandidates([p('w', 'A', 'Fakeshoe Glide QA2291-100 білі'), p('k', 'B', 'Fakeshoe Glide QA2291-001 чорні')]), []);
  const same = findDuplicateCandidates([p('w', 'A', 'Fakeshoe Glide QA2291-100 білі'), p('k', 'B', 'Fakeshoe QA2291 100')]);
  assert.equal(same.length, 1);
  assert.equal(same[0].confidence, 'high');
});

// ---- API on an isolated in-memory D1 -------------------------------------------------------------
const migrationDir = new URL('../../migrations/', import.meta.url);
function database() {
  const sqlite = new DatabaseSync(':memory:');
  for (const name of readdirSync(migrationDir).filter(n => /^\d{4}_.*\.sql$/.test(n)).sort()) sqlite.exec(readFileSync(new URL(name, migrationDir), 'utf8'));
  const wrap = (sql, bindings = []) => ({ sql, bindings, bind(...v) { return wrap(sql, v); }, async first() { return sqlite.prepare(sql).get(...bindings) ?? null; }, async all() { return { results: sqlite.prepare(sql).all(...bindings) }; }, async run() { return sqlite.prepare(sql).run(...bindings); } });
  return { sqlite, prepare: sql => wrap(sql), async batch(statements) { sqlite.exec('BEGIN'); try { const result = statements.map(s => sqlite.prepare(s.sql).run(...s.bindings)); sqlite.exec('COMMIT'); return result; } catch (error) { sqlite.exec('ROLLBACK'); throw error; } }, close: () => sqlite.close() };
}
const HOST = 'http://localhost';
const source = (externalId, title, photo, stock = 2) => ({ externalId, title, description: 'Synthetic', category: 'Кросівки', costMinor: 150000, currency: 'UAH', photos: [photo], variants: [{ id: 'v42', size: '42', stock }] });
async function setup(t) {
  const db = database();
  t.after(() => db.close());
  const call = async (path, { method = 'GET', body, role = 'owner' } = {}) => {
    const headers = { Origin: HOST };
    if (body !== undefined) headers['Content-Type'] = 'application/json';
    const response = await worker.fetch(new Request(HOST + '/api/admin' + path, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) }), { DB: db, APP_ENV: 'development', AUTH_DEV_BYPASS: 'true', DEV_STAFF_ROLE: role });
    return { status: response.status, data: await response.json() };
  };
  const supplier = async (name, slug) => (await call('/suppliers', { method: 'POST', body: { name, url: `https://mydrop.com.ua/${slug}` } })).data.id;
  const s1 = await supplier('Synthetic One', 'synthetic_one'), s2 = await supplier('Synthetic Two', 'synthetic_two'), s3 = await supplier('Synthetic Three', 'synthetic_three');
  const items = {
    [s1]: [source('A-1', 'Кросівки Fakeshoe Glide FS-7001 білі', 'https://img.test/a1.jpg', 3), source('A-2', 'Сумка Plain Tote', 'https://img.test/a2.jpg')],
    [s2]: [source('B-1', 'Fakeshoe Glide FS-7001 white', 'https://img.test/b1.jpg', 4), source('B-2', 'Сумка Plain Tote', 'https://img.test/b2.jpg')],
    [s3]: [source('C-1', 'Fakeshoe Glide FS7001', 'https://img.test/c1.jpg', 1), source('C-2', 'Кросівки Fakeshoe Glide FS-7001 чорні', 'https://img.test/c2.jpg')]
  };
  for (const [supplierId, list] of Object.entries(items)) assert.equal((await call(`/suppliers/${supplierId}/import`, { method: 'POST', body: { items: list } })).status, 200);
  const ids = Object.fromEntries(db.sqlite.prepare('SELECT id,external_id FROM products').all().map(r => [r.external_id, r.id]));
  return { db, call, ids, s1, s2, s3, items };
}

test('API: overview lists cross-supplier candidates with summaries and no public change', async t => {
  const { call, ids } = await setup(t);
  const { status, data } = await call('/duplicates');
  assert.equal(status, 200);
  const shoes = data.candidates.find(c => c.productIds.includes(ids['A-1']));
  assert.ok(shoes, 'shoe candidate exists');
  // C-1 and C-2 come from the same supplier; the union-find component may hold both, so the API must refuse confirming both.
  assert.ok(shoes.productIds.includes(ids['B-1']));
  assert.equal(data.products[ids['A-1']].supplierName, 'Synthetic One');
  assert.equal(data.products[ids['A-1']].costMinor, 150000);
  assert.equal(data.products[ids['A-1']].stock, 3);
  assert.ok(data.candidates.some(c => c.productIds.includes(ids['A-2']) && c.productIds.includes(ids['B-2'])));
  const pub = await worker.fetch(new Request(HOST + '/api/products'), { DB: (await setup(t)).db, APP_ENV: 'development' });
  assert.equal((await pub.json()).items.length, 0, 'imports stay drafts; storefront untouched');
});

test('API: confirm, one product per supplier, extend, survive reimport, remove and dissolve', async t => {
  const { db, call, ids, s1, items } = await setup(t);
  assert.equal((await call('/duplicates/groups', { method: 'POST', body: { productIds: [ids['A-1'], ids['C-1'], ids['C-2']] } })).status, 409, 'two products of one supplier refused');
  const created = await call('/duplicates/groups', { method: 'POST', body: { productIds: [ids['A-1'], ids['B-1']], rejectIds: [ids['C-2']] } });
  assert.equal(created.status, 201);
  const groupId = created.data.groupId;
  let overview = (await call('/duplicates')).data;
  assert.equal(overview.groups.length, 1);
  assert.deepEqual(overview.groups[0].productIds.sort(), [ids['A-1'], ids['B-1']].sort());
  const proposal = overview.candidates.find(c => c.groupId === groupId);
  assert.deepEqual(proposal.productIds, [ids['C-1']], 'C-2 was rejected against the group; C-1 is proposed as an addition');
  // Already grouped products cannot join a second group.
  assert.equal((await call('/duplicates/groups', { method: 'POST', body: { productIds: [ids['A-1'], ids['C-1']] } })).status, 409);
  assert.equal((await call('/duplicates/groups', { method: 'POST', body: { productIds: [ids['C-1']], groupId } })).status, 200);
  // Reimport with changed source values keeps product IDs and decisions.
  assert.equal((await call(`/suppliers/${s1}/import`, { method: 'POST', body: { items: [{ ...items[s1][0], title: 'Fakeshoe Glide FS-7001 оновлено постачальником', variants: [{ id: 'v42', size: '42', stock: 9 }] }] } })).status, 200);
  overview = (await call('/duplicates')).data;
  assert.equal(overview.groups[0].productIds.length, 3);
  assert.equal(overview.products[ids['A-1']].stock, 9);
  assert.ok(!overview.candidates.some(c => c.productIds.includes(ids['C-2']) && c.groupId === groupId));
  // Remove a member: it is recorded as a different item and not proposed again.
  const removed = await call(`/duplicates/groups/${groupId}/members/${ids['C-1']}`, { method: 'DELETE', body: {} });
  assert.equal(removed.status, 200);
  assert.equal(removed.data.dissolved, false);
  overview = (await call('/duplicates')).data;
  assert.ok(!overview.candidates.some(c => c.productIds.includes(ids['C-1']) && c.groupId === groupId));
  assert.ok(overview.rejections.some(r => r.productIds.includes(ids['C-1'])));
  // Dissolve: pairs become candidates again.
  assert.equal((await call(`/duplicates/groups/${groupId}`, { method: 'DELETE', body: {} })).status, 200);
  overview = (await call('/duplicates')).data;
  assert.equal(overview.groups.length, 0);
  assert.ok(overview.candidates.some(c => c.productIds.includes(ids['A-1']) && c.productIds.includes(ids['B-1'])));
  const actions = db.sqlite.prepare("SELECT action FROM audit_events WHERE action LIKE 'duplicates.%' ORDER BY created_at").all().map(r => r.action);
  assert.deepEqual(actions, ['duplicates.confirm', 'duplicates.confirm', 'duplicates.remove', 'duplicates.dissolve']);
  // Source snapshots and overlays are untouched by decisions.
  assert.equal(db.sqlite.prepare("SELECT COUNT(*) AS n FROM products WHERE overrides_json<>'{}'").get().n, 0);
});

test('API: reject and restore pairs; trashed products are not proposed or confirmable', async t => {
  const { db, call, ids } = await setup(t);
  assert.equal((await call('/duplicates/rejections', { method: 'POST', body: { productIds: [ids['A-2'], ids['B-2']] } })).status, 200);
  let overview = (await call('/duplicates')).data;
  assert.ok(!overview.candidates.some(c => c.productIds.includes(ids['A-2'])));
  assert.equal(overview.totals.rejections, 1);
  assert.equal((await call('/duplicates/rejections', { method: 'DELETE', body: { productIds: [ids['B-2'], ids['A-2']] } })).status, 200);
  assert.equal((await call('/duplicates/rejections', { method: 'DELETE', body: { productIds: [ids['B-2'], ids['A-2']] } })).status, 404);
  overview = (await call('/duplicates')).data;
  assert.ok(overview.candidates.some(c => c.productIds.includes(ids['A-2'])));
  assert.equal((await call(`/products/${ids['B-2']}`, { method: 'DELETE', body: { confirm: true } })).status, 200);
  overview = (await call('/duplicates')).data;
  assert.ok(!overview.candidates.some(c => c.productIds.includes(ids['B-2'])));
  assert.equal((await call('/duplicates/groups', { method: 'POST', body: { productIds: [ids['A-2'], ids['B-2']] } })).status, 409);
  assert.equal(db.sqlite.prepare("SELECT COUNT(*) AS n FROM audit_events WHERE action IN ('duplicates.reject','duplicates.unreject')").get().n, 2);
});

test('API: validation, permissions and the guard', async t => {
  const { db, call, ids } = await setup(t);
  for (const body of [{}, { productIds: [ids['A-1']] }, { productIds: [ids['A-1'], ids['A-1']] }, { productIds: [ids['A-1'], ids['B-1']], extra: 1 }, { productIds: [ids['A-1'], ids['B-1']], rejectIds: [ids['A-1']] }])
    assert.equal((await call('/duplicates/groups', { method: 'POST', body })).status, 400, JSON.stringify(body));
  assert.equal((await call('/duplicates/groups', { method: 'POST', body: { productIds: [ids['A-1'], 'missing'] } })).status, 404);
  assert.equal((await call('/duplicates/groups', { method: 'POST', body: { productIds: [ids['A-1'], ids['A-2']] } })).status, 409, 'same supplier');
  // Managers may review; the route table denies unknown methods.
  assert.equal((await call('/duplicates', { role: 'manager' })).status, 200);
  assert.equal((await call('/duplicates/groups', { method: 'POST', role: 'manager', body: { productIds: [ids['A-1'], ids['B-1']] } })).status, 201);
  assert.equal((await call('/duplicates', { method: 'PUT', body: {} })).status, 405);
  // The pre-check refuses a group that already breaks the rule.
  const groupId = db.sqlite.prepare('SELECT id FROM duplicate_groups').get().id;
  // A concurrent writer slips a second product of supplier one in between the API's read and its batch:
  // the in-transaction guard rolls the whole confirmation back.
  const batch = db.batch.bind(db);
  db.batch = async statements => { db.batch = batch; db.sqlite.prepare("INSERT INTO duplicate_group_members(product_id,group_id,added_at,actor) VALUES(?,?,'2026-01-01T00:00:00Z','race')").run(ids['A-2'], groupId); return batch(statements); };
  assert.equal((await call('/duplicates/groups', { method: 'POST', body: { productIds: [ids['C-1']], groupId } })).status, 409);
  assert.equal(db.sqlite.prepare('SELECT COUNT(*) AS n FROM duplicate_group_members WHERE product_id=?').get(ids['C-1']).n, 0, 'rolled back');
  assert.equal(db.sqlite.prepare("SELECT COUNT(*) AS n FROM audit_events WHERE action='duplicates.confirm'").get().n, 1, 'no audit for the rolled-back write');
  assert.equal((await call('/duplicates/groups', { method: 'POST', body: { productIds: [ids['C-1']], groupId } })).status, 409, 'pre-check now refuses the broken group');
});

test('real-data precision: colourways, years and space-separated colour numbers', () => {
  assert.deepEqual(colours('Adipisci Plaza 84 Low Off White'), ['white']);
  assert.deepEqual(colours('Кросівки Lorem Nox Heat Step 2 чорні'), ['black']);
  assert.deepEqual(modelCodes("Lorem Cursor 'Spring Day' 2025"), [], 'years are not codes');
  assert.ok(modelCodes('Lorem Aero Loft DN LX4410 006').includes('lx4410006'));
  const brand = { brand: 'Fakebrand' };
  // Different colourways of one model are not proposed, even through a chain.
  assert.deepEqual(findDuplicateCandidates([p('a', 'A', 'Fakebrand Plaza 84 Low Brown', brand), p('b', 'B', "Fakebrand Plaza 84 Low 'Green'", brand), p('c', 'C', 'Fakebrand Plaza 84 Low Off White', brand)]), []);
  assert.deepEqual(findDuplicateCandidates([p('a', 'A', 'Fakebrand Glide LX4410-002', brand), p('b', 'B', "Glide 'Black' Fakebrand LX4410 006", brand)]), []);
  // The same colourway still matches, and a full code wins over differently worded colours.
  assert.equal(findDuplicateCandidates([p('a', 'A', 'Fakebrand Swoop Low Mocha Glow шоколадні LM2604-124', brand), p('b', 'B', "Fakebrand Swoop Low 'Mocha Glow' brown LM2604 124", brand)])[0]?.confidence, 'high');
  assert.equal(findDuplicateCandidates([p('a', 'A', 'Fakebrand Plaza 84 Low Brown', brand), p('b', 'B', "Fakebrand Plaza 84 Low 'Brown'", brand)]).length, 1);
});
test('components are not chained across colourways through a colourless title', () => {
  const brand = { brand: 'Fakebrand' };
  const result = findDuplicateCandidates([p('n', 'A', 'Fakebrand Skyline Tailwind', brand), p('r', 'B', 'Fakebrand Skyline Tailwind Red', brand), p('g', 'C', 'Fakebrand Skyline Tailwind Green', brand)]);
  assert.equal(result.length, 1);
  assert.equal(result[0].productIds.length, 2, 'the colourless title joins one colourway only');
});
