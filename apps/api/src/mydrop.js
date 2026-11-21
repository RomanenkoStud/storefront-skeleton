import { fail, integer, text, validateSource, supplierUrl, photoUrl } from './domain.js';
export function connectionId(value) {
  if(value===null||value===undefined||value==='')return null;
  if(typeof value!=='string'||!/^\d{1,18}$/.test(value)||value[0]==='0')fail('MyDrop connectionId must be a positive integer string from the connected-suppliers API');
  return value;
}
function sourceId(value,label){if(!['string','number'].includes(typeof value)||(typeof value==='number'&&(!Number.isSafeInteger(value)||value<=0)))fail(`Invalid MyDrop ${label}`);return text(String(value),label,200,false);}
/** Convert a MyDrop UAH amount to kopecks. Numbers are read through toFixed(8) so
 * discount-derived floats such as 233.33333333333334 parse; strings may use a
 * decimal comma. Rounds half-up on the third decimal using decimal digits only. */
export function uahToMinor(value) {
  let input;
  if(typeof value==='number'){if(!Number.isFinite(value)||value<0||value>=1e9)fail('Invalid MyDrop drop_price');input=value.toFixed(8);}
  else if(typeof value==='string')input=value.trim().replace(',','.');
  else fail('Invalid MyDrop drop_price');
  if(!/^\d{1,9}(?:\.\d+)?$/.test(input))fail('Invalid MyDrop drop_price');
  const [whole,fraction='']=input.split('.');
  const minor=Number(whole)*100+Number((fraction+'00').slice(0,2))+(Number(fraction[2]||'0')>=5?1:0);
  return integer(minor,'MyDrop drop_price',100000000);
}
/** Stock: integers or digit strings; negative (oversold) clamps to 0; unknown/null is
 * treated as unavailable (0) — never fabricate availability. */
function stockOf(value) {
  const n=typeof value==='string'&&/^-?\d{1,9}$/.test(value.trim())?Number(value.trim()):value;
  if(!Number.isSafeInteger(n))return 0;
  return Math.min(Math.max(n,0),1000000);
}
const label=value=>typeof value==='string'&&value.trim()?value.trim():typeof value==='number'&&Number.isFinite(value)?String(value):null;
const clip=(value,max)=>value.length>max?value.slice(0,max).trim():value;
export const DEFAULT_VARIANT_ID='default';
export const SKIP_REASONS={bundle_invalid:'набір без коректного складу',bundle_no_common_size:'набір без спільного розміру для всіх речей',bundle_too_large:'набір має забагато складових',price_missing:'немає drop_price',price_type:'drop_price не число/рядок',price_invalid:'некоректна drop_price (відʼємна або нечислова)',title:'немає назви',id:'некоректний або повторний ID товару',variants:'понад 100 розмірів',sizes_invalid:'усі розміри некоректні',published_invalid:'оновлення зламало б опублікований товар (залишено як є)',invalid:'некоректні дані товару'};
class Skip extends Error{constructor(reason){super(reason);this.reason=reason;}}
/** Usable size variants: invalid/duplicate IDs and unlabeled sizes are dropped. */
function sizeList(sizes) {
  const seen=new Set(),variants=[];
  for(const size of Array.isArray(sizes)?sizes:[]){
    if(!size||typeof size!=='object')continue;
    let id;try{id=sourceId(size.id,'size ID');}catch{continue;}
    const name=label(size.formatted)||label(size.title)||label(size.sku);
    if(!name||seen.has(id))continue;seen.add(id);
    // 0/1 may encode only coarse availability. Preserve the supplied value.
    variants.push({id,size:clip(name,100),stock:stockOf(size.real_count_dropshipper)});
  }
  return variants;
}
const sizeKey=value=>value.toLowerCase().replace(/\s+/g,' ').trim();
/** Matched-size bundles: a bundle size exists when every sized component
 * offers it; one-size components (caps, bags) join every size. Stock is the
 * minimum over distinct components of floor(stock / units of that component in the set).
 * The private variant ID keeps each component's product and size ID for order routing. */
