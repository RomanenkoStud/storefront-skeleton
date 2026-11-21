ALTER TABLE suppliers ADD COLUMN deleted_at TEXT;
ALTER TABLE products ADD COLUMN deleted_at TEXT;
CREATE INDEX suppliers_deleted ON suppliers(deleted_at);
CREATE INDEX products_deleted ON products(deleted_at,supplier_id);
