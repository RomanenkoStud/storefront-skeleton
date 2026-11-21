import { test, expect } from '@playwright/test';
import { deflateSync } from 'node:zlib';
import { mkdir } from 'node:fs/promises';

// Admin Вітрина: scene picker, live preview, picture library. Real task-local Worker, D1 and R2
// (tests/e2e/wrangler.e2e.jsonc, AUTH_DEV_BYPASS owner); only /api/products is mocked. Background removal is NOT run:
// pictures are uploaded with «Прибрати фон» off as synthetic transparent PNGs. State is reset to defaults (no pictures, auto, fan) in beforeAll and afterAll.
const crcTable = Array.from({ length: 256 }, (_, n) => { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; return c >>> 0; });
const crc32 = buf => { let c = 0xffffffff; for (const b of buf) c = crcTable[(c ^ b) & 0xff] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; };
function chunk(type, data) { const out = Buffer.alloc(12 + data.length); out.writeUInt32BE(data.length, 0); out.write(type, 4, 'ascii'); data.copy(out, 8); out.writeUInt32BE(crc32(out.subarray(4, 8 + data.length)), 8 + data.length); return out; }
function png(width, height, pixel) {
  const raw = Buffer.alloc((width * 4 + 1) * height);
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) { const o = y * (width * 4 + 1) + 1 + x * 4, p = pixel(x, y); raw[o] = p[0]; raw[o + 1] = p[1]; raw[o + 2] = p[2]; raw[o + 3] = p[3]; }
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(width, 0); ihdr.writeUInt32BE(height, 4); ihdr[8] = 8; ihdr[9] = 6;
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr), chunk('IDAT', deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
}
// A synthetic puffer jacket: body + sleeves + collar on transparent margins (trim must shrink 500x700 to the garment).
const jacket = tint => png(500, 700, (x, y) => {
  const body = x > 150 && x < 350 && y > 120 && y < 600, sleeves = y > 160 && y < 520 && ((x > 80 && x <= 150) || (x >= 350 && x < 420)), collar = y > 90 && y <= 120 && x > 190 && x < 310;
  return body || sleeves || collar ? (y % 60 < 4 ? [30, 40, 30, 255] : tint) : [0, 0, 0, 0];
});
const photo = 'data:image/svg+xml,' + encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" width="400" height="500"><rect width="400" height="500" fill="#8a9"/></svg>');
const item = (id, brand, priceMinor) => ({ id, slug: `c-${id}`, title: `Річ ${id}`, description: 'fixture', brand, category: 'Пуховики', categoryId: 'puffer-jackets', priceMinor, photos: [photo], variants: [{ size: 'M', stock: 3 }] });
const products = [item('p1', 'Excepteur', 450000), item('p2', 'Dolor', 520000), item('p3', 'The Dolor Peak', 610000)];
const shots = `${process.cwd()}/.claude/tmp/admin-scenes`;

test.describe.configure({ mode: 'serial' });
let origin, request;
const headers = () => ({ Origin: origin });
async function cleanup(req, base) {
  const read = await req.get('/api/admin/storefront');
  expect(read.ok(), 'cleanup read').toBe(true);
  for (const p of (await read.json()).pictures || []) {
    const del = await req.fetch(`/api/admin/storefront/pictures/${p.id}`, { method: 'DELETE', headers: { Origin: base } });
    expect(del.ok(), `cleanup delete ${p.id}: ${await del.text()}`).toBe(true);
  }
  const put = await req.fetch('/api/admin/storefront/campaign', { method: 'PUT', headers: { Origin: base }, data: { mode: 'auto', excluded: [], sceneId: 'fan' } });
  expect(put.ok(), `cleanup reset: ${await put.text()}`).toBe(true);
}
test.beforeAll(async ({ playwright, baseURL }) => { origin = baseURL; request = await playwright.request.newContext({ baseURL }); await cleanup(request, baseURL); await mkdir(shots, { recursive: true }); });
test.afterAll(async () => { await cleanup(request, origin); await request.dispose(); });

