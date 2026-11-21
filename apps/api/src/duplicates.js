// Cross-supplier duplicate review. Candidates are computed per request from the current catalog;
// only manager decisions are stored (migrations/0016). Nothing here touches source snapshots, overlays,
// publication or the public projection.
import { fail, productProjection } from './domain.js';
import { actorLabel, auditStatement } from './permissions.js';
import { groupStorefront } from './merged.js';
import { findDuplicateCandidates, DUPLICATE_LIMITS } from '../../../packages/catalog/duplicates.js';

const now = () => new Date().toISOString();
const json = (data, status = 200) => new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' } });
async function rows(env, sql, ...bindings) { return (await env.DB.prepare(sql).bind(...bindings).all()).results; }
const MAX_REJECTIONS_SHOWN = 200;

function idList(value, field, min = 1, max = DUPLICATE_LIMITS.groupSize) {
  if (value === undefined && min === 0) return [];
  if (!Array.isArray(value) || value.length < min || value.length > max || value.some(v => typeof v !== 'string' || !v || v.length > 200) || new Set(value).size !== value.length) fail(`Supply ${min}–${max} unique product IDs in ${field}`);
  return value;
}
function onlyKeys(body, allowed) { for (const key of Object.keys(body)) if (!allowed.includes(key)) fail(`Unknown field: ${key}`); }

function summary(row, projection) {
  const source = projection.source;
  return {
    id: row.id, supplierId: row.supplier_id, supplierName: row.supplier_name, supplierEnabled: !!row.supplier_enabled,
    externalId: row.external_id, title: projection.title, sourceTitle: source.title, brand: projection.brand ?? null,
    category: projection.categoryPath?.join(' / ') || projection.category, photo: projection.photos[0] ?? null,
    costMinor: source.costMinor, priceMinor: projection.priceMinor, published: projection.published, deletedAt: row.deleted_at ?? null,
    slug: row.slug, sizes: source.variants.map(v => ({ size: v.size, stock: v.stock })), stock: source.variants.reduce((sum, v) => sum + v.stock, 0)
  };
}

async function loadState(env) {
  const [products, members, rejections] = await Promise.all([
    rows(env, 'SELECT p.*,s.name AS supplier_name,s.enabled AS supplier_enabled FROM products p JOIN suppliers s ON s.id=p.supplier_id WHERE s.deleted_at IS NULL'),
    rows(env, 'SELECT m.product_id,m.group_id,m.added_at,m.actor,g.created_at,g.updated_at,g.actor AS group_actor FROM duplicate_group_members m JOIN duplicate_groups g ON g.id=m.group_id ORDER BY m.added_at,m.product_id'),
    rows(env, 'SELECT * FROM duplicate_rejections ORDER BY created_at DESC,product_a,product_b')
  ]);
  const groups = new Map();
  for (const m of members) {
    let group = groups.get(m.group_id);
    if (!group) { group = { id: m.group_id, createdAt: m.created_at, updatedAt: m.updated_at, actor: m.group_actor, productIds: [] }; groups.set(m.group_id, group); }
    group.productIds.push(m.product_id);
  }
  return { products, groups: [...groups.values()], rejections };
}

