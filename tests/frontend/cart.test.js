import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, writeFile, rm } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { build } from 'vite';
import { pluralItems, cartLabel, badgeText } from '../../apps/web/src/cart/cart-labels.js';
import { cartSum, lineTotal, priceDrifted, lineUnavailable, unavailableFlags, loadCatalogHints } from '../../apps/web/src/cart/cart-pricing.js';
import { addWithFeedback } from '../../apps/web/src/cart/cart-add.js';
import { LOCAL_CART_KEY } from '../../packages/catalog/cart.js';
import { createCartStore, inStockSizes, isAddOk, lineKey, parseQuantityDraft } from '../../apps/web/src/cart/cart-store.js';
import { parseAddParams, cleanedCartUrl, checkout, fetchProduct, fetchAccountCarts, mapProblems, mapProblemsToLines, checkoutErrorText, managerMessage, copyText, deliveryErrorCode, deliveryLine, prefillHint, ANONYMOUS_HINT, checkoutDelivery, prefillFromProfile, deliveryHint, OVERRIDE_HINT, REMEMBER_HINT } from '../../apps/web/src/cart/cart-api.js';

function memoryStorage(seed) {
  const map = new Map(seed ? [[LOCAL_CART_KEY, seed]] : []);
  return { getItem: k => map.get(k) ?? null, setItem: (k, v) => map.set(k, v), map };
}
const product = { id: 'p1', slug: 'hoodie', title: 'Худі', priceMinor: 120000, photos: ['https://x/y.jpg'], variants: [{ size: 'S', stock: 0 }, { size: 'M', stock: 3 }, { size: 'M', stock: 2 }, { size: 'L', stock: 20 }] };
const res = (status, body, headers = {}) => ({ ok: status < 400, status, json: async () => body, headers: { get: k => headers[k] ?? null } });

test('inStockSizes hides empty sizes and sums duplicates', () => {
  assert.deepEqual(inStockSizes(product.variants), [{ size: 'M', stock: 5 }, { size: 'L', stock: 20 }]);
  assert.deepEqual(inStockSizes(undefined), []);
});

test('store adds, merges, caps and persists', () => {
  const storage = memoryStorage();
  const store = createCartStore(() => storage);
  assert.equal(store.addProduct(product, 'S').status, 'unavailable');
  assert.equal(store.addProduct(product, 'L', 4).status, 'added');
  assert.equal(store.addProduct(product, 'L', 2).status, 'merged');
  assert.equal(store.get().lines[0].quantity, 6);
  assert.equal(store.addProduct(product, 'L', 6).status, 'capped');
  assert.equal(store.get().lines[0].quantity, 10);
  assert.equal(store.addProduct(product, 'M', 4).status, 'added');
  assert.equal(store.addProduct(product, 'M', 4).status, 'stock_capped');
  assert.equal(store.get().lines[1].quantity, 5);
  assert.equal(store.count(), 15);
  assert.equal(JSON.parse(storage.map.get(LOCAL_CART_KEY)).lines.length, 2);
  assert.equal(createCartStore(() => storage).get().lines.length, 2);
});

test('store reports full carts', () => {
  const store = createCartStore(() => memoryStorage());
  for (let i = 0; i < 20; i++) assert.equal(store.addProduct({ ...product, id: `p${i}` }, 'L').status, 'added');
  assert.equal(store.addProduct({ ...product, id: 'extra' }, 'L').status, 'full');
  assert.equal(store.get().lines.length, 20);
});

test('store survives corrupt data and storage failures', () => {
  assert.deepEqual(createCartStore(() => memoryStorage('{not json')).get().lines, []);
  const broken = { getItem() { throw new Error('denied'); }, setItem() { throw new Error('quota'); } };
  const store = createCartStore(() => broken);
  assert.equal(store.addProduct(product, 'L').status, 'added');
  assert.equal(store.count(), 1);
  assert.equal(store.isPersistent(), false);
  const none = createCartStore(() => { throw new Error('blocked'); });
  assert.equal(none.addProduct(product, 'L').status, 'added');
  assert.equal(none.count(), 1);
});

test('store edits quantity, removes lines and notifies', () => {
  const store = createCartStore(() => memoryStorage());
  let calls = 0; const off = store.subscribe(() => calls++);
  store.addProduct(product, 'L', 2);
  store.setQuantity(0, 99); assert.equal(store.get().lines[0].quantity, 10);
  store.setQuantity(0, 0); assert.equal(store.get().lines[0].quantity, 1);
  store.removeLine(0); assert.equal(store.get().lines.length, 0);
  off(); assert.ok(calls >= 4);
});

test('completeCheckout clears lines and records the code', () => {
  const store = createCartStore(() => memoryStorage());
  store.addProduct(product, 'L');
  store.completeCheckout({ code: 'SS-ABCD-2345', createdAt: '2026-01-01T00:00:00Z', itemCount: 1, totalMinor: 120000 });
  assert.deepEqual(store.get().lines, []);
  assert.equal(store.get().recent[0].code, 'SS-ABCD-2345');
  store.completeCheckout({ code: 'SS-ABCD-2345', createdAt: '2026-01-02T00:00:00Z', itemCount: 1, totalMinor: 1 });
  assert.equal(store.get().recent.length, 1);
});

test('?add= params parse and the URL is cleaned', () => {
  assert.deepEqual(parseAddParams('?add=hoodie&size=M&qty=2'), { slug: 'hoodie', size: 'M', qty: 2 });
  assert.equal(parseAddParams('?qty=2'), null);
  assert.equal(parseAddParams('?add=a&size=M&qty=zz').qty, 1);
  assert.equal(cleanedCartUrl('/cart', '?add=a&size=M&qty=1&x=1', '#h'), '/cart?x=1#h');
  assert.equal(cleanedCartUrl('/cart', '?add=a&size=M&qty=1'), '/cart');
});

test('?add= flow validates through the product API then adds', async () => {
  const calls = [];
  const fetchImpl = async (path, opts) => { calls.push([path, opts.method]); return res(200, product); };
  const params = parseAddParams('?add=hoodie&size=M&qty=2');
  const p = await fetchProduct(params.slug, fetchImpl);
  const store = createCartStore(() => memoryStorage());
  assert.equal(store.addProduct(p, params.size, params.qty).status, 'added');
  assert.deepEqual(calls, [['/api/products/hoodie', 'GET']]);
  await assert.rejects(fetchProduct('gone', async () => res(404, { error: 'not_found' })), e => e.status === 404);
  assert.equal(store.addProduct(p, 'S', 1).status, 'unavailable');
});