async function open(page, permissions) {
  await page.route('**/api/products', r => r.fulfill({ json: { items: products } }));
  if (permissions) await page.route('**/api/auth/session', r => r.fulfill({ json: { authenticated: true, email: 'qa@example.test', displayName: 'QA', role: 'manager', permissions } }));
  await page.goto('/admin/storefront');
  await expect(page.getByRole('heading', { level: 2, name: 'Промо на головній' })).toBeVisible();
  await expect(page.locator('.scene-preview .campaign-band').first()).toBeVisible();
}
const settled = page => page.evaluate(async () => { await Promise.all([...document.images].map(i => (i.complete ? 0 : new Promise(r => { i.onload = i.onerror = r; })))); await document.fonts.ready; });
const frame = (page, w) => page.locator(`.scene-preview-frame[data-width="${w}"]`);

test('scene picker previews the unsaved form in both frames and saves sceneId with «Зберегти»', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 1000 });
  await open(page);
  const cards = page.locator('.scene-card');
  await expect(cards).toHaveCount(4);
  await expect(page.getByRole('radio', { name: /Віяло/ })).toBeChecked();
  await expect(page.getByRole('radio', { name: /Флет-лей/ })).toBeDisabled();
  await expect(page.locator('.scene-card[data-unavailable]')).toContainText('потрібен фон');
  // 1440 frame is scaled to the panel, 390 frame renders the mobile band (single column) in a desktop browser
  const desktop = frame(page, 1440), phone = frame(page, 390);
  await expect(desktop.locator('.campaign-band')).toHaveAttribute('data-scene', 'fan');
  const columns = async f => (await f.locator('.campaign-band').evaluate(el => getComputedStyle(el).gridTemplateColumns)).split(' ').length;
  expect(await columns(desktop)).toBe(2);
  expect(await columns(phone)).toBe(1);
  const box = await desktop.locator('.scene-preview-outer').boundingBox(), inner = await desktop.locator('.scene-preview-inner').boundingBox();
  expect(inner.width).toBeLessThan(1440); expect(Math.abs(inner.width - box.width)).toBeLessThan(4); // the outer box has a 1px border
  expect(box.height).toBeGreaterThan(150);
  // the preview band is inert decoration: no heading id, no aria-labelledby, no navigation target
  for (const f of [desktop, phone]) {
    await expect(f.locator('.campaign-band')).not.toHaveAttribute('aria-labelledby', /.*/);
    await expect(f.locator('h2')).not.toHaveAttribute('id', /.*/);
    await expect(f.locator('.campaign-cta')).not.toHaveAttribute('href', /.*/);
    await expect(f.locator('.scene-preview-inner')).toHaveJSProperty('inert', true);
  }
  await expect(page.getByRole('region', { name: 'Попередній перегляд промо' })).toBeVisible();
  // unsaved pick changes both previews but not the public settings
  await page.getByRole('radio', { name: /Рейл/ }).check();
  await expect(desktop.locator('.campaign-band')).toHaveAttribute('data-scene', 'rail');
  await expect(phone.locator('.campaign-band')).toHaveAttribute('data-scene', 'rail');
  expect((await (await request.get('/api/storefront')).json()).campaign.sceneId).toBe('fan');
  const put = page.waitForRequest(r => r.method() === 'PUT' && r.url().endsWith('/api/admin/storefront/campaign'));
  await page.getByRole('button', { name: 'Зберегти', exact: true }).first().click();
  expect((await put).postDataJSON()).toMatchObject({ mode: 'auto', sceneId: 'rail' });
  await expect(page.getByText('Збережено. Головна сторінка')).toBeVisible();
  expect((await (await request.get('/api/storefront')).json()).campaign.sceneId).toBe('rail');
  // «Показати категорію» previews an eligible category without saving
  await page.getByLabel('Показати категорію').selectOption('hoodies');
  await expect(desktop.locator('.campaign-band')).toHaveAttribute('data-category', 'hoodies');
  await expect(page.locator('.scene-preview-note')).toContainText('немає речей у наявності');
  expect((await (await request.get('/api/admin/storefront')).json()).campaign.mode).toBe('auto');
  // mode "category" lists every eligible category, not only the old RAIL.clothes one
  await page.getByRole('radio', { name: /Обрана категорія/ }).check();
  expect(await page.locator('.storefront-settings select').first().locator('option').count()).toBeGreaterThan(5);
});

