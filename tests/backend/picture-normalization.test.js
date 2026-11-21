import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { readFileSync, readdirSync } from 'node:fs';
import { createHash, randomBytes } from 'node:crypto';
import { crc32 } from 'node:zlib';
import worker from '../../apps/api/src/index.js';
import { ADMIN_ROUTES } from '../../apps/api/src/permissions.js';
import { fitPicture } from '../../packages/catalog/picture-fit.js';
import { PICTURE_TEMPLATES } from '../../packages/catalog/picture-templates.js';

// T4: POST /api/admin/products/:id/normalized and the lineage-aware source rule.
// Fully synthetic: in-memory D1, fake R2, generated PNGs, no network and no real inventory.
const ORIGIN = 'https://catalog.test';
const TEMPLATE = PICTURE_TEMPLATES.default;
const source = (externalId, photos = ['https://example.com/photo.jpg']) => ({ externalId, title: 'Test Coat ' + externalId, description: 'd', category: 'Coats', costMinor: 10001, currency: 'UAH', photos, variants: [{ id: 's', size: 'S', stock: 4 }] });

// ---- PNG fixtures: signature, a correct IHDR (with CRC) and IEND. The server only inspects the header.
function chunk(type, data) {
  const out = Buffer.alloc(12 + data.length), body = Buffer.concat([Buffer.from(type), data]);
  out.writeUInt32BE(data.length, 0); body.copy(out, 4); out.writeUInt32BE(crc32(body), 8 + data.length); return out;
}
function png(width, height, pad = 0) {
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(width, 0); ihdr.writeUInt32BE(height, 4); ihdr[8] = 8; ihdr[9] = 6;
  return new Uint8Array(Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr), chunk('IEND', Buffer.alloc(0)), Buffer.alloc(pad)]));
}
const hex = bytes => createHash('sha256').update(bytes).digest('hex');
const uuid = () => crypto.randomUUID();

// A real recipe from the pure fit module so validateFitRecipe accepts it.
function recipeFor(template = TEMPLATE) {
  const width = 400, height = 300, data = new Uint8Array(width * height);
  for (let y = 50; y < 250; y++) for (let x = 50; x < 350; x++) data[y * width + x] = 255;
  return fitPicture({ width, height, data, channels: 1 }, template);
}

// ---- D1 + R2 fakes
function database() {
  const sqlite = new DatabaseSync(':memory:');
  for (const name of readdirSync(new URL('../../migrations/', import.meta.url)).filter(n => /^\d{4}_.*\.sql$/.test(n)).sort()) sqlite.exec(readFileSync(new URL('../../migrations/' + name, import.meta.url), 'utf8'));
  const wrap = (sql, bindings = []) => ({ sql, bindings, bind(...v) { return wrap(sql, v); }, async first() { return sqlite.prepare(sql).get(...bindings) ?? null; }, async all() { return { results: sqlite.prepare(sql).all(...bindings) }; }, async run() { return sqlite.prepare(sql).run(...bindings); } });
  return { sqlite, prepare: sql => wrap(sql), async batch(s) { sqlite.exec('BEGIN'); try { const r = s.map(x => sqlite.prepare(x.sql).run(...x.bindings)); sqlite.exec('COMMIT'); return r; } catch (e) { sqlite.exec('ROLLBACK'); throw e; } }, close: () => sqlite.close() };
}
function fakeR2() {
  const objects = new Map(), r2 = { objects, puts: 0,
    async put(key, bytes, meta = {}) { r2.puts++; objects.set(key, { bytes: new Uint8Array(bytes), ...meta }); },
    async get(key) { const v = objects.get(key); return v ? { ...v, body: v.bytes } : null; },
    async head(key) { return objects.get(key) ?? null; } };
  return r2;
}

let keys;
async function accessToken() {
  keys ??= await crypto.subtle.generateKey({ name: 'RSASSA-PKCS1-v1_5', modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: 'SHA-256' }, true, ['sign', 'verify']);
  const enc = v => Buffer.from(JSON.stringify(v)).toString('base64url');
  const unsigned = enc({ alg: 'RS256', kid: 'k' }) + '.' + enc({ iss: 'https://your-team.cloudflareaccess.com', aud: ['catalog-audience'], email: 'manager@example.com', exp: Math.floor(Date.now() / 1000) + 3600 });
  return unsigned + '.' + Buffer.from(await crypto.subtle.sign('RSASSA-PKCS1-v1_5', keys.privateKey, new TextEncoder().encode(unsigned))).toString('base64url');
}

