import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { readFileSync, readdirSync } from 'node:fs';
import { createHash, randomBytes } from 'node:crypto';
import worker from '../../apps/api/src/index.js';
import { buildSnapshot, reduceRecord } from '../../packages/catalog/delivery.js';
import { guid, loadSnapshot, r2Stub, syntheticUpstream } from '../fixtures/nova-poshta/records.js';

const ORIGIN = 'https://catalog.test';
const sha256 = value => createHash('sha256').update(value).digest('hex');
const SESSION = '__Host-ls_session';
const GUID_A = '0a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d';
// A synthetic catalog snapshot (built by the same code the sync script uses) in an R2 stub: Kyiv branch 10, Kyiv postomat 1001, Lviv branch 1.
const catalog = () => { const map = new Map(); loadSnapshot(map, buildSnapshot(syntheticUpstream().map(reduceRecord).filter(Boolean), '20261117T003000Z')); return r2Stub(map); };
const REF_BRANCH = guid('wh-a'), REF_POSTOMAT = guid('wh-p1'), REF_LVIV = guid('wh-l1'), REF_RENAMED = guid('wh-b');

function database() {
  const sqlite = new DatabaseSync(':memory:');
  // Every migration, in order (0027 rebuilds carts and needs 0017's cart_lines.allocations_json).
  for (const file of readdirSync(new URL('../../migrations/', import.meta.url)).filter(n => /^\d{4}_.*\.sql$/.test(n)).sort()) sqlite.exec(readFileSync(new URL(`../../migrations/${file}`, import.meta.url), 'utf8'));
  const wrap = (sql, bindings = []) => ({ sql, bindings, bind(...values) { return wrap(sql, values); }, async first() { return sqlite.prepare(sql).get(...bindings) ?? null; }, async all() { return { results: sqlite.prepare(sql).all(...bindings) }; }, async run() { return sqlite.prepare(sql).run(...bindings); } });
  return { sqlite, prepare: sql => wrap(sql), async batch(statements) { sqlite.exec('BEGIN'); try { const result = statements.map(s => ({ results: sqlite.prepare(s.sql).all(...s.bindings) })); sqlite.exec('COMMIT'); return result; } catch (error) { sqlite.exec('ROLLBACK'); throw error; } }, close: () => sqlite.close() };
}

// Customers and sessions are seeded directly so these tests exercise the profile API, not Google sign-in.
function setup(t, envOverrides = {}) {
  const env = { DB: database(), MEDIA: catalog(), APP_ENV: 'production', CF_ACCESS_TEAM_NAME: 'your-team', CF_ACCESS_AUD: 'catalog-audience', CUSTOMER_AUTH_HMAC_KEY: 'fake-hmac-key-for-tests', ...envOverrides };
  const logs = [], errorLog = console.error, logLog = console.log;
  console.error = (...args) => { logs.push(args.map(String).join(' ')); };
  console.log = (...args) => { logs.push(args.map(String).join(' ')); };
  t.after(() => { console.error = errorLog; console.log = logLog; env.DB.close(); });
  const sql = env.DB.sqlite;
  const a = { env, sql, logs };
  a.customer = (id, { authenticatedAt = new Date().toISOString() } = {}) => {
    const now = new Date().toISOString(), token = randomBytes(32).toString('base64url');
    sql.prepare('INSERT INTO customers(id,status,created_at,updated_at) VALUES(?,?,?,?)').run(id, 'active', now, now);
    sql.prepare("INSERT INTO customer_identities(id,customer_id,provider,subject,display_handle,created_at) VALUES(?,?,'google',?,?,?)").run('i-' + id, id, 'sub-' + id, id + '@example.com', now);
    sql.prepare('INSERT INTO customer_sessions(token_hash,customer_id,created_at,authenticated_at,last_seen_at,idle_expires_at,absolute_expires_at) VALUES(?,?,?,?,?,?,?)').run(sha256(token), id, now, authenticatedAt, now, new Date(Date.now() + 86400000).toISOString(), new Date(Date.now() + 86400000).toISOString());
    return token;
  };
  a.call = async (token, path, method = 'GET', body, { origin = ORIGIN, contentType = 'application/json', host = ORIGIN, raw, headers = {} } = {}) => {
    const h = { ...headers };
    if (origin) h.Origin = origin;
    if (token) h.Cookie = `${SESSION}=${token}`;
    if (body !== undefined || raw !== undefined) h['Content-Type'] = contentType;
    const response = await worker.fetch(new Request(host + path, { method, headers: h, body: raw ?? (body === undefined ? undefined : JSON.stringify(body)) }), env);
    const data = (response.headers.get('Content-Type') || '').includes('json') ? await response.json() : await response.text();
    return { response, data, status: response.status };
  };
  a.patch = (token, body, options) => a.call(token, '/api/account/profile', 'PATCH', body, options);
  a.get = token => a.call(token, '/api/account/profile');
  return a;
}
const PREF = { warehouseRef: REF_BRANCH };

