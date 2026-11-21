import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { LOCAL_CART_KEY } from '../../packages/catalog/cart.js';
import { createCartStore } from '../../apps/web/src/cart/cart-store.js';
import { addWithFeedback } from '../../apps/web/src/cart/cart-add.js';

function memoryStorage() {
  const map = new Map();
  return { getItem: k => map.get(k) ?? null, setItem: (k, v) => map.set(k, v), map };
}
const product = { id: 'p1', slug: 'hoodie', title: 'Худі', priceMinor: 120000, photos: [], variants: [{ size: 'M', stock: 3 }, { size: 'L', stock: 20 }] };
function setup() {
  const storage = memoryStorage();
  const store = createCartStore(() => storage);
  const events = [];
  const off = store.subscribeAdded(e => events.push(e));
  return { storage, store, events, off };
}

test('subscribeAdded fires once per successful add or merge, with the payload', () => {
  const { store, events } = setup();
  store.addProduct(product, 'L', 1);
  assert.deepEqual(events, [{ status: 'added', productId: 'p1', size: 'L' }]);
  store.addProduct(product, 'L', 1);
  assert.deepEqual(events.map(e => e.status), ['added', 'merged']);
});

test('subscribeAdded stays silent for capped, stock_capped and failed adds', () => {
  const { store, events } = setup();
  store.addProduct(product, 'L', 9);
  events.length = 0;
  assert.equal(store.addProduct(product, 'L', 5).status, 'capped');
  store.addProduct(product, 'M', 3);
  events.length = 0;
  assert.equal(store.addProduct(product, 'M', 1).status, 'stock_capped');
  assert.equal(store.addProduct(product, 'XL', 1).status, 'unavailable');
  assert.equal(store.addProduct({}, 'M', 1).status, 'invalid');
  assert.equal(events.length, 0);
});

test('subscribeAdded ignores other-tab sync, quantity change, remove, hints and checkout', () => {
  const { store, storage, events } = setup();
  store.addProduct(product, 'L', 2);
  events.length = 0;
  storage.map.set(LOCAL_CART_KEY, storage.map.get(LOCAL_CART_KEY));
  store.refresh();
  store.setQuantity(0, 5);
  store.refreshHints([{ ...product, title: 'Нове' }]);
  store.completeCheckout({ code: 'A', createdAt: 'x', itemCount: 1, totalMinor: 1 });
  store.addProduct(product, 'L', 1);
  events.length = 0;
  store.removeLine(0);
  assert.equal(events.length, 0);
});

test('unsubscribe stops events and a throwing listener does not break the add', () => {
  const { store, events, off } = setup();
  store.subscribeAdded(() => { throw new Error('boom'); });
  assert.equal(store.addProduct(product, 'L', 1).status, 'added');
  assert.equal(events.length, 1);
  off();
  store.addProduct(product, 'L', 1);
  assert.equal(events.length, 1);
  assert.equal(store.count(), 2);
});

test('addWithFeedback (QuickAdd and SizePicker path) fires through the store exactly once', () => {
  const { store, events } = setup();
  assert.equal(addWithFeedback(product, 'L', store).ok, true);
  assert.equal(events.length, 1);
  assert.equal(addWithFeedback(product, '', store).ok, false);
  assert.equal(events.length, 1);
});

test('cart-moment.css animates only transform, opacity and stroke-dashoffset, uses tokens and honours reduced motion', async () => {
  const css = (await readFile(new URL('../../apps/web/src/cart/cart-moment.css', import.meta.url), 'utf8')).replace(/\/\*[\s\S]*?\*\//g, '');
  assert.ok(/var\(--lime\)/.test(css));
  assert.ok(!/#[0-9a-f]{3,8}\b/i.test(css), 'no raw colours');
  for (const m of css.matchAll(/@keyframes [\w-]+\{([\s\S]*?\})\}/g)) {
    for (const prop of m[1].matchAll(/([a-z-]+)\s*:/g)) assert.ok(['transform', 'opacity', 'stroke-dashoffset'].includes(prop[1]), `keyframe animates ${prop[1]}`);
  }
  assert.ok(/prefers-reduced-motion:\s*reduce/.test(css));
});
