CREATE TABLE `sales_ad_spend` (
	`id` text PRIMARY KEY NOT NULL,
	`site` text NOT NULL,
	`channel` text NOT NULL,
	`business_date` text NOT NULL,
	`currency` text NOT NULL,
	`amount` real NOT NULL,
	`note` text NOT NULL,
	`version` integer DEFAULT 1 NOT NULL,
	`actor_id` text NOT NULL,
	`updated_at` text NOT NULL,
	`deleted_at` text
);
--> statement-breakpoint
CREATE UNIQUE INDEX `idx_sales_ad_scope_date` ON `sales_ad_spend` (`site`,`channel`,`business_date`,`currency`);
--> statement-breakpoint
CREATE TRIGGER maintenance_sales_ad_spend_insert BEFORE INSERT ON sales_ad_spend
WHEN EXISTS(SELECT 1 FROM system_maintenance WHERE id='global' AND mode<>'normal' AND expires_at>strftime('%Y-%m-%dT%H:%M:%fZ','now'))
BEGIN SELECT RAISE(ABORT,'guard_maintenance: system backup or migration is in progress'); END;

--> statement-breakpoint
CREATE TRIGGER maintenance_sales_ad_spend_update BEFORE UPDATE ON sales_ad_spend
WHEN EXISTS(SELECT 1 FROM system_maintenance WHERE id='global' AND mode<>'normal' AND expires_at>strftime('%Y-%m-%dT%H:%M:%fZ','now'))
BEGIN SELECT RAISE(ABORT,'guard_maintenance: system backup or migration is in progress'); END;

--> statement-breakpoint
CREATE TRIGGER maintenance_sales_ad_spend_delete BEFORE DELETE ON sales_ad_spend
WHEN EXISTS(SELECT 1 FROM system_maintenance WHERE id='global' AND mode<>'normal' AND expires_at>strftime('%Y-%m-%dT%H:%M:%fZ','now'))
BEGIN SELECT RAISE(ABORT,'guard_maintenance: system backup or migration is in progress'); END;
