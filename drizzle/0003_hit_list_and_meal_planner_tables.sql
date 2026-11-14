CREATE TABLE `hit_items` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`category` text NOT NULL,
	`item` text NOT NULL,
	`stock` integer NOT NULL,
	`store` text NOT NULL,
	`sort_order` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `hit_meta` (
	`id` integer PRIMARY KEY NOT NULL,
	`refreshed_at` integer
);
--> statement-breakpoint
CREATE TABLE `meals` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`name` text NOT NULL,
	`note` text,
	`sort_order` integer DEFAULT 0 NOT NULL,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `meal_proteins` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`meal_id` integer NOT NULL REFERENCES `meals`(`id`),
	`label` text NOT NULL,
	`sheet_name` text NOT NULL,
	`group_index` integer DEFAULT 0 NOT NULL,
	`sort_order` integer DEFAULT 0 NOT NULL
);
--> statement-breakpoint
CREATE TABLE `meal_ingredients` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`meal_id` integer NOT NULL REFERENCES `meals`(`id`),
	`name` text NOT NULL,
	`quantity` real,
	`unit` text,
	`sort_order` integer DEFAULT 0 NOT NULL
);
--> statement-breakpoint
CREATE TABLE `shopping_flags` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`sheet_name` text NOT NULL,
	`flagged_at` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `shopping_flags_sheet_name_unique` ON `shopping_flags` (`sheet_name`);
--> statement-breakpoint
CREATE TABLE `picks` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`date` text NOT NULL,
	`meal_id` integer NOT NULL REFERENCES `meals`(`id`),
	`protein_id` integer REFERENCES `meal_proteins`(`id`),
	`servings` integer DEFAULT 2 NOT NULL,
	`variant` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `picks_date_unique` ON `picks` (`date`);
--> statement-breakpoint
CREATE TABLE `meal_matches` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`date` text NOT NULL,
	`meal_id` integer NOT NULL,
	`meal_name` text NOT NULL,
	`dismissed` integer DEFAULT 0 NOT NULL,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `meal_matches_date_unique` ON `meal_matches` (`date`);
