import {test,expect} from '@playwright/test';

// Browser tests with a fully mocked, stateful admin API (session and /api/admin/*). Only the SPA shell and
// the public taxonomy come from the task-local worker; no real inventory or publication is touched.
const PNG=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGNgYGD4DwABBAEAHnOcQAAAAABJRU5ErkJggg==','base64');
const ALL=['catalog.read','products.edit','products.create','suppliers.manual','media.upload','media.read','suppliers.sync'];
const adminProduct=(over={})=>({id:'p-1',supplierId:'s-manual',externalId:'manual-1',source:{title:'Футболка',description:'',category:'',costMinor:50000,variants:[{size:'M',stock:2}],photos:[]},overrides:{},title:'Футболка',description:'',category:'Без категорії',categoryId:'unclassified',categoryPath:['Без категорії'],brand:null,slug:'futbolka',priceMinor:60000,currency:'UAH',photos:[],variants:[{size:'M',stock:2}],published:false,...over});

async function mockAdmin(page,{permissions=ALL,suppliers=[],products=[],failUploads=0,failUploadStatus=503,failUploadCode='storage-unavailable'}={}){
  const state={calls:[],suppliers:[...suppliers],products:[...products],uploadFailures:failUploads,n:0};
  await page.route('**/api/auth/session',route=>route.fulfill({json:{authenticated:true,email:'qa@example.test',displayName:'QA',role:permissions.includes('suppliers.manage')?'owner':'manager',permissions}}));
  await page.route('**/api/admin/**',async route=>{
    const request=route.request(),url=new URL(request.url()),method=request.method(),path=url.pathname.replace('/api/admin','');
    const body=request.postData()&&!request.headers()['content-type']?.startsWith('multipart')?JSON.parse(request.postData()):null;
    if(method!=='GET')state.calls.push({method,path,body});
    const json=(data,status=200)=>route.fulfill({status,json:data});
    if(method==='GET'&&path==='/products')return json({items:url.searchParams.get('deleted')?[]:state.products});
    if(method==='GET'&&path==='/suppliers')return json({items:url.searchParams.get('deleted')?[]:state.suppliers});
    if(method==='GET')return json({items:[]});
    if(method==='POST'&&path==='/suppliers/manual'){const s={id:`s-new-${++state.n}`,name:body.name,provider:'manual',url:`manual:s-new-${state.n}`,enabled:true,feed:null,productCount:0,publishedCount:0};state.suppliers.push(s);return json(s,201);}
    if(method==='POST'&&path==='/products'){const p=adminProduct({id:'p-new',supplierId:body.supplierId,title:body.title,source:{title:body.title,description:body.description||'',category:'',costMinor:body.costMinor??body.priceMinor,variants:body.variants,photos:[]},priceMinor:body.priceMinor,variants:body.variants});state.products.push(p);return json(p,201);}
    const photo=/^\/products\/([^/]+)\/photos$/.exec(path);
    if(method==='POST'&&photo){if(state.uploadFailures>0){state.uploadFailures--;return json({error:'Сховище фото недоступне',code:failUploadCode},failUploadStatus);}return json({url:`/media/00000000-0000-4000-8000-${String(++state.n).padStart(12,'0')}.png`},201);}
    const source=/^\/products\/([^/]+)\/source$/.exec(path);
    if(method==='PATCH'&&source){const p=state.products.find(x=>x.id===source[1]);const next={...p,title:body.title??p.title,source:{...p.source,...body},photos:body.photos??p.photos};if(body.costMinor!==undefined)next.source.costMinor=body.costMinor;state.products=state.products.map(x=>x.id===p.id?next:x);return json(next);}
    if(method==='PATCH'&&/^\/products\/[^/]+$/.test(path))return json(state.products[0]);
    return json({error:'unmocked '+method+' '+path},404);
  });
  return state;
}
const manualSupplier={id:'s-manual',name:'Власний склад',provider:'manual',url:'manual:s-manual',enabled:true,feed:null,productCount:1,publishedCount:0};
const myDrop={id:'s-md',name:'Lorem Supply',provider:'mydrop',url:'https://mydrop.com.ua/demo_shop',enabled:true,feed:null,connectionId:'12',productCount:3,publishedCount:1};
const open=async(page,tab)=>{await page.goto('/admin');await page.getByRole('button',{name:tab}).first().click();};

