import test from 'node:test';
import { readFileSync } from 'node:fs';
import assert from 'node:assert/strict';
import worker, { isPrivatePath } from '../../apps/api/src/index.js';

import {defaultRecognitionSettings,CATEGORY_TREE,createTaxonomyContext} from '../../packages/catalog/taxonomy.js';
const PAGE='<!doctype html><html><head><title>App</title></head><body><div id="root"></div></body></html>';
function db(rowsByCall) {
  const seen=[];
  const stmt=sql=>({bind(){return stmt(sql);},async first(){return sql.includes('recognition_state')?{active_version:'seed-v1',catalog_revision:0,settings_json:JSON.stringify(defaultRecognitionSettings()),taxonomy_revision:1,nodes_json:JSON.stringify(createTaxonomyContext(CATEGORY_TREE).nodes),redirects_json:'{}'}:sql.includes('recognition_versions')?{settings_json:JSON.stringify(defaultRecognitionSettings())}:null;},async all(){seen.push(sql);return{results:rowsByCall(sql)};}});
  return{seen,prepare:stmt};
}
const published={id:'p1',supplier_id:'s',external_id:'x',slug:'good-coat',updated_at:'2026-01-01T00:00:00Z',source_json:JSON.stringify({externalId:'x',title:'Admin Account Coat',description:'d',category:'Coats',costMinor:1000,currency:'UAH',photos:[],variants:[]}),overrides_json:'{"published":1}'};
function env(extra={}) {
  return{DB:db(()=>[published]),ASSETS:{fetch:async()=>new Response(PAGE,{headers:{'Content-Type':'text/html'}})},CF_ACCESS_TEAM_NAME:'t',CF_ACCESS_AUD:'a',APP_ENV:'production',...extra};
}
const get=(path,e=env())=>worker.fetch(new Request('https://catalog.test'+path),e);

test('private path predicate covers admin, account and auth trees only',()=>{
  for(const p of ['/admin','/admin/','/admin/x','/api/admin/products','/api/auth/session','/account','/account/orders','/api/account/me','/cart','/cart/','/cart/x','/api/cart/checkout'])assert.equal(isPrivatePath(p),true,p);
  for(const p of ['/','/products/admin','/products/account','/administrator','/accounting','/cartoon','/products/cart','/api/carts','/api/products','/api/adminx','/sitemap.xml'])assert.equal(isPrivatePath(p),false,p);
});

test('private responses carry noindex and no-store, including errors',async()=>{
  for(const p of ['/admin','/admin/x','/api/admin/products','/api/auth/session','/api/account/me','/account','/account/settings','/cart','/cart?add=coat-p1&size=M&qty=1','/api/cart/checkout']){
    const r=await get(p);
    assert.equal(r.headers.get('X-Robots-Tag'),'noindex, nofollow',p);
    assert.match(r.headers.get('Cache-Control')||'',/no-store/,p);
  }
});

test('account SPA document gets robots meta injected; public pages do not',async()=>{
  const r=await get('/account');assert.equal(r.status,200);
  const html=await r.text();assert.match(html,/<meta name="robots" content="noindex, nofollow">/);assert.equal(html.match(/name="robots"/g).length,1);
  const home=await get('/');assert.equal(home.headers.get('X-Robots-Tag'),null);assert.doesNotMatch(await home.text(),/name="robots"/);
});

test('/cart SPA document is noindex with exactly one robots meta and is not run-worker-first-bypassed',async()=>{
  const r=await get('/cart?add=good-coat&size=M&qty=1');assert.equal(r.status,200);
  assert.equal(r.headers.get('X-Robots-Tag'),'noindex, nofollow');assert.match(r.headers.get('Cache-Control'),/no-store/);
  const html=await r.text();assert.equal(html.match(/name="robots"/g).length,1);assert.match(html,/content="noindex, nofollow"/);
  assert.equal((await worker.fetch(new Request('https://catalog.test/cart',{method:'POST'}),env())).status,405);
  assert.doesNotMatch(await(await get('/sitemap.xml')).text(),/\/cart/);
});

test('unauthenticated /admin is rejected before HTML is served and stays noindex',async()=>{
  const r=await get('/admin');assert.equal(r.status,401);assert.equal(r.headers.get('X-Robots-Tag'),'noindex, nofollow');
});

