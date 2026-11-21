import test from 'node:test';
import assert from 'node:assert/strict';
import {CATEGORY_TREE,CATEGORY_OPTIONS,getCategory,categoryMatches,suggestClassification} from '../../packages/catalog/taxonomy.js';
import {validateOverrides,productProjection} from '../../apps/api/src/domain.js';

const infer=(title,category='',sizes=[])=>suggestClassification({title,category,variants:sizes.map(size=>({size}))});
const source={externalId:'synthetic-one',title:'Худі Lorem',category:'Lorem',costMinor:10000,currency:'UAH',description:'Plain text',photos:['https://example.com/photo.jpg'],variants:[{id:'m',size:'M',stock:2}]};
const row=(overrides={},item=source)=>({id:'p',supplier_id:'private-supplier',external_id:item.externalId,source_json:JSON.stringify(item),overrides_json:JSON.stringify(overrides),slug:'hoodie',updated_at:'2026-01-01T00:00:00Z'});

test('taxonomy leaf options have unique stable IDs and parent-aware matches',()=>{
 const all=[];function collect(nodes){for(const node of nodes){all.push(node.id);if(node.children)collect(node.children);}}collect(CATEGORY_TREE);
 assert.equal(new Set(all).size,all.length);
 for(const option of CATEGORY_OPTIONS){assert.equal(getCategory(option.id).children,undefined);assert.equal(option.path.at(-1),option.label);}
 assert.equal(categoryMatches('puffer-jackets','outerwear'),true);assert.equal(categoryMatches('puffer-jackets','clothing'),true);assert.equal(categoryMatches('puffer-jackets','pants'),false);assert.equal(categoryMatches('unknown','clothing'),false);assert.equal(categoryMatches('sneakers',''),true);
});
test('garment type and brand are independent with mixed brand supplier categories',()=>{
 const puffer=infer('Пуховик Ipsum чорний','Пуховики Lorem,XTR,Ipsum');assert.equal(puffer.categoryId,'puffer-jackets');assert.equal(puffer.brand,'Ipsum');assert.equal(puffer.confidence,'high');
 const cardigan=infer('Кардиган Consectetur','Кардигани Polo/Consectetur');assert.equal(cardigan.categoryId,'cardigans');assert.equal(cardigan.brand,'Consectetur');
 const polo=infer('Кардиган Polo','Кардигани Polo/Consectetur');assert.equal(polo.brand,'Polo Tempora Club');
 assert.equal(infer('Худі нова модель','Mollit').categoryId,'hoodies');assert.equal(infer('Худі нова модель','Mollit').brand,'Mollit');
});
test('specific types win over broader or mixed source labels',()=>{
 for(const [title,category,expected] of [['Зіп худі CD Company','C.D. Company','zip-hoodies'],['Костюм літній adipisci','Костюми','summer-suits'],['Костюм спортивний Lorem','Спортивні штани','tracksuits'],['Вітрівка Sitamet Isle','Жилетки/Вітрівки/Пуховики','windbreakers'],['Худі Officia','Костюми/Чоловічі Худі/Зіп худі/Кофти','hoodies'],['Зіп 1/3 Magnaline','Magnaline','sweatshirts'],['Шорти джинсові','Джинсові штани','shorts'],['Пуховик','Куртки','puffer-jackets'],['Нейлонові штани','Штани','pants-other']])assert.equal(infer(title,category).categoryId,expected,title);
 assert.equal(infer('Нова модель','Жилетки/Вітрівки/Пуховики').categoryId,'unclassified');
});
test('unknown brands and brand-only buckets never invent garment types',()=>{
 const unknown=infer('Невідома модель','NebulaBrand');assert.equal(unknown.categoryId,'unclassified');assert.equal(unknown.brand,null);assert.equal(unknown.confidence,'low');assert.ok(unknown.reasons.length);
 assert.equal(infer('Нова модель','Lorem').categoryId,'unclassified');assert.equal(infer('Нова модель','Lorem').brand,'Lorem');
 for(const title of ['UPS','AirPods','EcoFlow Delta'])assert.equal(infer(title).categoryId,'unclassified');
});
test('polo garment term is not mistaken for Tempora Club and collaborations remain reviewable',()=>{
 assert.equal(infer('Polo Lorem').brand,'Lorem');assert.equal(infer('Polo adipisci').brand,'adipisci');assert.equal(infer('Polo shirt').brand,null);assert.equal(infer('Polo shirt').categoryId,'tshirts-polos');
 assert.equal(infer('Худі Tempora Club').brand,'Polo Tempora Club');
 const collaboration=infer('Худі Lorem x Dolor');assert.equal(collaboration.brand,null);assert.equal(collaboration.categoryId,'hoodies');assert.equal(collaboration.confidence,'medium');assert.ok(collaboration.reasons.some(reason=>reason.includes('кілька')));
});
test('canonical brand aliases handle punctuation, case and supplier abbreviations',()=>{
 for(const [title,expected] of [['Худі С.D. Company','C.D. Company'],['Худі CD Company','C.D. Company'],['Худі SI','Sitamet Isle'],['Худі sitamet isle','Sitamet Isle'],['Худі TDP','The Dolor Peak'],['Худі Dolor','Dölor'],['Кросівки nova linea','Nova Linea'],['Худі Casa Elitwear','Casa Elitwear'],['Худі Elitwear Exchange','Elitwear Exchange']])assert.equal(infer(title).brand,expected,title);
});
test('shoe model inference needs realistic shoe-size evidence, never brand alone',()=>{
 const hint=infer('Lorem 97','Lorem',['40 (25см)','41.5 (26см)']);assert.equal(hint.categoryId,'sneakers');assert.equal(hint.confidence,'medium');
 assert.equal(infer('Lorem','Lorem',['40','41']).categoryId,'unclassified');assert.equal(infer('Lorem 97','Lorem',['S','M']).categoryId,'unclassified');assert.equal(infer('Lorem 97','Lorem',['60']).categoryId,'unclassified');
 assert.equal(infer('Лофери чорні').categoryId,'loafers');assert.equal(infer('Шльопанці Deserunt').categoryId,'slippers');assert.equal(infer('Черевики зимові').categoryId,'boots');assert.equal(infer('Рукавиці теплі').categoryId,'gloves');assert.equal(infer('Браслет срібний').categoryId,'jewellery');
});
test('category and brand overrides validate canonical IDs, preserve precedence and reset to automatic',()=>{
 assert.equal(validateOverrides({categoryId:'clothing'}).categoryId,'clothing');assert.throws(()=>validateOverrides({categoryId:'not-real'}));assert.throws(()=>validateOverrides({categoryId:123}));assert.throws(()=>validateOverrides({brand:'x'.repeat(101)}));assert.throws(()=>validateOverrides({brand:{}}));
 const overrides=validateOverrides({category:'Old free text',categoryId:'cardigans',brand:'Manager brand'});
 const projected=productProjection(row(overrides));assert.equal(projected.category,'Кардигани');assert.equal(projected.categoryId,'cardigans');assert.equal(projected.brand,'Manager brand');assert.equal(projected.categoryOverridden,true);assert.equal(projected.brandOverridden,true);assert.equal(projected.classificationSuggestion.categoryId,'hoodies');
 const reset=validateOverrides({categoryId:null,brand:null},overrides),automatic=productProjection(row(reset));assert.equal(automatic.categoryId,'hoodies');assert.equal(automatic.brand,'Lorem');assert.equal(automatic.categoryOverridden,false);assert.equal(automatic.brandOverridden,false);
 const unclassified=productProjection(row(validateOverrides({categoryId:'unclassified'})));assert.equal(unclassified.category,'Без категорії');assert.equal(unclassified.categoryId,'unclassified');
});
test('legacy free-text categories remain compatible and private diagnostics never reach public projections',()=>{
 const unknown=productProjection(row({}, {...source,title:'Unknown item',category:'Coats'}));assert.equal(unknown.category,'Coats');assert.equal(unknown.categoryId,'unclassified');
 const legacy=productProjection(row({category:'Manager category'}));assert.equal(legacy.category,'Manager category');assert.equal(legacy.categoryId,'unclassified');
 const publicProduct=productProjection(row({categoryId:'zip-hoodies',brand:'Custom'}),Date.now(),true);assert.equal(publicProduct.categoryId,'zip-hoodies');assert.equal(publicProduct.brand,'Custom');assert.deepEqual(publicProduct.categoryPath,['Одяг','Худі й світшоти','Зіп-худі']);
 for(const field of ['classificationSuggestion','source','supplierId','externalId','overrides','costMinor','categoryOverridden','brandOverridden'])assert.equal(field in publicProduct,false,field);
});
test('new source snapshots retain explicit category and brand rules',()=>{
 const overrides=validateOverrides({categoryId:'shirts',brand:'Curated brand'});
 const refreshed={...source,title:'Куртка adipisci',category:'Верхній одяг'};
 const result=productProjection(row(overrides,refreshed));assert.equal(result.categoryId,'shirts');assert.equal(result.brand,'Curated brand');assert.equal(result.classificationSuggestion.categoryId,'jackets');assert.equal(result.classificationSuggestion.brand,'adipisci');
});

