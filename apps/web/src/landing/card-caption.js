import { inStockSizes } from '../cart/cart-store.js';
import { formatPrice } from '../../../../packages/catalog/price.js';

/** Card-only caption facts: price label without ",00" and sold-out state (no in-stock size). Preview cards never show sold-out. */
export function cardCaption(product, { preview = false } = {}) {
  return {
    priceLabel: formatPrice(product?.priceMinor),
    soldOut: !preview && inStockSizes(product?.variants).length === 0,
  };
}
