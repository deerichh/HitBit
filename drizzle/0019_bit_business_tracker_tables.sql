CREATE TABLE `bit_business` (
	`id` integer PRIMARY KEY NOT NULL,
	`business_type` text NOT NULL,
	`custom_type` text,
	`name` text NOT NULL,
	`zones_json` text DEFAULT '[]' NOT NULL,
	`freezers_json` text DEFAULT '[]' NOT NULL,
	`colors_json` text DEFAULT '{}' NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `bit_items` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`name` text NOT NULL,
	`category` text NOT NULL,
	`zone` text NOT NULL,
	`on_hand` integer DEFAULT 0 NOT NULL,
	`unit` text DEFAULT 'units' NOT NULL,
	`par` integer DEFAULT 0 NOT NULL,
	`pack_size` integer DEFAULT 1 NOT NULL,
	`supplier` text,
	`sku` text,
	`tags_json` text DEFAULT '[]' NOT NULL,
	`sort_order` integer DEFAULT 0 NOT NULL,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `bit_items_name_unique` ON `bit_items` (`name`);
--> statement-breakpoint
CREATE TABLE `bit_rounds` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`counter_name` text NOT NULL,
	`zone_filter` text,
	`counted` integer NOT NULL,
	`total` integer NOT NULL,
	`variances_json` text DEFAULT '[]' NOT NULL,
	`below_par_json` text DEFAULT '[]' NOT NULL,
	`freezer_json` text DEFAULT '[]' NOT NULL,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `bit_manifest_scans` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`image_blob_key` text,
	`image_mime_type` text,
	`status` text DEFAULT 'pending' NOT NULL,
	`lines_json` text,
	`note` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
