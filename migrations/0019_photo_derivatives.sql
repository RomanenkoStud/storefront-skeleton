-- Derived image variants. Today: the 'card' thumbnail of a product's FIRST photo, produced by the
-- nightly tools/card-thumbnails.mjs. Derived data only: it never touches the supplier snapshot (source_json) or the
-- manager overlay (overrides_json), and can be dropped and regenerated at any time. Keyed by the original photo URL,
-- so a changed first photo simply has no row until the next run. A NULL url records "the derivative would not have
-- been smaller than the original": the card keeps using the original and the tool does not retry it.
CREATE TABLE photo_derivatives (
  source_url TEXT NOT NULL,
  variant TEXT NOT NULL CHECK (variant IN ('card')),
  -- Content-addressed, never overwritten: /media/<32 hex of sha256(source_url)>-<16 hex of sha256(source bytes + params)>.card.webp
  url TEXT CHECK (url IS NULL OR (length(url) = 66 AND url GLOB '/media/*-*.card.webp')),
  width INTEGER,
  height INTEGER,
  bytes INTEGER,
  source_bytes INTEGER,
  source_hash TEXT, -- sha256 of the original bytes the derivative was made from
  params TEXT, -- encoder settings version (variant, version, edge, quality, format); a change regenerates under a new key
  created_at TEXT NOT NULL,
  PRIMARY KEY (source_url, variant)
);
-- Media serving authorizes a thumbnail by its own URL.
CREATE UNIQUE INDEX photo_derivatives_url ON photo_derivatives(url) WHERE url IS NOT NULL;
