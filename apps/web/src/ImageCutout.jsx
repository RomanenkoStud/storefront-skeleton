import React,{useEffect,useRef,useState} from 'react';
import {api} from './api.js';
import {prepareCutout,saveCutoutResult,cutoutProgressLabel} from './cutout-photo.js';
import PictureFit from './PictureFit.jsx';
import {fitAction,cutoutAction,restoreTargets,templateStatus,lineageAfterSave,createJobGate} from './picture-fitter.js';

export default function ImageCutout({productId,photos,onReplace,onBusy,disabled=false,dirty=false,categoryId=null}){
  const [originals,setOriginals]=useState({}),[lineage,setLineage]=useState({}),[fit,setFit]=useState(null),[storage,setStorage]=useState(null),[error,setError]=useState(''),[job,setJob]=useState(null),[preview,setPreview]=useState(null),[background,setBackground]=useState('transparent');
  const abort=useRef(null),locked=useRef(false),previewUrl=useRef(null),gate=useRef(null);
  if(!gate.current)gate.current=createJobGate(busy=>{locked.current=busy;onBusy(busy);});
  useEffect(()=>{let live=true;api(`/api/admin/products/${encodeURIComponent(productId)}/image-originals`).then(data=>{if(live){setOriginals(data.originals);setLineage(data.lineage||{});setStorage(data.storageAvailable);}}).catch(e=>{if(live)setError(e.message);});return()=>{live=false;abort.current?.abort();gate.current.release();if(previewUrl.current)URL.revokeObjectURL(previewUrl.current);};},[productId]);
  function clear(){abort.current?.abort();abort.current=null;if(previewUrl.current)URL.revokeObjectURL(previewUrl.current);previewUrl.current=null;setPreview(null);setJob(null);gate.current.release();}
  async function start(src,index){
    if(disabled||!gate.current.acquire())return;setError('');setJob({index,label:'Отримуємо оригінал…'});abort.current=new AbortController();
    const signal=abort.current.signal;
    try{
      const prepared=await prepareCutout(productId,src,{signal,onProgress:p=>{
        const key=p.key;setJob({index,label:cutoutProgressLabel(p),value:key.startsWith('fetch:')&&p.total?p.current/p.total:undefined});
      }});
      if(!prepared)return;
      const {blob:result,width,height,originalHash}=prepared;
      const url=URL.createObjectURL(result);previewUrl.current=url;setPreview({src,index,blob:result,url,width,height,originalHash});setJob({index,label:'Перевірте краї, деталі та колір перед збереженням.'});
    }catch(e){if(e.name!=='AbortError')setError(e.message);clear();}
  }
  function startFit(index,action){if(disabled||action.disabled||!gate.current.acquire())return;setError('');focusBack.current=index;setFit({index,action});}
  // Closing the fit view unmounts the focused control; return focus to the fit button that opened it.
  const focusBack=useRef(null),root=useRef(null);
  useEffect(()=>{
    if(fit||focusBack.current===null)return;
    const index=focusBack.current;focusBack.current=null;
    const frame=requestAnimationFrame(()=>root.current?.querySelector(`[data-fit-index="${index}"]`)?.focus());
    return()=>cancelAnimationFrame(frame);
  },[fit]);
  function closeFit(){setFit(null);gate.current.release();}
  function fitAccepted(index,saved,recipe){setOriginals(x=>({...x,[saved.url]:saved.originalUrl}));setLineage(x=>lineageAfterSave(x,saved,recipe));onReplace(index,saved.url);closeFit();}
  async function save(){
    if(!preview||job?.saving)return;setJob({...job,saving:true,label:'Зберігаємо вирізане фото та оригінал…'});setError('');
    try{
      const saved=await saveCutoutResult(productId,preview,abort.current.signal);
      setOriginals(x=>({...x,[saved.url]:saved.originalUrl}));onReplace(preview.index,saved.url);clear();
    }catch(e){if(e.name!=='AbortError'){setError(e.message);setJob(x=>({...x,saving:false}));}}
  }
  return <section className="image-cutout" aria-label="Видалення фону" ref={root}>
    <p className="field-help">Обробка відбувається у вашому браузері. Модель завантажується при першому використанні й кешується. Після вибору фото збережіть зміни товару.</p>
    {storage===false&&<p role="status">Для збереження вирізаних фото потрібно підключити сховище R2.</p>}
    {error&&<p role="alert" className="inline-error">{error}</p>}
    <div className="cutout-actions">{photos.map((src,index)=>{const cut=cutoutAction({src,lineage,busy:disabled||!!job||!!fit,storage}),action=fitAction({src,lineage,dirty,busy:disabled||!!job||!!fit,storage}),targets=restoreTargets(src,lineage,originals),stale=templateStatus(lineage[src]);return <div key={`${src}-${index}`}><span>Фото {index+1}</span> <button type="button" className="button small secondary" disabled={cut.disabled} aria-describedby={cut.hint?`cut-hint-${index}`:undefined} onClick={()=>start(src,index)}>Видалити фон</button> {action.visible&&<button type="button" className="button small secondary" data-fit-index={index} disabled={action.disabled} aria-describedby={action.hint?`fit-hint-${index}`:undefined} onClick={()=>startFit(index,action)}>{action.label}</button>} {targets.original&&<button type="button" className="text-button" disabled={disabled||!!job||!!fit} onClick={()=>onReplace(index,targets.original)}>Відновити оригінал</button>} {targets.cutout&&<button type="button" className="text-button" disabled={disabled||!!job||!!fit} onClick={()=>onReplace(index,targets.cutout)}>Повернути вирізане фото</button>} {stale.stale&&<span className="picture-fit-stale">{stale.label}</span>}{cut.hint&&<small id={`cut-hint-${index}`} className="field-help">{cut.hint}</small>}{action.visible&&action.hint&&<small id={`fit-hint-${index}`} className="field-help">{action.hint}</small>}</div>;})}</div>
    {fit&&<PictureFit key={`${fit.index}-${fit.action.sourceUrl}`} productId={productId} sourceUrl={fit.action.sourceUrl} categoryId={categoryId} refit={fit.action.refit} onCancel={closeFit} onAccepted={(saved,recipe)=>fitAccepted(fit.index,saved,recipe)}/>}
    {job&&<div className="cutout-workspace" aria-busy={!preview||job.saving}>
      <p role="status">Фото {job.index+1}: {job.label}</p>{job.value!==undefined&&<progress max="1" value={job.value}/>}
      {preview&&<><div role="group" aria-label="Фон попереднього перегляду">{[['transparent','Прозорий'],['white','Білий'],['cream','Кремовий']].map(([value,label])=><button type="button" className="button small secondary" key={value} aria-pressed={background===value} onClick={()=>setBackground(value)}>{label}</button>)}</div><div className="cutout-comparison"><figure><img src={preview.src} alt="Оригінал"/><figcaption>Оригінал</figcaption></figure><figure className={`cutout-preview cutout-${background}`}><img src={preview.url} alt="Попередній перегляд без фону"/><figcaption>Без фону · {preview.width} × {preview.height}</figcaption></figure></div><button type="button" className="button primary" disabled={job.saving} onClick={save}>Використати фото без фону</button></>}
      <button type="button" className="button secondary" disabled={job.saving} onClick={clear}>Скасувати обробку</button>
    </div>}
    <small>IS-Net (IMG.LY) / ONNX Runtime · <a href="/licenses/background-removal.txt" target="_blank" rel="noreferrer">Ліцензії та автори</a></small>
  </section>;
}
