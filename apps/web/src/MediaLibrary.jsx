import React, { useEffect, useMemo, useRef, useState } from 'react';
import { api, date } from './api.js';
import { Notice, Empty } from './ui.jsx';
import ConfirmDialog from './ConfirmDialog.jsx';
import { usePermission } from './StaffPermissions.jsx';
import { filters, filterItems, filterCounts, paginate, buildSelection, selectableKeys, chunkSelection, summarizeCleanup, cleanupMessage, formatBytes, shortKey, kindLabel, notMergeableLabel, orphanEligible, duplicateEligible, scanProgressText, PAGE_SIZE } from './media-library.js';

function MediaStat({ label, value, note }) {
  return <div className="stat"><span>{label}</span><strong>{value}</strong><small>{note}</small></div>;
}

export default function MediaLibrary() {
  const can = usePermission();
  const manage = can('media.manage');
  const [data, setData] = useState(null), [loading, setLoading] = useState(true), [error, setError] = useState('');
  const [filter, setFilter] = useState('all'), [page, setPage] = useState(0), [selected, setSelected] = useState([]);
  const [scan, setScan] = useState(null), [busy, setBusy] = useState(false), [confirming, setConfirming] = useState(false), [result, setResult] = useState(null);
  const cancelScan = useRef(false);
  const mounted = useRef(true);
  useEffect(() => () => { mounted.current = false; cancelScan.current = true; }, []);

  async function load() {
    setLoading(true); setError('');
    try {
      const next = await api('/api/admin/media');
      if (!mounted.current) return;
      setData(next);
      const keys = new Set((next.items || []).map(item => item.key));
      setSelected(current => current.filter(key => keys.has(key)));
    } catch (e) { if (mounted.current) setError(e.message); }
    finally { if (mounted.current) setLoading(false); }
  }
  useEffect(() => { load(); }, []);

  const items = data?.items || [];
  const counts = useMemo(() => filterCounts(items), [items]);
  const visible = useMemo(() => filterItems(items, filter), [items, filter]);
  const paged = paginate(visible, page);
  useEffect(() => { if (page !== paged.page) setPage(paged.page); }, [page, paged.page]);
  const selection = useMemo(() => buildSelection(items, selected), [items, selected]);
  const summary = data?.summary;

  function toggle(key) { setSelected(current => current.includes(key) ? current.filter(k => k !== key) : [...current, key]); }
  function selectAll(kind) { setSelected(current => [...new Set([...current, ...selectableKeys(items, kind)])]); }

  async function runScan() {
    cancelScan.current = false; setBusy(true); setError(''); setResult(null);
    let cursor = null, scanned = 0, added = 0;
    setScan({ scanned, added, running: true });
    try {
      for (;;) {
        const page = await api('/api/admin/media/scan', { method: 'POST', body: { cursor } });
        scanned += page.scanned || 0; added += page.added || 0; cursor = page.cursor ?? null;
        if (!mounted.current) return;
        setScan({ scanned, added, running: !page.done });
        if (page.done) break;
        if (cancelScan.current) { setScan({ scanned, added, running: false, cancelled: true }); break; }
      }
    } catch (e) { if (mounted.current) { setError(e.message); setScan(s => s && { ...s, running: false, failed: true }); } }
    if (!mounted.current) return;
    setBusy(false);
    await load();
  }

  async function runCleanup() {
    setError(''); setResult(null);
    const { orphans, duplicates } = selection;
    const results = [];
    try {
      for (const chunk of chunkSelection({ orphans, duplicates })) results.push(await api('/api/admin/media/cleanup', { method: 'POST', body: { confirm: true, ...chunk } }));
    } catch (e) {
      // Chunks already applied stay applied; report them truthfully before the error.
      if (results.length) setResult(summarizeCleanup(results));
      setError(`${e.message}${results.length ? ' Частину файлів уже оброблено, перевірте результат нижче.' : ''}`);
      setSelected([]);
      await load();
      throw e;
    }
    setResult(summarizeCleanup(results));
    setSelected([]);
    await load();
  }

  if (loading && !data) return <section className="panel media-library" aria-label="Медіатека"><p role="status">Завантажуємо медіатеку…</p></section>;
  return <section className="media-library" aria-label="Медіатека" aria-busy={loading || busy}>
    {error && <Notice onClose={() => setError('')}>{error}</Notice>}
    {data && !data.storageAvailable && <Notice type="info">Сховище R2 не підключено: файли недоступні, сканування й очищення вимкнено.</Notice>}
    {summary && <div className="stats-grid media-library-stats">
      <MediaStat label="Усього у сховищі" value={formatBytes(summary.totalBytes)} note={`${summary.objectCount} файлів`}/>
      <MediaStat label="Використовуються" value={summary.liveCount} note={formatBytes(summary.liveBytes)}/>
      <MediaStat label="Осиротілі" value={summary.orphanCount} note={`${formatBytes(summary.orphanBytes)}${summary.recentOrphanCount ? ` · нових, захищених: ${summary.recentOrphanCount}` : ''}`}/>
      <MediaStat label="Дублікати" value={summary.duplicateCount} note={formatBytes(summary.duplicateBytes)}/>
      <MediaStat label="Не скановані" value={summary.untrackedCount} note="розмір ще невідомий"/>
    </div>}
    <div className="panel media-library-panel">
      <div className="media-library-head">
        <p className="media-library-scanned">Останнє сканування: {data?.lastScanAt ? date(data.lastScanAt) : 'ще не скановано'}</p>
        {manage && <div className="media-library-scan">
          <button className="button small secondary" disabled={busy || data?.storageAvailable === false} onClick={runScan}>Сканувати сховище</button>
          {scan?.running && <button className="button small secondary" onClick={() => { cancelScan.current = true; }}>Зупинити</button>}
        </div>}
      </div>
      {manage && <p className="field-help">Сканування записує розміри й контрольні суми наявних файлів і нічого не видаляє.</p>}
      {scan && <p role="status" className="media-library-progress">{scanProgressText(scan)}{scan.running ? '…' : scan.cancelled ? '. Зупинено, можна продовжити пізніше.' : scan.failed ? '. Перервано помилкою.' : '. Готово.'}</p>}
      <div className="resource-views media-library-filters" role="group" aria-label="Фільтр медіатеки">
        {filters.map(([id, label]) => <button key={id} aria-pressed={filter === id} className={filter === id ? 'active' : ''} onClick={() => { setFilter(id); setPage(0); }}>{label} ({counts[id]})</button>)}
      </div>
      {manage && <div className="media-library-actions">
        <button className="button small secondary" disabled={busy} onClick={() => selectAll('orphan')}>Вибрати всі осиротілі</button>
        <button className="button small secondary" disabled={busy} onClick={() => selectAll('duplicate')}>Вибрати всі дублікати</button>
        <button className="button small secondary" disabled={busy || !selected.length} onClick={() => setSelected([])}>Скинути вибір</button>
        <button className="button small danger-outline" disabled={busy || !selection.count} onClick={() => setConfirming(true)}>Очистити обрані ({selection.count})</button>
      </div>}
      {result && <Notice type="success" onClose={() => setResult(null)}>
        {cleanupMessage(result)}
        {result.skippedGroups.length > 0 && <ul className="media-library-skipped">{result.skippedGroups.map(g => <li key={g.reason}>{g.label}: {g.keys.length}</li>)}</ul>}
      </Notice>}
      {visible.length ? <>
        <ul className="media-library-list" aria-label="Файли медіатеки">
          {paged.items.map(item => <MediaRow key={item.key} item={item} manage={manage} checked={selected.includes(item.key)} disabled={busy} onToggle={() => toggle(item.key)}/>)}
        </ul>
        {paged.pageCount > 1 && <div className="pagination"><button className="button small secondary" disabled={paged.page === 0} onClick={() => setPage(paged.page - 1)}>Назад</button><span>Сторінка {paged.page + 1} з {paged.pageCount} · {PAGE_SIZE} на сторінці</span><button className="button small secondary" disabled={paged.page >= paged.pageCount - 1} onClick={() => setPage(paged.page + 1)}>Далі</button></div>}
      </> : <Empty icon="grid" title="Файлів немає">{filter === 'all' ? 'У медіатеці ще немає файлів.' : 'За цим фільтром нічого не знайдено.'}</Empty>}
    </div>
    {confirming && <ConfirmDialog title="Очистити обрані файли?" danger confirmLabel={`Очистити ${selection.count}`} onClose={() => setConfirming(false)} onConfirm={runCleanup}>
      <p>Буде оброблено <strong>{selection.count}</strong> файлів: осиротілих видалити — {selection.orphans.length}, дублікатів об’єднати — {selection.duplicates.length}. Орієнтовно звільниться {formatBytes(selection.bytes)}.</p>
      <p>Для дублікатів посилання товарів спершу переспрямовуються на збережену копію, потім дублікат видаляється.</p>
      <p>Файли, що використовуються, ніколи не видаляються. Сервер повторно перевіряє кожен файл і пропустить усе, що змінилося. Дію не можна скасувати.</p>
    </ConfirmDialog>}
  </section>;
}

