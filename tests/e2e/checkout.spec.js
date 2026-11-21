import { test, expect } from '@playwright/test';

// (three-part ПІБ). Three-step checkout. Fixtures only: products, session, profile, settings and checkout are mocked;
// the cart lives in this page's localStorage.
const lines = [
  { productId: 'ck1', slug: 'hoodie', size: 'M', quantity: 2, title: 'Худі', priceMinor: 150000, photo: null },
  { productId: 'ck2', slug: 'cap', size: 'L', quantity: 1, title: 'Кепка', priceMinor: 50000, photo: null },
];
const product = l => ({ id: l.productId, slug: l.slug, title: l.title, priceMinor: l.priceMinor, photos: [], variants: [{ size: l.size, stock: 9 }] });

async function mock(page, { signed = false, profile = null, prepaymentMinor = 20000 } = {}) {
  const sent = [];
  await page.route('**/api/products/*', r => { const slug = decodeURIComponent(new URL(r.request().url()).pathname.split('/').pop()); const l = lines.find(x => x.slug === slug); return l ? r.fulfill({ json: product(l) }) : r.fulfill({ status: 404, json: { error: 'not_found' } }); });
  await page.route('**/api/storefront', r => r.fulfill({ json: { campaign: null, ticker: { enabled: false, items: [] }, checkout: { prepaymentMinor } } }));
  await page.route('**/api/account/session', r => r.fulfill({ json: signed ? { authenticated: true, customer: { id: 'c', displayName: null, providers: ['google'] } } : { authenticated: false } }));
  await page.route('**/api/account/profile', r => r.fulfill({ json: profile ?? { displayName: null, phone: null, contactEmail: null, deliveryPreference: null, telegram: { linked: false }, updatedAt: null } }));
  await page.route('**/api/cart/checkout', async r => {
    const body = JSON.parse(r.request().postData());
    sent.push(body);
    const recipient = signed ? body.recipient ?? null : null;
    await r.fulfill({ status: 201, json: { cart: { code: 'SS-ABCD-2345', status: 'submitted', createdAt: '2026-11-19T10:00:00.000Z', itemCount: 3, totalMinor: 350000, currency: 'UAH', bound: signed, delivery: null, recipient, lines: body.lines.map(l => ({ ...l, title: lines.find(x => x.productId === l.productId).title })) } } });
  });
  await page.addInitScript(([k, v]) => { if (!localStorage.getItem(k)) localStorage.setItem(k, v); }, ['ls_cart_v1', JSON.stringify({ version: 1, lines, recent: [] })]);
  return sent;
}
const heading = page => page.getByRole('heading', { level: 1 });
const field = (scope, label) => scope.getByLabel(label, { exact: true });
async function fillName(scope, [last, first, middle]) {
  await field(scope, 'Прізвище').fill(last); await field(scope, 'Імʼя').fill(first); await field(scope, 'По батькові').fill(middle);
}
const steps = page => page.getByRole('navigation', { name: 'Етапи оформлення' });
const terms = page => page.getByRole('checkbox', { name: /Я приймаю умови оплати та доставки/ });
const buyerNotice = 'Лорем іпсум — тестовий текст попередження для покупця.';
const warning = page => page.getByRole('note', { name: 'Тестове попередження' });
// Another tab rewrites the cart: CartLink re-reads storage on a 'storage' event.
const otherTabWrites = (page, value) => page.evaluate(([k, v]) => { localStorage.setItem(k, v); window.dispatchEvent(new StorageEvent('storage', { key: k, newValue: v })); }, ['ls_cart_v1', value]);

