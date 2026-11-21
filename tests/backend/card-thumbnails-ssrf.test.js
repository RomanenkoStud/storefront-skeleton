import test from 'node:test';
import assert from 'node:assert/strict';
import { Readable } from 'node:stream';
import { EventEmitter } from 'node:events';
import { isBlockedAddress, resolvePublic, safeDownload } from '../../tools/safe-download.mjs';

const PNG = Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), Buffer.alloc(16)]);
const lookupTo = map => (host, _options, cb) => (map[host] ? cb(null, [].concat(map[host]).map(address => ({ address, family: address.includes(':') ? 6 : 4 }))) : cb(new Error('ENOTFOUND')));
// Fake https.request: routes by URL, records every request and the pinned lookup it was given.
function fakeRequest(routes, seen = []) {
  return (url, options, cb) => {
    const req = new EventEmitter();
    req.end = () => setImmediate(() => {
      seen.push({ url: String(url), lookup: options.lookup });
      const r = routes[String(url)] ?? { status: 404 };
      const res = Readable.from(r.body ? [r.body] : []);
      res.statusCode = r.status ?? 200; res.headers = r.headers ?? {};
      cb(res);
    });
    req.destroy = e => { if (e) req.emit('error', e); };
    return req;
  };
}

test('blocked address ranges: loopback, private, link-local, CGNAT, ULA, mapped IPv4, multicast, reserved', () => {
  for (const a of ['127.0.0.1', '10.1.2.3', '172.16.0.1', '172.31.255.255', '192.168.1.1', '169.254.169.254', '100.64.0.1', '0.0.0.0', '224.0.0.1', '255.255.255.255', '::1', '::', 'fc00::1', 'fd12:3456::1', 'fe80::1', 'ff02::1', '::ffff:127.0.0.1', '::ffff:10.0.0.1', '::ffff:7f00:1', '::ffff:a9fe:a9fe', 'not-an-ip']) assert.equal(isBlockedAddress(a), true, a);
  for (const a of ['93.184.216.34', '8.8.8.8', '172.32.0.1', '2606:4700:4700::1111', '::ffff:8.8.8.8']) assert.equal(isBlockedAddress(a), false, a);
});

test('a hostname that resolves to a private address is refused, even if another answer is public', async () => {
  await assert.rejects(resolvePublic('evil.example.com', lookupTo({ 'evil.example.com': '10.0.0.5' })), /non-public/);
  await assert.rejects(resolvePublic('evil.example.com', lookupTo({ 'evil.example.com': ['93.184.216.34', '169.254.169.254'] })), /non-public/);
  const ok = await resolvePublic('img.example.com', lookupTo({ 'img.example.com': '93.184.216.34' }));
  assert.equal(ok.address, '93.184.216.34');
  const seen = [];
  await assert.rejects(safeDownload('https://evil.example.com/a.png', { lookup: lookupTo({ 'evil.example.com': '127.0.0.1' }), request: fakeRequest({}, seen) }), /non-public/);
  assert.equal(seen.length, 0, 'no request is ever sent to the internal address');
});

test('a public image downloads, connecting to the pinned checked address', async () => {
  const seen = [];
  const body = await safeDownload('https://img.example.com/a.png', { lookup: lookupTo({ 'img.example.com': '93.184.216.34' }), request: fakeRequest({ 'https://img.example.com/a.png': { body: PNG } }, seen) });
  assert.deepEqual(body, PNG);
  await new Promise(resolve => seen[0].lookup('img.example.com', { all: false }, (e, address) => { assert.equal(address, '93.184.216.34'); resolve(); }));
});

test('a 302 to an internal host is refused, by name and by resolved address, and no request reaches it', async () => {
  for (const location of ['https://localhost/secret.png', 'https://169.254.169.254/latest/meta-data', 'http://img.example.com/plain.png', 'https://internal.example.com/x.png']) {
    const seen = [];
    const routes = { 'https://img.example.com/a.png': { status: 302, headers: { location } } };
    await assert.rejects(safeDownload('https://img.example.com/a.png', { lookup: lookupTo({ 'img.example.com': '93.184.216.34', 'internal.example.com': '192.168.0.9' }), request: fakeRequest(routes, seen) }), /refusing|non-public/, location);
    assert.deepEqual(seen.map(s => s.url), ['https://img.example.com/a.png'], 'only the public first hop was requested: ' + location);
  }
});

test('redirects: relative Location is followed, at most 3 hops', async () => {
  const lookup = lookupTo({ 'img.example.com': '93.184.216.34' });
  const chain = n => ({ status: 302, headers: { location: `/hop${n}` } });
  const good = { 'https://img.example.com/a.png': chain(1), 'https://img.example.com/hop1': chain(2), 'https://img.example.com/hop2': { body: PNG } };
  assert.deepEqual(await safeDownload('https://img.example.com/a.png', { lookup, request: fakeRequest(good) }), PNG);
  const long = { 'https://img.example.com/a.png': chain(1), 'https://img.example.com/hop1': chain(2), 'https://img.example.com/hop2': chain(3), 'https://img.example.com/hop3': chain(4), 'https://img.example.com/hop4': { body: PNG } };
  await assert.rejects(safeDownload('https://img.example.com/a.png', { lookup, request: fakeRequest(long) }), /redirects/);
});

test('size cap and error statuses', async () => {
  const lookup = lookupTo({ 'img.example.com': '93.184.216.34' });
  await assert.rejects(safeDownload('https://img.example.com/a.png', { lookup, maxBytes: 10, request: fakeRequest({ 'https://img.example.com/a.png': { body: PNG } }) }), /byte cap/);
  await assert.rejects(safeDownload('https://img.example.com/b.png', { lookup, request: fakeRequest({}) }), /download 404/);
});
