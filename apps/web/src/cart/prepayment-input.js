// admin «Передоплата» input (UAH) -> integer kopecks. Pure integer math via parsePriceInput; '' or 0 means hidden (0).
import { parsePriceInput } from '../price-override.js';

export const PREPAYMENT_MAX_MINOR = 10000000; // 100 000 UAH, the server limit (storefront-settings.js)
export const PREPAYMENT_ERRORS = {
  format: 'Введіть суму числом у гривнях, наприклад 200 або 199,50.',
  decimals: 'Сума може мати не більше двох знаків після коми.',
  max: 'Передоплата не може перевищувати 100 000 ₴.',
};
/** {ok:true, minor} (0 = hidden) or {ok:false, error}. */
export function parsePrepaymentInput(raw) {
  const text = String(raw ?? '').replace(/[\s  ]/g, '');
  if (text === '' || /^0+(?:[.,]0{0,2})?$/.test(text)) return { ok: true, minor: 0 };
  const parsed = parsePriceInput(text);
  if (!parsed.ok) return { ok: false, error: /знаків/.test(parsed.error) ? PREPAYMENT_ERRORS.decimals : /перевищувати/.test(parsed.error) ? PREPAYMENT_ERRORS.max : PREPAYMENT_ERRORS.format };
  if (parsed.minor > PREPAYMENT_MAX_MINOR) return { ok: false, error: PREPAYMENT_ERRORS.max };
  return { ok: true, minor: parsed.minor };
}
