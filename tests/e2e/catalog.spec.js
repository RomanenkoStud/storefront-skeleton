import { test, expect } from '@playwright/test';
import { readFile } from 'node:fs/promises';

test('manager imports, curates and publishes; supplier refresh preserves edits and photos inheritance', async ({ page, request }) => {
  const stamp = Date.now();
  const supplierName = `E2E Supplier ${stamp}`;
  const curatedTitle = `Капсула ${stamp}`;
  const fixture = JSON.parse(await readFile('fixtures/mydrop-demo.json', 'utf8'));
  fixture.items[0].externalId = `E2E-${stamp}`;
  await page.route('https://images.example.com/**', route => route.abort());
  await page.goto('/admin');
  await expect(page.getByRole('heading', { name: 'Ваша добірка' })).toBeVisible();
  await page.getByRole('button', { name: 'Постачальники', exact: true }).click();
  await page.getByLabel('Назва', { exact: true }).fill(supplierName);
  await page.getByLabel('Сторінка MyDrop', { exact: false }).fill(`https://mydrop.com.ua/e2e_${stamp}`);
  await page.getByRole('button', { name: 'Додати постачальника', exact: true }).click();
  const card = page.locator('.supplier-card').filter({ hasText: supplierName });
  await expect(card).toBeVisible();
  await card.getByRole('button', { name: 'Імпорт JSON', exact: true }).click();
  await page.getByLabel('Дані товарів').fill(JSON.stringify(fixture));
  await page.getByRole('button', { name: 'Імпортувати як чернетки' }).click();
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await page.getByRole('button', { name: /^Каталог/ }).click();
  await page.getByLabel('Пошук у каталозі менеджера').fill(fixture.items[0].externalId);
  await page.getByRole('button', { name: /^Редагувати/ }).click();
  const editor = page.getByRole('dialog');
  await editor.getByLabel('Назва', { exact: true }).fill(curatedTitle);
  await editor.getByLabel('Різниця до закупівлі, ₴', { exact: true }).fill('250');
  await editor.getByLabel('Опис', { exact: false }).fill('Власний опис менеджера');
  await editor.getByLabel('Показувати на сайті', { exact: false }).check();
  await editor.getByRole('button', { name: 'Зберегти зміни' }).click();
  await expect(editor).toHaveCount(0);
  let admin = await (await request.get('/api/admin/products')).json();
  const product = admin.items.find(item => item.externalId === fixture.items[0].externalId);
  expect(product.title).toBe(curatedTitle);
  expect(product.priceMinor).toBe(150000);
  expect(product.overrides.photos).toBeNull();
  let publicItems = await (await request.get('/api/products')).json();
  expect(publicItems.items.find(item => item.id === product.id)).toMatchObject({ title: curatedTitle, priceMinor: 150000 });
  expect(JSON.stringify(publicItems)).not.toContain('costMinor');
  fixture.items[0].costMinor = 140000;
  fixture.items[0].photos = ['https://images.example.com/new-source-photo.jpg'];
  const imported = await request.post(`/api/admin/suppliers/${product.supplierId}/import`, {
    data: fixture, headers: { Origin: new URL(page.url()).origin },
  });
  expect(imported.ok()).toBe(true);
  publicItems = await (await request.get('/api/products')).json();
  expect(publicItems.items.find(item => item.id === product.id)).toMatchObject({ title: curatedTitle, description: 'Власний опис менеджера', priceMinor: 165000, photos: fixture.items[0].photos });
  await page.goto('/');
  await page.getByLabel('Пошук товарів').fill(curatedTitle);
  await expect(page.getByRole('heading', { name: curatedTitle, exact: true })).toBeVisible();
  await page.getByRole('link').filter({ has: page.getByRole('heading', { name: curatedTitle, exact: true }) }).click();
  await expect(page.getByRole('heading', { name: curatedTitle, exact: true })).toBeVisible();
  await expect(page.locator('link[rel="canonical"]')).toHaveAttribute('href', `${new URL(page.url()).origin}/products/${product.slug}`);
});

