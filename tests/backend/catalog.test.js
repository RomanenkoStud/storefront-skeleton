import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { readFileSync } from 'node:fs';
import worker from '../../apps/api/src/index.js';
import { parseEasyDropLink, buildEasyDropFeedUrl, keyLast4 } from '../../apps/api/src/easydrop-link.js';
import { retailPrice, validateSource, validateOverrides, supplierUrl, productProjection } from '../../apps/api/src/domain.js';

const source={externalId:'supplier-1',title:'Test Coat',description:'Source description',category:'Coats',costMinor:10001,currency:'UAH',photos:['https://example.com/photo.jpg'],variants:[{id:'s',size:'S',stock:4},{id:'m',size:'M',stock:0}]};
function database() {
  const sqlite=new DatabaseSync(':memory:');sqlite.exec(readFileSync(new URL('../../migrations/0001_catalog.sql',import.meta.url),'utf8'));sqlite.exec(readFileSync(new URL('../../migrations/0002_mydrop_connection.sql',import.meta.url),'utf8'));sqlite.exec(readFileSync(new URL('../../migrations/0003_admin_trash.sql',import.meta.url),'utf8'));
  sqlite.exec(readFileSync(new URL('../../migrations/0005_recognition.sql',import.meta.url),'utf8'));
  sqlite.exec(readFileSync(new URL('../../migrations/0007_taxonomy.sql',import.meta.url),'utf8'));
  sqlite.exec(readFileSync(new URL('../../migrations/0008_staff.sql',import.meta.url),'utf8'));
  sqlite.exec(readFileSync(new URL('../../migrations/0015_supplier_provider.sql',import.meta.url),'utf8'));
  sqlite.exec(readFileSync(new URL('../../migrations/0016_duplicate_groups.sql',import.meta.url),'utf8'));
  sqlite.exec(readFileSync(new URL('../../migrations/0013_d1_read_budget.sql',import.meta.url),'utf8'));
  // Media tracking (0014) checks cart line photos, so carts (0011, which needs 0004 customers) are loaded too.
  for(const name of ['0004_customer_accounts.sql','0011_carts.sql','0014_media.sql'])sqlite.exec(readFileSync(new URL('../../migrations/'+name,import.meta.url),'utf8'));
  const wrap=(sql,bindings=[])=>({sql,bindings,bind(...values){return wrap(sql,values);},async first(){return sqlite.prepare(sql).get(...bindings)??null;},async all(){return{results:sqlite.prepare(sql).all(...bindings)};},async run(){return sqlite.prepare(sql).run(...bindings);}});
  const log=[];
  return{log,raw:sqlite,prepare:sql=>{log.push(sql);return wrap(sql);},async batch(statements){sqlite.exec('BEGIN');try{const result=statements.map(s=>sqlite.prepare(s.sql).run(...s.bindings));sqlite.exec('COMMIT');return result;}catch(error){sqlite.exec('ROLLBACK');throw error;}},close:()=>sqlite.close()};
}
let jwtFixture;
async function jwtSetup() {
 if(!jwtFixture){
  const pair=await crypto.subtle.generateKey({name:'RSASSA-PKCS1-v1_5',modulusLength:2048,publicExponent:new Uint8Array([1,0,1]),hash:'SHA-256'},true,['sign','verify']);
  const jwk=await crypto.subtle.exportKey('jwk',pair.publicKey);jwk.kid='test-key';jwk.alg='RS256';
  jwtFixture={pair,jwk};
 }
 return jwtFixture;
}
async function signedToken(overrides={},headerOverrides={}){
 const {pair}=await jwtSetup(),encode=value=>Buffer.from(JSON.stringify(value)).toString('base64url');
 const unsigned=encode({alg:'RS256',kid:'test-key',...headerOverrides})+'.'+encode({iss:'https://your-team.cloudflareaccess.com',aud:['catalog-audience'],email:'manager@example.com',exp:Math.floor(Date.now()/1000)+3600,...overrides});
 const signature=await crypto.subtle.sign('RSASSA-PKCS1-v1_5',pair.privateKey,new TextEncoder().encode(unsigned));return unsigned+'.'+Buffer.from(signature).toString('base64url');
}
function app(t) {
 const env={DB:database(),CF_ACCESS_TEAM_NAME:'your-team',CF_ACCESS_AUD:'catalog-audience',APP_ENV:'production'};t.after(()=>env.DB.close());
 let token='';
 async function call(path,method='GET',body,extra={}){
  const headers={Origin:'https://catalog.test',...extra};if(token)headers.Cookie='CF_Authorization='+token;
  if(body!==undefined)headers['Content-Type']='application/json';
  const response=await worker.fetch(new Request('https://catalog.test'+path,{method,headers,body:body===undefined?undefined:JSON.stringify(body)}),env);
  const contentType=response.headers.get('Content-Type')||'';const data=contentType.includes('application/json')?await response.json():await response.text();
  return{response,data};
 }
 return{env,call,setToken:value=>{token=value;}};
}
async function loggedIn(t){
 const a=app(t),{jwk}=await jwtSetup(),original=globalThis.fetch;
 // Mirror workerd: fetch accepts only redirect 'follow' or 'manual'; anything else throws.
 globalThis.fetch=async(url,options)=>{if(options?.redirect!==undefined&&!['follow','manual'].includes(options.redirect))throw new TypeError('Invalid redirect value');return String(url).includes('/cdn-cgi/access/certs')?new Response(JSON.stringify({keys:[jwk]}),{headers:{'Content-Type':'application/json'}}):original(url);};
 t.after(()=>{globalThis.fetch=original;});a.setToken(await signedToken());return a;
}
async function imported(t) {const a=await loggedIn(t);const {data:supplier}=await a.call('/api/admin/suppliers','POST',{name:'Lorem Supply',url:'https://mydrop.com.ua/demo_shop'});assert.ok(supplier.id);assert.equal((await a.call(`/api/admin/suppliers/${supplier.id}/import`,'POST',{items:[source]})).response.status,200);const {data}=await a.call('/api/admin/products');return{...a,supplier,product:data.items[0]};}

