-- Customer bank receipts are cash facts; allocations only settle order balances.
CREATE TABLE domestic_bank_receipts (
 id TEXT PRIMARY KEY, customer_id TEXT NOT NULL REFERENCES domestic_customers(id),
 amount_minor INTEGER NOT NULL CHECK(amount_minor>0 AND amount_minor<=1000000000000),
 business_date TEXT NOT NULL, bank_reference TEXT NOT NULL UNIQUE, bank_account TEXT NOT NULL,
 proof_id TEXT NOT NULL REFERENCES domestic_files(id), reason TEXT NOT NULL,
 actor_id TEXT NOT NULL REFERENCES users(id), created_at TEXT NOT NULL, version INTEGER NOT NULL DEFAULT 1
);
ALTER TABLE domestic_finance_entries ADD COLUMN bank_receipt_id TEXT REFERENCES domestic_bank_receipts(id);
CREATE INDEX domestic_finance_bank ON domestic_finance_entries(bank_receipt_id,business_date);
CREATE TABLE domestic_bank_events (
 id TEXT PRIMARY KEY, receipt_id TEXT NOT NULL REFERENCES domestic_bank_receipts(id),
 kind TEXT NOT NULL CHECK(kind IN('refund','refund_reverse','void')),
 amount_minor INTEGER NOT NULL CHECK(amount_minor>0), business_date TEXT NOT NULL,
 reference TEXT NOT NULL UNIQUE, related_id TEXT UNIQUE REFERENCES domestic_bank_events(id),
 proof_id TEXT NOT NULL REFERENCES domestic_files(id), reason TEXT NOT NULL,
 actor_id TEXT NOT NULL REFERENCES users(id), created_at TEXT NOT NULL
);
CREATE TABLE domestic_bank_proof_links (
 id TEXT PRIMARY KEY, submission_id TEXT NOT NULL UNIQUE REFERENCES domestic_payment_submissions(id),
 receipt_id TEXT NOT NULL REFERENCES domestic_bank_receipts(id), reason TEXT NOT NULL,
 actor_id TEXT NOT NULL REFERENCES users(id), created_at TEXT NOT NULL
);
CREATE TABLE domestic_customer_versions (
 id TEXT PRIMARY KEY, customer_id TEXT NOT NULL REFERENCES domestic_customers(id), version INTEGER NOT NULL,
 snapshot_json TEXT NOT NULL, reason TEXT NOT NULL, actor_id TEXT NOT NULL REFERENCES users(id), created_at TEXT NOT NULL
);
CREATE TABLE domestic_cancel_requests (
 id TEXT PRIMARY KEY, order_id TEXT NOT NULL REFERENCES domestic_orders(id), reason TEXT NOT NULL,
 status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN('pending','approved','rejected')),
 actor_id TEXT NOT NULL REFERENCES users(id), created_at TEXT NOT NULL,
 reviewer_id TEXT REFERENCES users(id), review_reason TEXT, reviewed_at TEXT
);
CREATE UNIQUE INDEX domestic_cancel_pending ON domestic_cancel_requests(order_id) WHERE status='pending';
CREATE TABLE domestic_collection_notes (
 id TEXT PRIMARY KEY, order_id TEXT NOT NULL REFERENCES domestic_orders(id), note TEXT NOT NULL,
 next_date TEXT NOT NULL, actor_id TEXT NOT NULL REFERENCES users(id), created_at TEXT NOT NULL
);
CREATE TRIGGER domestic_bank_link_guard BEFORE INSERT ON domestic_bank_proof_links BEGIN
 SELECT CASE WHEN NOT EXISTS(SELECT 1 FROM users WHERE id=NEW.actor_id AND active=1 AND role='财务')
 OR EXISTS(SELECT 1 FROM domestic_payment_submissions WHERE id=NEW.submission_id AND actor_id=NEW.actor_id)
 OR EXISTS(SELECT 1 FROM domestic_payment_reviews WHERE submission_id=NEW.submission_id)
 OR NOT EXISTS(SELECT 1 FROM domestic_payment_submissions s JOIN domestic_orders o ON o.id=s.order_id JOIN domestic_bank_receipts b ON b.customer_id=o.customer_id WHERE s.id=NEW.submission_id AND b.id=NEW.receipt_id)
 THEN RAISE(ABORT,'guard_bank_proof_link') END;
