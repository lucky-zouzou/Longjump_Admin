CREATE TABLE `new_product_projects` (
	`id` text PRIMARY KEY NOT NULL,
	`cycle_month` text NOT NULL,
	`sku` text NOT NULL,
	`name` text DEFAULT '' NOT NULL,
	`first_batch_qty` integer DEFAULT 3000 NOT NULL,
	`stage` text DEFAULT 'selection' NOT NULL,
	`status` text DEFAULT 'active' NOT NULL,
	`stage_started_at` text NOT NULL,
	`current_due_at` text NOT NULL,
	`production_batch_id` text,
	`abandon_reason` text DEFAULT '' NOT NULL,
	`decision_history_json` text DEFAULT '[]' NOT NULL,
	`created_by` text NOT NULL,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `idx_new_product_month_sku` ON `new_product_projects` (`cycle_month`,`sku`);--> statement-breakpoint
CREATE INDEX `idx_new_product_status_due` ON `new_product_projects` (`status`,`current_due_at`);--> statement-breakpoint
CREATE TABLE `new_product_stage_records` (
	`id` text PRIMARY KEY NOT NULL,
	`project_id` text NOT NULL,
	`stage_key` text NOT NULL,
	`scope_key` text DEFAULT 'global' NOT NULL,
	`site` text,
	`channel` text,
	`status` text DEFAULT 'submitted' NOT NULL,
	`data_json` text NOT NULL,
	`conclusion` text DEFAULT '' NOT NULL,
	`actor_id` text NOT NULL,
	`actor_name` text NOT NULL,
	`submitted_at` text NOT NULL,
	`updated_at` text NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `idx_new_product_record_scope` ON `new_product_stage_records` (`project_id`,`stage_key`,`scope_key`);--> statement-breakpoint
CREATE INDEX `idx_new_product_record_project` ON `new_product_stage_records` (`project_id`,`stage_key`);