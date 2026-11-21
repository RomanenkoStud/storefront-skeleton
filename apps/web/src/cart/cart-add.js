import { cartStore, isAddOk } from './cart-store.js';
import { ADD_STATUS_TEXT } from './cart-api.js';

/** Adds one unit and describes the outcome for a live region. `store` is injectable for tests. */
export function addWithFeedback(product, size, store = cartStore) {
  if (!size) return { ok: false, status: 'invalid', text: 'Оберіть розмір.' };
  const { status } = store.addProduct(product, size, 1);
  const ok = isAddOk(status);
  const note = ok && !store.isPersistent() ? ' Кошик не збережеться після закриття вкладки.' : '';
  return { ok, status, text: (ADD_STATUS_TEXT[status] || ADD_STATUS_TEXT.invalid) + note };
}
