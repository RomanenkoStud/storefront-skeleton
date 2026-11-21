import React, { useEffect, useState } from 'react';
import { BRAND_FILES, brandSrc } from './brand-files.js';
export function Icon({ name, size = 20 }) {
  const paths = {
    arrow: <><path d="M4 12h15M13 6l6 6-6 6"/></>,
    search: <><circle cx="10.8" cy="10.8" r="6.8"/><path d="m16 16 4.5 4.5"/></>,
    grid: <><rect x="3" y="3" width="7" height="7" rx="1"/><rect x="14" y="3" width="7" height="7" rx="1"/><rect x="3" y="14" width="7" height="7" rx="1"/><rect x="14" y="14" width="7" height="7" rx="1"/></>,
    suppliers: <><path d="M3 8 5 3h14l2 5v3a3 3 0 0 1-6 0 3 3 0 0 1-6 0 3 3 0 0 1-6 0V8ZM5 14v7h14v-7M9 21v-6h6v6"/></>,
    sync: <><path d="M20 8a8 8 0 0 0-14-3L3 8m0-5v5h5M4 16a8 8 0 0 0 14 3l3-3m0 5v-5h-5"/></>,
    close: <><path d="m6 6 12 12M6 18 18 6"/></>,
    plus: <><path d="M12 4v16M4 12h16"/></>,
    'tool-search': <><circle cx="10.8" cy="10.8" r="6.8"/><path d="m16 16 4.5 4.5"/></>,
    'tool-account': <><circle cx="12" cy="8" r="4"/><path d="M4.5 20.5c.8-4 3.8-6 7.5-6s6.7 2 7.5 6"/></>,
    'tool-bag': <><path d="M5 8h14l-1 12H6L5 8Z"/><path d="M9 8V7a3 3 0 0 1 6 0v1"/></>,
    'tool-menu': <><path d="M4 7h16M4 12h16M4 17h16"/></>,
    chart: <><path d="M4 20h16"/><path d="M7 16v-5M12 16V6M17 16v-8"/></>,
    server: <><rect x="4" y="4" width="16" height="7" rx="1"/><rect x="4" y="13" width="16" height="7" rx="1"/><path d="M8 7.5h.01M8 16.5h.01"/></>,
    lock: <><rect x="5" y="10" width="14" height="11" rx="2"/><path d="M8 10V7a4 4 0 0 1 8 0v3M12 14v3"/></>,
  };
  return <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">{paths[name] || paths.arrow}</svg>;
}

// variant: 'full' (B1) | 'compact' (S1 small cut, never the one-line) | 'mark' (N1); on: the surface, 'dark' | 'light'.
// width/height are the intrinsic aspect so swapping the logo never shifts layout; per-slot sizes live in landing/brand.css.
// The photo placeholder paints mark-n1.svg (mark-n1-small.svg under 120px) from landing/brand.css as a background, so no nested <img>.
export function Brand({ variant = 'full', on = 'dark' }) {
  const v = BRAND_FILES[variant] ? variant : 'full';
  const { width, height } = BRAND_FILES[v];
  return <a className={`brand brand-${v}`} href="/" aria-label="Lorem Store — головна"><img src={brandSrc(v, on)} alt="" width={width} height={height} decoding="async"/></a>;
}
export function Notice({ children, type = 'error', onClose }) {
  return <div className={`notice ${type}`} role={type === 'error' ? 'alert' : 'status'}><span>{children}</span>{onClose && <button className="icon-button" aria-label="Закрити повідомлення" onClick={onClose}><Icon name="close" size={16}/></button>}</div>;
}
export function Empty({ title, children, icon = 'grid' }) {
  return <div className="empty"><div className="empty-icon"><Icon name={icon} size={30}/></div><h3>{title}</h3><p>{children}</p></div>;
}
export function Photo({ src, fallbackSrc, title, className = '' }) {
  // `fallbackSrc` is the full-size original behind a card thumbnail: if the thumbnail fails to load, show the original.
  const [attempt, setAttempt] = useState(0);
  useEffect(() => setAttempt(0), [src, fallbackSrc]);
  const current = attempt === 0 ? src || fallbackSrc : attempt === 1 && src && fallbackSrc !== src ? fallbackSrc : null;
  return current ? <img className={className} src={current} alt={title} loading="lazy" decoding="async" onError={() => setAttempt(a => a + 1)}/> : <div className={`photo-placeholder ${className}`} role="img" aria-label="Фото ще не додано"></div>;
}
export function Field({ label, hint, children, className = '' }) {
  return <label className={`field ${className}`}><span>{label}</span>{children}{hint && <small>{hint}</small>}</label>;
}

