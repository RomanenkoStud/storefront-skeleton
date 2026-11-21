import test from 'node:test';
import assert from 'node:assert/strict';
import {CATEGORY_TREE} from '../../packages/catalog/taxonomy.js';
import {createTaxonomyContext} from '../../packages/catalog/taxonomy-context.js';
import {PICTURE_TEMPLATES_REVISION,PICTURE_TEMPLATES,CATEGORY_TEMPLATE_BINDINGS,validateTemplate,resolvePictureTemplate} from '../../packages/catalog/picture-templates.js';

const seeded = createTaxonomyContext(CATEGORY_TREE);
const base = () => structuredClone(PICTURE_TEMPLATES.default);
const mutate = fn => { const t = base(); fn(t); return t; };
const ids = (nodes,out=[]) => { for (const n of nodes) { out.push(n.id); if (n.children) ids(n.children,out); } return out; };

test('validateTemplate accepts every bundled template and returns it',()=>{
  for (const t of Object.values(PICTURE_TEMPLATES)) assert.equal(validateTemplate(t),t);
});
test('validateTemplate rejects bad ids, revisions, canvases, boxes, anchors and modes',()=>{
  const bad = {
    'id uppercase':t=>{t.id='Default';}, 'id too long':t=>{t.id='a'.repeat(41);},
    'revision float':t=>{t.revision=1.5;}, 'revision zero':t=>{t.revision=0;}, 'revision string':t=>{t.revision='1';},
    'empty label':t=>{t.label=' ';},
    'canvas small':t=>{t.canvas.width=255;}, 'canvas large':t=>{t.canvas.height=4097;}, 'canvas float':t=>{t.canvas.width=1200.5;},
    'box negative':t=>{t.box.x=-0.1;}, 'box overflow x':t=>{t.box.x=.5;t.box.w=.6;}, 'box overflow y':t=>{t.box.y=.9;t.box.h=.2;},
    'box zero width':t=>{t.box.w=0;}, 'box NaN':t=>{t.box.h=NaN;},
    'anchor high':t=>{t.anchor.x=1.1;}, 'anchor negative':t=>{t.anchor.y=-0.01;},
    'unknown scale mode':t=>{t.scale.mode='cover';}, 'area without fraction':t=>{t.scale.mode='area';},
    'fraction on contain':t=>{t.scale.areaFraction=.5;}, 'upscale below 1':t=>{t.scale.maxUpscale=.5;},
    'unknown axis':t=>{t.orientation.axis='diagonal';}, 'unknown multiple':t=>{t.multipleObjects='ignore';},
    'bad guide':t=>{t.guide={kind:'png'};},
  };
  for (const [name,fn] of Object.entries(bad)) assert.throws(()=>validateTemplate(mutate(fn)),TypeError,name);
  assert.throws(()=>validateTemplate(null),TypeError);
  assert.doesNotThrow(()=>validateTemplate(mutate(t=>{t.scale={mode:'area',areaFraction:.4,maxUpscale:1};t.guide={kind:'svg-path',d:'M0 0',viewBox:'0 0 1 1'};})));
});
test('templates and bindings are deeply frozen; only later-wave templates are marked draft',()=>{
  assert.ok(Object.isFrozen(PICTURE_TEMPLATES)&&Object.isFrozen(CATEGORY_TEMPLATE_BINDINGS));
  for (const t of Object.values(PICTURE_TEMPLATES)) {
    for (const part of [t,t.canvas,t.box,t.anchor,t.scale,t.orientation]) assert.ok(Object.isFrozen(part));
    if (['footwear-side','pants-vertical','default'].includes(t.id)) { assert.doesNotMatch(t.label,/ЧЕРНЕТКА|DRAFT/i); assert.ok(!/DRAFT/i.test(t.notes??'')); }
    else { assert.match(t.label,/ЧЕРНЕТКА/); assert.match(t.notes,/DRAFT/); }
  }
  assert.throws(()=>{'use strict';PICTURE_TEMPLATES.default.box.x=0;});
});
test('every binding key is a seeded category or default and targets a valid template',()=>{
  const seededIds = new Set(ids(CATEGORY_TREE));
  for (const [key,templateId] of Object.entries(CATEGORY_TEMPLATE_BINDINGS)) {
    assert.ok(key==='default'||seededIds.has(key),`unknown bound category ${key}`);
    assert.ok(PICTURE_TEMPLATES[templateId],`missing template ${templateId}`);
    validateTemplate(PICTURE_TEMPLATES[templateId]);
  }
  assert.equal(CATEGORY_TEMPLATE_BINDINGS.default,'default');
  for (const [key,t] of Object.entries(PICTURE_TEMPLATES)) assert.equal(t.id,key);
});
test('resolution: direct binding and inheritance from ancestors',()=>{
  const direct = resolvePictureTemplate('footwear',seeded);
  assert.deepEqual([direct.template.id,direct.boundCategoryId,direct.inherited],['footwear-side','footwear',false]);
  const sneakers = resolvePictureTemplate('sneakers',seeded);
  assert.deepEqual([sneakers.template.id,sneakers.boundCategoryId,sneakers.inherited],['footwear-side','footwear',true]);
  const pants = resolvePictureTemplate('pants',seeded);
  assert.deepEqual([pants.template.id,pants.boundCategoryId,pants.inherited],['pants-vertical','pants',false]);
  const cargo = resolvePictureTemplate('cargo',seeded);
  assert.deepEqual([cargo.template.id,cargo.boundCategoryId,cargo.inherited],['pants-vertical','pants',true]);
});
test('later-wave categories and their children resolve to default with no bound category',()=>{
  const later = ['outerwear','hoodies-sweatshirts','knitwear','tshirts-polos','shirts','suits','bags','belts','glasses'];
  const kids = ['puffer-jackets','tracksuits'];
  for (const id of [...later,...kids]) {
    assert.ok(seeded.index.has(id),`seeded category ${id}`);
    const r = resolvePictureTemplate(id,seeded);
    assert.deepEqual([r.template.id,r.boundCategoryId,r.inherited],['default',null,false],id);
  }
  for (const node of seeded.nodes.filter(n => n.parentId && later.includes(n.parentId))) assert.equal(resolvePictureTemplate(node.id,seeded).template.id,'default',node.id);
  assert.equal(resolvePictureTemplate('sneakers',seeded).template.id,'footwear-side');
});
test('draft templates stay defined, valid and draft-marked but unbound',()=>{
  const draft = ['tops-front','suits-front','bags','accessory-wide'];
  const bound = new Set(Object.values(CATEGORY_TEMPLATE_BINDINGS));
  for (const id of draft) {
    assert.ok(PICTURE_TEMPLATES[id],id);
    assert.doesNotThrow(()=>validateTemplate(PICTURE_TEMPLATES[id]));
    assert.match(PICTURE_TEMPLATES[id].label,/ЧЕРНЕТКА/);
    assert.ok(!bound.has(id),`${id} must be unbound`);
  }
});
test('every bound template is wave 1 or default; binding a later-wave template needs an explicit change',()=>{
  for (const templateId of Object.values(CATEGORY_TEMPLATE_BINDINGS)) assert.ok(['footwear-side','pants-vertical','default'].includes(templateId),templateId);
  assert.deepEqual({...CATEGORY_TEMPLATE_BINDINGS},{footwear:'footwear-side',pants:'pants-vertical',default:'default'});
});
test('resolution: nearest bound ancestor wins over a farther one',()=>{
  const bindings = {...CATEGORY_TEMPLATE_BINDINGS,jeans:'bags',clothing:'suits-front'};
  const r = resolvePictureTemplate('jeans',seeded,bindings);
  assert.deepEqual([r.template.id,r.boundCategoryId,r.inherited],['bags','jeans',false]);
  assert.equal(resolvePictureTemplate('cargo',seeded,bindings).template.id,'pants-vertical');
  assert.equal(resolvePictureTemplate('shirts',seeded,{default:'default',clothing:'suits-front'}).boundCategoryId,'clothing');
});
test('resolution: manager-created child under pants inherits pants-vertical',()=>{
  const ctx = createTaxonomyContext({revision:3,nodes:[
    ...seeded.nodes,{id:'cat-chinos',label:'Чиносы',parentId:'pants',position:9},
    {id:'cat-wide-chinos',label:'Широкі',parentId:'cat-chinos',position:0},
  ]});
  for (const id of ['cat-chinos','cat-wide-chinos']) {
    const r = resolvePictureTemplate(id,ctx);
    assert.deepEqual([r.template.id,r.boundCategoryId,r.inherited],['pants-vertical','pants',true]);
  }
  const orphan = createTaxonomyContext({nodes:[{id:'cat-new',label:'Нове',parentId:null,position:0}]});
  assert.equal(resolvePictureTemplate('cat-new',orphan).template.id,'default');
});
test('resolution: retired ID redirects to a bound category',()=>{
  const ctx = createTaxonomyContext({nodes:seeded.nodes,redirects:{'old-trousers':'pants','old-shoes':'sneakers','loop-a':'loop-b','loop-b':'loop-a'}});
  assert.equal(resolvePictureTemplate('old-trousers',ctx).template.id,'pants-vertical');
  assert.equal(resolvePictureTemplate('old-trousers',ctx).inherited,false);
  const shoes = resolvePictureTemplate('old-shoes',ctx);
  assert.deepEqual([shoes.template.id,shoes.boundCategoryId,shoes.inherited],['footwear-side','footwear',true]);
  assert.equal(resolvePictureTemplate('loop-a',ctx).template.id,'default');
});
test('resolution: a retired bound category (footwear) redirected to a new ID keeps its template',()=>{
  const nodes = [...seeded.nodes.filter(n => n.id !== 'footwear').map(n => n.parentId === 'footwear' ? {...n,parentId:'cat-shoes'} : n),
    {id:'cat-shoes',label:'Взуття 2',parentId:null,position:1},{id:'cat-heels',label:'Підбори',parentId:'cat-shoes',position:9}];
  const ctx = createTaxonomyContext({nodes,redirects:{footwear:'cat-shoes'}});
  const same = resolvePictureTemplate('cat-shoes',ctx);
  assert.deepEqual([same.template.id,same.boundCategoryId,same.inherited],['footwear-side','cat-shoes',false]);
  const child = resolvePictureTemplate('cat-heels',ctx);
  assert.deepEqual([child.template.id,child.boundCategoryId,child.inherited],['footwear-side','cat-shoes',true]);
  assert.equal(resolvePictureTemplate('sneakers',ctx).template.id,'footwear-side');
  assert.equal(resolvePictureTemplate('footwear',ctx).template.id,'footwear-side');
});
test('resolution: unclassified, unbound, null and unknown fall back to default',()=>{
  for (const id of ['unclassified','hats-caps','socks-underwear','gloves','jewellery','accessories','clothing','nope',null,undefined,'',42,'default']) {
    const r = resolvePictureTemplate(id,seeded);
    assert.deepEqual([r.template.id,r.boundCategoryId,r.inherited],['default',null,false],String(id));
  }
  assert.equal(resolvePictureTemplate('sneakers',null).template.id,'footwear-side');
  assert.equal(resolvePictureTemplate('sneakers',undefined).template.id,'footwear-side');
  assert.equal(resolvePictureTemplate('sneakers',CATEGORY_TREE).template.id,'footwear-side');
});

