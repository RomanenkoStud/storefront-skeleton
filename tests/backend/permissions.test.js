import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { readFileSync, readdirSync } from 'node:fs';
import worker from '../../apps/api/src/index.js';
import { ADMIN_ROUTES, ROLE_PERMISSIONS, can, actorLabel, matchAdminRoute, withRoleMatrixForTests } from '../../apps/api/src/permissions.js';

const migrationDir = new URL('../../migrations/', import.meta.url);
const migrations = readdirSync(migrationDir).filter(name => /^\d{4}_.*\.sql$/.test(name)).sort();
function database() {
  const sqlite = new DatabaseSync(':memory:');
  for (const name of migrations) sqlite.exec(readFileSync(new URL(name, migrationDir), 'utf8'));
  const wrap = (sql, bindings = []) => ({ sql, bindings, bind(...values) { return wrap(sql, values); }, async first() { return sqlite.prepare(sql).get(...bindings) ?? null; }, async all() { return { results: sqlite.prepare(sql).all(...bindings) }; }, async run() { return sqlite.prepare(sql).run(...bindings); } });
  return { sqlite, prepare: sql => wrap(sql), async batch(statements) { sqlite.exec('BEGIN'); try { const result = statements.map(s => sqlite.prepare(s.sql).run(...s.bindings)); sqlite.exec('COMMIT'); return result; } catch (error) { sqlite.exec('ROLLBACK'); throw error; } }, close: () => sqlite.close() };
}

// Access JWT fixture
let keys;
async function accessToken(email = 'owner@example.com') {
  keys ??= await crypto.subtle.generateKey({ name: 'RSASSA-PKCS1-v1_5', modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: 'SHA-256' }, true, ['sign', 'verify']);
  const jwk = await crypto.subtle.exportKey('jwk', keys.publicKey); jwk.kid = 'k'; jwk.alg = 'RS256';
  const enc = value => Buffer.from(JSON.stringify(value)).toString('base64url');
  const unsigned = enc({ alg: 'RS256', kid: 'k' }) + '.' + enc({ iss: 'https://your-team.cloudflareaccess.com', aud: ['catalog-audience'], email, exp: Math.floor(Date.now() / 1000) + 3600 });
  const signature = await crypto.subtle.sign('RSASSA-PKCS1-v1_5', keys.privateKey, new TextEncoder().encode(unsigned));
  return { token: unsigned + '.' + Buffer.from(signature).toString('base64url'), jwk };
}

const ORIGIN = 'http://localhost';
const source = { externalId: 'x-1', title: 'Test Coat', description: 'd', category: 'Coats', costMinor: 10001, currency: 'UAH', photos: ['https://example.com/p.jpg'], variants: [{ id: 's', size: 'S', stock: 4 }] };

// A shared D1 with several principals. Each principal has its own env so role and credential differ per request.
async function setup(t) {
  const db = database(), { token, jwk } = await accessToken(), original = globalThis.fetch;
  globalThis.fetch = async url => String(url).includes('/cdn-cgi/access/certs') ? new Response(JSON.stringify({ keys: [jwk] }), { headers: { 'Content-Type': 'application/json' } }) : String(url).includes('dropshipper_vendors') ? new Response(JSON.stringify({ results: [{ id: 7, vendor: { name: 'Vendor X', publicUrl: 'vendorx' }, verified: true, hidden: false }] }), { headers: { 'Content-Type': 'application/json' } }) : Promise.reject(new Error('network disabled in tests'));
  t.after(() => { globalThis.fetch = original; db.close(); });
  const base = { DB: db, CF_ACCESS_TEAM_NAME: 'your-team', CF_ACCESS_AUD: 'catalog-audience' };
  const envs = {
    anon: { ...base, APP_ENV: 'production' },
    access: { ...base, APP_ENV: 'production' },
    owner: { ...base, APP_ENV: 'development', AUTH_DEV_BYPASS: 'true', DEV_STAFF_ROLE: 'owner' },
    manager: { ...base, APP_ENV: 'development', AUTH_DEV_BYPASS: 'true', DEV_STAFF_ROLE: 'manager' }
  };
  async function call(who, path, method = 'GET', body, { headers = {}, env = {}, host = 'localhost', origin = ORIGIN } = {}) {
    const h = { ...headers }; if (origin) h.Origin = origin;
    if (who === 'access') h.Cookie = 'CF_Authorization=' + token;
    const multipart = body instanceof FormData;
    if (body !== undefined && !multipart) h['Content-Type'] = 'application/json';
    const response = await worker.fetch(new Request(`http://${host}${path}`, { method, headers: h, body: body === undefined ? undefined : multipart ? body : JSON.stringify(body) }), { ...envs[who], ...env });
    const type = response.headers.get('Content-Type') || '';
    return { status: response.status, data: type.includes('json') ? await response.json() : await response.text() };
  }
  const supplier = (await call('owner', '/api/admin/suppliers', 'POST', { name: 'Demo', url: 'https://mydrop.com.ua/seg', connectionId: '12345' })).data;
  assert.ok(supplier.id);
  assert.equal((await call('owner', `/api/admin/suppliers/${supplier.id}/import`, 'POST', { items: [source] })).status, 200);
  const product = (await call('owner', '/api/admin/products')).data.items[0];
  return { db, call, envs, supplier, product };
}
const snapshot = db => JSON.stringify(['products', 'suppliers', 'audit_events', 'staff_members', 'staff_sessions', 'taxonomy_state', 'recognition_state', 'recognition_versions', 'taxonomy_changes', 'sync_runs', 'campaign_pictures'].map(table => db.sqlite.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all()));