async function setup(t, { media = true } = {}) {
  await accessToken();
  const jwk = await crypto.subtle.exportKey('jwk', keys.publicKey); jwk.kid = 'k'; jwk.alg = 'RS256';
  const db = database(), r2 = fakeR2();
  const env = { DB: db, CF_ACCESS_TEAM_NAME: 'your-team', CF_ACCESS_AUD: 'catalog-audience', APP_ENV: 'production', ...(media ? { MEDIA: r2 } : {}) };
  const original = globalThis.fetch;
  globalThis.fetch = async (url, options) => { if (String(url).includes('/cdn-cgi/access/certs')) return new Response(JSON.stringify({ keys: [jwk] }), { headers: { 'Content-Type': 'application/json' } }); throw new Error('unexpected network call ' + url); };
  t.after(() => { globalThis.fetch = original; db.close(); });
  const token = await accessToken();
  const admin = (path, method = 'GET', body, { origin = ORIGIN, auth = true, headers = {} } = {}) => worker.fetch(new Request(ORIGIN + path, {
    method, headers: { ...(origin ? { Origin: origin } : {}), ...(auth ? { Cookie: 'CF_Authorization=' + token } : {}), ...(body && !(body instanceof FormData) ? { 'Content-Type': 'application/json' } : {}), ...headers },
    body: body === undefined ? undefined : body instanceof FormData ? body : JSON.stringify(body) }), env);
  const json = async (...a) => (await admin(...a)).json();
  const supplier = await json('/api/admin/suppliers', 'POST', { name: 'Demo', url: 'https://mydrop.com.ua/demo_shop' });
  const products = [];
  for (const id of ['supplier-1', 'supplier-2']) {
    assert.equal((await admin(`/api/admin/suppliers/${supplier.id}/import`, 'POST', { items: [source(id)] })).status, 200);
  }
  for (const item of (await json('/api/admin/products')).items) products.push(item);
  products.sort((x, y) => x.title.localeCompare(y.title));
  const [product, other] = products;

  // Seed one product's lineage directly in R2 (cutout + archived original) and put the cutout in its saved photos.
  const seedCutout = async (p, { size = [400, 300], originalUrl, productId = p.id, extra = {} } = {}) => {
    const originalKey = uuid() + '.jpg', key = uuid() + '.png';
    r2.objects.set(originalKey, { bytes: new Uint8Array([255, 216, 255, 1]), httpMetadata: { contentType: 'image/jpeg' } });
    const bytes = png(...size);
    r2.objects.set(key, { bytes, httpMetadata: { contentType: 'image/png' }, customMetadata: { productId, originalUrl: originalUrl ?? `/media/${originalKey}`, sourceUrl: 'https://example.com/photo.jpg', ...extra } });
    return { url: `/media/${key}`, key, bytes, originalUrl: originalUrl ?? `/media/${originalKey}` };
  };
  const setPhotos = async (p, photos) => assert.equal((await admin(`/api/admin/products/${p.id}`, 'PATCH', { photos })).status, 200);
  const form = ({ sourceUrl, sourceHash, recipe = recipeFor(), file = png(1200, 1600), omit = [] } = {}) => {
    const f = new FormData();
    if (!omit.includes('sourceUrl')) f.append('sourceUrl', sourceUrl);
    if (!omit.includes('sourceHash')) f.append('sourceHash', sourceHash);
    if (!omit.includes('recipe')) f.append('recipe', typeof recipe === 'string' ? recipe : JSON.stringify(recipe));
    if (!omit.includes('file')) f.append('file', new Blob([file], { type: 'image/png' }), 'normalized.png');
    return f;
  };
  const normalize = (p, cutout, over = {}, opts) => admin(`/api/admin/products/${p.id}/normalized`, 'POST',
    form({ sourceUrl: cutout.url, sourceHash: hex(cutout.bytes), ...over }), opts);
  const row = p => db.sqlite.prepare('SELECT * FROM products WHERE id=?').get(p.id);
  return { env, db, r2, admin, json, product, other, seedCutout, setPhotos, form, normalize, row, token };
}
const audits = (a, action) => a.db.sqlite.prepare('SELECT * FROM audit_events WHERE action=?').all(action);

