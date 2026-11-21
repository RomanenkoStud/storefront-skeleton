// storefront settings (the landing campaign band). Public read, owner-level write (settings.manage).
import { fail } from './domain.js';
import { getCategory } from '../../../packages/catalog/taxonomy.js';
import { DEFAULT_SCENE_ID, getScene } from '../../../packages/catalog/campaign-scenes.js';

export const CAMPAIGN_MODES = Object.freeze(['auto', 'category', 'off']);
export const DEFAULT_CAMPAIGN = Object.freeze({ mode: 'auto', categoryId: null, excluded: [], sceneId: DEFAULT_SCENE_ID });

// A known, available scene (aliases resolved) or null.
const usableScene = id => { const scene = getScene(id); return scene && scene.available ? scene.id : null; };

// Unknown or malformed stored values fall back to the default so the storefront never breaks on bad data.
export function normalizeCampaign(value) {
  const v = value && typeof value === 'object' ? value : {};
  const mode = CAMPAIGN_MODES.includes(v.mode) ? v.mode : 'auto';
  const categoryId = typeof v.categoryId === 'string' && v.categoryId ? v.categoryId : null;
  const excluded = Array.isArray(v.excluded) ? [...new Set(v.excluded.filter(x => typeof x === 'string' && x))].slice(0, 100) : [];
  return { mode: mode === 'category' && !categoryId ? 'auto' : mode, categoryId, excluded, sceneId: usableScene(v.sceneId) ?? DEFAULT_SCENE_ID };
}

// Strict validation for writes: reject anything the form could not have sent.
export function validateCampaign(body, taxonomy) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) fail('JSON object required');
  const extra = Object.keys(body).filter(k => !['mode', 'categoryId', 'excluded', 'sceneId'].includes(k));
  if (extra.length) fail(`Unknown field: ${extra[0]}`);
  if (!CAMPAIGN_MODES.includes(body.mode)) fail('mode must be auto, category or off');
  const known = id => !taxonomy || !!getCategory(id, taxonomy);
  let categoryId = null;
  if (body.mode === 'category') {
    if (typeof body.categoryId !== 'string' || !body.categoryId) fail('categoryId is required for a fixed category');
    if (!known(body.categoryId)) fail('Unknown category');
    categoryId = body.categoryId;
  }
  const excluded = body.excluded === undefined ? [] : body.excluded;
  if (!Array.isArray(excluded) || excluded.length > 100 || excluded.some(x => typeof x !== 'string' || !x)) fail('excluded must be a list of category ids');
  for (const id of excluded) if (!known(id)) fail(`Unknown category: ${id}`);
  const result = { mode: body.mode, categoryId, excluded: [...new Set(excluded)] };
  if (body.sceneId !== undefined) {
    const sceneId = usableScene(body.sceneId);
    if (!sceneId) fail('Unknown or unavailable scene');
    result.sceneId = sceneId;
  }
  return result;
}

export async function readCampaign(env) {
  try {
    const row = await env.DB.prepare("SELECT value_json,actor,updated_at FROM storefront_settings WHERE key='campaign'").first();
    if (!row) return { campaign: { ...DEFAULT_CAMPAIGN }, updatedAt: null, actor: null };
    return { campaign: normalizeCampaign(JSON.parse(row.value_json)), updatedAt: row.updated_at, actor: row.actor };
  } catch (error) {
    // Table not migrated yet (or unreadable JSON): behave like the pre-setting storefront.
    if (/no such table|JSON/i.test(String(error?.message))) return { campaign: { ...DEFAULT_CAMPAIGN }, updatedAt: null, actor: null };
    throw error;
  }
}

export function writeCampaignStatement(env, campaign, at) {
  return env.DB.prepare("INSERT INTO storefront_settings(key,value_json,actor,updated_at) VALUES('campaign',?,?,?) ON CONFLICT(key) DO UPDATE SET value_json=excluded.value_json,actor=excluded.actor,updated_at=excluded.updated_at")
    .bind(JSON.stringify(campaign), env.PRINCIPAL?.actor ?? 'system', at);
}

// the scrolling line (ticker) under the hero.
export const TICKER_MAX_ITEMS = 8, TICKER_MAX_LENGTH = 40;
export const DEFAULT_TICKER = Object.freeze({ enabled: true, items: Object.freeze(['НОВІ НАДХОДЖЕННЯ', 'STREETWEAR', 'LOREM STORE']) });
const cleanItem = x => (typeof x === 'string' ? x.replace(/\s+/g, ' ').trim() : '');

