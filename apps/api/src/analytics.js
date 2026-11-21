// Admin dashboard: cookieless visit statistics, sales and supplier metrics.
//
// Visits: the storefront sends a beacon per page view and one when the page is hidden. Nothing is stored on
// the device and no IP address or user agent is stored: the visitor key is a truncated SHA-256 of a random
// per-day salt, the IP and the user agent, and the salt is deleted once its Europe/Kyiv day is over.
import { can } from './permissions.js';
import { throttle } from './customer-auth.js';

export const TIME_ZONE = 'Europe/Kyiv';
export const SESSION_GAP_MS = 30 * 60 * 1000;
export const RETENTION_DAYS = 395;
export const MAX_PAGEVIEWS = 1000;
export const SESSION_CAP_SECONDS = 4 * 3600;
export const DASHBOARD_RANGES = [7, 30, 90];
// New sessions per IP per hour. Generous for shared mobile-carrier IPs; ongoing sessions only update their row.
export const NEW_SESSIONS_PER_IP_HOUR = 120;
const BODY_LIMIT = 2048;
export const SOLD_STATUSES = ['verified', 'sent_to_suppliers', 'completed'];
export const OPEN_STATUSES = ['submitted', 'verified', 'sent_to_suppliers'];
const BOT_RE = /bot|crawl|spider|slurp|scrap|headless|lighthouse|pagespeed|preview|facebookexternalhit|embedly|whatsapp|telegram|curl|wget|python|httpclient|okhttp|java\/|go-http|axios|node-fetch|monitor|uptime/i;

const json = (data, status = 200) => new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' } });
const noContent = () => new Response(null, { status: 204, headers: { 'Cache-Control': 'no-store' } });

const dayFormat = new Intl.DateTimeFormat('en-CA', { timeZone: TIME_ZONE, year: 'numeric', month: '2-digit', day: '2-digit' });
const wallFormat = new Intl.DateTimeFormat('en-CA', { timeZone: TIME_ZONE, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit' });
/** Europe/Kyiv calendar day (YYYY-MM-DD) of an instant. */
export const kyivDay = (at = new Date()) => dayFormat.format(at instanceof Date ? at : new Date(at));
function wallClockMs(ms) {
  const p = Object.fromEntries(wallFormat.formatToParts(new Date(ms)).map(part => [part.type, part.value]));
  return Date.UTC(+p.year, +p.month - 1, +p.day, +p.hour, +p.minute, +p.second);
}
/** UTC instant of 00:00 Europe/Kyiv on `day`. */
export function kyivMidnight(day) {
  const [y, m, d] = day.split('-').map(Number), target = Date.UTC(y, m - 1, d);
  let t = target;
  for (let i = 0; i < 3; i++) t -= wallClockMs(t) - target;
  return new Date(t);
}
/** Calendar arithmetic on YYYY-MM-DD, independent of time zones. */
export function addDays(day, delta) {
  const [y, m, d] = day.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d + delta)).toISOString().slice(0, 10);
}
export function dayRange(days, today = kyivDay()) {
  return Array.from({ length: days }, (_, i) => addDays(today, i - days + 1));
}

async function sha256Hex(text) {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return [...new Uint8Array(digest)].map(b => b.toString(16).padStart(2, '0')).join('');
}
function randomHex(bytes = 32) {
  return [...crypto.getRandomValues(new Uint8Array(bytes))].map(b => b.toString(16).padStart(2, '0')).join('');
}

