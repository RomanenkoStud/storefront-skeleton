import { randomBytes } from 'node:crypto';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

export const WORKER_NAME = 'storefront-skeleton';
export const SECRET_NAME = 'STAFF_AUTH_HMAC_KEY';

// Explicit production operator action. Existing bindings are preserved, never rotated.
// The fresh key exists only in memory and the Cloudflare request body.
export async function configureStaffKey(env = process.env, fetcher = fetch, random = randomBytes) {
  const account = env.CLOUDFLARE_ACCOUNT_ID;
  const token = env.CLOUDFLARE_API_TOKEN;
  if (!/^[a-f0-9]{32}$/i.test(account || '') || typeof token !== 'string' || !token.trim() || /[\r\n]/.test(token)) throw new Error('Production Cloudflare account and token are required.');
  const endpoint = `https://api.cloudflare.com/client/v4/accounts/${account}/workers/scripts/${WORKER_NAME}/secrets`;
  async function request(method, body) {
    const response = await fetcher(endpoint, { method, headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, ...(body ? { body: JSON.stringify(body) } : {}), signal: AbortSignal.timeout(20000) });
    if (!response.ok) throw new Error(`Production secret ${method} failed (HTTP ${response.status}).`);
    let result; try { result = await response.json(); } catch { throw new Error('Invalid production secret response.'); }
    if (result.success !== true) throw new Error('Production secret operation was rejected.');
    return result.result;
  }
  const before = await request('GET');
  if (!Array.isArray(before) || before.some(item => typeof item?.name !== 'string')) throw new Error('Invalid production secret inventory.');
  const existing = before.find(item => item.name === SECRET_NAME);
  if (existing && existing.type !== 'secret_text') throw new Error('Existing production staff key has an unexpected binding type.');
  if (existing) return { configured: false, alreadyPresent: true, worker: WORKER_NAME, secretName: SECRET_NAME };
  const bytes = random(32);
  if (!(bytes instanceof Uint8Array) || bytes.byteLength !== 32) throw new Error('Unable to generate a production staff key.');
  await request('PUT', { name: SECRET_NAME, text: Buffer.from(bytes).toString('base64url'), type: 'secret_text' });
  const after = await request('GET');
  if (!Array.isArray(after) || !after.some(item => item.name === SECRET_NAME && item.type === 'secret_text')) throw new Error('Production staff key verification failed.');
  return { configured: true, alreadyPresent: false, worker: WORKER_NAME, secretName: SECRET_NAME };
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try { console.log(JSON.stringify(await configureStaffKey())); }
  catch (error) { console.error(error.message); process.exitCode = 1; }
}
