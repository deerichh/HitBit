ALTER TABLE `bit_business` ADD COLUMN `pos_intake_token` text;
--> statement-breakpoint
CREATE TABLE `bit_pos_transactions` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`item_id` integer,
	`item_name` text,
	`pos_ref` text NOT NULL,
	`quantity` integer NOT NULL,
	`source` text NOT NULL,
	`external_id` text,
	`matched` integer NOT NULL DEFAULT 1,
	`below_par` integer NOT NULL DEFAULT 0,
	`undone` integer NOT NULL DEFAULT 0,
	`resolved` integer NOT NULL DEFAULT 0,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `bit_pos_mappings` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`pos_ref` text NOT NULL,
	`item_id` integer NOT NULL,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `bit_pos_mappings_pos_ref_unique` ON `bit_pos_mappings` (`pos_ref`);
