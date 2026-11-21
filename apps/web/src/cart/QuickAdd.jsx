import React, { useEffect, useId, useRef, useState } from 'react';
import { inStockSizes } from './cart-store.js';
import { addWithFeedback } from './cart-add.js';
import { BagIcon } from './CartLink.jsx';

import './cart-moment.css';

/** `draw` is true only for a real add (added/merged): the tick draws on; otherwise it is shown static. */
export function CheckIcon({ draw }) {
  return <svg className={`tick${draw ? ' draw' : ''}`} width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" focusable="false"><path pathLength="1" d="m5 12.5 4.5 4.5L19 7.5"/></svg>;
}

/**
 * Compact add-to-cart icon for catalog cards. One in-stock size adds directly; several open a size popover.
 * Render inside a position:relative container (the card image). `initialOpen` exists for markup tests only.
 */
export default function QuickAdd({ product, initialOpen = false }) {
  const sizes = inStockSizes(product.variants);
  const popId = useId();
  const root = useRef(null), trigger = useRef(null), timer = useRef(0);
  const [open, setOpen] = useState(initialOpen && sizes.length > 1);
  const [done, setDone] = useState(false), [plays, setPlays] = useState(0);
  const [feedback, setFeedback] = useState(null), [live, setLive] = useState('');
  useEffect(() => () => clearTimeout(timer.current), []);
  useEffect(() => {
    if (!open) return;
    const away = e => { if (!root.current?.contains(e.target)) setOpen(false); };
    document.addEventListener('pointerdown', away);
    return () => document.removeEventListener('pointerdown', away);
  }, [open]);
  useEffect(() => { if (open) root.current?.querySelector('.quick-add-sizes button')?.focus(); }, [open]);
  if (!sizes.length) return null;
  function add(size) {
    const result = addWithFeedback(product, size);
    setFeedback(result);
    setLive('');
    requestAnimationFrame(() => setLive(result.text));
    setDone(result.ok);
    setPlays(n => n + 1);
    clearTimeout(timer.current);
    timer.current = setTimeout(() => { setDone(false); setFeedback(null); }, 4000);
    if (open) { setOpen(false); trigger.current?.focus(); }
  }
  function onKeyDown(e) {
    if (e.key === 'Escape' && open) { e.stopPropagation(); setOpen(false); trigger.current?.focus(); }
  }
  const single = sizes.length === 1;
  return <div className="quick-add" ref={root} onKeyDown={onKeyDown} onBlur={e => {
    // Safari and Firefox on macOS do not focus a clicked button, so relatedTarget is null on mousedown; closing then would
    // swallow the click. Outside pointer clicks are handled by the document pointerdown listener.
    if (open && e.relatedTarget && !root.current?.contains(e.relatedTarget)) setOpen(false);
  }}>
    <button type="button" ref={trigger} className={`quick-add-button ${done ? 'done' : ''}`} aria-label={`Додати в кошик: ${product.title}`} aria-expanded={single ? undefined : open} aria-controls={single || !open ? undefined : popId} onClick={() => (single ? add(sizes[0].size) : setOpen(o => !o))}>{done ? <CheckIcon key={plays} draw={feedback?.status === 'added' || feedback?.status === 'merged'}/> : <BagIcon size={20}/>}</button>
    {open && <div className="quick-add-sizes" id={popId} role="group" aria-label={`Оберіть розмір: ${product.title}`}>{sizes.map(s => <button type="button" key={s.size} onClick={() => add(s.size)} aria-label={`Розмір ${s.size}: додати в кошик`}>{s.size}</button>)}</div>}
    <span className="sr-only" role="status" aria-live="polite">{live}</span>
    {feedback && (!feedback.ok || feedback.status !== 'added') && <p className={`quick-add-note ${feedback.ok ? '' : 'error'}`} aria-hidden="true">{feedback.text}</p>}
  </div>;
}
