import React from 'react';
import { Icon } from '../ui.jsx';
import RAIL from '../rail-media.json';
import { withPosters as mix } from './posters.js';
import { posterCutouts } from './storefront-images.js';

// Rack cut-outs by category (front view, or the shoe render); categories without one get a type-only tile.
const CUTOUTS = Object.fromEntries([...RAIL.clothes.map(x => [x.categoryId, x.front]), ...RAIL.shoes.map(x => [x.categoryId, x])]);

// ctx.images: staff-chosen poster / rack images from /api/storefront, over the shipped cut-outs.
export function withPosters(items, { images, ...ctx } = {}) { return mix(items, { cutouts: images ? posterCutouts(RAIL, images) : CUTOUTS, ...ctx }); }

// One grid slot, one tab stop. Not a .product-card: the product count and focus-after-"Показати ще" ignore it.
export default function PosterTile({ item, onCategory }) {
  const href = `/?category=${encodeURIComponent(item.id)}#catalog`;
  const open = e => { if (!onCategory || e.defaultPrevented || e.button || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return; e.preventDefault(); onCategory(item.id); /* the tile unmounts with the filter: keep keyboard focus on the results */ const target = document.querySelector('.catalog-results'); if (target) { target.tabIndex = -1; target.focus({ preventScroll: true }); } };
  return <a className={`poster-tile is-${item.tone}${item.cutout ? '' : ' type-only'}`} href={href} onClick={open} aria-label={`${item.label} — від ${item.price}`}>
    <span className="poster-top"><span className="poster-kicker">{item.kicker || 'Каталог'}</span><span className="poster-title">{item.label}</span></span>
    {item.cutout && <img className="poster-cut" src={item.cutout.src} width={item.cutout.w} height={item.cutout.h} alt="" loading="lazy" decoding="async"/>}
    <span className="poster-go"><span>Від {item.price}</span><Icon name="arrow" size={18}/></span>
  </a>;
}
