import React, { useEffect, useRef, useState } from 'react';
import { Notice } from '../ui.jsx';
import ConfirmDialog from '../ConfirmDialog.jsx';
import SiteHeader from '../landing/SiteHeader.jsx';
import { fetchAccountCarts } from '../cart/cart-api.js';
import NovaPoshtaPicker from '../delivery/NovaPoshtaPicker.jsx';
import { fromPreference } from '../delivery/np-picker-logic.js';
import { fetchProfile, saveDeliveryPreference, saveContacts } from '../delivery/profile-delivery.js';
import { normalizeUaPhone, recipientNamePart, RECIPIENT_NAME_FIELDS } from '../../../../packages/catalog/recipient.js';
import { formatPhone, recipientLine, recipientPrefill, RECIPIENT_PART_MAX, RECIPIENT_NAME_INPUTS, RECIPIENT_ERRORS, EMPTY_RECIPIENT } from '../cart/checkout-steps.js';
import { PD_ERASED_LABEL } from '../../../../packages/catalog/cart.js';
import '../cart/checkout.css';
import { money, date } from '../api.js';
import { fetchSession, startGoogle, logout, revokeAll } from './account-api.js';
import { callbackMessage, cleanedUrl, startErrorMessage, safeAuthorizationUrl, customerHandle, providerLabels, deliveryView, deliveryErrorMessage, noteForSave, noteLength, cartDeliveryText, NOTE_MAX, DELIVERY_LOAD_ERROR } from './account-helpers.js';

function SignInCard({ onMessage, focusOnMount = false }) {
  const [busy, setBusy] = useState(false);
  async function start() {
    setBusy(true); onMessage(null);
    try {
      const { authorizationUrl } = await startGoogle();
      const url = safeAuthorizationUrl(authorizationUrl, location.hostname);
      if (!url) throw Object.assign(new Error('bad url'), { status: 502 });
      window.location.assign(url);
    } catch (e) {
      onMessage({ type: 'error', text: startErrorMessage(e instanceof TypeError ? 0 : e.status, e.retryAfter) });
      setBusy(false);
    }
  }
  return <section className="account-card" aria-labelledby="signin-title">
    <p className="eyebrow">КАБІНЕТ</p>
    <h1 id="signin-title" tabIndex={-1} ref={el => el && focusOnMount && el.focus()}>Увійти</h1>
    <p>Увійдіть через Google, щоб зберегти контакти та побажання щодо доставки. Пароль не потрібен.</p>
    <button type="button" className="button primary account-google" onClick={start} disabled={busy} aria-busy={busy}>{busy ? 'Переходимо до Google…' : 'Увійти через Google'}</button>
  </section>;
}

function AccountCarts() {
  const [state, setState] = useState({ loading: true, carts: [], error: false });
  useEffect(() => { let active = true; fetchAccountCarts().then(d => active && setState({ loading: false, carts: d.carts || [], error: false })).catch(() => active && setState({ loading: false, carts: [], error: true })); return () => { active = false; }; }, []);
  const statusLabel = { submitted: 'Очікує перевірки', verified: 'Перевірено', sent_to_suppliers: 'Передано постачальникам', completed: 'Виконано', cancelled: 'Скасовано' };
  return <section className="account-card" aria-labelledby="carts-title">
    <p className="eyebrow">ЗАМОВЛЕННЯ</p><h2 id="carts-title">Мої кошики</h2>
    {state.loading ? <p role="status">Завантажуємо кошики…</p> : state.error ? <Notice>Не вдалося завантажити кошики. Спробуйте оновити сторінку.</Notice>
      : state.carts.length === 0 ? <p>Кошиків, збережених у профілі, поки немає.</p>
      : <ul className="account-carts">{state.carts.map(c => <li key={c.code}><div><code>{c.code}</code> <span className="cart-status">{statusLabel[c.status] || c.status}</span></div><small>{date(c.createdAt)} · {c.itemCount} шт. · {money(c.totalMinor)}</small>{c.personalDataErasedAt ? <small className="account-cart-delivery account-cart-erased">{PD_ERASED_LABEL}</small> : <><small className="account-cart-delivery">Доставка: {cartDeliveryText(c.delivery)}</small>{recipientLine(c.recipient) && <small className="account-cart-delivery">{recipientLine(c.recipient)}</small>}</>}<ul>{(c.lines || []).map((l, i) => <li key={i}>{l.title}, {l.size} × {l.quantity}</li>)}</ul></li>)}</ul>}
  </section>;
}

