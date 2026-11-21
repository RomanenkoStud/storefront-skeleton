// Cart checkout, customer cart history and manager cart operations (ADR-0007).
// Carts are immutable snapshots: only status, status_*, manager_note and updated_at ever change. Exceptions: account deletion and
// the retention job (order-retention.js) set the personal-data snapshot (rcpt_*, dp_*) to NULL.
// Private supplier columns are selected only by the staff queries below; public and customer shapes never include them.
import { HttpError, fail } from './domain.js';
import { resolveCustomerSession, readJsonObject, throttle, hmacSecret, clientIp } from './customer-auth.js';
import { actorLabel } from './permissions.js';
import { publicEntriesFor, allocate } from './merged.js';
import { CatalogUnavailable, resolvePoint } from './nova-poshta.js';
import { validateRecipient, recipientFullName } from '../../../packages/catalog/recipient.js';
import { CART_TRANSITIONS, CODE_PREFIX, canTransition, generateCode, isCartStatus, normalizeCode, validateCheckoutLines } from '../../../packages/catalog/cart.js';

const json = (data, status = 200, headers = {}) => new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', ...headers } });
const CHECKOUT_LIMIT = 10, CHECKOUT_WINDOW = 600, PAGE_SIZE = 40, MAX_NOTE = 500, MAX_ACCOUNT_CARTS = 100, CODE_ATTEMPTS = 5;

const summary = row => ({ code: row.code, status: row.status, createdAt: row.created_at, itemCount: row.item_count, totalMinor: row.total_minor, currency: row.currency });
const publicLine = row => ({ productId: row.product_id, slug: row.slug, title: row.title, size: row.size, quantity: row.quantity, unitPriceMinor: row.unit_price_minor, lineTotalMinor: row.line_total_minor, photo: row.photo || null });
const GUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
// CartDelivery (ADR-0011): the point copied from the catalog at checkout; null when the cart has none.
const deliveryOf = row => (row.dp_type ? { type: row.dp_type, cityName: row.dp_city_name, cityRef: row.dp_city_ref, warehouseNumber: row.dp_warehouse_number, warehouseRef: row.dp_warehouse_ref, warehouseName: row.dp_warehouse_name } : null);
const DELIVERY_COLUMNS = 'dp_type, dp_city_name, dp_city_ref, dp_warehouse_number, dp_warehouse_ref, dp_warehouse_name';
// CartRecipient (three-part ПІБ): stored like the point (signed-in checkouts only); null otherwise.
// {lastName, firstName, middleName, name, phone}: name is «Прізвище Імʼя По батькові». A cart created by the single-field checkout only has
// rcpt_name, so it is returned with null parts and that legacy name (never split by guessing).
function recipientOf(row) {
  if (!row.rcpt_phone) return null;
  if (row.rcpt_last_name && row.rcpt_first_name && row.rcpt_middle_name) {
    const parts = { lastName: row.rcpt_last_name, firstName: row.rcpt_first_name, middleName: row.rcpt_middle_name };
    return { ...parts, name: recipientFullName(parts), phone: row.rcpt_phone };
  }
  return row.rcpt_name ? { lastName: null, firstName: null, middleName: null, name: row.rcpt_name, phone: row.rcpt_phone } : null;
}
const RECIPIENT_COLUMNS = 'rcpt_name, rcpt_last_name, rcpt_first_name, rcpt_middle_name, rcpt_phone';
const RECIPIENT_WRITE_COLUMNS = 'rcpt_last_name, rcpt_first_name, rcpt_middle_name, rcpt_phone';
// Staff allowlists (ADR-0007 Q1 answered yes): everyone with orders.read sees the order's own recipient and point
// snapshot so the order can be fulfilled. Never the customer ID, the account email or any profile data; no Nova Poshta Refs.
const staffRecipientOf = row => { const r = recipientOf(row); return r && { lastName: r.lastName, firstName: r.firstName, middleName: r.middleName, name: r.name, phone: r.phone }; };
const staffDeliveryOf = row => (row.dp_type ? { type: row.dp_type, cityName: row.dp_city_name, warehouseNumber: row.dp_warehouse_number, warehouseName: row.dp_warehouse_name } : null);
const erasedAt = row => row.pd_erased_at ?? null;
// ADR-0011 section 7: remember the point as the favourite unless a cabinet favourite (or the same point) exists. One statement; the audit row follows only when it changed a row.
const REMEMBER_SQL = `INSERT INTO customer_profiles(customer_id, np_type, np_city_name, np_city_ref, np_warehouse_number, np_warehouse_ref, np_warehouse_name, np_note, np_source, np_origin, updated_at)
  VALUES (?, ?, ?, ?, ?, ?, ?, NULL, 'np-api', 'checkout', ?)
  ON CONFLICT(customer_id) DO UPDATE SET
    np_type=excluded.np_type, np_city_name=excluded.np_city_name, np_city_ref=excluded.np_city_ref,
    np_warehouse_number=excluded.np_warehouse_number, np_warehouse_ref=excluded.np_warehouse_ref,
    np_warehouse_name=excluded.np_warehouse_name, np_note=NULL, np_source='np-api',
    np_origin='checkout', updated_at=excluded.updated_at
  WHERE (customer_profiles.np_origin IS NULL OR customer_profiles.np_origin = 'checkout'
         OR customer_profiles.np_source IS NOT 'np-api')
    AND (customer_profiles.np_warehouse_ref IS NOT excluded.np_warehouse_ref
         OR customer_profiles.np_source IS NOT 'np-api')`;
