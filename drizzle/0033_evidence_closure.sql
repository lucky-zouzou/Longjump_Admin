-- New workflow state only. No historical stock, money or user grants are changed.
CREATE TABLE evidence_tasks (
 task_key TEXT PRIMARY KEY NOT NULL, site TEXT NOT NULL, channel TEXT NOT NULL,
 owner_id TEXT REFERENCES users(id), due_at TEXT, status TEXT NOT NULL DEFAULT 'open',
 version INTEGER NOT NULL DEFAULT 1, updated_at TEXT NOT NULL, snapshot_json TEXT NOT NULL
);
CREATE TABLE evidence_task_events (
 id TEXT PRIMARY KEY NOT NULL, task_key TEXT NOT NULL REFERENCES evidence_tasks(task_key),
 action TEXT NOT NULL, detail_json TEXT NOT NULL, actor_id TEXT NOT NULL REFERENCES users(id), created_at TEXT NOT NULL
);
CREATE TABLE quality_factory_aliases (
 alias TEXT PRIMARY KEY NOT NULL, factory_id TEXT NOT NULL REFERENCES business_partners(id),
 evidence TEXT NOT NULL, actor_id TEXT NOT NULL, created_at TEXT NOT NULL
);
CREATE TABLE finance_claim_sources (
 id TEXT PRIMARY KEY NOT NULL, kind TEXT NOT NULL CHECK(kind IN ('cash','offset')),
 factory_id TEXT NOT NULL REFERENCES business_partners(id), currency TEXT NOT NULL,
 amount_minor INTEGER NOT NULL CHECK(amount_minor>0), business_date TEXT NOT NULL,
 reference TEXT NOT NULL, debt_key TEXT, evidence TEXT NOT NULL, actor_id TEXT NOT NULL, created_at TEXT NOT NULL
);
CREATE TABLE finance_claim_allocations (
 id TEXT PRIMARY KEY NOT NULL, source_id TEXT NOT NULL REFERENCES finance_claim_sources(id),
 case_id TEXT NOT NULL REFERENCES after_sales(id), amount_minor INTEGER NOT NULL CHECK(amount_minor>0),
 business_date TEXT NOT NULL, evidence TEXT NOT NULL, actor_id TEXT NOT NULL, created_at TEXT NOT NULL
);
CREATE TABLE finance_claim_reversals (
 id TEXT PRIMARY KEY NOT NULL, allocation_id TEXT UNIQUE REFERENCES finance_claim_allocations(id),
 source_id TEXT UNIQUE REFERENCES finance_claim_sources(id), business_date TEXT NOT NULL,
 reason TEXT NOT NULL, actor_id TEXT NOT NULL, created_at TEXT NOT NULL,
 CHECK((allocation_id IS NULL) <> (source_id IS NULL))
);
CREATE TABLE quality_delivery_evidence (
 id TEXT PRIMARY KEY NOT NULL, factory_id TEXT NOT NULL REFERENCES business_partners(id), month TEXT NOT NULL,
 revision INTEGER NOT NULL DEFAULT 1, qty INTEGER NOT NULL CHECK(qty>0), reference TEXT NOT NULL, note TEXT NOT NULL, actor_id TEXT NOT NULL, created_at TEXT NOT NULL,
 UNIQUE(factory_id,month,reference,revision)
);

CREATE TRIGGER maintenance_evidence_tasks_insert BEFORE INSERT ON evidence_tasks WHEN EXISTS(SELECT 1 FROM system_maintenance WHERE id='global' AND mode<>'normal' AND expires_at>strftime('%Y-%m-%dT%H:%M:%fZ','now')) BEGIN SELECT RAISE(ABORT,'guard_maintenance'); END;

CREATE TRIGGER maintenance_evidence_tasks_update BEFORE UPDATE ON evidence_tasks WHEN EXISTS(SELECT 1 FROM system_maintenance WHERE id='global' AND mode<>'normal' AND expires_at>strftime('%Y-%m-%dT%H:%M:%fZ','now')) BEGIN SELECT RAISE(ABORT,'guard_maintenance'); END;

CREATE TRIGGER maintenance_evidence_tasks_delete BEFORE DELETE ON evidence_tasks WHEN EXISTS(SELECT 1 FROM system_maintenance WHERE id='global' AND mode<>'normal' AND expires_at>strftime('%Y-%m-%dT%H:%M:%fZ','now')) BEGIN SELECT RAISE(ABORT,'guard_maintenance'); END;

