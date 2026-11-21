import { test, expect } from '@playwright/test';
import { mockAdmin, freezeBrowser } from './helpers/admin-mock.js';

// Mobile orders and duplicates. API fully mocked (helpers/admin-mock.js); nothing touches real inventory.
const PHONES = [{ name: '375x812', width: 375, height: 812 }, { name: '360x740', width: 360, height: 740 }];

async function open(page, path, h1, opts = {}) {
  await freezeBrowser(page);
  const state = await mockAdmin(page, opts);
  await page.goto(path);
  await expect(page.getByRole('heading', { level: 1, name: h1 })).toBeVisible();
  return state;
}
// Card facts as shown: the data-label text is rendered through ::before, so it is not part of textContent.
const shown = row => row.evaluate(el => [...el.querySelectorAll('[data-label]')].map(f => `${f.dataset.label}: ${f.textContent.trim()}`).join(' | ') + ' || ' + el.textContent);
const noHScroll = async page => {
  const m = await page.evaluate(() => ({ sw: document.documentElement.scrollWidth, iw: window.innerWidth, scrollers: [...document.querySelectorAll('.table-scroll')].filter(el => el.scrollWidth > el.clientWidth + 1).length }));
  expect(m.sw, 'document scrollWidth').toBeLessThanOrEqual(m.iw);
  expect(m.scrollers, '.table-scroll that scrolls').toBe(0);
};
// Visible buttons, selects and text inputs under 44px inside the main content (the document header strip is covered by the shell spec).
const small = page => page.evaluate(() => [...document.querySelectorAll('.admin-main button, .admin-main select, .admin-main input:not([type=checkbox]):not([type=radio])')]
  .filter(el => { const r = el.getBoundingClientRect(), s = getComputedStyle(el); return r.width > 1 && r.height > 1 && s.visibility !== 'hidden' && s.display !== 'none' && r.height < 43.99; })
  .map(el => `${el.tagName} "${(el.textContent || el.getAttribute('aria-label') || '').trim().slice(0, 30)}" ${Math.round(el.getBoundingClientRect().height)}px`));

