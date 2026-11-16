CREATE TABLE `bit_item_snapshots` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`business_id` integer DEFAULT 1 NOT NULL,
	`item_id` integer,
	`item_name` text NOT NULL,
	`category` text NOT NULL,
	`book_count` real NOT NULL,
	`counted` real NOT NULL,
	`par` integer DEFAULT 0 NOT NULL,
	`round_id` integer NOT NULL,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `bit_stock_events` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`business_id` integer DEFAULT 1 NOT NULL,
	`item_id` integer,
	`item_name` text NOT NULL,
	`delta` real NOT NULL,
	`source` text NOT NULL,
	`created_at` integer NOT NULL
);
