-- Financial records are append-only; business data is not backfilled by migration.
CREATE TABLE finance_documents (
 id TEXT PRIMARY KEY NOT NULL, kind TEXT NOT NULL CHECK(kind IN ('supplier_bill','supplier_payment','supplier_allocation','platform_settlement','platform_receipt','platform_allocation','inventory_valuation')),
 business_key TEXT NOT NULL, revision INTEGER NOT NULL CHECK(revision>0), business_date TEXT NOT NULL,
 counterparty TEXT NOT NULL, site TEXT NOT NULL DEFAULT '', channel TEXT NOT NULL DEFAULT '', currency TEXT NOT NULL,
 amount_minor INTEGER NOT NULL CHECK(amount_minor>=0), status TEXT NOT NULL CHECK(status IN ('active','void')),
 data_json TEXT NOT NULL, evidence TEXT NOT NULL, reason TEXT NOT NULL, actor_id TEXT NOT NULL REFERENCES users(id), created_at TEXT NOT NULL,
 UNIQUE(kind,business_key,revision)
);
CREATE INDEX finance_document_scope ON finance_documents(kind,business_date,site,channel);
CREATE TABLE finance_rates (
 id TEXT PRIMARY KEY NOT NULL, month TEXT NOT NULL, currency TEXT NOT NULL, revision INTEGER NOT NULL,
 rate REAL NOT NULL CHECK(rate>0), evidence TEXT NOT NULL, actor_id TEXT NOT NULL, created_at TEXT NOT NULL,
 UNIQUE(month,currency,revision)
);
CREATE TABLE finance_period_events (
 id TEXT PRIMARY KEY NOT NULL, month TEXT NOT NULL, revision INTEGER NOT NULL,
 status TEXT NOT NULL CHECK(status IN ('closed','open')), snapshot_json TEXT NOT NULL,
 evidence TEXT NOT NULL, actor_id TEXT NOT NULL, created_at TEXT NOT NULL, UNIQUE(month,revision)
);
CREATE TABLE finance_clock(id TEXT PRIMARY KEY NOT NULL, version INTEGER NOT NULL);
ALTER TABLE wholesale_prices ADD cost_basis_json TEXT NOT NULL DEFAULT '{}';
CREATE TRIGGER immutable_finance_documents_update BEFORE UPDATE ON finance_documents BEGIN SELECT RAISE(ABORT,'immutable finance history'); END;
CREATE TRIGGER immutable_finance_documents_delete BEFORE DELETE ON finance_documents BEGIN SELECT RAISE(ABORT,'immutable finance history'); END;
CREATE TRIGGER maintenance_finance_documents_insert BEFORE INSERT ON finance_documents WHEN EXISTS(SELECT 1 FROM system_maintenance WHERE id='global' AND mode<>'normal' AND expires_at>strftime('%Y-%m-%dT%H:%M:%fZ','now')) BEGIN SELECT RAISE(ABORT,'guard_maintenance'); END;
CREATE TRIGGER clock_finance_documents_insert AFTER INSERT ON finance_documents BEGIN INSERT INTO finance_clock VALUES('global',1) ON CONFLICT(id) DO UPDATE SET version=version+1; END;
CREATE TRIGGER immutable_finance_rates_update BEFORE UPDATE ON finance_rates BEGIN SELECT RAISE(ABORT,'immutable finance history'); END;
CREATE TRIGGER immutable_finance_rates_delete BEFORE DELETE ON finance_rates BEGIN SELECT RAISE(ABORT,'immutable finance history'); END;
CREATE TRIGGER maintenance_finance_rates_insert BEFORE INSERT ON finance_rates WHEN EXISTS(SELECT 1 FROM system_maintenance WHERE id='global' AND mode<>'normal' AND expires_at>strftime('%Y-%m-%dT%H:%M:%fZ','now')) BEGIN SELECT RAISE(ABORT,'guard_maintenance'); END;
CREATE TRIGGER clock_finance_rates_insert AFTER INSERT ON finance_rates BEGIN INSERT INTO finance_clock VALUES('global',1) ON CONFLICT(id) DO UPDATE SET version=version+1; END;
CREATE TRIGGER immutable_finance_period_events_update BEFORE UPDATE ON finance_period_events BEGIN SELECT RAISE(ABORT,'immutable finance history'); END;
CREATE TRIGGER immutable_finance_period_events_delete BEFORE DELETE ON finance_period_events BEGIN SELECT RAISE(ABORT,'immutable finance history'); END;
CREATE TRIGGER maintenance_finance_period_events_insert BEFORE INSERT ON finance_period_events WHEN EXISTS(SELECT 1 FROM system_maintenance WHERE id='global' AND mode<>'normal' AND expires_at>strftime('%Y-%m-%dT%H:%M:%fZ','now')) BEGIN SELECT RAISE(ABORT,'guard_maintenance'); END;
CREATE TRIGGER clock_finance_period_events_insert AFTER INSERT ON finance_period_events BEGIN INSERT INTO finance_clock VALUES('global',1) ON CONFLICT(id) DO UPDATE SET version=version+1; END;
CREATE TRIGGER action_clock_cost_records_insert AFTER INSERT ON cost_records BEGIN INSERT INTO business_action_source_clock VALUES('global',1) ON CONFLICT(id) DO UPDATE SET version=version+1; END;
CREATE TRIGGER action_clock_cost_reviews_insert AFTER INSERT ON cost_reviews BEGIN INSERT INTO business_action_source_clock VALUES('global',1) ON CONFLICT(id) DO UPDATE SET version=version+1; END;
CREATE TRIGGER action_clock_product_cost_versions_insert AFTER INSERT ON product_cost_versions BEGIN INSERT INTO business_action_source_clock VALUES('global',1) ON CONFLICT(id) DO UPDATE SET version=version+1; END;

