import React, { useEffect, useRef, useState } from 'react';
import { Notice, Empty, Photo } from '../ui.jsx';
import { money, date } from '../api.js';
import SiteHeader from '../landing/SiteHeader.jsx';
import { useCartCount } from './CartLink.jsx';
import ConfirmDialog from '../ConfirmDialog.jsx';
import { cartSum, lineTotal, loadCatalogHints, unavailableFlags, priceDrifted } from './cart-pricing.js';
import { cartStore, isAddOk, lineKey, parseQuantityDraft } from './cart-store.js';
import NovaPoshtaPicker from '../delivery/NovaPoshtaPicker.jsx';
import { fromCartDelivery, valueSummary } from '../delivery/np-picker-logic.js';
import { fetchSession } from '../account/account-api.js';
import { fetchProfile } from '../delivery/profile-delivery.js';
import { loadStorefrontSettings } from '../landing/campaign.js';
import { STEPS, stepIndex, stepOf, stepCaption, prevStep, formatPhone, recipientErrors, checkoutRecipient, recipientInput, recipientPrefill, recipientLine, prepaymentMinorOf, prepaymentView, stepForError, canEnter, RECIPIENT_PART_MAX, RECIPIENT_NAME_INPUTS, EMPTY_RECIPIENT, BUYER_NOTICE_HEADLINE, BUYER_NOTICE_TEXT, TERMS_LABEL_PREFIX, TERMS_LINK_TEXT, TERMS_HREF, termsError } from './checkout-steps.js';
import { recipientFullName } from '../../../../packages/catalog/recipient.js';
import './checkout.css';
import { ADD_STATUS_TEXT, checkout, checkoutDelivery, checkoutErrorText, deliveryHint, prefillFromProfile, deliveryErrorCode, cleanedCartUrl, copyText, fetchProduct, managerMessage, mapProblemsToLines, parseAddParams } from './cart-api.js';

function CopyButton({ text, label, onResult }) {
  const [state, setState] = useState('');
  async function copy() { const ok = await copyText(text); setState(ok ? 'ok' : 'fail'); onResult?.(ok); }
  return <><button type="button" className="button secondary" onClick={copy}>{state === 'ok' ? 'Скопійовано' : label}</button><span className="sr-only" role="status" aria-live="polite">{state === 'ok' ? 'Скопійовано' : state === 'fail' ? 'Не вдалося скопіювати. Виділіть текст і скопіюйте вручну.' : ''}</span>{state === 'fail' && <small className="copy-fail">Не вдалося скопіювати. Виділіть текст вручну.</small>}</>;
}

export function Confirmation({ cart, onClose = () => {}, updated = false, point = null, recipient = null, termsAccepted = false }) {
  const heading = useRef(null);
  useEffect(() => { heading.current?.focus(); }, []);
  const shown = fromCartDelivery(cart.delivery) ?? point; // the stored point wins; an anonymous checkout keeps only the chosen one
  const contact = cart.recipient ?? recipient; // the stored recipient wins; an anonymous checkout keeps only the entered one
  const message = managerMessage(cart, money, shown, contact, termsAccepted);
  return <section className="account-card cart-confirm" aria-labelledby="confirm-title">
    <p className="eyebrow">КОШИК СТВОРЕНО</p>
    <h1 id="confirm-title" tabIndex={-1} ref={heading}>Ваш код кошика</h1>
    <p className="cart-code" aria-label={`Код кошика ${cart.code}`}>{cart.code}</p>
    <div className="cart-actions"><CopyButton text={cart.code} label="Скопіювати код"/></div>
    <p>Надішліть цей код менеджеру, і він підтвердить наявність та доставку.</p>
    {cart.bound && <p className="cart-bound">Кошик збережено у вашому профілі.</p>}
    {recipientLine(contact) && <p className="cart-delivery-point"><strong>Отримувач:</strong> {recipientFullName(contact)}, {formatPhone(contact.phone)}</p>}
    {shown && <p className="cart-delivery-point"><strong>Доставка:</strong> Нова пошта, {valueSummary(shown)}</p>}
    <h2 className="cart-sub">Повідомлення для менеджера</h2>
    <label className="sr-only" htmlFor="manager-message">Повідомлення для менеджера</label>
    <textarea id="manager-message" className="cart-message" readOnly rows={6} value={message}/>
    <div className="cart-actions"><CopyButton text={message} label="Скопіювати повідомлення"/><button type="button" className="button primary" onClick={onClose}>До каталогу</button></div>
    <p className="cart-total">Сума за вашим кошиком: <strong>{money(cart.totalMinor)}</strong> ({cart.itemCount} шт.){updated && <span className="cart-updated"> Ціну оновлено</span>}</p>
  </section>;
}

