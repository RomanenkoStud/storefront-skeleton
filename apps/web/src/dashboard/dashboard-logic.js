// Pure formatting and derivation helpers for the dashboard and infrastructure panels.
const nf = new Intl.NumberFormat('uk-UA');
export const count = value => (Number.isFinite(value) ? nf.format(value) : '—');
export const percent = (value, digits = 0) => (Number.isFinite(value) ? `${(value * 100).toFixed(digits).replace('.', ',')}%` : '—');
export const uah = minor => (Number.isFinite(minor) ? new Intl.NumberFormat('uk-UA', { style: 'currency', currency: 'UAH', maximumFractionDigits: 0 }).format(minor / 100) : '—');
export const usd = value => (Number.isFinite(value) ? new Intl.NumberFormat('uk-UA', { style: 'currency', currency: 'USD', minimumFractionDigits: 2 }).format(value) : '—');
export const money = (minor, currency = 'UAH') => (Number.isFinite(minor) ? new Intl.NumberFormat('uk-UA', { style: 'currency', currency, maximumFractionDigits: 2 }).format(minor / 100) : '—');

/** 0 -> "0 с", 75 -> "1 хв 15 с", 3700 -> "1 год 1 хв". */
export function duration(seconds) {
  if (!Number.isFinite(seconds) || seconds < 0) return '—';
  const s = Math.round(seconds), h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), r = s % 60;
  if (h) return `${h} год ${m} хв`;
  if (m) return r ? `${m} хв ${r} с` : `${m} хв`;
  return `${r} с`;
}

const UNITS = ['Б', 'КБ', 'МБ', 'ГБ', 'ТБ'];
/** Decimal units, as Cloudflare bills them: 1 ГБ = 10^9 bytes. */
export function bytes(value) {
  if (!Number.isFinite(value)) return '—';
  let v = value, i = 0;
  while (v >= 1000 && i < UNITS.length - 1) { v /= 1000; i++; }
  return `${i === 0 ? v : v.toFixed(v >= 100 ? 0 : v >= 10 ? 1 : 2).replace('.', ',')} ${UNITS[i]}`;
}
/** Short magnitudes for usage meters: 12 500 000 -> "12,5 млн". */
export function compact(value) {
  if (!Number.isFinite(value)) return '—';
  const abs = Math.abs(value);
  const fmt = (v, unit) => `${(Math.round(v * 10) / 10).toString().replace('.', ',')} ${unit}`;
  if (abs >= 1e9) return fmt(value / 1e9, 'млрд');
  if (abs >= 1e6) return fmt(value / 1e6, 'млн');
  if (abs >= 1e4) return fmt(value / 1e3, 'тис.');
  return nf.format(value);
}
export const usageValue = (value, unit) => (unit === 'bytes' ? bytes(value) : unit === 'ms' ? `${compact(value)} мс` : compact(value));

let regionNames = null;
export function countryName(code) {
  if (!code) return 'Невідомо';
  try { regionNames ??= new Intl.DisplayNames(['uk'], { type: 'region' }); return regionNames.of(code) || code; } catch { return code; }
}
export const DEVICE_LABELS = { mobile: 'Телефон', tablet: 'Планшет', desktop: 'Комп’ютер' };
export const KIND_LABELS = { domain: 'Домен', subscription: 'Підписка', other: 'Інше' };

/** "20.11" from YYYY-MM-DD. */
export const shortDay = day => (typeof day === 'string' && day.length === 10 ? `${day.slice(8, 10)}.${day.slice(5, 7)}` : '');
export const longDay = day => (typeof day === 'string' && day.length === 10 ? `${day.slice(8, 10)}.${day.slice(5, 7)}.${day.slice(0, 4)}` : '—');

/** Share of a limit used, clamped to [0, 1], or null when either side is unknown. */
export const share = (used, limit) => (Number.isFinite(used) && Number.isFinite(limit) && limit > 0 ? Math.min(1, Math.max(0, used / limit)) : null);
/** Meter tone: ok < 70%, warning < 90%, critical from 90%. */
export const meterTone = fraction => (fraction === null ? 'unknown' : fraction >= 0.9 ? 'critical' : fraction >= 0.7 ? 'warning' : 'ok');

/** Reminder state for a renewal relative to `today` (YYYY-MM-DD). */
export function renewalState(dueDate, today) {
  if (!dueDate) return { tone: 'warning', label: 'Дату не вказано', daysLeft: null };
  const daysLeft = Math.round((Date.parse(dueDate) - Date.parse(today)) / 86400000);
  if (daysLeft < 0) return { tone: 'critical', label: `Прострочено на ${-daysLeft} дн.`, daysLeft };
  if (daysLeft === 0) return { tone: 'critical', label: 'Сьогодні', daysLeft };
  if (daysLeft <= 14) return { tone: 'critical', label: `Через ${daysLeft} дн.`, daysLeft };
  if (daysLeft <= 30) return { tone: 'warning', label: `Через ${daysLeft} дн.`, daysLeft };
  return { tone: 'ok', label: `Через ${daysLeft} дн.`, daysLeft };
}

/** Nice axis maximum and 3-4 ticks for a non-negative series. */
export function niceScale(max) {
  if (!Number.isFinite(max) || max <= 0) return { max: 1, ticks: [0, 1] };
  const raw = max / 4, power = 10 ** Math.floor(Math.log10(raw)), step = [1, 2, 2.5, 5, 10].map(f => f * power).find(s => s >= raw);
  const top = Math.ceil(max / step) * step, ticks = [];
  for (let v = 0; v <= top + step / 2; v += step) ticks.push(Math.round(v * 1e6) / 1e6);
  return { max: top, ticks };
}

/** Parses a UAH amount typed by a person ("1 200,50") into kopecks, or null for empty, or NaN for invalid. */
export function parseAmount(text) {
  const clean = String(text ?? '').replace(/[\s ]/g, '').replace(',', '.');
  if (!clean) return null;
  if (!/^\d{1,8}(\.\d{1,2})?$/.test(clean)) return NaN;
  return Math.round(Number(clean) * 100);
}
