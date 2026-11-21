-- keep D1 rows read/written inside the free plan.
-- Published storefront rows. A partial index on the same json_extract expression the queries use,
-- so SQLite maintains membership on every overrides_json write (PATCH, bulk, lifecycle,
-- recognition/taxonomy apply) and it cannot drift from overrides. Holds only published rows.
CREATE INDEX products_published ON products(deleted_at,supplier_id) WHERE json_extract(overrides_json,'$.published')=1;
-- Lookup by supplier product number (id = ? OR external_id = ? becomes a MULTI-INDEX OR).
CREATE INDEX products_external ON products(external_id);
-- Trash list: only trashed rows are indexed.
CREATE INDEX products_trash ON products(deleted_at) WHERE deleted_at IS NOT NULL;