test('persisted seed matches legacy category and alias behavior',async()=>{
 const {defaultRecognitionSettings}=await import('../../packages/catalog/taxonomy.js');const seed=defaultRecognitionSettings();
 for(const [title,category,sizes] of [['Худі С.D. Company','',[]],['Худі SI','',[]],['Худі TDP','',[]],['Худі Casa Elitwear','',[]],['Худі Elitwear Exchange','',[]],['Кардиган Polo','Кардигани Polo/Consectetur',[]],['Вітрівка Sitamet Isle','Жилетки/Вітрівки/Пуховики',[]],['Lorem 97','Lorem',['40','41']],['Шорти джинсові','Джинсові штани',[]],['Худі Lorem x Dolor','',[]],['Нова модель','Жилетки/Вітрівки/Пуховики',[]]]){const source={title,category,variants:sizes.map(size=>({size}))};const old=suggestClassification(source),next=suggestClassification(source,seed);for(const key of ['categoryId','brand','confidence'])assert.equal(next[key],old[key],`${title} ${key}`);}
});
test('literal scope priority and ambiguity are deterministic and seeded rules can be disabled',async()=>{
 const {defaultRecognitionSettings}=await import('../../packages/catalog/taxonomy.js');const seed=defaultRecognitionSettings();seed.brands.find(b=>b.name==='Lorem').enabled=false;assert.equal(suggestClassification({title:'Худі Lorem'},seed).brand,null);
 const settings={legacyEnabled:false,brands:[],categoryRules:[{id:'x',text:'model',mode:'word',supplierId:'s1',enabled:true,priority:1,specificity:1,categoryId:'shirts'},{id:'y',text:'model black',mode:'contains',supplierId:'s1',enabled:true,priority:1,specificity:1,categoryId:'jackets'}]};
 assert.equal(suggestClassification({title:'model black'},settings,'s2').categoryId,'unclassified');const ambiguous=suggestClassification({title:'model black'},settings,'s1');assert.equal(ambiguous.categoryId,'unclassified');assert.equal(ambiguous.ambiguous,true);settings.categoryRules[1].priority=2;assert.equal(suggestClassification({title:'model black'},settings,'s1').categoryId,'jackets');
});

