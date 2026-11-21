import { test, expect } from '@playwright/test';

// Fixtures only: products and the session are mocked, nothing real is touched.
const photo = 'https://images.example.com/photo-1?w=10';
const items = Array.from({ length: 6 }, (_, i) => ({ id: `h${i}`, slug: `item-${i}`, title: `Футболка ${i}`, brand: 'Lorem', category: 'Одяг', priceMinor: 175000, photos: [photo], variants: [{ size: 'M', stock: 3 }] }));
const signedOut = { authenticated: false };
const mock = async (page, session = signedOut) => {
  await page.route('**/api/products', r => r.fulfill({ json: { items } }));
  await page.route('https://images.example.com/**', r => r.abort());
  await page.route('**/api/account/session', r => r.fulfill({ json: session }));
};
const noOverflow = page => page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth);
const bar = page => page.locator('.store-bar');

for (const width of [1440, 820]) {
  test(`header order at ${width}px: logo, links, then search, account, bag`, async ({ page }) => {
    await page.setViewportSize({ width, height: 900 });
    await mock(page);
    await page.goto('/');
    const header = page.locator('header.store-header');
    const x = async l => (await l.boundingBox()).x;
    const logo = header.getByRole('link', { name: /Lorem Store/ }), catalog = header.getByRole('link', { name: 'Каталог' }), rhythm = header.getByRole('link', { name: 'Доставка й обмін' });
    const search = header.getByRole('link', { name: 'Пошук' }), account = header.getByRole('link', { name: 'Увійти' }), bag = header.getByRole('link', { name: /Кошик/ });
    const xs = [];
    for (const l of [logo, catalog, rhythm, search, account, bag]) { await expect(l).toBeVisible(); xs.push(await x(l)); }
    expect(xs).toEqual([...xs].sort((a, b) => a - b));
    await expect(account).toHaveAttribute('href', '/account');
    expect((await account.boundingBox()).width).toBeLessThanOrEqual(48);
    await expect(account.locator('svg')).toHaveAttribute('stroke-width', '1.6');
    await expect(header.locator('.hdr-menu-btn')).toBeHidden();
    expect(await noOverflow(page)).toBe(true);
  });
}

test('signed-in account icon keeps a state name', async ({ page }) => {
  await mock(page, { authenticated: true, customer: { id: 'c1', displayName: null, signInEmail: 'a@b.c', providers: ['google'], createdAt: '2026-01-01' } });
  await page.goto('/');
  await expect(page.locator('header.store-header').getByRole('link', { name: /Кабінет/ })).toHaveAttribute('href', '/account');
});

test('phone header: menu, logo, search, bag; keyboard menu with Esc and focus return', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 800 });
  await mock(page);
  await page.goto('/');
  const header = page.locator('header.store-header');
  const button = header.getByRole('button', { name: 'Меню' });
  await expect(button).toHaveAttribute('aria-expanded', 'false');
  const controls = await button.getAttribute('aria-controls');
  const xs = [];
  for (const l of [button, header.getByRole('link', { name: /Lorem Store/ }), header.getByRole('link', { name: 'Пошук' }), header.getByRole('link', { name: /Кошик/ })]) { await expect(l).toBeVisible(); xs.push((await l.boundingBox()).x); }
  expect(xs).toEqual([...xs].sort((a, b) => a - b));
  await expect(header.getByRole('link', { name: 'Каталог' })).toBeHidden();
  expect(await noOverflow(page)).toBe(true);

  await button.focus();
  await page.keyboard.press('Enter');
  await expect(button).toHaveAttribute('aria-expanded', 'true');
  const menu = page.locator(`#${controls}`);
  await expect(menu).toBeVisible();
  await expect(menu.getByRole('link', { name: 'Каталог' })).toBeFocused();
  await page.keyboard.press('Tab');
  await expect(menu.getByRole('link', { name: 'Доставка й обмін' })).toBeFocused();
  await expect(menu.getByRole('link', { name: 'Доставка й обмін' })).toHaveAttribute('href', '/#delivery');
  await page.keyboard.press('Tab');
  await expect(menu.getByRole('link', { name: 'Увійти' })).toHaveAttribute('href', '/account');
  await page.keyboard.press('Escape');
  await expect(button).toHaveAttribute('aria-expanded', 'false');
  await expect(menu).toBeHidden();
  await expect(button).toBeFocused();
  // Tabbing past the menu leaves it usable: focus is never trapped.
  await page.keyboard.press('Enter');
  await page.keyboard.press('Shift+Tab');
  await expect(button).toBeFocused();
  await page.keyboard.press('Shift+Tab');
  await expect(button).not.toBeFocused();
});

