import test from 'node:test';
import assert from 'node:assert/strict';
import { CARD_THUMBNAIL_KEY, firstPhotoSql } from '../../apps/api/src/photo-derivatives.js';
import { ENVS, MAX_EDGE, DEFAULT_LIMIT, parseArgs, firstPhoto, sourceKind, thumbnailKey, thumbnailUrl, swapPlan, paramsString, sha256, selectCandidates, findStale, worthKeeping, imageType, isSystemicFailure } from '../../tools/card-thumbnails-core.mjs';

const UUID = 'aaaaaaaa-0000-4000-8000-000000000001';

test('arguments: defaults, flags and rejections', () => {
  assert.deepEqual(parseArgs([]), { env: 'prod', limit: DEFAULT_LIMIT, dryRun: false, force: false, prune: true, help: false });
  assert.deepEqual(parseArgs(['--env', 'staging', '--limit', '25', '--dry-run', '--force', '--no-prune']), { env: 'staging', limit: 25, dryRun: true, force: true, prune: false, help: false });
  for (const bad of [['--env', 'dev'], ['--env'], ['--limit', '0'], ['--limit', '-3'], ['--limit', 'x'], ['--limit', '1e3'], ['--limit', '999999'], ['--bogus']]) assert.throws(() => parseArgs(bad), bad.join(' '));
});

test('environments: production is the default and the two never share a database or bucket', () => {
  assert.equal(parseArgs([]).env, 'prod');
  assert.notEqual(ENVS.prod.db, ENVS.staging.db);
  assert.notEqual(ENVS.prod.bucket, ENVS.staging.bucket);
  assert.equal(ENVS.staging.bucket, 'lorem-store-media-staging');
});

test('first photo mirrors the public projection: overlay photos win, null inherits, empty source gives none', () => {
  assert.equal(firstPhoto({ photos: ['/o'] }, { photos: ['/s'] }), '/o');
  assert.equal(firstPhoto({ photos: null }, { photos: ['/s'] }), '/s');
  assert.equal(firstPhoto({}, { photos: ['/s', '/t'] }), '/s');
  assert.equal(firstPhoto({}, { photos: [] }), null);
  assert.equal(firstPhoto(undefined, undefined), null);
});

test('source URLs: R2 media and public https are accepted; internal or odd hosts are not', () => {
  assert.deepEqual(sourceKind(`/media/${UUID}.png`), { kind: 'r2', key: `${UUID}.png` });
  assert.equal(sourceKind('https://backend.mydrop.com.ua/p/1.jpg').kind, 'https');
  for (const bad of ['http://x.example/a.jpg', 'https://localhost/a.jpg', 'https://127.0.0.1/a.jpg', 'https://10.0.0.5/a.jpg', 'https://[::1]/a.jpg', 'https://intranet/a.jpg', 'https://u:p@x.example/a.jpg', 'https://x.example:8443/a.jpg', 'https://svc.internal/a.jpg', '/media/uploads/images/x.jpg', '/media/x.card.webp', 'data:image/png;base64,AA', '', null]) assert.equal(sourceKind(bad).kind, 'unsupported', String(bad));
});

test('thumbnail key: content-addressed, matches the Worker pattern, changes with source bytes or params, never collides across sources', () => {
  const url = `/media/${UUID}.png`, h1 = sha256(Buffer.from('bytes one')), h2 = sha256(Buffer.from('bytes two'));
  const key = thumbnailKey(url, h1);
  assert.match(key, CARD_THUMBNAIL_KEY);
  assert.equal(key, thumbnailKey(url, h1), 'deterministic for identical inputs');
  assert.notEqual(key, thumbnailKey(url, h2), 'the supplier replaced the image behind the same URL');
  const paramsKeys = new Set([paramsString(), 'card:v2:800:75:webp', 'card:v1:600:75:webp', 'card:v1:800:80:webp', 'card:v1:800:75:avif'].map(p => thumbnailKey(url, h1, p)));
  assert.equal(paramsKeys.size, 5, 'version, width, quality and format each change the key');
  assert.notEqual(key, thumbnailKey('https://backend.mydrop.com.ua/p/1.jpg', h1));
  assert.equal(thumbnailUrl(url, h1), `/media/${key}`);
});

test('the Worker pattern accepts only the new shape', () => {
  const ok = `${'a'.repeat(32)}-${'0'.repeat(16)}.card.webp`;
  assert.match(ok, CARD_THUMBNAIL_KEY);
  for (const bad of [`${UUID}.card.webp`, `${'a'.repeat(32)}.card.webp`, `${'a'.repeat(32)}-${'0'.repeat(15)}.card.webp`, `${'a'.repeat(32)}-${'0'.repeat(17)}.card.webp`, `${'A'.repeat(32)}-${'0'.repeat(16)}.card.webp`, `${'a'.repeat(32)}-${'0'.repeat(16)}.card.png`, `${'a'.repeat(32)}-${'0'.repeat(16)}.card.webp.x`, `x/${ok}`, `${ok}\n`, `${'a'.repeat(31)}g-${'0'.repeat(16)}.card.webp`]) assert.doesNotMatch(bad, CARD_THUMBNAIL_KEY, bad);
});

