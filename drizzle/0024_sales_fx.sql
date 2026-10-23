CREATE TABLE sales_fx_snapshots (
 id TEXT PRIMARY KEY NOT NULL,
 provider TEXT NOT NULL,
 effective_at TEXT NOT NULL,
 fetched_at TEXT NOT NULL,
 next_update_at TEXT NOT NULL,
 rates_json TEXT NOT NULL
);
--> statement-breakpoint
CREATE INDEX idx_sales_fx_effective ON sales_fx_snapshots(effective_at);
--> statement-breakpoint
CREATE TRIGGER maintenance_sales_fx_insert BEFORE INSERT ON sales_fx_snapshots
WHEN EXISTS(SELECT 1 FROM system_maintenance WHERE id='global' AND mode<>'normal' AND expires_at>strftime('%Y-%m-%dT%H:%M:%fZ','now'))
BEGIN SELECT RAISE(ABORT,'guard_maintenance'); END;
--> statement-breakpoint
CREATE TRIGGER maintenance_sales_fx_update BEFORE UPDATE ON sales_fx_snapshots
WHEN EXISTS(SELECT 1 FROM system_maintenance WHERE id='global' AND mode<>'normal' AND expires_at>strftime('%Y-%m-%dT%H:%M:%fZ','now'))
BEGIN SELECT RAISE(ABORT,'guard_maintenance'); END;
--> statement-breakpoint
CREATE TRIGGER maintenance_sales_fx_delete BEFORE DELETE ON sales_fx_snapshots
WHEN EXISTS(SELECT 1 FROM system_maintenance WHERE id='global' AND mode<>'normal' AND expires_at>strftime('%Y-%m-%dT%H:%M:%fZ','now'))
BEGIN SELECT RAISE(ABORT,'guard_maintenance'); END;