test('manual supplier shows a Manual badge and no sync, import, connection or link controls',async({page})=>{
  await mockAdmin(page,{permissions:[...ALL,'suppliers.manage'],suppliers:[manualSupplier,myDrop]});
  await open(page,/^Постачальники/);
  const card=page.locator('.supplier-card',{hasText:'Власний склад'});
  await expect(card.locator('.provider-badge')).toHaveText('Ручний');
  await expect(card.getByRole('link')).toHaveCount(0);
  await expect(card).not.toContainText('manual:s-manual');
  for(const name of ['Синхронізувати','Імпорт JSON'])await expect(card.getByRole('button',{name})).toHaveCount(0);
  await expect(card.getByLabel(/ID підключення/)).toHaveCount(0);
  await expect(card.getByRole('button',{name:'Перейменувати'})).toBeVisible();
  const other=page.locator('.supplier-card',{hasText:'Lorem Supply'});
  await expect(other.getByRole('button',{name:'Синхронізувати'})).toBeVisible();await expect(other.getByRole('button',{name:'Імпорт JSON'})).toBeVisible();
});

test('a manager without suppliers.manage can add a manual supplier from the suppliers screen',async({page})=>{
  const state=await mockAdmin(page,{permissions:ALL,suppliers:[myDrop]});
  await open(page,/^Постачальники/);
  await expect(page.getByText('Новий постачальник',{exact:true})).toHaveCount(0);
  await page.locator('.add-manual-supplier').getByLabel('Назва').fill('Нова полиця');
  await page.getByRole('button',{name:'Додати ручного постачальника'}).click();
  await expect(page.getByText('Ручного постачальника додано')).toBeVisible();
  expect(state.calls).toEqual([{method:'POST',path:'/suppliers/manual',body:{name:'Нова полиця',enabled:true}}]);
  await expect(page.locator('.supplier-card',{hasText:'Нова полиця'}).locator('.provider-badge')).toHaveText('Ручний');
});

