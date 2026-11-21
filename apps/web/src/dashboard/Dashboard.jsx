import React, { useEffect, useState } from 'react';
import { api } from '../api.js';
import { Notice } from '../ui.jsx';
import { StatTile, ColumnChart, BarList } from './charts.jsx';
import { count, percent, uah, duration, countryName, DEVICE_LABELS, renewalState, longDay } from './dashboard-logic.js';
import './dashboard.css';

const RANGES = [[7, '7 днів'], [30, '30 днів'], [90, '90 днів']];

export function RenewalBanner({ renewals, today, onOpen }) {
  if (!renewals?.length) return null;
  const urgent = renewals.some(r => renewalState(r.dueDate, today).tone === 'critical');
  return <div className={`dash-renewals dash-renewals-${urgent ? 'critical' : 'warning'}`} role="status">
    <strong>{urgent ? 'Термінові продовження' : 'Незабаром продовження'}</strong>
    <ul>{renewals.map(r => <li key={r.id}><span>{r.name}</span> <em>{renewalState(r.dueDate, today).label}{r.dueDate ? ` · ${longDay(r.dueDate)}` : ''}{r.autoRenew ? ' · автопродовження' : ''}</em></li>)}</ul>
    {onOpen && <button type="button" className="button secondary" onClick={onOpen}>Відкрити інфраструктуру</button>}
  </div>;
}

