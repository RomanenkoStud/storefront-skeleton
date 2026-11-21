import assert from 'node:assert/strict';
import { mkdir, mkdtemp, writeFile, rm } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { build } from 'vite';
import {
  parseLookup, listPath, pageCount, PAGE_SIZE, STATUS_FILTERS, statusLabel, errorText,
  groupBySupplier, supplierSummary, changeStatus, loadCart, listCarts, visibleActions, canOperate,
  recipientView, deliveryView, recipientShort, deliveryShort, isErased, PD_ERASED_LABEL, RETENTION_HINT, ACTION_LABELS,
} from '../../apps/web/src/orders/orders-logic.js';

// lookup normalization
assert.deepEqual(parseLookup(' ss 7k2m-9qxd '), { code: 'SS-7K2M-9QXD' });
assert.deepEqual(parseLookup('7k2m9qxd'), { code: 'SS-7K2M-9QXD' });
assert.deepEqual(parseLookup('SS-OIL0-0000'), { code: 'SS-0110-0000' });
assert.ok(parseLookup('').error && parseLookup('nope').error && parseLookup('SS-UUUU-UUUU').error);

// list filter/pagination
assert.equal(PAGE_SIZE, 40);
assert.equal(listPath(), '/api/admin/carts?page=1');
assert.equal(listPath({ status: 'verified', q: ' Ann ', page: 3 }), '/api/admin/carts?status=verified&q=Ann&page=3');
assert.equal(listPath({ status: 'bogus', page: 0 }), '/api/admin/carts?page=1');
assert.equal(pageCount(0), 1); assert.equal(pageCount(40), 1); assert.equal(pageCount(41), 2);
assert.deepEqual(STATUS_FILTERS.map(f => f[0]), ['', 'submitted', 'verified', 'sent_to_suppliers', 'completed', 'cancelled']);
assert.equal(statusLabel('cancelled'), 'Скасовано'); assert.equal(statusLabel('completed'), 'Виконано');
assert.equal(STATUS_FILTERS.find(f => f[0] === 'completed')[1], 'Виконано');
assert.equal(ACTION_LABELS.completed, 'Позначити як виконане');

// order personal data
const RECIPIENT = { lastName: 'Коваль', firstName: 'Олена', middleName: 'Петрівна', name: 'Коваль Олена Петрівна', phone: '+380501234567' };
const POINT = { type: 'postomat', cityName: 'Київ', warehouseNumber: '1001', warehouseName: 'Поштомат №1001: вул. Сімʼї Кульженків, 31а' };
assert.deepEqual(recipientView(RECIPIENT), { name: 'Коваль Олена Петрівна', phone: '+380 50 123 45 67', tel: '+380501234567' });
assert.deepEqual(recipientView({ lastName: null, firstName: null, middleName: null, name: 'Стара Назва', phone: '+380671234567' }).name, 'Стара Назва', 'legacy single name');
assert.equal(recipientView(null), null); assert.equal(recipientView({ name: 'X' }), null);
assert.deepEqual(deliveryView(POINT), { kind: 'Поштомат №1001', city: 'Київ', name: POINT.warehouseName });
assert.deepEqual(deliveryView({ type: 'branch', cityName: 'Львів', warehouseNumber: '5', warehouseName: null }), { kind: 'Відділення №5', city: 'Львів', name: '' });
assert.equal(deliveryView(null), null);
assert.equal(recipientShort({ recipient: RECIPIENT }), 'Коваль Олена Петрівна, +380 50 123 45 67'); assert.equal(deliveryShort({ delivery: POINT }), 'Поштомат №1001, Київ');
assert.equal(recipientShort({}), '—'); assert.equal(deliveryShort({ delivery: null }), '—');
assert.equal(isErased({ personalDataErasedAt: '2026-12-01T00:00:00.000Z' }), true); assert.equal(recipientShort({ personalDataErasedAt: 'x', recipient: RECIPIENT }), 'Видалено');
assert.equal(PD_ERASED_LABEL, 'Персональні дані видалено (термін зберігання)');
assert.match(RETENTION_HINT, /14 днів .*«Виконано» або «Скасовано».*90 днів/);

