import React, { useEffect, useState } from 'react';
import { Icon } from '../ui.jsx';
import { fetchSession } from './account-api.js';
import { customerHandle } from './account-helpers.js';

/** Header entry. Always points to /account, never to the manager area. */
export default function AccountLink({ session: override = null, variant = 'icon' }) {
  const [own, setOwn] = useState(null), session = override || own;
  useEffect(() => { if (override) return undefined; let active = true; fetchSession().then(s => active && setOwn(s)); return () => { active = false; }; }, [override]);
  const signedIn = session?.authenticated === true;
  const handle = signedIn ? customerHandle(session.customer) : '';
  const text = signedIn ? 'Кабінет' : session ? 'Увійти' : 'Акаунт';
  const label = signedIn ? `Кабінет: ${handle}` : text;
  return variant === 'text'
    ? <a className="account-link account-link-text" href="/account" aria-label={label}>{text}</a>
    : <a className="account-link hdr-tool" href="/account" aria-label={label}><Icon name="tool-account" size={22}/></a>;
}