const PUBLIC_LINE_COLUMNS = 'cart_id, position, product_id, slug, title, size, quantity, unit_price_minor, line_total_minor, photo';

// ---- checkout -------------------------------------------------------------------------------
// Lines resolve through the merged storefront: any member ID of a confirmed duplicate group
// means the group's storefront product, and its quantity is filled from the cheapest suppliers with stock.
function problemsFor(lines, catalog) {
  const problems = [], resolved = [], seen = new Map();
  lines.forEach((line, index) => {
    const entry = catalog.byProductId.get(line.productId);
    if (!entry) { problems.push({ index, code: 'product_unavailable' }); return; }
    const key = JSON.stringify([entry.primaryId, line.size]);
    if (seen.has(key)) { problems.push({ index, code: 'duplicate_line', field: 'size', firstIndex: seen.get(key) }); return; }
    seen.set(key, index);
    const result = allocate(entry, line.size, line.quantity);
    if (!result.ok) { problems.push({ index, code: result.code, ...(result.available !== undefined ? { available: result.available } : {}) }); return; }
    const unitPriceMinor = entry.product.priceMinor;
    resolved.push({ entry, product: entry.product, line, unitPriceMinor, lineTotalMinor: unitPriceMinor * line.quantity, allocations: result.allocations });
  });
  return { problems, resolved };
}

function isCodeCollision(error) { return /UNIQUE constraint failed:\s*carts\.code/i.test(String(error?.message ?? '')); }

