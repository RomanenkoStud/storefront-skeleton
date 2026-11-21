import { test, expect } from '@playwright/test';
import { mockAdmin, freezeBrowser, adminProduct, OWNER_PERMISSIONS } from './helpers/admin-mock.js';

// Mobile catalog list: phone cards, filter disclosure, select-all, bottom bulk bar, pager; tablet targets; desktop DOM kept.
// The API is fully mocked (helpers/admin-mock.js); nothing here touches real inventory or publication.
const PHONES = [{ name: '375x812', width: 375, height: 812 }, { name: '360x740', width: 360, height: 740 }];

async function open(page, opts = {}) {
  await freezeBrowser(page);
  const state = await mockAdmin(page, opts);
  await page.goto('/admin/catalog');
  await expect(page.getByRole('heading', { level: 1, name: 'Ваша добірка' })).toBeVisible();
  await expect(page.locator('.catalog-table tbody tr').first()).toBeVisible();
  return state;
}
// The shared mock has no bulk endpoint; answer it here (and record the call like the mock does) so a successful action empties the selection.
async function mockBulk(page, state) {
  await page.route(/\/api\/(?:staff\/)?admin\/products\/bulk$/, route => { const body = JSON.parse(route.request().postData()); state.calls.push({ method: 'POST', path: '/products/bulk', body }); return route.fulfill({ json: { updated: body.ids.length } }); });
}
const manyProducts = n => Array.from({ length: n }, (_, i) => adminProduct({ id: `m-${i}`, externalId: `mx-${i}`, title: `Товар ${i}`, brand: 'Lorem', categoryId: 'tops', categoryPath: ['Одяг'], variants: [{ size: 'M', stock: 1 }] }));
const trashed = () => [adminProduct({ id: 't-1', externalId: 'trash-1', title: 'Видалена куртка', published: false, deletedAt: '2026-06-10T08:00:00.000Z' }), adminProduct({ id: 't-2', externalId: 'trash-2', title: 'Видалені шорти', deletedAt: '2026-06-11T08:00:00.000Z' })];
const noHScroll = page => page.evaluate(() => ({ sw: document.documentElement.scrollWidth, iw: window.innerWidth }));
const box = async locator => { const b = await locator.boundingBox(); expect(b, 'visible').not.toBeNull(); return b; };

