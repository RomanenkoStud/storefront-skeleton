import assert from 'node:assert/strict';
import { getScene } from '../../packages/catalog/campaign-scenes.js';
import { pickCampaign, campaignLead, modelsLabel, campaignHref, campaignArt, sceneSlots, resolveScene } from '../../apps/web/src/landing/campaign.js';

const nb = '\u00a0';
const labels = { 'puffer-jackets': 'Пуховики', hoodies: 'Худі', sneakers: 'Кросівки' };
const parents = { 'puffer-jackets': 'outerwear' };
const taxonomy = { getCategory: id => labels[id] ? { id, label: labels[id] } : null, matches: (id, parent) => id === parent || parents[id] === parent };
const rail = [{ categoryId: 'puffer-jackets', front: { src: '/rail/pf.webp', w: 520, h: 620 }, side: { src: '/rail/ps.webp', w: 140, h: 670 }, angle: { src: '/rail/pa.webp', w: 342, h: 691 } },
  { categoryId: 'hoodies', front: { src: '/rail/hf.webp', w: 520, h: 728 }, side: { src: '/rail/hs.webp', w: 292, h: 731 } }];
const art = campaignArt(rail, {});
const p = (categoryId, brand, priceMinor, stock = 1) => ({ categoryId, brand, priceMinor, variants: [{ size: 'M', stock }] });

assert.equal(modelsLabel(1), '1 модель'); assert.equal(modelsLabel(2), '2 моделі'); assert.equal(modelsLabel(5), '5 моделей');
assert.equal(modelsLabel(11), '11 моделей'); assert.equal(modelsLabel(12), '12 моделей'); assert.equal(modelsLabel(21), '21 модель'); assert.equal(modelsLabel(22), '22 моделі');

assert.equal(pickCampaign([], taxonomy, art), null);
assert.equal(pickCampaign(null, taxonomy, art), null);
assert.equal(pickCampaign([p('sneakers', 'Lorem', 100)], taxonomy, art), null, 'category without cut-out cannot headline');
assert.equal(pickCampaign([p('puffer-jackets', 'A', 100, 0)], taxonomy, art), null, 'sold out only');

const products = [p('puffer-jackets', 'Dolor', 250000), p('puffer-jackets', 'Excepteur', 400000), p('puffer-jackets', 'Excepteur', 300000), p('puffer-jackets', 'Ipsum', 100000, 0),
  p('hoodies', 'Lorem', 90000), p('hoodies', 'Lorem', 80000), p('sneakers', 'Lorem', 10), p('sneakers', 'Lorem', 10), p('sneakers', 'Lorem', 10)];
const c = pickCampaign(products, taxonomy, art);
assert.equal(c.categoryId, 'puffer-jackets'); assert.equal(c.label, 'Пуховики');
assert.equal(c.count, 3, 'sold-out items are not counted');
assert.deepEqual(c.brands, ['Excepteur', 'Dolor'], 'top brands by in-stock count, sold-out brand excluded');
assert.equal(c.minPriceMinor, 250000, 'from-price ignores sold-out items');
assert.deepEqual(c.images.map(i => i.src), ['/rail/pf.webp', '/rail/pa.webp', '/rail/ps.webp'], 'rail order: front, angle, side');
assert.equal(campaignLead(c), `3 моделі в наявності. Excepteur, Dolor. Від 2${nb}500${nb}грн.`);

