-- Staff roles and staff Google sign-in (ADR-0006). Separate from customer tables; no seed rows.
CREATE TABLE staff_members (
  id TEXT PRIMARY KEY,
  role TEXT NOT NULL CHECK (role IN ('owner','manager')),
  status TEXT NOT NULL CHECK (status IN ('invited','active','suspended','removed')),
  invited_email TEXT,            -- lowercase; matched once at first sign-in; NULL after removal
  google_sub TEXT,               -- NULL until first sign-in and after removal
  email TEXT,                    -- last verified Google email, display only
  display_name TEXT NOT NULL,
  created_by TEXT NOT NULL,      -- actor string
  created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
  invitation_expires_at TEXT, activated_at TEXT, last_sign_in_at TEXT, suspended_at TEXT, removed_at TEXT,
  CHECK (status <> 'invited' OR (google_sub IS NULL AND invited_email IS NOT NULL AND invitation_expires_at IS NOT NULL)),
  CHECK (status NOT IN ('active','suspended') OR google_sub IS NOT NULL),
  CHECK (status <> 'removed' OR (google_sub IS NULL AND invited_email IS NULL AND email IS NULL))
);
CREATE UNIQUE INDEX staff_members_sub ON staff_members(google_sub) WHERE google_sub IS NOT NULL;
CREATE UNIQUE INDEX staff_members_invited_email ON staff_members(invited_email) WHERE invited_email IS NOT NULL AND status IN ('invited','active','suspended');
CREATE TABLE staff_sessions (token_hash TEXT PRIMARY KEY, staff_id TEXT NOT NULL REFERENCES staff_members(id) ON DELETE CASCADE, created_at TEXT NOT NULL, authenticated_at TEXT NOT NULL, last_seen_at TEXT NOT NULL, idle_expires_at TEXT NOT NULL, absolute_expires_at TEXT NOT NULL);
CREATE INDEX staff_sessions_staff ON staff_sessions(staff_id);
CREATE INDEX staff_sessions_expiry ON staff_sessions(absolute_expires_at);
CREATE TABLE staff_auth_flows (binding_hash TEXT PRIMARY KEY, state_hash TEXT NOT NULL UNIQUE, intent TEXT NOT NULL CHECK (intent IN ('login','reauth')), staff_id TEXT REFERENCES staff_members(id) ON DELETE CASCADE, code_verifier TEXT NOT NULL, nonce TEXT NOT NULL, redirect_uri TEXT NOT NULL, return_path TEXT NOT NULL CHECK (return_path = '/staff'), created_at TEXT NOT NULL, expires_at TEXT NOT NULL, CHECK ((intent='login' AND staff_id IS NULL) OR (intent='reauth' AND staff_id IS NOT NULL)));
CREATE TABLE staff_auth_throttle (bucket TEXT NOT NULL, key_hmac TEXT NOT NULL, window_start INTEGER NOT NULL, count INTEGER NOT NULL, PRIMARY KEY (bucket,key_hmac,window_start));
ALTER TABLE audit_events ADD COLUMN actor_type TEXT CHECK (actor_type IS NULL OR actor_type IN ('access','staff','dev','system'));
ALTER TABLE audit_events ADD COLUMN actor_role TEXT CHECK (actor_role IS NULL OR actor_role IN ('owner','manager'));
ALTER TABLE audit_events ADD COLUMN details_json TEXT;
CREATE INDEX audit_events_created ON audit_events(created_at);
