// Fitter seam (docs/MEDIA.md "Picture normalization (fit)"). T5 ships the mask-only path; the neural model path is T8.
// This module also holds the pure UI logic of the fit flow so it can be unit-tested in Node.
import {analyzeMask,computeFit} from '../../../packages/catalog/picture-fit.js';
import {PICTURE_TEMPLATES} from '../../../packages/catalog/picture-templates.js';

const abortError=()=>new DOMException('Скасовано','AbortError');
const tick=()=>new Promise(resolve=>setTimeout(resolve,0));

export async function proposeFit({cutout,alpha,template,signal,onProgress=()=>{}}){
  if(signal?.aborted)throw abortError();
  onProgress({key:'analyze'});
  await tick(); // let the UI paint the progress label before the synchronous analysis
  if(signal?.aborted)throw abortError();
  const analysis=analyzeMask(alpha);
  if(signal?.aborted)throw abortError();
  return {
    result:computeFit(analysis,template,null),
    fitter:'mask',
    // The neural model arrives with T8; until then the model is simply unavailable.
    fallbackReason:'unsupported',
    refit:manual=>computeFit(analysis,template,manual),
  };
}

// Manual bounds mirror MANUAL_LIMITS in packages/catalog/picture-fit.js (not exported there).
export const MANUAL_LIMITS=Object.freeze({rotate:45,scaleMin:0.5,scaleMax:2,offset:0.25});
export const NEUTRAL_MANUAL=Object.freeze({rotateDeg:0,scale:1,offsetX:0,offsetY:0});
export const NUDGES=Object.freeze([
  {key:'rotateDeg',label:'Поворот',step:0.5,unit:'°',decrease:'Повернути проти годинникової стрілки',increase:'Повернути за годинниковою стрілкою'},
  {key:'scale',label:'Масштаб',step:0.02,unit:'%',decrease:'Зменшити',increase:'Збільшити'},
  {key:'offsetX',label:'Зсув по горизонталі',step:0.01,unit:'%',decrease:'Лівіше',increase:'Правіше'},
  {key:'offsetY',label:'Зсув по вертикалі',step:0.01,unit:'%',decrease:'Вище',increase:'Нижче'},
]);
const r4=n=>Math.round(n*10000)/10000,clamp=(n,lo,hi)=>Math.min(hi,Math.max(lo,n));
export function clampManual(m){
  const x={...NEUTRAL_MANUAL,...m},L=MANUAL_LIMITS;
  return {rotateDeg:r4(clamp(x.rotateDeg,-L.rotate,L.rotate)),scale:r4(clamp(x.scale,L.scaleMin,L.scaleMax)),offsetX:r4(clamp(x.offsetX,-L.offset,L.offset)),offsetY:r4(clamp(x.offsetY,-L.offset,L.offset))};
}
export function applyNudge(manual,key,direction){
  const nudge=NUDGES.find(n=>n.key===key);if(!nudge)throw new TypeError('Невідомий параметр');
  const base={...NEUTRAL_MANUAL,...manual};
  return clampManual({...base,[key]:base[key]+Math.sign(direction)*nudge.step});
}
export function formatManual(manual,key){
  const v={...NEUTRAL_MANUAL,...manual}[key];
  if(key==='rotateDeg')return `${v>0?'+':''}${v.toFixed(1)}°`;
  const pct=key==='scale'?(v-1)*100:v*100;
  return `${pct>0?'+':''}${pct.toFixed(0)}%`;
}

