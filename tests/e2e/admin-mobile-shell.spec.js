import { test, expect } from '@playwright/test';
import { mockAdmin, freezeBrowser, MANAGER_PERMISSIONS } from './helpers/admin-mock.js';

// Mobile manager shell: phone layout at 375x812 and 360x740, tablet touch targets, staff revoke-all, modal sheet.
// The API is fully mocked (helpers/admin-mock.js); nothing here touches real inventory or publication.
const PHONES = [{ name: '375x812', width: 375, height: 812 }, { name: '360x740', width: 360, height: 740 }];
const ROUTES = [
  { path: '/admin/catalog', staff: false, h1: 'Ваша добірка' },
  { path: '/admin/suppliers', staff: false, h1: 'Постачальники' },
  { path: '/admin/orders', staff: false, h1: 'Замовлення' },
  { path: '/staff/orders', staff: true, h1: 'Замовлення' },
];
const NAV = 'nav[aria-label="Розділи кабінету"]';
const ALL_TOOLS = ['Каталог', 'Постачальники', 'Синхронізація', 'Дублікати', 'Правила розпізнавання', 'Вітрина', 'Команда', 'Журнал дій', 'Замовлення'];

async function open(page, route, opts = {}) {
  await freezeBrowser(page);
  await mockAdmin(page, { staff: route.staff, ...opts });
  await page.goto(route.path);
  await expect(page.getByRole('heading', { level: 1, name: route.h1 })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Оновити', exact: true }).first()).toBeEnabled();
}

// Visible shell controls that are smaller than the touch target, or inputs that would trigger iOS focus zoom.
const audit = page => page.evaluate(() => {
  const visible = el => { const r = el.getBoundingClientRect(), s = getComputedStyle(el); return r.width > 1 && r.height > 1 && s.visibility !== 'hidden' && s.display !== 'none'; };
  const label = el => `${el.tagName.toLowerCase()}${el.className ? '.' + String(el.className).trim().split(/\s+/).join('.') : ''} "${(el.getAttribute('aria-label') || el.textContent || el.getAttribute('placeholder') || '').trim().slice(0, 40)}"`;
  const textLike = el => el.matches('input') && !['checkbox', 'radio', 'file', 'hidden', 'range', 'button', 'submit'].includes(el.type);
  const controls = [...document.querySelectorAll('.admin-shell button, .admin-shell select, .admin-shell input, .admin-shell textarea')].filter(el => visible(el) && (!el.matches('input') || textLike(el)));
  return {
    small: controls.filter(el => !el.matches('textarea') && el.getBoundingClientRect().height < 43.99).map(el => `${label(el)} ${Math.round(el.getBoundingClientRect().height * 10) / 10}px`),
    zoom: controls.filter(el => el.matches('input, select, textarea') && parseFloat(getComputedStyle(el).fontSize) < 16).map(el => `${label(el)} ${getComputedStyle(el).fontSize}`),
    count: controls.length,
  };
});

for (const viewport of PHONES) {
  test.describe(`phone shell ${viewport.name}`, () => {
    test.use({ viewport: { width: viewport.width, height: viewport.height } });

    for (const route of ROUTES) {
      test(`${route.path}: no page h-scroll, 44px controls, 1rem inputs, strip, heading`, async ({ page }) => {
        await open(page, route);
        const scroll = await page.evaluate(() => ({ sw: document.documentElement.scrollWidth, iw: window.innerWidth }));
        expect(scroll.sw, 'document scrollWidth').toBeLessThanOrEqual(scroll.iw);
        const result = await audit(page);
        expect(result.count).toBeGreaterThan(10);
        expect(result.small, 'controls under 44px').toEqual([]);
        expect(result.zoom, 'inputs under 16px').toEqual([]);
        // one horizontally scrollable 44px row under the top bar
        const nav = page.locator(NAV);
        const box = await nav.boundingBox();
        expect(Math.round(box.height)).toBe(44);
        const strip = await nav.evaluate(el => ({ overflowX: getComputedStyle(el).overflowX, scrolls: el.scrollWidth > el.clientWidth, tops: [...el.querySelectorAll('button')].map(b => Math.round(b.getBoundingClientRect().top)) }));
        expect(strip.overflowX).toBe('auto');
        expect(strip.scrolls).toBe(true);
        expect(new Set(strip.tops).size, 'all nav buttons on one row').toBe(1);
        const bar = await page.locator('.admin-topbar').boundingBox();
        expect(bar.y).toBeLessThan(box.y);
        const h1 = await page.getByRole('heading', { level: 1 }).boundingBox();
        expect(h1.y).toBeLessThan(180);
        await expect(page.locator('.admin-footer')).toBeHidden();
        await expect(page.locator('.admin-main .section-heading .eyebrow')).toBeHidden();
        const heading = await page.locator('.admin-main .section-heading h1').evaluate(el => ({ size: getComputedStyle(el).fontSize, lines: Math.round(el.getBoundingClientRect().height / parseFloat(getComputedStyle(el).lineHeight)) }));
        expect(heading.size).toBe('24px');
        expect(heading.lines).toBeLessThanOrEqual(2);
        // revoke-all exists only for staff
        const revoke = page.getByRole('button', { name: 'Вийти на всіх пристроях' });
        if (route.staff) {
          await expect(revoke).toBeVisible();
          expect(Math.round((await revoke.boundingBox()).height)).toBeGreaterThanOrEqual(44);
        } else await expect(revoke).toHaveCount(0);
        await expect(page.getByRole('link', { name: /Переглянути сайт/ })).toBeVisible();
        await expect(page.getByRole('button', { name: 'Вийти', exact: true })).toBeVisible();
      });
    }

    test('every permitted tool is reachable by scrolling the strip; names and aria-current are kept', async ({ page }) => {
      await open(page, ROUTES[0], { permissions: MANAGER_PERMISSIONS });
      const nav = page.locator(NAV);
      const expected = ALL_TOOLS.filter(name => name !== 'Команда'); // manager has no staff.read
      await expect(nav.getByRole('button')).toHaveCount(expected.length);
      for (const name of expected) {
        const button = nav.getByRole('button', { name: new RegExp(`^${name}`) });
        await button.focus(); // keyboard focus scrolls the strip
        await expect.poll(() => button.evaluate(el => { const b = el.getBoundingClientRect(), n = el.closest('nav').getBoundingClientRect(); return b.left >= n.left - 1 && b.right <= n.right + 1; }), { message: `${name} fully inside the strip once focused` }).toBe(true);
      }
      await expect(nav.getByRole('button', { name: /^Каталог/ })).toHaveAttribute('aria-current', 'page');
    });

    test('the active tool is scrolled into view on load and on tool change', async ({ page }) => {
      await open(page, { path: '/admin/orders', staff: false, h1: 'Замовлення' });
      const active = page.locator(`${NAV} button.active`);
      await expect(active).toHaveText(/Замовлення/);
      await expect.poll(() => active.evaluate(el => { const b = el.getBoundingClientRect(), n = el.closest('nav').getBoundingClientRect(); return b.left >= n.left - 1 && b.right <= n.right + 1; })).toBe(true);
      expect(await page.evaluate(() => window.scrollY), 'the page itself does not jump').toBe(0);
      await page.locator(NAV).getByRole('button', { name: /^Каталог/ }).click();
      await expect(page.getByRole('heading', { level: 1, name: 'Ваша добірка' })).toBeVisible();
      await expect.poll(() => page.locator(`${NAV} button.active`).evaluate(el => { const b = el.getBoundingClientRect(), n = el.closest('nav').getBoundingClientRect(); return b.left >= n.left - 1 && b.right <= n.right + 1; })).toBe(true);
    });

    test('the top bar stays sticky while the page scrolls', async ({ page }) => {
      await open(page, ROUTES[1]);
      await page.evaluate(() => window.scrollTo(0, document.documentElement.scrollHeight));
      expect(await page.evaluate(() => window.scrollY)).toBeGreaterThan(100);
      const bar = await page.locator('.admin-topbar').boundingBox();
      expect(Math.round(bar.y)).toBe(0);
      const z = await page.locator('.admin-topbar').evaluate(el => getComputedStyle(el).zIndex);
      expect(z).toBe('50');
    });

    test('the product editor is a full-screen sheet above the sticky bar with 44px footer buttons', async ({ page }) => {
      await open(page, ROUTES[0]);
      await page.getByRole('button', { name: /^Редагувати/ }).first().click();
      const dialog = page.getByRole('dialog');
      await expect(dialog).toBeVisible();
      const modal = await page.locator('.admin-shell .modal').boundingBox();
      expect(Math.round(modal.height)).toBe(viewport.height);
      expect(Math.round(modal.width)).toBe(viewport.width);
      // the sheet, not the top bar, receives a tap at the top-left corner
      expect(await page.evaluate(() => document.elementFromPoint(20, 20).closest('.modal') !== null)).toBe(true);
      const footer = await dialog.locator('.modal-footer').boundingBox();
      expect(footer.y + footer.height, 'footer sits within the sheet').toBeLessThanOrEqual(viewport.height);
      const buttons = dialog.locator('.modal-footer button');
      for (let i = 0; i < await buttons.count(); i += 1) expect(Math.round((await buttons.nth(i).boundingBox()).height), `footer button ${i}`).toBeGreaterThanOrEqual(44);
      const scroll = await page.evaluate(() => ({ sw: document.documentElement.scrollWidth, iw: window.innerWidth }));
      expect(scroll.sw).toBeLessThanOrEqual(scroll.iw);
    });

    // Every admin dialog renders inside .admin-shell and must cover the sticky top bar (z-index 50), not sit under it.
    const dialogs = {
      'add product': async p => { await p.getByRole('button', { name: 'Додати товар' }).click(); },
      'confirm single delete': async p => { await p.getByRole('row', { name: /Футболка Lorem/ }).getByRole('button', { name: /^Видалити/ }).click(); },
      'confirm bulk publish': async p => { await p.getByLabel('Обрати Футболка Lorem', { exact: true }).check(); await p.getByRole('button', { name: 'Опублікувати обрані' }).click(); },
    };
    for (const [name, openDialog] of Object.entries(dialogs)) {
      test(`${name} dialog is a full-screen sheet above the sticky top bar`, async ({ page }) => {
        await open(page, ROUTES[0]);
        await openDialog(page);
        const dialog = page.getByRole('dialog');
        await expect(dialog).toBeVisible();
        await expect(dialog).toHaveCount(1);
        expect(await dialog.evaluate(el => !!el.closest('.admin-shell .modal-backdrop'))).toBe(true);
        const box = await dialog.boundingBox();
        expect(Math.round(box.height)).toBe(viewport.height);
        expect(Math.round(box.width)).toBe(viewport.width);
        expect(await page.evaluate(() => !!document.elementFromPoint(20, 20).closest('[role="dialog"]')), 'top-left corner belongs to the dialog').toBe(true);
        const buttons = dialog.getByRole('button');
        for (let i = 0; i < await buttons.count(); i += 1) {
          const button = buttons.nth(i);
          if (await button.isVisible()) expect(Math.round((await button.boundingBox()).height), `dialog button ${i}`).toBeGreaterThanOrEqual(44);
        }
        const scroll = await page.evaluate(() => ({ sw: document.documentElement.scrollWidth, iw: window.innerWidth }));
        expect(scroll.sw).toBeLessThanOrEqual(scroll.iw);
      });
    }
  });
}

// 645px sits in the 640-650px band where the old max-width 650px shell rules still apply (static nav) next to the tablet touch rules.
for (const width of [768, 645]) test.describe(`tablet ${width}px (today layout, 44px targets)`, () => {
  test.use({ viewport: { width, height: 1024 } });
  for (const route of ROUTES.slice(0, 3)) {
    test(`${route.path}: no h-scroll, 44px controls`, async ({ page }) => {
      await open(page, route);
      const scroll = await page.evaluate(() => ({ sw: document.documentElement.scrollWidth, iw: window.innerWidth }));
      expect(scroll.sw).toBeLessThanOrEqual(scroll.iw);
      if (width > 650) expect(await page.locator('.sidebar').evaluate(el => getComputedStyle(el).position)).toBe('fixed');
      expect(await page.locator('.admin-topbar').evaluate(el => getComputedStyle(el).position)).toBe('static');
      const result = await audit(page);
      expect(result.small, 'controls under 44px').toEqual([]);
    });
  }
});