const EXPECTED_ROUTES = [
  ['GET', '/staff', 'staff.read'],
  ['POST', '/staff', 'staff.manage'],
  ['PATCH', '/staff/:id', 'staff.manage'],
  ['POST', '/staff/:id/suspend', 'staff.manage'],
  ['POST', '/staff/:id/reactivate', 'staff.manage'],
  ['POST', '/staff/:id/reinvite', 'staff.manage'],
  ['POST', '/staff/:id/sessions/revoke', 'staff.manage'],
  ['DELETE', '/staff/:id', 'staff.manage'],
  ['GET', '/audit', 'audit.read'],
  ['GET', '/storefront', 'catalog.read'], ['PUT', '/storefront/campaign', 'settings.manage'], ['POST', '/storefront/pictures', 'settings.manage'], ['PUT', '/storefront/pictures/order', 'settings.manage'], ['DELETE', '/storefront/pictures/:id', 'settings.manage'], ['PUT', '/storefront/ticker', 'settings.manage'], ['PUT', '/storefront/checkout', 'settings.manage'], ['PUT', '/storefront/banner', 'settings.manage'], ['PUT', '/storefront/images', 'settings.manage'], ['DELETE', '/storefront/images/:categoryId/:slot', 'settings.manage'],
  ['GET', '/taxonomy', 'catalog.read'], ['POST', '/taxonomy/preview', 'taxonomy.edit'], ['POST', '/taxonomy/apply', 'taxonomy.edit'],
  ['GET', '/recognition', 'recognition.draft'], ['POST', '/recognition/drafts', 'recognition.draft'], ['POST', '/recognition/preview', 'recognition.draft'],
  ['POST', '/recognition/apply', 'recognition.apply'], ['POST', '/recognition/activate', 'recognition.activate'],
  ['POST', '/suppliers/sync-connected', 'suppliers.manage'], ['GET', '/suppliers', 'catalog.read'], ['POST', '/suppliers/manual', 'suppliers.manual'], ['POST', '/suppliers', 'suppliers.manage'],
  ['PATCH', '/suppliers/:id', 'suppliers.manage'], ['DELETE', '/suppliers/:id', 'suppliers.manage'], ['POST', '/suppliers/:id/restore', 'suppliers.manage'],
  ['POST', '/suppliers/:id/import', 'suppliers.sync'], ['POST', '/suppliers/:id/sync', 'suppliers.sync'],
  ['GET', '/products', 'catalog.read'], ['POST', '/products', 'products.create'], ['POST', '/products/bulk', 'products.edit'], ['POST', '/products/bulk-tags', 'products.edit'], ['DELETE', '/products/:id', 'products.trash'],
  ['POST', '/products/:id/restore', 'products.trash'], ['PATCH', '/products/:id', 'products.edit'], ['PATCH', '/products/:id/source', 'products.create'], ['POST', '/products/:id/photos', 'media.upload'], ['DELETE', '/products/:id/permanent', 'products.purge'], ['POST', '/media', 'media.upload'], ['GET', '/media', 'media.read'], ['POST', '/media/scan', 'media.manage'], ['POST', '/media/cleanup', 'media.manage'], ['GET', '/products/:id/image', 'media.read'], ['GET', '/products/:id/image-originals', 'media.read'], ['POST', '/products/:id/cutout', 'media.upload'], ['POST', '/products/:id/normalized', 'media.upload'], ['GET', '/sync-runs', 'catalog.read'],
  ['GET', '/duplicates', 'catalog.read'], ['POST', '/duplicates/groups', 'products.edit'], ['DELETE', '/duplicates/groups/:id', 'products.edit'], ['DELETE', '/duplicates/groups/:id/members/:productId', 'products.edit'], ['POST', '/duplicates/rejections', 'products.edit'], ['DELETE', '/duplicates/rejections', 'products.edit'],
  ['GET', '/carts', 'orders.read'], ['GET', '/carts/:code', 'orders.read'], ['POST', '/carts/:code/status', 'orders.operate'],
  ['GET', '/dashboard', 'analytics.read'], ['GET', '/infra', 'infra.read'], ['PUT', '/infra/plan', 'settings.manage'],
  ['POST', '/infra/renewals', 'settings.manage'], ['PATCH', '/infra/renewals/:id', 'settings.manage'], ['DELETE', '/infra/renewals/:id', 'settings.manage']
];
const MANAGER_DENIED = new Set(['PUT /storefront/banner', 'PUT /storefront/images', 'DELETE /storefront/images/:categoryId/:slot', 'PUT /storefront/campaign', 'PUT /storefront/ticker', 'PUT /storefront/checkout', 'POST /storefront/pictures', 'PUT /storefront/pictures/order', 'DELETE /storefront/pictures/:id', 'POST /recognition/activate', 'POST /suppliers/sync-connected', 'POST /suppliers', 'PATCH /suppliers/:id', 'DELETE /suppliers/:id', 'POST /suppliers/:id/restore', 'DELETE /products/:id/permanent', 'POST /media/scan', 'POST /media/cleanup', 'GET /dashboard', 'GET /infra', 'PUT /infra/plan', 'POST /infra/renewals', 'PATCH /infra/renewals/:id', 'DELETE /infra/renewals/:id']);