test('public and manager layouts fit a mobile viewport', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('/');
  await expect(page.getByRole('heading', { name: 'Каталог', exact: true })).toBeVisible();
  const overflow = await page.evaluate(() => ({ width: innerWidth, scroll: document.documentElement.scrollWidth, elements: [...document.querySelectorAll('body *')].filter(e => e.getBoundingClientRect().right > innerWidth + 1).map(e => ({ tag:e.tagName, cls:e.className, right:e.getBoundingClientRect().right, overflow:getComputedStyle(e).overflowX })).slice(0,15) }));
  expect(overflow.scroll, JSON.stringify(overflow)).toBeLessThanOrEqual(overflow.width);
  await page.goto('/admin');
  await expect(page.getByRole('heading', { name: 'Ваша добірка', exact: true })).toBeVisible();
  const adminOverflow = await page.evaluate(() => ({ width: innerWidth, scroll: document.documentElement.scrollWidth, elements: [...document.querySelectorAll('body *')].filter(e => e.getBoundingClientRect().right > innerWidth + 1).map(e => ({ tag:e.tagName, cls:e.className, right:e.getBoundingClientRect().right, overflow:getComputedStyle(e).overflowX })).slice(0,15) }));
  expect(adminOverflow.scroll, JSON.stringify(adminOverflow)).toBeLessThanOrEqual(adminOverflow.width);
});

test('category tree combines brand, manufacturer size and price filters and preserves URL state', async ({ page, request, baseURL }) => {
  const stamp=Date.now();
  const headers={Origin:baseURL};
  const supplierResponse=await request.post('/api/admin/suppliers',{headers,data:{name:`Filter test ${stamp}`,url:`https://mydrop.com.ua/filters_${stamp}`}});
  expect(supplierResponse.ok()).toBe(true);
  const supplier=await supplierResponse.json();
  const item=(id,title,category,costMinor,size)=>({externalId:`${stamp}-${id}`,title:`${title} ${stamp}`,description:'Filter integration fixture',category,costMinor,currency:'UAH',photos:['https://images.example.com/filter-fixture.jpg'],variants:[{id:'v',size,stock:2}]});
  const items=[item('jacket','Куртка Lorem','Куртки Lorem, Polo',150000,'M (Маломірить на С)'),item('cardigan','Кардиган Consectetur','Кардигани Polo/Consectetur',250000,'М'),item('shoes','Кросівки Lorem Air','Lorem',100000,'41.5 (26см)')];
  expect((await request.post(`/api/admin/suppliers/${supplier.id}/import`,{headers,data:{items}})).ok()).toBe(true);
  const all=await (await request.get('/api/admin/products')).json();
  for(const product of all.items.filter(p=>p.supplierId===supplier.id))expect((await request.patch(`/api/admin/products/${product.id}`,{headers,data:{published:true}})).ok()).toBe(true);
  await page.route('https://images.example.com/**',route=>route.abort());
  await page.goto(`/?q=${stamp}&category=clothing&brand=Lorem&size=M#catalog`);
  await expect(page.locator('.product-card')).toHaveCount(1);
  await expect(page.getByRole('heading',{name:items[0].title,exact:true})).toBeVisible();
  await page.getByLabel('Сортування товарів').selectOption('price-asc');
  await expect(page).toHaveURL(/sort=price-asc/);
  await page.goBack();
  await expect(page.getByLabel('Сортування товарів')).toHaveValue('new');
  await page.getByLabel('Сортування товарів').selectOption('price-asc');
  await page.reload();
  await expect(page.locator('.product-card')).toHaveCount(1);
  await expect(page.getByRole('checkbox',{name:'Розмір M',exact:true})).toBeChecked();
  await page.getByRole('button',{name:'Скинути все',exact:true}).click();
  await page.getByLabel('Пошук товарів').fill(String(stamp));
  await expect(page.locator('.product-card')).toHaveCount(3);
  await page.getByLabel('Мінімальна ціна, ₴').fill('1400');
  await page.getByLabel('Максимальна ціна, ₴').fill('1600');
  await expect(page.locator('.product-card')).toHaveCount(1);
  await expect(page.getByRole('heading',{name:items[0].title,exact:true})).toBeVisible();
  await page.getByRole('button',{name:'Скинути все',exact:true}).click();
  await page.getByLabel('Пошук товарів').fill(String(stamp));
  await page.getByRole('button',{name:/^Взуття/}).click();
  await page.getByRole('checkbox',{name:'Розмір 41.5',exact:true}).check();
  await expect(page.locator('.product-card')).toHaveCount(1);
  await expect(page.getByRole('heading',{name:items[2].title,exact:true})).toBeVisible();
});

