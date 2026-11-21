// Staff permission model (ADR-0006, T1). Handlers test permissions, never role names.
// Changing a manager boundary means editing one line of MANAGER_PERMISSIONS.
import { fail } from './domain.js';

export const PERMISSIONS = Object.freeze([
  'catalog.read', 'products.edit', 'products.price', 'products.publish', 'products.trash',
  'products.purge', 'media.upload', 'media.read', 'media.manage', 'taxonomy.edit', 'taxonomy.delete',
  'recognition.draft', 'recognition.apply', 'recognition.activate',
  'suppliers.sync', 'suppliers.manage', 'suppliers.manual', 'products.create', 'settings.manage',
  'orders.read', 'orders.operate', 'staff.read', 'staff.manage', 'audit.read',
  'analytics.read', 'infra.read'
]);

// One line per permission so the lead can move a boundary with a one-line change.
const MANAGER_PERMISSIONS = [
  'catalog.read',
  'products.edit',
  'products.price',      // D5c: markup and price allowed, audited
  'products.publish',
  'products.trash',      // D5b: Trash and restore allowed (reversible)
  // 'products.purge'   // owner-only: permanent deletion from Trash (irreversible)
  'media.upload',
  'media.read',
  // 'media.manage'    // owner-only: media library scan and cleanup delete files (irreversible)
  'taxonomy.edit',
  // 'taxonomy.delete'   // D5d: category delete is owner-only (irreversible)
  'recognition.draft',
  'recognition.apply',
  // 'recognition.activate' // owner-only: global settings change
  'suppliers.sync',      // D5a: per-supplier sync and JSON import allowed
  // 'suppliers.manage'  // owner-only: connection and supplier configuration
  'suppliers.manual',    // create a manual (feed-less) supplier
  'products.create',     // create manual products and edit their source
  'orders.read',
  'orders.operate'
  // 'analytics.read'    // dashboard (visits, sales, supplier revenue and margin) is owner-only for now
  // 'infra.read'        // infrastructure usage, cost and renewals are owner-only
];

export const ROLE_PERMISSIONS = Object.freeze({
  owner: Object.freeze([...PERMISSIONS]),
  manager: Object.freeze(MANAGER_PERMISSIONS)
});

// Test-only seam: a code-level override, never reachable from env or requests. It is restored when `run` settles.
let activeMatrix = ROLE_PERMISSIONS;
export async function withRoleMatrixForTests(overrides, run) {
  const previous = activeMatrix;
  activeMatrix = Object.freeze({ ...ROLE_PERMISSIONS, ...Object.fromEntries(Object.entries(overrides).map(([role, list]) => [role, Object.freeze([...list])])) });
  try { return await run(); } finally { activeMatrix = previous; }
}
export function can(principal, permission) {
  return !!principal && Object.hasOwn(activeMatrix, principal.role) && activeMatrix[principal.role].includes(permission);
}
export function requirePermission(principal, permission) {
  if (!can(principal, permission)) fail('Not permitted for your role', 403);
}
export const permissionsFor = principal => (principal && Object.hasOwn(activeMatrix, principal.role) ? [...activeMatrix[principal.role]] : []);

