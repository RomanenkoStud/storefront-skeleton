import test from 'node:test';
import assert from 'node:assert/strict';
import {runBatch,planBatch} from '../../apps/web/src/batch-cutout.js';

const products=()=>[
  {id:'a',title:'A',photos:['https://x/a1.jpg','https://x/a2.jpg']},
  {id:'b',title:'B',photos:['/media/cut.png','https://x/b2.jpg']},
  {id:'c',title:'C',photos:['ftp://bad']},
  {id:'d',title:'D',photos:[]},
  {id:'e',title:'E',photos:['https://x/e1.jpg']},
];
const lineage=async id=>({originals:id==='b'?{'/media/cut.png':'/media/orig.jpg'}:{}});

test('default mode takes the first photo only, skips cutouts, unretrievable and empty, and keeps order',async()=>{
  const calls=[],saved=[];
  const s=await runBatch({products:products(),loadLineage:lineage,
    cutout:async i=>{calls.push(`${i.productId}:${i.index}`);if(i.productId==='e')throw new Error('boom');return {url:`/media/${i.productId}${i.index}.png`};},
    persist:async(id,photos)=>{saved.push([id,photos]);}});
  assert.deepEqual(calls,['a:0','e:0']);
  assert.deepEqual(saved,[['a',['/media/a0.png','https://x/a2.jpg']]]);
  assert.equal(s.total,5);assert.equal(s.ok.length,1);assert.equal(s.failed.length,1);assert.equal(s.failed[0].reason,'boom');
  assert.deepEqual(s.skipped.map(x=>x.productId),['b','c','d']);assert.match(s.skipped[0].reason,/вже без фону/);
});

test('all-photos mode keeps positions and accumulates replacements per product',async()=>{
  const saved=[];
  const s=await runBatch({products:products().slice(0,2),allPhotos:true,loadLineage:lineage,cutout:async i=>({url:`/media/${i.productId}${i.index}.png`}),persist:async(id,p)=>{saved.push([id,p]);}});
  assert.deepEqual(saved,[['a',['/media/a0.png','https://x/a2.jpg']],['a',['/media/a0.png','/media/a1.png']],['b',['/media/cut.png','/media/b1.png']]]);
  assert.equal(s.skipped.length,1);assert.equal(s.ok.length,3);
});

test('cancel stops after the current item and reports the remainder',async()=>{
  let cancelled=false;const calls=[];
  const s=await runBatch({products:products(),loadLineage:lineage,isCancelled:()=>cancelled,
    cutout:async i=>{calls.push(i.productId);cancelled=true;return {url:'/media/n.png'};},persist:async()=>{}});
  assert.deepEqual(calls,['a']);assert.equal(s.cancelled,true);assert.equal(s.ok.length,1);assert.equal(s.remaining,4);
});

test('persist failure and lineage failure are failures that do not stop the batch',async()=>{
  const progress=[];
  const s=await runBatch({products:products().filter(p=>['a','e'].includes(p.id)),
    loadLineage:async id=>{if(id==='a')throw new Error('503');return {originals:{}};},
    cutout:async()=>({url:'/media/n.png'}),persist:async()=>{throw new Error('409');},onProgress:p=>progress.push(p)});
  assert.equal(s.failed.length,2);assert.match(s.failed[0].reason,/503/);assert.match(s.failed[1].reason,/409/);
  assert.equal(progress.at(-1).done,2);assert.equal(progress.at(-1).failed,2);
  assert.equal(planBatch([{id:'z',title:'Z',photos:['https://x/1']}],{z:{originals:{}}}).length,1);
});

test('degenerate cutout result is a failure, nothing is persisted, and the batch continues',async()=>{
  const saved=[];
  const s=await runBatch({products:products().filter(p=>p.id==='a'||p.id==='e'),loadLineage:lineage,
    cutout:async i=>{if(i.productId==='a')throw new Error('Не вдалося відокремити товар від фону (маска порожня або повна)');return {url:'/media/e.png'};},
    persist:async(id,p)=>{saved.push(id);}});
  assert.deepEqual(saved,['e']);assert.equal(s.failed.length,1);assert.match(s.failed[0].reason,/маска порожня або повна/);assert.equal(s.ok.length,1);
});

test('lost update: the current photo list is re-read and the source URL replaced in place',async()=>{
  const saved=[];
  const s=await runBatch({products:products().slice(0,1),loadLineage:lineage,
    loadProduct:async()=>({photos:['https://x/new.jpg','https://x/a1.jpg']}),
    cutout:async()=>({url:'/media/a.png'}),persist:async(id,p)=>{saved.push(p);}});
  assert.deepEqual(saved,[['https://x/new.jpg','/media/a.png']]);assert.equal(s.ok.length,1);
});

test('lost update: source photo gone during processing is skipped, not saved',async()=>{
  const saved=[];
  const s=await runBatch({products:products().slice(0,1),loadLineage:lineage,loadProduct:async()=>({photos:['https://x/other.jpg']}),
    cutout:async()=>({url:'/media/a.png'}),persist:async(id,p)=>{saved.push(p);}});
  assert.equal(saved.length,0);assert.equal(s.skipped.length,1);assert.equal(s.skipped[0].reason,'Фото змінилося під час обробки');assert.equal(s.ok.length,0);
});

test('cancel during lineage loading reports cancelled with remaining',async()=>{
  let n=0;
  const s=await runBatch({products:products().slice(0,2),loadLineage:async()=>{n++;return {originals:{}};},isCancelled:()=>n>=1,cutout:async()=>({url:'/m'}),persist:async()=>{}});
  assert.equal(s.cancelled,true);assert.equal(s.remaining,2);
});