test('collision: a retired key redirected onto a bound category never overrides the current binding',()=>{
  const nodes = seeded.nodes.filter(n => n.id !== 'footwear').map(n => n.parentId === 'footwear' ? {...n,parentId:'pants'} : n);
  const ctx = createTaxonomyContext({nodes,redirects:{footwear:'pants'}});
  for (const id of ['pants','cargo','footwear']) {
    const r = resolvePictureTemplate(id,ctx);
    assert.equal(r.template.id,'pants-vertical',id);
  }
  assert.equal(resolvePictureTemplate('pants',ctx).boundCategoryId,'pants');
  // Order of keys must not matter.
  const reversed = Object.fromEntries(Object.entries(CATEGORY_TEMPLATE_BINDINGS).reverse());
  assert.equal(resolvePictureTemplate('cargo',ctx,reversed).template.id,'pants-vertical');
});
test('collision: two retired keys onto one unbound category resolve by smallest original key',()=>{
  const nodes = seeded.nodes.filter(n => !['footwear','pants'].includes(n.id)).map(n => ['footwear','pants'].includes(n.parentId) ? {...n,parentId:'jewellery'} : n);
  const ctx = createTaxonomyContext({nodes,redirects:{footwear:'jewellery',pants:'jewellery'}});
  const entries = Object.entries(CATEGORY_TEMPLATE_BINDINGS);
  const fwd = resolvePictureTemplate('jewellery',ctx,Object.fromEntries(entries));
  const rev = resolvePictureTemplate('jewellery',ctx,Object.fromEntries([...entries].reverse()));
  assert.equal(fwd.template.id,'footwear-side');
  assert.equal(rev.template.id,'footwear-side');
});
test('validateTemplate rejects non-plain and inherited-property objects',()=>{
  assert.throws(()=>validateTemplate(Object.create(base())),TypeError);
  assert.throws(()=>validateTemplate(mutate(t=>{t.box=Object.create(PICTURE_TEMPLATES.default.box);})),TypeError);
  assert.throws(()=>validateTemplate(mutate(t=>{delete t.anchor;})),TypeError);
  assert.doesNotThrow(()=>validateTemplate(Object.assign(Object.create(null),base())));
  class X{}; assert.throws(()=>validateTemplate(Object.assign(new X(),base())),TypeError);
});
test('guide viewBox must be a strict numeric string',()=>{
  const vb = viewBox => mutate(t=>{t.guide={kind:'svg-path',d:'M0 0',viewBox};});
  for (const ok of ['0 0 10 20','0,0,10.5,20','-1 -1 1e2 2E+1','0 0 .5 5.']) assert.doesNotThrow(()=>validateTemplate(vb(ok)),ok);
  for (const bad of ['0x0 0 1 1','0 0 0x10 1',' 0 0 1 1','0 0 1 1 ','0  0 1 1','0 0 1,1 1 1','0 0 1 1 1','Infinity 0 1 1','0 0 1 1\n','0 0 '+'1'.repeat(100)+' 1']) assert.throws(()=>validateTemplate(vb(bad)),TypeError,JSON.stringify(bad));
});
test('resolution reads own properties only and validates the chosen template',()=>{
  for (const id of ['constructor','toString','__proto__','hasOwnProperty']) assert.equal(resolvePictureTemplate(id,seeded).template.id,'default',id);
  const ctx = createTaxonomyContext({nodes:[{id:'constructor',label:'x',parentId:null,position:0}]});
  assert.equal(resolvePictureTemplate('constructor',ctx).template.id,'default');
  assert.equal(resolvePictureTemplate('sneakers',seeded,{default:'default',footwear:'toString'}).template.id,'default');
  const broken = {...PICTURE_TEMPLATES,'footwear-side':{...PICTURE_TEMPLATES['footwear-side'],box:{x:0,y:0,w:2,h:2}}};
  assert.throws(()=>resolvePictureTemplate('sneakers',seeded,CATEGORY_TEMPLATE_BINDINGS,broken),TypeError);
});
test('validateTemplate hardening: allowlists, length caps, guide and box minimums',()=>{
  const bad = {
    'extra top key':t=>{t.evil=1;}, 'extra box key':t=>{t.box.z=1;}, 'extra scale key':t=>{t.scale.x=1;},
    'label too long':t=>{t.label='я'.repeat(81);}, 'notes too long':t=>{t.notes='n'.repeat(501);}, 'notes not string':t=>{t.notes=5;},
    'revision unsafe':t=>{t.revision=Number.MAX_SAFE_INTEGER+1;},
    'box too thin':t=>{t.box.w=.04;}, 'box too short':t=>{t.box.h=.049;},
    'guide script':t=>{t.guide={kind:'svg-path',d:'M0 0<script>',viewBox:'0 0 1 1'};},
    'guide too long':t=>{t.guide={kind:'svg-path',d:'M'.repeat(4001),viewBox:'0 0 1 1'};},
    'guide empty':t=>{t.guide={kind:'svg-path',d:'',viewBox:'0 0 1 1'};},
    'viewBox 3 numbers':t=>{t.guide={kind:'svg-path',d:'M0 0',viewBox:'0 0 1'};},
    'viewBox NaN':t=>{t.guide={kind:'svg-path',d:'M0 0',viewBox:'0 0 a 1'};},
    'viewBox zero width':t=>{t.guide={kind:'svg-path',d:'M0 0',viewBox:'0 0 0 1'};},
    'guide extra key':t=>{t.guide={kind:'svg-path',d:'M0 0',viewBox:'0 0 1 1',href:'x'};},
  };
  for (const [name,fn] of Object.entries(bad)) assert.throws(()=>validateTemplate(mutate(fn)),TypeError,name);
  assert.doesNotThrow(()=>validateTemplate(mutate(t=>{t.box.w=.05;t.box.h=.05;t.notes='ok';t.revision=Number.MAX_SAFE_INTEGER;t.label='я'.repeat(80);})));
  assert.doesNotThrow(()=>validateTemplate(mutate(t=>{t.guide={kind:'svg-path',d:'M0,0 L1e-1 2Z',viewBox:'0 0 10.5 20'};})));
});
// Append-only geometry history keyed `${id}@${revision}`. Never edit an existing entry: change geometry by bumping
// the template revision and adding a new entry. Editing an entry in place is the only way to hide a missing bump.
const GEOMETRY = {
  'footwear-side@1':{revision:1,canvas:[1200,1600],box:[.06,.30,.88,.46],anchor:[.5,1],scale:['contain',1.5],orientation:['horizontal',20,1.3],multiple:'allow'},
  'pants-vertical@1':{revision:1,canvas:[1200,1600],box:[.18,.05,.64,.90],anchor:[.5,0],scale:['height',1.5],orientation:['vertical',15,1.3],multiple:'flag'},
  'tops-front@1':{revision:1,canvas:[1200,1600],box:[.08,.08,.84,.84],anchor:[.5,0],scale:['contain',1.5],orientation:['vertical',8,1.15],multiple:'flag'},
  'suits-front@1':{revision:1,canvas:[1200,1600],box:[.10,.05,.80,.90],anchor:[.5,.5],scale:['contain',1.5],orientation:['none',0,1],multiple:'flag'},
  'bags@1':{revision:1,canvas:[1200,1600],box:[.12,.20,.76,.62],anchor:[.5,1],scale:['contain',1.5],orientation:['none',0,1],multiple:'flag'},
  'accessory-wide@1':{revision:1,canvas:[1200,1600],box:[.08,.30,.84,.40],anchor:[.5,.5],scale:['contain',1.5],orientation:['horizontal',20,1.3],multiple:'flag'},
  'default@1':{revision:1,canvas:[1200,1600],box:[.10,.10,.80,.80],anchor:[.5,.5],scale:['contain',1.5],orientation:['none',0,1],multiple:'flag'},
};
const geometry = t => ({revision:t.revision,canvas:[t.canvas.width,t.canvas.height],box:[t.box.x,t.box.y,t.box.w,t.box.h],anchor:[t.anchor.x,t.anchor.y],
  scale:t.scale.areaFraction===undefined?[t.scale.mode,t.scale.maxUpscale]:[t.scale.mode,t.scale.maxUpscale,t.scale.areaFraction],
  orientation:[t.orientation.axis,t.orientation.maxCorrectionDeg,t.orientation.minElongation],multiple:t.multipleObjects});
test('frozen geometry history: the current revision of every template matches its recorded entry exactly',()=>{
  assert.equal(PICTURE_TEMPLATES_REVISION,1);
  for (const [id,t] of Object.entries(PICTURE_TEMPLATES)) {
    const entry = GEOMETRY[`${id}@${t.revision}`];
    assert.ok(entry,`${id}@${t.revision} has no history entry; add one when bumping the revision`);
    assert.deepEqual(geometry(t),entry,`${id}: geometry changed without a revision bump`);
  }
  for (const key of Object.keys(GEOMETRY)) { const [id,rev] = key.split('@'); assert.ok(PICTURE_TEMPLATES[id]&&PICTURE_TEMPLATES[id].revision>=Number(rev),`history entry ${key} is stale or ahead`); }
});
