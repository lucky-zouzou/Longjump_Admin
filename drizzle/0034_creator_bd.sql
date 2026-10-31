-- Creator collaboration is an operational ledger. It never posts sales, stock or payments.
CREATE TABLE creator_clock (id TEXT PRIMARY KEY, version INTEGER NOT NULL);
CREATE TABLE creator_scopes (
 id TEXT PRIMARY KEY, site TEXT NOT NULL, platform TEXT NOT NULL, shop TEXT NOT NULL,
 operator_id TEXT NOT NULL REFERENCES users(id), backup_id TEXT REFERENCES users(id), bd_id TEXT NOT NULL REFERENCES users(id),
 version INTEGER NOT NULL DEFAULT 1, updated_at TEXT NOT NULL, UNIQUE(site,platform,shop)
);
CREATE TABLE creator_profiles (
 id TEXT PRIMARY KEY, scope_id TEXT NOT NULL REFERENCES creator_scopes(id), platform_id TEXT NOT NULL,
 name TEXT NOT NULL, kind TEXT NOT NULL, source_user_id TEXT NOT NULL REFERENCES users(id),
 state TEXT NOT NULL DEFAULT 'candidate', tier TEXT NOT NULL DEFAULT 'trial',
 next_at TEXT, next_owner_id TEXT REFERENCES users(id), next_action TEXT NOT NULL DEFAULT '',
 first_contact_at TEXT, first_reply_at TEXT, accepted_at TEXT,
 data_json TEXT NOT NULL, version INTEGER NOT NULL DEFAULT 1, created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
 UNIQUE(scope_id,platform_id)
);
CREATE TABLE creator_rounds (
 id TEXT PRIMARY KEY, creator_id TEXT NOT NULL REFERENCES creator_profiles(id), round_no TEXT NOT NULL UNIQUE,
 status TEXT NOT NULL DEFAULT 'draft', terms_json TEXT NOT NULL, logistics_json TEXT NOT NULL DEFAULT '{}',
 original_due_at TEXT NOT NULL, effective_due_at TEXT NOT NULL,
 author_id TEXT NOT NULL REFERENCES users(id), approver_id TEXT REFERENCES users(id), approved_at TEXT, completed_at TEXT,
 version INTEGER NOT NULL DEFAULT 1, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
);
CREATE TABLE creator_contents (
 id TEXT PRIMARY KEY, round_id TEXT NOT NULL REFERENCES creator_rounds(id), kind TEXT NOT NULL,
 url TEXT NOT NULL UNIQUE, published_at TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'pending',
 data_json TEXT NOT NULL, version INTEGER NOT NULL DEFAULT 1, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
);
CREATE TABLE creator_events (
 id TEXT PRIMARY KEY, creator_id TEXT REFERENCES creator_profiles(id), round_id TEXT REFERENCES creator_rounds(id),
 action TEXT NOT NULL, actor_id TEXT NOT NULL REFERENCES users(id), actor_name TEXT NOT NULL,
 detail_json TEXT NOT NULL, created_at TEXT NOT NULL
);
CREATE TABLE creator_finance (
 id TEXT PRIMARY KEY, round_id TEXT NOT NULL REFERENCES creator_rounds(id), revision INTEGER NOT NULL,
 basis_version INTEGER NOT NULL, business_date TEXT NOT NULL, source_ref TEXT NOT NULL,
 data_json TEXT NOT NULL, actor_id TEXT NOT NULL REFERENCES users(id), created_at TEXT NOT NULL,
 UNIQUE(round_id,revision)
);
CREATE TABLE creator_finance_sources (source_ref TEXT PRIMARY KEY, round_id TEXT NOT NULL REFERENCES creator_rounds(id));
CREATE TABLE creator_observations (
 id TEXT PRIMARY KEY, content_id TEXT NOT NULL REFERENCES creator_contents(id), window_days INTEGER NOT NULL CHECK(window_days IN (7,30)),
 revision INTEGER NOT NULL, observed_at TEXT NOT NULL, data_json TEXT NOT NULL, actor_id TEXT NOT NULL REFERENCES users(id), created_at TEXT NOT NULL,
 UNIQUE(content_id,window_days,revision)
);
CREATE INDEX creator_profile_scope ON creator_profiles(scope_id,state);
CREATE INDEX creator_round_profile ON creator_rounds(creator_id,status);
CREATE INDEX creator_event_profile ON creator_events(creator_id,created_at);

