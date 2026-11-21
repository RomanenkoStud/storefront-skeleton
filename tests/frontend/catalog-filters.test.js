import test from 'node:test';
import assert from 'node:assert/strict';
import { EMPTY_FILTERS, readFilters, writeFilters, filterProducts, normalizeSize } from '../../apps/web/src/catalog-filters.js';
const product=(id,categoryId,brand,priceMinor,size,stock,updatedAt='2026-01-01T00:00:00Z')=>({id,categoryId,brand,title:id,description:'',priceMinor,variants:[{size,stock}],updatedAt});
const products=[
  product('lorem-hoodie','hoodies','Lorem',20000,'M',3),
  product('polo-jacket','jackets','Polo Tempora Club',30000,'М',1),
  product('lorem-shoes','sneakers','Lorem',15000,'42 (26.5см)',1),
  product('dolor-zip','zip-hoodies','Dölor',25000,'Xl',1,'2026-02-01T00:00:00Z'),
  product('unavailable','unclassified',null,10000,'Чорна',0),
];
const filters=patch=>({...EMPTY_FILTERS,...patch});
test('parent category includes descendants while brand and stock-size filters combine',()=>{
 assert.deepEqual(filterProducts(products,filters({category:'clothing',brands:['Lorem']})).map(p=>p.id),['lorem-hoodie']);
 assert.deepEqual(filterProducts(products,filters({category:'hoodies-sweatshirts',brands:['Lorem','Dölor'],sizes:['XL']})).map(p=>p.id),['dolor-zip']);
 assert.deepEqual(filterProducts(products,filters({brands:['Lorem'],sizes:['42']})).map(p=>p.id),['lorem-shoes']);
});
test('sizes normalize manufacturer labels without turning colors or fit notes into other sizes',()=>{
 for(const [source,expected] of [['Xl','XL'],['М','M'],['42 (26.5см)','42'],['41.5 (26см)','41.5'],['41,5','41.5'],['40–41','40-41'],['S/M','S/M'],['S-M','S-M'],['M (Маломірить на С)','M'],['Чорна',null],['Сіра',null]]) assert.equal(normalizeSize(source),expected);
 const unavailableXL={...products[0],variants:[{size:'XL',stock:0}]};
 assert.equal(filterProducts([unavailableXL],filters({sizes:['XL']})).length,0);
});
test('retail price bounds are inclusive and sorting does not mutate input order',()=>{
 const order=products.map(p=>p.id);
 assert.deepEqual(filterProducts(products,filters({min:'150',max:'250',sort:'price-asc'})).map(p=>p.priceMinor),[15000,20000,25000]);
 assert.deepEqual(filterProducts(products,filters({min:'150',max:'250',sort:'price-desc'})).map(p=>p.priceMinor),[25000,20000,15000]);
 assert.deepEqual(products.map(p=>p.id),order);
 assert.equal(filterProducts(products,filters({available:true})).length,4);
});
test('multiple brands and sizes survive URL encoding and roundtrip without duplicates',()=>{
 const selected=filters({q:'Речі & стиль',category:'clothing',brands:['C.D. Company','Dölor'],sizes:['M','42'],min:'100.50',max:'2000',available:true,sort:'price-desc'});
 assert.deepEqual(readFilters(writeFilters(selected)),selected);
 const parsed=readFilters('?brand=Lorem&brand=Lorem&size=M&size=M&min=-1&max=nope&sort=bad');
 assert.deepEqual(parsed.brands,['Lorem']);assert.deepEqual(parsed.sizes,['M']);assert.equal(parsed.min,'');assert.equal(parsed.max,'');assert.equal(parsed.sort,'new');
});
test('search includes inferred brand and category, while clearing returns the full published input',()=>{
 assert.equal(filterProducts(products,filters({q:'dölor'}))[0].id,'dolor-zip');
 assert.equal(filterProducts(products,filters({q:'not in catalog'})).length,0);
 assert.equal(filterProducts(products,filters({})).length,products.length);
});

test('runtime categories include custom grandchildren and resolve retired category filters',async()=>{
 const {createTaxonomyContext}=await import('../../packages/catalog/taxonomy.js');
 const taxonomy=createTaxonomyContext({nodes:[{id:'custom-root',label:'Custom',parentId:null,position:0},{id:'custom-child',label:'Child',parentId:'custom-root',position:0},{id:'custom-leaf',label:'Leaf',parentId:'custom-child',position:0}],redirects:{'retired-category':'custom-child'}});
 const custom=product('nested','custom-leaf','Lorem',20000,'M',2);
 assert.deepEqual(filterProducts([custom],filters({category:'custom-root'}),taxonomy).map(p=>p.id),['nested']);
 assert.deepEqual(filterProducts([custom],filters({category:'retired-category'}),taxonomy).map(p=>p.id),['nested']);
 assert.deepEqual(filterProducts([custom],filters({category:'clothing'}),taxonomy),[]);
});
