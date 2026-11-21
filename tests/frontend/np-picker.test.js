import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, writeFile, rm } from 'node:fs/promises';
import { join, resolve, dirname } from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
import { build } from 'vite';
import { createNpApi, NpApiError, UNAVAILABLE_TEXT } from '../../apps/web/src/delivery/np-api.js';
import {
  createPickerController, browserGeo, filterPoints, haversineKm, formatDistance, sortByDistance, nextIndex, normalizeText, queryLongEnough,
  toPickerValue, fromPreference, fromCartDelivery, toDeliveryInput, valueSummary, MESSAGES, DEBOUNCE_MS, PAGE_SIZE, GEO_OPTIONS,
} from '../../apps/web/src/delivery/np-picker-logic.js';
import { saveDeliveryPreference, fetchProfile, buildPreferenceBody } from '../../apps/web/src/delivery/profile-delivery.js';

// ---- fixtures built from the docs/API.md shapes ------------------------------------------------------------
const KYIV = { ref: '8d5a980d-391c-11dd-90d9-001a92567626', name: 'Київ', area: 'Київська', branches: 120, postomats: 60 };
const LVIV = { ref: 'db5c88f5-391c-11dd-90d9-001a92567626', name: 'Львів', area: 'Львівська', branches: 40, postomats: 0 };
const guid = (prefix, i) => `${prefix}${String(i).padStart(7, '0')}-76b4-11eb-ac16-b8830365bd14`;
const branchPoints = Array.from({ length: 120 }, (_, i) => ({
  ref: guid('b', i + 1), number: String(i + 1), name: `Відділення №${i + 1}: вул. Тестова, ${i + 1}`,
  lat: (i + 1) % 10 === 0 ? null : 50.4 + (i + 1) * 0.001, lon: (i + 1) % 10 === 0 ? null : 30.5,
}));
const postomatPoints = Array.from({ length: 60 }, (_, i) => ({ ref: guid('c', i + 1), number: String(1000 + i), name: `Поштомат "Нова Пошта" №${1000 + i}: вул. Сімʼї Кульженків, ${i}`, lat: 50.5 + i * 0.0001, lon: 30.4 }));
const noCoordinates = [{ ref: guid('d', 1), number: '1', name: 'Відділення №1: без координат', lat: null, lon: null }];

const GENERATED_AT = '2026-11-17T00:30:00.000Z';
const res = (status, body, headers = {}) => ({ ok: status < 400, status, json: async () => body, headers: { get: k => headers[k] ?? null } });
const flush = async () => { for (let i = 0; i < 5; i++) await new Promise(r => setImmediate(r)); };

function clock() {
  let now = 0, id = 0; const timers = new Map();
  return {
    setTimeout(fn, ms) { timers.set(++id, { fn, at: now + ms }); return id; },
    clearTimeout(i) { timers.delete(i); },
    advance(ms) { now += ms; for (const [i, t] of [...timers]) if (t.at <= now) { timers.delete(i); t.fn(); } },
    pending: () => timers.size,
  };
}

/** Mocked server. `overrides` may replace a route result; every call is recorded with its url and init. */
function mockFetch({ cities = [KYIV, LVIV], points = {}, fail = null } = {}) {
  const calls = [];
  const fetch = async (url, init = {}) => {
    calls.push({ url: String(url), init });
    if (fail) return fail(String(url), init);
    const u = new URL(url, 'http://x');
    if (u.pathname === '/api/delivery/np/cities') {
      const q = u.searchParams.get('q').toLowerCase();
      return res(200, { generatedAt: GENERATED_AT, items: cities.filter(c => c.name.toLowerCase().startsWith(q)) });
    }
    const cityRef = u.searchParams.get('cityRef'), kind = u.searchParams.get('kind');
    const defaults = { [`${KYIV.ref}|branch`]: branchPoints, [`${KYIV.ref}|postomat`]: postomatPoints, [`${LVIV.ref}|branch`]: noCoordinates };
    return res(200, { cityRef, kind, generatedAt: GENERATED_AT, items: points[`${cityRef}|${kind}`] ?? defaults[`${cityRef}|${kind}`] ?? [] });
  };
  fetch.calls = calls;
  fetch.cityCalls = () => calls.filter(c => c.url.includes('/np/cities'));
  fetch.pointCalls = () => calls.filter(c => c.url.includes('/np/warehouses'));
  return fetch;
}
const geoOk = (latitude, longitude) => ({ getCurrentPosition: (ok, _bad, options) => { geoOk.lastOptions = options; ok({ coords: { latitude, longitude } }); } });
const geoFail = code => ({ getCurrentPosition: (_ok, bad) => bad({ code }) });
const SECURE = geolocation => ({ secure: true, geolocation });

function setup({ fetch = mockFetch(), geo = null, initial = null } = {}) {
  const clk = clock();
  const controller = createPickerController({ initial, api: createNpApi(fetch), timers: clk, geo });
  return { controller, clk, fetch };
}
async function openKyivBranches(opts) {
  const ctx = setup(opts);
  ctx.controller.setQuery('Київ'); ctx.clk.advance(DEBOUNCE_MS); await flush();
  await ctx.controller.pickCity(ctx.controller.getState().cities[0]);
  return ctx;
}