test('GET returns an empty profile for a new customer and telegram state from identities', async t => {
  const a = setup(t), token = a.customer('c1');
  const r = await a.get(token);
  assert.equal(r.status, 200);
  assert.deepEqual(r.data, { displayName: null, lastName: null, firstName: null, middleName: null, phone: null, contactEmail: null, deliveryPreference: null, telegram: { linked: false, handle: null, linkedAt: null }, updatedAt: null });
  assert.equal(r.response.headers.get('Cache-Control'), 'no-store');
  a.sql.prepare("INSERT INTO customer_identities(id,customer_id,provider,subject,display_handle,created_at) VALUES('t1','c1','telegram','555','@shopper','2026-01-02T00:00:00.000Z')").run();
  assert.deepEqual((await a.get(token)).data.telegram, { linked: true, handle: '@shopper', linkedAt: '2026-01-02T00:00:00.000Z' });
  assert.equal(a.sql.prepare('SELECT COUNT(*) n FROM customer_profiles').get().n, 0, 'reads never create rows');
});

test('PATCH stores normalized contact fields, partial updates keep others and null clears', async t => {
  const a = setup(t), token = a.customer('c1');
  const r = await a.patch(token, { displayName: ' Олена Коваль ', phone: '050 123-45-67', contactEmail: 'Olena@Example.com' });
  assert.equal(r.status, 200);
  assert.equal(r.data.displayName, 'Олена Коваль'); assert.equal(r.data.phone, '+380501234567'); assert.equal(r.data.contactEmail, 'Olena@Example.com'); assert.ok(r.data.updatedAt);
  assert.equal((await a.patch(token, { phone: '380671234567' })).data.phone, '+380671234567');
  assert.equal((await a.patch(token, { phone: '+380931234567' })).data.phone, '+380931234567');
  const after = await a.patch(token, { displayName: null });
  assert.equal(after.data.displayName, null); assert.equal(after.data.phone, '+380931234567'); assert.equal(after.data.contactEmail, 'Olena@Example.com');
  assert.deepEqual((await a.get(token)).data, after.data);
  assert.equal((await a.patch(token, {})).status, 200, 'empty patch is a no-op');
});

test('PATCH stores ПІБ as three separate parts: same rule as the checkout recipient, displayName untouched', async t => {
  const a = setup(t), token = a.customer('c1');
  await a.patch(token, { displayName: 'Коваль Олена Петрівна' }); // a single-field ПІБ
  const r = await a.patch(token, { lastName: ' Коваль-Ліщук ', firstName: 'Марʼяна', middleName: 'Петрівна' });
  assert.equal(r.status, 200);
  assert.deepEqual([r.data.lastName, r.data.firstName, r.data.middleName], ['Коваль-Ліщук', 'Марʼяна', 'Петрівна']);
  assert.equal(r.data.displayName, 'Коваль Олена Петрівна', 'display_name is kept, never split or overwritten');
  assert.deepEqual({ ...a.sql.prepare('SELECT display_name, last_name, first_name, middle_name FROM customer_profiles').get() }, { display_name: 'Коваль Олена Петрівна', last_name: 'Коваль-Ліщук', first_name: 'Марʼяна', middle_name: 'Петрівна' });
  for (const field of ['lastName', 'firstName', 'middleName']) {
    for (const bad of ['', '   ', 'Олена1', 'О'.repeat(41), '-Олена', 'Оле​на', 'Оле‮на', 'Олена\nКоваль', 5, ['x']]) {
      const failed = await a.patch(token, { [field]: bad });
      assert.equal(failed.status, 400, `${field} ${JSON.stringify(bad)}`);
      assert.ok(!/Олена|ОООО/.test(JSON.stringify(failed.data)), 'values are never echoed');
    }
  }
  assert.equal((await a.patch(token, { middleName: 'П'.repeat(40) })).status, 200);
  const cleared = await a.patch(token, { middleName: null });
  assert.equal(cleared.data.middleName, null); assert.equal(cleared.data.lastName, 'Коваль-Ліщук');
  const events = a.sql.prepare("SELECT fields FROM customer_audit_events WHERE action='profile.update' ORDER BY created_at, rowid").all().map(e => JSON.parse(e.fields));
  assert.deepEqual(events.slice(1), [['lastName', 'firstName', 'middleName'], ['middleName'], ['middleName']]);
  const exported = await a.call(token, '/api/account/export');
  assert.deepEqual([exported.data.profile.lastName, exported.data.profile.firstName], ['Коваль-Ліщук', 'Марʼяна']);
});