test('picture library: upload preview, save now, reorder, delete with confirmation, band refresh', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 1000 });
  await open(page);
  await page.getByRole('radio', { name: /Рейл/ }).check();
  const library = page.locator('.picture-library');
  await library.getByLabel('Категорія').selectOption('puffer-jackets');
  await expect(library).toContainText('Дії з картинками зберігаються одразу');
  await expect(library.locator('.picture-tile.is-fallback')).toHaveCount(3);
  await expect(library.locator('.picture-tile.is-fallback').first()).toContainText('стандартна');
  await library.getByRole('checkbox', { name: /Прибрати фон/ }).uncheck();
  // a file without transparency is refused clearly
  await library.locator('input[type=file]').setInputFiles({ name: 'flat.png', mimeType: 'image/png', buffer: png(200, 200, () => [200, 100, 50, 255]) });
  await expect(library.locator('.picture-tile-error')).toContainText('Потрібна картинка з прозорим фоном');
  await library.getByRole('button', { name: 'Скасувати' }).click();
  await library.locator('input[type=file]').setInputFiles([{ name: 'a.png', mimeType: 'image/png', buffer: jacket([90, 110, 80, 255]) }, { name: 'b.png', mimeType: 'image/png', buffer: jacket([70, 80, 120, 255]) }]);
  await expect(library.locator('.picture-pending [data-status=ready]')).toHaveCount(2);
  // the preview shows the unsaved picture first, and nothing is stored yet
  await expect(frame(page, 1440).locator('.scene-slot img').first()).toHaveAttribute('src', /^blob:/);
  expect((await (await request.get('/api/admin/storefront')).json()).pictures).toHaveLength(0);
  await library.locator('.picture-pending [data-status=ready]').first().getByRole('button', { name: 'Зберегти картинку' }).click();
  await expect(library.locator('.picture-tile[data-source=library]')).toHaveCount(1);
  await expect(library).toContainText('вже на сайті');
  const saved = (await (await request.get('/api/admin/storefront')).json()).pictures;
  expect(saved).toHaveLength(1);
  expect(saved[0].src).toMatch(/^\/media\/campaign\/[0-9a-f-]+\.(webp|png)$/);
  expect(saved[0].w).toBeLessThan(500); expect(saved[0].h).toBeLessThan(700); // trimmed to the garment (+2%)
  // public media rule: the saved picture is readable by the storefront
  expect((await request.get(saved[0].src)).ok()).toBe(true);
  await library.locator('.picture-pending [data-status=ready]').first().getByRole('button', { name: 'Зберегти картинку' }).click();
  await expect(library.locator('.picture-tile[data-source=library]')).toHaveCount(2);
  await expect(library.locator('.picture-tile.is-fallback')).toHaveCount(3);
  // «Зараз на головній» uses the library: preview shows the library picture first
  await page.getByLabel('Показати категорію').selectOption('puffer-jackets');
  await expect(frame(page, 1440).locator('.scene-slot img').first()).toHaveAttribute('src', saved[0].src);
  await expect(page.locator('.storefront-preview').first()).toContainText('Пуховики · 3 в наявності');
  // reorder: move the second picture up (immediate PUT)
  const ids = (await (await request.get('/api/admin/storefront')).json()).pictures.map(p => p.id);
  await library.getByRole('button', { name: 'Картинка 2 вище' }).click();
  await expect(library.locator('.picture-tile-label').first()).toContainText('1 · головна');
  await expect.poll(async () => (await (await request.get('/api/admin/storefront')).json()).pictures.sort((a, b) => a.position - b.position).map(p => p.id)).toEqual([ids[1], ids[0]]);
  await expect(library.getByRole('button', { name: 'Картинка 1 вище' })).toBeDisabled();
  await page.getByLabel('Показати категорію').selectOption('');
  // delete is deliberate: cancel keeps it, confirm removes it
  await library.getByRole('button', { name: 'Видалити картинку 1' }).click();
  const dialog = page.getByRole('dialog', { name: 'Видалити картинку?' });
  await dialog.getByRole('button', { name: 'Скасувати' }).click();
  await expect(library.locator('.picture-tile[data-source=library]')).toHaveCount(2);
  await library.getByRole('button', { name: 'Видалити картинку 1' }).click();
  await page.getByRole('dialog').getByRole('button', { name: 'Видалити' }).click();
  await expect(library.locator('.picture-tile[data-source=library]')).toHaveCount(1);
  expect((await (await request.get('/api/admin/storefront')).json()).pictures).toHaveLength(1);
  // screenshots: scene picker + both previews + library with exactly one uploaded picture (Рейл is chosen above, unsaved)
  await page.getByLabel('Показати категорію').selectOption('');
  await settled(page);
  await page.screenshot({ path: `${shots}/admin-1440-full.png`, fullPage: true });
  await page.locator('.storefront-settings').first().screenshot({ path: `${shots}/admin-1440-scene-and-previews.png` });
  await library.screenshot({ path: `${shots}/admin-1440-picture-library.png` });
});

