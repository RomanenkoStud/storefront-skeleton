// Pure helpers for the site header.
export const SEARCH_ID = 'catalog-search';
/** Search from another page: opens the home page at the catalog search, which SiteHeader then focuses. */
export const SEARCH_HREF = `/#${SEARCH_ID}`;

export function isHomePath(pathname) {
  return pathname === '/' || pathname === '';
}

/** On the home page the search icon scrolls and focuses in place; elsewhere it follows the link. */
export function searchAction(pathname, hasInput) {
  return isHomePath(pathname) && hasInput ? 'focus' : 'navigate';
}

/** True when the page was opened at the search anchor and the input should take focus. */
export function wantsSearchFocus(pathname, hash) {
  return isHomePath(pathname) && hash === `#${SEARCH_ID}`;
}

/** The condensed bar shows once the hero has scrolled above the viewport, never while it is visible or still below. */
export function condensedVisible(entry) {
  return !entry.isIntersecting && entry.boundingClientRect.bottom <= 0;
}

/** Next open menu owner: toggling the same bar closes it. */
export function nextMenu(current, bar) {
  return current === bar ? null : bar;
}
