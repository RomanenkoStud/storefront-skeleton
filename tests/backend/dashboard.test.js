// dashboard metrics, cookieless visit beacon, infrastructure usage and renewals. Synthetic in-memory data only.
import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { readFileSync, readdirSync } from 'node:fs';
import worker from '../../apps/api/src/index.js';
import { kyivDay, kyivMidnight, dayRange, addDays, lineParts, cleanPath, referrerHost, deviceOf, isBot } from '../../apps/api/src/analytics.js';
import { estimate, validateRenewal, r2Class, PRICING, cloudflareUsage } from '../../apps/api/src/infra.js';
import { ROLE_PERMISSIONS } from '../../apps/api/src/permissions.js';
import { startVisitBeacon, VISIT_BEACON_INLINE } from '../../packages/catalog/visit-beacon.js';
import { NEW_SESSIONS_PER_IP_HOUR } from '../../apps/api/src/analytics.js';
import { build } from 'esbuild';

const migrationDir = new URL('../../migrations/', import.meta.url);
function database() {
  const sqlite = new DatabaseSync(':memory:');
  for (const name of readdirSync(migrationDir).filter(n => /^\d{4}_.*\.sql$/.test(n)).sort()) sqlite.exec(readFileSync(new URL(name, migrationDir), 'utf8'));
  const wrap = (sql, bindings = []) => ({ sql, bindings, bind(...v) { return wrap(sql, v); }, async first() { return sqlite.prepare(sql).get(...bindings) ?? null; }, async all() { return { results: sqlite.prepare(sql).all(...bindings) }; }, async run() { return sqlite.prepare(sql).run(...bindings); } });
  return { sqlite, prepare: sql => wrap(sql), async batch(statements) { sqlite.exec('BEGIN'); try { const result = statements.map(s => sqlite.prepare(s.sql).run(...s.bindings)); sqlite.exec('COMMIT'); return result; } catch (error) { sqlite.exec('ROLLBACK'); throw error; } }, close() { sqlite.close(); } };
}
const HOST = 'http://localhost';
const UA = 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) Mobile/15E148 Safari/604.1';
function setup(t, extraEnv = {}) {
  const db = database();
  t.after(() => db.close());
  const base = { DB: db, APP_ENV: 'development', CF_ACCESS_TEAM_NAME: 'team', CF_ACCESS_AUD: 'aud', ...extraEnv };
  const call = async (path, { method = 'GET', body, role = 'owner', origin = HOST, ua = UA, ip = '203.0.113.7', cf, raw, type = 'application/json', env = {} } = {}) => {
    const headers = { 'CF-Connecting-IP': ip, 'User-Agent': ua };
    if (origin) headers.Origin = origin;
    if (body !== undefined || raw !== undefined) headers['Content-Type'] = type;
    const request = new Request(HOST + path, { method, headers, body: raw ?? (body === undefined ? undefined : JSON.stringify(body)) });
    if (cf) Object.defineProperty(request, 'cf', { value: cf });
    const response = await worker.fetch(request, { ...base, ...(role ? { AUTH_DEV_BYPASS: 'true', DEV_STAFF_ROLE: role } : {}), ...env });
    const contentType = response.headers.get('Content-Type') || '';
    return { status: response.status, data: contentType.includes('json') ? await response.json() : await response.text() };
  };
  return { db, call };
}

test('Kyiv days: midnight in winter and summer, calendar arithmetic, ranges', () => {
  assert.equal(kyivMidnight('2026-01-15').toISOString(), '2026-01-14T22:00:00.000Z');
  assert.equal(kyivMidnight('2026-07-15').toISOString(), '2026-07-14T21:00:00.000Z');
  assert.equal(kyivMidnight('2026-03-29').toISOString(), '2026-03-28T22:00:00.000Z', 'DST starts at 03:00 that day');
  assert.equal(kyivDay(new Date('2026-11-19T22:30:00Z')), '2026-11-20');
  assert.equal(kyivDay(new Date('2026-11-19T21:59:59Z')), '2026-11-19');
  assert.equal(addDays('2026-03-01', -1), '2026-02-28');
  assert.deepEqual(dayRange(3, '2026-01-01'), ['2025-12-30', '2025-12-31', '2026-01-01']);
});