export async function checkout(request, env) {
  const url = new URL(request.url);
  if (request.headers.get('Origin') !== url.origin) return json({ error: 'forbidden_origin' }, 403);
  if (!request.headers.get('Content-Type')?.startsWith('application/json')) return json({ error: 'json_required' }, 415);
  try { await throttle(env, hmacSecret(request, env), 'cart-checkout', clientIp(request), CHECKOUT_LIMIT, CHECKOUT_WINDOW); }
  catch (error) { if (error?.retryAfter) return json({ error: 'rate_limited' }, 429, { 'Retry-After': String(error.retryAfter) }); throw error; }
  // Bounded cleanup so the throttle table cannot grow without limit on a checkout-only workload.
  try { await env.DB.prepare('DELETE FROM customer_auth_throttle WHERE rowid IN (SELECT rowid FROM customer_auth_throttle WHERE window_start<? LIMIT 50)').bind(Math.floor(Date.now() / 1000) - 86400).run(); } catch { console.error('Throttle cleanup failed'); }
  let body;
  try { body = await readJsonObject(request, 65536); }
  catch (error) { if (error instanceof HttpError) return json({ error: error.status === 413 ? 'payload_too_large' : 'invalid_request' }, error.status === 413 ? 413 : 400); throw error; }
  if (Object.keys(body).some(key => key !== 'lines' && key !== 'delivery' && key !== 'recipient')) return json({ error: 'invalid_request' }, 400);
  const checked = validateCheckoutLines(body.lines);
  if (!checked.ok) return json({ error: 'invalid_cart', problems: checked.problems }, 400);
  // Step 6a: delivery is null/absent or exactly {warehouseRef: GUID}.
  let warehouseRef = null;
  if (body.delivery !== undefined && body.delivery !== null) {
    const d = body.delivery;
    if (typeof d !== 'object' || Array.isArray(d) || Object.keys(d).length !== 1 || typeof d.warehouseRef !== 'string' || !GUID.test(d.warehouseRef.toLowerCase())) return json({ error: 'invalid_delivery' }, 400);
    warehouseRef = d.warehouseRef.toLowerCase();
  }
  // recipient is null/absent or exactly {lastName, firstName, middleName, phone}; the error names the fields, never the values.
  let recipientInput = null;
  if (body.recipient !== undefined && body.recipient !== null) {
    const r = validateRecipient(body.recipient);
    if (!r.ok) return json({ error: 'invalid_recipient', fields: r.fields }, 400);
    recipientInput = r.recipient;
  }

  const ids = [...new Set(checked.lines.map(l => l.productId))];
  const now = Date.now(), { problems, resolved } = problemsFor(checked.lines, await publicEntriesFor(env, ids));
  if (problems.length) return json({ error: 'cart_unavailable', problems }, 409);

  const { session } = await resolveCustomerSession(request, env);
  const customerId = session?.customerId ?? null;
  // Steps 8 and 8a: anonymous checkouts ignore delivery entirely; a signed-in one resolves it against the local catalog before anything is written.
  let point = null;
  if (customerId && warehouseRef) {
    try { point = await resolvePoint(env, warehouseRef); }
    catch (error) { if (error instanceof CatalogUnavailable) return json({ error: 'delivery_catalog_unavailable' }, 503); throw error; }
    if (!point) return json({ error: 'delivery_unavailable' }, 409);
  }
  const recipient = customerId ? recipientInput : null; // anonymous: validated above, never stored (ADR-0007 "no personal data from anonymous visitors")
  const delivery = point ? { type: point.kind, cityName: point.cityName, cityRef: point.cityRef, warehouseNumber: point.number, warehouseRef, warehouseName: point.name } : null;
  const createdAt = new Date(now).toISOString(), cartId = crypto.randomUUID();
  const itemCount = resolved.reduce((sum, r) => sum + r.line.quantity, 0), totalMinor = resolved.reduce((sum, r) => sum + r.lineTotalMinor, 0);
  if (!Number.isSafeInteger(totalMinor)) fail('Cart total exceeds limit', 409);
  let code = null;
  for (let attempt = 0; attempt < CODE_ATTEMPTS && !code; attempt++) {
    const candidate = generateCode();
    try {
      await env.DB.batch([
        env.DB.prepare(`INSERT INTO carts(id,code,status,customer_id,item_count,total_minor,currency,created_at,updated_at,status_changed_at,${DELIVERY_COLUMNS},${RECIPIENT_WRITE_COLUMNS}) VALUES(?,?,'submitted',?,?,?,'UAH',?,?,?,?,?,?,?,?,?,?,?,?,?)`).bind(cartId, candidate, customerId, itemCount, totalMinor, createdAt, createdAt, createdAt, delivery?.type ?? null, delivery?.cityName ?? null, delivery?.cityRef ?? null, delivery?.warehouseNumber ?? null, delivery?.warehouseRef ?? null, delivery?.warehouseName ?? null, recipient?.lastName ?? null, recipient?.firstName ?? null, recipient?.middleName ?? null, recipient?.phone ?? null),
        // The single-supplier columns hold the first allocation; a merged product also stores the full split (staff only).
        ...resolved.map((r, position) => { const first = r.allocations[0]; return env.DB.prepare('INSERT INTO cart_lines(cart_id,position,product_id,slug,title,size,quantity,unit_price_minor,line_total_minor,photo,supplier_id,supplier_name,external_product_id,variant_ids_json,unit_cost_minor,allocations_json) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)')
          .bind(cartId, position, r.product.id, r.product.slug, r.product.title, r.line.size, r.line.quantity, r.unitPriceMinor, r.lineTotalMinor, r.product.photos[0] ?? null, first.supplierId, first.supplierName, first.externalProductId, JSON.stringify(first.variantIds), first.unitCostMinor, r.entry.groupId ? JSON.stringify(r.allocations) : null); }),
        ...(delivery ? [
          env.DB.prepare(REMEMBER_SQL).bind(customerId, delivery.type, delivery.cityName, delivery.cityRef, delivery.warehouseNumber, delivery.warehouseRef, delivery.warehouseName, createdAt),
          // Must stay directly after the upsert: changes() then reports whether it wrote. customer-auth's audit() is module-private, so the row is prepared here.
          env.DB.prepare("INSERT INTO customer_audit_events(id,customer_id,action,fields,created_at) SELECT ?,?,'profile.delivery-remembered',?,? WHERE changes() > 0").bind(crypto.randomUUID(), customerId, JSON.stringify(['deliveryPreference']), createdAt),
        ] : []),
      ]);
      code = candidate;
    } catch (error) { if (!isCodeCollision(error)) throw error; }
  }
  if (!code) { console.error('Cart code generation exhausted'); return json({ error: 'code_unavailable' }, 503); }
  return json({ cart: { code, status: 'submitted', createdAt, itemCount, totalMinor, currency: 'UAH', bound: customerId !== null, delivery, recipient: recipient ? { lastName: recipient.lastName, firstName: recipient.firstName, middleName: recipient.middleName, name: recipientFullName(recipient), phone: recipient.phone } : null, lines: resolved.map((r, position) => publicLine({ product_id: r.product.id, slug: r.product.slug, title: r.product.title, size: r.line.size, quantity: r.line.quantity, unit_price_minor: r.unitPriceMinor, line_total_minor: r.lineTotalMinor, photo: r.product.photos[0] ?? null, position })) } }, 201);
}

