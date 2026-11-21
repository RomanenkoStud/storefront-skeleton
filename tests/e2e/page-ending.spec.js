import { test, expect } from '@playwright/test';

const TOTAL = 55; // 24 + 24 + 7

async function seed(request, baseURL, stamp) {
  const headers = { Origin: baseURL };
  const supplier = await (await request.post('/api/admin/suppliers', { headers, data: { name: `Page ending ${stamp}`, url: `https://mydrop.com.ua/page_ending_${stamp}` } })).json();
  const items = Array.from({ length: TOTAL }, (_, i) => ({ externalId: `${stamp}-${i}`, title: `Ending ${stamp} ${String(i).padStart(2, '0')}`, description: 'Page ending fixture', category: 'Lorem', costMinor: 100000 + i * 100, currency: 'UAH', photos: ['https://images.example.com/ending-fixture.jpg'], variants: [{ id: 'v', size: 'M', stock: 2 }] }));
  expect((await request.post(`/api/admin/suppliers/${supplier.id}/import`, { headers, data: { items } })).ok()).toBe(true);
  const all = await (await request.get('/api/admin/products')).json();
  for (const product of all.items.filter(p => p.supplierId === supplier.id)) expect((await request.patch(`/api/admin/products/${product.id}`, { headers, data: { published: true } })).ok()).toBe(true);
}

test('catalog shows 24 cards, loads more in steps, restores on refresh and back, and ends on the editorial band', async ({ page, request, baseURL }) => {
  const stamp = Date.now();
  await seed(request, baseURL, stamp);
  await page.route('https://images.example.com/**', route => route.abort());
  await page.goto(`/?q=${stamp}&sort=title#catalog`);
  const cards = page.locator('.product-card');
  const count = page.locator('.catalog-more-count');
  const more = page.getByRole('button', { name: /^Показати ще/ });
  await expect(cards).toHaveCount(24);
  await expect(count).toHaveText(`Показано 24 з ${TOTAL}`);
  await expect(more).toHaveText('Показати ще 24');
  await expect(page).not.toHaveURL(/shown=/);

  await more.click();
  await expect(cards).toHaveCount(48);
  await expect(count).toHaveText(`Показано 48 з ${TOTAL}`);
  await expect(more).toHaveText('Показати ще 7');
  await expect(page).toHaveURL(/shown=48/);
  // keyboard users land on the first new card, and the page does not jump
  await expect(cards.nth(24).locator('a.product-info')).toBeFocused();

  await page.reload();
  await expect(cards).toHaveCount(48);
  await expect(count).toHaveText(`Показано 48 з ${TOTAL}`);

  // changing sort resets to the first page; Back returns to the 48-card view
  await page.getByLabel('Сортування товарів').selectOption('price-asc');
  await expect(cards).toHaveCount(24);
  await expect(page).not.toHaveURL(/shown=/);
  await page.goBack();
  await expect(cards).toHaveCount(48);
  await expect(page.getByLabel('Сортування товарів')).toHaveValue('title');

  await more.click();
  await expect(cards).toHaveCount(TOTAL);
  await expect(count).toHaveText(`Показано ${TOTAL} з ${TOTAL}`);
  await expect(more).toHaveCount(0);

  // a narrowing search below one page hides the ending block entirely
  await page.getByLabel('Пошук товарів').fill(`${stamp} 00`);
  await expect(cards).toHaveCount(1);
  await expect(page.locator('.catalog-more')).toHaveCount(0);
});

test('invalid shown values fall back to the first page and the editorial link works with a hash on load', async ({ page, request, baseURL }) => {
  const stamp = Date.now();
  await seed(request, baseURL, stamp);
  await page.route('https://images.example.com/**', route => route.abort());
  await page.goto(`/?q=${stamp}&shown=banana`);
  await expect(page.locator('.product-card')).toHaveCount(24);
  await page.goto(`/?q=${stamp}&shown=9999999`);
  await expect(page.locator('.product-card')).toHaveCount(55);
  await expect(page.locator('.catalog-more')).toContainText('Показано 55 з 55');

  await page.goto(`/?q=${stamp}#editorial`);
  await expect(page.locator('.product-card')).toHaveCount(24);
  await expect.poll(() => page.locator('#editorial').evaluate(el => el.getBoundingClientRect().top)).toBeGreaterThan(-5);
  // aligned to the viewport top, or as high as the end of the page allows
  await expect.poll(() => page.locator('#editorial').evaluate(el => el.getBoundingClientRect().top)).toBeLessThan(200);
  await page.goto(`/?q=${stamp}`);
  await expect(page.locator('.product-card')).toHaveCount(24);
  await page.locator('header').getByRole('link', { name: 'Доставка й обмін', exact: true }).first().click();
  await expect(page).toHaveURL(/#delivery$/);
  await expect(page.locator('#delivery')).toBeInViewport();
});

test('a malformed fragment does not break the storefront and an oversized shown is trimmed', async ({ page, request, baseURL }) => {
  const stamp = Date.now();
  await seed(request, baseURL, stamp);
  await page.route('https://images.example.com/**', route => route.abort());
  const errors = [];
  page.on('pageerror', e => errors.push(e.message));
  for (const hash of ['#%', '#%zz']) {
    await page.goto(`/?q=${stamp}${hash}`);
    await expect(page.locator('.storefront')).toBeVisible();
    await expect(page.locator('.product-card')).toHaveCount(24);
  }
  expect(errors).toEqual([]);
  await page.goto(`/?q=${stamp}&shown=2400`);
  await expect(page.locator('.product-card')).toHaveCount(55);
  await expect(page).toHaveURL(/shown=72(&|$)/);
});

test('a failed product request keeps the restorable shown count in the URL', async ({ page }) => {
  await page.route('**/api/products', route => route.fulfill({ status: 500, contentType: 'application/json', body: '{"error":"boom"}' }));
  await page.goto('/?shown=72');
  await expect(page.locator('.storefront')).toBeVisible();
  await expect(page.locator('.product-card')).toHaveCount(0);
  await page.waitForTimeout(500);
  await expect(page).toHaveURL(/shown=72(&|$)/);
});

test('the editorial hash stays aligned while slow images settle the layout above it', async ({ page, request, baseURL }) => {
  const stamp = Date.now();
  await seed(request, baseURL, stamp);
  await page.route('https://images.example.com/**', route => route.abort());
  await page.route(/\/(editorial|media)\//, async route => { await new Promise(r => setTimeout(r, 700)); await route.continue(); });
  await page.goto(`/?q=${stamp}#editorial`);
  await expect(page.locator('.product-card')).toHaveCount(24);
  await expect.poll(() => page.locator('#editorial').evaluate(el => el.getBoundingClientRect().top), { timeout: 3000 }).toBeGreaterThan(-5);
  await page.waitForTimeout(1800);
  const top = await page.locator('#editorial').evaluate(el => el.getBoundingClientRect().top);
  expect(top).toBeGreaterThan(-5);
  expect(top).toBeLessThan(200);
});