test('cart line attribution: single supplier, merged allocations, malformed allocations fall back', () => {
  const base = { supplier_id: 's1', supplier_name: 'One', quantity: 3, line_total_minor: 1000, unit_cost_minor: 200 };
  assert.deepEqual(lineParts(base), [{ supplierId: 's1', supplierName: 'One', quantity: 3, unitCostMinor: 200, revenueMinor: 1000, costMinor: 600 }]);
  const merged = lineParts({ ...base, allocations_json: JSON.stringify([{ supplierId: 's1', supplierName: 'One', quantity: 1, unitCostMinor: 200 }, { supplierId: 's2', supplierName: 'Two', quantity: 2, unitCostMinor: 150 }]) });
  assert.deepEqual(merged.map(p => [p.supplierId, p.quantity, p.revenueMinor, p.costMinor]), [['s1', 1, 333, 200], ['s2', 2, 667, 300]]);
  assert.equal(merged.reduce((sum, p) => sum + p.revenueMinor, 0), 1000, 'parts sum to the line total');
  assert.equal(lineParts({ ...base, allocations_json: JSON.stringify([{ supplierId: 's2', quantity: 1 }]) })[0].supplierId, 's1', 'quantities must add up');
  assert.equal(lineParts({ ...base, allocations_json: '{bad' })[0].supplierId, 's1');
  assert.equal(lineParts({ ...base, unit_cost_minor: null })[0].costMinor, null);
});

test('visit input hygiene: paths, referrers, devices, bots', () => {
  const priv = p => p.startsWith('/admin');
  assert.equal(cleanPath('/products/coat-1?utm=x#top', priv), '/products/coat-1');
  for (const bad of ['//evil.test/x', 'products', '/admin/catalog', '/a<script>', 5, '/' + 'a'.repeat(400)]) assert.equal(cleanPath(bad, priv), null, String(bad));
  assert.equal(referrerHost('https://www.google.com/search?q=secret', 'shop.test'), 'google.com');
  assert.equal(referrerHost('https://shop.test/products/x', 'shop.test'), null);
  assert.equal(referrerHost('javascript:alert(1)', 'shop.test'), null);
  assert.equal(deviceOf(UA), 'mobile');
  assert.equal(deviceOf('Mozilla/5.0 (iPad; CPU OS 17_0 like Mac OS X)'), 'tablet');
  assert.equal(deviceOf('Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/130'), 'desktop');
  assert.ok(isBot('Googlebot/2.1') && isBot('') && isBot('curl/8.0') && isBot(UA, { botManagement: { verifiedBot: true } }) && !isBot(UA, {}));
});

