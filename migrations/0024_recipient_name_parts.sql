-- ПІБ as three separate parts («Прізвище», «Імʼя», «По батькові»). Additive only: nullable columns, no backfill.
-- Cart recipient snapshot (signed-in checkouts only, cleared on account deletion). Carts created by the single-field checkout keep rcpt_name
-- and are returned with null parts and that legacy name; new checkouts write the parts and leave rcpt_name NULL.
ALTER TABLE carts ADD COLUMN rcpt_last_name TEXT;
ALTER TABLE carts ADD COLUMN rcpt_first_name TEXT;
ALTER TABLE carts ADD COLUMN rcpt_middle_name TEXT;
-- Profile «Контакти»: prefill for the checkout recipient. display_name is kept untouched (no guessed split).
ALTER TABLE customer_profiles ADD COLUMN last_name TEXT;
ALTER TABLE customer_profiles ADD COLUMN first_name TEXT;
ALTER TABLE customer_profiles ADD COLUMN middle_name TEXT;
