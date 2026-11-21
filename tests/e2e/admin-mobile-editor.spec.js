import { test, expect } from '@playwright/test';
import { mockAdmin, freezeBrowser, adminProduct, productsFixture } from './helpers/admin-mock.js';

// Product editor, add-product dialog and confirm/cutout dialogs on phone. The API is fully mocked
// (helpers/admin-mock.js); nothing here touches real inventory or publication.
const PHONES = [{ name: '375x812', width: 375, height: 812 }, { name: '360x740', width: 360, height: 740 }];
const PHOTO_A = '/media/00000000-0000-4000-8000-000000000001.png';
const PHOTO_B = '/media/00000000-0000-4000-8000-000000000002.png';
const withPhotos = () => productsFixture().map(p => (p.id === 'p-1' ? adminProduct({ photos: [PHOTO_A, PHOTO_B] }) : p));

async function openCatalog(page, opts = {}) {
  await freezeBrowser(page);
  const state = await mockAdmin(page, { products: withPhotos(), ...opts });
  await page.goto('/admin/catalog');
  await expect(page.locator('.catalog-table tbody tr').first()).toBeVisible();
  return state;
}
async function openEditor(page, name = /^Редагувати/, index = 0) {
  await page.getByRole('button', { name }).nth(index).click();
  const dialog = page.getByRole('dialog', { name: 'Створіть свою версію' });
  await expect(dialog).toBeVisible();
  return dialog;
}
const metrics = page => page.evaluate(() => ({ sw: document.documentElement.scrollWidth, iw: window.innerWidth }));
const box = async locator => { const b = await locator.boundingBox(); expect(b, 'visible').not.toBeNull(); return b; };
const expect44 = async (locator, what) => {
  const n = await locator.count(); expect(n, `${what} count`).toBeGreaterThan(0);
  for (let i = 0; i < n; i += 1) { const b = await box(locator.nth(i)); expect(b.height, `${what} ${i} height`).toBeGreaterThanOrEqual(43.9); expect(b.width, `${what} ${i} width`).toBeGreaterThanOrEqual(43.9); }
};
const expectHeight44 = async (locator, what) => {
  const n = await locator.count(); expect(n, `${what} count`).toBeGreaterThan(0);
  for (let i = 0; i < n; i += 1) expect((await box(locator.nth(i))).height, `${what} ${i}`).toBeGreaterThanOrEqual(43.9);
};
const fontSize = locator => locator.evaluate(el => parseFloat(getComputedStyle(el).fontSize));
const tab = (dialog, name) => dialog.getByRole('tab', { name });
const saveCall = state => state.calls.filter(c => c.method === 'PATCH' && c.path === '/products/p-1');

// Save through the real form; returns the request body that reached the mock API.
async function saveEdited(page) {
  const state = await openCatalog(page);
  const dialog = await openEditor(page);
  await dialog.getByLabel('Назва', { exact: true }).fill('Футболка Lorem нова');
  await dialog.getByRole('button', { name: /Зберегти зміни/ }).click();
  await expect.poll(() => saveCall(state).length).toBe(1);
  return saveCall(state)[0].body;
}

test.describe('save request is identical on phone and desktop', () => {
  let desktopBody;
  test('desktop 1280x800 reference body', async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 800 });
    desktopBody = await saveEdited(page);
    expect(Object.keys(desktopBody)).toContain('markupValue');
    expect(desktopBody.markupValue).toBe(0);
    expect(desktopBody.title).toBe('Футболка Lorem нова');
  });
  test('phone 375x812 body equals the desktop body byte for byte', async ({ page }) => {
    test.skip(!desktopBody, 'reference body missing');
    await page.setViewportSize({ width: 375, height: 812 });
    const body = await saveEdited(page);
    expect(JSON.stringify(body)).toBe(JSON.stringify(desktopBody));
  });
});