export function normalizeTicker(value) {
  const v = value && typeof value === 'object' ? value : {};
  const items = Array.isArray(v.items) ? v.items.map(cleanItem).filter(Boolean).map(x => x.slice(0, TICKER_MAX_LENGTH)).slice(0, TICKER_MAX_ITEMS) : [];
  if (!items.length && v.enabled !== false) return { enabled: true, items: [...DEFAULT_TICKER.items] };
  return { enabled: v.enabled !== false, items };
}

export function validateTicker(body) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) fail('JSON object required');
  const extra = Object.keys(body).filter(k => !['enabled', 'items'].includes(k));
  if (extra.length) fail(`Unknown field: ${extra[0]}`);
  if (typeof body.enabled !== 'boolean') fail('enabled must be true or false');
  if (!Array.isArray(body.items) || body.items.some(x => typeof x !== 'string')) fail('items must be a list of phrases');
  const items = body.items.map(cleanItem).filter(Boolean);
  if (items.length > TICKER_MAX_ITEMS) fail(`At most ${TICKER_MAX_ITEMS} phrases`);
  if (items.some(x => x.length > TICKER_MAX_LENGTH)) fail(`A phrase can be at most ${TICKER_MAX_LENGTH} characters`);
  if (body.enabled && !items.length) fail('Add at least one phrase or turn the line off');
  return { enabled: body.enabled, items };
}

async function readKey(env, key, normalize, fallback) {
  try {
    const row = await env.DB.prepare('SELECT value_json,actor,updated_at FROM storefront_settings WHERE key=?').bind(key).first();
    if (!row) return { value: fallback(), updatedAt: null, actor: null };
    return { value: normalize(JSON.parse(row.value_json)), updatedAt: row.updated_at, actor: row.actor };
  } catch (error) {
    if (/no such table|JSON/i.test(String(error?.message))) return { value: fallback(), updatedAt: null, actor: null };
    throw error;
  }
}
export const readTicker = env => readKey(env, 'ticker', normalizeTicker, () => ({ enabled: true, items: [...DEFAULT_TICKER.items] }));

export function writeTickerStatement(env, ticker, at) {
  return env.DB.prepare("INSERT INTO storefront_settings(key,value_json,actor,updated_at) VALUES('ticker',?,?,?) ON CONFLICT(key) DO UPDATE SET value_json=excluded.value_json,actor=excluded.actor,updated_at=excluded.updated_at")
    .bind(JSON.stringify(ticker), env.PRINCIPAL?.actor ?? 'system', at);
}

// checkout settings. prepaymentMinor is the «Передоплата» shown on the cart step, integer kopecks (UAH); 0 hides the line.
export const PREPAYMENT_MAX_MINOR = 10000000; // 100 000 UAH
export const DEFAULT_CHECKOUT = Object.freeze({ prepaymentMinor: 0 });
const isPrepayment = v => Number.isSafeInteger(v) && v >= 0 && v <= PREPAYMENT_MAX_MINOR;

export function normalizeCheckout(value) {
  const v = value && typeof value === 'object' ? value : {};
  return { prepaymentMinor: isPrepayment(v.prepaymentMinor) ? v.prepaymentMinor : 0 };
}

export function validateCheckout(body) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) fail('JSON object required');
  const extra = Object.keys(body).filter(k => k !== 'prepaymentMinor');
  if (extra.length) fail(`Unknown field: ${extra[0]}`);
  if (!isPrepayment(body.prepaymentMinor)) fail('prepaymentMinor must be a whole number of kopecks from 0 to 10000000');
  return { prepaymentMinor: body.prepaymentMinor };
}

export const readCheckout = env => readKey(env, 'checkout', normalizeCheckout, () => ({ ...DEFAULT_CHECKOUT }));

export function writeCheckoutStatement(env, checkout, at) {
  return env.DB.prepare("INSERT INTO storefront_settings(key,value_json,actor,updated_at) VALUES('checkout',?,?,?) ON CONFLICT(key) DO UPDATE SET value_json=excluded.value_json,actor=excluded.actor,updated_at=excluded.updated_at")
    .bind(JSON.stringify(checkout), env.PRINCIPAL?.actor ?? 'system', at);
}

