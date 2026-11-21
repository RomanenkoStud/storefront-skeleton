import React, { useEffect, useState } from 'react';
import { api } from '../api.js';
import { Notice } from '../ui.jsx';
import { usePermission } from '../StaffPermissions.jsx';
import ConfirmDialog from '../ConfirmDialog.jsx';
import { Meter, StatTile } from './charts.jsx';
import { bytes, compact, count, usd, money, share, meterTone, renewalState, longDay, usageValue, KIND_LABELS, parseAmount } from './dashboard-logic.js';
import './dashboard.css';

const ERRORS = { invalid_name: 'Вкажіть назву до 120 символів.', invalid_due_date: 'Вкажіть коректну дату.', invalid_cost: 'Вартість має бути невідʼємною сумою.', invalid_kind: 'Оберіть тип.', invalid_notes: 'Примітка — до 500 символів.', not_found: 'Запис уже видалено.' };
const errorText = e => ERRORS[e.message] || e.message;
const EMPTY = { kind: 'domain', name: '', dueDate: '', cost: '', currency: 'UAH', autoRenew: false, notes: '' };

function RenewalForm({ initial, busy, onSubmit, onCancel }) {
  const [form, setForm] = useState(initial), [error, setError] = useState('');
  const set = key => e => setForm(f => ({ ...f, [key]: e.target.type === 'checkbox' ? e.target.checked : e.target.value }));
  function submit(e) {
    e.preventDefault();
    const costMinor = parseAmount(form.cost);
    if (Number.isNaN(costMinor)) { setError('Вартість: число, наприклад 450 або 450,50.'); return; }
    setError('');
    onSubmit({ kind: form.kind, name: form.name, dueDate: form.dueDate || null, costMinor, currency: form.currency, autoRenew: form.autoRenew, notes: form.notes });
  }
  return <form className="dash-form" onSubmit={submit}>
    {error && <Notice>{error}</Notice>}
    <label><span>Тип</span><select value={form.kind} onChange={set('kind')}>{Object.entries(KIND_LABELS).map(([k, l]) => <option key={k} value={k}>{l}</option>)}</select></label>
    <label><span>Назва</span><input required maxLength={120} value={form.name} onChange={set('name')} placeholder="example.com"/></label>
    <label><span>Дата продовження</span><input type="date" value={form.dueDate} onChange={set('dueDate')}/></label>
    <label><span>Вартість</span><span className="dash-inline"><input inputMode="decimal" value={form.cost} onChange={set('cost')} placeholder="необовʼязково"/><select aria-label="Валюта" value={form.currency} onChange={set('currency')}>{['UAH', 'USD', 'EUR'].map(c => <option key={c}>{c}</option>)}</select></span></label>
    <label className="dash-check"><input type="checkbox" checked={form.autoRenew} onChange={set('autoRenew')}/><span>Автопродовження увімкнено</span></label>
    <label className="dash-wide"><span>Примітка</span><textarea maxLength={500} rows={2} value={form.notes} onChange={set('notes')} placeholder="Реєстратор, рахунок, хто оплачує"/></label>
    <div className="dash-form-actions"><button className="button primary" disabled={busy}>Зберегти</button><button type="button" className="button secondary" disabled={busy} onClick={onCancel}>Скасувати</button></div>
  </form>;
}

function Renewals({ items, today, canEdit, onChanged, setError }) {
  const [editing, setEditing] = useState(null), [busy, setBusy] = useState(false), [confirm, setConfirm] = useState(null);
  async function save(body) {
    setBusy(true); setError('');
    try {
      if (editing === 'new') await api('/api/admin/infra/renewals', { method: 'POST', body });
      else await api(`/api/admin/infra/renewals/${encodeURIComponent(editing.id)}`, { method: 'PATCH', body });
      setEditing(null); await onChanged();
    } catch (e) { setError(errorText(e)); } finally { setBusy(false); }
  }
  const toForm = r => ({ kind: r.kind, name: r.name, dueDate: r.dueDate || '', cost: r.costMinor === null ? '' : String(r.costMinor / 100).replace('.', ','), currency: r.currency, autoRenew: r.autoRenew, notes: r.notes });
  return <div className="dash-chart">
    <div className="dash-row"><p className="dash-chart-title">Продовження й нагадування</p>{canEdit && !editing && <button type="button" className="button secondary" onClick={() => setEditing('new')}>Додати</button>}</div>
    {editing === 'new' && <RenewalForm initial={EMPTY} busy={busy} onSubmit={save} onCancel={() => setEditing(null)}/>}
    {items.length ? <ul className="dash-renewal-list">{items.map(r => { const state = renewalState(r.dueDate, today); return <li key={r.id} className={`dash-renewal dash-renewal-${state.tone}`}>
      {editing?.id === r.id ? <RenewalForm initial={toForm(r)} busy={busy} onSubmit={save} onCancel={() => setEditing(null)}/> : <>
        <div className="dash-renewal-main"><span className="dash-badge">{KIND_LABELS[r.kind]}</span><strong>{r.name}</strong><span className={`dash-state dash-state-${state.tone}`}>{state.label}</span></div>
        <div className="dash-renewal-meta"><span>{r.dueDate ? longDay(r.dueDate) : 'дата не вказана'}</span>{r.costMinor !== null && <span>{money(r.costMinor, r.currency)}</span>}{r.autoRenew && <span>автопродовження</span>}{r.notes && <span>{r.notes}</span>}</div>
        {canEdit && <div className="dash-renewal-actions"><button type="button" className="button secondary" onClick={() => setEditing(r)}>Змінити</button><button type="button" className="button danger-outline" aria-label={`Видалити ${r.name}`} onClick={() => setConfirm(r)}>Видалити</button></div>}
      </>}
    </li>; })}</ul> : <p className="dash-empty">Нагадувань ще немає.</p>}
    <p className="dash-footnote">Нагадування видно в кабінеті (на «Огляді» за 30 днів до дати). Листів і повідомлень сайт не надсилає.</p>
    {confirm && <ConfirmDialog title="Видалити нагадування?" confirmLabel="Видалити" danger onClose={() => setConfirm(null)} onConfirm={async () => { try { await api(`/api/admin/infra/renewals/${encodeURIComponent(confirm.id)}`, { method: 'DELETE', body: { confirm: true } }); } catch (e) { throw new Error(errorText(e)); } await onChanged(); }}><p><strong>{confirm.name}</strong></p></ConfirmDialog>}
  </div>;
}