// ---- np-api ----------------------------------------------------------------------------------------------------
test('np-api builds same-origin GET URLs and returns documented bodies', async () => {
  const fetch = mockFetch(); const api = createNpApi(fetch);
  const cities = await api.searchCities('Камʼянське');
  assert.equal(fetch.calls[0].url, `/api/delivery/np/cities?q=${encodeURIComponent('Камʼянське')}`);
  assert.equal(fetch.calls[0].init.method, 'GET'); assert.equal(fetch.calls[0].init.body, undefined);
  assert.equal(cities.generatedAt, GENERATED_AT);
  const pts = await api.loadPoints(KYIV.ref, 'postomat');
  assert.equal(fetch.calls[1].url, `/api/delivery/np/warehouses?cityRef=${KYIV.ref}&kind=postomat`);
  assert.equal(pts.items.length, 60);
});

test('np-api maps every error code to a fixed Ukrainian message, never server text', async () => {
  const cases = [
    [503, 'catalog_unavailable', true, UNAVAILABLE_TEXT], [400, 'invalid_request', false, 'Перевірте запит і спробуйте ще раз.'],
    [404, 'not_found', false, 'Не вдалося завантажити дані. Спробуйте ще раз.'], [405, 'method_not_allowed', false, 'Не вдалося завантажити дані. Спробуйте ще раз.'],
    [500, 'boom <script>', false, 'Не вдалося завантажити дані. Спробуйте ще раз.'], [503, '', true, UNAVAILABLE_TEXT],
  ];
  for (const [status, code, unavailable, text] of cases) {
    const api = createNpApi(async () => res(status, { error: code }));
    for (const call of [() => api.searchCities('ки'), () => api.loadPoints(KYIV.ref, 'branch')]) {
      await assert.rejects(call, e => e instanceof NpApiError && e.status === status && e.unavailable === unavailable && e.message === text);
    }
  }
  const net = createNpApi(async () => { throw new TypeError('Failed to fetch'); });
  await assert.rejects(net.searchCities('ки'), e => e.unavailable && e.code === 'network' && e.message === UNAVAILABLE_TEXT);
  const garbled = createNpApi(async () => ({ ok: true, status: 200, json: async () => { throw new Error('x'); } }));
  await assert.rejects(garbled.loadPoints(KYIV.ref, 'branch'), e => e.unavailable);
  const abortApi = createNpApi(async () => { throw Object.assign(new Error('a'), { name: 'AbortError' }); });
  await assert.rejects(abortApi.searchCities('ки'), e => e.name === 'AbortError');
});

// ---- search: debounce, minimum length, stale responses ------------------------------------------------------------
test('city search honours the 350 ms debounce and the 2 character minimum', async () => {
  const { controller, clk, fetch } = setup();
  controller.setQuery('к'); clk.advance(5000); await flush();
  assert.equal(fetch.cityCalls().length, 0); assert.equal(clk.pending(), 0);
  controller.setQuery('  к '); clk.advance(5000); await flush();
  assert.equal(fetch.cityCalls().length, 0, 'whitespace does not count');
  controller.setQuery('ки'); clk.advance(DEBOUNCE_MS - 1); await flush();
  assert.equal(fetch.cityCalls().length, 0);
  controller.setQuery('киї'); clk.advance(DEBOUNCE_MS - 1); assert.equal(fetch.cityCalls().length, 0, 'typing restarts the debounce');
  clk.advance(1); await flush();
  assert.equal(fetch.cityCalls().length, 1);
  assert.match(fetch.cityCalls()[0].url, /q=%D0%BA%D0%B8%D1%97$/);
  assert.equal(DEBOUNCE_MS, 350); assert.ok(queryLongEnough('ки')); assert.ok(!queryLongEnough('к '));
  controller.setQuery('к'); assert.equal(controller.getState().cities.length, 0, 'dropping below the minimum clears the list');
});

test('stale city responses are discarded and the superseded request is aborted', async () => {
  const pending = [];
  const fetch = (url, init) => new Promise(resolveFetch => pending.push({ url, init, resolveFetch }));
  const clk = clock(); const controller = createPickerController({ api: createNpApi(fetch), timers: clk, geo: null });
  controller.setQuery('ки'); clk.advance(DEBOUNCE_MS);
  controller.setQuery('киї'); clk.advance(DEBOUNCE_MS);
  assert.equal(pending.length, 2); assert.equal(pending[0].init.signal.aborted, true); assert.equal(pending[1].init.signal.aborted, false);
  pending[1].resolveFetch(res(200, { generatedAt: GENERATED_AT, items: [KYIV] })); await flush();
  pending[0].resolveFetch(res(200, { generatedAt: GENERATED_AT, items: [LVIV] })); await flush();
  assert.deepEqual(controller.getState().cities, [KYIV]);
  assert.equal(controller.getState().announcement, 'Знайдено міст: 1.');
});

test('a late city response after a city was chosen does not reopen the list', async () => {
  const pending = []; const base = mockFetch();
  const fetch = (url, init) => (url.includes('/np/cities') ? new Promise(r => pending.push(r)) : base(url, init));
  const clk = clock(); const controller = createPickerController({ api: createNpApi(fetch), timers: clk, geo: null });
  controller.setQuery('ки'); clk.advance(DEBOUNCE_MS);
  await controller.pickCity(KYIV);
  pending[0](res(200, { generatedAt: GENERATED_AT, items: [LVIV] })); await flush();
  assert.equal(controller.getState().citiesOpen, false); assert.equal(controller.getState().city.ref, KYIV.ref);
});

