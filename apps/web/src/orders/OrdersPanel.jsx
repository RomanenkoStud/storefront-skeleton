import React, { useEffect, useRef, useState } from 'react';
import { date, money } from '../api.js';
import { Notice } from '../ui.jsx';
import ConfirmDialog from '../ConfirmDialog.jsx';
import { usePermission } from '../StaffPermissions.jsx';
import MobileActionBar from '../admin-mobile/MobileActionBar.jsx';
import FilterDisclosure from '../admin-mobile/FilterDisclosure.jsx';
import { PHONE, useMediaQuery } from '../admin-mobile/media.js';
import {
  ACTION_LABELS, NOTE_MAX, STATUS_FILTERS, errorText, groupBySupplier, listCarts, loadCart, pageCount,
  parseLookup, statusLabel, supplierSummary, changeStatus, visibleActions,
  PD_ERASED_LABEL, NOTE_PRIVACY_HINT, RETENTION_HINT, isErased, recipientView, deliveryView, recipientShort, deliveryShort,
} from './orders-logic.js';

// «Отримувач» and «Доставка»: the order's own snapshot, never the customer's account or profile.
function OrderPersonal({ cart }) {
  if (isErased(cart)) return <p className="orders-erased" role="note"><strong>{PD_ERASED_LABEL}</strong> · {date(cart.personalDataErasedAt)}</p>;
  const recipient = recipientView(cart.recipient), delivery = deliveryView(cart.delivery);
  const missing = cart.bound ? 'Не вказано' : 'Не вказано: оформлено без входу, дані є лише в повідомленні клієнта';
  return <dl className="orders-facts orders-personal">
    <div><dt>Отримувач</dt><dd>{recipient ? <>{recipient.name}<br />{recipient.tel ? <a href={`tel:${recipient.tel}`}>{recipient.phone}</a> : recipient.phone}</> : missing}</dd></div>
    <div><dt>Доставка</dt><dd>{delivery ? <>{delivery.kind}, {delivery.city}{delivery.name && <><br /><span className="orders-point-name">{delivery.name}</span></>}</> : missing}</dd></div>
  </dl>;
}


function StatusBadge({ status }) { return <span className={`status order-status order-${status}`}>{statusLabel(status)}</span>; }

function CopyButton({ text, label }) {
  const [state, setState] = useState('');
  async function copy() {
    try { await navigator.clipboard.writeText(text); setState('Скопійовано'); } catch { setState('Не вдалося скопіювати: виділіть текст нижче вручну'); }
  }
  return <><button type="button" className="button secondary small" onClick={copy}>{label}</button><span role="status" className="orders-copy-state">{state}</span></>;
}

function SupplierGroup({ group, cart }) {
  const phone = useMediaQuery(PHONE);
  const text = supplierSummary(group, cart);
  return <section className="orders-group" aria-label={`Постачальник ${group.supplierName}`}>
    <header><h3>{group.supplierName}</h3><span>{group.lines.length} поз. · {group.quantity} шт.{group.costKnown ? ` · закупівля ${money(group.costMinor)}` : ''}</span></header>
    {phone ? <div className="table-scroll"><table className="m-cards orders-lines" role="table"><caption className="sr-only">Позиції постачальника {group.supplierName}</caption><thead role="rowgroup"><tr role="row"><th role="columnheader" scope="col">Товар</th><th role="columnheader" scope="col">Кількість і ціни</th><th role="columnheader" scope="col">Ідентифікатори</th></tr></thead><tbody role="rowgroup">
      {group.lines.map((l, i) => <tr role="row" key={`${l.productId}-${l.size}-${i}`}>
        <td role="cell" className="m-title">{l.title}</td>
        <td role="cell" className="m-meta"><span data-label="Розмір × к-сть">{l.size} × {l.quantity}</span><span data-label="Ціна">{money(l.unitPriceMinor)}</span><span data-label="Закупівля">{l.unitCostMinor == null ? 'невідомо' : money(l.unitCostMinor)}</span></td>
        <td role="cell" className="m-meta"><span data-label="ID у постачальника"><code>{l.externalProductId}</code></span><span data-label="ID варіантів">{(l.variantIds || []).join(', ') || '—'}</span></td>
      </tr>)}
    </tbody></table></div>
    : <div className="table-scroll"><table><caption className="sr-only">Позиції постачальника {group.supplierName}</caption><thead><tr><th scope="col">Товар</th><th scope="col">ID у постачальника</th><th scope="col">Розмір</th><th scope="col">К-сть</th><th scope="col">Закупівля</th><th scope="col">Ціна</th><th scope="col">ID варіантів</th></tr></thead><tbody>
      {group.lines.map((l, i) => <tr key={`${l.productId}-${l.size}-${i}`}><td>{l.title}</td><td><code>{l.externalProductId}</code></td><td>{l.size}</td><td>{l.quantity}</td><td>{l.unitCostMinor == null ? 'невідомо' : money(l.unitCostMinor)}</td><td>{money(l.unitPriceMinor)}</td><td className="orders-variants">{(l.variantIds || []).join(', ') || '—'}</td></tr>)}
    </tbody></table></div>}
    <div className="orders-copy"><CopyButton text={text} label={`Копіювати для ${group.supplierName}`} /><textarea readOnly rows={Math.min(10, text.split('\n').length)} value={text} aria-label={`Текст замовлення для ${group.supplierName}`} onFocus={e => e.target.select()} /></div>
  </section>;
}