test('anonymous: items with prepayment, recipient validation, back keeps state, submit sends no personal data', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 900 });
  const sent = await mock(page);
  await page.goto('/cart');
  await expect(heading(page)).toContainText('Ваш кошик');
  await expect(steps(page).locator('[aria-current="step"]')).toContainText('Кошик');
  await expect(page.locator('.checkout-prepay')).toContainText('Передоплата');
  await expect(page.locator('.checkout-prepay')).toContainText('200');
  await expect(page.locator('.checkout-prepay')).toContainText('Решта при отриманні');
  await expect(page.locator('.checkout-prepay')).toContainText(/3\s?300/);
  // a prominent buyer warning at the top of the items step (icon, headline, body), above the lines; navigation is not gated
  await expect(warning(page)).toBeVisible();
  await expect(warning(page).getByRole('heading', { level: 2 })).toHaveText('Тестове попередження');
  await expect(warning(page).locator('.checkout-warning-text')).toHaveText(buyerNotice);
  await expect(warning(page).locator('svg.checkout-warning-icon')).toHaveAttribute('aria-hidden', 'true');
  await expect(warning(page).getByRole('checkbox')).toHaveCount(0);
  expect(await page.evaluate(() => { const w = document.querySelector('.checkout-warning'), l = document.querySelector('.cart-lines'); return !!(w.compareDocumentPosition(l) & Node.DOCUMENT_POSITION_FOLLOWING); })).toBe(true);

  await page.getByRole('button', { name: 'Далі: отримувач' }).click();
  await expect(heading(page)).toContainText('Отримувач');
  await expect(heading(page)).toBeFocused();
  await expect(steps(page).locator('[aria-current="step"]')).toContainText('Отримувач');
  await expect(page.locator('.cart-lines')).toHaveCount(0);

  // three labelled required name inputs in order, then the phone
  expect(await page.locator('.checkout-recipient label').allTextContents()).toEqual(['Прізвище', 'Імʼя', 'По батькові', 'Мобільний телефон']);
  await page.getByRole('button', { name: 'Далі: доставка' }).click();
  await expect(field(page, 'Прізвище')).toBeFocused();
  for (const id of ['last-name', 'first-name', 'middle-name', 'phone']) await expect(page.locator(`#recipient-${id}`)).toHaveAttribute('aria-invalid', 'true');
  await expect(page.locator('#recipient-middle-name-error')).toContainText('Вкажіть по батькові');
  // per-field errors: a digit in the first name only flags that input, and it gets focus
  await fillName(page, ['Коваль', 'Олена1', 'Петрівна']);
  await page.getByRole('button', { name: 'Далі: доставка' }).click();
  await expect(field(page, 'Імʼя')).toBeFocused();
  await expect(field(page, 'Прізвище')).toHaveAttribute('aria-invalid', 'false');
  await expect(page.locator('#recipient-first-name-error')).toContainText('Вкажіть імʼя');
  await field(page, 'Імʼя').fill('Олена');
  await page.getByLabel('Мобільний телефон').fill('12345');
  await page.getByRole('button', { name: 'Далі: доставка' }).click();
  await expect(page.getByLabel('Мобільний телефон')).toBeFocused();
  await page.getByLabel('Мобільний телефон').fill('050 123 45 67');
  await page.getByLabel('Мобільний телефон').press('Enter');

  await expect(heading(page)).toContainText('Доставка');
  await expect(heading(page)).toBeFocused();
  await expect(page.locator('.checkout-recap')).toContainText('Отримувач: Коваль Олена Петрівна, +380 50 123 45 67');
  await page.getByRole('button', { name: 'Назад' }).click();
  await expect(field(page, 'Прізвище')).toHaveValue('Коваль'); await expect(field(page, 'По батькові')).toHaveValue('Петрівна');
  await steps(page).getByRole('button', { name: /Кошик/ }).click();
  await expect(heading(page)).toContainText('Ваш кошик');
  await page.getByRole('button', { name: 'Далі: отримувач' }).click();
  await expect(page.getByLabel('Мобільний телефон')).toHaveValue('050 123 45 67');
  await page.getByRole('button', { name: 'Далі: доставка' }).click();
  expect(await page.evaluate(() => localStorage.getItem('ls_cart_v1'))).not.toMatch(/Коваль|Петрівна|123 45 67/);
  await expect(page.getByRole('note')).toHaveCount(0);

  // the terms box is required, unticked by default; an unticked attempt sends nothing, shows an error and focuses the box
  await expect(terms(page)).not.toBeChecked();
  const link = page.getByRole('link', { name: /умови оплати та доставки/ });
  await expect(link).toHaveAttribute('href', '/#delivery'); await expect(link).toHaveAttribute('target', '_blank');
  await page.getByRole('button', { name: 'Отримати код кошика' }).click();
  await expect(terms(page)).toBeFocused();
  await expect(page.locator('#checkout-terms-error')).toHaveText('Щоб отримати код кошика, позначте, що приймаєте умови.');
  await expect(page.locator('#checkout-terms-error')).toHaveAttribute('role', 'alert');
  await expect(terms(page)).toHaveAttribute('aria-describedby', 'checkout-terms-error');
  await expect(terms(page)).toHaveAttribute('aria-invalid', 'true');
  expect(sent).toHaveLength(0);
  await expect(heading(page)).toContainText('Доставка');
  await page.keyboard.press('Space'); // keyboard works: the focused box toggles
  await expect(terms(page)).toBeChecked();
  await expect(page.locator('#checkout-terms-error')).toHaveCount(0);
  await expect(field(page, 'Прізвище')).toHaveCount(0); // still on the delivery step; the recipient draft is kept (checked in the message below)

  await page.getByRole('button', { name: 'Отримати код кошика' }).click();
  await expect(page.getByRole('heading', { name: 'Ваш код кошика' })).toBeVisible();
  expect(sent).toHaveLength(1);
  expect(Object.keys(sent[0])).toEqual(['lines']);
  await expect(page.locator('#manager-message')).toHaveValue(/Отримувач: Коваль Олена Петрівна, \+380 50 123 45 67/);
  await expect(page.locator('#manager-message')).toHaveValue(/Умови оплати та доставки прийнято\.\nБудь ласка, перевірте замовлення\./);
});

