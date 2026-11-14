CREATE TABLE `purchase_log` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`item` text NOT NULL,
	`quantity` integer NOT NULL,
	`adjustment_id` integer,
	`created_at` integer NOT NULL,
	`undone` integer DEFAULT 0 NOT NULL,
	`undone_at` integer
);
--> statement-breakpoint
INSERT INTO `purchase_log` (`item`, `quantity`, `adjustment_id`, `created_at`, `undone`)
SELECT `item`, `delta`, `id`, `created_at`, 0 FROM `stock_adjustments` WHERE `source` = 'finish-shop';
--> statement-breakpoint
CREATE TABLE `item_expiries` (
	`item` text PRIMARY KEY NOT NULL,
	`expiry_date` text NOT NULL,
	`updated_at` integer NOT NULL
);
