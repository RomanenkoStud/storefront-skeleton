// Static checks of the logo swap: every referenced /brand file exists, no one-line compact, slots map as ADR-0014.
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { BRAND_FILES, brandSrc } from '../../apps/web/src/brand-files.js';

const root = new URL('../../', import.meta.url);
const read = p => readFileSync(new URL(p, root), 'utf8');
const ui = read('apps/web/src/ui.jsx'), header = read('apps/web/src/landing/SiteHeader.jsx');
const html = read('apps/web/index.html'), page = read('apps/api/src/product-page.js'), css = read('apps/web/src/landing/brand.css');

for (const src of [ui, html, page, read('apps/web/public/brand/site.webmanifest')]) {
  for (const [, f] of src.matchAll(/\/brand\/([a-z0-9-]+\.(?:svg|png|webmanifest))/g)) assert.ok(existsSync(new URL(`apps/web/public/brand/${f}`, root)), f);
}
assert.match(ui, /export function Brand\(\{ variant = 'full', on = 'dark' \}\)/);
assert.ok(ui.includes('aria-label="Lorem Store — головна"') && ui.includes('alt=""') && ui.includes('width={width} height={height}'));
assert.ok(css.includes('/brand/mark-n1.svg') && css.includes('/brand/mark-n1-small.svg') && css.includes('@container (max-width:120px)'), 'placeholder paints N1, small cut under 120px');
assert.ok(!/photo-placeholder[^\n]*<img/.test(ui), 'Photo placeholder has no nested img');
const ALLOWED = new Set(['logo-b1-dark.svg', 'logo-b1-light.svg', 'logo-s1-dark.svg', 'logo-s1-light.svg', 'mark-n1.svg', 'mark-n1-dark.svg']);
for (const variant of [...Object.keys(BRAND_FILES), 'bogus', undefined]) for (const on of ['dark', 'light', undefined]) {
  const src = brandSrc(variant, on), name = src.replace('/brand/', '');
  assert.ok(ALLOWED.has(name), `${variant}/${on} -> ${src}`);
  assert.ok(existsSync(new URL(`apps/web/public/brand/${name}`, root)), src);
}
assert.equal(brandSrc('mark'), '/brand/mark-n1-dark.svg');
assert.equal(brandSrc('full', 'light'), '/brand/logo-b1-light.svg');
assert.equal(brandSrc('compact'), '/brand/logo-s1-dark.svg');
assert.deepEqual(Object.keys(BRAND_FILES), ['full', 'compact', 'mark'], 'no one-line variant');
assert.deepEqual(BRAND_FILES.compact, { file: 'logo-s1', width: 64, height: 35 });
assert.ok(header.includes("variant={name === 'bar' ? 'compact' : 'full'}"), 'sticky bar uses S1, full header B1');
for (const m of ['favicon.svg', 'favicon-32.png', 'favicon-16.png', 'apple-touch-icon.png', 'site.webmanifest', 'content="#1b201d"', 'https://example.com/brand/og.png', 'twitter:card']) assert.ok(html.includes(m), m);
assert.match(css, /\.brand-full img\{width:120px/);
assert.match(css, /\.brand-compact img\{width:64px/);
assert.match(css, /\.brand-mark img\{width:48px/);
assert.ok(JSON.parse(read('apps/web/public/brand/site.webmanifest')).display === 'browser');
console.log('brand tests ok');