test('PATCH rejects unknown keys, non-objects and bad content with exact bounds', async t => {
  const a = setup(t), token = a.customer('c1');
  for (const body of [{ nope: 1 }, { displayName: 'Ok', telegram: {} }, { updatedAt: 'x' }, { source: 'np-api' }, { customerId: 'c2' }]) assert.equal((await a.patch(token, body)).status, 400, JSON.stringify(body));
  assert.equal(a.sql.prepare('SELECT COUNT(*) n FROM customer_profiles').get().n, 0, 'a rejected patch writes nothing');
  assert.equal((await a.patch(token, [1])).status, 400);
  assert.equal((await a.patch(token, undefined, { raw: '{bad' })).status, 400);
  assert.equal((await a.patch(token, undefined, { raw: 'x'.repeat(9000) })).status, 413);
  assert.equal((await a.patch(token, {}, { contentType: 'text/plain' })).status, 415);
  assert.equal((await a.patch(token, { displayName: 'x'.repeat(80) })).status, 200);
  assert.equal((await a.patch(token, { displayName: 'x'.repeat(81) })).status, 400);
  assert.equal((await a.patch(token, { displayName: '\u{1F600}'.repeat(80) })).status, 200, 'length counts characters, not UTF-16 units');
  for (const bad of ['', '   ', 5, 'a\u0000b', 'a\nb', ['x'], 'a\u202Eb', 'a\u2066b', 'a\u200Bb', '\u200B', '\u200D\u2060', '\uFEFF', 'x\uFEFFy', ' \u3000 ', 'a\u007Fb']) assert.equal((await a.patch(token, { displayName: bad })).status, 400, JSON.stringify(bad));
  for (const bad of ['', '12345', '+38050123456', '+3805012345678', '+1 555 123 4567', '0501234567x', 380501234567]) assert.equal((await a.patch(token, { phone: bad })).status, 400, String(bad));
  assert.equal((await a.patch(token, { contactEmail: 'a@b.co' })).status, 200);
  assert.equal((await a.patch(token, { contactEmail: `${'a'.repeat(64)}@${'b'.repeat(60)}.${'c'.repeat(60)}.${'d'.repeat(60)}.${'e'.repeat(50)}` })).status, 400, 'over 254 characters');
  assert.equal((await a.patch(token, { contactEmail: `${'a'.repeat(65)}@b.co` })).status, 400);
  const edge = `${'a'.repeat(64)}@${'b'.repeat(60)}.${'c'.repeat(60)}.${'d'.repeat(60)}.${'e'.repeat(2)}`;
  assert.equal(edge.length, 250); assert.equal((await a.patch(token, { contactEmail: edge })).status, 200);
  for (const bad of ['', 'plain', 'a@b', 'a b@c.co', 'a@@b.co', '@b.co', 'a@b..co', 'a@-b.co', '<x>@b.co', 'a@b.co\u0000', 7, 'a\u0001b@example.com', 'a\u007Fb@example.com', 'a\u202Eb@example.com', 'a\u200Bb@example.com', 'a@exam\u200Bple.com']) assert.equal((await a.patch(token, { contactEmail: bad })).status, 400, String(bad));
});

test('Nova Poshta preference: only {warehouseRef, note}; the server copies the point from the catalog and sets source and origin', async t => {
  const a = setup(t), token = a.customer('c1');
  const ok = await a.patch(token, { deliveryPreference: { warehouseRef: REF_POSTOMAT.toUpperCase(), note: 'Біля входу\nдругий поверх' } });
  assert.equal(ok.status, 200);
  assert.deepEqual(ok.data.deliveryPreference, { type: 'postomat', cityName: 'Київ', cityRef: guid('city-kyiv'), warehouseNumber: '1001', warehouseRef: REF_POSTOMAT, warehouseName: 'Поштомат "Нова Пошта" №1001: вул. Сімʼї Кульженків, 31а', note: 'Біля входу\nдругий поверх', source: 'np-api', origin: 'cabinet' });
  assert.deepEqual({ ...a.sql.prepare('SELECT np_source, np_origin, np_warehouse_ref FROM customer_profiles').get() }, { np_source: 'np-api', np_origin: 'cabinet', np_warehouse_ref: REF_POSTOMAT });
  const bad = body => a.patch(token, { deliveryPreference: body });
  const rejected = ['x', [PREF], {}, { note: 'x' }, { warehouseRef: null }, { warehouseRef: '' }, { warehouseRef: 5 }, { warehouseRef: GUID_A + '0' }, { warehouseRef: '0a1b2c3d4e5f4a6b8c7d9e0f1a2b3c4d' },
    { type: 'branch', cityName: 'Київ', warehouseNumber: '12' }, { ...PREF, type: 'postomat' }, { ...PREF, cityName: 'X' }, { ...PREF, cityRef: GUID_A }, { ...PREF, warehouseNumber: '1' }, { ...PREF, warehouseName: 'x' }, { ...PREF, source: 'np-api' }, { ...PREF, origin: 'cabinet' }, { ...PREF, extra: 1 },
    { ...PREF, note: 'n'.repeat(201) }, { ...PREF, note: 'a\r\nb' }, { ...PREF, note: 'a\nb\nc' }, { ...PREF, note: 'a\u0007' }, { ...PREF, note: 'a\u202Eb' }, { ...PREF, note: 'a\u200Bb' }, { ...PREF, note: 5 }];
  for (const body of rejected) assert.equal((await bad(body)).status, 400, JSON.stringify(body));
  assert.equal((await bad({ ...PREF, note: 'n'.repeat(200) })).status, 200);
  assert.equal((await bad({ ...PREF, note: '' })).data.deliveryPreference.note, null);
  assert.equal((await bad({ ...PREF, note: undefined })).data.deliveryPreference.note, null);
  const cleared = await a.patch(token, { deliveryPreference: null });
  assert.equal(cleared.data.deliveryPreference, null);
  const row = a.sql.prepare('SELECT * FROM customer_profiles').get();
  for (const column of Object.keys(row).filter(name => name.startsWith('np_'))) assert.equal(row[column], null, `${column} cleared (including np_origin and np_warehouse_name)`);
});

