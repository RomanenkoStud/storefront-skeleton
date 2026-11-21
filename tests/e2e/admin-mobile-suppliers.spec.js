import { test, expect } from '@playwright/test';
import { mockAdmin, freezeBrowser, suppliersFixture, syncRunsFixture } from './helpers/admin-mock.js';

// Suppliers and sync history on phone and tablet. The API is fully mocked (helpers/admin-mock.js); nothing here
// touches real inventory, suppliers or publication.
const PHONES = [{ name: '375x812', width: 375, height: 812 }, { name: '360x740', width: 360, height: 740 }];
const metrics = page => page.evaluate(() => ({ sw: document.documentElement.scrollWidth, iw: window.innerWidth }));
const box = async locator => { const b = await locator.boundingBox(); expect(b, 'visible').not.toBeNull(); return b; };
const fontSize = locator => locator.evaluate(el => parseFloat(getComputedStyle(el).fontSize));
const expectHeight44 = async (locator, what) => {
  const n = await locator.count(); expect(n, `${what} count`).toBeGreaterThan(0);
  for (let i = 0; i < n; i += 1) expect((await box(locator.nth(i))).height, `${what} ${i}`).toBeGreaterThanOrEqual(43.9);
};
const noScroll = async (page, what) => {
  const m = await metrics(page); expect(m.sw, `${what} page`).toBeLessThanOrEqual(m.iw);
  const t = await page.locator('.table-scroll').evaluateAll(els => els.map(el => el.scrollWidth - el.clientWidth));
  for (const d of t) expect(d, `${what} table-scroll`).toBeLessThanOrEqual(0);
};
const calls = (state, method, path) => state.calls.filter(c => c.method === method && c.path === path);

async function openSuppliers(page, opts = {}) {
  await freezeBrowser(page);
  const state = await mockAdmin(page, opts);
  await page.goto('/admin/suppliers');
  await expect(page.locator('.supplier-card').first()).toBeVisible();
  return state;
}
const card = (page, name) => page.locator('.supplier-card', { has: page.getByRole('heading', { name, exact: true }) });
const longSupplier = () => [{ ...suppliersFixture()[0], name: 'Дуже довга назва постачальника для перевірки переносу рядків у картці', url: 'https://mydrop.com.ua/demo_shop_with_a_really_long_public_page_name_for_overflow_checks' }, ...suppliersFixture().slice(1)];

