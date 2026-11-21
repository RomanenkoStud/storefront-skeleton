// sale banner in the top announcement bar (e.g. «BLACK FRIDAY · БЕЗКОШТОВНА ДОСТАВКА»).
// Off by default; an optional start/end window is entered in the browser's local time and stored as ISO.
import React, { useState } from 'react';
import { api, date } from './api.js';
import { Notice } from './ui.jsx';
import { toLocalInput, fromLocalInput } from './landing/storefront-images.js';

export const TEXT_MAX = 90, LABEL_MAX = 30;
export function bannerState(banner, now = Date.now()) {
  if (!banner?.enabled) return 'Вимкнено: на сайті звичайний верхній рядок.';
  if (banner.startsAt && Date.parse(banner.startsAt) > now) return `Заплановано: з’явиться ${date(banner.startsAt)}.`;
  if (banner.endsAt && Date.parse(banner.endsAt) <= now) return 'Завершено: час показу минув, на сайті звичайний верхній рядок.';
  return `Показується зараз${banner.endsAt ? ` до ${date(banner.endsAt)}` : ''}.`;
}

export default function BannerSettings({ initial, meta: initialMeta, editable }) {
  const from = b => ({ enabled: !!b?.enabled, text: b?.text || '', linkLabel: b?.linkLabel || '', linkHref: b?.linkHref || '', startsAt: toLocalInput(b?.startsAt), endsAt: toLocalInput(b?.endsAt) });
  const [form, setForm] = useState(() => from(initial)), [stored, setStored] = useState(initial), [meta, setMeta] = useState(initialMeta);
  const [busy, setBusy] = useState(false), [error, setError] = useState(''), [saved, setSaved] = useState('');
  const update = patch => { setForm({ ...form, ...patch }); setSaved(''); };
  async function save(event) {
    event.preventDefault(); setBusy(true); setError('');
    try {
      const body = { enabled: form.enabled, text: form.text.trim(), linkLabel: form.linkLabel.trim(), linkHref: form.linkHref.trim(), startsAt: fromLocalInput(form.startsAt), endsAt: fromLocalInput(form.endsAt) };
      const d = await api('/api/admin/storefront/banner', { method: 'PUT', body });
      setForm(from(d.banner)); setStored(d.banner); setMeta({ updatedAt: d.bannerUpdatedAt, actor: d.bannerActor });
      setSaved('Збережено. Головна сторінка покаже зміни після оновлення.');
    } catch (e) { setError(e.message); } finally { setBusy(false); }
  }
  return <section className="panel storefront-settings banner-settings" aria-labelledby="banner-settings-title">
    <h2 id="banner-settings-title">Акційний банер угорі</h2>
    <p className="section-subtitle">Лаймовий рядок над шапкою сайту замість стандартного оголошення, наприклад «BLACK FRIDAY · БЕЗКОШТОВНА ДОСТАВКА». {bannerState(stored)}{meta?.updatedAt ? ` Змінено ${date(meta.updatedAt)}${meta.actor ? ` · ${meta.actor}` : ''}.` : ''}</p>
    {error && <Notice onClose={() => setError('')}>{error}</Notice>}
    {saved && <Notice type="info" onClose={() => setSaved('')}>{saved}</Notice>}
    <form onSubmit={save}><fieldset disabled={!editable || busy}>
      <label className="storefront-mode"><input type="checkbox" checked={form.enabled} onChange={e => update({ enabled: e.target.checked })}/><span><strong>Показувати банер</strong></span></label>
      <label className="field"><span>Текст (до {TEXT_MAX} символів)</span><input value={form.text} maxLength={TEXT_MAX} onChange={e => update({ text: e.target.value })} placeholder="BLACK FRIDAY · БЕЗКОШТОВНА ДОСТАВКА"/></label>
      <div className="banner-link">
        <label className="field"><span>Текст посилання (необов’язково)</span><input value={form.linkLabel} maxLength={LABEL_MAX} onChange={e => update({ linkLabel: e.target.value })} placeholder="ДИВИТИСЬ"/></label>
        <label className="field"><span>Адреса на сайті, з «/»</span><input value={form.linkHref} maxLength={200} onChange={e => update({ linkHref: e.target.value })} placeholder="/?available=1#catalog"/></label>
      </div>
      <div className="banner-window">
        <label className="field"><span>Показувати з (необов’язково)</span><input type="datetime-local" value={form.startsAt} onChange={e => update({ startsAt: e.target.value })}/></label>
        <label className="field"><span>До (необов’язково)</span><input type="datetime-local" value={form.endsAt} onChange={e => update({ endsAt: e.target.value })}/></label>
      </div>
      <p className="storefront-preview" aria-live="polite"><strong>Перегляд:</strong> <span className="banner-preview">{form.text.trim() || 'додайте текст'}{form.linkLabel.trim() && form.linkHref.trim() ? ` ${form.linkLabel.trim()} →` : ''}</span></p>
      {editable && <button className="button primary" type="submit">{busy ? 'Зберігаємо…' : 'Зберегти'}</button>}
    </fieldset></form>
  </section>;
}