function MediaRow({ item, manage, checked, disabled, onToggle }) {
  const canSelect = manage && (orphanEligible(item) || duplicateEligible(item));
  const products = item.referencedBy || [];
  return <li className="media-library-row">
    <div className="media-library-check">{canSelect && <input type="checkbox" checked={checked} disabled={disabled} onChange={onToggle} aria-label={`Обрати файл ${shortKey(item.key)}`}/>}</div>
    <div className="media-library-thumb"><img loading="lazy" src={item.url} alt="" width="64" height="64"/></div>
    <div className="media-library-info">
      <strong title={item.key}>{shortKey(item.key, 36)}</strong>
      <small>{item.tracked ? formatBytes(item.size) : 'розмір невідомий'} · {item.contentType || 'тип невідомий'} · {kindLabel(item.kind)}{item.createdAt ? ` · ${date(item.createdAt)}` : ''}</small>
      <small>
        {products.length ? <>Товари: {products.map((p, i) => <span key={p.id}>{i ? ', ' : ''}{p.title}{p.deleted ? ' (у кошику)' : ''}</span>)}</> : 'Товари: немає'}
        {item.cartLines > 0 && ` · рядків кошиків: ${item.cartLines}`}
        {item.keptBy?.length > 0 && ` · утримується іншими файлами: ${item.keptBy.length}`}
      </small>
      <div className="media-library-badges">
        {item.live && <span className="status published">Використовується</span>}
        {item.orphan && !item.recent && <span className="status draft">Осиротілий</span>}
        {item.orphan && item.recent && <span className="status draft">Осиротілий: нове — захищене 24 год</span>}
        {item.duplicateOf && <span className="status draft" title={item.duplicateOf}>Дублікат {shortKey(item.duplicateOf, 20)}</span>}
        {item.duplicateOf && !item.mergeable && <span className="status">Не об’єднується: {notMergeableLabel(item.reason)}</span>}
        {!item.tracked && <span className="status">Не скановано</span>}
      </div>
    </div>
  </li>;
}
