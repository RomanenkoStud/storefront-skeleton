// Draft cart over localStorage (ADR-0007). Display fields are hints only; the server re-prices at checkout.
import { LOCAL_CART_KEY, MAX_RECENT_CODES, MAX_QUANTITY, MIN_QUANTITY, addLocalLine, emptyLocalCart, isValidQuantity, parseLocalCart, serializeLocalCart } from '../../../../packages/catalog/cart.js';

function browserStorage() {
  try { return globalThis.localStorage || null; } catch { return null; }
}

const ADD_OK = ['added', 'merged', 'capped', 'stock_capped'];
export function isAddOk(status) { return ADD_OK.includes(status); }
export const lineKey = line => `${line.productId}\u0000${line.size}`;

/** Quantity text typed by the user: integer 1..10 or null (not yet committable). */
export function parseQuantityDraft(text) {
  const t = String(text ?? '').trim();
  if (!/^\d{1,3}$/.test(t)) return null;
  const n = Number(t);
  return n >= MIN_QUANTITY && n <= MAX_QUANTITY ? n : null;
}

/** Sizes with stock, deduped by size (variant sizes are not guaranteed unique). */
export function inStockSizes(variants) {
  const totals = new Map();
  for (const v of Array.isArray(variants) ? variants : []) {
    const size = typeof v?.size === 'string' ? v.size.trim() : '';
    if (!size || !(v.stock > 0)) continue;
    totals.set(size, (totals.get(size) || 0) + v.stock);
  }
  return [...totals].map(([size, stock]) => ({ size, stock }));
}

/**
 * @param {() => Storage | null} getStorage may return null or throw-prone storage; failures keep an in-memory copy.
 */
export function createCartStore(getStorage = browserStorage) {
  let state = null;
  let persistent = true;
  const listeners = new Set(), externalListeners = new Set(), addedListeners = new Set();
  function read() {
    try {
      const text = getStorage()?.getItem(LOCAL_CART_KEY);
      persistent = true;
      return parseLocalCart(text ?? null);
    } catch { persistent = false; return state || emptyLocalCart(); }
  }
  function write(next) {
    state = parseLocalCart(serializeLocalCart(next));
    try { const s = getStorage(); if (!s) throw new Error('no storage'); s.setItem(LOCAL_CART_KEY, serializeLocalCart(state)); persistent = true; } catch { persistent = false; }
    emit();
    return state;
  }
  function emit() { for (const l of [...listeners]) l(); }
  function get() { if (!state) state = read(); return state; }
  return {
    get,
    /** Re-read storage (another tab changed it). */
    refresh() { state = read(); for (const l of [...externalListeners]) l(); emit(); return state; },
    /** Notified when the cart was re-read from storage (another tab); used to clear stale UI problems. */
    subscribeExternal(listener) { externalListeners.add(listener); return () => externalListeners.delete(listener); },
    /**
     * Fired once after a successful add of a new line or a merge into an existing one, with {status, productId, size}.
     * Not fired for capped/stock_capped adds (the quantity did not grow as asked), failures, other-tab refresh,
     * quantity changes, removal, checkout or hint refresh. A throwing listener never breaks the add.
     */
    subscribeAdded(listener) { addedListeners.add(listener); return () => addedListeners.delete(listener); },
    isPersistent() { get(); return persistent; },
    subscribe(listener) { listeners.add(listener); return () => listeners.delete(listener); },
    count() { return get().lines.reduce((n, l) => n + l.quantity, 0); },
    /** Immutable copy of the lines, to submit while the user keeps interacting. */
    snapshot() { return get().lines.map(l => ({ ...l })); },
    /**
     * Adds a size of a public product. Returns {status}: added | merged | capped | stock_capped | full | unavailable | invalid.
     */
    addProduct(product, size, quantity = 1) {
      if (!product?.id || typeof size !== 'string') return { status: 'invalid' };
      const available = inStockSizes(product.variants).find(s => s.size === size.trim());
      if (!available) return { status: 'unavailable' };
      const qty = isValidQuantity(quantity) ? quantity : MIN_QUANTITY;
      const current = get();
      const line = { productId: product.id, slug: product.slug || '', size: available.size, quantity: qty, title: product.title || '', priceMinor: Number.isSafeInteger(product.priceMinor) ? product.priceMinor : null, photo: product.photos?.[0] || null };
      const existed = current.lines.some(l => l.productId === line.productId && l.size === line.size);
      const result = addLocalLine(current.lines, line);
      if (result.full) return { status: 'full' };
      let lines = result.lines;
      let stockCapped = false;
      lines = lines.map(l => {
        if (l.productId === line.productId && l.size === line.size && l.quantity > available.stock) { stockCapped = true; return { ...l, quantity: Math.max(MIN_QUANTITY, available.stock) }; }
        return l;
      });
      write({ ...current, lines });
      const status = result.capped ? 'capped' : stockCapped ? 'stock_capped' : existed ? 'merged' : 'added';
      if (status === 'added' || status === 'merged') {
        for (const l of [...addedListeners]) { try { l({ status, productId: line.productId, size: line.size }); } catch { /* a listener must not break the add */ } }
      }
      return { status, stock: available.stock };
    },
    /** Updates only the display hints title and priceMinor from fresh catalog products. Never touches quantities, sizes, slug or photo. */
    refreshHints(products) {
      const byId = new Map((Array.isArray(products) ? products : []).filter(p => p?.id).map(p => [p.id, p]));
      const current = get();
      let changed = false;
      const lines = current.lines.map(l => {
        const p = byId.get(l.productId);
        if (!p) return l;
        const next = { ...l, title: typeof p.title === 'string' && p.title ? p.title : l.title, priceMinor: Number.isSafeInteger(p.priceMinor) ? p.priceMinor : null };
        if (next.title !== l.title || next.priceMinor !== l.priceMinor) changed = true;
        return next;
      });
      if (changed) write({ ...current, lines });
      return changed;
    },
    setQuantity(index, quantity) {
      const current = get();
      if (!current.lines[index] || !Number.isInteger(quantity)) return;
      const q = Math.min(MAX_QUANTITY, Math.max(MIN_QUANTITY, quantity));
      write({ ...current, lines: current.lines.map((l, i) => (i === index ? { ...l, quantity: q } : l)) });
    },
    removeLine(index) { const current = get(); write({ ...current, lines: current.lines.filter((_, i) => i !== index) }); },
    /**
     * After a successful checkout: remove only the SUBMITTED lines (quantity submitted is subtracted, so lines or
     * units added elsewhere meanwhile survive) and remember the code.
     */
    completeCheckout(cart, submittedLines = null) {
      get();
      if (persistent) state = read(); // memory-only carts keep their in-memory state
      const current = state;
      const submitted = new Map((submittedLines || current.lines).map(l => [lineKey(l), l.quantity]));
      const lines = [];
      for (const l of current.lines) {
        const sent = submitted.get(lineKey(l));
        if (sent === undefined) lines.push(l);
        else if (l.quantity > sent) lines.push({ ...l, quantity: l.quantity - sent });
      }
      const entry = { code: cart.code, createdAt: cart.createdAt, itemCount: cart.itemCount, totalMinor: cart.totalMinor };
      const recent = [entry, ...current.recent.filter(r => r.code !== cart.code)].slice(0, MAX_RECENT_CODES);
      write({ ...current, lines, recent });
    },
    clearRecent() { write({ ...get(), recent: [] }); },
  };
}

export const cartStore = createCartStore();