test('visit beacon: one upserted session, no IP or user agent stored, bots/private/cross-origin rejected', async t => {
  const { db, call } = setup(t);
  const cf = { country: 'UA', region: 'Kyiv City' };
  assert.equal((await call('/api/visit', { method: 'POST', role: null, body: { type: 'view', path: '/', ref: 'https://www.instagram.com/p/abc' }, cf })).status, 204);
  assert.equal((await call('/api/visit', { method: 'POST', role: null, raw: JSON.stringify({ type: 'view', path: '/products/coat-1' }), type: 'text/plain;charset=UTF-8', cf })).status, 204, 'sendBeacon string body');
  assert.equal((await call('/api/visit', { method: 'POST', role: null, body: { type: 'leave', path: '/products/coat-1' }, cf })).status, 204);
  let rows = db.sqlite.prepare('SELECT * FROM visit_sessions').all();
  assert.equal(rows.length, 1);
  assert.equal(rows[0].pageviews, 2);
  assert.deepEqual([rows[0].country, rows[0].region, rows[0].device, rows[0].referrer, rows[0].entry_path], ['UA', 'Kyiv City', 'mobile', 'instagram.com', '/']);
  assert.match(rows[0].visitor, /^[0-9a-f]{32}$/);
  const stored = JSON.stringify(db.sqlite.prepare('SELECT * FROM visit_sessions').all()) + JSON.stringify(db.sqlite.prepare('SELECT * FROM analytics_salts').all());
  assert.ok(!stored.includes('203.0.113.7') && !stored.includes('iPhone'), 'no IP or user agent at rest');
  assert.equal(db.sqlite.prepare('SELECT COUNT(*) AS n FROM analytics_salts').get().n, 1);

  await call('/api/visit', { method: 'POST', role: null, body: { type: 'view', path: '/' }, ip: '198.51.100.9' });
  assert.equal(db.sqlite.prepare('SELECT COUNT(*) AS n FROM visit_sessions').get().n, 2, 'another visitor is another session');
  assert.equal(db.sqlite.prepare("SELECT country FROM visit_sessions WHERE entry_path='/' AND country IS NULL").all().length, 1, 'no cf data locally');

  assert.equal((await call('/api/visit', { method: 'POST', role: null, body: { type: 'view', path: '/' }, ua: 'Googlebot/2.1', ip: '192.0.2.1' })).status, 204);
  assert.equal((await call('/api/visit', { method: 'POST', role: null, body: { type: 'view', path: '/admin/catalog' }, ip: '192.0.2.2' })).status, 204);
  assert.equal((await call('/api/visit', { method: 'POST', role: null, body: { type: 'leave', path: '/' }, ip: '192.0.2.3' })).status, 204, 'leave without a session creates nothing');
  assert.equal(db.sqlite.prepare('SELECT COUNT(*) AS n FROM visit_sessions').get().n, 2);
  assert.equal((await call('/api/visit', { method: 'POST', role: null, body: { type: 'view', path: '/' }, origin: 'https://evil.test' })).status, 403);
  assert.equal((await call('/api/visit', { method: 'POST', role: null, body: { type: 'view', path: '/' }, origin: null })).status, 403);
  assert.equal((await call('/api/visit', { role: null })).status, 405);
  assert.equal((await call('/api/visit', { method: 'POST', role: null, body: { type: 'click', path: '/' } })).status, 400);
  assert.equal((await call('/api/visit', { method: 'POST', role: null, raw: 'x'.repeat(5000) })).status, 400);
  assert.equal((await call('/api/visit', { method: 'POST', role: null, raw: '{}', type: 'application/x-www-form-urlencoded' })).status, 415);
  rows = db.sqlite.prepare('SELECT COUNT(*) AS n FROM visit_sessions').get();
  assert.equal(rows.n, 2);
});

test('visit salts rotate daily and prune old salts and sessions past retention', async t => {
  const { db, call } = setup(t);
  db.sqlite.prepare("INSERT INTO analytics_salts(day,salt,created_at) VALUES('2020-01-01','old','2020-01-01T00:00:00Z')").run();
  db.sqlite.prepare("INSERT INTO visit_sessions(id,visitor,day,started_at,last_seen_at) VALUES('ancient','v','2020-01-01','2020-01-01T10:00:00Z','2020-01-01T10:00:00Z')").run();
  await call('/api/visit', { method: 'POST', role: null, body: { type: 'view', path: '/' } });
  assert.deepEqual(db.sqlite.prepare('SELECT day FROM analytics_salts').all().map(r => r.day), [kyivDay()]);
  assert.equal(db.sqlite.prepare("SELECT COUNT(*) AS n FROM visit_sessions WHERE id='ancient'").get().n, 0);
});

function seedSales(db) {
  const s = db.sqlite, now = new Date(), today = now.toISOString(), old = new Date(now.getTime() - 40 * 86400000).toISOString();
  s.prepare("INSERT INTO suppliers(id,name,url,enabled,created_at) VALUES('s1','Lorem Supply','https://mydrop.com.ua/s1',1,'2026-01-01T00:00:00Z'),('s2','Easy','https://mydrop.com.ua/s2',1,'2026-01-01T00:00:00Z')").run();
  const cart = (id, status, createdAt, total) => s.prepare("INSERT INTO carts(id,code,status,item_count,total_minor,created_at,updated_at,status_changed_at) VALUES(?,?,?,1,?,?,?,?)").run(id, ('SS' + id).padEnd(12, '0').slice(0, 12), status, total, createdAt, createdAt, createdAt);
  const line = (cartId, position, productId, quantity, total, supplierId, cost, allocations = null) => s.prepare("INSERT INTO cart_lines(cart_id,position,product_id,slug,title,size,quantity,unit_price_minor,line_total_minor,supplier_id,supplier_name,external_product_id,unit_cost_minor,allocations_json) VALUES(?,?,?,?,?,'M',?,?,?,?,?,'x',?,?)")
    .run(cartId, position, productId, productId, 'Title ' + productId, quantity, total / quantity, total, supplierId, supplierId === 's1' ? 'Lorem Supply' : 'Easy', cost, allocations);
  cart('c1', 'verified', today, 3000); line('c1', 0, 'p1', 2, 2000, 's1', 500); line('c1', 1, 'p2', 1, 1000, 's2', 400);
  cart('c2', 'sent_to_suppliers', today, 3000); line('c2', 0, 'p1', 3, 3000, 's1', 500, JSON.stringify([{ supplierId: 's1', supplierName: 'Lorem Supply', quantity: 1, unitCostMinor: 500 }, { supplierId: 's2', supplierName: 'Easy', quantity: 2, unitCostMinor: 450 }]));
  cart('c3', 'submitted', today, 5000); line('c3', 0, 'p3', 5, 5000, 's2', null);
  cart('c4', 'cancelled', today, 9000); line('c4', 0, 'p4', 9, 9000, 's1', 100);
  cart('c5', 'verified', old, 7000); line('c5', 0, 'p5', 7, 7000, 's1', 100);
}