test('pricing uses integer kopecks with deterministic percent rounding',()=>{assert.equal(retailPrice(10001,'percent',15),11501);assert.equal(retailPrice(10001,'fixed',5000),15001);assert.throws(()=>retailPrice(100,'fixed',-1));assert.throws(()=>retailPrice(100000000,'percent',100000000));});
test('source and overrides reject malformed inventory and URLs',()=>{assert.throws(()=>supplierUrl('https://mydrop.com.ua.evil.test/foo'));assert.throws(()=>supplierUrl('https://mydrop.com.ua/foo?url=http://localhost'));assert.throws(()=>validateSource({...source,variants:[{id:'x',size:'S',stock:-1}]}));assert.throws(()=>validateOverrides({published:'true'}));assert.throws(()=>validateOverrides({source:{costMinor:1}}));assert.throws(()=>validateOverrides({promoStartsAt:'2027-01-02T00:00:00Z',promoEndsAt:'2027-01-01T00:00:00Z'}));});
test('projection excludes private IDs/costs and expires promotion exactly at boundary',()=>{const row={id:'p',supplier_id:'s',external_id:'secret',slug:'coat',source_json:JSON.stringify(source),overrides_json:JSON.stringify({hiddenSizes:['S'],freeShipping:true,promoText:'Offer',promoEndsAt:'2026-01-01T00:00:00Z'}),updated_at:'2026-01-01T00:00:00Z'};const projection=productProjection(row,Date.parse('2026-01-01T00:00:00Z'),true);assert.equal(projection.freeShipping,false);assert.equal(projection.promoText,'');assert.deepEqual(projection.variants,[{size:'M',stock:0}]);assert.ok(!JSON.stringify(projection).includes('costMinor'));assert.ok(!('supplierId' in projection));});
test('Access protects HTML and APIs, verifies signed identity, and rejects CSRF',async t=>{
 const a=await loggedIn(t);a.setToken('');assert.equal((await a.call('/api/admin/products')).response.status,401);assert.equal((await a.call('/admin')).response.status,401);
 a.setToken(await signedToken());assert.equal((await a.call('/api/auth/session')).data.email,'manager@example.com');
 assert.equal((await a.call('/api/admin/suppliers','POST',{name:'A',url:'https://mydrop.com.ua/foo'},{Origin:'https://evil.test'})).response.status,403);
 a.env.CF_ACCESS_AUD='';assert.equal((await a.call('/api/admin/products')).response.status,401);
});
test('Access rejects wrong audience, issuer, expired, missing expiry, wrong algorithm and forged token',async t=>{
 const a=await loggedIn(t);
 for(const payload of [{aud:['wrong']},{iss:'https://evil.test'},{exp:0},{exp:null},{email:null},{nbf:99999999999}]){a.setToken(await signedToken(payload));assert.equal((await a.call('/api/admin/products')).response.status,401);}
 a.setToken(await signedToken({},{alg:'HS256'}));assert.equal((await a.call('/api/admin/products')).response.status,401);
 const valid=await signedToken();const parts=valid.split('.');parts[1]=Buffer.from(JSON.stringify({iss:'https://your-team.cloudflareaccess.com',aud:['catalog-audience'],email:'attacker@example.com',exp:99999999999})).toString('base64url');a.setToken(parts.join('.'));assert.equal((await a.call('/api/admin/products')).response.status,401);
});
test('development bypass is explicit, loopback-only and unavailable in production',async t=>{
 const a=app(t);a.env.AUTH_DEV_BYPASS='true';
 async function local(host){const response=await worker.fetch(new Request(`http://${host}/api/auth/session`),a.env);return response.json();}
 assert.equal((await local('localhost')).authenticated,false);a.env.APP_ENV='development';assert.equal((await local('localhost')).authenticated,true);assert.equal((await local('catalog.test')).authenticated,false);a.env.AUTH_DEV_BYPASS='false';assert.equal((await local('localhost')).authenticated,false);
});
test('repeat import preserves edits, publication gates public data, disabling supplier hides it',async t=>{const a=await imported(t);assert.deepEqual((await a.call('/api/products')).data.items,[]);const updated=await a.call(`/api/admin/products/${a.product.id}`,'PATCH',{published:true,title:'Curated coat',description:'Curated copy',markupType:'percent',markupValue:20,hiddenSizes:['M'],slug:'curated-coat'});assert.equal(updated.response.status,200);await a.call(`/api/admin/suppliers/${a.supplier.id}/import`,'POST',{items:[{...source,costMinor:20000,title:'Changed supplier title'}]});const admin=(await a.call('/api/admin/products')).data.items;assert.equal(admin.length,1);assert.equal(admin[0].title,'Curated coat');assert.equal(admin[0].description,'Curated copy');assert.equal(admin[0].priceMinor,24000);const publicProducts=(await a.call('/api/products')).data.items;assert.equal(publicProducts.length,1);assert.equal(publicProducts[0].slug,'curated-coat');assert.deepEqual(publicProducts[0].variants,[{size:'S',stock:4}]);assert.ok(!('source' in publicProducts[0]));assert.equal((await a.call('/api/products/curated-coat')).response.status,200);await a.call(`/api/admin/suppliers/${a.supplier.id}`,'PATCH',{enabled:false});assert.deepEqual((await a.call('/api/products')).data.items,[]);assert.equal((await a.call('/products/curated-coat')).response.status,404);});
test('invalid partial import changes nothing and cannot delete existing inventory',async t=>{const a=await imported(t);const res=await a.call(`/api/admin/suppliers/${a.supplier.id}/import`,'POST',{items:[{...source,costMinor:1},{...source,externalId:'bad',costMinor:-1}]});assert.equal(res.response.status,400);assert.equal((await a.call('/api/admin/products')).data.items[0].source.costMinor,10001);});
test('slug changes redirect published pages; SEO escapes copy and matches price/stock',async t=>{const a=await imported(t);const oldSlug=a.product.slug;await a.call(`/api/admin/products/${a.product.id}`,'PATCH',{published:true,slug:'safe-coat',title:'<script>alert(1)</script>',seoDescription:'A "safe" description',photos:['https://example.com/curated-first.jpg','https://example.com/curated-second.jpg']});const page=await a.call('/products/safe-coat');assert.equal(page.response.status,200);assert.match(page.data,/&lt;script&gt;/);assert.ok(page.data.indexOf('src="https://example.com/curated-first.jpg"')<page.data.indexOf('src="https://example.com/curated-second.jpg"'));assert.match(page.data,/src="https:\/\/example.com\/curated-second.jpg"/);assert.match(page.data,/ви отримаєте код кошика/);assert.ok(!page.data.includes('<script>alert(1)</script>'));assert.match(page.data,/"price":"100.01"/);const redirect=await a.call('/products/'+oldSlug);assert.equal(redirect.response.status,301);assert.equal(redirect.response.headers.get('Location'),'https://catalog.test/products/safe-coat');const sitemap=await a.call('/sitemap.xml');assert.match(sitemap.data,/safe-coat/);assert.ok(!sitemap.data.includes(oldSlug));});
test('product HTML discloses photo processing in the footer only, never in body, meta, JSON-LD or sitemap',async t=>{const a=await imported(t);await a.call(`/api/admin/products/${a.product.id}`,'PATCH',{published:true,slug:'note-coat',photos:['https://example.com/n.jpg']});const html=(await a.call('/products/note-coat')).data;const short='Фото товарів можуть бути оброблені для єдиного стилю каталогу.';const footer=html.slice(html.indexOf('<footer'));assert.ok(footer.includes(`<p class="photo-note">${short}</p>`));const body=html.slice(html.indexOf('<main>'),html.indexOf('</main>'));assert.ok(!body.includes('photo-note-long')&&!body.includes('єдиного стилю'));const ld=html.match(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/)[1];const meta=html.match(/<meta name="description" content="([^"]*)"/)[1];for(const text of [ld,meta])assert.ok(!text.includes('оброблені')&&!text.includes('єдиного стилю'));assert.equal(html.split('єдиного стилю каталогу').length-1,1);const sitemap=(await a.call('/sitemap.xml')).data;assert.ok(!sitemap.includes('єдиного стилю'));});
test('unconfigured MyDrop API sync records explicit failure and never fabricates inventory',async t=>{const a=await imported(t), original=globalThis.fetch;globalThis.fetch=async()=>new Response('Forbidden',{status:403});t.after(()=>{globalThis.fetch=original;});const result=await a.call(`/api/admin/suppliers/${a.supplier.id}/sync`,'POST',{});assert.equal(result.response.status,422);assert.match(result.data.error,/API key is not configured/);assert.equal((await a.call('/api/admin/products')).data.items.length,1);const runs=(await a.call('/api/admin/sync-runs')).data.items;assert.ok(runs.some(x=>x.status==='blocked'));});
test('Access owns sign-in/out; missing R2 yields explicit unavailable error',async t=>{const a=await loggedIn(t);assert.equal((await a.call('/api/admin/media','POST',{})).response.status,503);assert.equal((await a.call('/api/auth/login','POST',{})).response.status,405);assert.equal((await a.call('/api/auth/logout','POST',{})).response.status,405);a.setToken('');assert.equal((await a.call('/api/auth/session')).data.authenticated,false);});
test('refresh cannot invalidate published products or overflow saved pricing',async t=>{const a=await imported(t);await a.call(`/api/admin/products/${a.product.id}`,'PATCH',{published:true,markupType:'percent',markupValue:100});for(const change of [{costMinor:0},{costMinor:100000000},{photos:[]},{variants:[{id:'s',size:'S',stock:0}]}]){if(change.variants)await a.call(`/api/admin/products/${a.product.id}`,'PATCH',{hiddenSizes:['S']});const response=await a.call(`/api/admin/suppliers/${a.supplier.id}/import`,'POST',{items:[{...source,...change}]});assert.equal(response.response.status,400);}assert.equal((await a.call('/api/admin/products')).data.items[0].source.costMinor,10001);});
test('null variants are client validation failures',async t=>{const a=await imported(t);assert.equal((await a.call(`/api/admin/suppliers/${a.supplier.id}/import`,'POST',{items:[{...source,variants:[null]}]})).response.status,400);});
test('media upload checks content, remains private as draft and is exposed only after publication',async t=>{
 const a=await imported(t),objects=new Map();
 a.env.MEDIA={async put(key,bytes,options){objects.set(key,{body:bytes,httpMetadata:options.httpMetadata});},async get(key){return objects.get(key)||null;}};
 const jwt=await signedToken();
 async function upload(bytes,type){const form=new FormData();form.append('file',new Blob([new Uint8Array(bytes)],{type}),'photo.png');return worker.fetch(new Request('https://catalog.test/api/admin/media',{method:'POST',headers:{Origin:'https://catalog.test',Cookie:'CF_Authorization='+jwt},body:form}),a.env);}
 assert.equal((await upload([60,115,118,103,62],'image/png')).status,400);
 const response=await upload([137,80,78,71,13,10,26,10,0,0,0,0],'image/png');assert.equal(response.status,201);const {url}=await response.json();
 const privatePhoto=await worker.fetch(new Request('https://catalog.test'+url),a.env);assert.equal(privatePhoto.status,404);
 await a.call(`/api/admin/products/${a.product.id}`,'PATCH',{published:true,photos:[url]});
 const publicPhoto=await worker.fetch(new Request('https://catalog.test'+url),a.env);assert.equal(publicPhoto.status,200);assert.equal(publicPhoto.headers.get('Content-Type'),'image/png');
 const events=await a.env.DB.prepare('SELECT actor FROM audit_events').all();assert.ok(events.results.every(event=>event.actor==='manager@example.com'));
 await a.call(`/api/admin/products/${a.product.id}`,'DELETE',{confirm:true});
 assert.equal((await worker.fetch(new Request('https://catalog.test'+url),a.env)).status,404);
});

const apiCatalog={categories:[{id:90210,title:'Кросівки',parent_id:null}],products:[{id:553311,title:'Кросівки Lorem Air',sku:'ld-1245',category_id:90210,drop_price:950.15,price:1400,description:'Опис товару',sizes_available:true,is_set:false,sizes:[{id:77001,title:'42',formatted:'42',real_count_dropshipper:1,images:[]}],images:[{id:88001,full_url:'https://backend.mydrop.com.ua/vendor/products/uploads/example.jpg'}]}]};
async function apiReady(t,responseFactory){
 const a=await imported(t);a.env.MYDROP_API_KEY='test-secret-never-log';
 await a.call(`/api/admin/suppliers/${a.supplier.id}`,'PATCH',{connectionId:'12345'});
 const original=globalThis.fetch;
 globalThis.fetch=async(url,options)=>String(url).startsWith('https://backend.mydrop.com.ua/')?responseFactory(url,options):original(url,options);
 t.after(()=>{globalThis.fetch=original;});return a;
}
test('official MyDrop API maps drop price, category, photo and stable size IDs without fabricating counts',async t=>{
 let fetched;
 const a=await apiReady(t,(url,options)=>{fetched={url,options};return new Response(JSON.stringify(apiCatalog),{headers:{'Content-Type':'application/json'}});});
 const result=await a.call(`/api/admin/suppliers/${a.supplier.id}/sync`,'POST',{});assert.equal(result.response.status,200);assert.deepEqual(result.data,{status:'synced',imported:1});
 assert.equal(fetched.url,'https://backend.mydrop.com.ua/dropshipper/api/export/dropshipper_vendors/12345/products/json');assert.equal(fetched.options.headers['X-API-KEY'],'test-secret-never-log');assert.equal(fetched.options.redirect,'manual');assert.equal(fetched.options.headers['Content-Type'],'application/json');
 const products=(await a.call('/api/admin/products')).data.items,product=products.find(p=>p.externalId==='553311');assert.equal(product.source.costMinor,95015);assert.equal(product.source.category,'Кросівки');assert.deepEqual(product.source.variants,[{id:'77001',size:'42',stock:1}]);assert.equal(product.source.photos[0],apiCatalog.products[0].images[0].full_url);assert.equal(product.published,false);
 assert.equal((await a.call(`/api/admin/suppliers/${a.supplier.id}/sync`,'POST',{})).response.status,429);
});
test('MyDrop pending response returns202, progress and cooldown without changing inventory',async t=>{
 const a=await apiReady(t,()=>new Response(JSON.stringify({status:'pending',progress:40}),{status:202,headers:{'Content-Type':'application/json'}}));
 const response=await a.call(`/api/admin/suppliers/${a.supplier.id}/sync`,'POST',{});assert.equal(response.response.status,202);assert.deepEqual(response.data,{status:'pending',progress:40,retryAfterSeconds:900});assert.equal((await a.call('/api/admin/products')).data.items.length,1);assert.equal((await a.call('/api/admin/sync-runs')).data.items[0].status,'pending');
});
test('MyDrop bundles and malformed products are skipped with reasons while the rest of the supplier imports',async t=>{
 const base=apiCatalog.products[0];
 const a=await apiReady(t,()=>new Response(JSON.stringify({...apiCatalog,products:[base,{...base,id:553400,is_set:true,sizes:[],child_products:[{id:1,sizes:[{id:11,title:'S',real_count_dropshipper:1},{id:12,title:'M',real_count_dropshipper:1}]},{id:2,sizes:[{id:21,title:'40',real_count_dropshipper:1},{id:22,title:'42',real_count_dropshipper:1}]}]},{...base,id:553401,drop_price:null},{...base,id:553402},{...base,id:553402,drop_price:1}]}),{headers:{'Content-Type':'application/json'}}));
 const result=await a.call(`/api/admin/suppliers/${a.supplier.id}/sync`,'POST',{});assert.equal(result.response.status,200);assert.equal(result.data.imported,1);assert.equal(result.data.skippedCount,4);assert.deepEqual(result.data.skippedIds,['553400','553401','553402','553402']);
 assert.match(result.data.skippedNote,/Пропущено 4 з 5/);assert.match(result.data.skippedNote,/набір без спільного розміру для всіх речей — 1/);assert.match(result.data.skippedNote,/немає drop_price — 1/);assert.match(result.data.skippedNote,/ID товару — 2/);
 const products=(await a.call('/api/admin/products')).data.items;assert.deepEqual(products.map(p=>p.externalId).sort(),[source.externalId,'553311'].sort());
 const run=(await a.call('/api/admin/sync-runs')).data.items.find(r=>r.status==='synced');assert.equal(run.imported,1);assert.match(run.error,/Пропущено 4/);
 const supplier=(await a.call('/api/admin/suppliers')).data.items.find(s=>s.id===a.supplier.id);assert.equal(supplier.lastSyncStatus,'synced');
});
test('MyDrop refresh that would invalidate a published product keeps it and syncs the rest',async t=>{
 let catalog=apiCatalog;
 const a=await apiReady(t,()=>new Response(JSON.stringify(catalog),{headers:{'Content-Type':'application/json'}}));
 const path=`/api/admin/suppliers/${a.supplier.id}/sync`;
 assert.equal((await a.call(path,'POST',{})).data.imported,1);
 const product=(await a.call('/api/admin/products')).data.items.find(p=>p.externalId==='553311');
 assert.equal((await a.call(`/api/admin/products/${product.id}`,'PATCH',{published:true})).response.status,200);
 await a.env.DB.prepare('UPDATE suppliers SET last_api_request_at=NULL WHERE id=?').bind(a.supplier.id).run();
 catalog={...apiCatalog,products:[{...apiCatalog.products[0],images:[{full_url:'http://insecure.test/x.jpg'}]},{...apiCatalog.products[0],id:553999}]};
 const result=await a.call(path,'POST',{});assert.equal(result.response.status,200);assert.equal(result.data.imported,1);
 assert.equal(result.data.skippedCount,1);assert.deepEqual(result.data.skippedIds,['553311']);assert.match(result.data.skippedNote,/залишено як є\) — 1/);
 const kept=(await a.call('/api/admin/products')).data.items.find(p=>p.id===product.id);assert.equal(kept.published,true);assert.equal(kept.source.photos.length,1);
 const supplier=(await a.call('/api/admin/suppliers')).data.items.find(s=>s.id===a.supplier.id);assert.equal(supplier.lastSyncStatus,'synced');
});
test('MyDrop bundles import with matched sizes, derived stock and private component IDs',async t=>{
 const {normalizeMyDrop}=await import('../../apps/api/src/mydrop.js');
 const base=apiCatalog.products[0];
 const hoodie={id:10,title:'Худі',sizes:[{id:101,title:'S',real_count_dropshipper:5},{id:102,title:'M',real_count_dropshipper:0},{id:103,title:'L',real_count_dropshipper:9},{id:104,title:'XL',real_count_dropshipper:9}]};
 const pants={id:20,title:'Штани',sizes:[{id:201,title:'s ',real_count_dropshipper:2},{id:202,title:'M',real_count_dropshipper:7},{id:203,title:'L',real_count_dropshipper:7}]};
 const cap={id:30,title:'Кепка',sizes:[{id:301,title:'One size',real_count_dropshipper:4,images:[{full_url:'https://cdn.test/cap.jpg'}]}]};
 const set=(id,child_products,extra={})=>({...base,id,is_set:true,sizes:[],images:[],child_products,...extra});
 const {items,skipped}=normalizeMyDrop({...apiCatalog,products:[
  set(1,[hoodie,pants,cap]),
  set(2,[{...pants},{...pants},{...pants}]),
  set(3,[hoodie,{id:40,sizes:[{id:401,title:'XL',real_count_dropshipper:3}]}]),
  set(4,[{id:50,sizes:[{id:501,title:'M',real_count_dropshipper:1}]},{id:60,sizes:[]}]),
  set(5,[hoodie,{id:70,sizes:[{id:701,title:'38',real_count_dropshipper:1},{id:702,title:'40',real_count_dropshipper:1}]}]),
  set(6,[]),
  set(10,[hoodie,pants,{id:80,sizes:[{id:801,title:'XL',real_count_dropshipper:3}]}]),
  set(11,[pants,hoodie,{id:80,sizes:[{id:801,title:'XL',real_count_dropshipper:3}]}]),
  set(12,[hoodie,{id:90,real_count_dropshipper:7,sizes:[{id:901},{id:902,title:''}]}]),
  set(13,[{id:95,sizes:[{id:951,title:'M',real_count_dropshipper:0},{id:952,title:'L',real_count_dropshipper:1},{id:953,title:'M',real_count_dropshipper:9}]}]),
  set(14,Array.from({length:15},(_,i)=>({id:1000000000+i,sizes:[{id:2000000000+i,title:'M',real_count_dropshipper:1},{id:3000000000+i,title:'L',real_count_dropshipper:1}]}))),
  set(7,[{id:null}]),
  {...base,id:8,is_set:undefined,sizes:[],child_products:[hoodie,pants]},
 ]});
 const byId=new Map(items.map(i=>[i.externalId,i]));
 // Sizes shared by every sized component, in the first component's order; one-size cap joins all.
 assert.deepEqual(byId.get('1').variants,[{id:'set:10.101+20.201+30.301',size:'S',stock:2},{id:'set:10.102+20.202+30.301',size:'M',stock:0},{id:'set:10.103+20.203+30.301',size:'L',stock:4}]);
 assert.deepEqual(byId.get('1').photos,['https://cdn.test/cap.jpg']);
 // Three units of one component: stock is floor(stock / 3).
 assert.deepEqual(byId.get('2').variants.map(v=>[v.id,v.size,v.stock]),[['set:20.201','s',0],['set:20.202','M',2],['set:20.203','L',2]]);
 // A component listing only one real size restricts the bundle to it.
 assert.deepEqual(byId.get('3').variants,[{id:'set:10.104+40.401',size:'XL',stock:3}]);
 assert.deepEqual(byId.get('4').variants,[{id:'set:50.501+60.default',size:'M / Один розмір',stock:0}]);
 assert.equal(byId.get('8').variants.length,3);
 // Order-independent: an XL-only component never joins sizes it does not have.
 assert.deepEqual(skipped,[{externalId:'5',reason:'bundle_no_common_size'},{externalId:'6',reason:'bundle_invalid'},{externalId:'10',reason:'bundle_no_common_size'},{externalId:'11',reason:'bundle_no_common_size'},{externalId:'12',reason:'bundle_invalid'},{externalId:'14',reason:'bundle_too_large'},{externalId:'7',reason:'bundle_invalid'}]);
 assert.deepEqual(byId.get('13').variants,[{id:'set:95.953',size:'M',stock:9},{id:'set:95.952',size:'L',stock:1}]);
 // Public product responses expose bundle sizes and stock, never component IDs.
 const a=await apiReady(t,()=>new Response(JSON.stringify({...apiCatalog,products:[set(9,[hoodie,pants,cap],{images:base.images})]}),{headers:{'Content-Type':'application/json'}}));
 assert.equal((await a.call(`/api/admin/suppliers/${a.supplier.id}/sync`,'POST',{})).data.imported,1);
 const product=(await a.call('/api/admin/products')).data.items.find(p=>p.externalId==='9');
 assert.equal((await a.call(`/api/admin/products/${product.id}`,'PATCH',{published:true})).response.status,200);
 const pub=(await a.call('/api/products')).data.items.find(p=>p.id===product.id);
 assert.deepEqual(pub.variants,[{size:'S',stock:2},{size:'M',stock:0},{size:'L',stock:4}]);assert.ok(!JSON.stringify(pub).includes('set:'));
});
test('MyDrop export where every product is unusable fails the run and keeps inventory',async t=>{
 const base=apiCatalog.products[0];
 const a=await apiReady(t,()=>new Response(JSON.stringify({...apiCatalog,products:[{...base,drop_price:{}},{...base,id:2,drop_price:'-5'}]}),{headers:{'Content-Type':'application/json'}}));
 const result=await a.call(`/api/admin/suppliers/${a.supplier.id}/sync`,'POST',{});assert.equal(result.response.status,422);
 assert.match(result.data.error,/no importable products/);assert.match(result.data.error,/не число\/рядок — 1/);assert.match(result.data.error,/відʼємна або нечислова\) — 1/);
 assert.equal((await a.call('/api/admin/products')).data.items.length,1);
 const supplier=(await a.call('/api/admin/suppliers')).data.items.find(s=>s.id===a.supplier.id);assert.equal(supplier.lastSyncStatus,'failed');
});
test('MyDrop production shapes: float/comma drop_price, size-less products, null category, bad photos and stock',async()=>{
 const {uahToMinor,normalizeMyDrop}=await import('../../apps/api/src/mydrop.js');
 assert.equal(uahToMinor(233.33333333333334),23333);assert.equal(uahToMinor(199.99000000000001),19999);assert.equal(uahToMinor('950,15'),95015);assert.equal(uahToMinor(' 12.5 '),1250);assert.equal(uahToMinor(0.1+0.2),30);
 for(const bad of [null,undefined,'',-1,'-5','abc',NaN,Infinity,1e12,{}])assert.throws(()=>uahToMinor(bad),/drop_price/);
 const base=apiCatalog.products[0];
 const {items,skipped}=normalizeMyDrop({categories:[...apiCatalog.categories,{id:5,title:''}],products:[
  {...base,id:1,sizes_available:false,sizes:[],real_count_dropshipper:3},
  {...base,id:2,category_id:null,is_set:undefined},
  {...base,id:3,category_id:777,images:[{full_url:'http://insecure.test/a.jpg'},{full_url:null},...Array.from({length:40},(_,i)=>({full_url:`https://cdn.test/${i}.jpg`}))]},
  {...base,id:4,sizes:[{id:1,title:'S',real_count_dropshipper:null},{id:1,title:'S dup',real_count_dropshipper:2},{id:2,title:'',formatted:'',real_count_dropshipper:2},{id:3,title:'M',real_count_dropshipper:-2},{id:4,title:'L',real_count_dropshipper:'7'}]},
  {...base,id:5,category_id:5,title:'x'.repeat(400),description:null},
  {...base,id:6,sizes:Array.from({length:101},(_,i)=>({id:i+1,title:String(i),real_count_dropshipper:1}))},
  {...base,id:7,title:'  '},
  {...base,id:8,is_set:1},
  {...base,id:9,sizes:[{id:null,title:'S'},{id:2,title:''}]},
 ]});
 const byId=new Map(items.map(i=>[i.externalId,i]));
 assert.deepEqual(byId.get('1').variants,[{id:'default',size:'Один розмір',stock:3}]);
 assert.equal(byId.get('2').category,'Без категорії');assert.equal(byId.get('3').category,'Без категорії');
 assert.equal(byId.get('3').photos.length,30);assert.ok(byId.get('3').photos.every(p=>p.startsWith('https://')));
 assert.deepEqual(byId.get('4').variants,[{id:'1',size:'S',stock:0},{id:'3',size:'M',stock:0},{id:'4',size:'L',stock:7}]);
 assert.equal(byId.get('5').title.length,300);assert.equal(byId.get('5').description,'');assert.equal(byId.get('5').category,'Без категорії');
 assert.deepEqual(skipped,[{externalId:'6',reason:'variants'},{externalId:'7',reason:'title'},{externalId:'8',reason:'bundle_invalid'},{externalId:'9',reason:'sizes_invalid'}]);
});
test('MyDrop unauthorized and redirect errors do not expose credentials or alter products',async t=>{
 let status=401;
 const a=await apiReady(t,()=>new Response('sensitive-upstream-text-test-secret-never-log',{status,headers:status===302?{Location:'https://evil.test/'}:{}}));
 for(const code of [401,302]){status=code;await a.env.DB.prepare('UPDATE suppliers SET last_api_request_at=NULL WHERE id=?').bind(a.supplier.id).run();const result=await a.call(`/api/admin/suppliers/${a.supplier.id}/sync`,'POST',{});assert.equal(result.response.status,422);assert.ok(!JSON.stringify(result.data).includes(a.env.MYDROP_API_KEY));assert.ok(!JSON.stringify(result.data).includes('sensitive-upstream'));}
 assert.equal((await a.call('/api/admin/products')).data.items.length,1);
});
test('MyDrop connection ID is not inferred from slug, validates positive integer string and clears explicitly',async t=>{
 const a=await imported(t);a.env.MYDROP_API_KEY='key';const first=await a.call(`/api/admin/suppliers/${a.supplier.id}/sync`,'POST',{});assert.equal(first.response.status,422);assert.match(first.data.error,/connection ID/);
 for(const invalid of ['0','-1','123/../../bad',123])assert.equal((await a.call(`/api/admin/suppliers/${a.supplier.id}`,'PATCH',{connectionId:invalid})).response.status,400);
 assert.equal((await a.call(`/api/admin/suppliers/${a.supplier.id}`,'PATCH',{connectionId:'123'})).data.connectionId,'123');assert.equal((await a.call(`/api/admin/suppliers/${a.supplier.id}`,'PATCH',{connectionId:null})).data.connectionId,null);
});
test('MyDrop decimal conversion rounds to kopecks and rejects oversized exports',async()=>{
 const {uahToMinor,normalizeMyDrop}=await import('../../apps/api/src/mydrop.js');assert.equal(uahToMinor(1.005),101);assert.equal(uahToMinor('10.994'),1099);assert.equal(uahToMinor('10.995'),1100);assert.throws(()=>uahToMinor(-1));assert.throws(()=>normalizeMyDrop({...apiCatalog,products:Array(5001).fill(apiCatalog.products[0])}),/5000-product/);for(const id of [{},true,null,NaN,Infinity])assert.deepEqual(normalizeMyDrop({...apiCatalog,products:[{...apiCatalog.products[0],id}]}),{items:[],skipped:[{externalId:null,reason:'id'}]});
});