test('manager can confirm, override, reset and batch-review suggested categories without changing publication',async ({page,request,baseURL})=>{
  const stamp=Date.now(),headers={Origin:baseURL};
  const supplier=await(await request.post('/api/admin/suppliers',{headers,data:{name:`Classification ${stamp}`,url:`https://mydrop.com.ua/classification_${stamp}`}})).json();
  const fixture=JSON.parse(await readFile('fixtures/mydrop-demo.json','utf8'));
  fixture.items[0]={...fixture.items[0],externalId:`classify-${stamp}`,title:`Кардиган Consectetur ${stamp}`,category:'Кардигани Polo/Consectetur'};
  expect((await request.post(`/api/admin/suppliers/${supplier.id}/import`,{headers,data:fixture})).ok()).toBe(true);
  await page.route('https://images.example.com/**',route=>route.abort());
  await page.goto('/admin');
  await page.getByLabel('Пошук у каталозі менеджера').fill(`classify-${stamp}`);
  await page.getByRole('button',{name:/^Редагувати/}).click();
  let editor=page.getByRole('dialog');
  await expect(editor.locator('.classification-panel')).toContainText('Кардигани Polo/Consectetur');
  await expect(editor.locator('.classification-panel')).toContainText('Кардигани');
  await editor.getByLabel('Категорія',{exact:false}).selectOption('jackets');
  await editor.getByLabel('Бренд',{exact:false}).fill('Test Brand');
  await editor.getByRole('button',{name:'Зберегти зміни'}).click();
  await expect(editor).toHaveCount(0);
  let product=(await(await request.get('/api/admin/products')).json()).items.find(p=>p.externalId===`classify-${stamp}`);
  expect(product.categoryId).toBe('jackets');expect(product.brand).toBe('Test Brand');expect(product.published).toBe(false);
  await page.getByRole('checkbox',{name:`Обрати ${fixture.items[0].title}`,exact:true}).check();
  await page.getByRole('button',{name:'Переглянути пропозиції',exact:true}).click();
  const selectedPreview=page.locator('.bulk-preview');
  await expect(selectedPreview).toContainText('лише там, де ще немає ручної редакції');
  await expect(selectedPreview.getByRole('cell',{name:'Куртки · Test Brand',exact:true})).toHaveCount(2);
  await expect(selectedPreview.getByLabel('Версія для обраних товарів',{exact:true})).toHaveValue((await(await request.get('/api/admin/recognition')).json()).activeVersion);
  const beforeSelectedApply=structuredClone(product);
  await page.getByRole('button',{name:'Підтвердити й закріпити пропозиції для обраних',exact:true}).click();
  await expect(page.locator('.bulk-preview')).toHaveCount(0);
  product=(await(await request.get('/api/admin/products')).json()).items.find(p=>p.externalId===`classify-${stamp}`);
  expect(product.categoryId).toBe('jackets');expect(product.brand).toBe('Test Brand');expect(product.published).toBe(false);
  expect(product.overrides).toEqual(beforeSelectedApply.overrides);expect(product.source).toEqual(beforeSelectedApply.source);expect(product.priceMinor).toBe(beforeSelectedApply.priceMinor);
  const application=(await(await request.get('/api/admin/recognition')).json()).applications.find(a=>a.productId===product.id);
  expect(application.versionId).toBe((await(await request.get('/api/admin/recognition')).json()).activeVersion);
  await page.getByRole('button',{name:/^Редагувати/}).click();editor=page.getByRole('dialog');
  await editor.getByRole('button',{name:'Повернути автоматичне визначення',exact:true}).click();
  await editor.getByRole('button',{name:'Зберегти зміни'}).click();await expect(editor).toHaveCount(0);
  product=(await(await request.get('/api/admin/products')).json()).items.find(p=>p.externalId===`classify-${stamp}`);
  expect(product.categoryId).toBe('cardigans');expect(product.brand).toBe('Consectetur');expect(product.categoryOverridden).toBe(false);expect(product.brandOverridden).toBe(false);expect(product.published).toBe(false);
});

