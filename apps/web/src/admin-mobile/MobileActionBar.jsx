import React, { useEffect, useId, useRef, useState } from 'react';

/**
 * Sticky bottom action bar for phones. Styled only inside the phone media range (admin-mobile/base.css): render it only
 * when useMediaQuery(PHONE) is true. Place it as the LAST child of the scrolling page content so it never covers the last card.
 *
 * Props
 *   label    status line text, for example `Обрано 3`
 *   actions  ordered array of { key, label, onClick, disabled, tone } ALREADY filtered by permission. tone: 'primary' | 'danger' | undefined
 *   inline   how many actions stay in the bar (default 2); the rest go behind the «Ще дії» toggle
 *
 * Renders nothing when `actions` is empty. The overflow list opens above the row inside the bar. It is not a dialog: the toggle has
 * aria-expanded and aria-controls, Escape closes it and returns focus to the toggle, and no element gets role="dialog".
 */
export default function MobileActionBar({ label, actions = [], inline = 2 }) {
  const [open, setOpen] = useState(false);
  const listId = useId();
  const toggle = useRef(null);
  const list = Array.isArray(actions) ? actions.filter(Boolean) : [];
  const shown = list.slice(0, inline), more = list.slice(inline);
  useEffect(() => { if (!more.length) setOpen(false); }, [more.length]);
  if (!list.length) return null;
  const className = action => `button ${action.tone === 'primary' ? 'primary' : action.tone === 'danger' ? 'danger' : 'secondary'}`;
  const render = (action, afterClick) => <button key={action.key} type="button" className={className(action)} disabled={action.disabled}
    onClick={() => { action.onClick?.(); if (afterClick) { toggle.current?.focus(); setOpen(false); } }}>{action.label}</button>;
  return <div className="m-actionbar" onKeyDown={e => { if (e.key === 'Escape' && open) { e.stopPropagation(); setOpen(false); toggle.current?.focus(); } }}>
    {more.length > 0 && <div id={listId} className="m-actionbar-more" hidden={!open}>{more.map(action => render(action, true))}</div>}
    <div className="m-actionbar-row">
      <span className="m-actionbar-status" role="status">{label}</span>
      {shown.map(action => render(action, false))}
      {more.length > 0 && <button ref={toggle} type="button" className="button secondary" aria-expanded={open} aria-controls={listId} onClick={() => setOpen(value => !value)}>Ще дії</button>}
    </div>
  </div>;
}
