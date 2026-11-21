import { test, expect } from '@playwright/test';

// H4 fresh-drop hero (ADR-0014). Fixtures only: /api/products is mocked, nothing real is touched.
const svg = c => 'data:image/svg+xml,' + encodeURIComponent(`<svg xmlns="http://www.w3.org/2000/svg" width="400" height="500"><rect width="400" height="500" fill="${c}"/></svg>`);
const day = n => new Date(Date.UTC(2026, 10, n)).toISOString();
const item = (slug, categoryId, brand, updatedAt, extra = {}) => ({ id: slug, slug, title: `Річ ${slug}`, description: 'fixture', brand, category: categoryId, categoryId, priceMinor: 175000, updatedAt, photos: [svg('#8a9')], cardPhoto: svg('#9ab'), variants: [{ size: 'M', stock: 2 }], ...extra });
const items = [
  item('sold-out-newest', 'hoodies', 'Lorem', day(19), { variants: [{ size: 'M', stock: 0 }] }),
  item('hoodie-new', 'hoodies', 'Lorem', day(18)),
  item('hoodie-old', 'hoodies', 'Lorem', day(17)),
  item('sneaker-new', 'sneakers', 'Velit', day(16), { priceMinor: 280000 }),
  item('tee-new', 'tees', 'Sitamet Isle', day(15)),
  item('no-photo', 'caps', 'Lorem', day(14), { photos: [], cardPhoto: undefined }),
  item('tee-old', 'tees', 'Sitamet Isle', day(1)),
];
const VIEWPORTS = [[1440, 900], [820, 1000], [390, 844]];
const noOverflow = page => page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth);
const shiftSum = page => page.evaluate(() => window.__shifts.reduce((a, b) => a + b, 0));
const watchShifts = page => page.addInitScript(() => {
  window.__shifts = [];
  new PerformanceObserver(list => { for (const e of list.getEntries()) if (!e.hadRecentInput) window.__shifts.push(e.value); }).observe({ type: 'layout-shift', buffered: true });
});
// Holds /api/products until released so the skeleton state can be measured.
async function hold(page, respond) {
  let release;
  const gate = new Promise(r => { release = r; });
  await page.route('**/api/products', async r => { await gate; await respond(r); });
  return release;
}
// The web fonts swap in on their own (a pre-existing reflow of the hero copy). Let them settle, then count only what the drop causes.
const settle = async page => { await page.evaluate(() => document.fonts.ready); await page.waitForTimeout(400); await page.evaluate(() => { window.__shifts = []; }); };
const boxes = (page, sel) => page.locator(sel).evaluateAll(els => els.map(e => { const b = e.getBoundingClientRect(); return [b.x, b.y + scrollY, b.width, b.height].map(n => Math.round(n * 2) / 2); }));
const ok = r => r.fulfill({ json: { items } });

for (const [width, height] of VIEWPORTS) test(`three tiles from the newest in-stock items, one per category, never sold out at ${width}px`, async ({ page }) => {
  await page.setViewportSize({ width, height });
  await page.route('**/api/products', ok);
  await page.goto('/');
  const tiles = page.locator('.hero-drop .drop-tile');
  await expect(tiles).toHaveCount(3);
  // hoodies (newest in stock), sneakers, tees: sold-out and photo-less items are skipped
  expect(await tiles.evaluateAll(a => a.map(x => x.getAttribute('href')))).toEqual(['/products/hoodie-new', '/products/sneaker-new', '/products/tee-new']);
  expect(await page.locator('.hero a[href="/products/sold-out-newest"], .hero a[href="/products/no-photo"]').count()).toBe(0);
  // captions: brand, title, price
  await expect(tiles.nth(1)).toContainText('Velit');
  await expect(tiles.nth(1)).toContainText('Річ sneaker-new');
  await expect(tiles.nth(1)).toContainText('2 800 грн');
  // images: decorative, thumbnail first, lead is high priority
  const imgs = page.locator('.hero-drop img');
  await expect(imgs).toHaveCount(3);
  for (const img of await imgs.all()) { await expect(img).toHaveAttribute('alt', ''); await expect(img).toHaveAttribute('loading', 'eager'); }
  await expect(imgs.nth(0)).toHaveAttribute('fetchpriority', 'high');
  await expect(imgs.nth(1)).not.toHaveAttribute('fetchpriority', 'high');
  expect(await imgs.nth(0).getAttribute('src')).toBe(items[1].cardPhoto);
  // heading, count and the retired index line
  await expect(page.getByRole('heading', { level: 2, name: 'Нові надходження' })).toBeVisible();
  await expect(page.locator('.drop-all')).toHaveText('7 речей у каталозі ↗');
  await expect(page.locator('.drop-all')).toHaveAttribute('href', '/#catalog');
  await expect(page.locator('.hero')).not.toContainText('РЕЧІ ДЛЯ ТВОГО ЩОДНЯ');
  await expect(page.locator('.hero')).toHaveCount(1);
  await expect(page.locator('#hero-title')).toBeVisible();
});

