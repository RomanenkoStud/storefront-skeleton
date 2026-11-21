import { test, expect } from '@playwright/test';

const baseURL = `http://127.0.0.1:${process.env.E2E_PORT || 8788}`;
async function seed(request) {
  const stamp = Date.now(), headers = { Origin: baseURL };
  const supplier = await (await request.post('/api/admin/suppliers', { headers, data: { name: `Brand ${stamp}`, url: `https://mydrop.com.ua/br_${stamp}` } })).json();
  const items = [{ externalId: `br-${stamp}`, title: `Бренд тест ${stamp}`, description: 'Fixture', category: 'Куртки Lorem', costMinor: 175000, currency: 'UAH', photos: ['https://images.example.com/br-fixture.jpg'], variants: [{ id: 'a', size: 'S', stock: 3 }] }];
  expect((await request.post(`/api/admin/suppliers/${supplier.id}/import`, { headers, data: { items } })).ok()).toBe(true);
  const product = (await (await request.get('/api/admin/products')).json()).items.find(p => p.supplierId === supplier.id);
  expect((await request.patch(`/api/admin/products/${product.id}`, { headers, data: { published: true, markupType: 'percent', markupValue: 0 } })).ok()).toBe(true);
  return (await (await request.get('/api/products')).json()).items.find(p => p.id === product.id);
}
const markBox = locator => locator.evaluate(el => { const cs = getComputedStyle(el, '::before'); return { host: el.getBoundingClientRect().width, w: parseFloat(cs.width), h: parseFloat(cs.height), image: cs.backgroundImage }; });

// Fixtures only: products and the session are mocked; the dev-bypass admin is read-only here.
const signedOut = { authenticated: false };
const mock = async (page) => {
  await page.route('**/api/products', r => r.fulfill({ json: { items: [] } }));
  await page.route('**/api/account/session', r => r.fulfill({ json: signedOut }));
};
const logo = (page, scope) => page.locator(`${scope} .brand img`).first();

for (const width of [1440, 820, 390]) {
  test(`header B1 and sticky S1 keep their sizes and the header height at ${width}px`, async ({ page }) => {
    await page.setViewportSize({ width, height: 900 });
    await mock(page);
    await page.addInitScript(() => {
      window.__logoShift = 0;
      new PerformanceObserver(list => { for (const e of list.getEntries()) if (!e.hadRecentInput && e.sources?.some(s => s.node?.closest?.('.store-header, .store-bar'))) window.__logoShift += e.value; }).observe({ type: 'layout-shift', buffered: true });
    });
    await page.goto('/');
    const header = page.locator('header.store-header');
    const link = header.getByRole('link', { name: 'Lorem Store — головна' });
    await expect(link).toBeVisible();
    const img = logo(page, 'header.store-header');
    await expect(img).toHaveAttribute('src', '/brand/logo-b1-dark.svg');
    await expect.poll(() => img.evaluate(i => i.complete && i.naturalWidth > 0)).toBe(true);
    const box = await img.boundingBox();
    expect(box.width).toBeGreaterThanOrEqual(120);
    expect(box.height).toBeGreaterThanOrEqual(60);
    const before = (await header.boundingBox()).height;
    await page.waitForTimeout(300);
    expect((await header.boundingBox()).height).toBe(before);

    await page.evaluate(() => window.scrollTo(0, 1200));
    const bar = page.locator('.store-bar');
    await expect(bar).toHaveClass(/is-on/);
    const s1 = logo(page, '.store-bar');
    await expect(s1).toHaveAttribute('src', '/brand/logo-s1-dark.svg');
    const sbox = await s1.boundingBox();
    expect(sbox.width).toBeGreaterThanOrEqual(64);
    expect((await bar.boundingBox()).height).toBe(56);
    expect(sbox.height).toBeLessThanOrEqual(56);
    expect(await page.evaluate(() => window.__logoShift), 'header and bar layout shift since navigation').toBe(0);
  });
}

test('footer carries B1 at no less than 120px', async ({ page }) => {
  await mock(page);
  await page.goto('/');
  const footer = page.locator('[data-slot="footer-logo"] .brand img');
  await expect(footer).toHaveAttribute('src', '/brand/logo-b1-dark.svg');
  expect((await footer.evaluate(i => i.width))).toBeGreaterThanOrEqual(120);
});

test('admin sidebar uses the N1 mark on dark; the staff login uses B1 light', async ({ page }) => {
  await page.goto('/admin');
  await expect(page.locator('.sidebar .brand img')).toHaveAttribute('src', '/brand/mark-n1-dark.svg');
  await expect(page.locator('.sidebar').getByRole('link', { name: 'Lorem Store — головна' })).toBeVisible();
  await page.goto('/staff');
  await expect(page.locator('.login-card .brand img')).toHaveAttribute('src', '/brand/logo-b1-light.svg');
});