export async function handleCart(request, env) {
  const path = new URL(request.url).pathname;
  if (path !== '/api/cart/checkout') return json({ error: 'not_found' }, 404);
  if (request.method !== 'POST') return json({ error: 'method_not_allowed' }, 405, { Allow: 'POST' });
  return checkout(request, env);
}

// ---- customer history -----------------------------------------------------------------------
export async function accountCarts(env, customerId, limit = MAX_ACCOUNT_CARTS) {
  const cap = limit === null ? -1 : limit; // SQLite: negative LIMIT is unlimited (used by the account export)
  const carts = (await env.DB.prepare(`SELECT code, status, created_at, item_count, total_minor, currency, id, ${DELIVERY_COLUMNS}, ${RECIPIENT_COLUMNS}, pd_erased_at FROM carts WHERE customer_id=? ORDER BY created_at DESC, id DESC LIMIT ?`).bind(customerId, cap).all()).results;
  if (!carts.length) return [];
  const lines = (await env.DB.prepare(`SELECT ${PUBLIC_LINE_COLUMNS} FROM cart_lines WHERE cart_id IN (SELECT id FROM carts WHERE customer_id=? ORDER BY created_at DESC, id DESC LIMIT ?) ORDER BY cart_id, position`).bind(customerId, cap).all()).results;
  const grouped = new Map();
  for (const line of lines) { if (!grouped.has(line.cart_id)) grouped.set(line.cart_id, []); grouped.get(line.cart_id).push(publicLine(line)); }
  return carts.map(row => ({ ...summary(row), delivery: deliveryOf(row), recipient: recipientOf(row), personalDataErasedAt: erasedAt(row), lines: grouped.get(row.id) ?? [] }));
}

