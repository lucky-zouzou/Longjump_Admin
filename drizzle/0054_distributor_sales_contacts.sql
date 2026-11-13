CREATE TABLE distributor_sales_contacts (
 user_id TEXT PRIMARY KEY REFERENCES users(id),
 display_name TEXT NOT NULL DEFAULT '',
 whatsapp TEXT NOT NULL DEFAULT '',
 version INTEGER NOT NULL DEFAULT 1 CHECK(version>0),
 updated_by TEXT NOT NULL REFERENCES users(id),
 updated_at TEXT NOT NULL
);
CREATE TRIGGER maintenance_distributor_contacts_insert BEFORE INSERT ON distributor_sales_contacts WHEN EXISTS(SELECT 1 FROM system_maintenance WHERE id='global' AND mode<>'normal' AND expires_at>strftime('%Y-%m-%dT%H:%M:%fZ','now')) BEGIN SELECT RAISE(ABORT,'guard_maintenance'); END;
CREATE TRIGGER maintenance_distributor_contacts_update BEFORE UPDATE ON distributor_sales_contacts WHEN EXISTS(SELECT 1 FROM system_maintenance WHERE id='global' AND mode<>'normal' AND expires_at>strftime('%Y-%m-%dT%H:%M:%fZ','now')) BEGIN SELECT RAISE(ABORT,'guard_maintenance'); END;
CREATE TRIGGER maintenance_distributor_contacts_delete BEFORE DELETE ON distributor_sales_contacts WHEN EXISTS(SELECT 1 FROM system_maintenance WHERE id='global' AND mode<>'normal' AND expires_at>strftime('%Y-%m-%dT%H:%M:%fZ','now')) BEGIN SELECT RAISE(ABORT,'guard_maintenance'); END;
