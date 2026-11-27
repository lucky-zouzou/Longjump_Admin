-- A single-store pilot. Agents write evidence/tasks only, never operational orders.
CREATE TABLE agent_pilot_settings (
 id TEXT PRIMARY KEY CHECK(id='indonesia-tiktok'), scope_id TEXT REFERENCES creator_scopes(id),
 enabled INTEGER NOT NULL DEFAULT 0 CHECK(enabled IN (0,1)), config_json TEXT NOT NULL DEFAULT '{}',
 version INTEGER NOT NULL DEFAULT 1, updated_by TEXT REFERENCES users(id), updated_at TEXT NOT NULL
);
INSERT INTO agent_pilot_settings(id,updated_at) VALUES('indonesia-tiktok',strftime('%Y-%m-%dT%H:%M:%fZ','now'));
CREATE TABLE agent_pilot_tasks (
 id TEXT PRIMARY KEY, scope_id TEXT NOT NULL REFERENCES creator_scopes(id),
 agent TEXT NOT NULL CHECK(agent IN ('operating','creator')), finding_key TEXT NOT NULL,
 status TEXT NOT NULL CHECK(status IN ('open','acknowledged','resolved')),
 finding_json TEXT NOT NULL, owner_id TEXT, opened_at TEXT NOT NULL, updated_at TEXT NOT NULL,
 review_date TEXT NOT NULL, resolved_at TEXT, note TEXT NOT NULL DEFAULT '',
 draft_review_json TEXT, version INTEGER NOT NULL DEFAULT 1,
 UNIQUE(scope_id,agent,finding_key)
);
CREATE INDEX agent_pilot_task_owner ON agent_pilot_tasks(owner_id,status,scope_id);
CREATE TABLE agent_pilot_events (
 id TEXT PRIMARY KEY, scope_id TEXT NOT NULL, task_id TEXT REFERENCES agent_pilot_tasks(id),
 event TEXT NOT NULL, actor_id TEXT NOT NULL, detail_json TEXT NOT NULL, created_at TEXT NOT NULL
);
CREATE INDEX agent_pilot_event_time ON agent_pilot_events(scope_id,created_at);
CREATE TABLE agent_pilot_runs (
 id TEXT PRIMARY KEY, scope_id TEXT NOT NULL, agent TEXT NOT NULL,
 period_type TEXT NOT NULL CHECK(period_type IN ('daily','weekly')), period_key TEXT NOT NULL,
 result_json TEXT NOT NULL, generated_at TEXT NOT NULL, UNIQUE(scope_id,agent,period_type,period_key)
);
CREATE TABLE agent_pilot_lock (
 id TEXT PRIMARY KEY CHECK(id='global'), token TEXT NOT NULL, expires_at TEXT NOT NULL
);
CREATE TRIGGER maintenance_agent_pilot_settings_insert BEFORE INSERT ON agent_pilot_settings WHEN EXISTS(SELECT 1 FROM system_maintenance WHERE id='global' AND mode<>'normal' AND expires_at>strftime('%Y-%m-%dT%H:%M:%fZ','now')) BEGIN SELECT RAISE(ABORT,'guard_maintenance'); END;
CREATE TRIGGER maintenance_agent_pilot_settings_update BEFORE UPDATE ON agent_pilot_settings WHEN EXISTS(SELECT 1 FROM system_maintenance WHERE id='global' AND mode<>'normal' AND expires_at>strftime('%Y-%m-%dT%H:%M:%fZ','now')) BEGIN SELECT RAISE(ABORT,'guard_maintenance'); END;
CREATE TRIGGER maintenance_agent_pilot_settings_delete BEFORE DELETE ON agent_pilot_settings WHEN EXISTS(SELECT 1 FROM system_maintenance WHERE id='global' AND mode<>'normal' AND expires_at>strftime('%Y-%m-%dT%H:%M:%fZ','now')) BEGIN SELECT RAISE(ABORT,'guard_maintenance'); END;
CREATE TRIGGER maintenance_agent_pilot_tasks_insert BEFORE INSERT ON agent_pilot_tasks WHEN EXISTS(SELECT 1 FROM system_maintenance WHERE id='global' AND mode<>'normal' AND expires_at>strftime('%Y-%m-%dT%H:%M:%fZ','now')) BEGIN SELECT RAISE(ABORT,'guard_maintenance'); END;
CREATE TRIGGER maintenance_agent_pilot_tasks_update BEFORE UPDATE ON agent_pilot_tasks WHEN EXISTS(SELECT 1 FROM system_maintenance WHERE id='global' AND mode<>'normal' AND expires_at>strftime('%Y-%m-%dT%H:%M:%fZ','now')) BEGIN SELECT RAISE(ABORT,'guard_maintenance'); END;
CREATE TRIGGER maintenance_agent_pilot_tasks_delete BEFORE DELETE ON agent_pilot_tasks WHEN EXISTS(SELECT 1 FROM system_maintenance WHERE id='global' AND mode<>'normal' AND expires_at>strftime('%Y-%m-%dT%H:%M:%fZ','now')) BEGIN SELECT RAISE(ABORT,'guard_maintenance'); END;
CREATE TRIGGER maintenance_agent_pilot_events_insert BEFORE INSERT ON agent_pilot_events WHEN EXISTS(SELECT 1 FROM system_maintenance WHERE id='global' AND mode<>'normal' AND expires_at>strftime('%Y-%m-%dT%H:%M:%fZ','now')) BEGIN SELECT RAISE(ABORT,'guard_maintenance'); END;
CREATE TRIGGER maintenance_agent_pilot_events_update BEFORE UPDATE ON agent_pilot_events WHEN EXISTS(SELECT 1 FROM system_maintenance WHERE id='global' AND mode<>'normal' AND expires_at>strftime('%Y-%m-%dT%H:%M:%fZ','now')) BEGIN SELECT RAISE(ABORT,'guard_maintenance'); END;
CREATE TRIGGER maintenance_agent_pilot_events_delete BEFORE DELETE ON agent_pilot_events WHEN EXISTS(SELECT 1 FROM system_maintenance WHERE id='global' AND mode<>'normal' AND expires_at>strftime('%Y-%m-%dT%H:%M:%fZ','now')) BEGIN SELECT RAISE(ABORT,'guard_maintenance'); END;
CREATE TRIGGER maintenance_agent_pilot_runs_insert BEFORE INSERT ON agent_pilot_runs WHEN EXISTS(SELECT 1 FROM system_maintenance WHERE id='global' AND mode<>'normal' AND expires_at>strftime('%Y-%m-%dT%H:%M:%fZ','now')) BEGIN SELECT RAISE(ABORT,'guard_maintenance'); END;
CREATE TRIGGER maintenance_agent_pilot_runs_update BEFORE UPDATE ON agent_pilot_runs WHEN EXISTS(SELECT 1 FROM system_maintenance WHERE id='global' AND mode<>'normal' AND expires_at>strftime('%Y-%m-%dT%H:%M:%fZ','now')) BEGIN SELECT RAISE(ABORT,'guard_maintenance'); END;
CREATE TRIGGER maintenance_agent_pilot_runs_delete BEFORE DELETE ON agent_pilot_runs WHEN EXISTS(SELECT 1 FROM system_maintenance WHERE id='global' AND mode<>'normal' AND expires_at>strftime('%Y-%m-%dT%H:%M:%fZ','now')) BEGIN SELECT RAISE(ABORT,'guard_maintenance'); END;
CREATE TRIGGER maintenance_agent_pilot_lock_insert BEFORE INSERT ON agent_pilot_lock WHEN EXISTS(SELECT 1 FROM system_maintenance WHERE id='global' AND mode<>'normal' AND expires_at>strftime('%Y-%m-%dT%H:%M:%fZ','now')) BEGIN SELECT RAISE(ABORT,'guard_maintenance'); END;
CREATE TRIGGER maintenance_agent_pilot_lock_update BEFORE UPDATE ON agent_pilot_lock WHEN EXISTS(SELECT 1 FROM system_maintenance WHERE id='global' AND mode<>'normal' AND expires_at>strftime('%Y-%m-%dT%H:%M:%fZ','now')) BEGIN SELECT RAISE(ABORT,'guard_maintenance'); END;
CREATE TRIGGER maintenance_agent_pilot_lock_delete BEFORE DELETE ON agent_pilot_lock WHEN EXISTS(SELECT 1 FROM system_maintenance WHERE id='global' AND mode<>'normal' AND expires_at>strftime('%Y-%m-%dT%H:%M:%fZ','now')) BEGIN SELECT RAISE(ABORT,'guard_maintenance'); END;
