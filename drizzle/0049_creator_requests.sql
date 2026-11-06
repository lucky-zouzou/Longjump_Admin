CREATE TABLE creator_requests (
 id TEXT PRIMARY KEY NOT NULL, creator_id TEXT NOT NULL REFERENCES creator_profiles(id),
 author_id TEXT NOT NULL REFERENCES users(id), state TEXT NOT NULL CHECK(state IN ('pending','following','executing','cancelled')),
 terms_json TEXT NOT NULL, round_id TEXT UNIQUE REFERENCES creator_rounds(id),
 version INTEGER NOT NULL DEFAULT 1, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
);
CREATE INDEX creator_requests_profile ON creator_requests(creator_id,state);
CREATE TABLE creator_practice_uses (
 practice_id TEXT NOT NULL REFERENCES creator_practices(id), scope_id TEXT NOT NULL REFERENCES creator_scopes(id),
 actor_id TEXT NOT NULL REFERENCES users(id), revision INTEGER NOT NULL, kind TEXT NOT NULL CHECK(kind IN ('read','used')),
 updated_at TEXT NOT NULL, PRIMARY KEY(practice_id,scope_id,actor_id,revision)
);
CREATE TABLE creator_practice_files (
 id TEXT PRIMARY KEY NOT NULL, practice_id TEXT NOT NULL REFERENCES creator_practices(id),
 filename TEXT NOT NULL, mime TEXT NOT NULL, payload TEXT NOT NULL
);
CREATE TRIGGER maintenance_creator_requests_insert BEFORE INSERT ON creator_requests
WHEN EXISTS(SELECT 1 FROM system_maintenance WHERE id='global' AND mode<>'normal' AND expires_at>strftime('%Y-%m-%dT%H:%M:%fZ','now'))
BEGIN SELECT RAISE(ABORT,'guard_maintenance'); END;
CREATE TRIGGER clock_creator_requests_insert AFTER INSERT ON creator_requests BEGIN UPDATE creator_clock SET version=version+1 WHERE id='global'; END;
CREATE TRIGGER maintenance_creator_requests_update BEFORE UPDATE ON creator_requests
WHEN EXISTS(SELECT 1 FROM system_maintenance WHERE id='global' AND mode<>'normal' AND expires_at>strftime('%Y-%m-%dT%H:%M:%fZ','now'))
BEGIN SELECT RAISE(ABORT,'guard_maintenance'); END;
CREATE TRIGGER clock_creator_requests_update AFTER UPDATE ON creator_requests BEGIN UPDATE creator_clock SET version=version+1 WHERE id='global'; END;
CREATE TRIGGER maintenance_creator_requests_delete BEFORE DELETE ON creator_requests
WHEN EXISTS(SELECT 1 FROM system_maintenance WHERE id='global' AND mode<>'normal' AND expires_at>strftime('%Y-%m-%dT%H:%M:%fZ','now'))
BEGIN SELECT RAISE(ABORT,'guard_maintenance'); END;
CREATE TRIGGER clock_creator_requests_delete AFTER DELETE ON creator_requests BEGIN UPDATE creator_clock SET version=version+1 WHERE id='global'; END;
CREATE TRIGGER maintenance_creator_practice_uses_insert BEFORE INSERT ON creator_practice_uses
WHEN EXISTS(SELECT 1 FROM system_maintenance WHERE id='global' AND mode<>'normal' AND expires_at>strftime('%Y-%m-%dT%H:%M:%fZ','now'))
BEGIN SELECT RAISE(ABORT,'guard_maintenance'); END;
CREATE TRIGGER clock_creator_practice_uses_insert AFTER INSERT ON creator_practice_uses BEGIN UPDATE creator_clock SET version=version+1 WHERE id='global'; END;
CREATE TRIGGER maintenance_creator_practice_uses_update BEFORE UPDATE ON creator_practice_uses
WHEN EXISTS(SELECT 1 FROM system_maintenance WHERE id='global' AND mode<>'normal' AND expires_at>strftime('%Y-%m-%dT%H:%M:%fZ','now'))
BEGIN SELECT RAISE(ABORT,'guard_maintenance'); END;
CREATE TRIGGER clock_creator_practice_uses_update AFTER UPDATE ON creator_practice_uses BEGIN UPDATE creator_clock SET version=version+1 WHERE id='global'; END;
CREATE TRIGGER maintenance_creator_practice_uses_delete BEFORE DELETE ON creator_practice_uses
WHEN EXISTS(SELECT 1 FROM system_maintenance WHERE id='global' AND mode<>'normal' AND expires_at>strftime('%Y-%m-%dT%H:%M:%fZ','now'))
BEGIN SELECT RAISE(ABORT,'guard_maintenance'); END;
CREATE TRIGGER clock_creator_practice_uses_delete AFTER DELETE ON creator_practice_uses BEGIN UPDATE creator_clock SET version=version+1 WHERE id='global'; END;
CREATE TRIGGER maintenance_creator_practice_files_insert BEFORE INSERT ON creator_practice_files
WHEN EXISTS(SELECT 1 FROM system_maintenance WHERE id='global' AND mode<>'normal' AND expires_at>strftime('%Y-%m-%dT%H:%M:%fZ','now'))
BEGIN SELECT RAISE(ABORT,'guard_maintenance'); END;
CREATE TRIGGER clock_creator_practice_files_insert AFTER INSERT ON creator_practice_files BEGIN UPDATE creator_clock SET version=version+1 WHERE id='global'; END;
CREATE TRIGGER maintenance_creator_practice_files_update BEFORE UPDATE ON creator_practice_files
WHEN EXISTS(SELECT 1 FROM system_maintenance WHERE id='global' AND mode<>'normal' AND expires_at>strftime('%Y-%m-%dT%H:%M:%fZ','now'))
BEGIN SELECT RAISE(ABORT,'guard_maintenance'); END;
CREATE TRIGGER clock_creator_practice_files_update AFTER UPDATE ON creator_practice_files BEGIN UPDATE creator_clock SET version=version+1 WHERE id='global'; END;
CREATE TRIGGER maintenance_creator_practice_files_delete BEFORE DELETE ON creator_practice_files
WHEN EXISTS(SELECT 1 FROM system_maintenance WHERE id='global' AND mode<>'normal' AND expires_at>strftime('%Y-%m-%dT%H:%M:%fZ','now'))
BEGIN SELECT RAISE(ABORT,'guard_maintenance'); END;
CREATE TRIGGER clock_creator_practice_files_delete AFTER DELETE ON creator_practice_files BEGIN UPDATE creator_clock SET version=version+1 WHERE id='global'; END;
CREATE TABLE creator_bd_names (user_id TEXT PRIMARY KEY REFERENCES users(id), display_name TEXT NOT NULL);
CREATE TRIGGER maintenance_creator_bd_names_insert BEFORE INSERT ON creator_bd_names
WHEN EXISTS(SELECT 1 FROM system_maintenance WHERE id='global' AND mode<>'normal' AND expires_at>strftime('%Y-%m-%dT%H:%M:%fZ','now'))
BEGIN SELECT RAISE(ABORT,'guard_maintenance'); END;
CREATE TRIGGER clock_creator_bd_names_insert AFTER INSERT ON creator_bd_names BEGIN UPDATE creator_clock SET version=version+1 WHERE id='global'; END;
CREATE TRIGGER maintenance_creator_bd_names_update BEFORE UPDATE ON creator_bd_names
WHEN EXISTS(SELECT 1 FROM system_maintenance WHERE id='global' AND mode<>'normal' AND expires_at>strftime('%Y-%m-%dT%H:%M:%fZ','now'))
BEGIN SELECT RAISE(ABORT,'guard_maintenance'); END;
CREATE TRIGGER clock_creator_bd_names_update AFTER UPDATE ON creator_bd_names BEGIN UPDATE creator_clock SET version=version+1 WHERE id='global'; END;
CREATE TRIGGER maintenance_creator_bd_names_delete BEFORE DELETE ON creator_bd_names
WHEN EXISTS(SELECT 1 FROM system_maintenance WHERE id='global' AND mode<>'normal' AND expires_at>strftime('%Y-%m-%dT%H:%M:%fZ','now'))
BEGIN SELECT RAISE(ABORT,'guard_maintenance'); END;
CREATE TRIGGER clock_creator_bd_names_delete AFTER DELETE ON creator_bd_names BEGIN UPDATE creator_clock SET version=version+1 WHERE id='global'; END;
