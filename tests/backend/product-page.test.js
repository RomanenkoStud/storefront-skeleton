import assert from 'node:assert/strict';
import { seoHtml } from '../../apps/api/src/product-page.js';

const product = (over = {}) => ({
  slug: 'coat-1', title: 'Пальто <b>"X"</b>', seoTitle: 'Пальто', seoDescription: 'Опис', description: 'Теплий <i>опис</i>',
  priceMinor: 175000, currency: 'UAH', brand: 'Duis', category: 'Пальта', categoryPath: ['Одяг', 'Пальта'], categoryId: 'coats',
  photos: ['https://example.com/a.jpg'], variants: [{ size: 'S', stock: 3 }, { size: 'M', stock: 0 }, { size: 'L', stock: 2 }],
  promoText: '', freeShipping: false, costMinor: 91234, supplierId: 'sup-private-77', externalId: 'ext-private-88', ...over,
});
const html = seoHtml(product(), 'https://shop.test');

// Brand: B1 outline image (accessible name on the link, empty alt), no one-line compact, icons, manifest and og:image.
assert.match(html, /<a class="brand" href="\/" aria-label="Lorem Store — головна"><img src="\/brand\/logo-b1-dark\.svg" alt="" width="120" height="61" decoding="async"><\/a>/);
assert.ok(!html.includes('wordmark-main') && !html.includes('logo-s1'));
for (const m of ['rel="icon" href="/brand/favicon.svg"', 'href="/brand/favicon-32.png"', 'href="/brand/favicon-16.png"', 'rel="apple-touch-icon" href="/brand/apple-touch-icon.png"', 'rel="manifest" href="/brand/site.webmanifest"', 'name="theme-color" content="#1b201d"', 'name="twitter:card"']) assert.ok(html.includes(m), m);
const ogImage = html.match(/<meta property="og:image" content="([^"]+)">/)[1];
assert.equal(ogImage, product().photos[0].startsWith('http') ? product().photos[0] : 'https://shop.test' + product().photos[0]);
const noPhoto = seoHtml({ ...product(), photos: [] }, 'https://shop.test');
assert.ok(noPhoto.includes('<meta property="og:image" content="https://shop.test/brand/og.png">'));
const header = html.match(/<header class="store-header">([\s\S]*?)<\/header>/)[1];
assert.deepEqual([...header.matchAll(/<a [^>]*href="([^"]+)"/g)].map(m => m[1]), ['/', '/#catalog', '/#delivery', '/account', '/#catalog-search', '/account', '/cart']);
assert.match(header, /<a class="hdr-tool search-link" href="\/#catalog-search" aria-label="Пошук"><svg/);
assert.match(header, /<a class="hdr-tool cart-link" href="\/cart" aria-label="Кошик"><svg[\s\S]*<\/svg><\/a>/);
assert.equal((header.match(/stroke-width="1\.6"/g) || []).length, 3, 'three icons from one stroke');

// Size chips are real radios; out-of-stock sizes are disabled; first available is required; no ul.sizes / duplicate h2.
const form = html.match(/<form class="add-to-cart"[\s\S]*?<\/form>/)[0];
assert.match(form, /action="\/cart"/);
assert.match(form, /method="get"/);
assert.match(form, /<input type="hidden" name="add" value="coat-1">/);
assert.equal([...form.matchAll(/<input type="radio" name="size"/g)].length, 2, 'out-of-stock sizes get no radio');
assert.match(form, /<input type="radio" name="size" value="S" required>/);
assert.match(form, /<span class="size-chip is-out" title="Немає в наявності">M<span class="visually-hidden"> — немає в наявності<\/span><\/span>/);
assert.ok(!form.includes('value="M"'));
assert.match(form, /<input type="radio" name="size" value="L">/);
assert.equal([...form.matchAll(/ required/g)].length, 1);
assert.match(form, /<input type="hidden" name="qty" value="1">/);
assert.ok(!form.includes('type="number"'));
assert.ok(!html.includes('class="sizes"') && !html.includes('Розміри та наявність') && !html.includes('<h2'));
assert.match(form, /<button type="submit">Додати до кошика<\/button>/);

// One price string, U+00A0 grouping, no legacy "₴" decimal format.
const PRICE = '1\u00a0750\u00a0грн';
assert.ok(html.includes(`<p class="price">${PRICE}</p>`));
assert.equal(html.split(PRICE).length - 1, 1);
assert.ok(!html.includes('₴') && !html.includes('1 750 грн') && !/1750\.00 /.test(html.replace(/<script[\s\S]*?<\/script>/, '')));

// Escaping and privacy.
assert.ok(html.includes('<h1>Пальто &lt;b&gt;&quot;X&quot;&lt;/b&gt;</h1>'));
assert.ok(!html.includes('<b>"X"</b>') && !html.includes('<i>опис</i>'));
for (const leak of ['91234', 'sup-private-77', 'ext-private-88', 'costMinor', 'supplierId', 'externalId']) assert.ok(!html.toLowerCase().includes(leak.toLowerCase()), leak);

// Fonts self-hosted, preloaded; canonical/JSON-LD intact; no scripts besides JSON-LD and the optional cookieless visit beacon, last in <body>.
assert.match(html, /<link rel="preload" href="\/fonts\/oswald-cyrillic\.woff2" as="font" type="font\/woff2" crossorigin>/);
assert.ok(!html.includes('fonts.googleapis.com') && html.includes('font-display:swap'));
assert.match(html, /<link rel="canonical" href="https:\/\/shop\.test\/products\/coat-1">/);
assert.deepEqual([...html.matchAll(/<script\b[^>]*>/g)].map(m => m[0]), ['<script type="application/ld+json">', '<script>']);
assert.match(html, /<script>\(function\(\)\{var __name=function\(f\)\{return f\};\(function startVisitBeacon\(win\) \{[\s\S]*\}\)\(window\);\}\)\(\);<\/script><\/body><\/html>$/);
assert.match(html, /"price":"1750.00"/);

// Nothing in stock: no cart form, sizes shown disabled and an explicit sold-out message.
const sold = seoHtml(product({ variants: [{ size: 'S', stock: 0 }] }), 'https://shop.test');
assert.ok(!sold.includes('<form') && sold.includes('Немає в наявності') && sold.includes('size-chip is-out'));
assert.match(sold, /OutOfStock/);
console.log('product-page ok');
