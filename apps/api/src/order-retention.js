// Retention erasure of the order's personal data (ADR-0007 "Retention of order personal data").
// The recipient (rcpt_*) and Nova Poshta point (dp_*) snapshot of a cart is set to NULL ORDER_PD_RETENTION.closedDays after
// the cart reaches a closed status (completed or cancelled, by status_changed_at), and at the latest ORDER_PD_RETENTION.maxDays
// after created_at for a cart that is never closed. pd_erased_at marks the row so the UI can say why the data is gone.
// This is the only write to the snapshot columns after checkout besides account deletion (the ADR-0007 immutability exception).
// Nothing else changes: status, status_*, manager_note, updated_at, the lines and the customer binding stay as they are.
import { CLOSED_STATUSES, ORDER_PD_RETENTION } from '../../../packages/catalog/cart.js';

const DAY_MS = 86400000;
export const PD_COLUMNS = Object.freeze(['rcpt_name', 'rcpt_phone', 'rcpt_last_name', 'rcpt_first_name', 'rcpt_middle_name', 'dp_type', 'dp_city_name', 'dp_city_ref', 'dp_warehouse_number', 'dp_warehouse_ref', 'dp_warehouse_name']);
// Must stay textually identical to the WHERE of the partial index carts_pd_pending (migration 0027).
export const PD_PENDING = `pd_erased_at IS NULL AND (${PD_COLUMNS.map(c => `${c} IS NOT NULL`).join(' OR ')})`;
const CLOSED_LIST = CLOSED_STATUSES.map(s => `'${s}'`).join(',');
const CLOSED_DUE = `(status IN (${CLOSED_LIST}) AND status_changed_at <= ?)`;
// The 90-day backstop applies only to carts that were never closed: a closed cart always gets its full 14 days.
const OPEN_EXPIRED = `(status NOT IN (${CLOSED_LIST}) AND created_at <= ?)`;
const DUE = `${PD_PENDING} AND (${CLOSED_DUE} OR ${OPEN_EXPIRED})`;

/** ISO cutoffs for `now`: a cart is due when its timestamp is at or before the cutoff (exactly 14/90 days old counts). */
export function retentionCutoffs(now = new Date()) {
  const at = now instanceof Date ? now.getTime() : Number(now);
  if (!Number.isFinite(at)) throw new TypeError('Invalid retention clock.');
  return { closedBefore: new Date(at - ORDER_PD_RETENTION.closedDays * DAY_MS).toISOString(), createdBefore: new Date(at - ORDER_PD_RETENTION.maxDays * DAY_MS).toISOString(), at: new Date(at).toISOString() };
}

/**
 * Erases due personal data, oldest carts first, at most `limit` carts per call. Idempotent: an erased row no longer
 * matches PD_PENDING. Writes one `cart.pd-retention` audit row (counts only, never values or codes) when it erased anything.
 * Returns {erased, closed, expired, more}: `closed` were due by the closed-status rule, `expired` by the age backstop for open carts.
 */
export async function purgeExpiredOrderPersonalData(env, now = new Date(), { limit = ORDER_PD_RETENTION.batchLimit } = {}) {
  if (!Number.isSafeInteger(limit) || limit < 1) throw new TypeError('Invalid retention batch limit.');
  const { closedBefore, createdBefore, at } = retentionCutoffs(now);
  const pick = `SELECT id FROM carts WHERE ${DUE} ORDER BY created_at, id LIMIT ?`;
  const due = (await env.DB.prepare(`SELECT ${CLOSED_DUE} AS closed FROM carts WHERE ${DUE} ORDER BY created_at, id LIMIT ?`).bind(closedBefore, closedBefore, createdBefore, limit + 1).all()).results;
  const batch = due.slice(0, limit), closed = batch.filter(r => r.closed).length;
  if (!batch.length) return { erased: 0, closed: 0, expired: 0, more: false };
  const results = await env.DB.batch([
    env.DB.prepare(`UPDATE carts SET ${PD_COLUMNS.map(c => `${c}=NULL`).join(', ')}, pd_erased_at=? WHERE id IN (${pick})`).bind(at, closedBefore, createdBefore, limit),
    // Directly after the UPDATE, so changes() is the number of carts actually erased by this run.
    env.DB.prepare("INSERT INTO audit_events(id,actor,action,resource_id,created_at,actor_type,actor_role,details_json) SELECT ?,'system','cart.pd-retention','carts',?,'system',NULL,json_object('erased',changes(),'closed',?,'expired',?,'closedDays',?,'maxDays',?) WHERE changes() > 0")
      .bind(crypto.randomUUID(), at, closed, batch.length - closed, ORDER_PD_RETENTION.closedDays, ORDER_PD_RETENTION.maxDays),
  ]);
  const erased = Number(results?.[0]?.meta?.changes ?? results?.[0]?.changes ?? batch.length);
  return { erased, closed, expired: batch.length - closed, more: due.length > limit };
}
