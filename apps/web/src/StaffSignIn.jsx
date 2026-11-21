import React, {useState} from 'react';
import {api} from './api.js';
import {Brand, Notice} from './ui.jsx';
export const staffReasonMessages = {
  invalid: 'Не вдалося перевірити вхід. Спробуйте ще раз.',
  expired: 'Час для входу минув. Почніть вхід ще раз.',
  denied: 'Вхід через Google скасовано.',
  not_allowed: 'Для цього Google-акаунта немає чинного запрошення. Зверніться до власника.',
  mismatch: 'Оберіть той самий Google-акаунт, який використовували для входу.'
};
export async function startStaffSignIn(intent = 'login') {
  // The OAuth callback always lands on /staff; remember the tool URL so the console can reopen it.
  try { const path = window.location.pathname; if (path.startsWith('/staff/')) sessionStorage.setItem('ls_staff_return', path); } catch {}
  const result = await api('/api/staff/google/start', {method:'POST', body:{intent}});
  window.location.assign(result.authorizationUrl);
}
export default function StaffSignIn({error: initialError}) {
  const [busy, setBusy] = useState(false), [error,setError] = useState(initialError || '');
  const params = new URLSearchParams(window.location.search);
  if (params.get('status') === 'error') { try { sessionStorage.removeItem('ls_staff_return'); } catch {} }
  async function signIn(){setBusy(true);setError('');try{await startStaffSignIn();}catch(e){setError(e.message);setBusy(false);}}
  return <main className="login-page"><div className="login-card"><Brand on="light"/><p className="eyebrow">КОМАНДА LOREM STORE</p><h1>Вхід для команди</h1><p>Увійдіть Google-акаунтом, на який власник надав запрошення.</p>{params.get('status')==='error'&&<Notice>{staffReasonMessages[params.get('reason')] || staffReasonMessages.invalid}</Notice>}{error&&<Notice>{error}</Notice>}<button className="button primary full" disabled={busy} onClick={signIn}>{busy?'Відкриваємо Google…':'Увійти через Google'}</button><p>Клієнтський акаунт магазину не надає доступу до кабінету команди.</p><a href="/admin">Вхід власника через Cloudflare Access</a><p><a href="/">← До магазину</a></p></div></main>;
}