// Subpaths are relative to /api/admin. Order matters only for readability: matching is by path and method.
export const ADMIN_ROUTES = Object.freeze([
  { id: 'staff.list', method: 'GET', pattern: '/staff', permission: 'staff.read' },
  { id: 'staff.invite', method: 'POST', pattern: '/staff', permission: 'staff.manage' },
  { id: 'staff.update', method: 'PATCH', pattern: '/staff/:id', permission: 'staff.manage' },
  { id: 'staff.suspend', method: 'POST', pattern: '/staff/:id/suspend', permission: 'staff.manage' },
  { id: 'staff.reactivate', method: 'POST', pattern: '/staff/:id/reactivate', permission: 'staff.manage' },
  { id: 'staff.reinvite', method: 'POST', pattern: '/staff/:id/reinvite', permission: 'staff.manage' },
  { id: 'staff.revoke', method: 'POST', pattern: '/staff/:id/sessions/revoke', permission: 'staff.manage' },
  { id: 'staff.remove', method: 'DELETE', pattern: '/staff/:id', permission: 'staff.manage' },
  { id: 'audit.list', method: 'GET', pattern: '/audit', permission: 'audit.read' },
  { id: 'storefront.get', method: 'GET', pattern: '/storefront', permission: 'catalog.read' },
  { id: 'storefront.campaign', method: 'PUT', pattern: '/storefront/campaign', permission: 'settings.manage' },
  { id: 'storefront.pictures.add', method: 'POST', pattern: '/storefront/pictures', permission: 'settings.manage' }, // L1: owners only; media.upload would open it to managers
  { id: 'storefront.pictures.order', method: 'PUT', pattern: '/storefront/pictures/order', permission: 'settings.manage' },
  { id: 'storefront.pictures.remove', method: 'DELETE', pattern: '/storefront/pictures/:id', permission: 'settings.manage' },
  { id: 'storefront.ticker', method: 'PUT', pattern: '/storefront/ticker', permission: 'settings.manage' },
  { id: 'storefront.checkout', method: 'PUT', pattern: '/storefront/checkout', permission: 'settings.manage' },
  { id: 'storefront.banner', method: 'PUT', pattern: '/storefront/banner', permission: 'settings.manage' },
  { id: 'storefront.images.set', method: 'PUT', pattern: '/storefront/images', permission: 'settings.manage' },
  { id: 'storefront.images.reset', method: 'DELETE', pattern: '/storefront/images/:categoryId/:slot', permission: 'settings.manage' },
  { id: 'taxonomy.get', method: 'GET', pattern: '/taxonomy', permission: 'catalog.read' },
  { id: 'taxonomy.preview', method: 'POST', pattern: '/taxonomy/preview', permission: 'taxonomy.edit' },
  { id: 'taxonomy.apply', method: 'POST', pattern: '/taxonomy/apply', permission: 'taxonomy.edit' },
  { id: 'recognition.get', method: 'GET', pattern: '/recognition', permission: 'recognition.draft' },
  { id: 'recognition.drafts', method: 'POST', pattern: '/recognition/drafts', permission: 'recognition.draft' },
  { id: 'recognition.preview', method: 'POST', pattern: '/recognition/preview', permission: 'recognition.draft' },
  { id: 'recognition.apply', method: 'POST', pattern: '/recognition/apply', permission: 'recognition.apply' },
  { id: 'recognition.activate', method: 'POST', pattern: '/recognition/activate', permission: 'recognition.activate' },
  { id: 'suppliers.syncConnected', method: 'POST', pattern: '/suppliers/sync-connected', permission: 'suppliers.manage' },
  { id: 'suppliers.list', method: 'GET', pattern: '/suppliers', permission: 'catalog.read' },
  { id: 'suppliers.createManual', method: 'POST', pattern: '/suppliers/manual', permission: 'suppliers.manual' },
  { id: 'suppliers.create', method: 'POST', pattern: '/suppliers', permission: 'suppliers.manage' },
  { id: 'suppliers.update', method: 'PATCH', pattern: '/suppliers/:id', permission: 'suppliers.manage' },
  { id: 'suppliers.delete', method: 'DELETE', pattern: '/suppliers/:id', permission: 'suppliers.manage' },
  { id: 'suppliers.restore', method: 'POST', pattern: '/suppliers/:id/restore', permission: 'suppliers.manage' },
  { id: 'suppliers.import', method: 'POST', pattern: '/suppliers/:id/import', permission: 'suppliers.sync' },
  { id: 'suppliers.sync', method: 'POST', pattern: '/suppliers/:id/sync', permission: 'suppliers.sync' },
  { id: 'products.list', method: 'GET', pattern: '/products', permission: 'catalog.read' },
  { id: 'products.create', method: 'POST', pattern: '/products', permission: 'products.create' },
  { id: 'products.bulk', method: 'POST', pattern: '/products/bulk', permission: 'products.edit' },
  { id: 'products.tags', method: 'POST', pattern: '/products/bulk-tags', permission: 'products.edit' },
  { id: 'products.delete', method: 'DELETE', pattern: '/products/:id', permission: 'products.trash' },
  { id: 'products.restore', method: 'POST', pattern: '/products/:id/restore', permission: 'products.trash' },
  { id: 'products.update', method: 'PATCH', pattern: '/products/:id', permission: 'products.edit' },
  { id: 'products.source', method: 'PATCH', pattern: '/products/:id/source', permission: 'products.create' },
  { id: 'products.photos', method: 'POST', pattern: '/products/:id/photos', permission: 'media.upload' },
  { id: 'products.purge', method: 'DELETE', pattern: '/products/:id/permanent', permission: 'products.purge' },
  { id: 'media.upload', method: 'POST', pattern: '/media', permission: 'media.upload' },
  { id: 'media.list', method: 'GET', pattern: '/media', permission: 'media.read' },
  { id: 'media.scan', method: 'POST', pattern: '/media/scan', permission: 'media.manage' },
  { id: 'media.cleanup', method: 'POST', pattern: '/media/cleanup', permission: 'media.manage' },
  { id: 'products.image', method: 'GET', pattern: '/products/:id/image', permission: 'media.read' },
  { id: 'products.originals', method: 'GET', pattern: '/products/:id/image-originals', permission: 'media.read' },
  { id: 'products.cutout', method: 'POST', pattern: '/products/:id/cutout', permission: 'media.upload' },
  { id: 'products.normalized', method: 'POST', pattern: '/products/:id/normalized', permission: 'media.upload' },
  { id: 'syncRuns.list', method: 'GET', pattern: '/sync-runs', permission: 'catalog.read' },
  { id: 'duplicates.list', method: 'GET', pattern: '/duplicates', permission: 'catalog.read' },
  { id: 'duplicates.confirm', method: 'POST', pattern: '/duplicates/groups', permission: 'products.edit' },
  { id: 'duplicates.dissolve', method: 'DELETE', pattern: '/duplicates/groups/:id', permission: 'products.edit' },
  { id: 'duplicates.removeMember', method: 'DELETE', pattern: '/duplicates/groups/:id/members/:productId', permission: 'products.edit' },
  { id: 'duplicates.reject', method: 'POST', pattern: '/duplicates/rejections', permission: 'products.edit' },
  { id: 'duplicates.unreject', method: 'DELETE', pattern: '/duplicates/rejections', permission: 'products.edit' },
  { id: 'carts.list', method: 'GET', pattern: '/carts', permission: 'orders.read' },
  { id: 'carts.get', method: 'GET', pattern: '/carts/:code', permission: 'orders.read' },
  { id: 'carts.status', method: 'POST', pattern: '/carts/:code/status', permission: 'orders.operate' },
  { id: 'dashboard.get', method: 'GET', pattern: '/dashboard', permission: 'analytics.read' },
  { id: 'infra.get', method: 'GET', pattern: '/infra', permission: 'infra.read' },
  { id: 'infra.plan', method: 'PUT', pattern: '/infra/plan', permission: 'settings.manage' },
  { id: 'infra.renewals.create', method: 'POST', pattern: '/infra/renewals', permission: 'settings.manage' },
  { id: 'infra.renewals.update', method: 'PATCH', pattern: '/infra/renewals/:id', permission: 'settings.manage' },
  { id: 'infra.renewals.delete', method: 'DELETE', pattern: '/infra/renewals/:id', permission: 'settings.manage' }
]);

