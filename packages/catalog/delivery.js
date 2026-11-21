// Nova Poshta delivery-point helpers (ADR-0011). Pure and dependency-free: shared by tools/np-catalog-sync.mjs and the Worker.
// The sync script writes the snapshot built here; the Worker only reads it, so the format cannot drift between them.
export const PREFIX = 'np-catalog/v1/';
export const SOURCE = 'api.novaposhta.ua/v2.0 Address.getWarehouses';
export const GUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
export const SNAPSHOT_ID = /^\d{8}T\d{6}Z$/;
export const KINDS = ['branch', 'postomat'];
export const MAX_CITY_RESULTS = 20;
const APOSTROPHES = /['’‘`´′]/g;
const QUERY = /^[\p{L}\p{N} ʼ\-.,()]+$/u;
const encoder = new TextEncoder();
export const bytes = text => encoder.encode(text);
const cpLength = value => [...value].length;

// NFC, drop format characters (zero-width, bidi), turn control characters into spaces, collapse whitespace, trim, apostrophe variants -> U+02BC.
export function normalizeText(value) {
  if (typeof value !== 'string') return '';
  return value.normalize('NFC').replace(/\p{Cf}/gu, '').replace(/\p{Cc}/gu, ' ').replace(/\s+/g, ' ').trim().replace(APOSTROPHES, 'ʼ');
}
// One folding for city names and queries, so a name and its own query always meet in the same shard.
export const foldName = value => value.toLowerCase();
export function normalizeQuery(value) {
  if (typeof value !== 'string') return null;
  const q = foldName(value.normalize('NFC').trim().replace(/\s+/g, ' ').replace(APOSTROPHES, 'ʼ'));
  const length = cpLength(q);
  return length >= 2 && length <= 50 && QUERY.test(q) ? q : null;
}
export const normalizeRef = value => typeof value === 'string' && GUID.test(value.trim().toLowerCase()) ? value.trim().toLowerCase() : null;

// Allowlist on CategoryOfWarehouse; everything else (DropOff, Fulfillment, OtherOperating, unknown, missing) is excluded.
export function classify(record) {
  const category = record?.CategoryOfWarehouse;
  if (category === 'Postomat') return 'postomat';
  if (category === 'Branch' || category === 'Store') return 'branch';
  return null;
}
export function normalizeNumber(value) {
  const text = typeof value === 'number' ? String(value) : value;
  return typeof text === 'string' && /^[0-9]{1,6}$/.test(text.trim()) ? text.trim() : null;
}
// Coordinates are kept only as a valid pair inside Ukraine's bounding box, rounded to 5 decimals.
export function normalizeCoordinates(latitude, longitude) {
  const lat = Number(latitude), lon = Number(longitude);
  const ok = Number.isFinite(lat) && Number.isFinite(lon) && lat !== 0 && lon !== 0 && lat >= 44 && lat <= 53 && lon >= 22 && lon <= 41;
  return ok ? { lat: Math.round(lat * 1e5) / 1e5, lon: Math.round(lon * 1e5) / 1e5 } : { lat: null, lon: null };
}
// Upstream record -> {cityRef, cityName, area, kind, point} or null when it is not a selectable pickup point.
export function reduceRecord(record) {
  if (!record || typeof record !== 'object') return null;
  const kind = classify(record);
  if (!kind || record.WarehouseStatus !== 'Working' || String(record.DenyToSelect) === '1') return null;
  const ref = normalizeRef(record.Ref), cityRef = normalizeRef(record.CityRef);
  if (!ref || !cityRef) return null;
  const cityName = normalizeText(record.CityDescription), name = [...normalizeText(record.Description)].slice(0, 200).join('');
  if (!cityName || !name) return null;
  const { lat, lon } = normalizeCoordinates(record.Latitude, record.Longitude);
  return { cityRef, cityName, area: normalizeText(record.SettlementAreaDescription), kind, point: { ref, number: normalizeNumber(record.Number), name, lat, lon } };
}

export const cityLetter = name => [...foldName(name)][0] ?? '';
export const cityShardKey = letter => encodeURIComponent(letter);
const compareText = (a, b) => (a < b ? -1 : a > b ? 1 : 0);
const numberOrder = number => (number === null ? Infinity : Number(number));
export const comparePoints = (a, b) => (numberOrder(a.number) - numberOrder(b.number)) || compareText(a.ref, b.ref) || 0;

export function snapshotIdFor(date) { return date.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}Z$/, 'Z'); }
export function snapshotTime(id) {
  const m = /^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})Z$/.exec(id);
  return m ? Date.parse(`${m[1]}-${m[2]}-${m[3]}T${m[4]}:${m[5]}:${m[6]}Z`) : NaN;
}
export const generatedAtFor = id => new Date(snapshotTime(id)).toISOString();

