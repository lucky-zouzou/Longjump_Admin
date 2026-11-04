CREATE TABLE creator_submissions (
 id TEXT PRIMARY KEY, scope_id TEXT NOT NULL REFERENCES creator_scopes(id), creator_id TEXT REFERENCES creator_profiles(id),
 platform_id TEXT NOT NULL, submitted_on TEXT NOT NULL, request_kind TEXT NOT NULL,
 submitter_id TEXT NOT NULL REFERENCES users(id), submitted_by TEXT NOT NULL REFERENCES users(id),
 status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','queued','returned','accepted')),
 data_json TEXT NOT NULL, review_json TEXT NOT NULL DEFAULT '{}', fingerprint TEXT NOT NULL,
 version INTEGER NOT NULL DEFAULT 1, created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
 UNIQUE(scope_id,fingerprint)
);
CREATE INDEX creator_submissions_queue ON creator_submissions(scope_id,status,updated_at);
CREATE TABLE creator_submission_history (
 id TEXT PRIMARY KEY, submission_id TEXT NOT NULL REFERENCES creator_submissions(id), revision INTEGER NOT NULL,
 action TEXT NOT NULL, actor_id TEXT NOT NULL REFERENCES users(id), actor_name TEXT NOT NULL,
 snapshot_json TEXT NOT NULL, created_at TEXT NOT NULL, UNIQUE(submission_id,revision)
);
CREATE TRIGGER maintenance_creator_submissions_insert BEFORE INSERT ON creator_submissions WHEN EXISTS(SELECT 1 FROM system_maintenance WHERE id='global' AND mode<>'normal' AND expires_at>strftime('%Y-%m-%dT%H:%M:%fZ','now')) BEGIN SELECT RAISE(ABORT,'guard_maintenance'); END;
CREATE TRIGGER clock_creator_submissions_insert AFTER INSERT ON creator_submissions BEGIN INSERT INTO creator_clock VALUES('global',1) ON CONFLICT(id) DO UPDATE SET version=version+1; END;
CREATE TRIGGER maintenance_creator_submissions_update BEFORE UPDATE ON creator_submissions WHEN EXISTS(SELECT 1 FROM system_maintenance WHERE id='global' AND mode<>'normal' AND expires_at>strftime('%Y-%m-%dT%H:%M:%fZ','now')) BEGIN SELECT RAISE(ABORT,'guard_maintenance'); END;
CREATE TRIGGER clock_creator_submissions_update AFTER UPDATE ON creator_submissions BEGIN INSERT INTO creator_clock VALUES('global',1) ON CONFLICT(id) DO UPDATE SET version=version+1; END;
CREATE TRIGGER maintenance_creator_submissions_delete BEFORE DELETE ON creator_submissions WHEN EXISTS(SELECT 1 FROM system_maintenance WHERE id='global' AND mode<>'normal' AND expires_at>strftime('%Y-%m-%dT%H:%M:%fZ','now')) BEGIN SELECT RAISE(ABORT,'guard_maintenance'); END;
CREATE TRIGGER clock_creator_submissions_delete AFTER DELETE ON creator_submissions BEGIN INSERT INTO creator_clock VALUES('global',1) ON CONFLICT(id) DO UPDATE SET version=version+1; END;
CREATE TRIGGER maintenance_creator_submission_history_insert BEFORE INSERT ON creator_submission_history WHEN EXISTS(SELECT 1 FROM system_maintenance WHERE id='global' AND mode<>'normal' AND expires_at>strftime('%Y-%m-%dT%H:%M:%fZ','now')) BEGIN SELECT RAISE(ABORT,'guard_maintenance'); END;
CREATE TRIGGER clock_creator_submission_history_insert AFTER INSERT ON creator_submission_history BEGIN INSERT INTO creator_clock VALUES('global',1) ON CONFLICT(id) DO UPDATE SET version=version+1; END;
CREATE TRIGGER maintenance_creator_submission_history_update BEFORE UPDATE ON creator_submission_history WHEN EXISTS(SELECT 1 FROM system_maintenance WHERE id='global' AND mode<>'normal' AND expires_at>strftime('%Y-%m-%dT%H:%M:%fZ','now')) BEGIN SELECT RAISE(ABORT,'guard_maintenance'); END;
CREATE TRIGGER clock_creator_submission_history_update AFTER UPDATE ON creator_submission_history BEGIN INSERT INTO creator_clock VALUES('global',1) ON CONFLICT(id) DO UPDATE SET version=version+1; END;
CREATE TRIGGER maintenance_creator_submission_history_delete BEFORE DELETE ON creator_submission_history WHEN EXISTS(SELECT 1 FROM system_maintenance WHERE id='global' AND mode<>'normal' AND expires_at>strftime('%Y-%m-%dT%H:%M:%fZ','now')) BEGIN SELECT RAISE(ABORT,'guard_maintenance'); END;
CREATE TRIGGER clock_creator_submission_history_delete AFTER DELETE ON creator_submission_history BEGIN INSERT INTO creator_clock VALUES('global',1) ON CONFLICT(id) DO UPDATE SET version=version+1; END;
CREATE TRIGGER immutable_creator_submission_history_update BEFORE UPDATE ON creator_submission_history BEGIN SELECT RAISE(ABORT,'immutable history'); END;
CREATE TRIGGER immutable_creator_submission_history_delete BEFORE DELETE ON creator_submission_history BEGIN SELECT RAISE(ABORT,'immutable history'); END;
