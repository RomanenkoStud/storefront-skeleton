import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { readFileSync, readdirSync } from 'node:fs';
import { createHash } from 'node:crypto';
import worker from '../../apps/api/src/index.js';
import { withRoleMatrixForTests } from '../../apps/api/src/permissions.js';
import { normalizeCode, CODE_PREFIX } from '../../packages/catalog/cart.js';
import { buildSnapshot, reduceRecord } from '../../packages/catalog/delivery.js';
import { guid, loadSnapshot, r2Stub, syntheticUpstream } from '../fixtures/nova-poshta/records.js';

// All fixtures are synthetic and in-memory; nothing touches real inventory.
const migrationDir = new URL('../../migrations/', import.meta.url);
function database() {
  const sqlite = new DatabaseSync(':memory:');
  for (const name of readdirSync(migrationDir).filter(n => /^\d{4}_.*\.sql$/.test(n)).sort()) sqlite.exec(readFileSync(new URL(name, migrationDir), 'utf8'));
  const wrap = (sql, bindings = []) => ({ sql, bindings, bind(...v) { return wrap(sql, v); }, async first() { return sqlite.prepare(sql).get(...bindings) ?? null; }, async all() { return { results: sqlite.prepare(sql).all(...bindings) }; }, async run() { return sqlite.prepare(sql).run(...bindings); } });
  return { sqlite, prepare: sql => wrap(sql), async batch(statements) { sqlite.exec('BEGIN'); try { const result = statements.map(s => sqlite.prepare(s.sql).run(...s.bindings)); sqlite.exec('COMMIT'); return result; } catch (error) { sqlite.exec('ROLLBACK'); throw error; } }, close: () => sqlite.close() };
}
const sha256 = v => createHash('sha256').update(v).digest('hex');
const HOST = 'http://localhost';
const SECRET_MARKERS = ['supplier_id', 'supplierId', 'supplierName', 'unitCostMinor', 'externalProductId', 'variantIds', 'SUPPLIER-SECRET', 'EXT-SECRET', 'customer_id'];

function seed(db) {
  const s = db.sqlite;
  s.prepare("INSERT INTO suppliers(id,name,url,enabled,created_at) VALUES('sup1','SUPPLIER-SECRET Shop','https://mydrop.com.ua/secret',1,'2026-01-01T00:00:00Z')").run();
  s.prepare("INSERT INTO suppliers(id,name,url,enabled,created_at) VALUES('sup-off','Disabled','https://mydrop.com.ua/off',0,'2026-01-01T00:00:00Z')").run();
  const add = (id, supplier, slug, variants, overrides = {}, deleted = null) => s.prepare('INSERT INTO products(id,supplier_id,external_id,source_json,overrides_json,slug,updated_at,deleted_at) VALUES(?,?,?,?,?,?,?,?)').run(id, supplier, 'EXT-SECRET-' + id,
    JSON.stringify({ externalId: 'EXT-SECRET-' + id, title: 'Coat ' + id, description: 'd', category: 'Coats', costMinor: 10000, currency: 'UAH', photos: ['https://example.com/' + id + '.jpg'], variants }), JSON.stringify({ published: 1, markupType: 'fixed', markupValue: 5000, ...overrides }), slug, '2026-01-01T00:00:00Z', deleted);
  add('p1', 'sup1', 'coat-p1', [{ id: 'v-s', size: 'S', stock: 3 }, { id: 'v-m', size: 'M', stock: 2 }, { id: 'v-m2', size: 'M', stock: 4 }, { id: 'v-xl', size: 'XL', stock: 0 }, { id: 'v-h', size: 'HID', stock: 9 }], { hiddenSizes: ['HID'] });
  add('p2', 'sup1', 'coat-p2', [{ id: 'w-l', size: 'L', stock: 5 }]);
  add('unpub', 'sup1', 'coat-unpub', [{ id: 'u', size: 'S', stock: 5 }], { published: false });
  add('trashed', 'sup1', 'coat-trashed', [{ id: 't', size: 'S', stock: 5 }], {}, '2026-02-01T00:00:00Z');
  add('offsup', 'sup-off', 'coat-off', [{ id: 'o', size: 'S', stock: 5 }]);
}
function customer(db, id = 'cust1', token = 'A'.repeat(43)) {
  const now = new Date().toISOString(), later = new Date(Date.now() + 86400000).toISOString();
  db.sqlite.prepare("INSERT INTO customers(id,status,created_at,updated_at) VALUES(?,'active',?,?)").run(id, now, now);
  db.sqlite.prepare("INSERT INTO customer_identities(id,customer_id,provider,subject,display_handle,created_at,last_used_at) VALUES(?,?,'google',?,?,?,?)").run('i-' + id, id, 'sub-' + id, 'PII-person@example.com', now, now);
  db.sqlite.prepare('INSERT INTO customer_sessions(token_hash,customer_id,created_at,authenticated_at,last_seen_at,idle_expires_at,absolute_expires_at) VALUES(?,?,?,?,?,?,?)').run(sha256(token), id, now, now, now, later, later);
  return 'ls_session_dev=' + token;
}
let staffCounter = 0;
function staff(db, role) {
  const n = ++staffCounter, now = new Date().toISOString(), later = new Date(Date.now() + 86400000).toISOString(), token = String(n).padStart(2, '0') + 'S'.repeat(41);
  db.sqlite.prepare("INSERT INTO staff_members(id,role,status,invited_email,google_sub,email,display_name,created_by,created_at,updated_at) VALUES(?,?,'active',?,?,?,'M','o',?,?)").run('st' + n, role, `m${n}@example.com`, 'gs' + n, `m${n}@example.com`, now, now);
  db.sqlite.prepare('INSERT INTO staff_sessions(token_hash,staff_id,created_at,authenticated_at,last_seen_at,idle_expires_at,absolute_expires_at) VALUES(?,?,?,?,?,?,?)').run(sha256(token), 'st' + n, now, now, now, later, later);
  return 'ls_staff_dev=' + token;
}

async function setup(t, opts = {}) {
  const db = database(); seed(db);
  t.after(() => db.close());
  const base = { DB: db, APP_ENV: 'development', CUSTOMER_AUTH_HMAC_KEY: 'fake-hmac', CF_ACCESS_TEAM_NAME: 'team', CF_ACCESS_AUD: 'aud', ...opts.env };
  const call = async (path, { method = 'GET', body, headers = {}, origin = HOST, env = {}, raw, ip = '203.0.113.7' } = {}) => {
    const h = { 'CF-Connecting-IP': ip, ...headers };
    if (origin) h.Origin = origin;
    if (body !== undefined && raw === undefined) h['Content-Type'] = 'application/json';
    const response = await worker.fetch(new Request(HOST + path, { method, headers: h, body: raw ?? (body === undefined ? undefined : JSON.stringify(body)) }), { ...base, ...env });
    const type = response.headers.get('Content-Type') || '';
    return { status: response.status, headers: response.headers, text: null, data: type.includes('json') ? await response.json() : await response.text() };
  };
  const checkout = (lines, extra = {}) => call('/api/cart/checkout', { method: 'POST', body: { lines }, ...extra });
  const admin = (role, mount = 'admin') => {
    const env = mount === 'admin' ? { AUTH_DEV_BYPASS: 'true', DEV_STAFF_ROLE: role } : {}, headers = mount === 'staff' ? { Cookie: staff(db, role) } : {};
    return (path, options = {}) => call(`/api/${mount === 'admin' ? 'admin' : 'staff/admin'}${path}`, { ...options, env: { ...env, ...options.env }, headers: { ...headers, ...options.headers } });
  };
  return { db, call, checkout, admin };
}
const line = (productId, size, quantity = 1) => ({ productId, size, quantity });
const cartRows = db => db.sqlite.prepare('SELECT * FROM carts').all();
const leaks = value => SECRET_MARKERS.filter(marker => JSON.stringify(value).includes(marker));

test('happy path: server prices, snapshot of private fields, 201 shape without private data', async t => {
  const { db, checkout } = await setup(t);
  const r = await checkout([line('p1', 'M', 2), line('p2', 'L', 1)]);
  assert.equal(r.status, 201);
  assert.match(r.headers.get('Cache-Control'), /no-store/);
  const { cart } = r.data;
  assert.match(cart.code, /^SS-[0-9A-HJKMNP-TV-Z]{4}-[0-9A-HJKMNP-TV-Z]{4}$/);
  assert.deepEqual({ ...cart, code: undefined, createdAt: undefined, lines: undefined }, { status: 'submitted', itemCount: 3, totalMinor: 15000 * 3, currency: 'UAH', bound: false, delivery: null, recipient: null, code: undefined, createdAt: undefined, lines: undefined });
  assert.deepEqual(cart.lines[0], { productId: 'p1', slug: 'coat-p1', title: 'Coat p1', size: 'M', quantity: 2, unitPriceMinor: 15000, lineTotalMinor: 30000, photo: 'https://example.com/p1.jpg' });
  assert.deepEqual(leaks(r.data), [], 'public response has no private fields');
  const rows = db.sqlite.prepare('SELECT * FROM cart_lines ORDER BY position').all();
  assert.equal(rows.length, 2);
  assert.equal(rows[0].supplier_id, 'sup1'); assert.equal(rows[0].supplier_name, 'SUPPLIER-SECRET Shop'); assert.equal(rows[0].external_product_id, 'EXT-SECRET-p1');
  assert.deepEqual(JSON.parse(rows[0].variant_ids_json), ['v-m', 'v-m2'], 'all in-stock variants of that size, never hidden or empty ones');
  assert.equal(rows[0].unit_cost_minor, 10000);
  assert.equal(cartRows(db)[0].customer_id, null);
});

test('price tampering and unknown fields are ignored: the server prices every line', async t => {
  const { call, checkout } = await setup(t);
  const r = await checkout([{ ...line('p2', 'L', 2), unitPriceMinor: 1, priceMinor: 1, totalMinor: 1, title: 'Free' }], {});
  assert.equal(r.status, 201); assert.equal(r.data.cart.totalMinor, 30000); assert.equal(r.data.cart.lines[0].title, 'Coat p2');
  const tampered = await call('/api/cart/checkout', { method: 'POST', body: { lines: [line('p2', 'L')], totalMinor: 1, currency: 'USD' } });
  assert.equal(tampered.status, 400); assert.equal(tampered.data.error, 'invalid_request', 'top-level price/currency fields are rejected');
});

test('shape problems: 400 invalid_cart with every validateCheckoutLines code, nothing stored', async t => {
  const { db, call, checkout } = await setup(t);
  let n = 0;
  const bad = async lines => { const r = await checkout(lines, { ip: '10.0.0.' + (++n) }); assert.equal(r.status, 400); assert.equal(r.data.error, 'invalid_cart'); return r.data.problems.map(p => p.code); };
  assert.deepEqual(await bad([]), ['lines_required']);
  assert.deepEqual(await bad(undefined), ['lines_required']);
  assert.ok((await bad(Array.from({ length: 21 }, (_, i) => line('p1', 'S' + i)))).includes('too_many_lines'));
  assert.deepEqual(await bad(['x']), ['invalid_line']);
  assert.deepEqual(await bad([{ size: 'S', quantity: 1 }]), ['invalid_product_id']);
  assert.deepEqual(await bad([{ productId: 'p1', quantity: 1 }]), ['invalid_size']);
  for (const quantity of [0, 11, 1.5, '2', null]) assert.deepEqual(await bad([line('p1', 'S', quantity)]), ['invalid_quantity']);
  assert.deepEqual(await bad([line('p1', 'S'), line('p1', 'S', 2)]), ['duplicate_line']);
  const notJson = await call('/api/cart/checkout', { method: 'POST', ip: '10.1.1.1', raw: '{nope', headers: { 'Content-Type': 'application/json' } });
  assert.equal(notJson.status, 400); assert.equal(notJson.data.error, 'invalid_request');
  assert.equal(cartRows(db).length, 0);
});