test('signed-in: Прізвище, Імʼя, По батькові and phone prefill from the profile and are sent with the checkout', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 900 });
  const REF = '1ec09d88-e1c2-11e3-8c4a-0050568002cf';
  const favourite = { type: 'branch', cityName: 'Київ', cityRef: '8d5a980d-391c-11dd-90d9-001a92567626', warehouseNumber: '1', warehouseRef: REF, warehouseName: 'Відділення №1: вул. Пирогівський шлях, 135', note: null, source: 'np-api', origin: 'cabinet' };
  const sent = await mock(page, { signed: true, prepaymentMinor: 0, profile: { displayName: 'Інше Імʼя', lastName: 'Шевченко', firstName: 'Тарас', middleName: 'Григорович', phone: '+380671234567', contactEmail: null, deliveryPreference: favourite, telegram: { linked: false }, updatedAt: null } });
  await page.goto('/cart');
  await expect(page.locator('.checkout-prepay')).toHaveCount(0);
  await page.getByRole('button', { name: 'Далі: отримувач' }).click();
  await expect(field(page, 'Прізвище')).toHaveValue('Шевченко'); await expect(field(page, 'Імʼя')).toHaveValue('Тарас'); await expect(field(page, 'По батькові')).toHaveValue('Григорович');
  await expect(page.getByLabel('Мобільний телефон')).toHaveValue('0671234567');
  await expect(page.getByText('Заповнено з вашого профілю')).toBeVisible();
  await page.getByRole('button', { name: 'Далі: доставка' }).click();
  // the favourite point is prefilled and survives leaving and re-entering the delivery step
  await expect(page.locator('#checkout-np-selected')).toContainText('Відділення №1');
  await page.getByRole('button', { name: 'Назад' }).click();
  await page.getByRole('button', { name: 'Далі: доставка' }).click();
  await expect(page.locator('#checkout-np-selected')).toContainText('Відділення №1');
  await expect(terms(page)).not.toBeChecked(); // signed-in checkouts need it too
  await terms(page).check();
  await page.getByRole('button', { name: 'Отримати код кошика' }).click();
  await expect(page.getByRole('heading', { name: 'Ваш код кошика' })).toBeVisible();
  expect(sent[0].recipient).toEqual({ lastName: 'Шевченко', firstName: 'Тарас', middleName: 'Григорович', phone: '+380671234567' });
  expect(sent[0].delivery).toEqual({ warehouseRef: REF });
  expect(Object.keys(sent[0]).sort()).toEqual(['delivery', 'lines', 'recipient'], 'the checkout contract is unchanged: no terms field');
  await expect(page.locator('.cart-confirm')).toContainText('Шевченко Тарас Григорович');
  await expect(page.locator('#manager-message')).toHaveValue(/Отримувач: Шевченко Тарас Григорович, \+380 67 123 45 67/);
});

test('signed-in with only a single-field ПІБ in displayName: name inputs stay empty, the phone is still prefilled', async ({ page }) => {
  await mock(page, { signed: true, profile: { displayName: 'Шевченко Тарас Григорович', lastName: null, firstName: null, middleName: null, phone: '+380671234567', contactEmail: null, deliveryPreference: null, telegram: { linked: false }, updatedAt: null } });
  await page.goto('/cart');
  await page.getByRole('button', { name: 'Далі: отримувач' }).click();
  for (const label of ['Прізвище', 'Імʼя', 'По батькові']) await expect(field(page, label)).toHaveValue('');
  await expect(page.getByLabel('Мобільний телефон')).toHaveValue('0671234567');
});