test('route inventory: reviewed table equals ADMIN_ROUTES, index.js has one mount and one handler per route', () => {
  assert.deepEqual(ADMIN_ROUTES.map(r => [r.method, r.pattern, r.permission]), EXPECTED_ROUTES);
  assert.equal(new Set(ADMIN_ROUTES.map(r => r.id)).size, ADMIN_ROUTES.length);
  const src = readFileSync(new URL('../../apps/api/src/index.js', import.meta.url), 'utf8');
  assert.equal(src.split("'/api/admin/'").length - 1, 1, 'index.js must contain the /api/admin/ mount exactly once');
  const body = src.slice(src.indexOf('const ADMIN_HANDLERS={'), src.indexOf('assertHandlers(ADMIN_HANDLERS)'));
  const keys = [...body.matchAll(/^  '([A-Za-z.]+)':/gm)].map(m => m[1]);
  assert.deepEqual([...keys].sort(), ADMIN_ROUTES.map(r => r.id).sort());
  const known = new Set(Object.values(ROLE_PERMISSIONS).flat());
  for (const route of ADMIN_ROUTES) assert.ok(known.has(route.permission), route.permission);
  assert.ok(can({ role: 'owner' }, 'staff.manage') && !can({ role: 'manager' }, 'staff.manage') && !can({ role: 'x' }, 'catalog.read') && !can(null, 'catalog.read'));
});

const concrete = (route, ctx) => route.pattern.replace('/products/:id', `/products/${ctx.product.id}`).replace(':id', ctx.supplier.id).replace(':categoryId/:slot', 'shorts/poster');
const bodyFor = method => (method === 'GET' ? undefined : {});

test('default deny: unlisted paths are 401 anonymous, 404 for owners, wrong methods 405', async t => {
  const ctx = await setup(t);
  for (const path of ['/nope', '/products/a/b', '/products/', '/taxonomy/delete', '/unknown-staff', '/unknown-audit', '/suppliers/x/y']) {
    assert.equal((await ctx.call('anon', '/api/admin' + path)).status, 401, path);
    assert.equal((await ctx.call('owner', '/api/admin' + path)).status, 404, path);
    assert.equal((await ctx.call('manager', '/api/admin' + path)).status, 404, path);
  }
  const put = await worker.fetch(new Request('http://localhost/api/admin/products', { method: 'PUT', headers: { Origin: ORIGIN, 'Content-Type': 'application/json' }, body: '{}' }), ctx.envs.owner);
  assert.equal(put.status, 405); assert.equal(put.headers.get('Allow'), 'GET, POST');
  const bulk = await worker.fetch(new Request('http://localhost/api/admin/products/bulk', { headers: {} }), ctx.envs.owner);
  assert.equal(bulk.status, 405); assert.equal(bulk.headers.get('Allow'), 'POST, DELETE, PATCH', 'bulk also matches the :id routes, as routing does');
  const one = await worker.fetch(new Request('http://localhost/api/admin/products/abc', { headers: {} }), ctx.envs.owner);
  assert.equal(one.headers.get('Allow'), 'DELETE, PATCH');
  assert.equal((await ctx.call('owner', '/api/admin/products', 'PUT', {})).status, 405);
  assert.equal((await ctx.call('owner', '/api/admin/products/bulk', 'GET')).status, 405);
  assert.equal((await ctx.call('anon', '/api/admin/products', 'PUT', {})).status, 401);
  assert.deepEqual(matchAdminRoute('GET', '/zzz'), { status: 404 });
  assert.deepEqual(matchAdminRoute('DELETE', '/taxonomy'), { status: 405, allow: 'GET' });
});