/** Today's salt; creating it also deletes earlier salts and sessions past retention (so no cron is needed). */
export async function daySalt(env, day, now = new Date()) {
  const found = await env.DB.prepare('SELECT salt FROM analytics_salts WHERE day=?').bind(day).first();
  if (found) return found.salt;
  const cutoff = new Date(now.getTime() - RETENTION_DAYS * 86400000).toISOString();
  await env.DB.batch([
    env.DB.prepare('INSERT OR IGNORE INTO analytics_salts(day,salt,created_at) VALUES(?,?,?)').bind(day, randomHex(), now.toISOString()),
    env.DB.prepare('DELETE FROM analytics_salts WHERE day<?').bind(day),
    env.DB.prepare('DELETE FROM visit_sessions WHERE started_at<?').bind(cutoff),
    env.DB.prepare("DELETE FROM customer_auth_throttle WHERE bucket='visit-new' AND window_start<?").bind(Math.floor(now.getTime() / 1000) - 86400)
  ]);
  return (await env.DB.prepare('SELECT salt FROM analytics_salts WHERE day=?').bind(day).first()).salt;
}

export const deviceOf = ua => /iPad|Tablet|PlayBook|Silk|(Android(?!.*Mobile))/i.test(ua) ? 'tablet' : /Mobi|iPhone|iPod|Android|Windows Phone/i.test(ua) ? 'mobile' : 'desktop';
export const isBot = (ua, cf) => !ua || ua.length > 512 || BOT_RE.test(ua) || cf?.botManagement?.verifiedBot === true;

/** Page path without query or fragment, or null when it must not be counted. */
export function cleanPath(value, isPrivatePath) {
  if (typeof value !== 'string' || !value.startsWith('/') || value.startsWith('//') || value.length > 300) return null;
  const path = value.split(/[?#]/)[0];
  if (!/^\/[\p{L}\p{N}\-._~/%]*$/u.test(path) || path.length > 200 || isPrivatePath(path)) return null;
  return path;
}
export function referrerHost(value, ownHost) {
  if (typeof value !== 'string' || !value || value.length > 2048) return null;
  try {
    const url = new URL(value);
    if (url.protocol !== 'https:' && url.protocol !== 'http:') return null;
    const host = url.hostname.toLowerCase().replace(/^www\./, '');
    return host && host !== String(ownHost || '').toLowerCase().replace(/^www\./, '') && host.length <= 100 ? host : null;
  } catch { return null; }
}
const country = cf => (typeof cf?.country === 'string' && /^[A-Z]{2}$/.test(cf.country) && !['XX', 'T1'].includes(cf.country) ? cf.country : null);
const region = cf => (typeof cf?.region === 'string' && cf.region.trim() && cf.region.length <= 80 ? cf.region.trim() : null);

// Streams at most `limit` bytes and cancels the upload beyond it, whether or not Content-Length is sent.
async function readSmallBody(request, limit = BODY_LIMIT) {
  if (Number(request.headers.get('Content-Length')) > limit) return null;
  const reader = request.body?.getReader();
  if (!reader) return null;
  const chunks = []; let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > limit) { await reader.cancel(); return null; }
      chunks.push(value);
    }
  } finally { reader.releaseLock(); }
  const bytes = new Uint8Array(size); let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length; }
  try { const body = JSON.parse(new TextDecoder().decode(bytes)); return body && typeof body === 'object' && !Array.isArray(body) ? body : null; } catch { return null; }
}
const optedOut = request => request.headers.get('Sec-GPC') === '1' || request.headers.get('DNT') === '1';

