import test from 'node:test';
import assert from 'node:assert/strict';
import worker from '../../apps/api/src/index.js';
import { defaultRecognitionSettings, CATEGORY_TREE, createTaxonomyContext } from '../../packages/catalog/taxonomy.js';

const PAGE = '<!doctype html><html><head><title>App</title></head><body></body></html>';
function db() {
  const stmt = sql => ({ bind() { return stmt(sql); }, async first(){return sql.includes('recognition_state')?{active_version:'seed-v1',catalog_revision:0,settings_json:JSON.stringify(defaultRecognitionSettings()),taxonomy_revision:1,nodes_json:JSON.stringify(createTaxonomyContext(CATEGORY_TREE).nodes),redirects_json:'{}'}:sql.includes('recognition_versions')?{settings_json:JSON.stringify(defaultRecognitionSettings())}:null;}, async all() { return { results: [] }; } });
  return { prepare: stmt };
}
const assetCalls = [];
const base = extra => ({ DB: db(), ASSETS: { fetch: async request => { assetCalls.push(new URL(request.url).pathname); return new Response(PAGE, { headers: { 'Content-Type': 'text/html' } }); } }, CF_ACCESS_TEAM_NAME: 't', CF_ACCESS_AUD: 'a', ...extra });
const staging = extra => base({ APP_ENV: 'staging', ...extra });
const call = (path, e, host = 'staging.example.com', init) => worker.fetch(new Request(`https://${host}${path}`, init), e);
const NOINDEX = 'noindex, nofollow';

test('every staging response carries X-Robots-Tag, whatever the status or route', async () => {
  const e = staging();
  for (const path of ['/', '/api/health', '/api/products', '/api/nope', '/products/missing', '/assets/app-abc.js', '/admin', '/api/admin/products', '/api/account/me', '/robots.txt', '/sitemap.xml', '/media/x']) {
    const r = await call(path, e);
    assert.equal(r.headers.get('X-Robots-Tag'), NOINDEX, path);
  }
  assert.equal((await call('/', e, undefined, { method: 'POST' })).headers.get('X-Robots-Tag'), NOINDEX);
  assert.equal((await call('/api/products', staging({ DB: undefined }))).headers.get('X-Robots-Tag'), NOINDEX);
});

test('staging robots.txt disallows everything and sitemap.xml is 404', async () => {
  const robots = await call('/robots.txt', staging());
  assert.equal(robots.status, 200);
  assert.equal(await robots.text(), 'User-agent: *\nDisallow: /\n');
  const sitemap = await call('/sitemap.xml', staging());
  assert.equal(sitemap.status, 404);
  assert.ok(!(await sitemap.text()).includes('<urlset'));
});

test('production and development robots, sitemap and headers are unchanged', async () => {
  for (const appEnv of ['production', 'development', undefined]) {
    const e = base(appEnv ? { APP_ENV: appEnv } : {});
    const robots = await call('/robots.txt', e, 'catalog.test');
    assert.equal(await robots.text(), 'User-agent: *\nAllow: /\nSitemap: https://catalog.test/sitemap.xml\n');
    assert.equal(robots.headers.get('X-Robots-Tag'), null);
    const sitemap = await call('/sitemap.xml', e, 'catalog.test');
    assert.equal(sitemap.status, 200);
    assert.match(await sitemap.text(), /<urlset/);
    assert.equal((await call('/', e, 'catalog.test')).headers.get('X-Robots-Tag'), null);
  }
});

test('ADMIN_HOST: manager paths on another host are 404 before auth or assets, with headers', async () => {
  const e = staging({ ADMIN_HOST: 'staging.example.com' });
  assetCalls.length = 0;
  for (const path of ['/admin', '/admin/', '/admin/x', '/api/admin/products', '/api/admin/', '/api/auth/session', '/api/auth/login']) {
    for (const method of ['GET', 'POST']) {
      const r = await call(path, e, 'staging-admin.example.com', { method });
      assert.equal(r.status, 404, `${method} ${path}`);
      assert.ok((await r.json()).error, path);
      assert.equal(r.headers.get('X-Robots-Tag'), NOINDEX);
      assert.equal(r.headers.get('X-Frame-Options'), 'DENY');
      assert.equal(r.headers.get('X-Content-Type-Options'), 'nosniff');
    }
  }
  assert.deepEqual(assetCalls, []);
});

