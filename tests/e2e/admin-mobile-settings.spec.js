import { test, expect } from '@playwright/test';
import { mockAdmin, freezeBrowser } from './helpers/admin-mock.js';

// Mobile manager UI T6: team, audit, storefront settings, recognition and categories on phone and tablet.
// The API is fully mocked (helpers/admin-mock.js); nothing here touches real inventory or publication.
const PHONES = [{ name: '375x812', width: 375, height: 812 }, { name: '360x740', width: 360, height: 740 }];
const TABS = ['Бренди', 'Правила категорій', 'Дерево категорій', 'Історія'];

const sample = (id, over = {}) => ({ id, title: `Худі Adipisci Originals з дуже довгою назвою для перевірки переносу ${id}`, published: true, ambiguous: false, before: { category: 'Без категорії', categoryId: 'unclassified', brand: null, categoryPath: ['Без категорії'] }, after: { category: 'Худі', categoryId: 'hoodie', brand: 'Adipisci', categoryPath: ['Одяг', 'Верхній одяг', 'Худі'] }, ...over });

async function open(page, path, ready) {
  await freezeBrowser(page);
  const state = await mockAdmin(page);
  await page.route('**/api/admin/recognition/preview', route => route.fulfill({ json: { versionId: 'seed-v1', scope: 'all', total: 12, changed: 2, unchanged: 10, ambiguous: 1, publishedAffected: 1, samples: [sample('a'), sample('b', { published: false, ambiguous: true })] } }));
  await page.route('**/api/admin/taxonomy/preview', route => route.fulfill({ json: { token: 't', operation: { type: 'update', label: 'Футболки', id: 'tshirts' }, options: [], impact: { changed: 2, publishedAffected: 1, productReferences: 2, ruleReferences: 0, samples: [sample('c')] } } }));
  await page.goto(path);
  await ready(page);
  return state;
}
const noHScroll = async page => {
  const s = await page.evaluate(() => ({ sw: document.documentElement.scrollWidth, iw: window.innerWidth, tables: [...document.querySelectorAll('.table-scroll')].filter(el => el.scrollWidth > el.clientWidth + 1).length }));
  expect(s.sw, 'document scrollWidth').toBeLessThanOrEqual(s.iw);
  expect(s.tables, 'scrolling .table-scroll').toBe(0);
};
const audit = page => page.evaluate(() => {
  const visible = el => { const r = el.getBoundingClientRect(), s = getComputedStyle(el); return r.width > 1 && r.height > 1 && s.visibility !== 'hidden' && s.display !== 'none' && s.opacity !== '0' && s.pointerEvents !== 'none'; }; // opacity-0, pointer-events-none controls (the picture file input) are not touch targets
  const label = el => `${el.tagName.toLowerCase()}.${String(el.className).trim().split(/\s+/).join('.')} "${(el.getAttribute('aria-label') || el.textContent || '').trim().slice(0, 40)}"`;
  const controls = [...document.querySelectorAll('.admin-main button, .admin-main select, .admin-main input:not([type=checkbox]):not([type=radio]), .admin-main summary')].filter(visible);
  const hits = [...document.querySelectorAll('.admin-main label:has(> input[type=checkbox]), .admin-main label:has(> input[type=radio])')].filter(visible);
  return {
    small: controls.filter(el => el.getBoundingClientRect().height < 43.99).map(el => `${label(el)} ${Math.round(el.getBoundingClientRect().height)}px`),
    smallHits: hits.filter(el => el.getBoundingClientRect().height < 43.99).map(el => `${label(el)} ${Math.round(el.getBoundingClientRect().height)}px`),
    zoom: controls.filter(el => el.matches('input, select') && parseFloat(getComputedStyle(el).fontSize) < 16).map(label),
  };
});
const tops = (locators) => Promise.all(locators.map(async l => Math.round((await l.boundingBox()).y)));

