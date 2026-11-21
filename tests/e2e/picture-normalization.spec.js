import { test, expect } from '@playwright/test';
import { createHash } from 'node:crypto';
import { deflateSync } from 'node:zlib';
import { request as httpRequest } from 'node:http';
import { mkdir } from 'node:fs/promises';

// Isolated end-to-end check of picture normalization. Everything is synthetic:
// generated PNGs, a throwaway supplier/product in the task-local D1 + R2 (tests/e2e/wrangler.e2e.jsonc).
// The IS-Net model is NOT run; the cutout is seeded through the real POST /cutout API.

const crcTable = Array.from({ length: 256 }, (_, n) => { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; return c >>> 0; });
const crc32 = buf => { let c = 0xffffffff; for (const b of buf) c = crcTable[(c ^ b) & 0xff] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; };
function chunk(type, data) {
  const out = Buffer.alloc(12 + data.length);
  out.writeUInt32BE(data.length, 0); out.write(type, 4, 'ascii'); data.copy(out, 8);
  out.writeUInt32BE(crc32(out.subarray(4, 8 + data.length)), 8 + data.length);
  return out;
}
function png(width, height, pixel) {
  const raw = Buffer.alloc((width * 4 + 1) * height);
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
    const o = y * (width * 4 + 1) + 1 + x * 4, [r, g, b, a] = pixel(x, y);
    raw[o] = r; raw[o + 1] = g; raw[o + 2] = b; raw[o + 3] = a;
  }
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(width, 0); ihdr.writeUInt32BE(height, 4); ihdr[8] = 8; ihdr[9] = 6;
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr), chunk('IDAT', deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
}
// A synthetic "shoe": a 7 degree tilted ellipse (elongation about 2.6) with a lighter sole, on a flat backdrop.
const W = 640, H = 480, tilt = 7 * Math.PI / 180;
const inShoe = (x, y) => {
  const dx = x - 320, dy = y - 250, u = dx * Math.cos(tilt) + dy * Math.sin(tilt), v = -dx * Math.sin(tilt) + dy * Math.cos(tilt);
  return (u / 230) ** 2 + (v / 90) ** 2 <= 1 ? (v > 55 ? 'sole' : 'upper') : null;
};
const originalPng = png(W, H, (x, y) => { const s = inShoe(x, y); return s === 'sole' ? [235, 235, 225, 255] : s ? [160, 70, 40, 255] : [200, 215, 230, 255]; });
const cutoutPng = png(W, H, (x, y) => { const s = inShoe(x, y); return s === 'sole' ? [235, 235, 225, 255] : s ? [160, 70, 40, 255] : [0, 0, 0, 0]; });
const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');
const pngPart = (name, bytes) => ({ name, mimeType: 'image/png', buffer: bytes });

// With AUTH_DEV_BYPASS every 127.0.0.1 request is the dev owner, so the anonymous check uses a non-loopback Host header.
function anonymousGet(port, path) {
  return new Promise((resolve, reject) => {
    const req = httpRequest({ host: '127.0.0.1', port, path, method: 'GET', headers: { Host: 'anonymous.example.test' } }, res => {
      const chunks = []; res.on('data', c => chunks.push(c)); res.on('end', () => resolve({ status: res.statusCode, type: res.headers['content-type'], body: Buffer.concat(chunks) }));
    });
    req.on('error', reject); req.end();
  });
}

