import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { normalizeEasyDrop, parseXml, htmlToText, easydropUahToMinor, easydropSkippedSummary, EASYDROP_LIMITS } from '../../apps/api/src/easydrop.js';
import { syntheticFeed } from '../../tools/easydrop-timing.mjs';

const fixture = readFileSync(new URL('../../fixtures/easydrop-sample.xml', import.meta.url), 'utf8');
const img = n => `<image>https://easydrop.one/media/uploads/images/base/${n}.jpg</image>`;
const item = ({ id = '1001', group = '9', cat = 'c1', name = 'Name', price = '1000', size = '40', qty = '2', avail = 'true', extra = '', images = img('a') } = {}) =>
  `<item id="${id}"${group === null ? '' : ` group_id="${group}"`} available="${avail}"><categoryId>${cat}</categoryId><name>${name}</name>${price === null ? '' : `<priceuah>${price}</priceuah>`}<description>&lt;p&gt;A&lt;/p&gt;</description>${images}${size === null ? '' : `<param name="Розмір" unit="">${size}</param>`}<available>${avail}</available>${qty === null ? '' : `<quantity_in_stock>${qty}</quantity_in_stock>`}${extra}</item>`;
const feed = (...items) => `<?xml version="1.0"?><shop><catalog><category id="c1" >Brand |  Model </category></catalog><items>${items.join('\n')}</items></shop>`;
const status = fn => { try { fn(); } catch (e) { return e.status; } return null; };
const reasons = r => r.skipped.map(s => s.reason);

test('fixture normalizes with expected products, stock, prices, photos and categories', () => {
  const r = normalizeEasyDrop(fixture);
  const by = id => r.items.find(i => i.externalId === id);
  assert.equal(r.stats.categories, 5);
  const one = by('10001');
  assert.equal(one.costMinor, 265000);
  assert.equal(one.category, 'Testbrand | Runner One');
  assert.equal(one.variants.length, 11);
  assert.deepEqual(one.variants.slice(0, 3).map(v => [v.id, v.size, v.stock]), [['70010010001', '36', 0], ['70010110001', '37', 2], ['70010210001', '38', 5]]);
  assert.equal(one.description, 'Матеріал : Текстиль\nВиробник : Тестляндія');
  assert.equal(one.currency, 'UAH');
  const lone = by('o:700300');
  assert.equal(lone.variants[0].size, 'Один розмір');
  const hoodie = by('10004');
  assert.equal(hoodie.photos.length, 3);
  assert.equal(hoodie.variants.length, 4); // duplicate L collapsed
  assert.equal(hoodie.category, 'Fakewear | Hoodie');
  assert.ok(r.items.every(i => i.photos.every(p => p.startsWith('https://'))));
  // Split-price product skipped with a counted reason.
  assert.equal(by('10005'), undefined);
  assert.deepEqual(r.skipped, [{ externalId: '10005', reason: 'price_mismatch' }]);
  assert.match(easydropSkippedSummary(r.skipped, r.stats.products), /Пропущено 1 з 5 товарів: різні ціни розмірів — 1/);
});

test('available=false and missing or malformed quantity give zero, digit strings are accepted', () => {
  const r = normalizeEasyDrop(feed(
    item({ id: '1', size: 'A', avail: 'false', qty: '3' }), item({ id: '2', size: 'B', qty: null }),
    item({ id: '3', size: 'C', qty: ' 7 ' }), item({ id: '4', size: 'D', qty: 'many' }), item({ id: '5', size: 'E', qty: '-2' })));
  assert.deepEqual(r.items[0].variants.map(v => v.stock), [0, 0, 7, 0, 0]);
});

test('exact decimal price arithmetic', () => {
  assert.equal(easydropUahToMinor('2650'), 265000);
  assert.equal(easydropUahToMinor('19.99'), 1999);
  assert.equal(easydropUahToMinor('1,5'), 150);
  assert.equal(easydropUahToMinor('0.285'), 29);
  assert.equal(easydropUahToMinor('0.284'), 28);
  assert.equal(easydropUahToMinor('1.005'), 101);
  for (const v of ['', 'abc', '-5', '1e3', '0', '1.2.3', ' ', 5]) assert.throws(() => easydropUahToMinor(v), { reason: 'price_invalid' });
});