for (const viewport of PHONES) {
  test.describe(`phone editor ${viewport.name}`, () => {
    test.use({ viewport: { width: viewport.width, height: viewport.height } });

    test('full-screen sheet, one 44px tab row, body scrolls between header and footer', async ({ page }) => {
      await openCatalog(page);
      const dialog = await openEditor(page);
      const sheet = await box(dialog);
      expect(sheet).toMatchObject({ x: 0, y: 0, width: viewport.width, height: viewport.height });
      const header = await box(dialog.locator('.modal-header')), footer = await box(dialog.locator('.modal-footer'));
      expect(header.y).toBe(0);
      expect(Math.round(footer.y + footer.height)).toBe(viewport.height);
      const tabs = dialog.getByRole('tab');
      await expect(tabs).toHaveCount(4);
      const first = await box(tabs.first());
      for (let i = 0; i < 4; i += 1) { const b = await box(tabs.nth(i)); expect(b.y, `tab ${i} on the same row`).toBeCloseTo(first.y, 0); expect(b.height).toBeGreaterThanOrEqual(43.9); }
      const scroller = dialog.locator('.editor-scroll');
      const s = await box(scroller);
      expect(s.y).toBeGreaterThanOrEqual(first.y + 43);
      expect(s.y + s.height).toBeLessThanOrEqual(footer.y + 1);
      expect(await scroller.evaluate(el => ({ ov: getComputedStyle(el).overflowY, grew: el.scrollHeight > el.clientHeight }))).toMatchObject({ ov: 'auto', grew: true });
      const m = await metrics(page);
      expect(m.sw).toBeLessThanOrEqual(m.iw);
    });

    test('content tab: single-column rows, input types and 16px inputs', async ({ page }) => {
      await openCatalog(page);
      const dialog = await openEditor(page);
      const title = await box(dialog.getByLabel('Назва', { exact: true })), category = await box(dialog.getByLabel('Категорія'));
      expect(category.x).toBeCloseTo(title.x, 0);
      expect(category.y).toBeGreaterThan(title.y + title.height - 1);
      const type = dialog.getByLabel('Тип націнки'), value = dialog.getByLabel('Різниця до закупівлі, ₴');
      const t = await box(type), v = await box(value);
      expect(v.x).toBeCloseTo(t.x, 0); expect(v.y).toBeGreaterThan(t.y + t.height - 1);
      await expect(value).toHaveAttribute('type', 'number');
      await expect(value).toHaveAttribute('inputmode', 'decimal');
      const override = dialog.getByLabel('Ручна ціна, ₴');
      await expect(override).toHaveAttribute('type', 'text');
      await expect(override).toHaveAttribute('inputmode', 'decimal');
      for (const control of [dialog.getByLabel('Назва', { exact: true }), dialog.getByLabel('Категорія'), type, value, override, dialog.getByLabel('Опис')]) expect(await fontSize(control)).toBeGreaterThanOrEqual(16);
      await expectHeight44(dialog.locator('.classification-controls .button'), 'classification buttons');
      await expectHeight44(dialog.locator('.price-override .button'), 'price override reset');
      await expectHeight44(dialog.locator('.variant-controls label'), 'size checkbox rows');
      const m = await metrics(page);
      expect(m.sw).toBeLessThanOrEqual(m.iw);
    });

    test('promo and seo tabs: single column, datetime-local kept, slug hints', async ({ page }) => {
      await openCatalog(page);
      const dialog = await openEditor(page);
      await tab(dialog, 'Промо').click();
      const start = dialog.getByLabel('Початок акції'), end = dialog.getByLabel('Завершення акції');
      await expect(start).toHaveAttribute('type', 'datetime-local');
      await expect(end).toHaveAttribute('type', 'datetime-local');
      const a = await box(start), b = await box(end);
      expect(b.x).toBeCloseTo(a.x, 0); expect(b.y).toBeGreaterThan(a.y + a.height - 1);
      expect(await fontSize(start)).toBeGreaterThanOrEqual(16);
      expect((await metrics(page)).sw).toBeLessThanOrEqual(viewport.width);
      await tab(dialog, 'SEO').click();
      const slug = dialog.getByLabel('Адреса товару (slug)');
      await expect(slug).toHaveAttribute('autocapitalize', 'none');
      await expect(slug).toHaveAttribute('autocorrect', 'off');
      await expect(slug).toHaveAttribute('spellcheck', 'false');
      expect(await fontSize(slug)).toBeGreaterThanOrEqual(16);
      expect((await metrics(page)).sw).toBeLessThanOrEqual(viewport.width);
    });

    test('photos tab: two columns, 44x44 reorder buttons, cutout controls 44px', async ({ page }) => {
      await openCatalog(page);
      const dialog = await openEditor(page);
      await tab(dialog, 'Фото').click();
      const items = dialog.locator('.photo-editor-item');
      await expect(items).toHaveCount(2);
      const one = await box(items.nth(0)), two = await box(items.nth(1));
      expect(two.y).toBeCloseTo(one.y, 0); expect(two.x).toBeGreaterThan(one.x + one.width - 1);
      await expect44(dialog.locator('.photo-editor-item .icon-button'), 'reorder button');
      await expectHeight44(dialog.locator('.cutout-actions .button'), 'cutout action');
      expect((await metrics(page)).sw).toBeLessThanOrEqual(viewport.width);
    });

    test('footer: save full width, cancel and delete share a row, note hidden, publish control above the footer', async ({ page }) => {
      await openCatalog(page);
      const dialog = await openEditor(page);
      const footer = await box(dialog.locator('.modal-footer'));
      const save = await box(dialog.getByRole('button', { name: /Зберегти зміни/ })), cancel = await box(dialog.getByRole('button', { name: 'Скасувати' })), del = await box(dialog.getByRole('button', { name: 'Видалити товар' }));
      expect(save.width).toBeGreaterThan(footer.width - 2 * 16 - 1);
      expect(cancel.y).toBeCloseTo(del.y, 0);
      expect(save.y).toBeGreaterThan(cancel.y + cancel.height - 1);
      for (const b of [save, cancel, del]) expect(b.height).toBeGreaterThanOrEqual(43.9);
      await expect(dialog.locator('.save-note')).toBeHidden();
      const publish = dialog.locator('.publish-control');
      await expect(publish).toBeVisible();
      const p = await box(publish);
      expect(p.y + p.height).toBeLessThanOrEqual(footer.y + 1);
      expect(p.height).toBeGreaterThanOrEqual(43.9);
    });

    test('manual supplier product: Джерело tab stays in the same scroll row, fields at 16px', async ({ page }) => {
      await openCatalog(page);
      const dialog = await openEditor(page, /^Редагувати/, 3);
      const tabs = dialog.getByRole('tab');
      await expect(tabs).toHaveCount(5);
      const first = await box(tabs.first()), last = await box(tabs.last());
      expect(last.y).toBeCloseTo(first.y, 0);
      await tab(dialog, 'Джерело').click();
      const cost = dialog.getByLabel('Закупівля, ₴');
      await expect(cost).toHaveAttribute('inputmode', 'decimal');
      expect(await fontSize(cost)).toBeGreaterThanOrEqual(16);
      await expect(dialog.getByLabel('Кількість 1')).toHaveAttribute('inputmode', 'numeric');
      expect((await metrics(page)).sw).toBeLessThanOrEqual(viewport.width);
    });

    test('delete confirmation: sheet with 44px buttons, one dialog, Escape and focus trap unchanged', async ({ page }) => {
      await openCatalog(page);
      const editor = await openEditor(page);
      await editor.getByRole('button', { name: 'Видалити товар' }).click();
      const dialog = page.getByRole('dialog', { name: 'Видалити товар?' });
      await expect(dialog).toBeVisible();
      await expect(page.getByRole('dialog')).toHaveCount(1);
      const d = await box(dialog);
      expect(d.x).toBe(0); expect(d.width).toBe(viewport.width);
      expect(Math.round(d.y + d.height)).toBe(viewport.height);
      await expect(dialog.getByRole('button', { name: 'Скасувати' })).toBeFocused();
      await expectHeight44(dialog.getByRole('button', { name: /Скасувати|Видалити товар$/ }), 'confirm button');
      await expect44(dialog.getByRole('button', { name: 'Закрити підтвердження' }), 'confirm close');
      await page.keyboard.press('Tab'); await page.keyboard.press('Tab'); await page.keyboard.press('Tab');
      expect(await page.evaluate(() => !!document.activeElement.closest('[role="dialog"]'))).toBe(true);
      expect((await metrics(page)).sw).toBeLessThanOrEqual(viewport.width);
      await page.keyboard.press('Escape');
      await expect(page.getByRole('dialog')).toHaveCount(0);
    });

    test('add product dialog: no h-scroll, single column rows, 44px footer buttons and inputs at 16px', async ({ page }) => {
      await openCatalog(page);
      await page.getByRole('button', { name: /Додати товар/ }).first().click();
      const dialog = page.getByRole('dialog', { name: 'Додати товар' });
      await expect(dialog).toBeVisible();
      expect(await box(dialog)).toMatchObject({ x: 0, width: viewport.width });
      const price = dialog.getByLabel(/^Ціна на сайті/), cost = dialog.getByLabel(/^Закупівля/);
      const a = await box(price), b = await box(cost);
      expect(b.x).toBeCloseTo(a.x, 0); expect(b.y).toBeGreaterThan(a.y + a.height - 1);
      await expect(price).toHaveAttribute('inputmode', 'decimal');
      await expect(dialog.getByLabel('Кількість 1')).toHaveAttribute('inputmode', 'numeric');
      for (const control of [price, cost, dialog.getByLabel('Назва', { exact: true }), dialog.getByLabel('Категорія')]) expect(await fontSize(control)).toBeGreaterThanOrEqual(16);
      await expectHeight44(dialog.locator('.modal-footer .button'), 'add product footer button');
      await expect44(dialog.getByRole('button', { name: 'Закрити додавання товару' }), 'close');
      await dialog.getByRole('button', { name: /Додати розмір/ }).click();
      await expectHeight44(dialog.locator('.size-row > button'), 'remove size');
      expect((await metrics(page)).sw).toBeLessThanOrEqual(viewport.width);
    });

    test('batch cutout panel: 44px controls', async ({ page }) => {
      await openCatalog(page);
      await page.getByRole('checkbox', { name: 'Обрати Футболка Lorem' }).check();
      const more = page.getByRole('button', { name: 'Ще дії' });
      if (await more.isVisible()) await more.click();
      await page.getByRole('button', { name: /^Видалити фон \(1\)/ }).click();
      const panel = page.locator('.batch-cutout');
      await expect(panel).toBeVisible();
      await expectHeight44(panel.getByRole('button'), 'batch cutout button');
      await expectHeight44(panel.locator('label:has(input)'), 'batch toggle');
      expect((await metrics(page)).sw).toBeLessThanOrEqual(viewport.width);
    });
  });
}

test.describe('tablet editor 768x1024', () => {
  test.use({ viewport: { width: 768, height: 1024 } });
  test('44px targets and no page h-scroll; tabs and reorder keep today layout', async ({ page }) => {
    await openCatalog(page);
    const dialog = await openEditor(page);
    await expectHeight44(dialog.getByRole('tab'), 'tab');
    await expectHeight44(dialog.locator('.modal-footer .button, .modal-footer .text-button'), 'footer button');
    await tab(dialog, 'Фото').click();
    await expect44(dialog.locator('.photo-editor-item .icon-button'), 'reorder button');
    expect((await metrics(page)).sw).toBeLessThanOrEqual(768);
  });
});