// grouping
const cart = { code: 'SS-7K2M-9QXD', currency: 'UAH', status: 'submitted', allowedTransitions: ['verified', 'cancelled'], lines: [
  { title: 'A', size: 'M', quantity: 2, unitPriceMinor: 10000, unitCostMinor: 6000, supplierId: 's1', supplierName: 'Alpha', externalProductId: 'X1', variantIds: ['v1', 'v2'] },
  { title: 'B', size: 'L', quantity: 1, unitPriceMinor: 5000, unitCostMinor: null, supplierId: 's2', supplierName: 'Beta', externalProductId: 'Y1', variantIds: ['v3'] },
  { title: 'C', size: 'S', quantity: 1, unitPriceMinor: 5000, unitCostMinor: 1000, supplierId: 's1', supplierName: 'Alpha', externalProductId: 'X2', variantIds: [] },
] };
const groups = groupBySupplier(cart.lines);
assert.deepEqual(groups.map(g => [g.supplierName, g.lines.length, g.quantity]), [['Alpha', 2, 3], ['Beta', 1, 1]]);
assert.equal(groups[0].costMinor, 13000); assert.equal(groups[1].costKnown, false);
const text = supplierSummary(groups[0], cart);
assert.doesNotMatch(text, /100\.00|ціна/i);
assert.match(text, /Закупівля: 60\.00/);
assert.match(text, /SS-7K2M-9QXD — Alpha/); assert.match(text, /X1/); assert.match(text, /v1, v2/); assert.match(text, /кількість: 2/);
assert.match(supplierSummary(groups[1], cart), /невідомо/);

// permissions
assert.deepEqual(visibleActions(cart, ['orders.read', 'orders.operate']), ['verified', 'cancelled']);
assert.deepEqual(visibleActions(cart, ['orders.read']), []);
assert.deepEqual(visibleActions({ ...cart, status: 'sent_to_suppliers', allowedTransitions: ['completed'] }, ['orders.read', 'orders.operate']), ['completed'], 'completed has a label, so its button is shown');
assert.equal(canOperate(['orders.read']), false);

// transitions + transport
const originalFetch = globalThis.fetch, originalLocation = globalThis.location;
globalThis.location = { pathname: '/staff' };
const calls = [];
const json = (status, body) => new Response(JSON.stringify(body), { status });
try {
  globalThis.fetch = async (path, options = {}) => { calls.push({ path, options }); return json(200, { cart: { ...cart, status: 'verified' }, carts: [], total: 0 }); };
  await listCarts({ status: 'submitted' });
  assert.equal(calls[0].path, '/api/staff/admin/carts?status=submitted&page=1');
  await loadCart('SS-7K2M-9QXD');
  assert.equal(calls[1].path, '/api/staff/admin/carts/SS-7K2M-9QXD');
  const ok = await changeStatus(cart, 'verified', '  ok  ');
  assert.equal(calls[2].path, '/api/staff/admin/carts/SS-7K2M-9QXD/status');
  assert.equal(calls[2].options.method, 'POST');
  assert.deepEqual(JSON.parse(calls[2].options.body), { status: 'verified', expectedStatus: 'submitted', note: 'ok' });
  assert.equal(ok.cart.status, 'verified'); assert.equal(ok.conflict, undefined);
  await changeStatus(cart, 'cancelled');
  assert.deepEqual(JSON.parse(calls[3].options.body), { status: 'cancelled', expectedStatus: 'submitted' });
  await changeStatus(cart, 'cancelled', 'x'.repeat(900));
  assert.equal(JSON.parse(calls[4].options.body).note.length, 500);

  // 409: reload and surface current state
  const seen = [];
  globalThis.fetch = async (path, options = {}) => {
    seen.push(`${options.method || 'GET'} ${path}`);
    return options.method === 'POST' ? json(409, { error: 'status_conflict', currentStatus: 'cancelled' }) : json(200, { cart: { ...cart, status: 'cancelled', allowedTransitions: [] } });
  };
  const conflict = await changeStatus(cart, 'verified');
  assert.equal(conflict.conflict, true); assert.equal(conflict.cart.status, 'cancelled');
  assert.deepEqual(seen, ['POST /api/staff/admin/carts/SS-7K2M-9QXD/status', 'GET /api/staff/admin/carts/SS-7K2M-9QXD']);

  // other errors propagate with Ukrainian text
  globalThis.fetch = async () => json(404, { error: 'not_found' });
  await assert.rejects(() => changeStatus(cart, 'verified'), e => e.status === 404 && errorText(e) === 'Кошик із таким кодом не знайдено.');
} finally { globalThis.fetch = originalFetch; globalThis.location = originalLocation; }

