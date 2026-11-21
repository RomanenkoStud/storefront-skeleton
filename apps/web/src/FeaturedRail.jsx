import React, { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { useTaxonomy } from './TaxonomyContext.jsx';
import { onHeroSettled } from './landing/hero-signal.js';
import SHIPPED from './rail-media.json';
import { loadStorefrontSettings } from './landing/campaign.js';
import { rackWithImages } from './landing/storefront-images.js';
import './featured-rail.css';

// Landing rail: a street pipe rack where every hanger and every pair on the shelf is a
// catalog category. Pieces are pre-cut transparent renders shipped under /rail/ (see rail-media.json),
// so the rail does not depend on which products an environment has.

// Resting angle per piece: turned away but never dead side-on, and not all the same, like a real rack.
const idleTurn = i => 48 + ((i * 7) % 5) * 3;
const SIDE_SHOW = 0.4; // share of a card's width that stays visible edge-on
const ar = v => (v.w / v.h).toFixed(4);

function useMedia(query) {
  const [match, setMatch] = useState(() => typeof matchMedia === 'function' && matchMedia(query).matches);
  useEffect(() => { const m = matchMedia(query), on = () => setMatch(m.matches); on(); m.addEventListener('change', on); return () => m.removeEventListener('change', on); }, [query]);
  return match;
}

// Rendered front, three-quarter and side views as planes that turn together around the hook,
// cross-faded by angle, so a turned piece shows its real profile instead of a squashed front.
// The rack room asks for its images only once it is near the viewport and the hero's lead tile has settled (see RackImages).
const RackImages = React.createContext(true);
function Garment3D({ front, side, angle, drapeRef }) {
  const ready = React.useContext(RackImages);
  const face = (cls, v) => <span className={`g3-face ${cls}`} style={ready ? { '--cut': `url("${v.src}")` } : undefined}><img src={ready ? v.src : undefined} alt="" draggable={false} loading="lazy" fetchPriority="low" decoding="async"/><span className="g3-shade"/></span>;
  return <span className={`rail-3d is-ready ${angle ? 'has-angle' : ''}`} style={{ '--far': ar(front), '--sar': ar(side), '--qar': ar(angle || side) }}>
    <span ref={drapeRef} className="g3-drape">{face('g3-front', front)}{face('g3-side', side)}{angle && face('g3-angle', angle)}</span>
  </span>;
}

function Shoe({ x }) {
  const ready = React.useContext(RackImages);
  return <img className="shoe-img" src={ready ? x.src : undefined} width={x.w} height={x.h} alt="" draggable={false} loading="lazy" fetchPriority="low" decoding="async"/>;
}

function Chip({ kind, item, idle, pick }) {
  return <div className={`rail-chip is-${kind}`} aria-live="polite">
    {item ? <a key={item.id} href="#catalog" onClick={e => pick(e, item.category)}><span>{item.category.path?.slice(0, -1).join('\u00a0/ ') || 'Каталог'}</span><b>{item.category.label}</b><i>ДИВИТИСЬ ↗</i></a>
      : <span className="idle">{idle}</span>}
  </div>;
}

export default function FeaturedRail({ onCategory }) {
  const { getCategory } = useTaxonomy();
  // staff-chosen images replace shipped renders per category and slot. Images are not requested before
  // the settings answer (loadStorefrontSettings never rejects), so a replaced render is never downloaded twice.
  const [own, setOwn] = useState(null);
  useEffect(() => { let live = true; loadStorefrontSettings().then(d => { if (live) setOwn(d.storefrontImages || {}); }); return () => { live = false; }; }, []);
  const RAIL = useMemo(() => rackWithImages(SHIPPED, own), [own]);
  const narrow = useMedia('(max-width: 760px)'), touch = useMedia('(hover: none)');
  const rack = RAIL.rack;
  const rackStyle = { '--rack-ar': ar(rack), '--bar': rack.bar, '--post': rack.post, '--shelf': rack.shelf };
  // Only categories the live taxonomy knows; an unknown id would otherwise break the landing page.
  const withCategory = list => list.map(x => { const category = getCategory(x.categoryId); return category ? { ...x, id: x.categoryId, category } : null; }).filter(Boolean);
  const items = useMemo(() => withCategory(RAIL.clothes), [getCategory, RAIL]);
  const shoes = useMemo(() => withCategory(RAIL.shoes), [getCategory, RAIL]);
  const n = items.length;
  const compact = false;
  const reduced = useMedia('(prefers-reduced-motion: reduce)');
  const [active, setActive] = useState(null), [shoe, setShoe] = useState(null);
  // Phone: one piece on the bar and one pair on the shelf at a time.
  const [solo, setSolo] = useState({ top: 0, shoe: 0, dir: 1 });
  const railRef = useRef(null), pieceRefs = useRef([]), turnRefs = useRef([]), swingRefs = useRef([]), shadeRefs = useRef([]), drapeRefs = useRef([]);
  const sim = useRef({ x: [], vx: [], tx: [], turn: [], vturn: [], tturn: [], swing: [], vswing: [], raf: 0, last: 0, width: 0, card: 260, pointer: null });
  const activeRef = useRef(null);
  const blockRef = useRef(null);
  const [visible, setReady] = useState(() => typeof IntersectionObserver !== 'function');
  const ready = visible && own !== null;
  useEffect(() => {
    if (visible || !blockRef.current) return undefined;
    let near = false, settled = false, done = false;
    const go = () => { if (!done && near && settled) { done = true; setReady(true); } };
    const io = new IntersectionObserver(([entry]) => { near = entry.isIntersecting; go(); }, { rootMargin: '100% 0px' });
    io.observe(blockRef.current);
    const off = onHeroSettled(() => { settled = true; go(); });
    const timer = setTimeout(() => { settled = true; go(); }, 3000);
    return () => { io.disconnect(); off(); clearTimeout(timer); };
  }, [visible]);
  activeRef.current = active;

  // Lay out targets: the active piece opens to full width, neighbours part around it.
  const layout = useCallback(() => {
    const s = sim.current, W = s.width, card = s.card;
    if (!W || !n) return;
    const a = activeRef.current;
    const slot = i => a === null ? card * SIDE_SHOW : i === a ? card * 1.04 : Math.abs(i - a) === 1 ? card * SIDE_SHOW * 1.35 : card * SIDE_SHOW;
    let widths = items.map((_, i) => slot(i));
    const total = widths.reduce((t, w) => t + w, 0), room = W - 24;
    if (total > room) { const fixed = a === null ? 0 : widths[a], k = (room - fixed) / (total - fixed); widths = widths.map((w, i) => i === a ? w : w * k); }
    let cursor = (W - widths.reduce((t, w) => t + w, 0)) / 2;
    widths.forEach((w, i) => {
      s.tx[i] = cursor + w / 2; cursor += w;
      // Same turn direction on both sides, so a released piece never flips through face-on.
      s.tturn[i] = a === null ? idleTurn(i) : i === a ? 0 : i < a ? Math.min(76, idleTurn(i) + 12) : idleTurn(i) + 4;
    });
  }, [items, n]);

  const paint = useCallback(i => {
    const s = sim.current, el = pieceRefs.current[i];
    if (!el) return;
    el.style.transform = `translate3d(${(s.x[i] - s.card / 2).toFixed(2)}px,0,0)`;
    const turn = turnRefs.current[i];
    if (turn) { turn.style.transform = `perspective(1100px) rotateY(${s.turn[i].toFixed(2)}deg)`; turn.style.setProperty('--deg', Math.abs(s.turn[i]).toFixed(1)); }
    const swing = swingRefs.current[i];
    if (swing) swing.style.transform = `rotate(${s.swing[i].toFixed(3)}deg)`;
    const shade = shadeRefs.current[i];
    if (shade) shade.style.opacity = (Math.min(1, Math.abs(s.turn[i]) / 80) * 0.7).toFixed(3);
    // Fabric lags behind the hanger: skew the hem against the swing velocity.
    const drape = drapeRefs.current[i];
    if (drape) drape.style.transform = `skewX(${Math.max(-5, Math.min(5, -s.vswing[i] * 0.09)).toFixed(3)}deg)`;
  }, []);

  const step = useCallback(now => {
    const s = sim.current;
    const dt = s.last ? Math.min(0.034, (now - s.last) / 1000) : 1 / 60;
    s.last = now;
    let moving = false;
    for (let i = 0; i < n; i++) {
      // Springs: position and turn are near-critically damped, the hanger swing is loose.
      const ax = 170 * (s.tx[i] - s.x[i]) - 24 * s.vx[i];
      s.vx[i] += ax * dt; s.x[i] += s.vx[i] * dt;
      const at = 150 * (s.tturn[i] - s.turn[i]) - 21 * s.vturn[i];
      s.vturn[i] += at * dt; s.turn[i] += s.vturn[i] * dt;
      const as = -60 * s.swing[i] - 3.2 * s.vswing[i];
      s.vswing[i] += as * dt; s.swing[i] = Math.max(-8, Math.min(8, s.swing[i] + s.vswing[i] * dt));
      if (Math.abs(s.tx[i] - s.x[i]) > 0.1 || Math.abs(s.vx[i]) > 0.1 || Math.abs(s.tturn[i] - s.turn[i]) > 0.05 || Math.abs(s.vturn[i]) > 0.05 || Math.abs(s.swing[i]) > 0.02 || Math.abs(s.vswing[i]) > 0.02) moving = true;
      paint(i);
    }
    s.raf = moving ? requestAnimationFrame(step) : 0;
    if (!moving) s.last = 0;
  }, [n, paint]);

  const kick = useCallback(() => {
    const s = sim.current;
    if (reduced || compact) {
      for (let i = 0; i < n; i++) { s.x[i] = s.tx[i]; s.turn[i] = s.tturn[i]; s.swing[i] = 0; s.vx[i] = s.vturn[i] = s.vswing[i] = 0; paint(i); }
      return;
    }
    if (!s.raf) s.raf = requestAnimationFrame(step);
  }, [reduced, compact, n, paint, step]);

  // Measure the rail and seed the simulation.
  useLayoutEffect(() => {
    const el = railRef.current;
    if (!el || compact) return;
    const s = sim.current;
    const measure = () => {
      s.width = el.clientWidth;
      s.card = pieceRefs.current[0]?.offsetWidth || 120; // --card-w is a calc() of container units
      layout();
      for (let i = 0; i < n; i++) {
        if (s.x[i] === undefined) { s.x[i] = s.tx[i]; s.turn[i] = s.tturn[i]; s.swing[i] = (i % 2 ? 1 : -1) * 1.5; s.vx[i] = s.vturn[i] = s.vswing[i] = 0; }
      }
      kick();
    };
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => { ro.disconnect(); cancelAnimationFrame(s.raf); s.raf = 0; s.last = 0; };
  }, [n, compact, layout, kick, narrow]);

  useEffect(() => { if (!compact) { layout(); const s = sim.current; if (active !== null) s.vswing[active] += 40; kick(); } }, [active, compact, layout, kick]);


  function nearest(clientX) {
    const r = railRef.current.getBoundingClientRect(), x = clientX - r.left, s = sim.current;
    let best = 0, dist = Infinity;
    for (let i = 0; i < n; i++) { const d = Math.abs((s.tx[i] ?? 0) - x); if (d < dist) { dist = d; best = i; } }
    return best;
  }
  function onPointerMove(e) {
    if (compact || e.pointerType !== 'mouse') return;
    const s = sim.current, r = railRef.current.getBoundingClientRect(), x = e.clientX - r.left, now = performance.now();
    if (s.pointer && !reduced) {
      // "Run a hand along the rail": pieces near the pointer sway with its speed.
      const dtm = Math.max(4, Math.min(48, now - s.pointer.t)), v = (x - s.pointer.x) / dtm, rate = dtm / 16;
      for (let i = 0; i < n; i++) { const d = Math.abs((s.x[i] ?? 0) - x); if (d < s.card * 0.6) s.vswing[i] += Math.max(-30, Math.min(30, v * 9 * rate * (1 - d / (s.card * 0.6)))); }
      kick();
    }
    s.pointer = { x, t: now };
    const next = nearest(e.clientX);
    if (next !== activeRef.current) setActive(next);
  }
  function onPointerLeave(e) {
    if (compact || e.pointerType !== 'mouse') return;
    sim.current.pointer = null;
    if (!railRef.current?.contains(document.activeElement)) setActive(null);
  }

  const top = narrow ? items[solo.top] : active !== null ? items[active] : null;
  const bottom = narrow ? shoes[solo.shoe] : shoe !== null ? shoes[shoe] : null;
  const pick = (e, cat) => { if (onCategory) { e.preventDefault(); onCategory(cat.id); } };
  const rackImg = <img className="rail-rack-img" src={ready ? rack.src : undefined} width={rack.w} height={rack.h} alt="" aria-hidden="true" draggable={false} loading="lazy" fetchPriority="low" decoding="async"/>;

  // Its own landing block under the hero. Clothing and footwear captions are kept apart.
  return <RackImages.Provider value={ready}><section ref={blockRef} className={`rail-block${ready ? '' : ' is-deferred'}`} aria-label="Категорії на вішаку">
    <p className="rail-label"><span className="rail-led"/> КАТЕГОРІЇ</p>
    <Chip kind="top" item={top} pick={pick} idle={<><em>ОДЯГ</em>{touch ? 'Торкніться речі, щоб обрати категорію' : 'Наведіть на річ, щоб обрати категорію'}</>}/>
    <Chip kind="bottom" item={bottom} pick={pick} idle={<><em>ВЗУТТЯ</em>{touch ? 'Торкніться пари, щоб обрати категорію' : 'Наведіть на пару, щоб обрати категорію'}</>}/>
    {narrow ? <SoloStage items={items} shoes={shoes} solo={solo} setSolo={setSolo} rackImg={rackImg} rackStyle={rackStyle} pick={pick}/> :
    <div className="rail-stage" onPointerLeave={onPointerLeave} style={rackStyle}>
      {rackImg}
      {n > 0 &&
        <ul ref={railRef} className="rail-track" aria-label="Категорії одягу" onPointerMove={onPointerMove}>
          {items.map((p, i) => <li key={p.id} ref={el => { pieceRefs.current[i] = el; }} className={`rail-piece ${active === i ? 'is-active' : ''}`} style={{ zIndex: active === null ? i + 1 : active === i ? 50 : 40 - Math.abs(active - i) }}>
            <div ref={el => { swingRefs.current[i] = el; }} className="rail-swing">
              <a className="rail-card-link is-3d" href="#catalog" onClick={e => { if (touch && activeRef.current !== i) { e.preventDefault(); setActive(i); } else pick(e, p.category); }} onFocus={() => setActive(i)} onBlur={e => { if (!railRef.current?.contains(e.relatedTarget)) setActive(null); }} aria-label={`Категорія: ${p.category.label}`}>
                {/* The hanger is part of the render, so it turns with the garment. */}
                <span ref={el => { turnRefs.current[i] = el; }} className="rail-turn">
                  <Garment3D front={p.front} side={p.side} angle={p.angle} drapeRef={el => { drapeRefs.current[i] = el; }}/>
                </span>
              </a>
              <span className="rail-price-tag" aria-hidden="true"><i/>{p.category.label}</span>
            </div>
          </li>)}
        </ul>}
      {shoes.length > 0 && <ul className="rail-shelf" aria-label="Категорії взуття">
        {shoes.map((x, i) => <li key={x.id} className={`rail-shoe ${shoe === i ? 'is-active' : ''} ${x.flip ? 'is-flipped' : ''}`}>
          <a href="#catalog" aria-label={`Категорія: ${x.category.label}`}
            onPointerEnter={e => { if (e.pointerType === 'mouse') setShoe(i); }} onPointerLeave={e => { if (e.pointerType === 'mouse') setShoe(null); }}
            onFocus={() => setShoe(i)} onBlur={() => setShoe(null)}
            onClick={e => { if (touch && shoe !== i) { e.preventDefault(); setShoe(i); } else pick(e, x.category); }}>
            <Shoe x={x}/>
            <span className="rail-shoe-tag" aria-hidden="true">{x.category.label}</span>
          </a>
        </li>)}
      </ul>}
    </div>}
  </section></RackImages.Provider>;
}

// Phone stage: the same rack, one category on the bar and one on the shelf. Arrows or a swipe on each row
// change it; a tap opens the category.
function SoloStage({ items, shoes, solo, setSolo, rackImg, rackStyle, pick }) {
  const step = (row, d) => setSolo(v => {
    const len = row === 'top' ? items.length : shoes.length;
    return len ? { ...v, [row]: (v[row] + d + len) % len, dir: d } : v;
  });
  const swipe = row => {
    let x0 = null;
    return {
      onPointerDown: e => { x0 = e.clientX; },
      onPointerUp: e => { if (x0 !== null && Math.abs(e.clientX - x0) > 36) step(row, e.clientX < x0 ? 1 : -1); x0 = null; },
      onPointerCancel: () => { x0 = null; },
    };
  };
  const p = items[solo.top], x = shoes[solo.shoe];
  const arrows = (row, label) => <>
    <button type="button" className="solo-arrow is-prev" aria-label={`Попередня категорія: ${label}`} onClick={() => step(row, -1)}>‹</button>
    <button type="button" className="solo-arrow is-next" aria-label={`Наступна категорія: ${label}`} onClick={() => step(row, 1)}>›</button>
  </>;
  return <div className="rail-stage is-solo" style={rackStyle}>
    {rackImg}
    {p && <div className="solo-row solo-top" {...swipe('top')}>
      <a key={p.id} className={`solo-piece ${solo.dir < 0 ? 'from-left' : ''} is-3d`} href="#catalog" onClick={e => pick(e, p.category)} aria-label={`Категорія: ${p.category.label}`} draggable={false}>
        <span className="rail-turn" style={{ transform: 'none', '--deg': 0 }}><Garment3D front={p.front} side={p.side} angle={p.angle}/></span>
        <span className="rail-price-tag" aria-hidden="true"><i/>{p.category.label}</span>
      </a>
      {items.length > 1 && arrows('top', 'одяг')}
    </div>}
    {x && <div className="solo-row solo-shelf" {...swipe('shoe')}>
      <a key={x.id} className={`solo-shoe ${solo.dir < 0 ? 'from-left' : ''}`} href="#catalog" onClick={e => pick(e, x.category)} aria-label={`Категорія: ${x.category.label}`} draggable={false}>
        <Shoe x={x}/>
        <span className="rail-shoe-tag" aria-hidden="true">{x.category.label}</span>
      </a>
      {shoes.length > 1 && arrows('shoe', 'взуття')}
    </div>}
  </div>;
}
