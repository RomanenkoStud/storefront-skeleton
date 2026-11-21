// Synthetic Nova Poshta data and test doubles (no real directory content). Shared by the h7e.3 tests.
import { createHash } from 'node:crypto';

export const guid = seed => { const h = createHash('md5').update(String(seed)).digest('hex'); return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20, 32)}`; };
export const KYIV = guid('city-kyiv'), LVIV = guid('city-lviv'), KAMIANSKE = guid('city-kamianske'), VILLAGE = guid('city-village');

export function record({ Ref: seed, rawRef, ...over } = {}) {
  const n = over.Number ?? '1';
  return {
    Ref: rawRef ?? guid(`wh-${seed ?? n}`), CityRef: KYIV, CityDescription: 'Київ', SettlementAreaDescription: 'Київська', Number: String(n),
    Description: `Відділення №${n}: вул. Тестова, ${n}`, CategoryOfWarehouse: 'Branch', WarehouseStatus: 'Working', DenyToSelect: '0', Latitude: '50.45010', Longitude: '30.52340', TypeOfWarehouse: 'x', ...over,
  };
}
// A small synthetic upstream covering every filter, normalization and ordering rule.
export function syntheticUpstream() {
  return [
    record({ Number: '10', Ref: 'a' }), record({ Number: '2', Ref: 'b' }), record({ Number: '2', Ref: 'c' }), record({ Number: 'abc', Ref: 'nonum', Description: 'Відділення без номера' }),
    record({ Number: '5', Ref: 'store', CategoryOfWarehouse: 'Store' }),
    record({ Number: '1001', Ref: 'p1', CategoryOfWarehouse: 'Postomat', Description: 'Поштомат "Нова Пошта" №1001: вул. Сімʼї Кульженків, 31а' }),
    record({ Number: '1002', Ref: 'p2', CategoryOfWarehouse: 'Postomat', Latitude: '0', Longitude: '0' }),
    record({ Number: '1003', Ref: 'p3', CategoryOfWarehouse: 'Postomat', Latitude: '61.1', Longitude: '30.5' }),
    record({ Number: '7', Ref: 'dropoff', CategoryOfWarehouse: 'DropOff' }), record({ Number: '8', Ref: 'fulfil', CategoryOfWarehouse: 'Fulfillment' }),
    record({ Number: '9', Ref: 'other', CategoryOfWarehouse: 'OtherOperating' }), record({ Number: '11', Ref: 'unk', CategoryOfWarehouse: 'Mystery' }), record({ Number: '12', Ref: 'nocat', CategoryOfWarehouse: undefined }),
    record({ Number: '13', Ref: 'closed', WarehouseStatus: 'NotWorking' }), record({ Number: '14', Ref: 'deny', DenyToSelect: '1' }),
    record({ Number: '15', rawRef: 'not-a-guid' }), record({ Number: '16', Ref: 'badcity', CityRef: 'zzz' }),
    record({ Number: '2', Ref: 'b' }), // duplicate Ref
    record({ Number: '1', Ref: 'l1', CityRef: LVIV, CityDescription: 'Львів', SettlementAreaDescription: 'Львівська' }),
    record({ Number: '3', Ref: 'k1', CityRef: KAMIANSKE, CityDescription: "Кам'янське", SettlementAreaDescription: 'Дніпропетровська', Description: "Відділення №3: вул. Кам'янська" }),
    record({ Number: '4', Ref: 'k2', CityRef: KAMIANSKE, CityDescription: 'Кам’янське', SettlementAreaDescription: 'Дніпропетровська', CategoryOfWarehouse: 'Postomat' }),
    record({ Number: '1', Ref: 'v1', CityRef: VILLAGE, CityDescription: 'Миньківці (Київська обл.)', SettlementAreaDescription: 'Київська', Description: 'Відділення​ №1\t  вул.\u0000 Тестова' }),
  ];
}

// Upstream fetch double: pages `records` by Limit/Page, records concurrency. Options: failPage(page, attempt), status, totalCount, success.
export function upstreamFetch(records, options = {}) {
  const state = { calls: [], inFlight: 0, maxInFlight: 0, attempts: new Map() };
  const impl = async (url, init) => {
    const body = JSON.parse(init.body), page = Number(body.methodProperties.Page), limit = Number(body.methodProperties.Limit);
    state.calls.push({ url, init, body });
    state.inFlight++; state.maxInFlight = Math.max(state.maxInFlight, state.inFlight);
    try {
      await new Promise(r => setTimeout(r, 2));
      const attempt = (state.attempts.get(page) ?? 0) + 1; state.attempts.set(page, attempt);
      const fail = options.failPage?.(page, attempt);
      if (fail === 'throw') throw new TypeError('network');
      if (typeof fail === 'number') return new Response('x', { status: fail });
      const data = records.slice((page - 1) * limit, page * limit);
      return new Response(JSON.stringify({ success: options.success ?? true, data: options.noData ? undefined : data, info: { totalCount: options.totalCount ?? records.length }, errors: [] }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    } finally { state.inFlight--; }
  };
  impl.state = state;
  return impl;
}

// R2 bucket double with the real ranged-read shape: size is the whole object, range is {offset,length}.
export function r2Stub(map = new Map(), options = {}) {
  const calls = [];
  return {
    map, calls,
    async get(key, opts) {
      calls.push({ key, opts });
      if (options.failGet?.(key)) throw new Error('r2 down');
      if (!map.has(key)) return null;
      const data = typeof map.get(key) === 'string' ? new TextEncoder().encode(map.get(key)) : map.get(key);
      const range = opts?.range ? { offset: opts.range.offset, length: Math.max(0, Math.min(opts.range.length, data.length - opts.range.offset)) } : undefined;
      const part = range ? data.slice(range.offset, range.offset + range.length) : data;
      const short = options.shortRange?.(key) ? part.slice(0, Math.max(0, part.length - 1)) : part;
      return { size: options.badSize?.(key) ? 0 : data.length, range: range && options.shortRange?.(key) ? { ...range, length: short.length } : range, body: new Blob([short]).stream(), text: async () => new TextDecoder().decode(short) };
    },
  };
}
// Fill a stub's map from a built snapshot (the writer produces the reader's fixtures, so the format cannot drift).
export function loadSnapshot(map, snapshot, prefix = 'np-catalog/v1/') {
  for (const [key, data] of snapshot.objects) map.set(`${prefix}${snapshot.manifest.snapshotId}/${key}`, data);
  map.set(`${prefix}current.json`, JSON.stringify(snapshot.manifest));
  return map;
}
