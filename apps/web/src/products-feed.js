// One shared request for the public product list (ADR-0014). main.jsx starts it early on the landing page so it runs
// in parallel with /api/taxonomy; Storefront reads the same promise. Nothing here is a cache of results: a rejection
// clears the memo so the next call sends a fresh request.
import { api } from './api.js';

export function createProductsFeed(fetchProducts) {
  let memo = null;
  return function load() {
    if (memo) return memo;
    const promise = Promise.resolve().then(fetchProducts);
    memo = promise;
    // Never an unhandled rejection for an early call nobody has awaited yet; callers still see the rejection.
    promise.catch(() => { if (memo === promise) memo = null; });
    return promise;
  };
}

export const loadProducts = createProductsFeed(() => api('/api/products'));
