import React from 'react';
import { Brand } from '../ui.jsx';
import { useTaxonomy } from '../TaxonomyContext.jsx';

// Top-level categories come from the already loaded taxonomy (no extra API call).
// No contact or privacy links yet: no published contact exists and docs/legal/privacy-notice.uk.md is an unpublished draft.
export default function SiteFooter() {
  const { tree } = useTaxonomy();
  const roots = tree.filter(node => node.id !== 'unclassified');
  return <footer className="store-footer site-footer"><div className="site-footer-inner">
    <div className="site-footer-cols">
      {/* Logo slot: wave 3 swaps the mark here. Keep the wrapper. */}
      <div className="site-footer-brand"><div className="site-footer-logo" data-slot="footer-logo"><Brand/></div><p className="site-footer-tag">ЛОРЕМ ІПСУМ<br/>ТЕСТОВИЙ СЛОГАН</p></div>
      <nav aria-labelledby="footer-catalog-title"><h2 id="footer-catalog-title">Магазин</h2><ul>
        <li><a href="/#catalog">Усі товари</a></li>
        {roots.map(node => <li key={node.id}><a href={`/?category=${encodeURIComponent(node.id)}#catalog`}>{node.label}</a></li>)}
      </ul></nav>
      <div className="site-footer-col" role="group" aria-labelledby="footer-delivery-title"><h2 id="footer-delivery-title">Доставка й обмін</h2>
        <p>Лорем іпсум — тестовий текст доставки.</p>
        <p>Долор сіт амет — тестовий текст оплати.</p>
        <p>Консектетур — тестовий текст обміну.</p>
        <p><a href="/#delivery">Докладніше</a></p></div>
      <nav aria-labelledby="footer-buyer-title"><h2 id="footer-buyer-title">Покупцю</h2><ul>
        <li><a href="/cart">Кошик</a></li>
        <li><a href="/account">Особистий кабінет</a></li>
      </ul></nav>
    </div>
    <div className="site-footer-base"><a href="/#catalog">ДО КАТАЛОГУ ↗</a><small>© {new Date().getFullYear()} LOREM STORE</small><p className="photo-note">Фото товарів можуть бути оброблені для єдиного стилю каталогу.</p></div>
  </div></footer>;
}
