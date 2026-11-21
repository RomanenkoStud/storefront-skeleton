-- Cross-supplier duplicate review. Manager decisions only: candidates are computed on request
-- and never stored. Source snapshots and overlays are untouched; product IDs are stable across reimport, so
-- decisions survive sync. Step 1 does not change the public projection.
CREATE TABLE duplicate_groups (
  id TEXT PRIMARY KEY,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  actor TEXT NOT NULL
);
-- One group per product (primary key). At most one product per supplier is enforced by the API.
CREATE TABLE duplicate_group_members (
  product_id TEXT PRIMARY KEY REFERENCES products(id) ON DELETE CASCADE,
  group_id TEXT NOT NULL REFERENCES duplicate_groups(id) ON DELETE CASCADE,
  added_at TEXT NOT NULL,
  actor TEXT NOT NULL
);
CREATE INDEX duplicate_group_members_group ON duplicate_group_members(group_id);
-- "Not the same item" decisions, stored once per unordered pair (product_a < product_b).
CREATE TABLE duplicate_rejections (
  product_a TEXT NOT NULL REFERENCES products(id) ON DELETE CASCADE,
  product_b TEXT NOT NULL REFERENCES products(id) ON DELETE CASCADE,
  created_at TEXT NOT NULL,
  actor TEXT NOT NULL,
  PRIMARY KEY (product_a, product_b),
  CHECK (product_a < product_b)
);
CREATE INDEX duplicate_rejections_created ON duplicate_rejections(created_at);
-- In-transaction guard (same pattern as recognition/taxonomy): a group write ends by inserting valid=1 only if the
-- group still has the expected member count and at most one product per supplier; otherwise the batch rolls back.
CREATE TABLE duplicate_guards (token TEXT PRIMARY KEY, valid INTEGER NOT NULL CHECK(valid=1));
