// Infrastructure usage, cost estimate and renewal reminders. Owner only (infra.read / settings.manage).
//
// Measured inside the Worker (always available): D1 database size and table row counts, R2 object totals
// (paginated list, cached). Cloudflare account analytics (Worker requests and CPU, D1 rows read/written,
// R2 operations) need an API token with "Account Analytics: Read" as the CF_ANALYTICS_API_TOKEN secret plus
// INFRA_ACCOUNT_ID, and optionally INFRA_D1_DATABASE_ID / INFRA_R2_BUCKET vars. Without them the page says so.
import { auditStatement } from './permissions.js';
import { kyivDay } from './analytics.js';

const json = (data, status = 200) => new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' } });
const bad = (error, status = 400, extra = {}) => json({ error, ...extra }, status);
const GB = 1e9;

// Published Cloudflare list prices and allowances, USD. Checked 2026-11-20 against the pages in `sources`;
// re-check them there before relying on an estimate. The estimate is not a bill.
export const PRICING = Object.freeze({
  checkedOn: '2026-11-20',
  sources: Object.freeze({
    workers: 'https://developers.cloudflare.com/workers/platform/pricing/',
    d1: 'https://developers.cloudflare.com/d1/platform/pricing/',
    d1Limits: 'https://developers.cloudflare.com/d1/platform/limits/',
    r2: 'https://developers.cloudflare.com/r2/pricing/'
  }),
  plans: Object.freeze({
    workers_paid: Object.freeze({
      label: 'Workers Paid', baseUsd: 5, period: 'month',
      workerRequests: { included: 10e6, perMillionUsd: 0.30 },
      workerCpuMs: { included: 30e6, perMillionUsd: 0.02 },
      d1RowsRead: { included: 25e9, perMillionUsd: 0.001 },
      d1RowsWritten: { included: 50e6, perMillionUsd: 1.00 },
      d1StorageBytes: { included: 5 * GB, perGbMonthUsd: 0.75 },
      d1MaxDatabaseBytes: 10 * GB
    }),
    workers_free: Object.freeze({
      label: 'Workers Free', baseUsd: 0, period: 'day',
      workerRequests: { includedPerDay: 100e3 },
      d1RowsRead: { includedPerDay: 5e6 },
      d1RowsWritten: { includedPerDay: 100e3 },
      d1StorageBytes: { included: 5 * GB },
      d1MaxDatabaseBytes: 500e6
    })
  }),
  r2: Object.freeze({ storageBytes: { included: 10 * GB, perGbMonthUsd: 0.015 }, classA: { included: 1e6, perMillionUsd: 4.50 }, classB: { included: 10e6, perMillionUsd: 0.36 } })
});
export const PLANS = Object.keys(PRICING.plans);

// R2 operation classes (https://developers.cloudflare.com/r2/pricing/#class-a-operations). Deletes are free.
const R2_CLASS_A = new Set(['ListBuckets', 'PutBucket', 'ListObjects', 'PutObject', 'CopyObject', 'CompleteMultipartUpload', 'CreateMultipartUpload', 'LifecycleStorageTierTransition', 'ListMultipartUploads', 'UploadPart', 'UploadPartCopy', 'ListParts', 'PutBucketEncryption', 'PutBucketCors', 'PutBucketLifecycleConfiguration']);
const R2_FREE = new Set(['DeleteObject', 'DeleteBucket', 'AbortMultipartUpload', 'DeleteObjects']);
export const r2Class = action => (R2_FREE.has(action) ? 'free' : R2_CLASS_A.has(action) ? 'A' : 'B');

const R2_CACHE_MS = 6 * 3600 * 1000, R2_MIN_REFRESH_MS = 5 * 60 * 1000, CF_CACHE_MS = 15 * 60 * 1000, R2_MAX_PAGES = 50;

async function snapshot(env, key) {
  const row = await env.DB.prepare('SELECT value_json, measured_at FROM infra_snapshots WHERE key=?').bind(key).first();
  if (!row) return null;
  try { return { value: JSON.parse(row.value_json), measuredAt: row.measured_at }; } catch { return null; }
}
async function storeSnapshot(env, key, value, at) {
  await env.DB.prepare('INSERT INTO infra_snapshots(key,value_json,measured_at) VALUES(?,?,?) ON CONFLICT(key) DO UPDATE SET value_json=excluded.value_json, measured_at=excluded.measured_at').bind(key, JSON.stringify(value), at).run();
}