for (const viewport of PHONES) {
  test.describe(`phone catalog ${viewport.name}`, () => {
    test.use({ viewport: { width: viewport.width, height: viewport.height } });

    test('cards: no h-scroll, field order, thumbnail, 44px controls, roles', async ({ page }) => {
      await open(page);
      const scroll = await noHScroll(page);
      expect(scroll.sw, 'document scrollWidth').toBeLessThanOrEqual(scroll.iw);
      const tableScroll = await page.locator('.table-scroll').evaluate(el => ({ sw: el.scrollWidth, cw: el.clientWidth }));
      expect(tableScroll.sw).toBeLessThanOrEqual(tableScroll.cw);
      const table = page.locator('table.catalog-table');
      await expect(table).toHaveClass(/m-cards/);
      await expect(table).toHaveAttribute('role', 'table');
      await expect(table.locator('thead')).toHaveAttribute('role', 'rowgroup');
      await expect(table.locator('tbody')).toHaveAttribute('role', 'rowgroup');
      await expect(table.locator('tbody tr').first()).toHaveAttribute('role', 'row');
      await expect(table.locator('tbody tr').first().locator('td').first()).toHaveAttribute('role', 'cell');
      await expect(table.locator('thead th').first()).toHaveAttribute('role', 'columnheader');
      await expect(table.locator('thead th').first()).toBeHidden();
      await expect(page.getByLabel('Обрати видимі товари')).toBeHidden();

      const card = table.locator('tbody tr').first();
      const parts = {
        select: card.getByRole('checkbox', { name: 'Обрати Футболка Lorem' }),
        thumb: card.locator('td.m-thumb img'),
        title: card.locator('td.m-title'),
        idBrand: card.locator('td.m-sub > span').nth(0),
        category: card.locator('td.m-sub > span').nth(1),
        review: card.locator('td.m-sub .review-marker'),
        price: card.locator('td.m-price'),
        stock: card.locator('td.m-meta').nth(0),
        status: card.locator('td.m-status'),
        supplier: card.locator('td.m-meta').nth(1),
        edit: card.getByRole('button', { name: /^Редагувати/ }),
        remove: card.getByRole('button', { name: 'Видалити товар Футболка Lorem' }),
      };
      await expect(parts.title).toHaveText('Футболка Lorem');
      await expect(parts.idBrand).toHaveText('ext-1 · Lorem');
      await expect(parts.category).toHaveText('Без категорії');
      await expect(parts.review).toBeVisible();
      await expect(parts.stock).toContainText('В наявності');
      await expect(parts.stock).toContainText('M · L');
      await expect(parts.status).toHaveText('Чернетка');
      // the labels are CSS content (attr(data-label)), so assert the attributes and the rendered pseudo-element
      await expect(parts.supplier.locator('[data-label="Постачальник"]')).toHaveText('Lorem Supply');
      await expect(parts.supplier.locator('[data-label="Закупівля"]')).toHaveText(/500,00/);
      expect(await parts.supplier.locator('[data-label="Постачальник"]').evaluate(el => getComputedStyle(el, '::before').content)).toBe('"Постачальник: "');
      await expect(parts.edit).toHaveText('Редагувати ↗');
      await expect(parts.remove).toHaveText('Видалити');
      // DOM order is the specified order, and the visual stack runs top to bottom in it.
      const order = ['select', 'thumb', 'title', 'idBrand', 'category', 'review', 'price', 'stock', 'status', 'supplier', 'edit', 'remove'];
      const handles = await Promise.all(order.map(key => parts[key].elementHandle()));
      for (let i = 1; i < handles.length; i += 1) {
        const follows = await page.evaluate(([a, b]) => !!(a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING), [handles[i - 1], handles[i]]);
        expect(follows, `${order[i - 1]} before ${order[i]}`).toBe(true);
      }
      const tops = {};
      for (const key of ['title', 'idBrand', 'category', 'review', 'price', 'stock', 'supplier', 'edit']) tops[key] = (await box(parts[key])).y;
      const stack = ['title', 'idBrand', 'category', 'review', 'price', 'stock', 'supplier', 'edit'];
      for (let i = 1; i < stack.length; i += 1) expect(tops[stack[i]], `${stack[i]} below ${stack[i - 1]}`).toBeGreaterThan(tops[stack[i - 1]]);
      expect((await box(parts.status)).y).toBeLessThan(tops.stock);
      const thumb = await box(parts.thumb);
      expect([Math.round(thumb.width), Math.round(thumb.height)]).toEqual([56, 72]);
      const cardBox = await box(card);
      expect(thumb.x).toBeGreaterThan((await box(parts.select)).x);
      // 44px targets
      for (const key of ['edit', 'remove']) expect((await box(parts[key])).height, key).toBeGreaterThanOrEqual(43.99);
      const wrapper = card.locator('.m-check');
      const wb = await box(wrapper);
      expect(wb.width).toBeGreaterThanOrEqual(43.99);
      expect(wb.height).toBeGreaterThanOrEqual(43.99);
      expect(wb.x + wb.width).toBeLessThanOrEqual(cardBox.x + cardBox.width + 1);
      // the 44px hit area really toggles: click its corner, far from the 20px box
      await page.mouse.click(wb.x + 2, wb.y + 2);
      await expect(parts.select).toBeChecked();
      await expect(page.locator('.m-actionbar-status')).toHaveText('Обрано 1');
      await page.mouse.click(wb.x + 2, wb.y + 2);
      await expect(parts.select).not.toBeChecked();
      await expect(page.locator('.m-actionbar')).toHaveCount(0);

      // price with the manual badge, a brandless card, the 2-line title clamp
      const third = table.locator('tbody tr').nth(2);
      await expect(third.locator('td.m-price')).toContainText('Ручна ціна');
      await expect(third.locator('td.m-sub > span').first()).toHaveText('ext-3 · Бренд не визначено');
      const longTitle = table.locator('tbody tr').nth(1).locator('td.m-title');
      const lines = await longTitle.evaluate(el => Math.round(el.getBoundingClientRect().height / parseFloat(getComputedStyle(el).lineHeight)));
      expect(lines).toBeLessThanOrEqual(2);
    });

    test('controls: search, stats, resource views and filters meet size and zoom rules', async ({ page }) => {
      await open(page);
      const search = page.getByLabel('Пошук у каталозі менеджера');
      await expect(search).toHaveAttribute('type', 'search');
      await expect(search).toHaveAttribute('enterkeyhint', 'search');
      expect(await search.evaluate(el => parseFloat(getComputedStyle(el).fontSize))).toBeGreaterThanOrEqual(16);
      expect((await box(search)).height).toBeGreaterThanOrEqual(43.99);
      const stats = await box(page.locator('.stats-grid'));
      expect(stats.height).toBeLessThanOrEqual(120);
      const views = page.locator('.resource-views > button');
      expect(await views.count()).toBe(3);
      const rects = await views.evaluateAll(list => list.map(el => { const r = el.getBoundingClientRect(); return { top: Math.round(r.top), height: r.height, right: r.right }; }));
      expect(new Set(rects.map(r => r.top)).size, 'one row').toBe(1);
      for (const r of rects) { expect(r.height).toBeGreaterThanOrEqual(43.99); expect(r.right).toBeLessThanOrEqual(viewport.width); }
      // every visible control outside the table cards is 44px and inputs are 16px
      const audit = await page.evaluate(() => {
        const visible = el => { const r = el.getBoundingClientRect(), s = getComputedStyle(el); return r.width > 1 && r.height > 1 && s.visibility !== 'hidden' && s.display !== 'none'; };
        const controls = [...document.querySelectorAll('.admin-main button, .admin-main select, .admin-main input:not([type="checkbox"])')].filter(visible);
        return { small: controls.filter(el => el.getBoundingClientRect().height < 43.99).map(el => `${el.tagName} ${el.textContent || el.getAttribute('aria-label')}`), zoom: controls.filter(el => el.matches('input, select') && parseFloat(getComputedStyle(el).fontSize) < 16).map(el => el.getAttribute('aria-label')), count: controls.length };
      });
      expect(audit.count).toBeGreaterThan(5);
      expect(audit.small).toEqual([]);
      expect(audit.zoom).toEqual([]);
    });

    test('filters: collapsed disclosure, non-default count, reset restores defaults', async ({ page }) => {
      await open(page);
      const toggle = page.getByRole('button', { name: /^Фільтри \(/ });
      await expect(toggle).toHaveText(/Фільтри \(0\)/);
      await expect(toggle).toHaveAttribute('aria-expanded', 'false');
      const supplier = page.getByLabel('Постачальник', { exact: true });
      await expect(supplier).toBeHidden();
      await toggle.focus();
      await page.keyboard.press('Enter');
      await expect(toggle).toHaveAttribute('aria-expanded', 'true');
      await expect(supplier).toBeVisible();
      const panelBox = await box(page.locator('.m-filters-panel'));
      expect(panelBox.x + panelBox.width).toBeLessThanOrEqual(viewport.width);
      const scroll = await noHScroll(page);
      expect(scroll.sw).toBeLessThanOrEqual(scroll.iw);
      await expect(page.getByLabel('Наявність', { exact: true })).toHaveValue('in-stock');
      await supplier.selectOption('s-ed');
      await expect(toggle).toHaveText(/Фільтри \(1\)/);
      await expect(page.locator('.catalog-table tbody tr')).toHaveCount(1);
      await page.getByLabel('Бренд у кабінеті').selectOption('Lorem');
      await page.getByLabel('Наявність', { exact: true }).selectOption('');
      await expect(toggle).toHaveText(/Фільтри \(3\)/);
      await expect(page.getByText('Товарів за цим запитом немає')).toBeVisible();
      await page.getByRole('button', { name: 'Скинути фільтри' }).click();
      await expect(toggle).toHaveText(/Фільтри \(0\)/);
      for (const label of ['Постачальник', 'Статус публікації', 'Категорія в кабінеті', 'Бренд у кабінеті', 'Перевірка категоризації']) await expect(page.getByLabel(label, { exact: true })).toHaveValue('');
      await expect(page.getByLabel('Наявність', { exact: true })).toHaveValue('in-stock');
      await expect(page.locator('.catalog-table tbody tr')).toHaveCount(4);
      await toggle.click();
      await expect(toggle).toHaveAttribute('aria-expanded', 'false');
      await expect(supplier).toBeHidden();
    });

    test('select-all replaces the header checkbox and the bulk bar follows the selection', async ({ page }) => {
      await open(page);
      await expect(page.locator('.m-actionbar')).toHaveCount(0);
      await expect(page.getByText('Оберіть до 50 товарів для групової дії')).toBeVisible();
      await expect(page.getByRole('button', { name: 'Видалити обрані' })).toHaveCount(0);
      const all = page.getByLabel('Обрати всі на сторінці (4)');
      await expect(all).toBeVisible();
      await all.check();
      const bar = page.locator('.m-actionbar');
      await expect(bar.locator('.m-actionbar-status')).toHaveText('Обрано 4');
      await expect(page.getByText('Оберіть до 50 товарів для групової дії')).toHaveCount(0);
      // inline: publish, delete; the rest behind «Ще дії», clear selection last
      const row = bar.locator('.m-actionbar-row');
      await expect(row.locator('> button:not([aria-expanded])')).toHaveText(['Опублікувати обрані', 'Видалити обрані']);
      const more = bar.getByRole('button', { name: 'Ще дії' });
      await expect(more).toHaveAttribute('aria-expanded', 'false');
      await expect(bar.locator('.m-actionbar-more')).toBeHidden();
      await more.click();
      await expect(more).toHaveAttribute('aria-expanded', 'true');
      await expect(bar.locator('.m-actionbar-more > button')).toHaveText(['Зняти обрані з публікації', 'Видалити фон (4)', 'Мітки…', 'Переглянути пропозиції', 'Зняти вибір']);
      for (const button of await bar.locator('button:visible').all()) expect((await box(button)).height).toBeGreaterThanOrEqual(43.99);
      // Escape closes the overflow and returns focus to its toggle
      await bar.getByRole('button', { name: 'Видалити фон (4)' }).focus();
      await page.keyboard.press('Escape');
      await expect(more).toHaveAttribute('aria-expanded', 'false');
      await expect(more).toBeFocused();
      await expect(bar.locator('.m-actionbar-more')).toBeHidden();
      // the bar does not cover the last card
      await page.evaluate(() => window.scrollTo(0, document.documentElement.scrollHeight));
      const last = await box(page.locator('.catalog-table tbody tr').last());
      const barBox = await box(bar);
      expect(last.y + last.height).toBeLessThanOrEqual(barBox.y + 1);
      expect(barBox.y + barBox.height).toBeLessThanOrEqual(viewport.height + 1);
      const scroll = await noHScroll(page);
      expect(scroll.sw).toBeLessThanOrEqual(scroll.iw);
      // clear selection
      await more.click();
      await bar.getByRole('button', { name: 'Зняти вибір' }).click();
      await expect(page.locator('.m-actionbar')).toHaveCount(0);
      // focus moves to the select-all checkbox instead of falling to <body>
      await expect(all).toBeFocused();
      await expect(all).not.toBeChecked();
    });

    test('bulk bar keeps the same permission gates and deliberate delete confirmation', async ({ page }) => {
      const permissions = OWNER_PERMISSIONS.filter(p => p !== 'products.publish');
      const state = await open(page, { permissions });
      await mockBulk(page, state);
      await page.getByLabel('Обрати Футболка Lorem').check();
      const bar = page.locator('.m-actionbar');
      await expect(bar.locator('.m-actionbar-row > button:not([aria-expanded])')).toHaveText(['Видалити обрані', 'Видалити фон (1)']);
      await bar.getByRole('button', { name: 'Ще дії' }).click();
      await expect(bar.locator('.m-actionbar-more > button')).toHaveText(['Мітки…', 'Переглянути пропозиції', 'Зняти вибір']);
      await bar.getByRole('button', { name: 'Ще дії' }).click();
      await bar.getByRole('button', { name: 'Видалити обрані' }).click();
      const dialog = page.getByRole('dialog');
      await expect(dialog.getByRole('heading', { name: 'Видалити обрані товари?' })).toBeVisible();
      // the dialog is above the bar and delete is not sent until confirmed
      const dialogBox = await box(dialog);
      expect(dialogBox.y).toBeLessThanOrEqual(1);
      expect(state.calls.filter(c => c.path === '/products/bulk')).toEqual([]);
      await dialog.getByRole('button', { name: 'Видалити 1 товарів' }).click();
      await expect.poll(() => state.calls.filter(c => c.path === '/products/bulk').map(c => c.body)).toEqual([{ ids: ['p-1'], action: 'delete', confirm: true }]);
      await expect(page.locator('.m-actionbar')).toHaveCount(0);
      await expect.poll(() => page.evaluate(() => document.activeElement?.tagName)).not.toBe('BODY');
      await expect.poll(() => page.evaluate(() => document.activeElement?.closest('.m-select-all, .bulk-hint') !== null)).toBe(true);
    });

    test('trash view: restore card actions and the restore-only bar', async ({ page }) => {
      const state = await open(page, { trashedProducts: trashed() });
      await mockBulk(page, state);
      await page.getByRole('button', { name: /^Кошик товарів/ }).click();
      const cards = page.locator('.catalog-table tbody tr');
      await expect(cards).toHaveCount(2);
      await expect(cards.first().locator('td.m-status')).toContainText('У кошику');
      await expect(cards.first().locator('td.m-status .cell-note')).not.toBeEmpty();
      await expect(cards.first().getByRole('button', { name: 'Відновити товар' })).toBeVisible();
      await expect(cards.first().getByRole('button', { name: /^Редагувати/ })).toHaveCount(0);
      expect((await box(cards.first().getByRole('button', { name: 'Відновити товар' }))).height).toBeGreaterThanOrEqual(43.99);
      await page.getByLabel('Обрати всі на сторінці (2)').check();
      const bar = page.locator('.m-actionbar');
      await expect(bar.locator('.m-actionbar-status')).toHaveText('Обрано 2');
      await expect(bar.getByRole('button')).toHaveText(['Відновити обрані']);
      await bar.getByRole('button', { name: 'Відновити обрані' }).click();
      await expect.poll(() => state.calls.filter(c => c.path === '/products/bulk').map(c => c.body)).toEqual([{ ids: ['t-1', 't-2'], action: 'restore' }]);
      await expect(page.locator('.m-actionbar')).toHaveCount(0);
      await expect.poll(() => page.evaluate(() => document.activeElement?.tagName)).not.toBe('BODY');
      const scroll = await noHScroll(page);
      expect(scroll.sw).toBeLessThanOrEqual(scroll.iw);
    });

    test('bulk suggestion preview and cutout panel stay inside the viewport', async ({ page }) => {
      await open(page);
      await page.route(/\/api\/(?:staff\/)?admin\/recognition\/preview$/, route => route.fulfill({ json: { versionId: 'seed-v1', scope: 'selected', total: 1, changed: 1, unchanged: 0, ambiguous: 0, publishedAffected: 0, token: 'fixture-token', samples: [{ id: 'p-1', title: 'Футболка Lorem', published: false, before: { category: 'Футболки', brand: 'Lorem' }, after: { category: 'Футболки / поло', brand: 'Lorem' }, ambiguous: false }] } }));
      await page.getByLabel('Обрати Футболка Lorem').check();
      const bar = page.locator('.m-actionbar');
      await bar.getByRole('button', { name: 'Ще дії' }).click();
      await bar.getByRole('button', { name: 'Переглянути пропозиції' }).click();
      const confirm = page.getByRole('button', { name: 'Підтвердити й закріпити пропозиції для обраних' });
      await expect(confirm).toBeVisible();
      await expect(page.getByRole('button', { name: 'Скасувати' })).toBeVisible();
      let scroll = await noHScroll(page);
      expect(scroll.sw, 'preview open: document scrollWidth').toBeLessThanOrEqual(scroll.iw);
      const cb = await box(confirm);
      expect(cb.x).toBeGreaterThanOrEqual(0);
      expect(cb.x + cb.width).toBeLessThanOrEqual(viewport.width);
      expect(cb.height).toBeGreaterThanOrEqual(43.99);
      await page.getByRole('button', { name: 'Скасувати' }).click();
      await bar.getByRole('button', { name: 'Ще дії' }).click();
      await bar.getByRole('button', { name: /^Видалити фон/ }).click();
      await expect(page.locator('.batch-cutout')).toBeVisible();
      scroll = await noHScroll(page);
      expect(scroll.sw, 'cutout panel open: document scrollWidth').toBeLessThanOrEqual(scroll.iw);
    });

    test('pressing the trash view switch keeps focus on it', async ({ page }) => {
      await open(page, { trashedProducts: trashed() });
      await page.getByRole('button', { name: /^Кошик товарів/ }).click();
      await page.getByLabel('Обрати Видалена куртка').check();
      await expect(page.locator('.m-actionbar')).toHaveCount(1);
      const products = page.getByRole('button', { name: /^Товари \(/ });
      await products.click();
      await expect(page.locator('.m-actionbar')).toHaveCount(0);
      await expect(products).toBeFocused();
    });

    test('a cutout bar action does not pull focus away from a later view-switch press', async ({ page }) => {
      await open(page);
      await page.getByLabel('Обрати Футболка Lorem').check();
      const bar = page.locator('.m-actionbar');
      await bar.getByRole('button', { name: 'Ще дії' }).click();
      await bar.getByRole('button', { name: /^Видалити фон/ }).click();
      await expect(page.locator('.batch-cutout')).toBeVisible();
      const products = page.getByRole('button', { name: /^Товари \(/ });
      await products.click();
      await expect(page.locator('.m-actionbar')).toHaveCount(0);
      await expect(products).toBeFocused();
    });

    test('pager: 44px arrows keep their labels, the range wraps and paging works', async ({ page }) => {
      await open(page, { products: manyProducts(45) });
      const prev = page.getByRole('button', { name: 'Попередня сторінка' }), next = page.getByRole('button', { name: 'Наступна сторінка' });
      for (const button of [prev, next]) { const b = await box(button); expect(b.width).toBeGreaterThanOrEqual(43.99); expect(b.height).toBeGreaterThanOrEqual(43.99); }
      await expect(prev).toBeDisabled();
      await expect(page.locator('.panel-footer > span').first()).toContainText('1–40 із 45');
      const footer = await page.locator('.panel-footer').evaluate(el => ({ sw: el.scrollWidth, cw: el.clientWidth }));
      expect(footer.sw).toBeLessThanOrEqual(footer.cw);
      await next.click();
      await expect(page.locator('.panel-footer > span').first()).toContainText('41–45 із 45');
      await expect(page.locator('.catalog-table tbody tr')).toHaveCount(5);
      await expect(next).toBeDisabled();
      const all = page.getByLabel('Обрати всі на сторінці (5)');
      await all.check();
      await expect(page.locator('.m-actionbar-status')).toHaveText('Обрано 5');
    });

    test('edit opens the editor from a card', async ({ page }) => {
      await open(page);
      await page.locator('.catalog-table tbody tr').first().getByRole('button', { name: /^Редагувати/ }).click();
      await expect(page.getByRole('dialog')).toBeVisible();
    });
  });
}

test.describe('tablet catalog 768x1024', () => {
  test.use({ viewport: { width: 768, height: 1024 } });
  test('keeps the table, 44px row actions and pager, no page h-scroll', async ({ page }) => {
    await open(page, { products: manyProducts(45) });
    await expect(page.locator('table.catalog-table')).not.toHaveClass(/m-cards/);
    await expect(page.locator('table.catalog-table')).not.toHaveAttribute('role', 'table');
    await expect(page.getByRole('button', { name: /^Фільтри \(/ })).toHaveCount(0);
    await expect(page.getByLabel('Обрати видимі товари')).toBeVisible();
    const scroll = await noHScroll(page);
    expect(scroll.sw).toBeLessThanOrEqual(scroll.iw);
    const row = page.locator('.catalog-table tbody tr').first();
    for (const name of [/^Редагувати/, /^Видалити/]) expect((await box(row.getByRole('button', { name }))).height).toBeGreaterThanOrEqual(43.99);
    for (const name of ['Попередня сторінка', 'Наступна сторінка']) { const b = await box(page.getByRole('button', { name })); expect(b.width).toBeGreaterThanOrEqual(43.99); expect(b.height).toBeGreaterThanOrEqual(43.99); }
    await page.getByLabel('Обрати Товар 0').check();
    await expect(page.locator('.m-actionbar')).toHaveCount(0);
    await expect(page.locator('.bulk-toolbar').getByRole('button', { name: 'Видалити обрані' })).toBeVisible();
  });
});

test.describe('desktop catalog 1440x900', () => {
  test.use({ viewport: { width: 1440, height: 900 } });
  test('renders the unchanged table: no phone-only elements, roles or attributes', async ({ page }) => {
    await open(page);
    await expect(page.locator('table.catalog-table')).not.toHaveClass(/m-cards/);
    expect(await page.locator('table.catalog-table, table.catalog-table *').evaluateAll(list => list.filter(el => el.hasAttribute('role')).length)).toBe(0);
    await expect(page.locator('.m-filters, .m-actionbar, .m-select-all')).toHaveCount(0);
    await expect(page.getByLabel('Пошук у каталозі менеджера')).not.toHaveAttribute('type', 'search');
    await expect(page.locator('.panel-toolbar select')).toHaveCount(8);
    await page.getByLabel('Обрати Футболка Lorem').check();
    await expect(page.locator('.bulk-toolbar').getByRole('button', { name: 'Видалити обрані' })).toBeEnabled();
    await expect(page.locator('.m-actionbar')).toHaveCount(0);
  });
});
