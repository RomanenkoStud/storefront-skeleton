// Pure picker logic (ADR-0011 sections 10 and 11): filtering, sorting, haversine, labels, mappings and the
// picker controller. The controller owns all timers, requests and geolocation so it runs in Node with fakes.
// Device coordinates live only in a closure variable: never in exported state, storage, URLs, bodies or logs.

import { isAbort, NpApiError, searchCities as defaultSearch, loadPoints as defaultLoad } from './np-api.js';

export const DEBOUNCE_MS = 350;
export const MIN_QUERY = 2;
export const PAGE_SIZE = 50;
export const GEO_OPTIONS = Object.freeze({ enableHighAccuracy: false, timeout: 10000, maximumAge: 300000 });
export const KINDS = Object.freeze([{ value: 'branch', label: 'Відділення' }, { value: 'postomat', label: 'Поштомат' }]);
export const KIND_LABEL = Object.freeze({ branch: 'Відділення', postomat: 'Поштомат' });

export const MESSAGES = Object.freeze({
  geoDenied: 'Доступ до геолокації заборонено. Оберіть пункт зі списку.',
  geoFailed: 'Не вдалося визначити місцезнаходження.',
  geoSorted: 'Пункти відсортовано за відстанню.',
  geoLocating: 'Визначаємо місцезнаходження…',
  loadingCities: 'Пошук міст…',
  loadingPoints: 'Завантаження пунктів…',
  noCities: 'Міст не знайдено.',
  noPoints: 'Пунктів не знайдено.',
});