/** POST /api/visit {type:'view'|'leave', path, ref?} -> 204. Public, same-origin, best effort: never an error page for the visitor. */
export async function recordVisit(request, env, isPrivatePath, now = new Date()) {
  if (request.method !== 'POST') return json({ error: 'Method not allowed' }, 405);
  const type = (request.headers.get('Content-Type') || '').split(';')[0].trim();
  if (type !== 'application/json' && type !== 'text/plain') return json({ error: 'invalid_request' }, 415);
  const body = await readSmallBody(request);
  if (!body || !['view', 'leave'].includes(body.type)) return json({ error: 'invalid_request' }, 400);
  const path = cleanPath(body.path, isPrivatePath);
  const ua = request.headers.get('User-Agent') || '';
  if (!path || isBot(ua, request.cf) || optedOut(request)) return noContent();
  const at = now.toISOString(), day = kyivDay(now);
  const ip = request.headers.get('CF-Connecting-IP') || 'local';
  const salt = await daySalt(env, day, now);
  const visitor = (await sha256Hex(`${salt}|${ip}|${ua}`)).slice(0, 32);
  const since = new Date(now.getTime() - SESSION_GAP_MS).toISOString();
  const open = await env.DB.prepare('SELECT id FROM visit_sessions WHERE visitor=? AND last_seen_at>=? ORDER BY last_seen_at DESC LIMIT 1').bind(visitor, since).first();
  if (body.type === 'leave') {
    if (open) await env.DB.prepare('UPDATE visit_sessions SET last_seen_at=? WHERE id=? AND last_seen_at<?').bind(at, open.id, at).run();
    return noContent();
  }
  if (open) await env.DB.prepare('UPDATE visit_sessions SET pageviews=MIN(pageviews+1,?), last_seen_at=? WHERE id=?').bind(MAX_PAGEVIEWS, at, open.id).run();
  else {
    // Bound new rows per IP so a script rotating user agents cannot flood D1. The key is HMAC(daily salt, IP): no IP at rest.
    try { await throttle(env, salt, 'visit-new', ip, NEW_SESSIONS_PER_IP_HOUR, 3600); }
    catch (error) { if (!error?.retryAfter) console.error('Visit throttle failed', error?.name || 'Error'); return noContent(); }
    await env.DB.prepare('INSERT INTO visit_sessions(id,visitor,day,started_at,last_seen_at,pageviews,country,region,device,referrer,entry_path) VALUES(?,?,?,?,?,1,?,?,?,?,?)')
    .bind(crypto.randomUUID(), visitor, day, at, at, country(request.cf), region(request.cf), deviceOf(ua), referrerHost(body.ref, new URL(request.url).hostname), path).run();
  }
  return noContent();
}

const all = async (env, sql, ...bindings) => (await env.DB.prepare(sql).bind(...bindings).all()).results;

/** Splits a cart line across the suppliers that fill it (merged duplicates carry allocations_json). */
export function lineParts(line) {
  let allocations = null;
  try { allocations = line.allocations_json ? JSON.parse(line.allocations_json) : null; } catch { allocations = null; }
  const single = [{ supplierId: line.supplier_id, supplierName: line.supplier_name, quantity: line.quantity, unitCostMinor: line.unit_cost_minor ?? null }];
  const parts = Array.isArray(allocations) && allocations.length && allocations.every(a => a && typeof a.supplierId === 'string' && Number.isInteger(a.quantity) && a.quantity > 0)
    && allocations.reduce((sum, a) => sum + a.quantity, 0) === line.quantity
    ? allocations.map(a => ({ supplierId: a.supplierId, supplierName: typeof a.supplierName === 'string' ? a.supplierName : a.supplierId, quantity: a.quantity, unitCostMinor: Number.isInteger(a.unitCostMinor) ? a.unitCostMinor : null }))
    : single;
  // Revenue is split by quantity; the last part takes the rounding remainder so the parts sum to the line total.
  let left = line.line_total_minor;
  return parts.map((part, i) => {
    const revenueMinor = i === parts.length - 1 ? left : Math.round(line.line_total_minor * part.quantity / line.quantity);
    left -= revenueMinor;
    return { ...part, revenueMinor, costMinor: part.unitCostMinor === null ? null : part.unitCostMinor * part.quantity };
  });
}