test('390px: every step fits the viewport and the navigation buttons are touch-sized', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 800 });
  await mock(page);
  await page.goto('/cart');
  const fits = () => page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth);
  expect(await fits()).toBe(true);
  // the warning block fits at 390px, its icon is 24–28px and the headline stays on one line
  const block = await warning(page).boundingBox(), icon = await warning(page).locator('svg').boundingBox();
  expect(block.x).toBeGreaterThanOrEqual(0); expect(block.x + block.width).toBeLessThanOrEqual(390);
  expect(icon.width).toBeGreaterThanOrEqual(24); expect(icon.width).toBeLessThanOrEqual(28);
  const h2 = await warning(page).getByRole('heading', { level: 2 }).evaluate(el => ({ h: el.getBoundingClientRect().height, lh: parseFloat(getComputedStyle(el).lineHeight) }));
  expect(h2.h).toBeLessThan(h2.lh * 1.5);
  await page.getByRole('button', { name: 'Далі: отримувач' }).click();
  expect(await fits()).toBe(true);
  const next = await page.getByRole('button', { name: 'Далі: доставка' }).boundingBox();
  expect(next.height).toBeGreaterThanOrEqual(44);
  await fillName(page, ['Коваль', 'Олена', 'Петрівна']);
  await page.getByLabel('Мобільний телефон').fill('0501234567');
  await page.getByRole('button', { name: 'Далі: доставка' }).click();
  await expect(heading(page)).toContainText('Доставка');
  expect(await fits()).toBe(true);
  const row = await page.locator('label[for="checkout-terms"]').boundingBox();
  expect(row.height).toBeGreaterThanOrEqual(44);
  await page.locator('label[for="checkout-terms"]').click({ position: { x: 4, y: row.height / 2 } }); // the label row toggles the box
  await expect(terms(page)).toBeChecked();
});

test('terms: emptying the cart clears the ticked box, so a refilled cart asks again', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 900 });
  const sent = await mock(page);
  await page.goto('/cart');
  await page.getByRole('button', { name: 'Далі: отримувач' }).click();
  await fillName(page, ['Коваль', 'Олена', 'Петрівна']);
  await page.getByLabel('Мобільний телефон').fill('0501234567');
  await page.getByRole('button', { name: 'Далі: доставка' }).click();
  await terms(page).check();
  await otherTabWrites(page, JSON.stringify({ version: 1, lines: [], recent: [] }));
  await expect(page.getByText('Кошик порожній')).toBeVisible();
  await otherTabWrites(page, JSON.stringify({ version: 1, lines, recent: [] }));
  await expect(warning(page)).toContainText(buyerNotice);
  await page.getByRole('button', { name: 'Далі: отримувач' }).click();
  await page.getByRole('button', { name: 'Далі: доставка' }).click();
  await expect(terms(page)).not.toBeChecked();
  await page.getByRole('button', { name: 'Отримати код кошика' }).click();
  await expect(terms(page)).toBeFocused();
  expect(sent).toHaveLength(0);
});

