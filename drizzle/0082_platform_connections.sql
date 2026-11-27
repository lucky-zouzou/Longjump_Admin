-- External accounts are isolated staging sources, not the financial or inventory ledger.
CREATE TABLE platform_grants (
 id TEXT PRIMARY KEY, provider TEXT NOT NULL CHECK(provider IN ('shop','ads')),
 config_hash TEXT NOT NULL, token_encrypted TEXT NOT NULL, expires_at INTEGER,
 created_by TEXT NOT NULL REFERENCES users(id), created_at TEXT NOT NULL
);
CREATE TABLE platform_oauth_states (
 state_hash TEXT PRIMARY KEY, provider TEXT NOT NULL, binding_hash TEXT NOT NULL,
 session_hash TEXT NOT NULL, actor_id TEXT NOT NULL REFERENCES users(id),
 config_hash TEXT NOT NULL, expires_at INTEGER NOT NULL
);
CREATE TABLE platform_accounts (
 id TEXT PRIMARY KEY, provider TEXT NOT NULL CHECK(provider IN ('shop','ads')),
 external_id TEXT NOT NULL, name TEXT NOT NULL, region TEXT NOT NULL DEFAULT '',
 currency TEXT NOT NULL DEFAULT '', timezone TEXT NOT NULL DEFAULT '',
 cipher TEXT NOT NULL DEFAULT '', grant_id TEXT REFERENCES platform_grants(id),
 status TEXT NOT NULL DEFAULT 'connected', version INTEGER NOT NULL DEFAULT 1,
 last_sync_at TEXT, last_error TEXT NOT NULL DEFAULT '', lease_until INTEGER NOT NULL DEFAULT 0,
 UNIQUE(provider,external_id)
);
CREATE TABLE platform_snapshots (
 account_id TEXT PRIMARY KEY REFERENCES platform_accounts(id), start_at TEXT NOT NULL,
 end_at TEXT NOT NULL, summary_json TEXT NOT NULL, records_json TEXT NOT NULL,
 fetched_at TEXT NOT NULL
);
CREATE TABLE platform_connection_events (
 id TEXT PRIMARY KEY, actor_id TEXT NOT NULL, provider TEXT NOT NULL,
 account_id TEXT, event TEXT NOT NULL, created_at TEXT NOT NULL
);
CREATE TRIGGER maintenance_platform_grants_insert BEFORE INSERT ON platform_grants WHEN EXISTS(SELECT 1 FROM system_maintenance WHERE id='global' AND mode<>'normal' AND expires_at>strftime('%Y-%m-%dT%H:%M:%fZ','now')) BEGIN SELECT RAISE(ABORT,'guard_maintenance'); END;
CREATE TRIGGER maintenance_platform_grants_update BEFORE UPDATE ON platform_grants WHEN EXISTS(SELECT 1 FROM system_maintenance WHERE id='global' AND mode<>'normal' AND expires_at>strftime('%Y-%m-%dT%H:%M:%fZ','now')) BEGIN SELECT RAISE(ABORT,'guard_maintenance'); END;
CREATE TRIGGER maintenance_platform_grants_delete BEFORE DELETE ON platform_grants WHEN EXISTS(SELECT 1 FROM system_maintenance WHERE id='global' AND mode<>'normal' AND expires_at>strftime('%Y-%m-%dT%H:%M:%fZ','now')) BEGIN SELECT RAISE(ABORT,'guard_maintenance'); END;
CREATE TRIGGER maintenance_platform_oauth_states_insert BEFORE INSERT ON platform_oauth_states WHEN EXISTS(SELECT 1 FROM system_maintenance WHERE id='global' AND mode<>'normal' AND expires_at>strftime('%Y-%m-%dT%H:%M:%fZ','now')) BEGIN SELECT RAISE(ABORT,'guard_maintenance'); END;
CREATE TRIGGER maintenance_platform_oauth_states_update BEFORE UPDATE ON platform_oauth_states WHEN EXISTS(SELECT 1 FROM system_maintenance WHERE id='global' AND mode<>'normal' AND expires_at>strftime('%Y-%m-%dT%H:%M:%fZ','now')) BEGIN SELECT RAISE(ABORT,'guard_maintenance'); END;
CREATE TRIGGER maintenance_platform_oauth_states_delete BEFORE DELETE ON platform_oauth_states WHEN EXISTS(SELECT 1 FROM system_maintenance WHERE id='global' AND mode<>'normal' AND expires_at>strftime('%Y-%m-%dT%H:%M:%fZ','now')) BEGIN SELECT RAISE(ABORT,'guard_maintenance'); END;
CREATE TRIGGER maintenance_platform_accounts_insert BEFORE INSERT ON platform_accounts WHEN EXISTS(SELECT 1 FROM system_maintenance WHERE id='global' AND mode<>'normal' AND expires_at>strftime('%Y-%m-%dT%H:%M:%fZ','now')) BEGIN SELECT RAISE(ABORT,'guard_maintenance'); END;
CREATE TRIGGER maintenance_platform_accounts_update BEFORE UPDATE ON platform_accounts WHEN EXISTS(SELECT 1 FROM system_maintenance WHERE id='global' AND mode<>'normal' AND expires_at>strftime('%Y-%m-%dT%H:%M:%fZ','now')) BEGIN SELECT RAISE(ABORT,'guard_maintenance'); END;
CREATE TRIGGER maintenance_platform_accounts_delete BEFORE DELETE ON platform_accounts WHEN EXISTS(SELECT 1 FROM system_maintenance WHERE id='global' AND mode<>'normal' AND expires_at>strftime('%Y-%m-%dT%H:%M:%fZ','now')) BEGIN SELECT RAISE(ABORT,'guard_maintenance'); END;
CREATE TRIGGER maintenance_platform_snapshots_insert BEFORE INSERT ON platform_snapshots WHEN EXISTS(SELECT 1 FROM system_maintenance WHERE id='global' AND mode<>'normal' AND expires_at>strftime('%Y-%m-%dT%H:%M:%fZ','now')) BEGIN SELECT RAISE(ABORT,'guard_maintenance'); END;
CREATE TRIGGER maintenance_platform_snapshots_update BEFORE UPDATE ON platform_snapshots WHEN EXISTS(SELECT 1 FROM system_maintenance WHERE id='global' AND mode<>'normal' AND expires_at>strftime('%Y-%m-%dT%H:%M:%fZ','now')) BEGIN SELECT RAISE(ABORT,'guard_maintenance'); END;
CREATE TRIGGER maintenance_platform_snapshots_delete BEFORE DELETE ON platform_snapshots WHEN EXISTS(SELECT 1 FROM system_maintenance WHERE id='global' AND mode<>'normal' AND expires_at>strftime('%Y-%m-%dT%H:%M:%fZ','now')) BEGIN SELECT RAISE(ABORT,'guard_maintenance'); END;
CREATE TRIGGER maintenance_platform_connection_events_insert BEFORE INSERT ON platform_connection_events WHEN EXISTS(SELECT 1 FROM system_maintenance WHERE id='global' AND mode<>'normal' AND expires_at>strftime('%Y-%m-%dT%H:%M:%fZ','now')) BEGIN SELECT RAISE(ABORT,'guard_maintenance'); END;
CREATE TRIGGER maintenance_platform_connection_events_update BEFORE UPDATE ON platform_connection_events WHEN EXISTS(SELECT 1 FROM system_maintenance WHERE id='global' AND mode<>'normal' AND expires_at>strftime('%Y-%m-%dT%H:%M:%fZ','now')) BEGIN SELECT RAISE(ABORT,'guard_maintenance'); END;
CREATE TRIGGER maintenance_platform_connection_events_delete BEFORE DELETE ON platform_connection_events WHEN EXISTS(SELECT 1 FROM system_maintenance WHERE id='global' AND mode<>'normal' AND expires_at>strftime('%Y-%m-%dT%H:%M:%fZ','now')) BEGIN SELECT RAISE(ABORT,'guard_maintenance'); END;
