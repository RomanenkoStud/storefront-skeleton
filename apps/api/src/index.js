import { staffAdmin } from './staff-admin.js';
import {taxonomyRoute,taxonomyView} from './taxonomy.js';
import { retrieveProductImage, imageLineage, saveCutout, saveNormalized, saveProductPhoto, imageType } from './image-processing.js';
import {loadRecognition,recognitionRoute} from './recognition.js';
import { storeMedia, isPublicMedia, requireNewMediaExists, removedMediaKeys, deleteUnreferenced, purgeProduct, mediaLibrary, scanMedia, cleanupMedia } from './media.js';
import { HttpError, fail, text, supplierUrl, validateSource, validateOverrides, productProjection, slugFor, escapeHtml, normalizeTags, TAG_LIMITS } from './domain.js';
import { MANUAL_PRODUCT_FIELDS, MANUAL_NO_FEED, rejectUnknown, manualProductFromRequest, manualSourcePatch } from './manual.js';
import { authenticated, identity, checkOrigin } from './auth.js';
import { parseEasyDropLink, EasyDropLinkError, keyLast4, buildEasyDropFeedUrl } from './easydrop-link.js';
import { normalizeEasyDrop, easydropSkippedSummary, EASYDROP_LIMITS } from './easydrop.js';
import { connectionId, normalizeMyDrop, normalizeConnections, skippedSummary } from './mydrop.js';
import { handleAccount } from './customer-auth.js';
import { handleDelivery } from './nova-poshta.js';
import { handleCart, listCarts, getCart, changeStatus } from './carts.js';
import { recordVisit, dashboard } from './analytics.js';
import { infraOverview, createRenewal, updateRenewal, deleteRenewal, setPlan } from './infra.js';
import { publicCatalog, publicEntryBySlug } from './merged.js';
import { isCardThumbnailKey, isPublicCardThumbnail, withCardPhoto, withCardPhotos } from './photo-derivatives.js';
import { duplicatesOverview, confirmGroup, rejectCandidates, restoreRejection, dissolveGroup, removeMember } from './duplicates.js';
import { seoHtml } from './product-page.js';
import { DEFAULT_SCENE_ID } from '../../../packages/catalog/campaign-scenes.js';
import { readCampaign, validateCampaign, writeCampaignStatement, readTicker, validateTicker, writeTickerStatement, readCheckout, validateCheckout, writeCheckoutStatement, readBanner, validateBanner, writeBannerStatement, activeBanner } from './storefront-settings.js';
import { listImages, publicImages, isPublicStorefrontKey, setImage, resetImage, STOREFRONT_KEY } from './storefront-images.js';
import { listPictures, publicPictures, isPublicCampaignKey, addPicture, orderPictures, removePicture, CAMPAIGN_KEY } from './campaign-pictures.js';
import { handleStaff, resolveStaffPrincipal, staffUnauthorized } from './staff-auth.js';
import { dispatchAdmin, assertHandlers, actorLabel, auditStatement, can, requirePermission, permissionsFor } from './permissions.js';
import { purgeExpiredOrderPersonalData } from './order-retention.js';
const now = () => new Date().toISOString();
const id = () => crypto.randomUUID();
const json = (data,status=200,headers={}) => new Response(JSON.stringify(data),{status,headers:{'Content-Type':'application/json; charset=utf-8','Cache-Control':'no-store',...headers}});
async function readBounded(request,limit) {
  if(Number(request.headers.get('Content-Length'))>limit)fail('Request too large',413);
  const reader=request.body?.getReader();if(!reader)return new Uint8Array();
  const chunks=[];let size=0;
  try{while(true){const{done,value}=await reader.read();if(done)break;size+=value.byteLength;if(size>limit){await reader.cancel();fail('Request too large',413);}chunks.push(value);}}finally{reader.releaseLock();}
  const bytes=new Uint8Array(size);let offset=0;for(const chunk of chunks){bytes.set(chunk,offset);offset+=chunk.length;}return bytes;
}
async function readJson(request) {
  if (!request.headers.get('Content-Type')?.startsWith('application/json')) fail('Content-Type application/json required',415);
  const raw=new TextDecoder().decode(await readBounded(request,2000000));
  try { const data=JSON.parse(raw); if(!data||typeof data!=='object'||Array.isArray(data)) fail('JSON object required');return data; } catch(error) { if(error instanceof HttpError) throw error;fail('Invalid JSON'); }
}
// updated_at orders the public catalog ("newest" sort, Fresh drop). An edit that changes nothing a customer can
// see — e.g. internal manager tags — must not move the product, so keep its timestamp in that case.
function storefrontChanged(before,after,env){
  const at=Date.now(),view=row=>{const o=JSON.parse(row.overrides_json),{updatedAt,...product}=productProjection({...row,updated_at:''},at,true,env.RECOGNITION?.settings,env.RECOGNITION?.taxonomy);return JSON.stringify([product,!!o.published,o.promoStartsAt??null,o.promoEndsAt??null,o.promoText??'',!!o.freeShipping]);};
  try{return view(before)!==view(after);}catch{return true;}
}
const supplier = row => ({id:row.id,name:row.name,provider:row.provider??'mydrop',url:row.url,connectionId:row.connection_id??null,feed:row.provider==='easydrop'?{configured:!!row.feed_key,keyLast4:row.feed_key?keyLast4(row.feed_key):null,updatedAt:row.feed_updated_at??null}:null,enabled:!!row.enabled,deletedAt:row.deleted_at??null,productCount:row.product_count??0,publishedCount:row.published_count??0,createdAt:row.created_at,lastSyncAt:row.last_sync_at,lastSuccessAt:row.last_success_at??null,lastSyncStatus:row.last_sync_status,lastSyncError:row.last_sync_error});
async function rows(env,sql,...bindings) { return (await env.DB.prepare(sql).bind(...bindings).all()).results; }
// Same order as ORDER BY updated_at DESC. D1 bills every row SQLite's sorter reads back as a row read,
// which doubled the cost of large lists, so list queries sort in the Worker instead.
const newestFirst=list=>list.sort((a,b)=>a.updated_at<b.updated_at?1:a.updated_at>b.updated_at?-1:0);
async function getSupplier(env,supplierId,includeDeleted=false) {
  const row=await env.DB.prepare(`SELECT s.*,(SELECT COUNT(*) FROM products p WHERE p.supplier_id=s.id AND p.deleted_at IS NULL) AS product_count,(SELECT COUNT(*) FROM products p WHERE p.supplier_id=s.id AND p.deleted_at IS NULL AND json_extract(p.overrides_json,'$.published')=1) AS published_count FROM suppliers s WHERE s.id=?`).bind(supplierId).first();
  if(!row||(!includeDeleted&&row.deleted_at))fail('Supplier not found',404);return row;
}
function validatePublication(row,message='Publishing requires title, category, positive price, photo and visible variants',settings=null,taxonomy=null) {
  const projection=productProjection(row,Date.now(),false,settings,taxonomy);
  if(projection.published&&(!projection.title.trim()||!projection.category.trim()||projection.priceMinor<=0||!projection.photos.length||!projection.variants.length))fail(message);
  return projection;
}
async function productRow(env,productId,includeDeleted=false) {
  const row=await env.DB.prepare('SELECT p.*,s.deleted_at AS supplier_deleted_at FROM products p JOIN suppliers s ON s.id=p.supplier_id WHERE p.id=?').bind(productId).first();
  if(!row||row.supplier_deleted_at||(!includeDeleted&&row.deleted_at))fail('Product not found',404);return row;
}
async function supplierList(env,deleted) {
  return(await rows(env,`SELECT s.*,(SELECT COUNT(*) FROM products p WHERE p.supplier_id=s.id AND p.deleted_at IS NULL) AS product_count,(SELECT COUNT(*) FROM products p WHERE p.supplier_id=s.id AND p.deleted_at IS NULL AND json_extract(p.overrides_json,'$.published')=1) AS published_count,(SELECT MAX(r.created_at) FROM sync_runs r WHERE r.supplier_id=s.id AND r.status IN ('synced','imported')) AS last_success_at FROM suppliers s WHERE s.deleted_at IS ${deleted?'NOT ':''}NULL ORDER BY s.created_at DESC`)).map(supplier);
}
function requireConfirmation(body){if(body.confirm!==true)fail('Explicit confirm:true is required for deletion');}
function productLifecycleStatement(env,row,action) {
  const overrides={...JSON.parse(row.overrides_json),published:action==='publish'};
  const updated={...row,overrides_json:JSON.stringify(overrides),deleted_at:action==='delete'?now():null,updated_at:now()};
  validatePublication(updated,`Product ${row.id} cannot be published: supply title, category, positive price, photo and visible variants`,env.RECOGNITION?.settings,env.RECOGNITION?.taxonomy);
  return{updated,statement:env.DB.prepare('UPDATE products SET overrides_json=?,deleted_at=?,updated_at=? WHERE id=?').bind(updated.overrides_json,updated.deleted_at,updated.updated_at,row.id)};
}
// Bulk add/remove internal tags on 1–50 products. Tags are invisible to customers, so updated_at (storefront
// order) is left alone; json_set touches only $.tags so a concurrent edit of other fields is never overwritten.
async function bulkTags(env,body) {
  if(!body||typeof body!=='object'||Array.isArray(body))fail('Invalid request');
  for(const key of Object.keys(body))if(!['ids','add','remove'].includes(key))fail(`Unknown field: ${key}`);
  const ids=body.ids;
  if(!Array.isArray(ids)||!ids.length||ids.length>50||ids.some(value=>typeof value!=='string'||!value||value.length>200)||new Set(ids).size!==ids.length)fail('Supply 1–50 unique product IDs');
  const add=normalizeTags(body.add??[]),remove=normalizeTags(body.remove??[]);
  if(!add.length&&!remove.length)fail('Choose tags to add or remove');
  const key=tag=>tag.normalize('NFC').toLocaleLowerCase('uk'),removeKeys=new Set(remove.map(key));
  if(add.some(tag=>removeKeys.has(key(tag))))fail('A tag cannot be both added and removed');
  const found=await rows(env,`SELECT p.*,s.deleted_at AS supplier_deleted_at FROM products p JOIN suppliers s ON s.id=p.supplier_id WHERE p.id IN (${ids.map(()=>'?').join(',')})`,...ids);
  if(found.length!==ids.length)fail('One or more selected products do not exist',404);
  const statements=[],at=now();
  for(const row of found){
    if(row.deleted_at||row.supplier_deleted_at)fail(`Product ${row.id} is in Trash; restore it first`,409);
    const before=JSON.parse(row.overrides_json).tags??[],kept=before.filter(tag=>!removeKeys.has(key(tag)));
    const have=new Set(kept.map(key)),next=[...kept,...add.filter(tag=>!have.has(key(tag)))];
    if(next.length>TAG_LIMITS.count)fail(`Product ${row.id} would have more than ${TAG_LIMITS.count} tags`);
    if(JSON.stringify(next)===JSON.stringify(before))continue;
    statements.push(env.DB.prepare("UPDATE products SET overrides_json=json_set(overrides_json,'$.tags',json(?)) WHERE id=?").bind(JSON.stringify(next),row.id),auditStatement(env,'product.tags',row.id,at,{add,remove}));
  }
  if(statements.length)await env.DB.batch(statements);
  return{updated:statements.length/2,matched:found.length};
}
async function bulkProducts(env,body) {
  const actions=['publish','unpublish','delete','restore'];
  if(!actions.includes(body.action))fail('Choose publish, unpublish, delete or restore');
  requirePermission(env.PRINCIPAL,body.action==='publish'||body.action==='unpublish'?'products.publish':'products.trash');
  if(!Array.isArray(body.ids)||!body.ids.length||body.ids.length>50||body.ids.some(value=>typeof value!=='string'||!value||value.length>200)||new Set(body.ids).size!==body.ids.length)fail('Supply 1–50 unique product IDs');
  if(body.action==='delete')requireConfirmation(body);
  const found=await rows(env,`SELECT p.*,s.deleted_at AS supplier_deleted_at FROM products p JOIN suppliers s ON s.id=p.supplier_id WHERE p.id IN (${body.ids.map(()=>'?').join(',')})`,...body.ids);
  if(found.length!==body.ids.length)fail('One or more selected products do not exist',404);
  const statements=[];
  for(const row of found){
    if(row.supplier_deleted_at)fail(`Product ${row.id} belongs to a deleted supplier; restore the supplier first`,409);
    if(body.action==='restore'?!row.deleted_at:!!row.deleted_at)fail(`Product ${row.id} is ${row.deleted_at?'in Trash; restore it first':'not in Trash'}`,409);
    statements.push(productLifecycleStatement(env,row,body.action).statement,audit(env,`product.${body.action}`,row.id));
  }
  await env.DB.batch(statements);return{updated:found.length,action:body.action};
}
function audit(env,action,resourceId) { return auditStatement(env,action,resourceId,now()); }
const withoutConnection=({connectionId:_omitted,feed,...rest})=>({...rest,feed:feed?{configured:feed.configured}:null});
async function recordRun(env,supplierId,status,imported=0,error=null) {
  const timestamp=now();
  await env.DB.batch([env.DB.prepare('INSERT INTO sync_runs(id,supplier_id,status,imported,error,created_at) VALUES(?,?,?,?,?,?)').bind(id(),supplierId,status,imported,error,timestamp),env.DB.prepare('UPDATE suppliers SET last_sync_at=?,last_sync_status=?,last_sync_error=? WHERE id=?').bind(timestamp,status,error,supplierId)]);
}
async function importItems(env,supplierId,payload,maxItems=200,{tolerant=false}={}) {
  if((await getSupplier(env,supplierId)).provider==='manual')fail(MANUAL_NO_FEED,409);
  if (!Array.isArray(payload.items)||!payload.items.length||payload.items.length>maxItems) fail(`Import requires 1–${maxItems} source items`);
  const items=payload.items.map(validateSource);
  if(new Set(items.map(x=>x.externalId)).size!==items.length)fail('Duplicate source IDs in import');
  const existing=new Map((await rows(env,'SELECT * FROM products WHERE supplier_id=?',supplierId)).map(row=>[row.external_id,row]));
  const statements=[],skippedPublished=[];let imported=0,skippedDeleted=0;
  for(const source of items) {
    const productId=id(),timestamp=now();
    const previous=existing.get(source.externalId);
    if(previous?.deleted_at){skippedDeleted++;continue;}
    if(previous){
      try{validatePublication({...previous,source_json:JSON.stringify(source)},'Source refresh would invalidate a published product; adjust overrides or unpublish first',env.RECOGNITION?.settings,env.RECOGNITION?.taxonomy);}
      // API sync keeps the published row unchanged and reports it instead of failing the supplier.
      catch(error){if(!tolerant||!(error instanceof HttpError))throw error;skippedPublished.push({externalId:source.externalId,reason:'published_invalid'});continue;}
    }
    imported++;
    const sourceJson=JSON.stringify(source);
    // Unchanged source: the upsert would only bump updated_at, so skip it and write nothing.
    if(previous&&previous.source_json===sourceJson)continue;
    statements.push(env.DB.prepare('INSERT INTO products(id,supplier_id,external_id,source_json,overrides_json,slug,updated_at) VALUES(?,?,?,?,?,?,?) ON CONFLICT(supplier_id,external_id) DO UPDATE SET source_json=excluded.source_json,updated_at=excluded.updated_at').bind(productId,supplierId,source.externalId,sourceJson,'{}',slugFor(source,productId),timestamp));
  }
  statements.push(audit(env,'supplier.import',supplierId));
  await env.DB.batch(statements);
  await recordRun(env,supplierId,'imported',imported);
  return {imported,...(skippedDeleted?{skippedDeleted}:{}),...(skippedPublished.length?{skippedPublished}:{})};
}
function feedLink(value) { try{return parseEasyDropLink(value);}catch(error){if(error instanceof EasyDropLinkError)fail(error.message);throw error;} }
async function assertFeedKeyFree(env,key,exceptId=null) {
  const owner=await env.DB.prepare("SELECT id,deleted_at FROM suppliers WHERE provider='easydrop' AND feed_key=?").bind(key).first();
  if(owner&&owner.id!==exceptId)fail(owner.deleted_at?'This EasyDrop link belongs to a supplier in Trash; restore it instead':'This EasyDrop link is already used by another supplier',409);
}
// A lost race on the unique index surfaces as a constraint error; report it without echoing statement bindings.
async function insertOrConflict(env,statements) { try{return await env.DB.batch(statements);}catch(error){if(/UNIQUE constraint failed: suppliers\.(provider|feed_key)/.test(String(error?.message)))fail('This EasyDrop link is already used by another supplier',409);throw error;} }
async function syncSupplier(env,row) {
  // Manual suppliers have no feed: refuse before any run record, cooldown claim or fetch.
  if(row.provider==='manual')fail(MANUAL_NO_FEED,409);
  if(row.provider==='easydrop')return syncEasyDrop(env,row);
  let attempted=false;
  try {
    if(!env.MYDROP_API_KEY||typeof env.MYDROP_API_KEY!=='string')fail('MyDrop API key is not configured; set the MYDROP_API_KEY Worker secret',422);
    if(!row.connection_id)fail('Set the MyDrop connection ID from the connected-suppliers API; it cannot be derived from the public page URL',422);
    const timestamp=Date.now();
    const claim=await env.DB.prepare('UPDATE suppliers SET last_api_request_at=? WHERE id=? AND (last_api_request_at IS NULL OR last_api_request_at<=?) RETURNING id').bind(timestamp,row.id,timestamp-900000).first();
    if(!claim)fail('MyDrop export was requested recently; retry after 15 minutes',429);
    attempted=true;
    const endpoint=`https://backend.mydrop.com.ua/dropshipper/api/export/dropshipper_vendors/${connectionId(row.connection_id)}/products/json`;
    const response=await fetch(endpoint,{redirect:'manual',headers:{Accept:'application/json','Content-Type':'application/json','X-API-KEY':env.MYDROP_API_KEY},signal:AbortSignal.timeout(20000)});
    if(response.status===401||response.status===403){await response.body?.cancel();fail('MyDrop API access was denied; verify the API key, subscription and connected supplier permissions',422);}
    if(response.status>=300&&response.status<400){await response.body?.cancel();fail('MyDrop API redirected unexpectedly; credentials were not forwarded',422);}
    if(!response.ok){await response.body?.cancel();fail(`MyDrop API returned HTTP ${response.status}; retry later`,422);}
    if(!response.headers.get('Content-Type')?.includes('application/json')){await response.body?.cancel();fail('MyDrop API returned a non-JSON response',422);}
    const bytes=await readBounded(response,8000000);let body;
    try{body=JSON.parse(new TextDecoder().decode(bytes));}catch{fail('MyDrop API returned invalid JSON',422);}
    if(response.status===202){
      if(body.status!=='pending')fail('Unexpected MyDrop pending response',422);
      const progress=typeof body.progress==='number'&&Number.isFinite(body.progress)?Math.max(0,Math.min(100,body.progress)):0;
      await recordRun(env,row.id,'pending',0,'Catalog is being generated by MyDrop; retry after 15 minutes');
      return{status:'pending',progress,retryAfterSeconds:900};
    }
    const {items,skipped}=normalizeMyDrop(body);
    // Every product unusable is a failure, not a successful empty sync; existing inventory is untouched.
    if(!items.length&&skipped.length)fail(`MyDrop export has no importable products. ${skippedSummary(skipped,body.products.length)}`,422);
    const {skippedPublished=[],...result}=items.length?await importItems(env,row.id,{items},5000,{tolerant:true}):{imported:0};
    const all=[...skipped,...skippedPublished],note=skippedSummary(all,body.products.length);
    await recordRun(env,row.id,'synced',result.imported,note);
    return{status:'synced',...result,...(all.length?{skippedCount:all.length,skippedIds:all.map(s=>s.externalId).filter(Boolean).slice(0,50),skippedNote:note}:{})};
  }catch(error){
    if(error instanceof HttpError&&error.status===429)throw error;
    const safe=error instanceof HttpError?error.message:'MyDrop API could not be reached; retry later';
    await recordRun(env,row.id,attempted?'failed':'blocked',0,safe);
    throw new HttpError(error instanceof HttpError?error.status:422,safe);
  }
}
// Streamed read with a hard cap; the feed URL, key and pid never appear in messages.
async function readFeedBounded(response,limit,signal) {
  const aborted=new Promise((_,reject)=>{const stop=()=>reject(new Error('timeout'));if(signal.aborted)stop();else signal.addEventListener('abort',stop,{once:true});});
  aborted.catch(()=>{});
  const tooLarge=()=>fail('EasyDrop feed exceeds the 12 MB limit',422);
  if(Number(response.headers.get('Content-Length'))>limit)tooLarge();
  const reader=response.body?.getReader();if(!reader)return new Uint8Array();
  const chunks=[];let size=0;
  try{while(true){const{done,value}=await Promise.race([reader.read(),aborted]);if(done)break;size+=value.byteLength;if(size>limit){await reader.cancel();tooLarge();}chunks.push(value);}}catch(error){reader.cancel().catch(()=>{});throw error;}finally{try{reader.releaseLock();}catch{}}
  const bytes=new Uint8Array(size);let offset=0;for(const chunk of chunks){bytes.set(chunk,offset);offset+=chunk.length;}return bytes;
}
const XML_TYPE=/^(?:text|application)\/xml\s*(?:;|$)/i;
// Diagnostics for unexpected errors: strip anything that could carry the feed link, then clip.
function scrubDiagnostic(value) { return String(value??'').replace(/https?:\/\/\S+/gi,'<redacted>').replace(/\b(?:key|pid)\s*[=:]\s*\S+/gi,'<redacted>').replace(/\d{6,}/g,'<redacted>').replace(/\s+/g,' ').trim().slice(0,160); }
async function syncEasyDrop(env,row) {
  let attempted=false,stage='fetch';
  try {
    if(!row.feed_key)fail('EasyDrop feed link is not configured; add it to the supplier',409);
    const timestamp=Date.now();
    const claim=await env.DB.prepare('UPDATE suppliers SET last_api_request_at=? WHERE id=? AND (last_api_request_at IS NULL OR last_api_request_at<=?) RETURNING id').bind(timestamp,row.id,timestamp-900000).first();
    if(!claim)fail('EasyDrop feed was requested recently; retry after 15 minutes',429);
    attempted=true;
    const signal=AbortSignal.timeout(20000);
    const response=await fetch(buildEasyDropFeedUrl({key:row.feed_key,pid:row.feed_pid}),{redirect:'manual',headers:{Accept:'application/xml, text/xml'},signal});
    if(response.status>=300&&response.status<400){await response.body?.cancel();fail('EasyDrop feed redirected unexpectedly; the link may be invalid',422);}
    if(response.status!==200){await response.body?.cancel();fail(`EasyDrop feed returned HTTP ${response.status}; retry later`,422);}
    if(!XML_TYPE.test(response.headers.get('Content-Type')||'')){await response.body?.cancel();fail('EasyDrop feed returned a non-XML response; the link may be invalid',422);}
    stage='read';const feedBytes=await readFeedBounded(response,EASYDROP_LIMITS.bytes,signal);
    stage='parse';const {items,skipped,stats}=normalizeEasyDrop(feedBytes);
    if(!items.length)fail(`EasyDrop feed has no importable products. ${easydropSkippedSummary(skipped,stats.products)}`,422);
    stage='import';const {skippedPublished=[],...result}=await importItems(env,row.id,{items},5000,{tolerant:true});
    const all=[...skipped,...skippedPublished],note=easydropSkippedSummary(all,stats.products);
    await recordRun(env,row.id,'synced',result.imported,note);
    return{status:'synced',...result,...(all.length?{skippedCount:all.length,skippedIds:all.map(s=>s.externalId).filter(Boolean).slice(0,50),skippedNote:note}:{})};
  }catch(error){
    if(error instanceof HttpError&&error.status===429)throw error;
    let safe=error instanceof HttpError?error.message:null;
    if(safe===null){const name=scrubDiagnostic(error?.name||'Error').slice(0,40),detail=scrubDiagnostic(error?.message);safe=`EasyDrop sync failed at ${stage} (${name}: ${detail}); retry later`;console.error('EasyDrop sync failed',stage,name,detail);}
    await recordRun(env,row.id,attempted?'failed':'blocked',0,safe);
    throw new HttpError(error instanceof HttpError?error.status:422,safe);
  }
}
// D1 allows about 1,000 queries per invocation; a sync issues about one statement per product. Before starting any supplier after the first, estimate its cost as its current product count + 10 (the count comes with the selection query; zero products means unknown and counts as the whole budget, so such a supplier only runs first) and defer it and all later ones if spent + estimate would exceed this budget. The first always runs; deferred ones stay oldest and go first next tick.
const SCHEDULED_QUERY_BUDGET=800;
// The cron ticks every 5 minutes; a supplier is due 55 minutes after its last run (any status), or 15 minutes after a MyDrop
// 'pending' export, so every enabled supplier refreshes about hourly even when the budget allows only one supplier per tick.
const SYNC_DUE_MS=55*60000,PENDING_RETRY_MS=15*60000;
async function syncConnectedSuppliers(env) {
  if(!env.MYDROP_API_KEY||typeof env.MYDROP_API_KEY!=='string')fail('MyDrop API key is not configured; set the MYDROP_API_KEY Worker secret',422);
  let remote;
  try {
    const response=await fetch('https://backend.mydrop.com.ua/dropshipper/api/dropshipper_vendors',{
      redirect:'manual',headers:{Accept:'application/json','Content-Type':'application/json','X-API-KEY':env.MYDROP_API_KEY},signal:AbortSignal.timeout(20000),
    });
    if(!response.ok){await response.body?.cancel();fail(response.status===401||response.status===403?'MyDrop API access was denied; verify the configured key and permissions':`MyDrop supplier list returned HTTP ${response.status}; retry later`,422);}
    if(!response.headers.get('Content-Type')?.includes('application/json')){await response.body?.cancel();fail('MyDrop supplier list returned a non-JSON response',422);}
    const bytes=await readBounded(response,2000000);
    let body;try{body=JSON.parse(new TextDecoder().decode(bytes));}catch{fail('MyDrop supplier list returned invalid JSON',422);}
    remote=normalizeConnections(body);
  }catch(error){if(error instanceof HttpError)throw error;fail('MyDrop connected suppliers could not be reached; retry later',422);}
  const local=await rows(env,"SELECT * FROM suppliers WHERE provider='mydrop'"),byConnection=new Map(),byUrl=new Map(local.map(row=>[row.url,row]));
  for(const row of local)if(row.connection_id){const matches=byConnection.get(row.connection_id)||[];matches.push(row);byConnection.set(row.connection_id,matches);}
  const statements=[],skipped=[],remoteUrls=new Set();let added=0,updated=0,unchanged=0;
  for(const entry of remote) {
    const skip=reason=>skipped.push({connectionId:entry.connectionId,name:entry.name,reason});
    if(!entry.verified){skip('Підключення ще не підтверджене в MyDrop');continue;}
    const matches=byConnection.get(entry.connectionId)||[];
    if(matches.some(row=>row.deleted_at)||byUrl.get(entry.url)?.deleted_at){skip('Постачальника видалено локально; відновіть його з кошика вручну');continue;}
    if(matches.length>1){skip('Кілька локальних постачальників мають однаковий ID; перевірте їх вручну');continue;}
    const current=matches[0]||byUrl.get(entry.url);
    const url=entry.url||current?.url;
    if(!url){skip('MyDrop не повернув публічне посилання постачальника');continue;}
    if(remoteUrls.has(url)){skip('Публічне посилання дублюється у відповіді MyDrop');continue;}remoteUrls.add(url);
    const urlOwner=byUrl.get(url);
    if(current&&urlOwner&&urlOwner.id!==current.id){skip('Публічне посилання вже зайняте іншим локальним постачальником');continue;}
    if(current) {
      if(current.connection_id===entry.connectionId&&current.url===url){unchanged++;continue;}
      statements.push(env.DB.prepare('UPDATE suppliers SET connection_id=?,url=? WHERE id=? AND provider=\'mydrop\'').bind(entry.connectionId,url,current.id));
      updated++;
    }else{
      const supplierId=id();
      statements.push(env.DB.prepare('INSERT INTO suppliers(id,name,url,enabled,created_at,connection_id) VALUES(?,?,?,?,?,?)').bind(supplierId,entry.name,url,entry.hidden?0:1,now(),entry.connectionId));
      added++;
    }
  }
  statements.push(audit(env,'suppliers.sync-connected','mydrop'));
  await env.DB.batch(statements);
  return{total:remote.length,added,updated,unchanged,skipped};
}
// Public projection with confirmed duplicate groups merged into one product each.
async function publicProduct(env,slug) { const entry=await publicEntryBySlug(env,slug);return entry?entry.product:null; }
async function mediaUpload(request,env) {
  if(!env.MEDIA)fail('Photo storage is not configured',503);
  if(!request.headers.get('Content-Type')?.startsWith('multipart/form-data'))fail('Multipart image upload required',415);
  const uploadBytes=await readBounded(request,5500000);
  let form;try{form=await new Response(uploadBytes,{headers:{'Content-Type':request.headers.get('Content-Type')}}).formData();}catch{fail('Invalid multipart image upload');}
  const file=form.get('file');
  if(!file||typeof file.arrayBuffer!=='function'||file.size>5000000||file.size===0)fail('Supply an image up to 5 MB');
  const bytes=new Uint8Array(await file.arrayBuffer());
  let ext,type;
  if(bytes[0]===0xff&&bytes[1]===0xd8&&bytes[2]===0xff){ext='jpg';type='image/jpeg';}
  else if([137,80,78,71,13,10,26,10].every((v,i)=>bytes[i]===v)){ext='png';type='image/png';}
  else if(new TextDecoder().decode(bytes.slice(0,4))==='RIFF'&&new TextDecoder().decode(bytes.slice(8,12))==='WEBP'){ext='webp';type='image/webp';}
  else fail('Only JPEG, PNG and WebP image content is accepted');
  const stored=await storeMedia(env,bytes,{ext,contentType:type,kind:'upload'});
  await audit(env,'media.upload',stored.key).run();
  return json({url:`/media/${stored.key}`,...(stored.deduplicated?{deduplicated:true}:{})},201);
}
async function serveMedia(request,env,path) {
  if(!env.MEDIA)fail('Photo not found',404);
  const key=path.slice('/media/'.length);
  const storefront=STOREFRONT_KEY.test(key),campaign=CAMPAIGN_KEY.test(key)||storefront;
  if(!campaign&&!isCardThumbnailKey(key)&&!/^[a-f0-9-]+\.(jpg|png|webp)$/.test(key))fail('Photo not found',404);
  // Uploaded files remain private until a published product uses their URL.
  // Access/dev identity first, then the staff cookie with media.read. The customer cookie is never a credential.
  const privateAccess=await authenticated(request,env)||can((await resolveStaffPrincipal(request,env)).principal,'media.read');
  // Public access: storefront/campaign/card-thumbnail rules are staging's; a product photo is one indexed media_refs
  // lookup confirmed through the merged storefront entry instead of projecting every published product.
  // Recognition settings are loaded only for the checks that project products, so other /media/ hits stay read-free.
  if(!privateAccess) {
    const projected=async()=>({...env,RECOGNITION:await loadRecognition(env)});
    if(!(storefront?await isPublicStorefrontKey(env,key):campaign?await isPublicCampaignKey(env,key):isCardThumbnailKey(key)?await isPublicCardThumbnail(await projected(),path):await isPublicMedia(env,path,projected)))fail('Photo not found',404);
  }
  // Random keys are never overwritten, so publicly authorized product bytes are immutable; credentialed responses stay private.
  // Only cache-validation preconditions are forwarded, so a failed precondition always means 304 Not Modified.
  const validators=new Headers();for(const name of ['If-None-Match','If-Modified-Since'])if(request.headers.has(name))validators.set(name,request.headers.get(name));
  const object=await env.MEDIA.get(key,privateAccess||![...validators.keys()].length?undefined:{onlyIf:validators});if(!object)fail('Photo not found',404);
  // Campaign/storefront pictures keep staging's hour-long lifetime (a manager can replace them); card thumbnails stay uncached.
  const cacheControl=privateAccess?'no-store':campaign?'public, max-age=3600':isCardThumbnailKey(key)?'no-store':'public, max-age=31536000, immutable';
  const headers={'Content-Type':object.httpMetadata?.contentType||'application/octet-stream','Cache-Control':cacheControl,'X-Content-Type-Options':'nosniff',...(object.httpEtag?{ETag:object.httpEtag}:{})};
  if(!privateAccess&&!('body' in object))return new Response(null,{status:304,headers});
  return new Response(object.body,{headers});
}
async function adminBanner(env){const b=await readBanner(env);return{banner:b.value,bannerUpdatedAt:b.updatedAt,bannerActor:b.actor&&actorLabel(env.PRINCIPAL,b.actor)};}
const ADMIN_HANDLERS={
  'staff.list':context=>staffAdmin(context,'list'),
  'staff.invite':context=>staffAdmin(context,'invite'),
  'staff.update':context=>staffAdmin(context,'update'),
  'staff.suspend':context=>staffAdmin(context,'suspend'),
  'staff.reactivate':context=>staffAdmin(context,'reactivate'),
  'staff.reinvite':context=>staffAdmin(context,'reinvite'),
  'staff.revoke':context=>staffAdmin(context,'revoke'),
  'staff.remove':context=>staffAdmin(context,'remove'),
  'audit.list':context=>staffAdmin(context,'audit'),
  'storefront.get':async({env})=>{const t=await readTicker(env),c=await readCampaign(env),k=await readCheckout(env);return json({...c,actor:c.actor&&actorLabel(env.PRINCIPAL,c.actor),ticker:t.value,tickerUpdatedAt:t.updatedAt,tickerActor:t.actor&&actorLabel(env.PRINCIPAL,t.actor),checkout:k.value,checkoutUpdatedAt:k.updatedAt,checkoutActor:k.actor&&actorLabel(env.PRINCIPAL,k.actor),pictures:await listPictures(env,env.RECOGNITION?.taxonomy),...await adminBanner(env),images:await listImages(env,env.RECOGNITION?.taxonomy)});},
  'storefront.banner':async({request,env})=>{const banner=validateBanner(await readJson(request)),at=now();await env.DB.batch([writeBannerStatement(env,banner,at),auditStatement(env,'storefront.banner','banner',at,banner)]);return json({banner,bannerUpdatedAt:at,bannerActor:env.PRINCIPAL?.actor??null});},
  'storefront.images.set':async({request,env})=>json({image:await setImage(request,env,readBounded)}),
  'storefront.images.reset':async({env,params})=>json(await resetImage(params,env)),
  'storefront.checkout':async({request,env})=>{const checkout=validateCheckout(await readJson(request)),at=now();await env.DB.batch([writeCheckoutStatement(env,checkout,at),auditStatement(env,'storefront.checkout','checkout',at,checkout)]);return json({checkout,checkoutUpdatedAt:at,checkoutActor:env.PRINCIPAL?.actor??null});},
  'storefront.ticker':async({request,env})=>{const ticker=validateTicker(await readJson(request)),at=now();await env.DB.batch([writeTickerStatement(env,ticker,at),auditStatement(env,'storefront.ticker','ticker',at,ticker)]);return json({ticker,tickerUpdatedAt:at,tickerActor:env.PRINCIPAL?.actor??null});},
  'storefront.campaign':async({request,env})=>{const body=await readJson(request),validated=validateCampaign(body,env.RECOGNITION?.taxonomy),at=now();
    // Read and write in one handler: an omitted sceneId keeps the stored one, so an older admin tab cannot reset the scene.
    const campaign={...validated,sceneId:validated.sceneId??(await readCampaign(env)).campaign.sceneId??DEFAULT_SCENE_ID};
    await env.DB.batch([writeCampaignStatement(env,campaign,at),auditStatement(env,'storefront.campaign','campaign',at,campaign)]);return json({campaign,updatedAt:at,actor:env.PRINCIPAL?.actor??null});},
  'storefront.pictures.add':async({request,env})=>json({picture:await addPicture(request,env,readBounded)},201),
  'storefront.pictures.order':async({request,env})=>json(await orderPictures(await readJson(request),env)),
  'storefront.pictures.remove':async({env,params})=>json(await removePicture(params.id,env)),
  'taxonomy.get':async({request,env})=>json(await taxonomyRoute(env,'','GET',{})),
  'taxonomy.preview':async({request,env})=>json(await taxonomyRoute(env,'preview','POST',await readJson(request))),
  'taxonomy.apply':async({request,env})=>json(await taxonomyRoute(env,'apply','POST',await readJson(request))),
  'recognition.get':async({request,env})=>json(await recognitionRoute(env,'','GET',{})),
  'recognition.drafts':async({request,env})=>json(await recognitionRoute(env,'drafts','POST',await readJson(request))),
  'recognition.preview':async({request,env})=>json(await recognitionRoute(env,'preview','POST',await readJson(request))),
  'recognition.apply':async({request,env})=>json(await recognitionRoute(env,'apply','POST',await readJson(request))),
  'recognition.activate':async({request,env})=>json(await recognitionRoute(env,'activate','POST',await readJson(request))),
  'suppliers.syncConnected':async({request,env})=>{await readJson(request);return json(await syncConnectedSuppliers(env));},
  'suppliers.list':async({env,url})=>json({items:(await supplierList(env,url.searchParams.get('deleted')==='1')).map(row=>can(env.PRINCIPAL,'suppliers.manage')?row:withoutConnection(row)),autoSync:env.APP_ENV==='production'?{intervalMinutes:60}:null}),
  'suppliers.createManual':async({request,env})=>{
    const body=await readJson(request);rejectUnknown(body,['name','enabled']);
    if(body.enabled!==undefined&&typeof body.enabled!=='boolean')fail('Invalid enabled flag');
    const name=text(body.name,'supplier name',200,false),supplierId=id();
    await env.DB.batch([env.DB.prepare('INSERT INTO suppliers(id,name,url,enabled,created_at,provider) VALUES(?,?,?,?,?,?)').bind(supplierId,name,`manual:${supplierId}`,body.enabled===false?0:1,now(),'manual'),audit(env,'supplier.create',supplierId)]);
    return json(supplier(await getSupplier(env,supplierId)),201);
  },
  'suppliers.create':async({request,env})=>{
    const body=await readJson(request),supplierId=id();
    if(body.enabled!==undefined&&typeof body.enabled!=='boolean')fail('Invalid enabled flag');
    const provider=body.provider===undefined?'mydrop':body.provider;if(provider==='manual')fail('Create manual suppliers with POST /api/admin/suppliers/manual');if(!['mydrop','easydrop'].includes(provider))fail('Unknown supplier provider');
    const name=text(body.name,'supplier name',200,false),enabled=body.enabled===false?0:1;
    if(provider==='easydrop') {
      if(Object.keys(body).some(k=>!['provider','name','enabled','feedUrl'].includes(k)))fail('Unknown supplier field for EasyDrop');
      const link=feedLink(body.feedUrl);await assertFeedKeyFree(env,link.key);
      await insertOrConflict(env,[env.DB.prepare('INSERT INTO suppliers(id,name,url,enabled,created_at,provider,feed_key,feed_pid,feed_updated_at) VALUES(?,?,?,?,?,?,?,?,?)').bind(supplierId,name,`easydrop:${supplierId}`,enabled,now(),'easydrop',link.key,link.pid,now()),audit(env,'supplier.create',supplierId)]);
      return json(supplier(await getSupplier(env,supplierId)),201);
    }
    if(body.feedUrl!==undefined)fail('feedUrl is only for EasyDrop suppliers');
    const canonical=supplierUrl(body.url),connection=connectionId(body.connectionId);
    const duplicate=await env.DB.prepare('SELECT id,deleted_at FROM suppliers WHERE url=?').bind(canonical).first();if(duplicate)fail(duplicate.deleted_at?'Supplier is in Trash; restore it instead of adding a duplicate':'Supplier already exists',409);
    await env.DB.batch([env.DB.prepare('INSERT INTO suppliers(id,name,url,enabled,created_at,connection_id) VALUES(?,?,?,?,?,?)').bind(supplierId,name,canonical,enabled,now(),connection),audit(env,'supplier.create',supplierId)]);
    return json(supplier(await getSupplier(env,supplierId)),201);
  },
  'suppliers.restore':async({request,env,params})=>{const row=await getSupplier(env,params.id,true);await readJson(request);if(!row.deleted_at)fail('Supplier is not in Trash',409);await env.DB.batch([env.DB.prepare('UPDATE suppliers SET deleted_at=NULL,enabled=0 WHERE id=?').bind(row.id),audit(env,'supplier.restore',row.id)]);return json(supplier(await getSupplier(env,row.id)));},
  'suppliers.delete':async({request,env,params})=>{const row=await getSupplier(env,params.id);requireConfirmation(await readJson(request));await env.DB.batch([env.DB.prepare('UPDATE suppliers SET deleted_at=?,enabled=0 WHERE id=?').bind(now(),row.id),audit(env,'supplier.delete',row.id)]);return json({deleted:true,affectedProducts:row.product_count,publishedProducts:row.published_count});},
  'suppliers.update':async({request,env,params})=>{
    const row=await getSupplier(env,params.id),body=await readJson(request);
    if(body.provider!==undefined)fail('Supplier provider cannot be changed');
    const easydrop=row.provider==='easydrop',manual=row.provider==='manual';
    if(Object.keys(body).some(k=>!['name','enabled',...(manual?[]:[easydrop?'feedUrl':'connectionId'])].includes(k)))fail('Unknown supplier field');
    if(body.enabled!==undefined&&typeof body.enabled!=='boolean')fail('Invalid enabled flag');
    const name=body.name===undefined?row.name:text(body.name,'supplier name',200,false),enabled=body.enabled===undefined?row.enabled:Number(body.enabled);
    if(easydrop) {
      const link=body.feedUrl===undefined?null:feedLink(body.feedUrl);if(link)await assertFeedKeyFree(env,link.key,row.id);
      await insertOrConflict(env,[link?env.DB.prepare('UPDATE suppliers SET name=?,enabled=?,feed_key=?,feed_pid=?,feed_updated_at=? WHERE id=? AND provider=\'easydrop\'').bind(name,enabled,link.key,link.pid,now(),row.id):env.DB.prepare('UPDATE suppliers SET name=?,enabled=? WHERE id=?').bind(name,enabled,row.id),audit(env,'supplier.update',row.id),...(link?[audit(env,'supplier.link.update',row.id)]:[])]);
      return json(supplier(await getSupplier(env,row.id)));
    }
    if(manual){await env.DB.batch([env.DB.prepare('UPDATE suppliers SET name=?,enabled=? WHERE id=?').bind(name,enabled,row.id),audit(env,'supplier.update',row.id)]);return json(supplier(await getSupplier(env,row.id)));}
    const connection=body.connectionId===undefined?row.connection_id:connectionId(body.connectionId);
    await env.DB.batch([env.DB.prepare('UPDATE suppliers SET name=?,enabled=?,connection_id=? WHERE id=?').bind(name,enabled,connection,row.id),audit(env,'supplier.update',row.id)]);
    return json(supplier(await getSupplier(env,row.id)));
  },
  'suppliers.import':async({request,env,params})=>{const row=await getSupplier(env,params.id);if(row.provider==='manual')fail(MANUAL_NO_FEED,409);return json(await importItems(env,row.id,await readJson(request)));},
  'suppliers.sync':async({request,env,params})=>{const row=await getSupplier(env,params.id);if(row.provider==='manual')fail(MANUAL_NO_FEED,409);await readJson(request);if(!row.enabled)fail('Supplier is disabled');const result=await syncSupplier(env,row);return json(result,result.status==='pending'?202:200);},
  // Live list via products_deleted, Trash via the partial products_trash index (0013); one read per row.
  'products.list':async({env,url})=>json({items:newestFirst(await rows(env,`SELECT p.* FROM products p WHERE p.deleted_at IS ${url.searchParams.get('deleted')==='1'?'NOT ':''}NULL AND +p.supplier_id IN (SELECT id FROM suppliers WHERE deleted_at IS NULL)`)).map(row=>productProjection(row,Date.now(),false,env.RECOGNITION?.settings,env.RECOGNITION?.taxonomy))}),
  'products.create':async({request,env})=>{
    const body=await readJson(request);rejectUnknown(body,MANUAL_PRODUCT_FIELDS);
    requirePermission(env.PRINCIPAL,'products.price');
    if(typeof body.supplierId!=='string'||!body.supplierId||body.supplierId.length>200)fail('Invalid supplier ID');
    const owner=await getSupplier(env,body.supplierId,true);
    if(owner.deleted_at)fail('Supplier is in Trash; restore it first',409);
    if(owner.provider!=='manual')fail('Products can only be created for manual suppliers',409);
    const productId=id(),{source,overrides:base}=manualProductFromRequest(body,`m-${id().replaceAll('-','').slice(0,16)}`);
    const overrides=validateOverrides(base,{},env.RECOGNITION?.taxonomy),timestamp=now();
    const row={id:productId,supplier_id:owner.id,external_id:source.externalId,source_json:JSON.stringify(source),overrides_json:JSON.stringify(overrides),slug:slugFor(source,productId),updated_at:timestamp,deleted_at:null};
    await env.DB.batch([env.DB.prepare('INSERT INTO products(id,supplier_id,external_id,source_json,overrides_json,slug,updated_at) VALUES(?,?,?,?,?,?,?)').bind(row.id,row.supplier_id,row.external_id,row.source_json,row.overrides_json,row.slug,row.updated_at),audit(env,'product.create',row.id)]);
    return json(productProjection(row,Date.now(),false,env.RECOGNITION?.settings,env.RECOGNITION?.taxonomy),201);
  },
  'products.bulk':async({request,env})=>json(await bulkProducts(env,await readJson(request))),
  'products.tags':async({request,env})=>json(await bulkTags(env,await readJson(request))),
  'products.delete':async({request,env,params})=>productLifecycle(request,env,params.id,false),
  'products.restore':async({request,env,params})=>productLifecycle(request,env,params.id,true),
  'products.update':async({request,env,params})=>{
    const row=await productRow(env,params.id),body=await readJson(request);
    if('published' in body)requirePermission(env.PRINCIPAL,'products.publish');
    if('markupType' in body||'markupValue' in body||'priceOverrideMinor' in body)requirePermission(env.PRINCIPAL,'products.price');
    const overrides=validateOverrides(body,JSON.parse(row.overrides_json),env.RECOGNITION?.taxonomy),slug=overrides.slug??row.slug;
    const collision=await env.DB.prepare('SELECT id FROM products WHERE slug=? AND id<>?').bind(slug,row.id).first();
    const oldCollision=await env.DB.prepare('SELECT product_id FROM slug_redirects WHERE slug=? AND product_id<>?').bind(slug,row.id).first();
    if(collision||oldCollision)fail('Slug is already used',409);
    const draft={...row,overrides_json:JSON.stringify(overrides),slug},updated={...draft,updated_at:storefrontChanged(row,draft,env)?now():row.updated_at},projection=validatePublication(updated,undefined,env.RECOGNITION?.settings,env.RECOGNITION?.taxonomy);
    await requireNewMediaExists(env,row,overrides);
    const statements=[env.DB.prepare('UPDATE products SET overrides_json=?,slug=?,updated_at=? WHERE id=?').bind(updated.overrides_json,slug,updated.updated_at,row.id),audit(env,'product.update',row.id)];
    if('priceOverrideMinor' in body){const fromMinor=JSON.parse(row.overrides_json).priceOverrideMinor??null,toMinor=overrides.priceOverrideMinor??null;if(fromMinor!==toMinor)statements.push(auditStatement(env,toMinor===null?'product.price.reset':'product.price.override',row.id,now(),{fromMinor,toMinor,computedMinor:projection.computedPriceMinor}));}
    if(slug!==row.slug)statements.push(env.DB.prepare('INSERT INTO slug_redirects(slug,product_id) VALUES(?,?) ON CONFLICT(slug) DO UPDATE SET product_id=excluded.product_id').bind(row.slug,row.id));
    await env.DB.batch(statements);
    await deleteUnreferenced(env,removedMediaKeys(row,overrides),'photo-removed');
    return json(projection);
  },
  'products.source':async({request,env,params})=>{
    const row=await productRow(env,params.id,true),body=await readJson(request);
    if('costMinor' in body)requirePermission(env.PRINCIPAL,'products.price');
    if(row.deleted_at)fail('Product is in Trash; restore it first',409);
    if((await getSupplier(env,row.supplier_id,true)).provider!=='manual')fail('Only products of manual suppliers have an editable source',409);
    const source=manualSourcePatch(body,JSON.parse(row.source_json)),updated={...row,source_json:JSON.stringify(source),updated_at:now()};
    const projection=validatePublication(updated,'Source change would invalidate a published product; unpublish it first',env.RECOGNITION?.settings,env.RECOGNITION?.taxonomy);
    await env.DB.batch([env.DB.prepare('UPDATE products SET source_json=?,updated_at=? WHERE id=?').bind(updated.source_json,updated.updated_at,row.id),audit(env,'product.source.update',row.id)]);
    return json(projection);
  },
  'products.photos':async({request,env,params})=>json(await saveProductPhoto(request,await productRow(env,params.id),env,readBounded),201),
  'products.purge':async({request,env,params})=>{const row=await productRow(env,params.id,true);requireConfirmation(await readJson(request));return json(await purgeProduct(env,row));},
  'products.image':async({env,params,url})=>{
    const row=await productRow(env,params.id),bytes=await retrieveProductImage(row,url.searchParams.get('url'),env);
    return new Response(bytes,{headers:{'Content-Type':imageType(bytes)[1],'Cache-Control':'no-store'}});
  },
  'products.originals':async({env,params})=>json({...await imageLineage(await productRow(env,params.id),env),storageAvailable:!!env.MEDIA}),
  'products.cutout':async({request,env,params})=>json(await saveCutout(request,await productRow(env,params.id),env,readBounded),201),
  'products.normalized':async({request,env,params})=>json(await saveNormalized(request,await productRow(env,params.id),env,readBounded),201),
  'media.upload':async({request,env})=>mediaUpload(request,env),
  'duplicates.list':context=>duplicatesOverview(context),
  'duplicates.confirm':context=>confirmGroup(context,readJson),
  'duplicates.dissolve':context=>dissolveGroup(context,readJson),
  'duplicates.removeMember':context=>removeMember(context,readJson),
  'duplicates.reject':context=>rejectCandidates(context,readJson),
  'duplicates.unreject':context=>restoreRejection(context,readJson),
  'media.list':async({env})=>json(await mediaLibrary(env)),
  'media.scan':async({request,env})=>json(await scanMedia(env,await readJson(request))),
  'media.cleanup':async({request,env})=>json(await cleanupMedia(env,await readJson(request))),
  'carts.list':context=>listCarts(context),
  'carts.get':context=>getCart(context),
  'carts.status':context=>changeStatus(context),
  'dashboard.get':context=>dashboard(context),
  'infra.get':context=>infraOverview(context),
  'infra.plan':context=>setPlan(context,readJson),
  'infra.renewals.create':context=>createRenewal(context,readJson),
  'infra.renewals.update':context=>updateRenewal(context,readJson),
  'infra.renewals.delete':context=>deleteRenewal(context,readJson),
  'syncRuns.list':async({env})=>json({items:(await rows(env,'SELECT * FROM sync_runs ORDER BY created_at DESC LIMIT 100')).map(r=>({id:r.id,supplierId:r.supplier_id,status:r.status,imported:r.imported,error:r.error,createdAt:r.created_at}))})
};
assertHandlers(ADMIN_HANDLERS);
async function productLifecycle(request,env,productId,restoring) {
  const row=await productRow(env,productId,restoring),body=await readJson(request);
  if(restoring&&!row.deleted_at)fail('Product is not in Trash',409);
  if(!restoring)requireConfirmation(body);
  const action=restoring?'restore':'delete',change=productLifecycleStatement(env,row,action);
  await env.DB.batch([change.statement,audit(env,`product.${action}`,row.id)]);
  return json(restoring?productProjection(change.updated,Date.now(),false,env.RECOGNITION?.settings,env.RECOGNITION?.taxonomy):{deleted:true});
}
const PRIVATE_PREFIXES=['/admin','/account','/staff','/cart','/api/cart','/api/admin','/api/auth','/api/account','/api/staff'];
export function isPrivatePath(path){return PRIVATE_PREFIXES.some(prefix=>path===prefix||path.startsWith(prefix+'/'));}
const MANAGER_PREFIXES=['/admin','/api/admin','/api/auth'];
const ROBOTS_META='<meta name="robots" content="noindex, nofollow">';
function markPrivate(response){const headers=new Headers(response.headers);headers.set('X-Robots-Tag','noindex, nofollow');headers.set('Cache-Control','no-store');return new Response(response.body,{status:response.status,headers});}
async function privateDocument(request,response){
  if(response.status!==200||request.method==='HEAD'||!response.body||!(response.headers.get('Content-Type')||'').includes('text/html'))return markPrivate(response);
  const marked=markPrivate(response);
  const html=(await marked.text()).replace(/<meta\s+name=["']robots["'][^>]*>/gi,'').replace(/<\/head>/i,ROBOTS_META+'</head>');
  const headers=new Headers(marked.headers);headers.delete('Content-Length');headers.delete('ETag');
  return new Response(html,{status:marked.status,headers});
}
async function route(request,env) {
  const url=new URL(request.url),path=url.pathname,method=request.method;
  if(typeof env.ADMIN_HOST==='string'&&env.ADMIN_HOST.trim()&&url.hostname!==env.ADMIN_HOST.trim().toLowerCase()&&MANAGER_PREFIXES.some(prefix=>path===prefix||path.startsWith(prefix+'/')))fail('Not found',404);
  if(path==='/api/delivery'||path.startsWith('/api/delivery/'))return handleDelivery(request,env);
  // Cookieless visit beacon: before the recognition load, so a page view costs no extra reads.
  if(path==='/api/visit'){if(!env.DB)return new Response(null,{status:204});if(method!=='POST')fail('Method not allowed',405);checkOrigin(request);return recordVisit(request,env,isPrivatePath);}
  if(env.DB&&path!=='/api/health'&&!path.startsWith('/media/'))env={...env,RECOGNITION:await loadRecognition(env)};
  if(path==='/api/health')return json({ok:true});
  if(path.startsWith('/api/')) {
    if(!env.DB)fail('Database is not configured',503);
    if(path==='/api/cart'||path.startsWith('/api/cart/'))return handleCart(request,env);
    if(!['GET','HEAD','OPTIONS'].includes(method))checkOrigin(request);
    if(path==='/api/account'||path.startsWith('/api/account/'))return handleAccount(request,env);
    if(path.startsWith('/api/staff/admin/')) {
      // Staff mount: only the __Host-ls_staff session is a credential here (never Access, the bypass or a customer cookie).
      const{principal,stale}=await resolveStaffPrincipal(request,env);if(!principal)return staffUnauthorized(request,env,stale);
      return dispatchAdmin({request,env:{...env,PRINCIPAL:principal,AUDIT_ACTOR:principal.actor},url},principal,path.slice('/api/staff/admin'.length),ADMIN_HANDLERS);
    }
    if(path==='/api/staff'||path.startsWith('/api/staff/'))return handleStaff(request,env);
    if(path==='/api/taxonomy'&&method==='GET')return json(taxonomyView(env.RECOGNITION.taxonomy));
    if(path==='/api/auth/session'&&method==='GET'){const user=await identity(request,env);return json({authenticated:!!user,email:user?.email,role:user?.role,permissions:permissionsFor(user),provider:'cloudflare-access',loginUrl:'/admin',logoutUrl:'/cdn-cgi/access/logout'});}
    if(path==='/api/auth/login'||path==='/api/auth/logout')fail('Authentication is managed by Cloudflare Access; use /admin to sign in and /cdn-cgi/access/logout to sign out',405);
    if(path.startsWith('/api/admin/')) {
      const principal=await identity(request,env);if(!principal)fail('Cloudflare Access manager login required',401);
      return dispatchAdmin({request,env:{...env,PRINCIPAL:principal,AUDIT_ACTOR:principal.actor},url},principal,path.slice('/api/admin'.length),ADMIN_HANDLERS);
    }
    if(path==='/api/storefront'&&method==='GET')return json({campaign:(await readCampaign(env)).campaign,ticker:(await readTicker(env)).value,checkout:(await readCheckout(env)).value,campaignPictures:await publicPictures(env,env.RECOGNITION?.taxonomy),banner:activeBanner((await readBanner(env)).value),storefrontImages:await publicImages(env,env.RECOGNITION?.taxonomy)});
    if(path==='/api/products'&&method==='GET')return json({items:await withCardPhotos(env,(await publicCatalog(env)).items.map(entry=>entry.product))});
    if(path.startsWith('/api/products/')&&method==='GET'){const product=await publicProduct(env,decodeURIComponent(path.slice(14)));if(!product)fail('Product not found',404);return json(await withCardPhoto(env,product));}
    fail('Endpoint not found',404);
  }
  if(method!=='GET'&&method!=='HEAD')fail('Method not allowed',405);
  if(path.startsWith('/media/'))return serveMedia(request,env,path);
  if(env.APP_ENV==='staging'&&path==='/robots.txt')return new Response('User-agent: *\nDisallow: /\n',{headers:{'Content-Type':'text/plain'}});
  if(env.APP_ENV==='staging'&&path==='/sitemap.xml')fail('Not found',404);
  if(path==='/robots.txt')return new Response(`User-agent: *\nAllow: /\nSitemap: ${url.origin}/sitemap.xml\n`,{headers:{'Content-Type':'text/plain'}});
  if(path==='/sitemap.xml')return new Response(`<?xml version="1.0" encoding="UTF-8"?><urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">${(await publicCatalog(env)).items.map(({product})=>`<url><loc>${escapeHtml(url.origin+'/products/'+product.slug)}</loc><lastmod>${escapeHtml(product.updatedAt)}</lastmod></url>`).join('')}</urlset>`,{headers:{'Content-Type':'application/xml','Cache-Control':'no-store'}});
  if(path.startsWith('/products/')) {
    const slug=decodeURIComponent(path.slice(10)),product=await publicProduct(env,slug);
    // A hidden member of a merged duplicate group points at the product the storefront shows.
    if(product&&product.slug!==slug)return Response.redirect(`${url.origin}/products/${encodeURIComponent(product.slug)}`,301);
    if(product)return new Response(seoHtml(product,url.origin),{headers:{'Content-Type':'text/html; charset=utf-8','Cache-Control':'no-store'}});
    const redirect=await env.DB.prepare("SELECT p.slug FROM slug_redirects r JOIN products p ON p.id=r.product_id JOIN suppliers s ON s.id=p.supplier_id WHERE r.slug=? AND s.enabled=1 AND s.deleted_at IS NULL AND p.deleted_at IS NULL AND json_extract(p.overrides_json,'$.published')=1").bind(slug).first();
    if(redirect)return Response.redirect(`${url.origin}/products/${redirect.slug}`,301);
    fail('Product not found',404);
  }
  if((path==='/admin'||path.startsWith('/admin/'))&&!await authenticated(request,env))fail('Cloudflare Access manager login required',401);
  if(env.ASSETS) { const response=await env.ASSETS.fetch(request);return isPrivatePath(path)?privateDocument(request,response):response; }
  return new Response('Build the frontend to serve Lorem Store Catalog.',{headers:{'Content-Type':'text/plain'}});
}
// Public catalog JSON and the sitemap are kept in this colo's Cache API for a short TTL so repeated
// storefront/crawler hits make no D1 query at all. Key: origin + path; the handlers ignore
// the query string, so ?bust=... cannot force D1 reads. Only GET 200 responses are stored. Browsers get
// no-cache, so a manager's own browser never keeps a stale copy. Successful manager/staff mutations make a
// best-effort purge of this colo's copies; the worst case everywhere is PUBLIC_CACHE_SECONDS (publish/unpublish, promo expiry,
// scheduled sync and recognition activation are all bounded by that TTL).
const PUBLIC_CACHE_SECONDS=60; // not exported: workerd accepts only handler/function named exports
const PUBLIC_CACHED_PATHS=['/api/products','/sitemap.xml'];
const publicCache=()=>globalThis.caches?.default??null;
const publicCacheKey=(url,path)=>new Request(url.origin+path,{method:'GET'});
async function cachedPublic(request,env,ctx,url) {
  const cache=publicCache(),key=publicCacheKey(url,url.pathname);
  let hit=null;try{hit=cache&&await cache.match(key);}catch{hit=null;}if(hit)return hit;
  const response=await route(request,env);
  if(cache&&response.status===200){
    const headers=new Headers(response.headers);headers.set('Cache-Control',`public, max-age=${PUBLIC_CACHE_SECONDS}`);
    const pending=cache.put(key,new Response(response.clone().body,{status:200,headers})).catch(()=>{});
    if(ctx?.waitUntil)ctx.waitUntil(pending);else await pending;
  }
  return response;
}
async function purgePublicCache(url) {
  const cache=publicCache();if(!cache)return;
  await Promise.all(PUBLIC_CACHED_PATHS.map(path=>cache.delete(publicCacheKey(url,path)).catch(()=>false)));
}
const isManagerMutation=(path,method)=>!['GET','HEAD','OPTIONS'].includes(method)&&[...MANAGER_PREFIXES,'/api/staff/admin'].some(prefix=>path.startsWith(prefix+'/'));
export default {
  async fetch(request,env,ctx) {
    const url=new URL(request.url),path=url.pathname,cacheable=request.method==='GET'&&PUBLIC_CACHED_PATHS.includes(path);
    const finish=response=>{const headers=new Headers(response.headers);if(cacheable&&response.status===200)headers.set('Cache-Control','no-cache');headers.set('X-Content-Type-Options','nosniff');headers.set('Referrer-Policy','strict-origin-when-cross-origin');headers.set('X-Frame-Options','DENY');if(isPrivatePath(path)){headers.set('X-Robots-Tag','noindex, nofollow');headers.set('Cache-Control','no-store');}if(env.APP_ENV==='staging')headers.set('X-Robots-Tag','noindex, nofollow');return new Response(response.body,{status:response.status,headers});};
    try {
      if(cacheable)return finish(await cachedPublic(request,env,ctx,url));
      const response=await route(request,env);
      if(response.status<400&&isManagerMutation(path,request.method))await purgePublicCache(url);
      return finish(response);
    }
    catch(error){if(error instanceof HttpError)return finish(json({error:error.message,...(error.code?{code:error.code}:{})},error.status));console.error('Catalog request failed',error?.name||'Error');return finish(json({error:'Internal server error'},500));}
  },
  async scheduled(_event,env,ctx) {
    ctx.waitUntil((async()=>{if(!env.DB)return;
      // retention erasure runs first and on its own, so a failing supplier sync can never starve it.
      try{await purgeExpiredOrderPersonalData(env,new Date());}catch{console.error('Order retention failed');}
      const at=Date.now();const suppliers=await rows(env,"SELECT s.*,(SELECT COUNT(*) FROM products p WHERE p.supplier_id=s.id AND p.deleted_at IS NULL) AS product_count FROM suppliers s WHERE (s.provider='mydrop' OR (s.provider='easydrop' AND s.feed_key IS NOT NULL)) AND s.enabled=1 AND s.deleted_at IS NULL AND (s.last_sync_at IS NULL OR s.last_sync_at<=? OR (s.last_sync_status='pending' AND s.last_sync_at<=?)) ORDER BY s.last_sync_at ASC LIMIT 5",new Date(at-SYNC_DUE_MS).toISOString(),new Date(at-PENDING_RETRY_MS).toISOString());if(!suppliers.length)return;env={...env,RECOGNITION:await loadRecognition(env)};let used=0;for(const [index,row] of suppliers.entries()){if(index>0&&used+(row.product_count?row.product_count+10:SCHEDULED_QUERY_BUDGET)>SCHEDULED_QUERY_BUDGET)break;try{const result=await syncSupplier(env,row);used+=(result?.imported||0)+10;}catch(error){used+=10;if(!(error instanceof HttpError))console.error('Scheduled sync failed');}}})());
  }
};
