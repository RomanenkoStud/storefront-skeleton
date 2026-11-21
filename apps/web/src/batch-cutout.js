// Pure sequential batch runner for background removal. All I/O is injected.
const retrievable=src=>typeof src==='string'&&(/^https:\/\/\S+$/i.test(src)||/^\/media\/[A-Za-z0-9._-]+$/.test(src));

export function planBatch(products,lineages,{allPhotos=false}={}){
  const items=[];
  for(const product of products){
    const photos=product.photos||[],lineage=lineages[product.id];
    if(!photos.length){items.push({productId:product.id,title:product.title,index:0,src:null,skip:'У товару немає фото'});continue;}
    if(lineage?.error){items.push({productId:product.id,title:product.title,index:0,src:photos[0],fail:lineage.error});continue;}
    for(const index of allPhotos?photos.keys():[0]){
      const src=photos[index],item={productId:product.id,title:product.title,index,src};
      if(Object.hasOwn(lineage?.originals||{},src))item.skip='Фото вже без фону';
      else if(!retrievable(src))item.skip='Фото недоступне для завантаження (потрібне HTTPS-посилання або власне фото)';
      items.push(item);
    }
  }
  return items;
}

// loadLineage(id) -> {originals}; cutout(item) -> {url}; persist(id, photos) -> Promise.
// isCancelled() is checked before each item, so a cancel finishes the current item first.
export async function runBatch({products,allPhotos=false,loadLineage,cutout,persist,loadProduct,isCancelled=()=>false,onProgress=()=>{}}){
  const lineages={};
  for(const product of products){
    if(isCancelled())break;
    try{lineages[product.id]=await loadLineage(product.id);}catch(e){lineages[product.id]={error:`Не вдалося перевірити історію фото: ${e.message}`};}
  }
  const unloaded=products.filter(p=>!lineages[p.id]);
  if(unloaded.length&&isCancelled()){
    const planned=planBatch(products.filter(p=>lineages[p.id]),lineages,{allPhotos}),rest=unloaded.reduce((n,p)=>n+Math.max(1,allPhotos?(p.photos||[]).length:1),0);
    return {total:planned.length+rest,ok:[],skipped:[],failed:[],cancelled:true,remaining:planned.length+rest};
  }
  const items=planBatch(products.filter(p=>lineages[p.id]),lineages,{allPhotos});
  const photos=Object.fromEntries(products.map(p=>[p.id,[...(p.photos||[])]]));
  const read=loadProduct||(async id=>({photos:photos[id]}));
  const summary={total:items.length,ok:[],skipped:[],failed:[],cancelled:false,remaining:0};
  const emit=current=>onProgress({total:summary.total,done:summary.ok.length+summary.skipped.length+summary.failed.length,current,ok:summary.ok.length,skipped:summary.skipped.length,failed:summary.failed.length});
  for(const [position,item] of items.entries()){
    if(isCancelled()){summary.cancelled=true;summary.remaining=items.length-position;break;}
    if(item.skip){summary.skipped.push({...item,reason:item.skip});emit(item);continue;}
    if(item.fail){summary.failed.push({...item,reason:item.fail});emit(item);continue;}
    emit(item);
    let saved;
    try{saved=await cutout(item);}catch(e){summary.failed.push({...item,reason:e.message||'Невідома помилка'});emit(item);continue;}
    try{
      // Re-read right before writing so photo edits made during processing are not overwritten.
      const current=[...((await read(item.productId)).photos||[])],at=current.indexOf(item.src);
      if(at<0){summary.skipped.push({...item,reason:'Фото змінилося під час обробки'});emit(item);continue;}
      const next=[...current];next[at]=saved.url;
      await persist(item.productId,next);photos[item.productId]=next;summary.ok.push({...item,url:saved.url});
    }
    catch(e){summary.failed.push({...item,reason:`Вирізане фото збережено, але список фото не оновлено: ${e.message}`});}
    emit(item);
  }
  return summary;
}