// For every manager-denied route the request is one that WOULD succeed for an owner, so an unchanged D1 snapshot proves the 403 came first.
const seedPicture = (ctx, id) => ctx.db.sqlite.prepare("INSERT INTO campaign_pictures VALUES(?,'shorts',?,100,100,0,'seed','2026-01-01T00:00:00Z')").run(id, `campaign/${'a'.repeat(36)}-${id.length}.png`);
// The matrix substitutes the supplier id for ':id', so seed a renewal under that id for the renewal routes.
const renewalRow = ctx => ctx.db.sqlite.prepare("INSERT OR IGNORE INTO infra_renewals(id,kind,name,due_date,created_at,updated_at) VALUES(?,'other','Seeded',NULL,'2026-01-01T00:00:00Z','2026-01-01T00:00:00Z')").run(ctx.supplier.id);
const DENIED_REQUESTS = {
  'PUT /storefront/campaign': async () => ({ body: { mode: 'auto', excluded: ['shorts'] } }),
  'PUT /storefront/ticker': async () => ({ body: { enabled: true, items: ['STREETWEAR'] } }),
  'POST /storefront/pictures': async () => {
    const png = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10, 0, 0, 0, 13, 73, 72, 68, 82, 0, 0, 1, 0, 0, 0, 1, 0, 8, 6, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 73, 69, 78, 68]), form = new FormData();
    form.set('file', new File([png], 'a.png', { type: 'image/png' })); form.set('categoryId', 'shorts');
    return { body: form, env: { MEDIA: { put: async () => {}, delete: async () => {} } } };
  },
  'PUT /storefront/pictures/order': async ctx => { seedPicture(ctx, 'seed-order'); return { body: { categoryId: 'shorts', ids: ['seed-order'] } }; },
  'DELETE /storefront/pictures/:id': async ctx => { seedPicture(ctx, ctx.supplier.id); return { body: {} }; },
  'PUT /storefront/checkout': async () => ({ body: { prepaymentMinor: 20000 } }),
  'PUT /storefront/banner': async () => ({ body: { enabled: true, text: 'BLACK FRIDAY' } }),
  'PUT /storefront/images': async () => {
    const png = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10, 0, 0, 0, 13, 73, 72, 68, 82, 0, 0, 1, 0, 0, 0, 1, 0, 8, 6, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 73, 69, 78, 68]), form = new FormData();
    form.set('file', new File([png], 'a.png', { type: 'image/png' })); form.set('categoryId', 'shorts'); form.set('slot', 'poster');
    return { body: form, env: { MEDIA: { put: async () => {}, delete: async () => {} } } };
  },
  'DELETE /storefront/images/:categoryId/:slot': async ctx => { ctx.db.sqlite.prepare("INSERT INTO storefront_images VALUES('shorts','poster',?,100,100,'seed','2026-01-01T00:00:00Z')").run(`storefront/${'b'.repeat(8)}-bbbb-bbbb-bbbb-${'b'.repeat(12)}.png`); return { body: {} }; },
  'POST /recognition/activate': async ctx => {
    const draft = (await ctx.call('owner', '/api/admin/recognition/drafts', 'POST', { settings: structuredClone((await ctx.call('owner', '/api/admin/recognition')).data.defaults) })).data;
    const preview = (await ctx.call('owner', '/api/admin/recognition/preview', 'POST', { versionId: draft.id })).data;
    return { body: { versionId: draft.id, token: preview.token, confirm: true } };
  },
  'POST /suppliers/sync-connected': async () => ({ body: {}, env: { MYDROP_API_KEY: 'fake-key' } }),
  'POST /suppliers': async () => ({ body: { name: 'Another', url: 'https://mydrop.com.ua/another', connectionId: '777' } }),
  'PATCH /suppliers/:id': async () => ({ body: { name: 'Renamed', enabled: false, connectionId: '999' } }),
  'DELETE /suppliers/:id': async () => ({ body: { confirm: true } }),
  'GET /dashboard': async () => ({}),
  'GET /infra': async () => ({}),
  'PUT /infra/plan': async () => ({ body: { plan: 'workers_free' } }),
  'POST /infra/renewals': async () => ({ body: { kind: 'domain', name: 'example.test', dueDate: null } }),
  'PATCH /infra/renewals/:id': async ctx => { renewalRow(ctx); return { body: { name: 'Renamed' } }; },
  'DELETE /infra/renewals/:id': async ctx => { renewalRow(ctx); return { body: { confirm: true } }; },
  'DELETE /products/:id/permanent': async ctx => { assert.equal((await ctx.call('owner', `/api/admin/products/${ctx.product.id}`, 'DELETE', { confirm: true })).status, 200); return { body: { confirm: true } }; },
  'POST /media/scan': async () => ({ body: {}, env: { MEDIA: { async list() { return { objects: [], truncated: false }; } } } }),
  'POST /media/cleanup': async () => ({ body: { confirm: true, orphans: ['aaaa.png'] }, env: { MEDIA: { async head() { return null; }, async delete() {} } } }),
  'POST /suppliers/:id/restore': async ctx => { assert.equal((await ctx.call('owner', `/api/admin/suppliers/${ctx.supplier.id}`, 'DELETE', { confirm: true })).status, 200); return { body: {} }; }
};
test('principal x route matrix: anonymous 401, manager 403 for owner-only routes with no D1 change, owners and Access pass', async t => {
  for (const route of ADMIN_ROUTES.filter(route => !route.id.startsWith('staff.') && !route.id.startsWith('audit.'))) {
    await t.test(`${route.method} ${route.pattern}`, async tt => {
      const key = `${route.method} ${route.pattern}`, denied = Object.hasOwn(DENIED_REQUESTS, key);
      assert.equal(MANAGER_DENIED.has(key), denied);
      const ctx = await setup(tt), prepared = denied ? await DENIED_REQUESTS[key](ctx) : {}, body = prepared.body ?? bodyFor(route.method), env = prepared.env ?? {}, full = '/api/admin' + concrete(route, ctx);
      assert.equal((await ctx.call('anon', full, route.method, body, { env })).status, 401);
      assert.equal((await ctx.call('anon', full, route.method, body, { env, headers: { Cookie: '__Host-ls_session=abc; __Host-ls_staff=abc' } })).status, 401, 'customer/staff cookies are not credentials');
      const before = snapshot(ctx.db);
      const manager = (await ctx.call('manager', full, route.method, body, { env })).status;
      if (denied) { assert.equal(manager, 403, 'manager denied'); assert.equal(snapshot(ctx.db), before, 'no D1 change on 403'); const owner = await ctx.call('owner', full, route.method, body, { env }); assert.ok(owner.status >= 200 && owner.status < 300, `owner would succeed, got ${owner.status} ${JSON.stringify(owner.data)}`); if (route.method !== 'GET') assert.notEqual(snapshot(ctx.db), before, 'the same request does change D1 for an owner'); return; }
      assert.ok(![401, 403].includes(manager), `manager allowed, got ${manager}`);
      for (const who of ['owner', 'access']) { const status = (await ctx.call(who, full, route.method, body, { env })).status; assert.ok(![401, 403, 405].includes(status), `${who} got ${status}`); }
    });
  }
});

