/** Pure helpers for the manager Media library. No DOM and no network. */
export const PAGE_SIZE = 40;
export const CLEANUP_CHUNK = 200;

export const kindLabels = { upload: 'завантаження', original: 'архів оригіналу', cutout: 'без фону', normalized: 'вирівняне', unknown: 'невідомо' };
export const kindLabel = kind => kindLabels[kind] || kindLabels.unknown;

export const skipReasonLabels = {
  referenced: 'Файл використовується товаром, кошиком або іншим файлом',
  recent: 'Файл новіший за 24 години і ще захищений',
  untracked: 'Файл ще не скановано',
  'not-duplicate': 'Файл більше не є дублікатом',
  'immutable-reference': 'Файл збережено в кошику або історії файлів, його не можна замінити',
  'lineage-mismatch': 'Походження файлу не збігається з оригіналом',
  'supplier-source': 'Файл є джерелом фото постачальника',
  changed: 'Дані змінилися під час очищення',
  missing: 'Файл уже відсутній',
};
export const skipReasonLabel = reason => skipReasonLabels[reason] || `Інша причина (${reason})`;

export const notMergeableLabels = {
  cart: 'використовується в кошику',
  lineage: 'є частиною історії іншого файлу',
  'lineage-mismatch': 'різне походження',
  'supplier-source': 'джерело фото постачальника',
};
export const notMergeableLabel = reason => notMergeableLabels[reason] || (reason ? String(reason) : 'не можна об’єднати');

export function formatBytes(bytes) {
  const n = bytes == null || bytes === '' ? NaN : Number(bytes);
  if (!Number.isFinite(n) || n < 0) return '—';
  if (n < 1024) return `${Math.round(n)} Б`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1).replace('.', ',')} КБ`;
  if (n < 1024 ** 3) return `${(n / 1024 / 1024).toFixed(1).replace('.', ',')} МБ`;
  return `${(n / 1024 ** 3).toFixed(2).replace('.', ',')} ГБ`;
}

export function shortKey(key, max = 28) {
  const text = String(key || '');
  return text.length <= max ? text : `${text.slice(0, Math.ceil((max - 1) * 0.6))}…${text.slice(-Math.floor((max - 1) * 0.4))}`;
}

export const filters = [
  ['all', 'Усі'],
  ['orphan', 'Осиротілі'],
  ['duplicate', 'Дублікати'],
  ['untracked', 'Не скановані'],
  ['live', 'Використовуються'],
];

export function matchesFilter(item, filter) {
  switch (filter) {
    case 'orphan': return !!item.orphan;
    case 'duplicate': return item.duplicateOf != null;
    case 'untracked': return item.tracked === false;
    case 'live': return !!item.live;
    default: return true;
  }
}
export const filterItems = (items = [], filter = 'all') => items.filter(item => matchesFilter(item, filter));
export const filterCounts = (items = []) => Object.fromEntries(filters.map(([id]) => [id, filterItems(items, id).length]));

export function paginate(items, page, size = PAGE_SIZE) {
  const pageCount = Math.max(1, Math.ceil(items.length / size));
  const current = Math.min(Math.max(0, page), pageCount - 1);
  return { page: current, pageCount, items: items.slice(current * size, (current + 1) * size) };
}

/** Client-side eligibility mirrors the server; the server re-checks every key anyway. */
export const orphanEligible = item => !!(item.orphan && !item.recent && item.tracked);
export const duplicateEligible = item => !!(item.duplicateOf && item.mergeable && item.tracked !== false);
export const eligible = item => orphanEligible(item) || duplicateEligible(item);

export const selectableKeys = (items, kind) => items.filter(kind === 'duplicate' ? duplicateEligible : orphanEligible).map(item => item.key);

/** Build the cleanup selection from a Set/array of keys; a key is sent once, as an orphan when it is one. */
export function buildSelection(items, selectedKeys) {
  const chosen = new Set(selectedKeys);
  const orphans = [], duplicates = [];
  let bytes = 0;
  for (const item of items) {
    if (!chosen.has(item.key)) continue;
    if (orphanEligible(item)) orphans.push(item.key);
    else if (duplicateEligible(item)) duplicates.push(item.key);
    else continue;
    bytes += Number(item.size) || 0;
  }
  return { orphans, duplicates, bytes, count: orphans.length + duplicates.length };
}

export function chunkSelection({ orphans = [], duplicates = [] }, size = CLEANUP_CHUNK) {
  const chunks = [];
  let current = { orphans: [], duplicates: [] }, used = 0;
  const flush = () => { if (used) chunks.push(current); current = { orphans: [], duplicates: [] }; used = 0; };
  for (const [field, keys] of [['orphans', orphans], ['duplicates', duplicates]]) {
    for (const key of keys) {
      current[field].push(key);
      if (++used >= size) flush();
    }
  }
  flush();
  return chunks;
}

/** Combine per-chunk server results into one summary with skipped items grouped by reason. */
export function summarizeCleanup(results = []) {
  const deleted = [], merged = [], skipped = [];
  let freedBytes = 0;
  for (const result of results) {
    deleted.push(...(result?.deleted || []));
    merged.push(...(result?.merged || []));
    skipped.push(...(result?.skipped || []));
    freedBytes += Number(result?.freedBytes) || 0;
  }
  const groups = new Map();
  for (const { key, reason } of skipped) {
    if (!groups.has(reason)) groups.set(reason, []);
    groups.get(reason).push(key);
  }
  return {
    deleted: deleted.length,
    merged: merged.length,
    freedBytes,
    skipped: skipped.length,
    skippedGroups: [...groups].map(([reason, keys]) => ({ reason, label: skipReasonLabel(reason), keys })),
  };
}

export function cleanupMessage(summary) {
  const parts = [`Видалено файлів: ${summary.deleted}`, `об’єднано дублікатів: ${summary.merged}`, `звільнено ${formatBytes(summary.freedBytes)}`];
  return `${parts.join(', ')}.${summary.skipped ? ` Пропущено: ${summary.skipped}.` : ''}`;
}

export function scanProgressText({ scanned = 0, added = 0 } = {}) {
  return `Проскановано файлів: ${scanned}, нових записів: ${added}`;
}