// deterministic tie: smaller category id wins regardless of product order
const tie = [p('puffer-jackets', 'A', 1), p('hoodies', 'B', 2)];
assert.equal(pickCampaign(tie, taxonomy, art).categoryId, 'hoodies');
assert.equal(pickCampaign([...tie].reverse(), taxonomy, art).categoryId, 'hoodies');
// unknown taxonomy label is skipped, not shown as an id
assert.equal(pickCampaign([p('hoodies', 'B', 2)], { getCategory: () => null }, art), null);
// count follows the catalog filter's membership (descendants/aliases); bad prices are ignored
const tax2 = { getCategory: taxonomy.getCategory, matches: (id, parent) => id === parent || (parent === 'hoodies' && id === 'hoodies-legacy') };
const m = pickCampaign([p('hoodies', 'B', 5), p('hoodies-legacy', 'B', 7), p('hoodies', 'C', 0), p('hoodies', 'C', null), p('hoodies', 'C', -4)], tax2, art);
assert.equal(m.count, 2); assert.equal(m.minPriceMinor, 5);
// no brand or price data: lead stays truthful
assert.equal(campaignLead({ count: 1, brands: [], minPriceMinor: null }), '1 модель в наявності.');
assert.equal(pickCampaign([p('hoodies', '', 5)], taxonomy, art).brands.length, 0);
assert.equal(campaignHref('puffer-jackets'), '/?category=puffer-jackets&available=1#catalog');
console.log('campaign tests passed');

// admin settings
{
  const mix = [p('puffer-jackets', 'A', 100), p('hoodies', 'B', 100), p('hoodies', 'C', 200)];
  assert.equal(pickCampaign(mix, taxonomy, art).categoryId, 'hoodies');
  assert.equal(pickCampaign(mix, taxonomy, art, { mode: 'off' }), null, 'off hides the band');
  assert.equal(pickCampaign(mix, taxonomy, art, { mode: 'auto', excluded: ['hoodies'] }).categoryId, 'puffer-jackets', 'excluded skipped');
  assert.equal(pickCampaign(mix, taxonomy, art, { mode: 'auto', excluded: ['outerwear'] }).categoryId, 'hoodies', 'parent exclusion covers children');
  assert.equal(pickCampaign([p('puffer-jackets', 'A', 100)], taxonomy, art, { mode: 'auto', excluded: ['outerwear'] }), null);
  assert.equal(pickCampaign(mix, taxonomy, art, { mode: 'category', categoryId: 'puffer-jackets', excluded: [] }).categoryId, 'puffer-jackets', 'pinned wins');
  assert.equal(pickCampaign(mix, taxonomy, art, { mode: 'category', categoryId: 'sneakers', excluded: [] }).categoryId, 'hoodies', 'pin without stock or art falls back to auto');
}

// sceneSlots: a pictures prop that bypasses campaignArt is still validated and de-duplicated by src (React keys)
{
  const pic = (src, w = 10, h = 20) => ({ src, w, h });
  const { slots } = sceneSlots('fan', [pic('/a.webp'), pic('/a.webp'), pic('/b.webp'), null, pic('/c.webp', 'x'), pic('/d.webp')]);
  assert.deepEqual(slots.map(s => s.picture.src), ['/a.webp', '/b.webp', '/d.webp']);
}