test('cross-origin and missing-Origin mutations are 403 before authentication, even for anonymous callers', async t => {
  const ctx = await setup(t), before = snapshot(ctx.db);
  for (const who of ['anon', 'owner', 'manager', 'access']) for (const origin of ['https://evil.test', null]) {
    assert.equal((await ctx.call(who, '/api/admin/products/bulk', 'POST', { action: 'delete', ids: [ctx.product.id], confirm: true }, { origin })).status, 403, `${who} ${origin}`);
    assert.equal((await ctx.call(who, '/api/admin/nope', 'POST', {}, { origin })).status, 403);
  }
  assert.equal(snapshot(ctx.db), before);
  assert.equal((await ctx.call('anon', '/api/admin/products', 'GET', undefined, { origin: 'https://evil.test' })).status, 401);
});

test('bulk: manager follows publish/trash permissions per action (D5b); unknown action 400; D5 boundary is a reviewed literal', async t => {
  const ctx = await setup(t);
  const { product } = ctx, patched = await ctx.call('owner', `/api/admin/products/${product.id}`, 'PATCH', { categoryId: 'jackets' });
  assert.equal(patched.status, 200);
  assert.equal((await ctx.call('manager', '/api/admin/products/bulk', 'POST', { action: 'publish', ids: [product.id] })).status, 200);
  assert.equal((await ctx.call('manager', '/api/admin/products/bulk', 'POST', { action: 'unpublish', ids: [product.id] })).status, 200);
  assert.equal((await ctx.call('manager', '/api/admin/products/bulk', 'POST', { action: 'delete', ids: [product.id], confirm: true })).status, 200);
  assert.equal((await ctx.call('manager', '/api/admin/products/bulk', 'POST', { action: 'restore', ids: [product.id] })).status, 200);
  assert.equal((await ctx.call('manager', '/api/admin/products/bulk', 'POST', { action: 'explode', ids: [product.id] })).status, 400);
  assert.equal((await ctx.call('owner', '/api/admin/products/bulk', 'POST', { action: 'explode', ids: [product.id] })).status, 400);
  // The D5 manager boundary is a reviewed literal: moving it is a one-line matrix change plus this assertion.
  assert.deepEqual([...ROLE_PERMISSIONS.manager], ['catalog.read', 'products.edit', 'products.price', 'products.publish', 'products.trash', 'media.upload', 'media.read', 'taxonomy.edit', 'recognition.draft', 'recognition.apply', 'suppliers.sync', 'suppliers.manual', 'products.create', 'orders.read', 'orders.operate']);
  assert.ok(Object.isFrozen(ROLE_PERMISSIONS) && Object.isFrozen(ROLE_PERMISSIONS.manager));
});

test('product PATCH: manager may publish and set markup (D5c, audited); owner-only fields stay checked by permission', async t => {
  const ctx = await setup(t), url = `/api/admin/products/${ctx.product.id}`;
  const res = await ctx.call('manager', url, 'PATCH', { markupType: 'percent', markupValue: 25, published: true, categoryId: 'jackets' });
  assert.equal(res.status, 200, JSON.stringify(res.data));
  assert.equal(res.data.priceMinor, 12501);
  const row = ctx.db.sqlite.prepare("SELECT * FROM audit_events WHERE action='product.update' ORDER BY rowid DESC").get();
  assert.deepEqual([row.actor, row.actor_type, row.actor_role], ['dev@localhost', 'dev', 'manager']);
});

test('taxonomy: manager edits categories but delete is owner-only at preview and at apply; tokens are actor-bound', async t => {
  const ctx = await setup(t);
  const create = await ctx.call('manager', '/api/admin/taxonomy/preview', 'POST', { operation: { type: 'create', id: 'mgr-cat', label: 'Mgr', parentId: null } });
  assert.equal(create.status, 200, JSON.stringify(create.data));
  assert.equal((await ctx.call('manager', '/api/admin/taxonomy/apply', 'POST', { token: create.data.token, confirm: true })).status, 200);
  const before = snapshot(ctx.db);
  assert.equal((await ctx.call('manager', '/api/admin/taxonomy/preview', 'POST', { operation: { type: 'delete', id: 'mgr-cat', replacementId: 'unclassified' } })).status, 403);
  assert.equal(snapshot(ctx.db), before);
  // An owner's delete preview cannot be applied by a different actor (409) or by a manager holding a token of its own (403).
  const ownerPreview = await ctx.call('access', '/api/admin/taxonomy/preview', 'POST', { operation: { type: 'delete', id: 'mgr-cat', replacementId: 'unclassified' } });
  assert.equal(ownerPreview.status, 200, JSON.stringify(ownerPreview.data));
  assert.equal((await ctx.call('manager', '/api/admin/taxonomy/apply', 'POST', { token: ownerPreview.data.token, confirm: true })).status, 409);
  const state = ctx.db.sqlite.prepare('SELECT * FROM taxonomy_previews WHERE token=?').get(ownerPreview.data.token);
  ctx.db.sqlite.prepare('UPDATE taxonomy_previews SET actor=? WHERE token=?').run('dev@localhost', state.token);
  const frozen = snapshot(ctx.db);
  assert.equal((await ctx.call('manager', '/api/admin/taxonomy/apply', 'POST', { token: state.token, confirm: true })).status, 403);
  assert.equal(snapshot(ctx.db), frozen);
  assert.equal((await ctx.call('owner', '/api/admin/taxonomy/apply', 'POST', { token: state.token, confirm: true })).status, 200);
});