test('a broken thumbnail falls back to the original photo', async ({ page }) => {
  await page.route('**/api/products', r => r.fulfill({ json: { items: items.map(x => ({ ...x, cardPhoto: 'http://127.0.0.1:9/missing.webp' })) } }));
  await page.route('http://127.0.0.1:9/**', r => r.abort());
  await page.goto('/');
  await expect(page.locator('.hero-drop img').first()).toHaveAttribute('src', items[1].photos[0]);
});

for (const [width, height] of VIEWPORTS) {
  test(`skeleton holds the exact boxes of the tiles at ${width}px, zero layout shift`, async ({ page }) => {
    await page.setViewportSize({ width, height });
    await watchShifts(page);
    const release = await hold(page, ok);
    await page.goto('/');
    const sk = page.locator('.hero-drop .drop-skeleton');
    await expect(sk).toHaveCount(3);
    await expect(page.locator('.hero-drop')).toHaveAttribute('aria-busy', 'true');
    await settle(page);
    expect(await page.locator('.hero-drop').innerText()).toBe('');
    const before = { tiles: await boxes(page, '.hero-drop .drop-skeleton'), drop: await boxes(page, '.hero-drop'), strip: await boxes(page, '.street-strip') };
    release();
    await expect(page.locator('.hero-drop .drop-tile:not(.drop-skeleton)')).toHaveCount(3);
    await expect(page.locator('.hero-drop img').first()).toBeVisible();
    await page.waitForTimeout(300);
    expect(await boxes(page, '.hero-drop .drop-tile')).toEqual(before.tiles);
    expect(await boxes(page, '.hero-drop')).toEqual(before.drop);
    expect(await boxes(page, '.street-strip')).toEqual(before.strip);
    expect(await shiftSum(page)).toBeLessThan(0.001);
    expect(await noOverflow(page)).toBe(true);
  });

  test(`API failure keeps the same box with a quiet note at ${width}px`, async ({ page }) => {
    await page.setViewportSize({ width, height });
    await watchShifts(page);
    const release = await hold(page, r => r.fulfill({ status: 500, json: { error: 'fixture failure' } }));
    await page.goto('/');
    await expect(page.locator('.hero-drop .drop-skeleton')).toHaveCount(3);
    await settle(page);
    const before = { drop: await boxes(page, '.hero-drop'), strip: await boxes(page, '.street-strip') };
    release();
    await expect(page.locator('.hero-drop-empty')).toContainText('Нові надходження скоро');
    await expect(page.locator('.hero-drop-empty a')).toHaveAttribute('href', '/#catalog');
    await expect(page.locator('.hero-drop-empty img')).toHaveCount(0);
    await expect(page.locator('.hero-drop .drop-tile')).toHaveCount(0);
    await page.waitForTimeout(300);
    expect(await boxes(page, '.hero-drop')).toEqual(before.drop);
    expect(await boxes(page, '.street-strip')).toEqual(before.strip);
    expect(await shiftSum(page)).toBeLessThan(0.001);
    expect(await noOverflow(page)).toBe(true);
    await expect(page.locator('#hero-title')).toBeVisible();
  });
}

test('fewer than three eligible items show the quiet note', async ({ page }) => {
  await page.route('**/api/products', r => r.fulfill({ json: { items: items.slice(0, 4) } })); // sold out is skipped: 2 hoodies + 1 sneaker = 3 eligible items in 2 categories
  await page.goto('/');
  // 3 eligible items in 2 categories: one per category, then the next newest: still three tiles
  await expect(page.locator('.hero-drop .drop-tile')).toHaveCount(3);
  await page.route('**/api/products', r => r.fulfill({ json: { items: [items[1], items[3]] } }));
  await page.reload();
  await expect(page.locator('.hero-drop-empty')).toBeVisible();
  await expect(page.locator('.hero-drop .drop-tile')).toHaveCount(0);
  await page.route('**/api/products', r => r.fulfill({ json: { items: [] } }));
  await page.reload();
  await expect(page.locator('.hero-drop-empty')).toBeVisible();
  await expect(page.locator('.product-card')).toHaveCount(0);
});