export function CartDetail({ cart, permissions, onChange, onBack }) {
  const phone = useMediaQuery(PHONE);
  const [note, setNote] = useState(''), [busy, setBusy] = useState(false), [error, setError] = useState(''), [info, setInfo] = useState(''), [confirm, setConfirm] = useState(false);
  useEffect(() => { setNote(''); }, [cart.code]);
  const actions = visibleActions(cart, permissions);
  const readOnly = !permissions.includes('orders.operate');
  async function run(status) {
    setBusy(true); setError(''); setInfo('');
    try {
      const result = await changeStatus(cart, status, note);
      onChange(result.cart);
      if (result.conflict) setError(`Статус уже змінили: зараз «${statusLabel(result.cart.status)}». Дані оновлено, перевірте й повторіть дію за потреби.`);
      else { setInfo(`Статус змінено на «${statusLabel(result.cart.status)}».`); setNote(''); }
    } catch (e) { const message = errorText(e); setError(message); throw new Error(message); } finally { setBusy(false); }
  }
  // On phones the status actions live in the sticky MobileActionBar, which can unmount once the new status has no actions: keep focus on the heading.
  const quick = status => run(status).then(() => true, () => false).then(ok => {
    // Only after success, and only when focus was lost (the bar unmounted or its buttons were disabled): never steal focus or scroll.
    const active = document.activeElement;
    if (phone && ok && (!active || active === document.body || !active.isConnected)) document.getElementById('order-heading')?.focus({ preventScroll: true });
  });
  const barActions = actions.map(status => ({ key: status, label: ACTION_LABELS[status], tone: status === 'cancelled' ? 'danger' : 'primary', disabled: busy, onClick: () => (status === 'cancelled' ? setConfirm(true) : quick(status)) }));
  const groups = groupBySupplier(cart.lines);
  return <article className="panel orders-detail" aria-label={`Кошик ${cart.code}`}>
    <div className="panel-title"><button type="button" className="text-button" onClick={onBack}>← До списку</button></div>
    <div className="orders-detail-body">
      <h2 tabIndex={-1} id="order-heading" data-dialog-return>{cart.code} <StatusBadge status={cart.status} /> {cart.bound && <span className="status" title="Кошик оформлено клієнтом, який увійшов у кабінет">Прив’язано до профілю</span>}</h2>
      <dl className="orders-facts">
        <div><dt>Створено</dt><dd>{date(cart.createdAt)}</dd></div>
        <div><dt>Сума</dt><dd>{money(cart.totalMinor)}</dd></div>
        <div><dt>Одиниць товару</dt><dd>{cart.itemCount}</dd></div>
        <div><dt>Статус змінено</dt><dd>{date(cart.statusChangedAt)}{cart.statusActor ? ` · ${cart.statusActor}` : ''}</dd></div>
      </dl>
      <OrderPersonal cart={cart} />
      {!isErased(cart) && (cart.recipient || cart.delivery) && <p className="form-note">{RETENTION_HINT}</p>}
      {cart.managerNote && <p className="orders-note"><strong>Нотатка:</strong> {cart.managerNote}</p>}
      {info && <Notice type="success">{info}</Notice>}
      {error && <Notice>{error}</Notice>}
      {readOnly ? <Notice type="info">Лише перегляд: змінювати статус може менеджер або власник.</Notice>
        : actions.length ? <form className="orders-actions" onSubmit={e => e.preventDefault()}>
          <label className="field"><span>Нотатка (необов’язково)</span><textarea value={note} maxLength={NOTE_MAX} rows={2} onChange={e => setNote(e.target.value)} aria-describedby="order-note-help" /><small id="order-note-help">{note.length}/{NOTE_MAX}. Збережеться разом зі зміною статусу. {NOTE_PRIVACY_HINT}</small></label>
          {!phone && <div className="row-actions">{actions.map(status => status === 'cancelled'
            ? <button key={status} type="button" className="button danger" disabled={busy} onClick={() => setConfirm(true)}>{ACTION_LABELS[status]}</button>
            : <button key={status} type="button" className="button primary" disabled={busy} onClick={() => quick(status)}>{busy ? 'Виконуємо…' : ACTION_LABELS[status]}</button>)}</div>}
          <p className="form-note">{actions.includes('completed') ? '«Виконано» закриває замовлення після того, як клієнт його отримав; змінити статус потім не можна.' : '«Передано постачальникам» лише фіксує, що ви самі оформили замовлення в постачальників; система нічого не надсилає автоматично.'}</p>
        </form> : <p className="form-note">Для цього статусу подальших дій немає.</p>}
      <h3 className="subsection-heading">Позиції за постачальниками</h3>
      {groups.length ? groups.map(g => <SupplierGroup key={g.supplierId ?? g.supplierName} group={g} cart={cart} />) : <p>У кошику немає позицій.</p>}
    </div>
    {confirm && <ConfirmDialog title="Скасувати кошик?" danger confirmLabel="Скасувати кошик" onClose={() => setConfirm(false)} onConfirm={() => run('cancelled')}><p>Кошик {cart.code} буде позначено як скасований. Скасований кошик змінити не можна.</p></ConfirmDialog>}
    {phone && !readOnly && <MobileActionBar label={busy ? 'Виконуємо…' : `Статус: ${statusLabel(cart.status)}`} actions={barActions} />}
  </article>;
}

