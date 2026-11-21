import { test, expect } from '@playwright/test';

// Campaign band: facts come from the loaded products, never from copy.
const photo = 'data:image/svg+xml,' + encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" width="400" height="500"><rect width="400" height="500" fill="#8a9"/></svg>');
const item = (id, categoryId, category, brand, priceMinor, stock = 2) => ({ id, slug: `c-${id}`, title: `Річ ${id}`, description: 'fixture', brand, category, categoryId, priceMinor, photos: [photo], variants: [{ size: 'M', stock }] });
// puffer-jackets: 3 in stock (+1 sold out cheaper), hoodies: 2 in stock
const items = [
  item('p1', 'puffer-jackets', 'Пуховики', 'Dolor', 250000), item('p2', 'puffer-jackets', 'Пуховики', 'Excepteur', 400000),
  item('p3', 'puffer-jackets', 'Пуховики', 'Excepteur', 300000), item('p4', 'puffer-jackets', 'Пуховики', 'Ipsum', 100000, 0),
  item('h1', 'hoodies', 'Худі', 'Lorem', 90000), item('h2', 'hoodies', 'Худі', 'Lorem', 80000),
];
const nb = s => s.replace(/ /g, ' ');

async function open(page, list = items) {
  await page.route('**/api/products', r => r.fulfill({ json: { items: list } }));
  await page.goto('/?intro=0');
  await expect(page.locator('.product-card').first()).toBeVisible();
}

test('band sits between the rack room and the catalog with numbers from the data', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await open(page);
  const band = page.locator('.campaign-band');
  await expect(band).toHaveCount(1);
  await expect(band).toHaveAttribute('data-scene', 'fan');
  await expect(band.getByRole('heading', { level: 2 })).toContainText('Пуховики');
  expect(nb(await band.locator('.campaign-lead').innerText())).toBe('3 моделі в наявності. Excepteur, Dolor. Від 2 500 грн.');
  const order = await page.evaluate(() => {
    const rail = document.querySelector('.rail-track')?.closest('section,div[class*=rail]'), band = document.querySelector('.campaign-frame'), main = document.getElementById('catalog');
    return { next: band.nextElementSibling === main, afterRail: !!rail && !!(rail.compareDocumentPosition(band) & Node.DOCUMENT_POSITION_FOLLOWING) };
  });
  expect(order).toEqual({ next: true, afterRail: true });
  // decorative cut-outs: empty alt, lazy, explicit size; the wall plus the fan layout's three slots
  const imgs = band.locator('.scene-slot img');
  await expect(imgs).toHaveCount(3);
  for (const img of await imgs.all()) {
    await expect(img).toHaveAttribute('alt', '');
    await expect(img).toHaveAttribute('loading', 'lazy');
    await expect(img).toHaveAttribute('width', /\d+/);
    await expect(img).toHaveAttribute('height', /\d+/);
  }
  await expect(band.getByRole('link', { name: /Дивитись у наявності: Пуховики/ })).toBeVisible();
});

test('another dataset gives another band; empty catalog renders no band', async ({ page }) => {
  await open(page, items.filter(p => p.categoryId === 'hoodies'));
  await expect(page.locator('.campaign-band h2')).toContainText('Худі');
  expect(nb(await page.locator('.campaign-lead').innerText())).toBe('2 моделі в наявності. Lorem. Від 800 грн.');
});

test('no products loaded: no band', async ({ page }) => {
  await page.route('**/api/products', r => r.fulfill({ json: { items: [] } }));
  await page.goto('/?intro=0');
  await expect(page.locator('#catalog')).toBeVisible();
  await expect(page.locator('.campaign-band')).toHaveCount(0);
});

test('loading shell shows no numbers, then the band replaces it', async ({ page }) => {
  let release;
  const gate = new Promise(r => { release = r; });
  await page.route('**/api/products', async r => { await gate; await r.fulfill({ json: { items } }); });
  await page.goto('/?intro=0');
  const shell = page.locator('.campaign-band.is-loading');
  await expect(page.locator('.campaign-frame > .campaign-band.is-loading')).toHaveCount(1);
  await expect(shell).toHaveCount(1);
  expect(await shell.innerText()).toBe('');
  const h = (await shell.boundingBox()).height;
  expect(h).toBeGreaterThan(200);
  release();
  await expect(page.locator('.campaign-band h2')).toBeVisible();
  await expect(shell).toHaveCount(0);
});

