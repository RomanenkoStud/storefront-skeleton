import test from 'node:test';
import assert from 'node:assert/strict';
import { addTags, tagsInUse, matchesTagFilter, sortProducts, NO_TAGS, TAG_MAX_COUNT } from '../../apps/web/src/product-tags.js';

test('addTags splits on commas, trims, dedupes ignoring case and enforces limits', () => {
  assert.deepEqual(addTags(['Promoted'], ' promoted, needs   image update ,,'), { tags: ['Promoted', 'needs image update'], error: '' });
  assert.match(addTags([], 'x'.repeat(41)).error, /до 40/);
  assert.ok(addTags([], 'a\u200bb').error && addTags([], '!!!').error, 'invisible or symbol-only tags rejected');
  assert.deepEqual(addTags(['caf\u00e9'], 'cafe\u0301').tags, ['caf\u00e9'], 'NFC dedupe');
  const full = Array.from({ length: TAG_MAX_COUNT }, (_, i) => `t${i}`);
  assert.deepEqual(addTags(full, 'one more').tags, full);
  assert.match(addTags(full, 'one more').error, /20/);
});

test('tagsInUse lists one spelling per tag, sorted', () => {
  assert.deepEqual(tagsInUse([{ tags: ['Промо', 'b'] }, { tags: ['промо', 'A'] }, {}]), ['Промо', 'A', 'b'], 'Ukrainian collation: Cyrillic first');
});

test('tag filter matches case-insensitively and supports untagged', () => {
  assert.ok(matchesTagFilter({ tags: ['Needs image'] }, 'needs image'));
  assert.ok(!matchesTagFilter({ tags: ['x'] }, 'needs image'));
  assert.ok(matchesTagFilter({ tags: [] }, NO_TAGS) && matchesTagFilter({}, NO_TAGS));
  assert.ok(!matchesTagFilter({ tags: ['x'] }, NO_TAGS));
  assert.ok(matchesTagFilter({}, ''));
  assert.ok(!matchesTagFilter({ tags: [] }, '__none__') && NO_TAGS.includes('\u0000'), 'sentinel cannot be a real tag');
});

test('sort by tags groups by first tag (uk collation), untagged last, stable otherwise', () => {
  const items = [{ id: 1 }, { id: 2, tags: ['zeta'] }, { id: 3, tags: ['Beta', 'alpha'] }, { id: 4, tags: ['beta'] }, { id: 5 }];
  assert.deepEqual(sortProducts(items, 'tags').map(p => p.id), [3, 4, 2, 1, 5]);
  assert.equal(sortProducts(items, ''), items);
});
