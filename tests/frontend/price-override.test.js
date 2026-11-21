import test from 'node:test';
import assert from 'node:assert/strict';
import { parsePriceInput, minorToInput, overridePatchValue } from '../../apps/web/src/price-override.js';

test('parses UAH strings to exact kopecks', () => {
  for (const [input, minor] of [['1299', 129900], ['1299.5', 129950], ['1 299,50', 129950], ['0.29', 29], ['1.15', 115], ['19.99', 1999], ['0,01', 1], ['1000000', 100000000], ['  42.00 ', 4200], ['007', 700]]) {
    assert.deepEqual(parsePriceInput(input), { ok: true, minor }, input);
  }
});
test('empty input means reset (null), never 0', () => {
  for (const v of ['', '   ', null, undefined]) assert.deepEqual(parsePriceInput(v), { ok: true, minor: null });
});
test('rejects invalid input with Ukrainian errors', () => {
  for (const v of ['0', '0.00', '-5', '-0.5', 'abc', '12a', '1.234', '1,999', '1000000.01', '1000001', '99999999999', '1.', '.5', '1e3', '1..2', '1.2.3', 'NaN', 'Infinity']) {
    const r = parsePriceInput(v);
    assert.equal(r.ok, false, v);
    assert.match(r.error, /[А-Яа-яІіЇїЄє]/);
  }
});
test('every accepted value is a safe positive integer within the limit', () => {
  for (let k = 1; k <= 20000; k += 7) {
    const r = parsePriceInput(`${Math.floor(k / 100)}.${String(k % 100).padStart(2, '0')}`);
    assert.equal(r.minor, k);
  }
});
test('minorToInput round-trips', () => {
  assert.equal(minorToInput(129900), '1299');
  assert.equal(minorToInput(129950), '1299.50');
  assert.equal(minorToInput(5), '0.05');
  for (const bad of [null, undefined, 0, -1, 1.5, NaN]) assert.equal(minorToInput(bad), '');
  for (const k of [1, 5, 99, 100, 129950, 100000000]) assert.equal(parsePriceInput(minorToInput(k)).minor, k);
});
test('patch value only when changed', () => {
  assert.equal(overridePatchValue(undefined, null), undefined);
  assert.equal(overridePatchValue(null, null), undefined);
  assert.equal(overridePatchValue(129900, 129900), undefined);
  assert.equal(overridePatchValue(129900, 150000), 150000);
  assert.equal(overridePatchValue(129900, null), null);
  assert.equal(overridePatchValue(undefined, 150000), 150000);
});
