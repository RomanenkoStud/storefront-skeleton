// Navigation entry type of the current page: 'navigate', 'reload', 'back_forward' or 'prerender'.
export function navigationType(perf = globalThis.performance) {
  try { return perf?.getEntriesByType?.('navigation')?.[0]?.type || 'navigate'; } catch { return 'navigate'; }
}