/**
 * Props: none required. Reads staff permissions from the StaffPermissions context
 * (orders.read to view, orders.operate to act); optional `permissions` array overrides it.
 */
export default function OrdersPanel({ permissions: override }) {
  const phone = useMediaQuery(PHONE);
  const [filtersOpen, setFiltersOpen] = useState(false);
  const has = usePermission();
  const permissions = override || ['orders.read', 'orders.operate'].filter(has);
  const [status, setStatus] = useState(''), [q, setQ] = useState(''), [query, setQuery] = useState(''), [page, setPage] = useState(1);
  const [list, setList] = useState({ carts: [], total: 0 }), [loading, setLoading] = useState(true), [listError, setListError] = useState('');
  const [lookup, setLookup] = useState(''), [lookupError, setLookupError] = useState(''), [detail, setDetail] = useState(null), [detailBusy, setDetailBusy] = useState(false), [detailError, setDetailError] = useState('');
  const lookupRef = useRef(null), seq = useRef(0), openSeq = useRef(0), pendingFocus = useRef(null);
  const [tick, setTick] = useState(0);

  useEffect(() => {
    const id = ++seq.current;
    setLoading(true); setListError('');
    listCarts({ status, q: query, page }).then(result => { if (id === seq.current) setList(result); }).catch(e => { if (id === seq.current) setListError(errorText(e)); }).finally(() => { if (id === seq.current) setLoading(false); });
  }, [status, query, page, tick]);
  useEffect(() => { if (detail) document.getElementById('order-heading')?.focus(); }, [detail?.code]);
  useEffect(() => {
    if (detail || loading || !pendingFocus.current) return;
    const code = pendingFocus.current; pendingFocus.current = null;
    const row = code === 'lookup' ? null : [...document.querySelectorAll('[data-order-code]')].find(el => el.dataset.orderCode === code);
    (row || lookupRef.current)?.focus();
  }, [detail, loading]);

  async function open(code, from = 'lookup') {
    const id = ++openSeq.current;
    setDetailBusy(true); setDetailError('');
    try { const cart = await loadCart(code); if (id === openSeq.current) { pendingFocus.current = from; setDetail(cart); } }
    catch (e) { if (id === openSeq.current) setDetailError(errorText(e)); }
    finally { if (id === openSeq.current) setDetailBusy(false); }
  }
  function submitLookup(e) {
    e.preventDefault();
    const result = parseLookup(lookup);
    if (result.error) { setLookupError(result.error); return; }
    setLookupError(''); setLookup(result.code); open(result.code);
  }
  function refreshAfterChange(cart) {
    setDetail(cart); setTick(t => t + 1);
  }
  if (!permissions.includes('orders.read')) return <section className="panel staff-panel" aria-label="Замовлення"><Notice>Немає доступу до замовлень.</Notice></section>;
  if (detail) return <section aria-label="Замовлення"><CartDetail cart={detail} permissions={permissions} onChange={refreshAfterChange} onBack={() => { setLoading(true); setDetail(null); setTick(t => t + 1); }} /></section>;
  const pages = pageCount(list.total);
  const statusField = <label className="field"><span>Статус</span><select value={status} onChange={e => { setStatus(e.target.value); setPage(1); }}>{STATUS_FILTERS.map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></label>;
  const searchField = <label className="field"><span>Пошук</span><input type="search" {...(phone ? { enterKeyHint: 'search' } : {})} value={q} onChange={e => setQ(e.target.value)} placeholder="Код або його частина" /></label>;
  return <section className="panel staff-panel orders-panel" aria-label="Замовлення">
    <h2>Замовлення (кошики)</h2>
    <form className="orders-lookup" onSubmit={submitLookup} noValidate>
      <label className="field"><span>Код кошика</span><input ref={lookupRef} value={lookup} onChange={e => { setLookup(e.target.value); setLookupError(''); }} placeholder="SS-XXXX-XXXX" autoComplete="off" autoCapitalize="characters" spellCheck={false} aria-invalid={lookupError ? 'true' : undefined} aria-describedby="lookup-help" /><small id="lookup-help" className={lookupError ? 'inline-error' : ''} role="status" aria-live="polite">{lookupError || 'Пробіли, дефіси та регістр не важливі.'}</small></label>
      <button className="button primary" disabled={detailBusy}>{detailBusy ? 'Шукаємо…' : 'Знайти'}</button>
    </form>
    {detailError && <Notice>{detailError}</Notice>}
    <form className="orders-filters" role="search" onSubmit={e => { e.preventDefault(); setPage(1); setQuery(q); setTick(t => t + 1); }}>
      {phone ? <FilterDisclosure count={(status ? 1 : 0) + (q ? 1 : 0)} open={filtersOpen} onToggle={() => setFiltersOpen(o => !o)} controlsId="orders-filter-panel" onReset={() => { setStatus(''); setQ(''); setQuery(''); setPage(1); setTick(t => t + 1); }}>
        {statusField}{searchField}
      </FilterDisclosure> : <>{statusField}{searchField}</>}
      <button className="button secondary">Шукати</button>
      <button type="button" className="button secondary" disabled={loading} onClick={() => setTick(t => t + 1)}>Оновити список</button>
    </form>
    {listError && <Notice>{listError}</Notice>}
    {loading ? <p role="status">Завантажуємо кошики…</p> : phone
      ? <div className="table-scroll"><table className="m-cards orders-cards" role="table"><caption className="sr-only">Кошики, найновіші першими</caption><thead role="rowgroup"><tr role="row"><th role="columnheader" scope="col">Код</th><th role="columnheader" scope="col">Статус</th><th role="columnheader" scope="col">Деталі</th></tr></thead><tbody role="rowgroup">
        {list.carts.map(c => <tr role="row" key={c.code}><td role="cell" className="m-title"><button type="button" className="button secondary" data-order-code={c.code} disabled={detailBusy} onClick={() => open(c.code, c.code)}>{c.code}</button></td><td role="cell" className="m-status"><StatusBadge status={c.status} /></td><td role="cell" className="m-meta"><span data-label="Створено">{date(c.createdAt)}</span><span data-label="Шт.">{c.itemCount}</span><span data-label="Сума">{money(c.totalMinor)}</span><span data-label="Профіль">{c.bound ? 'Так' : 'Ні'}</span><span data-label="Отримувач">{recipientShort(c)}</span><span data-label="Доставка">{deliveryShort(c)}</span></td></tr>)}
      </tbody></table></div>
      : <div className="table-scroll"><table><caption className="sr-only">Кошики, найновіші першими</caption><thead><tr><th scope="col">Код</th><th scope="col">Статус</th><th scope="col">Створено</th><th scope="col">Шт.</th><th scope="col">Сума</th><th scope="col">Профіль</th><th scope="col">Отримувач</th><th scope="col">Доставка</th></tr></thead><tbody>
      {list.carts.map(c => <tr key={c.code}><td><button type="button" className="text-button" data-order-code={c.code} disabled={detailBusy} onClick={() => open(c.code, c.code)}>{c.code}</button></td><td><StatusBadge status={c.status} /></td><td>{date(c.createdAt)}</td><td>{c.itemCount}</td><td>{money(c.totalMinor)}</td><td>{c.bound ? 'Так' : 'Ні'}</td><td title={isErased(c) ? PD_ERASED_LABEL : undefined}>{recipientShort(c)}</td><td title={isErased(c) ? PD_ERASED_LABEL : undefined}>{deliveryShort(c)}</td></tr>)}
    </tbody></table></div>}
    {!loading && !listError && !list.carts.length && <p>Кошиків за цим фільтром немає.</p>}
    <nav className="orders-pager" aria-label="Сторінки списку"><button className="button secondary small" disabled={loading || page <= 1} onClick={() => setPage(page - 1)}>Назад</button><span aria-live="polite">Сторінка {page} з {pages} · усього {list.total}</span><button className="button secondary small" disabled={loading || page >= pages} onClick={() => setPage(page + 1)}>Далі</button></nav>
  </section>;
}