test('supplier page discovers account connections with one button and refreshes without manual name or ID entry',async ({page})=>{
 let synced=false;
 const supplier={id:'discovered',name:'Connected supplier',url:'https://mydrop.com.ua/connected_supplier',enabled:true,connectionId:'777',createdAt:new Date().toISOString()};
 await page.route('**/api/admin/suppliers',route=>route.fulfill({json:{items:synced?[supplier]:[]}}));
 await page.route('**/api/admin/suppliers/sync-connected',async route=>{
  expect(route.request().method()).toBe('POST');expect(route.request().postDataJSON()).toEqual({});
  const added=synced?0:1;synced=true;await route.fulfill({json:{total:1,added,updated:0,unchanged:added?0:1,skipped:[]}});
 });
 await page.goto('/admin');await page.getByRole('button',{name:'Постачальники',exact:true}).click();
 const button=page.getByRole('button',{name:'Синхронізувати постачальників MyDrop',exact:true});await button.click();
 await expect(page.getByRole('heading',{name:'Connected supplier',exact:true})).toBeVisible();
 await expect(page.getByLabel('ID підключення · Connected supplier',{exact:false})).toHaveValue('777');
 await expect(page.getByRole('status').filter({hasText:'додано 1'})).toBeVisible();
 await button.click();await expect(page.getByRole('status').filter({hasText:'без змін 1'})).toBeVisible();
 await expect(page.locator('.supplier-card')).toHaveCount(1);
});

async function seedLifecycle(request,baseURL){
 const stamp=String(Date.now()),headers={Origin:baseURL};
 const response=await request.post('/api/admin/suppliers',{headers,data:{name:`Lifecycle ${stamp}`,url:`https://mydrop.com.ua/lifecycle_${stamp}`}});expect(response.ok()).toBe(true);const supplier=await response.json();
 const fixture=JSON.parse(await readFile('fixtures/mydrop-demo.json','utf8'));
 const items=['A','B'].map(letter=>({...fixture.items[0],externalId:`life-${stamp}-${letter}`,title:`Lifecycle ${stamp} ${letter}`}));
 expect((await request.post(`/api/admin/suppliers/${supplier.id}/import`,{headers,data:{items}})).ok()).toBe(true);
 return {supplier,stamp,headers};
}

