-- Keep legacy data intact. New overlapping summaries must use atomic correction.
CREATE INDEX idx_sales_record_day_sku ON sales_records(site,channel,business_date,sku,reversed_at);
--> statement-breakpoint
CREATE TRIGGER sales_summary_overlap_insert BEFORE INSERT ON sales_records
WHEN NEW.qty>0 AND NEW.reversed_at IS NULL AND EXISTS(
 SELECT 1 FROM sales_records r WHERE r.site=NEW.site AND r.channel=NEW.channel
 AND r.business_date=NEW.business_date AND r.sku=NEW.sku AND r.qty>0
 AND r.reversed_at IS NULL AND r.import_id<>NEW.import_id
)
BEGIN SELECT RAISE(ABORT,'sales_summary_overlap'); END;
--> statement-breakpoint
CREATE TRIGGER sales_summary_overlap_update BEFORE UPDATE OF site,channel,business_date,sku,qty,reversed_at,import_id ON sales_records
WHEN NEW.qty>0 AND NEW.reversed_at IS NULL AND EXISTS(
 SELECT 1 FROM sales_records r WHERE r.id<>NEW.id AND r.site=NEW.site AND r.channel=NEW.channel
 AND r.business_date=NEW.business_date AND r.sku=NEW.sku AND r.qty>0
 AND r.reversed_at IS NULL AND r.import_id<>NEW.import_id
)
BEGIN SELECT RAISE(ABORT,'sales_summary_overlap'); END;
--> statement-breakpoint
-- Immutable daily revisions; period snapshots remain as historical evidence only.
CREATE TABLE business_action_finance_days (
 id TEXT PRIMARY KEY NOT NULL, site TEXT NOT NULL, channel TEXT NOT NULL, sku TEXT NOT NULL,
 business_date TEXT NOT NULL, revision INTEGER NOT NULL CHECK(revision>0),
 currency TEXT NOT NULL, basis_hash TEXT NOT NULL, basis_json TEXT NOT NULL,
 data_json TEXT NOT NULL, source TEXT NOT NULL, note TEXT NOT NULL,
 actor_id TEXT NOT NULL, created_at TEXT NOT NULL,
 UNIQUE(site,channel,sku,business_date,revision)
);
--> statement-breakpoint
CREATE TRIGGER maintenance_action_finance_days_insert BEFORE INSERT ON business_action_finance_days
WHEN EXISTS(SELECT 1 FROM system_maintenance WHERE id='global' AND mode<>'normal' AND expires_at>strftime('%Y-%m-%dT%H:%M:%fZ','now'))
BEGIN SELECT RAISE(ABORT,'guard_maintenance'); END;
--> statement-breakpoint
CREATE TRIGGER immutable_action_finance_days_update BEFORE UPDATE ON business_action_finance_days
BEGIN SELECT RAISE(ABORT,'immutable daily finance revision'); END;
--> statement-breakpoint
CREATE TRIGGER immutable_action_finance_days_delete BEFORE DELETE ON business_action_finance_days
BEGIN SELECT RAISE(ABORT,'immutable daily finance revision'); END;
--> statement-breakpoint
CREATE TRIGGER action_clock_finance_days_insert AFTER INSERT ON business_action_finance_days
BEGIN INSERT INTO business_action_source_clock VALUES('global',1) ON CONFLICT(id) DO UPDATE SET version=version+1; END;
