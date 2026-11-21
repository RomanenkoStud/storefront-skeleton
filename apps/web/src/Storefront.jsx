import React, { useEffect, useMemo, useRef, useState } from 'react';
import AccountLink from './account/AccountLink.jsx';
import CartLink from './cart/CartLink.jsx';
import SizePicker from './cart/SizePicker.jsx';
import QuickAdd from './cart/QuickAdd.jsx';
import { inStockSizes } from './cart/cart-store.js';
import { api, money } from './api.js';
import { loadProducts } from './products-feed.js';
import { Icon, Brand, Notice, Empty, Photo } from './ui.jsx';
import {useTaxonomy} from './TaxonomyContext.jsx';
import FeaturedRail from './FeaturedRail.jsx';
import { navigationType } from './navigation.js';
import { EMPTY_FILTERS, PAGE_SIZE, MAX_SHOWN, changeFilters, readFilters, writeFilters, withPreserved, filterProducts, normalizeSize } from './catalog-filters.js';
import { cardCaption } from './landing/card-caption.js';
import SiteHeader from './landing/SiteHeader.jsx';
import SiteFooter from './landing/SiteFooter.jsx';
import CampaignBand from './landing/CampaignBand.jsx';
import { loadStorefrontSettings, tickerItems } from './landing/campaign.js';
import DeliveryBand from './landing/DeliveryBand.jsx';
import PosterTile, { withPosters } from './landing/PosterTile.jsx';
import { bannerView } from './landing/storefront-images.js';
import FreshDrop from './landing/FreshDrop.jsx';

