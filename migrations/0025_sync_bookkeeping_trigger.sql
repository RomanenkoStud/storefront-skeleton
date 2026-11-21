-- hourly supplier sync updates suppliers' sync bookkeeping (last_sync_*, last_api_request_at) several times
-- an hour. Those columns never affect recognition or taxonomy previews, so they no longer bump catalog_revision
-- (which made open previews 409 "stale"). Every other column still does.
DROP TRIGGER IF EXISTS recognition_suppliers_update;
CREATE TRIGGER recognition_suppliers_update AFTER UPDATE OF id,name,url,enabled,created_at,connection_id,deleted_at,provider,feed_key,feed_pid,feed_updated_at ON suppliers BEGIN UPDATE recognition_state SET catalog_revision=catalog_revision+1 WHERE id=1; END;
-- Per-supplier last successful run (admin supplier list) without scanning all sync_runs.
CREATE INDEX IF NOT EXISTS sync_runs_supplier_status ON sync_runs(supplier_id,status,created_at);
