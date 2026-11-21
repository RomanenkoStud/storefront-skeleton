import assert from 'node:assert/strict';
import { cardCaption } from '../../apps/web/src/landing/card-caption.js';

const nbsp = ' ';
assert.equal(cardCaption({ priceMinor: 175000, variants: [{ size: 'M', stock: 2 }] }).priceLabel, `1${nbsp}750${nbsp}грн`);
assert.ok(!cardCaption({ priceMinor: 175000 }).priceLabel.includes(',00'));
assert.equal(cardCaption({ priceMinor: 175050 }).priceLabel, `1${nbsp}750,50${nbsp}грн`);
assert.equal(cardCaption({ priceMinor: 175000, variants: [{ size: 'M', stock: 2 }] }).soldOut, false);
assert.equal(cardCaption({ priceMinor: 1, variants: [{ size: 'M', stock: 0 }] }).soldOut, true);
assert.equal(cardCaption({ priceMinor: 1, variants: [] }).soldOut, true);
assert.equal(cardCaption({ priceMinor: 1, variants: [{ size: 'M', stock: 0 }] }, { preview: true }).soldOut, false);
console.log('card-caption tests passed');
