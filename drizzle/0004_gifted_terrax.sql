CREATE TABLE `business_partners` (
	`id` text PRIMARY KEY NOT NULL,
	`type` text NOT NULL,
	`code` text NOT NULL,
	`name` text NOT NULL,
	`contact` text DEFAULT '' NOT NULL,
	`default_lead_days` integer DEFAULT 0 NOT NULL,
	`assigned_user_id` text,
	`active` integer DEFAULT 1 NOT NULL,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	FOREIGN KEY (`assigned_user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `idx_partner_type_code` ON `business_partners` (`type`,`code`);--> statement-breakpoint
CREATE UNIQUE INDEX `idx_partner_type_name` ON `business_partners` (`type`,`name`);--> statement-breakpoint
CREATE INDEX `idx_partner_assignee` ON `business_partners` (`assigned_user_id`,`active`);--> statement-breakpoint
CREATE TABLE `inventory_count_requests` (
	`id` text PRIMARY KEY NOT NULL,
	`site` text NOT NULL,
	`channel` text NOT NULL,
	`sku` text NOT NULL,
	`system_qty` integer NOT NULL,
	`counted_qty` integer NOT NULL,
	`reason` text NOT NULL,
	`status` text DEFAULT 'pending' NOT NULL,
	`decision_comment` text DEFAULT '' NOT NULL,
	`creator_id` text NOT NULL,
	`decided_by` text,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL
);
--> statement-breakpoint
CREATE INDEX `idx_count_status` ON `inventory_count_requests` (`status`,`created_at`);--> statement-breakpoint
CREATE INDEX `idx_count_scope` ON `inventory_count_requests` (`site`,`channel`,`sku`);--> statement-breakpoint
CREATE UNIQUE INDEX `idx_count_pending_unique` ON `inventory_count_requests` (`site`,`channel`,`sku`) WHERE `status`='pending';--> statement-breakpoint
CREATE TABLE `transport_batch_items` (
	`id` text PRIMARY KEY NOT NULL,
	`batch_id` text NOT NULL,
	`production_order_id` text NOT NULL,
	`production_order_item_id` text NOT NULL,
	`series_name` text NOT NULL,
	`sku` text NOT NULL,
	`name` text DEFAULT '' NOT NULL,
	`shipped_qty` integer NOT NULL,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	FOREIGN KEY (`batch_id`) REFERENCES `transport_batches`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `idx_transport_item_source` ON `transport_batch_items` (`batch_id`,`production_order_item_id`);--> statement-breakpoint
CREATE INDEX `idx_transport_item_batch` ON `transport_batch_items` (`batch_id`);--> statement-breakpoint
CREATE INDEX `idx_transport_item_sku` ON `transport_batch_items` (`sku`);--> statement-breakpoint
CREATE TABLE `transport_batches` (
	`id` text PRIMARY KEY NOT NULL,
	`batch_no` text NOT NULL,
	`container_no` text DEFAULT '' NOT NULL,
	`bill_no` text DEFAULT '' NOT NULL,
	`carrier_name` text NOT NULL,
	`status` text DEFAULT 'booking' NOT NULL,
	`total_shipped_qty` integer NOT NULL,
	`sku_count` integer NOT NULL,
	`series_count` integer NOT NULL,
	`creator_id` text NOT NULL,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `idx_transport_batch_no` ON `transport_batches` (`batch_no`);--> statement-breakpoint
CREATE INDEX `idx_transport_batch_status` ON `transport_batches` (`status`,`updated_at`);--> statement-breakpoint
CREATE TABLE `transport_leg_items` (
	`id` text PRIMARY KEY NOT NULL,
	`leg_id` text NOT NULL,
	`batch_item_id` text NOT NULL,
	`sku` text NOT NULL,
	`qty` integer NOT NULL,
	`received_qty` integer DEFAULT 0 NOT NULL,
	`pending_shelf_qty` integer DEFAULT 0 NOT NULL,
	`sellable_qty` integer DEFAULT 0 NOT NULL,
	`quarantine_qty` integer DEFAULT 0 NOT NULL,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	FOREIGN KEY (`leg_id`) REFERENCES `transport_legs`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`batch_item_id`) REFERENCES `transport_batch_items`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `idx_transport_leg_item_unique` ON `transport_leg_items` (`leg_id`,`batch_item_id`);--> statement-breakpoint
CREATE INDEX `idx_transport_leg_item_sku` ON `transport_leg_items` (`sku`);--> statement-breakpoint
CREATE TABLE `transport_legs` (
	`id` text PRIMARY KEY NOT NULL,
	`batch_id` text NOT NULL,
	`leg_no` text NOT NULL,
	`site` text NOT NULL,
	`channel` text NOT NULL,
	`warehouse_id` text,
	`warehouse_name` text NOT NULL,
	`port_name` text DEFAULT '' NOT NULL,
	`stage` text DEFAULT 'booking' NOT NULL,
	`stage_owner` text DEFAULT '供应链' NOT NULL,
	`assigned_user_id` text,
	`total_qty` integer NOT NULL,
	`etd` text,
	`eta` text,
	`ata` text,
	`evidence_json` text DEFAULT '[]' NOT NULL,
	`version` integer DEFAULT 1 NOT NULL,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	FOREIGN KEY (`batch_id`) REFERENCES `transport_batches`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`warehouse_id`) REFERENCES `warehouses`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`assigned_user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `idx_transport_leg_no` ON `transport_legs` (`leg_no`);--> statement-breakpoint
CREATE UNIQUE INDEX `idx_transport_leg_destination` ON `transport_legs` (`batch_id`,`site`,`channel`,`warehouse_name`);--> statement-breakpoint
CREATE INDEX `idx_transport_leg_stage` ON `transport_legs` (`stage`,`updated_at`);--> statement-breakpoint
CREATE INDEX `idx_transport_leg_assignee` ON `transport_legs` (`assigned_user_id`,`stage`);--> statement-breakpoint
CREATE TABLE `transport_receipt_items` (
	`id` text PRIMARY KEY NOT NULL,
	`receipt_id` text NOT NULL,
	`leg_item_id` text NOT NULL,
	`received_qty` integer NOT NULL,
	`quarantine_qty` integer DEFAULT 0 NOT NULL,
	`created_at` text NOT NULL,
	FOREIGN KEY (`receipt_id`) REFERENCES `transport_receipts`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`leg_item_id`) REFERENCES `transport_leg_items`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `idx_transport_receipt_item_unique` ON `transport_receipt_items` (`receipt_id`,`leg_item_id`);--> statement-breakpoint
CREATE INDEX `idx_transport_receipt_item_leg` ON `transport_receipt_items` (`leg_item_id`);--> statement-breakpoint
CREATE TABLE `transport_receipts` (
	`id` text PRIMARY KEY NOT NULL,
	`receipt_no` text NOT NULL,
	`leg_id` text NOT NULL,
	`proof_ref` text NOT NULL,
	`note` text DEFAULT '' NOT NULL,
	`total_received_qty` integer NOT NULL,
	`total_quarantine_qty` integer DEFAULT 0 NOT NULL,
	`actor_id` text NOT NULL,
	`received_at` text NOT NULL,
	FOREIGN KEY (`leg_id`) REFERENCES `transport_legs`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `idx_transport_receipt_no` ON `transport_receipts` (`receipt_no`);--> statement-breakpoint
CREATE INDEX `idx_transport_receipt_leg` ON `transport_receipts` (`leg_id`,`received_at`);--> statement-breakpoint
CREATE TABLE `transport_shelf_confirmations` (
	`id` text PRIMARY KEY NOT NULL,
	`leg_item_id` text NOT NULL,
	`shelved_qty` integer NOT NULL,
	`listing_ref` text NOT NULL,
	`note` text DEFAULT '' NOT NULL,
	`actor_id` text NOT NULL,
	`confirmed_at` text NOT NULL,
	FOREIGN KEY (`leg_item_id`) REFERENCES `transport_leg_items`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `idx_transport_shelf_item` ON `transport_shelf_confirmations` (`leg_item_id`,`confirmed_at`);--> statement-breakpoint
CREATE TABLE `warehouses` (
	`id` text PRIMARY KEY NOT NULL,
	`site` text NOT NULL,
	`channel` text NOT NULL,
	`code` text NOT NULL,
	`name` text NOT NULL,
	`capacity_qty` integer DEFAULT 0 NOT NULL,
	`active` integer DEFAULT 1 NOT NULL,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `idx_warehouse_code` ON `warehouses` (`code`);--> statement-breakpoint
CREATE UNIQUE INDEX `idx_warehouse_scope_name` ON `warehouses` (`site`,`channel`,`name`);--> statement-breakpoint
CREATE INDEX `idx_warehouse_scope` ON `warehouses` (`site`,`channel`,`active`);--> statement-breakpoint
CREATE UNIQUE INDEX `idx_warehouse_active_scope` ON `warehouses` (`site`,`channel`) WHERE `active`=1;--> statement-breakpoint
ALTER TABLE `inventory_balances` ADD `pending_shelf_qty` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `inventory_balances` ADD `reserved_qty` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `inventory_balances` ADD `quarantine_qty` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `new_product_projects` ADD `recommended_first_batch_qty` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `sales_imports` ADD `source_batch_ref` text DEFAULT '' NOT NULL;--> statement-breakpoint
ALTER TABLE `sales_imports` ADD `reversed_at` text;--> statement-breakpoint
ALTER TABLE `sales_imports` ADD `reversed_by` text;--> statement-breakpoint
ALTER TABLE `sales_imports` ADD `reversal_reason` text DEFAULT '' NOT NULL;--> statement-breakpoint
ALTER TABLE `sales_records` ADD `reversed_at` text;--> statement-breakpoint
ALTER TABLE `series_production_orders` ADD `assigned_user_id` text REFERENCES users(id);--> statement-breakpoint
ALTER TABLE `series_production_orders` ADD `promised_completion_date` text;--> statement-breakpoint
ALTER TABLE `series_production_orders` ADD `progress_pct` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `series_production_orders` ADD `qc_status` text DEFAULT 'pending' NOT NULL;--> statement-breakpoint
ALTER TABLE `series_production_orders` ADD `qc_evidence` text DEFAULT '' NOT NULL;--> statement-breakpoint
ALTER TABLE `series_production_orders` ADD `qc_at` text;--> statement-breakpoint
ALTER TABLE `series_production_orders` ADD `qc_by` text;--> statement-breakpoint
ALTER TABLE `series_purchase_orders` ADD `assigned_supply_user_id` text REFERENCES users(id);--> statement-breakpoint
ALTER TABLE `series_purchase_orders` ADD `order_ref` text DEFAULT '' NOT NULL;--> statement-breakpoint
ALTER TABLE `series_purchase_orders` ADD `supplier_confirmed_at` text;--> statement-breakpoint
ALTER TABLE `series_purchase_orders` ADD `expected_completion_date` text;--> statement-breakpoint
ALTER TABLE `sku_settings` ADD `min_order_qty` integer DEFAULT 1 NOT NULL;--> statement-breakpoint
ALTER TABLE `sku_settings` ADD `order_multiple` integer DEFAULT 1 NOT NULL;--> statement-breakpoint
ALTER TABLE `sku_settings` ADD `carton_qty` integer DEFAULT 1 NOT NULL;--> statement-breakpoint
ALTER TABLE `sku_settings` ADD `unit_volume_cbm` real DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `users` ADD `responsibility_unit` text;
--> statement-breakpoint
CREATE UNIQUE INDEX `idx_sales_import_active_source_ref` ON `sales_imports` (`site`,`channel`,`business_date`,`source_batch_ref`) WHERE `reversed_at` IS NULL AND `source_batch_ref`<>'';
--> statement-breakpoint
CREATE TRIGGER `guard_inventory_buckets_insert` BEFORE INSERT ON `inventory_balances`
WHEN NEW.pending_shelf_qty < 0 OR NEW.reserved_qty < 0 OR NEW.quarantine_qty < 0
BEGIN SELECT RAISE(ABORT, 'inventory bucket cannot be negative'); END;
--> statement-breakpoint
CREATE TRIGGER `guard_inventory_buckets_update` BEFORE UPDATE ON `inventory_balances`
WHEN NEW.pending_shelf_qty < 0 OR NEW.reserved_qty < 0 OR NEW.quarantine_qty < 0
BEGIN SELECT RAISE(ABORT, 'inventory bucket cannot be negative'); END;
--> statement-breakpoint
CREATE TRIGGER `guard_transport_ship_qty` BEFORE INSERT ON `transport_batch_items`
WHEN NEW.shipped_qty <= 0 OR NEW.shipped_qty + COALESCE((SELECT SUM(shipped_qty) FROM transport_batch_items WHERE production_order_item_id=NEW.production_order_item_id),0) + COALESCE((SELECT SUM(shipped_qty) FROM shipment_batch_items WHERE production_order_item_id=NEW.production_order_item_id),0) > COALESCE((SELECT produced_qty FROM series_production_order_items WHERE id=NEW.production_order_item_id),0)
BEGIN SELECT RAISE(ABORT, 'shipment exceeds produced quantity'); END;
--> statement-breakpoint
CREATE TRIGGER `guard_transport_leg_allocation` BEFORE INSERT ON `transport_leg_items`
WHEN NEW.qty <= 0 OR NEW.qty + COALESCE((SELECT SUM(qty) FROM transport_leg_items WHERE batch_item_id=NEW.batch_item_id),0) > COALESCE((SELECT shipped_qty FROM transport_batch_items WHERE id=NEW.batch_item_id),0)
BEGIN SELECT RAISE(ABORT, 'destination allocation exceeds shipped quantity'); END;
--> statement-breakpoint
CREATE TRIGGER `guard_transport_receipt_qty` BEFORE INSERT ON `transport_receipt_items`
WHEN NEW.received_qty <= 0 OR NEW.quarantine_qty < 0 OR NEW.quarantine_qty > NEW.received_qty OR NEW.received_qty + COALESCE((SELECT SUM(received_qty) FROM transport_receipt_items WHERE leg_item_id=NEW.leg_item_id),0) > COALESCE((SELECT qty FROM transport_leg_items WHERE id=NEW.leg_item_id),0)
BEGIN SELECT RAISE(ABORT, 'receipt exceeds leg quantity'); END;
--> statement-breakpoint
CREATE TRIGGER `guard_transport_shelf_qty` BEFORE INSERT ON `transport_shelf_confirmations`
WHEN NEW.shelved_qty <= 0 OR NEW.shelved_qty > COALESCE((SELECT pending_shelf_qty FROM transport_leg_items WHERE id=NEW.leg_item_id),0)
BEGIN SELECT RAISE(ABORT, 'shelf confirmation exceeds pending quantity'); END;
--> statement-breakpoint
CREATE TRIGGER `guard_transport_leg_item_buckets` BEFORE UPDATE ON `transport_leg_items`
WHEN NEW.received_qty < 0 OR NEW.pending_shelf_qty < 0 OR NEW.sellable_qty < 0 OR NEW.quarantine_qty < 0 OR NEW.received_qty > NEW.qty OR NEW.pending_shelf_qty + NEW.sellable_qty + NEW.quarantine_qty > NEW.received_qty
BEGIN SELECT RAISE(ABORT, 'invalid transport leg inventory buckets'); END;