test('availability problems: product_unavailable, size_unavailable, insufficient_stock; all-or-nothing', async t => {
  const { db, checkout } = await setup(t);
  const r = await checkout([line('p1', 'S', 1), line('unpub', 'S'), line('trashed', 'S'), line('offsup', 'S'), line('nope', 'S'), line('p1', 'HID'), line('p1', 'ZZ'), line('p1', 'XL'), line('p1', 'M', 7), line('p2', 'L', 6)]);
  assert.equal(r.status, 409); assert.equal(r.data.error, 'cart_unavailable');
  assert.deepEqual(r.data.problems, [
    { index: 1, code: 'product_unavailable' }, { index: 2, code: 'product_unavailable' }, { index: 3, code: 'product_unavailable' }, { index: 4, code: 'product_unavailable' },
    { index: 5, code: 'size_unavailable' }, { index: 6, code: 'size_unavailable' },
    { index: 7, code: 'insufficient_stock', available: 0 }, { index: 8, code: 'insufficient_stock', available: 6 }, { index: 9, code: 'insufficient_stock', available: 5 },
  ]);
  assert.equal(cartRows(db).length, 0); assert.equal(db.sqlite.prepare('SELECT COUNT(*) n FROM cart_lines').get().n, 0);
  assert.equal((await checkout([line('p1', 'M', 6)])).status, 201, 'stock of same-size variants is summed');
});

test('overrides and lifecycle are honored at checkout time (unpublished, trashed, hidden size)', async t => {
  const { db, checkout } = await setup(t);
  db.sqlite.prepare("UPDATE products SET overrides_json='{\"published\":1,\"markupType\":\"percent\",\"markupValue\":50}' WHERE id='p2'").run();
  assert.equal((await checkout([line('p2', 'L')])).data.cart.lines[0].unitPriceMinor, 15000);
  db.sqlite.prepare("UPDATE products SET deleted_at='2026-03-01T00:00:00Z' WHERE id='p2'").run();
  assert.equal((await checkout([line('p2', 'L')])).data.problems[0].code, 'product_unavailable');
});

test('same-origin, JSON and method enforcement with coded errors', async t => {
  const { db, call, checkout } = await setup(t);
  assert.deepEqual((await checkout([line('p2', 'L')], { origin: 'https://evil.test' })).data, { error: 'forbidden_origin' });
  assert.equal((await checkout([line('p2', 'L')], { origin: null })).status, 403);
  const form = await call('/api/cart/checkout', { method: 'POST', raw: 'lines=1', headers: { 'Content-Type': 'application/x-www-form-urlencoded' } });
  assert.equal(form.status, 415); assert.deepEqual(form.data, { error: 'json_required' });
  assert.equal((await call('/api/cart/checkout')).status, 405);
  assert.equal((await call('/api/cart/other', { method: 'POST', body: {} })).status, 404);
  assert.equal(cartRows(db).length, 0);
});

test('checkout is throttled per client IP with Retry-After', async t => {
  const { checkout } = await setup(t);
  for (let i = 0; i < 10; i++) assert.equal((await checkout([line('p2', 'L')])).status, 201);
  const limited = await checkout([line('p2', 'L')]);
  assert.equal(limited.status, 429); assert.deepEqual(limited.data, { error: 'rate_limited' }); assert.ok(Number(limited.headers.get('Retry-After')) >= 1);
  assert.equal((await checkout([line('p2', 'L')], { ip: '198.51.100.9' })).status, 201, 'another IP has its own bucket');
});

test('code collisions retry up to 5 times, then fail without partial rows', async t => {
  const { db, checkout } = await setup(t);
  const first = (await checkout([line('p2', 'L')])).data.cart.code;
  const originalGetRandom = crypto.getRandomValues.bind(crypto);
  const body = normalizeCode(first).slice(CODE_PREFIX.length + 1).replace('-', '');
  const bytes = [...body].map(c => '0123456789ABCDEFGHJKMNPQRSTVWXYZ'.indexOf(c));
  let calls = 0;
  crypto.getRandomValues = array => { if (array.length === 8 && calls < 2) { calls++; array.set(bytes); return array; } return originalGetRandom(array); };
  try {
    const r = await checkout([line('p2', 'L')]);
    assert.equal(r.status, 201); assert.notEqual(r.data.cart.code, first); assert.equal(calls, 2, 'two collisions then success');
    calls = -100;
    crypto.getRandomValues = array => { if (array.length === 8) { array.set(bytes); return array; } return originalGetRandom(array); };
    const stuck = await checkout([line('p2', 'L')]);
    assert.equal(stuck.status, 503); assert.deepEqual(stuck.data, { error: 'code_unavailable' });
  } finally { crypto.getRandomValues = originalGetRandom; }
  assert.equal(cartRows(db).length, 2); assert.equal(db.sqlite.prepare('SELECT COUNT(*) n FROM cart_lines').get().n, 2);
});

test('a failing line insert rolls the whole cart back (all-or-nothing)', async t => {
  const { db, checkout } = await setup(t);
  db.sqlite.exec("CREATE TRIGGER fail_line BEFORE INSERT ON cart_lines WHEN NEW.position=1 BEGIN SELECT RAISE(ABORT,'boom'); END");
  assert.equal((await checkout([line('p1', 'S'), line('p2', 'L')])).status, 500);
  assert.equal(cartRows(db).length, 0); assert.equal(db.sqlite.prepare('SELECT COUNT(*) n FROM cart_lines').get().n, 0);
});

test('anonymous vs bound checkout; stale cookie stays anonymous; account history and export hide private data', async t => {
  const { db, call, checkout } = await setup(t);
  const cookie = customer(db);
  const bound = await checkout([line('p1', 'S', 2)], { headers: { Cookie: cookie } });
  assert.equal(bound.status, 201); assert.equal(bound.data.cart.bound, true);
  assert.deepEqual(leaks(bound.data), []);
  const stale = await checkout([line('p2', 'L')], { headers: { Cookie: 'ls_session_dev=' + 'B'.repeat(43) } });
  assert.equal(stale.data.cart.bound, false);
  const anon = await checkout([line('p2', 'L')]);
  assert.equal(anon.data.cart.bound, false);
  assert.equal(db.sqlite.prepare("SELECT COUNT(*) n FROM carts WHERE customer_id='cust1'").get().n, 1);

  const other = customer(db, 'cust2', 'C'.repeat(43));
  assert.equal((await checkout([line('p2', 'L')], { headers: { Cookie: other } })).status, 201);
  const mine = await call('/api/account/carts', { headers: { Cookie: cookie } });
  assert.equal(mine.status, 200); assert.equal(mine.data.carts.length, 1);
  assert.equal(mine.data.carts[0].code, bound.data.cart.code);
  assert.deepEqual(Object.keys(mine.data.carts[0]).sort(), ['code', 'createdAt', 'currency', 'delivery', 'itemCount', 'lines', 'personalDataErasedAt', 'recipient', 'status', 'totalMinor']);
  assert.equal(mine.data.carts[0].personalDataErasedAt, null);
  assert.deepEqual(mine.data.carts[0].lines, bound.data.cart.lines);
  assert.deepEqual(leaks(mine.data), []);
  const unauth = await call('/api/account/carts');
  assert.equal(unauth.status, 401); assert.deepEqual(unauth.data, { error: 'unauthenticated' });
  const exported = await call('/api/account/export', { headers: { Cookie: cookie } });
  assert.equal(exported.status, 200); assert.equal(exported.data.carts.length, 1); assert.equal(exported.data.carts[0].code, bound.data.cart.code);
  assert.deepEqual(leaks(exported.data.carts), []); assert.ok(exported.data.profile && exported.data.identities);
  assert.match(exported.headers.get('Content-Disposition'), /attachment/);
});

test('account deletion unbinds carts (ON DELETE SET NULL) and keeps the snapshot', async t => {
  const { db, call, checkout } = await setup(t);
  const cookie = customer(db);
  const created = await checkout([line('p1', 'S')], { headers: { Cookie: cookie } });
  const gone = await call('/api/account', { method: 'DELETE', body: { confirm: true }, headers: { Cookie: cookie } });
  assert.equal(gone.status, 200);
  const row = db.sqlite.prepare('SELECT * FROM carts WHERE code=?').get(created.data.cart.code);
  assert.ok(row); assert.equal(row.customer_id, null);
  assert.equal(db.sqlite.prepare('SELECT COUNT(*) n FROM cart_lines WHERE cart_id=?').get(row.id).n, 1);
});

for (const mount of ['admin', 'staff']) {
  test(`manager list/detail via /api/${mount === 'admin' ? 'admin' : 'staff/admin'}: private fields for staff, never customer account data`, async t => {
    const { db, checkout, admin } = await setup(t);
    const cookie = customer(db);
    const a = (await checkout([line('p1', 'M', 2), line('p2', 'L')], { headers: { Cookie: cookie } })).data.cart;
    const b = (await checkout([line('p2', 'L')])).data.cart;
    const mgr = admin('manager', mount);
    const list = await mgr('/carts');
    assert.equal(list.status, 200); assert.match(list.headers.get('Cache-Control'), /no-store/);
    assert.equal(list.data.page, 1); assert.equal(list.data.pageSize, 40); assert.equal(list.data.total, 2);
    assert.deepEqual(Object.keys(list.data.carts[0]).sort(), ['bound', 'code', 'createdAt', 'currency', 'delivery', 'itemCount', 'managerNote', 'personalDataErasedAt', 'recipient', 'status', 'statusChangedAt', 'totalMinor']);
    assert.deepEqual(list.data.carts.map(c => [c.recipient, c.delivery, c.personalDataErasedAt]), [[null, null, null], [null, null, null]], 'no snapshot was given');
    assert.deepEqual(list.data.carts.map(c => c.bound).sort(), [false, true]);
    assert.ok(!JSON.stringify(list.data).includes('cust1') && !JSON.stringify(list.data).includes('PII-person'));

    const detail = await mgr('/carts/' + a.code.toLowerCase().replace(/-/g, ' '));
    assert.equal(detail.status, 200, 'lookup normalizes case and separators');
    const d = detail.data.cart;
    assert.equal(d.code, a.code); assert.equal(d.bound, true); assert.deepEqual(d.allowedTransitions, ['verified', 'cancelled']);
    assert.equal(d.statusActor, null); assert.equal(d.managerNote, null);
    assert.deepEqual(Object.keys(d).sort(), ['allowedTransitions', 'bound', 'code', 'createdAt', 'currency', 'delivery', 'itemCount', 'lines', 'managerNote', 'personalDataErasedAt', 'recipient', 'status', 'statusActor', 'statusChangedAt', 'totalMinor', 'updatedAt']);
    assert.deepEqual(d.lines[0], { ...a.lines[0], supplierId: 'sup1', supplierName: 'SUPPLIER-SECRET Shop', externalProductId: 'EXT-SECRET-p1', variantIds: ['v-m', 'v-m2'], unitCostMinor: 10000 });
    const text = JSON.stringify(detail.data);
    for (const pii of ['cust1', 'customer_id', 'customerId', 'PII-person', 'example.com/p1']) if (pii !== 'example.com/p1') assert.ok(!text.includes(pii), pii);
    assert.ok(b.code);

    assert.equal((await mgr('/carts/UUU')).status, 400);
    assert.deepEqual((await mgr('/carts/UUU')).data, { error: 'invalid_code' });
    assert.deepEqual((await mgr('/carts/SS-0000-0000')).data, { error: 'not_found' });
    assert.equal((await mgr('/carts?status=submitted')).data.total, 2);
    assert.equal((await mgr('/carts?status=verified')).data.total, 0);
    for (const q of ['status=bogus', 'page=0', 'page=x', 'page=-1']) assert.deepEqual((await mgr('/carts?' + q)).data, { error: 'invalid_request' }, q);
    assert.equal((await mgr('/carts?page=2')).data.carts.length, 0);
  });
}

