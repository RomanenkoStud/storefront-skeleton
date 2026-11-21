import {createTaxonomyContext,resolveCategoryId} from './taxonomy-context.js';
import {CATEGORY_TREE} from './taxonomy.js';
/**
 * Picture normalization templates (ADR-0008, docs/MEDIA.md "Picture normalization (fit)"). Pure, no I/O.
 *
 * Decided: the 1200x1600 (3:4) canvas. Approved (wave 1): footwear-side, pants-vertical and the default
 * fallback. DRAFT placeholders (later waves, not approved designs): tops-front, suits-front, bags,
 * accessory-wide; their labels and notes carry a draft marker. The later-wave templates are defined but
 * unbound pending lead approval: tops, suits, bags and accessories use the default frame until each wave
 * is approved and its binding is added explicitly. Any geometric edit MUST bump the template
 * `revision` (the snapshot test enforces it) and, for a bundle-wide change, PICTURE_TEMPLATES_REVISION.
 */
export const PICTURE_TEMPLATES_REVISION = 1;
const DRAFT = 'ЧЕРНЕТКА (чернетка шаблону, значення не затверджені): ';
const canvas = {width:1200,height:1600};
const APPROVED = new Set(['footwear-side','pants-vertical','default']);
const tpl = (id,label,box,anchor,scale,orientation,multipleObjects='flag') => ({
  id,revision:1,...APPROVED.has(id)?{label}:{label:DRAFT+label,notes:'DRAFT placeholder, later wave, not an approved design'},
  canvas:{...canvas},box,anchor,scale,orientation,multipleObjects,
});
const none = {axis:'none',maxCorrectionDeg:0,minElongation:1};
const deepFreeze = value => {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) { Object.freeze(value); Object.values(value).forEach(deepFreeze); }
  return value;
};
const ID = /^[a-z0-9-]{1,40}$/;
const fail = message => { throw new TypeError(`Invalid picture template: ${message}`); };
const num = (value,name,min,max) => { if (typeof value !== 'number' || !Number.isFinite(value) || value < min || value > max) fail(`${name} must be a number in ${min}..${max}`); return value; };
const int = (value,name,min,max) => { if (!Number.isInteger(value) || value < min || value > max) fail(`${name} must be an integer in ${min}..${max}`); return value; };
const obj = (value,name,allowed,required = allowed) => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail(`${name} must be an object`);
  const proto = Object.getPrototypeOf(value);
  if (proto !== Object.prototype && proto !== null) fail(`${name} must be a plain object`);
  for (const key of Object.keys(value)) if (!allowed.includes(key)) fail(`${name}.${key} is not allowed`);
  for (const key of required) if (!Object.hasOwn(value,key)) fail(`${name}.${key} is required`);
  return value;
};
const MIN_BOX = 0.05, LABEL_MAX = 80, NOTES_MAX = 500;
const NUM = '[+-]?(?:\\d+\\.?\\d*|\\.\\d+)(?:[eE][+-]?\\d+)?';
const VIEWBOX = new RegExp(`^${NUM}(?:[ ,]${NUM}){3}$`);
const PATH = /^[MmLlHhVvCcSsQqTtAaZz0-9eE.,\s+-]{1,4000}$/;
/** Returns the template when valid, otherwise throws TypeError. Unknown keys are rejected at every level. */
export function validateTemplate(template) {
  obj(template,'template',['id','revision','label','notes','canvas','box','anchor','scale','orientation','multipleObjects','guide'],['id','revision','label','canvas','box','anchor','scale','orientation','multipleObjects']);
  if (typeof template.id !== 'string' || !ID.test(template.id)) fail('id must match [a-z0-9-]{1,40}');
  int(template.revision,'revision',1,Number.MAX_SAFE_INTEGER);
  if (typeof template.label !== 'string' || !template.label.trim() || template.label.length > LABEL_MAX) fail(`label must be a non-empty string of at most ${LABEL_MAX} characters`);
  if (template.notes !== undefined && (typeof template.notes !== 'string' || template.notes.length > NOTES_MAX)) fail(`notes must be a string of at most ${NOTES_MAX} characters`);
  const c = obj(template.canvas,'canvas',['width','height']); int(c.width,'canvas.width',256,4096); int(c.height,'canvas.height',256,4096);
  const b = obj(template.box,'box',['x','y','w','h']);
  for (const k of ['x','y']) num(b[k],`box.${k}`,0,1);
  for (const k of ['w','h']) num(b[k],`box.${k}`,MIN_BOX,1);
  if (b.x + b.w > 1 + 1e-9 || b.y + b.h > 1 + 1e-9) fail('box must lie inside the canvas (x+w<=1, y+h<=1)');
  const a = obj(template.anchor,'anchor',['x','y']); num(a.x,'anchor.x',0,1); num(a.y,'anchor.y',0,1);
  const s = obj(template.scale,'scale',['mode','areaFraction','maxUpscale'],['mode','maxUpscale']);
  if (!['contain','width','height','area'].includes(s.mode)) fail('scale.mode must be contain, width, height or area');
  if (s.mode === 'area') { num(s.areaFraction,'scale.areaFraction',0,1); if (s.areaFraction <= 0) fail('scale.areaFraction must be positive'); }
  else if (s.areaFraction !== undefined) fail('scale.areaFraction is only valid for mode area');
  num(s.maxUpscale,'scale.maxUpscale',1,16);
  const o = obj(template.orientation,'orientation',['axis','maxCorrectionDeg','minElongation']);
  if (!['horizontal','vertical','none'].includes(o.axis)) fail('orientation.axis must be horizontal, vertical or none');
  num(o.maxCorrectionDeg,'orientation.maxCorrectionDeg',0,90); num(o.minElongation,'orientation.minElongation',1,100);
  if (!['allow','flag'].includes(template.multipleObjects)) fail('multipleObjects must be allow or flag');
  if (template.guide !== undefined) {
    const g = obj(template.guide,'guide',['kind','d','viewBox']);
    if (g.kind !== 'svg-path' || typeof g.d !== 'string' || !PATH.test(g.d)) fail('guide must be {kind:"svg-path",d,viewBox} with a plain path string');
    const vb = typeof g.viewBox === 'string' && g.viewBox.length <= 100 && VIEWBOX.test(g.viewBox) ? g.viewBox.split(/[ ,]/).map(Number) : [];
    if (vb.length !== 4 || !vb.every(Number.isFinite) || vb[2] <= 0 || vb[3] <= 0) fail('guide.viewBox must be four finite numbers with positive width and height');
  }
  return template;
}
const contain15 = {mode:'contain',maxUpscale:1.5};
/** id -> template. Deeply frozen. Wave 1 + default approved; others DRAFT. */
export const PICTURE_TEMPLATES = deepFreeze(Object.fromEntries([
  tpl('footwear-side','Взуття, вид збоку',{x:.06,y:.30,w:.88,h:.46},{x:.5,y:1},{...contain15},{axis:'horizontal',maxCorrectionDeg:20,minElongation:1.3},'allow'),
  tpl('pants-vertical','Штани, вертикально',{x:.18,y:.05,w:.64,h:.90},{x:.5,y:0},{mode:'height',maxUpscale:1.5},{axis:'vertical',maxCorrectionDeg:15,minElongation:1.3}),
  tpl('tops-front','Верх, вид спереду',{x:.08,y:.08,w:.84,h:.84},{x:.5,y:0},{...contain15},{axis:'vertical',maxCorrectionDeg:8,minElongation:1.15}),
  tpl('suits-front','Костюми, вид спереду',{x:.10,y:.05,w:.80,h:.90},{x:.5,y:.5},{mode:'contain',maxUpscale:1.5},{...none}),
  tpl('bags','Сумки',{x:.12,y:.20,w:.76,h:.62},{x:.5,y:1},{mode:'contain',maxUpscale:1.5},{...none}),
  tpl('accessory-wide','Широкі аксесуари',{x:.08,y:.30,w:.84,h:.40},{x:.5,y:.5},{mode:'contain',maxUpscale:1.5},{axis:'horizontal',maxCorrectionDeg:20,minElongation:1.3}),
  tpl('default','Типовий шаблон',{x:.10,y:.10,w:.80,h:.80},{x:.5,y:.5},{...contain15},{...none}),
].map(t => [t.id,validateTemplate(t)])));
/**
 * Stable seeded category ID -> template ID. Children inherit from the nearest bound ancestor.
 * Only wave 1 (footwear, pants) is bound. Later-wave categories (outerwear, hoodies-sweatshirts, knitwear,
 * tshirts-polos, shirts, suits, bags, belts, glasses) stay unbound pending approval, as do hats-caps, socks-underwear, gloves, jewellery, unclassified.
 */
