import React, { useEffect, useState, useSyncExternalStore } from 'react';
import { LOCAL_CART_KEY } from '../../../../packages/catalog/cart.js';
import { cartStore } from './cart-store.js';
import { Icon } from '../ui.jsx';
import { badgeText, cartLabel } from './cart-labels.js';
import './cart-moment.css';

export function useCartCount() {
  useEffect(() => {
    const onStorage = e => { if (e.key === null || e.key === LOCAL_CART_KEY) cartStore.refresh(); };
    window.addEventListener('storage', onStorage);
    return () => window.removeEventListener('storage', onStorage);
  }, []);
  useSyncExternalStore(cartStore.subscribe, () => cartStore.get(), () => cartStore.get());
  return cartStore.count();
}

export function BagIcon({ size = 22 }) {
  return <Icon name="tool-bag" size={size}/>;
}

/** Header icon button with a count badge. `count` overrides the store (tests). */
export function CartLinkView({ count, moment = 0 }) {
  const badge = badgeText(count);
  return <a className="cart-link hdr-tool" href="/cart" aria-label={cartLabel(count)}><BagIcon/>{badge && <span className={`cart-count${moment ? ' pop' : ''}`} key={`c${moment}`} aria-hidden="true" onAnimationEnd={e => e.currentTarget.classList.remove('pop')}>{badge}</span>}{moment > 0 && <span className="cart-moment" key={`m${moment}`} aria-hidden="true"><i/><b/></span>}</a>;
}

/** Counts successful adds (cart-store subscribeAdded); each bump restarts the CSS-only moment. */
export default function CartLink() {
  const [moment, setMoment] = useState(0);
  useEffect(() => cartStore.subscribeAdded(() => setMoment(n => n + 1)), []);
  return <CartLinkView count={useCartCount()} moment={moment}/>;
}
