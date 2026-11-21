import { test, expect } from '@playwright/test';

// Fixtures only: products and the session are mocked, the cart lives in this page's localStorage.
const photo = 'https://images.example.com/photo-1?w=10';
const items = [
  { id: 'cm1', slug: 'one-size', title: 'Кепка', brand: 'Lorem', category: 'Одяг', priceMinor: 175000, photos: [photo], variants: [{ size: 'M', stock: 20 }] },
  { id: 'cm2', slug: 'capped', title: 'Футболка', brand: 'Lorem', category: 'Одяг', priceMinor: 175000, photos: [photo], variants: [{ size: 'M', stock: 20 }] },
];
const cappedLine = { productId: 'cm2', slug: 'capped', size: 'M', quantity: 10, title: 'Футболка', priceMinor: 175000, photo: null };
const mock = async (page, seed) => {
  await page.route('**/api/products', r => r.fulfill({ json: { items } }));
  await page.route('https://images.example.com/**', r => r.abort());
  await page.route('**/api/account/session', r => r.fulfill({ json: { authenticated: false } }));
  await page.addInitScript(() => {
    window.__popped = 0;
    const isPop = n => n.nodeType === 1 && n.classList.contains('cart-count') && n.classList.contains('pop');
    new MutationObserver(ms => { for (const m of ms) { if (m.type === 'attributes' ? isPop(m.target) : [...m.addedNodes].some(isPop)) window.__popped++; } }).observe(document, { childList: true, subtree: true, attributes: true, attributeFilter: ['class'] });
  });
  if (seed) await page.addInitScript(([k, v]) => { if (!localStorage.getItem(k)) localStorage.setItem(k, v); }, ['ls_cart_v1', JSON.stringify({ version: 1, lines: seed, recent: [] })]);
};
const headerBag = page => page.locator('header.store-header .cart-link');
const addButton = (page, title) => page.getByRole('button', { name: `Додати в кошик: ${title}` });
const boxes = page => page.evaluate(() => ['header.store-header', 'header.store-header .cart-link', 'header.store-header .cart-link svg'].map(s => { const r = document.querySelector(s).getBoundingClientRect(); return [r.x, r.y, r.width, r.height]; }));
const trackShift = page => page.evaluate(() => { window.__cls = 0; new PerformanceObserver(l => { for (const e of l.getEntries()) if (!e.hadRecentInput) window.__cls += e.value; }).observe({ type: 'layout-shift', buffered: false }); });

for (const [width, height] of [[1440, 900], [390, 800]]) {
  test(`quick add plays the moment under the bag without layout shift at ${width}px`, async ({ page }, info) => {
    await page.setViewportSize({ width, height });
    await mock(page);
    await page.goto('/');
    const bag = headerBag(page);
    await expect(bag).toBeVisible();
    await expect(bag.locator('.cart-moment')).toHaveCount(0);
    const card = addButton(page, 'Кепка');
    await card.scrollIntoViewIfNeeded();
    await page.evaluate(() => window.scrollTo(0, 0)); // keep the header in frame for the frame sequence
    await trackShift(page);
    const before = await boxes(page);
    await card.evaluate(el => el.click());
    const moment = bag.locator('.cart-moment');
    await expect(moment).toHaveCount(1);
    await expect(moment).toHaveAttribute('aria-hidden', 'true');
    await expect.poll(() => page.evaluate(() => window.__popped)).toBeGreaterThan(0);
    await expect(bag.locator('.cart-count')).toHaveText('1');
    const anim = await moment.locator('i').evaluate(el => ({ names: getComputedStyle(el).animationName, bg: getComputedStyle(el).backgroundColor, w: el.offsetWidth, h: el.offsetHeight }));
    expect(anim.names).toContain('cm-rule');
    expect(anim.bg).toBe('rgb(215, 241, 108)');
    expect([anim.w, anim.h]).toEqual([24, 2]);
    await page.screenshot({ path: `.claude/tmp/shots/moment-${width}-early.png`, clip: { x: Math.max(0, width - 200), y: 0, width: Math.min(200, width), height: 170 } });
    await page.waitForTimeout(500);
    await page.screenshot({ path: `.claude/tmp/shots/moment-${width}-held.png`, clip: { x: Math.max(0, width - 200), y: 0, width: Math.min(200, width), height: 170 } });
    // the tick draws on the button
    await expect(card.locator('svg.tick.draw path')).toHaveAttribute('pathLength', '1');
    expect(await boxes(page)).toEqual(before);
    // the moment is gone from view by 2.4 s
    await expect.poll(() => moment.locator('i').evaluate(el => getComputedStyle(el).opacity), { timeout: 4000 }).toBe('0');
    expect(await page.evaluate(() => window.__cls)).toBe(0);
    // no extra live region: the only status text is the card's own
    await expect(bag.locator('[role=status], [aria-live]')).toHaveCount(0);
  });
}