test('Polo compatibility alias obeys enabled scope rename and global disable',async()=>{
 const {defaultRecognitionSettings}=await import('../../packages/catalog/taxonomy.js');const settings=defaultRecognitionSettings();settings.legacyEnabled=false;assert.equal(suggestClassification({title:'Polo',category:'Polo'},settings).brand,null);settings.legacyEnabled=true;const b=settings.brands.find(b=>b.id==='polo-tempora-club');b.name='Renamed Polo';assert.equal(suggestClassification({title:'Polo',category:'Polo'},settings).brand,'Renamed Polo');const a=b.aliases.find(a=>a.builtin==='brand-polo-alias');a.supplierId='one';assert.equal(suggestClassification({title:'Polo',category:'Polo'},settings,'two').brand,null);
});
test('same-span competing literal brands stay ambiguous and category-only rules rank and deduplicate targets',()=>{
 const rule=(id,text,mode='word')=>({id,text,mode,enabled:true,supplierId:null,priority:100,specificity:10});
 const settings={legacyEnabled:false,brands:[{id:'a',name:'A',enabled:true,aliases:[rule('a1','foo')]},{id:'b',name:'B',enabled:true,aliases:[rule('b1','foo','contains')]}],categoryRules:[]};
 const result=suggestClassification({title:'foo'},settings);assert.equal(result.brand,null);assert.equal(result.brandAmbiguous,true);
 settings.categoryRules=[{...rule('c1','foo'),categoryId:'hoodies'},{...rule('c2','bar'),categoryId:'hoodies'}];assert.equal(suggestClassification({title:'Unknown',category:'foo bar'},settings).categoryId,'hoodies');settings.categoryRules[1].categoryId='shirts';settings.categoryRules[1].priority=200;assert.equal(suggestClassification({title:'Unknown',category:'foo bar'},settings).categoryId,'shirts');settings.categoryRules[1].priority=100;assert.equal(suggestClassification({title:'Unknown',category:'foo bar'},settings).categoryAmbiguous,true);
});

test('reprioritized seeded broad patterns can win over their specific legacy patterns',async()=>{
 const {defaultRecognitionSettings}=await import('../../packages/catalog/taxonomy.js');const settings=defaultRecognitionSettings();settings.categoryRules.find(r=>r.categoryId==='tracksuits').priority=999;assert.equal(suggestClassification({title:'Костюм літній'},settings).categoryId,'tracksuits');settings.categoryRules.find(r=>r.categoryId==='jackets').priority=999;assert.equal(suggestClassification({title:'Пуховик jacket'},settings).categoryId,'jackets');
});