const TABLES = ['products', 'suppliers', 'carts', 'cart_lines', 'customers', 'audit_events', 'visit_sessions', 'sync_runs'];
export async function d1Usage(env) {
  const result = await env.DB.prepare(`SELECT ${TABLES.map(t => `(SELECT COUNT(*) FROM ${t}) AS ${t}`).join(', ')}`).all();
  const row = result.results?.[0] || {};
  const size = result.meta?.size_after;
  return { sizeBytes: Number.isFinite(size) ? size : null, tables: TABLES.map(name => ({ name, rows: row[name] ?? 0 })) };
}

async function measureBucket(bucket) {
  let cursor, bytes = 0, objects = 0, pages = 0, truncated = false;
  do {
    const page = await bucket.list({ limit: 1000, ...(cursor ? { cursor } : {}) });
    for (const object of page.objects || []) { bytes += object.size || 0; objects++; }
    cursor = page.truncated ? page.cursor : undefined;
    pages++;
    if (cursor && pages >= R2_MAX_PAGES) { truncated = true; break; }
  } while (cursor);
  return { bytes, objects, truncated };
}
/** R2 totals per bound bucket, cached for six hours (a refresh is honoured at most every five minutes). */
export async function r2Usage(env, refresh = false, now = new Date()) {
  const buckets = [['MEDIA', 'Медіа (фото товарів)'], ['NP_CATALOG', 'Довідник Нової пошти']].filter(([binding]) => env[binding] && typeof env[binding].list === 'function');
  const out = [];
  for (const [binding, label] of buckets) {
    const key = `r2.${binding}`, cached = await snapshot(env, key);
    const age = cached ? now - Date.parse(cached.measuredAt) : Infinity;
    if (cached && (age < (refresh ? R2_MIN_REFRESH_MS : R2_CACHE_MS))) { out.push({ binding, label, ...cached.value, measuredAt: cached.measuredAt }); continue; }
    try {
      const value = await measureBucket(env[binding]), at = now.toISOString();
      await storeSnapshot(env, key, value, at);
      out.push({ binding, label, ...value, measuredAt: at });
    } catch {
      out.push({ binding, label, ...(cached?.value || {}), measuredAt: cached?.measuredAt ?? null, error: 'measure_failed' });
    }
  }
  return out;
}

export function cloudflareConfig(env) {
  const missing = [];
  if (!env.CF_ANALYTICS_API_TOKEN) missing.push('CF_ANALYTICS_API_TOKEN (secret)');
  if (!/^[0-9a-f]{32}$/.test(env.INFRA_ACCOUNT_ID || '')) missing.push('INFRA_ACCOUNT_ID (var)');
  const workerName = env.INFRA_WORKER_NAME || (env.APP_ENV === 'staging' ? 'lorem-store-staging' : 'lorem-store');
  return { configured: !missing.length, missing, workerName, databaseId: env.INFRA_D1_DATABASE_ID || null, bucketName: env.INFRA_R2_BUCKET || null };
}

const GRAPHQL = 'https://api.cloudflare.com/client/v4/graphql';
const QUERIES = {
  worker: `query($a:String!,$s:String!,$from:Time!,$to:Time!){viewer{accounts(filter:{accountTag:$a}){workersInvocationsAdaptive(limit:10000,filter:{scriptName:$s,datetime_geq:$from,datetime_leq:$to}){sum{requests errors subrequests}}}}}`,
  workerCpu: `query($a:String!,$s:String!,$from:Time!,$to:Time!){viewer{accounts(filter:{accountTag:$a}){workersInvocationsAdaptive(limit:10000,filter:{scriptName:$s,datetime_geq:$from,datetime_leq:$to}){sum{cpuTimeUs}}}}}`,
  d1: `query($a:String!,$d:String!,$fromDate:Date!,$toDate:Date!){viewer{accounts(filter:{accountTag:$a}){d1AnalyticsAdaptiveGroups(limit:10000,filter:{databaseId:$d,date_geq:$fromDate,date_leq:$toDate}){sum{readQueries writeQueries rowsRead rowsWritten}}}}}`,
  r2Ops: `query($a:String!,$b:String!,$from:Time!,$to:Time!){viewer{accounts(filter:{accountTag:$a}){r2OperationsAdaptiveGroups(limit:10000,filter:{bucketName:$b,datetime_geq:$from,datetime_leq:$to}){sum{requests} dimensions{actionType}}}}}`
};
async function graphql(fetchImpl, token, query, variables) {
  const response = await fetchImpl(GRAPHQL, { method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ query, variables }), signal: AbortSignal.timeout(10000) });
  const body = await response.json().catch(() => null);
  if (!response.ok || !body || body.errors?.length || !body.data?.viewer?.accounts?.[0]) throw new Error('graphql_failed');
  return body.data.viewer.accounts[0];
}
const sumOf = (groups, field) => (groups || []).reduce((total, g) => total + (Number(g?.sum?.[field]) || 0), 0);

