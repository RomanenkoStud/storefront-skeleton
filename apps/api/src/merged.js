// Merged storefront listing for confirmed duplicate groups (docs/adr/0012-merged-duplicate-listing.md).
// A confirmed group is shown publicly as ONE product: the primary member's public projection (title, photos,
// slug, price) with per-size stock summed over every active member. Nothing is written: publication flags,
// overlays and source snapshots of the members are unchanged, so dissolving a group restores the old storefront.
import { productProjection } from './domain.js';
import { sizeMergeKey } from '../../../packages/catalog/sizes.js';

// A contributor is a published, active product of an enabled, non-deleted supplier: drafts never become
// purchasable through a group. A member whose supplier cost exceeds the shown price is also left out, so the
// merged product is never filled at a loss.
const ELIGIBLE = 's.enabled=1 AND s.deleted_at IS NULL AND p.deleted_at IS NULL';
const PUBLISHED = "json_extract(p.overrides_json,'$.published')=1";
const COLUMNS = 'p.*,s.name AS supplier_name,m.group_id AS duplicate_group_id';
const FROM = 'FROM products p JOIN suppliers s ON s.id=p.supplier_id LEFT JOIN duplicate_group_members m ON m.product_id=p.id';
async function rows(env, sql, ...bindings) { return (await env.DB.prepare(sql).bind(...bindings).all()).results; }

const visibleStock = projection => projection.variants.reduce((sum, v) => sum + v.stock, 0);
/** Primary member: published, then in stock, then lowest supplier cost, then stable ID. */
export function choosePrimary(members) {
  return members.filter(m => m.projection.published).sort((a, b) =>
    (visibleStock(b.projection) > 0) - (visibleStock(a.projection) > 0) || a.projection.source.costMinor - b.projection.source.costMinor || a.row.id.localeCompare(b.row.id))[0] ?? null;
}
// Fill order for a merged line: cheapest supplier cost first; the primary wins ties.
const fillOrder = (primaryId) => (a, b) => a.projection.source.costMinor - b.projection.source.costMinor || (b.row.id === primaryId) - (a.row.id === primaryId) || a.row.id.localeCompare(b.row.id);

/**
 * Build storefront entries from contributor rows (each row may carry `duplicate_group_id`).
 * @returns {{items: Array, byProductId: Map, bySlug: Map}} entries {product, primaryId, groupId, members}
 *   where `product` is the public projection (no private fields) and `members` are {row, projection} in fill order.
 */
export function mergeCatalog(source, project) {
  const order = new Map(source.map((row, index) => [row.id, index]));
  const singles = [], groups = new Map();
  for (const row of source) {
    if (row.duplicate_group_id) { const list = groups.get(row.duplicate_group_id) || []; list.push(row); groups.set(row.duplicate_group_id, list); }
    else singles.push(row);
  }
  const items = [];
  for (const row of singles) {
    const projection = project(row, false);
    if (!projection.published) continue;
    items.push({ product: project(row, true), primaryId: row.id, groupId: null, members: [{ row, projection }] });
  }
  for (const [groupId, list] of groups) {
    const published = list.map(row => ({ row, projection: project(row, false) })).filter(m => m.projection.published);
    const primary = choosePrimary(published);
    if (!primary) continue; // No published member: the group stays off the storefront.
    const members = published.filter(m => m === primary || m.projection.source.costMinor <= primary.projection.priceMinor);
    const sizes = new Map();
    const add = (variant, fromPrimary) => {
      const key = sizeMergeKey(variant.size), current = sizes.get(key);
      if (current) { current.stock += variant.stock; if (fromPrimary && !current.fromPrimary) { current.size = variant.size; current.fromPrimary = true; } }
      else sizes.set(key, { size: variant.size, stock: variant.stock, fromPrimary });
    };
    for (const variant of primary.projection.variants) add(variant, true);
    for (const member of members) if (member !== primary) for (const variant of member.projection.variants) add(variant, false);
    const product = { ...project(primary.row, true), variants: [...sizes.values()].map(({ size, stock }) => ({ size, stock })) };
    items.push({ product, primaryId: primary.row.id, groupId, members: members.sort(fillOrder(primary.row.id)) });
  }
  items.sort((a, b) => order.get(a.primaryId) - order.get(b.primaryId));
  const byProductId = new Map(), bySlug = new Map();
  for (const entry of items) for (const member of entry.members) { byProductId.set(member.row.id, entry); bySlug.set(member.row.slug, entry); }
  return { items, byProductId, bySlug };
}

