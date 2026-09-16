CREATE TABLE `approval_requests` (
	`id` text PRIMARY KEY NOT NULL,
	`type` text NOT NULL,
	`month` text,
	`status` text NOT NULL,
	`stage` text NOT NULL,
	`creator_id` text NOT NULL,
	`creator_role` text NOT NULL,
	`payload_json` text NOT NULL,
	`decision_comment` text DEFAULT '' NOT NULL,
	`approved_by` text,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL
);
--> statement-breakpoint
CREATE INDEX `idx_approval_status` ON `approval_requests` (`status`,`created_at`);--> statement-breakpoint
CREATE UNIQUE INDEX `idx_approval_month_type` ON `approval_requests` (`type`,`month`);--> statement-breakpoint
CREATE TABLE `audit_logs` (
	`id` text PRIMARY KEY NOT NULL,
	`action` text NOT NULL,
	`entity_type` text NOT NULL,
	`entity_id` text NOT NULL,
	`detail_json` text NOT NULL,
	`actor_id` text NOT NULL,
	`actor_name` text NOT NULL,
	`created_at` text NOT NULL
);
--> statement-breakpoint
CREATE INDEX `idx_audit_time` ON `audit_logs` (`created_at`);--> statement-breakpoint
CREATE INDEX `idx_audit_entity` ON `audit_logs` (`entity_type`,`entity_id`);--> statement-breakpoint
CREATE TABLE `inbound_allocations` (
	`receipt_id` text NOT NULL,
	`site` text NOT NULL,
	`channel` text NOT NULL,
	`qty` integer NOT NULL,
	PRIMARY KEY(`receipt_id`, `site`, `channel`)
);
--> statement-breakpoint
CREATE TABLE `inbound_receipts` (
	`id` text PRIMARY KEY NOT NULL,
	`receipt_no` text NOT NULL,
	`sku` text NOT NULL,
	`name` text DEFAULT '' NOT NULL,
	`source_batch` text DEFAULT '' NOT NULL,
	`proof_ref` text NOT NULL,
	`total_qty` integer NOT NULL,
	`actor_id` text NOT NULL,
	`received_at` text NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `idx_receipt_no` ON `inbound_receipts` (`receipt_no`);--> statement-breakpoint
CREATE TABLE `inventory_balances` (
	`site` text NOT NULL,
	`channel` text NOT NULL,
	`sku` text NOT NULL,
	`name` text DEFAULT '' NOT NULL,
	`qty` integer DEFAULT 0 NOT NULL,
	`updated_at` text NOT NULL,
	PRIMARY KEY(`site`, `channel`, `sku`)
);
--> statement-breakpoint
CREATE INDEX `idx_inventory_scope` ON `inventory_balances` (`site`,`channel`);--> statement-breakpoint
CREATE TABLE `inventory_movements` (
	`id` text PRIMARY KEY NOT NULL,
	`site` text NOT NULL,
	`channel` text NOT NULL,
	`sku` text NOT NULL,
	`name` text DEFAULT '' NOT NULL,
	`movement_type` text NOT NULL,
	`qty_delta` integer NOT NULL,
	`balance_after` integer NOT NULL,
	`reference_type` text NOT NULL,
	`reference_id` text NOT NULL,
	`note` text DEFAULT '' NOT NULL,
	`actor_id` text NOT NULL,
	`created_at` text NOT NULL
);
--> statement-breakpoint
CREATE INDEX `idx_movements_scope_time` ON `inventory_movements` (`site`,`channel`,`created_at`);--> statement-breakpoint
CREATE INDEX `idx_movements_sku` ON `inventory_movements` (`sku`);--> statement-breakpoint
CREATE TABLE `monthly_submissions` (
	`id` text PRIMARY KEY NOT NULL,
	`month` text NOT NULL,
	`site` text NOT NULL,
	`channel` text NOT NULL,
	`items_json` text NOT NULL,
	`total_qty` integer NOT NULL,
	`actor_id` text NOT NULL,
	`submitted_at` text NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `idx_monthly_submission_unique` ON `monthly_submissions` (`month`,`site`,`channel`);--> statement-breakpoint
CREATE INDEX `idx_monthly_month` ON `monthly_submissions` (`month`);--> statement-breakpoint
CREATE TABLE `production_batches` (
	`id` text PRIMARY KEY NOT NULL,
	`month` text NOT NULL,
	`sku` text NOT NULL,
	`name` text DEFAULT '' NOT NULL,
	`qty` integer NOT NULL,
	`stage` text NOT NULL,
	`stage_owner` text NOT NULL,
	`allocations_json` text NOT NULL,
	`evidence_json` text DEFAULT '[]' NOT NULL,
	`creator_id` text NOT NULL,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL
);
--> statement-breakpoint
CREATE INDEX `idx_batches_stage` ON `production_batches` (`stage`,`updated_at`);--> statement-breakpoint
CREATE INDEX `idx_batches_sku` ON `production_batches` (`sku`);--> statement-breakpoint
CREATE TABLE `sales_imports` (
	`id` text PRIMARY KEY NOT NULL,
	`import_key` text NOT NULL,
	`business_date` text NOT NULL,
	`site` text NOT NULL,
	`channel` text NOT NULL,
	`file_name` text DEFAULT '' NOT NULL,
	`row_count` integer NOT NULL,
	`total_qty` integer NOT NULL,
	`actor_id` text NOT NULL,
	`created_at` text NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `idx_sales_import_key` ON `sales_imports` (`import_key`);--> statement-breakpoint
CREATE INDEX `idx_sales_import_scope_date` ON `sales_imports` (`site`,`channel`,`business_date`);--> statement-breakpoint
CREATE TABLE `sales_records` (
	`id` text PRIMARY KEY NOT NULL,
	`import_id` text NOT NULL,
	`business_date` text NOT NULL,
	`site` text NOT NULL,
	`channel` text NOT NULL,
	`sku` text NOT NULL,
	`qty` integer NOT NULL,
	`unit_price` real DEFAULT 0 NOT NULL,
	`amount` real DEFAULT 0 NOT NULL,
	`source_ref` text DEFAULT '' NOT NULL,
	`actor_id` text NOT NULL,
	`created_at` text NOT NULL
);
--> statement-breakpoint
CREATE INDEX `idx_sales_scope_date` ON `sales_records` (`site`,`channel`,`business_date`);--> statement-breakpoint
CREATE INDEX `idx_sales_sku_date` ON `sales_records` (`sku`,`business_date`);--> statement-breakpoint
CREATE TABLE `sku_settings` (
	`sku` text PRIMARY KEY NOT NULL,
	`name` text DEFAULT '' NOT NULL,
	`product_type` text DEFAULT '老款' NOT NULL,
	`unit_price` real DEFAULT 0 NOT NULL,
	`lead_time_days` integer DEFAULT 63 NOT NULL,
	`safety_pct` real DEFAULT 0.25 NOT NULL,
	`updated_at` text NOT NULL
);
--> statement-breakpoint
CREATE TABLE `users` (
	`id` text PRIMARY KEY NOT NULL,
	`email` text NOT NULL,
	`name` text NOT NULL,
	`role` text NOT NULL,
	`site` text,
	`channel` text,
	`active` integer DEFAULT 1 NOT NULL,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `idx_users_email` ON `users` (`email`);