CREATE TRIGGER maintenance_creator_scopes_insert BEFORE INSERT ON creator_scopes WHEN EXISTS(SELECT 1 FROM system_maintenance WHERE id='global' AND mode<>'normal' AND expires_at>strftime('%Y-%m-%dT%H:%M:%fZ','now')) BEGIN SELECT RAISE(ABORT,'guard_maintenance'); END;
CREATE TRIGGER clock_creator_scopes_insert AFTER INSERT ON creator_scopes BEGIN INSERT INTO creator_clock VALUES('global',1) ON CONFLICT(id) DO UPDATE SET version=version+1; END;

CREATE TRIGGER maintenance_creator_scopes_update BEFORE UPDATE ON creator_scopes WHEN EXISTS(SELECT 1 FROM system_maintenance WHERE id='global' AND mode<>'normal' AND expires_at>strftime('%Y-%m-%dT%H:%M:%fZ','now')) BEGIN SELECT RAISE(ABORT,'guard_maintenance'); END;
CREATE TRIGGER clock_creator_scopes_update AFTER UPDATE ON creator_scopes BEGIN INSERT INTO creator_clock VALUES('global',1) ON CONFLICT(id) DO UPDATE SET version=version+1; END;

CREATE TRIGGER maintenance_creator_scopes_delete BEFORE DELETE ON creator_scopes WHEN EXISTS(SELECT 1 FROM system_maintenance WHERE id='global' AND mode<>'normal' AND expires_at>strftime('%Y-%m-%dT%H:%M:%fZ','now')) BEGIN SELECT RAISE(ABORT,'guard_maintenance'); END;
CREATE TRIGGER clock_creator_scopes_delete AFTER DELETE ON creator_scopes BEGIN INSERT INTO creator_clock VALUES('global',1) ON CONFLICT(id) DO UPDATE SET version=version+1; END;

CREATE TRIGGER maintenance_creator_profiles_insert BEFORE INSERT ON creator_profiles WHEN EXISTS(SELECT 1 FROM system_maintenance WHERE id='global' AND mode<>'normal' AND expires_at>strftime('%Y-%m-%dT%H:%M:%fZ','now')) BEGIN SELECT RAISE(ABORT,'guard_maintenance'); END;
CREATE TRIGGER clock_creator_profiles_insert AFTER INSERT ON creator_profiles BEGIN INSERT INTO creator_clock VALUES('global',1) ON CONFLICT(id) DO UPDATE SET version=version+1; END;

CREATE TRIGGER maintenance_creator_profiles_update BEFORE UPDATE ON creator_profiles WHEN EXISTS(SELECT 1 FROM system_maintenance WHERE id='global' AND mode<>'normal' AND expires_at>strftime('%Y-%m-%dT%H:%M:%fZ','now')) BEGIN SELECT RAISE(ABORT,'guard_maintenance'); END;
CREATE TRIGGER clock_creator_profiles_update AFTER UPDATE ON creator_profiles BEGIN INSERT INTO creator_clock VALUES('global',1) ON CONFLICT(id) DO UPDATE SET version=version+1; END;

CREATE TRIGGER maintenance_creator_profiles_delete BEFORE DELETE ON creator_profiles WHEN EXISTS(SELECT 1 FROM system_maintenance WHERE id='global' AND mode<>'normal' AND expires_at>strftime('%Y-%m-%dT%H:%M:%fZ','now')) BEGIN SELECT RAISE(ABORT,'guard_maintenance'); END;
CREATE TRIGGER clock_creator_profiles_delete AFTER DELETE ON creator_profiles BEGIN INSERT INTO creator_clock VALUES('global',1) ON CONFLICT(id) DO UPDATE SET version=version+1; END;

CREATE TRIGGER maintenance_creator_rounds_insert BEFORE INSERT ON creator_rounds WHEN EXISTS(SELECT 1 FROM system_maintenance WHERE id='global' AND mode<>'normal' AND expires_at>strftime('%Y-%m-%dT%H:%M:%fZ','now')) BEGIN SELECT RAISE(ABORT,'guard_maintenance'); END;
CREATE TRIGGER clock_creator_rounds_insert AFTER INSERT ON creator_rounds BEGIN INSERT INTO creator_clock VALUES('global',1) ON CONFLICT(id) DO UPDATE SET version=version+1; END;

