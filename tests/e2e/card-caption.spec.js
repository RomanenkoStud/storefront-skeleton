import { test, expect } from '@playwright/test';

const photo = 'data:image/svg+xml,' + encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" width="400" height="500"><rect width="400" height="500" fill="#8a9"/></svg>');
const item = (id, extra) => ({ id, slug: `item-${id}`, title: `Футболка ${id}`, brand: 'Lorem', category: 'Одяг', priceMinor: 175000, photos: [photo], variants: [{ size: 'M', stock: 3 }], ...extra });
const items = [item('a'), item('b', { priceMinor: 99950, variants: [{ size: 'M', stock: 0 }] }), item('c', { brand: 'Adipisci' })];

async function open(page) {
  await page.route('**/api/products', r => r.fulfill({ json: { items } }));
  await page.goto('/');
  await expect(page.locator('.product-card').first()).toBeVisible();
}

test('prices drop ",00" and sold-out card gets class and strip', async ({ page }) => {
  await open(page);
  const prices = await page.locator('.product-price').allTextContents();
  expect(prices[0].replace(/ /g, ' ')).toBe('1 750 грн');
  expect(prices.every(t => !t.includes(',00'))).toBe(true);
  expect(prices[2].replace(/ /g, ' ')).toBe('999,50 грн'); // sold-out item sinks to the end of the default sort
  const sold = page.locator('.product-card.is-sold-out');
  await expect(sold).toHaveCount(1);
  await expect(sold.locator('.sold-out-caption')).toHaveText('Немає в наявності');
  await expect(page.locator('.product-card:not(.is-sold-out) .sold-out-caption')).toHaveCount(0);
  await expect(sold.locator('.product-meta svg')).toHaveCount(0);
  const strip = await sold.locator('.sold-out-caption').boundingBox();
  const media = await sold.locator('.product-media').boundingBox();
  expect(Math.abs(strip.width - media.width)).toBeLessThan(2);
  expect(strip.y + strip.height).toBeLessThanOrEqual(media.y + media.height + 1);
  expect(await sold.locator('.product-image img').evaluate(e => getComputedStyle(e).filter)).toContain('grayscale');
});

for (const [width, sameLine] of [[1440, true], [390, false]]) {
  test(`caption layout at ${width}px and no overflow`, async ({ page }) => {
    await page.setViewportSize({ width, height: 900 });
    await open(page);
    await page.evaluate(() => document.fonts.ready);
    await page.locator('.product-card img').first().evaluate(i => i.complete || new Promise(r => { i.onload = i.onerror = r; }));
    const { bTop, bBottom, cTop } = await page.evaluate(() => {
      const meta = document.querySelector('.product-card .product-meta');
      const b = meta.querySelector('strong').getBoundingClientRect();
      const c = meta.querySelector('small').getBoundingClientRect();
      return { bTop: b.top, bBottom: b.bottom, cTop: c.top };
    });
    if (sameLine) expect(Math.abs(bTop - cTop)).toBeLessThan(6);
    else expect(cTop).toBeGreaterThanOrEqual(bBottom - 2);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  });
}
