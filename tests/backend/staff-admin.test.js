import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { readFileSync, readdirSync } from 'node:fs';
import { staffAdmin } from '../../apps/api/src/staff-admin.js';
import worker from '../../apps/api/src/index.js';

function setup(t) {
  const sqlite = new DatabaseSync(':memory:');
  for (const name of readdirSync(new URL('../../migrations/', import.meta.url)).filter(n => /^\d{4}.*\.sql$/.test(n)).sort()) sqlite.exec(readFileSync(new URL('../../migrations/' + name, import.meta.url), 'utf8'));
  if (!sqlite.prepare('PRAGMA table_info(staff_auth_flows)').all().some(c => c.name === 'session_token_hash')) sqlite.exec('ALTER TABLE staff_auth_flows ADD COLUMN session_token_hash TEXT');
  let beforeBatch;
  const wrap = (sql, values = []) => ({ sql, values, bind(...v) { return wrap(sql, v); }, async first() { return sqlite.prepare(sql).get(...values) ?? null; }, async all() { return { results: sqlite.prepare(sql).all(...values) }; }, async run() { return sqlite.prepare(sql).run(...values); } });
  const DB = { prepare: sql => wrap(sql), async batch(statements) { beforeBatch?.(); beforeBatch = undefined; sqlite.exec('BEGIN'); try { const result = statements.map(s => ({ results: sqlite.prepare(s.sql).all(...s.values) })); sqlite.exec('COMMIT'); return result; } catch (error) { sqlite.exec('ROLLBACK'); throw error; } } };
  t.after(() => sqlite.close());
  const owner = { type: 'access', role: 'owner', actor: 'owner@example.com' };
  const seed = (id, role = 'manager', status = 'active') => { const at = new Date().toISOString(); sqlite.prepare('INSERT INTO staff_members(id,role,status,invited_email,google_sub,email,display_name,created_by,created_at,updated_at,invitation_expires_at) VALUES(?,?,?,?,?,?,?,?,?,?,?)').run(id, role, status, id + '@example.com', status === 'invited' ? null : 'sub-' + id, status === 'invited' ? null : id + '@example.com', id, 'seed', at, at, status === 'invited' ? new Date(Date.now() + 100000).toISOString() : null); return id; };
  const session = (id, age = 0) => { const now = new Date().toISOString(), auth = new Date(Date.now() - age).toISOString(); sqlite.prepare('INSERT INTO staff_sessions VALUES(?,?,?,?,?,?,?)').run('hash-' + id, id, now, auth, now, new Date(Date.now() + 100000).toISOString(), new Date(Date.now() + 1000000).toISOString()); return { type: 'staff', role: 'owner', actor: 'staff:' + id, staffId: id, sessionTokenHash: 'hash-' + id, authenticatedAt: auth }; };
  const call = async (action, data, { principal = owner, id = 'target', query = '', raw, contentType = 'application/json', env: extra = {} } = {}) => {
    const request = new Request('http://localhost/api/admin/staff' + query, { method: ['list', 'audit'].includes(action) ? 'GET' : 'POST', headers: { 'Content-Type': contentType }, body: ['list', 'audit'].includes(action) ? undefined : raw ?? JSON.stringify(data ?? {}) });
    const env = { DB, APP_ENV: 'development', PRINCIPAL: principal, ...extra };
    try { const response = await staffAdmin({ request, env, params: { id }, url: new URL(request.url) }, action); return { status: response.status, data: await response.json(), response }; } catch (error) { if (!error.status) throw error; return { status: error.status, data: { error: error.message } }; }
  };
  return { sqlite, DB, owner, seed, session, call, race: fn => { beforeBatch = fn; } };
}

test('invite/list project approved fields only, normalize email, reject duplicates and unsupported fields', async t => {
  const a = setup(t);
  const invited = await a.call('invite', { email: ' New@Example.com ', displayName: ' Manager ', role: 'manager' });
  assert.equal(invited.status, 201); assert.equal(invited.data.invitedEmail, 'new@example.com'); assert.equal(invited.data.displayName, 'Manager'); assert.equal(invited.data.status, 'invited');
  assert.ok(Date.parse(invited.data.invitationExpiresAt) > Date.now() + 71 * 3600000);
  assert.equal((await a.call('invite', { email: 'new@example.com', displayName: 'Duplicate', role: 'manager' })).status, 409);
  assert.equal((await a.call('invite', { email: 'invalid', displayName: 'Name', role: 'manager' })).status, 400);
  assert.equal((await a.call('invite', { email: 'ok@example.com', displayName: 'Name', role: 'admin' })).status, 400);
  assert.equal((await a.call('invite', { email: 'ok@example.com', displayName: 'Name', role: 'owner', google_sub: 'hack' })).status, 400);
  const list = await a.call('list'); assert.equal(list.data.items.length, 1); assert.ok(!JSON.stringify(list.data).includes('google_sub'));
  const event = a.sqlite.prepare("SELECT * FROM audit_events WHERE action='staff.invite'").get(); assert.equal(event.actor_type, 'access'); assert.equal(event.actor_role, 'owner'); assert.equal(event.details_json, '{"role":"manager"}'); assert.ok(!event.details_json.includes('@'));
});

