import { test, expect } from '@playwright/test';
import { mockAdmin, freezeBrowser } from './helpers/admin-mock.js';

// Internal manager tags: chips on rows, filter, sort and the editor field. Mocked API.
test.use({ viewport: { width: 1440, height: 900 }, reducedMotion: 'reduce' });
const titles = page => page.locator('table.catalog-table tbody tr strong:first-child').allTextContents();

test('tags show on rows, filter and sort the catalog, and save from the editor', async ({ page }) => {
  await freezeBrowser(page);
  const state = await mockAdmin(page);
  await page.goto('/admin/catalog');
  await expect(page.getByText('Футболка Lorem').first()).toBeVisible();
  const hoodie = page.getByRole('row', { name: /Худі Adipisci/ });
  await expect(hoodie.locator('.internal-tag')).toHaveText(['Потрібне нове фото', 'promoted']);

  await page.getByLabel('Внутрішня мітка').selectOption('Потрібне нове фото');
  await expect(page.locator('table.catalog-table tbody tr')).toHaveCount(1);
  await page.getByLabel('Внутрішня мітка').selectOption({ label: 'Без міток' });
  await expect(hoodie).toHaveCount(0);
  await page.getByLabel('Внутрішня мітка').selectOption('');

  await page.getByLabel('Сортування каталогу').selectOption('tags');
  expect((await titles(page))[0]).toMatch(/^Худі Adipisci/);

  await page.getByRole('row', { name: /Футболка Lorem/ }).getByRole('button', { name: /Редагувати/ }).click();
  const dialog = page.getByRole('dialog');
  const input = dialog.getByLabel('Внутрішні мітки');
  await input.fill('опис треба оновити');
  await input.press('Enter');
  await input.fill('promoted,');
  await expect(dialog.locator('.tag-editor .internal-tag')).toHaveText(['опис треба оновити×', 'promoted×']);
  await dialog.getByRole('button', { name: /Зберегти зміни/ }).click();
  const saves = () => state.calls.filter(c => c.method === 'PATCH' && c.path === '/products/p-1');
  await expect.poll(() => saves().length).toBe(1);
  expect(saves()[0].body.tags).toEqual(['опис треба оновити', 'promoted']);
});

test('bulk tagging adds and removes tags on the selected products', async ({ page }) => {
  await freezeBrowser(page);
  const state = await mockAdmin(page);
  await page.goto('/admin/catalog');
  await page.getByLabel('Обрати Футболка Lorem', { exact: true }).check();
  await page.getByLabel(/^Обрати Худі Adipisci/).check();
  await page.locator('.bulk-toolbar').getByRole('button', { name: 'Мітки…' }).click();
  const dialog = page.getByRole('dialog', { name: /Мітки для обраних товарів \(2\)/ });
  const trigger = page.locator('.bulk-toolbar').getByRole('button', { name: 'Мітки…' });
  await expect(dialog.getByLabel('Мітки, які додати')).toBeFocused();
  for (let i = 0; i < 12; i++) { await page.keyboard.press('Tab'); expect(await dialog.evaluate(el => el.contains(document.activeElement))).toBe(true); }
  await page.keyboard.press('Shift+Tab');
  expect(await dialog.evaluate(el => el.contains(document.activeElement))).toBe(true);
  await page.keyboard.press('Escape');
  await expect(dialog).toHaveCount(0);
  await expect(trigger).toBeFocused();
  await trigger.click();
  await dialog.getByLabel('Мітки, які додати').fill('нова колекція');
  await dialog.getByLabel('Мітки, які додати').press('Enter');
  await dialog.getByRole('button', { name: 'Додати до 2' }).click();
  const calls = () => state.calls.filter(c => c.method === 'POST' && c.path === '/products/bulk-tags');
  await expect.poll(() => calls().length).toBe(1);
  expect(calls()[0].body).toEqual({ ids: ['p-1', 'p-2'], add: ['нова колекція'] });
  await expect(dialog).toHaveCount(0);
  await expect(trigger).toBeFocused();

  await page.locator('.bulk-toolbar').getByRole('button', { name: 'Мітки…' }).click();
  await page.getByRole('dialog').getByLabel('Прибрати').check();
  await page.getByRole('dialog').getByRole('button', { name: '+ promoted' }).click();
  await page.getByRole('dialog').getByRole('button', { name: 'Прибрати з 2' }).click();
  await expect.poll(() => calls().length).toBe(2);
  expect(calls()[1].body).toEqual({ ids: ['p-1', 'p-2'], remove: ['promoted'] });
});

test('editor save without tag edits does not send tags (cannot undo a bulk change)', async ({ page }) => {
  await freezeBrowser(page);
  const state = await mockAdmin(page);
  await page.goto('/admin/catalog');
  await page.getByRole('row', { name: /Худі Adipisci/ }).getByRole('button', { name: /Редагувати/ }).click();
  const dialog = page.getByRole('dialog');
  await dialog.getByLabel('Назва', { exact: true }).fill('Худі нове');
  await dialog.getByRole('button', { name: /Зберегти зміни/ }).click();
  const saves = () => state.calls.filter(c => c.method === 'PATCH' && c.path === '/products/p-2');
  await expect.poll(() => saves().length).toBe(1);
  expect(saves()[0].body).not.toHaveProperty('tags');
});
