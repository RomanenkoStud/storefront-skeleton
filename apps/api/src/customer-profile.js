// Customer profile (ADR-0003): contact details and the Nova Poshta preference. Owner-only; every query is scoped to the session customer.
// Receives the authenticated customer and shared helpers from customer-auth.js, so it never touches manager identity.
// Validation messages name fields, never echo values: profile data is PII and must not reach logs or error bodies.
import { fail } from './domain.js';
import { CatalogUnavailable, resolvePoint } from './nova-poshta.js';
import { cleanVisibleName, normalizeUaPhone, recipientNamePart } from '../../../packages/catalog/recipient.js';

const FIELDS = ['displayName', 'lastName', 'firstName', 'middleName', 'phone', 'contactEmail', 'deliveryPreference'];
const PREFERENCE_KEYS = ['warehouseRef', 'note'];
const WRITES_PER_HOUR = 60;
const INVISIBLE = /[\p{Cc}\p{Cf}]/u; // controls plus format characters: bidi overrides/isolates, zero-width, BOM
const VISIBLE = /[\p{L}\p{N}\p{P}\p{S}]/u;
const GUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const EMAIL = /^[^\s@<>()[\]\\,;:"]+@[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?)+$/;
const length = value => [...value].length;
const isObject = value => value && typeof value === 'object' && !Array.isArray(value);

function str(value, field) { if (typeof value !== 'string') fail(`${field} must be a string`); return value.normalize('NFC'); }
// The name and phone rules are shared with the checkout recipient (packages/catalog/recipient.js), so a stored profile value prefills a valid checkout phone.
function displayName(value) {
  const v = cleanVisibleName(str(value, 'displayName'));
  if (!v) fail('displayName must be 1-80 visible characters without control or invisible formatting characters');
  return v;
}
// ПІБ parts: the checkout recipient rule, so stored parts always prefill a valid checkout. displayName stays a separate free-form field.
const namePart = field => value => {
  const v = recipientNamePart(str(value, field));
  if (!v) fail(`${field} must be 1-40 Cyrillic or Latin letters; an apostrophe, hyphen or space is allowed only between letters`);
  return v;
};
const lastName = namePart('lastName'), firstName = namePart('firstName'), middleName = namePart('middleName');
function phone(value) {
  const v = normalizeUaPhone(str(value, 'phone'));
  if (!v) fail('phone must be a Ukrainian number such as +380501234567');
  return v;
}
function contactEmail(value) {
  const v = str(value, 'contactEmail').trim();
  if (INVISIBLE.test(v) || v.length > 254 || v.split('@')[0].length > 64 || !EMAIL.test(v)) fail('contactEmail must be a valid email address of at most 254 characters');
  return v;
}
// Input is only {warehouseRef, note?} (ADR-0011): everything else is copied from the Nova Poshta catalog by the server.
function deliveryPreference(value) {
  if (!isObject(value)) fail('deliveryPreference must be an object or null');
  for (const key of Object.keys(value)) if (!PREFERENCE_KEYS.includes(key)) fail('Unknown deliveryPreference field');
  const warehouseRef = str(value.warehouseRef, 'deliveryPreference.warehouseRef').trim().toLowerCase();
  if (!GUID.test(warehouseRef)) fail('deliveryPreference.warehouseRef must be a Nova Poshta Ref GUID');
  let note = null;
  if (value.note !== undefined && value.note !== null) {
    note = str(value.note, 'deliveryPreference.note').trim() || null;
    if (note && (length(note) > 200 || /[^\P{Cc}\n]/u.test(note) || /\p{Cf}/u.test(note) || !VISIBLE.test(note) || note.split('\n').length > 2)) fail('deliveryPreference.note must be at most 200 characters with at most one newline and no other control characters');
  }
  return { warehouseRef, note };
}
// The catalog copy: what is stored and returned for a chosen point.
async function resolvedPreference(env, input) {
  let point;
  try { point = await resolvePoint(env, input.warehouseRef); }
  catch (error) { if (error instanceof CatalogUnavailable) fail('Nova Poshta catalog is unavailable', 503); throw error; }
  if (!point) fail('deliveryPreference.warehouseRef is not in the Nova Poshta catalog');
  return { type: point.kind, cityName: point.cityName, cityRef: point.cityRef, warehouseNumber: point.number, warehouseRef: input.warehouseRef, warehouseName: point.name, note: input.note, source: 'np-api', origin: 'cabinet' };
}
const VALIDATORS = { displayName, lastName, firstName, middleName, phone, contactEmail, deliveryPreference };

function view(row, telegram) {
  return {
    displayName: row?.display_name ?? null,
    lastName: row?.last_name ?? null,
    firstName: row?.first_name ?? null,
    middleName: row?.middle_name ?? null,
    phone: row?.phone_e164 ?? null,
    contactEmail: row?.contact_email ?? null,
    deliveryPreference: row?.np_type ? { type: row.np_type, cityName: row.np_city_name, cityRef: row.np_city_ref, warehouseNumber: row.np_warehouse_number, warehouseRef: row.np_warehouse_ref, warehouseName: row.np_warehouse_name ?? null, note: row.np_note, source: row.np_source, origin: row.np_origin ?? null } : null,
    telegram: telegram ? { linked: true, handle: telegram.display_handle ?? null, linkedAt: telegram.created_at } : { linked: false, handle: null, linkedAt: null },
    updatedAt: row?.updated_at ?? null,
  };
}
async function load(env, customerId) {
  const row = await env.DB.prepare('SELECT * FROM customer_profiles WHERE customer_id=?').bind(customerId).first();
  const telegram = await env.DB.prepare("SELECT display_handle, created_at FROM customer_identities WHERE customer_id=? AND provider='telegram'").bind(customerId).first();
  return view(row, telegram);
}
export const profileSnapshot = load;

// Columns written for each API field; a null value clears all of them.
function columns(field, value) {
  if (field === 'displayName') return { display_name: value };
  if (field === 'lastName') return { last_name: value };
  if (field === 'firstName') return { first_name: value };
  if (field === 'middleName') return { middle_name: value };
  if (field === 'phone') return { phone_e164: value };
  if (field === 'contactEmail') return { contact_email: value };
  const p = value ?? {};
  return { np_type: p.type ?? null, np_city_name: p.cityName ?? null, np_city_ref: p.cityRef ?? null, np_warehouse_number: p.warehouseNumber ?? null, np_warehouse_ref: p.warehouseRef ?? null, np_warehouse_name: p.warehouseName ?? null, np_note: p.note ?? null, np_source: p.source ?? null, np_origin: p.origin ?? null };
}

async function patch(request, env, ctx) {
  await ctx.throttle('profile-write', WRITES_PER_HOUR, 3600);
  const body = await ctx.readJsonObject(request, 8192);
  for (const key of Object.keys(body)) if (!FIELDS.includes(key)) fail('Unknown field');
  const next = {};
  for (const field of FIELDS) if (field in body) next[field] = body[field] === null ? null : VALIDATORS[field](body[field]);
  if (next.deliveryPreference) next.deliveryPreference = await resolvedPreference(env, next.deliveryPreference); // after every field is validated, so a bad field never costs a catalog read
  const current = await load(env, ctx.customerId);
  const changed = Object.keys(next).filter(field => JSON.stringify(next[field]) !== JSON.stringify(current[field]));
  if (changed.length) {
    const set = Object.assign({}, ...changed.map(field => columns(field, next[field])));
    const names = Object.keys(set), nowMs = Date.now(), now = new Date(nowMs).toISOString();
    await env.DB.batch([
      env.DB.prepare(`INSERT INTO customer_profiles(customer_id,${names.join(',')},updated_at) VALUES(?,${names.map(() => '?').join(',')},?) ON CONFLICT(customer_id) DO UPDATE SET ${names.map(name => `${name}=excluded.${name}`).join(',')},updated_at=excluded.updated_at`).bind(ctx.customerId, ...names.map(name => set[name]), now),
      ctx.audit(env, ctx.customerId, 'profile.update', nowMs, changed),
    ]);
  }
  return ctx.json(await load(env, ctx.customerId));
}

const RECENT_AUTH_MS = 600000;

// GET /api/account/export: everything stored for the owner. Hashes, tokens and throttle keys are never selected.
export async function handleExport(env, ctx) {
  const id = ctx.customerId;
  const identities = (await env.DB.prepare('SELECT provider, subject, display_handle, created_at, last_used_at FROM customer_identities WHERE customer_id=? ORDER BY provider').bind(id).all()).results;
  const events = (await env.DB.prepare('SELECT action, fields, created_at FROM customer_audit_events WHERE customer_id=? ORDER BY created_at, rowid').bind(id).all()).results;
  return ctx.json({
    customer: await ctx.customerView(id),
    identities: identities.map(row => ({ provider: row.provider, subject: row.subject, handle: row.display_handle ?? null, linkedAt: row.created_at, lastUsedAt: row.last_used_at ?? null })),
    profile: await load(env, id),
    auditEvents: events.map(row => ({ action: row.action, fields: JSON.parse(row.fields), createdAt: row.created_at })),
  }, 200, { 'Content-Disposition': 'attachment; filename="lorem-store-account.json"' });
}

// DELETE /api/account: hard delete in one atomic batch, including audit events. Throttle buckets are keyed by HMAC and expire on their own.
export async function handleDelete(request, env, ctx) {
  const body = await ctx.readJsonObject(request);
  if (body.confirm !== true || Object.keys(body).length !== 1) fail('confirm:true is required');
  if (Date.now() - Date.parse(ctx.authenticatedAt) > RECENT_AUTH_MS) fail('Sign in again to delete your account', 403);
  const id = ctx.customerId;
  // Delivery and recipient snapshots on the customer's carts are personal data too (ADR-0011 section 9); the carts themselves are unbound by the foreign key.
  await env.DB.batch(['customer_audit_events', 'customer_profiles', 'customer_sessions', 'customer_auth_flows', 'customer_identities'].map(table => env.DB.prepare(`DELETE FROM ${table} WHERE customer_id=?`).bind(id)).concat(env.DB.prepare('UPDATE carts SET dp_type=NULL, dp_city_name=NULL, dp_city_ref=NULL, dp_warehouse_number=NULL, dp_warehouse_ref=NULL, dp_warehouse_name=NULL, rcpt_name=NULL, rcpt_last_name=NULL, rcpt_first_name=NULL, rcpt_middle_name=NULL, rcpt_phone=NULL WHERE customer_id=?').bind(id), env.DB.prepare('DELETE FROM customers WHERE id=?').bind(id)));
  return ctx.json({ deleted: true });
}

export async function handleProfile(request, env, ctx) {
  if (request.method === 'GET') return ctx.json(await load(env, ctx.customerId));
  return patch(request, env, ctx);
}
