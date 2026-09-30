CREATE TABLE `business_reviews` (
	`id` text PRIMARY KEY NOT NULL,
	`owner_id` text NOT NULL,
	`owner_name` text NOT NULL,
	`site` text NOT NULL,
	`channel` text NOT NULL,
	`kind` text NOT NULL,
	`period_start` text NOT NULL,
	`period_end` text NOT NULL,
	`due_at` text NOT NULL,
	`status` text DEFAULT 'draft' NOT NULL,
	`version` integer DEFAULT 1 NOT NULL,
	`data_json` text DEFAULT '{}' NOT NULL,
	`snapshot_json` text DEFAULT '{}' NOT NULL,
	`review_note` text DEFAULT '' NOT NULL,
	`submitted_at` text,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `idx_business_review_period` ON `business_reviews` (`owner_id`,`kind`,`period_start`);--> statement-breakpoint
CREATE INDEX `idx_business_review_status` ON `business_reviews` (`status`,`due_at`);--> statement-breakpoint
CREATE TABLE `review_actions` (
	`id` text PRIMARY KEY NOT NULL,
	`report_id` text NOT NULL,
	`owner_id` text NOT NULL,
	`title` text NOT NULL,
	`target` text NOT NULL,
	`due_date` text NOT NULL,
	`priority` text NOT NULL,
	`status` text DEFAULT 'open' NOT NULL,
	`evidence` text DEFAULT '' NOT NULL,
	`review_note` text DEFAULT '' NOT NULL,
	`version` integer DEFAULT 1 NOT NULL,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL
);
--> statement-breakpoint
CREATE INDEX `idx_review_action_owner` ON `review_actions` (`owner_id`,`status`,`due_date`);