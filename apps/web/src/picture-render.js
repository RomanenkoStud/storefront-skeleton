// Browser render step (docs/MEDIA.md "Picture normalization (fit)"). The source is always the saved cutout:
// callers pass the decoded cutout bitmap, never an earlier normalized image. No mirroring, no RGB edits.
export const HALVING_THRESHOLD=0.5;
export function halvingSteps(scale){
  let steps=0,s=scale;
  while(s<HALVING_THRESHOLD&&steps<16){s*=2;steps+=1;}
  return steps;
}
const finite=n=>typeof n==='number'&&Number.isFinite(n);
export async function renderFit(cutout,fit,{OffscreenCanvasImpl=globalThis.OffscreenCanvas}={}){
  if(!cutout||!(cutout.width>0)||!(cutout.height>0))throw new TypeError('Потрібне вирізане фото (cutout) для рендеру.');
  const {canvas,matrix}=fit||{};
  if(!canvas||!Number.isInteger(canvas.width)||!Number.isInteger(canvas.height)||canvas.width<1||canvas.height<1)throw new TypeError('Некоректний розмір canvas у рецепті.');
  if(!Array.isArray(matrix)||matrix.length!==6||!matrix.every(finite))throw new TypeError('Некоректна matrix у рецепті.');
  const [a,b,c,d,e,f]=matrix;
  if(a*d-b*c<=0)throw new TypeError('Дзеркальне відображення не підтримується.');
  if(typeof OffscreenCanvasImpl!=='function')throw new Error('OffscreenCanvas недоступний у цьому браузері.');
  const scale=Math.hypot(a,b);
  let source=cutout,w=cutout.width,h=cutout.height,kx=1,ky=1; // rounding makes the per-axis shrink differ; track both so the matrix stays exact
  for(let i=halvingSteps(scale);i>0;i--){
    const nw=Math.max(1,Math.round(w/2)),nh=Math.max(1,Math.round(h/2)),step=new OffscreenCanvasImpl(nw,nh),sctx=step.getContext('2d');
    sctx.imageSmoothingQuality='high';sctx.drawImage(source,0,0,nw,nh);
    kx*=w/nw;ky*=h/nh;source=step;w=nw;h=nh;
  }
  const out=new OffscreenCanvasImpl(canvas.width,canvas.height),ctx=out.getContext('2d'); // stays transparent: no fill
  ctx.imageSmoothingQuality='high';
  ctx.setTransform(a*kx,b*kx,c*ky,d*ky,e,f);
  ctx.drawImage(source,0,0);
  return out.convertToBlob({type:'image/png'});
}
