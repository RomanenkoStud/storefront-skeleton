import { test, expect } from '@playwright/test';

// Rack readout: hover and keyboard focus drive the same caption; leaving returns the idle hint.
const top = page => page.locator('.rail-chip.is-top');
const bottom = page => page.locator('.rail-chip.is-bottom');
const mock = page => page.route('**/api/products', route => route.fulfill({ json: { items: [] } }));

test.describe('rack readout (desktop)', () => {
  test.use({ viewport: { width: 1440, height: 900 } });

  test('hover on clothes and shoes shows the category, leaving restores the hint', async ({ page }) => {
    await mock(page); await page.goto('/');
    const rail = page.locator('.rail-track');
    await rail.scrollIntoViewIfNeeded();
    await expect(top(page).locator('.idle')).toBeVisible();
    const idleTop = await top(page).innerText();
    const link = page.locator('.rail-card-link').nth(2), name = (await link.getAttribute('aria-label')).replace('Категорія: ', '');
    const box = await link.boundingBox();
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    await expect(top(page).locator('b')).toHaveText(new RegExp(`^${name}$`, 'i'));
    await expect(top(page)).toContainText('ДИВИТИСЬ');
    await page.mouse.move(5, 5);
    await expect(top(page).locator('.idle')).toBeVisible();
    expect(await top(page).innerText()).toBe(idleTop);

    const shoe = page.locator('.rail-shoe a').first(), sname = (await shoe.getAttribute('aria-label')).replace('Категорія: ', '');
    await shoe.hover();
    await expect(bottom(page).locator('b')).toHaveText(new RegExp(sname, 'i'));
    await page.mouse.move(5, 5);
    await expect(bottom(page).locator('.idle')).toBeVisible();
  });

  test('keyboard focus updates the readout like hover and blur restores it; focus is not stolen', async ({ page }) => {
    await mock(page); await page.goto('/');
    const link = page.locator('.rail-card-link').first(), name = (await link.getAttribute('aria-label')).replace('Категорія: ', '');
    await link.focus();
    await expect(top(page).locator('b')).toHaveText(new RegExp(`^${name}$`, 'i'));
    await expect(link).toBeFocused();
    await page.keyboard.press('Tab');
    const next = page.locator('.rail-card-link').nth(1), n2 = (await next.getAttribute('aria-label')).replace('Категорія: ', '');
    await expect(next).toBeFocused();
    await expect(top(page).locator('b')).toHaveText(new RegExp(`^${n2}$`, 'i'));
    const shoe = page.locator('.rail-shoe a').first(), sname = (await shoe.getAttribute('aria-label')).replace('Категорія: ', '');
    await shoe.focus();
    await expect(bottom(page).locator('b')).toHaveText(new RegExp(`^${sname}$`, 'i'));
    await shoe.blur();
    await expect(bottom(page).locator('.idle')).toBeVisible();
    await page.locator('.rail-card-link').first().focus();
    await page.locator('.rail-card-link').first().blur();
    await expect(top(page).locator('.idle')).toBeVisible();
  });
});

test('901px: every readout name stays inside the left column, left of the rack', async ({ page }) => {
  await page.setViewportSize({ width: 901, height: 900 });
  await mock(page); await page.goto('/');
  await page.locator('.rail-track').scrollIntoViewIfNeeded();
  const rack = await page.locator('.rail-rack-img').boundingBox();
  for (const [sel, chip] of [['.rail-card-link', top(page)], ['.rail-shoe a', bottom(page)]]) {
    const links = page.locator(sel);
    for (let i = 0; i < await links.count(); i++) {
      await links.nth(i).focus();
      const b = chip.locator('b'); await expect(b).toBeVisible();
      const r = await b.evaluate(el => { const g = document.createRange(); g.selectNodeContents(el); return Math.max(...[...g.getClientRects()].map(x => x.right)); });
      const c = await chip.boundingBox();
      expect(r).toBeLessThanOrEqual(c.x + c.width + 0.5);
      expect(r).toBeLessThanOrEqual(rack.x);
    }
  }
});

for (const width of [820, 390]) {
  test(`no horizontal overflow at ${width}`, async ({ page }) => {
    await page.setViewportSize({ width, height: 900 });
    await mock(page); await page.goto('/');
    await page.locator('.rail-block').scrollIntoViewIfNeeded();
    await expect(page.locator('.rail-chip.is-top')).toBeVisible();
    const over = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
    expect(over).toBeLessThanOrEqual(0);
  });
}