// ---- points: one load per key, filter, paging -----------------------------------------------------------------------
test('a point list is loaded once per (cityRef, kind), including concurrent switches', async () => {
  const { controller, fetch } = await openKyivBranches();
  assert.equal(fetch.pointCalls().length, 1);
  await controller.setKind('postomat'); await controller.setKind('branch'); await controller.setKind('postomat');
  assert.equal(fetch.pointCalls().length, 2);
  await controller.pickCity(LVIV); await controller.pickCity(KYIV);
  assert.equal(fetch.pointCalls().filter(c => c.url.includes(LVIV.ref)).length, 1);
  assert.equal(fetch.pointCalls().filter(c => c.url.includes(KYIV.ref)).length, 2);
  // A -> B -> A while A is still loading must not issue a second request for A.
  const slow = []; const fetch2 = (url) => new Promise(r => slow.push({ url, r }));
  const c2 = createPickerController({ api: createNpApi(fetch2), timers: clock(), geo: null });
  c2.pickCity(KYIV); c2.setKind('postomat'); c2.setKind('branch');
  assert.equal(slow.length, 2);
  slow[0].r(res(200, { items: branchPoints })); slow[1].r(res(200, { items: postomatPoints })); await flush();
  assert.equal(c2.getState().kind, 'branch'); assert.equal(c2.getState().pointsStatus, 'ready'); assert.equal(c2.getState().points.length, 120);
});

test('a city with only one kind starts on that kind', async () => {
  const { controller } = setup();
  await controller.pickCity({ ...LVIV, branches: 0, postomats: 3 });
  assert.equal(controller.getState().kind, 'postomat');
});

test('points are filtered locally by number or name and paged by 50', async () => {
  const { controller, fetch } = await openKyivBranches();
  let v = controller.view();
  assert.equal(v.total, 120); assert.equal(v.shown, PAGE_SIZE); assert.equal(v.hasMore, true);
  controller.showMore(); assert.equal(controller.view().shown, 100); assert.match(controller.getState().announcement, /Показано пунктів: 100 з 120/);
  controller.showMore(); v = controller.view(); assert.equal(v.shown, 120); assert.equal(v.hasMore, false);
  controller.setFilter('№17'); v = controller.view();
  assert.deepEqual(v.rows.map(r => r.point.number), ['17', '117']);
  controller.setFilter('тестова, 5'); assert.ok(controller.view().rows.every(r => r.point.name.includes('Тестова, 5')));
  assert.equal(controller.view().shown <= PAGE_SIZE, true, 'filter resets the page');
  controller.setFilter('немає такого'); assert.equal(controller.view().total, 0);
  controller.announceFilter(); assert.equal(controller.getState().announcement, MESSAGES.noPoints);
  assert.equal(fetch.pointCalls().length, 1, 'filtering never hits the network');
  assert.equal(filterPoints([{ number: null, name: 'Кам\'янське' }], 'КАМʼЯНСЬКЕ').length, 1);
  assert.equal(filterPoints(branchPoints, '  ').length, 120);
});

// ---- geometry ----------------------------------------------------------------------------------------------------------
test('haversine, null coordinates last, stable order and distance format', () => {
  const km = haversineKm({ lat: 50.4501, lon: 30.5234 }, { lat: 49.8397, lon: 24.0297 });
  assert.ok(Math.abs(km - 467.5) / 467.5 < 0.005, `Kyiv-Lviv ${km}`);
  assert.equal(haversineKm({ lat: 50, lon: 30 }, { lat: 50, lon: 30 }), 0);
  const pts = [{ ref: 'a', lat: null, lon: null }, { ref: 'b', lat: 50.0, lon: 30.0 }, { ref: 'c', lat: 50.01, lon: 30.0 }, { ref: 'd', lat: null, lon: 30 }, { ref: 'e', lat: 50.0, lon: 30.0 }];
  const sorted = sortByDistance(pts, { lat: 50.011, lon: 30.0 });
  assert.deepEqual(sorted.map(r => r.point.ref), ['c', 'b', 'e', 'a', 'd']);
  assert.ok(sorted[3].km === null && sorted[4].km === null);
  assert.equal(formatDistance(0.85), '≈ 850 м'); assert.equal(formatDistance(1.2), '≈ 1,2 км'); assert.equal(formatDistance(0.9996), '≈ 1 км');
  assert.equal(formatDistance(12.4), '≈ 12 км'); assert.equal(formatDistance(null), ''); assert.equal(formatDistance(Number.NaN), '');
});