test('permission gating hides add-product and manual supplier controls',async({page})=>{
  await mockAdmin(page,{permissions:['catalog.read','products.edit'],suppliers:[manualSupplier]});
  await page.goto('/admin');
  await expect(page.getByRole('button',{name:/^Товари \(/})).toBeVisible();
  await expect(page.getByRole('button',{name:'Додати товар'})).toHaveCount(0);
  await page.getByRole('button',{name:/^Постачальники/}).first().click();
  await expect(page.getByRole('button',{name:'Додати ручного постачальника'})).toHaveCount(0);
});

test('add product: validation blocks submit and shows exact errors',async({page})=>{
  const state=await mockAdmin(page,{suppliers:[manualSupplier]});
  await page.goto('/admin');await page.getByRole('button',{name:'Додати товар'}).click();
  const dialog=page.getByRole('dialog');
  await dialog.getByRole('button',{name:'Створити товар'}).click();
  await expect(dialog.getByText('Вкажіть назву.')).toBeVisible();await expect(dialog.getByText(/Вкажіть ціну в гривнях/)).toBeVisible();await expect(dialog.getByLabel('Ручний постачальник')).toHaveValue('s-manual'); // a single manual supplier is preselected
  await dialog.getByLabel(/^Назва/).fill('Худі');await dialog.getByLabel(/Ціна на сайті/).fill('1000.999');
  await dialog.getByLabel('Кількість 1').fill('1');
  await dialog.getByRole('button',{name:'Створити товар'}).click();
  await expect(dialog.getByText(/Вкажіть ціну в гривнях/)).toBeVisible();
  await dialog.getByLabel(/Ціна на сайті/).fill('1000');await dialog.getByLabel('Закупівля, ₴').fill('1000.01');
  await dialog.getByRole('button',{name:'Створити товар'}).click();
  await expect(dialog.getByText('Закупівля не може бути більшою за ціну.')).toBeVisible();
  await dialog.locator('input[type=file]').setInputFiles({name:'a.gif',mimeType:'image/gif',buffer:Buffer.from('GIF89a')});
  await expect(dialog.getByText(/дозволені лише JPEG, PNG або WebP/)).toBeVisible();
  expect(state.calls).toEqual([]);
});

test('add product: no manual supplier guides to create one inline; create, upload photos with retry, open editor',async({page})=>{
  const state=await mockAdmin(page,{suppliers:[myDrop],failUploads:1});
  await page.goto('/admin');await page.getByRole('button',{name:'Додати товар'}).click();
  const dialog=page.getByRole('dialog');
  await expect(dialog.getByText(/Ручних постачальників ще немає/)).toBeVisible();
  await expect(dialog.getByRole('option',{name:'Lorem Supply'})).toHaveCount(0);
  await dialog.getByLabel('Назва нового постачальника').fill('Мій склад');
  await dialog.getByRole('button',{name:'Створити й обрати'}).click();
  await expect(dialog.getByLabel('Ручний постачальник')).toHaveValue('s-new-1');
  await dialog.getByLabel(/^Назва/).fill('Куртка');await dialog.getByLabel('Опис').fill('Тепла');
  await dialog.getByLabel('Бренд').fill('Lorem');
  await dialog.getByLabel(/Ціна на сайті/).fill('1299.50');await dialog.getByLabel('Закупівля, ₴').fill('800');
  await dialog.getByLabel('Розмір 1').fill('M');await dialog.getByLabel('Кількість 1').fill('4');
  await dialog.getByRole('button',{name:'Додати розмір'}).click();
  await dialog.getByLabel('Розмір 2').fill('L');await dialog.getByLabel('Кількість 2').fill('0');
  await dialog.locator('input[type=file]').setInputFiles([{name:'one.png',mimeType:'image/png',buffer:PNG},{name:'two.png',mimeType:'image/png',buffer:PNG}]);
  await expect(dialog.getByRole('img',{name:/one\.png/})).toBeVisible();
  await dialog.getByRole('button',{name:'Створити товар'}).click();
  await expect(dialog.getByText(/не все вдалося завершити/)).toBeVisible();
  await expect(dialog.getByText(/не завантажено: сховище фото недоступне/)).toBeVisible();
  await expect(dialog.getByLabel(/^Назва/)).toBeDisabled();
  const post=state.calls.filter(c=>c.method==='POST'&&c.path==='/products');
  expect(post).toHaveLength(1);
  expect(post[0].body).toEqual({supplierId:'s-new-1',title:'Куртка',description:'Тепла',brand:'Lorem',priceMinor:129950,costMinor:80000,variants:[{size:'M',stock:4},{size:'L',stock:0}]});
  await dialog.getByRole('button',{name:/^Повторити/}).click();
  await expect(page.getByRole('dialog',{name:/Створіть свою версію/})).toBeVisible();
  await expect(page.getByRole('dialog')).toHaveCount(1);
  expect(state.calls.filter(c=>c.path==='/products')).toHaveLength(1); // never re-created on retry
  const order=state.calls.map(c=>`${c.method} ${c.path}`);
  expect(order).toEqual(['POST /suppliers/manual','POST /products','POST /products/p-new/photos','POST /products/p-new/photos','PATCH /products/p-new/source','POST /products/p-new/photos','PATCH /products/p-new/source'].slice(0,order.length));
  const patches=state.calls.filter(c=>c.method==='PATCH');
  expect(patches.at(-1).body.photos).toHaveLength(2);
  expect(state.calls.filter(c=>c.path.endsWith('/photos'))).toHaveLength(3);
  await expect(page.getByText(/Товар створено як чернетку/).first()).toBeVisible();
  await expect(page.getByRole('tab',{name:'Джерело'})).toBeVisible();
});

test('manual product editor shows an editable Source section; non-manual products do not',async({page})=>{
  const manual=adminProduct({photos:['https://media.example.test/a.png'],source:{...adminProduct().source,photos:['https://media.example.test/a.png']}});
  const other=adminProduct({id:'p-md',supplierId:'s-md',externalId:'md-1',title:'Чужий товар'});
  const state=await mockAdmin(page,{suppliers:[manualSupplier,myDrop],products:[manual,other]});
  await page.goto('/admin');
  await page.getByRole('button',{name:/^Редагувати/}).first().click();
  await page.getByRole('tab',{name:'Джерело'}).click();
  const dialog=page.getByRole('dialog');
  await expect(dialog.getByRole('heading',{name:'Джерело (ручний товар)'})).toBeVisible();
  await dialog.getByLabel('Закупівля, ₴').fill('450.5');
  await dialog.getByLabel('Кількість 1').fill('7');
  await dialog.getByLabel('Назва в джерелі').press('Enter'); // must not submit the overrides form
  expect(state.calls).toEqual([]);
  await expect(page.getByRole('tab',{name:'Джерело'})).toHaveAttribute('aria-selected','true');
  await dialog.getByRole('button',{name:'Зберегти джерело'}).click();
  await expect(page.getByText(/Джерело збережено/)).toBeVisible();
  expect(state.calls).toEqual([{method:'PATCH',path:'/products/p-1/source',body:{title:'Футболка',description:'',costMinor:45050,variants:[{size:'M',stock:7}],photos:['https://media.example.test/a.png']}}]);
  await page.getByRole('button',{name:'Закрити редактор'}).click();
  await page.getByRole('button',{name:/^Редагувати/}).nth(1).click();
  await expect(page.getByRole('tab',{name:'Основне'})).toHaveAttribute('aria-selected','true');
  await expect(page.getByRole('dialog').getByLabel('Назва',{exact:true})).toBeVisible();
  await expect(page.getByRole('tab',{name:'Джерело'})).toHaveCount(0);
});

test('add product dialog fits a 390px viewport',async({page})=>{
  await page.setViewportSize({width:390,height:844});
  await mockAdmin(page,{suppliers:[manualSupplier]});
  await page.goto('/admin');await page.getByRole('button',{name:'Додати товар'}).click();
  const dialog=page.getByRole('dialog');await expect(dialog).toBeVisible();
  expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);
  const box=await dialog.boundingBox();expect(box.x).toBeGreaterThanOrEqual(0);expect(box.x+box.width).toBeLessThanOrEqual(391);
  await dialog.getByRole('button',{name:'Додати розмір'}).click();
  const overflow=await dialog.evaluate(el=>[...el.querySelectorAll('*')].filter(n=>n.getBoundingClientRect().right>el.getBoundingClientRect().right+1).length);
  expect(overflow).toBe(0);
  await page.screenshot({path:'.claude/tmp/add-product-390.png'});
});

