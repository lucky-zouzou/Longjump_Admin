CREATE TABLE `after_sales` (
	`id` text PRIMARY KEY NOT NULL,
	`owner_id` text NOT NULL,
	`owner_name` text NOT NULL,
	`site` text NOT NULL,
	`channel` text NOT NULL,
	`business_date` text NOT NULL,
	`case_no` text NOT NULL,
	`sku` text NOT NULL,
	`status` text DEFAULT 'draft' NOT NULL,
	`version` integer DEFAULT 1 NOT NULL,
	`data_json` text DEFAULT '{}' NOT NULL,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `idx_after_sales_case` ON `after_sales` (`site`,`channel`,`case_no`,`sku`);--> statement-breakpoint
CREATE INDEX `idx_after_sales_month` ON `after_sales` (`business_date`,`status`);--> statement-breakpoint
CREATE TABLE `after_sales_files` (
	`id` text PRIMARY KEY NOT NULL,
	`record_id` text NOT NULL,
	`object_key` text NOT NULL,
	`name` text NOT NULL,
	`content_type` text NOT NULL,
	`size` integer NOT NULL,
	`sha256` text NOT NULL,
	`actor_id` text NOT NULL,
	`created_at` text NOT NULL,
	FOREIGN KEY (`record_id`) REFERENCES `after_sales`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `idx_after_sales_file_hash` ON `after_sales_files` (`record_id`,`sha256`);
--> statement-breakpoint
CREATE TRIGGER maintenance_after_sales_insert BEFORE INSERT ON after_sales
WHEN EXISTS(SELECT 1 FROM system_maintenance WHERE id='global' AND mode<>'normal' AND expires_at>strftime('%Y-%m-%dT%H:%M:%fZ','now'))
BEGIN SELECT RAISE(ABORT,'guard_maintenance: system backup or migration is in progress'); END;

--> statement-breakpoint
CREATE TRIGGER maintenance_after_sales_update BEFORE UPDATE ON after_sales
WHEN EXISTS(SELECT 1 FROM system_maintenance WHERE id='global' AND mode<>'normal' AND expires_at>strftime('%Y-%m-%dT%H:%M:%fZ','now'))
BEGIN SELECT RAISE(ABORT,'guard_maintenance: system backup or migration is in progress'); END;

--> statement-breakpoint
CREATE TRIGGER maintenance_after_sales_delete BEFORE DELETE ON after_sales
WHEN EXISTS(SELECT 1 FROM system_maintenance WHERE id='global' AND mode<>'normal' AND expires_at>strftime('%Y-%m-%dT%H:%M:%fZ','now'))
BEGIN SELECT RAISE(ABORT,'guard_maintenance: system backup or migration is in progress'); END;

--> statement-breakpoint
CREATE TRIGGER maintenance_after_sales_files_insert BEFORE INSERT ON after_sales_files
WHEN EXISTS(SELECT 1 FROM system_maintenance WHERE id='global' AND mode<>'normal' AND expires_at>strftime('%Y-%m-%dT%H:%M:%fZ','now'))
BEGIN SELECT RAISE(ABORT,'guard_maintenance: system backup or migration is in progress'); END;

--> statement-breakpoint
CREATE TRIGGER maintenance_after_sales_files_update BEFORE UPDATE ON after_sales_files
WHEN EXISTS(SELECT 1 FROM system_maintenance WHERE id='global' AND mode<>'normal' AND expires_at>strftime('%Y-%m-%dT%H:%M:%fZ','now'))
BEGIN SELECT RAISE(ABORT,'guard_maintenance: system backup or migration is in progress'); END;

--> statement-breakpoint
CREATE TRIGGER maintenance_after_sales_files_delete BEFORE DELETE ON after_sales_files
WHEN EXISTS(SELECT 1 FROM system_maintenance WHERE id='global' AND mode<>'normal' AND expires_at>strftime('%Y-%m-%dT%H:%M:%fZ','now'))
BEGIN SELECT RAISE(ABORT,'guard_maintenance: system backup or migration is in progress'); END;
