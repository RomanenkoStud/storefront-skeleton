import {defaultRecognitionSettings,getCategory,BUILTIN_CATEGORY_RULES,BUILTIN_BRAND_RULES,createTaxonomyContext} from '../../../packages/catalog/taxonomy.js';
import {fail,productProjection} from './domain.js';
import {actorLabel,auditStatement} from './permissions.js';
const rows=async(env,sql,...args)=>(await env.DB.prepare(sql).bind(...args).all()).results;
const stamp=()=>new Date().toISOString();
const stable=value=>typeof value==='string'&&/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,99}$/.test(value);
export function validateRecognition(settings,supplierIds=new Set(),taxonomy=null){
 if(!settings||typeof settings!=='object'||Array.isArray(settings)||typeof settings.legacyEnabled!=='boolean'||!Array.isArray(settings.brands)||!Array.isArray(settings.categoryRules)||settings.brands.length>100||settings.categoryRules.length>300)fail('Settings require legacyEnabled, up to 100 brands and 300 category rules');
 const ids=new Set(),aliases=new Set();let count=0;
 const rule=(r,kind)=>{
  if(!r||!stable(r.id)||ids.has(r.id))fail('Rule IDs must be unique stable IDs');ids.add(r.id);
  if(typeof r.text!=='string'||!r.text.trim()||r.text.length>120||!['word','contains','exact'].includes(r.mode)||typeof r.enabled!=='boolean'||!Number.isInteger(r.priority)||r.priority<0||r.priority>1000||!Number.isInteger(r.specificity)||r.specificity<0||r.specificity>1000)fail('Invalid rule: literal text <=120, mode, priority/specificity 0–1000 and enabled are required');
  if(r.supplierId!==null&&(!stable(r.supplierId)||!supplierIds.has(r.supplierId)))fail('Unknown supplier scope');
  const result={id:r.id,text:r.text.trim(),mode:r.mode,enabled:r.enabled,supplierId:r.supplierId,priority:r.priority,specificity:r.specificity};
  if(r.builtin!==undefined){const list=kind==='category'?BUILTIN_CATEGORY_RULES:BUILTIN_BRAND_RULES;const match=new RegExp(`^${kind}-([0-9]+)$`).exec(r.builtin);if(!(kind==='brand'&&r.builtin==='brand-polo-alias')&&(!match||!list[Number(match[1])]))fail('Invalid built-in matcher');const seed=kind==='category'?defaultRecognitionSettings().categoryRules.find(x=>x.builtin===r.builtin):defaultRecognitionSettings().brands.flatMap(b=>b.aliases).find(x=>x.builtin===r.builtin);if(seed&&result.text===seed.text&&result.mode===seed.mode)result.builtin=r.builtin;}
  return result;
 };
 const brands=settings.brands.map(b=>{if(!b||!stable(b.id)||ids.has(b.id)||typeof b.name!=='string'||!b.name.trim()||b.name.length>100||typeof b.enabled!=='boolean'||!Array.isArray(b.aliases)||b.aliases.length>50)fail('Invalid brand or duplicate ID');ids.add(b.id);const name=b.name.trim();if(aliases.has(name.toLocaleLowerCase()))fail('Duplicate canonical brand name');aliases.add(name.toLocaleLowerCase());count+=b.aliases.length;return{id:b.id,name,enabled:b.enabled,aliases:b.aliases.map(r=>rule(r,'brand'))};});
 if(count>500)fail('At most 500 brand aliases');
 const categoryRules=settings.categoryRules.map(r=>{const node=getCategory(r.categoryId,taxonomy);if(!node)fail('Category rules must target an existing selectable category');return{...rule(r,'category'),categoryId:r.categoryId};});
 // Same literal and scope at equal rank cannot point at incompatible targets.
 const seen=new Map();for(const [target,r] of [...brands.flatMap(b=>b.aliases.filter(r=>b.enabled&&r.enabled).map(r=>[b.id,r])),...categoryRules.filter(r=>r.enabled).map(r=>[r.categoryId,r])]){const key=JSON.stringify([r.builtin??r.text.normalize('NFKC').toLowerCase(),r.mode,r.supplierId,r.priority,r.specificity,!!r.categoryId]);if(seen.has(key)&&seen.get(key)!==target)fail('Overlapping identical rules have conflicting targets at the same rank');seen.set(key,target);}
 return {legacyEnabled:settings.legacyEnabled,brands,categoryRules};
}
export async function loadRecognition(env){const row=await env.DB.prepare('SELECT r.*,v.settings_json,t.revision AS taxonomy_revision,t.nodes_json,t.redirects_json FROM recognition_state r JOIN recognition_versions v ON v.id=r.active_version JOIN taxonomy_state t ON t.id=r.id WHERE r.id=1').first();return{...row,settings:JSON.parse(row.settings_json),taxonomy:createTaxonomyContext({revision:row.taxonomy_revision,nodes:JSON.parse(row.nodes_json),redirects:JSON.parse(row.redirects_json)})};}
const effectiveSettings=(settings,taxonomy)=>({...settings,categoryRules:settings.categoryRules.map(rule=>({...rule,categoryId:getCategory(rule.categoryId,taxonomy)?.id??rule.categoryId}))});
const versionView=(r,taxonomy,principal)=>({id:r.id,status:r.status,actor:actorLabel(principal,r.actor),createdAt:r.created_at,settings:effectiveSettings(JSON.parse(r.settings_json),taxonomy)});
const fields=p=>({categoryId:p.categoryId,category:p.category,brand:p.brand});
function selection(ids){if(!Array.isArray(ids)||!ids.length||ids.length>50||ids.some(id=>!stable(id))||new Set(ids).size!==ids.length)fail('Supply 1–50 unique product IDs');return [...ids].sort();}
const event=(env,action,resource)=>auditStatement(env,action,resource,stamp());
export async function recognitionRoute(env,action,method,body={}){
 const current=env.RECOGNITION??await loadRecognition(env);
 if(!action&&method==='GET')return{activeVersion:current.active_version,versions:(await rows(env,'SELECT * FROM recognition_versions ORDER BY (id=?) DESC,created_at DESC LIMIT 100',current.active_version)).map(r=>versionView(r,current.taxonomy,env.PRINCIPAL)),applications:(await rows(env,'SELECT a.*,p.source_json FROM recognition_applications a JOIN products p ON p.id=a.product_id ORDER BY a.applied_at DESC LIMIT 100')).map(a=>({productId:a.product_id,title:JSON.parse(a.source_json).title,versionId:a.version_id,actor:actorLabel(env.PRINCIPAL,a.actor),appliedAt:a.applied_at,evidence:JSON.parse(a.evidence_json)})),defaults:effectiveSettings(defaultRecognitionSettings(),current.taxonomy)};
 if(action==='drafts'&&method==='POST'){
  const suppliers=new Set((await rows(env,'SELECT id FROM suppliers WHERE deleted_at IS NULL')).map(s=>s.id));const settings=validateRecognition(body.settings,suppliers,current.taxonomy),id=crypto.randomUUID(),createdAt=stamp();
  await env.DB.batch([env.DB.prepare('INSERT INTO recognition_versions(id,status,settings_json,actor,created_at) VALUES(?,?,?,?,?)').bind(id,'draft',JSON.stringify(settings),env.AUDIT_ACTOR,createdAt),event(env,'recognition.draft',id)]);return{id,status:'draft',settings,createdAt,actor:actorLabel(env.PRINCIPAL,env.AUDIT_ACTOR)};
 }
 if(!['preview','activate','apply'].includes(action)||method!=='POST')fail('Recognition endpoint not found',404);
 const version=await env.DB.prepare('SELECT * FROM recognition_versions WHERE id=?').bind(body.versionId??'').first();if(!version)fail('Recognition version not found',404);
 const settings=JSON.parse(version.settings_json),ids=body.ids===undefined?null:selection(body.ids);
 const all=await rows(env,'SELECT p.*,s.enabled AS supplier_enabled FROM products p JOIN suppliers s ON s.id=p.supplier_id WHERE p.deleted_at IS NULL AND s.deleted_at IS NULL ORDER BY p.id');
 const selected=ids?all.filter(p=>ids.includes(p.id)):all;if(ids&&selected.length!==ids.length)fail('Selection includes missing or trashed products',409);
 const applied=new Map();
 const samples=selected.map(row=>{const before=productProjection(row,Date.now(),false,current.settings,current.taxonomy),candidate=productProjection(row,Date.now(),false,settings,current.taxonomy),suggestion=candidate.classificationSuggestion,overrides={...before.overrides};if(!before.categoryOverridden&&!suggestion.categoryAmbiguous&&suggestion.categoryId!=='unclassified')overrides.categoryId=suggestion.categoryId;if(!before.brandOverridden&&!suggestion.brandAmbiguous&&suggestion.brand!==null)overrides.brand=suggestion.brand;const updated={...row,overrides_json:JSON.stringify(overrides)};applied.set(row.id,{updated,suggestion});const after=ids?productProjection(updated,Date.now(),false,current.settings,current.taxonomy):candidate;return{id:row.id,title:before.title,published:before.published,publiclyVisible:before.published&&!!row.supplier_enabled,before:fields(before),after:fields(after),ambiguous:suggestion.ambiguous,changed:JSON.stringify(fields(before))!==JSON.stringify(fields(after))};});
 if(action==='preview'){
  const token=crypto.randomUUID(),expires=Date.now()+15*60*1000;
  await env.DB.batch([env.DB.prepare('DELETE FROM recognition_previews WHERE expires_at<?').bind(Date.now()),env.DB.prepare('INSERT INTO recognition_previews(token,version_id,active_version,catalog_revision,ids_json,actor,expires_at) VALUES(?,?,?,?,?,?,?)').bind(token,version.id,current.active_version,current.catalog_revision,JSON.stringify(ids),env.AUDIT_ACTOR,expires)]);
  return{token,versionId:version.id,activeVersion:current.active_version,scope:ids?'selected':'all',total:samples.length,changed:samples.filter(p=>p.changed).length,unchanged:samples.filter(p=>!p.changed).length,ambiguous:samples.filter(p=>p.ambiguous).length,publishedAffected:samples.filter(p=>p.changed&&p.published).length,samples:ids?samples:samples.filter(p=>p.changed||p.ambiguous).concat(samples.filter(p=>!p.changed&&!p.ambiguous)).slice(0,20)};
 }
 if(body.confirm!==true)fail('Review the impact preview and explicitly confirm');
 if(action==='activate'&&ids)fail('Activation requires an all-catalog preview');if(action==='apply'&&!ids)fail('Selected application requires explicit IDs');
 const preview=await env.DB.prepare('SELECT * FROM recognition_previews WHERE token=?').bind(body.token??'').first();
 if(!preview||preview.actor!==env.AUDIT_ACTOR||preview.version_id!==version.id||preview.active_version!==current.active_version||preview.catalog_revision!==current.catalog_revision||preview.ids_json!==JSON.stringify(ids)||preview.expires_at<Date.now())fail('Preview is stale; review a new preview',409);
 // The CHECK guard runs inside the same D1 transaction as writes. A concurrent
 // catalog write or activation invalidates the entire batch, including audit.
 const statements=[env.DB.prepare('INSERT INTO recognition_guards(token,valid) VALUES(?,(SELECT CASE WHEN active_version=? AND catalog_revision=? AND EXISTS(SELECT 1 FROM recognition_previews WHERE token=? AND actor=? AND version_id=? AND active_version=? AND catalog_revision=? AND ids_json=? AND expires_at>=?) THEN 1 ELSE 0 END FROM recognition_state WHERE id=1))').bind(preview.token,current.active_version,current.catalog_revision,preview.token,env.AUDIT_ACTOR,version.id,current.active_version,current.catalog_revision,JSON.stringify(ids),Date.now())];
 if(action==='activate')statements.push(env.DB.prepare('UPDATE recognition_state SET active_version=?,catalog_revision=catalog_revision+1 WHERE id=1').bind(version.id),env.DB.prepare("UPDATE recognition_versions SET status='historical' WHERE status='active'"),env.DB.prepare("UPDATE recognition_versions SET status='active' WHERE id=?").bind(version.id),event(env,'recognition.activate',version.id));
 else for(const row of selected)statements.push(env.DB.prepare('UPDATE products SET overrides_json=?,updated_at=? WHERE id=?').bind(applied.get(row.id).updated.overrides_json,stamp(),row.id),env.DB.prepare('INSERT INTO recognition_applications(product_id,version_id,evidence_json,actor,applied_at) VALUES(?,?,?,?,?) ON CONFLICT(product_id) DO UPDATE SET version_id=excluded.version_id,evidence_json=excluded.evidence_json,actor=excluded.actor,applied_at=excluded.applied_at').bind(row.id,version.id,JSON.stringify({...applied.get(row.id).suggestion,acceptedOverrides:JSON.parse(applied.get(row.id).updated.overrides_json)}),env.AUDIT_ACTOR,stamp()),event(env,'recognition.apply',`${version.id}:${row.id}`));
 statements.push(env.DB.prepare('DELETE FROM recognition_previews WHERE token=?').bind(preview.token),env.DB.prepare('DELETE FROM recognition_guards WHERE token=?').bind(preview.token));
 try{await env.DB.batch(statements);}catch(error){if(String(error.message).includes('CHECK constraint'))fail('Preview is stale; review a new preview',409);throw error;}
 return{activeVersion:action==='activate'?version.id:current.active_version,updated:action==='apply'?selected.length:0,action};
}
