// Model preprocessing follows the publisher's preprocessor_config.json.
// Inference and PNG compositing are local; model downloads contain no image data.
const modelUrl='https://huggingface.co/imgly/isnet-general-onnx/resolve/440dea96dd4a3b06bbbf5abec3e26569dd7ec49f/onnx/model_fp16.onnx';
const runtimeRoot='https://cdn.jsdelivr.net/npm/onnxruntime-web@1.21.0/dist/';
const report=(key,current=0,total=1)=>self.postMessage({type:'progress',key,current,total});
async function resource(url,key,expectedSize=0) {
  let cache;try{cache=await caches.open('catalog-isnet-440dea96-ort-1.21.0');const hit=await cache.match(url);if(hit){report(key,1,1);return hit;}}catch{/* caching may be disabled */}
  const response=await fetch(url,{credentials:'omit'});if(!response.ok)throw new Error('Не вдалося завантажити модель. Перевірте з’єднання та спробуйте ще раз.');
  const total=expectedSize,reader=response.body.getReader(),chunks=[];let current=0,last=0;
  while(true){const {done,value}=await reader.read();if(done)break;chunks.push(value);current+=value.length;if(performance.now()-last>100){report(key,current,total);last=performance.now();}}
  if(expectedSize&&current!==expectedSize)throw new Error('Завантажений файл моделі або середовища неповний. Спробуйте ще раз.');
  report(key,current,current);
  const complete=new Response(new Blob(chunks),{headers:{'Content-Type':response.headers.get('Content-Type')||'application/octet-stream'}});
  if(cache)try{await cache.put(url,complete.clone());}catch{/* quota/private mode */}
  return complete;
}
let kept=null;// {device,ort,session} reused when the caller asks to keep the model loaded
self.onmessage=async ({data:{blob,device,keep}})=>{
  let session,bitmap,ort;
  try{
    if(kept&&kept.device===device){({ort,session}=kept);}else{
    ort=device==='gpu'?await import('onnxruntime-web/webgpu'):await import('onnxruntime-web/wasm');
    ort.env.wasm.numThreads=1;ort.env.wasm.proxy=false;
    const base=device==='gpu'?'ort-wasm-simd-threaded.jsep':'ort-wasm-simd-threaded';
    const wasm=await resource(runtimeRoot+base+'.wasm','fetch:runtime',device==='gpu'?23914392:12666427);
    const mjs=await resource(runtimeRoot+base+'.mjs','fetch:runtime-script');
    ort.env.wasm.wasmPaths={wasm:URL.createObjectURL(await wasm.blob()),mjs:URL.createObjectURL(new Blob([await mjs.text()],{type:'text/javascript'}))};
    const model=await resource(modelUrl,'fetch:model',88152708);report('compute:initialize');
    session=await ort.InferenceSession.create(await model.arrayBuffer(),{executionProviders:[device==='gpu'?'webgpu':'wasm'],graphOptimizationLevel:'all'});
    if(keep)kept={device,ort,session};}
    bitmap=await createImageBitmap(blob);const {width,height}=bitmap;
    // Resize only the segmentation input. The final canvas keeps original RGB and dimensions.
    const inputCanvas=new OffscreenCanvas(1024,1024),ctx=inputCanvas.getContext('2d',{willReadFrequently:true});
    ctx.drawImage(bitmap,0,0,1024,1024);const pixels=ctx.getImageData(0,0,1024,1024).data;
    const size=1024*1024,input=new Float32Array(size*3);
    for(let i=0;i<size;i++)for(let c=0;c<3;c++)input[c*size+i]=(pixels[i*4+c]-128)/256;
    report('compute:inference');
    const output=await session.run({[session.inputNames[0]]:new ort.Tensor('float32',input,[1,3,1024,1024])});
    const mask=output[session.outputNames[0]],values=mask.data,maskPixels=new Uint8ClampedArray(size*4);
    if(values.length!==size)throw new Error('Неочікуваний формат маски моделі.');
    for(let i=0;i<size;i++){const alpha=Math.max(0,Math.min(255,Math.round(values[i]*255)));maskPixels[i*4]=255;maskPixels[i*4+1]=255;maskPixels[i*4+2]=255;maskPixels[i*4+3]=alpha;}
    ctx.putImageData(new ImageData(maskPixels,1024,1024),0,0);
    report('compute:encode');
    const canvas=new OffscreenCanvas(width,height),out=canvas.getContext('2d');out.drawImage(bitmap,0,0);out.globalCompositeOperation='destination-in';out.imageSmoothingEnabled=true;out.imageSmoothingQuality='high';out.drawImage(inputCanvas,0,0,width,height);
    const result=await canvas.convertToBlob({type:'image/png'});self.postMessage({type:'result',blob:result});
    for(const tensor of Object.values(output))tensor.dispose();
  }catch(error){self.postMessage({type:'error',message:'Не вдалося обробити фото. Перевірте з’єднання, доступну пам’ять і підтримку браузера. '+(error?.message||'')});}
  finally{bitmap?.close();if(session&&!keep)await session.release();}
};