test('regenerate-swap-delete order: new object first, then the row, then the old object; no-ops when unchanged', () => {
  assert.deepEqual(swapPlan('/media/old.card.webp', '/media/new.card.webp'), ['put-new', 'update-row', 'delete-old']);
  assert.deepEqual(swapPlan(null, '/media/new.card.webp'), ['put-new', 'update-row']);
  assert.deepEqual(swapPlan('/media/same.card.webp', '/media/same.card.webp'), ['update-row'], 'same content: never re-PUT, never delete');
  assert.deepEqual(swapPlan('/media/old.card.webp', null), ['update-row', 'delete-old'], 'no longer worthwhile: row first, then the object');
  assert.deepEqual(swapPlan(null, null), ['update-row']);
});

test('selection: distinct, skips existing derivatives, honours limit and force, reports what remains', () => {
  const rows = [
    { first_photo: 'a', has_derivative: 0 }, { first_photo: 'b', has_derivative: 1 }, { first_photo: 'a', has_derivative: 0 },
    { first_photo: null, has_derivative: 0 }, { first_photo: 'c', has_derivative: 0 }, { first_photo: 'd', has_derivative: 0 },
  ];
  assert.deepEqual(selectCandidates(rows, { limit: 2 }), { total: 4, pending: 3, selected: ['a', 'c'] });
  assert.deepEqual(selectCandidates(rows, { limit: 10 }).selected, ['a', 'c', 'd']);
  assert.deepEqual(selectCandidates(rows, { limit: 10, force: true }).selected, ['a', 'b', 'c', 'd']);
  assert.deepEqual(selectCandidates([{ first_photo: 'a', has_derivative: 1 }]), { total: 1, pending: 0, selected: [] }, 'a rerun does nothing');
});

test('stale derivatives are those whose source is no longer any live first photo', () => {
  const derivatives = [{ source_url: 'a', url: '/media/1.card.webp' }, { source_url: 'b', url: null }, { source_url: 'c', url: '/media/3.card.webp' }];
  assert.deepEqual(findStale(derivatives, ['a', 'c']).map(d => d.source_url), ['b']);
  assert.deepEqual(findStale(derivatives, new Set()).length, 3);
});

test('size decision keeps a thumbnail only when strictly smaller than the original', () => {
  assert.equal(worthKeeping(1000, 999), true);
  assert.equal(worthKeeping(1000, 1000), false);
  assert.equal(worthKeeping(1000, 2000), false);
  assert.equal(worthKeeping(1000, 0), false);
  assert.equal(worthKeeping(NaN, 10), false);
  assert.ok(MAX_EDGE >= 600 && MAX_EDGE <= 1000);
});

test('image magic bytes', () => {
  const png = Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), Buffer.alloc(8)]);
  const jpg = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(12)]);
  const webp = Buffer.concat([Buffer.from('RIFF'), Buffer.alloc(4), Buffer.from('WEBP'), Buffer.alloc(4)]);
  assert.equal(imageType(png), 'image/png');
  assert.equal(imageType(jpg), 'image/jpeg');
  assert.equal(imageType(webp), 'image/webp');
  assert.equal(imageType(Buffer.from('<html>not an image at all</html>')), null);
  assert.equal(imageType(Buffer.alloc(4)), null);
});

test('exit policy: broken photos never fail the run; only all-Cloudflare failure does', () => {
  assert.equal(isSystemicFailure({ attempted: 0, infraFailed: 0 }), false);
  assert.equal(isSystemicFailure({ attempted: 21, infraFailed: 0 }), false, 'steady state: only persistently broken external photos remain, all failing');
  assert.equal(isSystemicFailure({ attempted: 300 }), false);
  assert.equal(isSystemicFailure({ attempted: 100, infraFailed: 40 }), false);
  assert.equal(isSystemicFailure({ attempted: 1, infraFailed: 1 }), true);
  assert.equal(isSystemicFailure({ attempted: 10, infraFailed: 10 }), true);
});

test('--force always re-uploads, so a thumbnail missing from R2 heals; unchanged keys are otherwise left alone', () => {
  assert.deepEqual(swapPlan('/media/same.card.webp', '/media/same.card.webp', true), ['put-new', 'update-row']);
  assert.deepEqual(swapPlan('/media/old.card.webp', '/media/new.card.webp', true), ['put-new', 'update-row', 'delete-old']);
});

test('first-photo SQL treats an overlay array (even empty) as authoritative and null/missing as inherit', async () => {
  const { DatabaseSync } = await import('node:sqlite');
  const db = new DatabaseSync(':memory:');
  db.exec('CREATE TABLE products (id TEXT, source_json TEXT, overrides_json TEXT)');
  const add = (id, source, overrides) => db.prepare('INSERT INTO products VALUES (?,?,?)').run(id, JSON.stringify(source), JSON.stringify(overrides));
  add('a', { photos: ['/s'] }, { photos: ['/o'] });
  add('b', { photos: ['/s'] }, { photos: [] });
  add('c', { photos: ['/s'] }, { photos: null });
  add('d', { photos: ['/s'] }, {});
  const got = Object.fromEntries(db.prepare(`SELECT id, ${firstPhotoSql('p')} AS f FROM products p`).all().map(r => [r.id, r.f]));
  assert.deepEqual(got, { a: '/o', b: null, c: '/s', d: '/s' });
  for (const [id, o, sr] of [['a', { photos: ['/o'] }, { photos: ['/s'] }], ['b', { photos: [] }, { photos: ['/s'] }], ['c', { photos: null }, { photos: ['/s'] }], ['d', {}, { photos: ['/s'] }]]) assert.equal(firstPhoto(o, sr), got[id] ?? null, 'same answer as the projection helper for ' + id);
});