CREATE TRIGGER maintenance_creator_rounds_update BEFORE UPDATE ON creator_rounds WHEN EXISTS(SELECT 1 FROM system_maintenance WHERE id='global' AND mode<>'normal' AND expires_at>strftime('%Y-%m-%dT%H:%M:%fZ','now')) BEGIN SELECT RAISE(ABORT,'guard_maintenance'); END;
CREATE TRIGGER clock_creator_rounds_update AFTER UPDATE ON creator_rounds BEGIN INSERT INTO creator_clock VALUES('global',1) ON CONFLICT(id) DO UPDATE SET version=version+1; END;

CREATE TRIGGER maintenance_creator_rounds_delete BEFORE DELETE ON creator_rounds WHEN EXISTS(SELECT 1 FROM system_maintenance WHERE id='global' AND mode<>'normal' AND expires_at>strftime('%Y-%m-%dT%H:%M:%fZ','now')) BEGIN SELECT RAISE(ABORT,'guard_maintenance'); END;
CREATE TRIGGER clock_creator_rounds_delete AFTER DELETE ON creator_rounds BEGIN INSERT INTO creator_clock VALUES('global',1) ON CONFLICT(id) DO UPDATE SET version=version+1; END;

CREATE TRIGGER maintenance_creator_contents_insert BEFORE INSERT ON creator_contents WHEN EXISTS(SELECT 1 FROM system_maintenance WHERE id='global' AND mode<>'normal' AND expires_at>strftime('%Y-%m-%dT%H:%M:%fZ','now')) BEGIN SELECT RAISE(ABORT,'guard_maintenance'); END;
CREATE TRIGGER clock_creator_contents_insert AFTER INSERT ON creator_contents BEGIN INSERT INTO creator_clock VALUES('global',1) ON CONFLICT(id) DO UPDATE SET version=version+1; END;

CREATE TRIGGER maintenance_creator_contents_update BEFORE UPDATE ON creator_contents WHEN EXISTS(SELECT 1 FROM system_maintenance WHERE id='global' AND mode<>'normal' AND expires_at>strftime('%Y-%m-%dT%H:%M:%fZ','now')) BEGIN SELECT RAISE(ABORT,'guard_maintenance'); END;
CREATE TRIGGER clock_creator_contents_update AFTER UPDATE ON creator_contents BEGIN INSERT INTO creator_clock VALUES('global',1) ON CONFLICT(id) DO UPDATE SET version=version+1; END;

CREATE TRIGGER maintenance_creator_contents_delete BEFORE DELETE ON creator_contents WHEN EXISTS(SELECT 1 FROM system_maintenance WHERE id='global' AND mode<>'normal' AND expires_at>strftime('%Y-%m-%dT%H:%M:%fZ','now')) BEGIN SELECT RAISE(ABORT,'guard_maintenance'); END;
CREATE TRIGGER clock_creator_contents_delete AFTER DELETE ON creator_contents BEGIN INSERT INTO creator_clock VALUES('global',1) ON CONFLICT(id) DO UPDATE SET version=version+1; END;

CREATE TRIGGER maintenance_creator_events_insert BEFORE INSERT ON creator_events WHEN EXISTS(SELECT 1 FROM system_maintenance WHERE id='global' AND mode<>'normal' AND expires_at>strftime('%Y-%m-%dT%H:%M:%fZ','now')) BEGIN SELECT RAISE(ABORT,'guard_maintenance'); END;
CREATE TRIGGER clock_creator_events_insert AFTER INSERT ON creator_events BEGIN INSERT INTO creator_clock VALUES('global',1) ON CONFLICT(id) DO UPDATE SET version=version+1; END;

CREATE TRIGGER maintenance_creator_events_update BEFORE UPDATE ON creator_events WHEN EXISTS(SELECT 1 FROM system_maintenance WHERE id='global' AND mode<>'normal' AND expires_at>strftime('%Y-%m-%dT%H:%M:%fZ','now')) BEGIN SELECT RAISE(ABORT,'guard_maintenance'); END;
CREATE TRIGGER clock_creator_events_update AFTER UPDATE ON creator_events BEGIN INSERT INTO creator_clock VALUES('global',1) ON CONFLICT(id) DO UPDATE SET version=version+1; END;