test('ADMIN_HOST: staging host serves admin through normal auth without redirect, other paths stay unaffected', async () => {
  const e = staging({ ADMIN_HOST: 'staging.example.com' });
  const admin = await call('/admin', e, 'staging.example.com');
  assert.equal(admin.status, 401);
  assert.equal(admin.headers.get('Location'), null);
  assert.equal((await call('/api/admin/products', e, 'staging.example.com')).status, 401);
  assert.equal((await call('/api/auth/session', e, 'staging.example.com')).status, 200);
  for (const path of ['/administrator', '/api/administrator', '/api/authx', '/admin-panel']) assert.notEqual((await call(path, e)).status, 401, path);
  assert.equal((await call('/administrator', e)).status, 200);
  assert.equal((await call('/api/health', e)).status, 200);
  assert.equal((await call('/api/products', e)).status, 200);
});

test('ADMIN_HOST unset: manager paths behave exactly as before on any host', async () => {
  for (const appEnv of ['production', 'development']) {
    const e = base({ APP_ENV: appEnv });
    assert.equal((await call('/admin', e, 'anything.example')).status, 401);
    assert.equal((await call('/api/admin/products', e, 'anything.example')).status, 401);
    assert.equal((await call('/api/auth/session', e, 'anything.example')).status, 200);
  }
  const blank = base({ APP_ENV: 'production', ADMIN_HOST: '  ' });
  assert.equal((await call('/admin', blank, 'anything.example')).status, 401);
});

test('same-host staging cabinet and APIs require the signed staging Access audience', async t => {
  const team = 'staging-cabinet-test';
  const audience = 'staging-gate-audience';
  const e = staging({ ADMIN_HOST: 'staging.example.com', CF_ACCESS_TEAM_NAME: team, CF_ACCESS_AUD: audience });
  const pair = await crypto.subtle.generateKey({ name: 'RSASSA-PKCS1-v1_5', modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: 'SHA-256' }, true, ['sign', 'verify']);
  const jwk = await crypto.subtle.exportKey('jwk', pair.publicKey);
  Object.assign(jwk, { kid: 'staging-key', alg: 'RS256' });
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async url => {
    assert.equal(String(url), `https://${team}.cloudflareaccess.com/cdn-cgi/access/certs`);
    return Response.json({ keys: [jwk] });
  };
  t.after(() => { globalThis.fetch = originalFetch; });
  async function token(aud = audience) {
    const encode = value => Buffer.from(JSON.stringify(value)).toString('base64url');
    const unsigned = `${encode({ alg: 'RS256', kid: 'staging-key' })}.${encode({ iss: `https://${team}.cloudflareaccess.com`, aud: [aud], email: 'admin@example.com', exp: Math.floor(Date.now() / 1000) + 300 })}`;
    const signature = await crypto.subtle.sign('RSASSA-PKCS1-v1_5', pair.privateKey, new TextEncoder().encode(unsigned));
    return `${unsigned}.${Buffer.from(signature).toString('base64url')}`;
  }
  const headers = { Cookie: `CF_Authorization=${await token()}`, Origin: 'https://staging.example.com' };
  const page = await call('/admin', e, undefined, { headers });
  assert.equal(page.status, 200);
  assert.equal(page.headers.get('Location'), null);
  assert.equal(page.headers.get('X-Robots-Tag'), NOINDEX);
  assert.equal((await call('/api/auth/session', e, undefined, { headers }).then(r => r.json())).authenticated, true);
  assert.equal((await call('/api/admin/products', e, undefined, { headers })).status, 200);
  assert.equal((await call('/api/admin/suppliers', e, undefined, { method: 'POST', headers: { ...headers, 'Content-Type': 'application/json' }, body: '{}' })).status, 400);
  assert.equal((await call('/api/admin/suppliers', e, undefined, { method: 'POST', headers: { ...headers, Origin: 'https://evil.test' }, body: '{}' })).status, 403);
  for (const path of ['/admin', '/api/admin/products']) {
    assert.equal((await call(path, e)).status, 401);
    assert.equal((await call(path, e, undefined, { headers: { Cookie: `CF_Authorization=${await token('old-admin-host-audience')}` } })).status, 401);
  }
});