test('a Ref outside the catalog is 400, an unreadable catalog is 503, and a failed catalog check writes nothing', async t => {
  const a = setup(t), token = a.customer('c1');
  await a.patch(token, { displayName: 'Keep' });
  const missing = await a.patch(token, { displayName: 'Changed', deliveryPreference: { warehouseRef: guid('gone') } });
  assert.equal(missing.status, 400); assert.deepEqual(missing.data, { error: 'deliveryPreference.warehouseRef is not in the Nova Poshta catalog' });
  assert.equal((await a.get(token)).data.displayName, 'Keep', 'nothing from the rejected request was written');
  for (const [label, MEDIA] of [['no binding', undefined], ['no manifest', r2Stub()], ['failing bucket', r2Stub(new Map(), { failGet: () => true })]]) {
    const b = setup(t, { MEDIA }), tk = b.customer('c1');
    const r = await b.patch(tk, { displayName: 'X', deliveryPreference: PREF });
    assert.equal(r.status, 503, label); assert.deepEqual(r.data, { error: 'Nova Poshta catalog is unavailable' });
    assert.equal(b.sql.prepare('SELECT COUNT(*) n FROM customer_profiles').get().n, 0);
    assert.equal((await b.patch(tk, { displayName: 'Fine' })).status, 200, 'contact edits do not need the catalog');
    assert.equal((await b.patch(tk, { deliveryPreference: null })).status, 200, 'clearing does not need the catalog');
  }
  const readsBefore = a.env.MEDIA.calls.length;
  const invalidFirst = await a.patch(token, { phone: 'bad', deliveryPreference: { warehouseRef: guid('gone') } });
  assert.equal(invalidFirst.status, 400); assert.equal(a.env.MEDIA.calls.length, readsBefore, 'a request invalid elsewhere never reads the catalog');
});

test('legacy manual preferences read back as source manual and origin null; the next PATCH replaces them', async t => {
  const a = setup(t), token = a.customer('c1');
  const now = new Date().toISOString();
  a.sql.prepare("INSERT INTO customer_profiles(customer_id,np_type,np_city_name,np_city_ref,np_warehouse_number,np_warehouse_ref,np_note,np_source,updated_at) VALUES('c1','branch','Київ',?,'12',?,'стара примітка','manual',?)").run(GUID_A, REF_BRANCH, now);
  const legacy = (await a.get(token)).data.deliveryPreference;
  assert.deepEqual(legacy, { type: 'branch', cityName: 'Київ', cityRef: GUID_A, warehouseNumber: '12', warehouseRef: REF_BRANCH, warehouseName: null, note: 'стара примітка', source: 'manual', origin: null });
  const replaced = await a.patch(token, { deliveryPreference: PREF });
  assert.equal(replaced.data.deliveryPreference.source, 'np-api'); assert.equal(replaced.data.deliveryPreference.origin, 'cabinet');
  assert.equal(replaced.data.deliveryPreference.note, null, 'the legacy note is not carried over (the replacement is whole)');
  assert.equal(replaced.data.deliveryPreference.cityName, 'Київ'); assert.equal(replaced.data.deliveryPreference.cityRef, guid('city-kyiv'), 'catalog values, not the legacy client-supplied ones');
});

test('change detection compares every stored field: origin-only and name-only changes are written and audited, identical saves are not', async t => {
  const a = setup(t), token = a.customer('c1'), audits = () => a.sql.prepare("SELECT COUNT(*) n FROM customer_audit_events WHERE action='profile.update'").get().n;
  await a.patch(token, { deliveryPreference: PREF }); assert.equal(audits(), 1);
  await a.patch(token, { deliveryPreference: PREF }); assert.equal(audits(), 1, 'identical re-save: no write, no audit');
  const stamp = a.sql.prepare('SELECT updated_at u FROM customer_profiles').get().u;
  // origin-only: an auto-remembered favourite made explicit
  a.sql.prepare("UPDATE customer_profiles SET np_origin='checkout'").run();
  await a.patch(token, { deliveryPreference: PREF });
  assert.equal(a.sql.prepare('SELECT np_origin o FROM customer_profiles').get().o, 'cabinet'); assert.equal(audits(), 2);
  // name-only: Nova Poshta renamed the point
  a.sql.prepare("UPDATE customer_profiles SET np_warehouse_name='Стара назва'").run();
  await a.patch(token, { deliveryPreference: PREF });
  assert.notEqual(a.sql.prepare('SELECT np_warehouse_name n FROM customer_profiles').get().n, 'Стара назва'); assert.equal(audits(), 3);
  // note-only
  await a.patch(token, { deliveryPreference: { ...PREF, note: 'нова' } }); assert.equal(audits(), 4);
  await a.patch(token, { deliveryPreference: { warehouseRef: REF_LVIV } }); assert.equal(audits(), 5);
  assert.ok(stamp);
});

