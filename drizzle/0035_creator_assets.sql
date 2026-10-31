-- A company-owned market/account identity, independent of store assignments.
CREATE TABLE creator_assets (
 id TEXT PRIMARY KEY, site TEXT NOT NULL, platform TEXT NOT NULL, platform_id TEXT NOT NULL,
 data_json TEXT NOT NULL DEFAULT '{}', version INTEGER NOT NULL DEFAULT 1,
 created_at TEXT NOT NULL, updated_at TEXT NOT NULL, UNIQUE(site,platform,platform_id)
);
INSERT INTO creator_assets(id,site,platform,platform_id,created_at,updated_at)
 SELECT lower(hex(randomblob(16))),s.site,s.platform,p.platform_id,MIN(p.created_at),MAX(p.updated_at)
 FROM creator_profiles p JOIN creator_scopes s ON s.id=p.scope_id GROUP BY s.site,s.platform,p.platform_id;

CREATE TABLE creator_asset_history (
 id TEXT PRIMARY KEY, asset_id TEXT NOT NULL REFERENCES creator_assets(id), revision INTEGER NOT NULL,
 data_json TEXT NOT NULL, actor_id TEXT NOT NULL REFERENCES users(id), actor_name TEXT NOT NULL, created_at TEXT NOT NULL,
 UNIQUE(asset_id,revision)
);
CREATE TABLE creator_playbooks (
 id TEXT PRIMARY KEY, asset_id TEXT NOT NULL REFERENCES creator_assets(id), round_id TEXT NOT NULL REFERENCES creator_rounds(id),
 content_id TEXT NOT NULL REFERENCES creator_contents(id), title TEXT NOT NULL,
 status TEXT NOT NULL DEFAULT 'pending', data_json TEXT NOT NULL,
 author_id TEXT NOT NULL REFERENCES users(id), reviewer_id TEXT REFERENCES users(id),
 source_version INTEGER NOT NULL, finance_id TEXT, version INTEGER NOT NULL DEFAULT 1,
 created_at TEXT NOT NULL, updated_at TEXT NOT NULL
);
CREATE TABLE creator_playbook_history (
 id TEXT PRIMARY KEY, playbook_id TEXT NOT NULL REFERENCES creator_playbooks(id), revision INTEGER NOT NULL,
 action TEXT NOT NULL, snapshot_json TEXT NOT NULL, actor_id TEXT NOT NULL REFERENCES users(id), actor_name TEXT NOT NULL, created_at TEXT NOT NULL,
 UNIQUE(playbook_id,revision)
);
CREATE INDEX creator_playbook_source ON creator_playbooks(round_id,status);
CREATE INDEX creator_asset_history_lookup ON creator_asset_history(asset_id,revision);
CREATE TRIGGER immutable_creator_asset_history_update BEFORE UPDATE ON creator_asset_history BEGIN SELECT RAISE(ABORT,'immutable history'); END;
CREATE TRIGGER immutable_creator_asset_history_delete BEFORE DELETE ON creator_asset_history BEGIN SELECT RAISE(ABORT,'immutable history'); END;
CREATE TRIGGER immutable_creator_playbook_history_update BEFORE UPDATE ON creator_playbook_history BEGIN SELECT RAISE(ABORT,'immutable history'); END;
CREATE TRIGGER immutable_creator_playbook_history_delete BEFORE DELETE ON creator_playbook_history BEGIN SELECT RAISE(ABORT,'immutable history'); END;

CREATE TRIGGER maintenance_creator_assets_insert BEFORE INSERT ON creator_assets WHEN EXISTS(SELECT 1 FROM system_maintenance WHERE id='global' AND mode<>'normal' AND expires_at>strftime('%Y-%m-%dT%H:%M:%fZ','now')) BEGIN SELECT RAISE(ABORT,'guard_maintenance'); END;
CREATE TRIGGER clock_creator_assets_insert AFTER INSERT ON creator_assets BEGIN INSERT INTO creator_clock VALUES('global',1) ON CONFLICT(id) DO UPDATE SET version=version+1; END;

CREATE TRIGGER maintenance_creator_assets_update BEFORE UPDATE ON creator_assets WHEN EXISTS(SELECT 1 FROM system_maintenance WHERE id='global' AND mode<>'normal' AND expires_at>strftime('%Y-%m-%dT%H:%M:%fZ','now')) BEGIN SELECT RAISE(ABORT,'guard_maintenance'); END;
CREATE TRIGGER clock_creator_assets_update AFTER UPDATE ON creator_assets BEGIN INSERT INTO creator_clock VALUES('global',1) ON CONFLICT(id) DO UPDATE SET version=version+1; END;

CREATE TRIGGER maintenance_creator_assets_delete BEFORE DELETE ON creator_assets WHEN EXISTS(SELECT 1 FROM system_maintenance WHERE id='global' AND mode<>'normal' AND expires_at>strftime('%Y-%m-%dT%H:%M:%fZ','now')) BEGIN SELECT RAISE(ABORT,'guard_maintenance'); END;
CREATE TRIGGER clock_creator_assets_delete AFTER DELETE ON creator_assets BEGIN INSERT INTO creator_clock VALUES('global',1) ON CONFLICT(id) DO UPDATE SET version=version+1; END;