test('account contacts card: Прізвище, Імʼя, По батькові and phone, inline errors are announced, saved values are shown formatted', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 800 });
  let profile = { displayName: 'Коваль Олена Петрівна', lastName: null, firstName: null, middleName: null, phone: null, contactEmail: null, deliveryPreference: null, telegram: { linked: false, handle: null, linkedAt: null }, updatedAt: null };
  const patches = [];
  await page.route('**/api/account/session', r => r.fulfill({ json: { authenticated: true, customer: { id: 'c1', displayName: null, signInEmail: 'olena@example.com', providers: ['google'], createdAt: '2026-01-01' } } }));
  await page.route('**/api/account/carts', r => r.fulfill({ json: { carts: [
    { code: 'SS-AAAA-2345', status: 'submitted', createdAt: '2026-11-20T10:00:00.000Z', itemCount: 1, totalMinor: 1000, currency: 'UAH', delivery: null, recipient: { lastName: 'Коваль', firstName: 'Олена', middleName: 'Петрівна', name: 'Коваль Олена Петрівна', phone: '+380501234567' }, lines: [] },
    { code: 'SS-BBBB-2345', status: 'submitted', createdAt: '2026-11-19T10:00:00.000Z', itemCount: 1, totalMinor: 1000, currency: 'UAH', delivery: null, recipient: { lastName: null, firstName: null, middleName: null, name: 'Стара Назва', phone: '+380671234567' }, lines: [] },
    { code: 'SS-CCCC-2345', status: 'completed', createdAt: '2026-09-01T10:00:00.000Z', itemCount: 1, totalMinor: 1000, currency: 'UAH', delivery: null, recipient: null, personalDataErasedAt: '2026-09-20T00:17:00.000Z', lines: [] },
  ] } }));
  await page.route('**/api/account/profile', async r => {
    if (r.request().method() === 'PATCH') {
      const body = JSON.parse(r.request().postData()); patches.push(body);
      const digits = String(body.phone ?? '').replace(/\D/g, '').slice(-9);
      profile = { ...profile, lastName: body.lastName, firstName: body.firstName, middleName: body.middleName, phone: body.phone ? `+380${digits}` : null };
    }
    await r.fulfill({ json: profile });
  });
  await page.goto('/account');
  const carts = page.locator('section[aria-labelledby="carts-title"]');
  await expect(carts).toContainText('Отримувач: Коваль Олена Петрівна, +380 50 123 45 67');
  await expect(carts).toContainText('Отримувач: Стара Назва, +380 67 123 45 67');
  const erased = carts.locator('li', { hasText: 'SS-CCCC-2345' }).first();
  await expect(erased).toContainText('Виконано');
  await expect(erased).toContainText('Персональні дані видалено (термін зберігання)');
  await expect(erased).not.toContainText('Доставка:');
  const card = page.locator('section[aria-labelledby="contacts-title"]');
  await card.getByRole('button', { name: 'Додати контакти' }).click();
  await expect(field(card, 'Прізвище')).toBeFocused();
  for (const label of ['Прізвище', 'Імʼя', 'По батькові']) await expect(field(card, label)).toHaveValue('', { message: 'the old single ПІБ is not split by guessing' });
  await field(card, 'Прізвище').fill('Коваль');
  await card.getByRole('button', { name: 'Зберегти' }).click();
  await expect(field(card, 'Імʼя')).toBeFocused();
  await expect(card.locator('#contacts-first-name-error')).toContainText('Вкажіть імʼя');
  await field(card, 'Імʼя').fill('Олена'); await field(card, 'По батькові').fill('Петрівна');
  await card.getByLabel('Мобільний телефон').fill('12');
  await card.getByRole('button', { name: 'Зберегти' }).click();
  await expect(card.getByRole('alert')).toContainText('Вкажіть номер України');
  await expect(card.getByLabel('Мобільний телефон')).toBeFocused();
  expect(patches).toHaveLength(0);
  await card.getByLabel('Мобільний телефон').fill('050 123 45 67');
  await card.getByRole('button', { name: 'Зберегти' }).click();
  await expect(card).toContainText('+380 50 123 45 67');
  await expect(card).toContainText('Коваль Олена Петрівна');
  expect(patches).toEqual([{ lastName: 'Коваль', firstName: 'Олена', middleName: 'Петрівна', phone: '050 123 45 67' }]);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
});

test('admin «Вітрина»: the owner saves the prepayment, the storefront reads it, 0 hides it again', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.goto('/admin/storefront');
  const panel = page.locator('section[aria-labelledby="prepayment-settings-title"]');
  await expect(panel.getByRole('heading', { name: 'Передоплата' })).toBeVisible();
  const input = panel.getByLabel('Передоплата, ₴');
  await input.fill('250,5');
  await expect(panel.locator('.storefront-preview')).toContainText(/Передоплата 250,50/);
  await panel.getByRole('button', { name: 'Зберегти' }).click();
  await expect(panel.getByText('Збережено.')).toBeVisible();
  expect((await (await page.request.get('/api/storefront')).json()).checkout).toEqual({ prepaymentMinor: 25050 });
  await input.fill('1,234');
  await expect(panel.locator('.storefront-preview')).toContainText('не більше двох знаків');
  await input.fill('0');
  await panel.getByRole('button', { name: 'Зберегти' }).click();
  await expect(panel.locator('.storefront-preview')).toContainText('рядок приховано');
  await expect.poll(async () => (await (await page.request.get('/api/storefront')).json()).checkout).toEqual({ prepaymentMinor: 0 });
});
