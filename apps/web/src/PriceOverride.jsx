import React from 'react';
import { Field } from './ui.jsx';
import { parsePriceInput } from './price-override.js';

const uah = minor => Number.isFinite(minor) ? `${(minor / 100).toLocaleString('uk-UA', { minimumFractionDigits: 2, maximumFractionDigits: 2 })} ₴` : '—';

// Manager retail price override. Estimates only: the server validates and stores the real price.
export default function PriceOverride({ value, onChange, canEdit, supplierMinor, computedMinor, loadedOverrideMinor }) {
  const parsed = parsePriceInput(value);
  const overridden = parsed.ok && parsed.minor != null;
  const effective = overridden ? parsed.minor : computedMinor;
  return <section className="price-override" aria-label="Ціна товару">
    <div className="subsection-heading">Ціна на сайті {overridden && <span className="price-override-badge">Ручна ціна</span>}</div>
    <div className="price-breakdown">
      <span>Ціна постачальника <strong>{uah(supplierMinor)}</strong></span>
      <span>Розрахункова (закупівля + націнка) <strong>{uah(computedMinor)}</strong></span>
      <span>Діюча ціна <strong>{uah(effective)}</strong></span>
    </div>
    {canEdit ? <>
      <Field label="Ручна ціна, ₴" hint="Залиште порожнім, щоб використовувати розрахункову ціну. Дані EasyDrop вже містять націнку постачальника.">
        <input type="text" inputMode="decimal" autoComplete="off" placeholder={uah(computedMinor).replace(' ₴', '')} value={value} aria-invalid={!parsed.ok} aria-describedby={parsed.ok ? undefined : 'price-override-error'} onChange={e => onChange(e.target.value)}/>
      </Field>
      {!parsed.ok && <p id="price-override-error" className="inline-error" role="alert">{parsed.error}</p>}
      <button type="button" className="button small secondary" disabled={value === '' && loadedOverrideMinor == null} onClick={() => onChange('')}>Скинути до розрахункової ціни</button>
      <p className="field-help">Це оцінка: остаточну ціну перевіряє сервер після збереження.</p>
    </> : <p className="field-help">{overridden ? 'Для цього товару встановлена ручна ціна. ' : ''}Змінювати ціну може лише менеджер із правом «ціни».</p>}
  </section>;
}