test('dashboard: owner-only, Kyiv-day sales, supplier split by allocation, scopes, visits', async t => {
  const { db, call } = setup(t);
  seedSales(db);
  await call('/api/visit', { method: 'POST', role: null, body: { type: 'view', path: '/' }, cf: { country: 'UA', region: 'Lviv' } });
  await call('/api/visit', { method: 'POST', role: null, body: { type: 'view', path: '/products/p1' }, ip: '198.51.100.1', cf: { country: 'PL', region: 'Mazovia' } });
  assert.equal((await call('/api/admin/dashboard', { role: 'manager' })).status, 403);
  assert.equal((await call('/api/admin/dashboard', { role: null })).status, 401);
  assert.equal((await call('/api/admin/dashboard?days=12')).status, 400);
  assert.equal((await call('/api/admin/dashboard?scope=all')).status, 400);
  const { status, data } = await call('/api/admin/dashboard?days=30');
  assert.equal(status, 200);
  assert.equal(data.range.days, 30);
  assert.equal(data.visits.daily.length, 30);
  assert.equal(data.visits.today.visitors, 2);
  assert.equal(data.visits.period.sessions, 2);
  assert.deepEqual(data.visits.countries.map(c => c.country).sort(), ['PL', 'UA']);
  assert.equal(data.visits.regions.length, 2);
  assert.equal(data.sales.today.orders, 2, 'verified + sent_to_suppliers');
  assert.equal(data.sales.today.units, 6);
  assert.equal(data.sales.today.revenueMinor, 6000);
  assert.equal(data.sales.today.newOrders, 3, 'all non-cancelled carts');
  assert.equal(data.sales.period.orders, 2, 'the 40-day-old cart is outside 30 days');
  assert.deepEqual(data.sales.statusCounts, { submitted: 1, verified: 2, sent_to_suppliers: 1, completed: 0, cancelled: 1 }, 'queue totals include carts outside the period');
  const bySupplier = Object.fromEntries(data.sales.suppliers.map(r => [r.supplierId, r]));
  assert.deepEqual([bySupplier.s1.units, bySupplier.s1.revenueMinor, bySupplier.s1.costMinor, bySupplier.s1.marginMinor, bySupplier.s1.orders], [3, 3000, 1500, 1500, 2]);
  assert.deepEqual([bySupplier.s2.units, bySupplier.s2.revenueMinor, bySupplier.s2.costMinor, bySupplier.s2.orders], [3, 3000, 1300, 2]);
  assert.equal(data.sales.topProducts[0].productId, 'p1');
  assert.equal(data.sales.topProducts[0].units, 5);
  assert.equal(data.conversion, 1.5);
  assert.deepEqual(data.renewals.map(r => [r.name, r.dueDate]), [['example.com', null]], 'seeded domain needs a date');
  const open = (await call('/api/admin/dashboard?days=90&scope=open')).data;
  assert.equal(open.sales.period.orders, 4, 'open scope adds submitted, still drops cancelled');
  assert.equal(Object.fromEntries(open.sales.suppliers.map(r => [r.supplierId, r])).s2.costMinor, null, 'unknown cost is not a zero');
  const text = JSON.stringify(data);
  assert.ok(!text.includes('203.0.113') && !text.includes('iPhone') && !text.includes('"visitor"'), 'no visitor keys in the response');
});

