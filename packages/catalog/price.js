/**
 * Format a price given in minor units (kopecks) as "1 750 грн" or "1 750,50 грн".
 * Groups digits by threes with U+00A0 and uses U+00A0 before "грн". Integer
 * arithmetic only (no Intl) so Node and workerd agree. Non-integer input is
 * rounded; null/undefined/NaN count as 0; negatives get a "-" prefix.
 */
export function formatPrice(minor) {
  let n = Math.round(Number(minor));
  if (!Number.isFinite(n)) n = 0;
  const sign = n < 0 ? '-' : '';
  n = Math.abs(n);
  const hryvnias = Math.floor(n / 100);
  const kopecks = n % 100;
  const grouped = String(hryvnias).replace(/\B(?=(\d{3})+(?!\d))/g, ' ');
  const frac = kopecks ? `,${String(kopecks).padStart(2, '0')}` : '';
  return `${sign}${grouped}${frac} грн`;
}
