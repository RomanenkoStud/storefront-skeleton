import { test, expect } from '@playwright/test';

// Fixture data lives only in this task's own e2e database. Two garment categories with enough stock for tiles.
async function seed(request, baseURL, stamp) {
  const headers = { Origin: baseURL };
  const supplier = await (await request.post('/api/admin/suppliers', { headers, data: { name: `Posters ${stamp}`, url: `https://mydrop.com.ua/posters_${stamp}` } })).json();
  const make = (kind, n, offset) => Array.from({ length: n }, (_, i) => ({ externalId: `${stamp}-${kind.key}-${i}`, title: `${kind.title} ${stamp} ${String(i).padStart(2, '0')}`, description: 'Poster fixture', category: kind.category, costMinor: 100000 + offset + i * 100, currency: 'UAH', photos: ['https://images.example.com/poster-fixture.jpg'], variants: [{ id: 'v', size: kind.size, stock: 2 }] }));
  const items = [...make({ key: 'h', title: 'Худі', category: 'Худі', size: 'M' }, 20, 0), ...make({ key: 's', title: 'Кросівки', category: 'Кросівки', size: '42' }, 16, 50000)];
  expect((await request.post(`/api/admin/suppliers/${supplier.id}/import`, { headers, data: { items } })).ok()).toBe(true);
  const all = await (await request.get('/api/admin/products')).json();
  for (const product of all.items.filter(p => p.supplierId === supplier.id)) expect((await request.patch(`/api/admin/products/${product.id}`, { headers, data: { published: true } })).ok()).toBe(true);
}

const tiles = page => page.locator('.product-grid > .poster-tile');
const slotOf = (page, locator) => locator.evaluate(el => [...el.parentElement.children].indexOf(el) + 1);

test('poster tiles take one slot at 12 and 24, keep counts, tab order and load-more focus, and show catalog data', async ({ page, request, baseURL }) => {
  await seed(request, baseURL, Date.now());
  await page.route('https://images.example.com/**', route => route.abort());
  const catalog = (await (await request.get('/api/products')).json()).items;
  await page.goto('/#catalog');
  const cards = page.locator('.product-card');
  const count = page.locator('.catalog-more-count');
  await expect(cards).toHaveCount(24);
  await expect(tiles(page)).toHaveCount(2);
  expect(await slotOf(page, tiles(page).nth(0))).toBe(12);
  expect(await slotOf(page, tiles(page).nth(1))).toBe(24);
  await expect(page.locator('.product-grid > *')).toHaveCount(26);
  await expect(count).toHaveText(`Показано 24 з ${catalog.length}`);
  await expect(page.locator('.item-count')).toHaveText(`${catalog.length} товарів`);

  // tiles are not product cards and are a single tab stop with a decorative image
  await expect(page.locator('.poster-tile.product-card, .product-card .poster-tile')).toHaveCount(0);
  const first = tiles(page).first();
  await expect(first.locator('a, button, input, [tabindex]')).toHaveCount(0);
  await expect(first.locator('img')).toHaveAttribute('alt', '');
  expect(await tiles(page).evaluateAll(list => list.map(t => t.tagName))).toEqual(['A', 'A']);

  // text comes from loaded data: the name reads "Label — N речей від price" and matches the catalog
  const seen = new Set();
  for (const tile of await tiles(page).all()) {
    const name = await tile.getAttribute('aria-label');
    expect(name).toMatch(/^.+ — від [\d ]+(,\d\d)? грн$/);
    const id = decodeURIComponent((await tile.getAttribute('href')).match(/category=([^#&]+)/)[1]);
    expect(seen.has(id)).toBe(false);
    seen.add(id);
    const inCategory = catalog.filter(p => p.categoryId === id && p.variants?.some(v => v.stock > 0));
    expect(Number(name.match(/— (\d+)/)[1])).toBe(inCategory.length);
    expect(await tile.getAttribute('href')).toBe(`/?category=${id}#catalog`);
    expect(Math.min(...inCategory.map(p => p.priceMinor))).toBeGreaterThan(0);
  }
  await expect(tiles(page).nth(0)).toHaveClass(/is-lime/);
  await expect(tiles(page).nth(1)).toHaveClass(/is-moss/);

  // keyboard: Tab from the last product before the tile lands on the tile once, then on the next card
  await cards.nth(10).locator('a.product-info').focus();
  await page.keyboard.press('Tab');
  await expect(first).toBeFocused();
  await page.keyboard.press('Tab');
  await expect(cards.nth(11).locator('a.product-info, button').first()).toBeFocused();

  // load more: focus still lands on the first new PRODUCT card (index 24), counts count products only
  await page.getByRole('button', { name: /^Показати ще/ }).click();
  await expect(cards).toHaveCount(Math.min(48, catalog.length));
  await expect(count).toHaveText(`Показано ${Math.min(48, catalog.length)} з ${catalog.length}`);
  await expect(cards.nth(24).locator('a.product-info')).toBeFocused();
  const tileSlots = [];
  for (const tile of await tiles(page).all()) tileSlots.push(await slotOf(page, tile.first()));
  expect(tileSlots.slice(0, 4)).toEqual([12, 24, 36, 48].slice(0, tileSlots.length));
});

test('a tile link filters the catalog, and tiles stay away from searches and filters', async ({ page, request, baseURL }) => {
  const stamp = Date.now();
  await seed(request, baseURL, stamp);
  await page.route('https://images.example.com/**', route => route.abort());
  await page.goto('/#catalog');
  const tile = tiles(page).first();
  await expect(tile).toBeVisible();
  const id = decodeURIComponent((await tile.getAttribute('href')).match(/category=([^#&]+)/)[1]);
  await tile.click();
  await expect(page).toHaveURL(new RegExp(`category=${id}`));
  await expect(page.locator('.product-card').first()).toBeVisible();
  await expect(tiles(page)).toHaveCount(0);
  await expect(page.locator('.catalog-results')).toBeFocused();

  await page.goto('/#catalog');
  await expect(tiles(page)).toHaveCount(2);
  await page.getByLabel('Пошук товарів').fill(String(stamp));
  await expect(tiles(page)).toHaveCount(0);
  await page.getByLabel('Пошук товарів').fill('');
  await expect(tiles(page)).toHaveCount(2);
  await page.getByLabel('Лише в наявності').check();
  await expect(tiles(page)).toHaveCount(0);
  await page.goto(`/?q=${stamp} 00#catalog`);
  await expect(page.locator('.product-card')).toHaveCount(2);
  await expect(tiles(page)).toHaveCount(0);
});

test('phone: tiles fill a column cell and nothing overflows at 390', async ({ page, request, baseURL }) => {
  await seed(request, baseURL, Date.now());
  await page.route('https://images.example.com/**', route => route.abort());
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('/#catalog');
  const tile = tiles(page).first();
  await expect(tile).toBeAttached();
  await tile.scrollIntoViewIfNeeded();
  const box = await tile.boundingBox();
  const card = await page.locator('.product-card').first().boundingBox();
  expect(Math.abs(box.width - card.width)).toBeLessThan(2);
  expect(box.x + box.width).toBeLessThanOrEqual(390);
  expect(await slotOf(page, tile)).toBe(12);
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390);
  for (const t of await tiles(page).all()) {
    const overflow = await t.evaluate(el => [...el.querySelectorAll('*')].some(c => c.getBoundingClientRect().right > el.getBoundingClientRect().right + 1));
    expect(overflow).toBe(false);
  }
});
