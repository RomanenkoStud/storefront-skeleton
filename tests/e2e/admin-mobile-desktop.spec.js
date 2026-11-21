import { test, expect } from '@playwright/test';
import { mockAdmin, freezeBrowser } from './helpers/admin-mock.js';

// Desktop parity gate. Baselines in admin-mobile-desktop.spec.js-snapshots/ were captured on the
// base revision before any mobile CSS or JSX existed; the mobile tasks must never update them. Mocked API, fixed
// Date, blocked web fonts, disabled animations: no pixel may differ by more than the 0.02 YIQ threshold (Chromium varies box-shadow edges by 1/255 between runs; any layout, colour or text change is far above it).
const SHOT = { fullPage: true, animations: 'disabled', caret: 'hide', maxDiffPixels: 0, threshold: 0.02 };
const VIEWPORTS = [{ name: '1440', width: 1440, height: 900 }, { name: '1024', width: 1024, height: 768 }];
const TOOLS = [
  ['catalog', 'Ваша добірка'], ['suppliers', 'Постачальники'], ['sync', 'Історія синхронізації'], ['duplicates', 'Дублікати між постачальниками'],
  ['recognition', 'Правила розпізнавання'], ['storefront', 'Історія синхронізації'], ['team', 'Команда'], ['audit', 'Журнал дій'], ['orders', 'Замовлення'],
];

// The shell reloads the catalog in the background; the refresh button is disabled until that settles.
const settled = async page => {
  await expect(page.getByRole('button', { name: 'Оновити', exact: true }).first()).toBeEnabled();
  await page.evaluate(() => document.fonts.ready);
};
const shot = async (page, name) => { await settled(page); await expect(page).toHaveScreenshot(name, SHOT); };

for (const vp of VIEWPORTS) {
  test.describe(`desktop parity ${vp.name}`, () => {
    test.use({ viewport: { width: vp.width, height: vp.height }, reducedMotion: 'reduce' });
    test.beforeEach(async ({ page }) => { await freezeBrowser(page); await mockAdmin(page); });

    for (const [segment, heading] of TOOLS) {
      test(`tool ${segment}`, async ({ page }) => {
        await page.goto(`/admin/${segment}`);
        await expect(page.getByRole('heading', { level: 1, name: heading })).toBeVisible();
        await expect(page.getByText(/^(Завантажуємо|Шукаємо|Перевіряємо)/)).toHaveCount(0);
        if (segment === 'catalog') await expect(page.getByText('Футболка Lorem').first()).toBeVisible();
        if (segment === 'orders') await expect(page.getByRole('button', { name: 'SS-7K2M-9QXD' })).toBeVisible();
        if (segment === 'team') await expect(page.getByText('Менеджер Олена').first()).toBeVisible();
        if (segment === 'audit') await expect(page.getByText('p-3').first()).toBeVisible();
        if (segment === 'storefront') await expect(page.getByLabel('Показувати біжучий рядок')).toBeVisible();
        await shot(page, `${vp.name}-${segment}.png`);
      });
    }

    test('catalog with a selection (bulk toolbar)', async ({ page }) => {
      await page.goto('/admin/catalog');
      await page.getByLabel('Обрати Футболка Lorem', { exact: true }).check();
      await expect(page.getByText(/Обрано/).first()).toBeVisible();
      await shot(page, `${vp.name}-catalog-selected.png`);
    });

    test('catalog trash view', async ({ page }) => {
      await page.goto('/admin/catalog');
      await page.getByRole('button', { name: /^Кошик товарів/ }).click();
      await shot(page, `${vp.name}-catalog-trash.png`);
    });

    for (const [tab, product] of [['Основне', 'Футболка Lorem'], ['Фото', 'Футболка Lorem'], ['Промо', 'Футболка Lorem'], ['SEO', 'Футболка Lorem'], ['Джерело', 'Куртка власна']]) {
      test(`editor tab ${tab}`, async ({ page }) => {
        await page.goto('/admin/catalog');
        await page.getByRole('row', { name: new RegExp(product) }).getByRole('button', { name: /^Редагувати/ }).click();
        const dialog = page.getByRole('dialog');
        await expect(dialog).toBeVisible();
        await dialog.getByRole('tab', { name: tab }).click();
        await shot(page, `${vp.name}-editor-${tab}.png`);
      });
    }

    for (const tab of ['Бренди', 'Правила категорій', 'Дерево категорій', 'Історія']) {
      test(`recognition tab ${tab}`, async ({ page }) => {
        await page.goto('/admin/recognition');
        await page.getByRole('tab', { name: new RegExp(tab) }).click();
        await expect(page.getByRole('tab', { name: new RegExp(tab) })).toHaveAttribute('aria-selected', 'true');
        await shot(page, `${vp.name}-recognition-${tab}.png`);
      });
    }

    for (const view of ['groups', 'rejections']) {
      test(`duplicates ${view}`, async ({ page }) => {
        await page.goto('/admin/duplicates');
        await page.getByRole('tab', { name: view === 'groups' ? /Підтверджені групи/ : /Різні товари/ }).click();
        await shot(page, `${vp.name}-duplicates-${view}.png`);
      });
    }

    test('order detail', async ({ page }) => {
      await page.goto('/admin/orders');
      await page.getByRole('button', { name: 'SS-7K2M-9QXD' }).click();
      await expect(page.getByRole('region', { name: /Постачальник Lorem Supply/ })).toBeVisible();
      await shot(page, `${vp.name}-order-detail.png`);
    });
  });
}