test('brand files and manifest are public, indexable and not private-cached', async ({ request }) => {
  for (const f of ['logo-b1-dark.svg', 'logo-b1-light.svg', 'logo-s1-dark.svg', 'mark-n1.svg', 'mark-n1-dark.svg', 'favicon.svg', 'favicon-32.png', 'favicon-16.png', 'apple-touch-icon.png', 'icon-192.png', 'icon-512.png', 'og.png', 'site.webmanifest']) {
    const res = await request.get(`/brand/${f}`);
    expect(res.status(), f).toBe(200);
    expect(res.headers()['content-type'] || '', f).toMatch(f.endsWith('.svg') ? /image\/svg\+xml/ : f.endsWith('.png') ? /image\/png/ : /(manifest\+json|application\/json)/);
    expect(res.headers()['x-robots-tag'] || '', f).not.toMatch(/noindex/);
    expect(res.headers()['cache-control'] || '', f).not.toMatch(/no-store/);
  }
  expect((await (await request.get('/brand/site.webmanifest')).json()).display).toBe('browser');
});

test('index.html links icons, manifest and og:image', async ({ page }) => {
  await page.goto('/');
  await expect(page.locator('link[rel="manifest"]')).toHaveAttribute('href', '/brand/site.webmanifest');
  await expect(page.locator('link[rel="icon"][type="image/svg+xml"]')).toHaveAttribute('href', '/brand/favicon.svg');
  await expect(page.locator('meta[property="og:image"]')).toHaveAttribute('content', 'https://example.com/brand/og.png');
  await expect(page).toHaveTitle('Lorem Store — Твій стиль. Твої правила.');
});

test('the Worker product page links icons, manifest and the product og:image', async ({ page, request }) => {
  const product = await seed(request);
  await page.route('https://images.example.com/**', route => route.abort());
  await page.goto(`/products/${product.slug}`);
  await expect(page.locator('link[rel="manifest"]')).toHaveAttribute('href', '/brand/site.webmanifest');
  await expect(page.locator('link[rel="apple-touch-icon"]')).toHaveAttribute('href', '/brand/apple-touch-icon.png');
  await expect(page.locator('link[rel="icon"][type="image/svg+xml"]')).toHaveAttribute('href', '/brand/favicon.svg');
  await expect(page.locator('meta[property="og:image"]')).toHaveAttribute('content', /^https?:\/\/.+br-fixture\.jpg/);
  await expect(page.locator('.brand img')).toHaveAttribute('src', '/brand/logo-b1-dark.svg');
});

for (const width of [1440, 390]) {
  test(`photo placeholder mark is min(40%,96px) in a storefront card at ${width}px`, async ({ page }) => {
    await page.setViewportSize({ width, height: 900 });
    const item = { id: 'np', slug: 'no-photo', title: 'Без фото', brand: 'Lorem', category: 'Одяг', priceMinor: 175000, photos: [], variants: [{ size: 'M', stock: 2 }] };
    await page.route('**/api/products', r => r.fulfill({ json: { items: [item] } }));
    await page.route('**/api/account/session', r => r.fulfill({ json: signedOut }));
    await page.goto('/');
    const ph = page.locator('.product-card .photo-placeholder').first();
    await ph.scrollIntoViewIfNeeded();
    await expect(ph).toHaveAttribute('role', 'img');
    await expect(ph.locator('img')).toHaveCount(0);
    const m = await markBox(ph);
    expect(m.image).toContain('/brand/mark-n1.svg');
    expect(m.w).toBeCloseTo(Math.min(m.host * 0.4, 96), 0);
    expect(m.w).toBeLessThanOrEqual(96);
    expect(m.h).toBeCloseTo(m.w, 0);
    await ph.hover();
    await page.waitForTimeout(500);
    expect((await markBox(ph)).w).toBeCloseTo(m.w, 0);
  });
}

test('photo placeholder in the 50x64 admin thumbnail swaps to the small cut', async ({ page, request }) => {
  await seed(request);
  await page.route('**/api/admin/products', async route => {
    const res = await route.fetch(), body = await res.json();
    await route.fulfill({ response: res, json: { ...body, items: body.items.map(p => ({ ...p, photos: [], cardPhoto: null })) } });
  });
  await page.goto('/admin');
  const ph = page.locator('.table-product .photo-placeholder').first();
  await expect(ph).toBeVisible();
  const m = await markBox(ph);
  expect(m.host).toBeLessThanOrEqual(120);
  expect(m.image).toContain('/brand/mark-n1-small.svg');
  expect(m.w).toBeLessThanOrEqual(40);
});
