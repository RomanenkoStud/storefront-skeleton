// admin "Вітрина" tool. Configures the landing campaign band (auto / fixed category / off,
// plus categories excluded from the automatic pick). Saving needs settings.manage (owner); others see it read-only.
import React, { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { api, date, money } from './api.js';
import { Notice } from './ui.jsx';
import { useTaxonomy } from './TaxonomyContext.jsx';
import { usePermission } from './StaffPermissions.jsx';
import RAIL from './rail-media.json';
import { pickCampaign, campaignArt, resolveScene } from './landing/campaign.js';
import { CampaignBandView } from './landing/CampaignBand.jsx';
import { SCENES } from '../../../packages/catalog/campaign-scenes.js';
import ConfirmDialog from './ConfirmDialog.jsx';
import { createBatchProcessor, supportedBrowser } from './background-removal.js';
import { cutoutProgressLabel } from './cutout-photo.js';
import { preparePicture, uploadPicture, libraryFromRows, groupRows, pictureOptions, legacyOptions, dropQueued, railFallbacks, reorderIds, MAX_PER_CATEGORY } from './campaign-pictures.js';
import { parsePrepaymentInput } from './cart/prepayment-input.js';
import { minorToInput } from './price-override.js';
import BannerSettings from './BannerSettings.jsx';
import StorefrontImages from './StorefrontImages.jsx';

const MODES = [
  ['auto', 'Автоматично', 'Категорія з найбільшою кількістю речей у наявності. Можна виключити несезонні категорії.'],
  ['category', 'Обрана категорія', 'Завжди показувати одну категорію, поки в ній є речі в наявності. Інакше — автоматичний вибір.'],
  ['off', 'Не показувати', 'Блок промо на головній сторінці приховано.'],
];

const MAX_ITEMS = 8, MAX_LENGTH = 40;

function TickerSettings({ initial, meta: initialMeta, editable }) {
  const [form, setForm] = useState({ enabled: initial?.enabled !== false, items: initial?.items?.length ? initial.items : [''] });
  const [meta, setMeta] = useState(initialMeta), [busy, setBusy] = useState(false), [error, setError] = useState(''), [saved, setSaved] = useState('');
  const update = patch => { setForm({ ...form, ...patch }); setSaved(''); };
  const setItem = (i, value) => update({ items: form.items.map((x, j) => (j === i ? value : x)) });
  const move = (i, d) => { const items = [...form.items]; [items[i], items[i + d]] = [items[i + d], items[i]]; update({ items }); };
  async function save(event) {
    event.preventDefault(); setBusy(true); setError('');
    try {
      const d = await api('/api/admin/storefront/ticker', { method: 'PUT', body: { enabled: form.enabled, items: form.items.map(x => x.trim()).filter(Boolean) } });
      setForm({ enabled: d.ticker.enabled, items: d.ticker.items.length ? d.ticker.items : [''] }); setMeta({ updatedAt: d.tickerUpdatedAt, actor: d.tickerActor });
      setSaved('Збережено. Головна сторінка покаже зміни після оновлення.');
    } catch (e) { setError(e.message); } finally { setBusy(false); }
  }
  const preview = form.items.map(x => x.trim()).filter(Boolean);
  return <section className="panel storefront-settings" aria-labelledby="ticker-settings-title">
    <h2 id="ticker-settings-title">Біжучий рядок</h2>
    <p className="section-subtitle">Лаймова смуга під першим екраном. До {MAX_ITEMS} фраз, кожна до {MAX_LENGTH} символів.{meta?.updatedAt ? ` Змінено ${date(meta.updatedAt)}${meta.actor ? ` · ${meta.actor}` : ''}.` : ''}</p>
    {error && <Notice onClose={() => setError('')}>{error}</Notice>}
    {saved && <Notice type="info" onClose={() => setSaved('')}>{saved}</Notice>}
    <form onSubmit={save}><fieldset disabled={!editable || busy}>
      <label className="storefront-mode"><input type="checkbox" checked={form.enabled} onChange={e => update({ enabled: e.target.checked })}/><span><strong>Показувати біжучий рядок</strong></span></label>
      {form.enabled && <ol className="ticker-items">{form.items.map((item, i) => <li key={i}>
        <input aria-label={`Фраза ${i + 1}`} value={item} maxLength={MAX_LENGTH} onChange={e => setItem(i, e.target.value)} placeholder="Наприклад: НОВІ НАДХОДЖЕННЯ"/>
        <button type="button" className="text-button" aria-label={`Фраза ${i + 1} вище`} disabled={i === 0} onClick={() => move(i, -1)}>↑</button>
        <button type="button" className="text-button" aria-label={`Фраза ${i + 1} нижче`} disabled={i === form.items.length - 1} onClick={() => move(i, 1)}>↓</button>
        <button type="button" className="text-button" aria-label={`Видалити фразу ${i + 1}`} disabled={form.items.length === 1} onClick={() => update({ items: form.items.filter((_, j) => j !== i) })}>Видалити</button>
      </li>)}</ol>}
      {form.enabled && form.items.length < MAX_ITEMS && <button type="button" className="button secondary" onClick={() => update({ items: [...form.items, ''] })}>Додати фразу</button>}
      <p className="storefront-preview" aria-live="polite"><strong>Зараз на головній:</strong> {form.enabled ? (preview.length ? preview.join('  ✳  ') : 'додайте хоча б одну фразу') : 'рядок приховано'}</p>
      {editable && <button className="button primary" type="submit">{busy ? 'Зберігаємо…' : 'Зберегти'}</button>}
    </fieldset></form>
  </section>;
}


// A frame of fixed design width scaled down to the panel (ResizeObserver + transform). The inner frame is a real
// CampaignBandView under a .storefront wrapper, so container queries see the design width (1440 or 390).
function ScaledFrame({ width, label, children }) {
  const outer = useRef(null), inner = useRef(null), [box, setBox] = useState({ scale: 1, height: 0 });
  useLayoutEffect(() => {
    const measure = () => {
      const available = outer.current?.clientWidth || width, scale = Math.min(1, available / width);
      setBox(prev => { const height = Math.round((inner.current?.offsetHeight || 0) * scale); return prev.scale === scale && prev.height === height ? prev : { scale, height }; });
    };
    measure();
    if (typeof ResizeObserver === 'undefined') return undefined;
    const observer = new ResizeObserver(measure);
    observer.observe(outer.current); observer.observe(inner.current);
    return () => observer.disconnect();
  }, [width]);
  return <figure className="scene-preview-frame" data-width={width}>
    <figcaption>{label} · {width}</figcaption>
    <div className="scene-preview-outer" ref={outer} style={{ height: box.height || undefined }}>
      <div className="storefront scene-preview-inner" ref={inner} inert style={{ width, transform: `scale(${box.scale})` }}>{children}</div>
    </div>
  </figure>;
}

function ScenePreview({ campaign, sceneId, pictures, note }) {
  return <div className="scene-preview" role="region" aria-label="Попередній перегляд промо">
    {note && <p className="scene-preview-note" role="status">{note}</p>}
    {campaign ? <div className="scene-preview-grid">
      <ScaledFrame width={1440} label="Комп'ютер"><CampaignBandView campaign={campaign} scene={sceneId} pictures={pictures} preview/></ScaledFrame>
      <ScaledFrame width={390} label="Телефон"><CampaignBandView campaign={campaign} scene={sceneId} pictures={pictures} preview/></ScaledFrame>
    </div> : <p className="scene-preview-empty">Нічого показати: оберіть категорію з картинками та речами в наявності.</p>}
  </div>;
}

const Checker = ({ src, w, h, alt = '' }) => <span className="picture-checker"><img src={src} width={w} height={h} alt={alt} decoding="async"/></span>;

// Picture library of one leaf category. Every action is one API call and is saved at once (no "Зберегти" button).
function PictureLibrary({ rows, setRows, options, legacy, editable, pending, setPending, categoryId, setCategoryId }) {
  const taxonomy = useTaxonomy();
  const [busy, setBusy] = useState(false), [error, setError] = useState(''), [notice, setNotice] = useState(''), [confirm, setConfirm] = useState(null);
  const [removeBackground, setRemoveBackground] = useState(true), [work, setWork] = useState(null), fileInput = useRef(null), abort = useRef(null);
  const { live, deleted } = useMemo(() => groupRows(rows, taxonomy), [rows, taxonomy]);
  const own = live[categoryId] || [];
  const category = options.find(o => o.id === categoryId) || legacy.find(o => o.id === categoryId);
  const isLegacy = legacy.some(o => o.id === categoryId), canAdd = editable && !isLegacy;
  const focusAfter = useRef(null);
  useEffect(() => { const f = focusAfter.current; if (!f) return; focusAfter.current = null; const li = document.querySelector(`[data-picture-id="${f.id}"]`); const b = li?.querySelector(`[data-move=${f.dir}]`); (b && !b.disabled ? b : li?.querySelector('[data-move]:not(:disabled)'))?.focus(); }, [rows]);
  const fallbacks = useMemo(() => railFallbacks(RAIL.clothes, categoryId, own), [categoryId, own]);
  const mine = pending.filter(p => p.categoryId === categoryId);
  const full = own.length + mine.filter(p => p.status === 'ready').length >= MAX_PER_CATEGORY;
  useEffect(() => () => abort.current?.abort(), []);
  const replaceCategory = (id, list) => setRows(prev => [...prev.filter(r => r.categoryId !== id), ...list]);
  async function act(fn, done) { setBusy(true); setError(''); setNotice(''); try { await fn(); setNotice(done); } catch (e) { setError(e.message); } finally { setBusy(false); } }
  const move = (i, d) => { const ids = reorderIds(own.map(r => r.id), i, d); if (ids) { focusAfter.current = { id: own[i].id, dir: d < 0 ? 'up' : 'down' }; act(async () => { const r = await api('/api/admin/storefront/pictures/order', { method: 'PUT', body: { categoryId, ids } }); replaceCategory(categoryId, r.pictures); }, 'Порядок збережено одразу.'); } };
  const remove = async row => { setError(''); setNotice(''); const r = await api(`/api/admin/storefront/pictures/${encodeURIComponent(row.id)}`, { method: 'DELETE' }); setRows(prev => prev.filter(x => x.id !== r.deleted).map(x => (x.categoryId === row.categoryId && x.position > row.position ? { ...x, position: x.position - 1 } : x))); setNotice('Картинку видалено одразу.'); };
  async function choose(event) {
    const files = [...event.target.files]; event.target.value = '';
    if (!files.length) return;
    const room = Math.max(0, MAX_PER_CATEGORY - own.length - mine.filter(p => p.status === 'ready').length), batch = files.slice(0, room);
    setError(files.length > batch.length ? `У категорії може бути не більше ${MAX_PER_CATEGORY} картинок: взято ${batch.length} із ${files.length}.` : ''); setNotice('');
    const controller = new AbortController(); abort.current = controller;
    const processor = removeBackground ? createBatchProcessor() : null;
    const items = batch.map((file, i) => ({ key: `${Date.now()}-${i}`, categoryId, name: file.name, status: 'queued', file }));
    setPending(prev => [...prev, ...items]);
    const patch = (key, change) => setPending(prev => prev.map(p => (p.key === key ? { ...p, ...change } : p)));
    try {
      for (const item of items) {
        if (controller.signal.aborted) break;
        patch(item.key, { status: 'working' });
        setWork({ name: item.name, label: removeBackground ? 'Готуємо…' : 'Обробляємо…' });
        try {
          const out = await preparePicture(item.file, { removeBackground, process: processor?.process, retryCpu: processor?.retryCpu, signal: controller.signal, onProgress: p => setWork({ name: item.name, label: cutoutProgressLabel(p), value: p.key.startsWith('fetch:') && p.total ? p.current / p.total : undefined }) });
          patch(item.key, { status: 'ready', file: undefined, blob: out.blob, width: out.width, height: out.height, url: URL.createObjectURL(out.blob) });
        } catch (e) { patch(item.key, { status: 'error', file: undefined, message: e.name === 'AbortError' ? 'Скасовано' : e.message }); }
      }
    } finally { processor?.close(); setWork(null); abort.current = null; setPending(prev => dropQueued(prev, items.map(i => i.key))); }
  }
  const discard = key => setPending(prev => { const gone = prev.find(p => p.key === key); if (gone?.url) URL.revokeObjectURL(gone.url); return prev.filter(p => p.key !== key); });
  const savePending = item => act(async () => {
    const picture = await uploadPicture(api, item.categoryId, item.blob, 'picture');
    setRows(prev => [...prev, picture]); discard(item.key);
  }, 'Картинку збережено одразу: вона вже на сайті.');
  const working = pending.some(p => p.status === 'queued' || p.status === 'working');
  const unsupported = removeBackground && !supportedBrowser();
  return <section className="panel storefront-settings picture-library" aria-labelledby="picture-library-title">
    <h2 id="picture-library-title">Картинки категорії{category ? ` «${category.label}»` : ''}</h2>
    <p className="section-subtitle">Лише категорії без підкатегорій. До {MAX_PER_CATEGORY} картинок, перша — головна. <strong>Дії з картинками зберігаються одразу</strong>, кнопка «Зберегти» для них не потрібна.</p>
    {error && <Notice onClose={() => setError('')}>{error}</Notice>}
    {notice && <Notice type="info" onClose={() => setNotice('')}>{notice}</Notice>}
    <label className="field picture-category"><span>Категорія</span>
      <select data-dialog-return value={categoryId} onChange={e => setCategoryId(e.target.value)}>{options.map(o => <option key={o.id} value={o.id}>{o.label} · {o.count}</option>)}
        {legacy.length > 0 && <optgroup label="Категорії з підкатегоріями (нові не додаються)">{legacy.map(o => <option key={o.id} value={o.id}>{o.label} · {o.count}</option>)}</optgroup>}</select></label>
    {isLegacy && <p className="section-subtitle">У цієї категорії з’явилися підкатегорії: наявні картинки лишаються в роботі, їх можна впорядкувати або видалити, але нові додавати не можна.</p>}
    <ul className="picture-grid" aria-label="Картинки категорії">
      {own.map((row, i) => <li key={row.id} className="picture-tile" data-source="library" data-picture-id={row.id}>
        <Checker src={row.src} w={row.w} h={row.h}/>
        <span className="picture-tile-label">{i + 1}{i === 0 ? ' · головна' : ''}</span>
        {editable && <span className="picture-tile-actions">
          <button type="button" className="text-button" data-move="up" aria-label={`Картинка ${i + 1} вище`} disabled={busy || i === 0} onClick={() => move(i, -1)}>↑</button>
          <button type="button" className="text-button" data-move="down" aria-label={`Картинка ${i + 1} нижче`} disabled={busy || i === own.length - 1} onClick={() => move(i, 1)}>↓</button>
          <button type="button" className="text-button" aria-label={`Видалити картинку ${i + 1}`} disabled={busy} onClick={() => setConfirm({ row, title: `Картинка ${i + 1}` })}>Видалити</button>
        </span>}
      </li>)}
      {fallbacks.map((p, i) => <li key={p.src} className="picture-tile is-fallback" data-source="rail">
        <Checker src={p.src} w={p.w} h={p.h}/>
        <span className="picture-tile-label">{own.length + i + 1} · стандартна</span>
      </li>)}
      {canAdd && <li className="picture-tile picture-add"><button type="button" disabled={busy || working || full || !categoryId} onClick={() => fileInput.current?.click()}>{full ? `Ліміт ${MAX_PER_CATEGORY}` : '+ Додати'}</button></li>}
    </ul>
    {!own.length && <p className="section-subtitle">У цій категорії ще немає ваших картинок: на головній використовуються стандартні (сірі).</p>}
    {canAdd && <div className="picture-upload">
      <label className="storefront-mode"><input type="checkbox" checked={removeBackground} disabled={working} onChange={e => setRemoveBackground(e.target.checked)}/><span><strong>Прибрати фон</strong><small>У браузері, без завантаження оригіналу. Вимкніть, якщо файл уже з прозорим фоном (PNG або WebP).</small></span></label>
      {unsupported && <Notice type="info">Для прибирання фону потрібен сучасний Chrome, Edge або Firefox через HTTPS. Вимкніть «Прибрати фон» і завантажте PNG або WebP з прозорістю.</Notice>}
      <input ref={fileInput} className="picture-file" type="file" multiple accept="image/png,image/jpeg,image/webp" onChange={choose} aria-label="Файли картинок" tabIndex={-1}/>
      {work && <div className="picture-progress" role="status"><span>{work.name}: {work.label}</span>{work.value !== undefined && <progress value={work.value} max="1"/>}<button type="button" className="text-button" onClick={() => abort.current?.abort()}>Скасувати обробку</button></div>}
      <ul className="picture-pending">{mine.map(item => <li key={item.key} className="picture-tile" data-status={item.status}>
        {item.status === 'ready' ? <Checker src={item.url} w={item.width} h={item.height}/> : <span className="picture-checker picture-wait">{item.status === 'error' ? '!' : '…'}</span>}
        <span className="picture-tile-label">{item.name}</span>
        {item.status === 'error' && <span className="inline-error picture-tile-error" role="alert">{item.message}</span>}
        <span className="picture-tile-actions">
          {item.status === 'ready' && <button type="button" className="button primary" disabled={busy} onClick={() => savePending(item)}>Зберегти картинку</button>}
          {item.status !== 'working' && <button type="button" className="button secondary" disabled={busy} onClick={() => discard(item.key)}>Скасувати</button>}
        </span>
      </li>)}</ul>
    </div>}
    {deleted.length > 0 && <div className="picture-deleted"><h3>Видалена категорія</h3>
      <p className="section-subtitle">Ці картинки належать категоріям, яких уже немає, і не показуються на сайті.</p>
      <ul className="picture-grid">{deleted.map(row => <li key={row.id} className="picture-tile" data-source="deleted"><Checker src={row.src} w={row.w} h={row.h}/>
        <span className="picture-tile-label">{row.categoryId}</span>
        {editable && <span className="picture-tile-actions"><button type="button" className="text-button" aria-label={`Видалити картинку категорії ${row.categoryId}`} disabled={busy} onClick={() => setConfirm({ row, title: `Картинка видаленої категорії (${row.categoryId})` })}>Видалити</button></span>}</li>)}</ul></div>}
    {confirm && <ConfirmDialog title="Видалити картинку?" confirmLabel="Видалити" danger onClose={() => setConfirm(null)} onConfirm={() => remove(confirm.row)}>
      <p>{confirm.title} буде видалена одразу й назавжди. Кешований браузером файл може ще до години бути видимим.</p></ConfirmDialog>}
  </section>;
}

// «Передоплата» shown on the first checkout step. Integer kopecks on the wire; 0 hides the line.
function PrepaymentSettings({ initial, meta: initialMeta, editable }) {
  const [text, setText] = useState(minorToInput(initial?.prepaymentMinor ?? 0)), [meta, setMeta] = useState(initialMeta);
  const [busy, setBusy] = useState(false), [error, setError] = useState(''), [saved, setSaved] = useState('');
  const parsed = parsePrepaymentInput(text);
  async function save(event) {
    event.preventDefault();
    if (!parsed.ok) { setError(parsed.error); return; }
    setBusy(true); setError('');
    try {
      const d = await api('/api/admin/storefront/checkout', { method: 'PUT', body: { prepaymentMinor: parsed.minor } });
      setText(minorToInput(d.checkout.prepaymentMinor)); setMeta({ updatedAt: d.checkoutUpdatedAt, actor: d.checkoutActor });
      setSaved('Збережено. Кошик покаже зміни після оновлення сторінки.');
    } catch (e) { setError(e.message); } finally { setBusy(false); }
  }
  return <section className="panel storefront-settings" aria-labelledby="prepayment-settings-title">
    <h2 id="prepayment-settings-title">Передоплата</h2>
    <p className="section-subtitle">Сума, яку клієнт бачить у кошику як передоплату. 0 або порожнє поле — рядок приховано.{meta?.updatedAt ? ` Змінено ${date(meta.updatedAt)}${meta.actor ? ` · ${meta.actor}` : ''}.` : ''}</p>
    {error && <Notice onClose={() => setError('')}>{error}</Notice>}
    {saved && <Notice type="info" onClose={() => setSaved('')}>{saved}</Notice>}
    <form onSubmit={save}><fieldset disabled={!editable || busy}>
      <label className="field"><span>Передоплата, ₴</span><input inputMode="decimal" value={text} onChange={e => { setText(e.target.value); setSaved(''); }} placeholder="0" aria-invalid={!parsed.ok}/></label>
      <p className="storefront-preview" aria-live="polite"><strong>Зараз у кошику:</strong> {parsed.ok ? (parsed.minor ? `Передоплата ${money(parsed.minor)}` : 'рядок приховано') : parsed.error}</p>
      {editable && <button className="button primary" type="submit">{busy ? 'Зберігаємо…' : 'Зберегти'}</button>}
    </fieldset></form>
  </section>;
}

export default function StorefrontSettings() {
  const taxonomy = useTaxonomy(), can = usePermission(), editable = can('settings.manage');
  const [form, setForm] = useState(null), [meta, setMeta] = useState({}), [products, setProducts] = useState(null), [ticker, setTicker] = useState(null), [checkout, setCheckout] = useState(null), [banner, setBanner] = useState(null), [images, setImages] = useState(null);
  const [rows, setRows] = useState([]), [pending, setPending] = useState([]), [pictureCategory, setPictureCategory] = useState(''), [showCategory, setShowCategory] = useState('');
  const [busy, setBusy] = useState(false), [error, setError] = useState(''), [saved, setSaved] = useState('');
  useEffect(() => {
    api('/api/admin/storefront').then(d => { setForm(d.campaign); setRows(d.pictures || []); setMeta({ updatedAt: d.updatedAt, actor: d.actor }); setTicker({ value: d.ticker, meta: { updatedAt: d.tickerUpdatedAt, actor: d.tickerActor } }); setCheckout({ value: d.checkout, meta: { updatedAt: d.checkoutUpdatedAt, actor: d.checkoutActor } }); setBanner({ value: d.banner, meta: { updatedAt: d.bannerUpdatedAt, actor: d.bannerActor } }); setImages(d.images || []); }).catch(e => setError(e.message));
    api('/api/products').then(d => setProducts(d.items || [])).catch(() => setProducts([]));
  }, []);
  useEffect(() => () => pendingRef.current.forEach(p => p.url && URL.revokeObjectURL(p.url)), []);
  const pendingRef = useRef(pending); pendingRef.current = pending;
  // Library pictures (existing categories only) + the rail cut-outs decide which categories are eligible, exactly as on the storefront.
  const library = useMemo(() => libraryFromRows(rows.filter(r => taxonomy.index?.has(r.categoryId))), [rows, taxonomy]);
  const art = useMemo(() => campaignArt(RAIL.clothes, library), [library]);
  const label = id => taxonomy.getCategory?.(id)?.label || id;
  const options = useMemo(() => art.map(a => ({ id: a.categoryId, label: label(a.categoryId) })).sort((a, b) => a.label.localeCompare(b.label, 'uk')), [art, taxonomy]);
  const picOptions = useMemo(() => pictureOptions(taxonomy, rows), [taxonomy, rows]);
  const legacy = useMemo(() => legacyOptions(taxonomy, rows), [taxonomy, rows]);
  const activePictureCategory = picOptions.concat(legacy).some(o => o.id === pictureCategory) ? pictureCategory : (picOptions.find(o => o.count)?.id || picOptions[0]?.id || '');
  const sceneId = form ? resolveScene(form.sceneId).id : 'fan';
  // Live preview = the unsaved form. A pending (not yet saved) picture is shown first in its own category.
  const ready = pending.find(p => p.status === 'ready' && p.categoryId === activePictureCategory);
  const auto = useMemo(() => (form && products ? pickCampaign(products, taxonomy, art, form) : null), [form, products, taxonomy, art]);
  const previewId = ready ? ready.categoryId : showCategory;
  const shown = useMemo(() => {
    if (!form || products === null) return { campaign: null, note: '' };
    if (!previewId) return { campaign: form.mode === 'off' ? null : auto, note: form.mode === 'off' ? 'Блок приховано: перегляд показує, як виглядатиме промо, коли його ввімкнуть. Оберіть категорію нижче.' : '' };
    const entry = art.find(a => a.categoryId === previewId), pictures = ready ? [{ src: ready.url, w: ready.width, h: ready.height }, ...(entry?.pictures || [])] : entry?.pictures || [];
    const picked = pickCampaign(products, taxonomy, art, { mode: 'category', categoryId: previewId, excluded: [] });
    const base = picked?.categoryId === previewId ? picked : { categoryId: previewId, label: label(previewId), count: 0, brands: [], minPriceMinor: null };
    return { campaign: { ...base, images: pictures }, pictures, note: ready ? 'Показано нову картинку (ще не збережену).' : picked?.categoryId === previewId ? '' : 'У цій категорії немає речей у наявності: на головній вона не з’явиться, показано лише вигляд картинок.' };
  }, [form, products, previewId, ready, art, auto, taxonomy]);
  if (!form) return error ? <Notice onClose={() => setError('')}>{error}</Notice> : <p className="loading">Завантаження…</p>;
  const update = patch => { setForm({ ...form, ...patch }); setSaved(''); };
  const toggle = id => update({ excluded: form.excluded.includes(id) ? form.excluded.filter(x => x !== id) : [...form.excluded, id] });
  async function save(event) {
    event.preventDefault(); setBusy(true); setError('');
    try {
      const body = { mode: form.mode, excluded: form.excluded, sceneId, ...(form.mode === 'category' ? { categoryId: form.categoryId } : {}) };
      const d = await api('/api/admin/storefront/campaign', { method: 'PUT', body });
      setForm(d.campaign); setMeta({ updatedAt: d.updatedAt, actor: d.actor }); setSaved('Збережено. Головна сторінка покаже зміни після оновлення.');
    } catch (e) { setError(e.message); } finally { setBusy(false); }
  }
  const pinned = form.categoryId && !options.some(o => o.id === form.categoryId) ? [{ id: form.categoryId, label: `${label(form.categoryId)} (немає картинок)` }] : [];
  return <><section className="panel storefront-settings" aria-labelledby="storefront-settings-title">
    <h2 id="storefront-settings-title">Промо на головній</h2>
    <p className="section-subtitle">Зелений блок «Дроп … в наявності» між вішаком і каталогом. Сцена, режим і категорія зберігаються кнопкою «Зберегти»; перегляд показує й незбережені зміни.{meta.updatedAt ? ` Змінено ${date(meta.updatedAt)}${meta.actor ? ` · ${meta.actor}` : ''}.` : ''}</p>
    {!editable && <Notice type="info">Змінювати налаштування вітрини може лише власник.</Notice>}
    {error && <Notice onClose={() => setError('')}>{error}</Notice>}
    {saved && <Notice type="info" onClose={() => setSaved('')}>{saved}</Notice>}
    <form onSubmit={save}><fieldset disabled={!editable || busy}>
      <legend>Що показувати</legend>
      {MODES.map(([id, text, help]) => <label key={id} className="storefront-mode"><input type="radio" name="campaign-mode" value={id} checked={form.mode === id} onChange={() => update({ mode: id, categoryId: id === 'category' ? (form.categoryId || options[0]?.id || null) : form.categoryId })}/><span><strong>{text}</strong><small>{help}</small></span></label>)}
      {form.mode === 'category' && <label className="field"><span>Категорія</span><select value={form.categoryId || ''} onChange={e => update({ categoryId: e.target.value })}>{[...pinned, ...options].map(o => <option key={o.id} value={o.id}>{o.label}</option>)}</select></label>}
      {form.mode !== 'off' && <div className="storefront-excluded"><p><strong>Не пропонувати автоматично</strong> <small>(наприклад, шорти взимку)</small></p>
        <div className="storefront-excluded-list">{options.map(o => <label key={o.id}><input type="checkbox" checked={form.excluded.includes(o.id)} onChange={() => toggle(o.id)}/>{o.label}</label>)}</div></div>}
      <div role="radiogroup" aria-labelledby="scene-picker-title" className="scene-picker"><p id="scene-picker-title"><strong>Сцена</strong></p>
        <div className="scene-cards">{SCENES.map(scene => <label key={scene.id} className="scene-card" data-unavailable={scene.available === false ? 'true' : undefined}>
          <input type="radio" name="campaign-scene" value={scene.id} checked={sceneId === scene.id} disabled={scene.available === false} onChange={() => update({ sceneId: scene.id })}/>
          <strong>{scene.label}</strong>{scene.available === false && <small>потрібен фон</small>}</label>)}</div></div>
      <p className="storefront-preview" aria-live="polite"><strong>Зараз на головній:</strong> {products === null ? '…' : form.mode === 'off' ? 'блок приховано' : auto ? `${auto.label} · ${auto.count} в наявності` : 'немає підходящої категорії — блок приховано'}</p>
      {editable && <button className="button primary" type="submit">{busy ? 'Зберігаємо…' : 'Зберегти'}</button>}
    </fieldset></form>
    <div className="scene-preview-head"><h3>Перегляд</h3>
      <label className="field"><span>Показати категорію</span><select value={showCategory} onChange={e => setShowCategory(e.target.value)} disabled={!!ready}>
        <option value="">Як на головній</option>{options.map(o => <option key={o.id} value={o.id}>{o.label}</option>)}</select></label></div>
    {products === null ? <p className="loading">Завантаження…</p> : <ScenePreview campaign={shown.campaign} sceneId={sceneId} pictures={shown.pictures} note={shown.note}/>}
  </section>
  <PictureLibrary rows={rows} setRows={setRows} options={picOptions} legacy={legacy} editable={editable} pending={pending} setPending={setPending} categoryId={activePictureCategory} setCategoryId={setPictureCategory}/>
  {banner && <BannerSettings initial={banner.value} meta={banner.meta} editable={editable}/>}
  {images && <StorefrontImages initial={images} editable={editable}/>}
  {ticker && <TickerSettings initial={ticker.value} meta={ticker.meta} editable={editable}/>}
  {checkout && <PrepaymentSettings initial={checkout.value} meta={checkout.meta} editable={editable}/>}</>;
}