test('route row, permission and Origin/authentication gates run before any storage work', async t => {
  const ids = ADMIN_ROUTES.map(r => r.id), at = ids.indexOf('products.cutout');
  assert.equal(ids[at + 1], 'products.normalized');
  assert.deepEqual(ADMIN_ROUTES[at + 1], { id: 'products.normalized', method: 'POST', pattern: '/products/:id/normalized', permission: 'media.upload' });
  const a = await setup(t), cutout = await a.seedCutout(a.product); await a.setPhotos(a.product, [cutout.url]);
  assert.equal((await a.normalize(a.product, cutout, {}, { auth: false })).status, 401);
  assert.equal((await a.normalize(a.product, cutout, {}, { origin: 'https://evil.test' })).status, 403);
  assert.equal((await a.normalize(a.product, cutout, {}, { origin: null })).status, 403);
  assert.equal(a.r2.puts, 0);
  const gone = await setup(t, { media: false });
  const response = await gone.admin(`/api/admin/products/${gone.product.id}/normalized`, 'POST', gone.form({ sourceUrl: '/media/' + uuid() + '.png', sourceHash: 'x' }));
  assert.equal(response.status, 503); assert.equal((await response.json()).code, 'storage-unavailable');
});

test('staff session mount: a staff manager may normalize; no session is 401', async t => {
  const a = await setup(t), cutout = await a.seedCutout(a.product); await a.setPhotos(a.product, [cutout.url]);
  const sqlite = a.db.sqlite, now = new Date().toISOString(), later = new Date(Date.now() + 3600000).toISOString();
  sqlite.prepare('INSERT INTO staff_members(id,role,status,invited_email,google_sub,email,display_name,created_by,created_at,updated_at,invitation_expires_at) VALUES(?,?,?,?,?,?,?,?,?,?,?)').run('staff-1', 'manager', 'active', null, 'sub-1', 'm@example.com', 'M', 'owner@example.com', now, now, null);
  const sessionToken = randomBytes(32).toString('base64url');
  sqlite.prepare('INSERT INTO staff_sessions VALUES(?,?,?,?,?,?,?)').run(createHash('sha256').update(sessionToken).digest('hex'), 'staff-1', now, now, now, later, later);
  const go = (cookie, headers = {}) => worker.fetch(new Request(`${ORIGIN}/api/staff/admin/products/${a.product.id}/normalized`, { method: 'POST', headers: { Origin: ORIGIN, ...(cookie ? { Cookie: cookie } : {}), ...headers }, body: a.form({ sourceUrl: cutout.url, sourceHash: hex(cutout.bytes) }) }), a.env);
  assert.equal((await go('')).status, 401);
  assert.equal((await go('CF_Authorization=' + a.token)).status, 401, 'Access is not a credential on the staff mount');
  const ok = await go('__Host-ls_staff=' + sessionToken);
  assert.equal(ok.status, 201, JSON.stringify(await ok.clone().json()));
  const event = audits(a, 'media.normalize')[0];
  assert.equal(event.actor, 'staff:staff-1'); assert.equal(event.actor_role, 'manager');
});