test('checkout posts only ids/size/quantity and returns the cart', async () => {
  let seen;
  const fetchImpl = async (path, opts) => { seen = { path, opts }; return res(201, { cart: { code: 'SS-AAAA-BBBB', bound: true } }); };
  const out = await checkout([{ productId: 'p1', size: 'M', quantity: 2, title: 'x', priceMinor: 1 }], fetchImpl);
  assert.equal(seen.path, '/api/cart/checkout');
  assert.equal(seen.opts.method, 'POST');
  assert.deepEqual(JSON.parse(seen.opts.body), { lines: [{ productId: 'p1', size: 'M', quantity: 2 }] });
  assert.equal(seen.opts.headers['Content-Type'], 'application/json');
  assert.equal(out.cart.bound, true);
});

test('checkout 400/409 problems map onto lines', async () => {
  const problems = [{ index: 1, code: 'insufficient_stock', available: 2 }, { index: 0, code: 'size_unavailable' }, { index: null, code: 'too_many_lines' }];
  for (const status of [400, 409]) {
    const err = await checkout([{ productId: 'a', size: 'M', quantity: 1 }], async () => res(status, { error: status === 400 ? 'invalid_cart' : 'cart_unavailable', problems })).catch(e => e);
    assert.equal(err.status, status);
    const mapped = mapProblems(err.problems, 2);
    assert.match(mapped.byLine[1].text, /2 шт/);
    assert.equal(mapped.byLine[0].code, 'size_unavailable');
    assert.equal(mapped.general.length, 1);
    assert.match(checkoutErrorText(err), /уваги/);
  }
  assert.deepEqual(mapProblems([{ index: 9, code: 'x' }], 1).byLine, {});
});

test('checkout 429 exposes Retry-After', async () => {
  const err = await checkout([{ productId: 'a', size: 'M', quantity: 1 }], async () => res(429, { error: 'rate_limited' }, { 'Retry-After': '120' })).catch(e => e);
  assert.equal(err.status, 429);
  assert.equal(err.retryAfter, '120');
  assert.match(checkoutErrorText(err), /2 хв/);
  assert.match(checkoutErrorText({ status: 429, retryAfter: null }), /Забагато/);
  assert.match(checkoutErrorText(new TypeError('net')), /Кошик збережено/);
});

test('copyText uses the clipboard, then a fallback, then reports failure', async () => {
  let written;
  assert.equal(await copyText('SS-1', { navigator: { clipboard: { writeText: async t => { written = t; } } } }), true);
  assert.equal(written, 'SS-1');
  const calls = [];
  const doc = { createElement: () => ({ setAttribute() {}, style: {}, select: () => calls.push('select') }), body: { appendChild: () => calls.push('add'), removeChild: () => calls.push('rm') }, execCommand: c => { calls.push(c); return true; } };
  assert.equal(await copyText('SS-2', { navigator: { clipboard: { writeText: async () => { throw new Error('denied'); } } }, document: doc }), true);
  assert.deepEqual(calls, ['add', 'select', 'copy', 'rm']);
  assert.equal(await copyText('x', {}), false);
});

test('checkout sends delivery only as {warehouseRef} and omits it without a point', async () => {
  const bodies = [];
  const fetchImpl = async (path, opts) => { bodies.push(JSON.parse(opts.body)); return res(201, { cart: { code: 'SS-AAAA-BBBB' } }); };
  const lines = [{ productId: 'p1', size: 'M', quantity: 1 }];
  await checkout(lines, fetchImpl);
  await checkout(lines, fetchImpl, { delivery: null });
  await checkout(lines, fetchImpl, { delivery: { warehouseRef: 'abc', cityName: 'Київ', note: 'x' } });
  assert.deepEqual(Object.keys(bodies[0]), ['lines']);
  assert.deepEqual(Object.keys(bodies[1]), ['lines']);
  assert.deepEqual(bodies[2].delivery, { warehouseRef: 'abc' });
});

test('delivery errors map to fixed texts by code and keep the problems empty', async () => {
  const cases = [[409, 'delivery_unavailable', 'Цей пункт більше не приймає посилки. Оберіть інший.'], [503, 'delivery_catalog_unavailable', 'Довідник Нової пошти зараз недоступний. Можна оформити кошик без пункту доставки.'], [400, 'invalid_delivery', 'Перевірте пункт доставки.']];
  for (const [status, code, text] of cases) {
    const err = await checkout([{ productId: 'a', size: 'M', quantity: 1 }], async () => res(status, { error: code })).catch(e => e);
    assert.equal(deliveryErrorCode(err), code); assert.equal(checkoutErrorText(err), text);
  }
  const cartErr = { status: 409, code: 'cart_unavailable' };
  assert.equal(deliveryErrorCode(cartErr), ''); assert.match(checkoutErrorText(cartErr), /потребують уваги/);
  assert.equal(deliveryErrorCode({ code: 'toString' }), '');
});

test('origin hints and the anonymous hint', () => {
  assert.equal(prefillHint({ origin: 'cabinet' }), 'Ваш улюблений пункт');
  assert.equal(prefillHint({ origin: 'checkout' }), 'Пункт з вашого останнього замовлення');
  assert.match(ANONYMOUS_HINT, /Увійдіть, щоб ми його запамʼятали/);
});

test('checkoutDelivery sends a point only for a known signed-in session', () => {
  const point = { warehouseRef: 'w', cityName: 'Київ' };
  assert.deepEqual(checkoutDelivery({ signed: true, point }), { warehouseRef: 'w' });
  assert.equal(checkoutDelivery({ signed: false, point }), null);
  assert.equal(checkoutDelivery({ signed: null, point }), null);
  assert.equal(checkoutDelivery({ signed: true, point: null }), null);
  assert.equal(checkoutDelivery({ signed: true, point, withoutPoint: true }), null);
});

test('prefillFromProfile uses np-api preferences with a Ref only and never after interaction', () => {
  const pref = { source: 'np-api', origin: 'cabinet', type: 'branch', cityName: 'Київ', cityRef: 'c', warehouseRef: 'w', warehouseNumber: '1', warehouseName: 'В1' };
  const got = prefillFromProfile({ deliveryPreference: pref });
  assert.equal(got.ref, 'w'); assert.equal(got.hint, 'Ваш улюблений пункт'); assert.equal(got.origin, 'cabinet');
  assert.equal(prefillFromProfile({ deliveryPreference: { ...pref, origin: 'checkout' } }).hint, 'Пункт з вашого останнього замовлення');
  assert.equal(prefillFromProfile({ deliveryPreference: { ...pref, source: 'manual', origin: null } }), null);
  assert.equal(prefillFromProfile({ deliveryPreference: { ...pref, warehouseRef: null } }), null);
  assert.equal(prefillFromProfile({ deliveryPreference: null }), null);
  assert.equal(prefillFromProfile({ deliveryPreference: pref }, true), null);
});