function Line({ line, index, problem, unavailable, busy, onQty, onRemove }) {
  const qtyId = `qty-${index}`, errId = `line-error-${index}`, goneId = `line-gone-${index}`, hintId = `qty-hint-${index}`;
  const [draft, setDraft] = useState(String(line.quantity));
  useEffect(() => { setDraft(String(line.quantity)); }, [line.quantity]);
  const invalidDraft = parseQuantityDraft(draft) === null;
  function change(text) {
    setDraft(text);
    const n = parseQuantityDraft(text);
    if (n !== null) onQty(index, n);
  }
  function commit() {
    const n = parseQuantityDraft(draft);
    if (n !== null) onQty(index, n); else setDraft(String(line.quantity));
  }
  return <li className={`cart-line ${problem || unavailable ? 'has-problem' : ''}`}>
    <div className="cart-photo"><Photo src={line.photo || undefined} title={line.title}/></div>
    <div className="cart-line-body">
      <h3>{line.slug ? <a href={`/products/${encodeURIComponent(line.slug)}`}>{line.title || line.slug}</a> : line.title}</h3>
      <p className="cart-meta">Розмір: <strong>{line.size}</strong>{line.priceMinor != null && <> · {money(line.priceMinor)}</>}</p>
      <div className="cart-line-controls">
        <label htmlFor={qtyId}>Кількість</label>
        <input id={qtyId} type="text" inputMode="numeric" pattern="[0-9]*" maxLength={3} value={draft} disabled={busy} aria-describedby={[problem ? errId : '', unavailable && !problem ? goneId : '', invalidDraft ? hintId : ''].filter(Boolean).join(' ') || undefined} aria-invalid={!!problem || invalidDraft} onChange={e => change(e.target.value)} onBlur={commit} onKeyDown={e => { if (e.key === 'Enter') { e.preventDefault(); commit(); } }}/>
        <button type="button" className="text-button" disabled={busy} onClick={() => onRemove(index)} aria-label={`Видалити: ${line.title}, розмір ${line.size}`}>Видалити</button>
        {line.quantity > 1 && lineTotal(line) !== null && <strong className="cart-line-total"><span className="sr-only">Разом за позицію: </span><span aria-hidden="true">× {line.quantity} = </span>{money(lineTotal(line))}</strong>}
      </div>
      {invalidDraft && <p id={hintId} className="cart-line-error">від 1 до 10</p>}
      {unavailable && !problem && <p id={goneId} className="cart-line-error">Немає в наявності</p>}
      {problem && <p id={errId} className="cart-line-error">{problem.text}</p>}
    </div>
  </li>;
}

/** Step indicator: earlier steps are buttons (state is kept), the current one is marked, later ones are plain text. */
export function StepIndicator({ step, onGo, disabled }) {
  const current = stepIndex(step);
  return <nav className="checkout-steps" aria-label="Етапи оформлення">
    <ol>{STEPS.map((s, i) => <li key={s.id} className={i < current ? 'done' : i === current ? 'current' : 'todo'}>
      {i < current ? <button type="button" className="checkout-step" disabled={disabled} onClick={() => onGo(s.id)}><span className="checkout-step-n" aria-hidden="true">{i + 1}</span><span>{s.label}</span><span className="sr-only"> (крок {i + 1}, виконано; повернутися)</span></button>
        : <span className="checkout-step" aria-current={i === current ? 'step' : undefined}><span className="checkout-step-n" aria-hidden="true">{i + 1}</span><span>{s.label}</span><span className="sr-only"> (крок {i + 1}{i === current ? ', поточний' : ''})</span></span>}
    </li>)}</ol>
  </nav>;
}

/** Warning triangle with «!» on the 24-unit icon grid (stroke 1.6, round caps and joins); decorative, the headline carries the meaning. */
function WarningIcon() {
  return <svg className="checkout-warning-icon" viewBox="0 0 24 24" aria-hidden="true" focusable="false" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round">
    <path d="M10.3 4.2 2.6 17.6A2 2 0 0 0 4.3 20.6h15.4a2 2 0 0 0 1.7-3L13.7 4.2a2 2 0 0 0-3.4 0Z"/>
    <path d="M12 9.2v4.6"/>
    <circle cx="12" cy="17" r=".6" fill="currentColor"/>
  </svg>;
}

