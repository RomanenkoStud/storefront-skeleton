import { useEffect, useId, useRef, useState } from 'react';
import { TAG_MAX_COUNT, addTags, tagKey, tagsInUse } from './product-tags.js';
import { Icon } from './ui.jsx';

export function TagChips({ tags }) {
  if (!tags?.length) return null;
  return <span className="internal-tags">{tags.map(tag => <span key={tag} className="internal-tag">{tag}</span>)}</span>;
}

/** Chip editor for internal tags. Enter or comma adds; suggestions come from tags already in use. */
export function TagEditor({ tags, onChange, suggestions = [], autoFocus = false, label = 'Внутрішні мітки', help = 'Бачать лише менеджери — покупцям мітки не показуються. Enter або кома додає мітку.' }) {
  const [draft, setDraft] = useState(''), [error, setError] = useState(''), listId = useId(), labelId = useId();
  function commit(value = draft) { const result = addTags(tags, value); setError(result.error); if (!result.error) { onChange(result.tags); setDraft(''); } }
  return <div className="field tag-editor">
    <span id={labelId}>{label}</span>
    <div className="tag-editor-box">
      {tags.map(tag => <span key={tag} className="internal-tag">{tag}<button type="button" aria-label={`Прибрати мітку ${tag}`} onClick={() => onChange(tags.filter(t => t !== tag))}>×</button></span>)}
      <input autoFocus={autoFocus} aria-labelledby={labelId} list={listId} value={draft} placeholder={tags.length ? 'Ще мітка…' : 'Напр.: потрібне нове фото'}
        onChange={e => { const value = e.target.value; if (value.includes(',')) commit(value); else { setDraft(value); setError(''); } }}
        onKeyDown={e => { if (e.key === 'Enter' && !e.nativeEvent.isComposing) { e.preventDefault(); commit(); } else if (e.key === 'Backspace' && !draft && tags.length) onChange(tags.slice(0, -1)); }}
        onBlur={() => draft.trim() && commit()} />
      <datalist id={listId}>{suggestions.filter(s => !tags.some(t => tagKey(t) === tagKey(s))).map(s => <option key={s} value={s} />)}</datalist>
    </div>
    {error ? <small className="field-error" role="alert">{error}</small> : <small>{help}</small>}
  </div>;
}

/** Add or remove internal tags on the selected products (POST /products/bulk-tags). */
export function BulkTagsDialog({ products, suggestions = [], onApply, onClose }) {
  const [mode, setMode] = useState('add'), [tags, setTags] = useState([]), [busy, setBusy] = useState(false), [error, setError] = useState('');
  const present = tagsInUse(products), pick = mode === 'add' ? suggestions : present, dialog = useRef(null);
  // Captured during the first render, before autoFocus moves focus into the dialog.
  const [previous] = useState(() => document.activeElement);
  useEffect(() => {
    const before = document.body.style.overflow; document.body.style.overflow = 'hidden';
    return () => {
      document.body.style.overflow = before;
      const target = previous?.isConnected ? previous : document.querySelector('[data-dialog-return]');
      target?.focus();
    };
  }, []);
  function keydown(e) {
    if (e.key === 'Escape' && !busy) { e.preventDefault(); onClose(); return; }
    if (e.key !== 'Tab') return;
    const list = [...dialog.current.querySelectorAll('button:not(:disabled),input:not(:disabled)')].filter(el => el.getClientRects().length), first = list[0], last = list.at(-1);
    if (!first) { e.preventDefault(); return; }
    if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
    else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
  }
  function switchMode(next) { if (next !== mode) { setMode(next); setTags([]); setError(''); } }
  async function apply() {
    if (!tags.length) { setError('Додайте хоча б одну мітку.'); return; }
    if (mode === 'add') {
      const over = products.find(p => { const have = new Set((p.tags ?? []).map(tagKey)); return have.size + tags.filter(t => !have.has(tagKey(t))).length > TAG_MAX_COUNT; });
      if (over) { setError(`«${over.title}» матиме більше ${TAG_MAX_COUNT} міток. Спершу приберіть зайві.`); return; }
    }
    setBusy(true); setError('');
    try { await onApply(mode === 'add' ? { add: tags } : { remove: tags }); onClose(); } catch (e) { setError(e.message); } finally { setBusy(false); }
  }
  return <div className="modal-backdrop"><section role="dialog" aria-modal="true" aria-labelledby="bulk-tags-title" ref={dialog} className="modal confirm-modal bulk-tags-modal" onKeyDown={keydown}>
    <header className="modal-header"><h2 id="bulk-tags-title">Мітки для обраних товарів ({products.length})</h2><button className="icon-button" aria-label="Закрити мітки" disabled={busy} onClick={onClose}><Icon name="close"/></button></header>
    <div className="modal-body">
      <div className="bulk-tags-mode" role="radiogroup" aria-label="Дія з мітками">
        <label><input type="radio" name="bulk-tags-mode" checked={mode === 'add'} onChange={() => switchMode('add')} /> Додати</label>
        <label><input type="radio" name="bulk-tags-mode" checked={mode === 'remove'} onChange={() => switchMode('remove')} /> Прибрати</label>
      </div>
      <TagEditor autoFocus label={mode === 'add' ? 'Мітки, які додати' : 'Мітки, які прибрати'} help={mode === 'add' ? 'Enter або кома додає мітку до списку. Покупці мітки не бачать.' : 'Enter або кома додає мітку до списку для видалення; або оберіть нижче.'} tags={tags} onChange={next => { setTags(next); setError(''); }} suggestions={pick} />
      {mode === 'remove' && present.length > 0 && <div className="internal-tags" aria-label="Мітки обраних товарів">{present.filter(t => !tags.some(x => tagKey(x) === tagKey(t))).map(tag => <button key={tag} type="button" className="internal-tag" onClick={() => setTags(addTags(tags, tag).tags)}>+ {tag}</button>)}</div>}
      {error && <p className="field-error" role="alert">{error}</p>}
    </div>
    <footer className="modal-footer"><button className="button secondary" disabled={busy} onClick={onClose}>Скасувати</button><button className={`button ${mode === 'add' ? 'primary' : 'danger'}`} disabled={busy || !tags.length} onClick={apply}>{busy ? 'Зберігаємо…' : mode === 'add' ? `Додати до ${products.length}` : `Прибрати з ${products.length}`}</button></footer>
  </section></div>;
}