CREATE TRIGGER maintenance_creator_events_delete BEFORE DELETE ON creator_events WHEN EXISTS(SELECT 1 FROM system_maintenance WHERE id='global' AND mode<>'normal' AND expires_at>strftime('%Y-%m-%dT%H:%M:%fZ','now')) BEGIN SELECT RAISE(ABORT,'guard_maintenance'); END;
CREATE TRIGGER clock_creator_events_delete AFTER DELETE ON creator_events BEGIN INSERT INTO creator_clock VALUES('global',1) ON CONFLICT(id) DO UPDATE SET version=version+1; END;
CREATE TRIGGER immutable_creator_events_update BEFORE UPDATE ON creator_events BEGIN SELECT RAISE(ABORT,'immutable history'); END;
CREATE TRIGGER immutable_creator_events_delete BEFORE DELETE ON creator_events BEGIN SELECT RAISE(ABORT,'immutable history'); END;

CREATE TRIGGER maintenance_creator_finance_insert BEFORE INSERT ON creator_finance WHEN EXISTS(SELECT 1 FROM system_maintenance WHERE id='global' AND mode<>'normal' AND expires_at>strftime('%Y-%m-%dT%H:%M:%fZ','now')) BEGIN SELECT RAISE(ABORT,'guard_maintenance'); END;
CREATE TRIGGER clock_creator_finance_insert AFTER INSERT ON creator_finance BEGIN INSERT INTO creator_clock VALUES('global',1) ON CONFLICT(id) DO UPDATE SET version=version+1; END;

CREATE TRIGGER maintenance_creator_finance_update BEFORE UPDATE ON creator_finance WHEN EXISTS(SELECT 1 FROM system_maintenance WHERE id='global' AND mode<>'normal' AND expires_at>strftime('%Y-%m-%dT%H:%M:%fZ','now')) BEGIN SELECT RAISE(ABORT,'guard_maintenance'); END;
CREATE TRIGGER clock_creator_finance_update AFTER UPDATE ON creator_finance BEGIN INSERT INTO creator_clock VALUES('global',1) ON CONFLICT(id) DO UPDATE SET version=version+1; END;

CREATE TRIGGER maintenance_creator_finance_delete BEFORE DELETE ON creator_finance WHEN EXISTS(SELECT 1 FROM system_maintenance WHERE id='global' AND mode<>'normal' AND expires_at>strftime('%Y-%m-%dT%H:%M:%fZ','now')) BEGIN SELECT RAISE(ABORT,'guard_maintenance'); END;
CREATE TRIGGER clock_creator_finance_delete AFTER DELETE ON creator_finance BEGIN INSERT INTO creator_clock VALUES('global',1) ON CONFLICT(id) DO UPDATE SET version=version+1; END;
CREATE TRIGGER immutable_creator_finance_update BEFORE UPDATE ON creator_finance BEGIN SELECT RAISE(ABORT,'immutable history'); END;
CREATE TRIGGER immutable_creator_finance_delete BEFORE DELETE ON creator_finance BEGIN SELECT RAISE(ABORT,'immutable history'); END;

CREATE TRIGGER maintenance_creator_finance_sources_insert BEFORE INSERT ON creator_finance_sources WHEN EXISTS(SELECT 1 FROM system_maintenance WHERE id='global' AND mode<>'normal' AND expires_at>strftime('%Y-%m-%dT%H:%M:%fZ','now')) BEGIN SELECT RAISE(ABORT,'guard_maintenance'); END;
CREATE TRIGGER clock_creator_finance_sources_insert AFTER INSERT ON creator_finance_sources BEGIN INSERT INTO creator_clock VALUES('global',1) ON CONFLICT(id) DO UPDATE SET version=version+1; END;

CREATE TRIGGER maintenance_creator_finance_sources_update BEFORE UPDATE ON creator_finance_sources WHEN EXISTS(SELECT 1 FROM system_maintenance WHERE id='global' AND mode<>'normal' AND expires_at>strftime('%Y-%m-%dT%H:%M:%fZ','now')) BEGIN SELECT RAISE(ABORT,'guard_maintenance'); END;
CREATE TRIGGER clock_creator_finance_sources_update AFTER UPDATE ON creator_finance_sources BEGIN INSERT INTO creator_clock VALUES('global',1) ON CONFLICT(id) DO UPDATE SET version=version+1; END;

CREATE TRIGGER maintenance_creator_finance_sources_delete BEFORE DELETE ON creator_finance_sources WHEN EXISTS(SELECT 1 FROM system_maintenance WHERE id='global' AND mode<>'normal' AND expires_at>strftime('%Y-%m-%dT%H:%M:%fZ','now')) BEGIN SELECT RAISE(ABORT,'guard_maintenance'); END;
CREATE TRIGGER clock_creator_finance_sources_delete AFTER DELETE ON creator_finance_sources BEGIN INSERT INTO creator_clock VALUES('global',1) ON CONFLICT(id) DO UPDATE SET version=version+1; END;

