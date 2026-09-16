ALTER TABLE `production_batches` ADD `estimated_arrival_date` text;--> statement-breakpoint
ALTER TABLE `sku_settings` ADD `production_lead_days` integer DEFAULT 21 NOT NULL;--> statement-breakpoint
ALTER TABLE `sku_settings` ADD `sea_lead_days` integer DEFAULT 35 NOT NULL;--> statement-breakpoint
ALTER TABLE `sku_settings` ADD `review_cycle_days` integer DEFAULT 7 NOT NULL;--> statement-breakpoint
ALTER TABLE `sku_settings` ADD `service_level` real DEFAULT 0.95 NOT NULL;