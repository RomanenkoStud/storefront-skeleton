// Rendered by Storefront on the home page and on the SPA product view. Production /products/<slug> is served by the Worker page (product-page.js), which renders neither this band nor the footer.
// Only facts the code supports: the cart's Nova Poshta picker (branch or parcel locker, see
// delivery/np-picker-logic.js KINDS) and the manager confirming by cart code (cart/CartPage.jsx).
// The policy texts below are placeholders: replace them with the store's own delivery, payment and exchange terms.
import React from 'react';

function Glyph({ children }) {
  return <svg className="delivery-glyph" width="26" height="26" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" focusable="false">{children}</svg>;
}

export default function DeliveryBand() {
  return <section id="delivery" className="delivery-band" aria-labelledby="delivery-title">
    <h2 id="delivery-title" className="delivery-title">Як замовити</h2>
    <ul className="delivery-facts">
      <li className="delivery-fact"><Glyph><path d="M2 6h11v9H2zM13 9h4l3 3v3h-7z"/><circle cx="6.5" cy="17" r="1.6"/><circle cx="16.5" cy="17" r="1.6"/></Glyph><h3>Доставка</h3><p>Нова пошта, відділення або поштомат. Лорем іпсум — тестовий текст доставки.</p></li>
      <li className="delivery-fact"><Glyph><path d="M4 5h16v11H9l-5 4z"/></Glyph><h3>Менеджер підтверджує</h3><p>Надсилаєте код кошика. Менеджер підтверджує наявність і доставку.</p></li>
      <li className="delivery-fact"><Glyph><path d="M3 12V4h8l9 9-8 8z"/><circle cx="7.5" cy="8.5" r="1"/></Glyph><h3>Оплата</h3><p>Долор сіт амет — тестовий текст умов оплати.</p></li>
      <li className="delivery-fact"><Glyph><path d="M20 12a8 8 0 1 1-2.6-5.9M20 4v4h-4"/></Glyph><h3>Обмін</h3><p>Консектетур адипісці — тестовий текст умов обміну.</p></li>
    </ul>
  </section>;
}
