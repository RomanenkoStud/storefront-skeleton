import test from 'node:test';
import assert from 'node:assert/strict';
import {transparentFraction,isDegenerateMask} from '../../apps/web/src/cutout-photo.js';

const px=(n,transparent)=>{const d=new Uint8ClampedArray(n*4);for(let i=0;i<n;i++)d[i*4+3]=i<transparent?0:255;return d;};
test('transparent fraction counts low-alpha pixels',()=>{assert.equal(transparentFraction(px(100,40)),0.4);assert.equal(transparentFraction(new Uint8ClampedArray(0)),1);});
test('fully transparent or fully opaque masks are degenerate',()=>{
  assert.equal(isDegenerateMask(px(1000,1000)),true);assert.equal(isDegenerateMask(px(1000,995)),true);
  assert.equal(isDegenerateMask(px(1000,0)),true);assert.equal(isDegenerateMask(px(1000,5)),true);
});
test('plausible masks pass',()=>{assert.equal(isDegenerateMask(px(1000,10)),false);assert.equal(isDegenerateMask(px(1000,500)),false);assert.equal(isDegenerateMask(px(1000,990)),false);});
