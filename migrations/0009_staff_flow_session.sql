-- Staff auth flows remember the session that started them (ADR-0006 amendment 2026-11-15).
-- The OIDC callback is a cross-site redirect, so the SameSite=Strict session cookie is not sent to it.
ALTER TABLE staff_auth_flows ADD COLUMN session_token_hash TEXT;