// ---- manager --------------------------------------------------------------------------------
const staffPersonal = row => ({ recipient: staffRecipientOf(row), delivery: staffDeliveryOf(row), personalDataErasedAt: erasedAt(row) });
const staffSummary = row => ({ ...summary(row), bound: row.customer_id !== null && row.customer_id !== undefined, statusChangedAt: row.status_changed_at, managerNote: row.manager_note ?? null, ...staffPersonal(row) });
function codeParam(value) { try { return normalizeCode(decodeURIComponent(value)); } catch { return null; } }
const bad = (error, status = 400, extra = {}) => json({ error, ...extra }, status);

export async function listCarts({ env, url }) {
  const status = url.searchParams.get('status') || '', q = (url.searchParams.get('q') || '').trim(), pageParam = url.searchParams.get('page');
  if (status && !isCartStatus(status)) return bad('invalid_request');
  let page = 1;
  if (pageParam !== null && pageParam !== '') { if (!/^[0-9]{1,5}$/.test(pageParam) || Number(pageParam) < 1) return bad('invalid_request'); page = Number(pageParam); }
  const where = [], bindings = [];
  if (status) { where.push('status=?'); bindings.push(status); }
  if (q) {
    // Partial code search folded like normalizeCode (NFKC, case, separators incl. dashes, I/L->1, O->0, optional SS prefix) without the length requirement.
    let fragment = q.slice(0, 64).normalize('NFKC').toUpperCase().replace(/[\s\-\u2010-\u2015._]+/g, '').replace(/[IL]/g, '1').replace(/O/g, '0');
    if (fragment.startsWith(CODE_PREFIX)) fragment = fragment.slice(CODE_PREFIX.length);
    if (fragment.length > 8) where.push('0=1');
    else if (fragment) { where.push("REPLACE(SUBSTR(code,4),'-','') LIKE ? ESCAPE '\\'"); bindings.push(`%${fragment.replace(/[\\%_]/g, '\\$&')}%`); }
  }
  const clause = where.length ? `WHERE ${where.join(' AND ')}` : '';
  const total = (await env.DB.prepare(`SELECT COUNT(*) AS n FROM carts ${clause}`).bind(...bindings).first())?.n ?? 0;
  const rows = (await env.DB.prepare(`SELECT code, status, created_at, item_count, total_minor, currency, customer_id, status_changed_at, manager_note, ${DELIVERY_COLUMNS}, ${RECIPIENT_COLUMNS}, pd_erased_at FROM carts ${clause} ORDER BY created_at DESC, id DESC LIMIT ? OFFSET ?`).bind(...bindings, PAGE_SIZE, (page - 1) * PAGE_SIZE).all()).results;
  return json({ carts: rows.map(staffSummary), page, pageSize: PAGE_SIZE, total });
}

