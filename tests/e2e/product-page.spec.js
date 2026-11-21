import { test, expect } from '@playwright/test';

import { formatPrice } from '../../packages/catalog/price.js';

const baseURL = `http://127.0.0.1:${process.env.E2E_PORT || 8788}`;

async function seed(request) {
  const stamp = Date.now(), headers = { Origin: baseURL };
  const supplier = await (await request.post('/api/admin/suppliers', { headers, data: { name: `Product page ${stamp}`, url: `https://mydrop.com.ua/pp_${stamp}` } })).json();
  const title = `Пальто Page ${stamp}`;
  const variants = [{ id: 'a', size: 'S', stock: 3 }, { id: 'b', size: 'M', stock: 0 }, { id: 'c', size: 'L', stock: 2 }];
  expect((await request.post(`/api/admin/suppliers/${supplier.id}/import`, { headers, data: { items: [{ externalId: `pp-${stamp}`, title, description: 'Fixture', category: 'Куртки Lorem', costMinor: 175000, currency: 'UAH', photos: ['https://images.example.com/pp-fixture.jpg'], variants }] } })).ok()).toBe(true);
  const all = await (await request.get('/api/admin/products')).json();
  const product = all.items.find(p => p.supplierId === supplier.id);
  expect((await request.patch(`/api/admin/products/${product.id}`, { headers, data: { published: true, markupType: 'percent', markupValue: 0 } })).ok()).toBe(true);
  const pub = (await (await request.get('/api/products')).json()).items.find(p => p.id === product.id);
  return { slug: pub.slug, title, priceMinor: pub.priceMinor };
}

test('product page: size chips by keyboard, add to cart, no overflow at 390', async ({ page, request }) => {
  const product = await seed(request);
  await page.route('https://images.example.com/**', route => route.abort());
  await page.goto(`/products/${product.slug}`);
  await expect(page.locator('h1')).toHaveText(product.title);
  await expect(page.getByRole('link', { name: 'Lorem Store — головна' })).toBeVisible();
  await expect(page.locator('.brand img')).toHaveAttribute('src', '/brand/logo-b1-dark.svg');
  await expect(page.locator('.store-header .hdr-links a')).toHaveText(['Каталог', 'Доставка й обмін', 'Акаунт']);
  await expect(page.locator('.store-header .hdr-tools a')).toHaveCount(3);
  await expect(page.locator('a.cart-link svg')).toBeVisible();
  await expect(page.locator('ul.sizes, h2')).toHaveCount(0);
  // toHaveText normalises NBSP, so read the raw text: it must be the shared formatPrice output.
  expect(await page.locator('.price').textContent()).toBe(formatPrice(product.priceMinor));
  expect(formatPrice(product.priceMinor)).toMatch(/\u00a0грн$/);
  await expect(page.locator('.size-chip.is-out')).toHaveText(/M/);
  const radios = page.getByRole('radio');
  await expect(radios).toHaveCount(2);

  // Required: submitting without a size is blocked by the browser.
  await page.getByRole('button', { name: 'Додати до кошика' }).click();
  await expect(page).toHaveURL(new RegExp(`/products/${product.slug}$`));

  // Keyboard: Shift+Tab from the button lands on the chip group (visible focus ring); arrows select a chip.
  await page.getByRole('button', { name: 'Додати до кошика' }).focus();
  await page.keyboard.press('Shift+Tab');
  await expect(page.locator('.size-chip:has(input:focus-visible)')).toHaveCount(1);
  await page.keyboard.press('ArrowRight');
  const checked = page.locator('.size-chip:has(input:checked)');
  await expect(checked).toHaveCount(1);
  await expect(checked).toHaveText(/^(S|L)$/);
  await expect(checked).toHaveCSS('background-color', 'rgb(36, 45, 36)');

  await page.getByRole('button', { name: 'Додати до кошика' }).click();
  await page.waitForURL(/\/cart/);
  await expect(page.getByText(product.title).first()).toBeVisible();

  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(`/products/${product.slug}`);
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  expect(overflow).toBeLessThanOrEqual(0);
});

test('product page header: icon tools only on desktop/tablet, text account row on phone, sane height', async ({ page, request }) => {
  const product = await seed(request);
  await page.route('https://images.example.com/**', route => route.abort());
  for (const width of [1440, 820, 390]) {
    await page.setViewportSize({ width, height: 900 });
    await page.goto(`/products/${product.slug}`);
    const header = page.locator('header.store-header');
    const visible = await header.locator('a:visible').evaluateAll(els => els.map(e => e.getAttribute('aria-label') || e.textContent.trim()));
    if (width > 650) expect(visible).toEqual(['Lorem Store — головна', 'Каталог', 'Доставка й обмін', 'Пошук', 'Акаунт', 'Кошик']);
    else expect(visible).toEqual(['Lorem Store — головна', 'Каталог', 'Доставка й обмін', 'Акаунт', 'Пошук', 'Кошик']);
    if (width > 650) await expect(header.locator('.hdr-links-account')).toBeHidden();
    else await expect(header.locator('.hdr-tools .account-link')).toBeHidden();
    const h = (await header.boundingBox()).height;
    console.log('header height', width, h);
    if (width === 390) expect(h).toBeLessThanOrEqual(140);
  }
});
