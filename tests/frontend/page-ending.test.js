import test from 'node:test';
import assert from 'node:assert/strict';
import { EMPTY_FILTERS, PAGE_SIZE, MAX_SHOWN, parseShown, changeFilters, readFilters, writeFilters, withPreserved } from '../../apps/web/src/catalog-filters.js';

test('shown defaults to the first page and is omitted from the URL at the default', () => {
  assert.equal(PAGE_SIZE, 24);
  assert.equal(readFilters('').shown, 24);
  assert.equal(writeFilters(EMPTY_FILTERS), '');
  assert.equal(writeFilters({ ...EMPTY_FILTERS, shown: 24 }), '');
});
test('shown roundtrips through the URL next to other filters', () => {
  const f = { ...EMPTY_FILTERS, q: 'худі', sort: 'title', shown: 72 };
  const query = writeFilters(f);
  assert.match(query, /(^|&)shown=72(&|$)/);
  assert.deepEqual(readFilters(`?${query}`), f);
});
test('invalid shown values are clamped to whole pages within bounds', () => {
  for (const [raw, expected] of [['abc', 24], ['', 24], ['-48', 24], ['0', 24], ['1.5', 24], ['10', 24], ['25', 48], ['48', 48], ['1e3', 24], [String(MAX_SHOWN * 10), MAX_SHOWN]]) {
    assert.equal(readFilters(`?shown=${raw}`).shown, expected, raw);
  }
  assert.equal(parseShown(null), 24);
  assert.equal(writeFilters({ ...EMPTY_FILTERS, shown: -5 }), '');
});
test('any filter, sort or search change resets to the first page; an explicit shown keeps its value', () => {
  const current = { ...EMPTY_FILTERS, shown: 96 };
  assert.equal(changeFilters(current, { q: 'lorem' }).shown, 24);
  assert.equal(changeFilters(current, { sort: 'price-asc' }).shown, 24);
  assert.equal(changeFilters(current, c => ({ ...c, brands: ['Lorem'] })).shown, 24);
  assert.equal(changeFilters(current, { ...EMPTY_FILTERS }).shown, 24);
  assert.equal(changeFilters(current, { shown: 120 }).shown, 120);
  assert.equal(changeFilters({ ...EMPTY_FILTERS }, { shown: 48 }).shown, 48);
  assert.equal(changeFilters(current, { shown: 'x' }).shown, 24);
});
test('an ?intro param is no longer carried over, shown still is', () => {
  const query = withPreserved(writeFilters({ ...EMPTY_FILTERS, shown: 48 }), '?intro=0&shown=48');
  assert.equal(new URLSearchParams(query).get('intro'), null);
  assert.equal(new URLSearchParams(query).get('shown'), '48');
});
