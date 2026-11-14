CREATE TABLE `stock_adjustments` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`item` text NOT NULL,
	`delta` integer NOT NULL,
	`source` text NOT NULL,
	`created_at` integer NOT NULL,
	`applied_at` integer
);
--> statement-breakpoint
CREATE TABLE `watched_items` (
	`item` text PRIMARY KEY NOT NULL,
	`watched_at` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `stock_snapshots` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`date` text NOT NULL,
	`item` text NOT NULL,
	`stock` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `stock_snapshots_date_item_unique` ON `stock_snapshots` (`date`,`item`);
--> statement-breakpoint
CREATE TABLE `price_observations` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`item` text NOT NULL,
	`price_cents` integer NOT NULL,
	`store` text,
	`date` text NOT NULL,
	`observed_at` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `barcode_lookups` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`code` text NOT NULL,
	`status` text DEFAULT 'pending' NOT NULL,
	`formal_name` text,
	`note` text,
	`created_at` integer NOT NULL,
	`resolved_at` integer
);
--> statement-breakpoint
CREATE UNIQUE INDEX `barcode_lookups_code_unique` ON `barcode_lookups` (`code`);
--> statement-breakpoint
CREATE TABLE `recipe_imports` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`url` text NOT NULL,
	`status` text DEFAULT 'pending' NOT NULL,
	`ingredients_json` text,
	`note` text,
	`created_at` integer NOT NULL,
	`resolved_at` integer
);