/**
 * Buyer warning at the top of the «Кошик» step (replaces the earlier calm note): icon, headline and body.
 * Informational only (lead decision): no acknowledgement, no gating, not a live region; always visible on the first step.
 */
export function BuyerNotice() {
  return <section className="checkout-warning" role="note" aria-labelledby="buyer-notice-title">
    <div className="checkout-warning-head"><WarningIcon/><h2 id="buyer-notice-title">{BUYER_NOTICE_HEADLINE}</h2></div>
    <p className="checkout-warning-text">{BUYER_NOTICE_TEXT}</p>
  </section>;
}

/**
 * Required terms checkbox right before the final submit. Never pre-checked; the error is shown only after a submit
 * attempt and is linked to the input. The link opens the delivery & exchange policy in a new tab so the entered recipient survives.
 */
export function TermsConsent({ checked, onChange, showError, disabled, inputRef }) {
  const error = showError ? termsError(checked) : '';
  return <div className="checkout-terms">
    <label className="checkout-terms-row" htmlFor="checkout-terms">
      <input id="checkout-terms" ref={inputRef} type="checkbox" checked={checked} disabled={disabled} required aria-required="true"
        aria-invalid={!!error} aria-describedby={error ? 'checkout-terms-error' : undefined} onChange={e => onChange(e.target.checked)}/>
      <span>{TERMS_LABEL_PREFIX}<a href={TERMS_HREF} target="_blank" rel="noopener">{TERMS_LINK_TEXT}<span className="sr-only"> (відкриється в новій вкладці)</span></a></span>
    </label>
    {error && <p id="checkout-terms-error" className="checkout-error" role="alert">{error}</p>}
  </div>;
}

/** «Отримувач»: Прізвище, Імʼя, По батькові and phone, all required; per-field inline errors. refs: {field: ref}. */
export function RecipientForm({ draft, onChange, errors, showErrors, signed, prefilled, busy, onBack, onNext, refs = {} }) {
  const phoneErr = showErrors && errors.phone;
  return <form className="checkout-recipient" noValidate onSubmit={e => { e.preventDefault(); onNext(); }}>
    {RECIPIENT_NAME_INPUTS.map(({ field, label, slug, autoComplete }) => {
      const id = `recipient-${slug}`, err = showErrors && errors[field];
      return <div className="checkout-field" key={field}>
        <label htmlFor={id}>{label}</label>
        <input id={id} ref={refs[field]} type="text" autoComplete={autoComplete} maxLength={RECIPIENT_PART_MAX} required aria-required="true" value={draft[field] ?? ''} disabled={busy}
          aria-invalid={!!err} aria-describedby={err ? `${id}-error` : undefined}
          onChange={e => onChange({ [field]: e.target.value })}/>
        {err && <p id={`${id}-error`} className="checkout-error" role="alert">{err}</p>}
      </div>;
    })}
    <div className="checkout-field">
      <label htmlFor="recipient-phone">Мобільний телефон</label>
      <input id="recipient-phone" ref={refs.phone} type="tel" autoComplete="tel" inputMode="tel" maxLength={20} placeholder="050 123 45 67" required aria-required="true" value={draft.phone ?? ''} disabled={busy}
        aria-invalid={!!phoneErr} aria-describedby={['recipient-phone-help', phoneErr ? 'recipient-phone-error' : ''].filter(Boolean).join(' ')}
        onChange={e => onChange({ phone: e.target.value })}/>
      <small id="recipient-phone-help">Мобільний номер України, наприклад 050 123 45 67.</small>
      {phoneErr && <p id="recipient-phone-error" className="checkout-error" role="alert">{errors.phone}</p>}
    </div>
    <p className="cart-hint">{signed === false ? 'Дані потраплять лише в повідомлення для менеджера. Увійдіть, щоб зберегти їх із замовленням.' : signed === true ? (prefilled ? 'Заповнено з вашого профілю. Зміни діють лише для цього замовлення.' : 'Збережемо отримувача разом із замовленням у вашому профілі.') : ''}</p>
    <div className="checkout-nav">
      <button type="button" className="button secondary" onClick={onBack} disabled={busy}>Назад</button>
      <button type="submit" className="button primary" disabled={busy}>Далі: доставка</button>
    </div>
  </form>;
}

