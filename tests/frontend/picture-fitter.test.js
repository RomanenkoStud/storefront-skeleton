import test from 'node:test';
import assert from 'node:assert/strict';
import {PICTURE_TEMPLATES,resolvePictureTemplate} from '../../packages/catalog/picture-templates.js';
import {validateFitRecipe,analyzeMask,computeFit} from '../../packages/catalog/picture-fit.js';
import {createTaxonomyContext} from '../../packages/catalog/taxonomy.js';
import {proposeFit,clampManual,applyNudge,MANUAL_LIMITS,NEUTRAL_MANUAL,NUDGES,fitAction,fitSource,flagMessage,mapNormalizedError,mapImageError,cutoutAction,createJobGate,templateStatus,lineageAfterSave,restoreTargets,hintForTemplate} from '../../apps/web/src/picture-fitter.js';

function shoeAlpha(width=600,height=400){
  const data=new Uint8Array(width*height*4);
  for(let y=100;y<300;y++)for(let x=50;x<550;x++)data[(y*width+x)*4+3]=255;
  return {width,height,data,channels:4};
}
const tpl=PICTURE_TEMPLATES['footwear-side'];

test('mask fitter returns a valid recipe, mask fitter label and a refit that does not re-analyse',async()=>{
  const alpha=shoeAlpha(),progress=[];
  const out=await proposeFit({cutout:{width:600,height:400},alpha,template:tpl,onProgress:p=>progress.push(p)});
  assert.equal(out.fitter,'mask');assert.equal(out.fallbackReason,'unsupported');
  assert.deepEqual(validateFitRecipe(out.result,tpl),out.result);
  // refit must not read pixels again: replace the buffer with a throwing proxy after analysis
  Object.defineProperty(alpha,'data',{get(){throw new Error('re-analysed');}});
  const manual={rotateDeg:1,scale:1.1,offsetX:0.01,offsetY:-0.01},r=out.refit(manual);
  assert.deepEqual(r.manual,manual);assert.deepEqual(validateFitRecipe(r,tpl),r);
  assert.equal(out.refit(null).manual,null);
  assert.equal(out.refit(null).transform.scale,out.result.transform.scale);
  assert.throws(()=>out.refit({rotateDeg:99}));
});

test('abort rejects with AbortError and never falls back',async()=>{
  const c=new AbortController();c.abort();
  await assert.rejects(proposeFit({cutout:{},alpha:shoeAlpha(),template:tpl,signal:c.signal}),{name:'AbortError'});
  const c2=new AbortController(),p=proposeFit({cutout:{},alpha:shoeAlpha(),template:tpl,signal:c2.signal});c2.abort();
  await assert.rejects(p,{name:'AbortError'});
});

test('manual nudges step, clamp to picture-fit bounds and reset',()=>{
  assert.deepEqual(NUDGES.map(n=>[n.key,n.step]),[['rotateDeg',0.5],['scale',0.02],['offsetX',0.01],['offsetY',0.01]]);
  let m=null;m=applyNudge(m,'rotateDeg',1);m=applyNudge(m,'rotateDeg',1);assert.equal(m.rotateDeg,1);
  m=applyNudge(m,'scale',-1);assert.equal(m.scale,0.98);
  m=applyNudge(m,'offsetX',1);assert.equal(m.offsetX,0.01);
  for(let i=0;i<200;i++)m=applyNudge(m,'rotateDeg',1);assert.equal(m.rotateDeg,45);
  for(let i=0;i<200;i++)m=applyNudge(m,'scale',1);assert.equal(m.scale,2);
  for(let i=0;i<200;i++)m=applyNudge(m,'scale',-1);assert.equal(m.scale,0.5);
  for(let i=0;i<100;i++)m=applyNudge(m,'offsetY',-1);assert.equal(m.offsetY,-0.25);
  assert.deepEqual(clampManual({rotateDeg:99,scale:9,offsetX:9,offsetY:-9}),{rotateDeg:45,scale:2,offsetX:0.25,offsetY:-0.25});
  assert.equal(applyNudge({rotateDeg:0,scale:1,offsetX:0,offsetY:0},'scale',1).scale,1.02);
});