test('recognition: manager reads, drafts, previews and applies to selected products but cannot activate', async t => {
  const ctx = await setup(t);
  const view = (await ctx.call('manager', '/api/admin/recognition')).data, settings = structuredClone(view.defaults);
  const draft = await ctx.call('manager', '/api/admin/recognition/drafts', 'POST', { settings });
  assert.equal(draft.status, 200, JSON.stringify(draft.data));
  const preview = await ctx.call('manager', '/api/admin/recognition/preview', 'POST', { versionId: draft.data.id });
  assert.equal(preview.status, 200);
  const before = snapshot(ctx.db);
  assert.equal((await ctx.call('manager', '/api/admin/recognition/activate', 'POST', { versionId: draft.data.id, token: preview.data.token, confirm: true })).status, 403);
  assert.equal(snapshot(ctx.db), before);
  const selected = await ctx.call('manager', '/api/admin/recognition/preview', 'POST', { versionId: draft.data.id, ids: [ctx.product.id] });
  assert.equal((await ctx.call('manager', '/api/admin/recognition/apply', 'POST', { versionId: draft.data.id, ids: [ctx.product.id], token: selected.data.token, confirm: true })).status, 200);
  const allPreview = await ctx.call('owner', '/api/admin/recognition/preview', 'POST', { versionId: draft.data.id });
  assert.equal((await ctx.call('owner', '/api/admin/recognition/activate', 'POST', { versionId: draft.data.id, token: allPreview.data.token, confirm: true })).status, 200);
});

test('supplier projection: managers never see connectionId; owners do; sync and import stay available to managers', async t => {
  const ctx = await setup(t);
  const ownerItems = (await ctx.call('owner', '/api/admin/suppliers')).data.items, managerItems = (await ctx.call('manager', '/api/admin/suppliers')).data.items;
  assert.equal(ownerItems[0].connectionId, '12345');
  assert.equal('connectionId' in managerItems[0], false);
  assert.ok(!JSON.stringify((await ctx.call('manager', '/api/admin/suppliers?deleted=1')).data).includes('12345'));
  assert.equal((await ctx.call('manager', `/api/admin/suppliers/${ctx.supplier.id}/import`, 'POST', { items: [{ ...source, externalId: 'x-2' }] })).status, 200);
  assert.notEqual((await ctx.call('manager', `/api/admin/suppliers/${ctx.supplier.id}/sync`, 'POST', {})).status, 403);
});

test('escalation attempts: role cannot be forged by headers, query, body, env value, host, environment or cookies', async t => {
  const ctx = await setup(t), url = `/api/admin/suppliers/${ctx.supplier.id}`;
  const before = snapshot(ctx.db);
  for (const headers of [{ 'X-Staff-Role': 'owner' }, { 'X-Role': 'owner' }, { Cookie: '__Host-ls_staff=owner; __Host-ls_session=owner' }, { 'CF-Access-Jwt-Assertion': 'forged.owner.token' }])
    assert.equal((await ctx.call('manager', url, 'PATCH', { name: 'Hacked', role: 'owner' }, { headers })).status, 403);
  assert.equal((await ctx.call('manager', url + '?role=owner', 'PATCH', { name: 'Hacked', role: 'owner', actor: 'x' })).status, 403);
  assert.equal((await ctx.call('manager', '/api/admin/recognition/activate?role=owner', 'POST', { role: 'owner' })).status, 403);
  assert.equal(snapshot(ctx.db), before);
  // The bypass is off for any value but owner/manager, outside development, and off loopback.
  for (const role of ['admin', 'Owner', 'OWNER', ' manager', 'root', 'staff']) assert.equal((await ctx.call('manager', '/api/admin/products', 'GET', undefined, { env: { DEV_STAFF_ROLE: role } })).status, 401, role);
  assert.equal((await ctx.call('owner', '/api/admin/products', 'GET', undefined, { env: { DEV_STAFF_ROLE: undefined } })).status, 200, 'default role is owner');
  for (const appEnv of ['production', 'staging', undefined, 'Development', 'dev']) assert.equal((await ctx.call('owner', '/api/admin/products', 'GET', undefined, { env: { APP_ENV: appEnv } })).status, 401, String(appEnv));
  for (const host of ['catalog.example.com', 'localhost.evil.test', '127.0.0.1.evil.test']) assert.equal((await ctx.call('owner', '/api/admin/products', 'GET', undefined, { host })).status, 401, host);
  assert.equal((await ctx.call('owner', '/api/admin/products', 'GET', undefined, { host: '127.0.0.1' })).status, 200);
  assert.equal((await ctx.call('owner', '/api/admin/products', 'GET', undefined, { env: { AUTH_DEV_BYPASS: 'false' } })).status, 401);
  const session = (await ctx.call('manager', '/api/auth/session')).data;
  assert.equal(session.role, 'manager'); assert.ok(!session.permissions.includes('taxonomy.delete') && session.permissions.includes('products.edit'));
  const access = (await ctx.call('access', '/api/auth/session')).data;
  assert.equal(access.role, 'owner'); assert.ok(access.permissions.includes('staff.manage'));
  assert.equal((await ctx.call('anon', '/api/auth/session')).data.role, undefined);
  // A manager never reaches owner-only private media/pages by role forging; Access stays owner even with DEV_STAFF_ROLE set.
  assert.equal((await ctx.call('access', '/api/admin/suppliers', 'POST', { name: 'N', url: 'https://mydrop.com.ua/n2' }, { env: { DEV_STAFF_ROLE: 'manager' } })).status, 201);
});