CREATE TRIGGER maintenance_evidence_task_events_insert BEFORE INSERT ON evidence_task_events WHEN EXISTS(SELECT 1 FROM system_maintenance WHERE id='global' AND mode<>'normal' AND expires_at>strftime('%Y-%m-%dT%H:%M:%fZ','now')) BEGIN SELECT RAISE(ABORT,'guard_maintenance'); END;

CREATE TRIGGER maintenance_evidence_task_events_update BEFORE UPDATE ON evidence_task_events WHEN EXISTS(SELECT 1 FROM system_maintenance WHERE id='global' AND mode<>'normal' AND expires_at>strftime('%Y-%m-%dT%H:%M:%fZ','now')) BEGIN SELECT RAISE(ABORT,'guard_maintenance'); END;

CREATE TRIGGER maintenance_evidence_task_events_delete BEFORE DELETE ON evidence_task_events WHEN EXISTS(SELECT 1 FROM system_maintenance WHERE id='global' AND mode<>'normal' AND expires_at>strftime('%Y-%m-%dT%H:%M:%fZ','now')) BEGIN SELECT RAISE(ABORT,'guard_maintenance'); END;
CREATE TRIGGER immutable_evidence_task_events_update BEFORE UPDATE ON evidence_task_events BEGIN SELECT RAISE(ABORT,'immutable history'); END;
CREATE TRIGGER immutable_evidence_task_events_delete BEFORE DELETE ON evidence_task_events BEGIN SELECT RAISE(ABORT,'immutable history'); END;

CREATE TRIGGER maintenance_quality_factory_aliases_insert BEFORE INSERT ON quality_factory_aliases WHEN EXISTS(SELECT 1 FROM system_maintenance WHERE id='global' AND mode<>'normal' AND expires_at>strftime('%Y-%m-%dT%H:%M:%fZ','now')) BEGIN SELECT RAISE(ABORT,'guard_maintenance'); END;

CREATE TRIGGER maintenance_quality_factory_aliases_update BEFORE UPDATE ON quality_factory_aliases WHEN EXISTS(SELECT 1 FROM system_maintenance WHERE id='global' AND mode<>'normal' AND expires_at>strftime('%Y-%m-%dT%H:%M:%fZ','now')) BEGIN SELECT RAISE(ABORT,'guard_maintenance'); END;

CREATE TRIGGER maintenance_quality_factory_aliases_delete BEFORE DELETE ON quality_factory_aliases WHEN EXISTS(SELECT 1 FROM system_maintenance WHERE id='global' AND mode<>'normal' AND expires_at>strftime('%Y-%m-%dT%H:%M:%fZ','now')) BEGIN SELECT RAISE(ABORT,'guard_maintenance'); END;

CREATE TRIGGER maintenance_finance_claim_sources_insert BEFORE INSERT ON finance_claim_sources WHEN EXISTS(SELECT 1 FROM system_maintenance WHERE id='global' AND mode<>'normal' AND expires_at>strftime('%Y-%m-%dT%H:%M:%fZ','now')) BEGIN SELECT RAISE(ABORT,'guard_maintenance'); END;

CREATE TRIGGER maintenance_finance_claim_sources_update BEFORE UPDATE ON finance_claim_sources WHEN EXISTS(SELECT 1 FROM system_maintenance WHERE id='global' AND mode<>'normal' AND expires_at>strftime('%Y-%m-%dT%H:%M:%fZ','now')) BEGIN SELECT RAISE(ABORT,'guard_maintenance'); END;

CREATE TRIGGER maintenance_finance_claim_sources_delete BEFORE DELETE ON finance_claim_sources WHEN EXISTS(SELECT 1 FROM system_maintenance WHERE id='global' AND mode<>'normal' AND expires_at>strftime('%Y-%m-%dT%H:%M:%fZ','now')) BEGIN SELECT RAISE(ABORT,'guard_maintenance'); END;
CREATE TRIGGER immutable_finance_claim_sources_update BEFORE UPDATE ON finance_claim_sources BEGIN SELECT RAISE(ABORT,'immutable history'); END;
CREATE TRIGGER immutable_finance_claim_sources_delete BEFORE DELETE ON finance_claim_sources BEGIN SELECT RAISE(ABORT,'immutable history'); END;
CREATE TRIGGER clock_finance_claim_sources_insert AFTER INSERT ON finance_claim_sources BEGIN INSERT INTO finance_clock VALUES('global',1) ON CONFLICT(id) DO UPDATE SET version=version+1; END;
CREATE TRIGGER finance_closed_finance_claim_sources_insert BEFORE INSERT ON finance_claim_sources WHEN EXISTS(SELECT 1 FROM finance_period_events p WHERE p.status='closed' AND p.revision=(SELECT MAX(x.revision) FROM finance_period_events x WHERE x.month=p.month) AND substr(NEW.business_date,1,7)<=p.month) BEGIN SELECT RAISE(ABORT,'closed finance period'); END;