function useCatalogFilters() {
  const [filters, set] = useState(() => readFilters(location.search));
  useEffect(() => { const canonical=withPreserved(writeFilters(readFilters(location.search)),location.search); const query=canonical?`?${canonical}`:''; if(query!==location.search)history.replaceState(null,'',`${location.pathname}${query}${location.hash}`); }, []);
  useEffect(() => { const back = () => set(readFilters(location.search)); window.addEventListener('popstate',back); return () => window.removeEventListener('popstate',back); }, []);
  function update(patch, {replace=false}={}) {
    set(current => {
      const next = changeFilters(current, patch);
      const query = withPreserved(writeFilters(next), location.search);
      history[replace?'replaceState':'pushState'](null,'',`${location.pathname}${query ? `?${query}` : ''}${location.hash}`);
      return next;
    });
  }
  return [filters,update];
}
function CategoryBranch({node, selected, onSelect, products, depth = 0}) {
  const {matches:categoryMatches}=useTaxonomy();
  const count = products.filter(p => categoryMatches(p.categoryId || 'unclassified', node.id)).length;
  const descendantSelected = selected && categoryMatches(selected,node.id);
  const [open,setOpen] = useState(depth===0 || !!descendantSelected);
  useEffect(()=>{if(descendantSelected)setOpen(true);},[descendantSelected]);
  return <li className={`category-branch depth-${depth}`}><div className={selected===node.id?'selected':''}>{node.children?.length ? <button className="tree-expand" aria-label={`${open?'Згорнути':'Розгорнути'}: ${node.label}`} aria-expanded={open} onClick={()=>setOpen(!open)}>{open?'−':'+'}</button> : <span className="tree-spacer"/>}<button className="tree-label" aria-pressed={selected===node.id} onClick={()=>onSelect(node.id)}><span>{node.label}</span><small>{count}</small></button></div>{open&&node.children?.length>0&&<ul>{node.children.map(child=><CategoryBranch key={child.id} node={child} selected={selected} onSelect={onSelect} products={products} depth={depth+1}/>)}</ul>}</li>;
}
function Filters({products,filters,onChange,priceError}) {
  const {tree}=useTaxonomy();
  const brands=[...new Set(products.map(p=>p.brand).filter(Boolean))].sort((a,b)=>a.localeCompare(b));
  const sizes=[...new Set(products.flatMap(p=>p.variants||[]).filter(v=>v.stock>0).map(v=>normalizeSize(v.size)).filter(Boolean))].sort((a,b)=>a.localeCompare(b,undefined,{numeric:true}));
  function toggle(field,value){onChange(current=>({...current,[field]:current[field].includes(value)?current[field].filter(x=>x!==value):[...current[field],value]}));}
  return <><div className="filter-title"><h3>Фільтри</h3><button className="text-button" onClick={()=>onChange({...EMPTY_FILTERS})}>Скинути все</button></div><section className="filter-section"><h4>Категорії</h4><button className={`all-category ${!filters.category?'selected':''}`} aria-pressed={!filters.category} onClick={()=>onChange({category:''})}><span>Усі речі</span><small>{products.length}</small></button><ul className="category-tree">{tree.map(node=><CategoryBranch key={node.id} node={node} selected={filters.category} onSelect={category=>onChange({category})} products={products}/>)}</ul></section><section className="filter-section"><h4>Бренди</h4><div className="facet-options">{brands.length?brands.map(brand=><label key={brand}><input type="checkbox" checked={filters.brands.includes(brand)} onChange={()=>toggle('brands',brand)}/><span>{brand}</span><small>{products.filter(p=>p.brand===brand).length}</small></label>):<p className="filter-note">Бренди з’являться разом із товарами.</p>}</div></section><section className="filter-section"><h4>Розмір виробника</h4><div className="size-facets">{sizes.map(size=><label key={size} className={filters.sizes.includes(size)?'checked':''}><input type="checkbox" aria-label={`Розмір ${size}`} checked={filters.sizes.includes(size)} onChange={()=>toggle('sizes',size)}/><span>{size}</span></label>)}</div></section><section className="filter-section"><h4>Ціна, ₴</h4><div className="price-facets"><label><span>Від</span><input aria-label="Мінімальна ціна, ₴" aria-invalid={!!priceError} aria-describedby={priceError?'catalog-price-error':undefined} type="number" min="0" step="1" value={filters.min} placeholder="0" onChange={e=>onChange({min:e.target.value})}/></label><span>—</span><label><span>До</span><input aria-label="Максимальна ціна, ₴" aria-invalid={!!priceError} aria-describedby={priceError?'catalog-price-error':undefined} type="number" min="0" step="1" value={filters.max} placeholder="∞" onChange={e=>onChange({max:e.target.value})}/></label></div></section><label className="available-filter"><input type="checkbox" checked={filters.available} onChange={e=>onChange({available:e.target.checked})}/>Лише в наявності</label></>;
}
function ActiveFilters({filters,onChange}) {
  const {getCategory}=useTaxonomy();
  const chips=[];
  if(filters.q)chips.push({label:`Пошук: ${filters.q}`,remove:()=>onChange({q:''})});
  if(filters.category)chips.push({label:getCategory(filters.category)?.label||filters.category,remove:()=>onChange({category:''})});
  for(const brand of filters.brands)chips.push({label:brand,remove:()=>onChange({brands:filters.brands.filter(x=>x!==brand)})});
  for(const size of filters.sizes)chips.push({label:`Розмір ${size}`,remove:()=>onChange({sizes:filters.sizes.filter(x=>x!==size)})});
  if(filters.min!==''||filters.max!=='')chips.push({label:`${filters.min||'0'} — ${filters.max||'∞'} ₴`,remove:()=>onChange({min:'',max:''})});
  if(filters.available)chips.push({label:'У наявності',remove:()=>onChange({available:false})});
  return chips.length?<div className="active-filters" aria-label="Застосовані фільтри">{chips.map((chip,i)=><button key={i} onClick={chip.remove} aria-label={`Прибрати фільтр: ${chip.label}`}>{chip.label}<Icon name="close" size={12}/></button>)}<button className="clear-filters" onClick={()=>onChange({...EMPTY_FILTERS})}>Очистити все</button></div>:null;
}
function Poster({src,alt,className=''}) {
  const [failed,setFailed]=useState(false);
  return <div className={`editorial-poster ${className} ${failed?'poster-unavailable':''}`}>{!failed&&<img src={src} alt={alt} width="1024" height="1536" loading="lazy" decoding="async" onError={()=>setFailed(true)}/>}<span className="poster-index" aria-hidden="true">LOREM STORE</span></div>;
}