test('supplier rename, cancel deletion, Trash and disabled restore preserve products',async({page,request,baseURL})=>{
 const {supplier,stamp}=await seedLifecycle(request,baseURL);const name=`Renamed ${stamp}`;
 await page.goto('/admin');await page.getByRole('button',{name:'Постачальники',exact:true}).click();
 let card=page.locator('.supplier-card').filter({has:page.getByRole('heading',{name:supplier.name,exact:true})});
 await card.getByRole('button',{name:'Перейменувати',exact:true}).click();
 await card.getByLabel(`Нова назва ${supplier.name}`,{exact:true}).fill(name);await card.getByRole('button',{name:'Зберегти назву',exact:true}).click();
 card=page.locator('.supplier-card').filter({has:page.getByRole('heading',{name,exact:true})});
 await card.getByRole('button',{name:`Видалити постачальника ${name}`,exact:true}).click();
 let dialog=page.getByRole('dialog');await expect(dialog).toContainText(name);await expect(dialog.getByRole('button',{name:'Скасувати',exact:true})).toBeFocused();
 await dialog.getByRole('button',{name:'Скасувати',exact:true}).click();await expect(card).toBeVisible();
 await card.getByRole('button',{name:`Видалити постачальника ${name}`,exact:true}).click();await page.getByRole('dialog').getByRole('button',{name:'Видалити постачальника',exact:true}).click();await expect(card).toHaveCount(0);
 await page.getByRole('button',{name:/^Кошик постачальників \(/}).click();await expect(card).toBeVisible();
 await card.getByRole('button',{name:'Відновити постачальника',exact:true}).click();await expect(card).toHaveCount(0);
 const restored=(await(await request.get('/api/admin/suppliers')).json()).items.find(s=>s.id===supplier.id);expect(restored.name).toBe(name);expect(restored.enabled).toBe(false);
 const products=(await(await request.get('/api/admin/products')).json()).items.filter(p=>p.supplierId===supplier.id);expect(products).toHaveLength(2);
});

test('selected publication, unpublication, deletion and restore require deliberate actions',async({page,request,baseURL})=>{
 const {supplier,stamp}=await seedLifecycle(request,baseURL);
 const products=async(deleted=false)=>(await(await request.get(`/api/admin/products${deleted?'?deleted=1':''}`)).json()).items.filter(p=>p.supplierId===supplier.id);
 await page.goto('/admin');await page.getByLabel('Пошук у каталозі менеджера').fill(`Lifecycle ${stamp}`);
 await page.getByRole('checkbox',{name:'Обрати видимі товари',exact:true}).check();await page.getByRole('button',{name:'Опублікувати обрані',exact:true}).click();
 expect((await products()).every(p=>!p.published)).toBe(true);
 await page.getByRole('dialog').getByRole('button',{name:'Опублікувати 2 товарів',exact:true}).click();await expect(page.getByRole('dialog')).toHaveCount(0);expect((await products()).every(p=>p.published)).toBe(true);
 await page.getByRole('checkbox',{name:'Обрати видимі товари',exact:true}).check();await page.getByRole('button',{name:'Зняти обрані з публікації',exact:true}).click();await page.getByRole('dialog').getByRole('button',{name:'Зняти з публікації 2 товарів',exact:true}).click();await expect(page.getByRole('dialog')).toHaveCount(0);expect((await products()).every(p=>!p.published)).toBe(true);
 await page.getByRole('checkbox',{name:'Обрати видимі товари',exact:true}).check();await page.getByRole('button',{name:'Видалити обрані',exact:true}).click();await page.getByRole('dialog').getByRole('button',{name:'Видалити 2 товарів',exact:true}).click();await expect(page.getByRole('dialog')).toHaveCount(0);expect(await products()).toHaveLength(0);expect(await products(true)).toHaveLength(2);
 await page.getByRole('button',{name:/^Кошик товарів \(/}).click();await page.getByRole('checkbox',{name:'Обрати видимі товари',exact:true}).check();await page.getByRole('button',{name:'Відновити обрані',exact:true}).click();
 await expect.poll(async()=> (await products()).length).toBe(2);expect((await products()).every(p=>!p.published)).toBe(true);
});

test('public header and page expose no manager link', async ({ page }) => {
  for (const viewport of [{ width: 1280, height: 800 }, { width: 390, height: 844 }]) {
    await page.setViewportSize(viewport);
    await page.goto('/');
    // Phone: the account entry sits inside the header menu; desktop shows it as a header icon.
    if (viewport.width <= 650) await page.getByRole('button', { name: 'Меню' }).first().click();
    await expect(page.locator('a[href="/admin"], a[href^="/admin/"]')).toHaveCount(0);
    const accountNav = page.locator('header.store-header').getByRole('link', { name: /Кабінет|Увійти|Акаунт/ });
    await expect(accountNav).toHaveCount(1);
    await expect(accountNav).toHaveAttribute('href', '/account');
  }
});