test('reduced motion shows the line and the tick without movement or drawing', async ({ page }) => {
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await mock(page);
  await page.goto('/');
  const bag = headerBag(page);
  await addButton(page, 'Кепка').evaluate(el => el.click());
  const rule = bag.locator('.cart-moment i');
  await expect(rule).toHaveCount(1);
  const s = await rule.evaluate(el => { const c = getComputedStyle(el); return { name: c.animationName, transform: c.transform, opacity: c.opacity }; });
  expect(s.name).toBe('cm-fade-step');
  expect(s.transform).toBe('none');
  expect(s.opacity).toBe('1');
  expect(await bag.locator('.cart-moment b').evaluate(el => getComputedStyle(el).display)).toBe('none');
  expect(await bag.locator('.cart-count').evaluate(el => getComputedStyle(el).animationName)).toBe('none');
  const tick = await addButton(page, 'Кепка').locator('svg.tick path').evaluate(el => { const c = getComputedStyle(el); return { name: c.animationName, off: c.strokeDashoffset }; });
  expect(tick).toEqual({ name: 'none', off: '0px' });
});

test('a capped add plays nothing and shows the cap message', async ({ page }) => {
  await mock(page, [cappedLine]);
  await page.goto('/');
  const bag = headerBag(page);
  await expect(bag).toHaveAttribute('aria-label', /10/);
  const button = addButton(page, 'Футболка');
  await button.evaluate(el => el.click());
  await expect(page.getByRole('status').filter({ hasText: 'Додано до максимуму' })).toHaveCount(1);
  await expect(page.locator('.quick-add-note').filter({ hasText: 'максимуму' })).toBeVisible();
  await expect(bag.locator('.cart-moment')).toHaveCount(0);
  await expect(bag.locator('.cart-count.pop')).toHaveCount(0);
  await expect(button.locator('svg.tick.draw')).toHaveCount(0);
});

test('removing a line and another-tab sync play nothing', async ({ page, context }) => {
  await mock(page, [cappedLine]);
  await page.goto('/cart');
  const bag = headerBag(page);
  await expect(bag).toBeVisible();
  const other = await context.newPage();
  await other.goto('/cart');
  await other.evaluate(() => localStorage.setItem('ls_cart_v1', JSON.stringify({ version: 1, lines: [{ productId: 'cm2', slug: 'capped', size: 'M', quantity: 3, title: 'Футболка', priceMinor: 175000, photo: null }], recent: [] })));
  await expect(bag).toHaveAttribute('aria-label', /3/);
  await expect(bag.locator('.cart-moment')).toHaveCount(0);
  await other.close();
});

test('repeat adds leave exactly one badge per bag, and an emptied cart from another tab leaves none', async ({ page, context }) => {
  await mock(page);
  await page.goto('/');
  const bags = page.locator('a.cart-link');
  const button = addButton(page, 'Кепка');
  await button.evaluate(el => el.click());
  await expect(headerBag(page).locator('.cart-count')).toHaveText('1');
  await button.evaluate(el => el.click());
  await expect(headerBag(page).locator('.cart-count')).toHaveText('2');
  for (const bag of await bags.all()) { await expect(bag.locator('.cart-count')).toHaveCount(1); await expect(bag.locator('.cart-count')).toHaveText('2'); }
  const other = await context.newPage();
  await other.goto('/cart');
  await other.evaluate(() => localStorage.setItem('ls_cart_v1', JSON.stringify({ version: 1, lines: [], recent: [] })));
  await expect(headerBag(page)).toHaveAttribute('aria-label', /^Кошик$/);
  for (const bag of await bags.all()) await expect(bag.locator('.cart-count')).toHaveCount(0);
  await other.close();
});

test('Worker product page add (/cart?add=) plays the moment once on the cart header', async ({ page }) => {
  await mock(page);
  await page.addInitScript(() => {
    window.__momentInserts = 0;
    new MutationObserver(ms => { for (const m of ms) for (const n of m.addedNodes) if (n.nodeType === 1 && (n.matches?.('.cart-moment') || n.querySelector?.('.cart-moment'))) window.__momentInserts++; }).observe(document, { childList: true, subtree: true });
  });
  await page.route('**/api/products/one-size', r => r.fulfill({ json: items[0] }));
  await page.goto('/cart?add=one-size&size=M');
  await expect(headerBag(page).locator('.cart-moment')).toHaveCount(1);
  await expect(headerBag(page)).toHaveAttribute('aria-label', /1/);
  await page.waitForTimeout(500);
  expect(await page.evaluate(() => window.__momentInserts)).toBe(1);
});
