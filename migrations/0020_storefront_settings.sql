-- storefront settings edited in the admin (first key: the landing campaign band).
CREATE TABLE storefront_settings(key TEXT PRIMARY KEY,value_json TEXT NOT NULL,actor TEXT NOT NULL,updated_at TEXT NOT NULL);
INSERT INTO storefront_settings VALUES('campaign','{"mode":"auto","categoryId":null,"excluded":["shorts"]}','migration','2026-11-19T00:00:00.000Z');