test('large MyDrop sync accepts a nullable category record and preserves existing overrides atomically',async t=>{
 const catalog={categories:[...apiCatalog.categories,{id:99,title:null,parent_id:null}],products:Array.from({length:719},(_,i)=>({...apiCatalog.products[0],id:800000+i,category_id:i===0?99:90210}))};
 const a=await apiReady(t,()=>new Response(JSON.stringify(catalog),{headers:{'Content-Type':'application/json'}}));
 const syncPath=`/api/admin/suppliers/${a.supplier.id}/sync`;
 const first=await a.call(syncPath,'POST',{});assert.equal(first.response.status,200);assert.equal(first.data.imported,719);
 let products=(await a.call('/api/admin/products')).data.items;
 assert.equal(products.length,720);const product=products.find(p=>p.externalId==='800000');assert.equal(product.source.category,'Без категорії');assert.equal(product.category,'Кросівки');assert.equal(product.categoryId,'sneakers');
 assert.equal((await a.call(`/api/admin/products/${product.id}`,'PATCH',{title:'Manager title',markupType:'fixed',markupValue:5000})).response.status,200);
 await a.env.DB.prepare('UPDATE suppliers SET last_api_request_at=NULL WHERE id=?').bind(a.supplier.id).run();
 catalog.products[0].drop_price=1000;
 assert.equal((await a.call(syncPath,'POST',{})).data.imported,719);
 products=(await a.call('/api/admin/products')).data.items;assert.equal(products.length,720);
 const preserved=products.find(p=>p.id===product.id);assert.equal(preserved.title,'Manager title');assert.equal(preserved.priceMinor,105000);
 await a.env.DB.prepare('UPDATE suppliers SET last_api_request_at=NULL WHERE id=?').bind(a.supplier.id).run();
 catalog.products[718]={...catalog.products[718],sizes:[{...catalog.products[718].sizes[0],real_count_dropshipper:-1}]};
 const clamped=await a.call(syncPath,'POST',{});assert.equal(clamped.response.status,200);assert.equal(clamped.data.imported,719);
 products=(await a.call('/api/admin/products')).data.items;assert.equal(products.length,720);assert.equal(products.find(p=>p.externalId==='800718').source.variants[0].stock,0);
 assert.equal((await a.call('/api/products')).data.items.length,0);
 const manual=await a.call(`/api/admin/suppliers/${a.supplier.id}/import`,'POST',{items:Array(201).fill(source)});assert.equal(manual.response.status,400);
});

test('classification edits survive source refresh, public metadata escapes brand and automatic reset restores inference',async t=>{
 const a=await imported(t),path=`/api/admin/products/${a.product.id}`;
 const updated=await a.call(path,'PATCH',{published:true,categoryId:'hoodies',brand:'Custom <brand> "name"'});assert.equal(updated.response.status,200);assert.equal(updated.data.category,'Худі');assert.equal(updated.data.classificationSuggestion.categoryId,'unclassified');
 const refreshed={...source,title:'Куртка Lorem',category:'Верхній одяг'};
 assert.equal((await a.call(`/api/admin/suppliers/${a.supplier.id}/import`,'POST',{items:[refreshed]})).response.status,200);
 const admin=(await a.call('/api/admin/products')).data.items[0];assert.equal(admin.categoryId,'hoodies');assert.equal(admin.brand,'Custom <brand> "name"');assert.equal(admin.classificationSuggestion.categoryId,'jackets');
 const publicProduct=(await a.call('/api/products')).data.items[0];assert.equal(publicProduct.categoryId,'hoodies');assert.equal(publicProduct.brand,'Custom <brand> "name"');assert.equal('classificationSuggestion' in publicProduct,false);
 const html=(await a.call('/products/'+admin.slug)).data;assert.match(html,/Custom &lt;brand&gt; &quot;name&quot;/);assert.ok(!html.includes('Custom <brand>'));
 const reset=await a.call(path,'PATCH',{categoryId:null,brand:null});assert.equal(reset.response.status,200);assert.equal(reset.data.categoryId,'jackets');assert.equal(reset.data.brand,'Lorem');assert.equal(reset.data.categoryOverridden,false);
});