test('owner-only: sessions, tokens, manager identity and cross-site writes are enforced', async t => {
  const a = setup(t), t1 = a.customer('c1'), t2 = a.customer('c2');
  await a.patch(t1, { displayName: 'Перший', phone: '0501111111'.slice(0, 10) });
  await a.patch(t2, { displayName: 'Другий' });
  assert.equal((await a.get(t1)).data.displayName, 'Перший'); assert.equal((await a.get(t2)).data.displayName, 'Другий');
  assert.equal(a.sql.prepare("SELECT COUNT(*) n FROM customer_profiles WHERE customer_id='c1'").get().n, 1);
  for (const [token, method, body] of [[null, 'GET'], [null, 'PATCH', { displayName: 'x' }], ['A'.repeat(43), 'GET'], ['bad', 'PATCH', { displayName: 'x' }]]) {
    const r = await a.call(token, '/api/account/profile', method, body); assert.equal(r.status, 401); assert.deepEqual(r.data, { error: 'Sign-in required' });
  }
  const anonymous = await a.call(null, '/api/account/profile', 'PATCH', { displayName: 'x' }); assert.equal(anonymous.response.headers.getSetCookie().length, 0);
  const stale = await a.get('A'.repeat(43)); assert.match(stale.response.headers.getSetCookie()[0], /^__Host-ls_session=; .*Max-Age=0/, 'a stale cookie is cleared');
  assert.equal((await a.patch(t1, { displayName: 'x' }, { origin: 'https://evil.test' })).status, 403);
  assert.equal((await a.patch(t1, { displayName: 'x' }, { origin: null })).status, 403);
  assert.equal((await a.call(t1, '/api/account/profile', 'PUT', {})).status, 405);
  assert.equal((await a.call(t1, '/api/account/profile', 'DELETE')).status, 405);
  assert.equal((await a.get(t1)).data.displayName, 'Перший');
  // Customer cookies never open manager routes, and the manager dev bypass never opens the profile.
  const admin = await a.call(t1, '/api/admin/suppliers'); assert.equal(admin.status, 401);
  const dev = setup(t, { APP_ENV: 'development', AUTH_DEV_BYPASS: 'true', AUTH_DEV_EMAIL: 'manager@example.com' });
  const bypass = await dev.call(null, '/api/account/profile', 'GET', undefined, { host: 'http://localhost', origin: 'http://localhost' }); assert.equal(bypass.status, 401);
  const devToken = dev.customer('d1');
  const devOk = await worker.fetch(new Request('http://localhost/api/account/profile', { headers: { Cookie: `ls_session_dev=${devToken}` } }), dev.env);
  assert.equal(devOk.status, 200, 'development loopback uses the dev cookie name');
  assert.equal((await worker.fetch(new Request('https://catalog.test/api/account/profile', { headers: { Cookie: `ls_session_dev=${devToken}` } }), dev.env)).status, 401, 'non-loopback host never honours dev cookie');
});

test('manager and public routes never expose profile data', async t => {
  const a = setup(t), token = a.customer('c1');
  await a.patch(token, { displayName: 'Таємне Імʼя', phone: '0501234567', contactEmail: 'secret@example.com', deliveryPreference: { ...PREF, note: 'secretnote' } });
  const sources = ['apps/api/src/index.js', 'apps/api/src/auth.js', 'apps/api/src/domain.js', 'apps/api/src/mydrop.js'].map(f => readFileSync(new URL('../../' + f, import.meta.url), 'utf8')).join('\n');
  assert.ok(!/customer_profiles|customer_identities/.test(sources), 'manager/public code never reads customer tables');
  for (const path of ['/api/products', '/api/admin/suppliers', '/api/admin/products', '/sitemap.xml']) {
    const r = await a.call(token, path); const text = typeof r.data === 'string' ? r.data : JSON.stringify(r.data);
    assert.ok(!/secret|0501234567|Таємне/.test(text), path);
  }
});