export default function Storefront() {
  const taxonomy=useTaxonomy();
  const slug=location.pathname.startsWith('/products/')?decodeURIComponent(location.pathname.slice(10)):null;
  const [products,setProducts]=useState([]),[detail,setDetail]=useState(null),[loading,setLoading]=useState(true),[error,setError]=useState('');
  const [filters,updateFilters]=useCatalogFilters(),[mobileFilters,setMobileFilters]=useState(false);
  const [settings,setSettings]=useState(null);
  useEffect(()=>{let live=true;loadStorefrontSettings().then(d=>{if(live)setSettings(d);});return()=>{live=false;};},[]);
  const banner=bannerView(settings?.banner);
  useEffect(()=>{let active=true;(slug?api(`/api/products/${encodeURIComponent(slug)}`):loadProducts()).then(data=>{if(active)slug?setDetail(data):setProducts(data.items);}).catch(e=>active&&setError(e.message)).finally(()=>active&&setLoading(false));return()=>{active=false;};},[slug]);
  const filtered=useMemo(()=>filterProducts(products,filters,taxonomy),[products,filters,taxonomy]);
  const priceError=filters.min!==''&&Number(filters.min)<0?'Мінімальна ціна не може бути від’ємною.':filters.max!==''&&Number(filters.max)<=0?'Максимальна ціна має бути більшою за нуль.':filters.min!==''&&filters.max!==''&&Number(filters.min)>Number(filters.max)?'Мінімальна ціна більша за максимальну. Змініть межі або очистіть фільтр ціни.':'';
  const shownCards=filtered.slice(0,filters.shown),gridRef=useRef(null),focusFrom=useRef(null),[announce,setAnnounce]=useState('');
  // "Показати ще" is history-neutral (replaceState): Back leaves the list instead of unwinding every step, and the URL still restores the count after reload or a product visit.
  function showMore(){focusFrom.current=shownCards.length;updateFilters({shown:filters.shown+PAGE_SIZE},{replace:true});}
  useEffect(()=>{const from=focusFrom.current;if(from===null)return;focusFrom.current=null;gridRef.current?.querySelectorAll('.product-card')[from]?.querySelector('a.product-info')?.focus({preventScroll:true});setAnnounce(`Показано ${Math.min(filters.shown,filtered.length)} з ${filtered.length}`);},[filters.shown]);
  // A URL can carry more than the result set needs (shown=2400): once loaded, trim it down to the smallest whole page that holds every result.
  useEffect(()=>{if(loading||slug||error||!products.length)return;const fit=Math.max(PAGE_SIZE,Math.ceil(filtered.length/PAGE_SIZE)*PAGE_SIZE);if(filters.shown>fit)updateFilters({shown:fit},{replace:true});},[loading,slug,error,products.length,filtered.length,filters.shown]);
  // The page above the target grows once products arrive, so a /#editorial or /#catalog link is re-aligned after loading.
  // Only on a fresh navigation: a reload or Back keeps the browser's own scroll position. A malformed fragment (/#%) must never throw.
  useEffect(()=>{if(loading||slug||location.hash.length<2||navigationType()!=='navigate')return undefined;const raw=location.hash.slice(1);let el=document.getElementById(raw);if(!el){try{el=document.getElementById(decodeURIComponent(raw));}catch{el=null;}}if(!el)return undefined;const align=()=>el.scrollIntoView();align();
    // Keep the target aligned while the content above it settles (images, fonts, footer), for up to 1.5 s; any user scroll intent stops it at once.
    const stops=['wheel','touchstart','keydown','pointerdown'];let ro=null,timer=null;
    const stop=()=>{ro?.disconnect();clearTimeout(timer);stops.forEach(t=>window.removeEventListener(t,stop));};
    stops.forEach(t=>window.addEventListener(t,stop,{passive:true}));
    timer=setTimeout(stop,1500);
    if(typeof ResizeObserver==='function'){ro=new ResizeObserver(align);ro.observe(document.body);}
    return stop;},[loading,slug]);
  function quickCategory(category){const node=taxonomy.getCategory(category);updateFilters({category:node?.id||''});document.getElementById('catalog')?.scrollIntoView({behavior:'smooth'});}
  return <div className="storefront">
{banner?<div className="announcement is-sale" role="region" aria-label="Акція"><span className="sale-text">{banner.text}{banner.linkHref&&<> <a href={banner.linkHref}>{banner.linkLabel} <span aria-hidden="true">→</span></a></>}</span></div>
:<div className="announcement"><span>ЛОРЕМ ІПСУМ · ТЕСТОВЕ ОГОЛОШЕННЯ</span><span><a href="/#catalog" onClick={e=>showNewest(e,updateFilters)}>НОВІ НАДХОДЖЕННЯ <span aria-hidden="true">↓</span></a></span></div>}
<SiteHeader/>
{slug?<main className="store-main"><a className="back-link" href="/">← До каталогу</a>{error&&<Notice>{error}</Notice>}{loading?<p className="loading" role="status">Завантажуємо товар…</p>:detail&&<ProductDetail product={detail}/>}</main>:
<><section className="hero" aria-labelledby="hero-title"><div className="hero-copy"><p className="eyebrow"><span className="signal-dot"/> ОДЯГ · ВЗУТТЯ · АКСЕСУАРИ</p><h1 id="hero-title">ЛОРЕМ<br/><em>STREETWEAR</em></h1><p className="hero-description">Лорем іпсум долор сіт амет — тестовий опис вітрини.<br/>Тестовий текст про доставку, оплату й обмін.</p><a className="button primary" href="#catalog">ДО КАТАЛОГУ <Icon name="arrow"/></a><div className="hero-category-links"><button onClick={()=>quickCategory('hoodies-sweatshirts')}>{taxonomy.getCategory('hoodies-sweatshirts')?.label||'Каталог'} ↗</button><button onClick={()=>quickCategory('sneakers')}>{taxonomy.getCategory('sneakers')?.label||'Каталог'} ↗</button><button onClick={()=>quickCategory('outerwear')}>{taxonomy.getCategory('outerwear')?.label||'Каталог'} ↗</button></div></div><FreshDrop products={products} loading={loading} error={error}/></section>
<StreetStrip/>
<FeaturedRail onCategory={quickCategory}/>
<CampaignBand products={products} loading={loading}/>
<main id="catalog" className="store-main"><div className="section-heading"><div><p className="eyebrow">ДОБІРКА / ЗНАЙДИ СВОЄ</p><h2>Каталог</h2></div><span className="item-count" aria-live="polite">{filtered.length} товарів</span></div>
<div className="catalog-topline"><div className="search-field"><Icon name="search"/><input id="catalog-search" aria-label="Пошук товарів" placeholder="Худі, кросівки чи твій улюблений бренд…" value={filters.q} onChange={e=>updateFilters({q:e.target.value})}/></div><label className="sort-field"><span>Сортувати</span><select aria-label="Сортування товарів" value={filters.sort} onChange={e=>updateFilters({sort:e.target.value})}><option value="new">Спочатку нові</option><option value="price-asc">Від дешевих</option><option value="price-desc">Від дорогих</option><option value="title">За назвою</option></select></label><button className="mobile-filter-toggle button secondary" aria-expanded={mobileFilters} aria-controls="catalog-filters" onClick={()=>setMobileFilters(!mobileFilters)}>Фільтри {mobileFilters?'−':'+'}</button></div>
<ActiveFilters filters={filters} onChange={updateFilters}/>
<div className="catalog-layout">
<aside id="catalog-filters" className={`catalog-filters ${mobileFilters?'mobile-open':''}`} aria-label="Фільтри каталогу"><Filters products={products} filters={filters} onChange={updateFilters} priceError={priceError}/></aside>
<section className="catalog-results" aria-label="Товари каталогу">
{priceError&&<div id="catalog-price-error" className="price-validation"><Notice>{priceError}</Notice><button className="text-button" onClick={()=>updateFilters({min:'',max:''})}>Очистити ціну</button></div>}{error&&<Notice>{error}</Notice>}
{loading?<p className="loading" role="status">Збираємо добірку…</p>:filtered.length?
<><div className="product-grid" ref={gridRef}>{withPosters(shownCards,{products,filters,getCategory:taxonomy.getCategory,images:settings?.storefrontImages}).map(x=>x.poster?<PosterTile key={x.key} item={x} onCategory={quickCategory}/>:<ProductCard key={x.id} product={x}/>)}</div><CatalogMore shown={shownCards.length} total={filtered.length} onMore={showMore}/><p className="catalog-more-live" aria-live="polite">{announce}</p></>
:<Empty title={products.length?'Нічого не знайшли':'Нові надходження — скоро'}>{products.length?<>Зміни фільтри або почни спочатку.<br/><button className="button secondary" onClick={()=>updateFilters({...EMPTY_FILTERS})}>Очистити фільтри</button></>:'Готуємо нову добірку. Повертайся за речами у своєму ритмі.'}</Empty>}
</section></div>
</main>
<section id="editorial" className="editorial-section"><div className="editorial-copy"><p className="eyebrow">КАТЕГОРІЯ</p><h2>ХУДІ ТА<br/>СВІТШОТИ</h2><p>Лорем іпсум — тестовий текст категорії. Ціна, розміри й наявність — у картці кожної речі.</p><button className="button primary" onClick={()=>quickCategory('hoodies-sweatshirts')}>ДИВИТИСЬ ХУДІ ТА СВІТШОТИ <Icon name="arrow"/></button></div><Poster src="/editorial/city-layers.jpg" alt="Оливкова сорочка поверх сірого худі на вішаку біля теплої міської стіни, поруч кросівки й шапка" className="night-poster"/>
</section></>}
<DeliveryBand/>
<SiteFooter/>
</div>;
}
// Soft light that follows the pointer over the white photo stage (CSS vars read by streetwear.css).
function spotlight(e){const el=e.currentTarget,r=el.getBoundingClientRect();el.style.setProperty('--mx',`${((e.clientX-r.left)/r.width*100).toFixed(1)}%`);el.style.setProperty('--my',`${((e.clientY-r.top)/r.height*100).toFixed(1)}%`);}
function spotlightReset(e){e.currentTarget.style.removeProperty('--mx');e.currentTarget.style.removeProperty('--my');}
export function ProductCard({product:p,preview=false}) {
  const href=preview?undefined:`/products/${encodeURIComponent(p.slug)}`;
  const {priceLabel,soldOut}=cardCaption(p,{preview});
  return <article className={soldOut?'product-card is-sold-out':'product-card'}><div className="product-media"><a href={href} tabIndex={-1} aria-hidden="true"><div className="product-image" onPointerMove={spotlight} onPointerLeave={spotlightReset}><Photo src={p.cardPhoto||p.photos?.[0]} fallbackSrc={p.photos?.[0]} title={p.title}/>{p.freeShipping&&<span className="photo-badge">Безкоштовна доставка</span>}</div></a>{!preview&&<QuickAdd product={p}/>}{soldOut&&<span className="sold-out-caption">Немає в наявності</span>}</div><a className="product-info" href={href} tabIndex={preview?-1:undefined}><div className="product-meta"><span>{p.brand&&<strong>{p.brand}</strong>}<small>{p.category}</small></span></div><h3>{p.title}</h3><div className="product-price">{priceLabel}</div></a>{preview&&<div className="sizes">{p.variants?.map(v=><span className={v.stock?'':'unavailable'} key={v.size}>{v.size}</span>)}</div>}{p.promoText&&<p className="promo-caption">{p.promoText}</p>}</article>;
}
export function ProductDetail({product:p}) {
  return <article className="product-detail"><div className="detail-gallery">{p.photos?.length?p.photos.map((src,i)=><Photo key={`${src}-${i}`} src={src} title={`${p.title}, фото ${i+1}`}/>):<Photo title={p.title}/>}</div><div className="detail-copy"><p className="eyebrow">{p.categoryPath?.join(' / ')||p.category}{p.brand?` / ${p.brand}`:''}</p><h1>{p.title}</h1><p className="detail-price">{money(p.priceMinor)}</p>{p.freeShipping&&<span className="status published">Безкоштовна доставка</span>}{p.promoText&&<Notice type="info">{p.promoText}</Notice>}<h3>Розміри й наявність</h3><div className="size-options">{p.variants?.map(v=><span className={!v.stock?'unavailable':''} key={v.size}>{v.size}<small>{v.stock>0?'В наявності':'Немає'}</small></span>)}</div><SizePicker product={p}/><h3>Про річ</h3><p className="description">{p.description}</p><p className="detail-note">Оформіть кошик — ви отримаєте код кошика. Надішліть його менеджеру, і він підтвердить наявність та доставку.</p></div></article>;
}