test('manager list q is a partial, case-insensitive, normalized, wildcard-safe code search', async t => {
  const { db, checkout, admin } = await setup(t);
  const code = (await checkout([line('p2', 'L')])).data.cart.code;
  await checkout([line('p2', 'L')]);
  db.sqlite.prepare("UPDATE carts SET code='SS-AB10-11Z0' WHERE code=?").run(code);
  const mgr = admin('manager');
  const q = async value => (await mgr('/carts?q=' + encodeURIComponent(value))).data;
  assert.equal((await q('ab1o')).total, 1, 'substring');
  assert.equal((await q('ss-ab10-11z0')).total, 1, 'full code with I/L->1, O->0 mapping');
  assert.equal((await q('b1 0-ll')).total, 1, 'spaces and hyphens ignored');
  assert.equal((await q('SS')).total, 2, 'a bare SS prefix matches all');
  assert.equal((await q('ss-ab1')).total, 1, 'optional SS prefix');
  assert.equal((await q('AB1\u20130')).total, 1, 'en dash separator');
  assert.equal((await q('\uFF21\uFF22\uFF11\uFF10')).total, 1, 'full-width input is folded (NFKC)');
  assert.equal((await q('ab1.0_')).total, 1, 'dots and underscores are separators');
  assert.equal((await q('%')).total, 0, 'wildcard is escaped');
  assert.equal((await q('_')).total, 2, 'underscore is a separator, so an empty fragment applies no filter');
  assert.equal((await q('A_B%')).total, 0, 'percent after folding is escaped, not a wildcard');
  assert.equal((await q('X'.repeat(40))).total, 0, 'overlong query is capped, matches nothing');
  assert.equal((await q('zzzzz')).total, 0);
});

test('pagination: 40 per page, newest first', async t => {
  const { db, admin } = await setup(t);
  const insert = db.sqlite.prepare("INSERT INTO carts(id,code,status,item_count,total_minor,currency,created_at,updated_at,status_changed_at) VALUES(?,?,'submitted',1,100,'UAH',?,?,?)");
  for (let i = 0; i < 45; i++) { const at = new Date(Date.UTC(2026, 0, 1, 0, i)).toISOString(); insert.run('id' + i, 'SS-0000-' + String(1000 + i), at, at, at); }
  const mgr = admin('manager');
  const one = (await mgr('/carts')).data, two = (await mgr('/carts?page=2')).data;
  assert.equal(one.carts.length, 40); assert.equal(two.carts.length, 5); assert.equal(one.total, 45);
  assert.equal(one.carts[0].code, 'SS-0000-1044'); assert.equal(two.carts[4].code, 'SS-0000-1000');
});

for (const mount of ['admin', 'staff']) {
  test(`permission gating via ${mount} mount: anonymous 401, orders.read vs orders.operate`, async t => {
    const { db, call, checkout, admin } = await setup(t);
    const code = (await checkout([line('p2', 'L')])).data.cart.code;
    const prefix = mount === 'admin' ? '/api/admin' : '/api/staff/admin';
    for (const [method, path, body] of [['GET', '/carts'], ['GET', '/carts/' + code], ['POST', `/carts/${code}/status`, { status: 'verified', expectedStatus: 'submitted' }]]) {
      assert.equal((await call(prefix + path, { method, body, env: mount === 'admin' ? { APP_ENV: 'production' } : {} })).status, 401, `anon ${method} ${path}`);
    }
    const before = db.sqlite.prepare('SELECT * FROM carts').all(), auditBefore = db.sqlite.prepare('SELECT COUNT(*) n FROM audit_events').get().n;
    // Read-only role: orders.read without orders.operate.
    await withRoleMatrixForTests({ manager: ['orders.read'] }, async () => {
      const reader = admin('manager', mount);
      assert.equal((await reader('/carts')).status, 200);
      assert.equal((await reader('/carts/' + code)).status, 200);
      const denied = await reader(`/carts/${code}/status`, { method: 'POST', body: { status: 'verified', expectedStatus: 'submitted' } });
      assert.equal(denied.status, 403);
    });
    // No orders permissions at all.
    await withRoleMatrixForTests({ manager: ['catalog.read'] }, async () => {
      const none = admin('manager', mount);
      assert.equal((await none('/carts')).status, 403);
      assert.equal((await none('/carts/' + code)).status, 403);
      assert.equal((await none(`/carts/${code}/status`, { method: 'POST', body: { status: 'verified', expectedStatus: 'submitted' } })).status, 403);
    });
    assert.deepEqual(db.sqlite.prepare('SELECT * FROM carts').all(), before, 'a denied request changes nothing');
    assert.equal(db.sqlite.prepare('SELECT COUNT(*) n FROM audit_events').get().n, auditBefore);
    const ok = await admin('manager', mount)(`/carts/${code}/status`, { method: 'POST', body: { status: 'verified', expectedStatus: 'submitted' } });
    assert.equal(ok.status, 200);
    assert.equal((await admin('owner', mount)(`/carts/${code}`)).data.cart.status, 'verified');
    // completing needs orders.operate too; the read-only principal still sees the cart.
    db.sqlite.prepare("UPDATE carts SET status='sent_to_suppliers' WHERE code=?").run(code);
    const audits = db.sqlite.prepare('SELECT COUNT(*) n FROM audit_events').get().n;
    await withRoleMatrixForTests({ manager: ['orders.read'] }, async () => {
      const reader = admin('manager', mount);
      assert.deepEqual((await reader('/carts/' + code)).data.cart.allowedTransitions, ['completed']);
      assert.equal((await reader(`/carts/${code}/status`, { method: 'POST', body: { status: 'completed', expectedStatus: 'sent_to_suppliers' } })).status, 403);
    });
    assert.equal(db.sqlite.prepare('SELECT status FROM carts WHERE code=?').get(code).status, 'sent_to_suppliers');
    assert.equal(db.sqlite.prepare('SELECT COUNT(*) n FROM audit_events').get().n, audits);
    const done = await admin('owner', mount)(`/carts/${code}/status`, { method: 'POST', body: { status: 'completed', expectedStatus: 'sent_to_suppliers' } });
    assert.equal(done.status, 200); assert.equal(done.data.cart.status, 'completed');
    assert.equal((await admin('owner', mount)('/carts?status=completed')).data.total, 1, 'completed is a list filter');
  });
}

test('customer cookie and cross-origin cannot reach admin carts or change status', async t => {
  const { db, call, checkout } = await setup(t);
  const code = (await checkout([line('p2', 'L')])).data.cart.code;
  const cookie = customer(db);
  assert.equal((await call('/api/admin/carts', { headers: { Cookie: cookie }, env: { APP_ENV: 'production' } })).status, 401);
  assert.equal((await call('/api/staff/admin/carts', { headers: { Cookie: cookie } })).status, 401);
  const cross = await call(`/api/admin/carts/${code}/status`, { method: 'POST', body: { status: 'verified', expectedStatus: 'submitted' }, origin: 'https://evil.test', env: { AUTH_DEV_BYPASS: 'true' } });
  assert.equal(cross.status, 403);
  assert.equal(db.sqlite.prepare('SELECT status FROM carts').get().status, 'submitted');
});

test('status workflow: legal transitions, audit row, notes, terminal states, invalid and malformed requests', async t => {
  const { db, checkout, admin } = await setup(t);
  const code = (await checkout([line('p2', 'L')])).data.cart.code;
  const mgr = admin('manager');
  const post = (body, who = mgr) => who(`/carts/${code}/status`, { method: 'POST', body });
  const at = db.sqlite.prepare('SELECT created_at FROM carts').get().created_at;

  assert.deepEqual((await post({ status: 'sent_to_suppliers', expectedStatus: 'submitted' })).data, { error: 'invalid_transition' });
  assert.deepEqual((await post({ status: 'submitted', expectedStatus: 'submitted' })).data, { error: 'invalid_transition' });
  for (const body of [{}, { status: 'verified' }, { status: 'bogus', expectedStatus: 'submitted' }, { status: 'verified', expectedStatus: 'submitted', note: 5 }, { status: 'verified', expectedStatus: 'submitted', note: 'x'.repeat(501) }, { status: 'verified', expectedStatus: 'submitted', note: ' ' + 'x'.repeat(501) + ' ' }, { status: 'verified', expectedStatus: 'submitted', extra: 1 }])
    assert.deepEqual((await post(body)).data, { error: 'invalid_request' }, JSON.stringify(body).slice(0, 60));
  assert.equal(db.sqlite.prepare('SELECT COUNT(*) n FROM audit_events').get().n, 0, 'rejected requests leave no audit');
  assert.equal(db.sqlite.prepare('SELECT status FROM carts').get().status, 'submitted');

  const verified = await post({ status: 'verified', expectedStatus: 'submitted', note: '  checked stock  ' });
  assert.equal(verified.status, 200);
  assert.equal(verified.data.cart.status, 'verified'); assert.equal(verified.data.cart.managerNote, 'checked stock'); assert.equal(verified.data.cart.statusActor, 'dev@localhost');
  assert.deepEqual(verified.data.cart.allowedTransitions, ['sent_to_suppliers', 'cancelled']);
  assert.equal(verified.data.cart.createdAt, at, 'snapshot fields do not change');
  assert.ok(verified.data.cart.lines[0].supplierName);
  const audit = db.sqlite.prepare('SELECT * FROM audit_events').all();
  assert.equal(audit.length, 1);
  assert.deepEqual({ action: audit[0].action, resource: audit[0].resource_id, actor: audit[0].actor, type: audit[0].actor_type, role: audit[0].actor_role, details: JSON.parse(audit[0].details_json) }, { action: 'cart.status', resource: code, actor: 'dev@localhost', type: 'dev', role: 'manager', details: { from: 'submitted', to: 'verified', noteChanged: true } });
  assert.ok(!audit[0].details_json.includes('checked stock'), 'note text is never copied into the audit trail');

  const sent = await post({ status: 'sent_to_suppliers', expectedStatus: 'verified' });
  assert.equal(JSON.parse(db.sqlite.prepare("SELECT details_json FROM audit_events ORDER BY rowid DESC").get().details_json).noteChanged, false);
  assert.equal(sent.status, 200); assert.equal(sent.data.cart.managerNote, 'checked stock', 'note kept when none is supplied'); assert.deepEqual(sent.data.cart.allowedTransitions, ['completed']);
  assert.deepEqual((await post({ status: 'cancelled', expectedStatus: 'sent_to_suppliers' })).data, { error: 'invalid_transition' }, 'sent orders cannot be cancelled');
  assert.equal(db.sqlite.prepare('SELECT COUNT(*) n FROM audit_events').get().n, 2);
  // «Виконано» only from sent_to_suppliers, audited like the others, then terminal.
  const done = await post({ status: 'completed', expectedStatus: 'sent_to_suppliers', note: 'отримано' });
  assert.equal(done.status, 200); assert.equal(done.data.cart.status, 'completed'); assert.deepEqual(done.data.cart.allowedTransitions, []); assert.equal(done.data.cart.managerNote, 'отримано');
  const doneAudit = db.sqlite.prepare("SELECT * FROM audit_events ORDER BY rowid DESC").get();
  assert.deepEqual({ action: doneAudit.action, resource: doneAudit.resource_id, role: doneAudit.actor_role, details: JSON.parse(doneAudit.details_json) }, { action: 'cart.status', resource: code, role: 'manager', details: { from: 'sent_to_suppliers', to: 'completed', noteChanged: true } });
  for (const [status, expectedStatus] of [['cancelled', 'completed'], ['sent_to_suppliers', 'completed'], ['verified', 'completed'], ['completed', 'completed']]) assert.deepEqual((await post({ status, expectedStatus })).data, { error: 'invalid_transition' }, `${expectedStatus}->${status}`);
  assert.equal(db.sqlite.prepare('SELECT COUNT(*) n FROM audit_events').get().n, 3);
  assert.deepEqual((await mgr('/carts/SS-0000-0000/status', { method: 'POST', body: { status: 'verified', expectedStatus: 'submitted' } })).data, { error: 'not_found' });
  assert.deepEqual((await mgr('/carts/bad/status', { method: 'POST', body: { status: 'verified', expectedStatus: 'submitted' } })).data, { error: 'invalid_code' });
  const form = await mgr(`/carts/${code}/status`, { method: 'POST', raw: 'status=verified', headers: { 'Content-Type': 'text/plain' } });
  assert.equal(form.status, 415);
});

