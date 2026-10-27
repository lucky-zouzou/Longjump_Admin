-- Opt-in access: migration does not expand any existing employee permissions.
CREATE TABLE cost_access (
 user_id TEXT PRIMARY KEY NOT NULL REFERENCES users(id),
 can_read INTEGER NOT NULL DEFAULT 0 CHECK(can_read IN (0,1)),
 can_write INTEGER NOT NULL DEFAULT 0 CHECK(can_write IN (0,1)),
 can_review INTEGER NOT NULL DEFAULT 0 CHECK(can_review IN (0,1))
);
CREATE TABLE cost_clock (id TEXT PRIMARY KEY NOT NULL,version INTEGER NOT NULL);
CREATE TABLE cost_records (
 id TEXT PRIMARY KEY NOT NULL, kind TEXT NOT NULL CHECK(kind IN ('ticket','order','market','simulation','advertising')),
 business_key TEXT NOT NULL, site TEXT NOT NULL, channel TEXT NOT NULL,
 revision INTEGER NOT NULL CHECK(revision>0), business_date TEXT NOT NULL,
 data_json TEXT NOT NULL, reason TEXT NOT NULL, actor_id TEXT NOT NULL REFERENCES users(id), created_at TEXT NOT NULL,
 UNIQUE(kind,business_key,revision)
);
CREATE INDEX idx_cost_scope ON cost_records(site,channel,kind,business_date);
CREATE TABLE cost_reviews (
 record_id TEXT PRIMARY KEY NOT NULL REFERENCES cost_records(id),
 tax_treatment TEXT NOT NULL CHECK(tax_treatment IN ('inventory','period','recoverable','not_applicable')),
 note TEXT NOT NULL, actor_id TEXT NOT NULL REFERENCES users(id), created_at TEXT NOT NULL
);
CREATE TABLE cost_imports (
 fingerprint TEXT PRIMARY KEY NOT NULL, file_name TEXT NOT NULL, record_ids_json TEXT NOT NULL,
 actor_id TEXT NOT NULL REFERENCES users(id), created_at TEXT NOT NULL
);

CREATE TRIGGER immutable_cost_records_update BEFORE UPDATE ON cost_records
BEGIN SELECT RAISE(ABORT,'immutable cost record'); END;

CREATE TRIGGER immutable_cost_records_delete BEFORE DELETE ON cost_records
BEGIN SELECT RAISE(ABORT,'immutable cost record'); END;

CREATE TRIGGER immutable_cost_reviews_update BEFORE UPDATE ON cost_reviews
BEGIN SELECT RAISE(ABORT,'immutable cost record'); END;

CREATE TRIGGER immutable_cost_reviews_delete BEFORE DELETE ON cost_reviews
BEGIN SELECT RAISE(ABORT,'immutable cost record'); END;

CREATE TRIGGER immutable_cost_imports_update BEFORE UPDATE ON cost_imports
BEGIN SELECT RAISE(ABORT,'immutable cost record'); END;

CREATE TRIGGER immutable_cost_imports_delete BEFORE DELETE ON cost_imports
BEGIN SELECT RAISE(ABORT,'immutable cost record'); END;

CREATE TRIGGER maintenance_cost_records_insert BEFORE INSERT ON cost_records
WHEN EXISTS(SELECT 1 FROM system_maintenance WHERE id='global' AND mode<>'normal' AND expires_at>strftime('%Y-%m-%dT%H:%M:%fZ','now'))
BEGIN SELECT RAISE(ABORT,'guard_maintenance'); END;
CREATE TRIGGER clock_cost_records_insert AFTER INSERT ON cost_records
BEGIN INSERT INTO cost_clock VALUES('global',1) ON CONFLICT(id) DO UPDATE SET version=version+1; END;

CREATE TRIGGER maintenance_cost_reviews_insert BEFORE INSERT ON cost_reviews
WHEN EXISTS(SELECT 1 FROM system_maintenance WHERE id='global' AND mode<>'normal' AND expires_at>strftime('%Y-%m-%dT%H:%M:%fZ','now'))
BEGIN SELECT RAISE(ABORT,'guard_maintenance'); END;
CREATE TRIGGER clock_cost_reviews_insert AFTER INSERT ON cost_reviews
BEGIN INSERT INTO cost_clock VALUES('global',1) ON CONFLICT(id) DO UPDATE SET version=version+1; END;

CREATE TRIGGER maintenance_cost_imports_insert BEFORE INSERT ON cost_imports
WHEN EXISTS(SELECT 1 FROM system_maintenance WHERE id='global' AND mode<>'normal' AND expires_at>strftime('%Y-%m-%dT%H:%M:%fZ','now'))
BEGIN SELECT RAISE(ABORT,'guard_maintenance'); END;
CREATE TRIGGER clock_cost_imports_insert AFTER INSERT ON cost_imports
BEGIN INSERT INTO cost_clock VALUES('global',1) ON CONFLICT(id) DO UPDATE SET version=version+1; END;

CREATE TRIGGER maintenance_cost_access_insert BEFORE INSERT ON cost_access
WHEN EXISTS(SELECT 1 FROM system_maintenance WHERE id='global' AND mode<>'normal' AND expires_at>strftime('%Y-%m-%dT%H:%M:%fZ','now'))
BEGIN SELECT RAISE(ABORT,'guard_maintenance'); END;
CREATE TRIGGER clock_cost_access_insert AFTER INSERT ON cost_access
BEGIN INSERT INTO cost_clock VALUES('global',1) ON CONFLICT(id) DO UPDATE SET version=version+1; END;

CREATE TRIGGER maintenance_cost_access_update BEFORE UPDATE ON cost_access
WHEN EXISTS(SELECT 1 FROM system_maintenance WHERE id='global' AND mode<>'normal' AND expires_at>strftime('%Y-%m-%dT%H:%M:%fZ','now'))
BEGIN SELECT RAISE(ABORT,'guard_maintenance'); END;
CREATE TRIGGER clock_cost_access_update AFTER UPDATE ON cost_access
BEGIN INSERT INTO cost_clock VALUES('global',1) ON CONFLICT(id) DO UPDATE SET version=version+1; END;

CREATE TRIGGER maintenance_cost_access_delete BEFORE DELETE ON cost_access
WHEN EXISTS(SELECT 1 FROM system_maintenance WHERE id='global' AND mode<>'normal' AND expires_at>strftime('%Y-%m-%dT%H:%M:%fZ','now'))
BEGIN SELECT RAISE(ABORT,'guard_maintenance'); END;
CREATE TRIGGER clock_cost_access_delete AFTER DELETE ON cost_access
BEGIN INSERT INTO cost_clock VALUES('global',1) ON CONFLICT(id) DO UPDATE SET version=version+1; END;