async function discoveryReady(t,body){
 const a=await imported(t);a.env.MYDROP_API_KEY='discovery-secret';let calls=0;
 const original=globalThis.fetch;
 globalThis.fetch=async(url,options)=>{
  if(String(url)==='https://backend.mydrop.com.ua/dropshipper/api/dropshipper_vendors'){
   calls++;assert.equal(options.headers['X-API-KEY'],'discovery-secret');assert.equal(options.redirect,'manual');
   return new Response(JSON.stringify(body),{headers:{'Content-Type':'application/json'}});
  }
  return original(url,options);
 };
 t.after(()=>{globalThis.fetch=original;});return{...a,calls:()=>calls};
}
const connected=(id,name,publicUrl,extra={})=>({id,verified:true,vendor:{name,publicUrl,publicApiKey:'upstream-private-key',managerPhone:'private-contact'},...extra});
test('connected supplier discovery links existing URLs, preserves manager settings and is idempotent by connection ID',async t=>{
 const body={results:[connected(101,'Remote Lorem Supply','demo_shop'),connected(102,'New supplier','new_supplier')]};
 const a=await discoveryReady(t,body),path='/api/admin/suppliers/sync-connected';
 await a.call(`/api/admin/suppliers/${a.supplier.id}`,'PATCH',{name:'Manager label',enabled:false});
 await a.call(`/api/admin/products/${a.product.id}`,'PATCH',{published:true,markupValue:5000});
 const first=await a.call(path,'POST',{});assert.equal(first.response.status,200);assert.deepEqual(first.data,{total:2,added:1,updated:1,unchanged:0,skipped:[]});
 let suppliers=(await a.call('/api/admin/suppliers')).data.items;assert.equal(suppliers.length,2);
 const linked=suppliers.find(s=>s.id===a.supplier.id);assert.equal(linked.name,'Manager label');assert.equal(linked.enabled,false);assert.equal(linked.connectionId,'101');
 const second=await a.call(path,'POST',{});assert.deepEqual(second.data,{total:2,added:0,updated:0,unchanged:2,skipped:[]});
 body.results[1].vendor.publicUrl='new_supplier_renamed';
 assert.equal((await a.call(path,'POST',{})).data.updated,1);
 suppliers=(await a.call('/api/admin/suppliers')).data.items;assert.equal(suppliers.length,2);assert.equal(suppliers.find(s=>s.connectionId==='102').url,'https://mydrop.com.ua/new_supplier_renamed');
 const products=(await a.call('/api/admin/products')).data.items;assert.equal(products.length,1);assert.equal(products[0].id,a.product.id);assert.equal(products[0].published,true);assert.equal(products[0].overrides.markupValue,5000);
 assert.equal((await a.call('/api/products')).data.items.length,0);
 assert.ok(!JSON.stringify(suppliers).includes('upstream-private-key'));assert.ok(!JSON.stringify(first.data).includes('private-contact'));
});
test('discovery reports pending or missing URLs and preserves hidden suppliers without inventing links',async t=>{
 const a=await discoveryReady(t,{results:[connected(201,'Hidden source','hidden_source',{hidden:true}),connected(202,'Pending source','pending_source',{verified:false}),connected(203,'No public URL',null),connected(204,'Unsafe URL','https://evil.test/source')]});
 const result=await a.call('/api/admin/suppliers/sync-connected','POST',{});assert.equal(result.response.status,200);assert.equal(result.data.added,1);assert.equal(result.data.skipped.length,3);
 const suppliers=(await a.call('/api/admin/suppliers')).data.items;const hidden=suppliers.find(s=>s.connectionId==='201');assert.equal(hidden.enabled,false);assert.equal(suppliers.length,2);
});
test('duplicate remote connections reject discovery before any local mutations',async t=>{
 const a=await discoveryReady(t,{results:[connected(301,'First','one'),connected(301,'Duplicate','two')]});
 const result=await a.call('/api/admin/suppliers/sync-connected','POST',{});assert.equal(result.response.status,422);assert.equal((await a.call('/api/admin/suppliers')).data.items.length,1);
});
test('discovery requires manager access, same origin and a configured key',async t=>{
 const a=await discoveryReady(t,{results:[]});a.setToken('');assert.equal((await a.call('/api/admin/suppliers/sync-connected','POST',{})).response.status,401);assert.equal(a.calls(),0);
 a.setToken(await signedToken());assert.equal((await a.call('/api/admin/suppliers/sync-connected','POST',{}, {Origin:'https://evil.test'})).response.status,403);assert.equal(a.calls(),0);
 delete a.env.MYDROP_API_KEY;assert.equal((await a.call('/api/admin/suppliers/sync-connected','POST',{})).response.status,422);assert.equal(a.calls(),0);
});
test('discovery errors and redirects never forward credentials or alter existing suppliers',async t=>{
 const a=await loggedIn(t);a.env.MYDROP_API_KEY='discovery-secret';let status=401;
 const original=globalThis.fetch;globalThis.fetch=async(url,options)=>String(url).startsWith('https://backend.mydrop.com.ua/')?new Response('discovery-secret',{status,headers:status===302?{Location:'https://evil.test/'}:{}}):original(url,options);
 t.after(()=>{globalThis.fetch=original;});
 for(const code of [401,403,302,500]){status=code;const result=await a.call('/api/admin/suppliers/sync-connected','POST',{});assert.equal(result.response.status,422);assert.ok(!JSON.stringify(result.data).includes(a.env.MYDROP_API_KEY));}
 assert.equal((await a.call('/api/admin/suppliers')).data.items.length,0);
});

test('supplier Trash requires confirmation, hides all product surfaces, preserves data and restores disabled',async t=>{
 const a=await imported(t),productPath=`/api/admin/products/${a.product.id}`,supplierPath=`/api/admin/suppliers/${a.supplier.id}`;
 await a.call(productPath,'PATCH',{published:true,slug:'before-supplier-delete'});
 await a.call(productPath,'PATCH',{slug:'supplier-delete-test'});
 let listed=(await a.call('/api/admin/suppliers')).data.items[0];assert.equal(listed.productCount,1);assert.equal(listed.publishedCount,1);assert.equal(listed.deletedAt,null);
 assert.equal((await a.call(supplierPath,'DELETE',{})).response.status,400);assert.equal((await a.call('/api/products')).data.items.length,1);
 const deleted=await a.call(supplierPath,'DELETE',{confirm:true});assert.equal(deleted.response.status,200);assert.deepEqual(deleted.data,{deleted:true,affectedProducts:1,publishedProducts:1});
 assert.equal((await a.call('/api/admin/suppliers')).data.items.length,0);assert.equal((await a.call('/api/admin/products')).data.items.length,0);
 const trash=(await a.call('/api/admin/suppliers?deleted=1')).data.items[0];assert.ok(trash.deletedAt);assert.equal(trash.enabled,false);assert.equal(trash.productCount,1);
 assert.equal((await a.call('/api/products')).data.items.length,0);assert.equal((await a.call('/api/products/supplier-delete-test')).response.status,404);assert.equal((await a.call('/products/supplier-delete-test')).response.status,404);assert.equal((await a.call('/products/before-supplier-delete')).response.status,404);assert.ok(!(await a.call('/sitemap.xml')).data.includes('supplier-delete-test'));
 assert.equal((await a.call(supplierPath,'PATCH',{enabled:true})).response.status,404);assert.equal((await a.call(productPath,'PATCH',{published:true})).response.status,404);assert.equal((await a.call(supplierPath+'/import','POST',{items:[source]})).response.status,404);
 assert.equal((await a.call('/api/admin/suppliers','POST',{name:'Duplicate',url:a.supplier.url})).response.status,409);
 const restored=await a.call(supplierPath+'/restore','POST',{});assert.equal(restored.response.status,200);assert.equal(restored.data.enabled,false);assert.equal(restored.data.deletedAt,null);assert.equal((await a.call('/api/admin/products')).data.items.length,1);assert.equal((await a.call('/api/products')).data.items.length,0);
 const events=(await a.env.DB.prepare("SELECT action,actor FROM audit_events WHERE action IN ('supplier.delete','supplier.restore')").all()).results;assert.equal(events.length,2);assert.ok(events.every(event=>event.actor==='manager@example.com'));
});
test('product Trash preserves source and overrides, sync never resurrects, restore stays draft',async t=>{
 const a=await imported(t),path=`/api/admin/products/${a.product.id}`;
 await a.call(path,'PATCH',{published:true,title:'Saved copy',markupValue:5000});
 assert.equal((await a.call(path,'DELETE',{confirm:'yes'})).response.status,400);
 const deleted=await a.call(path,'DELETE',{confirm:true});assert.equal(deleted.response.status,200);assert.equal(deleted.data.deleted,true);
 assert.equal((await a.call('/api/admin/products')).data.items.length,0);let trash=(await a.call('/api/admin/products?deleted=1')).data.items;assert.equal(trash.length,1);assert.ok(trash[0].deletedAt);assert.equal(trash[0].published,false);assert.equal(trash[0].title,'Saved copy');
 assert.equal((await a.call(path,'PATCH',{title:'Illegal edit'})).response.status,404);assert.equal((await a.call('/api/products')).data.items.length,0);
 const refresh=await a.call(`/api/admin/suppliers/${a.supplier.id}/import`,'POST',{items:[{...source,title:'Supplier update',costMinor:99999999}]});assert.equal(refresh.response.status,200);assert.deepEqual(refresh.data,{imported:0,skippedDeleted:1});
 trash=(await a.call('/api/admin/products?deleted=1')).data.items;assert.equal(trash[0].source.costMinor,source.costMinor);assert.equal(trash[0].title,'Saved copy');
 const restored=await a.call(path+'/restore','POST',{});assert.equal(restored.response.status,200);assert.equal(restored.data.deletedAt,null);assert.equal(restored.data.published,false);assert.equal(restored.data.overrides.markupValue,5000);assert.equal((await a.call('/api/products')).data.items.length,0);assert.equal((await a.call('/api/admin/products?deleted=1')).data.items.length,0);
 assert.equal((await a.call(path+'/restore','POST',{})).response.status,409);
});
test('connected-supplier discovery honors local Trash by both connection ID and public URL',async t=>{
 const a=await apiReady(t,()=>new Response('unused'));await a.call(`/api/admin/suppliers/${a.supplier.id}`,'DELETE',{confirm:true});
 const original=globalThis.fetch;let connection='12345',publicUrl='demo_shop';
 globalThis.fetch=async(url,options)=>String(url)==='https://backend.mydrop.com.ua/dropshipper/api/dropshipper_vendors'?new Response(JSON.stringify({results:[{id:Number(connection),verified:true,hidden:false,vendor:{name:'Remote name',publicUrl}}]}),{headers:{'Content-Type':'application/json'}}):original(url,options);t.after(()=>{globalThis.fetch=original;});
 for(const changed of ['none','connection','url']){if(changed==='connection'){connection='77777';publicUrl='demo_shop';}if(changed==='url'){connection='12345';publicUrl='different-public-url';}const result=await a.call('/api/admin/suppliers/sync-connected','POST',{});assert.equal(result.response.status,200);assert.equal(result.data.added,0);assert.equal(result.data.updated,0);assert.match(result.data.skipped[0].reason,/кошика/);}
 assert.equal((await a.call('/api/admin/suppliers')).data.items.length,0);assert.equal((await a.call('/api/admin/suppliers?deleted=1')).data.items.length,1);
});
test('selected publication validates every item before atomic write and enforces IDs/limits',async t=>{
 const a=await imported(t);await a.call(`/api/admin/suppliers/${a.supplier.id}/import`,'POST',{items:[{...source,externalId:'invalid-photo',photos:[]}]});
 const products=(await a.call('/api/admin/products')).data.items,invalid=products.find(item=>item.externalId==='invalid-photo');const ids=products.map(item=>item.id);
 const failed=await a.call('/api/admin/products/bulk','POST',{ids,action:'publish'});assert.equal(failed.response.status,400);assert.match(failed.data.error,/cannot be published/);assert.ok((await a.call('/api/admin/products')).data.items.every(item=>!item.published));
 for(const badIds of [[],[a.product.id,a.product.id],Array.from({length:51},(_,i)=>'id-'+i),[null]])assert.equal((await a.call('/api/admin/products/bulk','POST',{ids:badIds,action:'publish'})).response.status,400);
 assert.equal((await a.call('/api/admin/products/bulk','POST',{ids:[a.product.id,'unknown'],action:'publish'})).response.status,404);assert.equal((await a.call('/api/admin/products/bulk','POST',{ids:[a.product.id],action:'unknown'})).response.status,400);
 await a.call(`/api/admin/products/${invalid.id}`,'PATCH',{photos:['https://example.com/fixed.jpg'],title:''});
 assert.equal((await a.call('/api/admin/products/bulk','POST',{ids,action:'publish'})).response.status,400);assert.ok((await a.call('/api/admin/products')).data.items.every(item=>!item.published));
 await a.call(`/api/admin/products/${invalid.id}`,'PATCH',{title:'Valid title'});
 assert.deepEqual((await a.call('/api/admin/products/bulk','POST',{ids,action:'publish'})).data,{updated:2,action:'publish'});assert.equal((await a.call('/api/products')).data.items.length,2);
 assert.deepEqual((await a.call('/api/admin/products/bulk','POST',{ids,action:'unpublish'})).data,{updated:2,action:'unpublish'});assert.equal((await a.call('/api/products')).data.items.length,0);
});
test('bulk deletion and restore are confirmed and atomic, reject mixed states and deleted suppliers',async t=>{
 const a=await imported(t);await a.call(`/api/admin/suppliers/${a.supplier.id}/import`,'POST',{items:[{...source,externalId:'second'}]});const ids=(await a.call('/api/admin/products')).data.items.map(item=>item.id);
 assert.equal((await a.call('/api/admin/products/bulk','POST',{ids,action:'delete'})).response.status,400);assert.equal((await a.call('/api/admin/products')).data.items.length,2);
 assert.equal((await a.call('/api/admin/products/bulk','POST',{ids,action:'delete',confirm:true})).data.updated,2);assert.equal((await a.call('/api/admin/products?deleted=1')).data.items.length,2);
 assert.equal((await a.call(`/api/admin/products/${ids[0]}/restore`,'POST',{})).response.status,200);
 assert.equal((await a.call('/api/admin/products/bulk','POST',{ids,action:'restore'})).response.status,409);assert.equal((await a.call('/api/admin/products?deleted=1')).data.items.length,1);
 await a.call(`/api/admin/suppliers/${a.supplier.id}`,'DELETE',{confirm:true});assert.equal((await a.call('/api/admin/products/bulk','POST',{ids:[ids[1]],action:'restore'})).response.status,409);assert.equal((await a.call(`/api/admin/products/${ids[1]}/restore`,'POST',{})).response.status,404);
 await a.call(`/api/admin/suppliers/${a.supplier.id}/restore`,'POST',{});assert.equal((await a.call('/api/admin/products/bulk','POST',{ids:[ids[1]],action:'restore'})).data.updated,1);assert.ok((await a.call('/api/admin/products')).data.items.every(item=>!item.published));
});
test('lifecycle endpoints require Access authorization and same-origin mutations',async t=>{
 const a=await imported(t),productPath=`/api/admin/products/${a.product.id}`,supplierPath=`/api/admin/suppliers/${a.supplier.id}`;
 for(const [path,method,body] of [[productPath,'DELETE',{confirm:true}],[supplierPath,'DELETE',{confirm:true}],['/api/admin/products/bulk','POST',{ids:[a.product.id],action:'delete',confirm:true}]])assert.equal((await a.call(path,method,body,{Origin:'https://evil.test'})).response.status,403);
 a.setToken('');for(const [path,method,body] of [[productPath,'DELETE',{confirm:true}],[supplierPath,'DELETE',{confirm:true}],[productPath+'/restore','POST',{}],[supplierPath+'/restore','POST',{}],['/api/admin/products/bulk','POST',{ids:[a.product.id],action:'delete',confirm:true}]])assert.equal((await a.call(path,method,body)).response.status,401);
});


test('DELETE on a restore-only product URL never deletes the active product',async t=>{
 const a=await imported(t);
 assert.equal((await a.call(`/api/admin/products/${a.product.id}/restore`,'DELETE',{confirm:true})).response.status,405);
 assert.equal((await a.call('/api/admin/products')).data.items.length,1);assert.equal((await a.call('/api/admin/products?deleted=1')).data.items.length,0);
});