test('search icon focuses the catalog search on home and from other pages', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await mock(page);
  await page.goto('/');
  await page.locator('header.store-header').getByRole('link', { name: 'Пошук' }).click();
  await expect(page.locator('#catalog-search')).toBeFocused();
  await expect(page.locator('#catalog-search')).toBeInViewport();
  await page.goto('/cart');
  const link = page.locator('header.store-header').getByRole('link', { name: 'Пошук' });
  await expect(link).toHaveAttribute('href', '/#catalog-search');
  await link.click();
  await expect(page).toHaveURL(/\/#catalog-search$/);
  await expect(page.locator('#catalog-search')).toBeFocused();
});

for (const [width, tools] of [[1440, 3], [390, 2]]) {
  test(`condensed bar pins after the hero at ${width}px without layout shift`, async ({ page }) => {
    await page.setViewportSize({ width, height: 800 });
    await mock(page);
    await page.goto('/');
    await expect(bar(page)).toBeHidden();
    await page.locator('#catalog').scrollIntoViewIfNeeded();
    await page.evaluate(() => window.scrollTo(0, document.querySelector('#catalog').offsetTop));
    await expect(bar(page)).toBeVisible();
    await expect.poll(async () => (await bar(page).boundingBox()).y).toBe(0);
    expect((await bar(page).boundingBox()).height).toBe(56);
    await expect(bar(page).locator('.hdr-tool:visible')).toHaveCount(tools);
    // The bar is an overlay: removing it must not move anything in the page.
    const metrics = () => page.evaluate(() => ({ h: document.documentElement.scrollHeight, y: document.querySelector('.hero').getBoundingClientRect().top + scrollY }));
    const withBar = await metrics();
    await page.addStyleTag({ content: '.store-bar{display:none!important}' });
    expect(await metrics()).toEqual(withBar);
    await page.addStyleTag({ content: '.store-bar{display:flex!important}' });
    expect(await noOverflow(page)).toBe(true);
    if (width === 390) {
      await bar(page).getByRole('button', { name: 'Меню' }).click();
      await expect(page.locator('#site-menu-bar')).toBeVisible();
      await page.keyboard.press('Escape');
      await expect(bar(page).getByRole('button', { name: 'Меню' })).toBeFocused();
    }
    await bar(page).getByRole('link', { name: 'Пошук' }).click();
    await expect(page.locator('#catalog-search')).toBeFocused();
    await page.evaluate(() => window.scrollTo(0, 0));
    await expect(bar(page)).toBeHidden();
  });
}

test('the bar is not used on the cart and account pages, which show the full header', async ({ page }) => {
  await mock(page);
  for (const path of ['/cart', '/account']) {
    await page.goto(path);
    await expect(page.locator('header.store-header')).toBeVisible();
    await expect(page.locator('.store-bar')).toHaveCount(0);
  }
});

for (const width of [1440, 820, 390]) {
  test(`cart and account headers fit ${width}px`, async ({ page }) => {
    await page.setViewportSize({ width, height: 800 });
    await mock(page);
    for (const path of ['/cart', '/account']) { await page.goto(path); await expect(page.locator('header.store-header')).toBeVisible(); expect(await noOverflow(page)).toBe(true); }
  });
}