test('deliveryHint wording follows the favourite origin', () => {
  const mk = origin => ({ ref: 'w', origin, hint: 'H' });
  assert.equal(deliveryHint({ signed: false, point: { warehouseRef: 'x' }, prefilled: null }), ANONYMOUS_HINT);
  assert.equal(deliveryHint({ signed: null, point: { warehouseRef: 'x' }, prefilled: null }), '');
  assert.equal(deliveryHint({ signed: true, point: null, prefilled: null }), '');
  assert.equal(deliveryHint({ signed: true, point: { warehouseRef: 'w' }, prefilled: mk('cabinet') }), 'H');
  assert.equal(deliveryHint({ signed: true, point: { warehouseRef: 'x' }, prefilled: mk('cabinet') }), OVERRIDE_HINT);
  assert.equal(deliveryHint({ signed: true, point: { warehouseRef: 'x' }, prefilled: mk('checkout') }), REMEMBER_HINT);
  assert.equal(deliveryHint({ signed: true, point: { warehouseRef: 'x' }, prefilled: null }), REMEMBER_HINT);
});

test('manager message carries the delivery line with a point, signed in or not', () => {
  const cart = { code: 'SS-AAAA-BBBB', totalMinor: 1, lines: [] };
  const point = { cityName: 'Київ', warehouseName: 'Відділення №1', warehouseNumber: '1' };
  assert.match(managerMessage(cart, undefined, point), /\nДоставка: Нова пошта, Київ, Відділення №1\n/);
  assert.match(managerMessage({ ...cart, delivery: point }), /Доставка: Нова пошта, Київ, Відділення №1/);
  assert.doesNotMatch(managerMessage(cart), /Доставка/);
  assert.equal(deliveryLine({ cityName: 'Львів', warehouseName: null, warehouseNumber: '5' }), 'Доставка: Нова пошта, Львів, №5');
});

test('manager message contains the code and lines', () => {
  const text = managerMessage({ code: 'SS-AAAA-BBBB', totalMinor: 240000, lines: [{ title: 'Худі', size: 'M', quantity: 2 }] });
  assert.match(text, /SS-AAAA-BBBB/);
  assert.match(text, /Худі \(M\) × 2/);
});

test('account carts list uses the account endpoint', async () => {
  let path;
  const out = await fetchAccountCarts(async p => { path = p; return res(200, { carts: [{ code: 'SS-AAAA-BBBB', lines: [] }] }); });
  assert.equal(path, '/api/account/carts');
  assert.equal(out.carts.length, 1);
  await assert.rejects(fetchAccountCarts(async () => res(401, { error: 'unauthenticated' })), e => e.status === 401);
});

test('completeCheckout removes only submitted lines and keeps other-tab additions', () => {
  const storage = memoryStorage();
  const store = createCartStore(() => storage);
  store.addProduct(product, 'L', 2);
  const submitted = store.snapshot();
  // another tab adds a new line and more of the same one while checkout is in flight
  const other = createCartStore(() => storage);
  other.addProduct({ ...product, id: 'p2' }, 'L', 1);
  other.addProduct(product, 'L', 3);
  store.completeCheckout({ code: 'SS-ABCD-2345', createdAt: '', itemCount: 2, totalMinor: 1 }, submitted);
  const lines = store.get().lines;
  assert.equal(lines.length, 2);
  assert.deepEqual(lines.map(l => [l.productId, l.quantity]).sort(), [['p1', 3], ['p2', 1]]);
  assert.equal(createCartStore(() => storage).get().recent[0].code, 'SS-ABCD-2345');
});

test('snapshot is frozen against later edits and problems key by productId+size', () => {
  const store = createCartStore(() => memoryStorage());
  store.addProduct(product, 'L', 2); store.addProduct(product, 'M', 1);
  const submitted = store.snapshot();
  store.removeLine(0); store.setQuantity(0, 7);
  assert.equal(submitted.length, 2); assert.equal(submitted[0].quantity, 2);
  const mapped = mapProblemsToLines([{ index: 0, code: 'size_unavailable' }, { index: 5, code: 'x' }], submitted);
  assert.equal(mapped.byKey[lineKey({ productId: 'p1', size: 'L' })].code, 'size_unavailable');
  assert.equal(Object.keys(mapped.byKey).length, 1);
});

test('refresh re-reads storage and notifies external listeners', () => {
  const storage = memoryStorage();
  const store = createCartStore(() => storage);
  store.addProduct(product, 'L');
  let external = 0; store.subscribeExternal(() => external++);
  createCartStore(() => storage).addProduct(product, 'M');
  store.refresh();
  assert.equal(external, 1);
  assert.equal(store.get().lines.length, 2);
});

test('quantity draft parsing allows clearing and retyping', () => {
  assert.equal(parseQuantityDraft(''), null);
  assert.equal(parseQuantityDraft('0'), null);
  assert.equal(parseQuantityDraft('11'), null);
  assert.equal(parseQuantityDraft('abc'), null);
  assert.equal(parseQuantityDraft('5'), 5);
  assert.equal(parseQuantityDraft(' 10 '), 10);
  // backspace to empty must not change the stored quantity; typing 5 commits 5
  const store = createCartStore(() => memoryStorage());
  store.addProduct(product, 'L', 3);
  for (const text of ['', '5']) { const n = parseQuantityDraft(text); if (n !== null) store.setQuantity(0, n); if (text === '') assert.equal(store.get().lines[0].quantity, 3); }
  assert.equal(store.get().lines[0].quantity, 5);
});

test('?qty is capped, null photos are handled and isAddOk classifies', () => {
  assert.equal(parseAddParams('?add=a&size=M&qty=99').qty, 10);
  assert.equal(parseAddParams('?add=a&qty=2').size, '');
  const store = createCartStore(() => memoryStorage());
  store.addProduct({ ...product, photos: [] }, 'L');
  assert.equal(store.get().lines[0].photo, null);
  assert.ok(isAddOk('merged') && isAddOk('capped') && !isAddOk('full') && !isAddOk('unavailable'));
});

test('clipboard fallback restores focus', async () => {
  const focused = [];
  const previous = { focus: () => focused.push('prev') };
  const doc = { activeElement: previous, createElement: () => ({ setAttribute() {}, style: {}, select() {} }), body: { appendChild() {}, removeChild() {} }, execCommand: () => true };
  assert.equal(await copyText('x', { document: doc }), true);
  assert.deepEqual(focused, ['prev']);
});

test('completeCheckout keeps in-memory state and recent codes when writes fail', () => {
  const stale = JSON.stringify({ version: 1, lines: [], recent: [] });
  const failing = { getItem: () => stale, setItem() { throw new Error('quota'); } };
  const store = createCartStore(() => failing);
  store.addProduct(product, 'L', 2);
  assert.equal(store.isPersistent(), false);
  store.completeCheckout({ code: 'SS-ABCD-2345', createdAt: '', itemCount: 2, totalMinor: 1 }, store.snapshot());
  assert.deepEqual(store.get().lines, []);
  assert.equal(store.get().recent[0].code, 'SS-ABCD-2345');
  assert.equal(store.isPersistent(), false);
});

