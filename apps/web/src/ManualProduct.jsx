import React, {useEffect, useRef, useState} from 'react';
import {Field, Icon, Notice, Photo} from './ui.jsx';
import {api} from './api.js';
import {useTaxonomy} from './TaxonomyContext.jsx';
import {serverMessage, buildProductBody, buildSourceBody, emptySizeRow, isManualSupplier, minorToHryvnia, MAX_PHOTOS, ONE_SIZE, photoFileError} from './manual-product.js';

// Manual products: suppliers without a CRM feed. Money stays in kopiyky; the form takes hryvnias and the
// server validates every price. Nothing here claims a sync: manual suppliers have none.

export function AddManualSupplierForm({busy, working, onAdd}) {
  const [name, setName] = useState('');
  return <section className="panel add-supplier add-manual-supplier">
    <div className="panel-title"><h2>Новий ручний постачальник</h2><Icon name="plus"/></div>
    <form onSubmit={e => {e.preventDefault(); onAdd(name.trim()).then(() => setName(''), () => {});}}>
      <Field label="Назва" hint="Для товарів, яких немає в MyDrop чи EasyDrop. Синхронізації й імпорту немає."><input required maxLength={120} value={name} onChange={e => setName(e.target.value)} placeholder="Наприклад, Власний склад" disabled={busy}/></Field>
      <button className="button primary full" disabled={busy || !name.trim()}>{working ? 'Додаємо…' : 'Додати ручного постачальника'}<Icon name="plus" size={16}/></button>
    </form>
    <p className="form-note">Нові товари завжди створюються чернетками до вашої публікації.</p>
  </section>;
}

function uploadMessage(error) {
  if (error.code === 'storage-unavailable' || error.status === 503) return 'сховище фото недоступне';
  if (error.code === 'too-large' || error.status === 413) return 'файл завеликий (максимум 20 МБ)';
  if (error.code === 'not-image' || error.status === 415) return 'це не зображення JPEG, PNG чи WebP';
  return error.message;
}

function useModalFocus(ref, onClose, locked) {
  useEffect(() => {
    const previous = document.activeElement, before = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    const items = () => [...(ref.current?.querySelectorAll('button:not(:disabled), input:not(:disabled), textarea:not(:disabled), select:not(:disabled), a[href]') || [])].filter(el => el.getClientRects().length);
    (ref.current?.querySelector('[data-autofocus]') || items()[0])?.focus();
    return () => {document.body.style.overflow = before; if (previous?.isConnected) previous.focus();};
  }, []);
  const latest = useRef({onClose, locked});
  latest.current = {onClose, locked};
  // Escape works even when focus was lost (e.g. the focused submit button became disabled while saving).
  useEffect(() => {
    const escape = e => {if (e.key === 'Escape' && !latest.current.locked) {e.preventDefault(); latest.current.onClose();}};
    document.addEventListener('keydown', escape);
    return () => document.removeEventListener('keydown', escape);
  }, []);
  function keydown(e) {
    if (e.key !== 'Tab') return;
    const list = [...(ref.current?.querySelectorAll('button:not(:disabled), input:not(:disabled), textarea:not(:disabled), select:not(:disabled), a[href]') || [])].filter(el => el.getClientRects().length);
    const first = list[0], last = list.at(-1);
    if (!first) return;
    if (e.shiftKey && document.activeElement === first) {e.preventDefault(); last.focus();}
    else if (!e.shiftKey && document.activeElement === last) {e.preventDefault(); first.focus();}
  }
  return keydown;
}