test('fit action visibility, lineage source selection and save-first gating',()=>{
  const cut={originalUrl:'/media/o.jpg'},norm={originalUrl:'/media/o.jpg',cutoutUrl:'/media/c.png',templateId:'footwear-side',templateRevision:1};
  assert.equal(fitAction({src:'/x.jpg',lineage:{},dirty:false}).visible,false);
  assert.equal(fitAction({src:'/x.jpg',lineage:null,dirty:false}).visible,false);
  const a=fitAction({src:'/media/c.png',lineage:{'/media/c.png':cut},dirty:false});
  assert.deepEqual([a.visible,a.label,a.disabled,a.sourceUrl,a.refit],[true,'Вирівняти за шаблоном',false,'/media/c.png',false]);
  const r=fitAction({src:'/media/n.png',lineage:{'/media/n.png':norm},dirty:false});
  assert.deepEqual([r.label,r.sourceUrl,r.refit],['Перевирівняти','/media/c.png',true]);
  const d=fitAction({src:'/media/c.png',lineage:{'/media/c.png':cut},dirty:true});
  assert.equal(d.disabled,true);assert.equal(d.hint,'Спочатку збережіть зміни товару');
  assert.equal(fitAction({src:'/media/c.png',lineage:{'/media/c.png':cut},dirty:false,busy:true}).disabled,true);
  assert.equal(fitAction({src:'/media/c.png',lineage:{'/media/c.png':cut},dirty:false,storage:false}).disabled,true);
  assert.deepEqual(fitSource('/media/n.png',{'/media/n.png':norm}),{sourceUrl:'/media/c.png',refit:true});
  assert.equal(fitSource('/media/n.png',{'/media/n.png':{cutoutUrl:'../evil'}}),null);
  assert.equal(fitSource('/media/n.png',{'/media/n.png':{cutoutUrl:'/media/n.png'}}),null);
});

test('restore targets work from lineage after reload, even when the cutout is no longer in the photos',()=>{
  const norm={originalUrl:'/media/o.jpg',cutoutUrl:'/media/c.png',templateId:'default',templateRevision:1};
  const lineage={'/media/n.png':norm,'/media/c.png':{originalUrl:'/media/o.jpg'}};
  assert.deepEqual(restoreTargets('/media/n.png',lineage,{}),{original:'/media/o.jpg',cutout:'/media/c.png'});
  assert.deepEqual(restoreTargets('/media/c.png',lineage,{}),{original:'/media/o.jpg',cutout:null});
  assert.deepEqual(restoreTargets('/media/n.png',{},{'/media/n.png':'/media/o.jpg'}),{original:'/media/o.jpg',cutout:null});
  assert.deepEqual(restoreTargets('/x.jpg',lineage,{}),{original:null,cutout:null});
  assert.deepEqual(lineageAfterSave({'/a':{originalUrl:'o'}},{url:'/media/n.png',cutoutUrl:'/media/c.png',originalUrl:'/media/o.jpg'},{templateId:'default',templateRevision:2}),
    {'/a':{originalUrl:'o'},'/media/n.png':{originalUrl:'/media/o.jpg',cutoutUrl:'/media/c.png',templateId:'default',templateRevision:2}});
});

test('template staleness and category hint',()=>{
  const r=PICTURE_TEMPLATES['footwear-side'].revision;
  assert.deepEqual(templateStatus({templateId:'footwear-side',templateRevision:r}),{stale:false});
  assert.deepEqual(templateStatus({templateId:'footwear-side',templateRevision:r-1}),{stale:true,label:'Шаблон оновлено'});
  assert.deepEqual(templateStatus({}),{stale:false});
  const ctx=createTaxonomyContext({});
  assert.match(hintForTemplate('unclassified'),/категор/i);assert.match(hintForTemplate(null),/категор/i);assert.equal(hintForTemplate('sneakers'),null);
  assert.equal(resolvePictureTemplate('unclassified',ctx).template.id,'default');
});