function bundleVariants(children) {
  if(!Array.isArray(children)||!children.length)throw new Skip('bundle_invalid');
  const components=new Map();
  for(const child of children){
    if(!child||typeof child!=='object')throw new Skip('bundle_invalid');
    let id;try{id=sourceId(child.id,'component ID');}catch{throw new Skip('bundle_invalid');}
    const existing=components.get(id);if(existing){existing.units++;continue;}
    const sizes=sizeList(child.sizes);
    // Sizes listed but none usable: a sized garment must not be sold as one-size.
    if(!sizes.length&&Array.isArray(child.sizes)&&child.sizes.length)throw new Skip('bundle_invalid');
    components.set(id,{id,units:1,sizes:sizes.length?sizes:[{id:DEFAULT_VARIANT_ID,size:'Один розмір',stock:stockOf(child.real_count_dropshipper)}]});
  }
  const all=[...components.values()],sized=all.filter(c=>c.sizes.length>1);
  // A single-size component is universal (one-size) unless its label is a size of any
  // sized component, e.g. only "M" listed: then it restricts the bundle to that size.
  // Using the union of sized labels keeps the result independent of component order.
  const sizedKeys=new Set(sized.flatMap(c=>c.sizes.map(s=>sizeKey(s.size))));
  const multi=all.filter(c=>c.sizes.length>1||sizedKeys.has(sizeKey(c.sizes[0].size)));
  const universal=c=>!multi.includes(c);
  const labels=[];
  // Every component has one size: the bundle has one size, named by the distinct labels.
  if(!multi.length)labels.push(clip([...new Map(all.map(c=>[sizeKey(c.sizes[0].size),c.sizes[0].size])).values()].join(' / '),100));
  else for(const {size} of (sized[0]??multi[0]).sizes){
    const key=sizeKey(size);
    if(!labels.some(l=>sizeKey(l)===key)&&multi.every(c=>c.sizes.some(s=>sizeKey(s.size)===key)))labels.push(size);
  }
  if(!labels.length)throw new Skip('bundle_no_common_size');
  if(labels.length>100)throw new Skip('variants');
  return labels.map(size=>{
    // A label repeated under several size IDs uses the entry with the most stock.
    const pick=c=>c.sizes.filter(s=>sizeKey(s.size)===sizeKey(size)).reduce((a,b)=>b.stock>a.stock?b:a);
    const parts=all.map(c=>({c,s:universal(c)?c.sizes[0]:pick(c)}));
    const id=`set:${parts.map(({c,s})=>`${c.id}.${s.id}`).join('+')}`;
    if(id.length>200)throw new Skip('bundle_too_large');
    return{id,size,stock:Math.min(...parts.map(({c,s})=>Math.floor(s.stock/c.units)))};
  });
}
function product(raw,categories) {
  const bundle=(raw.is_set!==false&&raw.is_set!==undefined&&raw.is_set!==null)||(Array.isArray(raw.child_products)&&raw.child_products.length>0);
  const title=label(raw.title);if(!title)throw new Skip('title');
  const price=raw.drop_price;
  if(price===null||price===undefined||(typeof price==='string'&&!price.trim()))throw new Skip('price_missing');
  if(!['number','string'].includes(typeof price))throw new Skip('price_type');
  let costMinor;try{costMinor=uahToMinor(price);}catch{throw new Skip('price_invalid');}
  let category='Без категорії';
  try{category=categories.get(sourceId(raw.category_id,'category ID'))??category;}catch{}
  const sizes=Array.isArray(raw.sizes)?raw.sizes:[];
  const variants=bundle?bundleVariants(raw.child_products):sizeList(sizes);
  if(variants.length>100)throw new Skip('variants');
  if(!variants.length&&sizes.length)throw new Skip('sizes_invalid');
  // Products without size variations (accessories, cosmetics…) get one stable variant.
  if(!variants.length)variants.push({id:DEFAULT_VARIANT_ID,size:'Один розмір',stock:stockOf(raw.real_count_dropshipper)});
  const children=bundle?raw.child_products.filter(c=>c&&typeof c==='object'):[];
  const images=[...(Array.isArray(raw.images)?raw.images:[]),...[...sizes,...children.flatMap(c=>Array.isArray(c.sizes)?c.sizes:[])].flatMap(size=>Array.isArray(size?.images)?size.images:[])];
  const photos=[];
  for(const image of images){
    if(photos.length>=30)break;
    try{const url=photoUrl(image?.full_url);if(!photos.includes(url))photos.push(url);}catch{}
  }
  const description=typeof raw.description==='string'?clip(raw.description,20000):'';
  try{return validateSource({externalId:sourceId(raw.id,'product ID'),title:clip(title,300),description,category,costMinor,currency:'UAH',photos,variants});}
  catch{throw new Skip('invalid');}
}
/** Normalize a dropshipper export. Whole-export problems (shape, size limits) reject the
 * sync; a product the catalog cannot represent is skipped with a reason so one bundle or
 * malformed price never blocks the rest of the supplier. */