/**
 * Split `quantity` of `size` over the entry's members. A single product keeps exact size matching; a merged
 * product accepts one of its merged size labels and matches members by normalized size.
 * @returns {{ok:false, code:'size_unavailable'|'insufficient_stock', available?:number} | {ok:true, allocations:Array}}
 */
export function allocate(entry, size, quantity) {
  const merged = entry.groupId !== null;
  if (merged && !entry.product.variants.some(v => v.size === size)) return { ok: false, code: 'size_unavailable' };
  const key = sizeMergeKey(size), candidates = [];
  for (const member of entry.members) {
    const hidden = new Set(member.projection.overrides.hiddenSizes ?? []);
    const matching = member.projection.source.variants.filter(v => !hidden.has(v.size) && (merged ? sizeMergeKey(v.size) === key : v.size === size));
    if (matching.length) candidates.push({ member, matching });
  }
  if (!candidates.length) return { ok: false, code: 'size_unavailable' };
  const available = candidates.reduce((sum, c) => sum + c.matching.reduce((n, v) => n + v.stock, 0), 0);
  if (available < quantity) return { ok: false, code: 'insufficient_stock', available };
  const allocations = [];
  let left = quantity;
  for (const { member, matching } of candidates) {
    const stock = matching.reduce((n, v) => n + v.stock, 0);
    if (left <= 0) break;
    if (stock <= 0) continue;
    const take = Math.min(stock, left);
    left -= take;
    allocations.push({ productId: member.row.id, supplierId: member.row.supplier_id, supplierName: member.row.supplier_name, externalProductId: member.row.external_id, variantIds: matching.filter(v => v.stock > 0).map(v => v.id), quantity: take, unitCostMinor: member.projection.source.costMinor });
  }
  return { ok: true, allocations };
}

const projector = env => { const at = Date.now(), settings = env.RECOGNITION?.settings, taxonomy = env.RECOGNITION?.taxonomy; return (row, publicOnly) => productProjection(row, at, publicOnly, settings, taxonomy); };

/** Whole storefront: published ungrouped products plus one merged product per visible group. */
export async function publicCatalog(env) {
  // Sorted here, not with ORDER BY: D1 bills every row the SQLite sorter reads back as a row read.
  // The WHERE terms match the partial index products_published (migration 0013) exactly.
  const list = await rows(env, `SELECT ${COLUMNS} ${FROM} WHERE ${ELIGIBLE} AND ${PUBLISHED}`);
  list.sort((a, b) => (a.updated_at < b.updated_at ? 1 : a.updated_at > b.updated_at ? -1 : a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  return mergeCatalog(list, projector(env));
}
/** Storefront entry reachable by any member's slug (callers redirect non-primary slugs), or null. */
export async function publicEntryBySlug(env, slug) {
  const row = (await rows(env, `SELECT ${COLUMNS} ${FROM} WHERE p.slug=? AND ${ELIGIBLE} AND ${PUBLISHED}`, slug))[0];
  if (!row) return null;
  const list = row.duplicate_group_id ? await rows(env, `SELECT ${COLUMNS} ${FROM} WHERE m.group_id=? AND ${ELIGIBLE} AND ${PUBLISHED} ORDER BY p.updated_at DESC,p.id`, row.duplicate_group_id) : [row];
  return mergeCatalog(list, projector(env)).bySlug.get(slug) ?? null;
}
/** Entries for the given product IDs, including whole groups those IDs belong to (checkout). */
export async function publicEntriesFor(env, ids) {
  const marks = ids.map(() => '?').join(',');
  return mergeCatalog(await rows(env, `SELECT ${COLUMNS} ${FROM} WHERE ${ELIGIBLE} AND ${PUBLISHED} AND (p.id IN (${marks}) OR m.group_id IN (SELECT group_id FROM duplicate_group_members WHERE product_id IN (${marks}))) ORDER BY p.updated_at DESC,p.id`, ...ids, ...ids), projector(env));
}
/** Admin view of one group's storefront state from already-loaded rows (no extra query). */
export function groupStorefront(groupRows, project) {
  const eligible = groupRows.filter(r => r.supplier_enabled && !r.deleted_at);
  const entry = mergeCatalog(eligible, project).items[0];
  return entry ? { visible: true, primaryId: entry.primaryId, slug: entry.product.slug, priceMinor: entry.product.priceMinor, sizes: entry.product.variants } : { visible: false, primaryId: null, slug: null, priceMinor: null, sizes: [] };
}
