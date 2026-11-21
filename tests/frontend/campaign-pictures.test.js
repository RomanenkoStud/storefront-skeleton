import assert from 'node:assert/strict';
import { alphaBounds, padBounds, targetSize, transparencyError, cropFor, encodePicture, libraryFromRows, groupRows, leafCategories, pictureOptions, railFallbacks, reorderIds, legacyOptions, dropQueued,
  NO_ALPHA_MESSAGE, TOO_BIG_MESSAGE, TOO_SMALL_MESSAGE, EMPTY_MESSAGE, MAX_BYTES } from '../../apps/web/src/campaign-pictures.js';
import { createTaxonomyContext } from '../../packages/catalog/taxonomy-context.js';

// Image helper: width x height RGBA, opaque inside [x0,x1)x[y0,y1) only.
const image = (w, h, x0, y0, x1, y1) => { const d = new Uint8ClampedArray(w * h * 4); for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) d.set([9, 9, 9, 255], (y * w + x) * 4); return d; };

// alpha bounding box; faint alpha (< 16) does not count
assert.deepEqual(alphaBounds(image(10, 8, 2, 3, 6, 7), 10, 8), { x: 2, y: 3, w: 4, h: 4 });
assert.equal(alphaBounds(new Uint8ClampedArray(10 * 8 * 4), 10, 8), null);
const faint = new Uint8ClampedArray(4 * 4 * 4); faint[3] = 15; assert.equal(alphaBounds(faint, 4, 4), null);
assert.throws(() => cropFor(new Uint8ClampedArray(64), 4, 4), { message: EMPTY_MESSAGE });

// 2% padding per side, clamped to the image
assert.deepEqual(padBounds({ x: 100, y: 200, w: 500, h: 1000 }, 1000, 2000), { x: 90, y: 180, w: 520, h: 1040 });
assert.deepEqual(padBounds({ x: 0, y: 0, w: 1000, h: 2000 }, 1000, 2000), { x: 0, y: 0, w: 1000, h: 2000 });
assert.deepEqual(cropFor(image(100, 100, 40, 40, 60, 60), 100, 100), { x: 39, y: 39, w: 22, h: 22 });

// long side <= 1200, never upscale
assert.deepEqual(targetSize(2400, 1200), { width: 1200, height: 600 });
assert.deepEqual(targetSize(600, 900), { width: 600, height: 900 });
assert.deepEqual(targetSize(900, 4000, 900), { width: 203, height: 900 });

// without background removal the file must already be >= 1% transparent
assert.equal(transparencyError(image(10, 10, 0, 0, 10, 10)), NO_ALPHA_MESSAGE);
assert.equal(transparencyError(image(10, 10, 0, 0, 10, 9)), '');

// encode plan: webp 0.9 first, then PNG when the browser silently falls back, then 900 px retry when over 2 MB
const mk = (type, size) => ({ type, size });
const run = async (crop, sizes) => {
  const calls = [];
  const render = async side => { calls.push(['render', side]); return { side }; };
  const encode = async (canvas, type, quality) => { calls.push(['encode', canvas.side, type, quality]); const next = sizes.shift(); return typeof next === 'function' ? next(type) : next; };
  return { calls, result: await encodePicture(crop, { render, encode }).catch(e => e) };
};
let r = await run({ w: 2000, h: 3000 }, [mk('image/webp', 500000)]);
assert.deepEqual(r.calls, [['render', 1200], ['encode', 1200, 'image/webp', 0.9]]);
assert.deepEqual([r.result.width, r.result.height, r.result.type], [800, 1200, 'image/webp']);
r = await run({ w: 2000, h: 3000 }, [mk('image/png', 1), mk('image/png', 900000)]);
assert.deepEqual(r.calls.filter(c => c[0] === 'encode').map(c => c[2]), ['image/webp', 'image/png']);
assert.equal(r.result.type, 'image/png');
r = await run({ w: 2000, h: 3000 }, [mk('image/webp', MAX_BYTES + 1), mk('image/webp', MAX_BYTES)]);
assert.deepEqual(r.calls.filter(c => c[0] === 'render').map(c => c[1]), [1200, 900]);
assert.deepEqual([r.result.width, r.result.height], [600, 900]);
r = await run({ w: 2000, h: 3000 }, [mk('image/webp', MAX_BYTES + 1), mk('image/webp', MAX_BYTES + 1)]);
assert.equal(r.result.message, TOO_BIG_MESSAGE);
r = await run({ w: 2000, h: 30 }, []);
assert.equal(r.result.message, TOO_SMALL_MESSAGE); assert.equal(r.calls.length, 0);

