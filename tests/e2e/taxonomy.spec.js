import {test,expect} from '@playwright/test';
import assert from 'node:assert/strict';

test('nested categories persist and safely rename, move and reassign published references',async({page,request,baseURL})=>{
  const suffix=Date.now(),root=`QA дерево ${suffix}`,child=`QA підкатегорія ${suffix}`,leaf=`QA третій рівень ${suffix}`,renamed=`QA оновлена ${suffix}`;
  const post=async(path,data)=>{const r=await request.post(path,{data,headers:{Origin:baseURL}});assert.ok(r.ok(),await r.text());return r.json();};
  const getTaxonomy=async()=> (await request.get('/api/taxonomy')).json();
  await page.goto('/admin');await page.getByRole('button',{name:'Правила розпізнавання',exact:true}).click();await page.getByRole('tab',{name:/Дерево категорій/}).click();
  const select=async(path)=>page.getByRole('button',{name:`Редагувати категорію ${path}`,exact:true}).click();
  const apply=async()=>{await page.getByRole('button',{name:'Переглянути зміни дерева',exact:true}).click();await expect(page.getByRole('region',{name:'Вплив змін дерева'})).toBeVisible();await page.getByRole('button',{name:'Підтвердити зміни дерева',exact:true}).click();await page.getByRole('button',{name:'Застосувати зміни дерева',exact:true}).click();await expect(page.getByRole('dialog')).toHaveCount(0);};
  await page.getByRole('button',{name:'Додати категорію',exact:true}).click();await page.getByLabel('Назва категорії',{exact:true}).fill(root);await apply();
  await select(root);await page.getByRole('button',{name:'Додати підкатегорію',exact:true}).click();await page.getByLabel('Назва категорії',{exact:true}).fill(child);await apply();
  await select(`${root} / ${child}`);await page.getByRole('button',{name:'Додати підкатегорію',exact:true}).click();await page.getByLabel('Назва категорії',{exact:true}).fill(leaf);await apply();
  let taxonomy=await getTaxonomy();const rootId=taxonomy.options.find(n=>n.label===root).id,childId=taxonomy.options.find(n=>n.label===child).id,leafId=taxonomy.options.find(n=>n.label===leaf).id;assert.deepEqual(taxonomy.options.find(n=>n.id===leafId).path,[root,child,leaf]);
  const supplier=await post('/api/admin/suppliers',{name:'Synthetic nested taxonomy QA',url:`https://mydrop.com.ua/taxonomy_qa_${suffix}`});
  await post(`/api/admin/suppliers/${supplier.id}/import`,{items:[{externalId:'taxonomy-fixture',title:`QA nested product ${suffix}`,description:'Synthetic only',category:'Unknown',costMinor:15000,currency:'UAH',photos:['https://example.com/qa.jpg'],variants:[{id:'m',size:'M',stock:1}]}]});
  const product=(await(await request.get('/api/admin/products')).json()).items.find(p=>p.supplierId===supplier.id);
  const patched=await request.patch(`/api/admin/products/${product.id}`,{data:{categoryId:leafId,published:true},headers:{Origin:baseURL}});assert.ok(patched.ok(),await patched.text());
  const before=(await(await request.get('/api/admin/products')).json()).items.find(p=>p.id===product.id);
  await page.reload();await page.getByRole('button',{name:'Правила розпізнавання',exact:true}).click();await page.getByRole('tab',{name:/Дерево категорій/}).click();await select(`${root} / ${child} / ${leaf}`);if(process.env.RECOGNITION_SCREENSHOTS){await page.evaluate(()=>scrollTo(0,0));await page.screenshot({path:'.claude/tmp/categories-desktop.png',fullPage:true});}
  await page.getByLabel('Назва категорії',{exact:true}).fill(renamed);await page.getByRole('button',{name:'Переглянути зміни дерева',exact:true}).click();await expect(page.getByRole('region',{name:'Вплив змін дерева'})).toContainText('QA nested product');await page.getByRole('button',{name:'Підтвердити зміни дерева',exact:true}).click();await page.getByRole('button',{name:'Застосувати зміни дерева',exact:true}).click();await expect(page.getByRole('dialog')).toHaveCount(0);
  await select(`${root} / ${child} / ${renamed}`);await page.getByLabel('Батьківська категорія',{exact:true}).selectOption(rootId);await apply();
  const publicPage=await page.context().newPage();await publicPage.route('https://example.com/**',route=>route.abort());await publicPage.goto(`/?category=${rootId}#catalog`);await expect(publicPage.getByRole('heading',{name:before.title,exact:true})).toBeVisible();await expect(publicPage.locator('.category-tree')).toContainText(renamed);await publicPage.close();
  await page.setViewportSize({width:390,height:844});
  for(const name of [/Бренди/,/Правила категорій/,/Дерево категорій/,/Історія/]){await page.getByRole('tab',{name}).click();assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true);}
  await page.getByRole('tab',{name:/Дерево категорій/}).click();await select(`${root} / ${renamed}`);await page.getByRole('button',{name:'Видалити категорію',exact:true}).click();await page.getByLabel('Перенести посилання в категорію',{exact:true}).selectOption(childId);await apply();
  taxonomy=await getTaxonomy();assert.equal(taxonomy.options.some(n=>n.id===leafId),false);
  const after=(await(await request.get('/api/admin/products')).json()).items.find(p=>p.id===product.id);assert.equal(after.categoryId,childId);assert.equal(after.published,before.published);assert.equal(after.priceMinor,before.priceMinor);assert.deepEqual(after.source,before.source);
});
