-- A single platform account dossier, with existing shop records retained as business relationships.
CREATE TABLE creator_dossiers (
 id TEXT PRIMARY KEY, platform TEXT NOT NULL, platform_id TEXT NOT NULL,
 created_at TEXT NOT NULL, UNIQUE(platform,platform_id)
);
CREATE TABLE creator_dossier_links (
 profile_id TEXT PRIMARY KEY REFERENCES creator_profiles(id), dossier_id TEXT NOT NULL REFERENCES creator_dossiers(id)
);
INSERT INTO creator_dossiers SELECT s.platform||':'||p.platform_id,s.platform,p.platform_id,MIN(p.created_at)
 FROM creator_profiles p JOIN creator_scopes s ON s.id=p.scope_id GROUP BY s.platform,p.platform_id;
INSERT INTO creator_dossier_links SELECT p.id,s.platform||':'||p.platform_id FROM creator_profiles p JOIN creator_scopes s ON s.id=p.scope_id;
CREATE TRIGGER creator_dossier_on_profile AFTER INSERT ON creator_profiles BEGIN
 INSERT OR IGNORE INTO creator_dossiers SELECT platform||':'||NEW.platform_id,platform,NEW.platform_id,NEW.created_at FROM creator_scopes WHERE id=NEW.scope_id;
 INSERT INTO creator_dossier_links SELECT NEW.id,platform||':'||NEW.platform_id FROM creator_scopes WHERE id=NEW.scope_id;