/** Month-to-date (UTC) account analytics for this Worker, its D1 database and media bucket. Each part fails alone. */
export async function cloudflareUsage(env, fetchImpl = fetch, now = new Date(), refresh = false) {
  const config = cloudflareConfig(env);
  if (!config.configured) return { configured: false, missing: config.missing };
  const cached = await snapshot(env, 'cf.usage');
  if (cached && !refresh && now - Date.parse(cached.measuredAt) < CF_CACHE_MS) return { configured: true, ...cached.value, measuredAt: cached.measuredAt };
  const from = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1)), base = { a: env.INFRA_ACCOUNT_ID };
  const period = { from: from.toISOString(), to: now.toISOString() }, times = { ...base, from: period.from, to: period.to };
  const run = async (key, variables, pick) => { try { return pick(await graphql(fetchImpl, env.CF_ANALYTICS_API_TOKEN, QUERIES[key], variables)); } catch { return { error: 'unavailable' }; } };
  const [worker, cpu, d1, r2] = await Promise.all([
    run('worker', { ...times, s: config.workerName }, a => ({ requests: sumOf(a.workersInvocationsAdaptive, 'requests'), errors: sumOf(a.workersInvocationsAdaptive, 'errors'), subrequests: sumOf(a.workersInvocationsAdaptive, 'subrequests') })),
    run('workerCpu', { ...times, s: config.workerName }, a => ({ cpuMs: Math.round(sumOf(a.workersInvocationsAdaptive, 'cpuTimeUs') / 1000) })),
    config.databaseId ? run('d1', { ...base, d: config.databaseId, fromDate: period.from.slice(0, 10), toDate: period.to.slice(0, 10) }, a => ({ rowsRead: sumOf(a.d1AnalyticsAdaptiveGroups, 'rowsRead'), rowsWritten: sumOf(a.d1AnalyticsAdaptiveGroups, 'rowsWritten'), readQueries: sumOf(a.d1AnalyticsAdaptiveGroups, 'readQueries'), writeQueries: sumOf(a.d1AnalyticsAdaptiveGroups, 'writeQueries') })) : { error: 'not_configured' },
    config.bucketName ? run('r2Ops', { ...times, b: config.bucketName }, a => {
      const out = { classA: 0, classB: 0, free: 0 };
      for (const g of a.r2OperationsAdaptiveGroups || []) out[r2Class(g?.dimensions?.actionType) === 'A' ? 'classA' : r2Class(g?.dimensions?.actionType) === 'B' ? 'classB' : 'free'] += Number(g?.sum?.requests) || 0;
      return out;
    }) : { error: 'not_configured' }
  ]);
  const value = { period, workerName: config.workerName, worker: worker.error ? worker : { ...worker, ...(cpu.error ? {} : cpu) }, d1, r2 };
  const at = now.toISOString();
  if (!worker.error || !d1.error || !r2.error) await storeSnapshot(env, 'cf.usage', value, at);
  return { configured: true, ...value, measuredAt: at };
}

