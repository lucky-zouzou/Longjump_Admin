-- Additive external facts; no personnel, schedules, credentials or approvals are invented.
CREATE TABLE feishu_settings (
 id TEXT PRIMARY KEY CHECK(id='global'), enabled INTEGER NOT NULL DEFAULT 0 CHECK(enabled IN(0,1)),
 version INTEGER NOT NULL DEFAULT 1, app_id TEXT NOT NULL DEFAULT '', id_type TEXT NOT NULL DEFAULT 'employee_id' CHECK(id_type IN('employee_id','employee_no')),
 connection_status TEXT NOT NULL DEFAULT 'untested' CHECK(connection_status IN('untested','passed','failed')),
 connection_version INTEGER, connection_app_id TEXT, config_source TEXT, connection_checked_at TEXT, connection_error TEXT NOT NULL DEFAULT '', enabled_at TEXT
);
INSERT INTO feishu_settings(id) VALUES('global');
CREATE TABLE feishu_user_links (
 id TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id), external_user_id TEXT NOT NULL, id_type TEXT NOT NULL,
 unit_id TEXT NOT NULL REFERENCES workplace_units(id), app_id TEXT NOT NULL, active INTEGER NOT NULL CHECK(active IN(0,1)),
 version INTEGER NOT NULL DEFAULT 1, activated_at TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
);
CREATE UNIQUE INDEX feishu_active_local_user ON feishu_user_links(user_id) WHERE active=1;
CREATE UNIQUE INDEX feishu_active_external_user ON feishu_user_links(app_id,id_type,external_user_id) WHERE active=1;
CREATE UNIQUE INDEX feishu_historical_scope ON feishu_user_links(app_id,id_type,external_user_id,user_id,unit_id);
CREATE INDEX feishu_link_identity ON feishu_user_links(app_id,id_type,external_user_id);
CREATE TRIGGER feishu_link_identity_immutable BEFORE UPDATE ON feishu_user_links WHEN OLD.user_id<>NEW.user_id OR OLD.external_user_id<>NEW.external_user_id OR OLD.id_type<>NEW.id_type OR OLD.unit_id<>NEW.unit_id OR OLD.app_id<>NEW.app_id BEGIN SELECT RAISE(ABORT,'immutable feishu identity'); END;
CREATE TRIGGER feishu_link_keep_history BEFORE DELETE ON feishu_user_links BEGIN SELECT RAISE(ABORT,'immutable feishu mapping history'); END;
CREATE TABLE feishu_sync_runs (
 id TEXT PRIMARY KEY, settings_version INTEGER NOT NULL, trigger TEXT NOT NULL CHECK(trigger IN('manual','scheduled')), actor_id TEXT REFERENCES users(id),
 status TEXT NOT NULL CHECK(status IN('running','succeeded','failed')), started_at TEXT NOT NULL, finished_at TEXT,
 scope_json TEXT NOT NULL, committed_windows INTEGER NOT NULL DEFAULT 0, error_code TEXT NOT NULL DEFAULT ''
);
CREATE TABLE feishu_sync_state (
 id TEXT PRIMARY KEY CHECK(id='global'), run_id TEXT REFERENCES feishu_sync_runs(id), lease_token_hash TEXT, lease_until TEXT,
 last_attempt_at TEXT, last_success_at TEXT, last_error TEXT NOT NULL DEFAULT ''
);
INSERT INTO feishu_sync_state(id) VALUES('global');
CREATE TABLE feishu_sync_windows (
 id TEXT PRIMARY KEY, run_id TEXT NOT NULL REFERENCES feishu_sync_runs(id), link_id TEXT NOT NULL REFERENCES feishu_user_links(id),
 link_version INTEGER NOT NULL, kind TEXT NOT NULL CHECK(kind IN('attendance','leave')), date_from TEXT NOT NULL, date_to TEXT NOT NULL,
 completed_at TEXT NOT NULL, counts_json TEXT NOT NULL, content_hash TEXT NOT NULL, UNIQUE(run_id,link_id,kind,date_from,date_to)
);
CREATE TABLE feishu_records (
 id TEXT PRIMARY KEY, link_id TEXT NOT NULL REFERENCES feishu_user_links(id), kind TEXT NOT NULL CHECK(kind IN('attendance','leave')),
 source_id TEXT NOT NULL, revision INTEGER NOT NULL, user_id TEXT NOT NULL REFERENCES users(id), unit_id TEXT NOT NULL REFERENCES workplace_units(id),
 user_name TEXT NOT NULL, unit_name TEXT NOT NULL, work_date TEXT NOT NULL, data_json TEXT NOT NULL, content_hash TEXT NOT NULL,
 source_missing INTEGER NOT NULL DEFAULT 0 CHECK(source_missing IN(0,1)), run_id TEXT NOT NULL REFERENCES feishu_sync_runs(id), imported_at TEXT NOT NULL,
 UNIQUE(link_id,kind,source_id,revision)
);
CREATE INDEX feishu_record_latest ON feishu_records(link_id,kind,source_id,revision DESC);
CREATE INDEX feishu_record_scope ON feishu_records(user_id,unit_id,work_date);
CREATE TRIGGER feishu_record_immutable_update BEFORE UPDATE ON feishu_records BEGIN SELECT RAISE(ABORT,'immutable feishu record revision'); END;
CREATE TRIGGER feishu_record_immutable_delete BEFORE DELETE ON feishu_records BEGIN SELECT RAISE(ABORT,'immutable feishu record revision'); END;
CREATE TRIGGER feishu_settings_clock_insert AFTER INSERT ON feishu_settings BEGIN UPDATE workplace_clock SET version=version+1 WHERE id='global'; END;
CREATE TRIGGER feishu_settings_maintenance_insert BEFORE INSERT ON feishu_settings WHEN EXISTS(SELECT 1 FROM system_maintenance WHERE id='global' AND mode<>'normal' AND expires_at>strftime('%Y-%m-%dT%H:%M:%fZ','now')) BEGIN SELECT RAISE(ABORT,'guard_maintenance'); END;
CREATE TRIGGER feishu_settings_clock_update AFTER UPDATE ON feishu_settings BEGIN UPDATE workplace_clock SET version=version+1 WHERE id='global'; END;
CREATE TRIGGER feishu_settings_maintenance_update BEFORE UPDATE ON feishu_settings WHEN EXISTS(SELECT 1 FROM system_maintenance WHERE id='global' AND mode<>'normal' AND expires_at>strftime('%Y-%m-%dT%H:%M:%fZ','now')) BEGIN SELECT RAISE(ABORT,'guard_maintenance'); END;
CREATE TRIGGER feishu_settings_clock_delete AFTER DELETE ON feishu_settings BEGIN UPDATE workplace_clock SET version=version+1 WHERE id='global'; END;
CREATE TRIGGER feishu_settings_maintenance_delete BEFORE DELETE ON feishu_settings WHEN EXISTS(SELECT 1 FROM system_maintenance WHERE id='global' AND mode<>'normal' AND expires_at>strftime('%Y-%m-%dT%H:%M:%fZ','now')) BEGIN SELECT RAISE(ABORT,'guard_maintenance'); END;
CREATE TRIGGER feishu_user_links_clock_insert AFTER INSERT ON feishu_user_links BEGIN UPDATE workplace_clock SET version=version+1 WHERE id='global'; END;
CREATE TRIGGER feishu_user_links_maintenance_insert BEFORE INSERT ON feishu_user_links WHEN EXISTS(SELECT 1 FROM system_maintenance WHERE id='global' AND mode<>'normal' AND expires_at>strftime('%Y-%m-%dT%H:%M:%fZ','now')) BEGIN SELECT RAISE(ABORT,'guard_maintenance'); END;
CREATE TRIGGER feishu_user_links_clock_update AFTER UPDATE ON feishu_user_links BEGIN UPDATE workplace_clock SET version=version+1 WHERE id='global'; END;
CREATE TRIGGER feishu_user_links_maintenance_update BEFORE UPDATE ON feishu_user_links WHEN EXISTS(SELECT 1 FROM system_maintenance WHERE id='global' AND mode<>'normal' AND expires_at>strftime('%Y-%m-%dT%H:%M:%fZ','now')) BEGIN SELECT RAISE(ABORT,'guard_maintenance'); END;
CREATE TRIGGER feishu_user_links_clock_delete AFTER DELETE ON feishu_user_links BEGIN UPDATE workplace_clock SET version=version+1 WHERE id='global'; END;
CREATE TRIGGER feishu_user_links_maintenance_delete BEFORE DELETE ON feishu_user_links WHEN EXISTS(SELECT 1 FROM system_maintenance WHERE id='global' AND mode<>'normal' AND expires_at>strftime('%Y-%m-%dT%H:%M:%fZ','now')) BEGIN SELECT RAISE(ABORT,'guard_maintenance'); END;
CREATE TRIGGER feishu_sync_runs_clock_insert AFTER INSERT ON feishu_sync_runs BEGIN UPDATE workplace_clock SET version=version+1 WHERE id='global'; END;
CREATE TRIGGER feishu_sync_runs_maintenance_insert BEFORE INSERT ON feishu_sync_runs WHEN EXISTS(SELECT 1 FROM system_maintenance WHERE id='global' AND mode<>'normal' AND expires_at>strftime('%Y-%m-%dT%H:%M:%fZ','now')) BEGIN SELECT RAISE(ABORT,'guard_maintenance'); END;
CREATE TRIGGER feishu_sync_runs_clock_update AFTER UPDATE ON feishu_sync_runs BEGIN UPDATE workplace_clock SET version=version+1 WHERE id='global'; END;
CREATE TRIGGER feishu_sync_runs_maintenance_update BEFORE UPDATE ON feishu_sync_runs WHEN EXISTS(SELECT 1 FROM system_maintenance WHERE id='global' AND mode<>'normal' AND expires_at>strftime('%Y-%m-%dT%H:%M:%fZ','now')) BEGIN SELECT RAISE(ABORT,'guard_maintenance'); END;
CREATE TRIGGER feishu_sync_runs_clock_delete AFTER DELETE ON feishu_sync_runs BEGIN UPDATE workplace_clock SET version=version+1 WHERE id='global'; END;
CREATE TRIGGER feishu_sync_runs_maintenance_delete BEFORE DELETE ON feishu_sync_runs WHEN EXISTS(SELECT 1 FROM system_maintenance WHERE id='global' AND mode<>'normal' AND expires_at>strftime('%Y-%m-%dT%H:%M:%fZ','now')) BEGIN SELECT RAISE(ABORT,'guard_maintenance'); END;
CREATE TRIGGER feishu_sync_state_clock_insert AFTER INSERT ON feishu_sync_state BEGIN UPDATE workplace_clock SET version=version+1 WHERE id='global'; END;
CREATE TRIGGER feishu_sync_state_maintenance_insert BEFORE INSERT ON feishu_sync_state WHEN EXISTS(SELECT 1 FROM system_maintenance WHERE id='global' AND mode<>'normal' AND expires_at>strftime('%Y-%m-%dT%H:%M:%fZ','now')) BEGIN SELECT RAISE(ABORT,'guard_maintenance'); END;
CREATE TRIGGER feishu_sync_state_clock_update AFTER UPDATE ON feishu_sync_state BEGIN UPDATE workplace_clock SET version=version+1 WHERE id='global'; END;
CREATE TRIGGER feishu_sync_state_maintenance_update BEFORE UPDATE ON feishu_sync_state WHEN EXISTS(SELECT 1 FROM system_maintenance WHERE id='global' AND mode<>'normal' AND expires_at>strftime('%Y-%m-%dT%H:%M:%fZ','now')) BEGIN SELECT RAISE(ABORT,'guard_maintenance'); END;
CREATE TRIGGER feishu_sync_state_clock_delete AFTER DELETE ON feishu_sync_state BEGIN UPDATE workplace_clock SET version=version+1 WHERE id='global'; END;
CREATE TRIGGER feishu_sync_state_maintenance_delete BEFORE DELETE ON feishu_sync_state WHEN EXISTS(SELECT 1 FROM system_maintenance WHERE id='global' AND mode<>'normal' AND expires_at>strftime('%Y-%m-%dT%H:%M:%fZ','now')) BEGIN SELECT RAISE(ABORT,'guard_maintenance'); END;
CREATE TRIGGER feishu_sync_windows_clock_insert AFTER INSERT ON feishu_sync_windows BEGIN UPDATE workplace_clock SET version=version+1 WHERE id='global'; END;
CREATE TRIGGER feishu_sync_windows_maintenance_insert BEFORE INSERT ON feishu_sync_windows WHEN EXISTS(SELECT 1 FROM system_maintenance WHERE id='global' AND mode<>'normal' AND expires_at>strftime('%Y-%m-%dT%H:%M:%fZ','now')) BEGIN SELECT RAISE(ABORT,'guard_maintenance'); END;
CREATE TRIGGER feishu_sync_windows_clock_update AFTER UPDATE ON feishu_sync_windows BEGIN UPDATE workplace_clock SET version=version+1 WHERE id='global'; END;
CREATE TRIGGER feishu_sync_windows_maintenance_update BEFORE UPDATE ON feishu_sync_windows WHEN EXISTS(SELECT 1 FROM system_maintenance WHERE id='global' AND mode<>'normal' AND expires_at>strftime('%Y-%m-%dT%H:%M:%fZ','now')) BEGIN SELECT RAISE(ABORT,'guard_maintenance'); END;
CREATE TRIGGER feishu_sync_windows_clock_delete AFTER DELETE ON feishu_sync_windows BEGIN UPDATE workplace_clock SET version=version+1 WHERE id='global'; END;
CREATE TRIGGER feishu_sync_windows_maintenance_delete BEFORE DELETE ON feishu_sync_windows WHEN EXISTS(SELECT 1 FROM system_maintenance WHERE id='global' AND mode<>'normal' AND expires_at>strftime('%Y-%m-%dT%H:%M:%fZ','now')) BEGIN SELECT RAISE(ABORT,'guard_maintenance'); END;
CREATE TRIGGER feishu_records_clock_insert AFTER INSERT ON feishu_records BEGIN UPDATE workplace_clock SET version=version+1 WHERE id='global'; END;
CREATE TRIGGER feishu_records_maintenance_insert BEFORE INSERT ON feishu_records WHEN EXISTS(SELECT 1 FROM system_maintenance WHERE id='global' AND mode<>'normal' AND expires_at>strftime('%Y-%m-%dT%H:%M:%fZ','now')) BEGIN SELECT RAISE(ABORT,'guard_maintenance'); END;
CREATE TRIGGER feishu_records_clock_update AFTER UPDATE ON feishu_records BEGIN UPDATE workplace_clock SET version=version+1 WHERE id='global'; END;
CREATE TRIGGER feishu_records_maintenance_update BEFORE UPDATE ON feishu_records WHEN EXISTS(SELECT 1 FROM system_maintenance WHERE id='global' AND mode<>'normal' AND expires_at>strftime('%Y-%m-%dT%H:%M:%fZ','now')) BEGIN SELECT RAISE(ABORT,'guard_maintenance'); END;
CREATE TRIGGER feishu_records_clock_delete AFTER DELETE ON feishu_records BEGIN UPDATE workplace_clock SET version=version+1 WHERE id='global'; END;
CREATE TRIGGER feishu_records_maintenance_delete BEFORE DELETE ON feishu_records WHEN EXISTS(SELECT 1 FROM system_maintenance WHERE id='global' AND mode<>'normal' AND expires_at>strftime('%Y-%m-%dT%H:%M:%fZ','now')) BEGIN SELECT RAISE(ABORT,'guard_maintenance'); END;
