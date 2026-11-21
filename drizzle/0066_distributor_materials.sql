ALTER TABLE distributor_stores ADD COLUMN access_mode TEXT NOT NULL DEFAULT 'full' CHECK(access_mode IN ('full','materials'));
CREATE TABLE distributor_materials (
 id TEXT PRIMARY KEY, sku TEXT NOT NULL REFERENCES sku_settings(sku), title_id TEXT NOT NULL,
 kind TEXT NOT NULL CHECK(kind IN ('image','video')), mime TEXT NOT NULL, bytes INTEGER NOT NULL,
 object_key TEXT NOT NULL UNIQUE, cover_key TEXT NOT NULL UNIQUE, cover_mime TEXT NOT NULL, cover_bytes INTEGER NOT NULL,
 status TEXT NOT NULL DEFAULT 'uploading' CHECK(status IN ('uploading','draft','published','withdrawn')),
 upload_expires TEXT NOT NULL, rights_note TEXT NOT NULL DEFAULT '', channels TEXT NOT NULL DEFAULT '',
 rights_until TEXT NOT NULL DEFAULT '', version INTEGER NOT NULL DEFAULT 1,
 created_by TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
);
CREATE INDEX distributor_materials_sku ON distributor_materials(sku,status);
CREATE TABLE distributor_material_grants (
 customer_id TEXT NOT NULL REFERENCES distributor_stores(customer_id), sku TEXT NOT NULL REFERENCES sku_settings(sku),
 active INTEGER NOT NULL CHECK(active IN (0,1)), updated_by TEXT NOT NULL, updated_at TEXT NOT NULL,
 PRIMARY KEY(customer_id,sku)
);
CREATE TABLE distributor_material_issues (
 id TEXT PRIMARY KEY, customer_id TEXT NOT NULL REFERENCES distributor_stores(customer_id),
 material_id TEXT NOT NULL REFERENCES distributor_materials(id), purpose TEXT NOT NULL CHECK(purpose IN ('preview','play','download')),
 issued_at TEXT NOT NULL, expires_at TEXT NOT NULL,
 outcome TEXT NOT NULL DEFAULT 'link_issued' CHECK(outcome='link_issued')
);
CREATE INDEX distributor_material_issues_customer ON distributor_material_issues(customer_id,issued_at);

CREATE TRIGGER maintenance_distributor_materials_insert BEFORE INSERT ON distributor_materials WHEN EXISTS(SELECT 1 FROM system_maintenance WHERE id='global' AND mode<>'normal' AND expires_at>strftime('%Y-%m-%dT%H:%M:%fZ','now')) BEGIN SELECT RAISE(ABORT,'guard_maintenance'); END;

CREATE TRIGGER maintenance_distributor_materials_update BEFORE UPDATE ON distributor_materials WHEN EXISTS(SELECT 1 FROM system_maintenance WHERE id='global' AND mode<>'normal' AND expires_at>strftime('%Y-%m-%dT%H:%M:%fZ','now')) BEGIN SELECT RAISE(ABORT,'guard_maintenance'); END;

CREATE TRIGGER maintenance_distributor_materials_delete BEFORE DELETE ON distributor_materials WHEN EXISTS(SELECT 1 FROM system_maintenance WHERE id='global' AND mode<>'normal' AND expires_at>strftime('%Y-%m-%dT%H:%M:%fZ','now')) BEGIN SELECT RAISE(ABORT,'guard_maintenance'); END;

CREATE TRIGGER maintenance_distributor_material_grants_insert BEFORE INSERT ON distributor_material_grants WHEN EXISTS(SELECT 1 FROM system_maintenance WHERE id='global' AND mode<>'normal' AND expires_at>strftime('%Y-%m-%dT%H:%M:%fZ','now')) BEGIN SELECT RAISE(ABORT,'guard_maintenance'); END;

CREATE TRIGGER maintenance_distributor_material_grants_update BEFORE UPDATE ON distributor_material_grants WHEN EXISTS(SELECT 1 FROM system_maintenance WHERE id='global' AND mode<>'normal' AND expires_at>strftime('%Y-%m-%dT%H:%M:%fZ','now')) BEGIN SELECT RAISE(ABORT,'guard_maintenance'); END;

CREATE TRIGGER maintenance_distributor_material_grants_delete BEFORE DELETE ON distributor_material_grants WHEN EXISTS(SELECT 1 FROM system_maintenance WHERE id='global' AND mode<>'normal' AND expires_at>strftime('%Y-%m-%dT%H:%M:%fZ','now')) BEGIN SELECT RAISE(ABORT,'guard_maintenance'); END;

CREATE TRIGGER maintenance_distributor_material_issues_insert BEFORE INSERT ON distributor_material_issues WHEN EXISTS(SELECT 1 FROM system_maintenance WHERE id='global' AND mode<>'normal' AND expires_at>strftime('%Y-%m-%dT%H:%M:%fZ','now')) BEGIN SELECT RAISE(ABORT,'guard_maintenance'); END;

CREATE TRIGGER maintenance_distributor_material_issues_update BEFORE UPDATE ON distributor_material_issues WHEN EXISTS(SELECT 1 FROM system_maintenance WHERE id='global' AND mode<>'normal' AND expires_at>strftime('%Y-%m-%dT%H:%M:%fZ','now')) BEGIN SELECT RAISE(ABORT,'guard_maintenance'); END;

CREATE TRIGGER maintenance_distributor_material_issues_delete BEFORE DELETE ON distributor_material_issues WHEN EXISTS(SELECT 1 FROM system_maintenance WHERE id='global' AND mode<>'normal' AND expires_at>strftime('%Y-%m-%dT%H:%M:%fZ','now')) BEGIN SELECT RAISE(ABORT,'guard_maintenance'); END;
