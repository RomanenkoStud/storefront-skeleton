import { test, expect } from '@playwright/test';

const open = async (page, url = '/') => { await page.route('**/api/products', route => route.fulfill({ json: { items: [] } })); await page.goto(url); };
const noOverflow = page => page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth);

test('delivery band states the placeholder delivery, payment and exchange policy', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await open(page);
  const band = page.locator('#delivery');
  await expect(band).toHaveCount(1);
  await expect(band.getByRole('heading', { level: 2, name: 'Як замовити' })).toHaveCount(1);
  await expect(band.getByRole('listitem')).toHaveCount(4);
  await expect(band).toContainText('Лорем іпсум — тестовий текст доставки.');
  await expect(band).toContainText('Долор сіт амет — тестовий текст умов оплати.');
  await expect(band).toContainText('тестовий текст умов обміну');
  await expect(band.locator('[data-placeholder]')).toHaveCount(0);
  // No invented terms: no prices, free-delivery or return-window claims.
  expect(await band.innerText()).not.toMatch(/грн|безкоштов|днів/i);
});

test('the #delivery anchor is reachable and sits directly above the footer', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await open(page, '/#delivery');
  await expect(page.locator('#delivery')).toBeInViewport();
  expect(await page.evaluate(() => document.getElementById('delivery').nextElementSibling?.matches('footer.store-footer'))).toBe(true);
});

test('footer keeps the wordmark, photo note in DM Sans, and every same-origin link resolves', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await open(page);
  const footer = page.locator('footer.store-footer');
  await expect(footer.locator('[data-slot="footer-logo"] .brand')).toHaveCount(1);
  const note = footer.locator('.photo-note');
  await expect(note).toHaveText('Фото товарів можуть бути оброблені для єдиного стилю каталогу.');
  expect(await note.evaluate(el => getComputedStyle(el).fontFamily)).toContain('DM Sans');
  await expect(footer.getByRole('heading', { level: 2 })).toHaveCount(3);
  await expect(footer.getByRole('link', { name: 'Одяг' })).toHaveAttribute('href', '/?category=clothing#catalog');
  const hrefs = await footer.locator('a[href]').evaluateAll(as => as.map(a => a.getAttribute('href')));
  expect(hrefs.length).toBeGreaterThan(5);
  for (const href of hrefs) {
    expect(href).toMatch(/^\//); // same-origin only; no invented external contacts
    const response = await page.request.get(href.split('#')[0]);
    expect(response.status(), href).toBe(200);
  }
  expect(hrefs).toContain('/#delivery');
  expect(await footer.locator('[aria-labelledby="footer-delivery-title"]').innerText()).not.toMatch(/грн|безкоштов|днів/i);
});

test('footer category link applies the real category filter', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await open(page);
  await page.locator('footer.store-footer').getByRole('link', { name: 'Взуття' }).click();
  await expect(page).toHaveURL(/category=footwear/);
  await expect(page.locator('#catalog-filters .selected .tree-label')).toHaveAttribute('aria-pressed', 'true');
  await expect(page.locator('#catalog-filters .selected .tree-label')).toContainText('Взуття');
});

test('footer links are keyboard focusable with a visible outline', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await open(page);
  const link = page.locator('footer.store-footer').getByRole('link', { name: 'Кошик' });
  await link.focus();
  expect(await link.evaluate(el => getComputedStyle(el).outlineStyle)).not.toBe('none');
});

for (const width of [390, 820]) {
  test(`band and footer do not overflow at ${width}px`, async ({ page }) => {
    await page.setViewportSize({ width, height: 900 });
    await open(page);
    await page.locator('#delivery').scrollIntoViewIfNeeded();
    expect(await noOverflow(page)).toBe(true);
    const box = await page.locator('footer.store-footer').boundingBox();
    expect(box.x + box.width).toBeLessThanOrEqual(width);
  });
}
