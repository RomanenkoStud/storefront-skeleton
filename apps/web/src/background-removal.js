export function supportedBrowser() {
  return !!(globalThis.isSecureContext && globalThis.Worker && globalThis.WebAssembly && globalThis.OffscreenCanvas && globalThis.createImageBitmap);
}
// A batch processor keeps one worker (and its loaded model session) alive between photos.
export function createBatchProcessor(){
  const pool={workers:{},cpuOnly:false,closed:false};
  return {process:(blob,options={})=>processImage(blob,{...options,pool}),
    // Retry once on WebAssembly after a degenerate GPU result; null when already on CPU. Later photos stay on CPU.
    retryCpu:(blob,options={})=>{if(pool.cpuOnly||!globalThis.navigator?.gpu)return null;pool.cpuOnly=true;return processImage(blob,{...options,pool});},close(){pool.closed=true;for(const w of Object.values(pool.workers))w.terminate();pool.workers={};}};
}
export function processImage(blob,{onProgress=()=>{},signal,pool}={}) {
  if(!supportedBrowser())return Promise.reject(new Error('Потрібен сучасний Chrome, Edge або Firefox із WebAssembly та OffscreenCanvas через HTTPS (або localhost).'));
  async function run(device){
    if(signal?.aborted)throw new DOMException('Скасовано','AbortError');
    return new Promise((resolve,reject)=>{
      const worker=pool?.workers[device]||new Worker(new URL('./background-removal.worker.js',import.meta.url),{type:'module'});
      if(pool)pool.workers[device]=worker;
      let settled=false;
      const finish=(error,value)=>{if(settled)return;settled=true;clearTimeout(timer);signal?.removeEventListener('abort',abort);if(!pool||error||pool.closed){worker.terminate();if(pool&&pool.workers[device]===worker)delete pool.workers[device];}error?reject(error):resolve(value);};
      const abort=()=>finish(new DOMException('Скасовано','AbortError'));
      const timer=setTimeout(()=>finish(new Error('Обробка триває надто довго. Спробуйте ще раз у браузері з WebGPU або на потужнішому пристрої.')),180000);
      signal?.addEventListener('abort',abort,{once:true});
      worker.onerror=()=>finish(new Error('Не вдалося запустити обробку. Оновіть браузер і перевірте доступну пам’ять.'));
      worker.onmessage=({data})=>{
        if(settled)return;
        if(data.type==='progress')onProgress({...data,device});
        else if(data.type==='result')finish(null,data.blob);
        else if(data.type==='error')finish(new Error(data.message));
      };
      worker.postMessage({blob,device,keep:!!pool});
    });
  }
  return (async()=>{
    if(navigator.gpu&&!pool?.cpuOnly){try{return await run('gpu');}catch(error){if(error.name==='AbortError')throw error;if(pool)pool.cpuOnly=true;onProgress({key:'fallback',device:'cpu'});}}
    return run('cpu');
  })();
}