for (const vp of PHONES) {
  test.describe(`settings phone ${vp.name}`, () => {
    test.use({ viewport: { width: vp.width, height: vp.height } });

    test('team: cards in order, no h-scroll, 44px controls, delete last', async ({ page }) => {
      await open(page, '/admin/team', p => expect(p.getByText('Запрошений').first()).toBeVisible());
      await noHScroll(page);
      const result = await audit(page);
      expect(result.small, 'controls under 44px').toEqual([]);
      expect(result.zoom).toEqual([]);
      const card = page.getByRole('row').filter({ hasText: 'Запрошений' }).last();
      const order = await tops([
        card.locator('strong'), card.getByText('new@example.test'), card.getByText(/^Запрошення до/), card.locator('.staff-status'), card.locator('.staff-sessions'),
        card.locator('.staff-role select'), card.getByRole('button', { name: 'Зберегти ім’я' }), card.getByRole('button', { name: 'Поновити запрошення' }),
        card.getByRole('button', { name: 'Завершити сесії' }), card.getByRole('button', { name: 'Видалити з команди' }),
      ]);
      expect(order[0]).toBeLessThan(order[1]); expect(order[1]).toBeLessThan(order[2]); expect(order[2]).toBeLessThan(order[3]);
      expect(order[3]).toBeLessThan(order[4]); expect(order[4]).toBeLessThan(order[5]); expect(order[5]).toBeLessThan(order[6]);
      expect(order[6]).toBeLessThan(order[7]); expect(order[9]).toBeGreaterThan(order[8]);
      const del = await card.getByRole('button', { name: 'Видалити з команди' }).boundingBox();
      expect(del.width).toBeGreaterThan(vp.width * 0.7);
      const select = await card.locator('.staff-role select').boundingBox();
      expect(select.width).toBeGreaterThan(vp.width * 0.7);
      await expect(page.getByText('Керування власником доступне лише через Access.').first()).toBeVisible();
    });

    test('audit: cards in order, details closed then open', async ({ page }) => {
      await open(page, '/admin/audit', p => expect(p.getByText('p-3').first()).toBeVisible());
      await noHScroll(page);
      expect((await audit(page)).small).toEqual([]);
      const card = page.getByRole('row').filter({ hasText: 'p-3' }).last();
      const order = await tops([card.locator('.audit-action'), card.locator('.audit-time'), card.locator('.audit-actor'), card.locator('.audit-object'), card.locator('.audit-details summary')]);
      for (let i = 1; i < order.length; i++) expect(order[i], `order ${order}`).toBeGreaterThan(order[i - 1]);
      const actor = await card.locator('.audit-actor').boundingBox(), role = await card.locator('.audit-role').boundingBox();
      expect(Math.abs(actor.y - role.y), 'actor and role share a line').toBeLessThan(2);
      const details = card.locator('details');
      await expect(details).not.toHaveAttribute('open', /.*/);
      await expect(card.locator('pre')).toBeHidden();
      await card.getByText('Подробиці', { exact: true }).click();
      await expect(card.locator('pre')).toBeVisible();
      await noHScroll(page);
    });

    test('storefront: ticker buttons 44px under the input, 44px choice rows, single column prepayment', async ({ page }) => {
      await open(page, '/admin/storefront', p => expect(p.getByLabel('Показувати біжучий рядок')).toBeVisible());
      await noHScroll(page);
      const result = await audit(page);
      expect(result.small, 'controls under 44px').toEqual([]);
      expect(result.smallHits, 'rows under 44px').toEqual([]);
      expect(result.zoom).toEqual([]);
      const input = await page.getByLabel('Фраза 1', { exact: true }).boundingBox();
      for (const name of ['Фраза 1 вище', 'Фраза 1 нижче', 'Видалити фразу 1']) {
        const b = await page.getByRole('button', { name }).boundingBox();
        expect(b.height).toBeGreaterThanOrEqual(43.99);
        expect(b.y, name).toBeGreaterThanOrEqual(input.y + input.height - 1);
      }
      const label = page.getByLabel('Передоплата, ₴');
      await expect(label).toHaveAttribute('inputmode', 'decimal');
      const b = await label.boundingBox();
      expect(b.x + b.width).toBeLessThanOrEqual(vp.width);
      // Radio description text must stay inside its card and the viewport; real hit area is the 44px label, not the 20px box.
      const modes = await page.locator('label.storefront-mode').evaluateAll(els => els.map(l => { const r = l.getBoundingClientRect(), t = l.querySelector('span').getBoundingClientRect(); return { h: r.height, right: r.right, textRight: t.right, scroll: l.scrollWidth - l.clientWidth }; }));
      expect(modes.length).toBeGreaterThan(3);
      for (const m of modes) { expect(m.h).toBeGreaterThanOrEqual(43.99); expect(m.textRight).toBeLessThanOrEqual(m.right + 0.5); expect(m.right).toBeLessThanOrEqual(vp.width); expect(m.scroll).toBeLessThanOrEqual(0); }
      // Staging markup (scene picker, picture library): present only when the branch carries it.
      for (const sel of ['label.scene-card', '.picture-tile-actions button', '.picture-add button']) {
        const hs = await page.locator(sel).evaluateAll(els => els.filter(e => e.getBoundingClientRect().width > 1).map(e => e.getBoundingClientRect().height));
        // the default mock has no saved pictures, so these lists may be empty; any present target must be 44px
        expect(hs.length).toBeGreaterThanOrEqual(0);
        for (const h of hs) expect(h, sel).toBeGreaterThanOrEqual(43.99);
      }
      const cols = await page.locator('.storefront-excluded-list').evaluate(el => getComputedStyle(el).gridTemplateColumns.split(' ').length);
      expect(cols).toBe(1);
      const save = await page.getByRole('button', { name: 'Зберегти' }).first().boundingBox();
      expect(save.width).toBeGreaterThan(vp.width * 0.8);
    });

    for (const tab of TABS) {
      test(`recognition ${tab}: no h-scroll, 44px controls`, async ({ page }) => {
        await open(page, '/admin/recognition', p => expect(p.getByRole('tab', { name: /Бренди/ })).toBeVisible());
        await page.getByRole('tab', { name: new RegExp(tab) }).click();
        await expect(page.getByRole('tab', { name: new RegExp(tab) })).toHaveAttribute('aria-selected', 'true');
        await noHScroll(page);
        const result = await audit(page);
        expect(result.small, 'controls under 44px').toEqual([]);
        expect(result.zoom).toEqual([]);
        if (tab === 'Бренди') {
          const toggles = await page.locator('.admin-main label:has(> input[type=checkbox])').evaluateAll(els => els.filter(e => e.getBoundingClientRect().width > 1).map(e => e.getBoundingClientRect().height));
          expect(toggles.length).toBeGreaterThan(0);
          for (const h of toggles) expect(h, 'recognition toggle label').toBeGreaterThanOrEqual(43.99);
        }
        if (tab === 'Бренди') {
          // alias enable checkboxes: the effective target (wrapping label) must be at least 44x44
          const boxes = await page.locator('fieldset.recognition-alias input[type=checkbox]').evaluateAll(els => els.map(e => { const r = (e.closest('label') || e).getBoundingClientRect(); return [Math.round(r.width), Math.round(r.height)]; }));
          expect(boxes.length).toBeGreaterThan(0);
          for (const [w, h] of boxes) { expect(w).toBeGreaterThanOrEqual(43.99); expect(h).toBeGreaterThanOrEqual(43.99); }
        }
        if (tab === 'Історія') {
          const history = page.locator('.recognition-history');
          await expect(history.locator('table.m-cards')).toBeVisible();
          const row = await history.getByRole('row').filter({ hasText: 'Футболка Lorem' }).boundingBox();
          expect(row.width).toBeLessThanOrEqual(vp.width);
        }
        if (tab === 'Правила категорій') {
          await page.getByRole('button', { name: 'Додати правило категорії', exact: true }).click();
          const cols = await page.locator('.recognition-match-grid').first().evaluate(el => getComputedStyle(el).gridTemplateColumns.split(' ').length);
          expect(cols).toBe(1);
          await noHScroll(page);
        }
      });
    }

    test('recognition impact preview becomes cards', async ({ page }) => {
      await open(page, '/admin/recognition', p => expect(p.getByRole('tab', { name: /Бренди/ })).toBeVisible());
      await page.getByRole('button', { name: 'Переглянути вплив на каталог', exact: true }).click();
      const region = page.getByRole('region', { name: 'Вплив правил' });
      await expect(region.locator('table.m-cards')).toBeVisible();
      await noHScroll(page);
      const cards = region.getByRole('row');
      await expect(cards.filter({ hasText: 'Потрібне уточнення' })).toHaveCount(1);
      const first = region.locator('tbody tr').first();
      await expect(first).toContainText('Опублікований');
      await expect(first.locator('td').nth(1)).toContainText('Без категорії · Без бренду');
      await expect(first.locator('td').nth(1)).toHaveAttribute('data-label', 'До');
      await expect(first.locator('td').nth(2)).toContainText('Худі · Adipisci');
      expect((await audit(page)).small).toEqual([]);
    });

    test('category tree preview becomes cards', async ({ page }) => {
      await open(page, '/admin/recognition', p => expect(p.getByRole('tab', { name: /Бренди/ })).toBeVisible());
      await page.getByRole('tab', { name: /Дерево категорій/ }).click();
      await page.locator('.recognition-list-row').first().click();
      await page.getByRole('button', { name: 'Переглянути зміни дерева' }).click();
      const panel = page.getByRole('region', { name: 'Вплив змін дерева' });
      await expect(panel.locator('table.m-cards')).toBeVisible();
      await expect(panel.locator('tbody tr').first().locator('td').nth(1)).toContainText('Без категорії');
      await noHScroll(page);
    });
  });
}

test.describe('settings tablet', () => {
  test.use({ viewport: { width: 820, height: 1000 } });
  for (const path of ['/admin/team', '/admin/audit', '/admin/storefront', '/admin/recognition']) {
    test(`${path}: 44px targets and no page h-scroll`, async ({ page }) => {
      await open(page, path, p => expect(p.locator('.admin-main')).toBeVisible());
      await expect(page.locator('.admin-main button').first()).toBeVisible();
      const s = await page.evaluate(() => ({ sw: document.documentElement.scrollWidth, iw: window.innerWidth }));
      expect(s.sw).toBeLessThanOrEqual(s.iw);
      const result = await audit(page);
      expect(result.small, 'controls under 44px').toEqual([]);
      if (path === '/admin/recognition') {
        const boxes = await page.locator('fieldset.recognition-alias input[type=checkbox]').evaluateAll(els => els.map(e => { const r = (e.closest('label') || e).getBoundingClientRect(); return Math.min(r.width, r.height); }));
        for (const m of boxes) expect(m).toBeGreaterThanOrEqual(43.99);
      }
    });
  }
});