test('success: one new R2 object with lineage metadata, audit, 201 shape, product row unchanged', async t => {
  const a = await setup(t), cutout = await a.seedCutout(a.product); await a.setPhotos(a.product, [cutout.url]);
  const before = a.row(a.product), recipe = recipeFor(), objectsBefore = a.r2.objects.size;
  const response = await a.normalize(a.product, cutout, { recipe: JSON.stringify(recipe, null, 0) });
  assert.equal(response.status, 201);
  const saved = await response.json();
  assert.deepEqual(Object.keys(saved).sort(), ['cutoutUrl', 'originalUrl', 'url']);
  assert.equal(saved.cutoutUrl, cutout.url); assert.equal(saved.originalUrl, cutout.originalUrl);
  assert.match(saved.url, /^\/media\/[a-f0-9-]+\.png$/); assert.notEqual(saved.url, cutout.url);
  assert.equal(a.r2.puts, 1); assert.equal(a.r2.objects.size, objectsBefore + 1);
  const object = a.r2.objects.get(saved.url.slice(7)), meta = object.customMetadata;
  assert.equal(object.httpMetadata.contentType, 'image/png');
  assert.deepEqual(Object.keys(meta).sort(), ['cutoutUrl', 'fitVersion', 'originalUrl', 'productId', 'recipe', 'templateId', 'templateRevision']);
  assert.deepEqual({ ...meta, recipe: undefined }, { productId: a.product.id, originalUrl: cutout.originalUrl, cutoutUrl: cutout.url, templateId: TEMPLATE.id, templateRevision: String(TEMPLATE.revision), fitVersion: '1', recipe: undefined });
  assert.equal(meta.recipe, JSON.stringify(JSON.parse(meta.recipe)), 'compact canonical JSON');
  assert.deepEqual(JSON.parse(meta.recipe), recipe);
  assert.deepEqual(object.bytes, png(1200, 1600));
  assert.deepEqual(a.row(a.product), before, 'product row untouched');
  const [event] = audits(a, 'media.normalize'); assert.equal(audits(a, 'media.normalize').length, 1);
  assert.equal(event.resource_id, a.product.id);
  assert.deepEqual(JSON.parse(event.details_json), { url: saved.url, cutoutUrl: cutout.url, templateId: TEMPLATE.id, templateRevision: TEMPLATE.revision, flags: recipe.quality.flags });
});

test('the stored recipe is the canonical copy, not the request input', async t => {
  const a = await setup(t), cutout = await a.seedCutout(a.product); await a.setPhotos(a.product, [cutout.url]);
  const recipe = recipeFor(); recipe.transform.scale = recipe.transform.scale + 0.00001; // rounds back to 4 decimals
  const loose = JSON.stringify(recipe).replace('"scale":', '"scale": ');
  const response = await a.normalize(a.product, cutout, { recipe: loose });
  assert.equal(response.status, 201, JSON.stringify(await response.clone().json()));
  const saved = await response.json(), stored = a.r2.objects.get(saved.url.slice(7)).customMetadata.recipe;
  assert.ok(!stored.includes(': '));
  assert.equal(JSON.parse(stored).transform.scale, Math.round(recipe.transform.scale * 1e4) / 1e4);
});

