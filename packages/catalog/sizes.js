// Size label normalization shared by the storefront filters and the merged duplicate listing.
// Returns a canonical key for recognised numeric/alpha sizes, or null for anything else.
export function normalizeSize(value) {
  const text = String(value || '').trim().toUpperCase()
    .replace(/[МХС]/g, c => ({'М':'M','Х':'X','С':'S'}[c]))
    .replace(/[‐‑‒–—−]/g, '-').replace(/(\d),(?=\d)/g, '$1.')
    .replace(/^(?:EUR|EU)\s*:?[ ]*/, '');
  const numeric = text.match(/^(\d{2}(?:\.\d+)?)(?:\s*([/-])\s*(\d{2}(?:\.\d+)?))?(?=$|[\s(])/);
  if (numeric) return numeric[1] + (numeric[2] ? numeric[2] + numeric[3] : '');
  const alpha = '(?:XXXS|XXS|XS|S|M|L|XL|XXL|XXXL|[2-6]XL)';
  const matched = text.match(new RegExp(`^(${alpha})(?:\\s*([/-])\\s*(${alpha}))?(?=$|[\\s(])`));
  return matched ? matched[1] + (matched[2] ? matched[2] + matched[3] : '') : null;
}
/** Merge key for a size label: the normalized size, or the trimmed upper-case label when not recognised. */
export const sizeMergeKey = value => normalizeSize(value) ?? String(value || '').trim().toUpperCase();