// ---- unavailable / errors ----------------------------------------------------------------------------------------------------
test('503 and network failure disable the picker with the fixed message, and retry recovers', async () => {
  let up = false;
  const good = mockFetch();
  const fetch = async (url, init) => (up ? good(url, init) : res(503, { error: 'catalog_unavailable' }));
  const { controller, clk } = (() => { const clk = clock(); return { clk, controller: createPickerController({ api: createNpApi(fetch), timers: clk, geo: null }) }; })();
  controller.setQuery('Київ'); clk.advance(DEBOUNCE_MS); await flush();
  let s = controller.getState();
  assert.equal(s.unavailable, true); assert.equal(s.error, 'Довідник Нової пошти зараз недоступний.'); assert.equal(s.announcement, s.error); assert.equal(s.citiesOpen, false);
  up = true; controller.retry(); await flush();
  s = controller.getState(); assert.equal(s.unavailable, false); assert.equal(s.cities.length, 1);
  // network failure while loading points
  const flaky = { down: false }; const fetch3 = async (u, i) => { if (flaky.down) throw new TypeError('offline'); return good(u, i); };
  const c3 = createPickerController({ api: createNpApi(fetch3), timers: clock(), geo: null });
  flaky.down = true; await c3.pickCity(KYIV);
  assert.equal(c3.getState().unavailable, true); assert.equal(c3.getState().error, UNAVAILABLE_TEXT);
  flaky.down = false; await c3.retry();
  assert.equal(c3.getState().unavailable, false); assert.equal(c3.getState().pointsStatus, 'ready');
});

test('a non-503 error shows its fixed text without disabling the picker', async () => {
  const fetch = async () => res(400, { error: 'invalid_request' });
  const clk = clock(); const controller = createPickerController({ api: createNpApi(fetch), timers: clk, geo: null });
  controller.setQuery('ки'); clk.advance(DEBOUNCE_MS); await flush();
  assert.equal(controller.getState().unavailable, false); assert.equal(controller.getState().error, 'Перевірте запит і спробуйте ще раз.');
});

// ---- geolocation -------------------------------------------------------------------------------------------------------------------------
test('geolocation success sorts by distance, resets on city/kind change, and never leaks coordinates', async () => {
  const stored = []; const originals = {};
  for (const name of ['localStorage', 'sessionStorage']) { originals[name] = Object.getOwnPropertyDescriptor(globalThis, name); Object.defineProperty(globalThis, name, { configurable: true, value: new Proxy({}, { get: (_t, p) => (...args) => { stored.push([name, p, args]); }, set: (_t, p, v) => { stored.push([name, p, v]); return true; } }) }); }
  const consoleCalls = []; const originalConsole = { log: console.log, error: console.error, warn: console.warn };
  for (const k of Object.keys(originalConsole)) console[k] = (...a) => consoleCalls.push(a);
  try {
    const { controller, fetch } = await openKyivBranches({ geo: SECURE(geoOk(50.5005, 30.5)) });
    assert.equal(controller.canLocate(), true);
    const before = controller.view().rows.map(r => r.point.ref);
    controller.locate();
    assert.deepEqual(geoOk.lastOptions, { enableHighAccuracy: false, timeout: 10000, maximumAge: 300000 }); assert.deepEqual(GEO_OPTIONS, geoOk.lastOptions);
    const v = controller.view();
    assert.equal(v.rows[0].point.number, '101', 'nearest first'); assert.match(v.rows[0].distance, /^≈ \d+ м$/);
    assert.notDeepEqual(v.rows.map(r => r.point.ref), before);
    assert.equal(controller.getState().announcement, MESSAGES.geoSorted);
    controller.setFilter('0'); const filtered = controller.view().rows; assert.ok(filtered.every(r => r.point.number.includes('0')));
    assert.ok(controller.view().rows[0].distance !== '' || filtered.length === 0);
    const serialized = JSON.stringify(controller.getState());
    assert.ok(!serialized.includes('50.5005') && !('position' in controller.getState()));
    await controller.setKind('postomat');
    assert.equal(controller.getState().sorted, false); assert.ok(controller.view().rows.every(r => r.distance === ''), 'cleared on kind change');
    controller.locate(); await controller.pickCity(LVIV);
    assert.equal(controller.getState().sorted, false); assert.ok(controller.view().rows.every(r => r.distance === ''), 'cleared on city change');
    for (const { url, init } of fetch.calls) {
      assert.doesNotMatch(url, /50\.5|30\.5|lat|lon/i); assert.equal(init.body, undefined);
      assert.deepEqual(Object.keys(init).sort(), ['headers', 'method', 'signal']);
    }
    controller.destroy();
    assert.deepEqual(stored, [], 'no storage API is touched'); assert.deepEqual(consoleCalls, [], 'nothing is logged');
  } finally {
    Object.assign(console, originalConsole);
    for (const [name, d] of Object.entries(originals)) { if (d) Object.defineProperty(globalThis, name, d); else delete globalThis[name]; }
  }
});

test('geolocation denied, timed out and unavailable keep the order and show the fixed messages', async () => {
  for (const [code, text, status] of [[1, 'Доступ до геолокації заборонено. Оберіть пункт зі списку.', 'denied'], [2, 'Не вдалося визначити місцезнаходження.', 'failed'], [3, 'Не вдалося визначити місцезнаходження.', 'failed']]) {
    const { controller, fetch } = await openKyivBranches({ geo: SECURE(geoFail(code)) });
    const before = controller.view().rows.map(r => r.point.ref);
    controller.locate();
    assert.deepEqual(controller.view().rows.map(r => r.point.ref), before);
    assert.equal(controller.getState().announcement, text); assert.equal(controller.getState().geoStatus, status); assert.equal(controller.getState().sorted, false);
    assert.equal(fetch.calls.length, 2, 'no request is made by a geolocation failure');
  }
  assert.equal(MESSAGES.geoDenied, 'Доступ до геолокації заборонено. Оберіть пункт зі списку.');
});