export async function duplicatesOverview({ env }) {
  const { products, groups, rejections } = await loadState(env);
  const settings = env.RECOGNITION?.settings, taxonomy = env.RECOGNITION?.taxonomy, at = Date.now();
  const byId = new Map(), projections = new Map();
  for (const row of products) { const projection = productProjection(row, at, false, settings, taxonomy); byId.set(row.id, row); projections.set(row.id, projection); }
  // Trashed products are never proposed; their existing decisions are kept and shown.
  const active = products.filter(row => !row.deleted_at).map(row => {
    const p = projections.get(row.id);
    return { id: row.id, supplierId: row.supplier_id, title: p.source.title, brand: p.brand, categoryId: p.categoryId, categoryPath: p.categoryPath, photos: p.source.photos };
  });
  const candidates = findDuplicateCandidates(active, { rejectedPairs: rejections.map(r => [r.product_a, r.product_b]), groups });
  const shownRejections = rejections.slice(0, MAX_REJECTIONS_SHOWN);
  const referenced = new Set([...candidates.flatMap(c => [...c.productIds, ...c.groupProductIds]), ...groups.flatMap(g => g.productIds), ...shownRejections.flatMap(r => [r.product_a, r.product_b])]);
  const summaries = {};
  for (const productId of referenced) if (byId.has(productId)) summaries[productId] = summary(byId.get(productId), projections.get(productId));
  return json({
    candidates,
    groups: groups.map(g => ({ ...g, actor: actorLabel(env.PRINCIPAL, g.actor), missingCount: g.productIds.filter(productId => !byId.has(productId)).length,
      storefront: groupStorefront(g.productIds.filter(productId => byId.has(productId)).map(productId => ({ ...byId.get(productId), duplicate_group_id: g.id })), (row, publicOnly) => publicOnly ? productProjection(row, at, true, settings, taxonomy) : projections.get(row.id)) })).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt) || a.id.localeCompare(b.id)),
    rejections: shownRejections.map(r => ({ productIds: [r.product_a, r.product_b], createdAt: r.created_at, actor: actorLabel(env.PRINCIPAL, r.actor) })),
    products: summaries,
    totals: { candidates: candidates.length, groups: groups.length, rejections: rejections.length }
  });
}

async function productsById(env, ids) {
  if (!ids.length) return new Map();
  const found = await rows(env, `SELECT p.id,p.supplier_id,p.deleted_at,s.deleted_at AS supplier_deleted_at,m.group_id FROM products p JOIN suppliers s ON s.id=p.supplier_id LEFT JOIN duplicate_group_members m ON m.product_id=p.id WHERE p.id IN (${ids.map(() => '?').join(',')})`, ...ids);
  const map = new Map(found.filter(r => !r.supplier_deleted_at).map(r => [r.id, r]));
  if (map.size !== ids.length) fail('One or more selected products do not exist', 404);
  return map;
}
function rejectionStatements(env, pairs, actor, at) {
  return pairs.map(([x, y]) => { const [a, b] = x < y ? [x, y] : [y, x]; return env.DB.prepare('INSERT OR IGNORE INTO duplicate_rejections(product_a,product_b,created_at,actor) VALUES(?,?,?,?)').bind(a, b, at, actor); });
}
// Fails the whole batch unless the group ends with `count` members and at most one product per supplier.
function guardStatements(env, groupId, count) {
  const token = crypto.randomUUID();
  return [
    env.DB.prepare(`INSERT INTO duplicate_guards(token,valid) VALUES(?,(SELECT CASE WHEN (SELECT COUNT(*) FROM duplicate_group_members WHERE group_id=?)=? AND NOT EXISTS(SELECT 1 FROM duplicate_group_members m JOIN products p ON p.id=m.product_id WHERE m.group_id=? GROUP BY p.supplier_id HAVING COUNT(*)>1) THEN 1 ELSE 0 END))`).bind(token, groupId, count, groupId),
    env.DB.prepare('DELETE FROM duplicate_guards WHERE token=?').bind(token)
  ];
}
async function guarded(env, statements) {
  try { return await env.DB.batch(statements); }
  catch (error) {
    if (/CHECK constraint failed|UNIQUE constraint failed: duplicate_group_members|FOREIGN KEY constraint failed/i.test(String(error?.message))) fail('The group was changed by another manager; reload and review it again', 409);
    throw error;
  }
}
async function groupMembers(env, groupId) {
  const members = await rows(env, 'SELECT m.product_id,p.supplier_id FROM duplicate_group_members m JOIN products p ON p.id=m.product_id WHERE m.group_id=?', groupId);
  if (!members.length) fail('Duplicate group not found', 404);
  return members;
}

