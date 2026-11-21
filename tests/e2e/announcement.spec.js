import { test, expect } from '@playwright/test';

const link = page => page.locator('.announcement').getByRole('link', { name: 'НОВІ НАДХОДЖЕННЯ' });
const open = async (page, url = '/') => { await page.route('**/api/products', route => route.fulfill({ json: { items: [] } })); await page.goto(url); };

for (const [name, width] of [['desktop', 1440], ['phone', 390]]) {
  test(`announcement new-arrivals link is visible with a real anchor href at ${width}px`, async ({ page }) => {
    await page.setViewportSize({ width, height: 900 });
    await open(page);
    await expect(link(page)).toBeVisible();
    await expect(link(page)).toHaveAttribute('href', '/#catalog');
    await expect(link(page).locator('[aria-hidden="true"]')).toHaveText('↓');
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  });
}

test('plain click sets newest sort, keeps other filters and lands on the catalog', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await open(page, '/?sort=price-asc&available=1');
  await expect(page.getByLabel('Сортування товарів')).toHaveValue('price-asc');
  await link(page).click();
  await expect(page.getByLabel('Сортування товарів')).toHaveValue('new');
  const url = new URL(page.url());
  expect(url.searchParams.has('sort')).toBe(false);
  expect(url.searchParams.get('available')).toBe('1');
  await expect(page.locator('#catalog')).toBeInViewport();
});

test('link is keyboard focusable with a visible focus ring and activates with Enter', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await open(page, '/?sort=title');
  await link(page).focus();
  await expect(link(page)).toBeFocused();
  expect(await link(page).evaluate(el => getComputedStyle(el).outlineStyle)).not.toBe('none');
  await page.keyboard.press('Enter');
  await expect(page.getByLabel('Сортування товарів')).toHaveValue('new');
});

test('phone shows only the link, brand line hidden, no horizontal overflow', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 800 });
  await open(page);
  await expect(page.getByText('ЛОРЕМ ІПСУМ · ТЕСТОВЕ ОГОЛОШЕННЯ')).toBeHidden();
  const box = await page.locator('.announcement').boundingBox();
  expect(box.width).toBeLessThanOrEqual(390);
});

test('on a product page the link follows href to the home catalog', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.route('**/api/products', route => route.fulfill({ json: { items: [] } }));
  await page.route('**/api/products/*', route => route.fulfill({ status: 404, json: { error: 'Not found' } }));
  const shell = await (await page.request.get('/')).text();
  await page.route('**/products/announcement-fixture', route => route.fulfill({ contentType: 'text/html', body: shell }));
  await page.goto('/products/announcement-fixture');
  await expect(page.locator('#catalog')).toHaveCount(0);
  await link(page).click();
  await expect(page).toHaveURL(/\/#catalog$/);
  await expect(page.locator('#catalog')).toHaveCount(1);
});

test('phone hit area is enlarged without changing the bar height', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 800 });
  await open(page);
  const a = await link(page).boundingBox();
  const cy = a.y + a.height / 2, cx = a.x + a.width / 2;
  for (const dy of [-10, 0, 10]) {
    expect(await page.evaluate(([x, y]) => !!document.elementFromPoint(x, y)?.closest('.announcement a'), [cx, cy + dy])).toBe(true);
  }
  const bar = await page.locator('.announcement').boundingBox();
  expect(bar.height).toBe(32);
});