test('every rejection happens before any R2 write', async t => {
  const a = await setup(t), cutout = await a.seedCutout(a.product), foreign = await a.seedCutout(a.other);
  const normalizedObject = uuid() + '.png';
  a.r2.objects.set(normalizedObject, { bytes: png(1200, 1600), customMetadata: { productId: a.product.id, originalUrl: cutout.originalUrl, cutoutUrl: cutout.url, templateId: TEMPLATE.id } });
  const hugeOriginal = await a.seedCutout(a.product, { originalUrl: '/media/' + 'a'.repeat(1700) + '.jpg' });
  const bare = await a.seedCutout(a.product); delete a.r2.objects.get(bare.key).customMetadata.sourceUrl;
  const rowless = await a.seedCutout(a.product, { productId: a.other.id });
  const ok = recipeFor();
  await a.setPhotos(a.product, [cutout.url, `/media/${normalizedObject}`, foreign.url, hugeOriginal.url, bare.url, rowless.url]);
  const cases = [
    ['source not in product photos', { sourceUrl: 'https://example.com/other.jpg' }, 400, 'source-not-allowed'],
    ['missing sourceUrl', { omit: ['sourceUrl'] }, 400, 'source-not-allowed'],
    ['source is another product\'s cutout', { sourceUrl: foreign.url, sourceHash: hex(foreign.bytes) }, 400, 'source-not-cutout'],
    ['source metadata names another product', { sourceUrl: rowless.url, sourceHash: hex(rowless.bytes) }, 400, 'source-not-cutout'],
    ['source without sourceUrl metadata', { sourceUrl: bare.url, sourceHash: hex(bare.bytes) }, 400, 'source-not-cutout'],
    ['normalized image as source', { sourceUrl: `/media/${normalizedObject}`, sourceHash: hex(png(1200, 1600)) }, 400, 'source-not-cutout'],
    ['supplier URL as source', { sourceUrl: 'https://example.com/photo.jpg' }, 400, 'source-not-cutout'],
    ['sourceHash mismatch', { sourceHash: '0'.repeat(64) }, 409, 'source-changed'],
    ['sourceHash missing', { omit: ['sourceHash'] }, 409, 'source-changed'],
    ['file missing', { omit: ['file'] }, 400, 'invalid-png'],
    ['non-PNG file', { file: new Uint8Array([255, 216, 255, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0]) }, 415, 'not-png'],
    ['file over 20 MB', { file: png(1200, 1600, 20_000_001) }, 413, 'too-large'],
    ['IHDR width differs from canvas', { file: png(1199, 1600) }, 400, 'canvas-mismatch'],
    ['IHDR height differs from canvas', { file: png(1200, 1599) }, 400, 'canvas-mismatch'],
    ['truncated PNG', { file: png(1200, 1600).slice(0, 20) }, 400, 'invalid-png'],
    ['recipe not JSON', { recipe: '{nope' }, 400, 'invalid-recipe'],
    ['recipe not an object', { recipe: '[]' }, 400, 'invalid-recipe'],
    ['recipe missing', { omit: ['recipe'] }, 400, 'invalid-recipe'],
    ['recipe over 1024 bytes', { recipe: JSON.stringify({ ...ok, pad: 'x'.repeat(1100) }) }, 400, 'invalid-recipe'],
    ['unknown template', { recipe: { ...ok, templateId: 'nope' } }, 400, 'unknown-template'],
    ['prototype template name', { recipe: { ...ok, templateId: 'constructor' } }, 400, 'unknown-template'],
    ['stale template revision', { recipe: { ...ok, templateRevision: TEMPLATE.revision + 1 } }, 409, 'template-updated'],
    ['older template revision', { recipe: { ...ok, templateRevision: 0 } }, 409, 'template-updated'],
    ['canvas differs from template', { recipe: { ...ok, canvas: { width: 600, height: 800 } }, file: png(600, 800) }, 400, 'canvas-mismatch'],
    ['extra recipe key', { recipe: { ...ok, extra: 1 } }, 400, 'invalid-recipe'],
    ['implausible scale', { recipe: { ...ok, transform: { ...ok.transform, scale: 99 } } }, 400, 'invalid-recipe'],
    ['unknown quality flag', { recipe: { ...ok, quality: { ...ok.quality, flags: ['bogus'] } } }, 400, 'invalid-recipe'],
    ['metadata over 1800 bytes', { sourceUrl: hugeOriginal.url, sourceHash: hex(hugeOriginal.bytes) }, 400, 'metadata-too-large']
  ];
  for (const [name, over, status, code] of cases) {
    const response = await a.normalize(a.product, cutout, over);
    assert.equal(response.status, status, `${name}: ${JSON.stringify(await response.clone().json())}`);
    const body = await response.json(); assert.equal(typeof body.error, 'string', name); assert.equal(body.code, code, name);
    assert.equal(a.r2.puts, 0, `${name}: wrote to R2`);
  }
  assert.equal(audits(a, 'media.normalize').length, 0);
  const stale = await (await a.normalize(a.product, cutout, { recipe: { ...ok, templateRevision: TEMPLATE.revision + 1 } })).json();
  assert.match(stale.error, /template updated|updated/i);
  // A non-multipart body is rejected too.
  const raw = await a.admin(`/api/admin/products/${a.product.id}/normalized`, 'POST', {});
  assert.equal(raw.status, 415); assert.equal((await raw.json()).code, 'not-png'); assert.equal(a.r2.puts, 0);
  // An unknown product is 404 and nothing is written.
  assert.equal((await a.admin('/api/admin/products/missing/normalized', 'POST', a.form({ sourceUrl: cutout.url, sourceHash: hex(cutout.bytes) }))).status, 404);
  assert.equal(a.r2.puts, 0);
});

