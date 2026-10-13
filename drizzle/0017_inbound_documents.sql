CREATE TABLE `inbound_document_lines` (
	`id` text PRIMARY KEY NOT NULL,
	`document_id` text NOT NULL,
	`sku` text NOT NULL,
	`name` text NOT NULL,
	`site` text NOT NULL,
	`channel` text NOT NULL,
	`warehouse_id` text NOT NULL,
	`warehouse_code` text NOT NULL,
	`warehouse_name` text NOT NULL,
	`source_batch` text DEFAULT '' NOT NULL,
	`qty` integer NOT NULL,
	`stock_state` text NOT NULL,
	`quarantine_remaining` integer DEFAULT 0 NOT NULL,
	`before_json` text NOT NULL,
	`after_json` text NOT NULL,
	`created_at` text NOT NULL,
	FOREIGN KEY (`document_id`) REFERENCES `inbound_documents`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`warehouse_id`) REFERENCES `warehouses`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `idx_inbound_document_scope` ON `inbound_document_lines` (`document_id`,`sku`,`site`,`channel`);--> statement-breakpoint
CREATE INDEX `idx_inbound_hold_scope` ON `inbound_document_lines` (`site`,`channel`,`sku`);--> statement-breakpoint
CREATE TABLE `inbound_documents` (
	`id` text PRIMARY KEY NOT NULL,
	`receipt_no` text NOT NULL,
	`business_date` text NOT NULL,
	`site` text NOT NULL,
	`proof_ref` text NOT NULL,
	`note` text NOT NULL,
	`total_qty` integer NOT NULL,
	`sku_count` integer NOT NULL,
	`actor_id` text NOT NULL,
	`actor_name` text NOT NULL,
	`created_at` text NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `inbound_documents_receipt_no_unique` ON `inbound_documents` (`receipt_no`);
--> statement-breakpoint
CREATE TRIGGER maintenance_inbound_documents_insert BEFORE INSERT ON inbound_documents
WHEN EXISTS(SELECT 1 FROM system_maintenance WHERE id='global' AND mode<>'normal' AND expires_at>strftime('%Y-%m-%dT%H:%M:%fZ','now'))
BEGIN SELECT RAISE(ABORT,'guard_maintenance: system backup or migration is in progress'); END;

--> statement-breakpoint
CREATE TRIGGER maintenance_inbound_documents_update BEFORE UPDATE ON inbound_documents
WHEN EXISTS(SELECT 1 FROM system_maintenance WHERE id='global' AND mode<>'normal' AND expires_at>strftime('%Y-%m-%dT%H:%M:%fZ','now'))
BEGIN SELECT RAISE(ABORT,'guard_maintenance: system backup or migration is in progress'); END;

--> statement-breakpoint
CREATE TRIGGER maintenance_inbound_documents_delete BEFORE DELETE ON inbound_documents
WHEN EXISTS(SELECT 1 FROM system_maintenance WHERE id='global' AND mode<>'normal' AND expires_at>strftime('%Y-%m-%dT%H:%M:%fZ','now'))
BEGIN SELECT RAISE(ABORT,'guard_maintenance: system backup or migration is in progress'); END;

--> statement-breakpoint
CREATE TRIGGER maintenance_inbound_document_lines_insert BEFORE INSERT ON inbound_document_lines
WHEN EXISTS(SELECT 1 FROM system_maintenance WHERE id='global' AND mode<>'normal' AND expires_at>strftime('%Y-%m-%dT%H:%M:%fZ','now'))
BEGIN SELECT RAISE(ABORT,'guard_maintenance: system backup or migration is in progress'); END;

--> statement-breakpoint
CREATE TRIGGER maintenance_inbound_document_lines_update BEFORE UPDATE ON inbound_document_lines
WHEN EXISTS(SELECT 1 FROM system_maintenance WHERE id='global' AND mode<>'normal' AND expires_at>strftime('%Y-%m-%dT%H:%M:%fZ','now'))
BEGIN SELECT RAISE(ABORT,'guard_maintenance: system backup or migration is in progress'); END;

--> statement-breakpoint
CREATE TRIGGER maintenance_inbound_document_lines_delete BEFORE DELETE ON inbound_document_lines
WHEN EXISTS(SELECT 1 FROM system_maintenance WHERE id='global' AND mode<>'normal' AND expires_at>strftime('%Y-%m-%dT%H:%M:%fZ','now'))
BEGIN SELECT RAISE(ABORT,'guard_maintenance: system backup or migration is in progress'); END;
