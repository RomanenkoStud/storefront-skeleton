import assert from 'node:assert/strict';
import { EMPTY_FILTERS, filterProducts } from '../../apps/web/src/catalog-filters.js';

const p = (id, stock, updatedAt, priceMinor = 1000, variants) => ({ id, title: id, description: '', priceMinor, updatedAt, variants: variants || [{ size: 'M', stock }] });
const ids = (list, sort = 'new', extra = {}) => filterProducts(list, { ...EMPTY_FILTERS, sort, ...extra }).map(x => x.id);

const mixed = [
  p('sold-new', 0, '2026-03-01T00:00:00Z'),
  p('in-old', 2, '2026-01-01T00:00:00Z'),
  p('sold-old', 0, '2026-02-01T00:00:00Z'),
  p('in-new', 1, '2026-02-15T00:00:00Z'),
];
assert.deepEqual(ids(mixed), ['in-new', 'in-old', 'sold-new', 'sold-old']);

// Input is not mutated and ordering is pure.
const copy = mixed.map(x => x.id);
ids(mixed);
assert.deepEqual(mixed.map(x => x.id), copy);

// Sold-out rule matches the card: no variant with stock > 0 (missing/empty variants, negative or non-numeric stock).
const odd = [
  { id: 'novariants', title: 'a', description: '', priceMinor: 1, updatedAt: '2026-05-01T00:00:00Z' },
  { id: 'empty', title: 'b', description: '', priceMinor: 1, updatedAt: '2026-05-02T00:00:00Z', variants: [] },
  p('neg', -1, '2026-05-03T00:00:00Z'),
  p('multi', 0, '2026-01-01T00:00:00Z', 1000, [{ size: 'S', stock: 0 }, { size: 'L', stock: 3 }]),
];
assert.deepEqual(ids(odd), ['multi', 'neg', 'empty', 'novariants']);

// Ties keep input order (stable); missing/invalid updatedAt sorts last within its group.
const ties = [p('a', 1, '2026-01-01T00:00:00Z'), p('b', 1, '2026-01-01T00:00:00Z'), p('c', 0, '2026-01-01T00:00:00Z'), p('d', 0, '2026-01-01T00:00:00Z')];
assert.deepEqual(ids(ties), ['a', 'b', 'c', 'd']);
const missing = [p('s-none', 0, undefined), p('i-none', 1, 'garbage'), p('s-dated', 0, '2026-01-01T00:00:00Z'), p('i-dated', 1, '2026-01-01T00:00:00Z')];
assert.deepEqual(ids(missing), ['i-dated', 'i-none', 's-dated', 's-none']);

// Other sorts are unchanged: sold-out items are not moved.
const others = [p('x', 0, '2026-03-01T00:00:00Z', 300), p('y', 1, '2026-01-01T00:00:00Z', 100), p('z', 0, '2026-02-01T00:00:00Z', 200)];
assert.deepEqual(ids(others, 'price-asc'), ['y', 'z', 'x']);
assert.deepEqual(ids(others, 'price-desc'), ['x', 'z', 'y']);
assert.deepEqual(ids(others, 'title'), ['x', 'y', 'z']);

// The available filter still hides sold-out items; the order of the rest follows the new rule.
assert.deepEqual(ids(mixed, 'new', { available: true }), ['in-new', 'in-old']);
console.log('sold-out-order tests passed');
