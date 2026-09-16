CREATE TABLE `series_production_order_items` (
	`id` text PRIMARY KEY NOT NULL,
	`production_order_id` text NOT NULL,
	`purchase_order_item_id` text NOT NULL,
	`sku` text NOT NULL,
	`name` text DEFAULT '' NOT NULL,
	`planned_qty` integer NOT NULL,
	`produced_qty` integer DEFAULT 0 NOT NULL,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `idx_series_production_item_unique` ON `series_production_order_items` (`production_order_id`,`sku`);--> statement-breakpoint
CREATE INDEX `idx_series_production_item_sku` ON `series_production_order_items` (`sku`);--> statement-breakpoint
CREATE TABLE `series_production_orders` (
	`id` text PRIMARY KEY NOT NULL,
	`purchase_order_id` text NOT NULL,
	`month` text NOT NULL,
	`series_name` text NOT NULL,
	`factory_name` text DEFAULT '' NOT NULL,
	`status` text DEFAULT 'pending' NOT NULL,
	`total_planned_qty` integer NOT NULL,
	`total_produced_qty` integer DEFAULT 0 NOT NULL,
	`evidence_json` text DEFAULT '[]' NOT NULL,
	`creator_id` text NOT NULL,
	`started_at` text,
	`completed_at` text,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `idx_series_production_po` ON `series_production_orders` (`purchase_order_id`);--> statement-breakpoint
CREATE INDEX `idx_series_production_status` ON `series_production_orders` (`status`,`updated_at`);--> statement-breakpoint
CREATE TABLE `series_purchase_order_items` (
	`id` text PRIMARY KEY NOT NULL,
	`purchase_order_id` text NOT NULL,
	`sku` text NOT NULL,
	`name` text DEFAULT '' NOT NULL,
	`ordered_qty` integer NOT NULL,
	`allocations_json` text NOT NULL,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `idx_series_po_item_unique` ON `series_purchase_order_items` (`purchase_order_id`,`sku`);--> statement-breakpoint
CREATE INDEX `idx_series_po_item_sku` ON `series_purchase_order_items` (`sku`);--> statement-breakpoint
CREATE TABLE `series_purchase_orders` (
	`id` text PRIMARY KEY NOT NULL,
	`month` text NOT NULL,
	`series_name` text NOT NULL,
	`supplier_name` text DEFAULT '' NOT NULL,
	`status` text DEFAULT 'ordered' NOT NULL,
	`total_qty` integer NOT NULL,
	`sku_count` integer NOT NULL,
	`approval_id` text NOT NULL,
	`creator_id` text NOT NULL,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `idx_series_po_approval_series` ON `series_purchase_orders` (`approval_id`,`series_name`,`supplier_name`);--> statement-breakpoint
CREATE INDEX `idx_series_po_month` ON `series_purchase_orders` (`month`,`updated_at`);--> statement-breakpoint
CREATE TABLE `shipment_batch_items` (
	`id` text PRIMARY KEY NOT NULL,
	`batch_id` text NOT NULL,
	`production_order_item_id` text NOT NULL,
	`sku` text NOT NULL,
	`name` text DEFAULT '' NOT NULL,
	`shipped_qty` integer NOT NULL,
	`received_qty` integer DEFAULT 0 NOT NULL,
	`shelved_qty` integer DEFAULT 0 NOT NULL,
	`allocations_json` text NOT NULL,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `idx_shipment_item_unique` ON `shipment_batch_items` (`batch_id`,`sku`);--> statement-breakpoint
CREATE INDEX `idx_shipment_item_sku` ON `shipment_batch_items` (`sku`);--> statement-breakpoint
CREATE TABLE `shipment_batches` (
	`id` text PRIMARY KEY NOT NULL,
	`batch_no` text NOT NULL,
	`month` text NOT NULL,
	`production_order_id` text NOT NULL,
	`series_name` text NOT NULL,
	`total_shipped_qty` integer NOT NULL,
	`sku_count` integer NOT NULL,
	`stage` text DEFAULT 'channel_allocation' NOT NULL,
	`stage_owner` text DEFAULT '供应链' NOT NULL,
	`estimated_arrival_date` text,
	`evidence_json` text DEFAULT '[]' NOT NULL,
	`creator_id` text NOT NULL,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `idx_shipment_batch_no` ON `shipment_batches` (`batch_no`);--> statement-breakpoint
CREATE INDEX `idx_shipment_stage` ON `shipment_batches` (`stage`,`updated_at`);--> statement-breakpoint
CREATE INDEX `idx_shipment_production` ON `shipment_batches` (`production_order_id`);--> statement-breakpoint
CREATE TABLE `shipment_receipt_items` (
	`id` text PRIMARY KEY NOT NULL,
	`receipt_id` text NOT NULL,
	`batch_item_id` text NOT NULL,
	`sku` text NOT NULL,
	`received_qty` integer NOT NULL,
	`allocations_json` text NOT NULL,
	`created_at` text NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `idx_shipment_receipt_item_unique` ON `shipment_receipt_items` (`receipt_id`,`batch_item_id`);--> statement-breakpoint
CREATE INDEX `idx_shipment_receipt_item_batch_item` ON `shipment_receipt_items` (`batch_item_id`);--> statement-breakpoint
CREATE TABLE `shipment_receipts` (
	`id` text PRIMARY KEY NOT NULL,
	`receipt_no` text NOT NULL,
	`batch_id` text NOT NULL,
	`proof_ref` text NOT NULL,
	`total_received_qty` integer NOT NULL,
	`actor_id` text NOT NULL,
	`received_at` text NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `idx_shipment_receipt_no` ON `shipment_receipts` (`receipt_no`);--> statement-breakpoint
CREATE INDEX `idx_shipment_receipt_batch` ON `shipment_receipts` (`batch_id`,`received_at`);--> statement-breakpoint
CREATE TABLE `shipment_shelf_confirmations` (
	`id` text PRIMARY KEY NOT NULL,
	`batch_item_id` text NOT NULL,
	`site` text NOT NULL,
	`channel` text NOT NULL,
	`planned_qty` integer NOT NULL,
	`shelved_qty` integer NOT NULL,
	`listing_ref` text NOT NULL,
	`note` text DEFAULT '' NOT NULL,
	`actor_id` text NOT NULL,
	`confirmed_at` text NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `idx_shipment_shelf_scope` ON `shipment_shelf_confirmations` (`batch_item_id`,`site`,`channel`);--> statement-breakpoint
CREATE INDEX `idx_shipment_shelf_item` ON `shipment_shelf_confirmations` (`batch_item_id`);--> statement-breakpoint
ALTER TABLE `sku_settings` ADD `product_series` text DEFAULT '待归类' NOT NULL;--> statement-breakpoint
ALTER TABLE `sku_settings` ADD `supplier_name` text DEFAULT '' NOT NULL;--> statement-breakpoint
ALTER TABLE `sku_settings` ADD `factory_name` text DEFAULT '' NOT NULL;