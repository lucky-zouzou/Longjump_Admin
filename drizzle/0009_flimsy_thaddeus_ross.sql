DROP INDEX `idx_series_po_approval_series`;--> statement-breakpoint
ALTER TABLE `series_purchase_orders` ADD `factory_name` text DEFAULT '' NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX `idx_series_po_approval_series` ON `series_purchase_orders` (`approval_id`,`series_name`,`supplier_name`,`factory_name`);