CREATE TABLE `bit_pos_sync_runs` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`provider` text NOT NULL,
	`status` text NOT NULL,
	`day_key` text,
	`orders_seen` integer NOT NULL DEFAULT 0,
	`lines_applied` integer NOT NULL DEFAULT 0,
	`lines_unmatched` integer NOT NULL DEFAULT 0,
	`duplicates` integer NOT NULL DEFAULT 0,
	`error` text,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
ALTER TABLE `bit_business` ADD COLUMN `pos_sync_requested_at` integer;
--> statement-breakpoint
ALTER TABLE `bit_business` ADD COLUMN `pos_sku_cache_json` text;