test('a position that arrives after a city change is ignored', async () => {
  let deliver; const geolocation = { getCurrentPosition: ok => { deliver = ok; } };
  const { controller } = await openKyivBranches({ geo: SECURE(geolocation) });
  controller.locate(); await controller.setKind('postomat');
  deliver({ coords: { latitude: 50.5, longitude: 30.5 } });
  assert.equal(controller.getState().sorted, false);
  controller.locate(); controller.destroy(); deliver({ coords: { latitude: 1, longitude: 1 } }); // no throw after unmount
});

test('the locate button is only offered with isSecureContext, navigator.geolocation and a point with coordinates', async () => {
  const geolocation = geoOk(50.5, 30.5);
  assert.equal((await openKyivBranches({ geo: SECURE(geolocation) })).controller.canLocate(), true);
  assert.equal((await openKyivBranches({ geo: { secure: false, geolocation } })).controller.canLocate(), false);
  assert.equal((await openKyivBranches({ geo: { secure: true, geolocation: null } })).controller.canLocate(), false);
  assert.equal((await openKyivBranches({ geo: null })).controller.canLocate(), false);
  const { controller } = setup({ geo: SECURE(geolocation) });
  await controller.pickCity(LVIV);
  assert.equal(controller.canLocate(), false, 'only points without coordinates');
  const ctrl = setup({ geo: SECURE(geolocation) }).controller; assert.equal(ctrl.canLocate(), false, 'nothing loaded yet');
  const guarded = setup({ geo: { secure: false, geolocation } }); await guarded.controller.pickCity(KYIV); guarded.controller.locate();
  assert.equal(guarded.controller.getState().geoStatus, 'idle');
});

test('browserGeo reads the real isSecureContext and navigator.geolocation gates', () => {
  const saved = { nav: Object.getOwnPropertyDescriptor(globalThis, 'navigator'), sec: Object.getOwnPropertyDescriptor(globalThis, 'isSecureContext') };
  const define = (nav, sec) => { Object.defineProperty(globalThis, 'navigator', { configurable: true, value: nav }); Object.defineProperty(globalThis, 'isSecureContext', { configurable: true, value: sec }); };
  try {
    const geolocation = geoOk(1, 1);
    define({ geolocation }, true); assert.deepEqual(browserGeo(), { secure: true, geolocation });
    define({ geolocation }, false); assert.equal(browserGeo().secure, false);
    define({}, true); assert.equal(browserGeo().geolocation, null);
    define(undefined, undefined); assert.deepEqual(browserGeo(), { secure: false, geolocation: null });
  } finally {
    for (const [k, d] of [['navigator', saved.nav], ['isSecureContext', saved.sec]]) { if (d) Object.defineProperty(globalThis, k, d); else delete globalThis[k]; }
  }
});

test('a failed point load can be retried without changing the kind', async () => {
  let fail = true; const good = mockFetch();
  const fetch = async (u, i) => (fail && u.includes('/warehouses') ? res(500, { error: 'boom' }) : good(u, i));
  const ctx = setup({ fetch }); await ctx.controller.pickCity(KYIV);
  assert.equal(ctx.controller.getState().pointsStatus, 'error'); assert.equal(ctx.controller.getState().unavailable, false);
  fail = false; await ctx.controller.retry();
  assert.equal(ctx.controller.getState().pointsStatus, 'ready'); assert.equal(ctx.controller.getState().error, '');
});

// ---- mappings ----------------------------------------------------------------------------------------------------------------------------
test('PickerValue, preference and CartDelivery mappings', () => {
  const point = branchPoints[0];
  const value = toPickerValue(point, { ref: KYIV.ref, name: 'Київ' }, 'branch');
  assert.deepEqual(value, { type: 'branch', cityRef: KYIV.ref, cityName: 'Київ', warehouseRef: point.ref, warehouseNumber: '1', warehouseName: point.name });
  assert.deepEqual(toDeliveryInput(value), { warehouseRef: point.ref }); assert.equal(toDeliveryInput(null), null);
  assert.deepEqual(Object.keys(toDeliveryInput(value)), ['warehouseRef']);
  const pref = { ...value, note: 'Подзвоніть', source: 'np-api', origin: 'cabinet' };
  assert.deepEqual(fromPreference(pref), value);
  assert.equal(fromPreference({ ...pref, source: 'manual', origin: null }), null, 'legacy preferences are not selectable values');
  assert.equal(fromPreference({ ...pref, warehouseRef: null }), null); assert.equal(fromPreference(null), null);
  assert.deepEqual(fromCartDelivery({ type: 'postomat', cityName: 'Київ', cityRef: KYIV.ref, warehouseNumber: null, warehouseRef: point.ref, warehouseName: 'П' }),
    { type: 'postomat', cityRef: KYIV.ref, cityName: 'Київ', warehouseRef: point.ref, warehouseNumber: null, warehouseName: 'П' });
  assert.equal(fromCartDelivery(null), null);
  assert.match(valueSummary(value), /^Відділення, Київ: Відділення №1/); assert.equal(valueSummary(null), '');
  assert.equal(normalizeText("  Кам'янське  "), 'камʼянське');
});

