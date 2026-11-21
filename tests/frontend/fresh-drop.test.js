// pickFreshDrop (ADR-0014, lead default L-2), the products feed memo and the plural label.
import assert from 'node:assert/strict';
import { pickFreshDrop, isFreshEligible, thingsLabel } from '../../apps/web/src/landing/fresh-drop.js';
import { createProductsFeed } from '../../apps/web/src/products-feed.js';

const day = n => new Date(Date.UTC(2026, 10, n)).toISOString();
const item = (slug, categoryId, updatedAt, extra = {}) => ({ id: slug, slug, categoryId, updatedAt, priceMinor: 100000, photos: ['/p.webp'], variants: [{ size: 'M', stock: 1 }], ...extra });
const slugs = list => list.map(x => x.slug);

// Eligibility
assert.equal(isFreshEligible(item('a', 'x', day(1))), true);
assert.equal(isFreshEligible(item('a', 'x', day(1), { variants: [{ size: 'M', stock: 0 }] })), false, 'sold out');
assert.equal(isFreshEligible(item('a', 'x', day(1), { variants: [] })), false, 'no variants');
assert.equal(isFreshEligible(item('a', 'x', day(1), { photos: [] })), false, 'no photo');
assert.equal(isFreshEligible(item('a', 'x', day(1), { photos: undefined })), false);
assert.equal(isFreshEligible(item('a', 'x', day(1), { priceMinor: 0 })), false, 'zero price');
assert.equal(isFreshEligible(item('a', 'x', day(1), { priceMinor: -5 })), false);
assert.equal(isFreshEligible(item('a', 'x', day(1), { priceMinor: 10.5 })), false, 'not a safe integer');
assert.equal(isFreshEligible(item('a', 'x', day(1), { priceMinor: null })), false);
assert.deepEqual(pickFreshDrop([item('s', 'a', day(9), { variants: [{ size: 'M', stock: 0 }] }), item('n', 'b', day(9), { photos: [] }), item('z', 'c', day(9), { priceMinor: 0 }), item('ok', 'd', day(1))]), [item('ok', 'd', day(1))]);
assert.deepEqual(pickFreshDrop([]), []);
assert.deepEqual(pickFreshDrop(undefined), []);

// One per category first, newest within the whole list, then in sort order
const four = [item('h1', 'hoodies', day(9)), item('h2', 'hoodies', day(8)), item('s1', 'sneakers', day(7)), item('t1', 'tees', day(6)), item('t2', 'tees', day(5))];
assert.deepEqual(slugs(pickFreshDrop(four)), ['h1', 's1', 't1'], 'variety beats recency when three categories exist');
assert.deepEqual(slugs(pickFreshDrop([...four].reverse())), ['h1', 's1', 't1'], 'input order does not matter');
assert.deepEqual(slugs(pickFreshDrop(four, 2)), ['h1', 's1']);
// A sold-out newest item does not take the category's place
assert.deepEqual(slugs(pickFreshDrop([item('h0', 'hoodies', day(10), { variants: [{ size: 'M', stock: 0 }] }), ...four])), ['h1', 's1', 't1']);

// Ties: same updatedAt orders by slug; invalid dates count as 0 (oldest)
assert.deepEqual(slugs(pickFreshDrop([item('b', 'x', day(3)), item('a', 'y', day(3)), item('c', 'z', day(3))])), ['a', 'b', 'c']);
assert.deepEqual(slugs(pickFreshDrop([item('bad', 'x', 'nonsense'), item('none', 'y', undefined), item('old', 'z', day(1)), item('new', 'w', day(2))])), ['new', 'old', 'bad'], 'invalid and missing dates sort last, then by slug');
// Tie inside one category: the lower slug is that category's pick
assert.deepEqual(slugs(pickFreshDrop([item('h2', 'hoodies', day(5)), item('h1', 'hoodies', day(5)), item('s1', 'sneakers', day(4)), item('t1', 'tees', day(3))])), ['h1', 's1', 't1']);

// unclassified, null and missing are one group
const mixed = [item('u1', 'unclassified', day(9)), item('u2', null, day(8)), item('u3', undefined, day(7)), item('s1', 'sneakers', day(6)), item('t1', 'tees', day(5))];
assert.deepEqual(slugs(pickFreshDrop(mixed)), ['u1', 's1', 't1'], 'three unclassified count as one category');

// Fewer than three categories: one per category, then the next newest overall (lead decision L-2)
assert.deepEqual(slugs(pickFreshDrop([item('a1', 'a', day(9)), item('a2', 'a', day(8)), item('a3', 'a', day(7)), item('b1', 'b', day(1))])), ['a1', 'b1', 'a2'], 'two categories: a1, b1, then a2');
assert.deepEqual(slugs(pickFreshDrop([item('a1', 'a', day(9)), item('a2', 'a', day(8)), item('a3', 'a', day(7))])), ['a1', 'a2', 'a3'], 'one category: strictly newest');
// Fewer than three eligible: whatever exists (the hero then shows its quiet empty note)
assert.deepEqual(slugs(pickFreshDrop([item('a1', 'a', day(9)), item('b1', 'b', day(8))])), ['a1', 'b1']);

// Products feed: one request, shared promise
{
  let calls = 0;
  const load = createProductsFeed(async () => { calls += 1; return { items: [calls] }; });
  const first = load(), second = load();
  assert.equal(first, second, 'same memoized promise');
  assert.deepEqual(await first, { items: [1] });
  assert.deepEqual(await load(), { items: [1] });
  assert.equal(calls, 1, 'one request');
}
// A rejection reaches every caller, clears the memo and the next call asks again
{
  const unhandled = [];
  const onUnhandled = reason => unhandled.push(reason);
  process.on('unhandledRejection', onUnhandled);
  let calls = 0;
  const load = createProductsFeed(async () => { calls += 1; if (calls === 1) throw new Error('boom'); return { items: [] }; });
  load(); // an early call nobody awaits (main.jsx) that fails before anyone listens
  await new Promise(r => setTimeout(r, 20));
  assert.deepEqual(unhandled, [], 'early failure is not an unhandled rejection');
  assert.equal(calls, 1);
  const shared = load(), again = load(); // memo was cleared by the failure: one new request, shared
  assert.equal(shared, again);
  assert.deepEqual(await shared, { items: [] });
  assert.equal(calls, 2);
  // a rejection reaches a caller that was waiting
  let n = 0;
  const flaky = createProductsFeed(async () => { n += 1; throw new Error('boom'); });
  await assert.rejects(flaky(), /boom/, 'callers still see the rejection');
  await assert.rejects(flaky(), /boom/);
  assert.equal(n, 2, 'a failure is never served from the memo');
  await new Promise(r => setTimeout(r, 10));
  process.off('unhandledRejection', onUnhandled);
  assert.deepEqual(unhandled, [], 'no unhandled rejection');
}
// A synchronous throw in the fetcher is a rejection too
{
  let calls = 0;
  const load = createProductsFeed(() => { calls += 1; throw new Error('sync'); });
  await assert.rejects(load(), /sync/);
  await assert.rejects(load(), /sync/);
  assert.equal(calls, 2);
}

// Count label: Ukrainian plural
assert.deepEqual([1, 2, 4, 5, 11, 12, 14, 21, 22, 25, 101, 111, 219, 0].map(thingsLabel), ['1 річ', '2 речі', '4 речі', '5 речей', '11 речей', '12 речей', '14 речей', '21 річ', '22 речі', '25 речей', '101 річ', '111 речей', '219 речей', '0 речей']);
console.log('fresh-drop ok');
