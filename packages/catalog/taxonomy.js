import {createTaxonomyContext,resolveCategoryId} from './taxonomy-context.js';
export {createTaxonomyContext,resolveCategoryId} from './taxonomy-context.js';
/** Shared deterministic catalog taxonomy. No I/O or supplier-specific records. */
export const CATEGORY_TREE = [
  {id:'clothing',label:'Одяг',children:[
    {id:'outerwear',label:'Верхній одяг',children:[{id:'jackets',label:'Куртки'},{id:'puffer-jackets',label:'Пуховики'},{id:'windbreakers',label:'Вітровки'},{id:'coats-vests',label:'Пальта / жилети'}]},
    {id:'hoodies-sweatshirts',label:'Худі й світшоти',children:[{id:'hoodies',label:'Худі'},{id:'zip-hoodies',label:'Зіп-худі'},{id:'sweatshirts',label:'Світшоти'}]},
    {id:'knitwear',label:'Трикотаж',children:[{id:'cardigans',label:'Кардигани'},{id:'sweaters',label:'Светри'},{id:'turtlenecks',label:'Гольфи'}]},
    {id:'tshirts-polos',label:'Футболки / поло'},{id:'shirts',label:'Сорочки'},
    {id:'pants',label:'Штани',children:[{id:'jeans',label:'Джинси'},{id:'cargo',label:'Карго'},{id:'joggers',label:'Спортивні штани'},{id:'shorts',label:'Шорти'},{id:'pants-other',label:'Інші штани'}]},
    {id:'suits',label:'Костюми',children:[{id:'tracksuits',label:'Спортивні костюми'},{id:'summer-suits',label:'Літні костюми'}]},
  ]},
  {id:'footwear',label:'Взуття',children:[{id:'sneakers',label:'Кросівки'},{id:'canvas-shoes',label:'Кеди'},{id:'slippers',label:'Капці'},{id:'loafers',label:'Лофери'},{id:'boots',label:'Черевики'}]},
  {id:'accessories',label:'Аксесуари',children:[{id:'bags',label:'Сумки'},{id:'belts',label:'Ремені'},{id:'glasses',label:'Окуляри'},{id:'hats-caps',label:'Шапки / кепки'},{id:'socks-underwear',label:'Шкарпетки / білизна'},{id:'gloves',label:'Рукавиці'},{id:'jewellery',label:'Прикраси й годинники'}]},
  {id:'unclassified',label:'Без категорії'},
];
const index=new Map();
function register(nodes,path=[],ancestors=[]){for(const node of nodes){index.set(node.id,{...node,path:[...path,node.label],ancestors:[...ancestors]});if(node.children)register(node.children,[...path,node.label],[...ancestors,node.id]);}}
register(CATEGORY_TREE);
/** Selectable leaf categories; parents remain available through CATEGORY_TREE. */
export const CATEGORY_OPTIONS=[...index.values()].filter(node=>!node.children).map(({id,label,path})=>({id,label,path}));
export function getCategory(id,taxonomy=null){const context=taxonomy?createTaxonomyContext(taxonomy):null;return (context?.index??index).get(resolveCategoryId(id,context))??null;}
export function categoryMatches(productCategoryId,selectedId,taxonomy=null){if(!selectedId)return true;const context=taxonomy?createTaxonomyContext(taxonomy):null,node=getCategory(productCategoryId,context),target=resolveCategoryId(selectedId,context);return !!node&&(node.id===target||node.ancestors.includes(target));}
const normalized=value=>typeof value==='string'?value.normalize('NFKC').toLowerCase().replace(/[’`]/g,"'").replace(/[_–—]/g,'-'):'';
// Most specific rules precede broad garment words. Avoid matching a brand as a type.
export const BUILTIN_CATEGORY_RULES=[
 ['summer-suits',/(?:костюм[\p{L}\s/-]*(?:літ|лет)|(?:літн|летн)[\p{L}\s/-]*костюм|summer\s+(?:suit|set)|(?:костюм|suit)[\p{L}\s/-]*summer)/u,130],
 ['tracksuits',/(?:костюм|tracksuit|track\s+suit)/u,125],
 ['puffer-jackets',/(?:пухов|puffer|down\s+jacket)/u,120],
 ['zip-hoodies',/(?:з[іи]п[\s-]*(?:худ[іи]|кофт)|zip[\s-]*(?:hood|худ)|(?:худ[іи]|hoodie)[\p{L}\s-]*(?:блискав|молни))/u,115],
 ['sweatshirts',/(?:з[іи]п\s*1\/3|quarter[ -]zip|св[іи]тшот|свитшот|sweatshirt|ол[іи]мп[іи]йк)/u,110],
 ['windbreakers',/(?:в[іи]тр[оіи]в|ветров|windbreaker|sherpa|шерп)/u,110],
 ['coats-vests',/(?:пальт|жилет|жилетк|\bvest\b|\bovercoat\b)/u,110],
 ['cardigans',/(?:кардиган|cardigan)/u,110],['turtlenecks',/(?:гольф|водолаз|turtleneck)/u,110],
 ['sweaters',/(?:светр|свитер|джемпер|sweater|jumper)/u,105],
 ['shorts',/(?:шорт|shorts)/u,115],['jeans',/(?:джинс|\bjeans\b|\bdenim\b)/u,105],
 ['cargo',/(?:карго|\bcargo\b)/u,110],['joggers',/(?:спортивн[\p{L}\s/-]*(?:штан|брюк)|(?:штан|брюк)[\p{L}\s/-]*спортивн|джогер|джоггер|jogger|sweatpants|track\s*pants)/u,110],
 ['pants-other',/(?:штан|брюк|\btrousers\b|\bpants\b)/u,70],
 ['slippers',/(?:шльоп|шл[её]п|тапк|капц|slipper|slide|clog)/u,110],['loafers',/(?:лофер|loafer)/u,110],['boots',/(?:черевик|ботин|чоб[іо]т|\bboot)/u,110],
 ['gloves',/(?:рукавиц|перчат|glove)/u,110],['jewellery',/(?:годинник|час[иы]|браслет|ланцюж|ланцюг|к[іо]льц|прикраси|jewell?ery|bracelet|watch)/u,110],
 ['hoodies',/(?:худ[іи]|hoodie)/u,95],['tshirts-polos',/(?:футбол|т[іи]шорт|лонгсл[іи]в|\bpolo\s+(?:shirt|lorem|adipisci)\b|\bt-?shirt\b|\btee\b|\blongsleeve\b|поло)/u,95],
 ['shirts',/(?:сороч|рубаш|оверш[оі]т|overshirt|\bshirt\b)/u,90],
 ['jackets',/(?:куртк|jacket)/u,90],
 ['sneakers',/(?:крос[іи]в|кроссов|sneaker|trainer)/u,110],['canvas-shoes',/(?:(?:^|[^\p{L}])кед[иыа]?(?=$|[^\p{L}])|canvas\s+shoe)/u,110],
 ['bags',/(?:сумк|рюкзак|гамане?ц|кошел[её]к|\bbag\b|backpack|wallet)/u,110],['belts',/(?:ремен|рем[іи]н|ремн[іи]|\bbelt\b)/u,110],
 ['glasses',/(?:окуляр|очк[иі]|glasses|sunglasses)/u,110],['hats-caps',/(?:шапк|кепк|панам|балаклав|\bcap\b|\bhat\b|beanie)/u,110],
 ['socks-underwear',/(?:шкарпет|носк|б[іе]лизн|бель[её]|термо|\bsock|underwear)/u,110],
];
function categoryEvidence(value,settings,supplierId,taxonomy){
 const configured=settings?.categoryRules;
 const matches=(configured?configured.filter(rule=>rule.enabled&&(!rule.builtin||settings.legacyEnabled)&&(!rule.supplierId||rule.supplierId===supplierId)&&ruleMatches(rule,value,'category')).map(rule=>({id:rule.categoryId,weight:rule.priority,specificity:rule.specificity,ruleId:rule.id,builtin:!!rule.builtin})):BUILTIN_CATEGORY_RULES.filter(([,regex])=>regex.test(normalized(value))).map(([id,,weight])=>({id,weight,specificity:0})));
 for(const match of matches)match.id=getCategory(match.id,taxonomy)?.id??'unclassified';
 const redundant=new Set();
 const suppress=(specific,broad)=>{const a=matches.find(r=>r.id===specific),b=matches.find(r=>r.id===broad);if(a&&b&&(a.weight>b.weight||a.weight===b.weight&&a.specificity>=b.specificity))redundant.add(broad);};
 suppress('summer-suits','tracksuits');suppress('zip-hoodies','hoodies');
 for(const id of ['puffer-jackets','windbreakers'])suppress(id,'jackets');
 for(const id of ['jeans','cargo','joggers','shorts'])suppress(id,'pants-other');suppress('shorts','jeans');
 const ranked=matches.filter(item=>!item.builtin&&settings||!redundant.has(item.id)).sort((a,b)=>b.weight-a.weight||b.specificity-a.specificity);return ranked.filter((item,i)=>ranked.findIndex(other=>other.id===item.id)===i);
}
export const BUILTIN_BRAND_RULES=[
 ['Polo Tempora Club',/\b(?:polo\s+tempora(?:\s+club)?|tempora\s+club)\b/i],
 ['C.D. Company',/(?:^|[^\p{L}])[сc]\s*\.?\s*d\s*\.?\s*(?:company)?(?=$|[^\p{L}])/iu],
 ['Sitamet Isle',/(?:\b[Ss][Ii][Tt][Aa][Mm][Ee][Tt]\s*[Ii][Ss][Ll][Ee]\b|\bSI\b)/],
 ['The Dolor Peak',/\b(?:the\s+dolor\s+peak|tdp)\b/i],['Nova Linea',/\bnova\s+linea\b/i],
 ['Ipsum',/\bipsum\b/i],['Lorem',/\b(?:lorem|lorum\s+xtr)\b/i],['adipisci',/\badipisci\b/i],['Magnaline',/\bmagnalin[ae]\b/i],
 ['Dölor',/\bd[öo]lor\b/i],['Chroma Cordis',/\bchroma\s+cordis\b/i],['Ludo Vetta',/\bludo\s+vetta\b/i],
 ['Casa Elitwear',/\bcasa\s+elitwear\b/i],['Elitwear Exchange',/\belitwear\s+exchange\b/i],['Elitwear',/\belitwear\b/i],
 ['Sed’cotto',/\bsed['’]?cotto\b/i],['Aute Irure',/\baute\s+irure\b/i],['Palma Nubes',/\bpalma\s+nubes\b/i],
 ...['Consectetur','Pariatur','Velit','Cillum','Fugiat','Nullam','Occaecat','Cupidatat','Proident','Culpa','Officia','Anim','Animo','Mollit','Deserunt','Laborum','Aliqua','Minima','Veniam','Quis Nostrud','Ullamco Laboris','Commodo','Duis','Denim Lacrimae'].map(brand=>[brand,new RegExp(`\\b${brand.replaceAll(' ','\\s+')}\\b`,'i')]),
];
function brands(value,allowPoloAlias=false,settings,supplierId){if(typeof value!=='string')return[];const input=value.normalize('NFKC');const brandRules=settings?settings.brands.filter(b=>b.enabled).flatMap(b=>b.aliases.filter(r=>r.enabled&&(!r.builtin||settings.legacyEnabled)&&(!r.supplierId||r.supplierId===supplierId)).map(r=>[b.name,{exec:input=>{const match=matchRule(r,input,'brand');if(match){match.ruleId=r.id;match.priority=r.priority;match.specificity=r.specificity;match.builtin=!!r.builtin;}return match;}}])):BUILTIN_BRAND_RULES;const found=brandRules.map(([brand,regex])=>{const match=regex.exec(input);return match?{brand,position:match.index,length:match[0].length,ruleId:match.ruleId,priority:match.priority??0,specificity:match.specificity??0,builtin:match.builtin??!settings}:null;}).filter(Boolean);const polo=legacyPolo(settings,supplierId);if(allowPoloAlias&&polo&&!found.some(item=>item.brand===polo.brand)){const alias=/\bpolo\b/i.exec(input);if(alias)found.push({...polo,position:alias.index,length:alias[0].length});}found.sort((a,b)=>(settings?b.priority-a.priority||b.specificity-a.specificity:0)||a.position-b.position||b.length-a.length);return found.filter((item,i)=>!found.some((other,j)=>j<i&&(!settings||other.brand===item.brand||other.builtin&&item.builtin)&&other.position<=item.position&&other.position+other.length>=item.position+item.length));}
export function suggestClassification(source={},settings=null,supplierId=null,taxonomy=null) {
 const title=typeof source?.title==='string'?source.title:'',category=typeof source?.category==='string'?source.category:'';
 const titleTypes=categoryEvidence(title,settings,supplierId,taxonomy);let categoryTypes=categoryEvidence(category,settings,supplierId,taxonomy);if(categoryTypes.some(r=>!r.builtin&&settings)){const top=categoryTypes[0];categoryTypes=categoryTypes.filter(r=>r.weight===top.weight&&r.specificity===top.specificity);}const reasons=[];
 let evidence=titleTypes[0],from='title';
 // When both sources agree on a family, retain the more specific source hint.
 if(!evidence){evidence=categoryTypes.length===1?categoryTypes[0]:null;from='category';}
 else if(categoryTypes.length===1&&categoryTypes[0].weight>evidence.weight){const a=getCategory(evidence.id,taxonomy),b=getCategory(categoryTypes[0].id,taxonomy);if(a?.ancestors.at(-1)===b?.ancestors.at(-1)){evidence=categoryTypes[0];from='category';}}
 const categoryBrands=brands(category,true,settings,supplierId);
 const titleBrands=brands(title,false,settings,supplierId);
 const polo=legacyPolo(settings,supplierId);if(!titleBrands.length&&polo&&categoryBrands.some(item=>item.brand===polo.brand)&&/\bpolo\b/i.test(title))titleBrands.push(polo);
 const bestBrands=items=>{if(!settings||!items.length)return items;const best=[...items].sort((a,b)=>b.priority-a.priority||b.specificity-a.specificity)[0];return items.filter(a=>a.priority===best.priority&&a.specificity===best.specificity).filter((a,i,all)=>all.findIndex(b=>b.brand===a.brand)===i);};
 const rankedTitle=bestBrands(titleBrands),rankedCategory=bestBrands(categoryBrands);
 titleBrands.splice(0,titleBrands.length,...rankedTitle);categoryBrands.splice(0,categoryBrands.length,...rankedCategory);
 const brand=titleBrands.length===1?titleBrands[0].brand:titleBrands.length>1?null:categoryBrands.length===1?categoryBrands[0].brand:null;
 const ambiguousBrands=titleBrands.length>1||(!titleBrands.length&&categoryBrands.length>1);
 if(brand)reasons.push(titleBrands.length?`Бренд «${brand}» знайдено в назві товару.`:`Бренд «${brand}» знайдено в однозначній категорії постачальника.`);
 else reasons.push(ambiguousBrands?'Є кілька можливих брендів; потрібна перевірка менеджера.':'Відомий бренд не визначено.');
 let confidence='low';
 if(evidence){reasons.unshift(`Тип «${getCategory(evidence.id,taxonomy).label}» визначено ${from==='title'?'за назвою товару':'за категорією постачальника'}.`);confidence=from==='title'?'high':categoryTypes.length===1?'high':'medium';}
 else {
  // Shoe-model hints need a model name plus shoe-sized variants. A brand alone is insufficient.
  const sizes=Array.isArray(source?.variants)?source.variants.map(v=>{const match=/^(?:EU\s*)?(\d{2})(?:[.,]\d)?(?:\D|$)/i.exec(String(v?.size??''));return match?Number(match[1]):NaN;}):[];
  const shoeSizes=sizes.length>0&&sizes.every(size=>size>=35&&size<=49);
  if((!settings||settings.legacyEnabled)&&shoeSizes&&/(?:aero\s+(?:glide|loft|vaporloft)|\bswoop\b|\bzephyr\b|q-?7000|gel-ventus|\b2207r\b|lorem\s+(?:97|tn|dn)\b)/i.test(title)){evidence={id:'sneakers'};confidence='medium';reasons.unshift('Модель взуття в назві підтверджена діапазоном розмірів; перевірте категорію.');}
  else reasons.unshift('Тип товару не визначено; потрібна перевірка менеджера.');
 }
 if(ambiguousBrands&&confidence==='high'){confidence='medium';reasons.push('Категорія розпізнана, але бренд потребує уточнення.');}
 const relevant=from==='title'?titleTypes:categoryTypes;const tied=settings&&((!evidence&&categoryTypes.length>1&&categoryTypes.some(r=>!r.builtin))||evidence&&relevant.some(r=>r.id!==evidence.id&&(!r.builtin||!evidence.builtin)&&r.weight===evidence.weight&&r.specificity===evidence.specificity));
 if(tied){evidence=null;confidence='low';reasons.unshift('Правила однакової пріоритетності суперечать одне одному; потрібна перевірка.');}
 const node=getCategory(evidence?.id||'unclassified',taxonomy);
 return{categoryId:node.id,category:node.label,categoryPath:[...node.path],brand,confidence,reasons,ambiguous:!!tied||ambiguousBrands,categoryAmbiguous:!!tied,brandAmbiguous:ambiguousBrands,evidence:{categoryRuleId:evidence?.ruleId??null,brandRuleIds:[...titleBrands,...categoryBrands].map(b=>b.ruleId).filter(Boolean)}};
}

const stableId=value=>value.normalize('NFKD').replace(/[’']/g,'').replace(/[^a-zA-Z0-9]+/g,'-').replace(/^-|-$/g,'').toLowerCase();
export function defaultRecognitionSettings(){return {legacyEnabled:true,categoryRules:BUILTIN_CATEGORY_RULES.map(([categoryId,,priority],i)=>({id:`category-${i}`,categoryId,text:categoryId,mode:'contains',supplierId:null,priority,specificity:0,enabled:true,builtin:`category-${i}`})),brands:BUILTIN_BRAND_RULES.map(([name],i)=>({id:stableId(name),name,enabled:true,aliases:[{id:`brand-${i}`,text:name,mode:'word',supplierId:null,priority:0,specificity:0,enabled:true,builtin:`brand-${i}`}]})).map(b=>b.id==='polo-tempora-club'?{...b,aliases:[...b.aliases,{id:'brand-polo-alias',text:'polo',mode:'word',supplierId:null,priority:0,specificity:0,enabled:true,builtin:'brand-polo-alias'}]}:b)};}
function matchRule(rule,value,kind){
 const input=String(value??'').normalize('NFKC');
 if(rule.builtin){if(rule.builtin==='brand-polo-alias')return null;const i=Number(rule.builtin.split('-').at(-1));const regex=(kind==='category'?BUILTIN_CATEGORY_RULES:BUILTIN_BRAND_RULES)[i]?.[1];return regex?.exec(kind==='category'?normalized(input):input)??null;}
 const hay=normalized(input),needle=normalized(rule.text);let position=hay.indexOf(needle);
 while(position>=0){const before=hay[position-1]??'',after=hay[position+needle.length]??'';if(rule.mode==='contains'||rule.mode==='exact'&&hay===needle||rule.mode==='word'&&!/[\p{L}\p{N}]/u.test(before)&&!/[\p{L}\p{N}]/u.test(after)){const result=[hay.slice(position,position+needle.length)];result.index=position;return result;}position=hay.indexOf(needle,position+1);}return null;
}
function ruleMatches(rule,value,kind){return !!matchRule(rule,value,kind);}

function legacyPolo(settings,supplierId){
 if(!settings)return{brand:'Polo Tempora Club',priority:0,specificity:0,builtin:true};
 if(!settings.legacyEnabled)return null;
 for(const brand of settings.brands){if(!brand.enabled)continue;const alias=brand.aliases.find(a=>a.enabled&&a.builtin==='brand-polo-alias'&&(!a.supplierId||a.supplierId===supplierId));if(alias)return{brand:brand.name,priority:alias.priority,specificity:alias.specificity,ruleId:alias.id,builtin:true};}return null;
}
