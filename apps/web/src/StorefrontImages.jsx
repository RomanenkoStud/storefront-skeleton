// admin images for the landing rack (front / three-quarter / side per hanger, one shelf pair per shoe
// category) and for the category poster tiles in the product grid. Every action is one API call, saved at once.
// Without an own image a slot shows the shipped render ("стандартна").
import React, { useEffect, useMemo, useRef, useState } from 'react';
import { api, date } from './api.js';
import { Notice } from './ui.jsx';
import { useTaxonomy } from './TaxonomyContext.jsx';
import SHIPPED from './rail-media.json';
import ConfirmDialog from './ConfirmDialog.jsx';
import { createBatchProcessor, supportedBrowser } from './background-removal.js';
import { cutoutProgressLabel } from './cutout-photo.js';
import { preparePicture, leafCategories } from './campaign-pictures.js';
import { posterCutouts } from './landing/storefront-images.js';

const SLOT_LABELS = { front: 'Вішак: спереду', angle: 'Вішак: у три чверті', side: 'Вішак: збоку', shoe: 'Полиця: пара взуття', poster: 'Плитка категорії в каталозі' };
const SLOT_HELP = {
  front: 'Головний вигляд речі на вішаку.',
  angle: 'Річ, повернута приблизно на 45°. Без неї поворот іде одразу від вигляду спереду до вигляду збоку.',
  side: 'Річ збоку (вузька). Без неї річ повертається як картинка «спереду».',
  shoe: 'Пара на полиці під вішаком.',
  poster: 'Картинка на плитці «Від … ₴» між товарами. Без неї — картинка з вішака.',
};

const toRows = list => Object.fromEntries((list || []).map(r => [`${r.categoryId}:${r.slot}`, r]));
const asImages = rows => { const out = {}; for (const r of Object.values(rows)) if (r.known !== false) (out[r.categoryId] ||= {})[r.slot] = { src: r.src, w: r.w, h: r.h }; return out; };
const Checker = ({ src, w, h }) => <span className="picture-checker"><img src={src} width={w} height={h} alt="" decoding="async"/></span>;

export function slotsFor(categoryId) {
  if (SHIPPED.clothes.some(x => x.categoryId === categoryId)) return ['front', 'angle', 'side', 'poster'];
  if (SHIPPED.shoes.some(x => x.categoryId === categoryId)) return ['shoe', 'poster'];
  return ['poster'];
}

// The shipped render a slot falls back to (poster: whatever the tile shows without its own picture).
function fallbackFor(categoryId, slot, images) {
  if (slot === 'poster') return posterCutouts(SHIPPED, { ...images, [categoryId]: { ...images[categoryId], poster: undefined } })[categoryId] || null;
  if (slot === 'shoe') { const x = SHIPPED.shoes.find(s => s.categoryId === categoryId); return x ? { src: x.src, w: x.w, h: x.h } : null; }
  return SHIPPED.clothes.find(c => c.categoryId === categoryId)?.[slot] || null;
}