/** Confirm products as one item: create a group, or add products to `groupId`. `rejectIds` (products the manager
 * unchecked in the same candidate) are recorded as "not the same item" against every final member. */
export async function confirmGroup({ request, env }, readJson) {
  const body = await readJson(request);
  onlyKeys(body, ['productIds', 'groupId', 'rejectIds']);
  const productIds = idList(body.productIds, 'productIds', body.groupId === undefined ? 2 : 1);
  const rejectIds = idList(body.rejectIds, 'rejectIds', 0);
  if (rejectIds.some(x => productIds.includes(x))) fail('A product cannot be both confirmed and rejected');
  if (body.groupId !== undefined && (typeof body.groupId !== 'string' || !body.groupId || body.groupId.length > 200)) fail('Invalid groupId');
  const existing = body.groupId === undefined ? [] : await groupMembers(env, body.groupId);
  const found = await productsById(env, [...productIds, ...rejectIds]);
  for (const productId of productIds) {
    const row = found.get(productId);
    if (row.deleted_at) fail(`Product ${productId} is in Trash; restore it first`, 409);
    if (row.group_id && row.group_id !== body.groupId) fail(`Product ${productId} already belongs to another duplicate group`, 409);
  }
  const added = productIds.filter(productId => !existing.some(m => m.product_id === productId));
  const final = [...existing, ...added.map(productId => ({ product_id: productId, supplier_id: found.get(productId).supplier_id }))];
  if (!added.length) fail('All selected products are already in this group');
  if (final.length > DUPLICATE_LIMITS.groupSize) fail(`A duplicate group can hold at most ${DUPLICATE_LIMITS.groupSize} products`);
  if (new Set(final.map(m => m.supplier_id)).size !== final.length) fail('A duplicate group holds at most one product per supplier; reject the extra product instead', 409);
  if (final.length < 2) fail('A duplicate group needs products from at least two suppliers');
  for (const productId of rejectIds) if (found.get(productId).group_id && found.get(productId).group_id === body.groupId) fail(`Product ${productId} is a member of this group; remove it from the group instead`, 409);
  const at = now(), actor = env.PRINCIPAL?.actor ?? 'system', groupId = body.groupId ?? crypto.randomUUID();
  const finalIds = final.map(m => m.product_id);
  const statements = [
    body.groupId === undefined
      ? env.DB.prepare('INSERT INTO duplicate_groups(id,created_at,updated_at,actor) VALUES(?,?,?,?)').bind(groupId, at, at, actor)
      : env.DB.prepare('UPDATE duplicate_groups SET updated_at=? WHERE id=?').bind(at, groupId),
    ...added.map(productId => env.DB.prepare('INSERT INTO duplicate_group_members(product_id,group_id,added_at,actor) VALUES(?,?,?,?)').bind(productId, groupId, at, actor)),
    // A confirmation supersedes any earlier "different items" decision between the members.
    env.DB.prepare(`DELETE FROM duplicate_rejections WHERE product_a IN (${finalIds.map(() => '?').join(',')}) AND product_b IN (${finalIds.map(() => '?').join(',')})`).bind(...finalIds, ...finalIds),
    ...rejectionStatements(env, rejectIds.flatMap(x => finalIds.filter(y => found.get(x).supplier_id !== final.find(m => m.product_id === y).supplier_id).map(y => [x, y])), actor, at),
    ...guardStatements(env, groupId, final.length),
    auditStatement(env, 'duplicates.confirm', groupId, at, { added, rejected: rejectIds })
  ];
  await guarded(env, statements);
  return json({ groupId, productIds: finalIds, added, rejected: rejectIds }, body.groupId === undefined ? 201 : 200);
}

