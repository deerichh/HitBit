CREATE TABLE `account_settings` (
	`id` integer PRIMARY KEY NOT NULL,
	`acting_role` text DEFAULT 'primary' NOT NULL,
	`policy_json` text DEFAULT '{}' NOT NULL
);
--> statement-breakpoint
ALTER TABLE `stock_adjustments` ADD COLUMN `actor` text;
--> statement-breakpoint
ALTER TABLE `purchase_log` ADD COLUMN `actor` text;
--> statement-breakpoint
ALTER TABLE `usage_log` ADD COLUMN `actor` text;
--> statement-breakpoint
ALTER TABLE `receipt_scans` ADD COLUMN `actor` text;
--> statement-breakpoint
ALTER TABLE `alerts` ADD COLUMN `dismissed_by` text;
--> statement-breakpoint
ALTER TABLE `bit_stock_events` ADD COLUMN `actor` text;
--> statement-breakpoint
ALTER TABLE `bit_waste_log` ADD COLUMN `actor` text;
--> statement-breakpoint
ALTER TABLE `bit_manifest_imports` ADD COLUMN `actor` text;
--> statement-breakpoint
ALTER TABLE `bit_requisition_lines` ADD COLUMN `checked_off_by` text;
--> statement-breakpoint
ALTER TABLE `bit_pos_transactions` ADD COLUMN `actor` text;
