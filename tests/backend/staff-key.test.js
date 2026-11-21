import test from 'node:test';
import assert from 'node:assert/strict';
import { configureStaffKey, SECRET_NAME, WORKER_NAME } from '../../tools/configure-staff-key.mjs';
const env = { CLOUDFLARE_ACCOUNT_ID: 'a'.repeat(32), CLOUDFLARE_API_TOKEN: 'synthetic-token' };
const response = result => new Response(JSON.stringify({ success: true, result }), { headers: { 'Content-Type': 'application/json' } });
test('missing production key is independently generated once, written only to the fixed Worker, and verified without disclosure', async () => {
  const calls = []; const bytes = Buffer.alloc(32, 17);
  const result = await configureStaffKey(env, async (url, options) => {
    calls.push({ url, ...options });
    if (calls.length === 1) return response([{ name: 'CUSTOMER_AUTH_HMAC_KEY', type: 'secret_text' }]);
    if (options.method === 'PUT') return response({ name: SECRET_NAME, type: 'secret_text' });
    return response([{ name: SECRET_NAME, type: 'secret_text' }]);
  }, count => { assert.equal(count, 32); return bytes; });
  assert.deepEqual(calls.map(c => c.method), ['GET', 'PUT', 'GET']);
  assert.ok(calls.every(c => c.url.endsWith(`/workers/scripts/${WORKER_NAME}/secrets`)));
  assert.deepEqual(JSON.parse(calls[1].body), { name: SECRET_NAME, text: bytes.toString('base64url'), type: 'secret_text' });
  assert.deepEqual(result, { configured: true, alreadyPresent: false, worker: WORKER_NAME, secretName: SECRET_NAME });
  assert.ok(!JSON.stringify(result).includes(bytes.toString('base64url')));
});
test('existing production key is preserved without generating or writing any key', async () => {
  let calls = 0;
  const result = await configureStaffKey(env, async (_url, options) => { calls++; assert.equal(options.method, 'GET'); return response([{ name: SECRET_NAME, type: 'secret_text' }]); }, () => { throw new Error('must not generate'); });
  assert.equal(calls, 1); assert.equal(result.alreadyPresent, true); assert.equal(result.configured, false);
});
test('invalid credentials, failed inventories and invalid random output fail before secret mutation', async () => {
  await assert.rejects(configureStaffKey({}, () => { throw new Error('must not fetch'); }), /required/);
  for (const result of [null, {}, [{ type: 'secret_text' }]]) await assert.rejects(configureStaffKey(env, async () => response(result)), /inventory/);
  await assert.rejects(configureStaffKey(env, async () => new Response('private-provider-error', { status: 403 })), /HTTP 403/);
  await assert.rejects(configureStaffKey(env, async () => response([]), () => Buffer.alloc(1)), /generate/);
  await assert.rejects(configureStaffKey(env, async () => response([{ name: SECRET_NAME, type: 'secret_key' }])), /binding type/);
});
test('provider errors and verification failures never expose the generated key or provider body', async () => {
  let count = 0;
  await assert.rejects(configureStaffKey(env, async () => ++count === 1 ? response([]) : new Response('sensitive-provider-detail', { status: 500 })), error => error.message === 'Production secret PUT failed (HTTP 500).');
  count = 0;
  await assert.rejects(configureStaffKey(env, async () => { count++; return response(count === 2 ? {} : []); }), /verification/);
});
