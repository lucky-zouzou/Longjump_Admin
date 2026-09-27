CREATE TABLE `field_files` (
	`id` text PRIMARY KEY NOT NULL,
	`record_id` text NOT NULL,
	`object_key` text NOT NULL,
	`name` text NOT NULL,
	`content_type` text NOT NULL,
	`size` integer NOT NULL,
	`sha256` text NOT NULL,
	`actor_id` text NOT NULL,
	`created_at` text NOT NULL,
	FOREIGN KEY (`record_id`) REFERENCES `field_records`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `idx_field_files_record` ON `field_files` (`record_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `idx_field_file_hash_record` ON `field_files` (`record_id`,`sha256`);--> statement-breakpoint
CREATE TABLE `field_records` (
	`id` text PRIMARY KEY NOT NULL,
	`kind` text NOT NULL,
	`sales_user_id` text NOT NULL,
	`customer_id` text,
	`business_date` text NOT NULL,
	`end_date` text NOT NULL,
	`status` text DEFAULT 'draft' NOT NULL,
	`version` integer DEFAULT 1 NOT NULL,
	`data_json` text NOT NULL,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	`submitted_at` text,
	FOREIGN KEY (`customer_id`) REFERENCES `wholesale_customers`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `idx_field_owner_month` ON `field_records` (`sales_user_id`,`business_date`);--> statement-breakpoint
CREATE INDEX `idx_field_customer` ON `field_records` (`customer_id`,`kind`);
--> statement-breakpoint
CREATE TRIGGER maintenance_field_records_insert BEFORE INSERT ON field_records
WHEN EXISTS(SELECT 1 FROM system_maintenance WHERE id='global' AND mode<>'normal' AND expires_at>strftime('%Y-%m-%dT%H:%M:%fZ','now'))
BEGIN SELECT RAISE(ABORT,'guard_maintenance: system backup or migration is in progress'); END;

--> statement-breakpoint
CREATE TRIGGER maintenance_field_records_update BEFORE UPDATE ON field_records
WHEN EXISTS(SELECT 1 FROM system_maintenance WHERE id='global' AND mode<>'normal' AND expires_at>strftime('%Y-%m-%dT%H:%M:%fZ','now'))
BEGIN SELECT RAISE(ABORT,'guard_maintenance: system backup or migration is in progress'); END;

--> statement-breakpoint
CREATE TRIGGER maintenance_field_records_delete BEFORE DELETE ON field_records
WHEN EXISTS(SELECT 1 FROM system_maintenance WHERE id='global' AND mode<>'normal' AND expires_at>strftime('%Y-%m-%dT%H:%M:%fZ','now'))
BEGIN SELECT RAISE(ABORT,'guard_maintenance: system backup or migration is in progress'); END;

--> statement-breakpoint
CREATE TRIGGER maintenance_field_files_insert BEFORE INSERT ON field_files
WHEN EXISTS(SELECT 1 FROM system_maintenance WHERE id='global' AND mode<>'normal' AND expires_at>strftime('%Y-%m-%dT%H:%M:%fZ','now'))
BEGIN SELECT RAISE(ABORT,'guard_maintenance: system backup or migration is in progress'); END;

--> statement-breakpoint
CREATE TRIGGER maintenance_field_files_update BEFORE UPDATE ON field_files
WHEN EXISTS(SELECT 1 FROM system_maintenance WHERE id='global' AND mode<>'normal' AND expires_at>strftime('%Y-%m-%dT%H:%M:%fZ','now'))
BEGIN SELECT RAISE(ABORT,'guard_maintenance: system backup or migration is in progress'); END;

--> statement-breakpoint
CREATE TRIGGER maintenance_field_files_delete BEFORE DELETE ON field_files
WHEN EXISTS(SELECT 1 FROM system_maintenance WHERE id='global' AND mode<>'normal' AND expires_at>strftime('%Y-%m-%dT%H:%M:%fZ','now'))
BEGIN SELECT RAISE(ABORT,'guard_maintenance: system backup or migration is in progress'); END;
