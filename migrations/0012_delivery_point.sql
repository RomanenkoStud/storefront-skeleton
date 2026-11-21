-- Nova Poshta delivery point (ADR-0011): the favourite gains a display name and an origin; carts get an immutable point snapshot.
-- Additive only. Legacy preferences keep np_source='manual' and np_origin NULL; dp_* are written at checkout and cleared on account deletion.
ALTER TABLE customer_profiles ADD COLUMN np_warehouse_name TEXT;
ALTER TABLE customer_profiles ADD COLUMN np_origin TEXT CHECK (np_origin IS NULL OR np_origin IN ('cabinet','checkout'));
ALTER TABLE carts ADD COLUMN dp_type TEXT CHECK (dp_type IS NULL OR dp_type IN ('branch','postomat'));
ALTER TABLE carts ADD COLUMN dp_city_name TEXT;
ALTER TABLE carts ADD COLUMN dp_city_ref TEXT;
ALTER TABLE carts ADD COLUMN dp_warehouse_number TEXT;
ALTER TABLE carts ADD COLUMN dp_warehouse_ref TEXT;
ALTER TABLE carts ADD COLUMN dp_warehouse_name TEXT;
