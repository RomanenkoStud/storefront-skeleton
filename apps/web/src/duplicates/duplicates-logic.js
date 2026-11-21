// Pure helpers for the duplicate review panel. No DOM, no fetch.

export const PAGE_SIZE = 20;
export const MAX_IDS = 20; // per-request limit of the duplicates API
export const CONFIDENCE_LABELS = { high: 'Висока схожість', medium: 'Середня схожість' };

/** Distinct, readable evidence for a candidate: each reason kind/value once, strongest first. */
export function evidenceLabels(candidate) {
  const seen = new Map();
  for (const pair of candidate.pairs || []) for (const reason of pair.reasons || []) {
    const key = reason.kind === 'title' ? 'title' : `${reason.kind}:${reason.value ?? ''}`;
    const current = seen.get(key);
    if (!current || (reason.kind === 'title' && reason.score > current.score)) seen.set(key, reason);
  }
  const order = { photo: 0, code: 1, title: 2, brand: 3 };
  return [...seen.values()].sort((a, b) => (order[a.kind] ?? 9) - (order[b.kind] ?? 9) || String(a.value ?? '').localeCompare(String(b.value ?? ''))).map(reasonLabel);
}
export function reasonLabel(reason) {
  if (reason.kind === 'photo') return 'Спільне фото';
  if (reason.kind === 'code') return `Код моделі ${String(reason.value || '').toUpperCase()}`;
  if (reason.kind === 'title') return `Схожа назва ${Math.round((reason.score ?? 0) * 100)}%`;
  if (reason.kind === 'brand') return `Бренд ${reason.value}`;
  return 'Збіг';
}

/** Initial checkboxes: one product per supplier (the first in candidate order); existing group members are fixed. */
export function defaultSelection(candidate, products) {
  const suppliers = new Set((candidate.groupProductIds || []).map(id => products[id]?.supplierId).filter(Boolean));
  const selected = [];
  for (const id of candidate.productIds) {
    const supplierId = products[id]?.supplierId;
    if (!supplierId || suppliers.has(supplierId)) continue;
    suppliers.add(supplierId); selected.push(id);
  }
  return selected;
}

/** Whether the manager's selection can be confirmed, with a Ukrainian reason when not. */
export function selectionProblem(candidate, selected, products) {
  const members = [...(candidate.groupProductIds || []), ...selected];
  if (!selected.length) return 'Оберіть хоча б один товар.';
  const suppliers = members.map(id => products[id]?.supplierId);
  if (new Set(suppliers).size !== suppliers.length) return 'В одній групі може бути лише один товар від кожного постачальника.';
  if (members.length < 2) return 'Група потребує товарів щонайменше двох постачальників.';
  if (members.length > MAX_IDS) return `Група може містити щонайбільше ${MAX_IDS} товарів.`;
  if (candidate.productIds.length - selected.length > MAX_IDS) return `Зніміть позначку щонайбільше з ${MAX_IDS} товарів за раз.`;
  return '';
}
/** "Different items" covers the whole candidate; the API accepts at most MAX_IDS products per request. */
export function rejectProblem(candidate) {
  return (candidate.groupProductIds || []).length + candidate.productIds.length > MAX_IDS ? `Забагато товарів (понад ${MAX_IDS}): підтвердіть групу з частини товарів — решту буде записано як інші товари.` : '';
}

/** Request bodies for the two candidate actions. Unchecked products are recorded as different items. */
export function confirmBody(candidate, selected) {
  const rejectIds = candidate.productIds.filter(id => !selected.includes(id));
  return { productIds: selected, ...(candidate.groupId ? { groupId: candidate.groupId } : {}), ...(rejectIds.length ? { rejectIds } : {}) };
}
export function rejectBody(candidate) {
  return { productIds: [...(candidate.groupProductIds || []), ...candidate.productIds] };
}

export function matchesFilter(candidate, products, { query = '', confidence = '', supplierId = '' } = {}) {
  if (confidence && candidate.confidence !== confidence) return false;
  const ids = [...(candidate.groupProductIds || []), ...candidate.productIds];
  if (supplierId && !ids.some(id => products[id]?.supplierId === supplierId)) return false;
  const q = query.trim().toLowerCase();
  if (q && !ids.some(id => [products[id]?.title, products[id]?.sourceTitle, products[id]?.supplierName, products[id]?.brand].some(v => typeof v === 'string' && v.toLowerCase().includes(q)))) return false;
  return true;
}

export function supplierOptions(products) {
  const map = new Map();
  for (const product of Object.values(products || {})) if (product.supplierId) map.set(product.supplierId, product.supplierName || product.supplierId);
  return [...map].sort((a, b) => a[1].localeCompare(b[1], 'uk'));
}

export const stockText = product => `${product.stock} шт.` + (product.sizes?.length ? ` · ${product.sizes.filter(s => s.stock > 0).map(s => s.size).join(', ') || 'немає розмірів у наявності'}` : '');