test('writes are throttled per customer (60 per hour) with Retry-After; fails closed without the HMAC key', async t => {
  const a = setup(t), t1 = a.customer('customer-visible-id'), t2 = a.customer('c2');
  for (let i = 0; i < 60; i++) assert.equal((await a.patch(t1, { displayName: 'n' + i })).status, 200, 'write ' + i);
  const limited = await a.patch(t1, { displayName: 'over' });
  assert.equal(limited.status, 429); assert.ok(Number(limited.response.headers.get('Retry-After')) > 0); assert.ok(Number(limited.response.headers.get('Retry-After')) <= 3600);
  assert.equal((await a.get(t1)).data.displayName, 'n59', 'throttled write changed nothing, reads are not throttled');
  assert.equal((await a.patch(t2, { displayName: 'other' })).status, 200, 'another customer is unaffected');
  for (const row of a.sql.prepare("SELECT * FROM customer_auth_throttle WHERE bucket='profile-write'").all()) assert.match(row.key_hmac, /^[0-9a-f]{64}$/);
  assert.ok(!JSON.stringify(a.sql.prepare('SELECT * FROM customer_auth_throttle').all()).includes('customer-visible-id'));
  const open = setup(t, { CUSTOMER_AUTH_HMAC_KEY: '' }), token = open.customer('c9');
  assert.equal((await open.patch(token, { displayName: 'x' })).status, 503);
  assert.equal(open.sql.prepare('SELECT COUNT(*) n FROM customer_profiles').get().n, 0);
});

test('audit events record changed field names only and nothing for no-op patches', async t => {
  const a = setup(t), token = a.customer('c1');
  await a.patch(token, { displayName: 'Аудит Тест', phone: '0501234567', deliveryPreference: { ...PREF, note: 'audit-secret-note' } });
  await a.patch(token, { displayName: 'Аудит Тест', phone: '+380501234567' });
  await a.patch(token, { phone: '+380671234567', contactEmail: 'audit@example.com' });
  await a.patch(token, { deliveryPreference: null, displayName: null });
  const events = a.sql.prepare("SELECT fields, action FROM customer_audit_events WHERE action LIKE 'profile.%' ORDER BY created_at, rowid").all();
  assert.deepEqual(events.map(e => e.action), ['profile.update', 'profile.update', 'profile.update']);
  assert.deepEqual(events.map(e => JSON.parse(e.fields)), [['displayName', 'phone', 'deliveryPreference'], ['phone', 'contactEmail'], ['displayName', 'deliveryPreference']]);
  const everything = JSON.stringify(a.sql.prepare('SELECT * FROM customer_audit_events').all());
  for (const secret of ['Аудит', '0501234567', '671234567', 'audit@example.com', 'audit-secret-note', 'Київ']) assert.ok(!everything.includes(secret), secret);
  await a.patch(token, { displayName: 'x'.repeat(81) });
  assert.equal(a.sql.prepare("SELECT COUNT(*) n FROM customer_audit_events WHERE action='profile.update'").get().n, 3, 'rejected patches are not audited');
});

test('PII never appears in logs or error bodies, and unexpected database failures return a fixed message', async t => {
  const a = setup(t), token = a.customer('c1');
  for (const [body, message] of [[{ secretkey: 1 }, 'Unknown field'], [{ deliveryPreference: { ...PREF, secretkey: 1 } }, 'Unknown deliveryPreference field']]) { const r = await a.patch(token, body); assert.equal(r.status, 400); assert.deepEqual(r.data, { error: message }); }
  const attempts = [{ phone: '+1 555 secret-phone' }, { contactEmail: 'pii-person@bad' }, { displayName: 'x'.repeat(81) + 'pii-name' }, { deliveryPreference: { ...PREF, cityName: 'Pii<City>' } }, { deliveryPreference: { ...PREF, note: 'pii-note'.repeat(40) } }];
  for (const body of attempts) { const r = await a.patch(token, body); assert.equal(r.status, 400); assert.ok(!/pii|secret-phone|555/i.test(JSON.stringify(r.data)), JSON.stringify(r.data)); }
  await a.patch(token, { displayName: 'Pii Name', phone: '0501234567', contactEmail: 'pii-person@example.com' });
  a.env.DB.batch = async () => { throw new Error('db exploded with pii-person@example.com'); };
  const failed = await a.patch(token, { displayName: 'Other' });
  assert.equal(failed.status, 500); assert.deepEqual(failed.data, { error: 'Internal server error' });
  assert.ok(!a.logs.join('\n').match(/pii|0501234567|example\.com/i), a.logs.join('\n'));
});

test('profile rows cascade away with the customer and migration constraints reject bad values', async t => {
  const a = setup(t), token = a.customer('c1');
  await a.patch(token, { displayName: 'Cascade', deliveryPreference: PREF });
  a.sql.prepare("DELETE FROM customers WHERE id='c1'").run();
  assert.equal(a.sql.prepare('SELECT COUNT(*) n FROM customer_profiles').get().n, 0);
  a.customer('c2');
  const now = new Date().toISOString();
  assert.throws(() => a.sql.prepare("INSERT INTO customer_profiles(customer_id,np_type,updated_at) VALUES('c2','locker',?)").run(now));
  assert.throws(() => a.sql.prepare("INSERT INTO customer_profiles(customer_id,np_source,updated_at) VALUES('c2','other',?)").run(now));
  assert.throws(() => a.sql.prepare("INSERT INTO customer_profiles(customer_id,updated_at) VALUES('missing',?)").run(now));
});

