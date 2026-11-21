import React, { useEffect, useId, useRef, useState } from 'react';
import { inStockSizes } from './cart-store.js';
import { addWithFeedback } from './cart-add.js';
import { CheckIcon } from './QuickAdd.jsx';

/** Explicit size selector for the product detail view. Only in-stock sizes; feedback goes to a polite live region. */
export default function SizePicker({ product }) {
  const id = useId();
  const sizes = inStockSizes(product.variants);
  const [size, setSize] = useState(sizes.length === 1 ? sizes[0].size : '');
  const [feedback, setFeedback] = useState(null), [done, setDone] = useState(0), timer = useRef(0);
  useEffect(() => () => clearTimeout(timer.current), []);
  if (!sizes.length) return <p className="picker-empty">Немає в наявності</p>;
  function add(e) {
    e.preventDefault();
    const result = addWithFeedback(product, size);
    setFeedback(result);
    clearTimeout(timer.current);
    const real = result.status === 'added' || result.status === 'merged';
    setDone(real ? d => d + 1 : 0);
    if (real) timer.current = setTimeout(() => setDone(0), 2000);
  }
  return <form className="size-picker" onSubmit={add}>
    <fieldset><legend>Оберіть розмір<span className="sr-only">: {product.title}</span></legend>
      <div className="size-picker-options">{sizes.map(s => <label key={s.size} className={size === s.size ? 'checked' : ''}><input type="radio" name={`size-${id}`} value={s.size} checked={size === s.size} onChange={() => { setSize(s.size); setFeedback(null); }}/><span>{s.size}</span></label>)}</div>
    </fieldset>
    <button type="submit" className="button primary add-to-cart" aria-label={`Додати в кошик: ${product.title}`}>{done ? <><CheckIcon key={done} draw/> У кошику</> : 'Додати в кошик'}</button>
    <p className={`picker-feedback ${feedback && !feedback.ok ? 'error' : ''}`} role="status" aria-live="polite">{feedback?.text || ''}</p>
  </form>;
}
