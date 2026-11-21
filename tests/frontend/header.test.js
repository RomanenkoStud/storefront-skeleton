import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { SEARCH_HREF, searchAction, wantsSearchFocus, condensedVisible, nextMenu, isHomePath } from '../../apps/web/src/landing/header-helpers.js';

assert.equal(SEARCH_HREF, '/#catalog-search');
assert.equal(isHomePath('/'), true);
assert.equal(isHomePath('/cart'), false);
assert.equal(searchAction('/', true), 'focus');
assert.equal(searchAction('/', false), 'navigate');
assert.equal(searchAction('/cart', true), 'navigate');
assert.equal(wantsSearchFocus('/', '#catalog-search'), true);
assert.equal(wantsSearchFocus('/', '#catalog'), false);
assert.equal(wantsSearchFocus('/account', '#catalog-search'), false);
// Condensed bar: only once the hero is above the viewport.
assert.equal(condensedVisible({ isIntersecting: true, boundingClientRect: { bottom: 300 } }), false);
assert.equal(condensedVisible({ isIntersecting: false, boundingClientRect: { bottom: 900 } }), false, 'hero still below');
assert.equal(condensedVisible({ isIntersecting: false, boundingClientRect: { bottom: -1 } }), true);
assert.equal(nextMenu(null, 'header'), 'header');
assert.equal(nextMenu('header', 'header'), null);
assert.equal(nextMenu('header', 'bar'), 'bar');

// The three header icons share one definition between the SPA and the server product page.
const ui = readFileSync(new URL('../../apps/web/src/ui.jsx', import.meta.url), 'utf8');
const page = readFileSync(new URL('../../apps/api/src/product-page.js', import.meta.url), 'utf8');
for (const [name, key] of [['tool-search', 'SEARCH_ICON'], ['tool-account', 'ACCOUNT_ICON'], ['tool-bag', 'CART_ICON']]) {
  const web = ui.match(new RegExp(`'${name}': <>(.*?)</>`))[1].replace(/\s*\/>/g, '/>');
  const srv = page.match(new RegExp(`const ${key}=ICON\\('(.*?)'\\);`))[1];
  assert.equal(srv, web, `${name} matches the server icon`);
}
console.log('header helpers ok');
