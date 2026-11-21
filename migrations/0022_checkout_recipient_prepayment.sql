-- three-step checkout. Additive only.
-- Recipient («Отримувач») snapshot on the cart: written at checkout for signed-in customers only (like dp_*), cleared on account deletion.
ALTER TABLE carts ADD COLUMN rcpt_name TEXT;
ALTER TABLE carts ADD COLUMN rcpt_phone TEXT;
-- Prepayment shown on the cart step, set by the owner in the admin «Вітрина» tool. Integer kopecks (UAH); 0 hides the line.
INSERT OR IGNORE INTO storefront_settings VALUES('checkout','{"prepaymentMinor":0}','migration','2026-11-19T00:00:00.000Z');