test('clearRecent empties recent codes, keeps lines, persists and notifies', () => {
  const storage = memoryStorage();
  const store = createCartStore(() => storage);
  store.addProduct(product, 'L');
  store.completeCheckout({ code: 'SS-ABCD-2345', createdAt: '', itemCount: 1, totalMinor: 1 }, store.snapshot());
  store.addProduct(product, 'M');
  let calls = 0; store.subscribe(() => calls++);
  store.clearRecent();
  assert.deepEqual(store.get().recent, []);
  assert.equal(store.get().lines.length, 1);
  assert.deepEqual(JSON.parse(storage.map.get(LOCAL_CART_KEY)).recent, []);
  assert.equal(calls, 1);
});

test('cart labels use Ukrainian plurals and cap the badge', () => {
  const words = [[1, 'товар'], [2, 'товари'], [4, 'товари'], [5, 'товарів'], [11, 'товарів'], [12, 'товарів'], [14, 'товарів'], [21, 'товар'], [22, 'товари'], [101, 'товар'], [111, 'товарів']];
  for (const [n, w] of words) assert.equal(pluralItems(n), w, String(n));
  assert.equal(cartLabel(0), 'Кошик');
  assert.equal(cartLabel(3), 'Кошик, 3 товари');
  assert.equal(cartLabel(25), 'Кошик, 25 товарів');
  assert.equal(badgeText(0), ''); assert.equal(badgeText(9), '9'); assert.equal(badgeText(10), '9+'); assert.equal(badgeText(99), '9+');
});

test('addWithFeedback adds, reports merges and requires a size', () => {
  const store = createCartStore(() => memoryStorage());
  assert.equal(addWithFeedback(product, '', store).ok, false);
  assert.equal(addWithFeedback(product, 'L', store).status, 'added');
  const again = addWithFeedback(product, 'L', store);
  assert.equal(again.status, 'merged'); assert.match(again.text, /збільшено/);
  assert.equal(addWithFeedback(product, 'S', store).ok, false);
  assert.equal(store.count(), 2);
});