END;
ALTER TABLE creator_profiles ADD COLUMN bd_grade TEXT NOT NULL DEFAULT '' CHECK(bd_grade IN ('','S','A','B','C'));
ALTER TABLE creator_profiles ADD COLUMN bd_stage TEXT NOT NULL DEFAULT '';
ALTER TABLE creator_profiles ADD COLUMN owner_bd_id TEXT REFERENCES users(id);
ALTER TABLE creator_profiles ADD COLUMN last_follow_at TEXT;
CREATE TABLE creator_leads (user_id TEXT PRIMARY KEY REFERENCES users(id), active INTEGER NOT NULL CHECK(active IN (0,1)), updated_at TEXT NOT NULL);
CREATE TABLE creator_round_results (
 id TEXT PRIMARY KEY, round_id TEXT NOT NULL REFERENCES creator_rounds(id), revision INTEGER NOT NULL,
 data_json TEXT NOT NULL, actor_id TEXT NOT NULL REFERENCES users(id), actor_name TEXT NOT NULL, created_at TEXT NOT NULL,
 UNIQUE(round_id,revision)
);
CREATE TABLE creator_practices (
 id TEXT PRIMARY KEY, scope_id TEXT NOT NULL REFERENCES creator_scopes(id), title TEXT NOT NULL,
 category TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'pending', data_json TEXT NOT NULL,
 author_id TEXT NOT NULL REFERENCES users(id), reviewer_id TEXT REFERENCES users(id),
 version INTEGER NOT NULL DEFAULT 1, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
);
CREATE TABLE creator_practice_history (
 id TEXT PRIMARY KEY, practice_id TEXT NOT NULL REFERENCES creator_practices(id), revision INTEGER NOT NULL,
 action TEXT NOT NULL, actor_id TEXT NOT NULL REFERENCES users(id), actor_name TEXT NOT NULL,
 snapshot_json TEXT NOT NULL, created_at TEXT NOT NULL, UNIQUE(practice_id,revision)
);
CREATE TRIGGER maintenance_creator_dossiers_insert BEFORE INSERT ON creator_dossiers WHEN EXISTS(SELECT 1 FROM system_maintenance WHERE id='global' AND mode<>'normal' AND expires_at>strftime('%Y-%m-%dT%H:%M:%fZ','now')) BEGIN SELECT RAISE(ABORT,'guard_maintenance'); END;
CREATE TRIGGER clock_creator_dossiers_insert AFTER INSERT ON creator_dossiers BEGIN INSERT INTO creator_clock VALUES('global',1) ON CONFLICT(id) DO UPDATE SET version=version+1; END;
CREATE TRIGGER maintenance_creator_dossiers_update BEFORE UPDATE ON creator_dossiers WHEN EXISTS(SELECT 1 FROM system_maintenance WHERE id='global' AND mode<>'normal' AND expires_at>strftime('%Y-%m-%dT%H:%M:%fZ','now')) BEGIN SELECT RAISE(ABORT,'guard_maintenance'); END;
CREATE TRIGGER clock_creator_dossiers_update AFTER UPDATE ON creator_dossiers BEGIN INSERT INTO creator_clock VALUES('global',1) ON CONFLICT(id) DO UPDATE SET version=version+1; END;
CREATE TRIGGER maintenance_creator_dossiers_delete BEFORE DELETE ON creator_dossiers WHEN EXISTS(SELECT 1 FROM system_maintenance WHERE id='global' AND mode<>'normal' AND expires_at>strftime('%Y-%m-%dT%H:%M:%fZ','now')) BEGIN SELECT RAISE(ABORT,'guard_maintenance'); END;
CREATE TRIGGER clock_creator_dossiers_delete AFTER DELETE ON creator_dossiers BEGIN INSERT INTO creator_clock VALUES('global',1) ON CONFLICT(id) DO UPDATE SET version=version+1; END;
CREATE TRIGGER maintenance_creator_dossier_links_insert BEFORE INSERT ON creator_dossier_links WHEN EXISTS(SELECT 1 FROM system_maintenance WHERE id='global' AND mode<>'normal' AND expires_at>strftime('%Y-%m-%dT%H:%M:%fZ','now')) BEGIN SELECT RAISE(ABORT,'guard_maintenance'); END;
CREATE TRIGGER clock_creator_dossier_links_insert AFTER INSERT ON creator_dossier_links BEGIN INSERT INTO creator_clock VALUES('global',1) ON CONFLICT(id) DO UPDATE SET version=version+1; END;
CREATE TRIGGER maintenance_creator_dossier_links_update BEFORE UPDATE ON creator_dossier_links WHEN EXISTS(SELECT 1 FROM system_maintenance WHERE id='global' AND mode<>'normal' AND expires_at>strftime('%Y-%m-%dT%H:%M:%fZ','now')) BEGIN SELECT RAISE(ABORT,'guard_maintenance'); END;
CREATE TRIGGER clock_creator_dossier_links_update AFTER UPDATE ON creator_dossier_links BEGIN INSERT INTO creator_clock VALUES('global',1) ON CONFLICT(id) DO UPDATE SET version=version+1; END;
CREATE TRIGGER maintenance_creator_dossier_links_delete BEFORE DELETE ON creator_dossier_links WHEN EXISTS(SELECT 1 FROM system_maintenance WHERE id='global' AND mode<>'normal' AND expires_at>strftime('%Y-%m-%dT%H:%M:%fZ','now')) BEGIN SELECT RAISE(ABORT,'guard_maintenance'); END;
CREATE TRIGGER clock_creator_dossier_links_delete AFTER DELETE ON creator_dossier_links BEGIN INSERT INTO creator_clock VALUES('global',1) ON CONFLICT(id) DO UPDATE SET version=version+1; END;
CREATE TRIGGER maintenance_creator_leads_insert BEFORE INSERT ON creator_leads WHEN EXISTS(SELECT 1 FROM system_maintenance WHERE id='global' AND mode<>'normal' AND expires_at>strftime('%Y-%m-%dT%H:%M:%fZ','now')) BEGIN SELECT RAISE(ABORT,'guard_maintenance'); END;
CREATE TRIGGER clock_creator_leads_insert AFTER INSERT ON creator_leads BEGIN INSERT INTO creator_clock VALUES('global',1) ON CONFLICT(id) DO UPDATE SET version=version+1; END;
CREATE TRIGGER maintenance_creator_leads_update BEFORE UPDATE ON creator_leads WHEN EXISTS(SELECT 1 FROM system_maintenance WHERE id='global' AND mode<>'normal' AND expires_at>strftime('%Y-%m-%dT%H:%M:%fZ','now')) BEGIN SELECT RAISE(ABORT,'guard_maintenance'); END;
CREATE TRIGGER clock_creator_leads_update AFTER UPDATE ON creator_leads BEGIN INSERT INTO creator_clock VALUES('global',1) ON CONFLICT(id) DO UPDATE SET version=version+1; END;
CREATE TRIGGER maintenance_creator_leads_delete BEFORE DELETE ON creator_leads WHEN EXISTS(SELECT 1 FROM system_maintenance WHERE id='global' AND mode<>'normal' AND expires_at>strftime('%Y-%m-%dT%H:%M:%fZ','now')) BEGIN SELECT RAISE(ABORT,'guard_maintenance'); END;
CREATE TRIGGER clock_creator_leads_delete AFTER DELETE ON creator_leads BEGIN INSERT INTO creator_clock VALUES('global',1) ON CONFLICT(id) DO UPDATE SET version=version+1; END;
CREATE TRIGGER maintenance_creator_round_results_insert BEFORE INSERT ON creator_round_results WHEN EXISTS(SELECT 1 FROM system_maintenance WHERE id='global' AND mode<>'normal' AND expires_at>strftime('%Y-%m-%dT%H:%M:%fZ','now')) BEGIN SELECT RAISE(ABORT,'guard_maintenance'); END;
CREATE TRIGGER clock_creator_round_results_insert AFTER INSERT ON creator_round_results BEGIN INSERT INTO creator_clock VALUES('global',1) ON CONFLICT(id) DO UPDATE SET version=version+1; END;
CREATE TRIGGER maintenance_creator_round_results_update BEFORE UPDATE ON creator_round_results WHEN EXISTS(SELECT 1 FROM system_maintenance WHERE id='global' AND mode<>'normal' AND expires_at>strftime('%Y-%m-%dT%H:%M:%fZ','now')) BEGIN SELECT RAISE(ABORT,'guard_maintenance'); END;
CREATE TRIGGER clock_creator_round_results_update AFTER UPDATE ON creator_round_results BEGIN INSERT INTO creator_clock VALUES('global',1) ON CONFLICT(id) DO UPDATE SET version=version+1; END;
CREATE TRIGGER maintenance_creator_round_results_delete BEFORE DELETE ON creator_round_results WHEN EXISTS(SELECT 1 FROM system_maintenance WHERE id='global' AND mode<>'normal' AND expires_at>strftime('%Y-%m-%dT%H:%M:%fZ','now')) BEGIN SELECT RAISE(ABORT,'guard_maintenance'); END;
CREATE TRIGGER clock_creator_round_results_delete AFTER DELETE ON creator_round_results BEGIN INSERT INTO creator_clock VALUES('global',1) ON CONFLICT(id) DO UPDATE SET version=version+1; END;
CREATE TRIGGER maintenance_creator_practices_insert BEFORE INSERT ON creator_practices WHEN EXISTS(SELECT 1 FROM system_maintenance WHERE id='global' AND mode<>'normal' AND expires_at>strftime('%Y-%m-%dT%H:%M:%fZ','now')) BEGIN SELECT RAISE(ABORT,'guard_maintenance'); END;
CREATE TRIGGER clock_creator_practices_insert AFTER INSERT ON creator_practices BEGIN INSERT INTO creator_clock VALUES('global',1) ON CONFLICT(id) DO UPDATE SET version=version+1; END;
CREATE TRIGGER maintenance_creator_practices_update BEFORE UPDATE ON creator_practices WHEN EXISTS(SELECT 1 FROM system_maintenance WHERE id='global' AND mode<>'normal' AND expires_at>strftime('%Y-%m-%dT%H:%M:%fZ','now')) BEGIN SELECT RAISE(ABORT,'guard_maintenance'); END;
CREATE TRIGGER clock_creator_practices_update AFTER UPDATE ON creator_practices BEGIN INSERT INTO creator_clock VALUES('global',1) ON CONFLICT(id) DO UPDATE SET version=version+1; END;
CREATE TRIGGER maintenance_creator_practices_delete BEFORE DELETE ON creator_practices WHEN EXISTS(SELECT 1 FROM system_maintenance WHERE id='global' AND mode<>'normal' AND expires_at>strftime('%Y-%m-%dT%H:%M:%fZ','now')) BEGIN SELECT RAISE(ABORT,'guard_maintenance'); END;
CREATE TRIGGER clock_creator_practices_delete AFTER DELETE ON creator_practices BEGIN INSERT INTO creator_clock VALUES('global',1) ON CONFLICT(id) DO UPDATE SET version=version+1; END;
CREATE TRIGGER maintenance_creator_practice_history_insert BEFORE INSERT ON creator_practice_history WHEN EXISTS(SELECT 1 FROM system_maintenance WHERE id='global' AND mode<>'normal' AND expires_at>strftime('%Y-%m-%dT%H:%M:%fZ','now')) BEGIN SELECT RAISE(ABORT,'guard_maintenance'); END;
CREATE TRIGGER clock_creator_practice_history_insert AFTER INSERT ON creator_practice_history BEGIN INSERT INTO creator_clock VALUES('global',1) ON CONFLICT(id) DO UPDATE SET version=version+1; END;
CREATE TRIGGER maintenance_creator_practice_history_update BEFORE UPDATE ON creator_practice_history WHEN EXISTS(SELECT 1 FROM system_maintenance WHERE id='global' AND mode<>'normal' AND expires_at>strftime('%Y-%m-%dT%H:%M:%fZ','now')) BEGIN SELECT RAISE(ABORT,'guard_maintenance'); END;
CREATE TRIGGER clock_creator_practice_history_update AFTER UPDATE ON creator_practice_history BEGIN INSERT INTO creator_clock VALUES('global',1) ON CONFLICT(id) DO UPDATE SET version=version+1; END;
CREATE TRIGGER maintenance_creator_practice_history_delete BEFORE DELETE ON creator_practice_history WHEN EXISTS(SELECT 1 FROM system_maintenance WHERE id='global' AND mode<>'normal' AND expires_at>strftime('%Y-%m-%dT%H:%M:%fZ','now')) BEGIN SELECT RAISE(ABORT,'guard_maintenance'); END;
CREATE TRIGGER clock_creator_practice_history_delete AFTER DELETE ON creator_practice_history BEGIN INSERT INTO creator_clock VALUES('global',1) ON CONFLICT(id) DO UPDATE SET version=version+1; END;
CREATE TRIGGER immutable_creator_round_results_update BEFORE UPDATE ON creator_round_results BEGIN SELECT RAISE(ABORT,'immutable history'); END;
CREATE TRIGGER immutable_creator_round_results_delete BEFORE DELETE ON creator_round_results BEGIN SELECT RAISE(ABORT,'immutable history'); END;
CREATE TRIGGER immutable_creator_practice_history_update BEFORE UPDATE ON creator_practice_history BEGIN SELECT RAISE(ABORT,'immutable history'); END;
CREATE TRIGGER immutable_creator_practice_history_delete BEFORE DELETE ON creator_practice_history BEGIN SELECT RAISE(ABORT,'immutable history'); END;
-- Link legacy submissions immediately, without asserting an unrecorded historical cooperation.
INSERT OR IGNORE INTO creator_profiles(id,scope_id,platform_id,name,kind,source_user_id,state,bd_stage,next_owner_id,next_action,data_json,created_at,updated_at)
 SELECT 'intake-profile:'||r.id,r.scope_id,r.platform_id,COALESCE(NULLIF(json_extract(r.data_json,'$.name'),''),r.platform_id),COALESCE(json_extract(r.data_json,'$.kind'),''),r.submitter_id,'handoff','pending',s.bd_id,'核对历史提交并接收',json_object('profileUrl',json_extract(r.data_json,'$.profileUrl'),'contact',json_extract(r.data_json,'$.contact'),'language',json_extract(r.data_json,'$.language'),'importedHandover',json('true')),r.created_at,r.updated_at
 FROM creator_submissions r JOIN creator_scopes s ON s.id=r.scope_id WHERE r.creator_id IS NULL ORDER BY r.created_at;
UPDATE creator_submissions SET creator_id=(SELECT p.id FROM creator_profiles p WHERE p.scope_id=creator_submissions.scope_id AND p.platform_id=creator_submissions.platform_id) WHERE creator_id IS NULL;
INSERT OR IGNORE INTO creator_assets(id,site,platform,platform_id,data_json,created_at,updated_at)
 SELECT 'intake-asset:'||p.id,s.site,s.platform,p.platform_id,'{}',p.created_at,p.updated_at FROM creator_profiles p JOIN creator_scopes s ON s.id=p.scope_id;
