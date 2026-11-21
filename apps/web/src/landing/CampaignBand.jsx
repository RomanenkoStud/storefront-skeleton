import React, { useEffect, useMemo, useState } from 'react';
import { useTaxonomy } from '../TaxonomyContext.jsx';
import RAIL from '../rail-media.json';
import { EMPTY_FILTERS, writeFilters, withPreserved } from '../catalog-filters.js';
import { Icon } from '../ui.jsx';
import { pickCampaign, campaignLead, campaignHref, campaignArt, sceneSlots, loadStorefrontSettings } from './campaign.js';

// Same-page click: filter through the URL the catalog already reads (popstate), no reload and no intro replay.
// The CTA shows the same set the band counts (in stock) and deliberately resets every other filter (search, brands, sizes, price): it means "go to the drop".
// Modified clicks and middle clicks fall through to the plain /?category=<id>&available=1#catalog link.
function filterCatalog(event, categoryId) {
  if (event.defaultPrevented || event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
  const catalog = document.getElementById('catalog');
  if (!catalog) return;
  event.preventDefault();
  const query = withPreserved(writeFilters({ ...EMPTY_FILTERS, category: categoryId, available: true }), location.search);
  const target = `${location.pathname}${query ? `?${query}` : ''}#catalog`;
  if (target !== `${location.pathname}${location.search}${location.hash}`) {
    history.pushState(null, '', target);
    window.dispatchEvent(new PopStateEvent('popstate'));
  }
  catalog.scrollIntoView({ behavior: 'smooth' });
}

// Pure view (ADR-0015): the storefront and the admin preview render the same markup. campaign = pickCampaign() result,
// scene = scene preset or id (unknown/unavailable renders the default), pictures = the campaign's pictures (defaults to
// campaign.images), preview = true inside the admin: the CTA does not navigate and ids stay unique.
export function CampaignBandView({ campaign, scene, pictures, preview = false }) {
  const { scene: sc, slots } = sceneSlots(scene, pictures || campaign.images);
  const bg = sc.background;
  const bandStyle = { '--wall-pos': bg.position.desktop, '--wall-mpos': bg.position.mobile };
  const titleId = preview ? undefined : 'campaign-title';
  const cta = preview ? { onClick: e => e.preventDefault(), tabIndex: -1, 'aria-disabled': true } : { onClick: e => filterCatalog(e, campaign.categoryId) };
  return <div className="campaign-frame">
    <section className="campaign-band" aria-labelledby={titleId} data-category={campaign.categoryId} data-scene={sc.id} style={bandStyle}>
      <img className="campaign-wall" src={bg.src} srcSet={bg.srcSet} sizes="100vw" width={bg.width} height={bg.height} alt="" aria-hidden="true" loading="lazy" decoding="async"/>
      <div className="campaign-copy">
        <p className="campaign-eyebrow"><i aria-hidden="true"/>Дроп</p>
        <h2 id={titleId}>{campaign.label}<br/><em>в наявності</em></h2>
        <p className="campaign-lead">{campaignLead(campaign)}</p>
        <a className="campaign-cta" href={preview ? undefined : campaignHref(campaign.categoryId)} {...cta}>Дивитись у наявності: {campaign.label} <Icon name="arrow"/></a>
      </div>
      <div className="campaign-art" data-anchor={sc.anchor} aria-hidden="true">
        {sc.props.map(prop => prop.kind === 'rail'
          ? <i key="rail" className="scene-rail" style={{ '--px': prop.desktop.x, '--py': prop.desktop.y, '--pw': prop.desktop.w, '--mpx': prop.mobile.x, '--mpy': prop.mobile.y, '--mpw': prop.mobile.w }}/>
          : prop.kind === 'hooks' ? slots.map((slot, i) => <i key={`hook-${i}`} className="scene-hook" data-mobile={slot.mobileOff ? 'off' : undefined}
              style={{ '--hx': slot.desktop.x + slot.desktop.w / 2, '--hy': slot.desktop.y, ...(slot.mobile ? { '--mhx': slot.mobile.x + slot.mobile.w / 2, '--mhy': slot.mobile.y } : {}) }}/>) : null)}
        {slots.map((slot, i) => <div key={slot.picture.src} className="scene-slot" data-rank={i + 1} data-mobile={slot.mobileOff ? 'off' : undefined} style={slot.style}>
          <img src={slot.picture.src} width={slot.picture.w} height={slot.picture.h} alt="" loading="lazy" decoding="async"/>
        </div>)}
      </div>
      <span className="campaign-idx" aria-hidden="true">Lorem Store</span>
    </section>
  </div>;
}

export default function CampaignBand({ products, loading }) {
  const taxonomy = useTaxonomy();
  const [data, setData] = useState(undefined);
  useEffect(() => {
    let live = true;
    loadStorefrontSettings().then(d => { if (live) setData({ settings: d.campaign || null, library: d.campaignPictures || {} }); });
    return () => { live = false; };
  }, []);
  const campaign = useMemo(() => (data === undefined ? null : pickCampaign(products, taxonomy, campaignArt(RAIL.clothes, data.library), data.settings)), [products, taxonomy, data]);
  // While loading, keep the band's height with a number-free shell; with no data it renders nothing.
  if (loading || data === undefined) return <div className="campaign-frame"><section className="campaign-band is-loading" aria-hidden="true"><div className="campaign-copy"/><div className="campaign-art"/></section></div>;
  if (!campaign) return null;
  return <CampaignBandView campaign={campaign} scene={data.settings?.sceneId}/>;
}
