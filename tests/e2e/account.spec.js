import { test, expect } from '@playwright/test';

const signedOut = { authenticated: false };
const mockSession = (page, body) => page.route('**/api/account/session', r => r.fulfill({ json: body }));

test('signed-out account page offers Google sign-in and navigates to the mocked URL', async ({ page }) => {
  await mockSession(page, signedOut);
  let body;
  await page.route('**/api/account/google/start', async r => {
    body = r.request().postData();
    await r.fulfill({ json: { authorizationUrl: 'http://127.0.0.1:1/mock-google' } });
  });
  await page.route('http://127.0.0.1:1/**', r => r.fulfill({ contentType: 'text/html', body: 'mock google' }));
  await page.goto('/account');
  const button = page.getByRole('button', { name: 'Увійти через Google' });
  await expect(button).toBeVisible();
  await button.click();
  await page.waitForURL('http://127.0.0.1:1/mock-google');
  expect(JSON.parse(body)).toEqual({});
});

test('sign-in start failures show friendly messages', async ({ page }) => {
  await mockSession(page, signedOut);
  await page.route('**/api/account/google/start', r => r.fulfill({ status: 503, json: { error: 'x' } }));
  await page.goto('/account');
  await page.getByRole('button', { name: 'Увійти через Google' }).click();
  await expect(page.getByRole('alert')).toContainText('тимчасово недоступний');
  await page.unroute('**/api/account/google/start');
  await page.route('**/api/account/google/start', r => r.fulfill({ status: 429, headers: { 'Retry-After': '30' }, json: { error: 'x' } }));
  await page.getByRole('button', { name: 'Увійти через Google' }).click();
  await expect(page.getByRole('alert')).toContainText('30');
});

for (const [query, text] of [
  ['status=signed-in', 'успішно увійшли'],
  ['status=error&reason=invalid', 'Не вдалося підтвердити'],
  ['status=error&reason=expired', 'Час входу минув'],
  ['status=error&reason=denied', 'скасовано'],
]) {
  test(`callback ${query} shows a message and cleans the URL`, async ({ page }) => {
    await mockSession(page, query === 'status=signed-in'
      ? { authenticated: true, customer: { id: 'c1', displayName: 'Олена', signInEmail: 'olena@example.com', providers: ['google'], createdAt: '2026-01-01' } }
      : signedOut);
    await page.goto(`/account?${query}`);
    await expect(page.getByText(text)).toBeVisible();
    await expect(page).toHaveURL(/\/account$/);
  });
}

test('signed-in summary offers logout and confirmed revoke-all', async ({ page }) => {
  await mockSession(page, { authenticated: true, customer: { id: 'c1', displayName: 'Олена', signInEmail: 'olena@example.com', providers: ['google'], createdAt: '2026-01-01' } });
  await page.route('**/api/account/sessions/revoke-all', r => r.fulfill({ json: { revoked: 2 } }));
  await page.goto('/account');
  await expect(page.getByText('olena@example.com')).toBeVisible();
  await expect(page.getByRole('link', { name: /Кабінет/ })).toHaveAttribute('href', '/account');
  await page.getByRole('button', { name: 'Вийти на всіх пристроях' }).click();
  await page.getByRole('dialog').getByRole('button', { name: 'Вийти всюди' }).click();
  await expect(page.getByText('Ви вийшли на всіх пристроях.')).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Увійти' })).toBeFocused();
  await expect(page.getByRole('button', { name: 'Увійти через Google' })).toBeVisible();
});

test('header entry points to /account, signed out and in, and fits a 390px viewport', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 800 });
  await mockSession(page, signedOut);
  await page.goto('/');
  // Phone: the account entry lives in the header menu.
  await page.getByRole('button', { name: 'Меню' }).first().click();
  const link = page.getByRole('navigation', { name: 'Головна навігація' }).getByRole('link', { name: 'Увійти' });
  await expect(link).toBeVisible();
  await expect(link).toHaveAttribute('href', '/account');
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  await page.unroute('**/api/account/session');
  await mockSession(page, { authenticated: true, customer: { id: 'c1', displayName: null, signInEmail: 'a@b.c', providers: ['google'], createdAt: '2026-01-01' } });
  await page.goto('/');
  await page.getByRole('button', { name: 'Меню' }).first().click();
  await expect(page.getByRole('link', { name: /Кабінет/ })).toHaveAttribute('href', '/account');
  await expect(page.locator('a[href="/admin"], a[href^="/admin/"]')).toHaveCount(0);
});

test('plain logout returns to the sign-in card', async ({ page }) => {
  await mockSession(page, { authenticated: true, customer: { id: 'c1', displayName: null, signInEmail: 'a@b.c', providers: ['google'], createdAt: '2026-01-01' } });
  let called = false;
  await page.route('**/api/account/logout', r => { called = true; r.fulfill({ json: { authenticated: false } }); });
  await page.goto('/account');
  await page.getByRole('button', { name: 'Вийти', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Увійти через Google' })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Увійти' })).toBeFocused();
  expect(called).toBe(true);
});

test('network error on start shows a connection message', async ({ page }) => {
  await mockSession(page, signedOut);
  await page.route('**/api/account/google/start', r => r.abort());
  await page.goto('/account');
  await page.getByRole('button', { name: 'Увійти через Google' }).click();
  await expect(page.getByRole('alert')).toContainText('зв’язку');
  await expect(page.getByRole('button', { name: 'Увійти через Google' })).toBeEnabled();
});

test('session 500 shows a notice and still offers sign-in', async ({ page }) => {
  await page.route('**/api/account/session', r => r.fulfill({ status: 500, json: { error: 'x' } }));
  await page.goto('/account');
  await expect(page.getByRole('alert')).toContainText('перевірити сесію');
  await expect(page.getByRole('button', { name: 'Увійти через Google' })).toBeVisible();
});