CREATE TRIGGER maintenance_creator_observations_insert BEFORE INSERT ON creator_observations WHEN EXISTS(SELECT 1 FROM system_maintenance WHERE id='global' AND mode<>'normal' AND expires_at>strftime('%Y-%m-%dT%H:%M:%fZ','now')) BEGIN SELECT RAISE(ABORT,'guard_maintenance'); END;
CREATE TRIGGER clock_creator_observations_insert AFTER INSERT ON creator_observations BEGIN INSERT INTO creator_clock VALUES('global',1) ON CONFLICT(id) DO UPDATE SET version=version+1; END;

CREATE TRIGGER maintenance_creator_observations_update BEFORE UPDATE ON creator_observations WHEN EXISTS(SELECT 1 FROM system_maintenance WHERE id='global' AND mode<>'normal' AND expires_at>strftime('%Y-%m-%dT%H:%M:%fZ','now')) BEGIN SELECT RAISE(ABORT,'guard_maintenance'); END;
CREATE TRIGGER clock_creator_observations_update AFTER UPDATE ON creator_observations BEGIN INSERT INTO creator_clock VALUES('global',1) ON CONFLICT(id) DO UPDATE SET version=version+1; END;

CREATE TRIGGER maintenance_creator_observations_delete BEFORE DELETE ON creator_observations WHEN EXISTS(SELECT 1 FROM system_maintenance WHERE id='global' AND mode<>'normal' AND expires_at>strftime('%Y-%m-%dT%H:%M:%fZ','now')) BEGIN SELECT RAISE(ABORT,'guard_maintenance'); END;
CREATE TRIGGER clock_creator_observations_delete AFTER DELETE ON creator_observations BEGIN INSERT INTO creator_clock VALUES('global',1) ON CONFLICT(id) DO UPDATE SET version=version+1; END;
CREATE TRIGGER immutable_creator_observations_update BEFORE UPDATE ON creator_observations BEGIN SELECT RAISE(ABORT,'immutable history'); END;
CREATE TRIGGER immutable_creator_observations_delete BEFORE DELETE ON creator_observations BEGIN SELECT RAISE(ABORT,'immutable history'); END;
CREATE TRIGGER creator_clock_users_insert AFTER INSERT ON users BEGIN INSERT INTO creator_clock VALUES('global',1) ON CONFLICT(id) DO UPDATE SET version=version+1; END;
CREATE TRIGGER creator_clock_users_update AFTER UPDATE ON users BEGIN INSERT INTO creator_clock VALUES('global',1) ON CONFLICT(id) DO UPDATE SET version=version+1; END;
CREATE TRIGGER creator_clock_users_delete AFTER DELETE ON users BEGIN INSERT INTO creator_clock VALUES('global',1) ON CONFLICT(id) DO UPDATE SET version=version+1; END;
CREATE TRIGGER creator_clock_sku_settings_insert AFTER INSERT ON sku_settings BEGIN INSERT INTO creator_clock VALUES('global',1) ON CONFLICT(id) DO UPDATE SET version=version+1; END;
CREATE TRIGGER creator_clock_sku_settings_update AFTER UPDATE ON sku_settings BEGIN INSERT INTO creator_clock VALUES('global',1) ON CONFLICT(id) DO UPDATE SET version=version+1; END;
CREATE TRIGGER creator_clock_sku_settings_delete AFTER DELETE ON sku_settings BEGIN INSERT INTO creator_clock VALUES('global',1) ON CONFLICT(id) DO UPDATE SET version=version+1; END;
CREATE TRIGGER creator_finance_closed BEFORE INSERT ON creator_finance WHEN EXISTS(SELECT 1 FROM finance_period_events p WHERE p.status='closed' AND p.revision=(SELECT MAX(x.revision) FROM finance_period_events x WHERE x.month=p.month) AND substr(NEW.business_date,1,7)<=p.month) BEGIN SELECT RAISE(ABORT,'closed finance period'); END;
CREATE TRIGGER creator_clock_period_close AFTER INSERT ON finance_period_events BEGIN INSERT INTO creator_clock VALUES('global',1) ON CONFLICT(id) DO UPDATE SET version=version+1; END;