test('CTA filters the catalog without a reload and the URL is shareable', async ({ page }) => {
  await open(page);
  await page.evaluate(() => { window.__stay = 1; });
  await page.getByRole('link', { name: /Дивитись у наявності: Пуховики/ }).click();
  await expect(page).toHaveURL(/category=puffer-jackets&available=1.*#catalog/);
  // band counts 3 in stock; the sold-out fourth puffer is filtered out, so catalog count == band count
  await expect(page.locator('.product-card')).toHaveCount(3);
  await expect(page.locator('.item-count')).toHaveText('3 товарів');
  expect(nb(await page.locator('.campaign-lead').innerText())).toMatch(/^3 моделі /);
  await expect(page.locator('.tree-label[aria-pressed=true]')).toContainText('Пуховики');
  expect(await page.evaluate(() => window.__stay)).toBe(1);
});

test('plain link keeps working when opened directly', async ({ page }) => {
  await page.route('**/api/products', r => r.fulfill({ json: { items } }));
  await page.goto('/?intro=0&category=puffer-jackets&available=1#catalog');
  await expect(page.locator('.product-card')).toHaveCount(3);
});

test('keyboard: the CTA is reachable and Enter filters', async ({ page }) => {
  await open(page);
  const cta = page.getByRole('link', { name: /Дивитись у наявності: Пуховики/ });
  await cta.focus();
  await page.keyboard.press('Enter');
  await expect(page.locator('.product-card')).toHaveCount(3);
});

for (const width of [390, 820, 1440]) {
  test(`no horizontal overflow at ${width}`, async ({ page }) => {
    await page.setViewportSize({ width, height: 900 });
    await open(page);
    const band = page.locator('.campaign-band');
    await band.scrollIntoViewIfNeeded();
    const m = await page.evaluate(() => ({ doc: document.documentElement.scrollWidth, win: innerWidth }));
    expect(m.doc).toBeLessThanOrEqual(m.win);
    // cut-outs are clipped by the band itself (overflow:hidden), so only the page width matters
    const r = await band.boundingBox();
    expect(r.x).toBeGreaterThanOrEqual(0);
    expect(r.x + r.width).toBeLessThanOrEqual(m.win);
  });
}

// scenes (ADR-0015). /api/storefront and the campaign media are mocked: no real data is touched.
const svg = (w, h) => '<svg xmlns="http://www.w3.org/2000/svg" width="' + w + '" height="' + h + '"><rect width="' + w + '" height="' + h + '" rx="20" fill="#cdd"/></svg>';
const libPic = n => ({ src: `/media/campaign/aaaaaaaa-0000-0000-0000-00000000000${n}.webp`, w: 600, h: 900 });
async function openScene(page, { sceneId, campaignPictures = {} }) {
  await page.route('**/api/storefront', r => r.fulfill({ json: { campaign: { mode: 'auto', categoryId: null, excluded: [], ...(sceneId ? { sceneId } : {}) }, campaignPictures } }));
  await page.route('**/media/campaign/*', r => r.fulfill({ contentType: 'image/svg+xml', body: svg(600, 900) }));
  await open(page);
  await expect(page.locator('.campaign-band h2')).toBeVisible();
}
// The cores of the slots (centred third of the width, 70% of the height nearest the anchor) must not be covered by a slot painted above them.
const coveredCores = () => page => page.evaluate(() => {
  const art = document.querySelector('.campaign-art'), anchor = art.dataset.anchor;
  const slots = [...art.querySelectorAll('.scene-slot')].filter(el => getComputedStyle(el).display !== 'none').map((el, order) => {
    const cs = getComputedStyle(el), box = el.getBoundingClientRect();
    const ox = art.getBoundingClientRect().x + el.offsetLeft, oy = art.getBoundingClientRect().y + el.offsetTop, w = el.offsetWidth, h = el.offsetHeight;
    const t = anchor === 'bottom' ? oy + h * 0.3 : anchor === 'top' ? oy : oy + h * 0.15;
    return { order, z: Number(cs.zIndex), box, core: { l: ox + w / 3, r: ox + 2 * w / 3, t, b: t + h * 0.7 }, w, h };
  });
  const bad = [];
  for (const low of slots) for (const high of slots) {
    if (low === high || high.z < low.z || (high.z === low.z && high.order < low.order)) continue;
    const a = high.box, c = low.core;
    if (a.left < c.r - 1 && c.l + 1 < a.right && a.top < c.b - 1 && c.t + 1 < a.bottom) bad.push([low.order + 1, high.order + 1]);
  }
  return { count: slots.length, bad, sizes: slots.map(s => [Math.round(s.w), Math.round(s.h)]) };
});

for (const sceneId of ['fan', 'rail', 'hooks']) for (const width of [1440, 390]) {
  test(`scene ${sceneId} renders at ${width} with no slot hidden`, async ({ page }) => {
    await page.setViewportSize({ width, height: 900 });
    await openScene(page, { sceneId });
    const band = page.locator('.campaign-band');
    await expect(band).toHaveAttribute('data-scene', sceneId);
    await band.scrollIntoViewIfNeeded();
    // puffer-jackets has front, angle and side cut-outs: three pictures, three slots
    await expect(band.locator('.scene-slot')).toHaveCount(3);
    for (const img of await band.locator('.scene-slot img').all()) {
      await expect(img).toHaveAttribute('alt', '');
      await expect(img).toHaveAttribute('loading', 'lazy');
      await expect(img).toHaveAttribute('decoding', 'async');
      await expect(img).toHaveAttribute('width', /\d+/);
    }
    await page.waitForFunction(() => [...document.querySelectorAll('.scene-slot img')].every(i => i.complete && i.naturalWidth > 0), null, { timeout: 15000 });
    const r = await coveredCores()(page);
    expect(r.count).toBe(3);
    expect(r.bad, `covered cores ${JSON.stringify(r.bad)}`).toEqual([]);
    for (const [w, h] of r.sizes) { expect(w).toBeGreaterThan(40); expect(h).toBeGreaterThan(60); }
    if (sceneId === 'rail') await expect(band.locator('.scene-rail')).toBeVisible();
    if (sceneId === 'hooks') await expect(band.locator('.scene-hook:visible')).toHaveCount(3);
    expect((await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth))).toBe(true);
  });
}

