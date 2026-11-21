import { useEffect } from 'react';
import { PHONE, useMediaQuery } from './media.js';

/**
 * Renders nothing. Keeps the horizontal nav strip (phone only) usable:
 *  - when `tab` changes, centres the active nav button in the strip;
 *  - when a nav button gets keyboard focus, centres it too (browsers leave a half-visible focused item cut off, and the strip snaps to
 *    button centres).
 * It sets the strip's own scrollLeft and never calls scrollIntoView: scrollIntoView also scrolls the document, and Chromium briefly
 * reports a 1px-wide viewport during full-page screenshots, which would scroll the desktop page. Mount it once inside the admin shell;
 * its only prop is `tab`.
 */
function center(nav, button) {
  if (!nav || !button || nav.scrollWidth <= nav.clientWidth) return;
  const n = nav.getBoundingClientRect(), b = button.getBoundingClientRect();
  nav.scrollLeft += (b.left + b.width / 2) - (n.left + n.width / 2);
}

export default function ActiveNavScroll({ tab }) {
  const phone = useMediaQuery(PHONE);
  useEffect(() => {
    if (!phone) return undefined;
    const nav = document.querySelector('.admin-shell .sidebar nav');
    center(nav, nav?.querySelector('button.active'));
    const reveal = event => center(nav, event.target.closest?.('button'));
    nav?.addEventListener('focusin', reveal);
    return () => nav?.removeEventListener('focusin', reveal);
  }, [tab, phone]);
  return null;
}
