CREATE TABLE product_cost_versions (
 id TEXT PRIMARY KEY NOT NULL,
 sku TEXT NOT NULL REFERENCES sku_settings(sku),
 site TEXT NOT NULL CHECK(site IN ('印尼','马来西亚','菲律宾','泰国','越南')),
 version INTEGER NOT NULL CHECK(version>0),
 purchase INTEGER CHECK(purchase>=0),
 freight INTEGER CHECK(freight>=0),
 total INTEGER CHECK(total>=0),
 currency TEXT NOT NULL CHECK(currency='CNY'),
 basis TEXT NOT NULL CHECK(basis IN ('unconfirmed','purchase_freight','landed')),
 effective_date TEXT NOT NULL,
 source_json TEXT NOT NULL,
 import_id TEXT NOT NULL,
 reason TEXT NOT NULL,
 actor_id TEXT NOT NULL,
 actor_name TEXT NOT NULL,
 created_at TEXT NOT NULL,
 UNIQUE(sku,site,version)
);
CREATE INDEX product_cost_scope ON product_cost_versions(site,sku,effective_date);
CREATE TABLE product_cost_imports (
 id TEXT PRIMARY KEY NOT NULL,
 fingerprint TEXT NOT NULL UNIQUE,
 file_name TEXT NOT NULL,
 file_hash TEXT NOT NULL,
 created_at TEXT NOT NULL,
 actor_id TEXT NOT NULL,
 summary_json TEXT NOT NULL
);
CREATE TABLE product_class_rules (
 version INTEGER PRIMARY KEY NOT NULL CHECK(version>0),
 data_json TEXT NOT NULL,
 reason TEXT NOT NULL,
 actor_id TEXT NOT NULL,
 created_at TEXT NOT NULL
);
CREATE TABLE product_cost_clock (id TEXT PRIMARY KEY NOT NULL,version INTEGER NOT NULL);
CREATE TRIGGER product_cost_versions_immutable_update BEFORE UPDATE ON product_cost_versions BEGIN SELECT RAISE(ABORT,'immutable product cost history'); END;
CREATE TRIGGER product_cost_versions_immutable_delete BEFORE DELETE ON product_cost_versions BEGIN SELECT RAISE(ABORT,'immutable product cost history'); END;
CREATE TRIGGER product_cost_versions_clock AFTER INSERT ON product_cost_versions BEGIN INSERT INTO product_cost_clock VALUES('global',1) ON CONFLICT(id) DO UPDATE SET version=version+1; END;
CREATE TRIGGER maintenance_product_cost_versions_insert BEFORE INSERT ON product_cost_versions WHEN EXISTS(SELECT 1 FROM system_maintenance WHERE id='global' AND mode<>'normal' AND expires_at>strftime('%Y-%m-%dT%H:%M:%fZ','now')) BEGIN SELECT RAISE(ABORT,'guard_maintenance'); END;
CREATE TRIGGER maintenance_product_cost_versions_update BEFORE UPDATE ON product_cost_versions WHEN EXISTS(SELECT 1 FROM system_maintenance WHERE id='global' AND mode<>'normal' AND expires_at>strftime('%Y-%m-%dT%H:%M:%fZ','now')) BEGIN SELECT RAISE(ABORT,'guard_maintenance'); END;
CREATE TRIGGER maintenance_product_cost_versions_delete BEFORE DELETE ON product_cost_versions WHEN EXISTS(SELECT 1 FROM system_maintenance WHERE id='global' AND mode<>'normal' AND expires_at>strftime('%Y-%m-%dT%H:%M:%fZ','now')) BEGIN SELECT RAISE(ABORT,'guard_maintenance'); END;
CREATE TRIGGER product_cost_imports_immutable_update BEFORE UPDATE ON product_cost_imports BEGIN SELECT RAISE(ABORT,'immutable product cost history'); END;
CREATE TRIGGER product_cost_imports_immutable_delete BEFORE DELETE ON product_cost_imports BEGIN SELECT RAISE(ABORT,'immutable product cost history'); END;
CREATE TRIGGER product_cost_imports_clock AFTER INSERT ON product_cost_imports BEGIN INSERT INTO product_cost_clock VALUES('global',1) ON CONFLICT(id) DO UPDATE SET version=version+1; END;
CREATE TRIGGER maintenance_product_cost_imports_insert BEFORE INSERT ON product_cost_imports WHEN EXISTS(SELECT 1 FROM system_maintenance WHERE id='global' AND mode<>'normal' AND expires_at>strftime('%Y-%m-%dT%H:%M:%fZ','now')) BEGIN SELECT RAISE(ABORT,'guard_maintenance'); END;
CREATE TRIGGER maintenance_product_cost_imports_update BEFORE UPDATE ON product_cost_imports WHEN EXISTS(SELECT 1 FROM system_maintenance WHERE id='global' AND mode<>'normal' AND expires_at>strftime('%Y-%m-%dT%H:%M:%fZ','now')) BEGIN SELECT RAISE(ABORT,'guard_maintenance'); END;
CREATE TRIGGER maintenance_product_cost_imports_delete BEFORE DELETE ON product_cost_imports WHEN EXISTS(SELECT 1 FROM system_maintenance WHERE id='global' AND mode<>'normal' AND expires_at>strftime('%Y-%m-%dT%H:%M:%fZ','now')) BEGIN SELECT RAISE(ABORT,'guard_maintenance'); END;
CREATE TRIGGER product_class_rules_immutable_update BEFORE UPDATE ON product_class_rules BEGIN SELECT RAISE(ABORT,'immutable product cost history'); END;
CREATE TRIGGER product_class_rules_immutable_delete BEFORE DELETE ON product_class_rules BEGIN SELECT RAISE(ABORT,'immutable product cost history'); END;
CREATE TRIGGER product_class_rules_clock AFTER INSERT ON product_class_rules BEGIN INSERT INTO product_cost_clock VALUES('global',1) ON CONFLICT(id) DO UPDATE SET version=version+1; END;
CREATE TRIGGER maintenance_product_class_rules_insert BEFORE INSERT ON product_class_rules WHEN EXISTS(SELECT 1 FROM system_maintenance WHERE id='global' AND mode<>'normal' AND expires_at>strftime('%Y-%m-%dT%H:%M:%fZ','now')) BEGIN SELECT RAISE(ABORT,'guard_maintenance'); END;
CREATE TRIGGER maintenance_product_class_rules_update BEFORE UPDATE ON product_class_rules WHEN EXISTS(SELECT 1 FROM system_maintenance WHERE id='global' AND mode<>'normal' AND expires_at>strftime('%Y-%m-%dT%H:%M:%fZ','now')) BEGIN SELECT RAISE(ABORT,'guard_maintenance'); END;
CREATE TRIGGER maintenance_product_class_rules_delete BEFORE DELETE ON product_class_rules WHEN EXISTS(SELECT 1 FROM system_maintenance WHERE id='global' AND mode<>'normal' AND expires_at>strftime('%Y-%m-%dT%H:%M:%fZ','now')) BEGIN SELECT RAISE(ABORT,'guard_maintenance'); END;