// campaignArt (library first, then rail front/angle/side, de-duplicated) and scene slots
{
  const uuid = n => `${String(n).repeat(8).slice(0, 8)}-1111-4111-8111-${String(n).repeat(12).slice(0, 12)}`; // 8-4-4-4-12
  const lib = id => ({ src: `/media/campaign/${id}.webp`, w: 600, h: 900 });
  const byId = a => Object.fromEntries(a.map(x => [x.categoryId, x.pictures.map(i => i.src)]));
  assert.deepEqual(byId(campaignArt(rail, undefined)), { 'puffer-jackets': ['/rail/pf.webp', '/rail/pa.webp', '/rail/ps.webp'], hoodies: ['/rail/hf.webp', '/rail/hs.webp'] });
  const mixed = byId(campaignArt(rail, { hoodies: [lib(uuid(1)), lib(uuid(2))] }));
  assert.deepEqual(mixed.hoodies, [`/media/campaign/${uuid(1)}.webp`, `/media/campaign/${uuid(2)}.webp`, '/rail/hf.webp', '/rail/hs.webp'], 'L3 mix: library first, then rail');
  assert.deepEqual(mixed['puffer-jackets'].length, 3, 'untouched categories keep the rail pictures');
  // de-duplicated by src (also the library repeating itself)
  assert.deepEqual(byId(campaignArt(rail, { hoodies: [lib(uuid(1)), lib(uuid(1)), { src: '/rail/hf.webp', w: 1, h: 1 }] })).hoodies, [`/media/campaign/${uuid(1)}.webp`, '/rail/hf.webp', '/rail/hs.webp']);
  // a library-only category (no rail cut-outs) is eligible once it has a picture
  assert.deepEqual(byId(campaignArt(rail, { 'new-leaf': [lib(uuid(3))] }))['new-leaf'], [`/media/campaign/${uuid(3)}.webp`]);
  assert.equal(campaignArt(rail, { 'new-leaf': [] }).some(a => a.categoryId === 'new-leaf'), false, 'no picture, not eligible');
  // untrusted library entries: only /media/campaign/ paths with finite sizes
  const bad = campaignArt([], { x: [{ src: 'https://evil.test/a.png', w: 1, h: 1 }, { src: '/media/abc.webp', w: 1, h: 1 }, { src: '/media/campaign/ab.webp', w: 'x', h: 1 }, { src: '/media/campaign/ABCDEF12-1111-4111-8111-111111111111.webp', w: 1, h: 1 }, null, lib(uuid(4))] });
  assert.deepEqual(byId(bad), { x: [`/media/campaign/${uuid(4)}.webp`] });
  assert.deepEqual(campaignArt(null, null), []);
  assert.deepEqual(campaignArt(rail, { __proto__: { hoodies: [lib(uuid(6))] } }).find(a => a.categoryId === 'hoodies').pictures.length, 2, 'inherited keys ignored');
  // pickCampaign images are the art pictures (library first); eligibility needs a picture
  const withLib = campaignArt(rail, { 'puffer-jackets': [lib(uuid(5))] });
  assert.equal(pickCampaign([p('puffer-jackets', 'A', 1)], taxonomy, withLib).images[0].src, `/media/campaign/${uuid(5)}.webp`);
  assert.equal(pickCampaign([p('puffer-jackets', 'A', 1)], taxonomy, [{ categoryId: 'puffer-jackets', pictures: [] }]), null);

  // layout choice by picture count
  const pics = n => Array.from({ length: n }, (_, i) => ({ src: `/p${i}.webp`, w: 300, h: 600 }));
  const counts = (id, n) => sceneSlots(id, pics(n)).slots.length;
  for (const id of ['fan', 'rail']) { assert.equal(counts(id, 0), 0); assert.equal(counts(id, 1), 1); assert.equal(counts(id, 2), 2); assert.equal(counts(id, 3), 3); assert.equal(counts(id, 7), 3); }
  assert.equal(counts('hooks', 3), 3); assert.equal(counts('hooks', 4), 4); assert.equal(counts('hooks', 9), 4);
  const hooks4 = sceneSlots('hooks', pics(4)).slots;
  assert.deepEqual(hooks4.map(s => s.mobileOff), [false, false, false, true], 'the fourth hooks slot is desktop-only');
  assert.equal('--mx' in hooks4[3].style, false); assert.equal(hooks4[0].style['--x'], getScene('hooks').layouts[4].desktop[0].x); assert.equal(hooks4[0].style['--mr'], 0);
  assert.equal(sceneSlots('fan', pics(3)).slots[0].picture.src, '/p0.webp', 'slot 1 is rank 1');
  // unknown / unavailable scene renders the default (fan)
  assert.equal(resolveScene('nope').id, 'fan'); assert.equal(resolveScene(undefined).id, 'fan'); assert.equal(resolveScene('floor').id, 'fan', 'floor is unavailable'); assert.equal(resolveScene('rail').id, 'rail');
  assert.equal(sceneSlots('floor', pics(3)).scene.id, 'fan');
  assert.ok(!/floor/.test(sceneSlots('floor', pics(3)).scene.background.src + sceneSlots(getScene('floor'), pics(3)).scene.background.srcSet), 'unavailable floor never renders or requests its background');
}
console.log('campaign scene tests passed');
