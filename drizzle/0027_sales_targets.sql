CREATE TABLE sales_monthly_targets (
 id TEXT PRIMARY KEY NOT NULL,
 month TEXT NOT NULL, site TEXT NOT NULL, channel TEXT NOT NULL CHECK(channel IN ('TikTok','Shopee')),
 owner_id TEXT NOT NULL REFERENCES users(id), owner_name TEXT NOT NULL,
 revenue_cny REAL NOT NULL CHECK(revenue_cny>=0), quantity INTEGER NOT NULL CHECK(quantity>=0),
 budget_cny REAL NOT NULL CHECK(budget_cny>=0), note TEXT NOT NULL,
 version INTEGER NOT NULL DEFAULT 1, created_by TEXT NOT NULL, created_at TEXT NOT NULL,
 updated_by TEXT NOT NULL, updated_at TEXT NOT NULL,
 UNIQUE(month,site,channel)
);
--> statement-breakpoint
CREATE TABLE sales_target_events (
 id TEXT PRIMARY KEY NOT NULL, target_id TEXT NOT NULL REFERENCES sales_monthly_targets(id),
 actor_id TEXT NOT NULL, actor_name TEXT NOT NULL, before_json TEXT, after_json TEXT NOT NULL,
 reason TEXT NOT NULL, created_at TEXT NOT NULL
);
--> statement-breakpoint
CREATE INDEX idx_sales_target_events ON sales_target_events(target_id,created_at);
--> statement-breakpoint
CREATE TRIGGER maintenance_sales_targets_insert BEFORE INSERT ON sales_monthly_targets
WHEN EXISTS(SELECT 1 FROM system_maintenance WHERE id='global' AND mode<>'normal' AND expires_at>strftime('%Y-%m-%dT%H:%M:%fZ','now'))
BEGIN SELECT RAISE(ABORT,'guard_maintenance'); END;
--> statement-breakpoint
CREATE TRIGGER maintenance_sales_targets_update BEFORE UPDATE ON sales_monthly_targets
WHEN EXISTS(SELECT 1 FROM system_maintenance WHERE id='global' AND mode<>'normal' AND expires_at>strftime('%Y-%m-%dT%H:%M:%fZ','now'))
BEGIN SELECT RAISE(ABORT,'guard_maintenance'); END;
--> statement-breakpoint
CREATE TRIGGER maintenance_sales_targets_delete BEFORE DELETE ON sales_monthly_targets
WHEN EXISTS(SELECT 1 FROM system_maintenance WHERE id='global' AND mode<>'normal' AND expires_at>strftime('%Y-%m-%dT%H:%M:%fZ','now'))
BEGIN SELECT RAISE(ABORT,'guard_maintenance'); END;
--> statement-breakpoint
CREATE TRIGGER maintenance_sales_target_events_insert BEFORE INSERT ON sales_target_events
WHEN EXISTS(SELECT 1 FROM system_maintenance WHERE id='global' AND mode<>'normal' AND expires_at>strftime('%Y-%m-%dT%H:%M:%fZ','now'))
BEGIN SELECT RAISE(ABORT,'guard_maintenance'); END;
