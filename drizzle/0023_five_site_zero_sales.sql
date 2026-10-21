-- Expand observations prospectively; retain all historical observations and applications.
DROP TRIGGER promotion_stock_insert;
--> statement-breakpoint
DROP TRIGGER promotion_stock_update;
--> statement-breakpoint
CREATE TRIGGER promotion_stock_insert AFTER INSERT ON inventory_balances
WHEN NEW.site IN ('马来西亚','印尼','泰国','越南','菲律宾') AND NEW.channel IN ('TikTok','Shopee') BEGIN
 INSERT INTO promotion_stock_days(site,channel,sku,day,min_available,first_at,last_at)
 VALUES(NEW.site,NEW.channel,NEW.sku,date('now',CASE WHEN NEW.site IN ('马来西亚','菲律宾') THEN '+8 hours' ELSE '+7 hours' END),NEW.qty-NEW.reserved_qty,strftime('%Y-%m-%dT%H:%M:%fZ','now'),strftime('%Y-%m-%dT%H:%M:%fZ','now'))
 ON CONFLICT(site,channel,sku,day) DO UPDATE SET min_available=MIN(min_available,excluded.min_available),last_at=excluded.last_at;
END;
--> statement-breakpoint
CREATE TRIGGER promotion_stock_update AFTER UPDATE ON inventory_balances
WHEN NEW.site IN ('马来西亚','印尼','泰国','越南','菲律宾') AND NEW.channel IN ('TikTok','Shopee') BEGIN
 INSERT INTO promotion_stock_days(site,channel,sku,day,min_available,first_at,last_at)
 VALUES(NEW.site,NEW.channel,NEW.sku,date('now',CASE WHEN NEW.site IN ('马来西亚','菲律宾') THEN '+8 hours' ELSE '+7 hours' END),MIN(OLD.qty-OLD.reserved_qty,NEW.qty-NEW.reserved_qty),strftime('%Y-%m-%dT%H:%M:%fZ','now'),strftime('%Y-%m-%dT%H:%M:%fZ','now'))
 ON CONFLICT(site,channel,sku,day) DO UPDATE SET min_available=MIN(min_available,excluded.min_available),last_at=excluded.last_at;
END;