test('permissions: dashboard and infra stay owner-only until the lead moves the boundary', () => {
  assert.ok(ROLE_PERMISSIONS.owner.includes('analytics.read') && ROLE_PERMISSIONS.owner.includes('infra.read'));
  assert.ok(!ROLE_PERMISSIONS.manager.includes('analytics.read') && !ROLE_PERMISSIONS.manager.includes('infra.read') && !ROLE_PERMISSIONS.manager.includes('settings.manage'));
});

test('infra estimate: paid plan overage, unknown usage is null, free plan has no base fee', () => {
  const paid = estimate('workers_paid', { d1SizeBytes: 6e9, r2Bytes: 20e9, cf: { configured: true, worker: { requests: 12e6, cpuMs: 1e6 }, d1: { rowsRead: 1e9, rowsWritten: 60e6 }, r2: { classA: 2e6, classB: 1e6 } } });
  const cost = key => paid.lines.find(l => l.key === key).costUsd;
  assert.equal(cost('base'), 5);
  assert.equal(cost('workerRequests'), 0.6);
  assert.equal(cost('workerCpu'), 0);
  assert.equal(cost('d1RowsWritten'), 10);
  assert.equal(cost('d1Storage'), 0.75);
  assert.equal(cost('r2Storage'), 0.15);
  assert.equal(cost('r2ClassA'), 4.5);
  assert.equal(paid.totalUsd, 21);
  assert.equal(paid.complete, true);
  const unknown = estimate('workers_paid', {});
  assert.equal(unknown.lines.find(l => l.key === 'workerRequests').costUsd, null);
  assert.equal(unknown.complete, false);
  assert.equal(unknown.totalUsd, 5);
  const free = estimate('workers_free', { r2Bytes: 1e9 });
  assert.equal(free.totalUsd, 0);
  assert.ok(!free.lines.some(l => l.key === 'workerRequests'));
  assert.equal(PRICING.checkedOn, '2026-11-20');
  assert.deepEqual(['PutObject', 'GetObject', 'DeleteObject', 'ListObjects', 'HeadObject'].map(r2Class), ['A', 'B', 'free', 'A', 'B']);
});

test('cloudflare analytics: not configured without token, partial failures stay partial, token only in the header', async t => {
  const { db } = setup(t);
  assert.deepEqual((await cloudflareUsage({ DB: db })).missing, ['CF_ANALYTICS_API_TOKEN (secret)', 'INFRA_ACCOUNT_ID (var)']);
  const calls = [];
  const fakeFetch = async (url, init) => {
    calls.push({ url, init, body: JSON.parse(init.body) });
    const q = JSON.parse(init.body).query;
    if (q.includes('cpuTimeUs')) return new Response(JSON.stringify({ errors: [{ message: 'unknown field' }] }), { status: 200 });
    if (q.includes('workersInvocationsAdaptive')) return Response.json({ data: { viewer: { accounts: [{ workersInvocationsAdaptive: [{ sum: { requests: 1200, errors: 3, subrequests: 40 } }, { sum: { requests: 300, errors: 0, subrequests: 0 } }] }] } } });
    if (q.includes('d1AnalyticsAdaptiveGroups')) return Response.json({ data: { viewer: { accounts: [{ d1AnalyticsAdaptiveGroups: [{ sum: { rowsRead: 5000, rowsWritten: 70, readQueries: 10, writeQueries: 2 } }] }] } } });
    return Response.json({ data: { viewer: { accounts: [{ r2OperationsAdaptiveGroups: [{ sum: { requests: 9 }, dimensions: { actionType: 'PutObject' } }, { sum: { requests: 90 }, dimensions: { actionType: 'GetObject' } }, { sum: { requests: 4 }, dimensions: { actionType: 'DeleteObject' } }] }] } } });
  };
  const env = { DB: db, APP_ENV: 'staging', CF_ANALYTICS_API_TOKEN: 'tok-secret', INFRA_ACCOUNT_ID: 'a'.repeat(32), INFRA_D1_DATABASE_ID: 'db-id', INFRA_R2_BUCKET: 'bucket' };
  const now = new Date('2026-11-20T12:00:00Z');
  const usage = await cloudflareUsage(env, fakeFetch, now);
  assert.equal(usage.configured, true);
  assert.deepEqual(usage.worker, { requests: 1500, errors: 3, subrequests: 40 }, 'CPU query failed alone');
  assert.equal(usage.d1.rowsWritten, 70);
  assert.deepEqual(usage.r2, { classA: 9, classB: 90, free: 4 });
  assert.equal(usage.period.from, '2026-11-01T00:00:00.000Z');
  assert.equal(usage.workerName, 'lorem-store-staging');
  assert.ok(calls.every(c => c.url === 'https://api.cloudflare.com/client/v4/graphql' && c.init.headers.Authorization === 'Bearer tok-secret' && !c.init.body.includes('tok-secret')));
  assert.equal(calls.find(c => c.body.query.includes('d1Analytics')).body.variables.d, 'db-id');
  const cachedCalls = calls.length;
  await cloudflareUsage(env, fakeFetch, new Date(now.getTime() + 60000));
  assert.equal(calls.length, cachedCalls, 'cached for 15 minutes');
  assert.ok(!JSON.stringify(db.sqlite.prepare('SELECT * FROM infra_snapshots').all()).includes('tok-secret'));
});