test('every admin tool subpath requires Access before HTML; staff tool subpaths are private documents',async()=>{
  for(const p of ['/admin/catalog','/admin/suppliers','/admin/sync','/admin/duplicates','/admin/recognition','/admin/team','/admin/audit','/admin/orders']){
    const r=await get(p);assert.equal(r.status,401,p);assert.equal(r.headers.get('X-Robots-Tag'),'noindex, nofollow',p);assert.doesNotMatch(await r.text(),/<div id="root">/,p);
  }
  for(const p of ['/staff/catalog','/staff/team','/staff/orders']){
    const r=await get(p);assert.equal(r.status,200,p);assert.equal(r.headers.get('X-Robots-Tag'),'noindex, nofollow',p);assert.match(r.headers.get('Cache-Control'),/no-store/,p);
  }
  const ok=await worker.fetch(new Request('http://localhost/admin/orders'),env({AUTH_DEV_BYPASS:'true',APP_ENV:'development'}));assert.equal(ok.status,200);
});

test('authenticated /admin 200 gets header, exactly one robots meta, no stale length/etag',async()=>{
  const e=env({AUTH_DEV_BYPASS:'true',APP_ENV:'development',ASSETS:{fetch:async()=>new Response(PAGE.replace('<title>','<meta name="robots" content="index"><title>'),{headers:{'Content-Type':'text/html','Content-Length':'999','ETag':'"abc"'}})}});
  const r=await worker.fetch(new Request('http://localhost/admin'),e);assert.equal(r.status,200);
  assert.equal(r.headers.get('X-Robots-Tag'),'noindex, nofollow');assert.equal(r.headers.get('ETag'),null);assert.equal(r.headers.get('Content-Length'),null);
  const html=await r.text();assert.equal(html.match(/name="robots"/g).length,1);assert.match(html,/content="noindex, nofollow"/);
});

test('304 and HEAD private responses are marked without body rewriting',async()=>{
  const e=env({ASSETS:{fetch:async()=>new Response(null,{status:304,headers:{'Content-Type':'text/html'}})}});
  const r=await get('/account',e);assert.equal(r.status,304);assert.equal(r.headers.get('X-Robots-Tag'),'noindex, nofollow');assert.match(r.headers.get('Cache-Control'),/no-store/);
  const h=await worker.fetch(new Request('https://catalog.test/account',{method:'HEAD'}),env());
  assert.equal(h.status,200);assert.equal(h.headers.get('X-Robots-Tag'),'noindex, nofollow');
});

test('wrangler run_worker_first routes every private prefix to the Worker',async()=>{
  const config=JSON.parse(readFileSync(new URL('../../wrangler.jsonc',import.meta.url),'utf8').replace(/^\s*\/\/.*$/gm,'')),first=config.assets.run_worker_first;
  for(const route of ['/admin','/admin/*','/account','/account/*','/cart','/cart/*','/api/*'])assert.ok(first.includes(route),route);
  for(const p of ['/admin','/admin/x','/account','/account/x','/api/admin/x'])assert.equal(isPrivatePath(p),true);
});

test('robots.txt does not advertise private paths and links the sitemap',async()=>{
  const r=await get('/robots.txt'),text=await r.text();
  assert.equal(r.status,200);assert.match(text,/^User-agent: \*\nAllow: \/$/m);assert.match(text,/Sitemap: https:\/\/catalog\.test\/sitemap\.xml/);
  assert.doesNotMatch(text,/Disallow|admin|account|\/api/i);
});

test('sitemap lists only published product URLs and reads from the published projection',async()=>{
  const e=env(),r=await get('/sitemap.xml',e),xml=await r.text();
  assert.match(xml,/<loc>https:\/\/catalog\.test\/products\/good-coat<\/loc>/);
  assert.doesNotMatch(xml,/\/admin|\/api|\/account/);
  assert.ok(e.DB.seen.every(s=>/json_extract\(p\.overrides_json,'\$\.published'\)=1/.test(s)&&/deleted_at IS NULL/.test(s)));
});

test('public search source ignores q and only exposes published projection, never routes',async()=>{
  const e=env(),r=await get('/api/products?q=admin',e),data=await r.json();
  assert.equal(r.headers.get('X-Robots-Tag'),null);
  assert.deepEqual(data.items.map(i=>i.slug),['good-coat']);
  assert.ok(e.DB.seen.every(s=>/^SELECT source_url,url FROM photo_derivatives WHERE variant='card' AND url IS NOT NULL$/.test(s)||/json_extract\(p\.overrides_json,'\$\.published'\)=1/.test(s)&&!/admin|account/i.test(s.replace(/overrides_json/g,''))));
  assert.doesNotMatch(JSON.stringify(data),/"\/(admin|account)|api\/admin/);
});