const overage = (used, included, perMillionUsd) => (Number.isFinite(used) ? Math.max(0, used - included) / 1e6 * perMillionUsd : null);
const round2 = usd => (usd === null ? null : Math.round(usd * 100) / 100);
/** Monthly cost estimate lines for the chosen plan. Usage that could not be measured gives a null cost, never a guess. */
export function estimate(plan, { d1SizeBytes = null, r2Bytes = null, cf = null } = {}) {
  const p = PRICING.plans[plan], r2 = PRICING.r2, lines = [];
  const w = cf?.configured && !cf.worker?.error ? cf.worker : null, d = cf?.configured && !cf.d1?.error ? cf.d1 : null, o = cf?.configured && !cf.r2?.error ? cf.r2 : null;
  lines.push({ key: 'base', label: `${p.label}: базова підписка`, costUsd: p.baseUsd });
  if (plan === 'workers_paid') {
    lines.push({ key: 'workerRequests', label: 'Запити до Worker', used: w?.requests ?? null, included: p.workerRequests.included, unit: 'requests', costUsd: round2(overage(w?.requests, p.workerRequests.included, p.workerRequests.perMillionUsd)) });
    lines.push({ key: 'workerCpu', label: 'Час CPU Worker', used: w?.cpuMs ?? null, included: p.workerCpuMs.included, unit: 'ms', costUsd: round2(overage(w?.cpuMs, p.workerCpuMs.included, p.workerCpuMs.perMillionUsd)) });
    lines.push({ key: 'd1RowsRead', label: 'D1: прочитані рядки', used: d?.rowsRead ?? null, included: p.d1RowsRead.included, unit: 'rows', costUsd: round2(overage(d?.rowsRead, p.d1RowsRead.included, p.d1RowsRead.perMillionUsd)) });
    lines.push({ key: 'd1RowsWritten', label: 'D1: записані рядки', used: d?.rowsWritten ?? null, included: p.d1RowsWritten.included, unit: 'rows', costUsd: round2(overage(d?.rowsWritten, p.d1RowsWritten.included, p.d1RowsWritten.perMillionUsd)) });
    lines.push({ key: 'd1Storage', label: 'D1: сховище', used: d1SizeBytes, included: p.d1StorageBytes.included, unit: 'bytes', costUsd: d1SizeBytes === null ? null : round2(Math.max(0, d1SizeBytes - p.d1StorageBytes.included) / GB * p.d1StorageBytes.perGbMonthUsd) });
  }
  lines.push({ key: 'r2Storage', label: 'R2: сховище', used: r2Bytes, included: r2.storageBytes.included, unit: 'bytes', costUsd: r2Bytes === null ? null : round2(Math.max(0, r2Bytes - r2.storageBytes.included) / GB * r2.storageBytes.perGbMonthUsd) });
  lines.push({ key: 'r2ClassA', label: 'R2: операції класу A', used: o?.classA ?? null, included: r2.classA.included, unit: 'operations', costUsd: round2(overage(o?.classA, r2.classA.included, r2.classA.perMillionUsd)) });
  lines.push({ key: 'r2ClassB', label: 'R2: операції класу B', used: o?.classB ?? null, included: r2.classB.included, unit: 'operations', costUsd: round2(overage(o?.classB, r2.classB.included, r2.classB.perMillionUsd)) });
  const known = lines.filter(line => line.costUsd !== null);
  return { lines, totalUsd: round2(known.reduce((total, line) => total + line.costUsd, 0)), complete: known.length === lines.length };
}

const renewal = r => ({ id: r.id, kind: r.kind, name: r.name, dueDate: r.due_date, costMinor: r.cost_minor, currency: r.currency, autoRenew: !!r.auto_renew, notes: r.notes, updatedAt: r.updated_at });
export async function listRenewals(env) {
  return (await env.DB.prepare('SELECT * FROM infra_renewals ORDER BY due_date IS NULL DESC, due_date, name').all()).results.map(renewal);
}

/** GET /api/admin/infra[?refresh=1] */
export async function infraOverview({ env, url }, fetchImpl = fetch, now = new Date()) {
  const refresh = url.searchParams.get('refresh') === '1';
  const settings = await env.DB.prepare('SELECT plan, updated_at FROM infra_settings WHERE id=1').first();
  const plan = PLANS.includes(settings?.plan) ? settings.plan : 'workers_paid';
  const [d1, r2, cf, renewals] = await Promise.all([d1Usage(env), r2Usage(env, refresh, now), cloudflareUsage(env, fetchImpl, now, refresh), listRenewals(env)]);
  // A truncated or failed measurement is not a total: leave the cost unknown rather than understate it.
  const r2Bytes = r2.length && r2.every(b => Number.isFinite(b.bytes) && !b.truncated && !b.error) ? r2.reduce((total, b) => total + b.bytes, 0) : null;
  return json({
    plan, planUpdatedAt: settings?.updated_at ?? null, environment: env.APP_ENV || 'development', today: kyivDay(now),
    pricing: { checkedOn: PRICING.checkedOn, sources: PRICING.sources, plan: PRICING.plans[plan], r2: PRICING.r2 },
    d1, r2, cloudflare: cf, estimate: estimate(plan, { d1SizeBytes: d1.sizeBytes, r2Bytes, cf }), renewals
  });
}

