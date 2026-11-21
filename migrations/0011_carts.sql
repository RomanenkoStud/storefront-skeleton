-- Immutable checkout snapshots (ADR-0007). Only status, status_*, manager_note and updated_at ever change.
-- Status-change audit reuses audit_events (action 'cart.status', resource_id = cart code, details_json {from,to}).
CREATE TABLE carts (
  id TEXT PRIMARY KEY,
  code TEXT NOT NULL UNIQUE CHECK (length(code) = 12),
  status TEXT NOT NULL DEFAULT 'submitted' CHECK (status IN ('submitted','verified','sent_to_suppliers','cancelled')),
  customer_id TEXT REFERENCES customers(id) ON DELETE SET NULL,
  item_count INTEGER NOT NULL CHECK (typeof(item_count) = 'integer' AND item_count BETWEEN 1 AND 200),
  total_minor INTEGER NOT NULL CHECK (typeof(total_minor) = 'integer' AND total_minor >= 0),
  currency TEXT NOT NULL DEFAULT 'UAH',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  status_changed_at TEXT NOT NULL,
  status_actor TEXT,
  manager_note TEXT
);
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
  PRIMARY KEY (cart_id, position),
  UNIQUE (cart_id, product_id, size)
);
CREATE INDEX carts_created ON carts(created_at DESC, id DESC);
CREATE INDEX carts_status_created ON carts(status, created_at DESC, id DESC);
CREATE INDEX carts_customer_created ON carts(customer_id, created_at DESC) WHERE customer_id IS NOT NULL;
CREATE INDEX cart_lines_product ON cart_lines(product_id);
CREATE INDEX audit_events_resource ON audit_events(resource_id, created_at);