test('manager cannot read staff/audit or perform any management action', async t => {
  const a = setup(t); a.seed('target');
  for (const action of ['list', 'audit', 'invite', 'update', 'suspend', 'reactivate', 'reinvite', 'remove', 'revoke']) {
    assert.equal((await a.call(action, {}, { principal: { type: 'staff', role: 'manager', actor: 'staff:m', staffId: 'm' } })).status, 403, action);
  }
  assert.equal(a.sqlite.prepare('SELECT COUNT(*) n FROM audit_events').get().n, 0);
});

test('Google owner must reauthenticate and cannot modify owners or own account', async t => {
  const a = setup(t); a.seed('google', 'owner'); a.seed('target'); a.seed('other-owner', 'owner');
  const principal = a.session('google');
  const stale = await a.call('suspend', {}, { principal: { ...principal, authenticatedAt: new Date(Date.now() - 600001).toISOString() } }); assert.equal(stale.status, 403); assert.equal(stale.data.reauth, true);
  for (const action of ['update', 'suspend', 'remove', 'revoke', 'reactivate', 'reinvite']) assert.equal((await a.call(action, action === 'remove' ? { confirm: true } : action === 'update' ? { displayName: 'X' } : {}, { principal, id: 'google' })).status, 403);
  for (const action of ['update', 'suspend', 'remove', 'revoke']) assert.equal((await a.call(action, action === 'remove' ? { confirm: true } : action === 'update' ? { displayName: 'X' } : {}, { principal, id: 'other-owner' })).status, 403);
  assert.equal((await a.call('update', { role: 'owner' }, { principal })).status, 403);
  assert.equal((await a.call('invite', { role: 'owner', email: 'owner2@example.com', displayName: 'Owner' }, { principal })).status, 403);
  assert.equal((await a.call('update', { displayName: 'Renamed' }, { principal })).status, 200);
});

test('suspend/reactivate/remove atomically revoke sessions and flows, retain anonymous audit tombstone', async t => {
  const a = setup(t); a.seed('target'); a.session('target');
  a.sqlite.prepare("INSERT INTO staff_auth_flows(binding_hash,state_hash,intent,staff_id,code_verifier,nonce,redirect_uri,return_path,created_at,expires_at,session_token_hash) VALUES('b','s','login',NULL,'v','n','http://localhost/api/staff/google/callback','/staff','x','z','hash-target')").run();
  assert.equal((await a.call('suspend')).status, 200); assert.equal(a.sqlite.prepare('SELECT COUNT(*) n FROM staff_sessions').get().n, 0); assert.equal(a.sqlite.prepare('SELECT COUNT(*) n FROM staff_auth_flows').get().n, 0);
  assert.equal((await a.call('suspend')).status, 409); assert.equal((await a.call('reactivate')).status, 200);
  assert.equal((await a.call('remove', {})).status, 400); assert.equal((await a.call('remove', { confirm: true })).status, 200);
  const row = a.sqlite.prepare("SELECT * FROM staff_members WHERE id='target'").get(); assert.equal(row.status, 'removed'); for (const key of ['google_sub', 'email', 'invited_email']) assert.equal(row[key], null);
  assert.equal((await a.call('list')).data.items.length, 0); assert.equal((await a.call('reactivate')).status, 409);
  assert.equal((await a.call('invite', { email: 'target@example.com', displayName: 'Again', role: 'manager' })).status, 201);
});

test('Access owners can change owner rows; role/name changes are separately audited', async t => {
  const a = setup(t); a.seed('target', 'owner');
  assert.equal((await a.call('update', { role: 'manager', displayName: 'Edited' })).status, 200);
  const events = a.sqlite.prepare('SELECT action,details_json FROM audit_events ORDER BY rowid').all(); assert.deepEqual(events.map(e => e.action), ['staff.role.change', 'staff.rename']); assert.deepEqual(JSON.parse(events[0].details_json), { from: 'owner', to: 'manager' });
  a.seed('pending', 'manager', 'invited'); assert.equal((await a.call('reinvite', {}, { id: 'pending' })).status, 200);
});

test('write guards reject capacity races, target promotion and actor suspension without partial audit/mutation', async t => {
  const a = setup(t); for (let i = 0; i < 49; i++) a.seed('m' + i);
  a.race(() => a.seed('racer'));
  assert.equal((await a.call('invite', { email: 'extra@example.com', displayName: 'Extra', role: 'manager' })).status, 409);
  assert.equal(a.sqlite.prepare("SELECT COUNT(*) n FROM staff_members WHERE invited_email='extra@example.com'").get().n, 0);
  assert.equal(a.sqlite.prepare('SELECT COUNT(*) n FROM audit_events').get().n, 0);
  a.seed('google', 'owner'); const principal = a.session('google');
  a.race(() => a.sqlite.prepare("UPDATE staff_members SET role='owner' WHERE id='m0'").run());
  assert.equal((await a.call('suspend', {}, { principal, id: 'm0' })).status, 409); assert.equal(a.sqlite.prepare("SELECT status FROM staff_members WHERE id='m0'").get().status, 'active');
  a.race(() => a.sqlite.prepare("UPDATE staff_members SET status='suspended' WHERE id='google'").run());
  assert.equal((await a.call('update', { displayName: 'Forbidden' }, { principal, id: 'm1' })).status, 409); assert.equal(a.sqlite.prepare("SELECT display_name FROM staff_members WHERE id='m1'").get().display_name, 'm1');
  assert.equal(a.sqlite.prepare('SELECT COUNT(*) n FROM staff_admin_guards').get().n, 0);
});