const CONTACT_PHONE_ERROR = 'Вкажіть номер України, наприклад 050 123 45 67.';
/** Errors in form order. ПІБ parts are all-or-nothing (the checkout needs all three); all empty clears them. The phone is optional. */
function contactErrors(form) {
  const errors = {}, anyName = RECIPIENT_NAME_FIELDS.some(field => form[field].trim());
  if (anyName) for (const field of RECIPIENT_NAME_FIELDS) if (!recipientNamePart(form[field])) errors[field] = RECIPIENT_ERRORS[field];
  if (form.phone.trim() && !normalizeUaPhone(form.phone)) errors.phone = CONTACT_PHONE_ERROR;
  return errors;
}
// ПІБ as Прізвище, Імʼя, По батькові and phone: prefilled into the checkout «Отримувач» step.
// The single-field ПІБ (profile displayName) is kept as is and never split by guessing.
function ContactsCard() {
  const [state, setState] = useState({ status: 'loading', profile: null });
  const [editing, setEditing] = useState(false), [form, setForm] = useState(EMPTY_RECIPIENT), [busy, setBusy] = useState(false);
  const [error, setError] = useState(''), [showErrors, setShowErrors] = useState(false), [announce, setAnnounce] = useState('');
  const heading = useRef(null), mounted = useRef(true);
  const refs = { lastName: useRef(null), firstName: useRef(null), middleName: useRef(null), phone: useRef(null) };
  function load() {
    setState({ status: 'loading', profile: null });
    fetchProfile().then(p => mounted.current && setState({ status: 'ready', profile: p })).catch(() => mounted.current && setState({ status: 'error', profile: null }));
  }
  useEffect(() => { mounted.current = true; load(); return () => { mounted.current = false; }; }, []);
  useEffect(() => { if (editing) refs.lastName.current?.focus(); }, [editing]);
  const errors = contactErrors(form), profile = state.profile;
  const name = RECIPIENT_NAME_FIELDS.map(field => profile?.[field]).filter(Boolean).join(' '), phone = profile?.phone || '';
  const legacyName = !name && profile?.displayName ? profile.displayName : '';
  function startEdit() { setForm(recipientPrefill(profile) || EMPTY_RECIPIENT); setError(''); setShowErrors(false); setAnnounce(''); setEditing(true); }
  function cancel() { setEditing(false); setError(''); heading.current?.focus(); }
  async function save(event) {
    event.preventDefault(); setShowErrors(true);
    const first = Object.keys(errors)[0];
    if (first) { refs[first].current?.focus(); return; }
    setBusy(true); setError('');
    try { const p = await saveContacts(form); setState({ status: 'ready', profile: p }); setEditing(false); setAnnounce('Контакти збережено.'); heading.current?.focus(); }
    catch (e) { setError(e.status === 429 ? 'Забагато спроб. Спробуйте ще раз трохи пізніше.' : e.status === 400 ? 'Перевірте прізвище, імʼя, по батькові та номер телефону.' : 'Не вдалося зберегти. Спробуйте ще раз.'); }
    finally { setBusy(false); }
  }
  const phoneErr = showErrors && errors.phone;
  return <section className="account-card account-delivery" aria-labelledby="contacts-title" aria-busy={state.status === 'loading'}>
    <p className="eyebrow">ОТРИМУВАЧ</p><h2 id="contacts-title" ref={heading} tabIndex={-1}>Контакти</h2>
    {state.status === 'loading' ? <p role="status">Завантажуємо контакти…</p>
      : state.status === 'error' ? <><Notice>Не вдалося завантажити контакти.</Notice><button type="button" className="button secondary" onClick={load}>Спробувати ще раз</button></>
      : editing ? <form className="checkout-recipient" noValidate onSubmit={save}>
        <p className="cart-hint" id="contacts-name-help">Прізвище, імʼя та по батькові підставимо в оформлення замовлення. Залиште всі три поля порожніми, щоб видалити їх.</p>
        {RECIPIENT_NAME_INPUTS.map(({ field, label, slug, autoComplete }) => {
          const id = `contacts-${slug}`, err = showErrors && errors[field];
          return <div className="checkout-field" key={field}><label htmlFor={id}>{label}</label>
            <input id={id} ref={refs[field]} type="text" autoComplete={autoComplete} maxLength={RECIPIENT_PART_MAX} value={form[field]} disabled={busy} aria-invalid={!!err} aria-describedby={`contacts-name-help${err ? ` ${id}-error` : ''}`} onChange={e => setForm({ ...form, [field]: e.target.value })}/>
            {err && <p id={`${id}-error`} className="checkout-error" role="alert">{err}</p>}</div>;
        })}
        <div className="checkout-field"><label htmlFor="contacts-phone">Мобільний телефон</label>
          <input id="contacts-phone" ref={refs.phone} type="tel" autoComplete="tel" inputMode="tel" maxLength={20} placeholder="050 123 45 67" value={form.phone} disabled={busy} aria-invalid={!!phoneErr} aria-describedby={`contacts-phone-help${phoneErr ? ' contacts-phone-error' : ''}`} onChange={e => setForm({ ...form, phone: e.target.value })}/>
          <small id="contacts-phone-help">Залиште поле порожнім, щоб видалити номер.</small>
          {phoneErr && <p id="contacts-phone-error" className="checkout-error" role="alert">{errors.phone}</p>}</div>
        {error && <p className="delivery-error" role="alert">{error}</p>}
        <div className="account-actions">
          <button type="submit" className="button primary" disabled={busy} aria-busy={busy}>{busy ? 'Зберігаємо…' : 'Зберегти'}</button>
          <button type="button" className="button secondary" onClick={cancel} disabled={busy}>Скасувати</button>
        </div>
      </form>
      : <>
        {name || phone ? <dl className="account-summary">
          <div><dt>ПІБ</dt><dd>{name || '—'}</dd></div>
          <div><dt>Телефон</dt><dd>{phone ? formatPhone(phone) : '—'}</dd></div>
        </dl> : <p>Додайте прізвище, імʼя, по батькові й телефон, і ми підставимо їх в оформлення замовлення.</p>}
        {legacyName && <p className="cart-hint">Раніше ПІБ було збережено одним рядком: «{legacyName}». Вкажіть прізвище, імʼя та по батькові окремо.</p>}
        <div className="account-actions"><button type="button" className="button secondary" onClick={startEdit}>{name || phone ? 'Змінити' : 'Додати контакти'}</button></div>
      </>}
    <p className="np-sr" role="status" aria-live="polite">{announce}</p>
  </section>;
}

