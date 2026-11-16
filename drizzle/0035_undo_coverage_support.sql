ALTER TABLE `stock_adjustments` ADD COLUMN `undone` integer DEFAULT 0 NOT NULL;
--> statement-breakpoint
ALTER TABLE `stock_adjustments` ADD COLUMN `undone_at` integer;
--> statement-breakpoint
ALTER TABLE `stock_adjustments` ADD COLUMN `receipt_scan_id` integer;
--> statement-breakpoint
ALTER TABLE `receipt_scans` ADD COLUMN `undone_at` integer;
--> statement-breakpoint
ALTER TABLE `bit_stock_events` ADD COLUMN `undone` integer DEFAULT 0 NOT NULL;
--> statement-breakpoint
ALTER TABLE `bit_waste_log` ADD COLUMN `undone` integer DEFAULT 0 NOT NULL;
--> statement-breakpoint
ALTER TABLE `bit_waste_log` ADD COLUMN `stock_deducted` real;
--> statement-breakpoint
CREATE TABLE `bit_manifest_imports` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`business_id` integer DEFAULT 1 NOT NULL,
	`scan_id` integer,
	`changes_json` text DEFAULT '[]' NOT NULL,
	`undone` integer DEFAULT 0 NOT NULL,
	`created_at` integer NOT NULL
);
