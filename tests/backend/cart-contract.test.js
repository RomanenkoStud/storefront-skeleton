import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import * as cart from '../../packages/catalog/cart.js';
const {CROCKFORD_ALPHABET:A,generateCode,normalizeCode,formatCode,canTransition,CART_STATUSES,CART_TRANSITIONS,validateCheckoutLines,parseLocalCart,serializeLocalCart,addLocalLine}=cart;
const fixed=bytes=>()=>Uint8Array.from(bytes);
const line=(o={})=>({productId:'p1',size:'M',quantity:1,...o});

test('alphabet is Crockford base32 without I L O U',()=>{
 assert.equal(A,'0123456789ABCDEFGHJKMNPQRSTVWXYZ');assert.equal(A.length,32);assert.equal(new Set(A).size,32);
 for(const c of 'ILOU')assert.ok(!A.includes(c));
});
test('generateCode formats SS-XXXX-XXXX from 5 bits per byte',()=>{
 assert.equal(generateCode(fixed([0,1,2,3,4,5,6,7])),'SS-0123-4567');
 assert.equal(generateCode(fixed([31,31,31,31,31,31,31,31])),'SS-ZZZZ-ZZZZ');
 assert.equal(generateCode(fixed([255,224,32,33,64,96,128,160])),'SS-Z001-0000','high bits are ignored');
 assert.throws(()=>generateCode(()=>new Uint8Array(3)));
});
test('generateCode sampling is unbiased across every byte value and uses secure default',()=>{
 const counts=new Array(32).fill(0);
 for(let b=0;b<256;b++){counts[A.indexOf(generateCode(fixed([b,0,0,0,0,0,0,0])).slice(3,4))]++;}
 assert.ok(counts.every(c=>c===8));
 const seen=new Set();for(let i=0;i<200;i++){const c=generateCode();assert.match(c,/^SS-[0-9A-HJKMNP-TV-Z]{4}-[0-9A-HJKMNP-TV-Z]{4}$/);seen.add(c);}
 assert.equal(seen.size,200);
});
test('formatCode validates the body',()=>{
 assert.equal(formatCode('ABCD1234'),'SS-ABCD-1234');
 for(const bad of ['','ABC','ABCD12345','ABCDILOU',null,undefined,12345678,'abcd1234'])assert.throws(()=>formatCode(bad),TypeError);
});
test('normalizeCode tolerates case, spaces, hyphens, confusables and optional prefix',()=>{
 const want='SS-ABCD-1234';
 for(const input of ['SS-ABCD-1234','ss-abcd-1234','ABCD1234',' abcd 1234 ','SS ABCD 1234','ssabcd1234','S S - A B C D - 1 2 3 4','ABCD-1234','abcdI234','abcdl234'])assert.equal(normalizeCode(input),want,input);
 assert.equal(normalizeCode('SS-0O0O-IL1L'),'SS-0000-1111');
 assert.equal(normalizeCode('SSABCDEF'),'SS-SSAB-CDEF','8-char body that begins with SS is not a prefix');
 assert.equal(normalizeCode(normalizeCode('ssabcd1234')),want,'idempotent');
});
test('normalizeCode rejects malformed input',()=>{
 for(const bad of [undefined,null,'',123,{},[],'SS-','ABCD','ABCD123','ABCD12345','SS-ABCD-12345','SS-ABCU-1234','ABCD#234','SS-SS-ABCD-1234','ÀBCD1234','x'.repeat(500),'ABCD\n1234;DROP'])assert.equal(normalizeCode(bad),null,String(bad));
 assert.equal(cart.isValidCode('ss-abcd-1234'),true);assert.equal(cart.isValidCode('nope'),false);
});
test('status table: forward flow, cancel from open states, completed only after sent_to_suppliers, terminal states are final',()=>{
 assert.deepEqual([...CART_STATUSES],['submitted','verified','sent_to_suppliers','completed','cancelled']);
 const allowed=[['submitted','verified'],['submitted','cancelled'],['verified','sent_to_suppliers'],['verified','cancelled'],['sent_to_suppliers','completed']];
 for(const f of CART_STATUSES)for(const t of CART_STATUSES)assert.equal(canTransition(f,t),allowed.some(([a,b])=>a===f&&b===t),`${f}->${t}`);
 assert.deepEqual([...cart.TERMINAL_STATUSES].sort(),['cancelled','completed']);
 assert.deepEqual([...cart.CLOSED_STATUSES].sort(),[...cart.TERMINAL_STATUSES].sort(),'every terminal status starts the retention clock');
 assert.deepEqual({...cart.ORDER_PD_RETENTION},{closedDays:14,maxDays:90,batchLimit:200});assert.ok(Object.isFrozen(cart.ORDER_PD_RETENTION));
 assert.equal(cart.isTerminalStatus('sent_to_suppliers'),false);assert.equal(cart.isTerminalStatus('completed'),true);
 assert.equal(cart.isTerminalStatus('cancelled'),true);assert.equal(cart.isTerminalStatus('submitted'),false);
 assert.equal(canTransition('submitted','sent_to_suppliers'),false);assert.equal(canTransition('bogus','verified'),false);assert.equal(canTransition('submitted','toString'),false);assert.equal(canTransition('__proto__','submitted'),false);
 assert.ok(Object.isFrozen(CART_TRANSITIONS));assert.equal(cart.isCartStatus('verified'),true);assert.equal(cart.isCartStatus('constructor'),false);
});
test('validateCheckoutLines accepts and normalizes valid carts',()=>{
 const r=validateCheckoutLines([line({productId:' p1 ',size:' M '}),line({size:'L',quantity:10}),line({productId:'p2'})]);
 assert.equal(r.ok,true);assert.deepEqual(r.problems,[]);
 assert.deepEqual(r.lines,[{productId:'p1',size:'M',quantity:1},{productId:'p1',size:'L',quantity:10},{productId:'p2',size:'M',quantity:1}]);
 assert.equal(validateCheckoutLines(Array.from({length:20},(_,i)=>line({productId:`p${i}`}))).ok,true);
});
test('validateCheckoutLines strips untrusted extras such as browser prices',()=>{
 const r=validateCheckoutLines([{...line(),priceMinor:1,unitCostMinor:5,supplierId:'x'}]);
 assert.deepEqual(r.lines,[{productId:'p1',size:'M',quantity:1}]);
});
test('validateCheckoutLines reports whole-cart problems',()=>{
 for(const bad of [undefined,null,[],'x',{}])assert.deepEqual(validateCheckoutLines(bad).problems,[{index:null,code:'lines_required'}]);
 const r=validateCheckoutLines(Array.from({length:21},(_,i)=>line({productId:`p${i}`})));
 assert.equal(r.ok,false);assert.equal(r.problems[0].code,'too_many_lines');assert.deepEqual(r.lines,[]);
});
test('validateCheckoutLines reports per-line problems with indexes',()=>{
 const r=validateCheckoutLines([line(),null,[],line({productId:''}),line({size:'  '}),line({quantity:0}),line({quantity:11}),line({quantity:1.5}),line({quantity:'2'}),line({quantity:NaN}),line({productId:7}),line({size:'x'.repeat(101)}),line({productId:'p9',size:'S',quantity:2})]);
 const codes=r.problems.map(p=>`${p.index}:${p.code}`);
 assert.deepEqual(codes,['1:invalid_line','2:invalid_line','3:invalid_product_id','4:invalid_size','5:invalid_quantity','6:invalid_quantity','7:invalid_quantity','8:invalid_quantity','9:invalid_quantity','10:invalid_product_id','11:invalid_size']);
 assert.equal(r.ok,false);assert.deepEqual(r.lines,[]);
 const multi=validateCheckoutLines([{productId:'',size:'',quantity:0}]);assert.deepEqual(multi.problems.map(p=>p.field),['productId','size','quantity']);
});
test('duplicate productId+size is rejected by the server contract, same product with another size is fine',()=>{
 const r=validateCheckoutLines([line(),line({size:'L'}),line({size:' M '})]);
 assert.equal(r.ok,false);assert.deepEqual(r.problems,[{index:2,code:'duplicate_line',field:'size',firstIndex:0}]);
});
test('addLocalLine merges duplicates, caps quantity and line count',()=>{
 let r=addLocalLine([],{...line(),title:'T'});assert.equal(r.added,true);
 r=addLocalLine(r.lines,{...line({quantity:4}),title:'T2'});assert.equal(r.lines.length,1);assert.equal(r.lines[0].quantity,5);assert.equal(r.lines[0].title,'T2');
 r=addLocalLine(r.lines,line({quantity:9}));assert.equal(r.lines[0].quantity,10);assert.equal(r.capped,true);
 r=addLocalLine(r.lines,line({size:'L'}));assert.equal(r.lines.length,2);
 const full=Array.from({length:20},(_,i)=>line({productId:`p${i}`}));
 const over=addLocalLine(full,line({productId:'new'}));assert.equal(over.full,true);assert.equal(over.added,false);assert.equal(over.lines.length,20);
 assert.equal(addLocalLine(full,line({productId:'p3',quantity:2})).lines[3].quantity,3);
 const input=[line()];addLocalLine(input,line());assert.equal(input[0].quantity,1,'does not mutate');
});
test('local cart round trips as ls_cart_v1 version 1',()=>{
 assert.equal(cart.LOCAL_CART_KEY,'ls_cart_v1');
 const state={lines:[{productId:'p1',slug:'hoodie',size:'M',quantity:2,title:'Худі',priceMinor:123400,photo:'https://x/y.jpg'}],recent:[{code:'SS-ABCD-1234',createdAt:'2026-01-01T00:00:00Z',itemCount:2,totalMinor:246800}]};
 const text=serializeLocalCart(state);const back=parseLocalCart(text);
 assert.equal(JSON.parse(text).version,1);assert.deepEqual(back,{version:1,...state});
 assert.equal(serializeLocalCart(back),text);
});
test('parseLocalCart tolerates corrupt, foreign and hostile data',()=>{
 const empty={version:1,lines:[],recent:[]};
 for(const bad of [null,undefined,'','{','not json','[]','null','7','"x"','{"version":2,"lines":[{}]}','{"lines":[]}',{version:0},[]])assert.deepEqual(parseLocalCart(bad),empty,String(bad));
 const r=parseLocalCart(JSON.stringify({version:1,lines:[null,7,{productId:'a',size:'M',quantity:99},{productId:'a',size:'M',quantity:2,priceMinor:-5,slug:5,title:{},photo:9},{productId:'a',size:'M',quantity:3},{productId:'b',size:'S',quantity:1,priceMinor:1.5}],recent:[null,{code:'bad'},{code:'ssabcd1234',itemCount:-1,totalMinor:'x'},{code:'SS-ABCD-1234'}]}));
 assert.equal(r.lines.length,2);assert.deepEqual(r.lines[0],{productId:'a',size:'M',quantity:5,slug:'',title:'',priceMinor:null,photo:null});assert.equal(r.lines[1].priceMinor,null);
 assert.deepEqual(r.recent,[{code:'SS-ABCD-1234',createdAt:'',itemCount:0,totalMinor:0}]);
 const many=parseLocalCart(JSON.stringify({version:1,lines:Array.from({length:50},(_,i)=>({productId:`p${i}`,size:'M',quantity:1})),recent:Array.from({length:50},(_,i)=>({code:`SS-${String(i).padStart(4,'0')}-0000`}))}));
 assert.equal(many.lines.length,20);assert.equal(many.recent.length,20);
 assert.doesNotThrow(()=>serializeLocalCart(undefined));assert.deepEqual(JSON.parse(serializeLocalCart(null)),empty);
 assert.equal(parseLocalCart('{"__proto__":{"version":1},"version":1,"lines":[]}').lines.length,0);
});
test('migration 0011 matches the contract',async()=>{
 const sql=await readFile(new URL('../../migrations/0011_carts.sql',import.meta.url),'utf8');
 // 0027 rebuilds carts with the current status list; 0011 keeps the original four.
 const rebuilt=await readFile(new URL('../../migrations/0027_order_completed_retention.sql',import.meta.url),'utf8');
 assert.ok(rebuilt.includes(`CHECK (status IN (${CART_STATUSES.map(s=>`'${s}'`).join(',')}))`),'0027 CHECK lists exactly CART_STATUSES');
 for(const s of CART_STATUSES.filter(s=>s!=='completed'))assert.ok(sql.includes(`'${s}'`),s);
 assert.match(sql,/code TEXT NOT NULL UNIQUE/);assert.match(sql,/customer_id TEXT REFERENCES customers\(id\) ON DELETE SET NULL/);
 for(const col of ['supplier_id','supplier_name','external_product_id','variant_ids_json','unit_cost_minor','unit_price_minor','total_minor'])assert.ok(sql.includes(col),col);
 assert.match(sql,/UNIQUE \(cart_id, product_id, size\)/);assert.match(sql,/quantity BETWEEN 1 AND 10/);
});
test('size length matches the catalog limit of 100',()=>{
 assert.equal(cart.MAX_SIZE_LENGTH,100);
 assert.equal(validateCheckoutLines([line({size:'x'.repeat(100)})]).ok,true);
 assert.deepEqual(validateCheckoutLines([line({size:'x'.repeat(101)})]).problems.map(p=>p.code),['invalid_size']);
 assert.equal(parseLocalCart(JSON.stringify({version:1,lines:[line({size:'x'.repeat(100)}),line({productId:'q',size:'x'.repeat(101)})]})).lines.length,1);
});
test('local cart keeps only safe photo URLs and catalog slugs',()=>{
 const get=extra=>parseLocalCart(JSON.stringify({version:1,lines:[{...line(),...extra}]})).lines[0];
 for(const photo of ['javascript:alert(1)','//evil.example/x','http://x/y.jpg','data:image/png;base64,AA','/\\evil.example','https://','HTTPS:x',7,'/a\nb'])assert.equal(get({photo}).photo,null,String(photo));
 for(const photo of ['https://cdn.example/a.jpg','/assets/a.jpg'])assert.equal(get({photo}).photo,photo);
 assert.equal(get({slug:'good-slug-1'}).slug,'good-slug-1');
 for(const slug of ['Bad Slug','../x','-x','a/b','x'.repeat(151),'<script>'])assert.equal(get({slug}).slug,'',slug);
});
test('control characters are rejected and dedupe keys cannot collide',()=>{
 for(const bad of ['a\u0000b','a\tb','a\u007Fb','a\nb']){
  assert.deepEqual(validateCheckoutLines([line({productId:bad})]).problems.map(p=>p.code),['invalid_product_id']);
  assert.deepEqual(validateCheckoutLines([line({size:bad})]).problems.map(p=>p.code),['invalid_size']);
  assert.equal(parseLocalCart(JSON.stringify({version:1,lines:[line({size:bad})]})).lines.length,0);
 }
 assert.equal(validateCheckoutLines([line({productId:'a',size:'b c'}),line({productId:'a b',size:'c'})]).ok,true);
});
test('normalizeCode handles Unicode dashes, dots, underscores and compatibility forms',()=>{
 for(const input of ['SS\u2013ABCD\u20131234','SS\u2014ABCD\u20141234','SS\u2010ABCD\u20111234','SS.ABCD.1234','SS_ABCD_1234','\uFF33\uFF33\uFF0D\uFF21\uFF22\uFF23\uFF24\uFF0D\uFF11\uFF12\uFF13\uFF14'])assert.equal(normalizeCode(input),'SS-ABCD-1234',input);
 assert.equal(normalizeCode('SS-ABCD-12\u200B34'),null);
});
test('addLocalLine ignores invalid lines instead of throwing',()=>{
 const base=[line()];
 for(const bad of [null,undefined,7,'x',{},{productId:'',size:'M'},{productId:'a',size:'a\u0000'}]){
  const r=addLocalLine(base,bad);assert.deepEqual(r,{lines:base,added:false,capped:false,full:false});assert.notEqual(r.lines,base);
 }
 assert.deepEqual(addLocalLine(null,null).lines,[]);
 assert.equal(addLocalLine([],{productId:'a',size:'M',photo:'javascript:1'}).lines[0].photo,null);
});
test('migration 0011 enforces integer types and descending id tie-breaks',async()=>{
 for(const file of ['0011_carts','0027_order_completed_retention']){
  const sql=await readFile(new URL(`../../migrations/${file}.sql`,import.meta.url),'utf8');
  for(const col of ['item_count','total_minor','quantity','position','unit_price_minor','line_total_minor','unit_cost_minor'])assert.ok(sql.includes(`typeof(${col}) = 'integer'`),`${file} ${col}`);
  assert.match(sql,/carts\(created_at DESC, id DESC\)/);assert.match(sql,/carts\(status, created_at DESC, id DESC\)/);
 }
});
test('merging into an existing line keeps display fields unless replaced by valid values',()=>{
 const first={productId:'p',size:'M',quantity:1,title:'Худі',slug:'hoodie',photo:'https://x/a.jpg',priceMinor:100};
 let r=addLocalLine([],first);
 r=addLocalLine(r.lines,{productId:'p',size:'M',quantity:1});
 assert.deepEqual(r.lines[0],{...first,quantity:2});
 r=addLocalLine(r.lines,{productId:'p',size:'M',quantity:1,photo:'javascript:1',slug:'Bad Slug',title:''});
 assert.deepEqual(r.lines[0],{...first,quantity:3});
 r=addLocalLine(r.lines,{productId:'p',size:'M',quantity:1,title:'Нове',priceMinor:250});
 assert.equal(r.lines[0].title,'Нове');assert.equal(r.lines[0].priceMinor,250);assert.equal(r.lines[0].slug,'hoodie');
});