CREATE TRIGGER action_clock_finance_rates_insert AFTER INSERT ON finance_rates BEGIN INSERT INTO business_action_source_clock VALUES('global',1) ON CONFLICT(id) DO UPDATE SET version=version+1; END;

CREATE TRIGGER finance_closed_sales_records_insert BEFORE INSERT ON sales_records WHEN EXISTS(SELECT 1 FROM finance_period_events p WHERE p.status='closed' AND p.revision=(SELECT MAX(x.revision) FROM finance_period_events x WHERE x.month=p.month) AND (substr(NEW.business_date,1,7)<=p.month)) BEGIN SELECT RAISE(ABORT,'closed finance period: reopen before corrections'); END;

CREATE TRIGGER finance_closed_sales_records_update BEFORE UPDATE ON sales_records WHEN EXISTS(SELECT 1 FROM finance_period_events p WHERE p.status='closed' AND p.revision=(SELECT MAX(x.revision) FROM finance_period_events x WHERE x.month=p.month) AND (substr(NEW.business_date,1,7)<=p.month OR substr(OLD.business_date,1,7)<=p.month)) BEGIN SELECT RAISE(ABORT,'closed finance period: reopen before corrections'); END;

CREATE TRIGGER finance_closed_sales_records_delete BEFORE DELETE ON sales_records WHEN EXISTS(SELECT 1 FROM finance_period_events p WHERE p.status='closed' AND p.revision=(SELECT MAX(x.revision) FROM finance_period_events x WHERE x.month=p.month) AND (substr(OLD.business_date,1,7)<=p.month)) BEGIN SELECT RAISE(ABORT,'closed finance period: reopen before corrections'); END;

CREATE TRIGGER finance_closed_sales_imports_insert BEFORE INSERT ON sales_imports WHEN EXISTS(SELECT 1 FROM finance_period_events p WHERE p.status='closed' AND p.revision=(SELECT MAX(x.revision) FROM finance_period_events x WHERE x.month=p.month) AND (substr(NEW.business_date,1,7)<=p.month)) BEGIN SELECT RAISE(ABORT,'closed finance period: reopen before corrections'); END;

CREATE TRIGGER finance_closed_sales_imports_update BEFORE UPDATE ON sales_imports WHEN EXISTS(SELECT 1 FROM finance_period_events p WHERE p.status='closed' AND p.revision=(SELECT MAX(x.revision) FROM finance_period_events x WHERE x.month=p.month) AND (substr(NEW.business_date,1,7)<=p.month OR substr(OLD.business_date,1,7)<=p.month)) BEGIN SELECT RAISE(ABORT,'closed finance period: reopen before corrections'); END;

CREATE TRIGGER finance_closed_sales_imports_delete BEFORE DELETE ON sales_imports WHEN EXISTS(SELECT 1 FROM finance_period_events p WHERE p.status='closed' AND p.revision=(SELECT MAX(x.revision) FROM finance_period_events x WHERE x.month=p.month) AND (substr(OLD.business_date,1,7)<=p.month)) BEGIN SELECT RAISE(ABORT,'closed finance period: reopen before corrections'); END;

CREATE TRIGGER finance_closed_sales_ad_spend_insert BEFORE INSERT ON sales_ad_spend WHEN EXISTS(SELECT 1 FROM finance_period_events p WHERE p.status='closed' AND p.revision=(SELECT MAX(x.revision) FROM finance_period_events x WHERE x.month=p.month) AND (substr(NEW.business_date,1,7)<=p.month)) BEGIN SELECT RAISE(ABORT,'closed finance period: reopen before corrections'); END;

CREATE TRIGGER finance_closed_sales_ad_spend_update BEFORE UPDATE ON sales_ad_spend WHEN EXISTS(SELECT 1 FROM finance_period_events p WHERE p.status='closed' AND p.revision=(SELECT MAX(x.revision) FROM finance_period_events x WHERE x.month=p.month) AND (substr(NEW.business_date,1,7)<=p.month OR substr(OLD.business_date,1,7)<=p.month)) BEGIN SELECT RAISE(ABORT,'closed finance period: reopen before corrections'); END;

