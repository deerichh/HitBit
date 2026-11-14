CREATE TABLE `hit_added_items` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`category` text NOT NULL,
	`item` text NOT NULL,
	`stock` integer NOT NULL,
	`store` text NOT NULL,
	`formal_name` text,
	`sku` text,
	`price_status` text DEFAULT 'pending' NOT NULL,
	`sale_price_cents` integer,
	`sale_store` text,
	`sale_end` text,
	`regular_price_cents` integer,
	`regular_store` text,
	`alt_name` text,
	`alt_price_cents` integer,
	`alt_store` text,
	`price_note` text,
	`price_checked_at` integer,
	`synced_at` integer,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `hit_added_items_item_unique` ON `hit_added_items` (`item`);