test('/api/products starts before /api/taxonomy resolves', async ({ page }) => {
  let releaseTaxonomy;
  const gate = new Promise(r => { releaseTaxonomy = r; });
  await page.route('**/api/taxonomy', async r => { await gate; await r.continue(); });
  await page.route('**/api/products', ok);
  const productsRequested = page.waitForRequest('**/api/products');
  await page.goto('/', { waitUntil: 'commit' });
  await productsRequested; // would never arrive while taxonomy is held if the feed waited for it
  await expect(page.locator('.storefront')).toHaveCount(0);
  releaseTaxonomy();
  await expect(page.locator('.hero-drop .drop-tile')).toHaveCount(3);
});

test('one /api/products request on the landing page, none from the cart page', async ({ page }) => {
  let count = 0;
  await page.route('**/api/products', r => { count += 1; return ok(r); });
  await page.goto('/');
  await expect(page.locator('.hero-drop .drop-tile')).toHaveCount(3);
  expect(count).toBe(1);
  count = 0;
  await page.goto('/cart');
  await expect(page.locator('main, #root').first()).toBeVisible();
  await page.waitForTimeout(500);
  expect(count).toBe(0);
});

for (const [width, height] of VIEWPORTS) {
  test(`sticky bar still pins once the hero has scrolled away at ${width}px, no overflow`, async ({ page }) => {
    await page.setViewportSize({ width, height });
    await page.route('**/api/products', ok);
    await page.goto('/');
    await expect(page.locator('.hero-drop .drop-tile')).toHaveCount(3);
    await expect(page.locator('.store-bar')).toBeHidden();
    await page.evaluate(() => window.scrollTo(0, document.querySelector('#catalog').offsetTop));
    await expect(page.locator('.store-bar')).toBeVisible();
    await page.evaluate(() => window.scrollTo(0, 0));
    await expect(page.locator('.store-bar')).toBeHidden();
    expect(await noOverflow(page)).toBe(true);
  });
}

test('phone row scrolls and every tile is reachable by keyboard', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.route('**/api/products', ok);
  await page.goto('/');
  const tiles = page.locator('.hero-drop .drop-tile');
  await expect(tiles).toHaveCount(3);
  expect((await tiles.first().boundingBox()).width).toBeCloseTo((390 - 40) * 0.44, 0);
  await tiles.first().focus();
  await page.keyboard.press('Tab');
  await page.keyboard.press('Tab');
  await expect(tiles.nth(2)).toBeFocused();
  await expect.poll(() => page.locator('.drop-grid').evaluate(el => el.scrollLeft)).toBeGreaterThan(0);
  expect(await noOverflow(page)).toBe(true);
});

test('a stale ?intro param is ignored and the page still renders the hero', async ({ page }) => {
  await page.route('**/api/products', ok);
  await page.goto('/?intro=1');
  await expect(page.locator('.hero-drop .drop-tile')).toHaveCount(3);
});

test('the rack room requests no images until the lead tile settles, and its images are low priority', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  let release;
  const gate = new Promise(r => { release = r; });
  await page.route('**/api/products', r => r.fulfill({ json: { items: items.map(x => ({ ...x, cardPhoto: '/__lead/' + x.slug + '.png' })) } }));
  await page.route('**/__lead/**', async r => { await gate; await r.fulfill({ status: 200, contentType: 'image/svg+xml', body: '<svg xmlns="http://www.w3.org/2000/svg" width="4" height="4"/>' }); });
  await page.goto('/');
  await expect(page.locator('.hero-drop .drop-tile')).toHaveCount(3);
  const rack = page.locator('.rail-block img');
  await expect.poll(() => rack.count()).toBeGreaterThan(0);
  expect(await rack.evaluateAll(a => a.every(i => !i.hasAttribute('src')))).toBe(true);
  expect(await rack.evaluateAll(a => a.every(i => i.getAttribute('fetchpriority') === 'low'))).toBe(true);
  await expect(page.locator('.rail-block')).toHaveClass(/is-deferred/);
  expect(await page.locator('.rail-block .g3-shade').first().evaluate(e => getComputedStyle(e).display)).toBe('none');
  release();
  await expect.poll(() => rack.evaluateAll(a => a.length > 0 && a.every(i => i.hasAttribute('src'))), { timeout: 10000 }).toBe(true);
  await expect(page.locator('.rail-block')).not.toHaveClass(/is-deferred/);
});