// ---- profile-delivery -------------------------------------------------------------------------------------------------------------------------
test('profile-delivery sends only {warehouseRef, note} or null', async () => {
  const sent = []; const fetch = async (url, init) => { sent.push({ url, init, body: init.body ? JSON.parse(init.body) : undefined }); return res(200, { deliveryPreference: null }); };
  const ref = guid('b', 1).toUpperCase();
  await saveDeliveryPreference(ref, ' Тихо ', fetch);
  await saveDeliveryPreference(guid('b', 2), undefined, fetch);
  await saveDeliveryPreference(guid('b', 3), null, fetch);
  await saveDeliveryPreference(null, 'ігнорується', fetch);
  await saveDeliveryPreference(undefined, undefined, fetch);
  assert.deepEqual(sent.map(s => s.body), [
    { deliveryPreference: { warehouseRef: guid('b', 1), note: 'Тихо' } }, { deliveryPreference: { warehouseRef: guid('b', 2) } },
    { deliveryPreference: { warehouseRef: guid('b', 3), note: null } }, { deliveryPreference: null }, { deliveryPreference: null },
  ]);
  for (const s of sent) { assert.equal(s.url, '/api/account/profile'); assert.equal(s.init.method, 'PATCH'); assert.equal(s.init.credentials, 'same-origin'); assert.equal(s.init.headers['Content-Type'], 'application/json'); }
  await fetchProfile(fetch); assert.equal(sent.at(-1).init.method, 'GET'); assert.equal(sent.at(-1).init.body, undefined);
  assert.throws(() => buildPreferenceBody('not-a-guid'), e => e.status === 400);
  assert.throws(() => buildPreferenceBody(guid('b', 1), 'x'.repeat(201)), e => e.status === 400);
  await assert.rejects(saveDeliveryPreference({ warehouseRef: ref, city: 'Київ' }, undefined, fetch), e => e.status === 400);
  assert.equal(sent.length, 6, 'invalid input is rejected before any request');
});

test('profile-delivery exposes status and retryAfter with fixed messages', async () => {
  for (const [status, text] of [[400, 'Не вдалося зберегти пункт. Оберіть його зі списку й спробуйте ще раз.'], [401, 'Увійдіть в акаунт, щоб зберегти пункт.'], [429, 'Забагато спроб. Спробуйте ще раз трохи пізніше.'], [503, 'Довідник Нової пошти зараз недоступний. Спробуйте пізніше.']]) {
    const fetch = async () => res(status, { error: 'Nova Poshta catalog is unavailable' }, { 'Retry-After': '120' });
    await assert.rejects(saveDeliveryPreference(guid('b', 1), undefined, fetch), e => e.status === status && e.retryAfter === '120' && e.message === text);
  }
  await assert.rejects(saveDeliveryPreference(null, undefined, async () => { throw new TypeError('offline'); }), e => e.status === 0 && e.retryAfter === null);
});

// ---- keyboard ----------------------------------------------------------------------------------------------------------------------------------------
test('keyboard-only selection of a city and a point', async () => {
  const { controller, clk } = setup();
  controller.setQuery('ки'); clk.advance(DEBOUNCE_MS); await flush();
  assert.equal(controller.cityKeyDown('Enter').handled, true, 'Enter never submits a form'); assert.equal(controller.getState().city, null);
  assert.equal(controller.cityKeyDown('ArrowDown').handled, true); assert.equal(controller.getState().activeCity, 0);
  assert.equal(controller.cityKeyDown('Escape').handled, true); assert.equal(controller.getState().citiesOpen, false);
  assert.equal(controller.cityKeyDown('Escape').handled, false);
  controller.cityKeyDown('ArrowUp'); assert.equal(controller.getState().citiesOpen, true); assert.equal(controller.getState().activeCity, 0);
  const picked = controller.cityKeyDown('Enter'); assert.equal(picked.city.ref, KYIV.ref); await flush();
  assert.equal(controller.getState().city.ref, KYIV.ref); assert.equal(controller.getState().pointsStatus, 'ready'); assert.equal(controller.getState().query, 'Київ');
  assert.equal(controller.pointKeyDown('Enter').point, undefined);
  controller.pointKeyDown('ArrowDown'); controller.pointKeyDown('ArrowDown');
  assert.equal(controller.getState().activePoint, 1);
  controller.pointKeyDown('ArrowUp'); controller.pointKeyDown('ArrowUp'); assert.equal(controller.getState().activePoint, 49, 'wraps within the shown page');
  controller.pointKeyDown('Home'); assert.equal(controller.getState().activePoint, 0);
  const done = controller.pointKeyDown('Enter');
  assert.equal(done.point.number, '1');
  assert.deepEqual(toPickerValue(done.point, controller.getState().city, controller.getState().kind).warehouseRef, branchPoints[0].ref);
  assert.equal(nextIndex(-1, 3, 'ArrowUp'), 2); assert.equal(nextIndex(2, 3, 'ArrowDown'), 0); assert.equal(nextIndex(0, 0, 'ArrowDown'), -1);
  controller.setQuery('киї'); assert.equal(controller.getState().city, null, 'editing the text drops the chosen city');
});