CREATE TRIGGER finance_closed_sales_ad_spend_delete BEFORE DELETE ON sales_ad_spend WHEN EXISTS(SELECT 1 FROM finance_period_events p WHERE p.status='closed' AND p.revision=(SELECT MAX(x.revision) FROM finance_period_events x WHERE x.month=p.month) AND (substr(OLD.business_date,1,7)<=p.month)) BEGIN SELECT RAISE(ABORT,'closed finance period: reopen before corrections'); END;

CREATE TRIGGER finance_closed_wholesale_orders_insert BEFORE INSERT ON wholesale_orders WHEN EXISTS(SELECT 1 FROM finance_period_events p WHERE p.status='closed' AND p.revision=(SELECT MAX(x.revision) FROM finance_period_events x WHERE x.month=p.month) AND (substr(NEW.business_date,1,7)<=p.month)) BEGIN SELECT RAISE(ABORT,'closed finance period: reopen before corrections'); END;

CREATE TRIGGER finance_closed_wholesale_shipments_insert BEFORE INSERT ON wholesale_shipments WHEN EXISTS(SELECT 1 FROM finance_period_events p WHERE p.status='closed' AND p.revision=(SELECT MAX(x.revision) FROM finance_period_events x WHERE x.month=p.month) AND (substr(NEW.business_date,1,7)<=p.month)) BEGIN SELECT RAISE(ABORT,'closed finance period: reopen before corrections'); END;

CREATE TRIGGER finance_closed_wholesale_returns_insert BEFORE INSERT ON wholesale_returns WHEN EXISTS(SELECT 1 FROM finance_period_events p WHERE p.status='closed' AND p.revision=(SELECT MAX(x.revision) FROM finance_period_events x WHERE x.month=p.month) AND (substr(NEW.business_date,1,7)<=p.month)) BEGIN SELECT RAISE(ABORT,'closed finance period: reopen before corrections'); END;

CREATE TRIGGER finance_closed_wholesale_finance_entries_insert BEFORE INSERT ON wholesale_finance_entries WHEN EXISTS(SELECT 1 FROM finance_period_events p WHERE p.status='closed' AND p.revision=(SELECT MAX(x.revision) FROM finance_period_events x WHERE x.month=p.month) AND (substr(NEW.business_date,1,7)<=p.month)) BEGIN SELECT RAISE(ABORT,'closed finance period: reopen before corrections'); END;

CREATE TRIGGER finance_closed_wholesale_consignment_sales_insert BEFORE INSERT ON wholesale_consignment_sales WHEN EXISTS(SELECT 1 FROM finance_period_events p WHERE p.status='closed' AND p.revision=(SELECT MAX(x.revision) FROM finance_period_events x WHERE x.month=p.month) AND (substr(NEW.business_date,1,7)<=p.month)) BEGIN SELECT RAISE(ABORT,'closed finance period: reopen before corrections'); END;

CREATE TRIGGER finance_closed_wholesale_bank_receipts_insert BEFORE INSERT ON wholesale_bank_receipts WHEN EXISTS(SELECT 1 FROM finance_period_events p WHERE p.status='closed' AND p.revision=(SELECT MAX(x.revision) FROM finance_period_events x WHERE x.month=p.month) AND (substr(NEW.business_date,1,7)<=p.month)) BEGIN SELECT RAISE(ABORT,'closed finance period: reopen before corrections'); END;

CREATE TRIGGER finance_closed_wholesale_bank_events_insert BEFORE INSERT ON wholesale_bank_events WHEN EXISTS(SELECT 1 FROM finance_period_events p WHERE p.status='closed' AND p.revision=(SELECT MAX(x.revision) FROM finance_period_events x WHERE x.month=p.month) AND (substr(NEW.business_date,1,7)<=p.month)) BEGIN SELECT RAISE(ABORT,'closed finance period: reopen before corrections'); END;

CREATE TRIGGER finance_closed_business_action_finance_days_insert BEFORE INSERT ON business_action_finance_days WHEN EXISTS(SELECT 1 FROM finance_period_events p WHERE p.status='closed' AND p.revision=(SELECT MAX(x.revision) FROM finance_period_events x WHERE x.month=p.month) AND (substr(NEW.business_date,1,7)<=p.month)) BEGIN SELECT RAISE(ABORT,'closed finance period: reopen before corrections'); END;

CREATE TRIGGER finance_closed_finance_documents_insert BEFORE INSERT ON finance_documents WHEN EXISTS(SELECT 1 FROM finance_period_events p WHERE p.status='closed' AND p.revision=(SELECT MAX(x.revision) FROM finance_period_events x WHERE x.month=p.month) AND (substr(NEW.business_date,1,7)<=p.month)) BEGIN SELECT RAISE(ABORT,'closed finance period: reopen before corrections'); END;