/** Mark products as different items: every cross-supplier pair among them is stored as rejected. */
export async function rejectCandidates({ request, env }, readJson) {
  const body = await readJson(request);
  onlyKeys(body, ['productIds']);
  const productIds = idList(body.productIds, 'productIds', 2);
  const found = await productsById(env, productIds);
  const pairs = [];
  for (let i = 0; i < productIds.length; i++) for (let j = i + 1; j < productIds.length; j++) {
    const a = found.get(productIds[i]), b = found.get(productIds[j]);
    if (a.supplier_id === b.supplier_id || (a.group_id && a.group_id === b.group_id)) continue;
    pairs.push([a.id, b.id]);
  }
  if (!pairs.length) fail('No cross-supplier pairs to reject');
  const at = now();
  await env.DB.batch([...rejectionStatements(env, pairs, env.PRINCIPAL?.actor ?? 'system', at), auditStatement(env, 'duplicates.reject', 'duplicates', at, { productIds, pairs: pairs.length })]);
  return json({ rejectedPairs: pairs.length });
}

/** Undo a "different items" decision for one pair; the pair can be proposed again. */
export async function restoreRejection({ request, env }, readJson) {
  const body = await readJson(request);
  onlyKeys(body, ['productIds']);
  const [x, y] = idList(body.productIds, 'productIds', 2, 2), [a, b] = x < y ? [x, y] : [y, x];
  const result = await env.DB.batch([
    env.DB.prepare('DELETE FROM duplicate_rejections WHERE product_a=? AND product_b=?').bind(a, b),
    env.DB.prepare("INSERT INTO audit_events(id,actor,action,resource_id,created_at,actor_type,actor_role,details_json) SELECT ?,?,'duplicates.unreject','duplicates',?,?,?,? WHERE changes()>0").bind(crypto.randomUUID(), env.PRINCIPAL?.actor ?? 'system', now(), env.PRINCIPAL?.type ?? 'system', env.PRINCIPAL?.role ?? null, JSON.stringify({ productIds: [a, b] }))
  ]);
  if (!(result[0]?.meta?.changes ?? result[0]?.changes)) fail('Rejected pair not found', 404);
  return json({ restored: true });
}

/** Dissolve a group. Its pairs become ordinary candidates again unless rejected. */
export async function dissolveGroup({ request, env, params }, readJson) {
  const body = await readJson(request);
  onlyKeys(body, []);
  const members = await groupMembers(env, params.id), at = now();
  await env.DB.batch([
    env.DB.prepare('DELETE FROM duplicate_groups WHERE id=?').bind(params.id),
    auditStatement(env, 'duplicates.dissolve', params.id, at, { productIds: members.map(m => m.product_id) })
  ]);
  return json({ dissolved: true, productIds: members.map(m => m.product_id) });
}

/** Remove one product from a group and record it as a different item from the remaining members, so it is not
 * proposed again. A group left with fewer than two products is dissolved. */
export async function removeMember({ request, env, params }, readJson) {
  const body = await readJson(request);
  onlyKeys(body, []);
  const members = await groupMembers(env, params.id);
  const leaving = members.find(m => m.product_id === params.productId);
  if (!leaving) fail('Product is not in this group', 404);
  const remaining = members.filter(m => m !== leaving), at = now(), actor = env.PRINCIPAL?.actor ?? 'system';
  const dissolve = remaining.length < 2;
  const statements = [
    env.DB.prepare('DELETE FROM duplicate_group_members WHERE product_id=? AND group_id=?').bind(leaving.product_id, params.id),
    ...rejectionStatements(env, remaining.filter(m => m.supplier_id !== leaving.supplier_id).map(m => [leaving.product_id, m.product_id]), actor, at),
    dissolve ? env.DB.prepare('DELETE FROM duplicate_groups WHERE id=?').bind(params.id) : env.DB.prepare('UPDATE duplicate_groups SET updated_at=? WHERE id=?').bind(at, params.id),
    ...(dissolve ? [] : guardStatements(env, params.id, remaining.length)),
    auditStatement(env, 'duplicates.remove', params.id, at, { productId: leaving.product_id, dissolved: dissolve })
  ];
  await guarded(env, statements);
  return json({ removed: leaving.product_id, dissolved: dissolve, productIds: dissolve ? [] : remaining.map(m => m.product_id) });
}