function DeliveryCard() {
  const [state, setState] = useState({ status: 'loading', preference: null });
  const [editing, setEditing] = useState(false), [value, setValue] = useState(null), [note, setNote] = useState('');
  const [busy, setBusy] = useState(false), [error, setError] = useState(null), [clearing, setClearing] = useState(false), [announce, setAnnounce] = useState('');
  const heading = useRef(null), mounted = useRef(true);
  const [focusTick, setFocusTick] = useState(0), cleared = useRef(false);
  const focusHeading = () => setFocusTick(t => t + 1);
  useEffect(() => { if (focusTick) heading.current?.focus(); }, [focusTick]);
  function load() {
    setState({ status: 'loading', preference: null });
    fetchProfile().then(p => mounted.current && setState({ status: 'ready', preference: p.deliveryPreference ?? null }))
      .catch(() => mounted.current && setState({ status: 'error', preference: null }));
  }
  useEffect(() => { mounted.current = true; load(); return () => { mounted.current = false; }; }, []);
  const view = deliveryView(state.preference);
  function startEdit() { setValue(fromPreference(state.preference)); setNote(state.preference?.note || ''); setError(null); setEditing(true); setAnnounce(''); focusHeading(); }
  function cancelEdit() { setEditing(false); setError(null); focusHeading(); }
  async function save() {
    const n = noteForSave(note);
    if (n.error) { setError(n.error); return; }
    if (!value) { setError('Оберіть пункт зі списку.'); return; }
    await commit(() => saveDeliveryPreference(value.warehouseRef, n.note), () => { setEditing(false); setAnnounce('Збережено.'); focusHeading(); });
  }
  async function commit(call, done) {
    setBusy(true); setError(null); setAnnounce('');
    try { const p = await call(); setState({ status: 'ready', preference: p.deliveryPreference ?? null }); done?.(); }
    catch (e) { setError(deliveryErrorMessage(e instanceof TypeError ? 0 : e.status)); }
    finally { setBusy(false); }
  }
  // The tick is bumped in the same batch that unmounts the dialog, so the heading wins over the dialog's focus restore.
  function closeClear() { setClearing(false); if (cleared.current) { cleared.current = false; focusHeading(); } }
  async function clear() {
    setAnnounce(''); cleared.current = false;
    try { const p = await saveDeliveryPreference(null); setState({ status: 'ready', preference: p.deliveryPreference ?? null }); setEditing(false); setAnnounce('Пункт очищено.'); cleared.current = true; }
    catch (e) { throw new Error(deliveryErrorMessage(e.status)); }
  }
  return <section className="account-card account-delivery" aria-labelledby="delivery-title" aria-busy={state.status === 'loading'}>
    <p className="eyebrow">НОВА ПОШТА</p><h2 id="delivery-title" ref={heading} tabIndex={-1}>Доставка</h2>
    {state.status === 'loading' ? <p role="status">Завантажуємо доставку…</p>
      : state.status === 'error' ? <><Notice>{DELIVERY_LOAD_ERROR}</Notice><button type="button" className="button secondary" onClick={load}>Спробувати ще раз</button></>
      : <>
        {!editing && view.kind === 'none' && <p>Улюбленого пункту Нової пошти поки немає. Оберіть його тут або ми запамʼятаємо пункт із наступного замовлення.</p>}
        {!editing && view.kind === 'legacy' && <div className="delivery-current">
          <p><strong>{view.text}</strong></p>{view.note && <p>Примітка: {view.note}</p>}
          <p className="delivery-hint">{view.prompt}</p>
        </div>}
        {!editing && view.kind === 'favourite' && <div className="delivery-current">
          <p className="delivery-origin">{view.originLabel}</p><p><strong>{view.text}</strong></p>{view.note && <p>Примітка: {view.note}</p>}
        </div>}
        {editing && <div className="delivery-edit">
          {view.kind === 'legacy' && <p className="delivery-hint">{view.prompt}</p>}
          <NovaPoshtaPicker value={value} onChange={setValue} idPrefix="cabinet-np" disabled={busy} legend="Улюблений пункт Нової пошти" />
          <div className="field"><label htmlFor="cabinet-np-note">Примітка до доставки (необовʼязково)</label>
            <textarea id="cabinet-np-note" rows={2} value={note} onChange={e => setNote(e.target.value)} disabled={busy} aria-describedby="cabinet-np-note-help" />
            <small id="cabinet-np-note-help">До {NOTE_MAX} символів, не більше двох рядків. <span aria-live="off">{noteLength(note)}/{NOTE_MAX}</span></small></div>
        </div>}
        {error && <p className="delivery-error" role="alert">{error}</p>}
        <div className="account-actions">
          {editing ? <>
            <button type="button" className="button primary" onClick={save} disabled={busy || !value} aria-busy={busy}>{busy ? 'Зберігаємо…' : 'Зберегти'}</button>
            <button type="button" className="button secondary" onClick={cancelEdit} disabled={busy}>Скасувати</button>
          </> : <>
            <button type="button" className="button secondary" onClick={startEdit} disabled={busy}>{view.kind === 'none' ? 'Обрати пункт' : view.kind === 'legacy' ? 'Обрати пункт із довідника' : 'Змінити'}</button>
            {view.kind === 'favourite' && view.canPromote && <button type="button" className="button secondary" disabled={busy} onClick={() => commit(() => saveDeliveryPreference(state.preference.warehouseRef), () => { setAnnounce('Збережено.'); focusHeading(); })}>Зробити улюбленим</button>}
            {view.kind !== 'none' && <button type="button" className="button secondary" data-dialog-return disabled={busy} onClick={() => { setError(null); setClearing(true); }}>Очистити</button>}
          </>}
        </div>
      </>}
    <p className="np-sr" role="status" aria-live="polite">{announce}</p>
    {clearing && <ConfirmDialog title="Очистити пункт доставки?" confirmLabel="Очистити" danger onConfirm={clear} onClose={closeClear}>
      Збережений пункт буде видалено. Наступне замовлення з пунктом доставки знову запамʼятає його.
    </ConfirmDialog>}
  </section>;
}

