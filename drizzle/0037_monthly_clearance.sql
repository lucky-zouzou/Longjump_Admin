CREATE TABLE clearance_lines (
 id TEXT PRIMARY KEY, month TEXT NOT NULL, site TEXT NOT NULL, channel TEXT NOT NULL, sku TEXT NOT NULL REFERENCES sku_settings(sku),
 owner_id TEXT NOT NULL REFERENCES users(id), status TEXT NOT NULL DEFAULT 'draft' CHECK(status IN ('draft','finance_review','admin_review','approved','active','completed','cancelled')),
 version INTEGER NOT NULL DEFAULT 1, data_json TEXT NOT NULL, created_by TEXT NOT NULL REFERENCES users(id),
 finance_by TEXT REFERENCES users(id), approved_by TEXT REFERENCES users(id), started_on TEXT, ended_on TEXT,
 created_at TEXT NOT NULL, updated_at TEXT NOT NULL
);
CREATE UNIQUE INDEX clearance_month_sku ON clearance_lines(month,site,channel,sku) WHERE status<>'cancelled';
CREATE TABLE clearance_events (
 id TEXT PRIMARY KEY, line_id TEXT NOT NULL REFERENCES clearance_lines(id), action TEXT NOT NULL, business_date TEXT NOT NULL,
 actor_id TEXT NOT NULL REFERENCES users(id), detail_json TEXT NOT NULL, created_at TEXT NOT NULL
);
CREATE INDEX clearance_events_line ON clearance_events(line_id,business_date);
CREATE TABLE clearance_reviews (
 id TEXT PRIMARY KEY, line_id TEXT NOT NULL REFERENCES clearance_lines(id), period_end TEXT NOT NULL, revision INTEGER NOT NULL,
 evidence_hash TEXT NOT NULL, snapshot_json TEXT NOT NULL, outcome TEXT NOT NULL, note TEXT NOT NULL,
 actor_id TEXT NOT NULL REFERENCES users(id), created_at TEXT NOT NULL, UNIQUE(line_id,period_end,revision)
);
CREATE TABLE clearance_operations (
 id TEXT PRIMARY KEY, actor_id TEXT NOT NULL, request_hash TEXT NOT NULL, result_json TEXT NOT NULL, created_at TEXT NOT NULL
);
CREATE TRIGGER maintenance_clearance_lines_insert BEFORE INSERT ON clearance_lines WHEN EXISTS(SELECT 1 FROM system_maintenance WHERE id='global' AND mode<>'normal' AND expires_at>strftime('%Y-%m-%dT%H:%M:%fZ','now')) BEGIN SELECT RAISE(ABORT,'guard_maintenance'); END;
CREATE TRIGGER maintenance_clearance_lines_update BEFORE UPDATE ON clearance_lines WHEN EXISTS(SELECT 1 FROM system_maintenance WHERE id='global' AND mode<>'normal' AND expires_at>strftime('%Y-%m-%dT%H:%M:%fZ','now')) BEGIN SELECT RAISE(ABORT,'guard_maintenance'); END;
CREATE TRIGGER maintenance_clearance_lines_delete BEFORE DELETE ON clearance_lines WHEN EXISTS(SELECT 1 FROM system_maintenance WHERE id='global' AND mode<>'normal' AND expires_at>strftime('%Y-%m-%dT%H:%M:%fZ','now')) BEGIN SELECT RAISE(ABORT,'guard_maintenance'); END;
CREATE TRIGGER maintenance_clearance_events_insert BEFORE INSERT ON clearance_events WHEN EXISTS(SELECT 1 FROM system_maintenance WHERE id='global' AND mode<>'normal' AND expires_at>strftime('%Y-%m-%dT%H:%M:%fZ','now')) BEGIN SELECT RAISE(ABORT,'guard_maintenance'); END;
CREATE TRIGGER maintenance_clearance_events_update BEFORE UPDATE ON clearance_events WHEN EXISTS(SELECT 1 FROM system_maintenance WHERE id='global' AND mode<>'normal' AND expires_at>strftime('%Y-%m-%dT%H:%M:%fZ','now')) BEGIN SELECT RAISE(ABORT,'guard_maintenance'); END;
CREATE TRIGGER maintenance_clearance_events_delete BEFORE DELETE ON clearance_events WHEN EXISTS(SELECT 1 FROM system_maintenance WHERE id='global' AND mode<>'normal' AND expires_at>strftime('%Y-%m-%dT%H:%M:%fZ','now')) BEGIN SELECT RAISE(ABORT,'guard_maintenance'); END;
CREATE TRIGGER immutable_clearance_events_update BEFORE UPDATE ON clearance_events BEGIN SELECT RAISE(ABORT,'immutable history'); END;
CREATE TRIGGER immutable_clearance_events_delete BEFORE DELETE ON clearance_events BEGIN SELECT RAISE(ABORT,'immutable history'); END;
CREATE TRIGGER maintenance_clearance_reviews_insert BEFORE INSERT ON clearance_reviews WHEN EXISTS(SELECT 1 FROM system_maintenance WHERE id='global' AND mode<>'normal' AND expires_at>strftime('%Y-%m-%dT%H:%M:%fZ','now')) BEGIN SELECT RAISE(ABORT,'guard_maintenance'); END;
CREATE TRIGGER maintenance_clearance_reviews_update BEFORE UPDATE ON clearance_reviews WHEN EXISTS(SELECT 1 FROM system_maintenance WHERE id='global' AND mode<>'normal' AND expires_at>strftime('%Y-%m-%dT%H:%M:%fZ','now')) BEGIN SELECT RAISE(ABORT,'guard_maintenance'); END;
CREATE TRIGGER maintenance_clearance_reviews_delete BEFORE DELETE ON clearance_reviews WHEN EXISTS(SELECT 1 FROM system_maintenance WHERE id='global' AND mode<>'normal' AND expires_at>strftime('%Y-%m-%dT%H:%M:%fZ','now')) BEGIN SELECT RAISE(ABORT,'guard_maintenance'); END;
CREATE TRIGGER immutable_clearance_reviews_update BEFORE UPDATE ON clearance_reviews BEGIN SELECT RAISE(ABORT,'immutable history'); END;
CREATE TRIGGER immutable_clearance_reviews_delete BEFORE DELETE ON clearance_reviews BEGIN SELECT RAISE(ABORT,'immutable history'); END;
CREATE TRIGGER maintenance_clearance_operations_insert BEFORE INSERT ON clearance_operations WHEN EXISTS(SELECT 1 FROM system_maintenance WHERE id='global' AND mode<>'normal' AND expires_at>strftime('%Y-%m-%dT%H:%M:%fZ','now')) BEGIN SELECT RAISE(ABORT,'guard_maintenance'); END;
CREATE TRIGGER maintenance_clearance_operations_update BEFORE UPDATE ON clearance_operations WHEN EXISTS(SELECT 1 FROM system_maintenance WHERE id='global' AND mode<>'normal' AND expires_at>strftime('%Y-%m-%dT%H:%M:%fZ','now')) BEGIN SELECT RAISE(ABORT,'guard_maintenance'); END;
CREATE TRIGGER maintenance_clearance_operations_delete BEFORE DELETE ON clearance_operations WHEN EXISTS(SELECT 1 FROM system_maintenance WHERE id='global' AND mode<>'normal' AND expires_at>strftime('%Y-%m-%dT%H:%M:%fZ','now')) BEGIN SELECT RAISE(ABORT,'guard_maintenance'); END;
CREATE TRIGGER immutable_clearance_operations_update BEFORE UPDATE ON clearance_operations BEGIN SELECT RAISE(ABORT,'immutable history'); END;
CREATE TRIGGER immutable_clearance_operations_delete BEFORE DELETE ON clearance_operations BEGIN SELECT RAISE(ABORT,'immutable history'); END;