test('closing the add dialog after a partial failure reloads the list so the draft is visible',async({page})=>{
  const state=await mockAdmin(page,{suppliers:[manualSupplier],failUploads:5});
  await page.goto('/admin');await page.getByRole('button',{name:'Додати товар'}).click();
  const dialog=page.getByRole('dialog');
  await dialog.getByLabel(/^Назва/).fill('Шапка');await dialog.getByLabel(/Ціна на сайті/).fill('300');await dialog.getByLabel('Кількість 1').fill('2');
  await dialog.locator('input[type=file]').setInputFiles({name:'one.png',mimeType:'image/png',buffer:PNG});
  await dialog.getByRole('button',{name:'Створити товар'}).click();
  await expect(dialog.getByText(/не все вдалося завершити/)).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await expect(page.getByText(/Товар створено як чернетку, але не все вдалося/)).toBeVisible();
  await expect(page.getByText('Шапка').first()).toBeVisible(); // present in the reloaded list
  expect(state.calls.filter(c=>c.path==='/products')).toHaveLength(1);
});

test('double submit sends one create request',async({page})=>{
  const state=await mockAdmin(page,{suppliers:[manualSupplier]});
  await page.goto('/admin');await page.getByRole('button',{name:'Додати товар'}).click();
  const dialog=page.getByRole('dialog');
  await dialog.getByLabel(/^Назва/).fill('Шарф');await dialog.getByLabel(/Ціна на сайті/).fill('100');await dialog.getByLabel('Кількість 1').fill('1');
  await dialog.locator('form').evaluate(f=>{f.requestSubmit();f.requestSubmit();});
  await expect(page.getByRole('dialog',{name:/Створіть свою версію/})).toBeVisible();
  expect(state.calls.filter(c=>c.path==='/products')).toHaveLength(1);
});

test('upload inputs need media.upload',async({page})=>{
  await mockAdmin(page,{permissions:ALL.filter(p=>p!=='media.upload'),suppliers:[manualSupplier]});
  await page.goto('/admin');await page.getByRole('button',{name:'Додати товар'}).click();
  await expect(page.getByRole('dialog').locator('input[type=file]')).toBeDisabled();
});

test('source tab fits a 390px viewport',async({page})=>{
  await page.setViewportSize({width:390,height:844});
  await mockAdmin(page,{suppliers:[manualSupplier],products:[adminProduct()]});
  await page.goto('/admin');await page.getByRole('button',{name:/^Редагувати/}).first().click();
  await page.getByRole('tab',{name:'Джерело'}).click();
  const dialog=page.getByRole('dialog');await expect(dialog.getByRole('heading',{name:'Джерело (ручний товар)'})).toBeVisible();
  expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);
  const overflow=await dialog.evaluate(el=>[...el.querySelectorAll('.source-section *')].filter(n=>n.getBoundingClientRect().right>el.getBoundingClientRect().right+1).length);
  expect(overflow).toBe(0);
  await page.screenshot({path:'.claude/tmp/source-tab-390.png'});
});
