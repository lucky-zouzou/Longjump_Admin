CREATE TABLE promotion_availability(site TEXT NOT NULL,channel TEXT NOT NULL,sku TEXT NOT NULL,listed_since TEXT NOT NULL,available_since TEXT NOT NULL,verified_through TEXT NOT NULL,reference TEXT NOT NULL,note TEXT NOT NULL,actor_id TEXT NOT NULL,updated_at TEXT NOT NULL,PRIMARY KEY(site,channel,sku));
--> statement-breakpoint
CREATE TABLE promotion_stock_days(site TEXT NOT NULL,channel TEXT NOT NULL,sku TEXT NOT NULL,day TEXT NOT NULL,min_available INTEGER NOT NULL,first_at TEXT NOT NULL,last_at TEXT NOT NULL,PRIMARY KEY(site,channel,sku,day));
--> statement-breakpoint
CREATE TABLE zero_sales_alerts(id TEXT PRIMARY KEY NOT NULL,site TEXT NOT NULL,channel TEXT NOT NULL,sku TEXT NOT NULL,status TEXT NOT NULL,data_json TEXT NOT NULL,opened_at TEXT NOT NULL,updated_at TEXT NOT NULL);
--> statement-breakpoint
CREATE UNIQUE INDEX idx_zero_sales_scope ON zero_sales_alerts(site,channel,sku);
--> statement-breakpoint
CREATE TABLE promotions(id TEXT PRIMARY KEY NOT NULL,site TEXT NOT NULL,channel TEXT NOT NULL,sku TEXT NOT NULL,owner_id TEXT NOT NULL,owner_name TEXT NOT NULL,status TEXT NOT NULL DEFAULT 'draft',version INTEGER NOT NULL DEFAULT 1,revision INTEGER NOT NULL DEFAULT 1,data_json TEXT NOT NULL,created_at TEXT NOT NULL,updated_at TEXT NOT NULL);
--> statement-breakpoint
CREATE INDEX idx_promotions_scope ON promotions(site,channel,sku,status);
--> statement-breakpoint
CREATE TABLE promotion_files(id TEXT PRIMARY KEY NOT NULL,record_id TEXT NOT NULL REFERENCES promotions(id),revision INTEGER NOT NULL,purpose TEXT NOT NULL,object_key TEXT NOT NULL,name TEXT NOT NULL,content_type TEXT NOT NULL,size INTEGER NOT NULL,sha256 TEXT NOT NULL,actor_id TEXT NOT NULL,created_at TEXT NOT NULL);
--> statement-breakpoint
CREATE UNIQUE INDEX idx_promotion_file_hash ON promotion_files(record_id,revision,purpose,sha256);

--> statement-breakpoint
CREATE TRIGGER maintenance_promotion_availability_insert BEFORE INSERT ON promotion_availability
WHEN EXISTS(SELECT 1 FROM system_maintenance WHERE id='global' AND mode<>'normal' AND expires_at>strftime('%Y-%m-%dT%H:%M:%fZ','now'))
BEGIN SELECT RAISE(ABORT,'guard_maintenance'); END;

--> statement-breakpoint
CREATE TRIGGER maintenance_promotion_availability_update BEFORE UPDATE ON promotion_availability
WHEN EXISTS(SELECT 1 FROM system_maintenance WHERE id='global' AND mode<>'normal' AND expires_at>strftime('%Y-%m-%dT%H:%M:%fZ','now'))
BEGIN SELECT RAISE(ABORT,'guard_maintenance'); END;

--> statement-breakpoint
CREATE TRIGGER maintenance_promotion_availability_delete BEFORE DELETE ON promotion_availability
WHEN EXISTS(SELECT 1 FROM system_maintenance WHERE id='global' AND mode<>'normal' AND expires_at>strftime('%Y-%m-%dT%H:%M:%fZ','now'))
BEGIN SELECT RAISE(ABORT,'guard_maintenance'); END;

--> statement-breakpoint
CREATE TRIGGER maintenance_promotion_stock_days_insert BEFORE INSERT ON promotion_stock_days
WHEN EXISTS(SELECT 1 FROM system_maintenance WHERE id='global' AND mode<>'normal' AND expires_at>strftime('%Y-%m-%dT%H:%M:%fZ','now'))
BEGIN SELECT RAISE(ABORT,'guard_maintenance'); END;

--> statement-breakpoint
CREATE TRIGGER maintenance_promotion_stock_days_update BEFORE UPDATE ON promotion_stock_days
WHEN EXISTS(SELECT 1 FROM system_maintenance WHERE id='global' AND mode<>'normal' AND expires_at>strftime('%Y-%m-%dT%H:%M:%fZ','now'))
BEGIN SELECT RAISE(ABORT,'guard_maintenance'); END;

--> statement-breakpoint
CREATE TRIGGER maintenance_promotion_stock_days_delete BEFORE DELETE ON promotion_stock_days
WHEN EXISTS(SELECT 1 FROM system_maintenance WHERE id='global' AND mode<>'normal' AND expires_at>strftime('%Y-%m-%dT%H:%M:%fZ','now'))
BEGIN SELECT RAISE(ABORT,'guard_maintenance'); END;

