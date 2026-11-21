-- Media tracking, reference index and permanent-deletion tombstones. See docs/API.md "Media library".
-- 0012 is delivery points (on staging) and 0013 the D1 read-budget task.
-- R2 cannot be read from SQL, so existing objects are tracked later by the manual, resumable scan in the Media library.
-- This migration never deletes media.
CREATE TABLE media_objects (
  key TEXT PRIMARY KEY,
  size INTEGER,
  content_type TEXT,
  sha256 TEXT,
  kind TEXT NOT NULL DEFAULT 'unknown' CHECK (kind IN ('upload','original','cutout','normalized','unknown')),
  product_id TEXT,
  original_key TEXT,
  cutout_key TEXT,
  created_at TEXT NOT NULL,
  touched_at TEXT,
  scanned_at TEXT
);
CREATE INDEX media_objects_sha ON media_objects(sha256, content_type) WHERE sha256 IS NOT NULL;
CREATE INDEX media_objects_original ON media_objects(original_key) WHERE original_key IS NOT NULL;
CREATE INDEX media_objects_cutout ON media_objects(cutout_key) WHERE cutout_key IS NOT NULL;

-- Every /media/<key> photo of every product (source or overrides, including Trash).
CREATE TABLE media_refs (key TEXT NOT NULL, product_id TEXT NOT NULL, PRIMARY KEY (key, product_id)) WITHOUT ROWID;
CREATE INDEX media_refs_product ON media_refs(product_id);

INSERT OR IGNORE INTO media_refs(key, product_id)
  SELECT substr(j.value, 8), p.id FROM products p, json_each(p.source_json, '$.photos') j WHERE j.type = 'text' AND j.value GLOB '/media/?*'
  UNION SELECT substr(j.value, 8), p.id FROM products p, json_each(p.overrides_json, '$.photos') j WHERE j.type = 'text' AND j.value GLOB '/media/?*';

CREATE TRIGGER media_refs_products_insert AFTER INSERT ON products
  WHEN instr(NEW.source_json, '/media/') > 0 OR instr(NEW.overrides_json, '/media/') > 0
BEGIN
  INSERT OR IGNORE INTO media_refs(key, product_id)
    SELECT substr(value, 8), NEW.id FROM json_each(NEW.source_json, '$.photos') WHERE type = 'text' AND value GLOB '/media/?*'
    UNION SELECT substr(value, 8), NEW.id FROM json_each(NEW.overrides_json, '$.photos') WHERE type = 'text' AND value GLOB '/media/?*';
END;
CREATE TRIGGER media_refs_products_update AFTER UPDATE OF source_json, overrides_json ON products
  WHEN instr(OLD.source_json, '/media/') + instr(OLD.overrides_json, '/media/') + instr(NEW.source_json, '/media/') + instr(NEW.overrides_json, '/media/') > 0
BEGIN
  DELETE FROM media_refs WHERE product_id = OLD.id;
  INSERT OR IGNORE INTO media_refs(key, product_id)
    SELECT substr(value, 8), NEW.id FROM json_each(NEW.source_json, '$.photos') WHERE type = 'text' AND value GLOB '/media/?*'
    UNION SELECT substr(value, 8), NEW.id FROM json_each(NEW.overrides_json, '$.photos') WHERE type = 'text' AND value GLOB '/media/?*';
END;
CREATE TRIGGER media_refs_products_delete AFTER DELETE ON products
BEGIN
  DELETE FROM media_refs WHERE product_id = OLD.id;
END;

-- Past carts keep their photo alive; the reference check looks this up per key.
CREATE INDEX IF NOT EXISTS cart_lines_photo ON cart_lines(photo) WHERE photo IS NOT NULL;

-- Permanently deleted products: imports and syncs never recreate them.
CREATE TABLE product_tombstones (
  supplier_id TEXT NOT NULL,
  external_id TEXT NOT NULL,
  product_id TEXT NOT NULL,
  purged_at TEXT NOT NULL,
  PRIMARY KEY (supplier_id, external_id)
) WITHOUT ROWID;
CREATE TRIGGER product_tombstones_block_insert BEFORE INSERT ON products
  WHEN EXISTS (SELECT 1 FROM product_tombstones t WHERE t.supplier_id = NEW.supplier_id AND t.external_id = NEW.external_id)
   AND NOT EXISTS (SELECT 1 FROM products p WHERE p.supplier_id = NEW.supplier_id AND p.external_id = NEW.external_id)
BEGIN
  SELECT RAISE(IGNORE);
END;

CREATE TABLE media_state (id INTEGER PRIMARY KEY CHECK (id = 1), last_scan_at TEXT);
INSERT INTO media_state(id, last_scan_at) VALUES (1, NULL);