test('skip reasons are counted per product and do not affect valid products', () => {
  const r = normalizeEasyDrop(feed(
    item({ id: '1', group: '101' }),
    item({ id: '2', group: '102', name: '  ' }),
    item({ id: '3', group: '103', price: null }),
    item({ id: '4', group: '104', price: 'free' }),
    item({ id: '5', group: '105', price: '0' }),
    item({ id: '6', group: '106', size: '1' }), item({ id: '7', group: '106', size: null }),
    item({ id: '8', group: '107', price: '10' }), item({ id: '9', group: '107', size: '41', price: '11' }),
    item({ id: 'dup', group: '108' }), item({ id: 'dup', group: '109' }),
    item({ id: '', group: '110' })));
  assert.deepEqual(r.items.map(i => i.externalId), ['101']);
  const got = Object.fromEntries(r.skipped.map(s => [s.externalId, s.reason]));
  assert.deepEqual(got, { 102: 'title', 103: 'price_missing', 104: 'price_invalid', 105: 'price_invalid', 106: 'sizes_invalid', 107: 'price_mismatch', 108: 'id', 109: 'id', 110: 'id' });
});

test('group id mapping, ungrouped items and size variants', () => {
  const r = normalizeEasyDrop(feed(item({ id: '55', group: null, size: null }), item({ id: '56', group: '', size: '40' }), item({ id: '57', group: '55', size: 'M' })));
  assert.deepEqual(r.items.map(i => i.externalId), ['o:55', 'o:56', '55']);
  assert.equal(r.items[0].variants[0].size, 'Один розмір');
});

test('repeated size label keeps the item with the most stock; Размер alias works', () => {
  const r = normalizeEasyDrop(feed(item({ id: '1', size: 'L', qty: '1' }), item({ id: '2', size: 'l', qty: '4' }),
    item({ id: '3', size: null, extra: '<param name="Размер">XL</param>', qty: '2' })));
  assert.deepEqual(r.items[0].variants.map(v => [v.id, v.stock]), [['2', 4], ['3', 2]]);
});

test('category falls back to Без категорії; whitespace is collapsed', () => {
  const r = normalizeEasyDrop(feed(item({ id: '1', group: '1', cat: 'nope' }), item({ id: '2', group: '2', cat: 'c1' })));
  assert.deepEqual(r.items.map(i => i.category), ['Без категорії', 'Brand | Model']);
});

test('photos: HTTPS only, deduplicated in order, capped at 30', () => {
  const images = [img('a'), '<image>http://easydrop.one/x.jpg</image>', '<image>/media/abc.jpg</image>', '<image>https://u:p@easydrop.one/x.jpg</image>', img('b'), img('a')].join('');
  assert.deepEqual(normalizeEasyDrop(feed(item({ images }))).items[0].photos, ['https://easydrop.one/media/uploads/images/base/a.jpg', 'https://easydrop.one/media/uploads/images/base/b.jpg']);
  const many = Array.from({ length: 40 }, (_, i) => img(`p${i}`)).join('');
  assert.equal(normalizeEasyDrop(feed(item({ images: many }))).items[0].photos.length, 30);
});

test('description is entity-decoded, stripped to text and clipped; title clipped', () => {
  assert.equal(htmlToText('<p>A&nbsp;b</p><p>C<br/>D</p><script>x</script>'), 'A b\nC\nD\nx');
  const long = `<item id="1" group_id="7"><categoryId>c1</categoryId><name>${'T'.repeat(400)}</name><priceuah>5</priceuah><description>${'d'.repeat(25000)}</description><param name="Розмір">M</param></item>`;
  const r = normalizeEasyDrop(feed(long));
  assert.equal(r.items[0].title.length, 300);
  assert.equal(r.items[0].description.length, EASYDROP_LIMITS.description);
});

test('variant cap: 101 sizes skip the product, 100 pass', () => {
  const sizes = n => Array.from({ length: n }, (_, i) => item({ id: `v${i}`, size: String(i) }));
  assert.equal(normalizeEasyDrop(feed(...sizes(100))).items[0].variants.length, 100);
  assert.deepEqual(reasons(normalizeEasyDrop(feed(...sizes(101)))), ['variants']);
});