test('recognition drafts preview activation rollback and selected apply preserve catalog and audit version',async t=>{
 const a=await imported(t);const initial=(await a.call('/api/admin/recognition')).data;assert.equal(initial.activeVersion,'seed-v1');
 await a.call(`/api/admin/products/${a.product.id}`,'PATCH',{published:true});
 const settings=structuredClone(initial.defaults);settings.categoryRules.push({id:'coat-custom',text:'Test Coat',mode:'contains',supplierId:a.supplier.id,categoryId:'coats-vests',priority:999,specificity:10,enabled:true});
 settings.brands.push({id:'test-label',name:'Test Label',enabled:true,aliases:[{id:'test-alias',text:'Test',mode:'word',supplierId:a.supplier.id,priority:900,specificity:1,enabled:true}]});
 const saved=await a.call('/api/admin/recognition/drafts','POST',{settings});assert.equal(saved.response.status,200,JSON.stringify(saved.data));const versionId=saved.data.id;
 const before=(await a.call('/api/admin/products')).data.items[0];assert.equal(before.brand,null);
 const preview=(await a.call('/api/admin/recognition/preview','POST',{versionId})).data;assert.equal(preview.total,1);assert.equal(preview.changed,1);assert.equal(preview.publishedAffected,1);assert.equal(preview.samples[0].after.brand,'Test Label');
 assert.equal((await a.call('/api/admin/products')).data.items[0].brand,null);
 assert.equal((await a.call('/api/admin/recognition/activate','POST',{versionId,token:preview.token})).response.status,400);
 assert.equal((await a.call('/api/admin/recognition/activate','POST',{versionId,token:preview.token,confirm:true})).response.status,200);
 const after=(await a.call('/api/admin/products')).data.items[0];assert.equal(after.brand,'Test Label');assert.equal(after.categoryId,'coats-vests');assert.deepEqual(after.source,before.source);assert.deepEqual(after.overrides,before.overrides);assert.equal(after.priceMinor,before.priceMinor);assert.equal(after.published,true);
 const publicProduct=(await a.call('/api/products')).data.items[0];assert.equal(publicProduct.brand,'Test Label');assert.ok(!(await a.call(`/products/${after.slug}`)).data.includes('classificationSuggestion'));
 await a.call(`/api/admin/suppliers/${a.supplier.id}`,'PATCH',{name:'Renamed'});assert.equal((await a.call('/api/admin/products')).data.items[0].brand,'Test Label');
 const selected=(await a.call('/api/admin/recognition/preview','POST',{versionId,ids:[after.id]})).data;assert.equal(selected.samples.length,1);
 assert.equal((await a.call('/api/admin/recognition/apply','POST',{versionId,ids:[after.id],token:selected.token,confirm:true})).response.status,200);
 const evidence=await a.env.DB.prepare('SELECT * FROM recognition_applications WHERE product_id=?').bind(after.id).first();assert.equal(evidence.version_id,versionId);assert.equal(evidence.actor,'manager@example.com');const history=(await a.call('/api/admin/recognition')).data.applications;assert.equal(history[0].versionId,versionId);assert.equal(history[0].evidence.brand,'Test Label');
 const applied=(await a.call('/api/admin/products')).data.items[0];assert.deepEqual(applied.overrides,{...after.overrides,categoryId:'coats-vests',brand:'Test Label'});assert.deepEqual(applied.source,after.source);
 const rollback=(await a.call('/api/admin/recognition/preview','POST',{versionId:'seed-v1'})).data;assert.equal((await a.call('/api/admin/recognition/activate','POST',{versionId:'seed-v1',token:rollback.token,confirm:true})).response.status,200);assert.equal((await a.call('/api/admin/products')).data.items[0].brand,'Test Label');await a.call(`/api/admin/products/${after.id}`,'PATCH',{categoryId:null,brand:null});assert.equal((await a.call('/api/admin/products')).data.items[0].brand,null);
});
test('recognition rejects unsafe settings stale previews CSRF and missing selections without writes',async t=>{
 const a=await imported(t),settings=(await a.call('/api/admin/recognition')).data.defaults;
 for(const invalid of [{...settings,categoryRules:[{id:'bad',categoryId:'missing',text:'x',mode:'regex',supplierId:null,priority:0,specificity:0,enabled:true}]},{...settings,brands:[{id:'x',name:'x',enabled:true,aliases:[{id:'a',text:'x',mode:'regex',supplierId:null,priority:0,specificity:0,enabled:true}]}]}])assert.equal((await a.call('/api/admin/recognition/drafts','POST',{settings:invalid})).response.status,400);
 const versionId=(await a.call('/api/admin/recognition/drafts','POST',{settings})).data.id;
 const p=(await a.call('/api/admin/recognition/preview','POST',{versionId})).data;
 await a.call(`/api/admin/products/${a.product.id}`,'PATCH',{brand:'',categoryId:'shirts',title:'Manual'});
 assert.equal((await a.call('/api/admin/recognition/activate','POST',{versionId,token:p.token,confirm:true})).response.status,409);
 const fresh=(await a.call('/api/admin/recognition/preview','POST',{versionId})).data;assert.equal(fresh.changed,0);
 assert.equal((await a.call('/api/admin/recognition/activate','POST',{versionId,token:fresh.token,confirm:true})).response.status,200);
 assert.equal((await a.call('/api/admin/recognition/preview','POST',{versionId,ids:[a.product.id,'missing']})).response.status,409);
 assert.equal((await a.call('/api/admin/recognition/preview','POST',{versionId,ids:Array(51).fill(a.product.id)})).response.status,400);
 const selected=(await a.call('/api/admin/recognition/preview','POST',{versionId,ids:[a.product.id]})).data;
 const input={versionId,ids:[a.product.id],token:selected.token,confirm:true};assert.equal((await a.call('/api/admin/recognition/apply','POST',input,{Origin:'https://evil.test'})).response.status,403);
 assert.equal((await a.call('/api/admin/recognition/apply','POST',input)).response.status,200);
 const item=(await a.call('/api/admin/products')).data.items[0];assert.equal(item.brand,'');assert.equal(item.categoryId,'shirts');assert.equal(item.title,'Manual');
 a.setToken('');assert.equal((await a.call('/api/admin/recognition')).response.status,401);assert.equal((await a.call('/api/admin/recognition/activate','POST',input)).response.status,401);
});

test('candidate selected apply changes only inferred fields without global activation and token replay is rejected',async t=>{
 const a=await imported(t),state=(await a.call('/api/admin/recognition')).data,settings=state.defaults;settings.categoryRules.push({id:'selected-coat',categoryId:'coats-vests',text:'Test Coat',mode:'exact',supplierId:null,priority:1000,specificity:1000,enabled:true});settings.brands.push({id:'selected-brand',name:'Selected Brand',enabled:true,aliases:[{id:'selected-alias',text:'Test',mode:'word',supplierId:null,priority:999,specificity:1000,enabled:true}]});
 const versionId=(await a.call('/api/admin/recognition/drafts','POST',{settings})).data.id,preview=(await a.call('/api/admin/recognition/preview','POST',{versionId,ids:[a.product.id]})).data;assert.equal(preview.changed,1);assert.equal(preview.samples[0].after.brand,'Selected Brand');
 const body={versionId,ids:[a.product.id],token:preview.token,confirm:true};const before=(await a.call('/api/admin/products')).data.items[0];assert.equal((await a.call('/api/admin/recognition/apply','POST',body)).response.status,200);assert.equal((await a.call('/api/admin/recognition/apply','POST',body)).response.status,409);
 const after=(await a.call('/api/admin/products')).data.items[0];assert.equal(after.brand,'Selected Brand');assert.equal(after.categoryId,'coats-vests');assert.equal(after.title,before.title);assert.equal(after.priceMinor,before.priceMinor);assert.equal(after.published,before.published);assert.deepEqual(after.source,before.source);assert.equal((await a.call('/api/admin/recognition')).data.activeVersion,'seed-v1');
 // A race consuming the preview after the preflight check must roll back writes.
 const next=(await a.call('/api/admin/recognition/preview','POST',{versionId,ids:[a.product.id]})).data,original=a.env.DB.batch;a.env.DB.batch=async statements=>{if(statements[0]?.sql.includes('recognition_guards'))await a.env.DB.prepare('DELETE FROM recognition_previews WHERE token=?').bind(next.token).run();return original(statements);};
 assert.equal((await a.call('/api/admin/recognition/apply','POST',{...body,token:next.token})).response.status,409);assert.deepEqual((await a.call('/api/admin/products')).data.items[0].overrides,after.overrides);
});

async function categoryChange(a,operation){
 const preview=await a.call('/api/admin/taxonomy/preview','POST',{operation});assert.equal(preview.response.status,200,JSON.stringify(preview.data));
 const result=await a.call('/api/admin/taxonomy/apply','POST',{token:preview.data.token,confirm:true});assert.equal(result.response.status,200,JSON.stringify(result.data));return{preview:preview.data,result:result.data};
}
test('persisted nested categories are seeded, selectable at every level and shared by public projection, rules and SEO',async t=>{
 const a=await imported(t),initial=(await a.call('/api/taxonomy')).data;assert.equal(initial.revision,1);assert.ok(initial.options.some(n=>n.id==='clothing'));assert.ok(!JSON.stringify(initial).includes('productReferences'));
 await categoryChange(a,{type:'create',id:'custom-root',label:'Власний каталог',parentId:null});
 await categoryChange(a,{type:'create',id:'constructor',label:'Безпечний ID',parentId:null});
 assert.equal((await a.call(`/api/admin/products/${a.product.id}`,'PATCH',{categoryId:'constructor'})).data.categoryId,'constructor');
 await categoryChange(a,{type:'create',id:'custom-child',label:'Для прогулянок',parentId:'custom-root'});
 await categoryChange(a,{type:'create',id:'custom-grandchild',label:'Дощовики',parentId:'custom-child'});
 const taxonomy=(await a.call('/api/taxonomy')).data;assert.deepEqual(taxonomy.options.find(n=>n.id==='custom-grandchild').path,['Власний каталог','Для прогулянок','Дощовики']);
 assert.equal((await a.call(`/api/admin/products/${a.product.id}`,'PATCH',{categoryId:'custom-child',published:true})).response.status,200);
 assert.equal((await a.call(`/api/admin/products/${a.product.id}`,'PATCH',{categoryId:'custom-grandchild'})).response.status,200);
 const item=(await a.call('/api/products')).data.items[0];assert.equal(item.categoryId,'custom-grandchild');assert.deepEqual(item.categoryPath,['Власний каталог','Для прогулянок','Дощовики']);assert.ok((await a.call(`/products/${item.slug}`)).data.includes('Дощовики'));
 const settings=(await a.call('/api/admin/recognition')).data.defaults;settings.categoryRules.push({id:'custom-recognition',categoryId:'custom-child',text:'Test Coat',mode:'exact',supplierId:null,priority:1000,specificity:1000,enabled:true});
 const draft=await a.call('/api/admin/recognition/drafts','POST',{settings});assert.equal(draft.response.status,200,JSON.stringify(draft.data));
 await a.call(`/api/admin/products/${a.product.id}`,'PATCH',{categoryId:null});const preview=(await a.call('/api/admin/recognition/preview','POST',{versionId:draft.data.id})).data;assert.equal(preview.samples[0].after.categoryId,'custom-child');
});
test('category rename move and reorder preserve IDs/manual data and previews cover descendant publication impact',async t=>{
 const a=await imported(t);await categoryChange(a,{type:'create',id:'parent-test',label:'Parent',parentId:null});await categoryChange(a,{type:'create',id:'child-test',label:'Child',parentId:'parent-test'});
 await a.call(`/api/admin/products/${a.product.id}`,'PATCH',{categoryId:'child-test',title:'Curated',brand:'',published:true,markupValue:300});
 const storedBefore=await a.env.DB.prepare('SELECT * FROM products WHERE id=?').bind(a.product.id).first();
 const preview=(await a.call('/api/admin/taxonomy/preview','POST',{operation:{type:'update',id:'parent-test',label:'Renamed parent',parentId:'clothing',position:0}})).data;
 assert.equal(preview.impact.changed,1);assert.equal(preview.impact.publishedAffected,1);assert.deepEqual(preview.impact.samples[0].after.categoryPath,['Одяг','Renamed parent','Child']);
 assert.deepEqual((await a.call('/api/products')).data.items[0].categoryPath,['Parent','Child']);
 await a.call('/api/admin/taxonomy/apply','POST',{token:preview.token,confirm:true});
 const storedAfter=await a.env.DB.prepare('SELECT * FROM products WHERE id=?').bind(a.product.id).first();assert.deepEqual(storedAfter,storedBefore);
 const item=(await a.call('/api/products')).data.items[0];assert.equal(item.categoryId,'child-test');assert.equal(item.brand,'');assert.equal(item.priceMinor,10301);assert.deepEqual(item.categoryPath,['Одяг','Renamed parent','Child']);
 await categoryChange(a,{type:'update',id:'parent-test',position:2});const nodes=(await a.call('/api/taxonomy')).data.nodes.filter(n=>n.parentId==='clothing');assert.equal(nodes.find(n=>n.id==='parent-test').position,2);
});
test('category deletion explicitly redirects retained products and immutable recognition versions without source rewrites or orphan IDs',async t=>{
 const a=await imported(t);await a.call(`/api/admin/products/${a.product.id}`,'PATCH',{categoryId:'jackets',published:true});
 const storedBefore=await a.env.DB.prepare('SELECT * FROM products WHERE id=?').bind(a.product.id).first(),versionBefore=await a.env.DB.prepare('SELECT settings_json FROM recognition_versions WHERE id=?').bind('seed-v1').first();
 const preview=(await a.call('/api/admin/taxonomy/preview','POST',{operation:{type:'delete',id:'jackets',replacementId:'shirts'}})).data;assert.equal(preview.impact.productReferences,1);assert.ok(preview.impact.ruleReferences>0);assert.equal(preview.impact.publishedAffected,1);
 assert.equal((await a.call('/api/admin/taxonomy/apply','POST',{token:preview.token,confirm:true})).response.status,200);
 assert.equal((await a.call('/api/products')).data.items[0].categoryId,'shirts');assert.deepEqual(await a.env.DB.prepare('SELECT * FROM products WHERE id=?').bind(a.product.id).first(),storedBefore);assert.deepEqual(await a.env.DB.prepare('SELECT settings_json FROM recognition_versions WHERE id=?').bind('seed-v1').first(),versionBefore);
 const recognition=(await a.call('/api/admin/recognition')).data;assert.equal(recognition.versions.find(v=>v.id==='seed-v1').settings.categoryRules.find(r=>r.id==='category-23').categoryId,'shirts');
 const rollback=(await a.call('/api/admin/recognition/preview','POST',{versionId:'seed-v1'})).data;assert.equal((await a.call('/api/admin/recognition/activate','POST',{versionId:'seed-v1',token:rollback.token,confirm:true})).response.status,200);
 assert.equal((await a.call('/api/admin/taxonomy/preview','POST',{operation:{type:'create',id:'jackets',label:'Reused',parentId:null}})).response.status,409);
 await categoryChange(a,{type:'delete',id:'shirts',replacementId:'unclassified'});assert.equal((await a.call('/api/products')).data.items[0].categoryId,'unclassified');
});
test('taxonomy rejects cycles excessive depth duplicate siblings invalid deletion and unauthorized CSRF without mutation',async t=>{
 const a=await imported(t),initial=(await a.call('/api/taxonomy')).data;
 for(const operation of [{type:'update',id:'clothing',parentId:'jackets'},{type:'create',id:'duplicate',label:'Куртки',parentId:'outerwear'},{type:'delete',id:'clothing',replacementId:'unclassified'},{type:'delete',id:'jackets',replacementId:'missing'},{type:'update',id:'unclassified',label:'No'},{type:'create',id:'invalid',label:'A',parentId:'missing'}])assert.ok((await a.call('/api/admin/taxonomy/preview','POST',{operation})).response.status>=400);
 assert.equal((await a.call('/api/taxonomy')).data.revision,initial.revision);
 for(let i=0;i<8;i++)await categoryChange(a,{type:'create',id:`depth-${i}`,label:`Depth ${i}`,parentId:i?`depth-${i-1}`:null});
 assert.equal((await a.call('/api/admin/taxonomy/preview','POST',{operation:{type:'create',id:'too-deep',label:'No',parentId:'depth-7'}})).response.status,400);
 const body={operation:{type:'create',id:'secured',label:'No',parentId:null}};assert.equal((await a.call('/api/admin/taxonomy/preview','POST',body,{Origin:'https://evil.test'})).response.status,403);
 a.setToken('');assert.equal((await a.call('/api/admin/taxonomy')).response.status,401);assert.equal((await a.call('/api/admin/taxonomy/preview','POST',body)).response.status,401);assert.equal((await a.call('/api/admin/taxonomy/apply','POST',{token:'x',confirm:true})).response.status,401);
});
test('taxonomy and recognition previews invalidate on catalog, settings and taxonomy changes and guard concurrent replay',async t=>{
 const a=await imported(t),operation={type:'create',id:'guarded',label:'Guarded',parentId:null};
 const p=(await a.call('/api/admin/taxonomy/preview','POST',{operation})).data;await a.call(`/api/admin/products/${a.product.id}`,'PATCH',{brand:'Changed'});assert.equal((await a.call('/api/admin/taxonomy/apply','POST',{token:p.token,confirm:true})).response.status,409);
 const p2=(await a.call('/api/admin/taxonomy/preview','POST',{operation})).data;await a.call('/api/admin/recognition/drafts','POST',{settings:(await a.call('/api/admin/recognition')).data.defaults});assert.equal((await a.call('/api/admin/taxonomy/apply','POST',{token:p2.token,confirm:true})).response.status,409);
 const rec=(await a.call('/api/admin/recognition/preview','POST',{versionId:'seed-v1'})).data;
 const fresh=(await a.call('/api/admin/taxonomy/preview','POST',{operation})).data;assert.equal((await a.call('/api/admin/taxonomy/apply','POST',{token:fresh.token})).response.status,400);
 const replies=await Promise.all([a.call('/api/admin/taxonomy/apply','POST',{token:fresh.token,confirm:true}),a.call('/api/admin/taxonomy/apply','POST',{token:fresh.token,confirm:true})]);assert.deepEqual(replies.map(r=>r.response.status).sort(),[200,409]);
 assert.equal((await a.call('/api/admin/recognition/activate','POST',{versionId:'seed-v1',token:rec.token,confirm:true})).response.status,409);
 assert.equal((await a.env.DB.prepare("SELECT COUNT(*) AS total FROM audit_events WHERE action='taxonomy.create'").first()).total,1);
});

