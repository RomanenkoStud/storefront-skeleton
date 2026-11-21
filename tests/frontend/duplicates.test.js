import assert from 'node:assert/strict';
import { evidenceLabels, defaultSelection, selectionProblem, rejectProblem, confirmBody, rejectBody, matchesFilter, supplierOptions, stockText } from '../../apps/web/src/duplicates/duplicates-logic.js';

// Synthetic review data.
const products = {
  a: { id: 'a', supplierId: 's1', supplierName: 'Альфа', title: 'Fakeshoe Glide', sourceTitle: 'Fakeshoe Glide', brand: 'Fakeshoe', stock: 3, sizes: [{ size: '42', stock: 3 }, { size: '43', stock: 0 }] },
  b: { id: 'b', supplierId: 's2', supplierName: 'Бета', title: 'Glide white', sourceTitle: 'Glide white', brand: 'Fakeshoe', stock: 0, sizes: [{ size: '42', stock: 0 }] },
  c: { id: 'c', supplierId: 's2', supplierName: 'Бета', title: 'Glide black', sourceTitle: 'Glide black', brand: 'Fakeshoe', stock: 1, sizes: [] },
  g: { id: 'g', supplierId: 's3', supplierName: 'Гамма', title: 'Glide', sourceTitle: 'Glide', brand: null, stock: 1, sizes: [] }
};
const candidate = { key: 'a,b,c', groupId: null, groupProductIds: [], productIds: ['a', 'b', 'c'], confidence: 'high', pairs: [
  { a: 'a', b: 'b', reasons: [{ kind: 'title', score: 0.8 }, { kind: 'code', value: 'fs7001' }, { kind: 'brand', value: 'Fakeshoe' }] },
  { a: 'a', b: 'c', reasons: [{ kind: 'title', score: 0.9 }, { kind: 'photo' }, { kind: 'code', value: 'fs7001' }] }
] };

assert.deepEqual(evidenceLabels(candidate), ['Спільне фото', 'Код моделі FS7001', 'Схожа назва 90%', 'Бренд Fakeshoe']);
assert.deepEqual(defaultSelection(candidate, products), ['a', 'b'], 'one product per supplier by default');
assert.equal(selectionProblem(candidate, ['a', 'b'], products), '');
assert.match(selectionProblem(candidate, ['a', 'b', 'c'], products), /один товар від кожного постачальника/);
assert.match(selectionProblem(candidate, ['a'], products), /двох постачальників/);
assert.deepEqual(confirmBody(candidate, ['a', 'b']), { productIds: ['a', 'b'], rejectIds: ['c'] });
assert.deepEqual(rejectBody(candidate), { productIds: ['a', 'b', 'c'] });

const extension = { key: 'g:1:g', groupId: '1', groupProductIds: ['a', 'b'], productIds: ['g'], confidence: 'medium', pairs: [] };
assert.deepEqual(defaultSelection(extension, products), ['g']);
assert.equal(selectionProblem(extension, ['g'], products), '');
assert.deepEqual(confirmBody(extension, ['g']), { productIds: ['g'], groupId: '1' });
assert.deepEqual(rejectBody(extension), { productIds: ['a', 'b', 'g'] });
assert.deepEqual(defaultSelection({ ...extension, productIds: ['c'] }, products), [], 'supplier already represented in the group');

assert.ok(matchesFilter(candidate, products, { query: 'бета' }));
assert.ok(!matchesFilter(candidate, products, { confidence: 'medium' }));
assert.ok(!matchesFilter(candidate, products, { supplierId: 's3' }));
assert.ok(matchesFilter(extension, products, { supplierId: 's1' }), 'group members count for supplier filter');
assert.deepEqual(supplierOptions(products).map(([id]) => id), ['s1', 's2', 's3']);
assert.equal(stockText(products.a), '3 шт. · 42');
assert.equal(stockText(products.b), '0 шт. · немає розмірів у наявності');
// Large candidates: never truncate silently; explain the per-request limit.
const big = {}; for (let i = 0; i < 25; i++) big['p' + i] = { id: 'p' + i, supplierId: 's' + i, supplierName: 'S' + i, title: 'T', sourceTitle: 'T', stock: 0, sizes: [] };
const large = { key: 'large', groupId: null, groupProductIds: [], productIds: Object.keys(big), confidence: 'high', pairs: [] };
assert.match(rejectProblem(large), /Забагато товарів/);
assert.equal(rejectProblem(candidate), '');
assert.match(selectionProblem(large, defaultSelection(large, big), big), /щонайбільше 20 товарів/);
assert.match(selectionProblem(large, ['p0', 'p1'], big), /Зніміть позначку щонайбільше з 20/);
assert.equal(selectionProblem(large, Object.keys(big).slice(0, 10), big), '');
assert.equal(rejectBody(large).productIds.length, 25, 'no silent truncation');
console.log('duplicates frontend logic: ok');