test('live region announces loading, counts and errors', async () => {
  const { controller, clk } = setup(); const seen = [];
  controller.subscribe(() => { const a = controller.getState().announcement; if (a && seen.at(-1) !== a) seen.push(a); });
  controller.setQuery('ки'); clk.advance(DEBOUNCE_MS); await flush();
  await controller.pickCity(KYIV);
  assert.deepEqual(seen, ['Пошук міст…', 'Знайдено міст: 1.', 'Завантаження пунктів…', 'Знайдено пунктів: 120.']);
  controller.setQuery('ящ'); clk.advance(DEBOUNCE_MS); await flush();
  assert.equal(controller.getState().announcement, 'Міст не знайдено.');
});

// ---- rendered markup (ARIA) -----------------------------------------------------------------------------------------------------------------------------
test('rendered picker exposes combobox, radio group, labelled lists and a polite live region', async () => {
  const cacheRoot = resolve(ROOT, 'node_modules/.cache');
  await mkdir(cacheRoot, { recursive: true });
  const dir = await mkdtemp(join(cacheRoot, 'np-ssr-'));
  try {
    const src = p => resolve(ROOT, 'apps/web/src', p).replaceAll('\\', '/');
    const entry = join(dir, 'entry.jsx');
    await writeFile(entry, `import React from 'react';import {renderToStaticMarkup as r} from 'react-dom/server';
import NovaPoshtaPicker, {PickerFlowView} from '${src('delivery/NovaPoshtaPicker.jsx')}';
const noop=()=>{};const stub=new Proxy({}, {get:()=>noop});
export const whole=(value,disabled)=>r(<NovaPoshtaPicker value={value} disabled={disabled} idPrefix="t" onChange={noop}/>);
export const flow=(c,locatable,disabled)=>r(<PickerFlowView s={c.getState()} v={c.view()} locatable={locatable} disabled={disabled} c={stub} idPrefix="t" onSelect={noop} onCancel={null}/>);`);
    await build({ root: dir, configFile: false, logLevel: 'silent', esbuild: { jsx: 'automatic' }, ssr: { noExternal: true }, build: { ssr: entry, outDir: dir, emptyOutDir: false, rollupOptions: { output: { format: 'cjs', entryFileNames: 'out.cjs' } } } });
    const m = (await import(pathToFileURL(join(dir, 'out.cjs')).href)).default;
    const empty = m.whole(null, false);
    assert.match(empty, /<legend>Пункт Нової пошти<\/legend>/); assert.match(empty, /<label for="t-city">Місто<\/label>/);
    assert.match(empty, /role="combobox"/); assert.match(empty, /aria-expanded="false"/); assert.match(empty, /aria-autocomplete="list"/); assert.match(empty, /aria-controls="t-city-list"/);
    assert.match(empty, /role="status" aria-live="polite"/); assert.doesNotMatch(empty, /type="radio"|role="listbox"/);
    assert.match(m.whole(null, true), /<fieldset[^>]*disabled/);
    const value = toPickerValue(branchPoints[0], { ref: KYIV.ref, name: 'Київ' }, 'branch');
    const chosen = m.whole(value, false);
    assert.match(chosen, /Обрано:/); assert.match(chosen, /role="status" aria-live="polite"/); assert.match(chosen, /Змінити пункт/); assert.match(chosen, /Очистити/); assert.doesNotMatch(chosen, /role="combobox"/);
    // Open city list and loaded point list, from a real controller state.
    const { controller, clk } = setup({ geo: SECURE(geoOk(50.5, 30.5)) });
    controller.setQuery('ки'); clk.advance(DEBOUNCE_MS); await flush(); controller.cityKeyDown('ArrowDown');
    const cityMarkup = m.flow(controller, false);
    assert.match(cityMarkup, /aria-expanded="true"/); assert.match(cityMarkup, /role="listbox"[^>]*aria-label="Знайдені міста"/);
    assert.match(cityMarkup, /id="t-city-opt-0" role="option" aria-selected="true"/); assert.match(cityMarkup, /aria-activedescendant="t-city-opt-0"/);
    assert.match(cityMarkup, /Київ, Київська \(відділень: 120, поштоматів: 60\)/);
    await controller.pickCity(KYIV); controller.pointKeyDown('ArrowDown');
    const pointMarkup = m.flow(controller, controller.canLocate());
    assert.match(pointMarkup, /<legend>Тип пункту<\/legend>/); assert.equal((pointMarkup.match(/type="radio"/g) || []).length, 2);
    assert.match(pointMarkup, /checked="" value="branch"/); assert.match(pointMarkup, /Відділення/); assert.match(pointMarkup, /Поштомат/);
    assert.match(pointMarkup, /role="listbox"[^>]*aria-label="Пункти: Відділення, Київ"/); assert.equal((pointMarkup.match(/role="option"/g) || []).length, 50);
    assert.match(pointMarkup, /aria-activedescendant="t-point-opt-0"/); assert.match(pointMarkup, /Показано 50 з 120/); assert.match(pointMarkup, /Показати ще/);
    assert.match(pointMarkup, /Найближчі до мене/);
    assert.doesNotMatch(m.flow(controller, false), /Найближчі до мене/);
    const hidden = setup({ geo: null }); await hidden.controller.pickCity(KYIV);
    assert.doesNotMatch(m.flow(hidden.controller, hidden.controller.canLocate()), /Найближчі до мене/);
    const down = setup({ fetch: mockFetch({ fail: async () => res(503, { error: 'catalog_unavailable' }) }) });
    down.controller.setQuery('ки'); down.clk.advance(DEBOUNCE_MS); await flush();
    const unavailable = m.flow(down.controller, false);
    assert.match(unavailable, /Довідник Нової пошти зараз недоступний\./); assert.match(unavailable, /id="t-city"[^>]*disabled/); assert.match(unavailable, /Повторити/);
    const off = m.flow(controller, false, true); assert.match(off, /aria-disabled="true"/); assert.doesNotMatch(m.flow(controller, false), /aria-disabled/);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

// ---- review hardening ----------------------------------------------------------------------------------------------
test('city list stays closed when the input lost focus before the response', async () => {
  const { controller, clk } = setup();
  controller.setQuery('ки'); controller.closeCities(); clk.advance(DEBOUNCE_MS); await flush();
  assert.equal(controller.getState().citiesOpen, false); assert.equal(controller.getState().cities.length, 1);
  controller.openCities(); assert.equal(controller.getState().citiesOpen, true);
});

test('Enter is always handled by both comboboxes, Escape clears the filter then the active option', async () => {
  const { controller, clk } = await openKyivBranches();
  assert.equal(controller.pointKeyDown('Enter').handled, true); assert.equal(controller.pointKeyDown('Enter').point, undefined);
  controller.setFilter('17'); controller.pointKeyDown('ArrowDown');
  assert.equal(controller.pointKeyDown('Escape').handled, true); assert.equal(controller.getState().filter, '17');
  assert.equal(controller.pointKeyDown('Escape').handled, true); assert.equal(controller.getState().filter, '');
  assert.equal(controller.pointKeyDown('Escape').handled, false);
  const c2 = setup().controller; assert.equal(c2.cityKeyDown('Enter').handled, true);
  assert.ok(clk);
});

test('filtering is memoized per list and filter, and normalization is computed once', async () => {
  const { controller } = await openKyivBranches();
  controller.setFilter('тестова'); const a = controller.view(); const b = controller.view();
  assert.deepEqual(a.rows.map(r => r.point.ref), b.rows.map(r => r.point.ref));
  assert.equal(controller.view().total, 120);
  const t0 = performance.now(); const big = Array.from({ length: 8000 }, (_, i) => ({ ref: `r${i}`, number: String(i), name: `Поштомат №${i}: вул. Довга, ${i}`, lat: 50, lon: 30 }));
  for (let i = 0; i < 20; i++) filterPoints(big, `довга, ${i}`);
  assert.ok(performance.now() - t0 < 1500);
});

test('clearing the distance sort keeps the typed filter', async () => {
  const { controller } = await openKyivBranches({ geo: SECURE(geoOk(50.5005, 30.5)) });
  controller.setFilter('1'); controller.locate(); assert.equal(controller.getState().sorted, true);
  controller.clearLocation();
  assert.equal(controller.getState().filter, '1'); assert.equal(controller.getState().sorted, false); assert.ok(controller.view().rows.every(r => r.distance === ''));
});

test('destroy aborts in-flight point loads and caches nothing afterwards', async () => {
  const pending = []; const fetch = (url, init) => new Promise(r => pending.push({ url, init, r }));
  const controller = createPickerController({ api: createNpApi(fetch), timers: clock(), geo: null });
  controller.pickCity(KYIV); assert.equal(pending[0].init.signal.aborted, false);
  controller.destroy(); assert.equal(pending[0].init.signal.aborted, true);
  pending[0].r(res(200, { items: branchPoints })); await flush();
  assert.equal(controller.getState().pointsStatus, 'loading');
});

test('only NpApiError text is shown; other failures get the fixed default', async () => {
  const controller = createPickerController({ api: { searchCities: async () => { throw new Error('secret internal detail'); }, loadPoints: async () => ({ items: [] }) }, timers: (() => { const c = clock(); return c; })(), geo: null });
  const clk = clock(); const c2 = createPickerController({ api: { searchCities: async () => { throw new Error('secret internal detail'); }, loadPoints: async () => ({ items: [] }) }, timers: clk, geo: null });
  c2.setQuery('ки'); clk.advance(DEBOUNCE_MS); await flush();
  assert.equal(c2.getState().error, 'Не вдалося завантажити дані. Спробуйте ще раз.'); assert.equal(c2.getState().unavailable, false);
  assert.ok(controller);
});

test('np-api drops malformed items', async () => {
  const api = createNpApi(async url => res(200, { items: url.includes('cities')
    ? [KYIV, { ref: 1, name: 'x' }, { ref: 'a', name: null }, null]
    : [branchPoints[0], { ref: 'a', name: 'n', number: 5 }, { ref: 'b', name: 'n', number: null, lat: 'x', lon: 30 }, { name: 'no ref', number: null }] }));
  assert.deepEqual((await api.searchCities('ки')).items, [KYIV]);
  const items = (await api.loadPoints(KYIV.ref, 'branch')).items;
  assert.deepEqual(items.map(p => p.ref), [branchPoints[0].ref, 'b']); assert.equal(items[1].lat, null); assert.equal(items[1].lon, 30);
});
