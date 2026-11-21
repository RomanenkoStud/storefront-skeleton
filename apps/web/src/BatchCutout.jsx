import React,{useEffect,useRef,useState} from 'react';
import {api} from './api.js';
import {createBatchProcessor} from './background-removal.js';
import {prepareCutout,saveCutoutResult,cutoutProgressLabel} from './cutout-photo.js';
import {runBatch} from './batch-cutout.js';

// Sequential batch background removal for the selected products. One worker/model session serves the whole run.
export default function BatchCutout({products,onBusy,onFinished,onEdit,onClose}){
  const [allPhotos,setAllPhotos]=useState(false),[state,setState]=useState('idle'),[progress,setProgress]=useState(null),[label,setLabel]=useState(''),[summary,setSummary]=useState(null),[cancelling,setCancelling]=useState(false);
  const cancel=useRef(false),running=useRef(false);
  useEffect(()=>{
    if(state!=='running')return;
    const warn=e=>{e.preventDefault();e.returnValue='';};
    window.addEventListener('beforeunload',warn);return()=>window.removeEventListener('beforeunload',warn);
  },[state]);
  async function start(){
    if(running.current)return;running.current=true;cancel.current=false;setCancelling(false);setState('running');setSummary(null);setProgress(null);onBusy(true);
    const processor=createBatchProcessor(),targets=products.map(p=>({id:p.id,title:p.title,photos:p.photos||[]}));
    try{
      const result=await runBatch({products:targets,allPhotos,isCancelled:()=>cancel.current,onProgress:p=>{setProgress(p);setLabel('Отримуємо оригінал…');},
        loadLineage:async id=>{const data=await api(`/api/admin/products/${encodeURIComponent(id)}/image-originals`);if(data.storageAvailable===false)throw new Error('Сховище R2 не підключене');return {originals:data.originals||{}};},
        loadProduct:async id=>{const data=await api('/api/admin/products');const product=(data.items||[]).find(x=>x.id===id);if(!product)throw new Error('Товар не знайдено');return product;},
        cutout:async item=>{
          const prepared=await prepareCutout(item.productId,item.src,{process:processor.process,retryCpu:processor.retryCpu,onProgress:p=>setLabel(cutoutProgressLabel(p))});
          setLabel('Зберігаємо вирізане фото…');return saveCutoutResult(item.productId,prepared);
        },
        persist:(id,photos)=>api(`/api/admin/products/${encodeURIComponent(id)}`,{method:'PATCH',body:{photos}})});
      setSummary(result);
    }catch(e){setSummary({total:0,ok:[],skipped:[],failed:[{productId:'',title:'Пакетна обробка',reason:e.message}],cancelled:false,remaining:0});}
    finally{processor.close();running.current=false;setState('done');onBusy(false);await onFinished();}
  }
  const p=progress;
  return <section className="batch-cutout" aria-label="Пакетне видалення фону">
    {state==='idle'&&<>
      <p><strong>Видалити фон: {products.length} товарів</strong></p>
      <p className="field-help">Обробка відбувається у вашому браузері, по одному фото. Не закривайте вкладку до завершення. Фото, що вже без фону, пропускаються; оригінали зберігаються й доступні в редакторі. Нові фото одразу замінюють старі в товарі.</p>
      <label className="batch-cutout-toggle"><input type="checkbox" checked={allPhotos} onChange={e=>setAllPhotos(e.target.checked)}/> Усі фото товару (за замовчуванням — лише перше)</label>
      <div className="batch-cutout-actions"><button type="button" className="button small primary" onClick={start}>Почати</button><button type="button" className="button small secondary" onClick={onClose}>Закрити</button></div>
    </>}
    {state==='running'&&<div role="status" aria-live="polite">
      <p><strong>{p?`${Math.min(p.done+1,p.total)} з ${p.total}`:'Готуємо чергу…'}</strong>{p?.current?` · ${p.current.title}`:''}</p>
      {p&&<progress max={p.total} value={p.done} aria-label="Прогрес пакетної обробки"/>}
      <p>{label}</p>
      {p&&<p>Успішно: {p.ok} · Пропущено: {p.skipped} · Помилки: {p.failed}</p>}
      <button type="button" className="button small secondary" disabled={cancelling} onClick={()=>{cancel.current=true;setCancelling(true);}}>{cancelling?'Зупинимо після поточного фото…':'Скасувати'}</button>
    </div>}
    {state==='done'&&summary&&<div role="status" aria-live="polite">
      <p><strong>{summary.cancelled?`Скасовано. Не оброблено фото: ${summary.remaining}`:'Готово'}</strong> · Успішно: {summary.ok.length} · Пропущено: {summary.skipped.length} · Помилки: {summary.failed.length}</p>
      {!!summary.failed.length&&<><p>Не вдалося обробити:</p><ul>{summary.failed.map((f,i)=><li key={i}>{f.title}{allPhotos&&f.src?` (фото ${f.index+1})`:''}: {f.reason} {f.productId&&<button type="button" className="text-button" onClick={()=>onEdit(f.productId)}>Відкрити товар</button>}</li>)}</ul></>}
      {!!summary.skipped.length&&<><p>Пропущено:</p><ul>{summary.skipped.map((f,i)=><li key={i}>{f.title}{allPhotos&&f.src?` (фото ${f.index+1})`:''}: {f.reason}</li>)}</ul></>}
      <div className="batch-cutout-actions"><button type="button" className="button small secondary" onClick={onClose}>Закрити</button></div>
    </div>}
  </section>;
}