test('stale expectedStatus returns 409 with currentStatus and writes nothing; cancel path from submitted', async t => {
  const { db, checkout, admin } = await setup(t);
  const code = (await checkout([line('p2', 'L')])).data.cart.code, mgr = admin('manager'), owner = admin('owner');
  assert.equal((await mgr(`/carts/${code}/status`, { method: 'POST', body: { status: 'verified', expectedStatus: 'submitted' } })).status, 200);
  const audits = db.sqlite.prepare('SELECT COUNT(*) n FROM audit_events').get().n, snapshot = JSON.stringify(db.sqlite.prepare('SELECT * FROM carts').all());
  const conflict = await owner(`/carts/${code}/status`, { method: 'POST', body: { status: 'cancelled', expectedStatus: 'submitted' } });
  assert.equal(conflict.status, 409); assert.deepEqual(conflict.data, { error: 'status_conflict', currentStatus: 'verified' });
  assert.equal(JSON.stringify(db.sqlite.prepare('SELECT * FROM carts').all()), snapshot); assert.equal(db.sqlite.prepare('SELECT COUNT(*) n FROM audit_events').get().n, audits);
  assert.equal((await owner(`/carts/${code}/status`, { method: 'POST', body: { status: 'cancelled', expectedStatus: 'verified' } })).data.cart.status, 'cancelled');
});

test('race: the guarded UPDATE decides; a concurrent change after the read yields 409 and no audit', async t => {
  const { db, checkout, admin } = await setup(t);
  const code = (await checkout([line('p2', 'L')])).data.cart.code, mgr = admin('manager');
  // Simulate another manager winning between our read and our write.
  db.sqlite.exec(`CREATE TRIGGER race BEFORE UPDATE ON carts WHEN NEW.status='verified' AND OLD.status='submitted' AND (SELECT COUNT(*) FROM audit_events)=0 BEGIN SELECT RAISE(IGNORE); END`);
  const lost = await mgr(`/carts/${code}/status`, { method: 'POST', body: { status: 'verified', expectedStatus: 'submitted' } });
  assert.equal(lost.status, 409); assert.equal(lost.data.currentStatus, 'submitted');
  assert.equal(db.sqlite.prepare('SELECT COUNT(*) n FROM audit_events').get().n, 0, 'audit is conditional on the guarded UPDATE changing a row');
});

test('actor label: managers without audit.read see owner Access actors as a label', async t => {
  const { db, checkout, admin } = await setup(t);
  const code = (await checkout([line('p2', 'L')])).data.cart.code;
  db.sqlite.prepare("UPDATE carts SET status_actor='boss@example.com' WHERE code=?").run(code);
  assert.notEqual((await admin('manager')(`/carts/${code}`)).data.cart.statusActor, 'boss@example.com');
});

