// staff-chosen rack / poster images over the shipped renders, and the sale banner view.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { cleanImages, rackWithImages, posterCutouts, bannerView, toLocalInput, fromLocalInput } from '../../apps/web/src/landing/storefront-images.js';

const RAIL = JSON.parse(readFileSync(new URL('../../apps/web/src/rail-media.json', import.meta.url), 'utf8'));
const U = c => `${c.repeat(8)}-${c.repeat(4)}-${c.repeat(4)}-${c.repeat(4)}-${c.repeat(12)}`;
const img = (c, w = 400, h = 600) => ({ src: `/media/storefront/${U(c)}.png`, w, h });
const hoodie = RAIL.clothes[0].categoryId, shoe = RAIL.shoes[0].categoryId;

assert.deepEqual(cleanImages({ a: { front: { src: 'https://evil.example/x.png', w: 1, h: 1 }, side: img('a'), poster: { src: `/media/campaign/${U('b')}.png`, w: 1, h: 1 } }, b: null }), { a: { side: img('a') } }, 'only /media/storefront/<uuid> images survive');
assert.deepEqual(cleanImages('nope'), {});

// No overrides: shipped rack unchanged.
assert.deepEqual(rackWithImages(RAIL, {}), RAIL);
assert.deepEqual(rackWithImages(RAIL, null).clothes, RAIL.clothes);
// A new front without side/angle turns on the side face as itself; no angle face (it would show the front flat).
let r = rackWithImages(RAIL, { [hoodie]: { front: img('a') } }).clothes[0];
assert.deepEqual([r.front, r.angle, r.side], [img('a'), undefined, img('a')]);
// New front + side, no angle: no three-quarter view, so the shipped angle of another garment is never mixed in.
r = rackWithImages(RAIL, { [hoodie]: { front: img('a'), side: img('b', 150, 600) } }).clothes[0];
assert.deepEqual([r.front, r.angle, r.side], [img('a'), undefined, img('b', 150, 600)]);
// Only the angle replaced: front and side stay shipped.
r = rackWithImages(RAIL, { [hoodie]: { angle: img('c') } }).clothes[0];
assert.deepEqual([r.front, r.angle, r.side], [RAIL.clothes[0].front, img('c'), RAIL.clothes[0].side]);
// Shoe slot replaces the shelf pair, keeping its other fields (flip).
const s = rackWithImages(RAIL, { [shoe]: { shoe: img('d', 300, 200) } }).shoes[0];
assert.deepEqual({ src: s.src, w: s.w, h: s.h, categoryId: s.categoryId }, { ...img('d', 300, 200), categoryId: shoe });
assert.equal(rackWithImages(RAIL, { [shoe]: { shoe: img('d') } }).rack, RAIL.rack);

// Poster cut-outs: poster override > rack front override > shipped; posters for categories off the rack too.
let p = posterCutouts(RAIL, {});
assert.deepEqual(p[hoodie], RAIL.clothes[0].front);
assert.deepEqual(p[shoe], { src: RAIL.shoes[0].src, w: RAIL.shoes[0].w, h: RAIL.shoes[0].h });
p = posterCutouts(RAIL, { [hoodie]: { front: img('a') }, caps: { poster: img('e') } });
assert.deepEqual(p[hoodie], img('a'));
assert.deepEqual(p.caps, img('e'));
assert.deepEqual(posterCutouts(RAIL, { [hoodie]: { front: img('a'), poster: img('f') } })[hoodie], img('f'));

// Banner view.
assert.equal(bannerView(null), null);
assert.equal(bannerView({ text: '  ' }), null);
assert.deepEqual(bannerView({ text: ' BLACK FRIDAY ', linkLabel: 'Дивитись', linkHref: '/?available=1#catalog' }), { text: 'BLACK FRIDAY', linkLabel: 'Дивитись', linkHref: '/?available=1#catalog' });
assert.deepEqual(bannerView({ text: 'x', linkLabel: 'go', linkHref: 'javascript:alert(1)' }), { text: 'x', linkLabel: '', linkHref: '' });
assert.deepEqual(bannerView({ text: 'x', linkLabel: 'go', linkHref: '//evil.example' }), { text: 'x', linkLabel: '', linkHref: '' });
assert.equal(bannerView({ text: 'x', endsAt: '2026-11-30T22:00:00.000Z' }, Date.parse('2026-12-01T00:00:00Z')), null, 'expired while the tab was open');

// datetime-local round trip in the local zone.
assert.equal(toLocalInput(null), '');
assert.equal(fromLocalInput(''), null);
assert.equal(fromLocalInput(toLocalInput('2026-11-27T08:30:00.000Z')), '2026-11-27T08:30:00.000Z');
console.log('storefront images ok');