function matchPattern(pattern, subpath) {
  const want = pattern.split('/'), have = subpath.split('/');
  if (want.length !== have.length) return null;
  const params = {};
  for (let i = 0; i < want.length; i++) {
    if (want[i].startsWith(':')) { if (!have[i]) return null; params[want[i].slice(1)] = have[i]; }
    else if (want[i] !== have[i]) return null;
  }
  return params;
}

// Default deny: only a (method, path) pair in ADMIN_ROUTES can run. Unknown path 404, known path with another method 405.
export function matchAdminRoute(method, subpath) {
  const allowed = [];
  for (const route of ADMIN_ROUTES) {
    const params = matchPattern(route.pattern, subpath);
    if (!params) continue;
    allowed.push(route.method);
    if (route.method === method) return { route, params };
  }
  return allowed.length ? { status: 405, allow: [...new Set(allowed)].join(', ') } : { status: 404 };
}

export function assertHandlers(handlers) {
  const ids = ADMIN_ROUTES.map(route => route.id);
  const keys = Object.keys(handlers);
  if (new Set(ids).size !== ids.length || ids.some(item => typeof handlers[item] !== 'function') || keys.some(key => !ids.includes(key))) throw new Error('Admin route table and handlers disagree');
}

// Enforcement order after authentication: match (404/405), route permission (403), then the handler.
export async function dispatchAdmin(context, principal, subpath, handlers) {
  const match = matchAdminRoute(context.request.method, subpath);
  if (match.status === 405) return new Response(JSON.stringify({ error: 'Method not allowed' }), { status: 405, headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', Allow: match.allow } });
  if (match.status) fail('Endpoint not found', match.status);
  requirePermission(principal, match.route.permission);
  return handlers[match.route.id]({ ...context, params: match.params });
}

// Single audit writer: records actor, actor_type and actor_role from env.PRINCIPAL ('system' for scheduled work).
export function auditStatement(env, action, resourceId, at = new Date().toISOString(), details = null) {
  const principal = env.PRINCIPAL;
  return env.DB.prepare('INSERT INTO audit_events(id,actor,action,resource_id,created_at,actor_type,actor_role,details_json) VALUES(?,?,?,?,?,?,?,?)')
    .bind(crypto.randomUUID(), principal?.actor ?? 'system', action, resourceId, at, principal?.type ?? 'system', principal?.role ?? null, details === null ? null : JSON.stringify(details));
}

// D12: principals without audit.read see Access actors (email addresses) as a display label; owners see raw actors.
export const ACCESS_ACTOR_LABEL = 'Власник (Access)';
export function actorLabel(principal, actor) {
  if (can(principal, 'audit.read') || actor === principal?.actor || typeof actor !== 'string' || !actor.includes('@') || actor.startsWith('staff:')) return actor;
  return ACCESS_ACTOR_LABEL;
}