export const CATEGORY_TEMPLATE_BINDINGS = deepFreeze({
  footwear:'footwear-side',
  pants:'pants-vertical',
  default:'default',
});
/**
 * Resolve the template for a category. Retired IDs follow taxonomy redirects, then the category itself and
 * its ancestors (nearest first) are searched for a binding; otherwise the default template applies.
 * A null/undefined taxonomyContext falls back to the seeded CATEGORY_TREE (like taxonomy.js getCategory).
 * Templates/bindings are read by own property only and the chosen template is validated.
 * @returns {{template:object,boundCategoryId:string|null,inherited:boolean}}
 */
export function resolvePictureTemplate(categoryId, taxonomyContext, bindings = CATEGORY_TEMPLATE_BINDINGS, templates = PICTURE_TEMPLATES) {
  const own = (o,k) => Object.hasOwn(o,k);
  const lookup = templateId => typeof templateId === 'string' && own(templates,templateId) ? validateTemplate(templates[templateId]) : undefined;
  const fallback = () => {
    const template = own(bindings,'default') ? lookup(bindings.default) : undefined;
    if (!template) throw new Error('Default picture template is not configured');
    return {template,boundCategoryId:null,inherited:false};
  };
  if (typeof categoryId !== 'string' || !categoryId) return fallback();
  const ctx = createTaxonomyContext(taxonomyContext ?? CATEGORY_TREE);
  const id = resolveCategoryId(categoryId,ctx), node = ctx.index.get(id);
  if (!node) return fallback();
  // Binding keys are stable seeded IDs that managers may retire; compare them in redirect-resolved form.
  // On collision (a retired key redirected onto a category that has its own binding) the current key wins; between
  // several retired keys the lexicographically smallest original key wins, independent of object key order.
  const keys = Object.keys(bindings).filter(key => key !== 'default'), bound = new Map();
  for (const key of keys) if (resolveCategoryId(key,ctx) === key) bound.set(key,bindings[key]);
  for (const key of [...keys].sort()) { const resolved = resolveCategoryId(key,ctx); if (!bound.has(resolved)) bound.set(resolved,bindings[key]); }
  // Nearest first: the node itself, then its parent up to the root (ctx ancestors are root -> parent).
  for (const candidate of [id,...[...node.ancestors].reverse().map(a => resolveCategoryId(a,ctx))]) {
    const template = bound.has(candidate) ? lookup(bound.get(candidate)) : undefined;
    if (template) return {template,boundCategoryId:candidate,inherited:candidate !== id};
  }
  return fallback();
}
