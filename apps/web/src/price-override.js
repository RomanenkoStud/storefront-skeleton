// UAH <-> kopecks helpers for the manager retail price override. Pure integer math, no floats.
export const MAX_OVERRIDE_MINOR = 100000000; // 1 000 000 UAH
export const PRICE_ERRORS = {
  format: 'Введіть ціну числом у гривнях, наприклад 1299 або 1299,50.',
  decimals: 'Ціна може мати не більше двох знаків після коми.',
  positive: 'Ціна має бути більшою за нуль. Щоб прибрати ручну ціну, натисніть «Скинути до розрахункової ціни».',
  max: 'Ціна не може перевищувати 1 000 000 ₴.',
};

// Returns {ok:true, minor:number|null} (empty => null = no override) or {ok:false, error}.
export function parsePriceInput(raw) {
  const text = String(raw ?? '').replace(/[\s  ]/g, '').replace(',', '.');
  if (text === '') return { ok: true, minor: null };
  if (/^-/.test(text)) return { ok: false, error: PRICE_ERRORS.positive };
  const m = /^(\d+)(?:\.(\d*))?$/.exec(text);
  if (!m || (m[2] !== undefined && m[2] === '')) return { ok: false, error: PRICE_ERRORS.format };
  const frac = m[2] || '';
  if (frac.length > 2) return { ok: false, error: PRICE_ERRORS.decimals };
  const whole = m[1].replace(/^0+(?=\d)/, '');
  if (whole.length > 7) return { ok: false, error: PRICE_ERRORS.max };
  const minor = Number(whole) * 100 + Number(frac.padEnd(2, '0'));
  if (minor <= 0) return { ok: false, error: PRICE_ERRORS.positive };
  if (minor > MAX_OVERRIDE_MINOR) return { ok: false, error: PRICE_ERRORS.max };
  return { ok: true, minor };
}

// Kopecks -> editable UAH string ('' for none). 129950 -> '1299.50', 129900 -> '1299'.
export function minorToInput(minor) {
  if (!Number.isSafeInteger(minor) || minor <= 0) return '';
  const whole = Math.trunc(minor / 100), frac = minor % 100;
  return frac ? `${whole}.${String(frac).padStart(2, '0')}` : String(whole);
}

// Patch value: undefined = unchanged (omit), number = set, null = reset.
export function overridePatchValue(loadedMinor, inputMinor) {
  const loaded = Number.isSafeInteger(loadedMinor) ? loadedMinor : null;
  return loaded === inputMinor ? undefined : inputMinor;
}