test('library pictures come first, the rail cut-outs fill the rest', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await openScene(page, { sceneId: 'fan', campaignPictures: { 'puffer-jackets': [libPic(1)] } });
  const srcs = await page.locator('.scene-slot img').evaluateAll(l => l.map(i => new URL(i.src).pathname));
  expect(srcs).toHaveLength(3);
  expect(srcs[0]).toBe(libPic(1).src);
  expect(srcs[1]).toMatch(/^\/rail\/puffer-jackets-front\.webp$/);
});

test('image count follows the layout: hooks shows a fourth picture on desktop only', async ({ page }) => {
  const pictures = { 'puffer-jackets': [libPic(1), libPic(2), libPic(3), libPic(4)] };
  await page.setViewportSize({ width: 1440, height: 900 });
  await openScene(page, { sceneId: 'hooks', campaignPictures: pictures });
  await expect(page.locator('.scene-slot')).toHaveCount(4);
  await expect(page.locator('.scene-slot:visible')).toHaveCount(4);
  await page.setViewportSize({ width: 390, height: 900 });
  await expect(page.locator('.scene-slot')).toHaveCount(4);
  await expect(page.locator('.scene-slot:visible')).toHaveCount(3);
  await expect(page.locator('.scene-slot[data-mobile=off]')).toHaveCount(1);
  // the fan has three slots whatever the library holds
  const page2 = await page.context().newPage();
  await page2.setViewportSize({ width: 1440, height: 900 });
  await openScene(page2, { sceneId: 'fan', campaignPictures: pictures });
  await expect(page2.locator('.scene-slot')).toHaveCount(3);
});

test('unknown or unavailable scene ids render the fan', async ({ page }) => {
  for (const sceneId of ['bogus', 'floor']) {
    await page.unroute('**/api/storefront').catch(() => {});
    const floorRequests = []; page.on('request', rq => { if (/campaign-floor/.test(rq.url())) floorRequests.push(rq.url()); });
    await openScene(page, { sceneId });
    await expect(page.locator('.campaign-band')).toHaveAttribute('data-scene', 'fan');
    expect(floorRequests).toEqual([]);
  }
});