export default function CartPage() {
  const count = useCartCount();
  const cart = cartStore.get();
  const [live, setLive] = useState(''), [confirmClear, setConfirmClear] = useState(false), [notice, setNotice] = useState(null), [busy, setBusy] = useState(false), [problems, setProblems] = useState({ byKey: {}, general: [] });
  const [error, setError] = useState(''), [done, setDone] = useState(null), [point, setPoint] = useState(null), [signed, setSigned] = useState(null), [prefilled, setPrefilled] = useState(null), [offerNoPoint, setOfferNoPoint] = useState(false), [adding, setAdding] = useState(() => !!parseAddParams(location.search));
  const addStarted = useRef(false), [catalog, setCatalog] = useState(() => new Map()), [drift, setDrift] = useState(false);
  // Steps. The recipient draft is React state only: never written to browser storage.
  const [step, setStep] = useState('items'), [draft, setDraft] = useState(EMPTY_RECIPIENT), [showErrors, setShowErrors] = useState(false), [recipientPrefilled, setRecipientPrefilled] = useState(false), [prepaymentMinor, setPrepaymentMinor] = useState(0);
  const recipientTouched = useRef(false), shownStep = useRef('items');
  // Terms: React state only, never pre-checked, cleared whenever the cart becomes empty.
  const [terms, setTerms] = useState(false), [showTermsError, setShowTermsError] = useState(false), termsRef = useRef(null);
  const recipientRefs = { lastName: useRef(null), firstName: useRef(null), middleName: useRef(null), phone: useRef(null) };
  useEffect(() => {
    let active = true;
    loadCatalogHints(cartStore.snapshot(), fetchProduct).then(({ found }) => {
      if (!active) return;
      cartStore.refreshHints(found);
      setCatalog(prev => { const m = new Map(prev); for (const p of found) m.set(p.id, p); return m; });
    });
    loadStorefrontSettings().then(settings => { if (active) setPrepaymentMinor(prepaymentMinorOf(settings)); });
    return () => { active = false; };
  }, []);

  const touched = useRef(false), titleRef = useRef(null);
  useEffect(() => {
    let active = true;
    fetchSession().then(session => {
      if (!active) return null;
      if (session?.authenticated !== true) { if (!session?.failed) setSigned(false); return null; } // a failed session lookup stays unknown: nothing is sent
      setSigned(true);
      return fetchProfile().then(profile => {
        if (!active) return;
        const prefill = prefillFromProfile(profile, touched.current);
        if (prefill) { setPoint(prefill.value); setPrefilled(prefill); }
        const contact = recipientPrefill(profile, recipientTouched.current);
        if (contact) { setDraft(contact); setRecipientPrefilled(true); }
      });
    }).catch(() => {});
    return () => { active = false; };
  }, []);
  const markTouched = () => { touched.current = true; };
  function choosePoint(next) { touched.current = true; setPoint(next); setOfferNoPoint(false); setError(''); }
  function changeDraft(patch) { recipientTouched.current = true; setDraft(prev => ({ ...prev, ...patch })); }

  useEffect(() => {
    const params = parseAddParams(location.search);
    if (!params || addStarted.current) return;
    addStarted.current = true;
    const clean = () => history.replaceState(null, '', cleanedCartUrl(location.pathname, location.search, location.hash));
    if (!params.size) {
      setNotice({ type: 'error', text: <>{ADD_STATUS_TEXT.no_size} <a href={`/products/${encodeURIComponent(params.slug)}`}>До сторінки товару</a>.</> });
      clean(); setAdding(false); return;
    }
    fetchProduct(params.slug).then(product => {
      const result = cartStore.addProduct(product, params.size, params.qty);
      setNotice({ type: isAddOk(result.status) ? 'success' : 'error', text: `${product.title}, ${params.size}: ${ADD_STATUS_TEXT[result.status]}` });
    }).catch(e => setNotice({ type: 'error', text: e.status === 404 ? 'Цей товар більше недоступний.' : 'Не вдалося перевірити товар. Спробуйте додати його ще раз.' }))
      .finally(() => { clean(); setAdding(false); });
  }, []);

  // Focus moves to the step heading on every step change (not on first render), so screen readers announce the new step.
  useEffect(() => { if (shownStep.current !== step) { shownStep.current = step; titleRef.current?.focus(); } }, [step]);
  function go(id) { if (busy || !canEnter(id, { lineCount: cart.lines.length, draft })) return; setNotice(null); setStep(id); }
  // An emptied cart (here or in another tab) always returns to the first step.
  useEffect(() => { if (!cart.lines.length && step !== 'items') setStep('items'); }, [cart.lines.length, step]);
  useEffect(() => { if (!cart.lines.length) { setTerms(false); setShowTermsError(false); } }, [cart.lines.length]);

  function resetProblems() { setProblems({ byKey: {}, general: [] }); setError(''); setOfferNoPoint(false); }
  useEffect(() => cartStore.subscribeExternal(resetProblems), []);
  function setQty(index, q) { if (busy || !Number.isInteger(q) || cart.lines[index]?.quantity === q) return; resetProblems(); cartStore.setQuantity(index, q); }
  function remove(index) { if (busy) return; resetProblems(); cartStore.removeLine(index); }
  const errors = recipientErrors(draft);
  function toDelivery() {
    setShowErrors(true);
    const first = Object.keys(errors)[0]; // form order: Прізвище, Імʼя, По батькові, phone
    if (first) { recipientRefs[first].current?.focus(); return; }
    go('delivery');
  }
  async function submit(withoutPoint = false) {
    if (busy || !cart.lines.length) return;
    if (Object.keys(errors).length) { setShowErrors(true); setStep('recipient'); return; }
    if (termsError(terms)) { setShowTermsError(true); termsRef.current?.focus(); return; } // also gates «Оформити без пункту»
    setBusy(true); resetProblems(); setNotice(null);
    if (withoutPoint) { touched.current = true; setPoint(null); titleRef.current?.focus(); } // the retry button unmounts with its notice
    // Only a known signed-in session sends a point or a recipient; anonymous or unknown sessions send neither.
    const chosen = withoutPoint ? null : point, delivery = checkoutDelivery({ signed, point: chosen }), recipient = checkoutRecipient({ signed, draft });
    const submitted = cartStore.snapshot();
    const before = cartSum(submitted);
    try {
      const { cart: created } = await checkout(submitted, undefined, { delivery, recipient });
      if (!created?.code) { setNotice({ type: 'info', text: 'Кошик, імовірно, створено, але код не отримано. Зверніться до менеджера й не повторюйте оформлення, щоб не створити дубль. Ваші позиції залишилися в кошику.' }); return; }
      cartStore.completeCheckout(created, submitted);
      setDrift(before.complete && priceDrifted(before.total, created.totalMinor));
      setDone({ cart: created, point: chosen, recipient: recipientInput(draft), terms: true });
    } catch (e) {
      const deliveryError = deliveryErrorCode(e);
      if (!deliveryError && (e.status === 400 || e.status === 409)) setProblems(mapProblemsToLines(e.problems, submitted));
      setOfferNoPoint(deliveryError === 'delivery_catalog_unavailable');
      setError(checkoutErrorText(e));
      const back = stepForError(e, 'delivery');
      if (back === 'recipient') setShowErrors(true);
      if (back !== step) setStep(back);
    } finally { setBusy(false); }
  }
  const { total, complete: priced } = cartSum(cart.lines), gone = unavailableFlags(cart.lines, catalog);
  const prepay = prepaymentView(prepaymentMinor, total, priced), current = stepOf(step);
  const totals = <>
    <p>Позицій: {cart.lines.length}, одиниць: {count}</p>
    {priced ? <p className="cart-total">Сума: <strong>{money(total)}</strong></p> : <p className="cart-hint">Суму буде розраховано під час оформлення.</p>}
    {prepay && <dl className="checkout-prepay">
      <div><dt>Передоплата</dt><dd><strong>{money(prepay.prepaymentMinor)}</strong></dd></div>
      {prepay.remainderMinor !== null && <div><dt>Решта при отриманні</dt><dd>{money(prepay.remainderMinor)}</dd></div>}
    </dl>}
  </>;

  return <div className="storefront cart-page">
    <SiteHeader/>
    <main className="cart-main">
      {done ? <Confirmation cart={done.cart} point={done.point} recipient={done.recipient} termsAccepted={done.terms} updated={drift} onClose={() => { location.assign('/'); }}/> : <>
        <p className="eyebrow">{cart.lines.length ? `ОФОРМЛЕННЯ · ${stepCaption(step).toUpperCase()}` : 'КОШИК'}</p>
        <h1 className="cart-title" tabIndex={-1} ref={titleRef}>{cart.lines.length ? <><span className="sr-only">{stepCaption(step)}. </span>{current.title}</> : 'Ваш кошик'}</h1>
        {cart.lines.length > 0 && <StepIndicator step={step} onGo={go} disabled={busy}/>}
        <div aria-live="polite" role="status" className="cart-live">{adding ? 'Додаємо товар…' : live}</div>
        {notice && <Notice type={notice.type} onClose={() => setNotice(null)}>{notice.text}</Notice>}
        {error && <Notice type="error">{error}{offerNoPoint && step === 'delivery' && <> <button type="button" className="button secondary cart-retry-no-point" disabled={busy} onClick={() => submit(true)}>Оформити без пункту</button></>}</Notice>}
        {problems.general.map((t, i) => <Notice key={i}>{t}</Notice>)}
        {!cartStore.isPersistent() && <Notice type="info">Не вдалося зберегти кошик у браузері. Він зникне після закриття вкладки.</Notice>}
        {cart.lines.length ? <>
          {step === 'items' && <>
            <BuyerNotice/>
            <ul className="cart-lines">{cart.lines.map((line, i) => <Line key={`${line.productId}-${line.size}`} line={line} index={i} problem={problems.byKey[lineKey(line)]} unavailable={gone[i]} busy={busy} onQty={setQty} onRemove={remove}/>)}</ul>
            <section className="cart-summary" aria-label="Підсумок">
              {totals}
              <div className="checkout-nav"><button type="button" className="button primary" onClick={() => go('recipient')} disabled={busy}>Далі: отримувач</button></div>
            </section>
          </>}
          {step === 'recipient' && <RecipientForm draft={draft} onChange={changeDraft} errors={errors} showErrors={showErrors} signed={signed} prefilled={recipientPrefilled && !recipientTouched.current} busy={busy} onBack={() => go(prevStep(step))} onNext={toDelivery} refs={recipientRefs}/>}
          {step === 'delivery' && <>
            <section className="cart-delivery" aria-label="Пункт доставки" onFocusCapture={markTouched} onInputCapture={markTouched}>
              <NovaPoshtaPicker value={point} onChange={choosePoint} idPrefix="checkout-np" disabled={busy} legend="Пункт Нової пошти (необовʼязково)"/>
              <p id="checkout-np-hint" className="cart-hint" role="status" aria-live="polite">{deliveryHint({ signed, point, prefilled })}</p>
            </section>
            <section className="cart-summary" aria-label="Підсумок">
              {recipientInput(draft) && <p className="checkout-recap">{recipientLine(recipientInput(draft))} <button type="button" className="text-button" disabled={busy} onClick={() => go('recipient')}>Змінити<span className="sr-only"> отримувача</span></button></p>}
              {totals}
              <TermsConsent checked={terms} onChange={v => { setTerms(v); if (v) setShowTermsError(false); }} showError={showTermsError} disabled={busy} inputRef={termsRef}/>
              <div className="checkout-nav">
                <button type="button" className="button secondary" onClick={() => go(prevStep(step))} disabled={busy}>Назад</button>
                <button type="button" className="button primary" onClick={() => submit()} disabled={busy} aria-busy={busy}>{busy ? 'Оформлюємо…' : 'Отримати код кошика'}</button>
              </div>
            </section>
          </>}
        </> : !adding && <Empty title="Кошик порожній" icon="grid">Додайте речі з <a href="/#catalog">каталогу</a>.</Empty>}
        {step === 'items' && cart.recent.length > 0 && <section className="cart-recent" aria-labelledby="recent-title">
          <h2 id="recent-title" className="cart-sub">Мої останні коди</h2>
          <p className="cart-hint">Список зберігається лише в цьому браузері. На спільному пристрої очистіть його.</p>
          <ul>{cart.recent.map(r => <li key={r.code}><code>{r.code}</code><span>{r.createdAt ? date(r.createdAt) : ''} · {r.itemCount} шт. · {money(r.totalMinor)}</span><CopyButton text={r.code} label="Копіювати"/></li>)}</ul>
          <button type="button" className="button secondary" data-dialog-return onClick={() => setConfirmClear(true)}>Очистити список кодів</button>
        </section>}
      </>}
    </main>
    {confirmClear && <ConfirmDialog title="Очистити список кодів?" confirmLabel="Очистити" danger onConfirm={() => { cartStore.clearRecent(); setLive('Список кодів очищено.'); }} onClose={() => setConfirmClear(false)}>Коди буде видалено лише з цього браузера. Вже створені кошики та їхні коди менеджера не зміняться, а скасувати очищення не можна.</ConfirmDialog>}
  </div>;
}
