import assert from 'node:assert/strict';
import { withPosters, posterCategories, postersSuppressed, itemsLabel, POSTER_EVERY } from '../../apps/web/src/landing/posters.js';
import { EMPTY_FILTERS } from '../../apps/web/src/catalog-filters.js';
import { formatPrice } from '../../packages/catalog/price.js';
import { getCategory } from '../../packages/catalog/taxonomy.js';

const nbsp = '\u00a0';
const CATS = ['hoodies', 'sneakers', 'jeans', 'shorts', 'boots'];
const stock = [{ size: 'M', stock: 2 }];
// 5 categories x 6 in-stock products, plus one sold-out hoodie that must not be counted
const catalog = CATS.flatMap((c, ci) => Array.from({ length: 6 }, (_, i) => ({ id: `${c}-${i}`, categoryId: c, priceMinor: 100000 + ci * 10000 + i * 500, variants: stock })));
catalog.push({ id: 'unc', categoryId: 'unclassified', priceMinor: 5, variants: stock }, { id: 'unc2', categoryId: 'unclassified', priceMinor: 5, variants: stock }, { id: 'unc3', categoryId: 'unclassified', priceMinor: 5, variants: stock });
catalog.push({ id: 'zero', categoryId: 'hoodies', priceMinor: 0, variants: stock }, { id: 'nul', categoryId: 'hoodies', priceMinor: null, variants: stock });
catalog.push({ id: 'sold', categoryId: 'hoodies', priceMinor: 1, variants: [{ size: 'M', stock: 0 }] });
const ctx = (extra = {}) => ({ products: catalog, filters: { ...EMPTY_FILTERS }, getCategory, cutouts: Object.fromEntries(['hoodies', 'sneakers', 'jeans', 'shorts'].map(c => [c, { src: `/rail/${c}.webp`, w: 1, h: 1 }])), ...extra });
const products = n => Array.from({ length: n }, (_, i) => ({ id: `p${i}`, categoryId: 'hoodies', variants: stock }));
const slotsOfTiles = list => list.flatMap((x, i) => x.poster ? [i + 1] : []);

// cadence: one tile after every 11 products, so slots 12, 24, 36
assert.equal(POSTER_EVERY, 11);
const mixed = withPosters(products(24), ctx());
assert.deepEqual(slotsOfTiles(mixed), [12, 24]);
assert.equal(mixed.filter(x => !x.poster).length, 24, 'products are untouched and uncounted as tiles');
assert.deepEqual(mixed.filter(x => !x.poster).map(x => x.id), products(24).map(x => x.id), 'product order preserved');
// 12 slots fill whole rows at 2, 3 and 4 columns
for (const cols of [2, 3, 4, 6]) assert.equal(12 % cols, 0);
assert.deepEqual(slotsOfTiles(withPosters(products(48), ctx())), [12, 24, 36, 48], 'slots 12,24,36,48');

// loading more does not move earlier tiles or change their category
const p24 = withPosters(products(24), ctx()).filter(x => x.poster).map(x => x.id);
const p48 = withPosters(products(48), ctx()).filter(x => x.poster).map(x => x.id);
assert.deepEqual(p48.slice(0, p24.length), p24);

// no category twice, even when there are more slots than categories
const many = withPosters(products(200), ctx()).filter(x => x.poster);
assert.equal(new Set(many.map(x => x.id)).size, many.length);
assert.equal(many.length, 4, 'stops when cut-out categories run out (boots has none)');
assert.ok(!many.some(x => x.id === 'boots'), 'no type-only tiles');
assert.equal(withPosters(products(40), ctx({ cutouts: {} })).some(x => x.poster), false, 'no cut-outs, no tiles');

// short lists and filters
assert.equal(withPosters(products(11), ctx()).length, 11);
assert.ok(!withPosters(products(11), ctx()).some(x => x.poster));

assert.deepEqual(slotsOfTiles(withPosters(products(13), ctx())), [12]);
assert.ok(!withPosters(products(12), ctx()).at(-1).poster, 'a tile never ends the list');
assert.equal(withPosters(products(12), ctx()).length, 13, 'exactly 12 products: one tile at slot 12, then the last product');
for (const f of [{ q: 'x' }, { category: 'hoodies' }, { brands: ['Lorem'] }, { sizes: ['M'] }, { min: '10' }, { max: '500' }, { min: '0' }, { available: true }]) {
  assert.ok(postersSuppressed({ ...EMPTY_FILTERS, ...f }), JSON.stringify(f));
  assert.equal(withPosters(products(30), ctx({ filters: { ...EMPTY_FILTERS, ...f } })).length, 30);
}
assert.ok(!postersSuppressed({ ...EMPTY_FILTERS, sort: 'price-asc', shown: 48 }), 'sort and paging do not hide tiles');
assert.deepEqual(withPosters(null, ctx()), []);

// content from data
const cats = posterCategories(catalog, ctx());
assert.equal(cats[0].id, 'hoodies', 'largest cut-out category first');
assert.ok(cats.every(c => c.cutout), 'only categories with a cut-out');
assert.equal(cats[0].count, 8, 'sold-out items are not counted; zero/null-priced ones are counted but never set the price');
assert.ok(!cats.some(c => c.id === 'unclassified'), 'no tile for unclassified');
assert.equal(cats[0].fromMinor, 100000);
assert.equal(cats[0].price, `1${nbsp}000${nbsp}грн`);
for (const c of cats) { const min = Math.min(...catalog.filter(p => p.categoryId === c.id && p.variants.some(v => v.stock > 0) && p.priceMinor > 0).map(p => p.priceMinor)); assert.equal(c.price, formatPrice(min)); }
assert.equal(posterCategories(catalog.filter(p => p.categoryId === 'jeans').map(p => ({ ...p, priceMinor: 0 })), ctx()).length, 0, 'no valid price, no tile');
assert.equal(cats[0].label, 'Худі');
assert.equal(cats[0].kicker, 'Худі й світшоти');
assert.equal(posterCategories([{ categoryId: 'hoodies', priceMinor: 1, variants: stock }], ctx()).length, 0, 'too few items for a tile');
assert.equal(posterCategories([{ categoryId: 'nope', priceMinor: 1, variants: stock }], ctx()).length, 0, 'unknown category ignored');
assert.deepEqual(mixed.filter(x => x.poster).map(x => x.tone), ['lime', 'moss'], 'tones alternate');

assert.equal(itemsLabel(1, true), '1 пара'); assert.equal(itemsLabel(3, true), '3 пари'); assert.equal(itemsLabel(26, true), '26 пар'); assert.equal(cats.find(c => c.id === 'sneakers').pairs, true); assert.equal(cats[0].pairs, false);
assert.equal(itemsLabel(1), '1 річ'); assert.equal(itemsLabel(2), '2 речі'); assert.equal(itemsLabel(5), '5 речей');
assert.equal(itemsLabel(11), '11 речей'); assert.equal(itemsLabel(18), '18 речей'); assert.equal(itemsLabel(21), '21 річ'); assert.equal(itemsLabel(22), '22 речі'); assert.equal(itemsLabel(112), '112 речей');
console.log('posters tests passed');
