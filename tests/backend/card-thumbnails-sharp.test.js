import test from 'node:test';
import assert from 'node:assert/strict';
import sharp from 'sharp';
import { MAX_EDGE, QUALITY, worthKeeping } from '../../tools/card-thumbnails-core.mjs';

// The same sharp pipeline as tools/card-thumbnails.mjs, on a synthetic transparent PNG: alpha survives, the long edge
// is capped without enlarging, and a small image is not blown up.
const pipeline = input => sharp(input).rotate().resize({ width: MAX_EDGE, height: MAX_EDGE, fit: 'inside', withoutEnlargement: true }).webp({ quality: QUALITY }).toBuffer({ resolveWithObject: true });

test('large transparent PNG becomes a smaller WebP with alpha and a capped long edge', async () => {
  const png = await sharp({ create: { width: 1600, height: 2000, channels: 4, background: { r: 200, g: 30, b: 30, alpha: 0 } } })
    .composite([{ input: { create: { width: 800, height: 1000, channels: 4, background: { r: 20, g: 120, b: 220, alpha: 1 } } }, left: 400, top: 500 }]).png().toBuffer();
  const { data, info } = await pipeline(png);
  assert.equal(info.format, 'webp');
  assert.equal(Math.max(info.width, info.height), MAX_EDGE);
  assert.equal(info.height / info.width, 1.25, 'aspect ratio kept');
  assert.equal(info.channels, 4, 'alpha kept');
  assert.ok(worthKeeping(png.length, data.length), `${png.length} -> ${data.length}`);
  const corner = await sharp(data).ensureAlpha().raw().toBuffer();
  assert.equal(corner[3], 0, 'transparent corner stays transparent');
});

test('a small image is not enlarged', async () => {
  const jpg = await sharp({ create: { width: 300, height: 400, channels: 3, background: '#888' } }).jpeg().toBuffer();
  const { info } = await pipeline(jpg);
  assert.deepEqual([info.width, info.height], [300, 400]);
});