test('audit pagination resolves staff labels, excludes identifiers and does not lose timestamp ties', async t => {
  const a = setup(t); a.seed('target'); const timestamp = '2026-01-01T00:00:00.000Z';
  for (const id of ['a', 'b', 'c']) a.sqlite.prepare("INSERT INTO audit_events(id,actor,actor_type,actor_role,action,resource_id,created_at) VALUES(?,'staff:target','staff','manager','edit','product',?)").run(id, timestamp);
  const first = await a.call('audit', undefined, { query: '?limit=2' }); assert.deepEqual(first.data.items.map(e => e.id), ['c', 'b']); assert.equal(first.data.items[0].actor, 'target');
  const second = await a.call('audit', undefined, { query: '?limit=2&before=' + encodeURIComponent(first.data.next) }); assert.deepEqual(second.data.items.map(e => e.id), ['a']); assert.equal(second.data.next, null);
  for (const query of ['?limit=101', '?limit=0', '?limit=1.5', '?before=bad']) assert.equal((await a.call('audit', undefined, { query })).status, 400);
});

test('bounded JSON, content types, mutation throttle and missing production config fail closed', async t => {
  const a = setup(t); a.seed('target');
  assert.equal((await a.call('update', {}, { raw: 'x'.repeat(4097) })).status, 413);
  assert.equal((await a.call('update', {}, { contentType: 'text/plain' })).status, 415);
  assert.equal((await a.call('update', {}, { raw: '[]' })).status, 400);
  assert.equal((await a.call('update', { displayName: 'x\u202Ey' })).status, 400);
  assert.equal((await a.call('update', { displayName: 'A' }, { env: { APP_ENV: 'production' } })).status, 503);
  for (let i = 0; i < 30; i++) assert.equal((await a.call('update', { displayName: 'Name ' + i })).status, 200);
  const limited = await a.call('update', { displayName: 'No' }); assert.equal(limited.status, 429); assert.ok(Number(limited.response.headers.get('Retry-After')) > 0); assert.equal(a.sqlite.prepare("SELECT display_name FROM staff_members WHERE id='target'").get().display_name, 'Name 29');
});

 test('staff routes enforce authentication and manager denial before handlers', async t => {
 const a=setup(t);
 const routes=[['GET','/staff'],['POST','/staff'],['PATCH','/staff/x'],['POST','/staff/x/suspend'],['POST','/staff/x/reactivate'],['POST','/staff/x/reinvite'],['POST','/staff/x/sessions/revoke'],['DELETE','/staff/x'],['GET','/audit']];
 for(const [method,path] of routes){for(const role of ['anonymous','manager']) {const response=await worker.fetch(new Request('http://localhost/api/admin'+path,{method,headers:{Origin:'http://localhost','Content-Type':'application/json'},body:method==='GET'?undefined:'{}'}),{DB:a.DB,APP_ENV:'development',AUTH_DEV_BYPASS:role==='anonymous'?'false':'true',DEV_STAFF_ROLE:role});assert.equal(response.status,role==='anonymous'?401:403,method+' '+path);}}
 assert.equal(a.sqlite.prepare('SELECT COUNT(*) n FROM audit_events').get().n,0);
 });

test('exact session revocation fails the actor guard even when another session has the same auth timestamp', async t => {
 const a=setup(t);a.seed('google','owner');a.seed('target');const principal=a.session('google');
 a.sqlite.prepare('INSERT INTO staff_sessions SELECT ?,staff_id,created_at,authenticated_at,last_seen_at,idle_expires_at,absolute_expires_at FROM staff_sessions WHERE token_hash=?').run('other-hash','hash-google');
 a.race(()=>a.sqlite.prepare('DELETE FROM staff_sessions WHERE token_hash=?').run('hash-google'));
 assert.equal((await a.call('update',{displayName:'Forbidden'},{principal})).status,409);assert.equal(a.sqlite.prepare("SELECT display_name FROM staff_members WHERE id='target'").get().display_name,'target');
 assert.equal(a.sqlite.prepare('SELECT COUNT(*) n FROM audit_events').get().n,0);
});
test('Access owner cannot target its own Google staff row or invitation', async t => {
 const a=setup(t);a.seed('owner','owner');
 assert.equal((await a.call('remove',{confirm:true},{id:'owner'})).status,403);
 a.seed('pending','owner','invited');a.sqlite.prepare("UPDATE staff_members SET invited_email='OWNER@example.com' WHERE id='pending'").run();
 assert.equal((await a.call('reinvite',{}, {id:'pending'})).status,403);
});