// Reduced records (deduplicated by the caller or here) -> every snapshot object (keys relative to PREFIX) plus the manifest.
// Layout (ADR-0011 section 2): cities/<letter>.json, points/<h>.json + points/<h>.idx.json (16 each), refs/<hh>.json (256), current.json written separately.
export function buildSnapshot(reduced, snapshotId) {
  const generatedAt = generatedAtFor(snapshotId);
  const seen = new Set(), cities = new Map();
  for (const item of reduced) {
    if (seen.has(item.point.ref)) continue;
    seen.add(item.point.ref);
    let city = cities.get(item.cityRef);
    if (!city) cities.set(item.cityRef, city = { ref: item.cityRef, name: item.cityName, area: item.area, branch: [], postomat: [] });
    city[item.kind].push(item.point);
  }
  const objects = new Map(), stats = { points: seen.size, cities: cities.size, branches: 0, postomats: 0 };
  const packs = Array.from({ length: 16 }, () => ({ parts: [], index: {}, size: 0 }));
  const refShards = new Map();
  const letters = new Map();
  for (const city of [...cities.values()].sort((a, b) => compareText(a.ref, b.ref))) {
    stats.branches += city.branch.length; stats.postomats += city.postomat.length;
    const letter = cityLetter(city.name);
    if (!letters.has(letter)) letters.set(letter, []);
    letters.get(letter).push({ ref: city.ref, name: city.name, area: city.area, branches: city.branch.length, postomats: city.postomat.length });
    const pack = packs[parseInt(city.ref[0], 16)];
    for (const kind of KINDS) {
      const items = city[kind].sort(comparePoints);
      if (!items.length) continue;
      const slice = bytes(JSON.stringify({ cityRef: city.ref, kind, generatedAt, items }));
      (pack.index[city.ref] ??= {})[kind] = [pack.size, slice.length];
      pack.parts.push(slice); pack.size += slice.length;
      for (const point of items) {
        const shard = point.ref.slice(0, 2);
        if (!refShards.has(shard)) refShards.set(shard, {});
        refShards.get(shard)[point.ref] = { cityRef: city.ref, cityName: city.name, kind, number: point.number, name: point.name };
      }
    }
  }
  packs.forEach((pack, i) => {
    const h = i.toString(16), body = new Uint8Array(pack.size);
    let offset = 0;
    for (const part of pack.parts) { body.set(part, offset); offset += part.length; }
    objects.set(`points/${h}.json`, body);
    objects.set(`points/${h}.idx.json`, bytes(JSON.stringify(pack.index)));
  });
  for (let i = 0; i < 256; i++) { const hh = i.toString(16).padStart(2, '0'); objects.set(`refs/${hh}.json`, bytes(JSON.stringify(refShards.get(hh) ?? {}))); }
  const cityLetters = [...letters.keys()].sort();
  for (const letter of cityLetters) {
    const list = letters.get(letter).sort((a, b) => ((b.branches + b.postomats) - (a.branches + a.postomats)) || compareText(a.name, b.name) || compareText(a.ref, b.ref));
    objects.set(`cities/${cityShardKey(letter)}.json`, bytes(JSON.stringify(list)));
  }
  const manifest = { version: 1, snapshotId, generatedAt, points: stats.points, cities: stats.cities, branches: stats.branches, postomats: stats.postomats, cityLetters, source: SOURCE };
  return { objects, manifest, stats };
}

// A manifest is usable when it parses, is version 1 and has a well-formed snapshotId (ADR-0011 section 4). Returns the object or null.
export function parseManifest(text) {
  let value;
  try { value = JSON.parse(text); } catch { return null; }
  if (!value || typeof value !== 'object' || Array.isArray(value) || value.version !== 1 || typeof value.snapshotId !== 'string' || !SNAPSHOT_ID.test(value.snapshotId) || !Array.isArray(value.cityLetters) || !Number.isSafeInteger(value.points) || value.points < 0) return null;
  return value;
}

// Prefix match on a city shard: exact name first, then shard order (bigger cities first), at most 20.
export function searchCities(shard, q) {
  const exact = [], rest = [];
  for (const city of shard) {
    const name = foldName(city.name);
    if (name === q) exact.push(city); else if (name.startsWith(q)) rest.push(city);
  }
  return exact.concat(rest).slice(0, MAX_CITY_RESULTS);
}

// Strict RFC 3986 percent-encoding of one path segment or query component.
export const rfc3986 = value => encodeURIComponent(value).replace(/[!*'()]/g, ch => `%${ch.charCodeAt(0).toString(16).toUpperCase()}`);
// A stored key to a URL path: every segment encoded (so the literal '%' of a city shard key becomes %25), segments joined by '/'.
export const encodeKeyPath = key => key.split('/').map(rfc3986).join('/');