CREATE TRIGGER maintenance_creator_asset_history_insert BEFORE INSERT ON creator_asset_history WHEN EXISTS(SELECT 1 FROM system_maintenance WHERE id='global' AND mode<>'normal' AND expires_at>strftime('%Y-%m-%dT%H:%M:%fZ','now')) BEGIN SELECT RAISE(ABORT,'guard_maintenance'); END;
CREATE TRIGGER clock_creator_asset_history_insert AFTER INSERT ON creator_asset_history BEGIN INSERT INTO creator_clock VALUES('global',1) ON CONFLICT(id) DO UPDATE SET version=version+1; END;

CREATE TRIGGER maintenance_creator_asset_history_update BEFORE UPDATE ON creator_asset_history WHEN EXISTS(SELECT 1 FROM system_maintenance WHERE id='global' AND mode<>'normal' AND expires_at>strftime('%Y-%m-%dT%H:%M:%fZ','now')) BEGIN SELECT RAISE(ABORT,'guard_maintenance'); END;
CREATE TRIGGER clock_creator_asset_history_update AFTER UPDATE ON creator_asset_history BEGIN INSERT INTO creator_clock VALUES('global',1) ON CONFLICT(id) DO UPDATE SET version=version+1; END;

CREATE TRIGGER maintenance_creator_asset_history_delete BEFORE DELETE ON creator_asset_history WHEN EXISTS(SELECT 1 FROM system_maintenance WHERE id='global' AND mode<>'normal' AND expires_at>strftime('%Y-%m-%dT%H:%M:%fZ','now')) BEGIN SELECT RAISE(ABORT,'guard_maintenance'); END;
CREATE TRIGGER clock_creator_asset_history_delete AFTER DELETE ON creator_asset_history BEGIN INSERT INTO creator_clock VALUES('global',1) ON CONFLICT(id) DO UPDATE SET version=version+1; END;

CREATE TRIGGER maintenance_creator_playbooks_insert BEFORE INSERT ON creator_playbooks WHEN EXISTS(SELECT 1 FROM system_maintenance WHERE id='global' AND mode<>'normal' AND expires_at>strftime('%Y-%m-%dT%H:%M:%fZ','now')) BEGIN SELECT RAISE(ABORT,'guard_maintenance'); END;
CREATE TRIGGER clock_creator_playbooks_insert AFTER INSERT ON creator_playbooks BEGIN INSERT INTO creator_clock VALUES('global',1) ON CONFLICT(id) DO UPDATE SET version=version+1; END;

CREATE TRIGGER maintenance_creator_playbooks_update BEFORE UPDATE ON creator_playbooks WHEN EXISTS(SELECT 1 FROM system_maintenance WHERE id='global' AND mode<>'normal' AND expires_at>strftime('%Y-%m-%dT%H:%M:%fZ','now')) BEGIN SELECT RAISE(ABORT,'guard_maintenance'); END;
CREATE TRIGGER clock_creator_playbooks_update AFTER UPDATE ON creator_playbooks BEGIN INSERT INTO creator_clock VALUES('global',1) ON CONFLICT(id) DO UPDATE SET version=version+1; END;

CREATE TRIGGER maintenance_creator_playbooks_delete BEFORE DELETE ON creator_playbooks WHEN EXISTS(SELECT 1 FROM system_maintenance WHERE id='global' AND mode<>'normal' AND expires_at>strftime('%Y-%m-%dT%H:%M:%fZ','now')) BEGIN SELECT RAISE(ABORT,'guard_maintenance'); END;
CREATE TRIGGER clock_creator_playbooks_delete AFTER DELETE ON creator_playbooks BEGIN INSERT INTO creator_clock VALUES('global',1) ON CONFLICT(id) DO UPDATE SET version=version+1; END;

CREATE TRIGGER maintenance_creator_playbook_history_insert BEFORE INSERT ON creator_playbook_history WHEN EXISTS(SELECT 1 FROM system_maintenance WHERE id='global' AND mode<>'normal' AND expires_at>strftime('%Y-%m-%dT%H:%M:%fZ','now')) BEGIN SELECT RAISE(ABORT,'guard_maintenance'); END;
CREATE TRIGGER clock_creator_playbook_history_insert AFTER INSERT ON creator_playbook_history BEGIN INSERT INTO creator_clock VALUES('global',1) ON CONFLICT(id) DO UPDATE SET version=version+1; END;

CREATE TRIGGER maintenance_creator_playbook_history_update BEFORE UPDATE ON creator_playbook_history WHEN EXISTS(SELECT 1 FROM system_maintenance WHERE id='global' AND mode<>'normal' AND expires_at>strftime('%Y-%m-%dT%H:%M:%fZ','now')) BEGIN SELECT RAISE(ABORT,'guard_maintenance'); END;
CREATE TRIGGER clock_creator_playbook_history_update AFTER UPDATE ON creator_playbook_history BEGIN INSERT INTO creator_clock VALUES('global',1) ON CONFLICT(id) DO UPDATE SET version=version+1; END;

CREATE TRIGGER maintenance_creator_playbook_history_delete BEFORE DELETE ON creator_playbook_history WHEN EXISTS(SELECT 1 FROM system_maintenance WHERE id='global' AND mode<>'normal' AND expires_at>strftime('%Y-%m-%dT%H:%M:%fZ','now')) BEGIN SELECT RAISE(ABORT,'guard_maintenance'); END;
CREATE TRIGGER clock_creator_playbook_history_delete AFTER DELETE ON creator_playbook_history BEGIN INSERT INTO creator_clock VALUES('global',1) ON CONFLICT(id) DO UPDATE SET version=version+1; END;
