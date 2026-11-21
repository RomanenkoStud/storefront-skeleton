PRAGMA foreign_keys = ON;
CREATE TABLE suppliers (id TEXT PRIMARY KEY, name TEXT NOT NULL, url TEXT NOT NULL UNIQUE, enabled INTEGER NOT NULL DEFAULT 1, created_at TEXT NOT NULL, last_sync_at TEXT, last_sync_status TEXT, last_sync_error TEXT);
CREATE TABLE products (id TEXT PRIMARY KEY, supplier_id TEXT NOT NULL REFERENCES suppliers(id), external_id TEXT NOT NULL, source_json TEXT NOT NULL, overrides_json TEXT NOT NULL DEFAULT '{}', slug TEXT NOT NULL UNIQUE, updated_at TEXT NOT NULL, UNIQUE(supplier_id,external_id));
CREATE INDEX products_supplier ON products(supplier_id);
CREATE TABLE slug_redirects (slug TEXT PRIMARY KEY, product_id TEXT NOT NULL REFERENCES products(id));
CREATE TABLE sync_runs (id TEXT PRIMARY KEY, supplier_id TEXT NOT NULL REFERENCES suppliers(id), status TEXT NOT NULL, imported INTEGER NOT NULL DEFAULT 0, error TEXT, created_at TEXT NOT NULL);
CREATE INDEX sync_runs_created ON sync_runs(created_at);
CREATE TABLE audit_events (id TEXT PRIMARY KEY, actor TEXT NOT NULL, action TEXT NOT NULL, resource_id TEXT NOT NULL, created_at TEXT NOT NULL);