export default function Dashboard({ onOpenInfra }) {
  const [days, setDays] = useState(30), [scope, setScope] = useState('confirmed');
  const [data, setData] = useState(null), [busy, setBusy] = useState(false), [error, setError] = useState('');
  async function load() {
    setBusy(true); setError('');
    try { setData(await api(`/api/admin/dashboard?days=${days}&scope=${scope}`)); } catch (e) { setError(e.message); } finally { setBusy(false); }
  }
  useEffect(() => { load(); }, [days, scope]);
  const v = data?.visits, s = data?.sales, c = data?.catalog;
  const soldWord = scope === 'confirmed' ? 'підтверджених' : 'усіх нескасованих';
  return <section className="panel staff-panel dash" aria-label="Огляд" aria-busy={busy}>
    <div className="dash-head">
      <div><h2>Огляд</h2><p className="dash-sub">Дні за київським часом{data ? ` · ${longDay(data.range.from)} – ${longDay(data.range.to)}` : ''}</p></div>
      <div className="dash-controls">
        <div className="resource-views" role="group" aria-label="Період">{RANGES.map(([value, label]) => <button key={value} type="button" className={days === value ? 'active' : ''} aria-pressed={days === value} disabled={busy} onClick={() => setDays(value)}>{label}</button>)}</div>
        <label className="dash-select"><span>Продажі</span><select value={scope} disabled={busy} onChange={e => setScope(e.target.value)}><option value="confirmed">Підтверджені замовлення</option><option value="open">Усі нескасовані</option></select></label>
        <button type="button" className="button secondary" disabled={busy} onClick={load}>Оновити</button>
      </div>
    </div>
    {error && <Notice>{error}</Notice>}
    {!data && busy && <p role="status">Завантажуємо показники…</p>}
    {data && <>
      <RenewalBanner renewals={data.renewals} today={data.range.to} onOpen={onOpenInfra}/>

      <h3 className="dash-section">Відвідувачі</h3>
      <div className="dash-tiles">
        <StatTile label="Відвідувачі сьогодні" value={count(v.today.visitors)} note={`${count(v.today.pageviews)} переглядів`}/>
        <StatTile label="Відвідувачі за період" value={count(v.period.visitors)} note="сума щоденних унікальних"/>
        <StatTile label="Сесії" value={count(v.period.sessions)} note={`${count(v.period.pageviews)} переглядів`}/>
        <StatTile label="Середня тривалість сесії" value={duration(v.period.avgSessionSeconds)} note={`відмови: ${percent(v.period.bounceRate)}`}/>
      </div>
      <ColumnChart title="Відвідувачі за днями" valueLabel="відвідувачі" series={v.daily.map(d => ({ day: d.day, value: d.visitors }))} format={count}/>
      <div className="dash-grid-2">
        <BarList title="Країни" items={v.countries.map(r => ({ key: r.country || 'none', label: countryName(r.country), value: r.sessions }))} format={n => `${count(n)} сес.`}/>
        <BarList title="Регіони" items={v.regions.map(r => ({ key: `${r.country}-${r.region}`, label: r.region, note: countryName(r.country), value: r.sessions }))} format={n => `${count(n)} сес.`}/>
        <BarList title="Пристрої" items={v.devices.map(r => ({ key: r.device, label: DEVICE_LABELS[r.device] || r.device, value: r.sessions }))} format={n => `${count(n)} сес.`}/>
        <BarList title="Звідки приходять" items={v.referrers.map(r => ({ key: r.host, label: r.host, value: r.sessions }))} format={n => `${count(n)} сес.`} empty="Переходів з інших сайтів ще немає."/>
      </div>
      <BarList title="Сторінки входу" items={v.entryPages.map(r => ({ key: r.path, label: r.path === '/' ? 'Головна' : r.path, value: r.sessions }))} format={n => `${count(n)} сес.`}/>
      <p className="dash-footnote">Статистика без cookie: адреси IP і дані браузера не зберігаються, відвідувача неможливо впізнати наступного дня. Тому «відвідувачі за період» — це сума щоденних унікальних. Не враховуються боти та браузери з увімкненим Do Not Track / Global Privacy Control.</p>

      <h3 className="dash-section">Товари й продажі</h3>
      <div className="dash-tiles">
        <StatTile label="Продано сьогодні" value={`${count(s.today.units)} шт.`} note={`${count(s.today.orders)} замовл. · ${uah(s.today.revenueMinor)}`}/>
        <StatTile label="Нові кошики сьогодні" value={count(s.today.newOrders)} note="усі нескасовані"/>
        <StatTile label="Продано за період" value={`${count(s.period.units)} шт.`} note={`${count(s.period.orders)} замовл. · ${uah(s.period.revenueMinor)}`}/>
        <StatTile label="Середній чек" value={uah(s.period.averageOrderMinor)} note={`конверсія: ${data.conversion === null ? '—' : percent(data.conversion, 1)}`}/>
      </div>
      <ColumnChart title="Виручка за днями" valueLabel={`виручка ${soldWord}`} series={s.daily.map(d => ({ day: d.day, value: d.revenueMinor }))} format={uah}/>
      <div className="dash-grid-2">
        <BarList title="Найпопулярніші товари" items={s.topProducts.map(p => ({ key: p.productId, label: p.title, value: p.units, note: uah(p.revenueMinor) }))} format={n => `${count(n)} шт.`}/>
        <div className="dash-chart">
          <p className="dash-chart-title">Каталог і всі замовлення (поточний стан)</p>
          <dl className="dash-facts">
            <div><dt>Товарів у каталозі</dt><dd>{count(c.products)}</dd></div>
            <div><dt>На вітрині</dt><dd>{count(c.published)}</dd></div>
            <div><dt>Чернетки</dt><dd>{count(c.drafts)}</dd></div>
            <div><dt>Очікують перевірки</dt><dd>{count(s.statusCounts.submitted)}</dd></div>
            <div><dt>Підтверджено</dt><dd>{count(s.statusCounts.verified)}</dd></div>
            <div><dt>Передано постачальникам</dt><dd>{count(s.statusCounts.sent_to_suppliers)}</dd></div>
            <div><dt>Виконано</dt><dd>{count(s.statusCounts.completed)}</dd></div>
            <div><dt>Скасовано</dt><dd>{count(s.statusCounts.cancelled)}</dd></div>
          </dl>
        </div>
      </div>

      <h3 className="dash-section">Постачальники</h3>
      <div className="dash-grid-2">
        <BarList title="Продано одиниць за постачальником" items={s.suppliers.map(r => ({ key: r.supplierId, label: r.name, value: r.units }))} format={n => `${count(n)} шт.`}/>
        <BarList title="Виручка за постачальником" items={[...s.suppliers].sort((a, b) => b.revenueMinor - a.revenueMinor).map(r => ({ key: r.supplierId, label: r.name, value: r.revenueMinor }))} format={uah}/>
      </div>
      {s.suppliers.length > 0 && <div className="table-scroll"><table className="dash-table"><thead><tr><th scope="col">Постачальник</th><th scope="col">Замовлень</th><th scope="col">Одиниць</th><th scope="col">Виручка</th><th scope="col">Закупівля</th><th scope="col">Маржа</th></tr></thead>
        <tbody>{s.suppliers.map(r => <tr key={r.supplierId}><th scope="row">{r.name}</th><td>{count(r.orders)}</td><td>{count(r.units)}</td><td>{uah(r.revenueMinor)}</td><td>{r.costMinor === null ? '—' : uah(r.costMinor)}</td><td>{r.marginMinor === null ? '—' : uah(r.marginMinor)}</td></tr>)}</tbody></table></div>}
      <p className="dash-footnote">«Продано» — {scope === 'confirmed' ? 'кошики зі статусом «Підтверджено» або «Передано постачальникам»' : 'усі кошики, крім скасованих'}, за датою оформлення. Об’єднані дублікати розподілено між постачальниками за фактичною кількістю. Закупівля — ціна постачальника на момент оформлення.</p>
    </>}
  </section>;
}