// sale banner in the announcement bar at the top of the storefront (e.g. a Black Friday offer).
// Off by default, so the page keeps its normal announcement. Optional window [startsAt, endsAt) in ISO time.
export const BANNER_LIMITS = Object.freeze({ text: 90, linkLabel: 30, linkHref: 200 });
export const DEFAULT_BANNER = Object.freeze({ enabled: false, text: '', linkLabel: '', linkHref: '', startsAt: null, endsAt: null });
const BANNER_FIELDS = Object.keys(DEFAULT_BANNER);
const oneLine = x => (typeof x === 'string' ? x.replace(/\s+/g, ' ').trim() : '');
// Same-site paths only ("/..." but not "//host"), so the banner can never send shoppers off the shop.
export const isSameSitePath = x => typeof x === 'string' && /^\/(?![/\\])[^\s<>"]*$/.test(x);
const isoOrNull = x => (typeof x === 'string' && x && !Number.isNaN(Date.parse(x)) ? new Date(x).toISOString() : null);

export function normalizeBanner(value) {
  const v = value && typeof value === 'object' ? value : {};
  const text = oneLine(v.text).slice(0, BANNER_LIMITS.text);
  const linkHref = isSameSitePath(v.linkHref) && v.linkHref.length <= BANNER_LIMITS.linkHref ? v.linkHref : '';
  const linkLabel = linkHref ? oneLine(v.linkLabel).slice(0, BANNER_LIMITS.linkLabel) : '';
  return { enabled: v.enabled === true && !!text, text, linkLabel, linkHref: linkLabel ? linkHref : '', startsAt: isoOrNull(v.startsAt), endsAt: isoOrNull(v.endsAt) };
}

export function validateBanner(body) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) fail('JSON object required');
  const extra = Object.keys(body).filter(k => !BANNER_FIELDS.includes(k));
  if (extra.length) fail(`Unknown field: ${extra[0]}`);
  if (typeof body.enabled !== 'boolean') fail('enabled must be true or false');
  for (const k of ['text', 'linkLabel', 'linkHref']) if (body[k] !== undefined && typeof body[k] !== 'string') fail(`${k} must be text`);
  const text = oneLine(body.text), linkLabel = oneLine(body.linkLabel), linkHref = (body.linkHref ?? '').trim();
  if (text.length > BANNER_LIMITS.text) fail(`Banner text can be at most ${BANNER_LIMITS.text} characters`);
  if (linkLabel.length > BANNER_LIMITS.linkLabel) fail(`Link text can be at most ${BANNER_LIMITS.linkLabel} characters`);
  if (body.enabled && !text) fail('Add the banner text or turn the banner off');
  if (linkHref && (!isSameSitePath(linkHref) || linkHref.length > BANNER_LIMITS.linkHref)) fail('Link must be a page of this shop starting with /');
  if (!!linkHref !== !!linkLabel) fail('Link needs both a text and an address');
  const at = {};
  for (const k of ['startsAt', 'endsAt']) {
    const raw = body[k];
    if (raw === undefined || raw === null || raw === '') { at[k] = null; continue; }
    if (typeof raw !== 'string' || Number.isNaN(Date.parse(raw))) fail(`${k} must be a date and time`);
    at[k] = new Date(raw).toISOString();
  }
  if (at.startsAt && at.endsAt && at.startsAt >= at.endsAt) fail('The banner must end after it starts');
  return { enabled: body.enabled, text, linkLabel, linkHref, ...at };
}

// What shoppers see right now: the banner while enabled and inside its window, otherwise null.
export function activeBanner(banner, now = new Date()) {
  const b = normalizeBanner(banner), t = now.toISOString();
  if (!b.enabled || (b.startsAt && t < b.startsAt) || (b.endsAt && t >= b.endsAt)) return null;
  return { text: b.text, linkLabel: b.linkLabel, linkHref: b.linkHref, ...(b.endsAt ? { endsAt: b.endsAt } : {}) };
}

export const readBanner = env => readKey(env, 'banner', normalizeBanner, () => ({ ...DEFAULT_BANNER }));

export function writeBannerStatement(env, banner, at) {
  return env.DB.prepare("INSERT INTO storefront_settings(key,value_json,actor,updated_at) VALUES('banner',?,?,?) ON CONFLICT(key) DO UPDATE SET value_json=excluded.value_json,actor=excluded.actor,updated_at=excluded.updated_at")
    .bind(JSON.stringify(banner), env.PRINCIPAL?.actor ?? 'system', at);
}
