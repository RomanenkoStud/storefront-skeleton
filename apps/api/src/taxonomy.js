import {createTaxonomyContext,getCategory,resolveCategoryId} from '../../../packages/catalog/taxonomy.js';
import {fail,productProjection} from './domain.js';
import {auditStatement,requirePermission} from './permissions.js';
const rows=async(env,sql,...args)=>(await env.DB.prepare(sql).bind(...args).all()).results;
const stable=value=>typeof value==='string'&&/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,99}$/.test(value);
const clone=value=>JSON.parse(JSON.stringify(value));
export function taxonomyView(context){const {revision,tree,options,nodes,redirects}=context;return{revision,tree,options,nodes,redirects};}
export function validateTaxonomy(nodes,redirects={}){
 if(!Array.isArray(nodes)||!nodes.length||nodes.length>500)fail('Use 1–500 categories');
 const ids=new Map(),siblings=new Set();
 for(const node of nodes){
  if(!node||!stable(node.id)||ids.has(node.id)||typeof node.label!=='string'||!node.label.trim()||node.label.length>100||/[\u0000-\u001f\u007f]/u.test(node.label)||node.parentId!==null&&!stable(node.parentId)||!Number.isInteger(node.position)||node.position<0||node.position>500)fail('Invalid category: stable unique ID, name up to 100 characters, parent and order required');
  const key=JSON.stringify([node.parentId,node.label.normalize('NFKC').trim().toLowerCase()]);if(siblings.has(key))fail('Sibling category names must be unique');siblings.add(key);ids.set(node.id,node);
 }
 if(!ids.has('unclassified')||ids.get('unclassified').parentId!==null)fail('The unclassified category must remain at the root');
 for(const node of nodes){let current=node,depth=0;const seen=new Set();while(current){if(seen.has(current.id))fail('Category hierarchy cannot contain cycles');seen.add(current.id);if(++depth>8)fail('Category hierarchy supports up to 8 levels');if(current.parentId!==null&&!ids.has(current.parentId))fail('Category parent does not exist');current=ids.get(current.parentId);}}
 if(Object.keys(redirects).length>10000)fail('Category history is full');
 for(const id of Object.keys(redirects)){if(ids.has(id)||!ids.has(resolveCategoryId(id,{redirects})))fail('Category replacement must resolve to an active category');}
 return createTaxonomyContext({nodes,redirects});
}
export function planTaxonomy(context,operation){
 if(!operation||typeof operation!=='object'||Array.isArray(operation)||!['create','update','delete'].includes(operation.type)||!stable(operation.id))fail('Choose a valid category operation');
 const allowed=operation.type==='delete'?['type','id','replacementId']:['type','id','label','parentId','position'];if(Object.keys(operation).some(k=>!allowed.includes(k)))fail('Unknown category operation field');
 const nodes=clone(context.nodes),redirects={...context.redirects},node=nodes.find(n=>n.id===operation.id);
 if(operation.id==='unclassified')fail('The unclassified category is reserved');
 if(operation.type==='create'){
  if(node||Object.prototype.hasOwnProperty.call(redirects,operation.id))fail('Category ID already exists or was retired',409);
  nodes.push({id:operation.id,label:operation.label,parentId:operation.parentId??null,position:operation.position??500});
 }else{
  if(!node)fail('Category not found',404);
  if(operation.type==='delete'){
   if(nodes.some(n=>n.parentId===node.id))fail('Move or remove child categories before deleting this category',409);
   if(!stable(operation.replacementId)||operation.replacementId===node.id||!nodes.some(n=>n.id===operation.replacementId))fail('Choose another active replacement category');
   nodes.splice(nodes.indexOf(node),1);redirects[node.id]=operation.replacementId;
   for(const id of Object.keys(redirects))redirects[id]=resolveCategoryId(id,{redirects});
  }else{
   if(Object.keys(operation).length===2)fail('Supply a category change');
   if(operation.label!==undefined)node.label=operation.label;
   if(operation.parentId!==undefined)node.parentId=operation.parentId;
   if(operation.position!==undefined)node.position=operation.position;
  }
 }
 // Validate before ordering; inserting at an existing position places the edited node first.
 validateTaxonomy(nodes,redirects);
 const byParent=new Map();for(const n of nodes){n.label=n.label.trim();const group=byParent.get(n.parentId)??[];group.push(n);byParent.set(n.parentId,group);}
 for(const group of byParent.values()){const edited=group.find(n=>n.id===operation.id);const ordered=group.filter(n=>n!==edited).sort((a,b)=>a.position-b.position||a.id.localeCompare(b.id));if(edited)ordered.splice(Math.min(edited.position,ordered.length),0,edited);ordered.forEach((n,i)=>n.position=i);}
 return createTaxonomyContext({nodes,redirects,revision:context.revision+1});
}
const categoryFields=p=>({categoryId:p.categoryId,categoryPath:p.categoryPath,category:p.category});
export async function taxonomyRoute(env,action,method,body={}){
 const current=env.RECOGNITION,context=current.taxonomy;
 if(!action&&method==='GET')return taxonomyView(context);
 if(!['preview','apply'].includes(action)||method!=='POST')fail('Category endpoint not found',404);
 if(action==='preview'){
  if(body.operation?.type==='delete')requirePermission(env.PRINCIPAL,'taxonomy.delete');
  const operation=body.operation,candidate=planTaxonomy(context,operation);
  const products=await rows(env,'SELECT p.*,s.enabled AS supplier_enabled,s.deleted_at AS supplier_deleted FROM products p JOIN suppliers s ON s.id=p.supplier_id ORDER BY p.id');
  let productReferences=0;
  const samples=[];
  for(const row of products){const before=productProjection(row,Date.now(),false,current.settings,context),after=productProjection(row,Date.now(),false,current.settings,candidate);if(before.categoryId===operation.id)productReferences++;if(JSON.stringify(categoryFields(before))!==JSON.stringify(categoryFields(after)))samples.push({id:row.id,title:before.title,published:before.published,publiclyVisible:before.published&&!!row.supplier_enabled&&!row.deleted_at&&!row.supplier_deleted,deleted:!!row.deleted_at||!!row.supplier_deleted,before:categoryFields(before),after:categoryFields(after)});}
  let ruleReferences=0;for(const version of await rows(env,'SELECT settings_json FROM recognition_versions'))for(const rule of JSON.parse(version.settings_json).categoryRules)if(getCategory(rule.categoryId,context)?.id===operation.id)ruleReferences++;
  const token=crypto.randomUUID(),expires=Date.now()+15*60*1000;
  await env.DB.batch([env.DB.prepare('DELETE FROM taxonomy_previews WHERE expires_at<?').bind(Date.now()),env.DB.prepare('INSERT INTO taxonomy_previews(token,actor,taxonomy_revision,catalog_revision,active_version,operation_json,candidate_json,expires_at) VALUES(?,?,?,?,?,?,?,?)').bind(token,env.AUDIT_ACTOR,context.revision,current.catalog_revision,current.active_version,JSON.stringify(operation),JSON.stringify({nodes:candidate.nodes,redirects:candidate.redirects}),expires)]);
  return{token,baseRevision:context.revision,operation,...taxonomyView(candidate),impact:{changed:samples.length,publishedAffected:samples.filter(s=>s.published).length,productReferences,ruleReferences,samples:samples.slice(0,20)}};
 }
 if(body.confirm!==true)fail('Review category impact and explicitly confirm');
 const preview=await env.DB.prepare('SELECT * FROM taxonomy_previews WHERE token=?').bind(body.token??'').first();
 if(preview&&preview.actor===env.AUDIT_ACTOR&&JSON.parse(preview.operation_json).type==='delete')requirePermission(env.PRINCIPAL,'taxonomy.delete');
 if(!preview||preview.actor!==env.AUDIT_ACTOR||preview.taxonomy_revision!==context.revision||preview.catalog_revision!==current.catalog_revision||preview.active_version!==current.active_version||preview.expires_at<Date.now())fail('Category preview is stale; review a new preview',409);
 const candidate=JSON.parse(preview.candidate_json),operation=JSON.parse(preview.operation_json),time=new Date().toISOString();
 const statements=[env.DB.prepare('INSERT INTO taxonomy_guards(token,valid) VALUES(?,(SELECT CASE WHEN t.revision=? AND r.catalog_revision=? AND r.active_version=? AND EXISTS(SELECT 1 FROM taxonomy_previews WHERE token=? AND actor=? AND expires_at>=?) THEN 1 ELSE 0 END FROM taxonomy_state t JOIN recognition_state r ON r.id=t.id WHERE t.id=1))').bind(preview.token,context.revision,current.catalog_revision,current.active_version,preview.token,env.AUDIT_ACTOR,Date.now()),env.DB.prepare('UPDATE taxonomy_state SET revision=revision+1,nodes_json=?,redirects_json=? WHERE id=1').bind(JSON.stringify(candidate.nodes),JSON.stringify(candidate.redirects)),auditStatement(env,`taxonomy.${operation.type}`,`${operation.id}:revision-${context.revision+1}`,time),env.DB.prepare('INSERT INTO taxonomy_changes(revision,actor,operation_json,state_json,created_at) VALUES(?,?,?,?,?)').bind(context.revision+1,env.AUDIT_ACTOR,preview.operation_json,preview.candidate_json,time),env.DB.prepare('DELETE FROM taxonomy_previews WHERE token=?').bind(preview.token),env.DB.prepare('DELETE FROM taxonomy_guards WHERE token=?').bind(preview.token)];
 try{await env.DB.batch(statements);}catch(error){if(String(error.message).includes('CHECK constraint'))fail('Category preview is stale; review a new preview',409);throw error;}
 return taxonomyView(createTaxonomyContext({...candidate,revision:context.revision+1}));
}
