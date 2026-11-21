import { fail, HttpError } from './domain.js';
import { auditStatement } from './permissions.js';
import { validateFitRecipe } from '../../../packages/catalog/picture-fit.js';
import { PICTURE_TEMPLATES } from '../../../packages/catalog/picture-templates.js';
import { storeMedia, trackStatement, sha256Hex, mediaKey } from './media.js';

export const IMAGE_LIMIT = 20_000_000;
const localImage = /^\/media\/([a-f0-9-]+\.(?:jpg|png|webp))$/;
export function imageType(bytes) {
  if (bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255) return ['jpg', 'image/jpeg'];
  if ([137,80,78,71,13,10,26,10].every((v,i)=>bytes[i]===v)) return ['png', 'image/png'];
  if (new TextDecoder().decode(bytes.slice(0,4)) === 'RIFF' && new TextDecoder().decode(bytes.slice(8,12)) === 'WEBP') return ['webp','image/webp'];
  fail('Only JPEG, PNG and WebP image content is accepted',415);
}
export async function boundedImage(response) {
  if (Number(response.headers.get('Content-Length')) > IMAGE_LIMIT) fail('Image exceeds 20 MB',413);
  const reader=response.body?.getReader(); if(!reader) fail('Empty image',502);
  const chunks=[];let size=0;
  try { while(true) { const {done,value}=await reader.read();if(done)break;size+=value.length;if(size>IMAGE_LIMIT){await reader.cancel();fail('Image exceeds 20 MB',413);}chunks.push(value); } }
  finally { reader.releaseLock(); }
  const bytes=new Uint8Array(size);let offset=0;for(const chunk of chunks){bytes.set(chunk,offset);offset+=chunk.length;}
  imageType(bytes);return bytes;
}
function photos(row) {
  const source=JSON.parse(row.source_json),overrides=JSON.parse(row.overrides_json);
  return [...new Set([...(source.photos||[]),...(overrides.photos||[])])];
}
export function requireProductImage(row,url) {
  if(typeof url!=='string'||!photos(row).includes(url))fail('Image does not belong to this product',400);
}
function effectivePhotos(row) {
  return JSON.parse(row.overrides_json).photos??JSON.parse(row.source_json).photos??[];
}
// Lineage-aware source rule (docs/MEDIA.md "Picture normalization (fit)"): a URL is acceptable when it is one of the product's photos,
// or the cutoutUrl of a saved /media PNG of this product, so re-fit still works after the normalized photo replaced the cutout.
export async function requireProductImageOrLineage(row,url,env) {
  if(typeof url!=='string')fail('Image does not belong to this product',400);
  if(photos(row).includes(url))return;
  if(env?.MEDIA){
    for(const photo of new Set(effectivePhotos(row))){
      const key=/^\/media\/([a-f0-9-]+\.png)$/.exec(photo)?.[1];if(!key)continue;
      const meta=(await env.MEDIA.head(key))?.customMetadata;
      if(meta?.productId===row.id&&meta.cutoutUrl===url)return;
    }
  }
  fail('Image does not belong to this product',400);
}
const easyDropImage=/^\/media\/uploads\/images\/(?:base|itemimage|item_[0-9]+)\/[A-Za-z0-9._-]+\.(?:jpe?g|png|webp)$/;
/** Shared EasyDrop media rule: the value must already be canonical (no dot segments or percent-encoding the URL parser would resolve). */
export function isEasyDropImageUrl(value) {
  if(typeof value!=='string')return false;
  let url;try{url=new URL(value);}catch{return false;}
  return url.protocol==='https:'&&!url.port&&!url.username&&!url.password&&!url.search&&!url.hash&&url.hostname==='easydrop.one'&&url.href===value&&!/[?#]/.test(value)&&!value.includes('%')&&!value.includes('\\')&&!value.includes('..')&&easyDropImage.test(url.pathname);
}
export function supplierImageUrl(value) {
  let url;try{url=new URL(value);}catch{fail('Unsupported supplier image URL',400);}
  if(url.protocol!=='https:'||url.port||url.username||url.password||url.search||url.hash)fail('Only MyDrop and EasyDrop product images can be retrieved',400);
  if(url.hostname==='backend.mydrop.com.ua'&&/^\/vendor\/products\/uploads\/[a-zA-Z0-9._-]+$/.test(url.pathname))return url.href;
  if(isEasyDropImageUrl(value))return url.href;
  fail('Only MyDrop and EasyDrop product images can be retrieved',400);
}
export async function retrieveProductImage(row,url,env) {
  await requireProductImageOrLineage(row,url,env);
  const key=localImage.exec(url)?.[1];
  if(key){const object=await env.MEDIA?.get(key);if(!object)fail('Original image is unavailable',404);return boundedImage(new Response(object.body));}
  const safeUrl=supplierImageUrl(url);
  let response;try{response=await fetch(safeUrl,{redirect:'manual',signal:AbortSignal.timeout(20000),headers:{Accept:'image/jpeg,image/png,image/webp'}});}catch{fail('Supplier image could not be retrieved. Try again later.',502);}
  if(!response.ok)fail('Supplier refused the image request. Try again later.',502);
  return boundedImage(response);
}
export async function imageLineage(row,env) {
  const originals={},lineage={};if(!env.MEDIA)return {originals,lineage};
  for(const url of new Set(effectivePhotos(row))){
    const key=localImage.exec(url)?.[1];if(!key)continue;
    const meta=(await env.MEDIA.head(key))?.customMetadata;
    if(meta?.productId!==row.id||!localImage.test(meta.originalUrl||''))continue;
    originals[url]=meta.originalUrl;
    const entry={originalUrl:meta.originalUrl};
    if(localImage.test(meta.cutoutUrl||''))entry.cutoutUrl=meta.cutoutUrl;
    if(meta.templateId)entry.templateId=meta.templateId;
    if(Number.isInteger(Number(meta.templateRevision))&&meta.templateRevision)entry.templateRevision=Number(meta.templateRevision);
    lineage[url]=entry;
  }
  return {originals,lineage};
}
export async function originalImages(row,env) {
  return (await imageLineage(row,env)).originals;
}
export async function saveCutout(request,row,env,readBounded) {
  if(!env.MEDIA)fail('Photo storage is not configured',503);
  if(!request.headers.get('Content-Type')?.startsWith('multipart/form-data'))fail('Multipart image upload required',415);
  const bytes=await readBounded(request,IMAGE_LIMIT+500000);
  let form;try{form=await new Response(bytes,{headers:{'Content-Type':request.headers.get('Content-Type')}}).formData();}catch{fail('Invalid image upload');}
  const sourceUrl=form.get('sourceUrl');requireProductImage(row,sourceUrl);
  const file=form.get('file');if(!file||typeof file.arrayBuffer!=='function'||!file.size||file.size>IMAGE_LIMIT)fail('Supply a PNG cutout up to 20 MB',413);
  const cutout=new Uint8Array(await file.arrayBuffer());if(imageType(cutout)[0]!=='png')fail('Cutout must be PNG',415);
  // Retrieve originals ourselves; never replace source snapshots or trust an uploaded "original".
  const original=await retrieveProductImage(row,sourceUrl,env),[ext,type]=imageType(original);
  const digest=await sha256Hex(original);
  if(form.get('originalHash')!==digest)fail('Original image changed. Cancel and process the image again.',409);
  // An own /media source is already stored and immutable: it is the original. Only supplier photos are archived, once per content.
  const originalKey=mediaKey(sourceUrl)??(await storeMedia(env,original,{ext,contentType:type,kind:'original'})).key;
  const originalUrl=`/media/${originalKey}`;
  const {key}=await storeMedia(env,cutout,{ext:'png',contentType:'image/png',kind:'cutout',productId:row.id,originalKey,customMetadata:{productId:row.id,originalUrl,sourceUrl}});
  const url=`/media/${key}`;
  await auditStatement(env,'media.cutout',row.id,undefined,{url,originalUrl}).run();
  return {url,originalUrl};
}

const RECIPE_LIMIT=1024,METADATA_LIMIT=1800,PNG_HEADER=[137,80,78,71,13,10,26,10];
const failCode=(message,status,code)=>{throw Object.assign(new HttpError(status,message),{code});};
const utf8=value=>new TextEncoder().encode(value).length;
export async function saveNormalized(request,row,env,readBounded) {
  if(!env.MEDIA)failCode('Photo storage is not configured',503,'storage-unavailable');
  if(!request.headers.get('Content-Type')?.startsWith('multipart/form-data'))failCode('Multipart image upload required',415,'not-png');
  // readBounded is shared and throws a code-less 413; give this route's error a stable code.
  let bytes;try{bytes=await readBounded(request,IMAGE_LIMIT+500000);}catch(error){if(error instanceof HttpError&&error.status===413&&!error.code)error.code='too-large';throw error;}
  let form;try{form=await new Response(bytes,{headers:{'Content-Type':request.headers.get('Content-Type')}}).formData();}catch{failCode('Invalid image upload',400,'invalid-png');}
  const sourceUrl=form.get('sourceUrl');
  try{await requireProductImageOrLineage(row,sourceUrl,env);}catch(error){if(error instanceof HttpError&&!error.code)error.code='source-not-allowed';throw error;}
  // The source must be a genuine cutout of this product, never a normalized image (no cumulative resampling).
  const sourceKey=/^\/media\/([a-f0-9-]+\.png)$/.exec(sourceUrl)?.[1];
  const sourceObject=sourceKey&&await env.MEDIA.get(sourceKey),meta=sourceObject?.customMetadata;
  if(!meta||meta.productId!==row.id||!meta.originalUrl||!meta.sourceUrl||meta.cutoutUrl||meta.templateId)failCode('Source must be a saved cutout of this product',400,'source-not-cutout');
  const source=await boundedImage(new Response(sourceObject.body));
  const digest=Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',source)),b=>b.toString(16).padStart(2,'0')).join('');
  if(form.get('sourceHash')!==digest)failCode('Source image changed. Fit the picture again.',409,'source-changed');
  const file=form.get('file');
  if(!file||typeof file.arrayBuffer!=='function'||!file.size)failCode('Supply a PNG file',400,'invalid-png');
  if(file.size>IMAGE_LIMIT)failCode('Supply a PNG up to 20 MB',413,'too-large');
  const normalized=new Uint8Array(await file.arrayBuffer());
  if(!PNG_HEADER.every((v,i)=>normalized[i]===v))failCode('Normalized picture must be PNG',415,'not-png');
  const raw=form.get('recipe');
  if(typeof raw!=='string'||!raw||utf8(raw)>RECIPE_LIMIT)failCode('Invalid fit recipe',400,'invalid-recipe');
  let parsed;try{parsed=JSON.parse(raw);}catch{failCode('Invalid fit recipe',400,'invalid-recipe');}
  if(!parsed||typeof parsed!=='object'||Array.isArray(parsed))failCode('Invalid fit recipe',400,'invalid-recipe');
  const template=typeof parsed.templateId==='string'&&Object.hasOwn(PICTURE_TEMPLATES,parsed.templateId)?PICTURE_TEMPLATES[parsed.templateId]:null;
  if(!template)failCode('Unknown picture template',400,'unknown-template');
  if(parsed.templateRevision!==template.revision)failCode('Template updated. Fit the picture again.',409,'template-updated');
  if(parsed.canvas&&(parsed.canvas.width!==template.canvas.width||parsed.canvas.height!==template.canvas.height))failCode('Recipe canvas does not match the template',400,'canvas-mismatch');
  let recipe;try{recipe=validateFitRecipe(parsed,template);}catch{failCode('Invalid fit recipe',400,'invalid-recipe');}
  // IHDR: the first chunk must be a 13-byte IHDR whose size is the recipe canvas.
  const view=new DataView(normalized.buffer,normalized.byteOffset,normalized.byteLength);
  if(normalized.length<33||view.getUint32(8)!==13||String.fromCharCode(...normalized.slice(12,16))!=='IHDR')failCode('Invalid PNG header',400,'invalid-png');
  if(view.getUint32(16)!==recipe.canvas.width||view.getUint32(20)!==recipe.canvas.height)failCode('Picture size does not match the template canvas',400,'canvas-mismatch');
  // R2 limits custom metadata to 2 KB for keys and values together; never drop fields silently.
  const metadata={productId:row.id,originalUrl:meta.originalUrl,cutoutUrl:sourceUrl,templateId:recipe.templateId,templateRevision:String(recipe.templateRevision),fitVersion:String(recipe.fitVersion),recipe:JSON.stringify(recipe)};
  if(Object.entries(metadata).reduce((sum,[k,v])=>sum+utf8(k)+utf8(String(v)),0)>METADATA_LIMIT)failCode('Picture metadata is too large',400,'metadata-too-large');
  const key=`${crypto.randomUUID()}.png`,url=`/media/${key}`;
  await env.MEDIA.put(key,normalized,{httpMetadata:{contentType:'image/png'},customMetadata:metadata});
  await trackStatement(env,{key,size:normalized.byteLength,contentType:'image/png',sha256:await sha256Hex(normalized),kind:'normalized',productId:row.id,originalKey:mediaKey(meta.originalUrl),cutoutKey:sourceKey}).run();
  await auditStatement(env,'media.normalize',row.id,undefined,{url,cutoutUrl:sourceUrl,templateId:recipe.templateId,templateRevision:recipe.templateRevision,flags:recipe.quality.flags}).run();
  return {url,cutoutUrl:sourceUrl,originalUrl:meta.originalUrl};
}

// Manager-uploaded product photo. Same flat `<uuid>.<ext>` key and /media/ serving as every other upload.
// Only productId is recorded as metadata: no originalUrl/sourceUrl/cutoutUrl, so the lineage code never treats it as a cutout.
export async function saveProductPhoto(request,row,env,readBounded) {
  if(!env.MEDIA)failCode('Photo storage is not configured',503,'storage-unavailable');
  if(!request.headers.get('Content-Type')?.startsWith('multipart/form-data'))failCode('Multipart image upload required',415,'not-image');
  let bytes;try{bytes=await readBounded(request,IMAGE_LIMIT+500000);}catch(error){if(error instanceof HttpError&&error.status===413&&!error.code)error.code='too-large';throw error;}
  let form;try{form=await new Response(bytes,{headers:{'Content-Type':request.headers.get('Content-Type')}}).formData();}catch{failCode('Invalid image upload',400,'missing-file');}
  const file=form.get('file');
  if(!file||typeof file.arrayBuffer!=='function'||!file.size)failCode('Supply an image file',400,'missing-file');
  if(file.size>IMAGE_LIMIT)failCode('Supply an image up to 20 MB',413,'too-large');
  const data=new Uint8Array(await file.arrayBuffer());
  let ext,type;
  try{[ext,type]=imageType(data);}catch(error){if(error instanceof HttpError)failCode('Only JPEG, PNG and WebP image content is accepted',415,'not-image');throw error;}
  // Tracked and deduplicated like every other upload: identical bytes reuse the stored object.
  const {key}=await storeMedia(env,data,{ext,contentType:type,kind:'upload',productId:row.id,customMetadata:{productId:row.id}}),url=`/media/${key}`;
  await auditStatement(env,'media.upload',key,undefined,{productId:row.id}).run();
  return {url};
}