export default function StorefrontImages({ initial, editable }) {
  const taxonomy = useTaxonomy();
  const [rows, setRows] = useState(() => toRows(initial));
  const [categoryId, setCategoryId] = useState(SHIPPED.clothes[0]?.categoryId || '');
  const [pending, setPending] = useState(null), [work, setWork] = useState(null), [busy, setBusy] = useState(false);
  const [error, setError] = useState(''), [notice, setNotice] = useState(''), [confirm, setConfirm] = useState(null);
  const [removeBackground, setRemoveBackground] = useState(true);
  const fileInput = useRef(null), slotRef = useRef(null), abort = useRef(null);
  useEffect(() => () => { abort.current?.abort(); }, []);
  useEffect(() => () => { if (pending?.url) URL.revokeObjectURL(pending.url); }, [pending]);
  const label = id => taxonomy.getCategory?.(id)?.label || id;
  const groups = useMemo(() => {
    const rack = SHIPPED.clothes.map(x => x.categoryId).filter(id => taxonomy.getCategory?.(id));
    const shoes = SHIPPED.shoes.map(x => x.categoryId).filter(id => taxonomy.getCategory?.(id));
    const onRack = new Set([...rack, ...shoes]);
    const others = leafCategories(taxonomy).map(c => c.id).filter(id => !onRack.has(id) && id !== 'unclassified');
    const sort = ids => ids.map(id => ({ id, label: label(id) })).sort((a, b) => a.label.localeCompare(b.label, 'uk'));
    return [['Одяг на вішаку', sort(rack)], ['Взуття на полиці', sort(shoes)], ['Лише плитка в каталозі', sort(others)]];
  }, [taxonomy]);
  const images = useMemo(() => asImages(rows), [rows]);
  const own = Object.values(rows).filter(r => r.categoryId === categoryId);
  const slots = slotsFor(categoryId);

  function choose(slot) { slotRef.current = slot; setError(''); setNotice(''); fileInput.current?.click(); }
  async function picked(event) {
    const file = event.target.files?.[0]; event.target.value = '';
    const slot = slotRef.current;
    if (!file || !slot) return;
    const controller = new AbortController(); abort.current = controller;
    const processor = removeBackground ? createBatchProcessor() : null;
    setPending(null); setWork({ slot, label: removeBackground ? 'Готуємо…' : 'Обробляємо…' });
    try {
      const out = await preparePicture(file, { removeBackground, process: processor?.process, retryCpu: processor?.retryCpu, signal: controller.signal, onProgress: p => setWork({ slot, label: cutoutProgressLabel(p), value: p.key.startsWith('fetch:') && p.total ? p.current / p.total : undefined }) });
      setPending({ categoryId, slot, blob: out.blob, w: out.width, h: out.height, url: URL.createObjectURL(out.blob) });
    } catch (e) { if (e.name !== 'AbortError') setError(e.message); } finally { processor?.close(); setWork(null); abort.current = null; }
  }
  async function save() {
    const item = pending; setBusy(true); setError('');
    try {
      const form = new FormData();
      form.set('categoryId', item.categoryId); form.set('slot', item.slot);
      form.set('file', item.blob, `${item.slot}.${item.blob.type === 'image/png' ? 'png' : 'webp'}`);
      const { image } = await api('/api/admin/storefront/images', { method: 'PUT', body: form });
      setRows(prev => ({ ...prev, [`${image.categoryId}:${image.slot}`]: image })); setPending(null);
      setNotice('Картинку збережено одразу: вона вже на сайті.');
    } catch (e) { setError(e.message); } finally { setBusy(false); }
  }
  async function reset(row) {
    await api(`/api/admin/storefront/images/${encodeURIComponent(row.categoryId)}/${row.slot}`, { method: 'DELETE' });
    setRows(prev => { const next = { ...prev }; delete next[`${row.categoryId}:${row.slot}`]; return next; });
    setNotice('Повернено стандартну картинку.');
  }
  const unsupported = removeBackground && !supportedBrowser();

  return <section className="panel storefront-settings picture-library storefront-images" aria-labelledby="storefront-images-title">
    <h2 id="storefront-images-title">Картинки вішака й плиток категорій</h2>
    <p className="section-subtitle">Вішак з категоріями під першим екраном і плитки категорій між товарами. Потрібен прозорий фон (PNG або WebP). <strong>Зміни зберігаються одразу</strong>; без своєї картинки показується стандартна.</p>
    {error && <Notice onClose={() => setError('')}>{error}</Notice>}
    {notice && <Notice type="info" onClose={() => setNotice('')}>{notice}</Notice>}
    <label className="field picture-category"><span>Категорія</span>
      <select value={categoryId} onChange={e => { setCategoryId(e.target.value); setPending(null); }} disabled={!!work}>
        {groups.map(([title, list]) => list.length > 0 && <optgroup key={title} label={title}>{list.map(o => <option key={o.id} value={o.id}>{o.label}{Object.values(rows).some(r => r.categoryId === o.id) ? ' · своя' : ''}</option>)}</optgroup>)}
      </select></label>
    <ul className="picture-grid storefront-image-slots" aria-label={`Картинки категорії «${label(categoryId)}»`}>
      {slots.map(slot => {
        const row = rows[`${categoryId}:${slot}`], fallback = fallbackFor(categoryId, slot, images), shown = row || fallback;
        const mine = pending?.categoryId === categoryId && pending.slot === slot ? pending : null;
        return <li key={slot} className={`picture-tile${row ? '' : ' is-fallback'}`} data-slot={slot} data-source={row ? 'own' : 'shipped'}>
          {mine ? <Checker src={mine.url} w={mine.w} h={mine.h}/> : shown ? <Checker src={shown.src} w={shown.w} h={shown.h}/> : <span className="picture-checker picture-wait">—</span>}
          <span className="picture-tile-label"><strong>{SLOT_LABELS[slot]}</strong> · {mine ? 'нова, ще не збережена' : row ? `своя${row.updatedAt ? `, ${date(row.updatedAt)}` : ''}` : fallback ? 'стандартна' : 'немає: плитка не показується'}</span>
          <small className="storefront-image-help">{SLOT_HELP[slot]}</small>
          {editable && <span className="picture-tile-actions">
            {mine ? <>
              <button type="button" className="button primary" disabled={busy} onClick={save}>Зберегти</button>
              <button type="button" className="button secondary" disabled={busy} onClick={() => setPending(null)}>Скасувати</button>
            </> : <>
              <button type="button" className="text-button" disabled={busy || !!work} onClick={() => choose(slot)}>{row ? 'Замінити' : 'Завантажити свою'}</button>
              {row && <button type="button" className="text-button" disabled={busy || !!work} onClick={() => setConfirm(row)}>Повернути стандартну</button>}
            </>}
          </span>}
          {work?.slot === slot && <span className="picture-progress" role="status"><span>{work.label}</span>{work.value !== undefined && <progress value={work.value} max="1"/>}<button type="button" className="text-button" onClick={() => abort.current?.abort()}>Скасувати обробку</button></span>}
        </li>;
      })}
    </ul>
    {own.some(r => r.known === false) && <p className="section-subtitle">Деякі картинки належать категоріям, яких уже немає, і не показуються.</p>}
    {editable && <div className="picture-upload">
      <label className="storefront-mode"><input type="checkbox" checked={removeBackground} disabled={!!work} onChange={e => setRemoveBackground(e.target.checked)}/><span><strong>Прибрати фон</strong><small>У браузері, без завантаження оригіналу. Вимкніть, якщо файл уже з прозорим фоном (PNG або WebP).</small></span></label>
      {unsupported && <Notice type="info">Для прибирання фону потрібен сучасний Chrome, Edge або Firefox через HTTPS. Вимкніть «Прибрати фон» і завантажте PNG або WebP з прозорістю.</Notice>}
      <input ref={fileInput} className="picture-file" type="file" accept="image/png,image/jpeg,image/webp" onChange={picked} aria-label="Файл картинки" tabIndex={-1}/>
    </div>}
    {confirm && <ConfirmDialog title="Повернути стандартну картинку?" confirmLabel="Повернути" danger onClose={() => setConfirm(null)} onConfirm={() => reset(confirm)}>
      <p>{SLOT_LABELS[confirm.slot]} для «{label(confirm.categoryId)}»: ваша картинка буде видалена одразу. Кешований браузером файл може ще до години бути видимим.</p></ConfirmDialog>}
  </section>;
}
