import React, {useEffect,useState} from 'react';
import {api,date} from './api.js';
import {Notice} from './ui.jsx';
import {PHONE,useMediaQuery} from './admin-mobile/media.js';
// phone-only card markup; the desktop DOM is unchanged.
const cell=(phone,className,label)=>phone?{role:'cell',...(className?{className}:{}),...(label?{'data-label':label}:{})}:{};
const ACTION_LABELS={'product.price.override':'Встановлено ручну ціну товару','product.price.reset':'Ручну ціну товару скинуто','cart.pd-retention':'Видалено персональні дані замовлень (термін зберігання)'};
export default function AuditLog(){
  const phone=useMediaQuery(PHONE);
  const [items,setItems]=useState([]),[next,setNext]=useState(null),[busy,setBusy]=useState(false),[error,setError]=useState('');
  async function load(before){setBusy(true);setError('');try{const result=await api(`/api/admin/audit?limit=50${before?`&before=${encodeURIComponent(before)}`:''}`);setItems(current=>before?[...current,...result.items]:result.items);setNext(result.next);}catch(e){setError(e.message);}finally{setBusy(false);}}
  useEffect(()=>{load();},[]);
  return <section className="panel staff-panel" aria-label="Журнал дій"><h2>Журнал дій</h2>{error&&<Notice>{error}</Notice>}<button className="button secondary" disabled={busy} onClick={()=>load()}>Оновити журнал</button>{busy&&<p role="status">Завантажуємо журнал…</p>}<div className="table-scroll"><table {...(phone?{className:'m-cards audit-cards',role:'table'}:{})}><thead {...(phone?{role:'rowgroup'}:{})}><tr {...(phone?{role:'row'}:{})}>{['Час','Хто','Роль','Дія','Об’єкт','Подробиці'].map(h=><th key={h} {...(phone?{role:'columnheader'}:{})}>{h}</th>)}</tr></thead><tbody {...(phone?{role:'rowgroup'}:{})}>{items.map(item=><tr key={item.id} {...(phone?{role:'row'}:{})}><td {...cell(phone,'audit-time','Час')}>{date(item.createdAt)}</td><td {...cell(phone,'audit-actor')}>{item.actor}</td><td {...cell(phone,'audit-role')}>{item.actorRole||'—'}</td><td {...cell(phone,'audit-action')}>{ACTION_LABELS[item.action]||item.action}</td><td {...cell(phone,'audit-object','Об’єкт')}>{item.resourceId||'—'}</td><td {...cell(phone,'audit-details')}>{phone?(item.details?<details><summary>Подробиці</summary><pre>{JSON.stringify(item.details,null,2)}</pre></details>:'—'):<pre>{item.details?JSON.stringify(item.details,null,2):'—'}</pre>}</td></tr>)}</tbody></table></div>{!busy&&!items.length&&<p>Записів поки немає.</p>}{next&&<button className="button secondary" disabled={busy} onClick={()=>load(next)}>Попередні записи</button>}</section>;
}