CREATE TRIGGER maintenance_finance_claim_allocations_insert BEFORE INSERT ON finance_claim_allocations WHEN EXISTS(SELECT 1 FROM system_maintenance WHERE id='global' AND mode<>'normal' AND expires_at>strftime('%Y-%m-%dT%H:%M:%fZ','now')) BEGIN SELECT RAISE(ABORT,'guard_maintenance'); END;

CREATE TRIGGER maintenance_finance_claim_allocations_update BEFORE UPDATE ON finance_claim_allocations WHEN EXISTS(SELECT 1 FROM system_maintenance WHERE id='global' AND mode<>'normal' AND expires_at>strftime('%Y-%m-%dT%H:%M:%fZ','now')) BEGIN SELECT RAISE(ABORT,'guard_maintenance'); END;

CREATE TRIGGER maintenance_finance_claim_allocations_delete BEFORE DELETE ON finance_claim_allocations WHEN EXISTS(SELECT 1 FROM system_maintenance WHERE id='global' AND mode<>'normal' AND expires_at>strftime('%Y-%m-%dT%H:%M:%fZ','now')) BEGIN SELECT RAISE(ABORT,'guard_maintenance'); END;
CREATE TRIGGER immutable_finance_claim_allocations_update BEFORE UPDATE ON finance_claim_allocations BEGIN SELECT RAISE(ABORT,'immutable history'); END;
CREATE TRIGGER immutable_finance_claim_allocations_delete BEFORE DELETE ON finance_claim_allocations BEGIN SELECT RAISE(ABORT,'immutable history'); END;
CREATE TRIGGER clock_finance_claim_allocations_insert AFTER INSERT ON finance_claim_allocations BEGIN INSERT INTO finance_clock VALUES('global',1) ON CONFLICT(id) DO UPDATE SET version=version+1; END;
CREATE TRIGGER finance_closed_finance_claim_allocations_insert BEFORE INSERT ON finance_claim_allocations WHEN EXISTS(SELECT 1 FROM finance_period_events p WHERE p.status='closed' AND p.revision=(SELECT MAX(x.revision) FROM finance_period_events x WHERE x.month=p.month) AND substr(NEW.business_date,1,7)<=p.month) BEGIN SELECT RAISE(ABORT,'closed finance period'); END;

CREATE TRIGGER maintenance_finance_claim_reversals_insert BEFORE INSERT ON finance_claim_reversals WHEN EXISTS(SELECT 1 FROM system_maintenance WHERE id='global' AND mode<>'normal' AND expires_at>strftime('%Y-%m-%dT%H:%M:%fZ','now')) BEGIN SELECT RAISE(ABORT,'guard_maintenance'); END;

CREATE TRIGGER maintenance_finance_claim_reversals_update BEFORE UPDATE ON finance_claim_reversals WHEN EXISTS(SELECT 1 FROM system_maintenance WHERE id='global' AND mode<>'normal' AND expires_at>strftime('%Y-%m-%dT%H:%M:%fZ','now')) BEGIN SELECT RAISE(ABORT,'guard_maintenance'); END;

CREATE TRIGGER maintenance_finance_claim_reversals_delete BEFORE DELETE ON finance_claim_reversals WHEN EXISTS(SELECT 1 FROM system_maintenance WHERE id='global' AND mode<>'normal' AND expires_at>strftime('%Y-%m-%dT%H:%M:%fZ','now')) BEGIN SELECT RAISE(ABORT,'guard_maintenance'); END;
CREATE TRIGGER immutable_finance_claim_reversals_update BEFORE UPDATE ON finance_claim_reversals BEGIN SELECT RAISE(ABORT,'immutable history'); END;
CREATE TRIGGER immutable_finance_claim_reversals_delete BEFORE DELETE ON finance_claim_reversals BEGIN SELECT RAISE(ABORT,'immutable history'); END;
CREATE TRIGGER clock_finance_claim_reversals_insert AFTER INSERT ON finance_claim_reversals BEGIN INSERT INTO finance_clock VALUES('global',1) ON CONFLICT(id) DO UPDATE SET version=version+1; END;
CREATE TRIGGER finance_closed_finance_claim_reversals_insert BEFORE INSERT ON finance_claim_reversals WHEN EXISTS(SELECT 1 FROM finance_period_events p WHERE p.status='closed' AND p.revision=(SELECT MAX(x.revision) FROM finance_period_events x WHERE x.month=p.month) AND substr(NEW.business_date,1,7)<=p.month) BEGIN SELECT RAISE(ABORT,'closed finance period'); END;

