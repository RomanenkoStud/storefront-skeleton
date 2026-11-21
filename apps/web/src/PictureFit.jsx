import React,{useEffect,useRef,useState} from 'react';
import {apiPath} from './api.js';
import {useTaxonomy} from './TaxonomyContext.jsx';
import {resolvePictureTemplate} from '../../../packages/catalog/picture-templates.js';
import {mapImageError,proposeFit,applyNudge,formatManual,NUDGES,NEUTRAL_MANUAL,flagMessage,mapNormalizedError,hintForTemplate} from './picture-fitter.js';
import {renderFit} from './picture-render.js';

// TODO(T8): move alpha extraction (getImageData on the full bitmap) to a worker; it blocks the main thread on large cutouts.
const hex=buffer=>Array.from(new Uint8Array(buffer),b=>b.toString(16).padStart(2,'0')).join('');
async function extractAlpha(bitmap){
  const canvas=new OffscreenCanvas(bitmap.width,bitmap.height),ctx=canvas.getContext('2d',{willReadFrequently:true});
  ctx.drawImage(bitmap,0,0);
  const {data}=ctx.getImageData(0,0,bitmap.width,bitmap.height);
  return {width:bitmap.width,height:bitmap.height,data,channels:4};
}
// api() drops the error code, so this POST reads the {error, code} body itself (same credentials/Origin conventions as api()).
async function postNormalized(productId,form,signal){
  const response=await fetch(apiPath(`/api/admin/products/${encodeURIComponent(productId)}/normalized`),{method:'POST',credentials:'same-origin',body:form,signal});
  const body=await response.json().catch(()=>({}));
  if(!response.ok){const error=new Error(body.error||`Помилка запиту (${response.status}).`);error.status=response.status;error.code=typeof body.code==='string'?body.code:undefined;throw error;}
  return body;
}
const FALLBACK={unsupported:'нейромережа ще недоступна','load-failed':'модель не вдалося завантажити','inference-failed':'модель не впоралася','deadline':'модель відповідала надто довго'};