test('infra page: owner-only, D1/R2 measurement cached, plan and renewals audited and validated', async t => {
  let lists = 0;
  const objects = Array.from({ length: 1500 }, (_, i) => ({ key: `k${i}`, size: 1000 }));
  const MEDIA = { async list({ cursor } = {}) { lists++; const start = cursor ? Number(cursor) : 0; const page = objects.slice(start, start + 1000); return { objects: page, truncated: start + 1000 < objects.length, cursor: String(start + 1000) }; } };
  const { db, call } = setup(t, { MEDIA });
  assert.equal((await call('/api/admin/infra', { role: 'manager' })).status, 403);
  const first = await call('/api/admin/infra');
  assert.equal(first.status, 200);
  assert.equal(first.data.plan, 'workers_paid');
  assert.equal(first.data.d1.sizeBytes, null, 'the test fake has no D1 meta');
  assert.ok(first.data.d1.tables.some(table => table.name === 'visit_sessions'));
  assert.deepEqual([first.data.r2[0].bytes, first.data.r2[0].objects, first.data.r2[0].truncated], [1.5e6, 1500, false]);
  assert.equal(first.data.cloudflare.configured, false);
  assert.equal(first.data.estimate.lines.find(l => l.key === 'r2Storage').costUsd, 0);
  assert.equal(lists, 2);
  await call('/api/admin/infra');
  assert.equal(lists, 2, 'R2 totals are cached');
  await call('/api/admin/infra?refresh=1');
  assert.equal(lists, 2, 'refresh is throttled to every five minutes');

  assert.equal((await call('/api/admin/infra/plan', { method: 'PUT', body: { plan: 'workers_free' }, role: 'manager' })).status, 403);
  assert.equal((await call('/api/admin/infra/plan', { method: 'PUT', body: { plan: 'enterprise' } })).status, 400);
  assert.equal((await call('/api/admin/infra/plan', { method: 'PUT', body: { plan: 'workers_free' } })).status, 200);
  assert.equal((await call('/api/admin/infra')).data.plan, 'workers_free');
  assert.equal((await call('/api/admin/infra/plan', { method: 'PUT', body: { plan: 'workers_free' }, origin: 'https://evil.test' })).status, 403);

  const created = await call('/api/admin/infra/renewals', { method: 'POST', body: { kind: 'subscription', name: '  Workers   Paid ', dueDate: '2026-12-01', costMinor: 500, currency: 'USD', autoRenew: true } });
  assert.equal(created.status, 201);
  assert.deepEqual([created.data.name, created.data.dueDate, created.data.costMinor, created.data.autoRenew], ['Workers Paid', '2026-12-01', 500, true]);
  assert.equal((await call('/api/admin/infra/renewals', { method: 'POST', body: { kind: 'domain', name: 'x', dueDate: '2026-02-30' } })).data.error, 'invalid_due_date');
  assert.equal((await call('/api/admin/infra/renewals', { method: 'POST', body: { kind: 'domain', name: 'x', dueDate: null, extra: 1 } })).data.error, 'invalid_request');
  assert.equal((await call('/api/admin/infra/renewals', { method: 'POST', body: { kind: 'domain', name: 'x', dueDate: null }, role: 'manager' })).status, 403);
  const domain = 'domain-example-com';
  const patched = await call(`/api/admin/infra/renewals/${domain}`, { method: 'PATCH', body: { dueDate: '2027-03-14', notes: 'Реєстратор: hostmaster' } });
  assert.equal(patched.status, 200);
  assert.equal(patched.data.dueDate, '2027-03-14');
  assert.equal((await call('/api/admin/infra/renewals/nope', { method: 'PATCH', body: { name: 'x' } })).status, 404);
  assert.equal((await call(`/api/admin/infra/renewals/${created.data.id}`, { method: 'DELETE', body: {} })).data.error, 'confirmation_required');
  assert.equal((await call(`/api/admin/infra/renewals/${created.data.id}`, { method: 'DELETE', body: { confirm: true } })).status, 200);
  assert.deepEqual((await call('/api/admin/infra')).data.renewals.map(r => r.id), [domain]);
  const actions = db.sqlite.prepare("SELECT action FROM audit_events WHERE action LIKE 'infra.%' ORDER BY created_at").all().map(r => r.action);
  assert.deepEqual(actions.sort(), ['infra.plan.update', 'infra.renewal.create', 'infra.renewal.delete', 'infra.renewal.update']);
  const dash = (await call('/api/admin/dashboard')).data;
  assert.deepEqual(dash.renewals, [], 'a renewal months away is not an alert');
});

