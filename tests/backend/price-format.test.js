import assert from 'node:assert/strict';
import { formatPrice } from '../../packages/catalog/price.js';

const N = ' ';
assert.equal(formatPrice(175000), `1${N}750${N}грн`);
assert.equal(formatPrice(99000), `990${N}грн`);
assert.equal(formatPrice(1234500), `12${N}345${N}грн`);
assert.equal(formatPrice(100000000), `1${N}000${N}000${N}грн`);
assert.equal(formatPrice(175050), `1${N}750,50${N}грн`);
assert.equal(formatPrice(5), `0,05${N}грн`);
assert.equal(formatPrice(0), `0${N}грн`);
for (const v of [null, undefined, NaN, 'abc']) assert.equal(formatPrice(v), `0${N}грн`);
assert.equal(formatPrice(99000.4), `990${N}грн`);
assert.equal(formatPrice(99000.6), `990,01${N}грн`);
assert.equal(formatPrice(-175000), `-1${N}750${N}грн`);
assert.ok(!formatPrice(175000).includes(' '), 'no plain spaces');
console.log('price-format ok');
