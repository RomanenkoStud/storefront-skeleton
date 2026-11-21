import React from 'react';
import {Field, Icon} from './ui.jsx';
import {date} from './api.js';

// EasyDrop feed links are secrets: never render, log, store or put them in URLs. They live only in an
// uncontrolled input and are cleared as soon as the request settles.
export const providerOf = supplier => supplier?.provider === 'easydrop' ? 'easydrop' : supplier?.provider === 'manual' ? 'manual' : 'mydrop';
const LABELS = {easydrop: 'EasyDrop', manual: 'Ручний', mydrop: 'MyDrop'};
export const providerLabel = supplier => LABELS[providerOf(supplier)];
export function httpsUrl(value) {
  try { return new URL(String(value)).protocol === 'https:' ? String(value) : null; } catch { return null; }
}
export function feedSummary(feed) {
  if(!feed?.configured) return 'Посилання на фід: не налаштовано';
  const tail = feed.keyLast4 ? ` ••••${feed.keyLast4}` : '';
  return `Посилання на фід: налаштовано${tail}${feed.updatedAt ? ` · оновлено ${date(feed.updatedAt)}` : ''}`;
}
// Reads the trimmed link from the form, always clears the input once the request settles.
export async function submitFeedForm(form, run) {
  const input = form.elements.feedUrl;
  const nameInput = form.elements.name;
  const feedUrl = String(input.value || '').trim();
  const name = nameInput ? String(nameInput.value || '').trim() : undefined;
  try { return await run(name === undefined ? {feedUrl} : {name, feedUrl}); }
  finally { input.value = ''; }
}

// Masked text input (not type=password) so password managers do not offer to save the feed key.
const SECRET_PROPS = {autoComplete:'off', spellCheck:false, 'data-1p-ignore':true, 'data-lpignore':'true', 'data-bwignore':true};

export function ProviderBadge({supplier}) {
  const provider = providerOf(supplier);
  return <span className={`provider-badge provider-${provider}`} title={provider==='manual'?'Ручний постачальник: без синхронізації та імпорту':undefined}>{providerLabel(supplier)}</span>;
}

export function SupplierSource({supplier}) {
  if(providerOf(supplier) === 'manual') return <span className="supplier-url-plain">Товари додаються вручну в кабінеті. Синхронізації немає.</span>;
  if(providerOf(supplier) === 'easydrop') return <p className="feed-status">{feedSummary(supplier.feed)}</p>;
  const href = httpsUrl(supplier.url);
  return href ? <a href={href} target="_blank" rel="noreferrer">{supplier.url} ↗</a> : <span className="supplier-url-plain">{supplier.url}</span>;
}

export function ReplaceFeedForm({supplier, busy, working, onReplace}) {
  return <form className="connection-form feed-form" autoComplete="off" onSubmit={e => {e.preventDefault();submitFeedForm(e.currentTarget, ({feedUrl}) => onReplace(supplier, feedUrl)).catch(() => {});}}>
    <Field label={`Нове посилання на фід · ${supplier.name}`} hint="Вставте повне посилання EasyDrop. Поточне посилання не показується.">
      <input name="feedUrl" type="text" className="secret-input" {...SECRET_PROPS} required maxLength={200} placeholder="https://easydrop.one/prom-export?key=…" disabled={busy}/>
    </Field>
    <button className="button small secondary" disabled={busy}>{working ? 'Зберігаємо…' : 'Замінити посилання'}</button>
  </form>;
}

export function AddEasyDropForm({busy, working, onAdd}) {
  return <section className="panel add-supplier add-easydrop">
    <div className="panel-title"><h2>Новий постачальник EasyDrop</h2><Icon name="plus"/></div>
    <form autoComplete="off" onSubmit={e => {e.preventDefault();const form=e.currentTarget;submitFeedForm(form, onAdd).then(() => form.reset(), () => {});}}>
      <Field label="Назва"><input name="name" required maxLength={120} placeholder="Наприклад, EasyDrop Одяг" disabled={busy}/></Field>
      <Field label="Посилання на фід EasyDrop" hint="Вставте посилання на експорт. Воно зберігається лише на сервері й не показується повторно."><input name="feedUrl" type="text" className="secret-input" {...SECRET_PROPS} required maxLength={200} placeholder="https://easydrop.one/prom-export?key=…" disabled={busy}/></Field>
      <button className="button primary full" disabled={busy}>{working ? 'Додаємо…' : 'Додати постачальника EasyDrop'}<Icon name="plus" size={16}/></button>
    </form>
    <p className="form-note">Посилання перевіряє сервер. Нові товари залишаються чернетками до вашої публікації.</p>
  </section>;
}
