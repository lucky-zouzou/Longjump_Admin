CREATE TABLE `wholesale_allocations` (
	`id` text PRIMARY KEY NOT NULL,
	`order_item_id` text NOT NULL,
	`channel` text NOT NULL,
	`qty` integer NOT NULL,
	`shipped_qty` integer DEFAULT 0 NOT NULL,
	`released_qty` integer DEFAULT 0 NOT NULL,
	`returned_qty` integer DEFAULT 0 NOT NULL,
	FOREIGN KEY (`order_item_id`) REFERENCES `wholesale_order_items`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "wh_allocation_qty" CHECK("wholesale_allocations"."qty">0 AND "wholesale_allocations"."shipped_qty">=0 AND "wholesale_allocations"."released_qty">=0 AND "wholesale_allocations"."shipped_qty"+"wholesale_allocations"."released_qty"<="wholesale_allocations"."qty" AND "wholesale_allocations"."returned_qty">=0 AND "wholesale_allocations"."returned_qty"<="wholesale_allocations"."shipped_qty")
);
--> statement-breakpoint
CREATE UNIQUE INDEX `idx_wh_allocation_item` ON `wholesale_allocations` (`order_item_id`,`channel`);--> statement-breakpoint
CREATE TABLE `wholesale_customers` (
	`id` text PRIMARY KEY NOT NULL,
	`code` text NOT NULL,
	`name` text NOT NULL,
	`contact` text NOT NULL,
	`phone` text NOT NULL,
	`city` text NOT NULL,
	`address` text NOT NULL,
	`note` text DEFAULT '' NOT NULL,
	`sales_user_id` text NOT NULL,
	`active` integer DEFAULT 1 NOT NULL,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `idx_wh_customer_code` ON `wholesale_customers` (`code`);--> statement-breakpoint
CREATE INDEX `idx_wh_customer_owner` ON `wholesale_customers` (`sales_user_id`);--> statement-breakpoint
CREATE TABLE `wholesale_files` (
	`id` text PRIMARY KEY NOT NULL,
	`order_id` text NOT NULL,
	`object_key` text NOT NULL,
	`name` text NOT NULL,
	`content_type` text NOT NULL,
	`size` integer NOT NULL,
	`actor_id` text NOT NULL,
	`created_at` text NOT NULL,
	FOREIGN KEY (`order_id`) REFERENCES `wholesale_orders`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `idx_wh_files_order` ON `wholesale_files` (`order_id`);--> statement-breakpoint
CREATE TABLE `wholesale_finance_entries` (
	`id` text PRIMARY KEY NOT NULL,
	`order_id` text NOT NULL,
	`kind` text NOT NULL,
	`amount` integer NOT NULL,
	`reference` text NOT NULL,
	`business_date` text NOT NULL,
	`note` text NOT NULL,
	`actor_id` text NOT NULL,
	`created_at` text NOT NULL,
	FOREIGN KEY (`order_id`) REFERENCES `wholesale_orders`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "wh_finance_positive" CHECK("wholesale_finance_entries"."amount">0)
);
--> statement-breakpoint
CREATE UNIQUE INDEX `idx_wh_finance_reference` ON `wholesale_finance_entries` (`kind`,`reference`);--> statement-breakpoint
CREATE INDEX `idx_wh_finance_order` ON `wholesale_finance_entries` (`order_id`);--> statement-breakpoint
CREATE TABLE `wholesale_operations` (
	`id` text PRIMARY KEY NOT NULL,
	`order_id` text NOT NULL,
	`action` text NOT NULL,
	`actor_id` text NOT NULL,
	`request_json` text NOT NULL,
	`guard` integer NOT NULL,
	`created_at` text NOT NULL,
	CONSTRAINT "wh_operation_atomic_guard" CHECK("wholesale_operations"."guard"=1)
);
--> statement-breakpoint
CREATE TABLE `wholesale_order_items` (
	`id` text PRIMARY KEY NOT NULL,
	`order_id` text NOT NULL,
	`sku` text NOT NULL,
	`name` text NOT NULL,
	`qty` integer NOT NULL,
	`unit_price` integer NOT NULL,
	`amount` integer NOT NULL,
	`shipped_qty` integer DEFAULT 0 NOT NULL,
	`returned_qty` integer DEFAULT 0 NOT NULL,
	FOREIGN KEY (`order_id`) REFERENCES `wholesale_orders`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "wh_item_qty" CHECK("wholesale_order_items"."qty">0 AND "wholesale_order_items"."shipped_qty">=0 AND "wholesale_order_items"."shipped_qty"<="wholesale_order_items"."qty" AND "wholesale_order_items"."returned_qty">=0 AND "wholesale_order_items"."returned_qty"<="wholesale_order_items"."shipped_qty")
);
--> statement-breakpoint
CREATE UNIQUE INDEX `idx_wh_item_sku` ON `wholesale_order_items` (`order_id`,`sku`);--> statement-breakpoint
CREATE TABLE `wholesale_orders` (
	`id` text PRIMARY KEY NOT NULL,
	`order_no` text NOT NULL,
	`site` text DEFAULT '印尼' NOT NULL,
	`currency` text DEFAULT 'IDR' NOT NULL,
	`business_date` text NOT NULL,
	`customer_id` text NOT NULL,
	`customer_json` text NOT NULL,
	`sales_user_id` text NOT NULL,
	`creator_id` text NOT NULL,
	`supply_user_id` text,
	`approved_by` text,
	`status` text DEFAULT 'pending' NOT NULL,
	`version` integer DEFAULT 1 NOT NULL,
	`total_qty` integer NOT NULL,
	`total_amount` integer NOT NULL,
	`invoice_required` integer DEFAULT 0 NOT NULL,
	`payment_terms` text DEFAULT 'prepaid' NOT NULL,
	`due_date` text,
	`allocation_policy` text DEFAULT 'average_v1' NOT NULL,
	`note` text DEFAULT '' NOT NULL,
	`decision_note` text DEFAULT '' NOT NULL,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	`approved_at` text,
	`completed_at` text,
	FOREIGN KEY (`customer_id`) REFERENCES `wholesale_customers`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "wh_indonesia_only" CHECK("wholesale_orders"."site"='印尼' AND "wholesale_orders"."currency"='IDR')
);
--> statement-breakpoint
CREATE UNIQUE INDEX `idx_wh_order_no` ON `wholesale_orders` (`order_no`);--> statement-breakpoint
CREATE INDEX `idx_wh_order_customer` ON `wholesale_orders` (`customer_id`,`business_date`);--> statement-breakpoint
CREATE INDEX `idx_wh_order_sales` ON `wholesale_orders` (`sales_user_id`,`status`);--> statement-breakpoint
CREATE INDEX `idx_wh_order_supply` ON `wholesale_orders` (`supply_user_id`,`status`);--> statement-breakpoint
CREATE TABLE `wholesale_returns` (
	`id` text PRIMARY KEY NOT NULL,
	`order_id` text NOT NULL,
	`order_item_id` text NOT NULL,
	`qty` integer NOT NULL,
	`amount` integer NOT NULL,
	`resellable` integer DEFAULT 0 NOT NULL,
	`allocations_json` text NOT NULL,
	`business_date` text NOT NULL,
	`proof_ref` text NOT NULL,
	`reason` text NOT NULL,
	`actor_id` text NOT NULL,
	`created_at` text NOT NULL,
	FOREIGN KEY (`order_id`) REFERENCES `wholesale_orders`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`order_item_id`) REFERENCES `wholesale_order_items`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `idx_wh_return_month` ON `wholesale_returns` (`business_date`,`order_id`);--> statement-breakpoint
CREATE TABLE `wholesale_shipment_items` (
	`id` text PRIMARY KEY NOT NULL,
	`shipment_id` text NOT NULL,
	`order_item_id` text NOT NULL,
	`qty` integer NOT NULL,
	`amount` integer NOT NULL,
	`allocations_json` text NOT NULL,
	FOREIGN KEY (`shipment_id`) REFERENCES `wholesale_shipments`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`order_item_id`) REFERENCES `wholesale_order_items`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `idx_wh_shipment_item` ON `wholesale_shipment_items` (`shipment_id`,`order_item_id`);--> statement-breakpoint
CREATE TABLE `wholesale_shipments` (
	`id` text PRIMARY KEY NOT NULL,
	`order_id` text NOT NULL,
	`shipment_no` text NOT NULL,
	`business_date` text NOT NULL,
	`tracking_no` text DEFAULT '' NOT NULL,
	`carrier` text NOT NULL,
	`warehouse` text NOT NULL,
	`proof_json` text DEFAULT '[]' NOT NULL,
	`note` text DEFAULT '' NOT NULL,
	`actor_id` text NOT NULL,
	`created_at` text NOT NULL,
	FOREIGN KEY (`order_id`) REFERENCES `wholesale_orders`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `idx_wh_shipment_no` ON `wholesale_shipments` (`shipment_no`);--> statement-breakpoint
CREATE INDEX `idx_wh_shipment_month` ON `wholesale_shipments` (`business_date`,`order_id`);