test('audit rows carry actor, actor_type and actor_role; legacy rows remain readable', async t => {
  const ctx = await setup(t);
  ctx.db.sqlite.prepare("INSERT INTO audit_events(id,actor,action,resource_id,created_at) VALUES('old','legacy@example.com','product.update','p','2020-01-01T00:00:00Z')").run();
  await ctx.call('access', `/api/admin/products/${ctx.product.id}`, 'PATCH', { title: 'By access' });
  await ctx.call('manager', `/api/admin/products/${ctx.product.id}`, 'PATCH', { title: 'By manager' });
  const rows = ctx.db.sqlite.prepare('SELECT actor,actor_type,actor_role,action FROM audit_events ORDER BY rowid').all();
  assert.deepEqual({ ...rows.find(r => r.actor === 'legacy@example.com') }, { actor: 'legacy@example.com', actor_type: null, actor_role: null, action: 'product.update' });
  assert.ok(rows.filter(r => r.actor !== 'legacy@example.com').every(r => r.actor_type && r.actor_role), JSON.stringify(rows));
  assert.deepEqual(rows.filter(r => r.action === 'product.update').slice(-2).map(r => [r.actor, r.actor_type, r.actor_role]), [['owner@example.com', 'access', 'owner'], ['dev@localhost', 'dev', 'manager']]);
  assert.ok(rows.some(r => r.actor_type === 'dev' && r.actor_role === 'owner' && r.action === 'supplier.create'));
  await ctx.call('manager', '/api/admin/taxonomy/preview', 'POST', { operation: { type: 'create', id: 'c1', label: 'C1', parentId: null } }).then(async p => ctx.call('manager', '/api/admin/taxonomy/apply', 'POST', { token: p.data.token, confirm: true }));
  const taxonomy = ctx.db.sqlite.prepare("SELECT actor_type,actor_role FROM audit_events WHERE action='taxonomy.create'").get();
  assert.deepEqual({ ...taxonomy }, { actor_type: 'dev', actor_role: 'manager' });
  assert.equal(ctx.db.sqlite.prepare('SELECT COUNT(*) AS n FROM audit_events WHERE actor_type IS NULL').get().n, 1);
});

test('D12: principals without audit.read see Access actors as display labels in recognition; owners see raw actors', async t => {
  const ctx = await setup(t);
  const settings = structuredClone((await ctx.call('access', '/api/admin/recognition')).data.defaults);
  const saved = await ctx.call('access', '/api/admin/recognition/drafts', 'POST', { settings });
  assert.equal(saved.data.actor, 'owner@example.com');
  const managerDraft = await ctx.call('manager', '/api/admin/recognition/drafts', 'POST', { settings });
  assert.equal(managerDraft.data.actor, 'dev@localhost', 'the caller sees its own actor unlabelled');
  const ownerView = (await ctx.call('access', '/api/admin/recognition')).data, managerView = (await ctx.call('manager', '/api/admin/recognition')).data;
  assert.ok(ownerView.versions.some(v => v.actor === 'owner@example.com'));
  assert.ok(!JSON.stringify(managerView).includes('owner@example.com'), 'no Access email leaks to managers');
  assert.ok(managerView.versions.some(v => v.actor === 'Власник (Access)'));
  assert.equal(ctx.db.sqlite.prepare('SELECT actor FROM recognition_versions WHERE id=?').get(saved.data.id).actor, 'owner@example.com', 'storage keeps raw actors');
  const pv = await ctx.call('access', '/api/admin/recognition/preview', 'POST', { versionId: saved.data.id, ids: [ctx.product.id] });
  await ctx.call('access', '/api/admin/recognition/apply', 'POST', { versionId: saved.data.id, ids: [ctx.product.id], token: pv.data.token, confirm: true });
  const applications = (await ctx.call('manager', '/api/admin/recognition')).data.applications;
  assert.ok(applications.length && applications.every(a => a.actor === 'Власник (Access)'));
  assert.ok((await ctx.call('access', '/api/admin/recognition')).data.applications.every(a => a.actor === 'owner@example.com'));
  assert.equal(actorLabel({ role: 'owner' }, 'x@y.z'), 'x@y.z');
  assert.equal(actorLabel({ role: 'manager', actor: 'm@y.z' }, 'x@y.z'), 'Власник (Access)');
  assert.equal(actorLabel({ role: 'manager', actor: 'm@y.z' }, 'm@y.z'), 'm@y.z');
  assert.equal(actorLabel({ role: 'manager' }, 'system'), 'system');
  assert.equal(actorLabel({ role: 'manager' }, 'staff:abc'), 'staff:abc');
});

