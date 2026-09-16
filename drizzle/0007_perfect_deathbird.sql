CREATE TABLE `wholesale_bank_events` (
	`id` text PRIMARY KEY NOT NULL,
	`receipt_id` text NOT NULL,
	`kind` text NOT NULL,
	`amount` integer NOT NULL,
	`business_date` text NOT NULL,
	`reference` text NOT NULL,
	`note` text NOT NULL,
	`actor_id` text NOT NULL,
	`created_at` text NOT NULL,
	CONSTRAINT "bank_event_amount" CHECK("wholesale_bank_events"."amount">0)
);
--> statement-breakpoint
CREATE UNIQUE INDEX `idx_bank_event_reference` ON `wholesale_bank_events` (`kind`,`reference`);--> statement-breakpoint
CREATE INDEX `idx_bank_event_receipt` ON `wholesale_bank_events` (`receipt_id`);--> statement-breakpoint
CREATE TABLE `wholesale_bank_receipts` (
	`id` text PRIMARY KEY NOT NULL,
	`customer_id` text NOT NULL,
	`reference` text NOT NULL,
	`bank_account` text DEFAULT '' NOT NULL,
	`business_date` text NOT NULL,
	`amount` integer NOT NULL,
	`allocated_amount` integer DEFAULT 0 NOT NULL,
	`refunded_amount` integer DEFAULT 0 NOT NULL,
	`voided_amount` integer DEFAULT 0 NOT NULL,
	`version` integer DEFAULT 1 NOT NULL,
	`note` text NOT NULL,
	`actor_id` text NOT NULL,
	`created_at` text NOT NULL,
	CONSTRAINT "bank_receipt_balance" CHECK("wholesale_bank_receipts"."amount">0 AND "wholesale_bank_receipts"."allocated_amount">=0 AND "wholesale_bank_receipts"."refunded_amount">=0 AND "wholesale_bank_receipts"."voided_amount">=0 AND "wholesale_bank_receipts"."allocated_amount"+"wholesale_bank_receipts"."refunded_amount"+"wholesale_bank_receipts"."voided_amount"<="wholesale_bank_receipts"."amount")
);
--> statement-breakpoint
CREATE UNIQUE INDEX `idx_bank_receipt_reference` ON `wholesale_bank_receipts` (`reference`);--> statement-breakpoint
CREATE INDEX `idx_bank_receipt_customer` ON `wholesale_bank_receipts` (`customer_id`);--> statement-breakpoint
CREATE TABLE `wholesale_finance_periods` (
	`month` text PRIMARY KEY NOT NULL,
	`status` text NOT NULL,
	`version` integer DEFAULT 1 NOT NULL,
	`snapshot_json` text NOT NULL,
	`note` text NOT NULL,
	`actor_id` text NOT NULL,
	`updated_at` text NOT NULL
);
--> statement-breakpoint
CREATE TABLE `forecast_snapshots` (
	`id` text PRIMARY KEY NOT NULL,
	`month` text NOT NULL,
	`sku` text NOT NULL,
	`site` text NOT NULL,
	`channel` text NOT NULL,
	`system_qty` integer NOT NULL,
	`forecast_sales` real NOT NULL,
	`operator_qty` integer NOT NULL,
	`approved_qty` integer,
	`model_json` text NOT NULL,
	`approval_id` text,
	`created_at` text NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `idx_forecast_month_scope` ON `forecast_snapshots` (`month`,`sku`,`site`,`channel`);--> statement-breakpoint
CREATE TABLE `system_maintenance` (
	`id` text PRIMARY KEY NOT NULL,
	`mode` text DEFAULT 'normal' NOT NULL,
	`token_hash` text DEFAULT '' NOT NULL,
	`actor_id` text DEFAULT '' NOT NULL,
	`expires_at` text DEFAULT '' NOT NULL,
	`updated_at` text NOT NULL
);
--> statement-breakpoint
CREATE TABLE `plan_changes` (
	`id` text PRIMARY KEY NOT NULL,
	`approval_id` text NOT NULL,
	`base_version` integer NOT NULL,
	`version` integer DEFAULT 1 NOT NULL,
	`month` text NOT NULL,
	`status` text DEFAULT 'pending' NOT NULL,
	`old_json` text NOT NULL,
	`new_json` text NOT NULL,
	`reason` text NOT NULL,
	`creator_id` text NOT NULL,
	`decided_by` text,
	`decision_note` text DEFAULT '' NOT NULL,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL
);
--> statement-breakpoint
CREATE INDEX `idx_plan_changes_approval` ON `plan_changes` (`approval_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `idx_plan_change_pending` ON `plan_changes` (`approval_id`) WHERE "plan_changes"."status"='pending';--> statement-breakpoint
CREATE TABLE `wholesale_return_resolutions` (
	`id` text PRIMARY KEY NOT NULL,
	`return_id` text NOT NULL,
	`channel` text NOT NULL,
	`qty` integer NOT NULL,
	`resolution` text NOT NULL,
	`reason` text NOT NULL,
	`actor_id` text NOT NULL,
	`created_at` text NOT NULL,
	CONSTRAINT "return_resolution_qty" CHECK("wholesale_return_resolutions"."qty">0 AND "wholesale_return_resolutions"."resolution" IN ('release','writeoff'))
);
--> statement-breakpoint
CREATE INDEX `idx_return_resolution_source` ON `wholesale_return_resolutions` (`return_id`,`channel`);--> statement-breakpoint
CREATE TABLE `sales_demand_corrections` (
	`id` text PRIMARY KEY NOT NULL,
	`sku` text NOT NULL,
	`site` text NOT NULL,
	`channel` text NOT NULL,
	`business_date` text NOT NULL,
	`stockout` integer DEFAULT 0 NOT NULL,
	`return_qty` integer DEFAULT 0 NOT NULL,
	`exclude_spike` integer DEFAULT 0 NOT NULL,
	`reason` text NOT NULL,
	`actor_id` text NOT NULL,
	`updated_at` text NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `idx_demand_correction_scope` ON `sales_demand_corrections` (`sku`,`site`,`channel`,`business_date`);--> statement-breakpoint
CREATE TABLE `supply_policies` (
	`id` text PRIMARY KEY NOT NULL,
	`sku` text NOT NULL,
	`site` text NOT NULL,
	`channel` text NOT NULL,
	`supplier` text NOT NULL,
	`transport_mode` text DEFAULT 'sea' NOT NULL,
	`production_days` integer DEFAULT 21 NOT NULL,
	`transport_days` integer DEFAULT 35 NOT NULL,
	`safety_days` integer DEFAULT 0 NOT NULL,
	`review_days` integer DEFAULT 7 NOT NULL,
	`service_level` real DEFAULT 0.95 NOT NULL,
	`season_factor` real DEFAULT 1 NOT NULL,
	`lifecycle` text DEFAULT 'normal' NOT NULL,
	`campaign_factor` real DEFAULT 1 NOT NULL,
	`campaign_start` text DEFAULT '' NOT NULL,
	`campaign_end` text DEFAULT '' NOT NULL,
	`outlier_multiple` real DEFAULT 4 NOT NULL,
	`min_order_qty` integer DEFAULT 1 NOT NULL,
	`order_multiple` integer DEFAULT 1 NOT NULL,
	`capacity_qty` integer,
	`warehouse_qty` integer,
	`budget_amount` real,
	`unit_cost` real DEFAULT 0 NOT NULL,
	`currency` text DEFAULT 'CNY' NOT NULL,
	`max_cover_days` integer DEFAULT 120 NOT NULL,
	`note` text DEFAULT '' NOT NULL,
	`version` integer DEFAULT 1 NOT NULL,
	`updated_at` text NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `idx_supply_policy_scope` ON `supply_policies` (`sku`,`site`,`channel`);--> statement-breakpoint
CREATE TABLE `system_operations` (
	`id` text PRIMARY KEY NOT NULL,
	`actor_id` text NOT NULL,
	`action` text NOT NULL,
	`request_json` text NOT NULL,
	`guard` integer NOT NULL,
	`created_at` text NOT NULL,
	CONSTRAINT "system_atomic_guard" CHECK("system_operations"."guard"=1)
);
--> statement-breakpoint
DROP INDEX `idx_wh_finance_reference`;--> statement-breakpoint
ALTER TABLE `wholesale_finance_entries` ADD `bank_receipt_id` text;--> statement-breakpoint
ALTER TABLE `wholesale_finance_entries` ADD `reverses_id` text;--> statement-breakpoint
CREATE UNIQUE INDEX `idx_wh_finance_reference_direct` ON `wholesale_finance_entries` (`kind`,`reference`) WHERE "wholesale_finance_entries"."bank_receipt_id" IS NULL;--> statement-breakpoint
CREATE UNIQUE INDEX `idx_wh_finance_reverses` ON `wholesale_finance_entries` (`reverses_id`) WHERE "wholesale_finance_entries"."reverses_id" IS NOT NULL;--> statement-breakpoint
ALTER TABLE `approval_requests` ADD `version` integer DEFAULT 1 NOT NULL;--> statement-breakpoint
ALTER TABLE `monthly_submissions` ADD `version` integer DEFAULT 1 NOT NULL;--> statement-breakpoint
ALTER TABLE `monthly_submissions` ADD `zero_demand` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `monthly_submissions` ADD `zero_reason` text DEFAULT '' NOT NULL;--> statement-breakpoint
ALTER TABLE `new_product_projects` ADD `version` integer DEFAULT 1 NOT NULL;--> statement-breakpoint
ALTER TABLE `new_product_projects` ADD `finance_revision` integer DEFAULT 1 NOT NULL;--> statement-breakpoint
ALTER TABLE `new_product_stage_records` ADD `version` integer DEFAULT 1 NOT NULL;--> statement-breakpoint
ALTER TABLE `new_product_stage_records` ADD `source_version` integer;--> statement-breakpoint
ALTER TABLE `wholesale_customers` ADD `version` integer DEFAULT 1 NOT NULL;--> statement-breakpoint
ALTER TABLE `wholesale_orders` ADD `service_user_id` text;
--> statement-breakpoint
CREATE TRIGGER guard_legacy_ship_qty BEFORE INSERT ON shipment_batch_items
WHEN NEW.shipped_qty<=0 OR NEW.shipped_qty+COALESCE((SELECT SUM(shipped_qty) FROM shipment_batch_items WHERE production_order_item_id=NEW.production_order_item_id),0)+COALESCE((SELECT SUM(shipped_qty) FROM transport_batch_items WHERE production_order_item_id=NEW.production_order_item_id),0)>COALESCE((SELECT MIN(produced_qty,planned_qty) FROM series_production_order_items WHERE id=NEW.production_order_item_id),0)
BEGIN SELECT RAISE(ABORT,'guard_legacy_shipment exceeds produced quantity'); END;
--> statement-breakpoint
CREATE TRIGGER guard_legacy_receipt_qty BEFORE INSERT ON shipment_receipt_items
WHEN NEW.received_qty<=0 OR NEW.received_qty+COALESCE((SELECT SUM(received_qty) FROM shipment_receipt_items WHERE batch_item_id=NEW.batch_item_id),0)>COALESCE((SELECT shipped_qty FROM shipment_batch_items WHERE id=NEW.batch_item_id),0)
BEGIN SELECT RAISE(ABORT,'guard_legacy_receipt exceeds shipped quantity'); END;
--> statement-breakpoint
CREATE TRIGGER guard_return_resolution BEFORE INSERT ON wholesale_return_resolutions
WHEN NEW.qty+COALESCE((SELECT SUM(qty) FROM wholesale_return_resolutions WHERE return_id=NEW.return_id AND channel=NEW.channel),0)>COALESCE((SELECT SUM(CAST(j.value->>'qty' AS INTEGER)) FROM wholesale_returns r,json_each(r.allocations_json) j WHERE r.id=NEW.return_id AND r.resellable=0 AND j.value->>'channel'=NEW.channel),0)
BEGIN SELECT RAISE(ABORT,'guard_return_resolution exceeds isolated return'); END;