for (const viewport of PHONES) {
  test.describe(`phone orders and duplicates ${viewport.name}`, () => {
    test.use({ viewport: { width: viewport.width, height: viewport.height } });

    for (const [path, staff] of [['/admin/orders', false], ['/staff/orders', true]]) {
      test(`${path}: list cards, no h-scroll, 44px`, async ({ page }) => {
        await open(page, path, 'Замовлення', { staff });
        await expect(page.getByRole('button', { name: 'SS-7K2M-9QXD' })).toBeVisible();
        await noHScroll(page);
        expect(await small(page), 'controls under 44px').toEqual([]);
        const card = page.getByRole('row').filter({ has: page.getByRole('button', { name: 'SS-7K2M-9QXD' }) });
        await expect(card.locator('.status')).toBeVisible();
        expect(await shown(card)).toContain('Шт.: 3');
        expect(await shown(card)).toContain('Профіль: Так');
        expect(await shown(card)).toContain('Отримувач: Коваль Олена Петрівна, +380 50 123 45 67');
        expect(await shown(card)).toContain('Доставка: Відділення №10, Київ');
        expect(await shown(card)).toContain('Створено:');
        expect(await shown(card)).toMatch(/Сума: 1\s899,00/);
        const order = (await shown(card)).split(' || ')[0];
        expect(order.indexOf('Створено'), 'date, count, sum, profile order').toBeLessThan(order.indexOf('Шт.'));
        expect(order.indexOf('Шт.')).toBeLessThan(order.indexOf('Сума'));
        expect(order.indexOf('Сума')).toBeLessThan(order.indexOf('Профіль'));
        const button = await card.getByRole('button', { name: 'SS-7K2M-9QXD' }).boundingBox();
        expect(button.height).toBeGreaterThanOrEqual(43.99);
        expect(button.width).toBeGreaterThan(viewport.width * 0.6);
        // filters are collapsed by default
        await expect(page.getByRole('button', { name: /^Фільтри \(0\)/ })).toHaveAttribute('aria-expanded', 'false');
        await expect(page.getByRole('searchbox')).toBeHidden();
      });

      test(`${path}: detail, action bar, recipient and delivery, line cards, no h-scroll`, async ({ page }) => {
        const state = await open(page, path, 'Замовлення', { staff });
        await page.getByRole('button', { name: 'SS-7K2M-9QXD' }).click();
        await expect(page.getByRole('heading', { level: 2, name: /SS-7K2M-9QXD/ })).toBeFocused();
        const personal = page.locator('.orders-personal');
        await expect(personal).toContainText('Коваль Олена Петрівна');
        await expect(personal.getByRole('link', { name: '+380 50 123 45 67' })).toHaveAttribute('href', 'tel:+380501234567');
        await expect(personal).toContainText('Відділення №10, Київ');
        await expect(page.getByText('персональні дані тут не показуються')).toHaveCount(0);
        await noHScroll(page);
        expect(await small(page), 'controls under 44px').toEqual([]);
        expect(await page.locator('.orders-lines').first().evaluate(t => [t.querySelectorAll('thead th').length, ...[...t.querySelectorAll('tbody tr')].map(r => r.children.length)])).toEqual([3, 3]);
        // facts: two columns
        const cols = await page.locator('.orders-facts').first().evaluate(el => getComputedStyle(el).gridTemplateColumns.split(' ').length);
        expect(cols).toBe(2);
        // supplier line card
        const line = page.getByRole('row').filter({ hasText: 'Кросівки Nova Linea' });
        await expect(line).toContainText('42 × 1');
        expect(await shown(line)).toContain('Ціна:');
        expect(await shown(line)).toContain('Закупівля: невідомо');
        expect(await shown(line)).toContain('ID у постачальника: ext-3');
        expect(await shown(line)).toContain('ID варіантів: v-9, v-10');
        // action bar holds the transitions; no in-flow action buttons
        const bar = page.locator('.m-actionbar');
        await expect(bar).toBeVisible();
        await expect(page.locator('.orders-actions .row-actions')).toHaveCount(0);
        expect(await bar.getByRole('button').allTextContents()).toEqual(['Перевірити', 'Скасувати кошик']);
        // cancel asks for confirmation and sends nothing until confirmed
        await bar.getByRole('button', { name: 'Скасувати кошик' }).click();
        const dialog = page.getByRole('dialog');
        await expect(dialog).toBeVisible();
        expect(state.calls).toEqual([]);
        await dialog.getByRole('button', { name: 'Скасувати', exact: true }).click();
        await expect(dialog).toBeHidden();
        expect(state.calls).toEqual([]);
        // transition: payload unchanged
        await page.locator('textarea').first().fill('Дзвонили');
        await bar.getByRole('button', { name: 'Перевірити' }).click();
        await expect.poll(() => state.calls.length).toBe(1);
        expect(state.calls[0]).toEqual({ method: 'POST', path: '/carts/SS-7K2M-9QXD/status', body: { status: 'verified', note: 'Дзвонили', expectedStatus: 'submitted' } });
      });
    }

    test('duplicates: tabs row, product cards, full-width actions, no h-scroll', async ({ page }) => {
      const state = await open(page, '/admin/duplicates', 'Дублікати між постачальниками');
      await expect(page.getByRole('heading', { level: 2, name: 'Дублікати між постачальниками' })).toBeVisible();
      await expect(page.getByRole('searchbox')).toBeVisible();
      await noHScroll(page);
      expect(await small(page), 'controls under 44px').toEqual([]);
      const tabs = await page.locator('.dup-tabs').evaluate(el => ({ ox: getComputedStyle(el).overflowX, tops: [...el.children].map(c => Math.round(c.getBoundingClientRect().top)) }));
      expect(tabs.ox).toBe('auto');
      expect(new Set(tabs.tops).size).toBe(1);
      expect(await page.locator('.dup-cards').first().evaluate(t => [t.querySelectorAll('thead th').length, ...[...t.querySelectorAll('tbody tr')].map(r => r.children.length)])).toEqual([8, 8, 8]);
      const row = page.getByRole('row').filter({ hasText: 'Lorem Aero-knit футболка' });
      await expect(row.getByRole('checkbox')).toBeVisible();
      await expect(row.locator('img')).toBeVisible();
      expect(await shown(row)).toContain('Постачальник: Lorem Aero-knit Tee');
      expect(await shown(row)).toContain('Постачальник: Easy Feed');
      expect(await shown(row)).toContain('Бренд: Lorem');
      expect(await shown(row)).toContain('Категорія: Футболки');
      await expect(row).toContainText('Собівартість');
      expect(await shown(row)).toContain('Наявність:');
      await expect(row.locator('.status')).toHaveText('Опубліковано');
      const check = await row.locator('.m-check').boundingBox();
      expect(check.width).toBeGreaterThanOrEqual(43.99);
      expect(check.height).toBeGreaterThanOrEqual(43.99);
      for (const name of ['Підтвердити: це один товар', 'Це різні товари']) {
        const box = await page.getByRole('button', { name }).boundingBox();
        expect(box.height, name).toBeGreaterThanOrEqual(43.99);
        expect(box.width, name).toBeGreaterThan(viewport.width - 100);
      }
      await page.getByRole('button', { name: 'Підтвердити: це один товар' }).click();
      await expect.poll(() => state.calls.length).toBe(1);
      expect(state.calls[0]).toMatchObject({ method: 'POST', path: '/duplicates/groups' });
      // groups tab: full-width group actions
      await page.getByRole('tab', { name: /Підтверджені групи/ }).click();
      await noHScroll(page);
      for (const name of ['Прибрати з групи', 'Розформувати групу']) {
        const button = page.getByRole('button', { name }).first();
        const box = await button.boundingBox();
        expect(box.height, name).toBeGreaterThanOrEqual(43.99);
        // full width of its container (the product card footer cell or the card footer)
        const parent = await button.evaluate(el => el.parentElement.getBoundingClientRect().width);
        expect(box.width, name).toBeGreaterThanOrEqual(parent - 1);
      }
      await page.getByRole('tab', { name: /Різні товари/ }).click();
      await noHScroll(page);
      expect(await small(page), 'controls under 44px').toEqual([]);
    });
  });
}

test.describe('tablet orders', () => {
  test.use({ viewport: { width: 768, height: 1024 } });
  test('44px controls and no page h-scroll', async ({ page }) => {
    await open(page, '/admin/orders', 'Замовлення');
    await expect(page.getByRole('button', { name: 'SS-7K2M-9QXD' })).toBeVisible();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
    expect(await small(page)).toEqual([]);
  });
});

test.describe('desktop keeps the table', () => {
  test.use({ viewport: { width: 1280, height: 800 } });
  test('orders table is not card markup', async ({ page }) => {
    await open(page, '/admin/orders', 'Замовлення');
    await expect(page.locator('table.m-cards')).toHaveCount(0);
    await expect(page.locator('.orders-filters input[type="search"]')).toHaveCount(1);
    await expect(page.getByRole('searchbox')).toBeVisible();
    await expect(page.locator('.m-filters, .m-actionbar')).toHaveCount(0);
  });
});