test('rendered header, cards, detail and cart have no estimate or payment wording', async () => {
  const cacheRoot = resolve('node_modules/.cache');
  await mkdir(cacheRoot, { recursive: true });
  const dir = await mkdtemp(join(cacheRoot, 'cart-ssr-')); // inside the repo so react resolves regardless of TMPDIR
  try {
    const src = p => resolve('apps/web/src', p).replaceAll('\\', '/');
    const entry = join(dir, 'entry.jsx');
    await writeFile(entry, `import React from 'react';import {renderToStaticMarkup as r} from 'react-dom/server';
import {CartLinkView} from '${src('cart/CartLink.jsx')}';import QuickAdd from '${src('cart/QuickAdd.jsx')}';import SizePicker from '${src('cart/SizePicker.jsx')}';
import {ProductDetail, ProductCard} from '${src('Storefront.jsx')}';import {Confirmation, StepIndicator, RecipientForm, BuyerNotice, TermsConsent} from '${src('cart/CartPage.jsx')}';
export const link=n=>r(<CartLinkView count={n}/>);export const quick=(p,o)=>r(<QuickAdd product={p} initialOpen={o}/>);export const picker=p=>r(<SizePicker product={p}/>);export const detail=p=>r(<ProductDetail product={p}/>);export const card=(p,preview)=>r(<ProductCard product={p} preview={preview}/>);export const confirm=(c,u,p,rc,t)=>r(<Confirmation cart={c} updated={u} point={p} recipient={rc} termsAccepted={t}/>);export const buyerNotice=()=>r(<BuyerNotice/>);export const terms=(c,e)=>r(<TermsConsent checked={c} onChange={()=>{}} showError={e}/>);export const steps=s=>r(<StepIndicator step={s} onGo={()=>{}}/>);export const form=(d,e,show,signed)=>r(<RecipientForm draft={d} onChange={()=>{}} errors={e} showErrors={show} signed={signed} onBack={()=>{}} onNext={()=>{}}/>);`);
    await build({ root: dir, configFile: false, logLevel: 'silent', esbuild: { jsx: 'automatic' }, ssr: { noExternal: true }, build: { ssr: entry, outDir: dir, emptyOutDir: false, rollupOptions: { output: { format: 'cjs', entryFileNames: 'out.cjs' } } } });
    const m = (await import(pathToFileURL(join(dir, 'out.cjs')).href)).default;
    assert.doesNotMatch(m.link(0), /cart-count/);
    assert.match(m.link(0), /aria-label="Кошик"/); assert.match(m.link(0), /href="\/cart"/);
    assert.match(m.link(3), /aria-label="Кошик, 3 товари"/); assert.match(m.link(3), />3</);
    assert.match(m.link(12), />9\+</); assert.match(m.link(12), /Кошик, 12 товарів/);
    const multi = m.quick(product, false);
    assert.match(multi, /aria-label="Додати в кошик: Худі"/); assert.match(multi, /aria-expanded="false"/); assert.doesNotMatch(multi, /aria-haspopup/); assert.doesNotMatch(multi, /quick-add-sizes/);
    const open = m.quick(product, true);
    assert.match(open, /role="group"/); assert.match(open, />M</); assert.match(open, />L</); assert.doesNotMatch(open, />S</);
    const single = m.quick({ ...product, variants: [{ size: 'M', stock: 2 }, { size: 'S', stock: 0 }] }, true);
    assert.match(single, /aria-label="Додати в кошик: Худі"/); assert.doesNotMatch(single, /aria-expanded|quick-add-sizes/);
    assert.equal(m.quick({ ...product, variants: [{ size: 'S', stock: 0 }] }, false), '');
    assert.doesNotMatch(multi, /type="radio"/);
    const detail = m.detail({ ...product, description: 'Опис', categoryPath: ['Одяг'] }) + m.picker(product);
    assert.match(detail, /type="radio"/); assert.match(detail, /Додати в кошик/);
    assert.doesNotMatch(detail, /photo-note-long/);
    const conf = m.confirm({ code: 'SS-AAAA-BBBB', totalMinor: 5000, itemCount: 1, lines: [] }, true);
    assert.match(conf, /підтвердить наявність та доставку/); assert.match(conf, /Ціну оновлено/);
    assert.doesNotMatch(m.confirm({ code: 'SS-AAAA-BBBB', totalMinor: 5000, itemCount: 1, lines: [] }, false), /Ціну оновлено/);
    const point = { type: 'branch', cityRef: 'c', cityName: 'Київ', warehouseRef: 'w', warehouseNumber: '1', warehouseName: 'Відділення №1' };
    const withPoint = m.confirm({ code: 'SS-AAAA-BBBB', totalMinor: 5000, itemCount: 1, lines: [] }, false, point);
    assert.match(withPoint, /Доставка:<\/strong> Нова пошта, Відділення, Київ: Відділення №1/); assert.match(withPoint, /Доставка: Нова пошта, Київ, Відділення №1/);
    assert.doesNotMatch(conf, /Доставка:/);
    // recipient on the confirmation and in the manager message; the stored one wins over the entered one
    const withRecipient = m.confirm({ code: 'SS-AAAA-BBBB', totalMinor: 5000, itemCount: 1, lines: [] }, false, null, { lastName: 'Коваль', firstName: 'Олена', middleName: 'Петрівна', phone: '+380501234567' });
    assert.match(withRecipient, /Отримувач:<\/strong> Коваль Олена Петрівна, \+380 50 123 45 67/); assert.match(withRecipient, /Отримувач: Коваль Олена Петрівна, \+380 50 123 45 67/);
    assert.match(m.confirm({ code: 'SS-AAAA-BBBB', totalMinor: 5000, itemCount: 1, lines: [], recipient: { lastName: 'Збережена', firstName: 'Особа', middleName: 'Іванівна', name: 'Збережена Особа Іванівна', phone: '+380671234567' } }, false, null, { lastName: 'Інша', firstName: 'Особа', middleName: 'Петрівна', phone: '+380501234567' }), /Збережена Особа Іванівна/);
    assert.doesNotMatch(conf, /Отримувач/);
    // step indicator: the current step is marked, earlier ones are buttons, later ones are not
    const second = m.steps('recipient');
    assert.match(second, /aria-label="Етапи оформлення"/); assert.equal((second.match(/<button/g) || []).length, 1);
    assert.match(second, /aria-current="step"[^>]*>.*Отримувач/); assert.doesNotMatch(m.steps('items'), /<button/);
    assert.equal((m.steps('delivery').match(/<button/g) || []).length, 2);
    // recipient form: Прізвище, Імʼя, По батькові, phone in that order; errors only after a Next attempt, linked to each input
    const empty = { lastName: '', firstName: '', middleName: '', phone: '' };
    const quiet = m.form(empty, { lastName: 'l', firstName: 'f', middleName: 'm', phone: 'p' }, false, false);
    assert.doesNotMatch(quiet, /aria-invalid="true"/); assert.match(quiet, /лише в повідомлення для менеджера/);
    const labels = [...quiet.matchAll(/<label for="([^"]+)">([^<]+)<\/label>/g)].map(x => [x[1], x[2]]);
    assert.deepEqual(labels, [['recipient-last-name', 'Прізвище'], ['recipient-first-name', 'Імʼя'], ['recipient-middle-name', 'По батькові'], ['recipient-phone', 'Мобільний телефон']]);
    for (const [id, ac] of [['recipient-last-name', 'family-name'], ['recipient-first-name', 'given-name'], ['recipient-middle-name', 'additional-name']]) assert.match(quiet, new RegExp(`id="${id}"[^>]*autoComplete="${ac}"|autoComplete="${ac}"[^>]*id="${id}"`, 'i'));
    assert.equal((quiet.match(/aria-required="true"/g) || []).length, 4); assert.match(quiet, /maxLength="40"/i); assert.match(quiet, /type="tel"/);
    const loud = m.form({ ...empty, firstName: 'Олена' }, { lastName: 'Вкажіть прізвище', middleName: 'Вкажіть по батькові', phone: 'Вкажіть номер' }, true, true);
    assert.equal((loud.match(/aria-invalid="true"/g) || []).length, 3);
    assert.match(loud, /aria-describedby="recipient-last-name-error"/); assert.match(loud, /id="recipient-middle-name-error"/); assert.doesNotMatch(loud, /recipient-first-name-error/);
    assert.match(loud, /aria-describedby="recipient-phone-help recipient-phone-error"/);
    assert.match(loud, /Збережемо отримувача/);
    for (const html of [detail, multi, open, single, conf]) assert.doesNotMatch(html, /орієнтов|(?<!перед)оплат|зв.яжеться/i); // only the lead-set «Передоплата» term is allowed
    // buyer disclaimer on the items step; required, unticked terms checkbox with a linked inline error
    // the buyer note is a prominent, informational warning block: decorative SVG icon, headline and body; no checkbox
    const buyerNotice = m.buyerNotice();
    assert.match(buyerNotice, /^<section class="checkout-warning" role="note" aria-labelledby="buyer-notice-title">/);
    assert.match(buyerNotice, /<svg class="checkout-warning-icon" viewBox="0 0 24 24" aria-hidden="true" focusable="false"/); assert.doesNotMatch(buyerNotice, /⚠/, 'an SVG icon, not an emoji');
    assert.match(buyerNotice, /<h2 id="buyer-notice-title">Тестове попередження<\/h2>/);
    assert.match(buyerNotice, /<p class="checkout-warning-text">Лорем іпсум — тестовий текст попередження для покупця\.<\/p>/);
    assert.doesNotMatch(buyerNotice, /<input|role="alert"|aria-live/, 'informational only: no acknowledgement, not a live region');
    const unticked = m.terms(false, false);
    assert.match(unticked, /<label[^>]*for="checkout-terms"/); assert.match(unticked, /<input id="checkout-terms"[^>]*type="checkbox"/);
    assert.doesNotMatch(unticked, /checked=""/, 'never pre-checked'); assert.match(unticked, /aria-required="true"/);
    assert.match(unticked, /Я приймаю <a href="\/#delivery" target="_blank" rel="noopener">умови оплати та доставки<span class="sr-only"> \(відкриється в новій вкладці\)<\/span><\/a>/);
    assert.doesNotMatch(unticked, /role="alert"|aria-invalid="true"|aria-describedby/, 'no error before a submit attempt');
    const blocked = m.terms(false, true);
    assert.match(blocked, /aria-invalid="true"/); assert.match(blocked, /aria-describedby="checkout-terms-error"/);
    assert.match(blocked, /<p id="checkout-terms-error" class="checkout-error" role="alert">Щоб отримати код кошика, позначте, що приймаєте умови\.<\/p>/);
    const ticked = m.terms(true, true);
    assert.match(ticked, /checked=""/); assert.doesNotMatch(ticked, /role="alert"|aria-invalid="true"/, 'ticking clears the error');
    assert.match(m.confirm({ code: 'SS-AAAA-BBBB', totalMinor: 5000, itemCount: 1, lines: [] }, false, null, null, true), /Умови оплати та доставки прийнято\.\nБудь ласка, перевірте замовлення\./);
    // card structure
    const full = { ...product, category: 'Одяг', brand: 'B' };
    const html = m.card(full, false);
    const anchors = [...html.matchAll(/<a\b[^>]*>[\s\S]*?<\/a>/g)].map(a => a[0]);
    assert.equal(anchors.length, 2);
    const focusable = anchors.filter(a => !/tabindex="-1"/.test(a));
    assert.equal(focusable.length, 1); assert.match(focusable[0], /<h3>Худі<\/h3>/);
    const hidden = anchors.find(a => /tabindex="-1"/.test(a)); assert.match(hidden, /aria-hidden="true"/);
    for (const a of anchors) assert.doesNotMatch(a, /<button/);
    assert.match(html, /quick-add-button/);
    assert.doesNotMatch(m.card(full, true), /quick-add|<button/);
    const soldOut = m.card({ ...full, variants: [{ size: 'S', stock: 0 }] }, false);
    assert.doesNotMatch(soldOut, /<button/); assert.match(soldOut, /Немає в наявності/);
    assert.doesNotMatch(m.card({ ...full, variants: [{ size: 'S', stock: 0 }] }, true), /Немає в наявності<\/span><\/div>/);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('cart page source and manager message carry no estimate or payment wording', async () => {
  const { readFile } = await import('node:fs/promises');
  // besides «Передоплата», the only payment wording allowed is the lead-set «умови оплати та доставки» (terms checkbox and its manager-message line).
  for (const f of ['CartPage.jsx', 'cart-api.js', 'checkout-steps.js', 'QuickAdd.jsx', 'SizePicker.jsx', 'CartLink.jsx']) assert.doesNotMatch(await readFile(resolve('apps/web/src/cart', f), 'utf8'), /орієнтов|(?<!перед)(?<!умови )оплат/i, f);
  assert.doesNotMatch(managerMessage({ code: 'SS-AAAA-BBBB', totalMinor: 1, lines: [] }), /орієнтов|оплат/i);
  assert.doesNotMatch(managerMessage({ code: 'SS-AAAA-BBBB', totalMinor: 1, lines: [] }, undefined, null, null, true).replace(TERMS_ACCEPTED_LINE, ''), /орієнтов|оплат/i);
  assert.match(await readFile(resolve('apps/web/src/cart/CartPage.jsx'), 'utf8'), /Передоплата/, 'the prepayment line exists');
});

test('line totals, cart sum and price drift', () => {
  const lines = [{ productId: 'a', size: 'M', quantity: 2, priceMinor: 1000 }, { productId: 'b', size: 'L', quantity: 1, priceMinor: 500 }];
  assert.equal(lineTotal(lines[0]), 2000); assert.equal(lineTotal({ quantity: 1, priceMinor: null }), null);
  assert.deepEqual(cartSum(lines), { total: 2500, complete: true });
  assert.equal(cartSum([...lines, { productId: 'c', size: 'S', quantity: 1, priceMinor: null }]).complete, false);
  assert.equal(priceDrifted(2500, 2500), false); assert.equal(priceDrifted(2500, 2600), true); assert.equal(priceDrifted(null, 2600), false);
});

test('refreshHints updates title and price only, never quantities', () => {
  const store = createCartStore(() => memoryStorage());
  store.addProduct(product, 'L', 3);
  assert.equal(store.refreshHints([{ ...product, title: 'Худі нове', priceMinor: 99000 }]), true);
  const line = store.get().lines[0];
  assert.equal(line.quantity, 3); assert.equal(line.title, 'Худі нове'); assert.equal(line.priceMinor, 99000); assert.equal(line.size, 'L');
  assert.equal(store.refreshHints([{ ...product, title: 'Худі нове', priceMinor: 99000 }]), false);
  assert.equal(store.refreshHints([{ id: 'other', title: 'x', priceMinor: 1 }]), false);
  store.refreshHints([{ ...product, priceMinor: undefined }]);
  assert.equal(store.get().lines[0].priceMinor, null);
  assert.equal(store.get().lines[0].quantity, 3);
});

test('catalog hints: only loaded products with a missing size are flagged; failures and 404 are ignored', async () => {
  const lines = [{ productId: 'p1', slug: 'hoodie', size: 'L' }, { productId: 'p1', slug: 'hoodie', size: 'S' }, { productId: 'g', slug: 'renamed', size: 'M' }, { productId: 'e', slug: 'err', size: 'M' }];
  let active = 0, peak = 0;
  const fetchP = async slug => { active++; peak = Math.max(peak, active); await new Promise(r => setTimeout(r, 1)); active--; if (slug === 'renamed') throw { status: 404 }; if (slug === 'err') throw { status: 500 }; return product; };
  const { found } = await loadCatalogHints(lines, fetchP, 2);
  assert.equal(found.length, 1); assert.ok(peak <= 2);
  const catalog = new Map(found.map(p => [p.id, p]));
  assert.deepEqual(unavailableFlags(lines, catalog), [false, true, false, false]);
  assert.equal(lineUnavailable(lines[2], new Map()), false);
});

// ---- three-step checkout --------------------------------------------------------------------------
import { STEPS, stepIndex, nextStep, prevStep, stepCaption, recipientErrors, recipientInput, checkoutRecipient, recipientPrefill, formatPhone, recipientLine, prepaymentMinorOf, prepaymentView, stepForError, canEnter, RECIPIENT_ERRORS, termsError, TERMS_ERROR, TERMS_HREF, TERMS_ACCEPTED_LINE, BUYER_NOTICE_TEXT, BUYER_NOTICE_HEADLINE } from '../../apps/web/src/cart/checkout-steps.js';
import { parsePrepaymentInput, PREPAYMENT_ERRORS } from '../../apps/web/src/cart/prepayment-input.js';
import { buildContactsBody } from '../../apps/web/src/delivery/profile-delivery.js';

test('steps: order, navigation bounds, captions and entry rules', () => {
  assert.deepEqual(STEPS.map(s => s.label), ['Кошик', 'Отримувач', 'Доставка']);
  assert.equal(nextStep('items'), 'recipient'); assert.equal(nextStep('recipient'), 'delivery'); assert.equal(nextStep('delivery'), 'delivery');
  assert.equal(prevStep('delivery'), 'recipient'); assert.equal(prevStep('items'), 'items'); assert.equal(stepIndex('nope'), 0);
  assert.equal(stepCaption('recipient'), 'Крок 2 з 3');
  const valid = { lastName: 'Коваль', firstName: 'Олена', middleName: 'Петрівна', phone: '050 123 45 67' };
  assert.equal(canEnter('items', { lineCount: 0, draft: {} }), true);
  assert.equal(canEnter('recipient', { lineCount: 0, draft: valid }), false, 'an empty cart cannot leave the first step');
  assert.equal(canEnter('recipient', { lineCount: 1, draft: {} }), true);
  assert.equal(canEnter('delivery', { lineCount: 1, draft: { ...valid, middleName: '' } }), false, 'delivery needs a complete recipient');
  assert.equal(canEnter('delivery', { lineCount: 1, draft: valid }), true);
});

test('recipient: per-field validation texts in form order, normalized input, signed-in only payload', () => {
  assert.deepEqual(Object.keys(RECIPIENT_ERRORS), ['lastName', 'firstName', 'middleName', 'phone']);
  const all = recipientErrors({ lastName: '', firstName: '', middleName: '', phone: '' });
  assert.deepEqual(Object.keys(all), ['lastName', 'firstName', 'middleName', 'phone'], 'first invalid field first, so it gets focus');
  assert.deepEqual(all, RECIPIENT_ERRORS);
  assert.deepEqual(recipientErrors({ lastName: 'Коваль1', firstName: 'Олена', middleName: 'П'.repeat(41), phone: '+38050123456' }), { lastName: RECIPIENT_ERRORS.lastName, middleName: RECIPIENT_ERRORS.middleName, phone: RECIPIENT_ERRORS.phone });
  assert.deepEqual(recipientErrors({}), RECIPIENT_ERRORS);
  const draft = { lastName: ' Коваль-Ліщук ', firstName: 'Мар\u02BCяна', middleName: 'Петрівна', phone: '(050) 123-45-67' };
  assert.deepEqual(recipientErrors(draft), {});
  assert.deepEqual(recipientInput(draft), { lastName: 'Коваль-Ліщук', firstName: 'Мар\u02BCяна', middleName: 'Петрівна', phone: '+380501234567' });
  assert.equal(recipientInput({ ...draft, phone: '123' }), null);
  assert.deepEqual(checkoutRecipient({ signed: true, draft }), recipientInput(draft));
  assert.equal(checkoutRecipient({ signed: false, draft }), null, 'anonymous: never sent');
  assert.equal(checkoutRecipient({ signed: null, draft }), null, 'unknown session: never sent');
  assert.equal(formatPhone('+380501234567'), '+380 50 123 45 67'); assert.equal(formatPhone('abc'), 'abc');
  assert.equal(recipientLine({ lastName: 'Коваль', firstName: 'Олена', middleName: 'Петрівна', phone: '+380501234567' }), 'Отримувач: Коваль Олена Петрівна, +380 50 123 45 67', 'entered draft');
  assert.equal(recipientLine({ lastName: 'Коваль', firstName: 'Олена', middleName: 'Петрівна', name: 'Коваль Олена Петрівна', phone: '+380501234567' }), 'Отримувач: Коваль Олена Петрівна, +380 50 123 45 67', 'stored cart');
  assert.equal(recipientLine({ lastName: null, firstName: null, middleName: null, name: 'Коваль Олена', phone: '+380501234567' }), 'Отримувач: Коваль Олена, +380 50 123 45 67', 'legacy single-field cart');
  assert.equal(recipientLine(null), ''); assert.equal(recipientLine({ lastName: 'Коваль', phone: '+380501234567' }), '');
});

test('recipient prefill from the profile: the three ПІБ parts and phone, never a guessed split, never after the customer typed', () => {
  const profile = { displayName: 'Інше Імʼя', lastName: 'Коваль', firstName: 'Олена', middleName: 'Петрівна', phone: '+380501234567' };
  assert.deepEqual(recipientPrefill(profile), { lastName: 'Коваль', firstName: 'Олена', middleName: 'Петрівна', phone: '0501234567' });
  assert.deepEqual(recipientPrefill({ lastName: null, firstName: 'Олена', middleName: null, phone: null }), { lastName: '', firstName: 'Олена', middleName: '', phone: '' });
  assert.equal(recipientPrefill({ displayName: 'Коваль Олена Петрівна', lastName: null, firstName: null, middleName: null, phone: null }), null, 'a single-field displayName is not split into parts');
  assert.deepEqual(recipientPrefill({ displayName: 'Коваль Олена Петрівна', phone: '+380501234567' }), { lastName: '', firstName: '', middleName: '', phone: '0501234567' });
  assert.equal(recipientPrefill(null), null);
  assert.equal(recipientPrefill(profile, true), null, 'touched fields are not overwritten');
});

test('checkout body carries the four recipient keys only when given; manager message lists the recipient before delivery', async () => {
  let sent;
  const fetchImpl = async (_path, init) => { sent = JSON.parse(init.body); return res(201, { cart: { code: 'SS-AAAA-BBBB' } }); };
  const recipient = { lastName: 'Коваль', firstName: 'Олена', middleName: 'Петрівна', phone: '+380501234567' };
  await checkout([{ productId: 'p1', size: 'M', quantity: 1, title: 'x' }], fetchImpl, { recipient: { ...recipient, name: 'ignored' } });
  assert.deepEqual(sent.recipient, recipient, 'exactly the four keys');
  await checkout([{ productId: 'p1', size: 'M', quantity: 1 }], fetchImpl, { recipient: null });
  assert.equal('recipient' in sent, false);
  await checkout([{ productId: 'p1', size: 'M', quantity: 1 }], fetchImpl, { recipient: { name: 'Коваль Олена', phone: '+380501234567' } });
  assert.equal('recipient' in sent, false, 'an incomplete recipient is not sent');
  const msg = managerMessage({ code: 'SS-AAAA-BBBB', totalMinor: 100, lines: [], recipient: { ...recipient, name: 'Коваль Олена Петрівна' }, delivery: { cityName: 'Київ', warehouseName: 'Відділення №1' } });
  assert.match(msg, /Отримувач: Коваль Олена Петрівна, \+380 50 123 45 67\nДоставка: Нова пошта, Київ, Відділення №1/);
  assert.match(managerMessage({ code: 'SS-AAAA-BBBB', totalMinor: 100, lines: [] }, undefined, null, { lastName: 'Анонім', firstName: 'Покупець', middleName: 'Іванович', phone: '+380671234567' }), /Отримувач: Анонім Покупець Іванович, \+380 67 123 45 67/);
  assert.match(managerMessage({ code: 'SS-AAAA-BBBB', totalMinor: 100, lines: [], recipient: { lastName: null, firstName: null, middleName: null, name: 'Стара Назва', phone: '+380671234567' } }), /Отримувач: Стара Назва, /);
  assert.equal(checkoutErrorText({ status: 400, code: 'invalid_recipient' }), 'Перевірте прізвище, імʼя, по батькові та номер телефону отримувача.');
});

test('a failed checkout returns to the step that needs attention', () => {
  assert.equal(stepForError({ status: 400, code: 'invalid_recipient' }), 'recipient');
  assert.equal(stepForError({ status: 409, code: 'delivery_unavailable' }), 'delivery');
  assert.equal(stepForError({ status: 503, code: 'delivery_catalog_unavailable' }), 'delivery');
  assert.equal(stepForError({ status: 409, code: 'cart_unavailable', problems: [{ index: 0, code: 'insufficient_stock' }] }), 'items');
  assert.equal(stepForError({ status: 400, code: 'invalid_cart', problems: [] }), 'items');
  assert.equal(stepForError({ status: 429 }, 'delivery'), 'delivery');
  assert.equal(stepForError({ status: 0 }, 'delivery'), 'delivery');
});

test('prepayment: public setting, hidden at 0, remainder only for a priced cart above it', () => {
  assert.equal(prepaymentMinorOf({ checkout: { prepaymentMinor: 20000 } }), 20000);
  for (const bad of [{}, null, { checkout: { prepaymentMinor: 0 } }, { checkout: { prepaymentMinor: -5 } }, { checkout: { prepaymentMinor: '200' } }, { checkout: { prepaymentMinor: 1.5 } }]) assert.equal(prepaymentMinorOf(bad), 0, JSON.stringify(bad));
  assert.equal(prepaymentView(0, 100000, true), null);
  assert.deepEqual(prepaymentView(20000, 150000, true), { prepaymentMinor: 20000, remainderMinor: 130000 });
  assert.deepEqual(prepaymentView(20000, 150000, false), { prepaymentMinor: 20000, remainderMinor: null }, 'unpriced cart: no remainder');
  assert.deepEqual(prepaymentView(20000, 20000, true), { prepaymentMinor: 20000, remainderMinor: null });
  assert.deepEqual(prepaymentView(20000, 10000, true), { prepaymentMinor: 20000, remainderMinor: null });
});

test('admin prepayment input converts UAH to kopecks with integer math', () => {
  assert.deepEqual(parsePrepaymentInput(''), { ok: true, minor: 0 });
  assert.deepEqual(parsePrepaymentInput('0'), { ok: true, minor: 0 });
  assert.deepEqual(parsePrepaymentInput('0,00'), { ok: true, minor: 0 });
  assert.deepEqual(parsePrepaymentInput('200'), { ok: true, minor: 20000 });
  assert.deepEqual(parsePrepaymentInput('199,99'), { ok: true, minor: 19999 });
  assert.deepEqual(parsePrepaymentInput('1 000'), { ok: true, minor: 100000 });
  assert.deepEqual(parsePrepaymentInput('100000'), { ok: true, minor: 10000000 });
  assert.deepEqual(parsePrepaymentInput('100000.01'), { ok: false, error: PREPAYMENT_ERRORS.max });
  assert.deepEqual(parsePrepaymentInput('1.234'), { ok: false, error: PREPAYMENT_ERRORS.decimals });
  for (const bad of ['abc', '-5', '1e3', '2..0']) assert.equal(parsePrepaymentInput(bad).ok, false, bad);
});

test('profile contacts body: trimmed values, empty clears', () => {
  assert.deepEqual(buildContactsBody({ lastName: ' Коваль ', firstName: 'Олена', middleName: ' Петрівна ', phone: ' 050 123 45 67 ' }), { lastName: 'Коваль', firstName: 'Олена', middleName: 'Петрівна', phone: '050 123 45 67' });
  assert.deepEqual(buildContactsBody({ lastName: '', firstName: ' ', middleName: '', phone: '   ' }), { lastName: null, firstName: null, middleName: null, phone: null }, 'displayName is never sent: the card no longer edits it');
});

test('the recipient draft never reaches the browser cart storage', async () => {
  const { readFile } = await import('node:fs/promises');
  const page = await readFile(resolve('apps/web/src/cart/CartPage.jsx'), 'utf8'), steps = await readFile(resolve('apps/web/src/cart/checkout-steps.js'), 'utf8');
  for (const text of [page, steps]) assert.doesNotMatch(text, /localStorage|sessionStorage|indexedDB/);
  const storage = memoryStorage(), store = createCartStore(() => storage);
  store.addProduct(product, 'L');
  store.completeCheckout({ code: 'SS-ABCD-2345', createdAt: '', itemCount: 1, totalMinor: 1, recipient: { lastName: 'Коваль', firstName: 'Олена', middleName: 'Петрівна', name: 'Коваль Олена Петрівна', phone: '+380501234567' } }, store.snapshot());
  assert.doesNotMatch(storage.map.get(LOCAL_CART_KEY), /Коваль|Петрівна|380501234567/, 'completed checkouts keep no recipient in recent codes');
});

test('terms gate and manager-message line; the checkout body is unchanged', async () => {
  assert.equal(termsError(true), '');
  for (const v of [false, undefined, null, 'true', 1]) assert.equal(termsError(v), TERMS_ERROR, String(v));
  assert.equal(TERMS_HREF, '/#delivery');
  assert.match(BUYER_NOTICE_TEXT, /тестовий текст попередження для покупця\.$/);
  const cart = { code: 'SS-AAAA-BBBB', totalMinor: 100, lines: [] };
  assert.doesNotMatch(managerMessage(cart), /Умови/, 'opt-in only');
  assert.match(managerMessage(cart, undefined, { cityName: 'Київ', warehouseName: 'Відділення №1' }, null, true), /Доставка: Нова пошта, Київ, Відділення №1\nУмови оплати та доставки прийнято\.\nБудь ласка, перевірте замовлення\.$/);
  assert.equal(TERMS_ACCEPTED_LINE, 'Умови оплати та доставки прийнято.');
  const { readFile } = await import('node:fs/promises');
  const page = await readFile(resolve('apps/web/src/cart/CartPage.jsx'), 'utf8');
  assert.match(page, /if \(termsError\(terms\)\) \{ setShowTermsError\(true\); termsRef\.current\?\.focus\(\); return; \}/, 'submit() itself is gated, so «Оформити без пункту» is too');
  assert.match(page, /checkout\(submitted, undefined, \{ delivery, recipient \}\)/, 'the checkout body carries no terms field');
});

test('the buyer warning sits at the top of the items step and changes neither navigation nor the message', async () => {
  assert.equal(BUYER_NOTICE_HEADLINE, 'Тестове попередження');
  assert.equal(BUYER_NOTICE_TEXT, 'Лорем іпсум — тестовий текст попередження для покупця.');
  const { readFile } = await import('node:fs/promises');
  const page = await readFile(resolve('apps/web/src/cart/CartPage.jsx'), 'utf8');
  assert.match(page, /\{step === 'items' && <>\n\s*<BuyerNotice\/>\n\s*<ul className="cart-lines">/, 'above the lines, on the first step only');
  assert.match(page, /function go\(id\) \{ if \(busy \|\| !canEnter\(id, \{ lineCount: cart\.lines\.length, draft \}\)\) return;/, 'step navigation is unchanged');
  assert.doesNotMatch(managerMessage({ code: 'SS-AAAA-BBBB', totalMinor: 1, lines: [] }, undefined, null, null, true), /тестовий текст попередження/i, 'no manager-message line');
  const css = await readFile(resolve('apps/web/src/cart/checkout.css'), 'utf8');
  assert.doesNotMatch(css, /checkout-buyer-note/, 'the calm note style is gone');
  assert.match(css, /\.checkout-warning\{[^}]*border-left:var\(--space-1\) solid var\(--lime\);background:var\(--graphite-900\);color:var\(--cream-50\)/);
});