async function detail(env, code) {
  const row = await env.DB.prepare('SELECT * FROM carts WHERE code=?').bind(code).first();
  if (!row) return null;
  const lines = (await env.DB.prepare('SELECT * FROM cart_lines WHERE cart_id=? ORDER BY position').bind(row.id).all()).results;
  return { row, lines };
}
function allocationsOf(value) {
  if (!value) return null;
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) && parsed.length && parsed.every(a => a && typeof a.supplierId === 'string' && Number.isSafeInteger(a.quantity) && a.quantity > 0) ? parsed.map(a => ({ ...a, variantIds: Array.isArray(a.variantIds) ? a.variantIds.filter(v => typeof v === 'string') : [], unitCostMinor: Number.isSafeInteger(a.unitCostMinor) ? a.unitCostMinor : null })) : null;
  } catch { return null; }
}
function staffDetail(env, { row, lines }) {
  const variantIds = value => { try { const parsed = JSON.parse(value); return Array.isArray(parsed) ? parsed.filter(v => typeof v === 'string') : []; } catch { return []; } };
  return {
    cart: {
      ...summary(row), bound: row.customer_id !== null && row.customer_id !== undefined, updatedAt: row.updated_at, statusChangedAt: row.status_changed_at,
      statusActor: row.status_actor ? actorLabel(env.PRINCIPAL, row.status_actor) : null, managerNote: row.manager_note ?? null, ...staffPersonal(row),
      allowedTransitions: [...CART_TRANSITIONS[row.status]],
      lines: lines.flatMap(line => {
        const base = { ...publicLine(line), supplierId: line.supplier_id, supplierName: line.supplier_name, externalProductId: line.external_product_id, variantIds: variantIds(line.variant_ids_json), unitCostMinor: line.unit_cost_minor ?? null };
        const split = allocationsOf(line.allocations_json);
        // A merged-product line is shown once per supplier part, so the per-supplier hand-off stays exact.
        return split ? split.map(a => ({ ...base, quantity: a.quantity, lineTotalMinor: line.unit_price_minor * a.quantity, supplierId: a.supplierId, supplierName: a.supplierName, externalProductId: a.externalProductId, variantIds: a.variantIds, unitCostMinor: a.unitCostMinor, merged: true, sourceProductId: a.productId })) : [base];
      }),
    },
  };
}

export async function getCart({ env, params }) {
  const code = codeParam(params.code);
  if (!code) return bad('invalid_code');
  const found = await detail(env, code);
  return found ? json(staffDetail(env, found)) : bad('not_found', 404);
}

export async function changeStatus({ request, env, params }) {
  const code = codeParam(params.code);
  if (!code) return bad('invalid_code');
  if (!request.headers.get('Content-Type')?.startsWith('application/json')) return bad('json_required', 415);
  let body;
  try { body = await readJsonObject(request, 8192); } catch (error) { if (error instanceof HttpError) return bad('invalid_request'); throw error; }
  const { status, expectedStatus, note } = body;
  if (Object.keys(body).some(key => !['status', 'expectedStatus', 'note'].includes(key)) || !isCartStatus(status) || !isCartStatus(expectedStatus)) return bad('invalid_request');
  if (note !== undefined && note !== null && (typeof note !== 'string' || note.trim().length > MAX_NOTE)) return bad('invalid_request');
  if (!canTransition(expectedStatus, status)) return bad('invalid_transition');
  const found = await detail(env, code);
  if (!found) return bad('not_found', 404);
  if (found.row.status !== expectedStatus) return bad('status_conflict', 409, { currentStatus: found.row.status });
  const principal = env.PRINCIPAL, actor = principal?.actor ?? 'system', at = new Date().toISOString();
  const cleanNote = typeof note === 'string' && note.trim() ? note.trim() : null;
  await env.DB.batch([
    env.DB.prepare('UPDATE carts SET status=?, status_changed_at=?, updated_at=?, status_actor=?, manager_note=COALESCE(?,manager_note) WHERE code=? AND status=?').bind(status, at, at, actor, cleanNote, code, expectedStatus),
    // Only recorded when the guarded UPDATE above changed a row, so the audit trail can never claim a transition that did not happen.
    env.DB.prepare('INSERT INTO audit_events(id,actor,action,resource_id,created_at,actor_type,actor_role,details_json) SELECT ?,?,?,?,?,?,?,? WHERE changes() > 0')
      .bind(crypto.randomUUID(), actor, 'cart.status', code, at, principal?.type ?? 'system', principal?.role ?? null, JSON.stringify({ from: expectedStatus, to: status, noteChanged: cleanNote !== null })),
  ]);
  const after = await detail(env, code);
  if (!after || after.row.status !== status || after.row.status_changed_at !== at) return bad('status_conflict', 409, { currentStatus: after?.row.status ?? expectedStatus });
  return json(staffDetail(env, after));
}