export function SizeRows({rows, onChange, disabled, idPrefix}) {
  const set = (index, patch) => onChange(rows.map((row, i) => i === index ? {...row, ...patch} : row));
  return <div className="size-rows" role="group" aria-label="Розміри й наявність">
    {rows.map((row, i) => <div className="size-row" key={i}>
      <Field label={`Розмір ${i + 1}`}><input value={row.size} maxLength={40} onChange={e => set(i, {size: e.target.value})} disabled={disabled} placeholder="Наприклад, M або 42"/></Field>
      <Field label={`Кількість ${i + 1}`}><input inputMode="numeric" value={row.stock} onChange={e => set(i, {stock: e.target.value})} disabled={disabled} placeholder="0"/></Field>
      <button type="button" className="text-button danger-text" aria-label={`Прибрати рядок ${i + 1}`} disabled={disabled || rows.length < 2} onClick={() => onChange(rows.filter((_, j) => j !== i))}>Прибрати</button>
    </div>)}
    <div><button type="button" className="button small secondary" disabled={disabled} onClick={() => onChange([...rows, emptySizeRow()])}><Icon name="plus" size={14}/>Додати розмір</button></div>
  </div>;
}

export function AddProductDialog({suppliers, brands = [], canCreateSupplier, canUpload = true, onClose, onDone, onSupplierCreated}) {
  const taxonomy = useTaxonomy();
  const manual = suppliers.filter(s => isManualSupplier(s) && !s.deletedAt);
  const [local, setLocal] = useState([]);
  const options = [...manual, ...local.filter(s => !manual.some(m => m.id === s.id))];
  const [form, setForm] = useState({supplierId: manual.length === 1 ? manual[0].id : '', title: '', description: '', categoryId: '', brand: '', price: '', cost: '', sizes: [{size: ONE_SIZE, stock: ''}]});
  const [files, setFiles] = useState([]);
  const [errors, setErrors] = useState({}), [message, setMessage] = useState(''), [status, setStatus] = useState(''), [busy, setBusy] = useState(false);
  const [newSupplier, setNewSupplier] = useState(!manual.length && canCreateSupplier), [newName, setNewName] = useState(''), [supplierBusy, setSupplierBusy] = useState(false), [supplierError, setSupplierError] = useState('');
  // Resumable pipeline state: once the product exists it is never created again.
  const [created, setCreated] = useState(null), [uploaded, setUploaded] = useState({}), [failures, setFailures] = useState({}), [photoSaveError, setPhotoSaveError] = useState('');
  const baseRef = useRef([]), latest = useRef(null), mounted = useRef(true), dialog = useRef(null), urls = useRef(new Map());
  const inflight = useRef(false);
  const close = () => created ? onClose({created: true}) : onClose();
  const keydown = useModalFocus(dialog, close, busy || supplierBusy);
  useEffect(() => () => {mounted.current = false; urls.current.forEach(url => URL.revokeObjectURL(url));}, []);
  const set = (key, value) => setForm(x => ({...x, [key]: value}));
  const locked = !!created;

  function addFiles(list) {
    const problems = [], accepted = [];
    for (const file of [...list]) {
      const problem = photoFileError(file);
      if (problem) problems.push(problem); else accepted.push(file);
    }
    const room = MAX_PHOTOS - files.length;
    if (accepted.length > room) problems.push(`Можна додати не більше ${MAX_PHOTOS} фото.`);
    const next = accepted.slice(0, Math.max(0, room)).map((file, i) => {
      const id = `${Date.now()}-${files.length + i}-${Math.random().toString(36).slice(2, 7)}`;
      const preview = URL.createObjectURL(file); urls.current.set(id, preview);
      return {id, file, preview};
    });
    setFiles(current => [...current, ...next]);
    setErrors(e => ({...e, photos: problems.join(' ')}));
  }
  function removeFile(id) {
    URL.revokeObjectURL(urls.current.get(id)); urls.current.delete(id);
    setFiles(current => current.filter(f => f.id !== id));
    setFailures(f => {const {[id]: _gone, ...rest} = f; return rest;});
  }
  async function createSupplier() {
    const name = newName.trim();
    if (!name) {setSupplierError('Вкажіть назву постачальника.'); return;}
    setSupplierBusy(true); setSupplierError('');
    try {
      const supplier = await api('/api/admin/suppliers/manual', {method: 'POST', body: {name, enabled: true}});
      setLocal(list => [...list, supplier]); set('supplierId', supplier.id); setNewSupplier(false); setNewName('');
      onSupplierCreated?.(supplier);
    } catch (e) {setSupplierError(serverMessage(e.message));} finally {setSupplierBusy(false);}
  }
  async function run(e) {
    e?.preventDefault();
    if (busy || inflight.current) return;
    inflight.current = true;
    try {await pipeline();} finally {inflight.current = false;}
  }
  async function pipeline() {
    let product = created;
    if (!product) {
      const {body, errors: found} = buildProductBody(form);
      setErrors(found);
      if (Object.keys(found).length) {setMessage('Перевірте виділені поля.'); return;}
      setMessage(''); setBusy(true); setStatus('Створюємо товар…');
      try {
        product = await api('/api/admin/products', {method: 'POST', body});
        baseRef.current = product.source?.photos || product.photos || []; latest.current = product;
        setCreated(product);
      } catch (error) {setBusy(false); setStatus(''); setMessage(serverMessage(error.message)); return;}
    } else {setBusy(true); setMessage('');}
    const done = {...uploaded}, failed = {};
    let index = 0;
    for (const item of files) {
      index += 1;
      if (done[item.id]) continue;
      setStatus(`Завантажуємо фото ${index} з ${files.length}…`);
      try {
        const data = new FormData(); data.append('file', item.file);
        done[item.id] = (await api(`/api/admin/products/${encodeURIComponent(product.id)}/photos`, {method: 'POST', body: data})).url;
        if (mounted.current) setUploaded({...done});
      } catch (error) {failed[item.id] = uploadMessage(error);}
    }
    let saveError = '';
    const ordered = files.filter(f => done[f.id]).map(f => done[f.id]);
    if (ordered.length) {
      setStatus('Зберігаємо фото в товарі…');
      try {
        const updated = await api(`/api/admin/products/${encodeURIComponent(product.id)}/source`, {method: 'PATCH', body: {photos: [...baseRef.current, ...ordered]}});
        latest.current = updated; if (mounted.current) setCreated(updated);
      } catch (error) {saveError = serverMessage(error.message);}
    }
    if (!mounted.current) return;
    setBusy(false); setStatus(''); setFailures(failed); setPhotoSaveError(saveError);
    if (!Object.keys(failed).length && !saveError) onDone(latest.current || product, {photos: ordered.length});
    else setMessage('Товар створено як чернетку, але не все вдалося завершити. Повторіть спробу або відкрийте товар у редакторі.');
  }
  const pending = files.filter(f => !uploaded[f.id]).length;
  const retry = created && (pending > 0 || photoSaveError);
  const cannotSubmit = busy || supplierBusy || (!created && !options.length);
  return <div className="modal-backdrop"><section ref={dialog} tabIndex={-1} role="dialog" aria-modal="true" aria-labelledby="add-product-title" className="modal product-modal" onKeyDown={keydown}>
    <header className="modal-header"><div><p className="eyebrow">РУЧНИЙ ТОВАР</p><h2 id="add-product-title">Додати товар</h2></div><button type="button" className="icon-button" aria-label="Закрити додавання товару" disabled={busy || supplierBusy} onClick={close}><Icon name="close"/></button></header>
    <form onSubmit={run} noValidate>
      <div className="modal-body">
        {message && <Notice type={created ? 'info' : 'error'}>{message}</Notice>}
        {created && <Notice type="success">Товар «{created.title}» створено як чернетку. Його можна відкрити в редакторі та опублікувати окремо.</Notice>}
        {photoSaveError && <Notice>Фото завантажено, але не додано до товару: {photoSaveError}</Notice>}
        {status && <p role="status" className="field-help">{status}</p>}
        <fieldset disabled={locked || busy}>
          <div className="supplier-pick">
            {options.length > 0 && <Field label="Ручний постачальник">
              <select required value={form.supplierId} onChange={e => set('supplierId', e.target.value)} aria-invalid={!!errors.supplierId} data-autofocus>
                <option value="">Оберіть постачальника…</option>
                {options.map(s => <option key={s.id} value={s.id}>{s.name}{s.enabled === false ? ' (вимкнений)' : ''}</option>)}
              </select>
              {errors.supplierId && <span className="field-error" role="alert">{errors.supplierId}</span>}
            </Field>}
            {!options.length && <Notice type="info">{canCreateSupplier ? 'Ручних постачальників ще немає. Створіть першого нижче: товари мають належати постачальнику.' : 'Ручних постачальників ще немає, а створювати їх вам не дозволено. Попросіть менеджера чи власника додати його в розділі «Постачальники».'}</Notice>}
            {canCreateSupplier && !newSupplier && <div><button type="button" className="button small secondary" onClick={() => setNewSupplier(true)}><Icon name="plus" size={14}/>Новий ручний постачальник</button></div>}
            {canCreateSupplier && newSupplier && <div className="manual-form-row">
              <Field label="Назва нового постачальника"><input value={newName} maxLength={120} disabled={supplierBusy} onChange={e => setNewName(e.target.value)} onKeyDown={e => {if (e.key === 'Enter') {e.preventDefault(); createSupplier();}}} placeholder="Наприклад, Власний склад"/></Field>
              <button type="button" className="button small primary" disabled={supplierBusy || !newName.trim()} onClick={createSupplier}>{supplierBusy ? 'Створюємо…' : 'Створити й обрати'}</button>
              {options.length > 0 && <button type="button" className="text-button" disabled={supplierBusy} onClick={() => {setNewSupplier(false); setSupplierError('');}}>Скасувати</button>}
            </div>}
            {supplierError && <Notice>{supplierError}</Notice>}
          </div>
          <Field label="Назва"><input required maxLength={200} value={form.title} onChange={e => set('title', e.target.value)} aria-invalid={!!errors.title}/>{errors.title && <span className="field-error" role="alert">{errors.title}</span>}</Field>
          <Field label="Опис" hint="Звичайний текст."><textarea rows={4} value={form.description} onChange={e => set('description', e.target.value)}/></Field>
          <div className="field-row">
            <Field label="Категорія" hint="Без вибору категорію визначить система."><select value={form.categoryId} onChange={e => set('categoryId', e.target.value)}><option value="">Не вказувати</option>{taxonomy.options.map(node => <option key={node.id} value={node.id}>{node.path.join(' / ')}</option>)}</select></Field>
            <Field label="Бренд" hint="Необов’язково."><input list="add-product-brands" maxLength={100} value={form.brand} onChange={e => set('brand', e.target.value)}/><datalist id="add-product-brands">{brands.map(b => <option key={b} value={b}/>)}</datalist></Field>
          </div>
          <div className="field-row">
            <Field label="Ціна на сайті, ₴" hint="Попередня оцінка: остаточну ціну перевіряє сервер."><input inputMode="decimal" required value={form.price} onChange={e => set('price', e.target.value)} placeholder="1299 або 1299.50" aria-invalid={!!errors.price}/>{errors.price && <span className="field-error" role="alert">{errors.price}</span>}</Field>
            <Field label="Закупівля, ₴" hint="Необов’язково. Без значення дорівнює ціні."><input inputMode="decimal" value={form.cost} onChange={e => set('cost', e.target.value)} placeholder="800" aria-invalid={!!errors.cost}/>{errors.cost && <span className="field-error" role="alert">{errors.cost}</span>}</Field>
          </div>
          <div className="subsection-heading">Розміри й наявність</div>
          <SizeRows rows={form.sizes} onChange={rows => set('sizes', rows)} disabled={locked || busy}/>
          {errors.sizes && <p className="field-error" role="alert">{errors.sizes}</p>}
        </fieldset>
        <div className="subsection-heading">Фото</div>
        <Field label="Додати фото" hint={canUpload ? 'JPEG, PNG або WebP, до 20 МБ кожне. Завантажуються після створення товару.' : 'У вас немає дозволу завантажувати фото.'}><input type="file" multiple accept="image/jpeg,image/png,image/webp" disabled={busy || !canUpload} onChange={e => {addFiles(e.target.files); e.target.value = '';}}/></Field>
        {errors.photos && <p className="field-error" role="alert">{errors.photos}</p>}
        {files.length > 0 && <ul className="new-photo-grid" aria-label="Обрані фото">{files.map((item, i) => <li key={item.id}>
          <img src={item.preview} alt={`Попередній перегляд ${item.file.name}`}/>
          <span className="photo-state">{i === 0 ? 'Обкладинка · ' : ''}{item.file.name}{uploaded[item.id] ? <b className="photo-ok"> · завантажено</b> : failures[item.id] ? <b className="photo-fail"> · не завантажено: {failures[item.id]}</b> : null}</span>
          {!uploaded[item.id] && <button type="button" className="text-button danger-text" disabled={busy} aria-label={`Прибрати фото ${item.file.name}`} onClick={() => removeFile(item.id)}>Прибрати</button>}
        </li>)}</ul>}
      </div>
      <footer className="modal-footer">
        {created ? <button type="button" className="button secondary" disabled={busy} onClick={() => onDone(latest.current || created, {skipped: pending, incomplete: pending > 0 || !!photoSaveError})}>Відкрити товар у редакторі</button> : <button type="button" className="button secondary" disabled={busy || supplierBusy} onClick={onClose}>Скасувати</button>}
        <button className="button primary" disabled={cannotSubmit || (created && !retry)}>{busy ? 'Зберігаємо…' : retry ? `Повторити${pending ? ` (фото: ${pending})` : ''}` : 'Створити товар'}<Icon name="arrow" size={16}/></button>
      </footer>
    </form>
  </section></div>;
}