test('cutout storage retains original bytes, survives reimport and gates public media',async t=>{
 const a=await imported(t),images=new Map(),png=new Uint8Array(Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScLbtAAAAABJRU5ErkJggg==','base64'));
 a.env.MEDIA={async put(key,bytes,meta){images.set(key,{bytes:new Uint8Array(bytes),...meta});},async get(key){const v=images.get(key);return v?{...v,body:v.bytes}:null;},async head(key){return images.get(key)||null;}};
 const sourceUrl='https://backend.mydrop.com.ua/vendor/products/uploads/synthetic.png';
 await a.call(`/api/admin/products/${a.product.id}`,'PATCH',{photos:[sourceUrl]});
 const originalFetch=globalThis.fetch;globalThis.fetch=async(url,options)=>String(url)===sourceUrl?new Response(png):originalFetch(url,options);
 t.after(()=>{globalThis.fetch=originalFetch;});
 const hash=Buffer.from(await crypto.subtle.digest('SHA-256',png)).toString('hex');
 async function upload({origin='https://catalog.test',token=true,originalHash=hash,source=sourceUrl}={}){
  const form=new FormData();form.append('sourceUrl',source);form.append('originalHash',originalHash);form.append('file',new Blob([png],{type:'image/png'}),'cutout.png');
  return worker.fetch(new Request(`https://catalog.test/api/admin/products/${a.product.id}/cutout`,{method:'POST',headers:{Origin:origin,...(token?{Cookie:'CF_Authorization='+await signedToken()}: {})},body:form}),a.env);
 }
 assert.equal((await upload({token:false})).status,401);assert.equal((await upload({origin:'https://evil.test'})).status,403);
 assert.equal((await upload({source:'http://127.0.0.1/private'})).status,400);assert.equal(images.size,0);
 assert.equal((await upload({originalHash:'changed'})).status,409);assert.equal(images.size,0);
 const response=await upload();assert.equal(response.status,201);const saved=await response.json();assert.equal(images.size,2);
 assert.deepEqual(images.get(saved.originalUrl.slice(7)).bytes,png);
 assert.equal((await worker.fetch(new Request('https://catalog.test'+saved.url),a.env)).status,404);
 await a.call(`/api/admin/products/${a.product.id}`,'PATCH',{photos:[saved.url]});
 const originals=await a.call(`/api/admin/products/${a.product.id}/image-originals`);assert.equal(originals.data.originals[saved.url],saved.originalUrl);
 await a.call(`/api/admin/suppliers/${a.supplier.id}/import`,'POST',{items:[{...source,title:'Synthetic changed source',photos:['https://example.com/new.jpg']}]});
 assert.deepEqual((await a.call('/api/admin/products')).data.items[0].photos,[saved.url]);
 await a.call(`/api/admin/products/${a.product.id}`,'PATCH',{published:true});
 assert.equal((await worker.fetch(new Request('https://catalog.test'+saved.url),a.env)).status,200);
 assert.equal((await worker.fetch(new Request('https://catalog.test'+saved.originalUrl),a.env)).status,404);
 await a.call(`/api/admin/products/${a.product.id}`,'PATCH',{photos:[saved.originalUrl]});
 assert.equal((await worker.fetch(new Request('https://catalog.test'+saved.originalUrl),a.env)).status,200);
 const publicData=JSON.stringify((await a.call('/api/products')).data);assert.ok(!publicData.includes('originalUrl'));assert.ok(!publicData.includes('sourceUrl'));
});

test('supplier image proxy rejects SSRF, redirects, invalid bytes and oversized responses',async t=>{
 const {supplierImageUrl,retrieveProductImage,IMAGE_LIMIT}=await import('../../apps/api/src/image-processing.js');
 for(const url of ['http://backend.mydrop.com.ua/vendor/products/uploads/a.jpg','https://backend.mydrop.com.ua.evil.test/vendor/products/uploads/a.jpg','https://backend.mydrop.com.ua/private','https://backend.mydrop.com.ua/vendor/products/uploads/a.jpg?redirect=evil','https://user:pass@backend.mydrop.com.ua/vendor/products/uploads/a.jpg','https://backend.mydrop.com.ua:444/vendor/products/uploads/a.jpg'])assert.throws(()=>supplierImageUrl(url));
 const url='https://backend.mydrop.com.ua/vendor/products/uploads/synthetic.jpg',row={source_json:JSON.stringify({photos:[url]}),overrides_json:'{}'};
 const previous=globalThis.fetch;t.after(()=>{globalThis.fetch=previous;});
 globalThis.fetch=async(_url,options)=>{assert.equal(options.redirect,'manual');return new Response(null,{status:302,headers:{Location:'http://127.0.0.1'}});};
 await assert.rejects(retrieveProductImage(row,url,{}),/refused/);
 globalThis.fetch=async()=>new Response('<html>blocked</html>');await assert.rejects(retrieveProductImage(row,url,{}),/Only JPEG/);
 globalThis.fetch=async()=>new Response('huge',{headers:{'Content-Length':String(IMAGE_LIMIT+1)}});await assert.rejects(retrieveProductImage(row,url,{}),/20 MB/);
 await assert.rejects(retrieveProductImage(row,'https://example.com/unrelated',{}),/does not belong/);
});

const KEY='9876543210123456789',PID='4455667',LINK=`https://easydrop.one/prom-export?key=${KEY}&pid=${PID}`;
test('EasyDrop link validator accepts only the exact link shape and rebuilds the fetch URL',()=>{
 assert.deepEqual(parseEasyDropLink(LINK),{key:KEY,pid:PID});assert.deepEqual(parseEasyDropLink(`https://easydrop.one/prom-export?pid=${PID}&key=${KEY}`),{key:KEY,pid:PID});
 assert.equal(buildEasyDropFeedUrl({key:KEY,pid:PID}),LINK);assert.throws(()=>buildEasyDropFeedUrl({key:'1&x=2',pid:PID}));
 const bad=['','http://easydrop.one/prom-export?key=1&pid=2','https://www.easydrop.one/prom-export?key=1&pid=2','https://easydrop.one.evil.test/prom-export?key=1&pid=2','https://evil.test/prom-export?key=1&pid=2',
  'https://easydrop.one:8443/prom-export?key=1&pid=2','https://u:p@easydrop.one/prom-export?key=1&pid=2','https://easydrop.one@evil.test/prom-export?key=1&pid=2','https://easydrop.one/prom-export/?key=1&pid=2','https://easydrop.one/prom-export2?key=1&pid=2','https://easydrop.one/other?key=1&pid=2',
  'https://easydrop.one/prom-export?key=1&pid=2#x','https://easydrop.one/prom-export?key=1&pid=2#','https://easydrop.one/prom-export?pid=2','https://easydrop.one/prom-export?key=1&','https://easydrop.one/prom-export?key=1&pid=','https://easydrop.one/prom-export?key=1#x','https://easydrop.one/prom-export','https://easydrop.one/prom-export?',
  'https://easydrop.one/prom-export?key=1&pid=2&x=3','https://easydrop.one/prom-export?key=1&key=3&pid=2','https://easydrop.one/prom-export?key=1&pid=2&pid=2','https://easydrop.one/prom-export?key=1&&pid=2','https://easydrop.one/prom-export?key=1&pid=2&',
  'https://easydrop.one/prom-export?key=abc&pid=2','https://easydrop.one/prom-export?key=1a&pid=2','https://easydrop.one/prom-export?key=-1&pid=2','https://easydrop.one/prom-export?key=1.5&pid=2','https://easydrop.one/prom-export?key=&pid=2',
  'https://easydrop.one/prom-export?key=%31&pid=2','https://easydrop.one/prom-export?key=1&pid=2%0a','https://easydrop.one/prom-export?key=1&pid=2 ',' https://easydrop.one/prom-export?key=1&pid=2','https://easydrop.one/prom-export?key=1&pid=2\n','https://easydrop.one/prom-export?key=1 &pid=2','https://easydrop.one/prom-export?key=1\t&pid=2',
  'https:\\\\easydrop.one\\prom-export?key=1&pid=2','https://easydrop.one/prom-export?key=1&pid=2;x=1','https://easydrop.one/prom-export?Key=1&pid=2','HTTPS://EASYDROP.ONE/prom-export?key=1&pid=2','https://easydrop.one/prom-export?key='+'1'.repeat(31)+'&pid=2',
  'https://easydrop.one./prom-export?key=1&pid=2',null,undefined,12,{},['x']];
 for(const value of bad)assert.throws(()=>parseEasyDropLink(value),{message:/EasyDrop link/},String(value));
 try{parseEasyDropLink(`https://evil.test/prom-export?key=${KEY}&pid=${PID}`);assert.fail();}catch(error){assert.ok(!error.message.includes(KEY));}
 assert.deepEqual(parseEasyDropLink(`https://easydrop.one/prom-export?key=${KEY}`),{key:KEY,pid:null});assert.equal(buildEasyDropFeedUrl({key:KEY,pid:null}),`https://easydrop.one/prom-export?key=${KEY}`);
 assert.deepEqual(parseEasyDropLink('https://easydrop.one/prom-export?key=0&pid=007'),{key:'0',pid:'007'});assert.deepEqual(parseEasyDropLink('https://easydrop.one/prom-export?key='+'0'.repeat(30)+'&pid=2'),{key:'0'.repeat(30),pid:'2'});
 assert.equal(keyLast4(KEY),'6789');assert.equal(keyLast4('1234567'),null);
});
async function easydropApp(t) {
 const a=await loggedIn(t);const created=await a.call('/api/admin/suppliers','POST',{name:'ED Shop',provider:'easydrop',feedUrl:LINK});assert.equal(created.response.status,201);return{...a,created:created.data};
}
const leaks=value=>JSON.stringify(value).includes(KEY);
test('EasyDrop supplier creation stores the link privately and exposes only masked feed state',async t=>{
 const a=await easydropApp(t),s=a.created;
 assert.equal(s.provider,'easydrop');assert.equal(s.url,`easydrop:${s.id}`);assert.equal(s.connectionId,null);assert.equal(s.feed.configured,true);assert.equal(s.feed.keyLast4,'6789');assert.ok(!leaks(s)&&!JSON.stringify(s).includes(PID));
 const list=await a.call('/api/admin/suppliers');assert.ok(!leaks(list.data)&&!JSON.stringify(list.data).includes(PID));
 const row=a.env.DB.prepare?await a.env.DB.prepare('SELECT provider,feed_key,feed_pid FROM suppliers WHERE id=?').bind(s.id).first():null;assert.deepEqual({...row},{provider:'easydrop',feed_key:KEY,feed_pid:PID});
 const mydrop=await a.call('/api/admin/suppliers','POST',{name:'Lorem Supply',url:'https://mydrop.com.ua/demo_shop'});assert.equal(mydrop.data.provider,'mydrop');assert.equal(mydrop.data.feed,null);
 const audits=await a.env.DB.prepare('SELECT * FROM audit_events').all();assert.ok(!leaks(audits.results)&&!JSON.stringify(audits.results).includes(PID));
 assert.ok(audits.results.some(r=>r.action==='supplier.create'&&r.resource_id===s.id));
});
test('EasyDrop creation validates input, rejects duplicate keys and keeps secrets out of errors',async t=>{
 const a=await easydropApp(t),post=body=>a.call('/api/admin/suppliers','POST',body);
 for(const body of [{name:'X',provider:'easydrop'},{name:'X',provider:'easydrop',feedUrl:`https://evil.test/prom-export?key=${KEY}&pid=${PID}`},{name:'X',provider:'easydrop',feedUrl:LINK,url:'https://mydrop.com.ua/x'},{name:'X',provider:'easydrop',feedUrl:LINK,connectionId:5},{name:'X',provider:'other',feedUrl:LINK},{name:'X',url:'https://mydrop.com.ua/x',feedUrl:LINK}]) {
  const r=await post(body);assert.equal(r.response.status,400);assert.ok(!leaks(r.data));
 }
 const dup=await post({name:'Copy',provider:'easydrop',feedUrl:`https://easydrop.one/prom-export?pid=99&key=${KEY}`});assert.equal(dup.response.status,409);assert.ok(!leaks(dup.data));
 const other=await post({name:'Second',provider:'easydrop',feedUrl:`https://easydrop.one/prom-export?key=111222333444&pid=${PID}`});assert.equal(other.response.status,201);
 assert.equal((await a.call('/api/admin/suppliers')).data.items.length,2);
 // Deleted supplier keeps the key reserved; a race past the pre-check still maps to 409.
 await a.call(`/api/admin/suppliers/${a.created.id}`,'DELETE',{confirm:true});assert.equal((await post({name:'Again',provider:'easydrop',feedUrl:LINK})).response.status,409);
 await assert.rejects(a.env.DB.batch([a.env.DB.prepare("INSERT INTO suppliers(id,name,url,created_at,provider,feed_key) VALUES('z','z','easydrop:z','t','easydrop',?)").bind(KEY)]),/UNIQUE/);
 // The same key digits under MyDrop do not collide: uniqueness is provider-scoped.
 await a.env.DB.batch([a.env.DB.prepare("INSERT INTO suppliers(id,name,url,created_at,provider,feed_key) VALUES('m','m','https://mydrop.com.ua/m','t','mydrop',?)").bind(KEY)]);
});
test('EasyDrop link replacement is audited without the value, provider is immutable and MyDrop fields stay separate',async t=>{
 const a=await easydropApp(t),path=`/api/admin/suppliers/${a.created.id}`,NEW='555666777888999',NEWLINK=`https://easydrop.one/prom-export?key=${NEW}&pid=${PID}`;
 const r=await a.call(path,'PATCH',{feedUrl:NEWLINK});assert.equal(r.response.status,200);assert.equal(r.data.feed.keyLast4,'8999');assert.ok(!leaks(r.data)&&!JSON.stringify(r.data).includes(NEW));
 assert.equal((await a.env.DB.prepare('SELECT feed_key FROM suppliers WHERE id=?').bind(a.created.id).first()).feed_key,NEW);
 const audits=await a.env.DB.prepare('SELECT * FROM audit_events').all();assert.ok(audits.results.some(x=>x.action==='supplier.link.update'));assert.ok(!JSON.stringify(audits.results).includes(NEW)&&!leaks(audits.results));
 for(const body of [{provider:'mydrop'},{provider:'easydrop'},{connectionId:12},{url:'https://mydrop.com.ua/x'},{feedUrl:'https://easydrop.one/prom-export?key=1&pid=2&x=3'}])assert.equal((await a.call(path,'PATCH',body)).response.status,400);
 assert.equal((await a.env.DB.prepare('SELECT feed_key FROM suppliers WHERE id=?').bind(a.created.id).first()).feed_key,NEW);
 const rename=await a.call(path,'PATCH',{name:'Renamed',enabled:false});assert.equal(rename.data.name,'Renamed');assert.equal(rename.data.feed.keyLast4,'8999');
 const my=(await a.call('/api/admin/suppliers','POST',{name:'Lorem Supply',url:'https://mydrop.com.ua/demo_shop'})).data;
 assert.equal((await a.call(`/api/admin/suppliers/${my.id}`,'PATCH',{feedUrl:LINK})).response.status,400);assert.equal((await a.call(`/api/admin/suppliers/${my.id}`,'PATCH',{provider:'easydrop'})).response.status,400);
 assert.equal((await a.call('/api/admin/suppliers','POST',{name:'Bad',url:'easydrop:abc'})).response.status,400);
});
test('EasyDrop link management follows supplier authorization and CSRF rules',async t=>{
 const a=await easydropApp(t);a.setToken('');
 assert.equal((await a.call('/api/admin/suppliers','POST',{name:'N',provider:'easydrop',feedUrl:LINK})).response.status,401);
 a.setToken(await signedToken());
 assert.equal((await a.call('/api/admin/suppliers','POST',{name:'N',provider:'easydrop',feedUrl:'https://easydrop.one/prom-export?key=5&pid=5'},{Origin:'https://evil.test'})).response.status,403);
 assert.equal((await a.call(`/api/admin/suppliers/${a.created.id}`,'PATCH',{feedUrl:'https://easydrop.one/prom-export?key=5&pid=5'},{Origin:'https://evil.test'})).response.status,403);
});
test('EasyDrop sync is wired: an unreachable feed fails cleanly without leaking the link (full coverage in easydrop-sync.test.js)',async t=>{
 const a=await easydropApp(t),original=globalThis.fetch;const prior=globalThis.fetch;globalThis.fetch=async(url,o)=>String(url).startsWith('https://easydrop.one/')?new Response('x',{status:404}):prior(url,o);t.after(()=>{globalThis.fetch=original;});
 const r=await a.call(`/api/admin/suppliers/${a.created.id}/sync`,'POST',{});
 assert.equal(r.response.status,422);assert.match(r.data.error,/HTTP 404/);assert.ok(!leaks(r.data));
 assert.equal((await a.env.DB.prepare("SELECT COUNT(*) AS n FROM sync_runs WHERE status='failed'").first()).n,1);
});
test('MyDrop discovery cannot match or modify EasyDrop suppliers, even hostile rows',async t=>{
 const a=await discoveryReady(t,{results:[connected(555,'Remote','demo_shop'),connected(556,'Fresh','new_one')]});
 const ed=(await a.call('/api/admin/suppliers','POST',{name:'ED',provider:'easydrop',feedUrl:LINK})).data;
 // Hostile rows: EasyDrop suppliers holding MyDrop connection IDs.
 await a.env.DB.batch([a.env.DB.prepare("UPDATE suppliers SET connection_id='555' WHERE id=?").bind(ed.id),a.env.DB.prepare("INSERT INTO suppliers(id,name,url,created_at,provider,connection_id) VALUES('ed2','ED2','easydrop:ed2','t','easydrop','556')")]);
 const before=await a.env.DB.prepare("SELECT * FROM suppliers WHERE provider='easydrop' ORDER BY id").all();
 const result=await a.call('/api/admin/suppliers/sync-connected','POST',{});assert.equal(result.response.status,200);
 assert.deepEqual({added:result.data.added,updated:result.data.updated,skipped:result.data.skipped.length},{added:1,updated:1,skipped:0});
 const after=await a.env.DB.prepare("SELECT * FROM suppliers WHERE provider='easydrop' ORDER BY id").all();assert.deepEqual(after.results,before.results);
 const mydrop=await a.env.DB.prepare("SELECT connection_id FROM suppliers WHERE provider='mydrop' ORDER BY connection_id").all();assert.deepEqual(mydrop.results.map(r=>r.connection_id),['555','556']);
});
test('public projections never carry EasyDrop supplier or feed data',async t=>{
 const a=await easydropApp(t);const imp=await a.call(`/api/admin/suppliers/${a.created.id}/import`,'POST',{items:[source]});assert.equal(imp.response.status,200);
 const product=(await a.call('/api/admin/products')).data.items[0];await a.call(`/api/admin/products/${product.id}`,'PATCH',{published:true,markupValue:5000});
 a.setToken('');for(const path of ['/api/products','/products/'+product.slug,'/']){const r=await a.call(path);const body=JSON.stringify(r.data);assert.ok(!body.includes(KEY)&&!body.includes(PID)&&!body.includes('easydrop:'),path);}
 assert.equal((await a.call('/api/products')).data.items.length,1);
});

test('staff without suppliers.manage see only feed.configured, in the list and in Trash',async t=>{
 const a=await easydropApp(t),second=(await a.call('/api/admin/suppliers','POST',{name:'ED2',provider:'easydrop',feedUrl:`https://easydrop.one/prom-export?key=111222333444&pid=${PID}`})).data;
 await a.call(`/api/admin/suppliers/${second.id}`,'DELETE',{confirm:true});
 const token='s'.repeat(43),hash=Buffer.from(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(token))).toString('hex'),at=new Date().toISOString(),later=new Date(Date.now()+3600000).toISOString();
 await a.env.DB.batch([a.env.DB.prepare("INSERT INTO staff_members(id,role,status,google_sub,email,display_name,created_by,created_at,updated_at) VALUES('m1','manager','active','sub1','m@example.com','M','owner',?,?)").bind(at,at),a.env.DB.prepare('INSERT INTO staff_sessions(token_hash,staff_id,created_at,authenticated_at,last_seen_at,idle_expires_at,absolute_expires_at) VALUES(?,?,?,?,?,?,?)').bind(hash,'m1',at,at,at,later,later)]);
 a.setToken('');const headers={Cookie:`__Host-ls_staff=${token}`};
 const owner=await signedToken();a.setToken(owner);const ownerView=(await a.call('/api/admin/suppliers')).data.items.find(s=>s.id===a.created.id);assert.equal(ownerView.feed.keyLast4,'6789');
 a.setToken('');
 for(const [path,id] of [['/api/staff/admin/suppliers',a.created.id],['/api/staff/admin/suppliers?deleted=1',second.id]]){
  const r=await a.call(path,'GET',undefined,headers);assert.equal(r.response.status,200,path);
  const item=r.data.items.find(s=>s.id===id);assert.deepEqual(item.feed,{configured:true});assert.equal(item.connectionId,undefined);
  const body=JSON.stringify(r.data);assert.ok(!body.includes(KEY)&&!body.includes('111222333444')&&!body.includes('keyLast4')&&!body.includes(PID));
 }
});
test('internal manager tags: normalized, admin-only, survive sync, never public, do not reorder the storefront',async t=>{
 const a=await imported(t),url=`/api/admin/products/${a.product.id}`,secret='zz-internal-tag-needs-image';
 const first=await a.call(url,'PATCH',{published:true,slug:'tagged-coat'});assert.equal(first.response.status,200);
 const stamp=first.data.updatedAt;await new Promise(r=>setTimeout(r,5));
 const tagged=await a.call(url,'PATCH',{tags:['  Promoted ','promoted','needs   image update',secret]});
 assert.equal(tagged.response.status,200);assert.deepEqual(tagged.data.tags,['Promoted','needs image update',secret]);
 assert.equal(tagged.data.updatedAt,stamp,'tag-only edits keep the storefront order');
 assert.deepEqual((await a.call(url,'PATCH',{tags:['caf\u00e9','cafe\u0301','Promoted','needs image update',secret]})).data.tags,['caf\u00e9','Promoted','needs image update',secret],'NFC duplicates merge');
 await a.call(url,'PATCH',{tags:['Promoted','needs image update',secret]});
 for(const bad of [['x'.repeat(41)],[''],['a\u0000b'],['a\u200bb'],['\ue000'],['\u0301'],['!!!'],['\ud800x'],Array.from({length:21},(_,i)=>`t${i}`),'promoted',[1]])assert.equal((await a.call(url,'PATCH',{tags:bad})).response.status,400,JSON.stringify(bad));
 await a.call(`/api/admin/suppliers/${a.supplier.id}/import`,'POST',{items:[{...source,title:'Changed supplier title'}]});
 const admin=(await a.call('/api/admin/products')).data.items[0];assert.deepEqual(admin.tags,['Promoted','needs image update',secret]);assert.deepEqual(admin.overrides.tags,admin.tags);
 for(const path of ['/api/products','/api/products/tagged-coat','/products/tagged-coat','/sitemap.xml','/']){const {response,data}=await a.call(path);assert.equal(response.status,200,path);const body=typeof data==='string'?data:JSON.stringify(data);assert.ok(body.includes('tagged-coat')||path==='/',path);assert.ok(!body.includes(secret)&&!body.includes('needs image update')&&!/"tags"/.test(body),path);}
 const visible=await a.call(url,'PATCH',{title:'Visible change'});assert.notEqual(visible.data.updatedAt,stamp,'visible edits still bump updatedAt');
 const cleared=await a.call(url,'PATCH',{tags:[]});assert.deepEqual(cleared.data.tags,[]);
});
test('bulk tags add and remove across selected products without touching storefront order or other fields',async t=>{
 const a=await imported(t);await a.call(`/api/admin/suppliers/${a.supplier.id}/import`,'POST',{items:[source,{...source,externalId:'supplier-2',title:'Second Coat'}]});
 const [p1,p2]=(await a.call('/api/admin/products')).data.items;
 await a.call(`/api/admin/products/${p1.id}`,'PATCH',{tags:['Old','keep'],title:'Edited title'});
 const stamps=Object.fromEntries((await a.call('/api/admin/products')).data.items.map(p=>[p.id,p.updatedAt]));await new Promise(r=>setTimeout(r,5));
 const bulk=(body)=>a.call('/api/admin/products/bulk-tags','POST',body);
 const added=await bulk({ids:[p1.id,p2.id],add:['promoted',' PROMOTED '],remove:['old']});
 assert.equal(added.response.status,200);assert.deepEqual(added.data,{updated:2,matched:2});
 let items=Object.fromEntries((await a.call('/api/admin/products')).data.items.map(p=>[p.id,p]));
 assert.deepEqual(items[p1.id].tags,['keep','promoted']);assert.deepEqual(items[p2.id].tags,['promoted']);
 assert.equal(items[p1.id].title,'Edited title');for(const id of [p1.id,p2.id])assert.equal(items[id].updatedAt,stamps[id]);
 assert.deepEqual((await bulk({ids:[p2.id],add:['promoted']})).data,{updated:0,matched:1},'no-op skipped');
 const removed=await bulk({ids:[p1.id,p2.id],remove:['Promoted']});assert.equal(removed.data.updated,2);
 items=Object.fromEntries((await a.call('/api/admin/products')).data.items.map(p=>[p.id,p]));assert.deepEqual(items[p1.id].tags,['keep']);assert.deepEqual(items[p2.id].tags,[]);
 for(const bad of [{ids:[p1.id]},{ids:[],add:['x']},{ids:[p1.id,p1.id],add:['x']},{ids:[p1.id],add:['x'],remove:['X']},{ids:[p1.id],add:['x'.repeat(41)]},{ids:[p1.id],add:Array.from({length:20},(_,i)=>`n${i}`)},{ids:[p1.id],add:['x'],published:true}])assert.equal((await bulk(bad)).response.status,400,JSON.stringify(bad));
 assert.deepEqual(items[p1.id].tags,['keep'],'failed batch applied nothing');
 assert.equal((await bulk({ids:[p1.id,'missing'],add:['x']})).response.status,404);
 await a.call(`/api/admin/products/${p2.id}`,'DELETE',{confirm:true});assert.equal((await bulk({ids:[p1.id,p2.id],add:['x']})).response.status,409);
 assert.deepEqual((await a.call('/api/admin/products')).data.items.find(p=>p.id===p1.id).tags,['keep'],'409 applied nothing');
});