async function visitMetrics(env, days, from) {
  const totals = await env.DB.prepare(`SELECT COUNT(*) AS sessions, COALESCE(SUM(pageviews),0) AS pageviews,
      AVG(MIN((julianday(last_seen_at)-julianday(started_at))*86400, ${SESSION_CAP_SECONDS})) AS avg_seconds,
      SUM(CASE WHEN pageviews<=1 THEN 1 ELSE 0 END) AS bounces FROM visit_sessions WHERE day>=?`).bind(from).first();
  const daily = new Map((await all(env, 'SELECT day, COUNT(DISTINCT visitor) AS visitors, COUNT(*) AS sessions, SUM(pageviews) AS pageviews FROM visit_sessions WHERE day>=? GROUP BY day', from)).map(r => [r.day, r]));
  const group = (column, limit, extra = '') => all(env, `SELECT ${column} AS key, COUNT(*) AS sessions FROM visit_sessions WHERE day>=? ${extra} GROUP BY ${column} ORDER BY sessions DESC, key LIMIT ${limit}`, from);
  const regions = await all(env, 'SELECT country, region, COUNT(*) AS sessions FROM visit_sessions WHERE day>=? AND region IS NOT NULL GROUP BY country, region ORDER BY sessions DESC, region LIMIT 10', from);
  const series = days.map(day => ({ day, visitors: daily.get(day)?.visitors ?? 0, sessions: daily.get(day)?.sessions ?? 0, pageviews: daily.get(day)?.pageviews ?? 0 }));
  const sessions = totals?.sessions ?? 0;
  return {
    today: series.at(-1),
    period: {
      visitors: series.reduce((sum, d) => sum + d.visitors, 0), sessions, pageviews: totals?.pageviews ?? 0,
      avgSessionSeconds: sessions ? Math.round(totals.avg_seconds ?? 0) : 0,
      bounceRate: sessions ? (totals.bounces ?? 0) / sessions : 0
    },
    daily: series,
    countries: (await group('country', 10)).map(r => ({ country: r.key, sessions: r.sessions })),
    regions: regions.map(r => ({ country: r.country, region: r.region, sessions: r.sessions })),
    devices: (await group('device', 3)).map(r => ({ device: r.key, sessions: r.sessions })),
    referrers: (await group('referrer', 8, 'AND referrer IS NOT NULL')).map(r => ({ host: r.key, sessions: r.sessions })),
    entryPages: (await group('entry_path', 8, 'AND entry_path IS NOT NULL')).map(r => ({ path: r.key, sessions: r.sessions }))
  };
}

async function salesMetrics(env, days, fromInstant, statuses) {
  const carts = await all(env, 'SELECT id, status, created_at, item_count, total_minor FROM carts WHERE created_at>=? ORDER BY created_at', fromInstant);
  const counted = new Set(statuses);
  const lines = await all(env, `SELECT l.cart_id, l.product_id, l.title, l.quantity, l.line_total_minor, l.supplier_id, l.supplier_name, l.unit_cost_minor, l.allocations_json, c.created_at
    FROM cart_lines l JOIN carts c ON c.id=l.cart_id WHERE c.created_at>=? AND c.status IN (${statuses.map(() => '?').join(',')})`, fromInstant, ...statuses);
  const supplierNames = new Map((await all(env, 'SELECT id, name FROM suppliers')).map(r => [r.id, r.name]));
  const byDay = new Map(days.map(day => [day, { day, orders: 0, units: 0, revenueMinor: 0, newOrders: 0 }]));
  // Status counts are current totals across all carts (the order queue), not limited to the selected period.
  const status = { submitted: 0, verified: 0, sent_to_suppliers: 0, completed: 0, cancelled: 0 };
  for (const row of await all(env, 'SELECT status, COUNT(*) AS n FROM carts GROUP BY status')) if (Object.hasOwn(status, row.status)) status[row.status] = row.n;
  for (const cart of carts) {
    const bucket = byDay.get(kyivDay(cart.created_at));
    if (!bucket) continue;
    if (cart.status !== 'cancelled') bucket.newOrders++;
    if (counted.has(cart.status)) { bucket.orders++; bucket.revenueMinor += cart.total_minor; }
  }
  const products = new Map(), suppliers = new Map();
  for (const line of lines) {
    const bucket = byDay.get(kyivDay(line.created_at));
    if (bucket) bucket.units += line.quantity;
    const product = products.get(line.product_id) || { productId: line.product_id, title: line.title, units: 0, revenueMinor: 0 };
    product.units += line.quantity; product.revenueMinor += line.line_total_minor; products.set(line.product_id, product);
    for (const part of lineParts(line)) {
      const s = suppliers.get(part.supplierId) || { supplierId: part.supplierId, name: supplierNames.get(part.supplierId) || part.supplierName, units: 0, revenueMinor: 0, costMinor: 0, costKnown: true, orders: new Set() };
      s.units += part.quantity; s.revenueMinor += part.revenueMinor; s.orders.add(line.cart_id);
      if (part.costMinor === null) s.costKnown = false; else s.costMinor += part.costMinor;
      suppliers.set(part.supplierId, s);
    }
  }
  const daily = [...byDay.values()];
  const sum = key => daily.reduce((total, d) => total + d[key], 0);
  return {
    today: daily.at(-1),
    period: { orders: sum('orders'), units: sum('units'), revenueMinor: sum('revenueMinor'), newOrders: sum('newOrders'), averageOrderMinor: sum('orders') ? Math.round(sum('revenueMinor') / sum('orders')) : 0 },
    daily,
    statusCounts: status,
    topProducts: [...products.values()].sort((a, b) => b.units - a.units || b.revenueMinor - a.revenueMinor).slice(0, 10),
    suppliers: [...suppliers.values()].map(({ orders, costKnown, costMinor, ...rest }) => ({ ...rest, orders: orders.size, costMinor: costKnown ? costMinor : null, marginMinor: costKnown ? rest.revenueMinor - costMinor : null }))
      .sort((a, b) => b.units - a.units || b.revenueMinor - a.revenueMinor)
  };
}