// Fit, preview and save for one photo. The parent holds the editor locks for the whole lifetime of this component.
export default function PictureFit({productId,sourceUrl,categoryId,refit,onAccepted,onCancel}){
  const taxonomy=useTaxonomy();
  const [phase,setPhase]=useState({key:'load',label:'Отримуємо вирізане фото…'}),[error,setError]=useState('');
  const [state,setState]=useState(null),[manual,setManual]=useState(null),[background,setBackground]=useState('transparent');
  const [after,setAfter]=useState(null),[saving,setSaving]=useState(false);
  const ctl=useRef(new AbortController()),data=useRef(null),seq=useRef(0),afterUrl=useRef(null),beforeUrl=useRef(null),[beforeSrc,setBeforeSrc]=useState(null);
  useEffect(()=>{
    const signal=ctl.current.signal;let closed=false;
    (async()=>{
      try{
        const response=await fetch(apiPath(`/api/admin/products/${encodeURIComponent(productId)}/image?url=${encodeURIComponent(sourceUrl)}`),{credentials:'same-origin',signal});
        if(!response.ok){const body=await response.json().catch(()=>({}));throw Object.assign(new Error(mapImageError({status:response.status,code:body.code})),{status:response.status});}
        const blob=await response.blob();
        const sourceHash=hex(await crypto.subtle.digest('SHA-256',await blob.arrayBuffer()));
        const bitmap=await createImageBitmap(blob);
        if(closed)return bitmap.close();
        data.current={bitmap,sourceHash};
        beforeUrl.current=URL.createObjectURL(blob);setBeforeSrc(beforeUrl.current);
        const alpha=await extractAlpha(bitmap),resolved=resolvePictureTemplate(categoryId,taxonomy);
        const fitter=await proposeFit({cutout:bitmap,alpha,template:resolved.template,signal,onProgress:()=>setPhase({key:'fit',label:'Аналізуємо маску…'})});
        if(closed)return;
        Object.assign(data.current,{template:resolved.template,fitter});
        if(!await show(fitter.result,fitter))return;
        setPhase({key:'ready',label:'Перевірте положення предмета перед збереженням.'});
      }catch(e){if(e.name!=='AbortError'&&!closed){setError(e.message);setPhase({key:'failed',label:'Вирівнювання не вдалося.'});}}
    })();
    return()=>{closed=true;ctl.current.abort();data.current?.bitmap.close();for(const r of [afterUrl,beforeUrl])if(r.current)URL.revokeObjectURL(r.current);};
  },[]);
  async function show(fit,fitter=data.current.fitter){
    const mine=++seq.current;
    setPhase(p=>({key:'render',label:'Малюємо результат…'}));
    let blob;
    try{blob=await renderFit(data.current.bitmap,fit);}
    catch(e){
      // A failed re-render must not leave Save disabled forever: keep the last good result, else fail.
      if(mine===seq.current&&!ctl.current.signal.aborted){
        setError(e.message);
        data.current.blob?setPhase({key:'ready',label:'Перевірте положення предмета перед збереженням.'}):setPhase({key:'failed',label:'Вирівнювання не вдалося.'});
      }
      return false;
    }
    if(mine!==seq.current||ctl.current.signal.aborted)return false;
    if(afterUrl.current)URL.revokeObjectURL(afterUrl.current);
    afterUrl.current=URL.createObjectURL(blob);
    data.current.blob=blob;
    setState({fit,fitter:fitter.fitter,fallbackReason:fitter.fallbackReason});setAfter({url:afterUrl.current});setPhase({key:'ready',label:'Перевірте положення предмета перед збереженням.'});setError('');return true;
  }
  const timer=useRef(null);
  useEffect(()=>()=>clearTimeout(timer.current),[]);
  // refit() itself may throw before show() runs; same recovery as a failed render.
  function fail(e){setError(e.message);setPhase(data.current?.blob?{key:'ready',label:'Перевірте положення предмета перед збереженням.'}:{key:'failed',label:'Вирівнювання не вдалося.'});}
  function nudge(next){
    setManual(next);setPhase({key:'render',label:'Малюємо результат…'});clearTimeout(timer.current);
    timer.current=setTimeout(()=>{
      try{show(data.current.fitter.refit(next)).catch(fail);}catch(e){fail(e);}
    },120);
  }
  async function save(){
    if(!state||phase.key!=='ready'||saving)return;setSaving(true);setError('');
    try{
      const form=new FormData();form.append('sourceUrl',sourceUrl);form.append('sourceHash',data.current.sourceHash);form.append('recipe',JSON.stringify(state.fit));form.append('file',data.current.blob,'normalized.png');
      const saved=await postNormalized(productId,form,ctl.current.signal);
      onAccepted(saved,state.fit);
    }catch(e){if(e.name!=='AbortError'){setError(mapNormalizedError(e));setSaving(false);}}
  }
  const t=data.current?.template,box=t?.box,guide=t?.guide,fit=state?.fit,ready=phase.key==='ready',manualNow={...NEUTRAL_MANUAL,...manual};
  const busy=!['ready','failed'].includes(phase.key)||saving;
  const hint=hintForTemplate(categoryId);
  return <div className="picture-fit" aria-busy={busy}>
    <h3 className="picture-fit-title">{refit?'Перевирівняти фото':'Вирівняти за шаблоном'}</h3>
    {t&&<p className="picture-fit-template">Шаблон: <strong>{t.label}</strong> · ревізія {t.revision}</p>}
    {hint&&t&&<p className="field-help" role="note">{hint}</p>}
    <p role="status" className="picture-fit-phase">{saving?'Зберігаємо вирівняне фото…':phase.label}</p>
    {error&&<p role="alert" className="inline-error">{error}</p>}
    {state&&<p className="field-help picture-fit-fitter">{state.fitter==='model'?'Вирівнювання за допомогою нейромережі.':`Вирівнювання за маскою без нейромережі (${FALLBACK[state.fallbackReason]||'модель не використано'}).`}</p>}
    {fit&&<div role="status" aria-label="Попередження вирівнювання" className="picture-fit-flags">{fit.quality.flags.length?<ul>{fit.quality.flags.map(f=><li key={f}>{flagMessage(f)}</li>)}</ul>:<p>Зауважень немає.</p>}</div>}
    {(beforeSrc||after)&&<><div role="group" aria-label="Фон попереднього перегляду" className="picture-fit-backgrounds">{[['transparent','Прозорий'],['white','Білий'],['cream','Кремовий']].map(([value,label])=><button type="button" className="button small secondary" key={value} aria-pressed={background===value} onClick={()=>setBackground(value)}>{label}</button>)}</div>
    <div className="picture-fit-compare">
      <figure className={`picture-fit-before cutout-${background}`}>{beforeSrc&&<img src={beforeSrc} alt="Вирізане фото до вирівнювання"/>}<figcaption>До</figcaption></figure>
      <figure className={`picture-fit-after cutout-${background}`}>
        <div className="picture-fit-stage" style={t?{aspectRatio:`${t.canvas.width} / ${t.canvas.height}`}:undefined}>
          {after&&<img src={after.url} alt="Вирівняне фото"/>}
          {box&&<div className="picture-fit-box" aria-hidden="true" style={{left:`${box.x*100}%`,top:`${box.y*100}%`,width:`${box.w*100}%`,height:`${box.h*100}%`}}>{guide&&<svg viewBox={guide.viewBox} preserveAspectRatio="none" focusable="false"><path d={guide.d}/></svg>}</div>}
        </div>
        <figcaption>Після{fit?` · ${fit.canvas.width} × ${fit.canvas.height}`:''}</figcaption>
      </figure>
    </div></>}
    {state&&<fieldset className="picture-fit-nudges" disabled={saving}><legend>Ручне коригування</legend>
      {NUDGES.map(n=><div className="picture-fit-nudge" key={n.key} role="group" aria-label={n.label}>
        <span className="picture-fit-nudge-label" id={`pf-${n.key}`}>{n.label}</span>
        <button type="button" className="button small secondary" aria-label={`${n.label}: ${n.decrease}`} onClick={()=>nudge(applyNudge(manual,n.key,-1))}>−</button>
        <output aria-labelledby={`pf-${n.key}`} className="picture-fit-value">{formatManual(manualNow,n.key)}</output>
        <button type="button" className="button small secondary" aria-label={`${n.label}: ${n.increase}`} onClick={()=>nudge(applyNudge(manual,n.key,1))}>+</button>
      </div>)}
      <button type="button" className="text-button" disabled={!manual} onClick={()=>{setManual(null);clearTimeout(timer.current);show(data.current.fitter.refit(null)).catch(fail);}}>Скинути</button>
    </fieldset>}
    <div className="picture-fit-actions">
      <button type="button" className="button primary" disabled={!ready||saving||fit?.quality.level==='unsupported'} onClick={save}>Використати вирівняне фото</button>
      <button type="button" className="button secondary" disabled={saving} onClick={onCancel}>Зберегти без вирівнювання</button>
    </div>
  </div>;
}
