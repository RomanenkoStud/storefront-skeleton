import assert from 'node:assert/strict';
import {build} from 'vite';
import {pathToFileURL,fileURLToPath} from 'node:url';
import {resolve,dirname,join} from 'node:path';
import {mkdtempSync,mkdirSync,rmSync,writeFileSync} from 'node:fs';
import {serverMessage,parseHryvniaToMinor,minorToHryvnia,validateVariants,photoFileError,buildProductBody,buildSourceBody,MAX_PHOTO_BYTES} from '../../apps/web/src/manual-product.js';

// Money: exact string conversion, no float errors.
for (const [input,minor] of [['1299',129900],['1299.5',129950],['1299.50',129950],['1299,5',129950],[' 0.07 ',7],['0.29',29],['1.15',115],['19.99',1999],['4.35',435],['0',0],['00012',1200]]) assert.equal(parseHryvniaToMinor(input),minor,input);
for (const bad of ['','  ','-1','1e3','1.234','1.','.5','abc','1 299','12,34,5','NaN','Infinity','1299.999','+5','0x10',null,undefined]) assert.equal(parseHryvniaToMinor(bad),null,String(bad));
assert.equal(parseHryvniaToMinor('1234567890'),null);
for (const minor of [0,7,100,129950,129900,1999,435]) assert.equal(parseHryvniaToMinor(minorToHryvnia(minor)),minor);
assert.equal(minorToHryvnia(129950),'1299.50');assert.equal(minorToHryvnia(129900),'1299');assert.equal(minorToHryvnia(-1),'');assert.equal(minorToHryvnia(1.5),'');

// Variants.
assert.deepEqual(validateVariants([{size:' M ',stock:'3'},{size:'L',stock:'0'}]).variants,[{size:'M',stock:3},{size:'L',stock:0}]);
for (const rows of [[],[{size:'',stock:'1'}],[{size:'M',stock:''}],[{size:'M',stock:'-1'}],[{size:'M',stock:'1.5'}],[{size:'M',stock:'1'},{size:'m',stock:'2'}]]) assert.ok(validateVariants(rows).error,JSON.stringify(rows));

// Files mirror the server limits.
assert.equal(photoFileError({name:'a.jpg',type:'image/jpeg',size:10}),'');
assert.equal(photoFileError({name:'a.webp',type:'image/webp',size:MAX_PHOTO_BYTES}),'');
assert.match(photoFileError({name:'a.gif',type:'image/gif',size:10}),/JPEG, PNG/);
assert.match(photoFileError({name:'big.png',type:'image/png',size:MAX_PHOTO_BYTES+1}),/20 МБ/);

// Add-product validation and payload.
const good={supplierId:'s1',title:' Куртка ',description:'',categoryId:'',brand:'',price:'1299.50',cost:'',sizes:[{size:'One size',stock:'2'}]};
let r=buildProductBody(good);assert.deepEqual(r.errors,{});assert.deepEqual(r.body,{supplierId:'s1',title:'Куртка',priceMinor:129950,variants:[{size:'One size',stock:2}]});
r=buildProductBody({...good,cost:'800',brand:' Lorem ',categoryId:'c1',description:'Опис'});assert.deepEqual(r.body,{supplierId:'s1',title:'Куртка',priceMinor:129950,variants:[{size:'One size',stock:2}],description:'Опис',categoryId:'c1',brand:'Lorem',costMinor:80000});
r=buildProductBody({...good,cost:'1299.51'});assert.ok(r.errors.cost);
assert.deepEqual(buildProductBody({...good,cost:'1299.50'}).errors,{});
assert.ok(buildProductBody({...good,title:'  '}).errors.title);assert.ok(buildProductBody({...good,price:''}).errors.price);assert.ok(buildProductBody({...good,price:'0'}).errors.price);
assert.ok(buildProductBody({...good,supplierId:''}).errors.supplierId);assert.ok(buildProductBody({...good,sizes:[]}).errors.sizes);
r=buildSourceBody({title:'T',description:' d ',cost:'10.5',sizes:[{size:'S',stock:'1'}],photos:['https://x/1.jpg']});assert.deepEqual(r.errors,{});assert.deepEqual(r.body,{title:'T',description:'d',costMinor:1050,variants:[{size:'S',stock:1}],photos:['https://x/1.jpg']});
assert.ok(buildSourceBody({title:'',cost:'x',sizes:[],photos:[]}).errors.cost);

// Limits and server message mapping.
assert.ok(buildProductBody({...good,price:'1000000.01'}).errors.price);assert.deepEqual(buildProductBody({...good,price:'1000000'}).errors,{});
assert.ok(buildProductBody({...good,price:'1000000',cost:'1000000.01'}).errors.cost);assert.ok(buildProductBody({...good,brand:'x'.repeat(101)}).errors.brand);
assert.ok(buildSourceBody({title:'T',cost:'1000000.01',sizes:[{size:'S',stock:'1'}],photos:[]}).errors.cost);
assert.equal(serverMessage('Price cannot be below cost'),'Ціна не може бути нижчою за закупівлю.');assert.equal(serverMessage('Duplicate sizes'),'Розміри не мають повторюватися.');assert.equal(serverMessage('Something new'),'Something new');
assert.equal(validateVariants([{size:'Один розмір',stock:'1'}]).variants[0].size,'Один розмір');

// Manual supplier UI: badge, no link, no feed text.
const root=resolve(dirname(fileURLToPath(import.meta.url)),'../..');
const cache=join(root,'node_modules/.cache');mkdirSync(cache,{recursive:true});
const dir=mkdtempSync(join(cache,'manual-product-test-'));
try {
  const entry=join(dir,'entry.jsx');
  writeFileSync(entry,`export * from '${resolve(root,'apps/web/src/EasyDrop.jsx').replaceAll('\\','/')}';export * from '${resolve(root,'apps/web/src/ManualProduct.jsx').replaceAll('\\','/')}';export {default as React} from 'react';export {renderToStaticMarkup} from 'react-dom/server';`);
  await build({root:dir,configFile:false,logLevel:'silent',esbuild:{jsx:'automatic'},ssr:{noExternal:true},build:{ssr:entry,outDir:dir,emptyOutDir:false,rollupOptions:{output:{format:'cjs',entryFileNames:'out.cjs'}}}});
  const m=await import(pathToFileURL(join(dir,'out.cjs')).href);
  const {React}=m, html=el=>m.renderToStaticMarkup(el); // bundled React copy so hooks work
  const manual={id:'m1',name:'Власний склад',provider:'manual',url:'manual:m1',feed:null};
  assert.equal(m.providerOf(manual),'manual');
  assert.match(html(React.createElement(m.ProviderBadge,{supplier:manual})),/provider-manual[^>]*>Ручний</);
  const source=html(React.createElement(m.SupplierSource,{supplier:manual}));
  assert.doesNotMatch(source,/<a /);assert.doesNotMatch(source,/manual:m1/);assert.doesNotMatch(source,/фід/);
  const form=html(React.createElement(m.AddManualSupplierForm,{busy:false,working:false,onAdd(){}}));
  assert.match(form,/Назва/);assert.match(form,/Додати ручного постачальника/);
  const rows=html(React.createElement(m.SizeRows,{rows:[{size:'One size',stock:'1'}],onChange(){}}));
  assert.match(rows,/Розмір 1/);assert.match(rows,/Кількість 1/);assert.match(rows,/disabled=""[^>]*>Прибрати/);
  console.log('Manual product frontend tests passed');
} finally {rmSync(dir,{recursive:true,force:true});}