async function catalogMetrics(env) {
  const row = await env.DB.prepare(`SELECT COUNT(*) AS products,
      SUM(CASE WHEN json_extract(p.overrides_json,'$.published')=1 THEN 1 ELSE 0 END) AS published
    FROM products p JOIN suppliers s ON s.id=p.supplier_id WHERE p.deleted_at IS NULL AND s.deleted_at IS NULL`).first();
  const suppliers = await env.DB.prepare('SELECT COUNT(*) AS n FROM suppliers WHERE deleted_at IS NULL AND enabled=1').first();
  return { products: row?.products ?? 0, published: row?.published ?? 0, drafts: (row?.products ?? 0) - (row?.published ?? 0), activeSuppliers: suppliers?.n ?? 0 };
}

/** Renewals that need attention: no date yet, overdue, or due within `withinDays`. */
export async function renewalAlerts(env, today = kyivDay(), withinDays = 30) {
  const limit = addDays(today, withinDays);
  return (await all(env, 'SELECT id, kind, name, due_date, auto_renew FROM infra_renewals WHERE due_date IS NULL OR due_date<=? ORDER BY due_date IS NOT NULL, due_date, name', limit))
    .map(r => ({ id: r.id, kind: r.kind, name: r.name, dueDate: r.due_date, autoRenew: !!r.auto_renew, daysLeft: r.due_date ? Math.round((Date.parse(r.due_date) - Date.parse(today)) / 86400000) : null }));
}

/** GET /api/admin/dashboard?days=7|30|90&scope=confirmed|open */
export async function dashboard({ env, url }, now = new Date()) {
  const days = Number(url.searchParams.get('days') || 30), scope = url.searchParams.get('scope') || 'confirmed';
  if (!DASHBOARD_RANGES.includes(days) || !['confirmed', 'open'].includes(scope)) return json({ error: 'invalid_request' }, 400);
  const today = kyivDay(now), range = dayRange(days, today), fromInstant = kyivMidnight(range[0]).toISOString();
  const [visits, sales, catalog] = await Promise.all([visitMetrics(env, range, range[0]), salesMetrics(env, range, fromInstant, scope === 'open' ? OPEN_STATUSES : SOLD_STATUSES), catalogMetrics(env)]);
  return json({
    range: { days, from: range[0], to: today, timeZone: TIME_ZONE, scope },
    visits, sales, catalog,
    conversion: visits.period.sessions ? sales.period.newOrders / visits.period.sessions : null,
    renewals: can(env.PRINCIPAL, 'infra.read') ? await renewalAlerts(env, today) : []
  });
}