const MEDIA=/^\/media\/[^/?#]+$/;
export function fitSource(src,lineage){
  const entry=lineage&&Object.hasOwn(lineage,src)?lineage[src]:null;
  if(!entry||typeof entry.originalUrl!=='string')return null;
  if(entry.cutoutUrl===undefined)return MEDIA.test(src)?{sourceUrl:src,refit:false}:null;
  if(typeof entry.cutoutUrl!=='string'||!MEDIA.test(entry.cutoutUrl)||entry.cutoutUrl===src)return null;
  return {sourceUrl:entry.cutoutUrl,refit:true};
}
export const SAVE_FIRST_HINT='Спочатку збережіть зміни товару';
export function fitAction({src,lineage,dirty,busy=false,storage=true}){
  const source=fitSource(src,lineage);
  if(!source)return {visible:false};
  return {visible:true,label:source.refit?'Перевирівняти':'Вирівняти за шаблоном',sourceUrl:source.sourceUrl,refit:source.refit,disabled:!!(dirty||busy||storage!==true),hint:dirty?SAVE_FIRST_HINT:null};
}
export function restoreTargets(src,lineage,originals){
  const entry=lineage&&Object.hasOwn(lineage,src)?lineage[src]:null;
  const original=(typeof entry?.originalUrl==='string'?entry.originalUrl:null)??(originals&&Object.hasOwn(originals,src)?originals[src]:null)??null;
  const cutout=typeof entry?.cutoutUrl==='string'&&MEDIA.test(entry.cutoutUrl)?entry.cutoutUrl:null;
  return {original,cutout};
}
export function lineageAfterSave(lineage,saved,fit){
  return {...lineage,[saved.url]:{originalUrl:saved.originalUrl,cutoutUrl:saved.cutoutUrl,templateId:fit.templateId,templateRevision:fit.templateRevision}};
}
export function templateStatus(entry){
  const t=entry&&typeof entry.templateId==='string'&&Object.hasOwn(PICTURE_TEMPLATES,entry.templateId)?PICTURE_TEMPLATES[entry.templateId]:null;
  return t&&Number.isInteger(entry.templateRevision)&&entry.templateRevision<t.revision?{stale:true,label:'Шаблон оновлено'}:{stale:false};
}
export function hintForTemplate(categoryId){
  return !categoryId||categoryId==='unclassified'?'Категорію не визначено, тому застосовано загальний шаблон. Оберіть категорію товару й збережіть зміни, щоб отримати відповідний шаблон.':null;
}
const FLAGS={
  'empty-mask':'На фото майже немає предмета: вирівнювання неможливе.',
  'multiple-objects':'На фото кілька окремих об’єктів. Перевірте, чи це один товар.',
  fragmented:'Частину маски відкинуто як дрібні фрагменти. Перевірте краї.',
  'edge-clipped':'Предмет торкається краю фото і може бути обрізаний.',
  'rotation-ambiguous':'Напрям предмета незрозумілий, автоповорот не застосовано.',
  'rotation-over-limit':'Потрібний поворот перевищує ліміт шаблону, автоповорот не застосовано. Можливо, обрано не ту категорію.',
  'aspect-mismatch':'Пропорції предмета дуже відрізняються від області шаблону.',
  upscaled:'Фото мале: збільшення обмежено, предмет менший за область шаблону.',
  'soft-mask':'Багато напівпрозорих пікселів на краях. Перевірте вирізання.',
};
export const flagMessage=flag=>(Object.hasOwn(FLAGS,flag)?FLAGS[flag]:`Позначка перевірки: ${flag}.`);
const ERROR_CODES={
  'source-changed':'Вирізане фото змінилося після перегляду. Закрийте перегляд і почніть вирівнювання заново.',
  'template-updated':'Шаблон оновлено. Вирівняйте фото ще раз.',
  'source-not-allowed':'Це фото не можна вирівняти: його немає серед збережених фото товару. Збережіть зміни товару й спробуйте ще раз.',
  'source-not-cutout':'Вирівнювати можна лише вирізане фото. Спершу видаліть фон і збережіть товар.',
  'invalid-recipe':'Сервер відхилив рецепт вирівнювання. Імовірно, застосунок оновився: оновіть сторінку (Ctrl+R) і почніть вирівнювання заново.',
  'unknown-template':'Шаблон не знайдено. Оновіть сторінку й спробуйте ще раз.',
  'canvas-mismatch':'Розмір зображення не збігається з шаблоном. Почніть вирівнювання заново.',
  'metadata-too-large':'Дані вирівнювання завеликі для збереження. Спробуйте ще раз.',
  'invalid-png':'Зображення пошкоджене або не є коректним PNG. Спробуйте ще раз.',
  'too-large':'Зображення надто велике для збереження (максимум 20 МБ).',
  'not-png':'Сервер приймає лише PNG-зображення.',
  'storage-unavailable':'Для збереження вирівняних фото потрібно підключити сховище R2.',
};
const ERROR_STATUS={
  409:'Фото або шаблон змінилися після перегляду. Закрийте перегляд і почніть вирівнювання заново.',
  400:'Сервер відхилив вирівнювання: джерело, рецепт або розмір зображення некоректні. Збережіть зміни товару й спробуйте ще раз.',
  413:ERROR_CODES['too-large'],415:ERROR_CODES['not-png'],503:ERROR_CODES['storage-unavailable'],
};
// Maps by the server's stable `code` first, then by HTTP status. Never inspects the message text.
export function mapNormalizedError(error){
  const {code,status}=error||{};
  if(typeof code==='string'&&Object.hasOwn(ERROR_CODES,code))return ERROR_CODES[code];
  if(Object.hasOwn(ERROR_STATUS,status))return ERROR_STATUS[status];
  if(status)return `Не вдалося зберегти вирівняне фото (помилка ${status}). Спробуйте ще раз.`;
  return 'Не вдалося зберегти вирівняне фото. Перевірте з’єднання й спробуйте ще раз.';
}
const IMAGE_ERROR_CODES={'source-not-allowed':ERROR_CODES['source-not-allowed'],'storage-unavailable':ERROR_CODES['storage-unavailable']};
const IMAGE_ERROR_STATUS={
  400:'Це фото не можна вирівняти: його немає серед збережених фото товару. Збережіть зміни товару й спробуйте ще раз.',
  401:'Сесія завершилась. Оновіть сторінку й увійдіть знову.',403:'Недостатньо прав для цієї дії.',
  404:'Фото або товар не знайдено. Збережіть зміни товару й спробуйте ще раз.',
  503:ERROR_CODES['storage-unavailable'],
};
// GET …/image failures: map by code, then status; the English server text is never shown.
export function mapImageError(error){
  const {code,status}=error||{};
  if(typeof code==='string'&&Object.hasOwn(IMAGE_ERROR_CODES,code))return IMAGE_ERROR_CODES[code];
  if(Object.hasOwn(IMAGE_ERROR_STATUS,status))return IMAGE_ERROR_STATUS[status];
  if(status)return `Не вдалося отримати вирізане фото (помилка ${status}). Спробуйте ще раз.`;
  return 'Не вдалося отримати вирізане фото. Перевірте з’єднання й спробуйте ще раз.';
}
const NORMALIZED_HINT='Це вже вирівняне фото: щоб не втрачати якість, фон не видаляється повторно. Скористайтеся «Перевирівняти» або поверніть вирізане фото.';
// Background removal is offered on originals only; a normalized photo (lineage has a templateId) would be resampled twice.
export function cutoutAction({src,lineage,busy=false,storage=true}){
  const normalized=!!(lineage&&Object.hasOwn(lineage,src)&&lineage[src]?.templateId);
  return {disabled:!!(busy||storage!==true||normalized),hint:normalized?NORMALIZED_HINT:null};
}
export function createJobGate(onBusy){
  let busy=false;
  return {
    get busy(){return busy;},
    acquire(){if(busy)return false;busy=true;onBusy(true);return true;},
    release(){if(!busy)return;busy=false;onBusy(false);},
  };
}
