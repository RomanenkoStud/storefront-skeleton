import React, { useEffect, useMemo, useState } from 'react';
import { api, money, date } from '../api.js';
import { Notice, Photo, Empty } from '../ui.jsx';
import ConfirmDialog from '../ConfirmDialog.jsx';
import { usePermission } from '../StaffPermissions.jsx';
import { PHONE, useMediaQuery } from '../admin-mobile/media.js';
import { PAGE_SIZE, CONFIDENCE_LABELS, evidenceLabels, defaultSelection, selectionProblem, rejectProblem, confirmBody, rejectBody, matchesFilter, supplierOptions, stockText } from './duplicates-logic.js';

// Cross-supplier duplicate review. Decisions only group products for review;
// a confirmed group is shown on the storefront as one merged product.
function ProductRow({ product, control, note, action, phone }) {
  if (!product) return <tr {...(phone ? { role: 'row' } : {})}><td {...(phone ? { role: 'cell' } : {})} colSpan={7}><small className="cell-note">Товар недоступний (постачальника видалено)</small></td></tr>;
  const label = product.deletedAt ? 'У кошику' : product.published ? 'Опубліковано' : 'Чернетка';
  if (phone) {
    // Phone card (admin-mobile table.m-cards): the same facts as the desktop columns, one stacked card per product.
    return <tr role="row" className={`${product.deletedAt ? 'dup-muted ' : ''}dup-row${control ? '' : ' dup-row-plain'}`}>
      <td role="cell" className="m-select dup-check">{control && <span className="m-check">{control}</span>}</td>
      <td role="cell" className="m-thumb"><Photo src={product.photo} title={product.title} className="dup-thumb"/></td>
      <td role="cell" className="m-title">{product.title}</td>
      <td role="cell" className="m-sub dup-sub">{product.sourceTitle !== product.title && <span>Постачальник: {product.sourceTitle}</span>}{note && <span>{note}</span>}</td>
      <td role="cell" className="m-price">Собівартість {money(product.costMinor)} · ціна {money(product.priceMinor)}</td>
      <td role="cell" className="m-status"><span className={`status ${product.published ? 'published' : 'draft'}`}>{label}</span></td>
      <td role="cell" className="m-meta"><span data-label="Постачальник">{product.supplierName}{!product.supplierEnabled && ' (постачальник вимкнений)'}</span><span data-label="Бренд">{product.brand || '—'}</span><span data-label="Категорія">{product.category}</span><span data-label="Наявність">{stockText(product)}</span></td>
      <td role="cell" className="m-actions">{action}</td>
    </tr>;
  }
  return <tr className={product.deletedAt ? 'dup-muted' : ''}>
    <td className="dup-check">{control}</td>
    <td><div className="dup-product"><Photo src={product.photo} title={product.title} className="dup-thumb"/><span><strong>{product.title}</strong>{product.sourceTitle !== product.title && <small className="cell-note">Постачальник: {product.sourceTitle}</small>}{note && <small className="cell-note">{note}</small>}</span></div></td>
    <td>{product.supplierName}{!product.supplierEnabled && <small className="cell-note">постачальник вимкнений</small>}</td>
    <td>{product.brand || '—'}<small className="cell-note">{product.category}</small></td>
    <td>{money(product.costMinor)}<small className="cell-note">ціна {money(product.priceMinor)}</small></td>
    <td>{stockText(product)}</td>
    <td><span className={`status ${product.published ? 'published' : 'draft'}`}>{label}</span>{action}</td>
  </tr>;
}
const PHONE_HEADS = ['Вибір', 'Фото', 'Товар', 'Примітки', 'Ціни', 'Стан', 'Деталі', 'Дії'];
const Head = ({ phone }) => <thead {...(phone ? { role: 'rowgroup' } : {})}><tr {...(phone ? { role: 'row' } : {})}>{(phone ? PHONE_HEADS : ['Вибір', 'Товар', 'Постачальник', 'Бренд / категорія', 'Собівартість', 'Наявність', 'Стан']).map((name, i) => <th key={name} {...(phone ? { role: 'columnheader' } : {})}>{i === 0 ? <span className="sr-only">{name}</span> : name}</th>)}</tr></thead>;
// Product table: phone-only m-cards markup and ARIA roles (WebKit drops table semantics when CSS changes display); the desktop DOM is unchanged.
const ProductTable = ({ phone, children }) => <div className="table-scroll"><table {...(phone ? { className: 'm-cards dup-cards', role: 'table' } : {})}><Head phone={phone}/><tbody {...(phone ? { role: 'rowgroup' } : {})}>{children}</tbody></table></div>;

