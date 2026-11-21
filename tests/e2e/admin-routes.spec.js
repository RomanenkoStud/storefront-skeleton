import { test, expect } from '@playwright/test';

test('each admin tool has its own URL: deep link, navigation, back/forward and fallback', async ({ page }) => {
  await page.goto('/admin/suppliers');
  await expect(page.getByRole('heading', { level: 1, name: 'Постачальники' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Постачальники', exact: true })).toHaveAttribute('aria-current', 'page');

  await page.getByRole('button', { name: 'Синхронізація', exact: true }).click();
  await expect(page).toHaveURL(/\/admin\/sync$/);
  await expect(page.getByRole('heading', { level: 1, name: 'Історія синхронізації' })).toBeVisible();

  await page.getByRole('button', { name: 'Журнал дій', exact: true }).click();
  await expect(page).toHaveURL(/\/admin\/audit$/);

  await page.goBack();
  await expect(page).toHaveURL(/\/admin\/sync$/);
  await expect(page.getByRole('heading', { level: 1, name: 'Історія синхронізації' })).toBeVisible();
  await page.goBack();
  await expect(page.getByRole('heading', { level: 1, name: 'Постачальники' })).toBeVisible();
  await page.goForward();
  await expect(page.getByRole('heading', { level: 1, name: 'Історія синхронізації' })).toBeVisible();

  await page.reload();
  await expect(page.getByRole('heading', { level: 1, name: 'Історія синхронізації' })).toBeVisible();

  await page.getByRole('button', { name: 'Дублікати', exact: true }).click();
  await expect(page).toHaveURL(/\/admin\/duplicates$/);

  await page.goto('/admin/team');
  await expect(page.getByRole('heading', { level: 1, name: 'Команда' })).toBeVisible();

  await page.goto('/admin/no-such-tool');
  await expect(page).toHaveURL(/\/admin\/catalog$/);
  await expect(page.getByRole('heading', { level: 1, name: 'Ваша добірка' })).toBeVisible();
});

test('staff tool URLs never authenticate through the Access dev bypass', async ({ page }) => {
  await page.goto('/staff/orders');
  await expect(page.getByRole('heading', { name: 'Вхід для команди' })).toBeVisible();
  await expect(page).toHaveURL(/\/staff\/orders$/);
});