// Endless running line: two identical groups slide left by one group width, so the loop has no seam.
// The phrases come from the admin "Вітрина" tool; until they load the strip keeps its height empty.
function StreetStrip(){
  const [items,setItems]=useState(null);
  useEffect(()=>{let live=true;loadStorefrontSettings().then(d=>{if(live)setItems(tickerItems(d.ticker));});return()=>{live=false;};},[]);
  if(items&&!items.length)return null;
  const words=items||[];
  const group=hidden=><div className="strip-group" aria-hidden={hidden||undefined}>{[0,1].flatMap(k=>words.map((w,i)=><React.Fragment key={`${k}-${i}`}><span>{w}</span><span className="strip-star" aria-hidden="true">✳</span></React.Fragment>))}</div>;
  return <div className="street-strip" role="marquee" aria-label={words.join(' · ')||undefined} aria-busy={items?undefined:'true'}><div className="strip-track">{items?<>{group(false)}{group(true)}</>:<span className="strip-placeholder" aria-hidden="true">&nbsp;</span>}</div></div>;
}
// Page ending: count, progress line and the next-step button under the grid. Nothing is rendered while everything fits on the first page.
function CatalogMore({shown,total,onMore}){
  if(total<=PAGE_SIZE)return null;
  const step=Math.min(PAGE_SIZE,total-shown);
  return <div className="catalog-more"><p className="catalog-more-count">Показано {shown} з {total}</p><div className="catalog-more-track" aria-hidden="true"><i style={{width:`${shown/total*100}%`}}/></div>{step>0&&shown<MAX_SHOWN&&<button type="button" className="button secondary" onClick={onMore}>Показати ще {step}</button>}</div>;
}
function showNewest(event,updateFilters){if(event.defaultPrevented||event.button!==0||event.metaKey||event.ctrlKey||event.shiftKey||event.altKey||!document.getElementById('catalog'))return;event.preventDefault();updateFilters({sort:'new'});document.getElementById('catalog')?.scrollIntoView({behavior:'smooth'});}