function StorefrontNote({ group, products }) {
  const s = group.storefront;
  if (!s?.visible) return <span className="status draft">Не на вітрині: опублікуйте один із товарів групи</span>;
  const stock = s.sizes.filter(v => v.stock > 0).map(v => `${v.size} (${v.stock})`).join(', ') || 'немає в наявності';
  return <span className="dup-storefront">На вітрині як <a href={`/products/${encodeURIComponent(s.slug)}`} target="_blank" rel="noreferrer">«{products[s.primaryId]?.title}»</a> · {money(s.priceMinor)} · {stock}</span>;
}

function CandidateCard({ candidate, products, canEdit, onDone, setError }) {
  const phone = useMediaQuery(PHONE);
  const [selected, setSelected] = useState(() => defaultSelection(candidate, products)), [busy, setBusy] = useState(false);
  const problem = selectionProblem(candidate, selected, products), tooMany = rejectProblem(candidate), unchecked = candidate.productIds.filter(id => !selected.includes(id));
  async function run(path, method, body, message) { setBusy(true); setError(''); try { await api(path, { method, body }); onDone(message); } catch (e) { setError(e.message); setBusy(false); } }
  const toggle = id => setSelected(current => current.includes(id) ? current.filter(x => x !== id) : [...current, id]);
  return <article className="dup-card" aria-label={`Можливий дублікат: ${products[candidate.productIds[0]]?.title || ''}`}>
    <header className="dup-card-head"><span className={`status ${candidate.confidence === 'high' ? 'published' : 'draft'}`}>{CONFIDENCE_LABELS[candidate.confidence]}</span>{candidate.groupId && <span className="status">Додати до наявної групи</span>}<ul className="dup-evidence" aria-label="Чому товари схожі">{evidenceLabels(candidate).map(label => <li key={label}>{label}</li>)}</ul></header>
    <ProductTable phone={phone}>
      {(candidate.groupProductIds || []).map(id => <ProductRow phone={phone} key={id} product={products[id]} control={<input type="checkbox" checked disabled aria-label="Уже в групі"/>} note="Уже в підтвердженій групі"/>)}
      {candidate.productIds.map(id => <ProductRow phone={phone} key={id} product={products[id]} control={<input type="checkbox" checked={selected.includes(id)} disabled={!canEdit || busy} onChange={() => toggle(id)} aria-label={`Включити «${products[id]?.title}» у групу`}/>}/>)}
    </ProductTable>
    {canEdit && <footer className="dup-actions">
      {problem ? <small className="form-note" role="status">{problem}</small> : unchecked.length ? <small className="form-note">Непозначені товари ({unchecked.length}) буде записано як інші товари.</small> : null}
      <button className="button primary small" disabled={busy || !!problem} onClick={() => run('/api/admin/duplicates/groups', 'POST', confirmBody(candidate, selected), candidate.groupId ? 'Товари додано до групи.' : 'Групу дублікатів підтверджено.')}>{candidate.groupId ? 'Додати до групи' : 'Підтвердити: це один товар'}</button>
      {tooMany && <small className="form-note">{tooMany}</small>}
      <button className="button secondary small" disabled={busy || !!tooMany} onClick={() => run('/api/admin/duplicates/rejections', 'POST', rejectBody(candidate), 'Позначено як різні товари.')}>Це різні товари</button>
    </footer>}
  </article>;
}