test('lineage: re-fit after the normalized photo replaced the cutout; image-originals reports lineage', async t => {
  const a = await setup(t), cutout = await a.seedCutout(a.product); await a.setPhotos(a.product, [cutout.url]);
  const first = await (await a.normalize(a.product, cutout)).json();
  // Before the swap the normalized URL is not yet in the photos; the cutout still is.
  assert.equal((await a.admin(`/api/admin/products/${a.product.id}/image?url=${encodeURIComponent(first.url)}`)).status, 400);
  await a.setPhotos(a.product, [first.url]);
  // The cutout is no longer in the photos but is the lineage of a saved normalized photo.
  const image = await a.admin(`/api/admin/products/${a.product.id}/image?url=${encodeURIComponent(cutout.url)}`);
  assert.equal(image.status, 200); assert.deepEqual(new Uint8Array(await image.arrayBuffer()), cutout.bytes);
  const second = await a.normalize(a.product, cutout, { recipe: JSON.stringify({ ...recipeFor(), manual: null }) });
  assert.equal(second.status, 201);
  const next = await second.json(); assert.equal(next.cutoutUrl, cutout.url); assert.equal(next.originalUrl, cutout.originalUrl);
  assert.equal(a.r2.puts, 2);
  // The old normalized image is not a legal source even though it is saved.
  assert.equal((await a.normalize(a.product, { url: first.url, bytes: png(1200, 1600) })).status, 400);
  assert.equal((await a.admin(`/api/admin/products/${a.product.id}/image?url=${encodeURIComponent(first.url)}`)).status, 200, 'saved photos stay readable');
  const originals = await a.json(`/api/admin/products/${a.product.id}/image-originals`);
  assert.equal(originals.storageAvailable, true);
  assert.deepEqual(originals.originals, { [first.url]: cutout.originalUrl });
  assert.deepEqual(originals.lineage, { [first.url]: { originalUrl: cutout.originalUrl, cutoutUrl: cutout.url, templateId: TEMPLATE.id, templateRevision: TEMPLATE.revision } });
  // A plain cutout photo reports lineage without cutoutUrl or template fields.
  await a.setPhotos(a.product, [cutout.url]);
  const plain = await a.json(`/api/admin/products/${a.product.id}/image-originals`);
  assert.deepEqual(plain.originals, { [cutout.url]: cutout.originalUrl });
  assert.deepEqual(plain.lineage, { [cutout.url]: { originalUrl: cutout.originalUrl } });
});

test('another product\'s cutoutUrl is rejected on both routes, and so is a lineage claim by an unsaved object', async t => {
  const a = await setup(t), mine = await a.seedCutout(a.product), theirs = await a.seedCutout(a.other);
  await a.setPhotos(a.product, [mine.url]);
  await a.setPhotos(a.other, [theirs.url]);
  const theirNormalized = await (await a.normalize(a.other, theirs)).json();
  await a.setPhotos(a.other, [theirNormalized.url]);
  assert.equal((await a.admin(`/api/admin/products/${a.other.id}/image?url=${encodeURIComponent(theirs.url)}`)).status, 200);
  const puts = a.r2.puts;
  assert.equal((await a.admin(`/api/admin/products/${a.product.id}/image?url=${encodeURIComponent(theirs.url)}`)).status, 400);
  assert.equal((await a.normalize(a.product, theirs)).status, 400);
  // This product's own photos hold the other product's normalized object: its productId differs, so its cutoutUrl is not lineage here.
  await a.setPhotos(a.product, [mine.url, theirNormalized.url]);
  assert.equal((await a.admin(`/api/admin/products/${a.product.id}/image?url=${encodeURIComponent(theirs.url)}`)).status, 400);
  assert.equal((await a.normalize(a.product, theirs)).status, 400);
  // An R2 object that is not in the photos does not confer lineage.
  const stray = await a.seedCutout(a.product, { extra: { cutoutUrl: mine.url, templateId: TEMPLATE.id } });
  assert.equal((await a.admin(`/api/admin/products/${a.product.id}/image?url=${encodeURIComponent('/media/' + uuid() + '.png')}`)).status, 400);
  assert.equal(a.r2.puts, puts);
  void stray;
});