export default function InfraPanel() {
  const can = usePermission(), canEdit = can('settings.manage');
  const [data, setData] = useState(null), [busy, setBusy] = useState(false), [error, setError] = useState('');
  async function load(refresh = false) {
    setBusy(true); setError('');
    try { setData(await api(`/api/admin/infra${refresh ? '?refresh=1' : ''}`)); } catch (e) { setError(e.message); } finally { setBusy(false); }
  }
  useEffect(() => { load(); }, []);
  async function changePlan(plan) {
    setBusy(true); setError('');
    try { await api('/api/admin/infra/plan', { method: 'PUT', body: { plan } }); await load(); } catch (e) { setError(e.message); setBusy(false); }
  }
  if (!data) return <section className="panel staff-panel dash" aria-label="Інфраструктура"><h2>Інфраструктура</h2>{error ? <Notice>{error}</Notice> : <p role="status">Завантажуємо дані…</p>}</section>;
  const plan = data.pricing.plan, cf = data.cloudflare, paid = data.plan === 'workers_paid';
  const media = data.r2.find(b => b.binding === 'MEDIA'), r2Total = data.r2.length ? data.r2.reduce((sum, b) => sum + (b.bytes || 0), 0) : null;
  const line = key => data.estimate.lines.find(l => l.key === key);
  const usageMeter = (key, label, note) => { const l = line(key); if (!l) return null; const f = share(l.used, l.included); return <Meter key={key} label={label} used={l.used === null ? 'немає даних' : usageValue(l.used, l.unit)} limit={usageValue(l.included, l.unit)} fraction={f} tone={meterTone(f)} note={note}/>; };
  const d1Limit = plan.d1MaxDatabaseBytes, d1Share = share(data.d1.sizeBytes, d1Limit);
  return <section className="panel staff-panel dash" aria-label="Інфраструктура" aria-busy={busy}>
    <div className="dash-head">
      <div><h2>Інфраструктура</h2><p className="dash-sub">Середовище: {data.environment === 'production' ? 'робочий сайт' : data.environment === 'staging' ? 'staging' : 'локальне'} · Cloudflare</p></div>
      <div className="dash-controls">
        <label className="dash-select"><span>План Cloudflare</span><select value={data.plan} disabled={!canEdit || busy} onChange={e => changePlan(e.target.value)}><option value="workers_paid">Workers Paid ($5/міс.)</option><option value="workers_free">Workers Free</option></select></label>
        <button type="button" className="button secondary" disabled={busy} onClick={() => load(true)}>Оновити виміри</button>
      </div>
    </div>
    {error && <Notice>{error}</Notice>}

    <Renewals items={data.renewals} today={data.today} canEdit={canEdit} onChanged={() => load()} setError={setError}/>

    <h3 className="dash-section">Вартість цього місяця (оцінка)</h3>
    <div className="dash-tiles">
      <StatTile label="Оцінка за місяць" value={usd(data.estimate.totalUsd)} note={data.estimate.complete ? 'усі складники виміряно' : 'без складників, яких не виміряно'}/>
      <StatTile label="Медіа в R2" value={bytes(r2Total)} note={media ? `${count(media.objects)} файлів${media.truncated ? ' (не повністю)' : ''}` : 'R2 не підключено'}/>
      <StatTile label="База D1" value={bytes(data.d1.sizeBytes)} note={`ліміт бази ${bytes(d1Limit)}`}/>
      <StatTile label="Запити до Worker" value={cf.configured && !cf.worker?.error ? compact(cf.worker.requests) : '—'} note={cf.configured && !cf.worker?.error ? `з початку місяця · помилок ${compact(cf.worker.errors)}` : 'потрібна аналітика Cloudflare'}/>
    </div>
    <div className="table-scroll"><table className="dash-table"><thead><tr><th scope="col">Складник</th><th scope="col">Використано</th><th scope="col">Включено</th><th scope="col">Вартість</th></tr></thead>
      <tbody>{data.estimate.lines.map(l => <tr key={l.key}><th scope="row">{l.label}</th><td>{l.used === undefined ? '—' : l.used === null ? 'немає даних' : usageValue(l.used, l.unit)}</td><td>{l.included === undefined ? '—' : usageValue(l.included, l.unit)}</td><td>{l.costUsd === null ? '—' : usd(l.costUsd)}</td></tr>)}</tbody></table></div>
    <p className="dash-footnote">Оцінка за публічними цінами Cloudflare, перевіреними {longDay(data.pricing.checkedOn)}: <a href={data.pricing.sources.workers} target="_blank" rel="noreferrer">Workers</a>, <a href={data.pricing.sources.d1} target="_blank" rel="noreferrer">D1</a>, <a href={data.pricing.sources.r2} target="_blank" rel="noreferrer">R2</a>. Включені обсяги {paid ? 'Workers Paid діють на весь акаунт' : 'Workers Free — денні, на весь акаунт'}: інші Worker і бази цього акаунта (зокрема staging або робочий сайт) їх теж використовують. Справжній рахунок — у панелі Cloudflare → Billing.</p>

    <h3 className="dash-section">Використання й ліміти</h3>
    {!cf.configured && <Notice type="info">Аналітику акаунта Cloudflare (запити, CPU, рядки D1, операції R2) не підключено. Потрібен API-токен з правом «Account Analytics: Read» як секрет Worker <code>CF_ANALYTICS_API_TOKEN</code> і змінні <code>INFRA_ACCOUNT_ID</code>, <code>INFRA_D1_DATABASE_ID</code>, <code>INFRA_R2_BUCKET</code>. Нижче — те, що Worker вимірює сам.</Notice>}
    {cf.configured && <p className="dash-sub">Дані Cloudflare з {longDay(cf.period.from.slice(0, 10))} (UTC) · Worker <code>{cf.workerName}</code>{cf.d1?.error === 'not_configured' ? ' · D1: не вказано INFRA_D1_DATABASE_ID' : ''}{cf.r2?.error === 'not_configured' ? ' · R2: не вказано INFRA_R2_BUCKET' : ''}</p>}
    <div className="dash-grid-2">
      <Meter label="Розмір бази D1" used={bytes(data.d1.sizeBytes)} limit={bytes(d1Limit)} fraction={d1Share} tone={meterTone(d1Share)} note={data.d1.sizeBytes === null ? 'розмір недоступний локально' : undefined}/>
      {usageMeter('r2Storage', 'Сховище R2 (безкоштовний обсяг)')}
      {paid && usageMeter('workerRequests', 'Запити Worker за місяць')}
      {paid && usageMeter('workerCpu', 'CPU Worker за місяць')}
      {paid && usageMeter('d1RowsRead', 'D1: прочитані рядки за місяць')}
      {paid && usageMeter('d1RowsWritten', 'D1: записані рядки за місяць')}
      {usageMeter('r2ClassA', 'R2: операції класу A (запис, список)')}
      {usageMeter('r2ClassB', 'R2: операції класу B (читання)')}
    </div>
    {!paid && <p className="dash-footnote">Workers Free: {compact(plan.workerRequests.includedPerDay)} запитів на день, D1 — {compact(plan.d1RowsRead.includedPerDay)} прочитаних і {compact(plan.d1RowsWritten.includedPerDay)} записаних рядків на день.</p>}
    <div className="dash-grid-2">
      <div className="dash-chart"><p className="dash-chart-title">Таблиці D1</p><dl className="dash-facts">{data.d1.tables.map(t => <div key={t.name}><dt><code>{t.name}</code></dt><dd>{count(t.rows)}</dd></div>)}</dl></div>
      <div className="dash-chart"><p className="dash-chart-title">Сховища R2</p>{data.r2.length ? <dl className="dash-facts">{data.r2.map(b => <div key={b.binding}><dt>{b.label}</dt><dd>{bytes(b.bytes)} · {count(b.objects)} файлів{b.error ? ' · вимір не вдався' : ''}<small>{b.measuredAt ? `виміряно ${new Date(b.measuredAt).toLocaleString('uk-UA', { timeZone: 'Europe/Kyiv' })}` : ''}</small></dd></div>)}</dl> : <p className="dash-empty">R2 не підключено до цього середовища.</p>}</div>
    </div>
  </section>;
}