// server-rendered views (bundle React once so hooks and renderer share a copy)
// Inside the repo (gitignored node_modules) so react resolves the same way on CI.
const cacheRoot = resolve('node_modules/.cache');
await mkdir(cacheRoot, { recursive: true });
const dir = await mkdtemp(join(cacheRoot, 'orders-view-'));
try {
  const entry = join(dir, 'entry.jsx');
  const panel = resolve('apps/web/src/orders/OrdersPanel.jsx').replaceAll('\\', '/');
  await writeFile(entry, `import React from 'react';import {renderToStaticMarkup} from 'react-dom/server';import {CartDetail} from '${panel}';export const view=(cart,permissions)=>renderToStaticMarkup(<CartDetail cart={cart} permissions={permissions} onChange={()=>{}} onBack={()=>{}}/>);`);
  const out = join(dir, 'out.cjs');
  await build({ root: dir, configFile: false, logLevel: 'silent', esbuild: { jsx: 'automatic' }, resolve: { alias: {} }, ssr: { noExternal: true }, build: { ssr: entry, outDir: dir, emptyOutDir: false, minify: false, rollupOptions: { output: { format: 'cjs', entryFileNames: 'out.cjs' } } } });
  const { view } = (await import(pathToFileURL(out).href)).default;
  const full = { ...cart, itemCount: 4, totalMinor: 25000, bound: true, createdAt: '2026-01-01T10:00:00Z', customerEmail: 'secret@example.test', customerName: 'Hidden Person' };
  const operate = view(full, ['orders.read', 'orders.operate']);
  assert.match(operate, /Перевірити/); assert.match(operate, /Скасувати кошик/); assert.match(operate, /Alpha/); assert.match(operate, /Beta/);
  assert.match(operate, /Копіювати для Alpha/); assert.match(operate, /Прив’язано до профілю/); assert.match(operate, /maxLength="500"/);
  assert.doesNotMatch(operate, /secret@example\.test|Hidden Person/);
  const readOnly = view(full, ['orders.read']);
  assert.match(readOnly, /Лише перегляд: змінювати статус може менеджер або власник\./);
  assert.doesNotMatch(readOnly, /Перевірити|Скасувати кошик|orders\.operate|<textarea[^>]*maxLength/);
  assert.match(readOnly, /Копіювати для Alpha/);
  const terminal = view({ ...full, status: 'cancelled', allowedTransitions: [] }, ['orders.read', 'orders.operate']);
  assert.match(terminal, /подальших дій немає/); assert.doesNotMatch(terminal, /Перевірити|Скасувати кошик<\/button>/);
  // the order's recipient and point are shown to every orders.read principal; never account data.
  const personal = { ...full, recipient: RECIPIENT, delivery: POINT, personalDataErasedAt: null };
  for (const permissions of [['orders.read', 'orders.operate'], ['orders.read']]) {
    const html = view(personal, permissions);
    assert.match(html, /<dt>Отримувач<\/dt><dd>Коваль Олена Петрівна<br\/><a href="tel:\+380501234567">\+380 50 123 45 67<\/a><\/dd>/);
    assert.match(html, /<dt>Доставка<\/dt><dd>Поштомат №1001, Київ<br\/><span class="orders-point-name">Поштомат №1001: вул\. Сімʼї Кульженків, 31а<\/span><\/dd>/);
    assert.match(html, /видаляються через 14 днів/);
    assert.doesNotMatch(html, /secret@example\.test|Hidden Person|персональні дані тут не показуються/);
  }
  assert.match(view(personal, ['orders.read', 'orders.operate']), /Не записуйте в нотатку ПІБ, телефон чи адресу клієнта/);
  const erased = view({ ...personal, recipient: null, delivery: null, personalDataErasedAt: '2026-12-15T10:00:00.000Z', status: 'completed', allowedTransitions: [] }, ['orders.read']);
  assert.match(erased, /Персональні дані видалено \(термін зберігання\)/); assert.doesNotMatch(erased, /Коваль|Поштомат|<dt>Отримувач|видаляються через/);
  assert.match(erased, /Виконано/);
  const anonymous = view({ ...full, bound: false, recipient: null, delivery: null, personalDataErasedAt: null }, ['orders.read']);
  assert.match(anonymous, /Не вказано: оформлено без входу/); assert.doesNotMatch(anonymous, /Персональні дані видалено|видаляються через/);
  const sent = view({ ...personal, status: 'sent_to_suppliers', allowedTransitions: ['completed'] }, ['orders.read', 'orders.operate']);
  assert.match(sent, /Позначити як виконане/); assert.doesNotMatch(sent, /Скасувати кошик<\/button>/);
} finally { await rm(dir, { recursive: true, force: true }); }
console.log('Manager orders frontend tests passed');