test('privacy: private until published, public output never exposes lineage, survives supplier reimport', async t => {
  const a = await setup(t), cutout = await a.seedCutout(a.product); await a.setPhotos(a.product, [cutout.url]);
  const saved = await (await a.normalize(a.product, cutout)).json();
  const anon = path => worker.fetch(new Request(ORIGIN + path), a.env);
  assert.equal((await anon(saved.url)).status, 404);
  await a.setPhotos(a.product, [saved.url]);
  assert.equal((await anon(saved.url)).status, 404, 'saved but unpublished');
  assert.equal((await a.admin(`/api/admin/products/${a.product.id}`, 'PATCH', { published: true })).status, 200);
  const served = await anon(saved.url); assert.equal(served.status, 200); assert.equal(served.headers.get('Content-Type'), 'image/png');
  assert.equal((await anon(cutout.url)).status, 404); assert.equal((await anon(cutout.originalUrl)).status, 404);
  const slug = a.row(a.product).slug;
  const pages = [await (await anon('/api/products')).text(), await (await anon('/products/' + slug)).text(), await (await anon('/')).text(), await (await anon('/sitemap.xml')).text()];
  for (const body of pages) for (const secret of [cutout.url, cutout.originalUrl, 'cutoutUrl', 'templateId', 'templateRevision', 'fitVersion', 'recipe', '"transform"', 'placedBox']) assert.ok(!body.includes(secret), secret);
  assert.ok(pages[0].includes(saved.url));
  const supplier = a.db.sqlite.prepare('SELECT supplier_id FROM products WHERE id=?').get(a.product.id).supplier_id;
  assert.equal((await a.admin(`/api/admin/suppliers/${supplier}/import`, 'POST', { items: [{ ...source('supplier-1'), title: 'Changed', photos: ['https://example.com/new.jpg'] }] })).status, 200);
  assert.deepEqual((await a.json('/api/admin/products')).items.find(p => p.id === a.product.id).photos, [saved.url]);
  assert.equal((await anon(saved.url)).status, 200);
});

test('empty, string and absent files are 400 invalid-png; an oversized request is 413 too-large with a code; no R2 writes', async t => {
  const a = await setup(t), cutout = await a.seedCutout(a.product); await a.setPhotos(a.product, [cutout.url]);
  const send = async (form, headers) => a.admin(`/api/admin/products/${a.product.id}/normalized`, 'POST', form, { headers });
  const base = () => { const f = a.form({ sourceUrl: cutout.url, sourceHash: hex(cutout.bytes), omit: ['file'] }); return f; };
  const empty = base(); empty.append('file', new Blob([], { type: 'image/png' }), 'normalized.png');
  const string = base(); string.append('file', 'not-a-file');
  for (const [name, form] of [['empty', empty], ['string', string], ['absent', base()]]) {
    const response = await send(form);
    assert.equal(response.status, 400, name); assert.equal((await response.json()).code, 'invalid-png', name);
  }
  const big = await send(a.form({ sourceUrl: cutout.url, sourceHash: hex(cutout.bytes) }), { 'Content-Length': String(21_000_000) });
  assert.equal(big.status, 413); assert.equal((await big.json()).code, 'too-large');
  assert.equal(a.r2.puts, 0);
});