export function normalizeMyDrop(body) {
  if(!body||typeof body!=='object'||!Array.isArray(body.categories)||!Array.isArray(body.products))fail('MyDrop export must contain categories and products');
  if(body.products.length>5000)fail('MyDrop export exceeds the 5000-product sync limit',422);
  if(body.categories.length>5000)fail('MyDrop export has too many categories');
  const categories=new Map();
  for(const c of body.categories){
    if(!c||typeof c!=='object')continue;
    try{categories.set(sourceId(c.id,'category ID'),label(c.title)?clip(label(c.title),200):'Без категорії');}catch{}
  }
  // An ID that appears more than once is ambiguous (which price wins?): skip every copy.
  const counts=new Map();
  for(const raw of body.products){try{const id=sourceId(raw?.id,'product ID');counts.set(id,(counts.get(id)||0)+1);}catch{}}
  const items=[],skipped=[];
  for(const raw of body.products){
    let externalId=null;
    try{
      if(!raw||typeof raw!=='object')throw new Skip('invalid');
      try{externalId=sourceId(raw.id,'product ID');}catch{throw new Skip('id');}
      if(counts.get(externalId)>1)throw new Skip('id');
      items.push(product(raw,categories));
    }catch(error){
      if(!(error instanceof Skip))throw error;
      skipped.push({externalId,reason:error.reason});
    }
  }
  return{items,skipped};
}
/** Human-readable run note, e.g. "Пропущено 3 з 120 товарів: набір без спільного розміру для всіх речей — 2; …". */
export function skippedSummary(skipped,total) {
  if(!skipped.length)return null;
  const counts=new Map();for(const s of skipped)counts.set(s.reason,(counts.get(s.reason)||0)+1);
  return `Пропущено ${skipped.length} з ${total} товарів: ${[...counts].map(([r,n])=>`${SKIP_REASONS[r]||r} — ${n}`).join('; ')}`;
}

/** Keep only fields needed to register suppliers; upstream credentials/contacts never leave this boundary. */
export function normalizeConnections(body) {
  if(!body||!Array.isArray(body.results)||body.results.length>1000)fail('Invalid MyDrop connected-suppliers response',422);
  const seen=new Set();
  return body.results.map(row=>{
    if(!row||typeof row!=='object'||!row.vendor||typeof row.vendor!=='object')fail('Invalid MyDrop supplier connection',422);
    const connection=connectionId(sourceId(row.id,'connection ID'));
    if(seen.has(connection))fail('Duplicate MyDrop supplier connection',422);seen.add(connection);
    const name=text(row.vendor.name,'supplier name',200,false);
    let url=null;
    if(typeof row.vendor.publicUrl==='string'&&row.vendor.publicUrl.trim()) {
      const value=row.vendor.publicUrl.trim();
      try{url=supplierUrl(value.startsWith('https://')?value:`https://mydrop.com.ua/${value}`);}catch{}
    }
    return{connectionId:connection,name,url,verified:row.verified===true,hidden:row.hidden===true};
  });
}
