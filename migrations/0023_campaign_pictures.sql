-- Campaign pictures (ADR-0015): staff-managed cut-out pictures per category for the campaign band.
-- Staff data only: never a supplier snapshot or product overlay. media_key is public only while a row holds it.
CREATE TABLE campaign_pictures(
  id TEXT PRIMARY KEY,
  category_id TEXT NOT NULL,
  media_key TEXT NOT NULL UNIQUE,
  width INTEGER NOT NULL CHECK(width BETWEEN 64 AND 1600),
  height INTEGER NOT NULL CHECK(height BETWEEN 64 AND 1600),
  position INTEGER NOT NULL,
  actor TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX campaign_pictures_category ON campaign_pictures(category_id, position);
