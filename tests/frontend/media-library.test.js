import test from 'node:test';
import assert from 'node:assert/strict';
import { formatBytes, shortKey, filterItems, filterCounts, paginate, buildSelection, selectableKeys, chunkSelection, summarizeCleanup, cleanupMessage, skipReasonLabel, kindLabel, eligible } from '../../apps/web/src/media-library.js';

const items = [
  { key: 'a', tracked: true, size: 1000, orphan: true, recent: false, live: false, duplicateOf: null },
  { key: 'b', tracked: true, size: 2000, orphan: true, recent: true, live: false, duplicateOf: null },
  { key: 'c', tracked: true, size: 3000, orphan: false, live: true, duplicateOf: 'z', mergeable: true },
  { key: 'd', tracked: true, size: 4000, orphan: false, live: true, duplicateOf: 'z', mergeable: false, reason: 'cart' },
  { key: 'e', tracked: false, size: null, orphan: false, live: true, duplicateOf: null },
  { key: 'f', tracked: true, size: 500, orphan: true, recent: false, live: false, duplicateOf: 'z', mergeable: true },
];

test('formatBytes is human readable and safe', () => {
  assert.equal(formatBytes(512), '512 Б');
  assert.equal(formatBytes(1536), '1,5 КБ');
  assert.equal(formatBytes(5 * 1024 * 1024), '5,0 МБ');
  assert.equal(formatBytes(null), '—');
  assert.equal(formatBytes(undefined), '—');
});

test('shortKey keeps short keys and abbreviates long ones', () => {
  assert.equal(shortKey('abc'), 'abc');
  assert.ok(shortKey('x'.repeat(80)).length <= 28);
});

test('filters match the contract', () => {
  assert.deepEqual(filterItems(items, 'orphan').map(i => i.key), ['a', 'b', 'f']);
  assert.deepEqual(filterItems(items, 'duplicate').map(i => i.key), ['c', 'd', 'f']);
  assert.deepEqual(filterItems(items, 'untracked').map(i => i.key), ['e']);
  assert.equal(filterItems(items, 'live').length, 3);
  assert.equal(filterItems(items, 'all').length, 6);
  assert.equal(filterCounts(items).orphan, 3);
});

test('paginate clamps pages', () => {
  const many = Array.from({ length: 95 }, (_, i) => i);
  assert.equal(paginate(many, 0).items.length, 40);
  assert.equal(paginate(many, 2).items.length, 15);
  assert.equal(paginate(many, 9).page, 2);
  assert.equal(paginate([], 3).pageCount, 1);
});

test('eligibility excludes recent, untracked and unmergeable items', () => {
  assert.deepEqual(items.filter(eligible).map(i => i.key), ['a', 'c', 'f']);
  assert.deepEqual(selectableKeys(items, 'orphan'), ['a', 'f']);
  assert.deepEqual(selectableKeys(items, 'duplicate'), ['c', 'f']);
});

test('buildSelection sends each key once and ignores ineligible keys', () => {
  const s = buildSelection(items, ['a', 'b', 'c', 'd', 'e', 'f', 'nope']);
  assert.deepEqual(s.orphans, ['a', 'f']);
  assert.deepEqual(s.duplicates, ['c']);
  assert.equal(s.count, 3);
  assert.equal(s.bytes, 4500);
});

test('chunkSelection splits at 200 keys', () => {
  const orphans = Array.from({ length: 450 }, (_, i) => `o${i}`);
  const chunks = chunkSelection({ orphans, duplicates: ['d1'] });
  assert.equal(chunks.length, 3);
  assert.ok(chunks.every(c => c.orphans.length + c.duplicates.length <= 200));
  assert.equal(chunks.reduce((n, c) => n + c.orphans.length + c.duplicates.length, 0), 451);
  assert.deepEqual(chunkSelection({}), []);
});

test('summarizeCleanup merges chunks and groups skip reasons', () => {
  const s = summarizeCleanup([
    { deleted: ['a'], merged: [{ key: 'c', into: 'z', products: 1 }], skipped: [{ key: 'x', reason: 'referenced' }], freedBytes: 100 },
    { deleted: ['b'], merged: [], skipped: [{ key: 'y', reason: 'referenced' }, { key: 'w', reason: 'recent' }], freedBytes: 50 },
  ]);
  assert.equal(s.deleted, 2);
  assert.equal(s.merged, 1);
  assert.equal(s.freedBytes, 150);
  assert.equal(s.skipped, 3);
  assert.deepEqual(s.skippedGroups.find(g => g.reason === 'referenced').keys, ['x', 'y']);
  assert.match(cleanupMessage(s), /Видалено файлів: 2/);
  assert.match(cleanupMessage(s), /Пропущено: 3/);
});

test('labels cover contract codes with a fallback', () => {
  for (const r of ['referenced', 'recent', 'untracked', 'not-duplicate', 'immutable-reference', 'lineage-mismatch', 'supplier-source', 'changed', 'missing']) assert.match(skipReasonLabel(r), /[а-яі]/i);
  assert.match(skipReasonLabel('weird'), /weird/);
  assert.equal(kindLabel('cutout'), 'без фону');
  assert.equal(kindLabel('???'), 'невідомо');
});
