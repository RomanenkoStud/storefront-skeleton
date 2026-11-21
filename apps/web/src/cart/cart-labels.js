// Pure labels for the header cart button (Ukrainian plural rules).
export function pluralItems(n) {
  const mod10 = n % 10, mod100 = n % 100;
  if (mod10 === 1 && mod100 !== 11) return 'товар';
  if (mod10 >= 2 && mod10 <= 4 && (mod100 < 12 || mod100 > 14)) return 'товари';
  return 'товарів';
}
export const cartLabel = count => (count > 0 ? `Кошик, ${count} ${pluralItems(count)}` : 'Кошик');
/** Badge text: hidden at 0, "9+" above 9. */
export const badgeText = count => (count > 9 ? '9+' : count > 0 ? String(count) : '');