// data helpers
const taxonomy = createTaxonomyContext({ nodes: [
  { id: 'outerwear', label: 'Верхній одяг', parentId: null, position: 0 }, { id: 'puffer-jackets', label: 'Пуховики', parentId: 'outerwear', position: 0 },
  { id: 'hoodies', label: 'Худі', parentId: null, position: 1 }], redirects: { 'old-hoodies': 'hoodies' } });
assert.deepEqual(leafCategories(taxonomy).map(c => c.id), ['puffer-jackets', 'hoodies']);
const rows = [
  { id: 'b', categoryId: 'hoodies', src: '/media/campaign/b.webp', w: 5, h: 6, position: 1 }, { id: 'a', categoryId: 'hoodies', src: '/media/campaign/a.webp', w: 3, h: 4, position: 0 },
  { id: 'c', categoryId: 'gone', src: '/media/campaign/c.webp', w: 3, h: 4, position: 0 }, { id: 'd', categoryId: 'old-hoodies', src: '/media/campaign/d.webp', w: 1, h: 2, position: 2 }];
assert.deepEqual(libraryFromRows(rows.slice(0, 2)), { hoodies: [{ src: '/media/campaign/a.webp', w: 3, h: 4 }, { src: '/media/campaign/b.webp', w: 5, h: 6 }] });
const g = groupRows(rows, taxonomy);
assert.deepEqual(g.live.hoodies.map(x => x.id), ['a', 'b', 'd']); assert.deepEqual(g.deleted.map(x => x.id), ['c']);
assert.deepEqual(Object.fromEntries(pictureOptions(taxonomy, rows).map(o => [o.id, o.count])), { 'puffer-jackets': 0, hoodies: 3 });
const rail = [{ categoryId: 'hoodies', front: { src: '/f.webp', w: 1, h: 1 }, angle: { src: '/a.webp', w: 1, h: 1 }, side: { src: '/media/campaign/a.webp', w: 1, h: 1 } }];
assert.deepEqual(railFallbacks(rail, 'hoodies', [{ src: '/media/campaign/a.webp' }]).map(p => p.src), ['/f.webp', '/a.webp']);
assert.deepEqual(railFallbacks(rail, 'nope'), []);
assert.deepEqual(reorderIds(['a', 'b', 'c'], 1, -1), ['b', 'a', 'c']);
assert.equal(reorderIds(['a', 'b'], 0, -1), null); assert.equal(reorderIds(['a', 'b'], 1, 1), null);
// a leaf that later gained children keeps its pictures: listed as legacy, still grouped as live
const grown = createTaxonomyContext({ nodes: [{ id: 'hoodies', label: 'Худі', parentId: null, position: 0 }, { id: 'zip', label: 'Зіп', parentId: 'hoodies', position: 0 }] });
assert.deepEqual(legacyOptions(grown, rows), [{ id: 'hoodies', label: 'Худі', count: 2 }]); // the redirect is not in this taxonomy
assert.deepEqual(legacyOptions(taxonomy, rows), []);
// cancelled batch: items that never started are dropped (so nothing stays queued and locks «+ Додати»)
const queue = [{ key: 'a', status: 'error' }, { key: 'b', status: 'queued' }, { key: 'c', status: 'queued' }, { key: 'x', status: 'queued' }];
assert.deepEqual(dropQueued(queue, ['a', 'b', 'c']).map(p => p.key), ['a', 'x']);
console.log('campaign-pictures ok');
