import React, { useCallback, useEffect, useRef, useState } from 'react';
import { Brand, Icon } from '../ui.jsx';
import AccountLink from '../account/AccountLink.jsx';
import CartLink from '../cart/CartLink.jsx';
import { fetchSession } from '../account/account-api.js';
import { SEARCH_ID, SEARCH_HREF, searchAction, wantsSearchFocus, condensedVisible, nextMenu } from './header-helpers.js';

/** The single logo slot used by the full and the condensed bar: B1 in the full header, S1 in the sticky bar. */
export function HeaderLogo({ variant = 'full' }) {
  return <Brand variant={variant} on="dark"/>;
}

const reduced = () => typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches;

function Menu({ id, open, panelRef, onNavigate, session }) {
  return <div id={id} ref={panelRef} className="hdr-menu" role="navigation" aria-label="Головна навігація" hidden={!open}>
    <a href="/#catalog" onClick={onNavigate}>Каталог</a>
    <a href="/#delivery" onClick={onNavigate}>Доставка й обмін</a>
    <AccountLink session={session} variant="text"/>
  </div>;
}

function Bar({ name, menuOpen, onMenu, onSearch, session, menuProps }) {
  const id = `site-menu-${name}`;
  return <>
    <button type="button" className="hdr-menu-btn" aria-label="Меню" aria-expanded={menuOpen} aria-controls={id} onClick={onMenu}><Icon name="tool-menu" size={22}/></button>
    <Menu id={id} open={menuOpen} session={session} {...menuProps}/>
    <div className="hdr-left"><HeaderLogo variant={name === 'bar' ? 'compact' : 'full'}/><nav className="hdr-links" aria-label={name === 'bar' ? 'Закріплена навігація' : 'Головна навігація'}><a href="/#catalog">Каталог</a><a href="/#delivery">Доставка й обмін</a></nav></div>
    <div className="hdr-tools">
      <a className="hdr-tool search-link" href={SEARCH_HREF} aria-label="Пошук" onClick={onSearch}><Icon name="tool-search" size={22}/></a>
      <AccountLink session={session}/>
      <CartLink/>
    </div>
  </>;
}

/** Site header. On the home page (a .hero is present) a condensed 56px bar pins once the hero has scrolled away. */
export default function SiteHeader({ session: given = null }) {
  const [own, setOwn] = useState(null), session = given || own;
  const [menu, setMenu] = useState(null), [stuck, setStuck] = useState(false), [pinnable, setPinnable] = useState(false);
  const buttons = useRef({}), panels = useRef({}), root = useRef(null);

  useEffect(() => { if (given) return undefined; let active = true; fetchSession().then(s => active && setOwn(s)); return () => { active = false; }; }, [given]);

  useEffect(() => {
    const hero = document.querySelector('.storefront .hero');
    if (!hero || typeof IntersectionObserver !== 'function') return undefined;
    const io = new IntersectionObserver(([entry]) => setStuck(condensedVisible(entry)), { threshold: 0 });
    setPinnable(true); io.observe(hero);
    return () => io.disconnect();
  }, []);
  useEffect(() => { setMenu(null); }, [stuck]);

  useEffect(() => {
    if (wantsSearchFocus(location.pathname, location.hash)) document.getElementById(SEARCH_ID)?.focus({ preventScroll: true });
  }, []);

  useEffect(() => {
    if (!menu) return undefined;
    panels.current[menu]?.querySelector('a')?.focus();
    const onKey = e => { if (e.key === 'Escape') { setMenu(null); buttons.current[menu]?.focus(); } };
    const onDown = e => { if (!root.current?.contains(e.target)) setMenu(null); };
    const onResize = () => { if (!matchMedia('(max-width: 650px)').matches) setMenu(null); };
    document.addEventListener('keydown', onKey); document.addEventListener('pointerdown', onDown); window.addEventListener('resize', onResize);
    const close = () => setMenu(null);
    window.addEventListener('popstate', close); window.addEventListener('hashchange', close);
    return () => { document.removeEventListener('keydown', onKey); document.removeEventListener('pointerdown', onDown); window.removeEventListener('resize', onResize); window.removeEventListener('popstate', close); window.removeEventListener('hashchange', close); };
  }, [menu]);

  const onSearch = useCallback(e => {
    const input = document.getElementById(SEARCH_ID);
    if (searchAction(location.pathname, !!input) !== 'focus') return;
    e.preventDefault(); setMenu(null);
    input.scrollIntoView({ behavior: reduced() ? 'auto' : 'smooth', block: 'center' });
    input.focus({ preventScroll: true });
  }, []);
  const onBlur = e => { if (menu && e.relatedTarget && !root.current?.contains(e.relatedTarget)) setMenu(null); };
  const bar = name => ({
    name, session, onSearch, menuOpen: menu === name, onMenu: () => setMenu(nextMenu(menu, name)),
    menuProps: { panelRef: el => { panels.current[name] = el; }, onNavigate: () => setMenu(null) },
  });
  const ref = name => el => { buttons.current[name] = el?.querySelector('.hdr-menu-btn'); };

  return <div ref={root} className="site-header" onBlur={onBlur}>
    <header className="store-header" ref={ref('header')}><Bar {...bar('header')}/></header>
    {pinnable && <div className={`store-bar${stuck ? ' is-on' : ''}`} ref={ref('bar')}><Bar {...bar('bar')}/></div>}
  </div>;
}