test('footwear picture is cut out, fitted, nudged, saved, re-fitted and restored without touching real inventory', async ({ page, request, baseURL }, testInfo) => {
  test.setTimeout(120000);
  const port = Number(new URL(baseURL).port), headers = { Origin: baseURL }, stamp = Date.now();
  const timings = {}, mark = async (name, fn) => { const t = Date.now(); const r = await fn(); timings[name] = Date.now() - t; return r; };
  const shots = `${process.cwd()}/.claude/tmp/picture-normalization-shots`;
  await mkdir(shots, { recursive: true });
  const call = async (method, path, options = {}) => {
    const response = await request.fetch(path, { method, headers, ...options });
    expect(response.ok(), `${method} ${path}: ${await response.text()}`).toBe(true);
    return response.json();
  };

  // ---- Synthetic fixture: supplier, draft footwear product, uploaded original, API-seeded cutout ----
  const supplier = await call('POST', '/api/admin/suppliers', { data: { name: `E2E Picture Supplier ${stamp}`, url: `https://mydrop.com.ua/e2e_picture_${stamp}` } });
  const externalId = `PIC-${stamp}`, title = `Синтетичні кросівки ${stamp}`;
  await call('POST', `/api/admin/suppliers/${supplier.id}/import`, { data: { items: [{ externalId, title, description: 'Synthetic only', category: 'Взуття', costMinor: 100000, currency: 'UAH', photos: ['https://example.com/pic.jpg'], variants: [{ id: 'v1', size: '42', stock: 2 }] }] } });
  const product = (await (await request.get('/api/admin/products')).json()).items.find(p => p.externalId === externalId);
  expect(product, 'synthetic product imported').toBeTruthy();
  const upload = await call('POST', '/api/admin/media', { multipart: { file: pngPart('original.png', originalPng) } });
  await call('PATCH', `/api/admin/products/${product.id}`, { data: { categoryId: 'footwear', published: false, photos: [upload.url] } });
  const seeded = await call('POST', `/api/admin/products/${product.id}/cutout`, { multipart: { sourceUrl: upload.url, originalHash: sha256(originalPng), file: pngPart('cutout.png', cutoutPng) } });
  expect(seeded.url).toMatch(/^\/media\/[a-f0-9-]+\.png$/);
  expect(seeded.originalUrl).toMatch(/^\/media\/[a-f0-9-]+\.png$/);
  await call('PATCH', `/api/admin/products/${product.id}`, { data: { photos: [seeded.url] } });
  const photosOf = async () => (await (await request.get('/api/admin/products')).json()).items.find(p => p.id === product.id).photos;
  expect(await photosOf()).toEqual([seeded.url]);

  // ---- Editor: open the Photos tab ----
  await page.route('https://example.com/**', route => route.abort());
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.goto('/admin');
  await expect(page.getByRole('heading', { name: 'Ваша добірка' })).toBeVisible();
  const openEditor = async () => {
    await page.getByLabel('Пошук у каталозі менеджера').fill(externalId);
    await page.getByRole('button', { name: /^Редагувати/ }).click();
    const dialog = page.getByRole('dialog');
    await dialog.getByRole('tab', { name: 'Фото' }).click();
    return dialog;
  };
  let editor = await openEditor();
  await expect(editor.getByRole('button', { name: 'Вирівняти за шаблоном', exact: true })).toBeEnabled();
  await expect(editor.getByRole('button', { name: 'Повернути вирізане фото' })).toHaveCount(0);
  await expect(editor.getByRole('button', { name: 'Відновити оригінал' })).toBeVisible();

  // ---- 1. Fit with the footwear template ----
  await mark('fitOpen', async () => {
    await editor.getByRole('button', { name: 'Вирівняти за шаблоном', exact: true }).click();
    await expect(editor.getByRole('heading', { name: 'Вирівняти за шаблоном' })).toBeVisible();
    await expect(editor.getByText(/Шаблон:\s*Взуття, вид збоку/)).toBeVisible();
    await expect(editor.getByText('Перевірте положення предмета перед збереженням.')).toBeVisible();
  });
  await expect(editor.getByText(/Вирівнювання за маскою без нейромережі/)).toBeVisible();
  await expect(editor.getByText(/Після · 1200 × 1600/)).toBeVisible();
  await expect(editor.getByRole('img', { name: 'Вирівняне фото' })).toBeVisible();
  const afterSize = () => editor.getByRole('img', { name: 'Вирівняне фото' }).evaluate(img => img.complete && img.naturalWidth ? [img.naturalWidth, img.naturalHeight] : null);
  await expect.poll(afterSize).toEqual([1200, 1600]);
  await page.screenshot({ path: `${shots}/desktop-fit.png` });
  await testInfo.attach('desktop-fit', { path: `${shots}/desktop-fit.png`, contentType: 'image/png' });

  // ---- 2. Keyboard nudge ----
  const scaleBefore = await editor.getByRole('group', { name: 'Масштаб' }).locator('output').textContent();
  const rotate = editor.getByRole('button', { name: 'Поворот: Повернути за годинниковою стрілкою' });
  await rotate.focus(); await page.keyboard.press('Enter');
  const scaleUp = editor.getByRole('button', { name: 'Масштаб: Збільшити' });
  await scaleUp.focus(); await page.keyboard.press('Space');
  const down = editor.getByRole('button', { name: 'Зсув по вертикалі: Нижче' });
  await down.focus(); await page.keyboard.press('Enter');
  await expect(editor.getByRole('group', { name: 'Поворот' }).locator('output')).not.toHaveText('0°');
  await expect(editor.getByRole('group', { name: 'Масштаб' }).locator('output')).not.toHaveText(scaleBefore);
  await expect(editor.getByText('Перевірте положення предмета перед збереженням.')).toBeVisible();
  await expect.poll(afterSize).toEqual([1200, 1600]);

  // ---- 3. Accept: real POST /normalized (201), then product save ----
  const [accepted] = await Promise.all([
    page.waitForResponse(r => r.url().endsWith(`/api/admin/products/${product.id}/normalized`) && r.request().method() === 'POST'),
    editor.getByRole('button', { name: 'Використати вирівняне фото' }).click(),
  ]);
  expect(accepted.status()).toBe(201);
  const normalized = await accepted.json();
  expect(normalized.url).toMatch(/^\/media\/[a-f0-9-]+\.png$/);
  expect(normalized.cutoutUrl).toBe(seeded.url);
  expect(normalized.originalUrl).toBe(seeded.originalUrl);
  expect(normalized.url).not.toBe(seeded.url);
  await expect(editor.getByRole('heading', { name: 'Вирівняти за шаблоном' })).toHaveCount(0);
  const photosField = editor.getByLabel('Посилання на фото');
  await expect(photosField).toHaveValue(normalized.url);
  expect(await photosOf(), 'accepting does not persist the product by itself').toEqual([seeded.url]);
  await mark('saveNormalized', async () => {
    await editor.getByRole('button', { name: 'Зберегти зміни' }).click();
    await expect(page.getByRole('dialog')).toHaveCount(0);
  });
  expect(await photosOf()).toEqual([normalized.url]);

  // Public gating: draft normalized media is private; the stored PNG is exactly the rendered 1200x1600 canvas.
  const draftAnonymous = await anonymousGet(port, normalized.url);
  expect(draftAnonymous.status, 'anonymous draft media').toBe(404);
  const ownerMedia = await request.get(normalized.url);
  expect(ownerMedia.status()).toBe(200);
  const stored = await ownerMedia.body();
  expect([stored.readUInt32BE(16), stored.readUInt32BE(20)]).toEqual([1200, 1600]);
  const lineage = await (await request.get(`/api/admin/products/${product.id}/image-originals`)).json();
  expect(lineage.lineage[normalized.url]).toMatchObject({ originalUrl: seeded.originalUrl, cutoutUrl: seeded.url, templateId: 'footwear-side' });

  // ---- 4. Reload; re-fit fetches the cutout; cancel ----
  await page.reload();
  editor = await openEditor();
  await expect(editor.getByLabel('Посилання на фото')).toHaveValue(normalized.url);
  const cutoutFetch = page.waitForResponse(r => r.url().includes(`/image?url=${encodeURIComponent(seeded.url)}`));
  await editor.getByRole('button', { name: 'Перевирівняти', exact: true }).click();
  expect((await cutoutFetch).status()).toBe(200);
  await expect(editor.getByRole('heading', { name: 'Перевирівняти фото' })).toBeVisible();
  await expect(editor.getByText('Перевірте положення предмета перед збереженням.')).toBeVisible();
  await editor.locator('.picture-fit').getByRole('button', { name: 'Зберегти без вирівнювання', exact: true }).click();
  await expect(editor.getByRole('heading', { name: 'Перевирівняти фото' })).toHaveCount(0);
  await expect(editor.getByLabel('Посилання на фото')).toHaveValue(normalized.url);
  expect(await photosOf()).toEqual([normalized.url]);

  // ---- 5. Back to the cutout, then to the original; save and reload after each ----
  // Saving a photo list deletes media nothing references any more. A second synthetic draft keeps the
  // normalized picture (and through its lineage the cutout and original) alive while this flow switches photos.
  // Its ID and title must not match the editor search for this fixture's externalId.
  await call('POST', `/api/admin/suppliers/${supplier.id}/import`, { data: { items: [{ externalId: `KEEP-${stamp}`, title: `Синтетичний тримач ${stamp}`, description: 'Synthetic only', category: 'Взуття', costMinor: 100000, currency: 'UAH', photos: ['https://example.com/pic.jpg'], variants: [{ id: 'v1', size: '42', stock: 2 }] }] } });
  const keeper = (await (await request.get('/api/admin/products')).json()).items.find(p => p.externalId === `KEEP-${stamp}`);
  await call('PATCH', `/api/admin/products/${keeper.id}`, { data: { photos: [normalized.url] } });
  await editor.getByRole('button', { name: 'Повернути вирізане фото' }).click();
  await expect(editor.getByLabel('Посилання на фото')).toHaveValue(seeded.url);
  await editor.getByRole('button', { name: 'Зберегти зміни' }).click();
  await expect(page.getByRole('dialog')).toHaveCount(0);
  expect(await photosOf()).toEqual([seeded.url]);
  await page.reload();
  editor = await openEditor();
  await expect(editor.getByLabel('Посилання на фото')).toHaveValue(seeded.url);
  await expect(editor.getByRole('button', { name: 'Відновити оригінал' })).toBeVisible();
  await editor.getByRole('button', { name: 'Відновити оригінал' }).click();
  await expect(editor.getByLabel('Посилання на фото')).toHaveValue(seeded.originalUrl);
  await editor.getByRole('button', { name: 'Зберегти зміни' }).click();
  await expect(page.getByRole('dialog')).toHaveCount(0);
  expect(await photosOf()).toEqual([seeded.originalUrl]);
  await page.reload();
  editor = await openEditor();
  await expect(editor.getByLabel('Посилання на фото')).toHaveValue(seeded.originalUrl);
  // The original is not a cutout, so no fit is offered for it, and the archive stayed intact.
  await expect(editor.getByRole('button', { name: 'Вирівняти за шаблоном', exact: true })).toHaveCount(0);
  for (const url of [seeded.originalUrl, seeded.url, normalized.url]) expect((await request.get(url)).status(), url).toBe(200);
  expect(Buffer.compare(await (await request.get(seeded.originalUrl)).body(), originalPng), 'original bytes are intact').toBe(0);
  expect(Buffer.compare(await (await request.get(seeded.url)).body(), cutoutPng), 'cutout bytes are intact').toBe(0);

  // ---- Mobile editor screenshot (cutout photo, re-fit open) ----
  await editor.getByRole('button', { name: 'Закрити редактор' }).click();
  await call('PATCH', `/api/admin/products/${product.id}`, { data: { photos: [normalized.url] } });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.reload();
  editor = await openEditor();
  await editor.getByRole('button', { name: 'Перевирівняти', exact: true }).click();
  await expect(editor.getByText('Перевірте положення предмета перед збереженням.')).toBeVisible();
  await expect.poll(afterSize).toEqual([1200, 1600]);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.screenshot({ path: `${shots}/mobile-fit.png` });
  await testInfo.attach('mobile-fit', { path: `${shots}/mobile-fit.png`, contentType: 'image/png' });
  await editor.locator('.picture-fit').getByRole('button', { name: 'Зберегти без вирівнювання', exact: true }).click();

  // ---- Public check: 404 while draft, 200 after publishing this fixture product only ----
  expect((await anonymousGet(port, normalized.url)).status).toBe(404);
  const published = await call('PATCH', `/api/admin/products/${product.id}`, { data: { published: true } });
  expect(published).toBeTruthy();
  const publicNow = await anonymousGet(port, normalized.url);
  expect(publicNow.status, 'anonymous published media').toBe(200);
  expect(publicNow.type).toBe('image/png');
  expect(Buffer.compare(publicNow.body, stored)).toBe(0);
  // Archive objects are not in the public projection, so they stay private.
  expect((await anonymousGet(port, seeded.url)).status).toBe(404);
  expect((await anonymousGet(port, seeded.originalUrl)).status).toBe(404);
  await call('PATCH', `/api/admin/products/${product.id}`, { data: { published: false } });
  expect((await anonymousGet(port, normalized.url)).status).toBe(404);

  // ---- Storage cleanup: removing the last references deletes the normalized picture, its cutout and its original ----
  await call('PATCH', `/api/admin/products/${keeper.id}`, { data: { photos: [] } });
  for (const url of [normalized.url, seeded.url, seeded.originalUrl]) expect((await request.get(url)).status(), `${url} still referenced`).toBe(200);
  await call('PATCH', `/api/admin/products/${product.id}`, { data: { photos: [] } });
  for (const url of [normalized.url, seeded.url, seeded.originalUrl]) expect((await request.get(url)).status(), `${url} deleted`).toBe(404);
  console.log('picture-normalization timings (ms):', JSON.stringify(timings));
});
