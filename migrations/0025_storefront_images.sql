-- staff-chosen images that replace the shipped rack renders (front/side/angle/shoe) and the
-- poster-tile cut-out, one per category and slot. Staff data only; media_key is public only while a row holds it.
CREATE TABLE storefront_images(
  category_id TEXT NOT NULL,
  slot TEXT NOT NULL CHECK(slot IN ('front','side','angle','shoe','poster')),
  media_key TEXT NOT NULL UNIQUE,
  width INTEGER NOT NULL CHECK(width BETWEEN 64 AND 1600),
  height INTEGER NOT NULL CHECK(height BETWEEN 64 AND 1600),
  actor TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY(category_id, slot)
);
