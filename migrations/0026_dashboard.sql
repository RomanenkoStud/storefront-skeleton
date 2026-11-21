-- Admin dashboard and infrastructure page.
--
-- Cookieless, anonymous visit statistics. No IP address, user agent, cookie or device storage is kept:
-- `visitor` is a truncated SHA-256 of (daily random salt, IP, user agent), and the salt for a day is deleted
-- after that day, so a visitor cannot be linked across days or re-identified from the stored hash.
CREATE TABLE analytics_salts (
  day TEXT PRIMARY KEY CHECK (length(day) = 10),   -- Europe/Kyiv calendar day, YYYY-MM-DD
  salt TEXT NOT NULL,
  created_at TEXT NOT NULL
);
-- One row per visit session (30 minutes of inactivity ends a session). Upserted, never one row per page view.
CREATE TABLE visit_sessions (
  id TEXT PRIMARY KEY,
  visitor TEXT NOT NULL,
  day TEXT NOT NULL CHECK (length(day) = 10),       -- Europe/Kyiv day the session started
  started_at TEXT NOT NULL,
  last_seen_at TEXT NOT NULL,
  pageviews INTEGER NOT NULL DEFAULT 1 CHECK (typeof(pageviews) = 'integer' AND pageviews >= 0),
  country TEXT,                                     -- ISO 3166-1 alpha-2 from Cloudflare, or NULL
  region TEXT,                                      -- Cloudflare region name (oblast/state), or NULL
  device TEXT NOT NULL DEFAULT 'desktop' CHECK (device IN ('mobile','tablet','desktop')),
  referrer TEXT,                                    -- external referrer host only, never a full URL
  entry_path TEXT
);
CREATE INDEX visit_sessions_visitor ON visit_sessions(visitor, last_seen_at DESC);
CREATE INDEX visit_sessions_day ON visit_sessions(day);
CREATE INDEX visit_sessions_started ON visit_sessions(started_at);

-- Cached infrastructure measurements (for example the R2 media total, which needs a paginated list).
CREATE TABLE infra_snapshots (
  key TEXT PRIMARY KEY,
  value_json TEXT NOT NULL,
  measured_at TEXT NOT NULL
);
-- Single-row infrastructure settings: the Cloudflare plan used for limits and cost estimates.
CREATE TABLE infra_settings (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  plan TEXT NOT NULL DEFAULT 'workers_paid' CHECK (plan IN ('workers_paid','workers_free')),
  updated_at TEXT,
  updated_by TEXT
);
INSERT INTO infra_settings(id, plan) VALUES (1, 'workers_paid');
-- Owner-maintained renewal reminders (domain, subscriptions, certificates). Shown in the cabinet only.
CREATE TABLE infra_renewals (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL CHECK (kind IN ('domain','subscription','other')),
  name TEXT NOT NULL CHECK (length(name) BETWEEN 1 AND 120),
  due_date TEXT CHECK (due_date IS NULL OR length(due_date) = 10),   -- YYYY-MM-DD; NULL = not entered yet
  cost_minor INTEGER CHECK (cost_minor IS NULL OR (typeof(cost_minor) = 'integer' AND cost_minor >= 0)),
  currency TEXT NOT NULL DEFAULT 'UAH' CHECK (currency IN ('UAH','USD','EUR')),
  auto_renew INTEGER NOT NULL DEFAULT 0 CHECK (auto_renew IN (0,1)),
  notes TEXT NOT NULL DEFAULT '' CHECK (length(notes) <= 500),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX infra_renewals_due ON infra_renewals(due_date);
-- The shop domain, with its expiry date still to be entered by the owner (the reminder asks for it until then).
INSERT INTO infra_renewals(id, kind, name, due_date, notes, created_at, updated_at)
VALUES ('domain-example-com', 'domain', 'example.com', NULL, 'Вкажіть справжню дату закінчення реєстрації домену.', strftime('%Y-%m-%dT%H:%M:%fZ','now'), strftime('%Y-%m-%dT%H:%M:%fZ','now'));