const DATE_RE = /^\d{4}-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])$/;
const validDate = value => DATE_RE.test(value) && new Date(`${value}T00:00:00Z`).toISOString().slice(0, 10) === value;
const RENEWAL_FIELDS = ['kind', 'name', 'dueDate', 'costMinor', 'currency', 'autoRenew', 'notes'];
/** Validates a renewal body; `partial` allows omitted fields (PATCH). Returns DB column values or an error code. */
export function validateRenewal(body, partial = false) {
  if (!body || typeof body !== 'object' || Array.isArray(body) || Object.keys(body).some(key => !RENEWAL_FIELDS.includes(key))) return { error: 'invalid_request' };
  const out = {}, has = key => Object.hasOwn(body, key);
  if (has('kind') || !partial) { if (!['domain', 'subscription', 'other'].includes(body.kind)) return { error: 'invalid_kind' }; out.kind = body.kind; }
  if (has('name') || !partial) { const name = typeof body.name === 'string' ? body.name.trim().replace(/\s+/g, ' ') : ''; if (!name || name.length > 120) return { error: 'invalid_name' }; out.name = name; }
  if (has('dueDate') || !partial) { if (body.dueDate !== null && !(typeof body.dueDate === 'string' && validDate(body.dueDate))) return { error: 'invalid_due_date' }; out.due_date = body.dueDate ?? null; }
  if (has('costMinor')) { if (body.costMinor !== null && !(Number.isSafeInteger(body.costMinor) && body.costMinor >= 0 && body.costMinor <= 1e10)) return { error: 'invalid_cost' }; out.cost_minor = body.costMinor; }
  if (has('currency')) { if (!['UAH', 'USD', 'EUR'].includes(body.currency)) return { error: 'invalid_currency' }; out.currency = body.currency; }
  if (has('autoRenew')) { if (typeof body.autoRenew !== 'boolean') return { error: 'invalid_request' }; out.auto_renew = body.autoRenew ? 1 : 0; }
  if (has('notes')) { if (typeof body.notes !== 'string' || body.notes.length > 500) return { error: 'invalid_notes' }; out.notes = body.notes.trim(); }
  if (partial && !Object.keys(out).length) return { error: 'invalid_request' };
  return { value: out };
}

export async function createRenewal({ request, env }, readJson) {
  const checked = validateRenewal(await readJson(request));
  if (checked.error) return bad(checked.error);
  const at = new Date().toISOString(), id = crypto.randomUUID(), v = { cost_minor: null, currency: 'UAH', auto_renew: 0, notes: '', ...checked.value };
  await env.DB.batch([
    env.DB.prepare('INSERT INTO infra_renewals(id,kind,name,due_date,cost_minor,currency,auto_renew,notes,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?)').bind(id, v.kind, v.name, v.due_date, v.cost_minor, v.currency, v.auto_renew, v.notes, at, at),
    auditStatement(env, 'infra.renewal.create', id, at, { kind: v.kind })
  ]);
  return json(renewal(await env.DB.prepare('SELECT * FROM infra_renewals WHERE id=?').bind(id).first()), 201);
}
export async function updateRenewal({ request, env, params }, readJson) {
  const checked = validateRenewal(await readJson(request), true);
  if (checked.error) return bad(checked.error);
  const found = await env.DB.prepare('SELECT id FROM infra_renewals WHERE id=?').bind(params.id).first();
  if (!found) return bad('not_found', 404);
  const at = new Date().toISOString(), columns = Object.keys(checked.value);
  await env.DB.batch([
    env.DB.prepare(`UPDATE infra_renewals SET ${columns.map(c => `${c}=?`).join(', ')}, updated_at=? WHERE id=?`).bind(...columns.map(c => checked.value[c]), at, params.id),
    auditStatement(env, 'infra.renewal.update', params.id, at, { fields: columns })
  ]);
  return json(renewal(await env.DB.prepare('SELECT * FROM infra_renewals WHERE id=?').bind(params.id).first()));
}
export async function deleteRenewal({ request, env, params }, readJson) {
  const body = await readJson(request);
  if (body.confirm !== true) return bad('confirmation_required');
  const found = await env.DB.prepare('SELECT id FROM infra_renewals WHERE id=?').bind(params.id).first();
  if (!found) return bad('not_found', 404);
  const at = new Date().toISOString();
  await env.DB.batch([env.DB.prepare('DELETE FROM infra_renewals WHERE id=?').bind(params.id), auditStatement(env, 'infra.renewal.delete', params.id, at)]);
  return json({ deleted: true });
}
export async function setPlan({ request, env }, readJson) {
  const body = await readJson(request);
  if (Object.keys(body).some(key => key !== 'plan') || !PLANS.includes(body.plan)) return bad('invalid_plan');
  const at = new Date().toISOString();
  await env.DB.batch([
    env.DB.prepare('INSERT INTO infra_settings(id,plan,updated_at,updated_by) VALUES(1,?,?,?) ON CONFLICT(id) DO UPDATE SET plan=excluded.plan, updated_at=excluded.updated_at, updated_by=excluded.updated_by').bind(body.plan, at, env.PRINCIPAL?.actor ?? null),
    auditStatement(env, 'infra.plan.update', 'infra', at, { plan: body.plan })
  ]);
  return json({ plan: body.plan, planUpdatedAt: at });
}
