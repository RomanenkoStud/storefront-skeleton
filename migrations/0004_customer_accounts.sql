-- Customer accounts (ADR-0003). Separate from manager (Cloudflare Access) identity.
-- Profile and Nova Poshta columns belong to migration 0005.
CREATE TABLE customers (id TEXT PRIMARY KEY, status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','disabled')), created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
CREATE TABLE customer_identities (id TEXT PRIMARY KEY, customer_id TEXT NOT NULL REFERENCES customers(id) ON DELETE CASCADE, provider TEXT NOT NULL CHECK (provider IN ('google','telegram')), subject TEXT NOT NULL, display_handle TEXT, created_at TEXT NOT NULL, last_used_at TEXT, UNIQUE(provider,subject), UNIQUE(customer_id,provider));
CREATE TABLE customer_sessions (token_hash TEXT PRIMARY KEY, customer_id TEXT NOT NULL REFERENCES customers(id) ON DELETE CASCADE, created_at TEXT NOT NULL, authenticated_at TEXT NOT NULL, last_seen_at TEXT NOT NULL, idle_expires_at TEXT NOT NULL, absolute_expires_at TEXT NOT NULL);
CREATE INDEX customer_sessions_customer ON customer_sessions(customer_id);
CREATE INDEX customer_sessions_expiry ON customer_sessions(absolute_expires_at);
CREATE TABLE customer_auth_flows (binding_hash TEXT PRIMARY KEY, state_hash TEXT NOT NULL UNIQUE, provider TEXT NOT NULL CHECK (provider IN ('google','telegram')), intent TEXT NOT NULL CHECK (intent IN ('login','link')), customer_id TEXT REFERENCES customers(id) ON DELETE CASCADE, code_verifier TEXT NOT NULL, nonce TEXT NOT NULL, redirect_uri TEXT NOT NULL, return_path TEXT NOT NULL, created_at TEXT NOT NULL, expires_at TEXT NOT NULL, CHECK ((provider='google' AND intent='login') OR (provider='telegram' AND intent='link' AND customer_id IS NOT NULL)));
CREATE TABLE customer_auth_throttle (bucket TEXT NOT NULL, key_hmac TEXT NOT NULL, window_start INTEGER NOT NULL, count INTEGER NOT NULL, PRIMARY KEY (bucket,key_hmac,window_start));
CREATE TABLE customer_audit_events (id TEXT PRIMARY KEY, customer_id TEXT NOT NULL REFERENCES customers(id) ON DELETE CASCADE, action TEXT NOT NULL, fields TEXT NOT NULL DEFAULT '[]', created_at TEXT NOT NULL);
CREATE INDEX customer_audit_customer ON customer_audit_events(customer_id,created_at);