--> statement-breakpoint
CREATE TRIGGER maintenance_zero_sales_alerts_insert BEFORE INSERT ON zero_sales_alerts
WHEN EXISTS(SELECT 1 FROM system_maintenance WHERE id='global' AND mode<>'normal' AND expires_at>strftime('%Y-%m-%dT%H:%M:%fZ','now'))
BEGIN SELECT RAISE(ABORT,'guard_maintenance'); END;

--> statement-breakpoint
CREATE TRIGGER maintenance_zero_sales_alerts_update BEFORE UPDATE ON zero_sales_alerts
WHEN EXISTS(SELECT 1 FROM system_maintenance WHERE id='global' AND mode<>'normal' AND expires_at>strftime('%Y-%m-%dT%H:%M:%fZ','now'))
BEGIN SELECT RAISE(ABORT,'guard_maintenance'); END;

--> statement-breakpoint
CREATE TRIGGER maintenance_zero_sales_alerts_delete BEFORE DELETE ON zero_sales_alerts
WHEN EXISTS(SELECT 1 FROM system_maintenance WHERE id='global' AND mode<>'normal' AND expires_at>strftime('%Y-%m-%dT%H:%M:%fZ','now'))
BEGIN SELECT RAISE(ABORT,'guard_maintenance'); END;

--> statement-breakpoint
CREATE TRIGGER maintenance_promotions_insert BEFORE INSERT ON promotions
WHEN EXISTS(SELECT 1 FROM system_maintenance WHERE id='global' AND mode<>'normal' AND expires_at>strftime('%Y-%m-%dT%H:%M:%fZ','now'))
BEGIN SELECT RAISE(ABORT,'guard_maintenance'); END;

--> statement-breakpoint
CREATE TRIGGER maintenance_promotions_update BEFORE UPDATE ON promotions
WHEN EXISTS(SELECT 1 FROM system_maintenance WHERE id='global' AND mode<>'normal' AND expires_at>strftime('%Y-%m-%dT%H:%M:%fZ','now'))
BEGIN SELECT RAISE(ABORT,'guard_maintenance'); END;

--> statement-breakpoint
CREATE TRIGGER maintenance_promotions_delete BEFORE DELETE ON promotions
WHEN EXISTS(SELECT 1 FROM system_maintenance WHERE id='global' AND mode<>'normal' AND expires_at>strftime('%Y-%m-%dT%H:%M:%fZ','now'))
BEGIN SELECT RAISE(ABORT,'guard_maintenance'); END;

--> statement-breakpoint
CREATE TRIGGER maintenance_promotion_files_insert BEFORE INSERT ON promotion_files
WHEN EXISTS(SELECT 1 FROM system_maintenance WHERE id='global' AND mode<>'normal' AND expires_at>strftime('%Y-%m-%dT%H:%M:%fZ','now'))
BEGIN SELECT RAISE(ABORT,'guard_maintenance'); END;

--> statement-breakpoint
CREATE TRIGGER maintenance_promotion_files_update BEFORE UPDATE ON promotion_files
WHEN EXISTS(SELECT 1 FROM system_maintenance WHERE id='global' AND mode<>'normal' AND expires_at>strftime('%Y-%m-%dT%H:%M:%fZ','now'))
BEGIN SELECT RAISE(ABORT,'guard_maintenance'); END;

--> statement-breakpoint
CREATE TRIGGER maintenance_promotion_files_delete BEFORE DELETE ON promotion_files
WHEN EXISTS(SELECT 1 FROM system_maintenance WHERE id='global' AND mode<>'normal' AND expires_at>strftime('%Y-%m-%dT%H:%M:%fZ','now'))
BEGIN SELECT RAISE(ABORT,'guard_maintenance'); END;

--> statement-breakpoint
CREATE TRIGGER promotion_stock_insert AFTER INSERT ON inventory_balances WHEN NEW.site='印尼' AND NEW.channel IN ('TikTok','Shopee') BEGIN
 INSERT INTO promotion_stock_days(site,channel,sku,day,min_available,first_at,last_at) VALUES(NEW.site,NEW.channel,NEW.sku,date('now','+7 hours'),NEW.qty-NEW.reserved_qty,strftime('%Y-%m-%dT%H:%M:%fZ','now'),strftime('%Y-%m-%dT%H:%M:%fZ','now')) ON CONFLICT(site,channel,sku,day) DO UPDATE SET min_available=MIN(min_available,excluded.min_available),last_at=excluded.last_at;
END;

--> statement-breakpoint
CREATE TRIGGER promotion_stock_update AFTER UPDATE ON inventory_balances WHEN NEW.site='印尼' AND NEW.channel IN ('TikTok','Shopee') BEGIN
 INSERT INTO promotion_stock_days(site,channel,sku,day,min_available,first_at,last_at) VALUES(NEW.site,NEW.channel,NEW.sku,date('now','+7 hours'),MIN(OLD.qty-OLD.reserved_qty,NEW.qty-NEW.reserved_qty),strftime('%Y-%m-%dT%H:%M:%fZ','now'),strftime('%Y-%m-%dT%H:%M:%fZ','now')) ON CONFLICT(site,channel,sku,day) DO UPDATE SET min_available=MIN(min_available,excluded.min_available),last_at=excluded.last_at;
END;
