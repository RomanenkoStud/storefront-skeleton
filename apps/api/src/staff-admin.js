import { HttpError, fail } from './domain.js';
import { can, auditStatement, requirePermission } from './permissions.js';

const json = (data, status = 200, headers = {}) => new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', ...headers } });
const iso = ms => new Date(ms).toISOString();
const all = async (env, sql, ...values) => (await env.DB.prepare(sql).bind(...values).all()).results;
const clean = (value, max, label) => { if (typeof value !== 'string' || !value.trim() || [...value.trim()].length > max || /[\p{Cc}\p{Cf}]/u.test(value)) fail(`Invalid ${label}`); return value.trim(); };
const validRole = value => { if (!['owner', 'manager'].includes(value)) fail('Invalid staff role'); return value; };
function email(value) { const result = clean(value, 254, 'email').toLowerCase(); if (!/^[^\s@]{1,64}@[^\s@.]+(?:\.[^\s@.]+)+$/.test(result)) fail('Invalid email'); return result; }
async function body(request, allowed) {
  if (!/^application\/json(?:\s*;|$)/i.test(request.headers.get('Content-Type') ?? '')) fail('Content-Type application/json required', 415);
  if (Number(request.headers.get('Content-Length')) > 4096) fail('Request too large', 413);
  const reader = request.body?.getReader(); let size = 0; const chunks = [];
  if (reader) try { while (true) { const { done, value } = await reader.read(); if (done) break; size += value.length; if (size > 4096) { await reader.cancel(); fail('Request too large', 413); } chunks.push(value); } } finally { reader.releaseLock(); }
  const bytes = new Uint8Array(size); let offset = 0; for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length; }
  let result; try { result = JSON.parse(new TextDecoder().decode(bytes)); } catch { fail('Invalid JSON'); }
  if (!result || typeof result !== 'object' || Array.isArray(result) || Object.keys(result).some(key => !allowed.includes(key))) fail('Unexpected field or JSON body');
  return result;
}
const memberView = row => ({ id: row.id, displayName: row.display_name, role: row.role, status: row.status, email: row.email, invitedEmail: row.invited_email, invitationExpiresAt: row.invitation_expires_at, createdBy: row.created_by, createdAt: row.created_at, updatedAt: row.updated_at, lastSignInAt: row.last_sign_in_at, activeSessions: row.active_sessions ?? 0 });
async function member(env, id) {
  const row = await env.DB.prepare("SELECT m.*,(SELECT COUNT(*) FROM staff_sessions s WHERE s.staff_id=m.id AND s.idle_expires_at>? AND s.absolute_expires_at>?) active_sessions FROM staff_members m WHERE m.id=?").bind(iso(Date.now()), iso(Date.now()), id).first();
  if (!row) fail('Staff member not found', 404); return row;
}
async function throttle(request, env) {
  const dev = env.APP_ENV === 'development' && ['localhost', '127.0.0.1', '[::1]'].includes(new URL(request.url).hostname);
  const key = String(env.STAFF_AUTH_HMAC_KEY ?? '').trim() || (dev ? 'local-development-staff-throttle-key' : '');
  if (!dev && (key.length < 32 || key === String(env.CUSTOMER_AUTH_HMAC_KEY ?? '').trim())) fail('Staff management is not configured', 503);
  const cryptoKey = await crypto.subtle.importKey('raw', new TextEncoder().encode(key), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const digest = await crypto.subtle.sign('HMAC', cryptoKey, new TextEncoder().encode(`staff-manage:${env.PRINCIPAL.actor}`));
  const hashed = [...new Uint8Array(digest)].map(v => v.toString(16).padStart(2, '0')).join('');
  const seconds = Math.floor(Date.now() / 1000), start = seconds - seconds % 3600;
  const row = await env.DB.prepare("INSERT INTO staff_auth_throttle(bucket,key_hmac,window_start,count) VALUES('staff-manage',?,?,1) ON CONFLICT(bucket,key_hmac,window_start) DO UPDATE SET count=count+1 RETURNING count").bind(hashed, start).first();
  if (row.count > 30) return json({ error: 'Too many staff changes; retry later' }, 429, { 'Retry-After': String(start + 3600 - seconds) });
}
// Recheck the actor and target inside the write transaction, rather than trusting preflight reads.
function guard(env, target, now, { capacity = false, ownerOnly = false } = {}) {
  const principal = env.PRINCIPAL, conditions = [], binds = [];
  if (principal.type === 'staff') {
    conditions.push("EXISTS(SELECT 1 FROM staff_members a JOIN staff_sessions s ON s.staff_id=a.id WHERE s.token_hash=? AND a.id=? AND a.role='owner' AND a.status='active' AND s.authenticated_at=? AND s.authenticated_at>=? AND s.idle_expires_at>? AND s.absolute_expires_at>?)");
    binds.push(principal.sessionTokenHash ?? '', principal.staffId, principal.authenticatedAt, iso(Date.parse(now) - 600000), now, now);
  }
  if (ownerOnly) conditions.push(principal.type === 'access' ? '1' : '0');
  if (target) { conditions.push('EXISTS(SELECT 1 FROM staff_members WHERE id=? AND role=? AND status=? AND updated_at=?)'); binds.push(target.id, target.role, target.status, target.updated_at); }
  if (capacity) conditions.push("(SELECT COUNT(*) FROM staff_members WHERE status<>'removed')<50");
  const token = crypto.randomUUID();
  return { statement: env.DB.prepare(`INSERT INTO staff_admin_guards(token,valid) VALUES(?,CASE WHEN ${conditions.join(' AND ') || '1'} THEN 1 ELSE 0 END)`).bind(token, ...binds), cleanup: env.DB.prepare('DELETE FROM staff_admin_guards WHERE token=?').bind(token) };
}
async function batch(env, target, now, statements, options) {
  const lock = guard(env, target, now, options);
  try { return await env.DB.batch([lock.statement, ...statements, lock.cleanup]); }
  catch (error) { if (/CHECK constraint|UNIQUE constraint/i.test(String(error?.message))) fail('Staff state changed or invitation already exists; refresh and retry', 409); throw error; }
}
function accessRequired(principal, targetRole, nextRole = targetRole) {
  const needed = targetRole === 'owner' || nextRole === 'owner';
  if (needed && principal.type !== 'access') fail('Owner changes require Cloudflare Access', 403); return needed;
}
async function auditView(env, url) {
  requirePermission(env.PRINCIPAL, 'audit.read');
  const rawLimit = url.searchParams.get('limit') ?? '50'; if (!/^[1-9]\d{0,2}$/.test(rawLimit) || Number(rawLimit) > 100) fail('Invalid audit limit');
  const limit = Number(rawLimit), before = url.searchParams.get('before'); let stamp = null, cursorId = null;
  if (before) {
    const split = before.indexOf('|'); stamp = split < 0 ? before : before.slice(0, split); cursorId = split < 0 ? null : before.slice(split + 1);
    if (!Number.isFinite(Date.parse(stamp)) || iso(Date.parse(stamp)) !== stamp || cursorId !== null && (!cursorId || cursorId.length > 100)) fail('Invalid audit cursor');
  }
  const conditions = before ? cursorId === null ? 'WHERE a.created_at<?' : 'WHERE (a.created_at<? OR (a.created_at=? AND a.id<?))' : '';
  const values = before ? cursorId === null ? [stamp] : [stamp, stamp, cursorId] : [];
  const rows = await all(env, `SELECT a.*,m.display_name staff_name FROM audit_events a LEFT JOIN staff_members m ON a.actor_type='staff' AND a.actor='staff:'||m.id ${conditions} ORDER BY a.created_at DESC,a.id DESC LIMIT ?`, ...values, limit + 1);
  const page = rows.slice(0, limit), last = page.at(-1);
  return json({ items: page.map(row => ({ id: row.id, actor: row.actor_type === 'staff' ? row.staff_name ?? 'Removed staff member' : row.actor, actorType: row.actor_type, actorRole: row.actor_role, action: row.action, resourceId: row.resource_id, details: row.details_json ? JSON.parse(row.details_json) : null, createdAt: row.created_at })), next: rows.length > limit ? `${last.created_at}|${last.id}` : null });
}
export async function staffAdmin({ request, env, params = {}, url = new URL(request.url) }, action) {
  const principal = env.PRINCIPAL;
  if (action === 'audit') return auditView(env, url);
  requirePermission(principal, action === 'list' ? 'staff.read' : 'staff.manage');
  if (action === 'list') return json({ items: (await all(env, "SELECT m.*,(SELECT COUNT(*) FROM staff_sessions s WHERE s.staff_id=m.id AND s.idle_expires_at>? AND s.absolute_expires_at>?) active_sessions FROM staff_members m WHERE status<>'removed' ORDER BY created_at,id", iso(Date.now()), iso(Date.now()))).map(memberView) });
  if (principal.type === 'staff' && (!Number.isFinite(Date.parse(principal.authenticatedAt)) || Date.now() - Date.parse(principal.authenticatedAt) > 600000 || Date.parse(principal.authenticatedAt) > Date.now())) return json({ error: 'Recent sign-in required', reauth: true }, 403);
  const allowed = action === 'invite' ? ['email', 'displayName', 'role'] : action === 'update' ? ['displayName', 'role'] : action === 'remove' ? ['confirm'] : [];
  const data = await body(request, allowed), now = iso(Date.now());
  const target = action === 'invite' ? null : await member(env, params.id);
  if (target?.status === 'removed') fail('Staff member has been removed', 409);
  if (target && (principal.staffId === target.id || principal.type === 'access' && [target.email, target.invited_email].some(value => typeof value === 'string' && value.toLowerCase() === principal.actor.toLowerCase()))) fail('Use your own session controls instead', 403);
  let ownerOnly = false;
  if (action === 'invite') ownerOnly = accessRequired(principal, validRole(data.role));
  else ownerOnly = accessRequired(principal, target.role, action === 'update' && data.role !== undefined ? validRole(data.role) : target.role);
  if (action === 'invite') { data.email = email(data.email); data.displayName = clean(data.displayName, 80, 'display name'); }
  if (action === 'update') { if (!Object.keys(data).length) fail('Supply a staff change'); if (data.displayName !== undefined) data.displayName = clean(data.displayName, 80, 'display name'); }
  if (action === 'remove' && data.confirm !== true) fail('Explicit removal confirmation required');
  const requiredStatus = { suspend: 'active', reactivate: 'suspended', reinvite: 'invited' }[action]; if (requiredStatus && target.status !== requiredStatus) fail(`Staff member must be ${requiredStatus}`, 409);
  const limited = await throttle(request, env); if (limited) return limited;
  const statements = [], expires = iso(Date.parse(now) + 72 * 3600000), targetId = target?.id ?? crypto.randomUUID();
  if (action === 'invite') {
    statements.push(env.DB.prepare("INSERT INTO staff_members(id,role,status,invited_email,display_name,created_by,created_at,updated_at,invitation_expires_at) VALUES(?,?,'invited',?,?,?,?,?,?)").bind(targetId, data.role, data.email, data.displayName, principal.actor, now, now, expires), auditStatement(env, 'staff.invite', targetId, now, { role: data.role }));
  } else if (action === 'update') {
    statements.push(env.DB.prepare('UPDATE staff_members SET role=?,display_name=?,updated_at=? WHERE id=?').bind(data.role ?? target.role, data.displayName ?? target.display_name, now, targetId));
    if (data.role !== undefined && data.role !== target.role) statements.push(auditStatement(env, 'staff.role.change', targetId, now, { from: target.role, to: data.role }));
    if (data.displayName !== undefined && data.displayName !== target.display_name) statements.push(auditStatement(env, 'staff.rename', targetId, now, { fields: ['displayName'] }));
  } else if (action === 'suspend') statements.push(env.DB.prepare("UPDATE staff_members SET status='suspended',suspended_at=?,updated_at=? WHERE id=?").bind(now, now, targetId));
  else if (action === 'reactivate') statements.push(env.DB.prepare("UPDATE staff_members SET status='active',suspended_at=NULL,updated_at=? WHERE id=?").bind(now, targetId));
  else if (action === 'reinvite') statements.push(env.DB.prepare('UPDATE staff_members SET invitation_expires_at=?,updated_at=? WHERE id=?').bind(expires, now, targetId));
  else if (action === 'remove') statements.push(env.DB.prepare("UPDATE staff_members SET status='removed',google_sub=NULL,email=NULL,invited_email=NULL,invitation_expires_at=NULL,removed_at=?,updated_at=? WHERE id=?").bind(now, now, targetId));
  let revokeIndex = -1;
  if (['suspend', 'remove', 'revoke'].includes(action)) {
    statements.push(env.DB.prepare('DELETE FROM staff_sessions WHERE staff_id=? RETURNING token_hash').bind(targetId), env.DB.prepare('DELETE FROM staff_auth_flows WHERE staff_id=? OR session_token_hash IN (SELECT token_hash FROM staff_sessions WHERE staff_id=?)').bind(targetId, targetId));
    // Delete flows before sessions so login flows bound to a current session are also revoked.
    [statements[statements.length - 2], statements[statements.length - 1]] = [statements.at(-1), statements.at(-2)];
    revokeIndex = statements.length - 1;
  }
  if (!['invite', 'update'].includes(action)) statements.push(auditStatement(env, action === 'revoke' ? 'staff.sessions.revoke' : `staff.${action}`, targetId, now));
  const results = await batch(env, target, now, statements, { capacity: action === 'invite', ownerOnly });
  if (action === 'remove') return json({ removed: true });
  if (action === 'revoke') return json({ revoked: results[revokeIndex + 1].results.length });
  return json(memberView(await member(env, targetId)), action === 'invite' ? 201 : 200);
}