export default function DuplicatesPanel() {
  const phone = useMediaQuery(PHONE);
  const can = usePermission(), canEdit = can('products.edit');
  const [data, setData] = useState(null), [loading, setLoading] = useState(true), [error, setError] = useState(''), [success, setSuccess] = useState('');
  const [view, setView] = useState('candidates'), [query, setQuery] = useState(''), [confidence, setConfidence] = useState(''), [supplierId, setSupplierId] = useState(''), [limit, setLimit] = useState(PAGE_SIZE), [confirmation, setConfirmation] = useState(null);
  async function load(message = '') { setLoading(true); setError(''); try { setData(await api('/api/admin/duplicates')); if (message) setSuccess(message); } catch (e) { setError(e.message); } finally { setLoading(false); } }
  useEffect(() => { load(); }, []);
  const products = data?.products || {};
  const candidates = useMemo(() => (data?.candidates || []).filter(c => matchesFilter(c, products, { query, confidence, supplierId })), [data, query, confidence, supplierId]);
  const act = async (path, method, body, message) => { setError(''); try { await api(path, { method, body }); await load(message); } catch (e) { setError(e.message); } };
  const tabs = [['candidates', 'На перевірку', data?.totals.candidates ?? 0], ['groups', 'Підтверджені групи', data?.totals.groups ?? 0], ['rejections', 'Різні товари', data?.totals.rejections ?? 0]];
  return <section className="panel staff-panel dup-panel" aria-label="Дублікати між постачальниками">
    <div className="dup-intro"><h2>Дублікати між постачальниками</h2><p>Схожі товари від різних постачальників згруповано для перевірки. Підтверджена група показується на вітрині як один товар: назва, фото й ціна — від опублікованого товару з найменшою собівартістю, а наявність розмірів сумується з усіх опублікованих товарів групи (крім тих, чия собівартість вища за ціну на вітрині). Публікацію й дані самих товарів це не змінює.</p></div>
    {error && <Notice onClose={() => setError('')}>{error}</Notice>}{success && <Notice type="success" onClose={() => setSuccess('')}>{success}</Notice>}
    <div className="dup-tabs" role="tablist" aria-label="Розділи дублікатів">{tabs.map(([id, label, count]) => <button key={id} role="tab" aria-selected={view === id} className={view === id ? 'active' : ''} onClick={() => { setView(id); setSuccess(''); }}>{label}<span>{count}</span></button>)}<button className="button secondary small" disabled={loading} onClick={() => load()}>{loading ? 'Шукаємо…' : 'Оновити'}</button></div>
    {loading && !data && <p role="status">Шукаємо можливі дублікати…</p>}
    {data && view === 'candidates' && <>
      <div className="orders-filters"><input {...(phone ? { type: 'search', enterKeyHint: 'search' } : {})} aria-label="Пошук за назвою, брендом або постачальником" placeholder="Назва, бренд або постачальник…" value={query} onChange={e => { setQuery(e.target.value); setLimit(PAGE_SIZE); }}/><select aria-label="Схожість" value={confidence} onChange={e => { setConfidence(e.target.value); setLimit(PAGE_SIZE); }}><option value="">Будь-яка схожість</option><option value="high">Висока</option><option value="medium">Середня</option></select><select aria-label="Постачальник" value={supplierId} onChange={e => { setSupplierId(e.target.value); setLimit(PAGE_SIZE); }}><option value="">Усі постачальники</option>{supplierOptions(products).map(([id, name]) => <option key={id} value={id}>{name}</option>)}</select></div>
      {candidates.length ? <>{candidates.slice(0, limit).map(c => <CandidateCard key={c.key} candidate={c} products={products} canEdit={canEdit} setError={setError} onDone={message => load(message)}/>)}<div className="orders-pager"><span>Показано {Math.min(limit, candidates.length)} з {candidates.length}</span>{limit < candidates.length && <button className="button secondary small" onClick={() => setLimit(limit + PAGE_SIZE)}>Показати ще</button>}</div></>
        : <Empty title="Можливих дублікатів не знайдено">{data.candidates.length ? 'Змініть пошук або фільтри.' : 'Нові збіги з’являться після імпорту від кількох постачальників.'}</Empty>}
    </>}
    {data && view === 'groups' && (data.groups.length ? data.groups.map(group => <article className="dup-card" key={group.id} aria-label="Підтверджена група">
      <header className="dup-card-head"><span className="status published">{group.productIds.length} товари</span><StorefrontNote group={group} products={products}/><small className="cell-note">Підтверджено {date(group.createdAt)} · {group.actor}{group.updatedAt !== group.createdAt ? ` · змінено ${date(group.updatedAt)}` : ''}</small></header>
      <ProductTable phone={phone}>{group.productIds.map(id => <ProductRow phone={phone} key={id} product={products[id]} control={null} action={canEdit && products[id] && <button className="text-button" onClick={() => setConfirmation({ title: 'Прибрати товар із групи?', body: `«${products[id].title}» буде записано як інший товар, і система більше не пропонуватиме його для цієї групи.${group.productIds.length <= 2 ? ' У групі залишиться один товар, тому її буде розформовано.' : ''}`, label: 'Прибрати', run: () => act(`/api/admin/duplicates/groups/${encodeURIComponent(group.id)}/members/${encodeURIComponent(id)}`, 'DELETE', {}, 'Товар прибрано з групи.') })}>Прибрати з групи</button>}/>)}</ProductTable>
      {canEdit && <footer className="dup-actions"><button className="button secondary small" onClick={() => setConfirmation({ title: 'Розформувати групу?', body: 'Опубліковані товари групи знову з’являться на вітрині окремо, а самі товари — серед можливих дублікатів. Дані товарів не зміняться.', label: 'Розформувати', run: () => act(`/api/admin/duplicates/groups/${encodeURIComponent(group.id)}`, 'DELETE', {}, 'Групу розформовано.') })}>Розформувати групу</button></footer>}
    </article>) : <Empty title="Підтверджених груп ще немає">Підтвердіть кандидатів у розділі «На перевірку».</Empty>)}
    {data && view === 'rejections' && (data.rejections.length ? <div className="table-scroll"><table {...(phone ? { className: 'm-cards dup-cards dup-rejections', role: 'table' } : {})}><thead {...(phone ? { role: 'rowgroup' } : {})}><tr {...(phone ? { role: 'row' } : {})}><th {...(phone ? { role: 'columnheader' } : {})}>Товари</th><th {...(phone ? { role: 'columnheader' } : {})}>Хто / коли</th><th {...(phone ? { role: 'columnheader' } : {})}><span className="sr-only">Дія</span></th></tr></thead><tbody {...(phone ? { role: 'rowgroup' } : {})}>{data.rejections.map(r => <tr {...(phone ? { role: 'row' } : {})} key={r.productIds.join('|')}><td {...(phone ? { role: 'cell' } : {})}>{r.productIds.map(id => <div key={id}><strong>{products[id]?.title || 'Товар недоступний'}</strong> <small className="cell-note">{products[id]?.supplierName}</small></div>)}</td><td {...(phone ? { role: 'cell', className: 'm-sub dup-sub' } : {})}>{r.actor}<small className="cell-note">{date(r.createdAt)}</small></td><td {...(phone ? { role: 'cell', className: 'm-actions' } : {})}>{canEdit && <button className="text-button" onClick={() => act('/api/admin/duplicates/rejections', 'DELETE', { productIds: r.productIds }, 'Пару повернуто до перевірки.')}>Повернути до перевірки</button>}</td></tr>)}</tbody></table>{data.totals.rejections > data.rejections.length && <p className="form-note">Показано останні {data.rejections.length} з {data.totals.rejections}.</p>}</div> : <Empty title="Відхилених пар немає">Пари, які ви позначите як різні товари, з’являться тут.</Empty>)}
    {confirmation && <ConfirmDialog title={confirmation.title} confirmLabel={confirmation.label} onConfirm={confirmation.run} onClose={() => setConfirmation(null)}><p>{confirmation.body}</p></ConfirmDialog>}
  </section>;
}
