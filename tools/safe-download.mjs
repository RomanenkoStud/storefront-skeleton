// Download a supplier-hosted image without letting it reach internal networks.
// Every hop (at most MAX_REDIRECTS, followed by hand) must be a public https URL (sourceKind) whose host resolves
// ONLY to public addresses, and the connection is pinned to the address that was checked, so DNS rebinding between the
// check and the connect is not possible. No credentials are ever sent.
import dns from 'node:dns';
import { BlockList, isIP } from 'node:net';
import https from 'node:https';
import { sourceKind } from './card-thumbnails-core.mjs';

export const MAX_REDIRECTS = 3;
const blocked = new BlockList();
for (const [net, bits] of [['0.0.0.0', 8], ['10.0.0.0', 8], ['100.64.0.0', 10], ['127.0.0.0', 8], ['169.254.0.0', 16], ['172.16.0.0', 12], ['192.0.0.0', 24], ['192.0.2.0', 24], ['192.168.0.0', 16], ['198.18.0.0', 15], ['198.51.100.0', 24], ['203.0.113.0', 24], ['224.0.0.0', 4], ['240.0.0.0', 4]]) blocked.addSubnet(net, bits, 'ipv4');
for (const [net, bits] of [['::', 128], ['::1', 128], ['64:ff9b::', 96], ['100::', 64], ['2001:db8::', 32], ['fc00::', 7], ['fe80::', 10], ['ff00::', 8]]) blocked.addSubnet(net, bits, 'ipv6');

/** True for loopback, private, link-local, CGNAT, ULA, multicast, reserved and IPv4-mapped forms of those. */
export function isBlockedAddress(address) {
  const kind = isIP(address);
  if (!kind) return true;
  if (kind === 4) return blocked.check(address, 'ipv4');
  const lower = address.toLowerCase();
  const dotted = /^(?:0:0:0:0:0:ffff:|::ffff:)(\d+\.\d+\.\d+\.\d+)$/.exec(lower);
  if (dotted) return blocked.check(dotted[1], 'ipv4');
  const hex = /^(?:0:0:0:0:0:ffff:|::ffff:)([0-9a-f]{1,4}):([0-9a-f]{1,4})$/.exec(lower);
  if (hex) { const n = (parseInt(hex[1], 16) << 16) | parseInt(hex[2], 16); return blocked.check(`${(n >>> 24) & 255}.${(n >>> 16) & 255}.${(n >>> 8) & 255}.${n & 255}`, 'ipv4'); }
  return blocked.check(address, 'ipv6');
}

/** Resolves a hostname and returns one address, rejecting when ANY answer is non-public. */
export async function resolvePublic(host, lookup = dns.lookup) {
  const answers = await new Promise((resolve, reject) => lookup(host, { all: true, verbatim: true }, (error, list) => error ? reject(error) : resolve(list)));
  if (!answers?.length) throw new Error(`${host} did not resolve`);
  for (const a of answers) if (isBlockedAddress(a.address)) throw new Error(`${host} resolves to a non-public address`);
  return answers[0];
}

function once({ url, address, request, timeoutMs, maxBytes }) {
  return new Promise((resolve, reject) => {
    const pinned = (_host, options, cb) => (options?.all ? cb(null, [address]) : cb(null, address.address, address.family));
    const req = request(url, { method: 'GET', lookup: pinned, timeout: timeoutMs, headers: { Accept: 'image/*' } }, res => {
      if ([301, 302, 303, 307, 308].includes(res.statusCode)) { res.resume(); return resolve({ redirect: res.headers.location || '' }); }
      if (res.statusCode !== 200) { res.resume(); return reject(new Error(`download ${res.statusCode}`)); }
      const declared = Number(res.headers['content-length']);
      if (declared > maxBytes) { res.destroy(); return reject(new Error(`image is ${declared} bytes, over the ${maxBytes} byte cap`)); }
      const chunks = []; let size = 0;
      res.on('data', chunk => { size += chunk.length; if (size > maxBytes) { res.destroy(); reject(new Error(`image is over the ${maxBytes} byte cap`)); } else chunks.push(chunk); });
      res.on('end', () => resolve({ body: Buffer.concat(chunks) }));
      res.on('error', reject);
    });
    req.on('timeout', () => req.destroy(new Error('download timed out')));
    req.on('error', reject);
    req.end();
  });
}

export async function safeDownload(startUrl, { lookup = dns.lookup, request = https.request, timeoutMs = 30000, maxBytes = 25 * 1024 * 1024 } = {}) {
  let url = startUrl;
  for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
    const kind = sourceKind(url);
    if (kind.kind !== 'https') throw new Error(`refusing to fetch ${hop ? 'redirect target' : 'URL'} (not a public https URL)`);
    const address = await resolvePublic(new URL(kind.url).hostname, lookup);
    const result = await once({ url: kind.url, address, request, timeoutMs, maxBytes });
    if (result.body) return result.body;
    let next;
    try { next = new URL(result.redirect, kind.url).href; } catch { throw new Error('bad redirect location'); }
    url = next;
  }
  throw new Error(`more than ${MAX_REDIRECTS} redirects`);
}