// ---- export and deletion (hard delete including audit events; export without hashes or secrets) ----
const tablesFor = (a, id) => ({
  customers: a.sql.prepare('SELECT COUNT(*) n FROM customers WHERE id=?').get(id).n,
  identities: a.sql.prepare('SELECT COUNT(*) n FROM customer_identities WHERE customer_id=?').get(id).n,
  sessions: a.sql.prepare('SELECT COUNT(*) n FROM customer_sessions WHERE customer_id=?').get(id).n,
  profiles: a.sql.prepare('SELECT COUNT(*) n FROM customer_profiles WHERE customer_id=?').get(id).n,
  audit: a.sql.prepare('SELECT COUNT(*) n FROM customer_audit_events WHERE customer_id=?').get(id).n,
  flows: a.sql.prepare('SELECT COUNT(*) n FROM customer_auth_flows WHERE customer_id=?').get(id).n,
});

test('export returns the owner data as JSON without hashes or secrets and never another customer', async t => {
  const a = setup(t), token = a.customer('c1'), other = a.customer('c2');
  await a.patch(token, { displayName: 'Експорт', phone: '0501234567', contactEmail: 'export@example.com', deliveryPreference: PREF });
  await a.patch(other, { displayName: 'Чужий' });
  a.sql.prepare("INSERT INTO customer_identities(id,customer_id,provider,subject,display_handle,created_at) VALUES('t1','c1','telegram','555000','@exporter','2026-01-02T00:00:00.000Z')").run();
  const r = await a.call(token, '/api/account/export');
  assert.equal(r.status, 200); assert.equal(r.response.headers.get('Cache-Control'), 'no-store');
  assert.deepEqual(Object.keys(r.data).sort(), ['auditEvents', 'carts', 'customer', 'identities', 'profile']);
  assert.equal(r.data.customer.id, 'c1'); assert.equal(r.data.profile.phone, '+380501234567'); assert.deepEqual([r.data.profile.deliveryPreference.warehouseRef, r.data.profile.deliveryPreference.warehouseName, r.data.profile.deliveryPreference.origin], [REF_BRANCH, 'Відділення №10: вул. Тестова, 10', 'cabinet']);
  assert.deepEqual(r.data.identities.map(i => [i.provider, i.subject]), [['google', 'sub-c1'], ['telegram', '555000']]);
  assert.deepEqual(r.data.auditEvents.map(e => [e.action, e.fields]), [['profile.update', ['displayName', 'phone', 'contactEmail', 'deliveryPreference']]]);
  const text = JSON.stringify(r.data);
  assert.ok(!text.includes(sha256(token)) && !text.includes(token) && !/token_hash|key_hmac|code_verifier|Чужий|c2/.test(text));
  assert.ok(!/[0-9a-f]{64}/.test(text), 'no hashes');
  assert.equal((await a.call(null, '/api/account/export')).status, 401);
  assert.equal((await a.call(token, '/api/account/export', 'POST', {})).status, 405);
  assert.equal(a.sql.prepare("SELECT COUNT(*) n FROM customer_audit_events WHERE action NOT LIKE 'profile.%'").get().n, 0, 'export writes no audit event');
});

test('DELETE /api/account hard-deletes every customer row including audit events, clears the cookie and leaves others', async t => {
  const a = setup(t), token = a.customer('c1'), other = a.customer('c2');
  await a.patch(token, { displayName: 'Видалити', deliveryPreference: PREF }); await a.patch(other, { displayName: 'Лишити' });
  a.sql.prepare("INSERT INTO customer_identities(id,customer_id,provider,subject,display_handle,created_at) VALUES('t1','c1','telegram','555000','@gone','2026-01-02T00:00:00.000Z')").run();
  a.sql.prepare("INSERT INTO customer_auth_flows(binding_hash,state_hash,provider,intent,customer_id,code_verifier,nonce,redirect_uri,return_path,created_at,expires_at) VALUES('b','s','telegram','link','c1','v','n','https://catalog.test/x','/account','2026-01-01','2099-01-01')").run();
  a.sql.prepare("INSERT INTO customer_sessions(token_hash,customer_id,created_at,authenticated_at,last_seen_at,idle_expires_at,absolute_expires_at) SELECT 'second',customer_id,created_at,authenticated_at,last_seen_at,idle_expires_at,absolute_expires_at FROM customer_sessions WHERE customer_id='c1'").run();
  assert.ok(Object.values(tablesFor(a, 'c1')).every(n => n >= 1));
  assert.equal((await a.call(token, '/api/account', 'DELETE')).status, 415);
  for (const body of [{}, { confirm: false }, { confirm: 'true' }, { confirm: true, extra: 1 }]) assert.equal((await a.call(token, '/api/account', 'DELETE', body)).status, 400, JSON.stringify(body));
  assert.equal((await a.call(token, '/api/account', 'DELETE', { confirm: true }, { origin: 'https://evil.test' })).status, 403);
  assert.equal((await a.call(null, '/api/account', 'DELETE', { confirm: true })).status, 401);
  assert.ok(Object.values(tablesFor(a, 'c1')).every(n => n >= 1), 'rejected requests delete nothing');
  const r = await a.call(token, '/api/account', 'DELETE', { confirm: true });
  assert.equal(r.status, 200); assert.deepEqual(r.data, { deleted: true });
  assert.match(r.response.headers.getSetCookie()[0], /^__Host-ls_session=; .*Secure; .*Max-Age=0/);
  assert.deepEqual(Object.values(tablesFor(a, 'c1')), [0, 0, 0, 0, 0, 0]);
  assert.equal(a.sql.prepare('SELECT COUNT(*) n FROM customer_audit_events').get().n, 1, 'no audit trail of the deleted account remains; the other customer is untouched');
  assert.equal((await a.get(token)).status, 401); assert.equal((await a.get(other)).data.displayName, 'Лишити');
  assert.equal((await a.call(token, '/api/account', 'DELETE', { confirm: true })).status, 401, 'second delete is unauthenticated');
  assert.equal((await a.call(other, '/api/account', 'GET')).status, 405);
});

