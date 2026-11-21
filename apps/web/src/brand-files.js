// Plain module (no JSX) so node tests can resolve every logo src Brand() can render.
export const BRAND_FILES = {
  full: { file: 'logo-b1', width: 120, height: 61 },
  compact: { file: 'logo-s1', width: 64, height: 35 },
  mark: { file: 'mark-n1', width: 48, height: 48 },
};
export function brandSrc(variant = 'full', on = 'dark') {
  const v = BRAND_FILES[variant] ? variant : 'full';
  const { file } = BRAND_FILES[v];
  return v === 'mark' ? `/brand/${file}${on === 'dark' ? '-dark' : ''}.svg` : `/brand/${file}-${on === 'light' ? 'light' : 'dark'}.svg`;
}