// D1 read/write budget. Plans are checked on the exact SQL the Worker issued.
const planOf=(sqlite,sql)=>sqlite.prepare('EXPLAIN QUERY PLAN '+sql).all(...Array((sql.match(/\?/g)||[]).length).fill('x')).map(r=>r.detail);
function issued(a,run){const start=a.env.DB.log.length;return run().then(()=>a.env.DB.log.slice(start).filter(sql=>/FROM products p\b/.test(sql)&&!/recognition_state/.test(sql)));}
test('public, admin, trash, supplier-count and external-id queries are index driven, never a products scan',async t=>{
 const a=await imported(t);await a.call(`/api/admin/suppliers/${a.supplier.id}/import`,'POST',{items:[{...source,externalId:'second'},{...source,externalId:'third'}]});
 const ids=(await a.call('/api/admin/products')).data.items.map(p=>p.id);
 for(const id of ids.slice(0,2))assert.equal((await a.call(`/api/admin/products/${id}`,'PATCH',{published:true})).response.status,200);
 assert.equal((await a.call(`/api/admin/products/${ids[2]}`,'DELETE',{confirm:true})).response.status,200);
 const sqlite=a.env.DB.raw,uses=(sql,index)=>{const plan=planOf(sqlite,sql).join(' | ');assert.ok(!/\bSCAN (p|products)\b/.test(plan),`${sql}\n=> ${plan}`);assert.match(plan,new RegExp(`USING (COVERING )?INDEX ${index}\\b`),`${sql}\n=> ${plan}`);};
 const [pub]=await issued(a,()=>a.call('/api/products'));uses(pub,'products_published');
 const [sitemap]=await issued(a,()=>a.call('/sitemap.xml'));assert.equal(sitemap,pub);
 // The live list is O(products) whatever the plan (with ANALYZE stats SQLite may prefer a scan); assert only without stats.
 const [live]=await issued(a,()=>a.call('/api/admin/products'));uses(live,'products_deleted');
 const [trash]=await issued(a,()=>a.call('/api/admin/products?deleted=1'));uses(trash,'products_trash');
 const supplierSql=(await issued(a,()=>a.call('/api/admin/suppliers'))).find(sql=>sql.includes('published_count'));uses(supplierSql,'products_published');
 assert.match(planOf(sqlite,supplierSql).join(' | '),/COVERING INDEX products_deleted/);
 // tools/stockify.mjs (staging) looks products up by internal id or supplier product number.
 assert.match(planOf(sqlite,'SELECT id, source_json, overrides_json, deleted_at FROM products WHERE id = ? OR external_id = ?').join(' | '),/MULTI-INDEX OR[\s\S]*products_external/);
 // Worker-side ordering equals ORDER BY updated_at DESC.
 const order=sql=>sqlite.prepare(sql.replace(/\s*$/,' ')+'ORDER BY p.updated_at DESC').all().map(r=>r.id);
 assert.deepEqual((await a.call('/api/admin/products')).data.items.map(p=>p.id),order(live));
 assert.deepEqual((await a.call('/api/products')).data.items.map(p=>p.slug),sqlite.prepare(pub+' ORDER BY p.updated_at DESC,p.id').all().map(r=>r.slug));
 assert.equal((await a.call('/api/products')).data.items.length,2);
});
test('published index membership matches overrides on every write path',async t=>{
 const a=await imported(t),sqlite=a.env.DB.raw;await a.call(`/api/admin/suppliers/${a.supplier.id}/import`,'POST',{items:[{...source,externalId:'second'}]});
 const ids=(await a.call('/api/admin/products')).data.items.map(p=>p.id).sort();
 const check=label=>{
  const indexed=sqlite.prepare("SELECT id FROM products INDEXED BY products_published WHERE deleted_at IS NULL AND json_extract(overrides_json,'$.published')=1 ORDER BY id").all().map(r=>r.id);
  const scanned=sqlite.prepare("SELECT id FROM products NOT INDEXED WHERE deleted_at IS NULL AND json_extract(overrides_json,'$.published') IS 1 ORDER BY id").all().map(r=>r.id);
  assert.deepEqual(indexed,scanned,label);return indexed;
 };
 assert.deepEqual(check('import'),[]);
 await a.call(`/api/admin/products/${ids[0]}`,'PATCH',{published:true});assert.deepEqual(check('patch'),[ids[0]]);
 await a.call('/api/admin/products/bulk','POST',{ids,action:'publish'});assert.deepEqual(check('bulk publish'),ids);
 assert.equal((await a.call(`/api/admin/suppliers/${a.supplier.id}`)).data?.publishedCount??(await a.call('/api/admin/suppliers')).data.items[0].publishedCount,2);
 await a.call(`/api/admin/suppliers/${a.supplier.id}/import`,'POST',{items:[{...source,title:'Refreshed'}]});assert.deepEqual(check('reimport keeps publication'),ids);
 await a.call(`/api/admin/products/${ids[1]}`,'PATCH',{title:'Other edit'});assert.deepEqual(check('non-publish patch'),ids);
 await a.call('/api/admin/products/bulk','POST',{ids:[ids[1]],action:'unpublish'});assert.deepEqual(check('bulk unpublish'),[ids[0]]);
 await a.call(`/api/admin/products/${ids[0]}`,'DELETE',{confirm:true});assert.deepEqual(check('trash'),[]);
 await a.call(`/api/admin/products/${ids[0]}/restore`,'POST',{});assert.deepEqual(check('restore'),[]);
 await a.call(`/api/admin/products/${ids[0]}`,'PATCH',{published:true});await a.call(`/api/admin/products/${ids[0]}`,'PATCH',{published:false});assert.deepEqual(check('patch unpublish'),[]);
 assert.equal((await a.call('/api/admin/suppliers')).data.items[0].publishedCount,0);
});
test('re-import of an unchanged source writes no product row and keeps overrides; a change still updates',async t=>{
 const a=await imported(t),sqlite=a.env.DB.raw,path=`/api/admin/suppliers/${a.supplier.id}/import`;
 await a.call(`/api/admin/products/${a.product.id}`,'PATCH',{published:true,title:'Curated'});
 const snapshot=()=>({row:sqlite.prepare('SELECT source_json,overrides_json,updated_at,slug FROM products WHERE id=?').get(a.product.id),revision:sqlite.prepare('SELECT catalog_revision FROM recognition_state').get().catalog_revision,count:sqlite.prepare('SELECT COUNT(*) n FROM products').get().n});
 const before=snapshot();await new Promise(resolve=>setTimeout(resolve,5));
 const again=await a.call(path,'POST',{items:[source]});assert.equal(again.response.status,200);assert.deepEqual(again.data,{imported:1});
 // Only recordRun's one suppliers UPDATE fires the revision trigger; no product trigger fires.
 assert.deepEqual(snapshot(),{...before,revision:before.revision+1},'unchanged source: no product write');
 assert.equal((await a.call('/api/products')).data.items[0].title,'Curated');
 const changed=await a.call(path,'POST',{items:[{...source,costMinor:20000}]});assert.deepEqual(changed.data,{imported:1});
 const after=snapshot();assert.notEqual(after.row.updated_at,before.row.updated_at);assert.equal(JSON.parse(after.row.source_json).costMinor,20000);assert.equal(after.row.overrides_json,before.row.overrides_json);assert.equal(after.revision,before.revision+3,'one product write plus one supplier update per sync');
 const mixed=await a.call(path,'POST',{items:[{...source,costMinor:20000},{...source,externalId:'new-one'}]});assert.deepEqual(mixed.data,{imported:2});assert.equal(snapshot().count,2);assert.equal(snapshot().row.updated_at,after.row.updated_at);
});
function fakeCache(){
 const store=new Map(),calls={match:0,put:0,delete:0};
 return{store,calls,default:{
  async match(request){calls.match++;const hit=store.get(new URL(request.url).href);return hit?hit.clone():undefined;},
  async put(request,response){calls.put++;assert.equal(request.method,'GET');assert.match(response.headers.get('Cache-Control'),/max-age=60/);store.set(new URL(request.url).href,response.clone());},
  async delete(request){calls.delete++;return store.delete(new URL(request.url).href);}
 }};
}
test('public catalog JSON and sitemap are served from the edge cache with no D1 query, and manager writes purge it',async t=>{
 const a=await imported(t),cache=fakeCache(),previous=globalThis.caches;globalThis.caches=cache;t.after(()=>{globalThis.caches=previous;});
 await a.call(`/api/admin/products/${a.product.id}`,'PATCH',{published:true});
 const first=await a.call('/api/products');assert.equal(first.data.items.length,1);assert.equal(first.response.headers.get('Cache-Control'),'no-cache');assert.equal(cache.calls.put,1);
 const start=a.env.DB.log.length;
 const second=await a.call('/api/products?bust='+Math.random());assert.deepEqual(second.data,first.data);assert.equal(second.response.headers.get('Cache-Control'),'no-cache');
 assert.equal(a.env.DB.log.length,start,'cache hit makes no D1 query (not even recognition)');
 const map=await a.call('/sitemap.xml');assert.match(map.data,/<loc>/);assert.equal(map.response.headers.get('Cache-Control'),'no-cache');
 const mark=a.env.DB.log.length;assert.equal((await a.call('/sitemap.xml')).data,map.data);assert.equal(a.env.DB.log.length,mark);
 assert.ok(!/costMinor|supplier/.test(JSON.stringify(second.data)));
 // Unpublish via the manager API purges this colo's copies immediately.
 assert.equal((await a.call(`/api/admin/products/${a.product.id}`,'PATCH',{published:false})).response.status,200);
 assert.equal(cache.store.size,0);assert.deepEqual((await a.call('/api/products')).data.items,[]);assert.doesNotMatch((await a.call('/sitemap.xml')).data,/<loc>/);
 // Private routes and errors are never cached.
 const puts=cache.calls.put;a.env.APP_ENV='staging';cache.store.clear();
 assert.equal((await a.call('/sitemap.xml')).response.status,404);assert.equal(cache.calls.put,puts);
 assert.equal((await a.call('/api/admin/products')).response.headers.get('Cache-Control'),'no-store');assert.equal(cache.calls.put,puts);
});
test('cache store uses ctx.waitUntil when the runtime provides it, and a failing cache falls back to D1',async t=>{
 const a=await imported(t),cache=fakeCache(),previous=globalThis.caches;globalThis.caches=cache;t.after(()=>{globalThis.caches=previous;});
 await a.call(`/api/admin/products/${a.product.id}`,'PATCH',{published:true});
 const waits=[],ctx={waitUntil:p=>waits.push(p)};
 const r=await worker.fetch(new Request('https://catalog.test/api/products'),a.env,ctx);assert.equal(r.status,200);assert.equal(waits.length,1);await Promise.all(waits);assert.equal(cache.store.size,1);
 cache.default.match=async()=>{throw new Error('cache down');};
 const fallback=await worker.fetch(new Request('https://catalog.test/api/products'),a.env,ctx);assert.equal(fallback.status,200);assert.equal((await fallback.json()).items.length,1);
});
test('public routes work unchanged when the Cache API is unavailable',async t=>{
 const a=await imported(t);assert.equal(globalThis.caches,undefined);
 await a.call(`/api/admin/products/${a.product.id}`,'PATCH',{published:true});
 const r=await a.call('/api/products');assert.equal(r.response.status,200);assert.equal(r.data.items.length,1);assert.equal(r.response.headers.get('Cache-Control'),'no-cache');
});