test('renewal validation is strict about types', () => {
  assert.equal(validateRenewal({ kind: 'domain', name: 'a', dueDate: '2026-01-01', costMinor: -1 }).error, 'invalid_cost');
  assert.equal(validateRenewal({ kind: 'domain', name: 'a', dueDate: '2026-01-01', costMinor: 1.5 }).error, 'invalid_cost');
  assert.equal(validateRenewal({ kind: 'domain', name: 'a', dueDate: '2026-01-01', currency: 'GBP' }).error, 'invalid_currency');
  assert.equal(validateRenewal({ kind: 'domain', name: 'a', dueDate: '2026-01-01', autoRenew: 'yes' }).error, 'invalid_request');
  assert.equal(validateRenewal({ kind: 'domain', name: 'a'.repeat(121), dueDate: null }).error, 'invalid_name');
  assert.equal(validateRenewal({}, true).error, 'invalid_request');
  assert.deepEqual(validateRenewal({ notes: ' x ' }, true).value, { notes: 'x' });
});

test('visit beacon script: skips private paths, DNT/GPC and automation; inline copy is self-contained', () => {
  const run = (pathname, nav = {}) => {
    const sent = [], listeners = {};
    const win = { navigator: { sendBeacon: (url, body) => { sent.push([url, JSON.parse(body)]); return true; }, ...nav }, location: { pathname }, document: { referrer: 'https://t.me/x', visibilityState: 'visible', addEventListener: (type, fn) => { listeners[type] = fn; } }, addEventListener: (type, fn) => { listeners[type] = fn; } };
    return { started: startVisitBeacon(win), sent, listeners, win };
  };
  const home = run('/');
  assert.equal(home.started, true);
  assert.deepEqual(home.sent, [['/api/visit', { type: 'view', path: '/', ref: 'https://t.me/x' }]]);
  home.listeners.pagehide();
  assert.deepEqual(home.sent[1], ['/api/visit', { type: 'leave', path: '/' }]);
  for (const path of ['/admin', '/admin/catalog', '/staff', '/account', '/cart', '/api/x']) assert.equal(run(path).started, false, path);
  assert.equal(run('/', { doNotTrack: '1' }).started, false);
  assert.equal(run('/', { globalPrivacyControl: true }).started, false);
  assert.equal(run('/', { webdriver: true }).started, false);
  const sent = [];
  new Function('window', VISIT_BEACON_INLINE)({ navigator: { sendBeacon: (_u, b) => sent.push(JSON.parse(b)) }, location: { pathname: '/products/a' }, document: { referrer: '', addEventListener() {} }, addEventListener() {} });
  assert.deepEqual(sent, [{ type: 'view', path: '/products/a' }]);
});