const APOSTROPHES = /['’`‘′´]/g;
export function normalizeText(text) {
  return String(text ?? '').normalize('NFC').replace(APOSTROPHES, 'ʼ').replace(/\s+/g, ' ').trim().toLowerCase();
}
/** Search text sent for a city: NFC, trimmed and collapsed, not lowercased (the server normalizes). */
export const cityQuery = text => String(text ?? '').normalize('NFC').replace(/\s+/g, ' ').trim();
export const queryLongEnough = text => [...normalizeText(text)].length >= MIN_QUERY;

export const hasCoordinates = point => Number.isFinite(point?.lat) && Number.isFinite(point?.lon);

const normalizedNames = new WeakMap(); // points array -> normalized names, computed once per loaded list
function namesOf(points) {
  let names = normalizedNames.get(points);
  if (!names) { names = points.map(point => normalizeText(point.name)); normalizedNames.set(points, names); }
  return names;
}
/** Substring match on the number or the name; a leading "№" or "#" is ignored. Empty filter keeps everything. */
export function filterPoints(points, filter) {
  const needle = normalizeText(filter).replace(/^[№#]\s*/, '');
  if (!needle) return points;
  const names = namesOf(points);
  return points.filter((point, i) => (point.number ?? '').includes(needle) || names[i].includes(needle));
}

const EARTH_RADIUS_KM = 6371.0088;
export function haversineKm(a, b) {
  const rad = deg => (deg * Math.PI) / 180;
  const dLat = rad(b.lat - a.lat), dLon = rad(b.lon - a.lon);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.sin(dLon / 2) ** 2;
  return 2 * EARTH_RADIUS_KM * Math.asin(Math.min(1, Math.sqrt(h)));
}

/** «≈ 850 м» below 1 km (10 m steps), «≈ 1,2 км» up to 10 km, whole kilometres beyond. */
export function formatDistance(km) {
  if (!Number.isFinite(km) || km < 0) return '';
  const meters = Math.round((km * 1000) / 10) * 10;
  if (meters < 1000) return `≈ ${meters} м`;
  const value = km < 10 ? Math.round(km * 10) / 10 : Math.round(km);
  return `≈ ${String(value).replace('.', ',')} км`;
}

/** Stable sort by distance from `origin`; points without coordinates keep their order and go last. Returns [{point, km}]. */
export function sortByDistance(points, origin) {
  return points
    .map((point, index) => ({ point, index, km: hasCoordinates(point) ? haversineKm(origin, point) : null }))
    .sort((a, b) => (a.km === null) - (b.km === null) || (a.km ?? 0) - (b.km ?? 0) || a.index - b.index)
    .map(({ point, km }) => ({ point, km }));
}

export function cityOptionLabel(city) {
  const counts = [city.branches > 0 ? `відділень: ${city.branches}` : '', city.postomats > 0 ? `поштоматів: ${city.postomats}` : ''].filter(Boolean).join(', ');
  return [city.name, city.area].filter(Boolean).join(', ') + (counts ? ` (${counts})` : '');
}

/** Wrapping ArrowDown/ArrowUp, Home and End over `count` options. -1 means no active option. */
export function nextIndex(current, count, key) {
  if (count <= 0) return -1;
  if (key === 'ArrowDown') return current < 0 || current >= count - 1 ? 0 : current + 1;
  if (key === 'ArrowUp') return current <= 0 ? count - 1 : current - 1;
  if (key === 'Home') return 0;
  if (key === 'End') return count - 1;
  return current;
}

/* ---- mappings -------------------------------------------------------------------------------------------- */

/** PickerValue = {type, cityRef, cityName, warehouseRef, warehouseNumber, warehouseName} */
export function toPickerValue(point, city, kind) {
  return { type: kind, cityRef: city.ref, cityName: city.name, warehouseRef: point.ref, warehouseNumber: point.number ?? null, warehouseName: point.name };
}
const fromStored = source => ({
  type: source.type, cityRef: source.cityRef ?? null, cityName: source.cityName, warehouseRef: source.warehouseRef,
  warehouseNumber: source.warehouseNumber ?? null, warehouseName: source.warehouseName ?? null,
});
const isStored = source => Boolean(source && (source.type === 'branch' || source.type === 'postomat') && typeof source.cityName === 'string' && typeof source.warehouseRef === 'string' && source.warehouseRef);
/** NovaPoshtaPreference -> PickerValue. Legacy (`source` not "np-api") or Ref-less preferences are not selectable values: null. */
export const fromPreference = preference => (isStored(preference) && preference.source === 'np-api' ? fromStored(preference) : null);
/** CartDelivery -> PickerValue (or null). */
export const fromCartDelivery = delivery => (isStored(delivery) ? fromStored(delivery) : null);
/** PickerValue -> the only thing consumers send to the server: DeliveryPointInput. */
export const toDeliveryInput = value => (value?.warehouseRef ? { warehouseRef: value.warehouseRef } : null);
/** Human summary, for example «Відділення, Київ: Відділення №1: вул. …». */
export const valueSummary = value => (value ? `${KIND_LABEL[value.type] ?? ''}, ${value.cityName}: ${value.warehouseName ?? `№${value.warehouseNumber ?? ''}`}` : '');

/* ---- controller ------------------------------------------------------------------------------------------ */

const defaultTimers = { setTimeout: (...a) => globalThis.setTimeout(...a), clearTimeout: id => globalThis.clearTimeout(id) };
export function browserGeo() {
  const nav = globalThis.navigator;
  return { secure: globalThis.isSecureContext === true, geolocation: nav?.geolocation ?? null };
}

export function initialPickerState(initial = null) {
  return {
    query: initial?.cityName ?? '', city: initial?.cityRef ? { ref: initial.cityRef, name: initial.cityName } : null,
    cities: [], citiesStatus: 'idle', citiesOpen: false, activeCity: -1,
    kind: initial?.type === 'postomat' ? 'postomat' : 'branch',
    points: null, pointsStatus: initial?.cityRef ? 'loading' : 'idle', filter: '', visible: PAGE_SIZE, activePoint: -1,
    geoStatus: 'idle', sorted: false,
    unavailable: false, error: '', announcement: '',
  };
}
export const emptyView = Object.freeze({ rows: [], total: 0, shown: 0, hasMore: false });

/**
 * @param {{initial?: {cityRef, cityName, type}|null, api?, timers?, geo?: {secure:boolean, geolocation}|null}} deps
 * State is a plain object replaced on every change (subscribe/getState suit useSyncExternalStore).
 */
export function createPickerController({ initial = null, api, timers = defaultTimers, geo = browserGeo() } = {}) {
  const { searchCities, loadPoints } = api ?? { searchCities: defaultSearch, loadPoints: defaultLoad };
  const listeners = new Set();
  const pointCache = new Map();   // `${cityRef}|${kind}` -> NpPoint[]; one successful load per key
  const inflight = new Map();     // same key -> Promise, shared so A -> B -> A never loads A twice
  let position = null;            // {lat, lon}; private, never exposed or persisted
  let timer = null, searchAbort = null, searchSeq = 0, geoSeq = 0, destroyed = false, lastAction = null;
  let sortedFor = null, sortedRows = null, filteredFor = null, focused = true;

  let state = initialPickerState(initial);
  const set = patch => { if (destroyed) return; state = { ...state, ...patch }; for (const l of listeners) l(); };
  const DEFAULT_ERROR = 'Не вдалося завантажити дані. Спробуйте ще раз.';
  const fail = error => {
    const message = error instanceof NpApiError ? error.message : DEFAULT_ERROR;
    return { unavailable: error instanceof NpApiError && error.unavailable, error: message, announcement: message };
  };

  function resetPointsView() {
    position = null; geoSeq++; sortedFor = null;
    return { filter: '', visible: PAGE_SIZE, activePoint: -1, geoStatus: 'idle', sorted: false };
  }

  async function runSearch(text) {
    searchAbort?.abort();
    const abort = new AbortController(), seq = ++searchSeq;
    searchAbort = abort;
    set({ citiesStatus: 'loading', error: '', announcement: MESSAGES.loadingCities });
    try {
      const body = await searchCities(text, { signal: abort.signal });
      if (seq !== searchSeq) return;
      const cities = body.items.slice(0, 20);
      set({ cities, citiesStatus: 'ready', citiesOpen: focused, activeCity: -1, announcement: cities.length ? `Знайдено міст: ${cities.length}.` : MESSAGES.noCities });
    } catch (error) {
      if (isAbort(error) || seq !== searchSeq) return;
      set({ citiesStatus: 'error', cities: [], citiesOpen: false, ...fail(error) });
    }
  }

  function setQuery(raw) {
    timers.clearTimeout(timer); timer = null; searchAbort?.abort(); searchSeq++;
    const patch = { query: raw, activeCity: -1, error: '' };
    if (state.city) Object.assign(patch, { city: null, points: null, pointsStatus: 'idle', ...resetPointsView() });
    if (!queryLongEnough(raw)) return set({ ...patch, cities: [], citiesStatus: 'idle', citiesOpen: false, announcement: '' });
    lastAction = () => runSearch(cityQuery(raw));
    set({ ...patch, citiesStatus: 'loading' });
    timer = timers.setTimeout(() => { timer = null; runSearch(cityQuery(raw)); }, DEBOUNCE_MS);
  }

  async function loadCurrent() {
    const { city, kind } = state;
    if (!city) return;
    const key = `${city.ref}|${kind}`;
    lastAction = loadCurrent;
    if (pointCache.has(key)) {
      const points = pointCache.get(key);
      return set({ points, pointsStatus: 'ready', error: '', announcement: points.length ? `Знайдено пунктів: ${points.length}.` : MESSAGES.noPoints });
    }
    set({ points: null, pointsStatus: 'loading', error: '', announcement: MESSAGES.loadingPoints });
    let entry = inflight.get(key);
    if (!entry) {
      const abort = new AbortController();
      const promise = loadPoints(city.ref, kind, { signal: abort.signal }).then(body => { if (!destroyed) pointCache.set(key, body.items); return body.items; }).finally(() => inflight.delete(key));
      entry = { promise, abort }; inflight.set(key, entry);
    }
    try {
      const points = await entry.promise;
      if (state.city?.ref !== city.ref || state.kind !== kind) return;
      set({ points, pointsStatus: 'ready', announcement: points.length ? `Знайдено пунктів: ${points.length}.` : MESSAGES.noPoints });
    } catch (error) {
      if (isAbort(error) || state.city?.ref !== city.ref || state.kind !== kind) return;
      set({ pointsStatus: 'error', ...fail(error) });
    }
  }

  function pickCity(city) {
    timers.clearTimeout(timer); timer = null; searchAbort?.abort(); searchSeq++;
    const kind = city.branches === 0 && city.postomats > 0 ? 'postomat' : city.postomats === 0 && city.branches > 0 ? 'branch' : state.kind;
    set({ city: { ref: city.ref, name: city.name }, query: city.name, kind, cities: [], citiesStatus: 'idle', citiesOpen: false, activeCity: -1, points: null, pointsStatus: 'idle', ...resetPointsView() });
    return loadCurrent();
  }
  function setKind(kind) {
    if (kind === state.kind || (kind !== 'branch' && kind !== 'postomat')) return;
    set({ kind, points: null, pointsStatus: 'idle', ...resetPointsView() });
    return loadCurrent();
  }

  function view() {
    if (!state.points) return { rows: [], total: 0, shown: 0, hasMore: false };
    if (filteredFor?.points !== state.points || filteredFor?.filter !== state.filter) filteredFor = { points: state.points, filter: state.filter, result: filterPoints(state.points, state.filter) };
    const filtered = filteredFor.result;
    let ordered;
    if (state.sorted && position) {
      if (sortedFor?.points !== filtered || sortedFor?.position !== position) { sortedFor = { points: filtered, position }; sortedRows = sortByDistance(filtered, position); }
      ordered = sortedRows;
    } else ordered = filtered.map(point => ({ point, km: null }));
    const rows = ordered.slice(0, state.visible).map(({ point, km }) => ({ point, distance: km === null ? '' : formatDistance(km) }));
    return { rows, total: ordered.length, shown: rows.length, hasMore: ordered.length > rows.length };
  }
  const canLocate = () => Boolean(geo?.secure && geo.geolocation && state.pointsStatus === 'ready' && state.points?.some(hasCoordinates));

  function locate() {
    if (!canLocate() || state.geoStatus === 'locating') return;
    const seq = ++geoSeq;
    set({ geoStatus: 'locating', announcement: MESSAGES.geoLocating });
    geo.geolocation.getCurrentPosition(
      result => {
        if (seq !== geoSeq || destroyed) return;
        const lat = result?.coords?.latitude, lon = result?.coords?.longitude;
        if (!Number.isFinite(lat) || !Number.isFinite(lon)) return set({ geoStatus: 'failed', announcement: MESSAGES.geoFailed });
        position = { lat, lon }; sortedFor = null;
        set({ geoStatus: 'ok', sorted: true, visible: PAGE_SIZE, activePoint: -1, announcement: MESSAGES.geoSorted });
      },
      failure => {
        if (seq !== geoSeq || destroyed) return;
        const text = failure?.code === 1 ? MESSAGES.geoDenied : MESSAGES.geoFailed;
        set({ geoStatus: failure?.code === 1 ? 'denied' : 'failed', announcement: text });
      },
      { ...GEO_OPTIONS },
    );
  }
  const clearLocation = () => { position = null; geoSeq++; sortedFor = null; set({ geoStatus: 'idle', sorted: false, visible: PAGE_SIZE, activePoint: -1, announcement: '' }); };

  function cityKeyDown(key) {
    if (key === 'Escape') { if (!state.citiesOpen) return { handled: false }; set({ citiesOpen: false, activeCity: -1 }); return { handled: true }; }
    if (['ArrowDown', 'ArrowUp'].includes(key)) {
      if (!state.cities.length) return { handled: true };
      set({ citiesOpen: true, activeCity: nextIndex(state.citiesOpen ? state.activeCity : -1, state.cities.length, key) });
      return { handled: true };
    }
    if (['Home', 'End'].includes(key) && state.citiesOpen && state.activeCity >= 0) { set({ activeCity: nextIndex(state.activeCity, state.cities.length, key) }); return { handled: true }; }
    if (key === 'Enter') {
      if (state.citiesOpen && state.activeCity >= 0) { const city = state.cities[state.activeCity]; pickCity(city); return { handled: true, city }; }
      return { handled: true };
    }
    return { handled: false };
  }
  function pointKeyDown(key) {
    const { rows } = view();
    if (['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(key)) {
      if (!rows.length) return { handled: true };
      if ((key === 'Home' || key === 'End') && state.activePoint < 0) return { handled: false };
      set({ activePoint: nextIndex(state.activePoint, rows.length, key) });
      return { handled: true };
    }
    if (key === 'Escape') {
      if (state.activePoint >= 0) { set({ activePoint: -1 }); return { handled: true }; }
      if (state.filter) { set({ filter: '', visible: PAGE_SIZE, activePoint: -1 }); return { handled: true }; }
      return { handled: false };
    }
    if (key === 'Enter') return state.activePoint >= 0 && rows[state.activePoint] ? { handled: true, point: rows[state.activePoint].point } : { handled: true };
    return { handled: false };
  }

  function destroy() {
    timers.clearTimeout(timer); timer = null; searchAbort?.abort(); searchSeq++; geoSeq++;
    destroyed = true;
    for (const { abort } of inflight.values()) abort.abort();
    position = null; sortedFor = sortedRows = filteredFor = null; pointCache.clear(); listeners.clear();
  }

  if (state.city) loadCurrent();
  return {
    getState: () => state,
    subscribe: listener => { listeners.add(listener); return () => listeners.delete(listener); },
    view, canLocate, destroy,
    setQuery, pickCity, setKind, cityKeyDown, pointKeyDown, locate, clearLocation,
    setFilter: filter => { set({ filter, visible: PAGE_SIZE, activePoint: -1 }); const v = view(); set({ announcement: v.total ? `Знайдено пунктів: ${v.total}.` : MESSAGES.noPoints }); },
    showMore: () => { const visible = state.visible + PAGE_SIZE; set({ visible }); const v = view(); set({ announcement: `Показано пунктів: ${v.shown} з ${v.total}.` }); },
    setActivePoint: index => set({ activePoint: index }),
    setActiveCity: index => set({ activeCity: index }),
    closeCities: () => { focused = false; set({ citiesOpen: false, activeCity: -1 }); },
    openCities: () => { focused = true; if (state.cities.length) set({ citiesOpen: true }); },
    announceFilter: () => { const v = view(); set({ announcement: v.total ? `Знайдено пунктів: ${v.total}.` : MESSAGES.noPoints }); },
    retry: () => { set({ unavailable: false, error: '' }); return lastAction?.(); },
  };
}
