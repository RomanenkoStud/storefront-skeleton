-- Manual suppliers. Widen suppliers.provider to include 'manual' (a supplier with no feed; products are created by managers).
-- SQLite cannot alter a CHECK, so the table is rebuilt. products and sync_runs keep REFERENCES suppliers(id). The pattern is
-- copy to a holding table, drop, recreate under the final name and copy back: with foreign keys deferred, re-inserting the parent
-- rows into the recreated table settles the violations raised by the DROP before commit (a plain create-new/rename does not).
PRAGMA defer_foreign_keys = true;
-- Re-runnable: a partial, non-atomic apply on remote D1 may have left the holding table behind.
DROP TABLE IF EXISTS suppliers_backup;
CREATE TABLE suppliers_backup AS SELECT id,name,url,enabled,created_at,last_sync_at,last_sync_status,last_sync_error,connection_id,last_api_request_at,deleted_at,provider,feed_key,feed_pid,feed_updated_at FROM suppliers;
DROP TABLE suppliers;
CREATE TABLE suppliers (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  url TEXT NOT NULL UNIQUE,
  enabled INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL,
  last_sync_at TEXT,
  last_sync_status TEXT,
  last_sync_error TEXT,
  connection_id TEXT,
  last_api_request_at INTEGER,
  deleted_at TEXT,
  provider TEXT NOT NULL DEFAULT 'mydrop' CHECK (provider IN ('mydrop','easydrop','manual')),
  feed_key TEXT,
  feed_pid TEXT,
  feed_updated_at TEXT
);
INSERT INTO suppliers(id,name,url,enabled,created_at,last_sync_at,last_sync_status,last_sync_error,connection_id,last_api_request_at,deleted_at,provider,feed_key,feed_pid,feed_updated_at)
  SELECT id,name,url,enabled,created_at,last_sync_at,last_sync_status,last_sync_error,connection_id,last_api_request_at,deleted_at,provider,feed_key,feed_pid,feed_updated_at FROM suppliers_backup;
DROP TABLE suppliers_backup;
CREATE INDEX suppliers_deleted ON suppliers(deleted_at);
CREATE UNIQUE INDEX suppliers_easydrop_key ON suppliers(provider, feed_key) WHERE provider='easydrop' AND feed_key IS NOT NULL;
CREATE TRIGGER recognition_suppliers_insert AFTER INSERT ON suppliers BEGIN UPDATE recognition_state SET catalog_revision=catalog_revision+1 WHERE id=1; END;
CREATE TRIGGER recognition_suppliers_update AFTER UPDATE ON suppliers BEGIN UPDATE recognition_state SET catalog_revision=catalog_revision+1 WHERE id=1; END;
CREATE TRIGGER recognition_suppliers_delete AFTER DELETE ON suppliers BEGIN UPDATE recognition_state SET catalog_revision=catalog_revision+1 WHERE id=1; END;