function Summary({ customer, onSignedOut, onMessage }) {
  const [busy, setBusy] = useState(false), [confirm, setConfirm] = useState(false);
  async function signOut() {
    setBusy(true);
    try { await logout(); onSignedOut(); } catch (e) { onMessage({ type: 'error', text: 'Не вдалося вийти. Спробуйте ще раз.' }); setBusy(false); }
  }
  async function everywhere() {
    try { await revokeAll(); onSignedOut('Ви вийшли на всіх пристроях.'); }
    catch (e) { throw new Error(e.status === 401 ? 'Сесія вже завершена. Оновіть сторінку.' : 'Не вдалося вийти на всіх пристроях. Спробуйте ще раз.'); }
  }
  const providers = providerLabels(customer.providers);
  return <>
    <section className="account-card" aria-labelledby="summary-title">
      <p className="eyebrow">КАБІНЕТ</p>
      <h1 id="summary-title">Вітаємо{customer.displayName ? `, ${customer.displayName}` : ''}</h1>
      <dl className="account-summary">
        <div><dt>Вхід</dt><dd>{customerHandle(customer)}</dd></div>
        <div><dt>Способи входу</dt><dd>{providers.length ? providers.join(', ') : '—'}</dd></div>
      </dl>
      <div className="account-actions">
        <button type="button" className="button secondary" onClick={signOut} disabled={busy}>Вийти</button>
        <button type="button" className="button secondary" data-dialog-return onClick={() => setConfirm(true)} disabled={busy}>Вийти на всіх пристроях</button>
      </div>
    </section>
    <ContactsCard />
    <section className="account-card account-placeholder" aria-label="Розділи кабінету" data-account-sections>
      <p>Telegram з’явиться тут.</p>
    </section>
    <DeliveryCard />
    <AccountCarts />
    {confirm && <ConfirmDialog title="Вийти на всіх пристроях?" confirmLabel="Вийти всюди" danger onConfirm={everywhere} onClose={() => setConfirm(false)}>
      Усі ваші сеанси, зокрема на інших пристроях, буде завершено. Щоб повернутися, потрібно буде увійти знову.
    </ConfirmDialog>}
  </>;
}

