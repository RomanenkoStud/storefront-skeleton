-- status «Виконано» ('completed') and retention erasure of the order's personal data.
-- SQLite cannot change the inline CHECK on carts.status, so carts is rebuilt; all rows, columns, indexes and foreign keys are kept.
-- Safety on D1 (foreign keys always enforced, defer_foreign_keys does not defer ON DELETE actions): dropping carts while
-- cart_lines still references it would CASCADE-delete every line. So cart_lines is first copied into a constraint-free
-- backup and dropped, carts is rebuilt, then cart_lines is recreated with its original definition and restored.
-- Explicit column lists everywhere (columns added by ALTER sit at the end). No triggers or views reference these tables.
-- New column: carts.pd_erased_at, set (with every rcpt_* and dp_* column nulled) by the retention job; NULL otherwise.

CREATE TABLE carts_z21 (
  id TEXT PRIMARY KEY,
  code TEXT NOT NULL UNIQUE CHECK (length(code) = 12),
  status TEXT NOT NULL DEFAULT 'submitted' CHECK (status IN ('submitted','verified','sent_to_suppliers','completed','cancelled')),
  customer_id TEXT REFERENCES customers(id) ON DELETE SET NULL,
  item_count INTEGER NOT NULL CHECK (typeof(item_count) = 'integer' AND item_count BETWEEN 1 AND 200),
  total_minor INTEGER NOT NULL CHECK (typeof(total_minor) = 'integer' AND total_minor >= 0),
  currency TEXT NOT NULL DEFAULT 'UAH',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  status_changed_at TEXT NOT NULL,
  status_actor TEXT,
  manager_note TEXT,
  dp_type TEXT CHECK (dp_type IS NULL OR dp_type IN ('branch','postomat')),
  dp_city_name TEXT,
  dp_city_ref TEXT,
  dp_warehouse_number TEXT,
  dp_warehouse_ref TEXT,
  dp_warehouse_name TEXT,
  rcpt_name TEXT,
  rcpt_phone TEXT,
  rcpt_last_name TEXT,
  rcpt_first_name TEXT,
  rcpt_middle_name TEXT,
  pd_erased_at TEXT
);
INSERT INTO carts_z21(id, code, status, customer_id, item_count, total_minor, currency, created_at, updated_at, status_changed_at, status_actor, manager_note,
  dp_type, dp_city_name, dp_city_ref, dp_warehouse_number, dp_warehouse_ref, dp_warehouse_name, rcpt_name, rcpt_phone, rcpt_last_name, rcpt_first_name, rcpt_middle_name)
  SELECT id, code, status, customer_id, item_count, total_minor, currency, created_at, updated_at, status_changed_at, status_actor, manager_note,
  dp_type, dp_city_name, dp_city_ref, dp_warehouse_number, dp_warehouse_ref, dp_warehouse_name, rcpt_name, rcpt_phone, rcpt_last_name, rcpt_first_name, rcpt_middle_name
  FROM carts;

CREATE TABLE cart_lines_z21_backup (
  cart_id TEXT, position INTEGER, product_id TEXT, slug TEXT, title TEXT, size TEXT, quantity INTEGER, unit_price_minor INTEGER, line_total_minor INTEGER, photo TEXT,
  supplier_id TEXT, supplier_name TEXT, external_product_id TEXT, variant_ids_json TEXT, unit_cost_minor INTEGER, allocations_json TEXT
);
INSERT INTO cart_lines_z21_backup(cart_id, position, product_id, slug, title, size, quantity, unit_price_minor, line_total_minor, photo, supplier_id, supplier_name, external_product_id, variant_ids_json, unit_cost_minor, allocations_json)
  SELECT cart_id, position, product_id, slug, title, size, quantity, unit_price_minor, line_total_minor, photo, supplier_id, supplier_name, external_product_id, variant_ids_json, unit_cost_minor, allocations_json
  FROM cart_lines;

DROP TABLE cart_lines;
DROP TABLE carts;
ALTER TABLE carts_z21 RENAME TO carts;

CREATE TABLE cart_lines (
  cart_id TEXT NOT NULL REFERENCES carts(id) ON DELETE CASCADE,
  position INTEGER NOT NULL CHECK (typeof(position) = 'integer' AND position >= 0 AND position < 20),
  product_id TEXT NOT NULL,
  slug TEXT NOT NULL,
  title TEXT NOT NULL,
  size TEXT NOT NULL,
  quantity INTEGER NOT NULL CHECK (typeof(quantity) = 'integer' AND quantity BETWEEN 1 AND 10),
  unit_price_minor INTEGER NOT NULL CHECK (typeof(unit_price_minor) = 'integer' AND unit_price_minor >= 0),
  line_total_minor INTEGER NOT NULL CHECK (typeof(line_total_minor) = 'integer' AND line_total_minor >= 0),
  photo TEXT,
  -- PRIVATE (staff only): never in public or customer responses.
  supplier_id TEXT NOT NULL,
  supplier_name TEXT NOT NULL,
  external_product_id TEXT NOT NULL,
  variant_ids_json TEXT NOT NULL DEFAULT '[]',
  unit_cost_minor INTEGER CHECK (unit_cost_minor IS NULL OR (typeof(unit_cost_minor) = 'integer' AND unit_cost_minor >= 0)),
  allocations_json TEXT,
  PRIMARY KEY (cart_id, position),
  UNIQUE (cart_id, product_id, size)
);
INSERT INTO cart_lines(cart_id, position, product_id, slug, title, size, quantity, unit_price_minor, line_total_minor, photo, supplier_id, supplier_name, external_product_id, variant_ids_json, unit_cost_minor, allocations_json)
  SELECT cart_id, position, product_id, slug, title, size, quantity, unit_price_minor, line_total_minor, photo, supplier_id, supplier_name, external_product_id, variant_ids_json, unit_cost_minor, allocations_json
  FROM cart_lines_z21_backup;
DROP TABLE cart_lines_z21_backup;

CREATE INDEX carts_created ON carts(created_at DESC, id DESC);
CREATE INDEX carts_status_created ON carts(status, created_at DESC, id DESC);
CREATE INDEX carts_customer_created ON carts(customer_id, created_at DESC) WHERE customer_id IS NOT NULL;
CREATE INDEX cart_lines_product ON cart_lines(product_id);
-- 0014_media.sql runs before this rebuild on a fresh database and its cart_lines index would be dropped with the table.
CREATE INDEX IF NOT EXISTS cart_lines_photo ON cart_lines(photo) WHERE photo IS NOT NULL;
-- Retention job (apps/api/src/order-retention.js): only carts that still hold personal data. The WHERE must stay textually
-- identical to PD_PENDING in that module so SQLite can use this partial index.
CREATE INDEX carts_pd_pending ON carts(created_at, id) WHERE pd_erased_at IS NULL AND (rcpt_name IS NOT NULL OR rcpt_phone IS NOT NULL OR rcpt_last_name IS NOT NULL OR rcpt_first_name IS NOT NULL OR rcpt_middle_name IS NOT NULL OR dp_type IS NOT NULL OR dp_city_name IS NOT NULL OR dp_city_ref IS NOT NULL OR dp_warehouse_number IS NOT NULL OR dp_warehouse_ref IS NOT NULL OR dp_warehouse_name IS NOT NULL);
