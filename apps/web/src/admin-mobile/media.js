// Media-query hook for the mobile manager UI. Same shape as the storefront's useMedia, but it must not import from
// FeaturedRail.jsx (storefront file). The numbers are literal because CSS custom properties cannot be used in @media.
import { useEffect, useState } from 'react';

/** Phone range of the manager UI. Tablet is 640px to 1023.98px; 1024px and up is desktop and never changes. */
export const PHONE = '(max-width: 639.98px)';

const matches = query => typeof window !== 'undefined' && typeof window.matchMedia === 'function' && window.matchMedia(query).matches;

/**
 * True while `query` matches, updated on change. SSR-safe: false when there is no window or matchMedia.
 * Use it to render phone-only JSX (`useMediaQuery(PHONE)`), so the desktop DOM stays byte-identical.
 */
export function useMediaQuery(query) {
  const [value, setValue] = useState(() => matches(query));
  useEffect(() => {
    if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return undefined;
    const list = window.matchMedia(query);
    const update = () => setValue(list.matches);
    update();
    list.addEventListener('change', update);
    return () => list.removeEventListener('change', update);
  }, [query]);
  return value;
}

export default useMediaQuery;
