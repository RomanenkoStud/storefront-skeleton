import React, { useEffect, useMemo, useState } from 'react';
import { formatPrice } from '../../../../packages/catalog/price.js';
import { markHeroSettled } from './hero-signal.js';
import { pickFreshDrop, thingsLabel, FRESH_DROP_COUNT } from './fresh-drop.js';

// Thumbnail first, the original photo if it fails, then an empty white stage. The image is decorative: the caption names the link.
function TileImage({ item, lead }) {
  const first = item.cardPhoto || item.photos[0];
  const [attempt, setAttempt] = useState(0);
  useEffect(() => setAttempt(0), [first, item.photos[0]]);
  const src = attempt === 0 ? first : attempt === 1 && item.photos[0] !== first ? item.photos[0] : null;
  useEffect(() => { if (lead && !src) markHeroSettled(); }, [lead, src]);
  if (!src) return null;
  return <img src={src} alt="" decoding="async" loading="eager" onLoad={lead ? markHeroSettled : undefined} {...(lead ? { fetchPriority: 'high' } : {})} onError={() => setAttempt(a => a + 1)}/>;
}

// On a phone the tiles are a scroll row and the browser does not reveal a tile that is only partly in view when it takes focus.
function revealOnFocus(event) {
  const tile = event.currentTarget, row = tile.parentElement;
  if (!row || row.scrollWidth <= row.clientWidth) return;
  const t = tile.getBoundingClientRect(), r = row.getBoundingClientRect();
  if (t.right > r.right) row.scrollLeft += t.right - r.right;
  else if (t.left < r.left) row.scrollLeft -= r.left - t.left;
}

function Tile({ item, index }) {
  return <a className={`drop-tile${index === 0 ? ' drop-tile-lead' : ''}`} href={`/products/${encodeURIComponent(item.slug)}`} onFocus={revealOnFocus}>
    <span className="drop-media"><TileImage item={item} lead={index === 0}/></span>
    <span className="drop-caption">
      {item.brand && <span className="drop-brand">{item.brand}</span>}
      <span className="drop-title">{item.title}</span>
      <span className="drop-price">{formatPrice(item.priceMinor)}</span>
    </span>
  </a>;
}

/**
 * Hero right column (ADR-0014). The outer box is the same in every state: skeleton, three tiles, empty note.
 * Box sizes come from the grid and from fixed heights in hero.css, never from the images.
 */
export default function FreshDrop({ products, loading, error }) {
  const picks = useMemo(() => (loading || error ? [] : pickFreshDrop(products)), [products, loading, error]);
  const empty = !loading && (!!error || picks.length < FRESH_DROP_COUNT);
  useEffect(() => { if (empty) markHeroSettled(); }, [empty]);
  if (loading && !error) {
    return <section className="hero-drop" aria-label="Нові надходження" aria-busy="true">
      <div className="drop-head" aria-hidden="true"><i className="drop-skeleton-line"/></div>
      <div className="drop-grid" aria-hidden="true">{Array.from({ length: FRESH_DROP_COUNT }, (_, i) => <i key={i} className={`drop-tile drop-skeleton${i === 0 ? ' drop-tile-lead' : ''}`}/>)}</div>
    </section>;
  }
  if (error || picks.length < FRESH_DROP_COUNT) {
    // No wall photo any more: the same box stays (no layout jump from the skeleton) with a quiet line and a way into the catalog.
    return <section className="hero-drop hero-drop-empty" aria-label="Нові надходження"><p>Нові надходження скоро.</p><a className="drop-all" href="/#catalog">Відкрити каталог <span aria-hidden="true">↗</span></a></section>;
  }
  return <section className="hero-drop" aria-labelledby="hero-drop-title">
    <div className="drop-head">
      <h2 id="hero-drop-title"><span className="drop-dot" aria-hidden="true"/>Нові надходження</h2>
      <a className="drop-all" href="/#catalog">{thingsLabel(products.length)} у каталозі <span aria-hidden="true">↗</span></a>
    </div>
    <div className="drop-grid">{picks.map((item, i) => <Tile key={item.id || item.slug} item={item} index={i}/>)}</div>
  </section>;
}