CREATE TRIGGER maintenance_quality_delivery_evidence_insert BEFORE INSERT ON quality_delivery_evidence WHEN EXISTS(SELECT 1 FROM system_maintenance WHERE id='global' AND mode<>'normal' AND expires_at>strftime('%Y-%m-%dT%H:%M:%fZ','now')) BEGIN SELECT RAISE(ABORT,'guard_maintenance'); END;

CREATE TRIGGER maintenance_quality_delivery_evidence_update BEFORE UPDATE ON quality_delivery_evidence WHEN EXISTS(SELECT 1 FROM system_maintenance WHERE id='global' AND mode<>'normal' AND expires_at>strftime('%Y-%m-%dT%H:%M:%fZ','now')) BEGIN SELECT RAISE(ABORT,'guard_maintenance'); END;

CREATE TRIGGER maintenance_quality_delivery_evidence_delete BEFORE DELETE ON quality_delivery_evidence WHEN EXISTS(SELECT 1 FROM system_maintenance WHERE id='global' AND mode<>'normal' AND expires_at>strftime('%Y-%m-%dT%H:%M:%fZ','now')) BEGIN SELECT RAISE(ABORT,'guard_maintenance'); END;
CREATE TRIGGER immutable_quality_delivery_evidence_update BEFORE UPDATE ON quality_delivery_evidence BEGIN SELECT RAISE(ABORT,'immutable history'); END;
CREATE TRIGGER immutable_quality_delivery_evidence_delete BEFORE DELETE ON quality_delivery_evidence BEGIN SELECT RAISE(ABORT,'immutable history'); END;

CREATE TRIGGER evidence_clock_transport_shelf_confirmations_insert AFTER INSERT ON transport_shelf_confirmations BEGIN INSERT INTO business_action_source_clock VALUES('global',1) ON CONFLICT(id) DO UPDATE SET version=version+1; END;

CREATE TRIGGER evidence_clock_transport_shelf_confirmations_update AFTER UPDATE ON transport_shelf_confirmations BEGIN INSERT INTO business_action_source_clock VALUES('global',1) ON CONFLICT(id) DO UPDATE SET version=version+1; END;

CREATE TRIGGER evidence_clock_transport_shelf_confirmations_delete AFTER DELETE ON transport_shelf_confirmations BEGIN INSERT INTO business_action_source_clock VALUES('global',1) ON CONFLICT(id) DO UPDATE SET version=version+1; END;

CREATE TRIGGER evidence_clock_business_partners_insert AFTER INSERT ON business_partners BEGIN INSERT INTO finance_clock VALUES('global',1) ON CONFLICT(id) DO UPDATE SET version=version+1; END;

CREATE TRIGGER evidence_clock_business_partners_update AFTER UPDATE ON business_partners BEGIN INSERT INTO finance_clock VALUES('global',1) ON CONFLICT(id) DO UPDATE SET version=version+1; END;

CREATE TRIGGER evidence_clock_business_partners_delete AFTER DELETE ON business_partners BEGIN INSERT INTO finance_clock VALUES('global',1) ON CONFLICT(id) DO UPDATE SET version=version+1; END;

CREATE TRIGGER evidence_clock_quality_factory_aliases_insert AFTER INSERT ON quality_factory_aliases BEGIN INSERT INTO finance_clock VALUES('global',1) ON CONFLICT(id) DO UPDATE SET version=version+1; END;

CREATE TRIGGER evidence_clock_quality_factory_aliases_update AFTER UPDATE ON quality_factory_aliases BEGIN INSERT INTO finance_clock VALUES('global',1) ON CONFLICT(id) DO UPDATE SET version=version+1; END;

CREATE TRIGGER evidence_clock_quality_factory_aliases_delete AFTER DELETE ON quality_factory_aliases BEGIN INSERT INTO finance_clock VALUES('global',1) ON CONFLICT(id) DO UPDATE SET version=version+1; END;
