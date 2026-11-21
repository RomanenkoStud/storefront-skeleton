import test from 'node:test';
import assert from 'node:assert/strict';
import {processImage} from '../../apps/web/src/background-removal.js';

test('browser processing retries GPU failure in a fresh WASM worker and reports progress',async t=>{
  const keys=['isSecureContext','Worker','OffscreenCanvas','createImageBitmap','navigator'];
  const descriptors=Object.fromEntries(keys.map(key=>[key,Object.getOwnPropertyDescriptor(globalThis,key)]));
  t.after(()=>{for(const key of keys){if(descriptors[key])Object.defineProperty(globalThis,key,descriptors[key]);else delete globalThis[key];}});
  const devices=[],workers=[],result=new Blob(['PNG']);let mode='fallback';
  class FakeWorker {
    constructor(){workers.push(this);this.terminated=false;}
    terminate(){this.terminated=true;}
    postMessage({device}){
      devices.push(device);if(mode==='pending')return;
      queueMicrotask(()=>{
        this.onmessage({data:{type:'progress',key:'compute:inference'}});
        this.onmessage({data:device==='gpu'?{type:'error',message:'GPU unavailable'}:{type:'result',blob:result}});
      });
    }
  }
  for(const [key,value] of Object.entries({isSecureContext:true,Worker:FakeWorker,OffscreenCanvas:class{},createImageBitmap:()=>{},navigator:{gpu:{}}}))Object.defineProperty(globalThis,key,{value,writable:true,configurable:true});
  const progress=[];
  assert.equal(await processImage(new Blob(),{onProgress:p=>progress.push(p)}),result);
  assert.deepEqual(devices,['gpu','cpu']);assert.ok(workers.every(w=>w.terminated));assert.ok(progress.some(p=>p.key==='fallback'));
  devices.length=0;globalThis.navigator={};
  assert.equal(await processImage(new Blob()),result);assert.deepEqual(devices,['cpu']);
  mode='pending';devices.length=0;globalThis.navigator={gpu:{}};
  const controller=new AbortController(),pending=processImage(new Blob(),{signal:controller.signal});controller.abort();
  await assert.rejects(pending,{name:'AbortError'});assert.deepEqual(devices,['gpu']);assert.ok(workers.at(-1).terminated);
  await assert.rejects(processImage(new Blob(),{signal:controller.signal}),{name:'AbortError'});
  globalThis.isSecureContext=false;await assert.rejects(processImage(new Blob()),/HTTPS/);
});