// Editable "Source (manual product)" section of the product editor. It saves through PATCH /source, separately from overrides.
export function ManualSourceSection({product, dirty, disabled, canUpload = true, onSaved}) {
  const source = product.source || {};
  const [form, setForm] = useState(() => ({title: source.title ?? product.title ?? '', description: source.description ?? product.description ?? '', cost: minorToHryvnia(source.costMinor ?? 0), sizes: (source.variants?.length ? source.variants : [{size: ONE_SIZE, stock: 0}]).map(v => ({size: v.size, stock: String(v.stock ?? 0)})), photos: [...(source.photos || [])]}));
  const [errors, setErrors] = useState({}), [error, setError] = useState(''), [busy, setBusy] = useState(false), [uploading, setUploading] = useState(false), [note, setNote] = useState('');
  const set = (key, value) => {setForm(x => ({...x, [key]: value})); setNote('');};
  const block = disabled || busy || uploading;
  async function save() {
    const {body, errors: found} = buildSourceBody(form);
    setErrors(found);
    if (Object.keys(found).length) {setError('Перевірте виділені поля.'); return;}
    setBusy(true); setError(''); setNote('');
    try {
      const updated = await api(`/api/admin/products/${encodeURIComponent(product.id)}/source`, {method: 'PATCH', body});
      await onSaved(updated);
    } catch (e) {setError(serverMessage(e.message));} finally {setBusy(false);}
  }
  async function upload(e) {
    const files = [...e.target.files]; e.target.value = '';
    if (!files.length) return;
    setError(''); setUploading(true);
    const added = []; const problems = [];
    for (const file of files) {
      const problem = photoFileError(file);
      if (problem) {problems.push(problem); continue;}
      if (form.photos.length + added.length >= MAX_PHOTOS) {problems.push(`Можна додати не більше ${MAX_PHOTOS} фото.`); break;}
      try {
        const data = new FormData(); data.append('file', file);
        added.push((await api(`/api/admin/products/${encodeURIComponent(product.id)}/photos`, {method: 'POST', body: data})).url);
      } catch (err) {problems.push(`«${file.name}»: ${uploadMessage(err)}`);}
    }
    if (added.length) {setForm(x => ({...x, photos: [...x.photos, ...added]})); setNote('Фото завантажено. Натисніть «Зберегти джерело», щоб додати їх до товару.');}
    setError(problems.join(' ')); setUploading(false);
  }
  const move = (i, d) => setForm(x => {const list = [...x.photos], j = i + d; if (j < 0 || j >= list.length) return x; [list[i], list[j]] = [list[j], list[i]]; return {...x, photos: list};});
  return <section className="source-section" aria-labelledby="source-title" onKeyDown={e => {if (e.key === 'Enter' && e.target.tagName === 'INPUT' && e.target.type !== 'file') e.preventDefault();}}>
    <h3 id="source-title">Джерело (ручний товар)</h3>
    <p className="field-help">Цей товар не має синхронізації: його дані джерела редагуєте ви. Ваша редакція на інших вкладках (назва, ціна, публікація) зберігається окремо.</p>
    {dirty && <Notice type="info">Є незбережені зміни на інших вкладках. Збережіть їх або скасуйте, перш ніж зберігати джерело: редактор оновиться після збереження.</Notice>}
    {error && <Notice>{error}</Notice>}{note && <Notice type="info">{note}</Notice>}
    <Field label="Назва в джерелі"><input value={form.title} maxLength={200} disabled={block} onChange={e => set('title', e.target.value)} aria-invalid={!!errors.title}/>{errors.title && <span className="field-error" role="alert">{errors.title}</span>}</Field>
    <Field label="Опис у джерелі"><textarea rows={4} value={form.description} disabled={block} onChange={e => set('description', e.target.value)}/></Field>
    <Field label="Закупівля, ₴" hint="Ціну на сайті порахує та перевірить сервер."><input inputMode="decimal" value={form.cost} disabled={block} onChange={e => set('cost', e.target.value)} aria-invalid={!!errors.cost}/>{errors.cost && <span className="field-error" role="alert">{errors.cost}</span>}</Field>
    <div className="subsection-heading">Розміри й наявність (джерело)</div>
    <SizeRows rows={form.sizes} onChange={rows => set('sizes', rows)} disabled={block}/>
    {errors.sizes && <p className="field-error" role="alert">{errors.sizes}</p>}
    <div className="subsection-heading">Фото джерела</div>
    <div className="photo-editor-grid">{form.photos.map((src, i) => <div className="photo-editor-item" key={`${src}-${i}`}><Photo src={src} title={`Фото джерела ${i + 1}`}/><div><span>{i === 0 ? 'Обкладинка' : `Фото ${i + 1}`}</span>
      <button type="button" className="icon-button" aria-label={`Пересунути фото джерела ${i + 1} раніше`} disabled={block || i === 0} onClick={() => move(i, -1)}>↑</button>
      <button type="button" className="icon-button" aria-label={`Пересунути фото джерела ${i + 1} пізніше`} disabled={block || i === form.photos.length - 1} onClick={() => move(i, 1)}>↓</button>
      <button type="button" className="icon-button" aria-label={`Прибрати фото джерела ${i + 1}`} disabled={block} onClick={() => set('photos', form.photos.filter((_, j) => j !== i))}>×</button></div></div>)}</div>
    <Field label={uploading ? 'Завантажуємо фото…' : 'Завантажити фото'} hint="JPEG, PNG або WebP до 20 МБ. Потрібне підключене сховище."><input type="file" multiple accept="image/jpeg,image/png,image/webp" disabled={block || !canUpload} onChange={upload}/></Field>
    <button type="button" className="button primary" disabled={block || dirty} onClick={save}>{busy ? 'Зберігаємо…' : 'Зберегти джерело'}</button>
  </section>;
}