test('migration 0008 applies after 0001-0007 additively with the ADR constraints', () => {
  assert.deepEqual(migrations.slice(0, 8).map(n => n.slice(0, 4)), ['0001', '0002', '0003', '0004', '0005', '0006', '0007', '0008']);
  const sqlite = new DatabaseSync(':memory:');
  for (const name of migrations.slice(0, 7)) sqlite.exec(readFileSync(new URL(name, migrationDir), 'utf8'));
  sqlite.prepare("INSERT INTO audit_events(id,actor,action,resource_id,created_at) VALUES('a','x@y.z','act','r','t')").run();
  sqlite.exec(readFileSync(new URL('0008_staff.sql', migrationDir), 'utf8'));
  assert.deepEqual({ ...sqlite.prepare("SELECT actor,actor_type,actor_role,details_json FROM audit_events WHERE id='a'").get() }, { actor: 'x@y.z', actor_type: null, actor_role: null, details_json: null });
  for (const table of ['staff_members', 'staff_sessions', 'staff_auth_flows', 'staff_auth_throttle']) assert.equal(sqlite.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get().n, 0, table + ' seeds no rows');
  const ins = (type, role) => sqlite.prepare('INSERT INTO audit_events(id,actor,action,resource_id,created_at,actor_type,actor_role) VALUES(?,?,?,?,?,?,?)').run(crypto.randomUUID(), 'a', 'b', 'c', 'd', type, role);
  ins('staff', 'manager'); ins('system', null);
  assert.throws(() => ins('robot', null), /CHECK/); assert.throws(() => ins('dev', 'admin'), /CHECK/);
  const member = (status, extra = {}) => sqlite.prepare('INSERT INTO staff_members(id,role,status,invited_email,google_sub,email,display_name,created_by,created_at,updated_at,invitation_expires_at) VALUES(?,?,?,?,?,?,?,?,?,?,?)').run(...Object.values({ id: crypto.randomUUID(), role: 'manager', status, invited_email: null, google_sub: null, email: null, display_name: 'N', created_by: 'a', created_at: 't', updated_at: 't', exp: null, ...extra }));
  assert.throws(() => member('boss'), /CHECK/);
  assert.throws(() => member('invited'), /CHECK/);
  assert.throws(() => member('active'), /CHECK/);
  member('invited', { invited_email: 'a@b.c', exp: 'later' });
  assert.throws(() => member('invited', { invited_email: 'a@b.c', exp: 'later' }), /UNIQUE/);
  member('removed');
  assert.ok(sqlite.prepare("SELECT 1 FROM sqlite_master WHERE name IN ('audit_events_created','staff_members_sub','staff_sessions_staff','staff_sessions_expiry')").all().length === 4);
  sqlite.close();
});

test('body-dependent checks deny with 403 and no D1 change under a reduced manager matrix (test-only seam)', async t => {
  const ctx = await setup(t), url = `/api/admin/products/${ctx.product.id}`, full = [...ROLE_PERMISSIONS.manager];
  const without = (...drop) => ({ manager: full.filter(p => !drop.includes(p)) });
  assert.equal((await ctx.call('owner', url, 'PATCH', { categoryId: 'jackets', published: true })).status, 200);
  async function denied(path, method, body) {
    const before = snapshot(ctx.db), response = await ctx.call('manager', path, method, body);
    assert.equal(response.status, 403, `${method} ${path} ${JSON.stringify(body)}`); assert.equal(snapshot(ctx.db), before);
  }
  await withRoleMatrixForTests(without('products.price'), async () => {
    await denied(url, 'PATCH', { markupValue: 30 }); await denied(url, 'PATCH', { markupType: 'fixed' });
    assert.equal((await ctx.call('manager', url, 'PATCH', { title: 'Allowed edit' })).status, 200);
    assert.equal((await ctx.call('manager', '/api/auth/session')).data.permissions.includes('products.price'), false);
  });
  await withRoleMatrixForTests(without('products.publish'), async () => {
    await denied(url, 'PATCH', { published: false });
    await denied('/api/admin/products/bulk', 'POST', { action: 'publish', ids: [ctx.product.id] });
    await denied('/api/admin/products/bulk', 'POST', { action: 'unpublish', ids: [ctx.product.id] });
    assert.equal((await ctx.call('manager', '/api/admin/products/bulk', 'POST', { action: 'delete', ids: [ctx.product.id], confirm: true })).status, 200, 'trash is still allowed');
  });
  // The product is now in Trash: restore needs products.trash, and publish/unpublish are not the permission in play.
  await withRoleMatrixForTests(without('products.trash'), async () => {
    await denied('/api/admin/products/bulk', 'POST', { action: 'restore', ids: [ctx.product.id] });
    await denied(`/api/admin/products/${ctx.product.id}/restore`, 'POST', {});
    assert.equal((await ctx.call('owner', '/api/admin/products/bulk', 'POST', { action: 'restore', ids: [ctx.product.id] })).status, 200, 'owner matrix is unaffected');
    await denied('/api/admin/products/bulk', 'POST', { action: 'delete', ids: [ctx.product.id], confirm: true });
    await denied(url, 'DELETE', { confirm: true });
    assert.equal((await ctx.call('manager', '/api/admin/products/bulk', 'POST', { action: 'publish', ids: [ctx.product.id] })).status, 200, 'publish is still allowed');
  });
  await withRoleMatrixForTests({ manager: ['catalog.read'] }, async () => { await denied(url, 'PATCH', { title: 'x' }); });
  // The override is scoped: the full matrix is back afterwards, and nothing in env or requests can reach it.
  assert.equal((await ctx.call('manager', url, 'PATCH', { markupValue: 31 })).status, 200);
  assert.equal((await ctx.call('manager', url, 'PATCH', { markupValue: 31 }, { env: { ROLE_MATRIX: '{"manager":[]}' }, headers: { 'X-Role-Matrix': '[]' } })).status, 200);
});