test('inline beacon survives the Worker bundle (esbuild keepNames adds __name calls)', async () => {
  const result = await build({ stdin: { contents: "import { VISIT_BEACON_INLINE } from './packages/catalog/visit-beacon.js'; export default VISIT_BEACON_INLINE;", resolveDir: process.cwd(), loader: 'js' }, bundle: true, format: 'esm', keepNames: true, write: false, platform: 'neutral' });
  const code = result.outputFiles[0].text;
  const inline = (await import('data:text/javascript,' + encodeURIComponent(code))).default;
  assert.match(inline, /__name\(/, 'the bundle really rewrites inner functions');
  const sent = [];
  // Run as a browser would: no __name in scope except the wrapper's own.
  new Function('window', inline)({ navigator: { sendBeacon: (_u, b) => sent.push(JSON.parse(b)) }, location: { pathname: '/products/a' }, document: { referrer: '', addEventListener() {} }, addEventListener() {} });
  assert.deepEqual(sent, [{ type: 'view', path: '/products/a' }]);
});

test('visit abuse controls: new sessions per IP are capped, DNT/GPC headers honoured, oversized chunked bodies cut', async t => {
  const { db, call } = setup(t);
  for (let i = 0; i < NEW_SESSIONS_PER_IP_HOUR + 5; i++) await call('/api/visit', { method: 'POST', role: null, body: { type: 'view', path: '/' }, ua: `Mozilla/5.0 rotating-${i}` });
  assert.equal(db.sqlite.prepare('SELECT COUNT(*) AS n FROM visit_sessions').get().n, NEW_SESSIONS_PER_IP_HOUR);
  const stored = JSON.stringify(db.sqlite.prepare("SELECT * FROM customer_auth_throttle WHERE bucket='visit-new'").all());
  assert.ok(stored.length > 2 && !stored.includes('203.0.113.7'), 'throttle key is an HMAC, not the IP');
  await call('/api/visit', { method: 'POST', role: null, body: { type: 'view', path: '/' }, ip: '198.51.100.20' });
  assert.equal(db.sqlite.prepare('SELECT COUNT(*) AS n FROM visit_sessions').get().n, NEW_SESSIONS_PER_IP_HOUR + 1, 'another IP still counts');

  const headerCall = async headers => worker.fetch(new Request(HOST + '/api/visit', { method: 'POST', headers: { Origin: HOST, 'Content-Type': 'application/json', 'User-Agent': UA, 'CF-Connecting-IP': '198.51.100.30', ...headers }, body: JSON.stringify({ type: 'view', path: '/' }) }), { DB: db, APP_ENV: 'development' });
  assert.equal((await headerCall({ 'Sec-GPC': '1' })).status, 204);
  assert.equal((await headerCall({ DNT: '1' })).status, 204);
  assert.equal(db.sqlite.prepare('SELECT COUNT(*) AS n FROM visit_sessions').get().n, NEW_SESSIONS_PER_IP_HOUR + 1);

  let pulled = 0;
  const stream = new ReadableStream({ pull(controller) { pulled++; controller.enqueue(new TextEncoder().encode('x'.repeat(1024))); if (pulled > 1000) controller.close(); } });
  const response = await worker.fetch(new Request(HOST + '/api/visit', { method: 'POST', headers: { Origin: HOST, 'Content-Type': 'application/json', 'User-Agent': UA }, body: stream, duplex: 'half' }), { DB: db, APP_ENV: 'development' });
  assert.equal(response.status, 400);
  assert.ok(pulled < 10, `stream cancelled early, pulled ${pulled} chunks`);
});

test('dashboard status counts are queue totals; truncated R2 totals do not price storage', async t => {
  const objects = Array.from({ length: 51000 }, (_, i) => ({ key: `k${i}`, size: 1 }));
  const MEDIA = { async list({ cursor } = {}) { const start = cursor ? Number(cursor) : 0; return { objects: objects.slice(start, start + 1000), truncated: start + 1000 < objects.length, cursor: String(start + 1000) }; } };
  const { db, call } = setup(t, { MEDIA });
  db.sqlite.prepare("INSERT INTO carts(id,code,status,item_count,total_minor,created_at,updated_at,status_changed_at) VALUES('old','SSOLD0000000','submitted',1,100,'2025-01-01T00:00:00Z','2025-01-01T00:00:00Z','2025-01-01T00:00:00Z')").run();
  assert.equal((await call('/api/admin/dashboard?days=7')).data.sales.statusCounts.submitted, 1);
  const infra = (await call('/api/admin/infra')).data;
  assert.equal(infra.r2[0].truncated, true);
  assert.equal(infra.estimate.lines.find(l => l.key === 'r2Storage').costUsd, null);
  assert.equal(infra.estimate.complete, false);
});