END;
CREATE TRIGGER domestic_legacy_review_link_guard BEFORE INSERT ON domestic_payment_reviews WHEN EXISTS(SELECT 1 FROM domestic_bank_proof_links WHERE submission_id=NEW.submission_id) BEGIN SELECT RAISE(ABORT,'guard_bank_proof_reviewed'); END;
CREATE TRIGGER domestic_bank_reference_unique BEFORE INSERT ON domestic_bank_receipts WHEN EXISTS(SELECT 1 FROM domestic_finance_entries WHERE bank_reference=NEW.bank_reference) BEGIN SELECT RAISE(ABORT,'guard_bank_reference_used'); END;
CREATE TRIGGER domestic_legacy_reference_unique BEFORE INSERT ON domestic_finance_entries WHEN NEW.bank_receipt_id IS NULL AND EXISTS(SELECT 1 FROM domestic_bank_receipts WHERE bank_reference=NEW.bank_reference) BEGIN SELECT RAISE(ABORT,'guard_bank_reference_used'); END;
CREATE TRIGGER maintenance_domestic_bank_receipts_insert BEFORE INSERT ON domestic_bank_receipts WHEN EXISTS(SELECT 1 FROM system_maintenance WHERE id='global' AND mode<>'normal' AND expires_at>strftime('%Y-%m-%dT%H:%M:%fZ','now')) BEGIN SELECT RAISE(ABORT,'guard_maintenance'); END;
CREATE TRIGGER maintenance_domestic_bank_receipts_update BEFORE UPDATE ON domestic_bank_receipts WHEN EXISTS(SELECT 1 FROM system_maintenance WHERE id='global' AND mode<>'normal' AND expires_at>strftime('%Y-%m-%dT%H:%M:%fZ','now')) BEGIN SELECT RAISE(ABORT,'guard_maintenance'); END;
CREATE TRIGGER maintenance_domestic_bank_receipts_delete BEFORE DELETE ON domestic_bank_receipts WHEN EXISTS(SELECT 1 FROM system_maintenance WHERE id='global' AND mode<>'normal' AND expires_at>strftime('%Y-%m-%dT%H:%M:%fZ','now')) BEGIN SELECT RAISE(ABORT,'guard_maintenance'); END;
CREATE TRIGGER clock_domestic_bank_receipts_insert AFTER INSERT ON domestic_bank_receipts BEGIN INSERT INTO finance_clock VALUES('global',1) ON CONFLICT(id) DO UPDATE SET version=version+1; END;
CREATE TRIGGER clock_domestic_bank_receipts_update AFTER UPDATE ON domestic_bank_receipts BEGIN INSERT INTO finance_clock VALUES('global',1) ON CONFLICT(id) DO UPDATE SET version=version+1; END;
CREATE TRIGGER clock_domestic_bank_receipts_delete AFTER DELETE ON domestic_bank_receipts BEGIN INSERT INTO finance_clock VALUES('global',1) ON CONFLICT(id) DO UPDATE SET version=version+1; END;
CREATE TRIGGER maintenance_domestic_bank_events_insert BEFORE INSERT ON domestic_bank_events WHEN EXISTS(SELECT 1 FROM system_maintenance WHERE id='global' AND mode<>'normal' AND expires_at>strftime('%Y-%m-%dT%H:%M:%fZ','now')) BEGIN SELECT RAISE(ABORT,'guard_maintenance'); END;
CREATE TRIGGER maintenance_domestic_bank_events_update BEFORE UPDATE ON domestic_bank_events WHEN EXISTS(SELECT 1 FROM system_maintenance WHERE id='global' AND mode<>'normal' AND expires_at>strftime('%Y-%m-%dT%H:%M:%fZ','now')) BEGIN SELECT RAISE(ABORT,'guard_maintenance'); END;
CREATE TRIGGER maintenance_domestic_bank_events_delete BEFORE DELETE ON domestic_bank_events WHEN EXISTS(SELECT 1 FROM system_maintenance WHERE id='global' AND mode<>'normal' AND expires_at>strftime('%Y-%m-%dT%H:%M:%fZ','now')) BEGIN SELECT RAISE(ABORT,'guard_maintenance'); END;
CREATE TRIGGER immutable_domestic_bank_events_update BEFORE UPDATE ON domestic_bank_events BEGIN SELECT RAISE(ABORT,'immutable_domestic_fact'); END;
CREATE TRIGGER immutable_domestic_bank_events_delete BEFORE DELETE ON domestic_bank_events BEGIN SELECT RAISE(ABORT,'immutable_domestic_fact'); END;
CREATE TRIGGER clock_domestic_bank_events_insert AFTER INSERT ON domestic_bank_events BEGIN INSERT INTO finance_clock VALUES('global',1) ON CONFLICT(id) DO UPDATE SET version=version+1; END;
CREATE TRIGGER clock_domestic_bank_events_update AFTER UPDATE ON domestic_bank_events BEGIN INSERT INTO finance_clock VALUES('global',1) ON CONFLICT(id) DO UPDATE SET version=version+1; END;
CREATE TRIGGER clock_domestic_bank_events_delete AFTER DELETE ON domestic_bank_events BEGIN INSERT INTO finance_clock VALUES('global',1) ON CONFLICT(id) DO UPDATE SET version=version+1; END;
CREATE TRIGGER maintenance_domestic_bank_proof_links_insert BEFORE INSERT ON domestic_bank_proof_links WHEN EXISTS(SELECT 1 FROM system_maintenance WHERE id='global' AND mode<>'normal' AND expires_at>strftime('%Y-%m-%dT%H:%M:%fZ','now')) BEGIN SELECT RAISE(ABORT,'guard_maintenance'); END;
CREATE TRIGGER maintenance_domestic_bank_proof_links_update BEFORE UPDATE ON domestic_bank_proof_links WHEN EXISTS(SELECT 1 FROM system_maintenance WHERE id='global' AND mode<>'normal' AND expires_at>strftime('%Y-%m-%dT%H:%M:%fZ','now')) BEGIN SELECT RAISE(ABORT,'guard_maintenance'); END;
CREATE TRIGGER maintenance_domestic_bank_proof_links_delete BEFORE DELETE ON domestic_bank_proof_links WHEN EXISTS(SELECT 1 FROM system_maintenance WHERE id='global' AND mode<>'normal' AND expires_at>strftime('%Y-%m-%dT%H:%M:%fZ','now')) BEGIN SELECT RAISE(ABORT,'guard_maintenance'); END;
CREATE TRIGGER immutable_domestic_bank_proof_links_update BEFORE UPDATE ON domestic_bank_proof_links BEGIN SELECT RAISE(ABORT,'immutable_domestic_fact'); END;
CREATE TRIGGER immutable_domestic_bank_proof_links_delete BEFORE DELETE ON domestic_bank_proof_links BEGIN SELECT RAISE(ABORT,'immutable_domestic_fact'); END;
CREATE TRIGGER clock_domestic_bank_proof_links_insert AFTER INSERT ON domestic_bank_proof_links BEGIN INSERT INTO finance_clock VALUES('global',1) ON CONFLICT(id) DO UPDATE SET version=version+1; END;
CREATE TRIGGER clock_domestic_bank_proof_links_update AFTER UPDATE ON domestic_bank_proof_links BEGIN INSERT INTO finance_clock VALUES('global',1) ON CONFLICT(id) DO UPDATE SET version=version+1; END;
CREATE TRIGGER clock_domestic_bank_proof_links_delete AFTER DELETE ON domestic_bank_proof_links BEGIN INSERT INTO finance_clock VALUES('global',1) ON CONFLICT(id) DO UPDATE SET version=version+1; END;
CREATE TRIGGER maintenance_domestic_customer_versions_insert BEFORE INSERT ON domestic_customer_versions WHEN EXISTS(SELECT 1 FROM system_maintenance WHERE id='global' AND mode<>'normal' AND expires_at>strftime('%Y-%m-%dT%H:%M:%fZ','now')) BEGIN SELECT RAISE(ABORT,'guard_maintenance'); END;
CREATE TRIGGER maintenance_domestic_customer_versions_update BEFORE UPDATE ON domestic_customer_versions WHEN EXISTS(SELECT 1 FROM system_maintenance WHERE id='global' AND mode<>'normal' AND expires_at>strftime('%Y-%m-%dT%H:%M:%fZ','now')) BEGIN SELECT RAISE(ABORT,'guard_maintenance'); END;
CREATE TRIGGER maintenance_domestic_customer_versions_delete BEFORE DELETE ON domestic_customer_versions WHEN EXISTS(SELECT 1 FROM system_maintenance WHERE id='global' AND mode<>'normal' AND expires_at>strftime('%Y-%m-%dT%H:%M:%fZ','now')) BEGIN SELECT RAISE(ABORT,'guard_maintenance'); END;
CREATE TRIGGER immutable_domestic_customer_versions_update BEFORE UPDATE ON domestic_customer_versions BEGIN SELECT RAISE(ABORT,'immutable_domestic_fact'); END;
CREATE TRIGGER immutable_domestic_customer_versions_delete BEFORE DELETE ON domestic_customer_versions BEGIN SELECT RAISE(ABORT,'immutable_domestic_fact'); END;
CREATE TRIGGER clock_domestic_customer_versions_insert AFTER INSERT ON domestic_customer_versions BEGIN INSERT INTO finance_clock VALUES('global',1) ON CONFLICT(id) DO UPDATE SET version=version+1; END;
CREATE TRIGGER clock_domestic_customer_versions_update AFTER UPDATE ON domestic_customer_versions BEGIN INSERT INTO finance_clock VALUES('global',1) ON CONFLICT(id) DO UPDATE SET version=version+1; END;
CREATE TRIGGER clock_domestic_customer_versions_delete AFTER DELETE ON domestic_customer_versions BEGIN INSERT INTO finance_clock VALUES('global',1) ON CONFLICT(id) DO UPDATE SET version=version+1; END;
CREATE TRIGGER maintenance_domestic_cancel_requests_insert BEFORE INSERT ON domestic_cancel_requests WHEN EXISTS(SELECT 1 FROM system_maintenance WHERE id='global' AND mode<>'normal' AND expires_at>strftime('%Y-%m-%dT%H:%M:%fZ','now')) BEGIN SELECT RAISE(ABORT,'guard_maintenance'); END;
CREATE TRIGGER maintenance_domestic_cancel_requests_update BEFORE UPDATE ON domestic_cancel_requests WHEN EXISTS(SELECT 1 FROM system_maintenance WHERE id='global' AND mode<>'normal' AND expires_at>strftime('%Y-%m-%dT%H:%M:%fZ','now')) BEGIN SELECT RAISE(ABORT,'guard_maintenance'); END;
CREATE TRIGGER maintenance_domestic_cancel_requests_delete BEFORE DELETE ON domestic_cancel_requests WHEN EXISTS(SELECT 1 FROM system_maintenance WHERE id='global' AND mode<>'normal' AND expires_at>strftime('%Y-%m-%dT%H:%M:%fZ','now')) BEGIN SELECT RAISE(ABORT,'guard_maintenance'); END;
CREATE TRIGGER clock_domestic_cancel_requests_insert AFTER INSERT ON domestic_cancel_requests BEGIN INSERT INTO finance_clock VALUES('global',1) ON CONFLICT(id) DO UPDATE SET version=version+1; END;
CREATE TRIGGER clock_domestic_cancel_requests_update AFTER UPDATE ON domestic_cancel_requests BEGIN INSERT INTO finance_clock VALUES('global',1) ON CONFLICT(id) DO UPDATE SET version=version+1; END;
CREATE TRIGGER clock_domestic_cancel_requests_delete AFTER DELETE ON domestic_cancel_requests BEGIN INSERT INTO finance_clock VALUES('global',1) ON CONFLICT(id) DO UPDATE SET version=version+1; END;
CREATE TRIGGER maintenance_domestic_collection_notes_insert BEFORE INSERT ON domestic_collection_notes WHEN EXISTS(SELECT 1 FROM system_maintenance WHERE id='global' AND mode<>'normal' AND expires_at>strftime('%Y-%m-%dT%H:%M:%fZ','now')) BEGIN SELECT RAISE(ABORT,'guard_maintenance'); END;
CREATE TRIGGER maintenance_domestic_collection_notes_update BEFORE UPDATE ON domestic_collection_notes WHEN EXISTS(SELECT 1 FROM system_maintenance WHERE id='global' AND mode<>'normal' AND expires_at>strftime('%Y-%m-%dT%H:%M:%fZ','now')) BEGIN SELECT RAISE(ABORT,'guard_maintenance'); END;
CREATE TRIGGER maintenance_domestic_collection_notes_delete BEFORE DELETE ON domestic_collection_notes WHEN EXISTS(SELECT 1 FROM system_maintenance WHERE id='global' AND mode<>'normal' AND expires_at>strftime('%Y-%m-%dT%H:%M:%fZ','now')) BEGIN SELECT RAISE(ABORT,'guard_maintenance'); END;
CREATE TRIGGER immutable_domestic_collection_notes_update BEFORE UPDATE ON domestic_collection_notes BEGIN SELECT RAISE(ABORT,'immutable_domestic_fact'); END;
CREATE TRIGGER immutable_domestic_collection_notes_delete BEFORE DELETE ON domestic_collection_notes BEGIN SELECT RAISE(ABORT,'immutable_domestic_fact'); END;
CREATE TRIGGER clock_domestic_collection_notes_insert AFTER INSERT ON domestic_collection_notes BEGIN INSERT INTO finance_clock VALUES('global',1) ON CONFLICT(id) DO UPDATE SET version=version+1; END;
CREATE TRIGGER clock_domestic_collection_notes_update AFTER UPDATE ON domestic_collection_notes BEGIN INSERT INTO finance_clock VALUES('global',1) ON CONFLICT(id) DO UPDATE SET version=version+1; END;
CREATE TRIGGER clock_domestic_collection_notes_delete AFTER DELETE ON domestic_collection_notes BEGIN INSERT INTO finance_clock VALUES('global',1) ON CONFLICT(id) DO UPDATE SET version=version+1; END;
CREATE TRIGGER period_domestic_bank_receipts_insert BEFORE INSERT ON domestic_bank_receipts WHEN EXISTS(SELECT 1 FROM finance_period_events p WHERE p.revision=(SELECT MAX(x.revision) FROM finance_period_events x WHERE x.month=p.month) AND p.status='closed' AND substr(NEW.business_date,1,7)<=p.month) BEGIN SELECT RAISE(ABORT,'closed finance period'); END;
CREATE TRIGGER period_domestic_bank_events_insert BEFORE INSERT ON domestic_bank_events WHEN EXISTS(SELECT 1 FROM finance_period_events p WHERE p.revision=(SELECT MAX(x.revision) FROM finance_period_events x WHERE x.month=p.month) AND p.status='closed' AND substr(NEW.business_date,1,7)<=p.month) BEGIN SELECT RAISE(ABORT,'closed finance period'); END;
CREATE TRIGGER immutable_domestic_bank_receipt_fields BEFORE UPDATE ON domestic_bank_receipts WHEN NEW.id<>OLD.id OR NEW.customer_id<>OLD.customer_id OR NEW.amount_minor<>OLD.amount_minor OR NEW.business_date<>OLD.business_date OR NEW.bank_reference<>OLD.bank_reference OR NEW.bank_account<>OLD.bank_account OR NEW.proof_id<>OLD.proof_id OR NEW.reason<>OLD.reason OR NEW.actor_id<>OLD.actor_id OR NEW.created_at<>OLD.created_at BEGIN SELECT RAISE(ABORT,'immutable_domestic_fact'); END;
CREATE TRIGGER immutable_domestic_bank_receipt_delete BEFORE DELETE ON domestic_bank_receipts BEGIN SELECT RAISE(ABORT,'immutable_domestic_fact'); END;
