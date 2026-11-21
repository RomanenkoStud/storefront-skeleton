-- Supplier provider. Existing rows stay MyDrop. `provider` is immutable after creation (enforced by the API).
ALTER TABLE suppliers ADD COLUMN provider TEXT NOT NULL DEFAULT 'mydrop' CHECK (provider IN ('mydrop','easydrop'));
-- EasyDrop prom-export link parts. Private: `feed_key` is a capability secret and is never projected, logged or audited.
ALTER TABLE suppliers ADD COLUMN feed_key TEXT;
ALTER TABLE suppliers ADD COLUMN feed_pid TEXT;
ALTER TABLE suppliers ADD COLUMN feed_updated_at TEXT;
-- Two suppliers must never share a key. The pid is shared by every link of one seller account, so it is not unique.
CREATE UNIQUE INDEX suppliers_easydrop_key ON suppliers(provider, feed_key) WHERE provider='easydrop' AND feed_key IS NOT NULL;
-- Application invariant: feed_key/feed_pid only when provider='easydrop'; connection_id only when provider='mydrop'.
-- MyDrop connection-ID matching is provider-scoped in code; no unique index on connection_id is added because legacy rows
-- may already hold duplicates (the connected-supplier sync skips those) and a failing migration would block deploys.