for (const viewport of PHONES) {
  test.describe(`phone suppliers ${viewport.name}`, () => {
    test.use({ viewport: { width: viewport.width, height: viewport.height } });

    test('supplier card keeps field order, actions are a 44px grid with delete last', async ({ page }) => {
      await openSuppliers(page, { suppliers: longSupplier() });
      const c = page.locator('.supplier-card').first();
      const y = async sel => (await box(c.locator(sel).first())).y;
      const order = [await y('h3'), await y('.provider-badge'), await y('.status'), await y('.supplier-info > a'), await y('.supplier-info > small'), await y('.supplier-counts'), await y('.connection-form'), await y('.supplier-actions')];
      for (let i = 1; i < order.length; i += 1) expect(order[i], `field ${i} after field ${i - 1}`).toBeGreaterThanOrEqual(order[i - 1] - 2); // badge and chip share a row (sub-pixel baseline offset)
      await expect(c.locator('.supplier-counts')).toHaveText('Товарів: 4 · опубліковано: 2');
      const labels = await c.locator('.supplier-actions > button').allInnerTexts();
      const visual = await c.locator('.supplier-actions > button').evaluateAll(els => els.map(el => ({ t: el.textContent.trim(), y: el.getBoundingClientRect().y, x: el.getBoundingClientRect().x })).sort((a, b) => a.y - b.y || a.x - b.x).map(e => e.t));
      expect(visual.map(t => t.replace(/\s+/g, ' ')).slice(0, 4)).toEqual(['Синхронізувати', 'Імпорт JSON', 'Перейменувати', 'Вимкнути']);
      expect(visual.at(-1)).toBe('Видалити постачальника');
      expect(labels.length).toBe(5);
      await expectHeight44(c.locator('.supplier-actions > button'), 'action');
      const del = await box(c.getByRole('button', { name: /Видалити постачальника/ })), sync = await box(c.getByRole('button', { name: 'Синхронізувати' }));
      expect(del.y).toBeGreaterThan(sync.y + sync.height);
      expect(del.width).toBeGreaterThan(sync.width * 1.5);
      await expectHeight44(c.locator('.supplier-info > a'), 'source link');
      await noScroll(page, 'suppliers');
    });

    test('inline forms are single column with 1rem inputs and full-width 44px buttons, request payloads unchanged', async ({ page }) => {
      const state = await openSuppliers(page);
      const md = card(page, 'Lorem Supply');
      await md.getByRole('button', { name: 'Перейменувати' }).click();
      const rename = md.locator('.supplier-rename-form');
      const input = rename.getByLabel('Нова назва Lorem Supply'), save = rename.getByRole('button', { name: 'Зберегти назву' });
      expect(await fontSize(input)).toBeGreaterThanOrEqual(16);
      const ib = await box(input), sb = await box(save);
      expect(sb.y).toBeGreaterThan(ib.y + ib.height - 1);
      expect(sb.width).toBeGreaterThanOrEqual(ib.width - 1);
      await expectHeight44(rename.locator('button'), 'rename form button');
      await input.fill('Lorem Supply нова');
      await save.click();
      await expect.poll(() => calls(state, 'PATCH', '/suppliers/s-md').length).toBe(1);
      expect(calls(state, 'PATCH', '/suppliers/s-md')[0].body).toEqual({ name: 'Lorem Supply нова' });

      const conn = card(page, 'Lorem Supply').getByLabel(/ID підключення · /);
      await expect(conn).toHaveAttribute('inputmode', 'numeric');
      expect(await fontSize(conn)).toBeGreaterThanOrEqual(16);
      await expectHeight44(card(page, 'Lorem Supply').locator('.connection-form button'), 'connection button');
      const feed = card(page, 'Easy Feed').locator('input[name="feedUrl"]');
      await expect(feed).toHaveAttribute('type', 'text');
      expect(await fontSize(feed)).toBeGreaterThanOrEqual(16);
      await noScroll(page, 'forms');
    });

    test('sync button still posts the same request', async ({ page }) => {
      const state = await openSuppliers(page);
      await card(page, 'Lorem Supply').getByRole('button', { name: 'Синхронізувати' }).click();
      await expect.poll(() => calls(state, 'POST', '/suppliers/s-md/sync').length).toBe(1);
      expect(calls(state, 'POST', '/suppliers/s-md/sync')[0].body).toEqual({});
    });

    test('manual supplier shows the visible hint and has no sync/import actions; trash view offers restore', async ({ page }) => {
      await openSuppliers(page, { trashedSuppliers: [{ ...suppliersFixture()[1], id: 's-trash', name: 'Видалений', deletedAt: '2026-01-01T00:00:00Z', enabled: false }] });
      const manual = card(page, 'Власний склад');
      await expect(manual.locator('.supplier-url-plain')).toBeVisible();
      await expect(manual.getByRole('button', { name: 'Синхронізувати' })).toHaveCount(0);
      await expect(manual.getByRole('button', { name: 'Імпорт JSON' })).toHaveCount(0);
      await page.getByRole('button', { name: /Кошик постачальників/ }).click();
      const restore = page.getByRole('button', { name: 'Відновити постачальника' });
      const b = await box(restore);
      expect(b.height).toBeGreaterThanOrEqual(43.9);
      expect(b.width).toBeGreaterThan(viewport.width / 2);
      await noScroll(page, 'trash');
    });

    test('add forms are single column; url and numeric input modes and the masked feed field are kept', async ({ page }) => {
      await openSuppliers(page);
      const url = page.getByLabel('Сторінка MyDrop'), connection = page.getByLabel('ID підключення MyDrop'), feed = page.getByLabel('Посилання на фід EasyDrop');
      await expect(url).toHaveAttribute('type', 'url');
      await expect(connection).toHaveAttribute('inputmode', 'numeric');
      await expect(feed).toHaveAttribute('type', 'text');
      await expect(feed).toHaveClass(/secret-input/);
      for (const control of [url, connection, feed, page.getByLabel('Назва', { exact: true }).first()]) {
        await control.scrollIntoViewIfNeeded();
        expect(await fontSize(control)).toBeGreaterThanOrEqual(16);
        const b = await box(control); expect(b.x + b.width).toBeLessThanOrEqual(viewport.width); expect(b.height).toBeGreaterThanOrEqual(43.9);
      }
      for (const name of ['Додати постачальника', 'Додати постачальника EasyDrop', 'Додати ручного постачальника']) {
        const button = page.getByRole('button', { name, exact: true });
        await button.scrollIntoViewIfNeeded();
        const b = await box(button); expect(b.height).toBeGreaterThanOrEqual(43.9); expect(b.x + b.width).toBeLessThanOrEqual(viewport.width);
      }
      const sync = page.getByRole('button', { name: 'Синхронізувати постачальників MyDrop' });
      expect((await box(sync)).height).toBeGreaterThanOrEqual(43.9);
      await noScroll(page, 'add forms');
    });

    test('JSON import modal is a full-screen sheet with a short textarea and 44px footer', async ({ page }) => {
      await openSuppliers(page);
      await card(page, 'Lorem Supply').getByRole('button', { name: 'Імпорт JSON' }).click();
      const dialog = page.getByRole('dialog', { name: 'Імпорт товарів' });
      await expect(dialog).toBeVisible();
      expect(await box(dialog)).toMatchObject({ x: 0, y: 0, width: viewport.width, height: viewport.height });
      const area = dialog.getByLabel('Дані товарів');
      expect((await box(area)).height).toBeLessThanOrEqual(8 * 24 + 24);
      expect(await fontSize(area)).toBeGreaterThanOrEqual(16);
      await expectHeight44(dialog.locator('.modal-footer .button'), 'footer button');
      const footer = await box(dialog.locator('.modal-footer'));
      expect(Math.round(footer.y + footer.height)).toBe(viewport.height);
      await expect(dialog.getByRole('button', { name: 'Закрити імпорт' })).toBeVisible();
      await noScroll(page, 'import');
    });

    test('sync history renders as ordered cards with error text and no horizontal scroll', async ({ page }) => {
      await freezeBrowser(page);
      await mockAdmin(page, { runs: [...syncRunsFixture(), { id: 'r-3', supplierId: 's-md', status: 'pending', imported: 0, error: 'https://example.test/very/long/error/path/without/any/natural/break/points/at/all/to/wrap/the/text', createdAt: '2026-01-02T10:00:00Z' }] });
      await page.goto('/admin/sync');
      const table = page.getByRole('table');
      await expect(table).toHaveClass(/m-cards/);
      const rows = table.locator('tbody tr');
      await expect(rows).toHaveCount(3);
      const r = rows.nth(1);
      const ys = [await box(r.locator('.status')), await box(r.locator('.m-sub')), await box(r.locator('.m-title')), await box(r.locator('.m-meta')), await box(r.locator('.sync-error'))];
      expect(ys[1].y).toBeCloseTo(ys[0].y, -1);
      for (let i = 2; i < ys.length; i += 1) expect(ys[i].y).toBeGreaterThan(ys[i - 1].y);
      await expect(r.locator('.m-meta [data-label="Товарів"]')).toHaveText('0');
      await expect(rows.nth(0).locator('.sync-error')).toHaveCount(0);
      for (const row of await rows.all()) { const b = await box(row); expect(b.x + b.width).toBeLessThanOrEqual(viewport.width); }
      await noScroll(page, 'sync history');
    });
  });
}

test.describe('tablet suppliers 800x1000', () => {
  test.use({ viewport: { width: 800, height: 1000 } });
  test('targets are 44px and nothing scrolls sideways; sync history keeps the desktop table', async ({ page }) => {
    await openSuppliers(page);
    await expectHeight44(page.locator('.supplier-actions button'), 'tablet action');
    await expectHeight44(page.locator('.supplier-info > a'), 'tablet source link');
    await expectHeight44(page.locator('.connection-form button'), 'tablet form button');
    await noScroll(page, 'tablet suppliers');
    await page.goto('/admin/sync');
    await expect(page.locator('.table-scroll table')).not.toHaveClass(/m-cards/);
  });
});