test('product page: no-JS GET form for in-stock sizes only; note explains cart codes; page escapes size values', async t => {
  const { call, db } = await setup(t);
  const page = (await call('/products/coat-p1')).data;
  assert.match(page, /<form class="add-to-cart" method="get" action="\/cart">/);
  assert.match(page, /name="add" value="coat-p1"/);
  assert.equal([...page.matchAll(/type="radio" name="size" value="([^"]+)"/g)].map(m => m[1]).join(','), 'S,M', 'XL (no stock) and hidden sizes are absent, duplicate sizes merged');
  assert.match(page, /name="qty"/); assert.match(page, /<legend>/);
  assert.doesNotMatch(page, /поки недоступні/); assert.match(page, /ви отримаєте код кошика/); assert.doesNotMatch(page, /зв.яжеться/); assert.doesNotMatch(page, /Онлайн-оплати/);
  db.sqlite.prepare("UPDATE products SET source_json=json_set(source_json,'$.variants',json('[{\"id\":\"x\",\"size\":\"\\\"><b>\",\"stock\":1}]')) WHERE id='p2'").run();
  const escaped = (await call('/products/coat-p2')).data;
  assert.doesNotMatch(escaped, /value=""><b>/); assert.match(escaped, /&quot;&gt;&lt;b&gt;/);
  db.sqlite.prepare("UPDATE products SET source_json=json_set(source_json,'$.variants',json('[{\"id\":\"x\",\"size\":\"S\",\"stock\":0}]')) WHERE id='p2'").run();
  assert.doesNotMatch((await call('/products/coat-p2')).data, /add-to-cart/);
});

test('public product API still hides private and cart-only fields', async t => {
  const { call } = await setup(t);
  const data = (await call('/api/products/coat-p1')).data;
  assert.deepEqual(leaks(data), []);
});

test('production without the HMAC key fails closed instead of skipping the throttle', async t => {
  const { checkout, db } = await setup(t, { env: { APP_ENV: 'production', CUSTOMER_AUTH_HMAC_KEY: undefined } });
  const r = await checkout([line('p2', 'L')], { origin: HOST });
  assert.equal(r.status, 503); assert.equal(cartRows(db).length, 0);
});

test('checkout rejects unknown top-level keys; unknown keys inside a line are stripped', async t => {
  const { db, call, checkout } = await setup(t);
  const extra = await call('/api/cart/checkout', { method: 'POST', body: { lines: [line('p2', 'L')], coupon: 'x' } });
  assert.equal(extra.status, 400); assert.deepEqual(extra.data, { error: 'invalid_request' }); assert.equal(cartRows(db).length, 0);
  assert.equal((await checkout([{ ...line('p2', 'L'), priceMinor: 1 }])).status, 201);
});

test('exhausted code generation is 503 code_unavailable and leaves nothing behind', async t => {
  const { db, checkout } = await setup(t);
  const first = (await checkout([line('p2', 'L')])).data.cart.code;
  const real = crypto.getRandomValues.bind(crypto), bytes = [...first.slice(3).replace('-', '')].map(c => '0123456789ABCDEFGHJKMNPQRSTVWXYZ'.indexOf(c));
  crypto.getRandomValues = array => { if (array.length === 8) { array.set(bytes); return array; } return real(array); };
  const origError = console.error; console.error = () => {};
  try { const r = await checkout([line('p2', 'L')]); assert.equal(r.status, 503); assert.deepEqual(r.data, { error: 'code_unavailable' }); }
  finally { crypto.getRandomValues = real; console.error = origError; }
  assert.equal(cartRows(db).length, 1);
});

test('checkout prunes expired throttle rows (bounded) so the table cannot grow forever', async t => {
  const { db, checkout } = await setup(t);
  const insert = db.sqlite.prepare("INSERT INTO customer_auth_throttle(bucket,key_hmac,window_start,count) VALUES('old',?,?,1)");
  for (let i = 0; i < 60; i++) insert.run('k' + i, 1000 + i);
  await checkout([line('p2', 'L')]);
  assert.equal(db.sqlite.prepare("SELECT COUNT(*) n FROM customer_auth_throttle WHERE bucket='old'").get().n, 10, 'at most 50 expired rows per checkout');
  assert.equal(db.sqlite.prepare("SELECT COUNT(*) n FROM customer_auth_throttle WHERE bucket='cart-checkout'").get().n, 1, 'current window kept');
});

test('account export includes every cart while GET /api/account/carts is capped at 100', async t => {
  const { db, call } = await setup(t);
  const cookie = customer(db);
  const ins = db.sqlite.prepare("INSERT INTO carts(id,code,status,customer_id,item_count,total_minor,currency,created_at,updated_at,status_changed_at) VALUES(?,?,'submitted','cust1',1,100,'UAH',?,?,?)");
  const line1 = db.sqlite.prepare("INSERT INTO cart_lines(cart_id,position,product_id,slug,title,size,quantity,unit_price_minor,line_total_minor,photo,supplier_id,supplier_name,external_product_id,variant_ids_json) VALUES(?,0,'p2','coat-p2','T','L',1,100,100,NULL,'sup1','SUPPLIER-SECRET','EXT-SECRET','[]')");
  for (let i = 0; i < 105; i++) { const at = new Date(Date.UTC(2026, 0, 1, 0, i)).toISOString(); ins.run('c' + i, 'SS-0000-' + String(1000 + i), at, at, at); line1.run('c' + i); }
  assert.equal((await call('/api/account/carts', { headers: { Cookie: cookie } })).data.carts.length, 100);
  const exported = (await call('/api/account/export', { headers: { Cookie: cookie } })).data;
  assert.equal(exported.carts.length, 105); assert.ok(exported.carts.every(c => c.lines.length === 1)); assert.deepEqual(leaks(exported.carts), []);
});

// ---- delivery point (ADR-0011) ------------------------------------------------------------------
const catalogStub = options => { const map = new Map(); loadSnapshot(map, buildSnapshot(syntheticUpstream().map(reduceRecord).filter(Boolean), '20261117T003000Z')); return r2Stub(map, options); };
const REF_K10 = guid('wh-a'), REF_K5 = guid('wh-store'), REF_POSTOMAT = guid('wh-p1'), REF_LVIV = guid('wh-l1'), KYIV = guid('city-kyiv');
const NOW_ISO = '2026-11-01T10:00:00.000Z';
let ipCounter = 0;
async function deliverySetup(t, catalogOptions) {
  const bucket = catalogStub(catalogOptions), ctx = await setup(t, { env: { MEDIA: bucket } });
  const cookie = customer(ctx.db);
  const place = (delivery, { signedIn = true, lines = [line('p2', 'L')], body } = {}) => ctx.call('/api/cart/checkout', { method: 'POST', body: body ?? { lines, ...(delivery === undefined ? {} : { delivery }) }, headers: signedIn ? { Cookie: cookie } : {}, ip: `198.51.100.${++ipCounter % 250}` });
  const profile = () => { const row = ctx.db.sqlite.prepare('SELECT * FROM customer_profiles WHERE customer_id=?').get('cust1'); return row ? { ...row } : null; };
  const audits = () => ctx.db.sqlite.prepare("SELECT fields FROM customer_audit_events WHERE action='profile.delivery-remembered'").all().map(r => r.fields);
  const seedProfile = (row) => ctx.db.sqlite.prepare('INSERT INTO customer_profiles(customer_id,np_type,np_city_name,np_city_ref,np_warehouse_number,np_warehouse_ref,np_warehouse_name,np_note,np_source,np_origin,display_name,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)')
    .run('cust1', row.type ?? 'branch', row.cityName ?? 'Київ', row.cityRef ?? KYIV, row.number ?? '10', row.ref ?? null, row.name ?? 'Стара назва', row.note ?? 'нотатка', row.source, row.origin ?? null, row.displayName ?? null, NOW_ISO);
  return { ...ctx, bucket, cookie, place, profile, audits, seedProfile };
}

test('delivery input: only {warehouseRef} or null; invalid shapes are 400 invalid_delivery after the lines are checked; other keys stay invalid_request', async t => {
  const { place, db } = await deliverySetup(t);
  for (const delivery of [{}, { warehouseRef: 'x' }, { warehouseRef: REF_K10, note: 'x' }, { warehouseRef: REF_K10, type: 'branch' }, { warehouseRef: 5 }, { warehouseRef: null }, [REF_K10], REF_K10, 5, true, { warehouseRef: REF_K10 + '0' }]) {
    const r = await place(delivery); assert.equal(r.status, 400, JSON.stringify(delivery)); assert.deepEqual(r.data, { error: 'invalid_delivery' });
  }
  assert.equal((await place(null)).status, 201);
  assert.equal((await place(undefined)).status, 201);
  assert.equal((await place({ warehouseRef: REF_K10.toUpperCase() })).status, 201, 'a Ref is accepted in any case and stored lowercase');
  assert.equal(db.sqlite.prepare('SELECT dp_warehouse_ref r FROM carts ORDER BY created_at DESC, rowid DESC LIMIT 1').get().r, REF_K10);
  assert.equal((await place(undefined, { body: { lines: [line('p2', 'L')], delivery: { warehouseRef: REF_K10 }, note: 'x' } })).status, 400);
  assert.deepEqual((await place(undefined, { body: { lines: [], delivery: { warehouseRef: 'x' } } })).data.error, 'invalid_cart', 'line errors come before step 6a');
  assert.deepEqual((await place(undefined, { body: { lines: [line('p2', 'L')], delivery: { warehouseRef: REF_K10 }, extra: 1 } })).data, { error: 'invalid_request' });
  assert.equal((await place({ warehouseRef: REF_K10 }, { lines: [line('unpub', 'S')] })).status, 409, 'unavailable lines still win over delivery');
});

test('anonymous checkout ignores delivery: nothing resolved, stored or remembered, delivery null in the response', async t => {
  const { place, db, bucket, profile, audits } = await deliverySetup(t);
  const r = await place({ warehouseRef: REF_K10 }, { signedIn: false });
  assert.equal(r.status, 201); assert.equal(r.data.cart.delivery, null); assert.equal(r.data.cart.bound, false);
  assert.equal(bucket.calls.length, 0, 'the catalog is not even read');
  assert.deepEqual({ ...db.sqlite.prepare('SELECT dp_type,dp_city_name,dp_city_ref,dp_warehouse_number,dp_warehouse_ref,dp_warehouse_name FROM carts').get() }, { dp_type: null, dp_city_name: null, dp_city_ref: null, dp_warehouse_number: null, dp_warehouse_ref: null, dp_warehouse_name: null });
  assert.equal(profile(), null); assert.deepEqual(audits(), []);
  // an unknown or malformed Ref is still ignored when anonymous only if it is well-formed; a malformed one is a 400 for everyone
  assert.equal((await place({ warehouseRef: guid('nowhere') }, { signedIn: false })).status, 201);
  assert.equal((await place({ warehouseRef: 'bad' }, { signedIn: false })).status, 400);
  const withDeadCatalog = await deliverySetup(t, { failGet: () => true });
  assert.equal((await withDeadCatalog.place({ warehouseRef: REF_K10 }, { signedIn: false })).status, 201, 'an anonymous checkout does not depend on the catalog');
});

test('signed-in checkout stores the catalog copy, returns CartDelivery and remembers the favourite (one audit row, field names only)', async t => {
  const { place, db, profile, audits, call, cookie } = await deliverySetup(t);
  const r = await place({ warehouseRef: REF_POSTOMAT });
  assert.equal(r.status, 201); assert.equal(r.data.cart.bound, true);
  const expected = { type: 'postomat', cityName: 'Київ', cityRef: KYIV, warehouseNumber: '1001', warehouseRef: REF_POSTOMAT, warehouseName: 'Поштомат "Нова Пошта" №1001: вул. Сімʼї Кульженків, 31а' };
  assert.deepEqual(r.data.cart.delivery, expected);
  assert.deepEqual({ ...db.sqlite.prepare('SELECT dp_type,dp_city_name,dp_city_ref,dp_warehouse_number,dp_warehouse_ref,dp_warehouse_name FROM carts').get() }, { dp_type: 'postomat', dp_city_name: 'Київ', dp_city_ref: KYIV, dp_warehouse_number: '1001', dp_warehouse_ref: REF_POSTOMAT, dp_warehouse_name: expected.warehouseName });
  assert.deepEqual([profile().np_source, profile().np_origin, profile().np_note, profile().np_warehouse_ref], ['np-api', 'checkout', null, REF_POSTOMAT]);
  assert.deepEqual(audits(), ['["deliveryPreference"]']);
  assert.ok(!JSON.stringify(db.sqlite.prepare('SELECT * FROM customer_audit_events').all()).includes('Київ'));
  const mine = (await call('/api/account/carts', { headers: { Cookie: cookie } })).data.carts[0];
  assert.deepEqual(mine.delivery, expected);
  const exported = (await call('/api/account/export', { headers: { Cookie: cookie } })).data;
  assert.deepEqual(exported.carts[0].delivery, expected); assert.equal(exported.profile.deliveryPreference.origin, 'checkout'); assert.equal(exported.profile.deliveryPreference.warehouseName, expected.warehouseName);
  assert.deepEqual((await place(undefined)).data.cart.delivery, null, 'a cart without a point has delivery null');
  assert.deepEqual((await call('/api/account/carts', { headers: { Cookie: cookie } })).data.carts.map(c => c.delivery === null), [true, false]);
});

test('a Ref missing from the catalog is 409 delivery_unavailable; an unreadable catalog is 503 delivery_catalog_unavailable; both write nothing', async t => {
  const a = await deliverySetup(t);
  const missing = await a.place({ warehouseRef: guid('closed-point') });
  assert.equal(missing.status, 409); assert.deepEqual(missing.data, { error: 'delivery_unavailable' });
  assert.equal(cartRows(a.db).length, 0); assert.equal(a.profile(), null); assert.deepEqual(a.audits(), []);
  for (const [label, options, env] of [['failing bucket', { failGet: () => true }], ['no manifest', undefined, { MEDIA: r2Stub() }], ['no binding', undefined, { MEDIA: undefined }]]) {
    const b = await deliverySetup(t, options);
    const r = await b.call('/api/cart/checkout', { method: 'POST', body: { lines: [line('p2', 'L')], delivery: { warehouseRef: REF_K10 } }, headers: { Cookie: b.cookie }, env: env ?? {}, ip: '198.51.100.250' });
    assert.equal(r.status, 503, label); assert.deepEqual(r.data, { error: 'delivery_catalog_unavailable' });
    assert.equal(cartRows(b.db).length, 0, label); assert.equal(b.profile(), null);
    const retry = await b.call('/api/cart/checkout', { method: 'POST', body: { lines: [line('p2', 'L')] }, headers: { Cookie: b.cookie }, env: env ?? {}, ip: '198.51.100.251' });
    assert.equal(retry.status, 201, 'the retry without a point works');
  }
});

test('favourite rules (ADR-0011 section 7), row by row', async t => {
  const row = async (label, seed, expected) => {
    const a = await deliverySetup(t);
    if (seed) a.seedProfile(seed);
    const before = a.profile();
    const r = await a.place({ warehouseRef: REF_K10 });
    assert.equal(r.status, 201, label);
    assert.equal(r.data.cart.delivery.warehouseRef, REF_K10, `${label}: the cart always stores P`);
    const after = a.profile();
    assert.deepEqual([after.np_warehouse_ref, after.np_source, after.np_origin, after.np_warehouse_name === expected.name], [expected.ref, expected.source, expected.origin, true], label);
    assert.equal(a.audits().length, expected.audit, `${label}: audit rows`);
    if (seed?.source === 'manual') assert.equal(after.np_note, null, `${label}: the legacy note is not carried over by the replacement`);
    if (!expected.written) assert.deepEqual(after, before, `${label}: no write`); else assert.notEqual(after.updated_at, before?.updated_at);
    return a;
  };
  const P = { ref: REF_K10, source: 'np-api', origin: 'checkout', name: 'Відділення №10: вул. Тестова, 10', audit: 1, written: true };
  await row('no profile row', null, P);
  await row('profile row without a point', { type: null, cityName: null, cityRef: null, number: null, ref: null, name: null, note: null, source: null, displayName: 'Олена' }, P)
    .then(a => assert.equal(a.profile().display_name, 'Олена', 'other profile fields survive'));
  await row('np-api checkout, other Ref', { source: 'np-api', origin: 'checkout', ref: REF_K5, name: 'x' }, P);
  await row('legacy manual without a Ref', { source: 'manual', ref: null }, P);
  await row('legacy manual with P\'s Ref (origin NULL)', { source: 'manual', ref: REF_K10, origin: null }, P);
  await row('legacy manual with P\'s Ref and origin cabinet', { source: 'manual', ref: REF_K10, origin: 'cabinet' }, P);
  await row('legacy manual with another Ref', { source: 'manual', ref: REF_K5 }, P);
  // same Ref: no write, no audit; the stored (older) display name is kept
  const same = await deliverySetup(t); same.seedProfile({ source: 'np-api', origin: 'checkout', ref: REF_K10, name: 'Стара назва', note: null });
  const before = same.profile(); assert.equal((await same.place({ warehouseRef: REF_K10 })).status, 201);
  assert.deepEqual(same.profile(), before); assert.deepEqual(same.audits(), []);
  // cabinet favourite: untouched, even with a different point; the cart still stores P
  const cabinet = await deliverySetup(t); cabinet.seedProfile({ source: 'np-api', origin: 'cabinet', ref: REF_LVIV, name: 'Львів', cityName: 'Львів', note: 'моя нотатка' });
  const cb = cabinet.profile(); assert.equal((await cabinet.place({ warehouseRef: REF_K10 })).data.cart.delivery.warehouseRef, REF_K10);
  assert.deepEqual(cabinet.profile(), cb); assert.deepEqual(cabinet.audits(), []);
  assert.equal((await cabinet.place({ warehouseRef: REF_LVIV })).status, 201); assert.deepEqual(cabinet.profile(), cb);
  // checkout without a point changes nothing
  const none = await deliverySetup(t); none.seedProfile({ source: 'np-api', origin: 'checkout', ref: REF_K5, name: 'x' });
  const nb = none.profile(); assert.equal((await none.place(undefined)).status, 201); assert.equal((await none.place(null)).status, 201); assert.deepEqual(none.profile(), nb);
  // last, not first: successive different points keep replacing an auto-remembered favourite
  const last = await deliverySetup(t);
  await last.place({ warehouseRef: REF_K10 }); await last.place({ warehouseRef: REF_LVIV });
  assert.equal(last.profile().np_warehouse_ref, REF_LVIV); assert.equal(last.audits().length, 2);
  await last.place({ warehouseRef: REF_LVIV }); assert.equal(last.audits().length, 2, 'same Ref again: no new audit');
});

test('checkout is one batch (cart, lines, upsert, audit); a failure leaves no cart, line, preference or audit', async t => {
  const a = await deliverySetup(t);
  const batches = [], original = a.db.batch;
  a.db.batch = async statements => { batches.push(statements.map(s => s.sql.trim().split(/\s+/).slice(0, 3).join(' '))); return original.call(a.db, statements); };
  assert.equal((await a.place({ warehouseRef: REF_K10 })).status, 201);
  assert.equal(batches.length, 1);
  assert.equal(batches[0].length, 4, 'cart, one line, upsert, audit');
  assert.ok(batches[0][0].startsWith('INSERT INTO carts(') && batches[0][1].startsWith('INSERT INTO cart_lines('));
  assert.ok(batches[0][2].startsWith('INSERT INTO customer_profiles') && batches[0][3].startsWith('INSERT INTO customer_audit_events'), 'the audit directly follows the upsert');
  const b = await deliverySetup(t);
  const ok = b.db.batch;
  b.db.batch = async statements => ok.call(b.db, [...statements, { sql: 'INSERT INTO missing_table VALUES (1)', bindings: [] }]);
  const origError = console.error; console.error = () => {};
  try { assert.equal((await b.place({ warehouseRef: REF_K10 })).status, 500); } finally { console.error = origError; }
  assert.equal(cartRows(b.db).length, 0); assert.equal(b.db.sqlite.prepare('SELECT COUNT(*) n FROM cart_lines').get().n, 0); assert.equal(b.profile(), null); assert.deepEqual(b.audits(), []);
});

const STAFF_POSTOMAT = { type: 'postomat', cityName: 'Київ', warehouseNumber: '1001', warehouseName: 'Поштомат "Нова Пошта" №1001: вул. Сімʼї Кульженків, 31а' };
test('staff (owner and manager) see the order\'s delivery point allowlist, never Refs or account data; account deletion clears dp_* and keeps the unbound snapshot', async t => {
  const a = await deliverySetup(t);
  const placed = (await a.place({ warehouseRef: REF_POSTOMAT })).data.cart;
  for (const mount of ['admin', 'staff']) for (const role of ['owner', 'manager']) {
    const admin = a.admin(role, mount), list = await admin('/carts'), one = await admin(`/carts/${placed.code}`);
    assert.equal(list.status, 200); assert.equal(one.status, 200);
    assert.deepEqual(list.data.carts[0].delivery, STAFF_POSTOMAT, `${role} ${mount} list`);
    assert.deepEqual(one.data.cart.delivery, STAFF_POSTOMAT, `${role} ${mount} detail`);
    for (const text of [JSON.stringify(list.data), JSON.stringify(one.data)]) {
      assert.ok(!text.includes(REF_POSTOMAT) && !text.includes(KYIV), 'no Nova Poshta Refs');
      assert.ok(!/dp_|cityRef|warehouseRef|cust1|customer_?[iI]d|PII-person|example\.com"|email|np_|deliveryPreference/.test(text), `${role} ${mount}`);
    }
  }
  const deleted = await a.call('/api/account', { method: 'DELETE', body: { confirm: true }, headers: { Cookie: a.cookie } });
  assert.equal(deleted.status, 200);
  const cartRow = { ...a.db.sqlite.prepare('SELECT * FROM carts').get() };
  assert.equal(cartRow.customer_id, null); assert.equal(cartRow.code, placed.code);
  for (const column of ['dp_type', 'dp_city_name', 'dp_city_ref', 'dp_warehouse_number', 'dp_warehouse_ref', 'dp_warehouse_name']) assert.equal(cartRow[column], null, column);
  assert.equal(a.db.sqlite.prepare('SELECT COUNT(*) n FROM cart_lines').get().n, 1);
  // another customer's carts keep their point
  const b = await deliverySetup(t), cookie2 = customer(b.db, 'cust2', 'C'.repeat(43));
  await b.place({ warehouseRef: REF_K10 });
  await b.call('/api/cart/checkout', { method: 'POST', body: { lines: [line('p2', 'L')], delivery: { warehouseRef: REF_LVIV } }, headers: { Cookie: cookie2 }, ip: '198.51.100.200' });
  await b.call('/api/account', { method: 'DELETE', body: { confirm: true }, headers: { Cookie: cookie2 } });
  assert.deepEqual(new Set(b.db.sqlite.prepare('SELECT dp_warehouse_ref r FROM carts').all().map(r => r.r)), new Set([null, REF_K10]), 'only the deleted customer\'s snapshot was cleared');
});

// ---- checkout recipient («Отримувач»: Прізвище, Імʼя, По батькові, phone) and the prepayment setting ----
const RECIPIENT = { lastName: '  Коваль ', firstName: 'Олена', middleName: ' Петрівна', phone: '050 123-45-67' };
const STORED = { lastName: 'Коваль', firstName: 'Олена', middleName: 'Петрівна', name: 'Коваль Олена Петрівна', phone: '+380501234567' };
const RCPT = 'rcpt_name, rcpt_last_name, rcpt_first_name, rcpt_middle_name, rcpt_phone';
test('recipient: validated always; stored, returned and exported only for signed-in checkouts; staff see exactly the order recipient', async t => {
  const { db, call, checkout, admin } = await setup(t);
  const cookie = customer(db);
  const signed = await checkout([line('p1', 'S')], { headers: { Cookie: cookie }, body: { lines: [line('p1', 'S')], recipient: RECIPIENT } });
  assert.equal(signed.status, 201);
  assert.deepEqual(signed.data.cart.recipient, STORED);
  const row = db.sqlite.prepare(`SELECT ${RCPT} FROM carts WHERE code=?`).get(signed.data.cart.code);
  assert.deepEqual({ ...row }, { rcpt_name: null, rcpt_last_name: 'Коваль', rcpt_first_name: 'Олена', rcpt_middle_name: 'Петрівна', rcpt_phone: '+380501234567' }, 'new checkouts store the parts, not the legacy single name');

  const anon = await call('/api/cart/checkout', { method: 'POST', body: { lines: [line('p2', 'L')], recipient: RECIPIENT } });
  assert.equal(anon.status, 201); assert.equal(anon.data.cart.recipient, null);
  const anonRow = db.sqlite.prepare(`SELECT ${RCPT} FROM carts WHERE code=?`).get(anon.data.cart.code);
  assert.deepEqual({ ...anonRow }, { rcpt_name: null, rcpt_last_name: null, rcpt_first_name: null, rcpt_middle_name: null, rcpt_phone: null }, 'anonymous recipients are never stored');
  assert.equal((await checkout([line('p2', 'L')], { headers: { Cookie: cookie } })).data.cart.recipient, null, 'recipient stays optional');

  const mine = await call('/api/account/carts', { headers: { Cookie: cookie } });
  assert.deepEqual(mine.data.carts.find(c => c.code === signed.data.cart.code).recipient, STORED);
  const exported = await call('/api/account/export', { headers: { Cookie: cookie } });
  assert.deepEqual(exported.data.carts.find(c => c.code === signed.data.cart.code).recipient, STORED);

  // (ADR-0007 Q1 = yes): owner and manager see the order's own recipient; never the account, its email or profile.
  db.sqlite.prepare("INSERT INTO customer_profiles(customer_id,display_name,phone_e164,contact_email,last_name,first_name,middle_name,updated_at) VALUES('cust1','PROFILE-NAME','+380679999999','profile-mail@example.test','ПрофільПрізвище','ПрофільІмʼя','ПрофільПобатькові','2026-11-01T00:00:00.000Z')").run();
  for (const mount of ['admin', 'staff']) for (const role of ['owner', 'manager']) {
    const mgr = admin(role, mount), list = await mgr('/carts'), one = await mgr(`/carts/${signed.data.cart.code}`), other = await mgr(`/carts/${anon.data.cart.code}`);
    assert.equal(list.status, 200); assert.equal(one.status, 200);
    assert.deepEqual(one.data.cart.recipient, STORED, `${role} ${mount} detail`);
    assert.deepEqual(list.data.carts.find(c => c.code === signed.data.cart.code).recipient, STORED, `${role} ${mount} list`);
    assert.equal(other.data.cart.recipient, null, 'anonymous carts have no recipient');
    assert.equal(list.data.carts.find(c => c.code === anon.data.cart.code).recipient, null);
    for (const text of [JSON.stringify(list.data), JSON.stringify(one.data), JSON.stringify(other.data)]) assert.ok(!/rcpt_|cust1|customer_?[iI]d|PII-person|PROFILE-NAME|Профіль|profile-mail|380679999999|email/.test(text), `${role} ${mount}`);
  }
});

test('recipient: carts created by the single-field checkout (only rcpt_name) are returned with null parts and the legacy name', async t => {
  const { db, call, checkout } = await setup(t);
  const cookie = customer(db);
  const placed = (await checkout([line('p1', 'S')], { headers: { Cookie: cookie } })).data.cart;
  db.sqlite.prepare("UPDATE carts SET rcpt_name='Коваль Олена Петрівна', rcpt_phone='+380501234567' WHERE code=?").run(placed.code);
  const legacy = { lastName: null, firstName: null, middleName: null, name: 'Коваль Олена Петрівна', phone: '+380501234567' };
  assert.deepEqual((await call('/api/account/carts', { headers: { Cookie: cookie } })).data.carts[0].recipient, legacy);
  assert.deepEqual((await call('/api/account/export', { headers: { Cookie: cookie } })).data.carts[0].recipient, legacy);
  db.sqlite.prepare("UPDATE carts SET rcpt_name=NULL, rcpt_last_name='Коваль', rcpt_first_name=NULL WHERE code=?").run(placed.code);
  assert.equal((await call('/api/account/carts', { headers: { Cookie: cookie } })).data.carts[0].recipient, null, 'an incomplete row is not shown as a recipient');
});

test('recipient input: shape and values are checked before anything is written; errors name fields, never values', async t => {
  const { db, call } = await setup(t);
  const cookie = customer(db);
  let n = 0; // the checkout throttle runs first, so every request gets its own client IP
  const post = recipient => call('/api/cart/checkout', { method: 'POST', body: { lines: [line('p2', 'L')], recipient }, headers: { Cookie: cookie }, ip: `198.51.100.${++n}` });
  const ok = { lastName: 'Коваль', firstName: 'Олена', middleName: 'Петрівна', phone: '0501234567' };
  const cases = [
    [[], ['recipient']], ['Коваль', ['recipient']], [{ name: 'Коваль Олена Петрівна', phone: '0501234567' }, ['recipient']],
    [{ ...ok, name: 'Коваль Олена' }, ['recipient']], [{ ...ok, email: 'x@y.z' }, ['recipient']],
    [{ phone: '0501234567' }, ['lastName', 'firstName', 'middleName']], [{ ...ok, middleName: undefined }, ['middleName']],
    [{ ...ok, lastName: 'Коваль 123' }, ['lastName']], [{ ...ok, firstName: 'Оле‮на' }, ['firstName']], [{ ...ok, middleName: 'П'.repeat(41) }, ['middleName']],
    [{ ...ok, firstName: '-Олена' }, ['firstName']], [{ ...ok, lastName: 5 }, ['lastName']],
    [{ ...ok, phone: '+38050123456' }, ['phone']], [{ ...ok, phone: '+1 555 123 4567' }, ['phone']], [{ ...ok, phone: 380501234567 }, ['phone']],
    [{ lastName: '', firstName: ' ', middleName: '', phone: '' }, ['lastName', 'firstName', 'middleName', 'phone']],
  ];
  for (const [recipient, fields] of cases) {
    const r = await post(recipient);
    assert.equal(r.status, 400, JSON.stringify(recipient)); assert.deepEqual(r.data, { error: 'invalid_recipient', fields }, JSON.stringify(recipient));
    assert.ok(!/Коваль|Олена|Петрівна|050|ПППП/.test(JSON.stringify(r.data)), 'values are never echoed');
  }
  assert.equal(cartRows(db).length, 0);
  assert.equal((await post(null)).status, 201, 'null means no recipient');
  for (const phone of ['+380501234567', '380 50 123 45 67', '(050) 123-45-67']) assert.equal((await post({ ...ok, phone })).data.cart.recipient.phone, '+380501234567', phone);
  const apostrophes = await post({ lastName: 'Ковальчук-Ліщук', firstName: 'Марʼяна', middleName: "Д'Арк", phone: '0501234567' });
  assert.equal(apostrophes.data.cart.recipient.name, "Ковальчук-Ліщук Марʼяна Д'Арк");
});

test('account deletion clears the recipient snapshot with the delivery point', async t => {
  const { db, call, checkout } = await setup(t);
  const cookie = customer(db), other = customer(db, 'cust2', 'C'.repeat(43));
  const mine = (await checkout([line('p1', 'S')], { headers: { Cookie: cookie }, body: { lines: [line('p1', 'S')], recipient: RECIPIENT } })).data.cart;
  const legacy = (await checkout([line('p2', 'L')], { headers: { Cookie: cookie }, ip: '198.51.100.77' })).data.cart;
  db.sqlite.prepare("UPDATE carts SET rcpt_name='Стара Назва', rcpt_phone='+380501234567' WHERE code=?").run(legacy.code);
  const theirs = (await checkout([line('p2', 'L')], { headers: { Cookie: other }, body: { lines: [line('p2', 'L')], recipient: { lastName: 'Інша', firstName: 'Людина', middleName: 'Іванівна', phone: '0671234567' } } })).data.cart;
  assert.equal((await call('/api/account', { method: 'DELETE', body: { confirm: true }, headers: { Cookie: cookie } })).status, 200);
  for (const code of [mine.code, legacy.code]) {
    const row = db.sqlite.prepare(`SELECT customer_id, ${RCPT} FROM carts WHERE code=?`).get(code);
    assert.deepEqual({ ...row }, { customer_id: null, rcpt_name: null, rcpt_last_name: null, rcpt_first_name: null, rcpt_middle_name: null, rcpt_phone: null }, code);
  }
  assert.deepEqual({ ...db.sqlite.prepare('SELECT rcpt_last_name, rcpt_phone FROM carts WHERE code=?').get(theirs.code) }, { rcpt_last_name: 'Інша', rcpt_phone: '+380671234567' });
});

test('prepayment setting: public read, owner-only audited write, strict validation', async t => {
  const { db, call, admin } = await setup(t);
  assert.deepEqual((await call('/api/storefront')).data.checkout, { prepaymentMinor: 0 }, 'migration seeds 0 (line hidden)');
  const owner = admin('owner'), mgr = admin('manager');
  assert.equal((await mgr('/storefront/checkout', { method: 'PUT', body: { prepaymentMinor: 20000 } })).status, 403);
  const saved = await owner('/storefront/checkout', { method: 'PUT', body: { prepaymentMinor: 20000 } });
  assert.equal(saved.status, 200); assert.deepEqual(saved.data.checkout, { prepaymentMinor: 20000 }); assert.ok(saved.data.checkoutUpdatedAt);
  assert.deepEqual((await call('/api/storefront')).data.checkout, { prepaymentMinor: 20000 });
  const adminView = await owner('/storefront');
  assert.deepEqual(adminView.data.checkout, { prepaymentMinor: 20000 }); assert.equal(adminView.data.checkoutUpdatedAt, saved.data.checkoutUpdatedAt);
  const audit = db.sqlite.prepare("SELECT * FROM audit_events WHERE action='storefront.checkout'").all();
  assert.equal(audit.length, 1); assert.equal(audit[0].resource_id, 'checkout');
  for (const body of [{}, { prepaymentMinor: -1 }, { prepaymentMinor: 1.5 }, { prepaymentMinor: '200' }, { prepaymentMinor: 10000001 }, { prepaymentMinor: 100, extra: 1 }, []]) {
    assert.equal((await owner('/storefront/checkout', { method: 'PUT', body })).status, 400, JSON.stringify(body));
  }
  assert.equal((await owner('/storefront/checkout', { method: 'PUT', body: { prepaymentMinor: 0 } })).status, 200, '0 turns the line off');
  db.sqlite.prepare("UPDATE storefront_settings SET value_json='{\"prepaymentMinor\":\"lots\"}' WHERE key='checkout'").run();
  assert.deepEqual((await call('/api/storefront')).data.checkout, { prepaymentMinor: 0 }, 'bad stored data falls back to hidden');
});

// ---- retention erasure of the order's personal data, and migration 0027 ----------------------------
const DAY = 86400000, RNOW = new Date('2026-12-31T12:00:00.000Z');
const ago = ms => new Date(RNOW.getTime() - ms).toISOString();
let rtCounter = 0;
function putCart(db, { status = 'submitted', customerId = null, created, changed = created, pd = 'parts', note = null }) {
  const n = ++rtCounter, id = 'rt' + n, code = `SS-RT${String(n).padStart(2, '0')}-0000`;
  const parts = pd === 'parts' || pd === 'all', point = pd === 'point' || pd === 'all' || pd === 'parts';
  db.sqlite.prepare(`INSERT INTO carts(id,code,status,customer_id,item_count,total_minor,currency,created_at,updated_at,status_changed_at,status_actor,manager_note,
    dp_type,dp_city_name,dp_city_ref,dp_warehouse_number,dp_warehouse_ref,dp_warehouse_name,rcpt_name,rcpt_phone,rcpt_last_name,rcpt_first_name,rcpt_middle_name)
    VALUES(?,?,?,?,1,100,'UAH',?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(id, code, status, customerId, created, changed, changed, status === 'submitted' ? null : 'm@example.test', note,
    point ? 'branch' : null, point ? 'Київ' : null, point ? 'city-ref' : null, point ? '10' : null, point ? 'wh-ref' : null, point ? 'Відділення №10' : null,
    pd === 'legacy' ? 'Стара Назва' : null, parts || pd === 'legacy' ? '+380501234567' : null, parts ? 'Коваль' : null, parts ? 'Олена' : null, parts ? 'Петрівна' : null);
  db.sqlite.prepare("INSERT INTO cart_lines(cart_id,position,product_id,slug,title,size,quantity,unit_price_minor,line_total_minor,photo,supplier_id,supplier_name,external_product_id,variant_ids_json,unit_cost_minor) VALUES(?,0,'p1','coat-p1','Coat','M',1,100,100,NULL,'sup1','S','E','[]',50)").run(id);
  return id;
}
const PD = ['rcpt_name', 'rcpt_phone', 'rcpt_last_name', 'rcpt_first_name', 'rcpt_middle_name', 'dp_type', 'dp_city_name', 'dp_city_ref', 'dp_warehouse_number', 'dp_warehouse_ref', 'dp_warehouse_name'];
const rowOf = (db, id) => ({ ...db.sqlite.prepare('SELECT * FROM carts WHERE id=?').get(id) });
const retentionAudits = db => db.sqlite.prepare("SELECT * FROM audit_events WHERE action='cart.pd-retention' ORDER BY rowid").all().map(r => ({ ...r }));

test('retention: erased exactly 14 days after completed/cancelled and 90 days after creation; only rcpt_*/dp_* and pd_erased_at change; idempotent; one counts-only audit row', async t => {
  const { purgeExpiredOrderPersonalData } = await import('../../apps/api/src/order-retention.js');
  const { db } = await setup(t);
  customer(db);
  const c14 = 14 * DAY, c90 = 90 * DAY;
  const due = {
    completed14: putCart(db, { status: 'completed', customerId: 'cust1', created: ago(40 * DAY), changed: ago(c14), note: 'внутрішня нотатка' }),
    cancelled14: putCart(db, { status: 'cancelled', customerId: 'cust1', created: ago(20 * DAY), changed: ago(c14) }),
    legacyCancelled: putCart(db, { status: 'cancelled', customerId: 'cust1', created: ago(30 * DAY), changed: ago(20 * DAY), pd: 'legacy' }),
    pointOnly: putCart(db, { status: 'completed', customerId: 'cust1', created: ago(30 * DAY), changed: ago(15 * DAY), pd: 'point' }),
    submitted90: putCart(db, { status: 'submitted', customerId: 'cust1', created: ago(c90) }),
    unbound90: putCart(db, { status: 'sent_to_suppliers', customerId: null, created: ago(c90 + DAY), changed: ago(60 * DAY) }),
  };
  const kept = {
    completedYoung: putCart(db, { status: 'completed', customerId: 'cust1', created: ago(40 * DAY), changed: ago(c14 - 1) }),
    cancelledYoung: putCart(db, { status: 'cancelled', customerId: 'cust1', created: ago(10 * DAY), changed: ago(c14 - 1) }),
    sentOld: putCart(db, { status: 'sent_to_suppliers', customerId: 'cust1', created: ago(c90 - 1), changed: ago(80 * DAY) }),
    verified89: putCart(db, { status: 'verified', customerId: 'cust1', created: ago(c90 - 1), changed: ago(c90 - 1) }),
    anonymousOld: putCart(db, { status: 'completed', created: ago(400 * DAY), changed: ago(300 * DAY), pd: 'none' }),
    anonymousOpen: putCart(db, { status: 'submitted', created: ago(400 * DAY), pd: 'none' }),
    // Closed recently but created long ago: the 90-day backstop is for never-closed carts, so it keeps its full 14 days.
    lateCompleted: putCart(db, { status: 'completed', customerId: 'cust1', created: ago(c90 + DAY), changed: ago(DAY) }),
    lateCancelled: putCart(db, { status: 'cancelled', customerId: 'cust1', created: ago(200 * DAY), changed: ago(c14 - 1) }),
  };
  const before = Object.fromEntries([...Object.values(due), ...Object.values(kept)].map(id => [id, rowOf(db, id)]));
  const lines = JSON.stringify(db.sqlite.prepare('SELECT * FROM cart_lines ORDER BY cart_id').all()), otherAudit = db.sqlite.prepare('SELECT COUNT(*) n FROM audit_events').get().n;

  assert.deepEqual(await purgeExpiredOrderPersonalData({ DB: db }, RNOW), { erased: 6, closed: 4, expired: 2, more: false });
  for (const [label, id] of Object.entries(due)) {
    const row = rowOf(db, id), was = before[id];
    for (const c of PD) assert.equal(row[c], null, `${label} ${c}`);
    assert.equal(row.pd_erased_at, RNOW.toISOString(), label);
    for (const c of Object.keys(was).filter(c => !PD.includes(c) && c !== 'pd_erased_at')) assert.equal(row[c], was[c], `${label}: ${c} untouched`);
  }
  assert.equal(rowOf(db, due.completed14).manager_note, 'внутрішня нотатка', 'manager_note is kept');
  assert.equal(rowOf(db, due.completed14).customer_id, 'cust1', 'binding is kept');
  for (const [label, id] of Object.entries(kept)) assert.deepEqual(rowOf(db, id), before[id], label);
  assert.equal(JSON.stringify(db.sqlite.prepare('SELECT * FROM cart_lines ORDER BY cart_id').all()), lines, 'lines are untouched');
  const audit = retentionAudits(db);
  assert.equal(audit.length, 1); assert.equal(db.sqlite.prepare('SELECT COUNT(*) n FROM audit_events').get().n, otherAudit + 1);
  assert.deepEqual({ actor: audit[0].actor, type: audit[0].actor_type, role: audit[0].actor_role, resource: audit[0].resource_id, at: audit[0].created_at, details: JSON.parse(audit[0].details_json) },
    { actor: 'system', type: 'system', role: null, resource: 'carts', at: RNOW.toISOString(), details: { erased: 6, closed: 4, expired: 2, closedDays: 14, maxDays: 90 } });
  assert.ok(!/SS-|Коваль|Олена|380|Київ|Стара|wh-ref|cust1/.test(audit[0].details_json), 'counts only, never values or codes');

  // Idempotent: a second run (even much later) finds nothing, changes nothing and writes no audit row.
  const snapshot = JSON.stringify(db.sqlite.prepare('SELECT * FROM carts ORDER BY id').all());
  assert.deepEqual(await purgeExpiredOrderPersonalData({ DB: db }, RNOW), { erased: 0, closed: 0, expired: 0, more: false });
  assert.equal(JSON.stringify(db.sqlite.prepare('SELECT * FROM carts ORDER BY id').all()), snapshot);
  assert.equal(retentionAudits(db).length, 1);
  // One millisecond later the young closed carts become due; the 89-day open carts still need their 90th day.
  assert.deepEqual(await purgeExpiredOrderPersonalData({ DB: db }, new Date(RNOW.getTime() + 1)), { erased: 5, closed: 3, expired: 2, more: false });
  assert.equal(rowOf(db, kept.lateCompleted).pd_erased_at, null, 'completed a day ago: not yet, despite created_at > 90 days');
  assert.deepEqual(await purgeExpiredOrderPersonalData({ DB: db }, new Date(RNOW.getTime() + c14 - DAY)), { erased: 1, closed: 1, expired: 0, more: false }, 'exactly 14 days after completion');
  assert.ok(rowOf(db, kept.lateCompleted).pd_erased_at);
  assert.equal(rowOf(db, kept.anonymousOld).pd_erased_at, null, 'carts without personal data are never marked');
  assert.equal(rowOf(db, kept.anonymousOpen).pd_erased_at, null);
  await assert.rejects(() => purgeExpiredOrderPersonalData({ DB: db }, RNOW, { limit: 0 }), TypeError);
  await assert.rejects(() => purgeExpiredOrderPersonalData({ DB: db }, new Date('nope')), TypeError);
});

test('retention: bounded batch per run, oldest first, `more` until the backlog is gone; the partial index serves the query', async t => {
  const { purgeExpiredOrderPersonalData, PD_PENDING } = await import('../../apps/api/src/order-retention.js');
  const { db } = await setup(t);
  const ids = [5, 4, 3, 2, 1].map(d => putCart(db, { status: 'cancelled', created: ago((100 + d) * DAY), changed: ago((95 + d) * DAY) }));
  const young = putCart(db, { status: 'submitted', created: ago(DAY) });
  assert.deepEqual(await purgeExpiredOrderPersonalData({ DB: db }, RNOW, { limit: 2 }), { erased: 2, closed: 2, expired: 0, more: true });
  assert.deepEqual(ids.map(id => rowOf(db, id).pd_erased_at !== null), [true, true, false, false, false], 'oldest carts first');
  assert.deepEqual(await purgeExpiredOrderPersonalData({ DB: db }, RNOW, { limit: 2 }), { erased: 2, closed: 2, expired: 0, more: true });
  assert.deepEqual(await purgeExpiredOrderPersonalData({ DB: db }, RNOW, { limit: 2 }), { erased: 1, closed: 1, expired: 0, more: false });
  assert.equal(rowOf(db, young).pd_erased_at, null);
  assert.deepEqual(retentionAudits(db).map(a => JSON.parse(a.details_json).erased), [2, 2, 1], 'one audit row per run that erased something');
  const migration = readFileSync(new URL('0027_order_completed_retention.sql', migrationDir), 'utf8');
  assert.ok(migration.includes(`WHERE ${PD_PENDING};`), 'index WHERE and PD_PENDING are the same text');
  const plan = db.sqlite.prepare(`EXPLAIN QUERY PLAN SELECT id FROM carts WHERE ${PD_PENDING} AND ((status IN ('completed','cancelled') AND status_changed_at <= ?) OR (status NOT IN ('completed','cancelled') AND created_at <= ?)) ORDER BY created_at, id LIMIT ?`).all('x', 'y', 5).map(r => r.detail).join(' | ');
  assert.match(plan, /carts_pd_pending/, plan);
});

test('retention: staff and the customer see the erased state; the scheduled handler runs the purge before supplier sync', async t => {
  const a = await deliverySetup(t);
  const placed = (await a.place(undefined, { body: { lines: [line('p2', 'L')], delivery: { warehouseRef: REF_POSTOMAT }, recipient: RECIPIENT } })).data.cart;
  assert.deepEqual(placed.recipient, STORED); assert.equal(placed.delivery.warehouseRef, REF_POSTOMAT);
  const owner = a.admin('owner'), mgr = a.admin('manager', 'staff');
  for (const [status, expectedStatus] of [['verified', 'submitted'], ['sent_to_suppliers', 'verified'], ['completed', 'sent_to_suppliers']]) assert.equal((await mgr(`/carts/${placed.code}/status`, { method: 'POST', body: { status, expectedStatus } })).status, 200, status);
  assert.deepEqual((await owner(`/carts/${placed.code}`)).data.cart.recipient, STORED, 'still visible while within the 14 days');
  const completedAt = a.db.sqlite.prepare('SELECT status_changed_at s FROM carts WHERE code=?').get(placed.code).s;
  // Run the real scheduled handler with a clock 14 days later: no suppliers to sync, so only the purge acts.
  const realNow = Date.now, later = Date.parse(completedAt) + 14 * DAY;
  Date.now = () => later; const RealDate = Date;
  globalThis.Date = class extends RealDate { constructor(...args) { if (args.length) super(...args); else super(later); } static now() { return later; } };
  try { const tasks = []; await worker.scheduled({}, { DB: a.db, MEDIA: a.bucket }, { waitUntil: p => tasks.push(p) }); await Promise.all(tasks); }
  finally { globalThis.Date = RealDate; Date.now = realNow; }
  const erased = new Date(later).toISOString();
  for (const view of [(await owner(`/carts/${placed.code}`)).data.cart, (await mgr(`/carts/${placed.code}`)).data.cart, (await owner('/carts')).data.carts[0]]) {
    assert.equal(view.recipient, null); assert.equal(view.delivery, null); assert.equal(view.personalDataErasedAt, erased); assert.equal(view.status, 'completed'); assert.equal(view.bound, true);
  }
  const mine = (await a.call('/api/account/carts', { headers: { Cookie: a.cookie } })).data.carts[0];
  assert.deepEqual([mine.recipient, mine.delivery, mine.personalDataErasedAt, mine.status], [null, null, erased, 'completed']);
  assert.equal((await a.call('/api/account/export', { headers: { Cookie: a.cookie } })).data.carts[0].personalDataErasedAt, erased);
  assert.equal(retentionAudits(a.db).length, 1);
  assert.notEqual(a.profile(), null, 'the profile (and its remembered point) is account data and is kept');
});

test('migration 0027 rebuilds carts on a populated database: every row, line, index and foreign key survives; completed is accepted', () => {
  const sqlite = new DatabaseSync(':memory:');
  const TARGET = '0027_order_completed_retention.sql', files = readdirSync(migrationDir).filter(n => /^\d{4}_.*\.sql$/.test(n)).sort();
  assert.ok(files.includes(TARGET), 'renumber this test together with the migration');
  for (const name of files.filter(n => n < TARGET)) sqlite.exec(readFileSync(new URL(name, migrationDir), 'utf8'));
  assert.equal(sqlite.prepare('PRAGMA foreign_keys').get().foreign_keys, 1, 'like D1: foreign keys are enforced, so a careless DROP would cascade');
  const now = '2026-11-20T10:00:00.000Z';
  for (const id of ['c1', 'c2']) sqlite.prepare("INSERT INTO customers(id,status,created_at,updated_at) VALUES(?,'active',?,?)").run(id, now, now);
  const cart = sqlite.prepare(`INSERT INTO carts(id,code,status,customer_id,item_count,total_minor,currency,created_at,updated_at,status_changed_at,status_actor,manager_note,dp_type,dp_city_name,dp_city_ref,dp_warehouse_number,dp_warehouse_ref,dp_warehouse_name,rcpt_name,rcpt_phone,rcpt_last_name,rcpt_first_name,rcpt_middle_name) VALUES(?,?,?,?,?,?,'UAH',?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`);
  cart.run('k1', 'SS-0000-0001', 'submitted', 'c1', 3, 450000, now, now, now, null, null, 'postomat', 'Київ', 'cref', '1001', 'wref', 'Поштомат №1001', null, '+380501234567', 'Коваль', 'Олена', 'Петрівна');
  cart.run('k2', 'SS-0000-0002', 'verified', 'c2', 1, 100, now, now, now, 'm@example.test', 'нотатка', null, null, null, null, null, null, 'Стара Назва', '+380671234567', null, null, null);
  cart.run('k3', 'SS-0000-0003', 'sent_to_suppliers', null, 2, 0, now, now, now, 'o@example.test', null, null, null, null, null, null, null, null, null, null, null, null);
  cart.run('k4', 'SS-0000-0004', 'cancelled', null, 1, 5, now, now, now, 'o@example.test', 'x', 'branch', 'Львів', 'l', '5', 'w5', 'Відділення №5', null, null, null, null, null);
  const lineSql = sqlite.prepare('INSERT INTO cart_lines(cart_id,position,product_id,slug,title,size,quantity,unit_price_minor,line_total_minor,photo,supplier_id,supplier_name,external_product_id,variant_ids_json,unit_cost_minor,allocations_json) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)');
  lineSql.run('k1', 0, 'p1', 'coat-p1', 'Coat', 'M', 2, 150000, 300000, 'https://x/1.jpg', 's1', 'Sup', 'E1', '["v1","v2"]', 90000, JSON.stringify([{ productId: 'p1', supplierId: 's1', quantity: 2 }]));
  lineSql.run('k1', 1, 'p2', 'coat-p2', 'Coat 2', 'L', 1, 150000, 150000, null, 's2', 'Sup2', 'E2', '[]', null, null);
  lineSql.run('k2', 0, 'p1', 'coat-p1', 'Coat', 'S', 1, 100, 100, null, 's1', 'Sup', 'E1', '[]', 10, null);
  lineSql.run('k3', 0, 'p3', 'p-3', 'Hat', 'One', 2, 0, 0, null, 's1', 'Sup', 'E3', '[]', 0, null);
  lineSql.run('k4', 0, 'p4', 'p-4', 'Bag', 'One', 1, 5, 5, null, 's1', 'Sup', 'E4', '[]', null, null);
  sqlite.prepare("INSERT INTO audit_events(id,actor,action,resource_id,created_at,actor_type,actor_role,details_json) VALUES('a1','m@example.test','cart.status','SS-0000-0002',?,'staff','manager','{}')").run(now);
  const dump = sql => sqlite.prepare(sql).all().map(r => ({ ...r }));
  const schema = table => ({ columns: dump(`PRAGMA table_info(${table})`), fks: dump(`PRAGMA foreign_key_list(${table})`), indexes: dump(`PRAGMA index_list(${table})`).map(({ seq, name, ...i }) => ({ ...i, name: name.startsWith('sqlite_autoindex') ? 'auto' : name, cols: dump(`PRAGMA index_info("${name}")`).map(c => c.name).join(',') })).sort((x, y) => (x.name + x.cols).localeCompare(y.name + y.cols)) });
  const before = { carts: dump('SELECT * FROM carts ORDER BY id'), lines: dump('SELECT * FROM cart_lines ORDER BY cart_id, position'), audit: dump('SELECT * FROM audit_events'), cartsSchema: schema('carts'), linesSchema: schema('cart_lines'), indexSql: dump("SELECT name, sql FROM sqlite_master WHERE type='index' AND tbl_name IN ('carts','cart_lines','audit_events') AND sql IS NOT NULL ORDER BY name") };

  sqlite.exec(readFileSync(new URL(TARGET, migrationDir), 'utf8'));

  assert.deepEqual(dump('SELECT * FROM carts ORDER BY id'), before.carts.map(r => ({ ...r, pd_erased_at: null })), 'every cart row and value survives');
  assert.deepEqual(dump('SELECT * FROM cart_lines ORDER BY cart_id, position'), before.lines, 'no line was cascade-deleted');
  assert.deepEqual(dump('SELECT * FROM audit_events'), before.audit);
  const cartsSchema = schema('carts');
  assert.deepEqual(cartsSchema.columns.slice(0, -1), before.cartsSchema.columns, 'same columns in the same order');
  assert.deepEqual(cartsSchema.columns.at(-1), { cid: before.cartsSchema.columns.length, name: 'pd_erased_at', type: 'TEXT', notnull: 0, dflt_value: null, pk: 0 });
  assert.deepEqual(cartsSchema.fks, before.cartsSchema.fks); assert.deepEqual(schema('cart_lines'), before.linesSchema, 'cart_lines is recreated identically');
  assert.deepEqual(cartsSchema.indexes.filter(i => i.name !== 'carts_pd_pending'), before.cartsSchema.indexes);
  assert.deepEqual(dump("SELECT name, sql FROM sqlite_master WHERE type='index' AND tbl_name IN ('carts','cart_lines','audit_events') AND sql IS NOT NULL AND name<>'carts_pd_pending' ORDER BY name"), before.indexSql);
  assert.deepEqual(dump("SELECT name FROM sqlite_master WHERE name LIKE '%z21%'"), [], 'temporary tables are gone');
  assert.deepEqual(dump('PRAGMA foreign_key_check'), []); assert.equal(sqlite.prepare('PRAGMA integrity_check').get().integrity_check, 'ok');

  sqlite.prepare("UPDATE carts SET status='completed' WHERE id='k3'").run();
  assert.throws(() => sqlite.prepare("UPDATE carts SET status='bogus' WHERE id='k1'").run(), /CHECK/);
  assert.throws(() => sqlite.prepare("UPDATE carts SET dp_type='locker' WHERE id='k1'").run(), /CHECK/);
  assert.throws(() => sqlite.prepare("UPDATE carts SET item_count=1.5 WHERE id='k1'").run(), /CHECK/);
  assert.throws(() => sqlite.prepare("UPDATE carts SET code='SS-0000-0001' WHERE id='k2'").run(), /UNIQUE/);
  assert.throws(() => lineSql.run('nope', 0, 'p1', 's', 't', 'M', 1, 1, 1, null, 's', 'S', 'E', '[]', null, null), /FOREIGN KEY/);
  assert.throws(() => lineSql.run('k1', 2, 'p1', 's', 't', 'M', 1, 1, 1, null, 's', 'S', 'E', '[]', null, null), /UNIQUE/);
  sqlite.prepare("DELETE FROM customers WHERE id='c1'").run();
  assert.equal(sqlite.prepare("SELECT customer_id FROM carts WHERE id='k1'").get().customer_id, null, 'ON DELETE SET NULL kept');
  sqlite.prepare("DELETE FROM carts WHERE id='k1'").run();
  assert.equal(sqlite.prepare("SELECT COUNT(*) n FROM cart_lines WHERE cart_id='k1'").get().n, 0, 'ON DELETE CASCADE kept');
  assert.equal(sqlite.prepare('SELECT COUNT(*) n FROM cart_lines').get().n, 3);
  sqlite.close();
});