test('deletion requires a sign-in within the last 10 minutes and is atomic', async t => {
  const a = setup(t), old = a.customer('c1', { authenticatedAt: new Date(Date.now() - 11 * 60000).toISOString() }), fresh = a.customer('c2', { authenticatedAt: new Date(Date.now() - 9 * 60000).toISOString() });
  await a.patch(old, { displayName: 'Старий' });
  const denied = await a.call(old, '/api/account', 'DELETE', { confirm: true });
  assert.equal(denied.status, 403); assert.ok(denied.data.error); assert.ok(!denied.response.headers.getSetCookie().length, 'session stays usable so the customer can re-authenticate');
  assert.equal(tablesFor(a, 'c1').customers, 1); assert.equal((await a.get(old)).status, 200);
  assert.equal((await a.call(fresh, '/api/account', 'DELETE', { confirm: true })).status, 200);
  // A failing statement rolls the whole deletion back.
  const b = setup(t), token = b.customer('c1'); await b.patch(token, { displayName: 'Atomic' });
  const original = b.env.DB.batch; b.env.DB.batch = async statements => original.call(b.env.DB, [...statements, { sql: 'DELETE FROM missing_table', bindings: [] }]);
  assert.equal((await b.call(token, '/api/account', 'DELETE', { confirm: true })).status, 500);
  b.env.DB.batch = original;
  const left = tablesFor(b, 'c1'); assert.ok([left.customers, left.identities, left.sessions, left.profiles, left.audit].every(n => n >= 1), 'nothing was deleted');
});

test('migration 0012 applies on a populated database; existing preferences and carts keep their data', () => {
  const sqlite = new DatabaseSync(':memory:'), run = names => names.forEach(name => sqlite.exec(readFileSync(new URL(`../../migrations/${name}.sql`, import.meta.url), 'utf8')));
  run(['0001_catalog', '0002_mydrop_connection', '0003_admin_trash', '0004_customer_accounts', '0005_recognition', '0006_customer_profile', '0007_taxonomy', '0008_staff', '0009_staff_flow_session', '0010_staff_admin_guards', '0011_carts']);
  const now = new Date().toISOString();
  sqlite.prepare("INSERT INTO customers(id,status,created_at,updated_at) VALUES('c1','active',?,?)").run(now, now);
  sqlite.prepare("INSERT INTO customer_profiles(customer_id,np_type,np_city_name,np_warehouse_number,np_warehouse_ref,np_source,updated_at) VALUES('c1','branch','Київ','12',?,'manual',?)").run(GUID_A, now);
  sqlite.prepare("INSERT INTO carts(id,code,customer_id,item_count,total_minor,created_at,updated_at,status_changed_at) VALUES('k1','SS-0000-0001','c1',1,100,?,?,?)").run(now, now, now);
  run(['0012_delivery_point']);
  assert.deepEqual({ ...sqlite.prepare('SELECT np_source,np_origin,np_warehouse_name,np_warehouse_ref FROM customer_profiles').get() }, { np_source: 'manual', np_origin: null, np_warehouse_name: null, np_warehouse_ref: GUID_A });
  assert.deepEqual({ ...sqlite.prepare('SELECT dp_type,dp_warehouse_ref FROM carts').get() }, { dp_type: null, dp_warehouse_ref: null });
  assert.throws(() => sqlite.prepare("UPDATE customer_profiles SET np_origin='other'").run());
  assert.throws(() => sqlite.prepare("UPDATE carts SET dp_type='locker'").run());
  sqlite.close();
});