test('feed caps: items, products and bytes reject the whole feed', () => {
  const many = n => feed(...Array.from({ length: n }, (_, i) => item({ id: `i${i}`, group: `${i % 6000}` })));
  assert.equal(status(() => normalizeEasyDrop(many(20001))), 422);
  assert.equal(status(() => normalizeEasyDrop(many(5001))), 422);
  assert.equal(normalizeEasyDrop(many(5000)).items.length, 5000);
  assert.equal(status(() => normalizeEasyDrop(feed(item()) + ' '.repeat(EASYDROP_LIMITS.bytes))), 422);
  assert.equal(status(() => normalizeEasyDrop(new Uint8Array(EASYDROP_LIMITS.bytes + 1))), 422);
});

test('DOCTYPE, ENTITY, CDATA, processing instructions and unknown entities are rejected', () => {
  const bodies = [
    `<!DOCTYPE shop [<!ENTITY x "y">]>${feed(item())}`,
    `<?xml version="1.0"?><!DOCTYPE shop>${feed(item()).replace('<?xml version="1.0"?>', '')}`,
    feed(item()).replace('<shop>', '<shop><![CDATA[x]]>'),
    feed(item()).replace('<shop>', '<shop><?php x ?>'),
    feed(item({ name: '&xxe;' })),
    feed(item({ name: 'a & b' })),
    feed(item({ name: '&#0;' })),
    feed(item({ name: '&#x110000;' }))
  ];
  for (const b of bodies) assert.equal(status(() => normalizeEasyDrop(b)), 422, b.slice(0, 60));
});

test('standard entities and numeric references are decoded', () => {
  const r = normalizeEasyDrop(feed(item({ name: 'A &amp; B &lt;x&gt; &quot;q&quot; &apos;s&apos; &#1044; &#x416;' })));
  assert.equal(r.items[0].title, `A & B <x> "q" 's' Д Ж`);
  assert.equal(parseXml('<a b="&lt;1&gt;">&#65;</a>').attrs.b, '<1>');
});

test('malformed or empty feeds throw instead of returning an empty success', () => {
  for (const b of ['', 'not xml', '<shop>', '<shop></shop>', '<shop><catalog/></shop>', '<shop><catalog/><items/></shop>', '<root><catalog/><items><item id="1"/></items></root>',
    '<shop><catalog/><items><item id="1"></items></shop>', '<shop/><shop/>', 'text<shop><catalog/><items/></shop>', '<a><b></a></b>', '<a x="1" x="2"/>']) {
    assert.equal(status(() => normalizeEasyDrop(b)), 422, b);
  }
  assert.equal(status(() => normalizeEasyDrop(new Uint8Array([0xff, 0xfe, 0x3c]))), 422);
  assert.equal(status(() => normalizeEasyDrop(null)), 422);
  const deep = '<a>'.repeat(50) + '</a>'.repeat(50);
  assert.equal(status(() => parseXml(deep)), 422);
});

test('output is stable across repeated runs and accepts bytes', () => {
  const a = normalizeEasyDrop(fixture), b = normalizeEasyDrop(new TextEncoder().encode(fixture));
  assert.deepEqual(a, b);
});

test('synthetic ~6 MB feed normalizes and reports timing (informational, not asserted)', () => {
  const xml = syntheticFeed(), start = performance.now();
  const r = normalizeEasyDrop(xml);
  const ms = performance.now() - start;
  assert.equal(r.items.length, 930);
  assert.equal(r.stats.items, 10230);
  console.log(`easydrop synthetic feed: ${Buffer.byteLength(xml)} bytes, ${r.stats.items} items, ${ms.toFixed(0)} ms parse+normalize`);
});

