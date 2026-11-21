import test from 'node:test';
import assert from 'node:assert/strict';
import {renderFit,halvingSteps,HALVING_THRESHOLD} from '../../apps/web/src/picture-render.js';

function fakeCanvasImpl(){
  const canvases=[];
  class FakeCanvas{
    constructor(width,height){this.width=width;this.height=height;this.calls=[];this.id=canvases.length;canvases.push(this);
      const calls=this.calls,self=this;
      this.ctx={set imageSmoothingQuality(v){calls.push(['quality',v]);},set imageSmoothingEnabled(v){calls.push(['smoothing',v]);},
        setTransform(...m){calls.push(['setTransform',...m]);},drawImage(src,...rest){calls.push(['drawImage',src,...rest]);},
        fillRect(){calls.push(['fillRect']);},clearRect(){calls.push(['clearRect']);}};
      this.self=self;}
    getContext(type,options){this.calls.push(['getContext',type,options]);return this.ctx;}
    async convertToBlob(options){this.calls.push(['convertToBlob',options]);return {fake:'png',options,from:this.id};}
  }
  return {FakeCanvas,canvases};
}
const fit=(scale,over={})=>({fitVersion:1,templateId:'t',templateRevision:1,canvas:{width:1200,height:1600},transform:{},matrix:[scale,0,0,scale,100,200],...over});

test('render draws the cutout once with the fit matrix on a transparent canvas of the recipe size, PNG output',async()=>{
  const {FakeCanvas,canvases}=fakeCanvasImpl(),cutout={width:4000,height:3000};
  const blob=await renderFit(cutout,fit(0.6,{matrix:[0.6,0.01,-0.01,0.6,100.5,200.5]}),{OffscreenCanvasImpl:FakeCanvas});
  assert.equal(canvases.length,1);const [c]=canvases;
  assert.deepEqual([c.width,c.height],[1200,1600]);
  const names=c.calls.map(x=>x[0]);
  assert.deepEqual(names,['getContext','quality','setTransform','drawImage','convertToBlob']);
  assert.deepEqual(c.calls[1],['quality','high']);
  assert.deepEqual(c.calls[2],['setTransform',0.6,0.01,-0.01,0.6,100.5,200.5]);
  assert.equal(c.calls[3][1],cutout);assert.deepEqual(c.calls[3].slice(2),[0,0]);
  assert.deepEqual(c.calls[4][1],{type:'image/png'});
  assert.ok(!names.includes('fillRect'),'canvas stays transparent');
  assert.deepEqual(c.calls[0].slice(1,2),['2d']);assert.equal(blob.from,0);
});

test('halving pre-downsample starts below the 0.5 threshold and rescales the matrix',async()=>{
  assert.equal(HALVING_THRESHOLD,0.5);
  assert.equal(halvingSteps(0.5),0);assert.equal(halvingSteps(1),0);assert.equal(halvingSteps(0.4999),1);
  assert.equal(halvingSteps(0.25),1);assert.equal(halvingSteps(0.2),2);assert.equal(halvingSteps(0.01),6);
  const {FakeCanvas,canvases}=fakeCanvasImpl(),cutout={width:4000,height:3000};
  await renderFit(cutout,fit(0.2,{matrix:[0.2,0,0,0.2,10,20]}),{OffscreenCanvasImpl:FakeCanvas});
  const [first,second,out]=canvases;
  assert.deepEqual([first.width,first.height],[2000,1500]);assert.deepEqual([second.width,second.height],[1000,750]);
  assert.equal(first.calls.find(x=>x[0]==='drawImage')[1],cutout,'first step reads the cutout');
  assert.equal(second.calls.find(x=>x[0]==='drawImage')[1],first,'second step reads the first step');
  assert.deepEqual([out.width,out.height],[1200,1600]);
  const draw=out.calls.find(x=>x[0]==='drawImage');assert.equal(draw[1],second);
  assert.deepEqual(out.calls.find(x=>x[0]==='setTransform').slice(1),[0.8,0,0,0.8,10,20]);
  assert.deepEqual(first.calls.filter(x=>x[0]==='quality'),[['quality','high']]);
});

test('render has no mirroring (positive determinant) refusal and rejects bad input',async()=>{
  const {FakeCanvas}=fakeCanvasImpl();
  await assert.rejects(renderFit({width:10,height:10},fit(1,{matrix:[-1,0,0,1,0,0]}),{OffscreenCanvasImpl:FakeCanvas}),/Дзеркальне/);
  await assert.rejects(renderFit({width:10,height:10},fit(1,{canvas:{width:0,height:5}}),{OffscreenCanvasImpl:FakeCanvas}),/розмір canvas/);
  await assert.rejects(renderFit({width:10,height:10},fit(1,{matrix:[1,0,0,1,NaN,0]}),{OffscreenCanvasImpl:FakeCanvas}),/matrix/);
  await assert.rejects(renderFit(null,fit(1),{OffscreenCanvasImpl:FakeCanvas}),/cutout/);
});

test('render only ever receives the cutout: repeated renders with different recipes never reuse an output',async()=>{
  const {FakeCanvas,canvases}=fakeCanvasImpl(),cutout={width:800,height:600};
  const a=await renderFit(cutout,fit(1),{OffscreenCanvasImpl:FakeCanvas}),b=await renderFit(cutout,fit(0.9),{OffscreenCanvasImpl:FakeCanvas});
  for(const c of canvases)assert.equal(c.calls.find(x=>x[0]==='drawImage')[1],cutout);
  assert.notEqual(a.from,b.from);
});

test('odd dimensions: the rescaled matrix compensates each axis separately and keeps the drawn size exact',async()=>{
  const {FakeCanvas,canvases}=fakeCanvasImpl(),cutout={width:1001,height:333};
  await renderFit(cutout,fit(0.4,{matrix:[0.4,0,0,0.4,0,0]}),{OffscreenCanvasImpl:FakeCanvas});
  const [step,out]=canvases;
  assert.deepEqual([step.width,step.height],[501,167]);
  const [,a,b,c,d]=out.calls.find(x=>x[0]==='setTransform');
  // Source pixel (x,y) of the half-size bitmap must land where (kx*x, ky*y) of the cutout would.
  assert.ok(Math.abs(a-0.4*1001/501)<1e-12&&Math.abs(d-0.4*333/167)<1e-12);
  assert.ok(Math.abs(a*step.width-0.4*cutout.width)<1e-9&&Math.abs(d*step.height-0.4*cutout.height)<1e-9,'drawn extent equals the unhalved extent');
  assert.equal(b,0);assert.equal(c,0);
});