test('cancelling a two-file batch leaves nothing queued and «+ Додати» works again', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 1000 });
  // a Worker that never answers keeps background removal "running" until the user cancels (the model is not run)
  await page.addInitScript(() => { window.Worker = class { postMessage() {} terminate() {} }; });
  await open(page);
  const library = page.locator('.picture-library');
  await library.getByLabel('Категорія').selectOption('hoodies');
  const add = library.getByRole('button', { name: '+ Додати' });
  await expect(add).toBeEnabled();
  await library.locator('input[type=file]').setInputFiles([{ name: 'a.png', mimeType: 'image/png', buffer: jacket([90, 110, 80, 255]) }, { name: 'b.png', mimeType: 'image/png', buffer: jacket([70, 80, 120, 255]) }]);
  await expect(library.locator('.picture-progress')).toBeVisible();
  await expect(add).toBeDisabled();
  await expect(library.getByRole('checkbox', { name: /Прибрати фон/ })).toBeDisabled();
  await library.getByRole('button', { name: 'Скасувати обробку' }).click();
  await expect(library.locator('.picture-progress')).toHaveCount(0);
  await expect(add).toBeEnabled();
  await expect(library.getByRole('checkbox', { name: /Прибрати фон/ })).toBeEnabled();
  await expect(library.locator('.picture-pending [data-status=queued]')).toHaveCount(0);
  await expect(library.locator('.picture-pending li')).toHaveCount(1); // only the one that started, shown as cancelled
});

test('non-owner sees the section read-only', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 1000 });
  // own fixture: one picture seeded through the real API (the earlier tests' pictures are not relied on)
  const upload = await request.post('/api/admin/storefront/pictures', { headers: headers(), multipart: { categoryId: 'puffer-jackets', file: { name: 'seed.png', mimeType: 'image/png', buffer: jacket([90, 110, 80, 255]) } } });
  expect(upload.ok(), await upload.text()).toBe(true);
  await open(page, ['catalog.read']);
  await page.locator('.picture-library').getByLabel('Категорія').selectOption('puffer-jackets');
  await expect(page.getByText('Змінювати налаштування вітрини може лише власник.')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Зберегти', exact: true })).toHaveCount(0);
  await expect(page.getByRole('radio', { name: /Рейл/ })).toBeDisabled();
  const library = page.locator('.picture-library');
  await expect(library.getByRole('button', { name: '+ Додати' })).toHaveCount(0);
  await expect(library.getByRole('button', { name: /вище|нижче|Видалити/ })).toHaveCount(0);
  await expect(library.locator('.picture-tile[data-source=library]').first()).toBeVisible();
  await expect(page.locator('.scene-preview .campaign-band').first()).toBeVisible();
});