export default function Account() {
  const [session, setSession] = useState(null), [message, setMessage] = useState(null), [afterSignOut, setAfterSignOut] = useState(false);
  useEffect(() => {
    const m = callbackMessage(location.search);
    if (m) { setMessage(m); history.replaceState(null, '', cleanedUrl(location.pathname, location.search, location.hash)); }
    let active = true;
    fetchSession().then(s => { if (active) setSession(s); });
    return () => { active = false; };
  }, []);
  function signedOut(text) { setAfterSignOut(true); setSession({ authenticated: false }); setMessage({ type: 'success', text: text || 'Ви вийшли з кабінету.' }); }
  return <div className="storefront account-page">
    <SiteHeader session={session}/>
    <main className="account-main">
      {message && <Notice type={message.type === 'error' ? 'error' : 'success'} onClose={() => setMessage(null)}>{message.text}</Notice>}
      {session === null ? <p className="loading" role="status">Завантажуємо кабінет…</p>
        : session.authenticated ? <Summary customer={session.customer} onSignedOut={signedOut} onMessage={setMessage} />
        : <>{session.failed && <Notice>Не вдалося перевірити сесію. Спробуйте оновити сторінку.</Notice>}<SignInCard onMessage={setMessage} focusOnMount={afterSignOut} /></>}
    </main>
  </div>;
}