test('htmlToText is linear on pathological input and keeps non-tag angle brackets', () => {
  for (const s of ['<', '<br', '&lt;', '<a ', '</p']) {
    const start = performance.now();
    htmlToText(s.repeat(Math.ceil(1048576 / s.length)));
    assert.ok(performance.now() - start < 500, `${s} too slow`);
  }
  assert.equal(htmlToText('a < b keep c > d'), 'a < b keep c > d');
  assert.equal(htmlToText('x <img src=x onerror=alert(1)'), 'x <img src=x onerror=alert(1)');
  assert.equal(htmlToText('&#8212; &lt;b&gt; &amp;amp;'), '— <b> &amp;');
  const start = performance.now();
  const r = normalizeEasyDrop(feed(`<item id="1" group_id="9"><categoryId>c1</categoryId><name>n</name><priceuah>5</priceuah><description>${'&lt;br'.repeat(150000)}</description><param name="Розмір">M</param><available>true</available><quantity_in_stock>1</quantity_in_stock></item>`));
  assert.ok(performance.now() - start < 500);
  assert.equal(r.items.length, 1);
});

test('allocation caps fire before memory is exhausted', () => {
  const wrap = body => `<shop><catalog/><items>${body}</items></shop>`;
  assert.equal(status(() => normalizeEasyDrop(wrap('<x/>'.repeat(EASYDROP_LIMITS.nodes + 1)))), 422);
  assert.throws(() => normalizeEasyDrop(wrap('<item id="1"/>'.repeat(EASYDROP_LIMITS.items + 1))), /20000-item/);
  assert.equal(status(() => parseXml(`<a>${'x'.repeat(EASYDROP_LIMITS.text + 1)}</a>`)), 422);
  assert.equal(status(() => parseXml(`<a>${'<b>x</b>'.repeat(10)}</a>`.replace(/x/g, 'y'.repeat(900000)))), 422); // cumulative text
  assert.equal(status(() => parseXml(`<a ${'b="1" '.repeat(500000)}`)), 422); // unterminated start tag
  assert.equal(status(() => parseXml(`<a b=">" ${'b="1" '.repeat(500000)}`)), 422);
});

test('only canonical EasyDrop media URLs survive as photos; the product is kept', () => {
  const ok = 'https://easydrop.one/media/uploads/images/item_12/a-b_c.1.webp';
  const images = [ok, 'https://evil.example/media/uploads/images/base/a.jpg', 'https://easydrop.one/media/uploads/images/other/a.jpg',
    'https://easydrop.one/media/uploads/images/base/a.jpg?x=1', 'https://easydrop.one/media/uploads/images/base/a%2e.jpg', 'https://easydrop.one/media/uploads/images/base/a..b.jpg',
    'https://easydrop.one/media/uploads/images/base/a.gif', 'https://easydrop.one:443/media/uploads/images/base/a.jpg', 'https://easydrop.one/media/uploads/images/base/a.jpg#f'].map(u => `<image>${u}</image>`).join('');
  const r = normalizeEasyDrop(feed(item({ images })));
  assert.equal(r.skipped.length, 0);
  assert.deepEqual(r.items[0].photos, [ok]);
});

test('group_id must be digits; malformed group is skipped and cannot merge with an ungrouped item', () => {
  const r = normalizeEasyDrop(feed(item({ id: '55', group: null }), item({ id: '56', group: 'o:55' }), item({ id: '57', group: '12 3' }), item({ id: '58', group: '1'.repeat(19) })));
  assert.deepEqual(r.items.map(i => i.externalId), ['o:55']);
  assert.deepEqual(reasons(r), ['id', 'id', 'id']);
});

test('stock needs at least one availability flag and every present flag true', () => {
  const noFlags = '<item id="1" group_id="9"><categoryId>c1</categoryId><name>n</name><priceuah>5</priceuah><param name="Розмір">A</param><quantity_in_stock>3</quantity_in_stock></item>';
  const elementOnly = '<item id="2" group_id="9"><categoryId>c1</categoryId><name>n</name><priceuah>5</priceuah><param name="Розмір">B</param><available>true</available><quantity_in_stock>3</quantity_in_stock></item>';
  const conflict = item({ id: '3', size: 'C', price: '5' }).replace('<available>true</available>', '<available>false</available>');
  const maybe = item({ id: '4', size: 'D', avail: 'yes', price: '5' });
  assert.deepEqual(normalizeEasyDrop(feed(noFlags, elementOnly, conflict, maybe)).items[0].variants.map(v => v.stock), [0, 3, 0, 0]);
});