test('flags and API errors map to Ukrainian messages',()=>{
  for(const f of ['empty-mask','multiple-objects','fragmented','edge-clipped','rotation-ambiguous','rotation-over-limit','aspect-mismatch','upscaled','soft-mask'])assert.match(flagMessage(f),/[а-яіїєґ]/i,f);
  assert.match(flagMessage('nope'),/[а-яіїєґ]/i);
  const e=(status,code,message='english')=>mapNormalizedError({status,code,message});
  assert.equal(e(409,'template-updated'),'Шаблон оновлено. Вирівняйте фото ще раз.');
  assert.match(e(409,'source-changed'),/змінилося/);
  for(const code of ['source-not-allowed','source-not-cutout','invalid-recipe','unknown-template','canvas-mismatch','metadata-too-large','invalid-png','too-large','not-png','storage-unavailable'])assert.match(e(400,code),/[а-яіїєґ]/i,code);
  assert.equal(e(409,undefined,'Шаблон оновлено. Вирівняйте фото ще раз.'),e(409,undefined,'x'),'message text is ignored');
  assert.notEqual(e(409,undefined,'Шаблон оновлено'),'Шаблон оновлено. Вирівняйте фото ще раз.');
  assert.equal(e(500,'template-updated'),'Шаблон оновлено. Вирівняйте фото ще раз.','code wins over status');
  for(const s of [400,409,413,415,503,500])assert.match(e(s),/[а-яіїєґ]/i);
  assert.match(e(503),/R2/);assert.match(e(413),/20 МБ/);assert.match(e(415),/PNG/);
  assert.match(e(400,'unexpected-future-code'),/відхилив/);
  assert.match(mapNormalizedError(new Error('x')),/[а-яіїєґ]/i);
});

test('job gate allows one job at a time and releases the editor locks',()=>{
  const calls=[],gate=createJobGate(b=>calls.push(b));
  assert.equal(gate.acquire(),true);assert.equal(gate.acquire(),false);assert.equal(gate.busy,true);
  gate.release();gate.release();assert.equal(gate.busy,false);assert.deepEqual(calls,[true,false]);
  assert.equal(gate.acquire(),true);
});

test('MANUAL_LIMITS copy matches the bounds enforced by picture-fit',()=>{
  const analysis=analyzeMask(shoeAlpha()),L=MANUAL_LIMITS;
  const ok=[{rotateDeg:L.rotate},{rotateDeg:-L.rotate},{scale:L.scaleMin},{scale:L.scaleMax},{offsetX:L.offset},{offsetY:-L.offset}];
  for(const m of ok)assert.doesNotThrow(()=>computeFit(analysis,tpl,{...NEUTRAL_MANUAL,...m}),JSON.stringify(m));
  const eps=1e-3,bad=[{rotateDeg:L.rotate+eps},{rotateDeg:-L.rotate-eps},{scale:L.scaleMin-eps},{scale:L.scaleMax+eps},{offsetX:L.offset+eps},{offsetY:-L.offset-eps}];
  for(const m of bad)assert.throws(()=>computeFit(analysis,tpl,{...NEUTRAL_MANUAL,...m}),JSON.stringify(m));
});

test('invalid-recipe advises reloading the page (version skew after a deploy)',()=>{
  assert.match(mapNormalizedError({status:400,code:'invalid-recipe'}),/Оновіть сторінку|оновіть сторінку/);
});

test('GET image errors map to Ukrainian by code then status, never the server text',()=>{
  for(const e of [{status:400,code:'source-not-allowed'},{status:400},{status:401},{status:403},{status:404},{status:503},{status:500},{},undefined]){
    const text=mapImageError(e);assert.match(text,/[А-Яа-яІіЇїЄє]/);assert.doesNotMatch(text,/Failed|Not found|error/i);
  }
  assert.match(mapImageError({status:503}),/R2/);assert.match(mapImageError({status:500}),/500/);
  assert.notEqual(mapImageError({status:404}),mapImageError({}));
});

test('background removal is disabled with a hint on normalized photos only',()=>{
  const lineage={'/media/n.png':{originalUrl:'/media/o.jpg',cutoutUrl:'/media/c.png',templateId:'t',templateRevision:1},'/media/c.png':{originalUrl:'/media/o.jpg'}};
  const norm=cutoutAction({src:'/media/n.png',lineage});
  assert.equal(norm.disabled,true);assert.match(norm.hint,/Перевирівняти/);
  assert.deepEqual(cutoutAction({src:'/media/c.png',lineage}),{disabled:false,hint:null});
  assert.deepEqual(cutoutAction({src:'https://x/y.jpg',lineage}),{disabled:false,hint:null});
  assert.equal(cutoutAction({src:'/media/c.png',lineage,busy:true}).disabled,true);
  assert.equal(cutoutAction({src:'/media/c.png',lineage,storage:false}).disabled,true);
  assert.equal(cutoutAction({src:'constructor',lineage:{}}).disabled,false);
});
