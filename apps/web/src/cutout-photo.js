import {api,apiPath} from './api.js';
import {processImage} from './background-removal.js';

export function cutoutProgressLabel({key,current,total,device}){
  return key==='fallback'?'WebGPU недоступний. Повторюємо через WebAssembly…':key.startsWith('fetch:')?`Завантажуємо модель / середовище${total?`: ${Math.round(current/total*100)}%`:'…'}`:`Обробляємо локально (${device==='gpu'?'WebGPU':'WebAssembly'})…`;
}
export const DEGENERATE_MESSAGE='Не вдалося відокремити товар від фону (маска порожня або повна)';
export const ALPHA_TRANSPARENT_BELOW=16,MIN_TRANSPARENT=0.01,MAX_TRANSPARENT=0.99;
// Pure: share of transparent pixels in RGBA data; a cutout that is >99% or <1% transparent is a failed mask.
export function transparentFraction(rgba){let t=0;const n=Math.floor(rgba.length/4);for(let i=3;i<rgba.length;i+=4)if(rgba[i]<ALPHA_TRANSPARENT_BELOW)t++;return n?t/n:1;}
export function isDegenerateMask(rgba){const f=transparentFraction(rgba);return f>MAX_TRANSPARENT||f<MIN_TRANSPARENT;}
async function resultAlpha(bitmap){const scale=Math.min(1,256/Math.max(bitmap.width,bitmap.height)),w=Math.max(1,Math.round(bitmap.width*scale)),h=Math.max(1,Math.round(bitmap.height*scale));const canvas=new OffscreenCanvas(w,h),ctx=canvas.getContext('2d');ctx.drawImage(bitmap,0,0,w,h);return ctx.getImageData(0,0,w,h).data;}
// Fetch the original through the product image endpoint, run background removal and validate dimensions.
// Returns null when aborted before a result exists.
export async function prepareCutout(productId,src,{signal,onProgress=()=>{},process=processImage,retryCpu,onFetched=()=>{}}={}){
  const response=await fetch(apiPath(`/api/admin/products/${encodeURIComponent(productId)}/image?url=${encodeURIComponent(src)}`),{credentials:'same-origin',signal});
  if(!response.ok){const data=await response.json().catch(()=>({}));throw new Error(data.error||'Не вдалося отримати фото. Збережіть зміни товару перед обробкою.');}
  const blob=await response.blob();
  onFetched();
  let result=await process(blob,{signal,onProgress});
  if(signal?.aborted)return null;
  const sourceBitmap=await createImageBitmap(blob);let resultBitmap=await createImageBitmap(result);
  let degenerate=isDegenerateMask(await resultAlpha(resultBitmap));
  if(degenerate&&retryCpu){
    // A broken GPU can return a blank mask; try this photo once on WebAssembly.
    const again=await retryCpu(blob,{signal,onProgress});
    if(signal?.aborted)return null;
    if(again){resultBitmap.close();result=again;resultBitmap=await createImageBitmap(result);degenerate=isDegenerateMask(await resultAlpha(resultBitmap));}
  }
  const width=sourceBitmap.width,height=sourceBitmap.height,valid=width===resultBitmap.width&&height===resultBitmap.height;
  sourceBitmap.close();resultBitmap.close();
  if(degenerate)throw new Error(DEGENERATE_MESSAGE);if(!valid)throw new Error('Розмір результату відрізняється від оригіналу. Фото не змінено.');
  const originalHash=Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',await blob.arrayBuffer())),b=>b.toString(16).padStart(2,'0')).join('');
  if(signal?.aborted)return null;
  return {src,blob:result,width,height,originalHash};
}
// Archive the original and store the cutout; resolves {url,originalUrl}.
export function saveCutoutResult(productId,prepared,signal){
  const data=new FormData();data.append('sourceUrl',prepared.src);data.append('originalHash',prepared.originalHash);data.append('file',prepared.blob,'cutout.png');
  return api(`/api/admin/products/${encodeURIComponent(productId)}/cutout`,{method:'POST',body:data,signal});
}