test('EasyDrop image allowlist is exact and bounded like MyDrop', async t => {
  const { supplierImageUrl, retrieveProductImage, IMAGE_LIMIT } = await import('../../apps/api/src/image-processing.js');
  const uuid = '00000000-0000-4000-8000-000000000001';
  const ok = [
    `https://easydrop.one/media/uploads/images/base/${uuid}.jpg`,
    `https://easydrop.one/media/uploads/images/itemimage/${uuid}.png`,
    'https://easydrop.one/media/uploads/images/item_740/a-b_c.1.webp',
    'https://easydrop.one/media/uploads/images/item_1/x.jpeg',
    'https://backend.mydrop.com.ua/vendor/products/uploads/a.jpg'
  ];
  for (const url of ok) assert.equal(supplierImageUrl(url), url);
  const bad = [
    `http://easydrop.one/media/uploads/images/base/${uuid}.jpg`,
    `https://easydrop.one.evil.com/media/uploads/images/base/${uuid}.jpg`,
    `https://evil.easydrop.one/media/uploads/images/base/${uuid}.jpg`,
    `https://www.easydrop.one/media/uploads/images/base/${uuid}.jpg`,
    `https://easydrop.one@evil.com/media/uploads/images/base/${uuid}.jpg`,
    `https://user:pw@easydrop.one/media/uploads/images/base/${uuid}.jpg`,
    `https://easydrop.one:8443/media/uploads/images/base/${uuid}.jpg`,
    `https://easydrop.one/media/uploads/images/base/${uuid}.jpg?x=1`,
    `https://easydrop.one/media/uploads/images/base/${uuid}.jpg#f`,
    'https://easydrop.one/media/uploads/images/other/a.jpg',
    'https://easydrop.one/media/uploads/images/item_/a.jpg',
    'https://easydrop.one/media/uploads/images/item_x1/a.jpg',
    'https://easydrop.one/media/uploads/images/base/sub/a.jpg',
    'https://easydrop.one/media/uploads/images/base/a.svg',
    'https://easydrop.one/media/uploads/images/base/a.jpg.php',
    'https://easydrop.one/media/uploads/images/base/',
    'https://easydrop.one/media/other/base/a.jpg',
    'https://easydrop.one/media/a.jpg',
    'https://easydrop.one/private/a.jpg',
    'https://easydrop.one/media/uploads/images/base/../../../private/a.jpg',
    'https://easydrop.one/media/uploads/images/base/%2e%2e/a.jpg',
    'https://easydrop.one/media/uploads/images/base/..%2fa.jpg',
    'https://easydrop.one/media/uploads/images/base%2fa.jpg',
    'https://easydrop.one/media/uploads/images/base/a%2Fb.jpg',
    'https://easydrop.one/media/uploads/images/base/a%00.jpg',
    'https://easydrop.one/media/uploads/images/base\\a.jpg',
    'https://easydrop.one/media/uploads/images/base/a b.jpg',
    'file:///media/uploads/images/base/a.jpg',
    'not a url',
    'https://easydrop.one/media/uploads/images/base/x/.\t./a.jpg',
    `https://easydrop.one/media/uploads/images/base/${uuid}.jpg?`,
    `https://easydrop.one/media/uploads/images/base/${uuid}.jpg#`,
    `https://easydrop.one:443/media/uploads/images/base/${uuid}.jpg`,
    `https://@easydrop.one/media/uploads/images/base/${uuid}.jpg`,
    `https://:@easydrop.one/media/uploads/images/base/${uuid}.jpg`,
    `https://EASYDROP.one/media/uploads/images/base/${uuid}.jpg`,
    `https://easydrop.one/media/uploads/images/base/${uuid}.jpg\n`,
    ` https://easydrop.one/media/uploads/images/base/${uuid}.jpg`,
    `https://easydrop.one/media/uploads/images/base/${uuid}.jp\tg`,
    `https://\uFF45asydrop.one/media/uploads/images/base/${uuid}.jpg`
  ];
  for (const url of bad) assert.throws(() => supplierImageUrl(url), undefined, url);

  const url = `https://easydrop.one/media/uploads/images/base/${uuid}.jpg`, row = { source_json: JSON.stringify({ photos: [url] }), overrides_json: '{}' };
  const previous = globalThis.fetch; t.after(() => { globalThis.fetch = previous; });
  globalThis.fetch = async (_u, options) => { assert.equal(options.redirect, 'manual'); assert.ok(options.signal); return new Response(null, { status: 302, headers: { Location: 'http://127.0.0.1' } }); };
  await assert.rejects(retrieveProductImage(row, url, {}), /refused/);
  globalThis.fetch = async () => new Response('<html>x</html>'); await assert.rejects(retrieveProductImage(row, url, {}), /Only JPEG/);
  globalThis.fetch = async () => new Response('x', { headers: { 'Content-Length': String(IMAGE_LIMIT + 1) } }); await assert.rejects(retrieveProductImage(row, url, {}), /20 MB/);
  // Streamed body without Content-Length is still bounded.
  globalThis.fetch = async () => new Response(new ReadableStream({ pull(c) { c.enqueue(new Uint8Array(5_000_000)); } }));
  await assert.rejects(retrieveProductImage(row, url, {}), /20 MB/);
  // A 2.6 MB original (documented size) is within the cap.
  const big = new Uint8Array(2_600_000); big.set([255, 216, 255, 224]);
  globalThis.fetch = async () => new Response(big, { headers: { 'Content-Length': String(big.length) } });
  assert.equal((await retrieveProductImage(row, url, {})).length, 2_600_000);
  assert.ok(2_600_000 < IMAGE_LIMIT);
  await assert.rejects(retrieveProductImage(row, 'https://easydrop.one/media/uploads/images/base/other.jpg', {}), /does not belong/);
});
