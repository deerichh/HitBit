CREATE TABLE `web_recipe_loads` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`url` text NOT NULL,
	`status` text DEFAULT 'pending' NOT NULL,
	`title` text,
	`servings` integer,
	`ingredients_json` text,
	`steps_json` text,
	`note` text,
	`created_at` integer NOT NULL,
	`resolved_at` integer
);
--> statement-breakpoint
CREATE UNIQUE INDEX `web_recipe_loads_url_unique` ON `web_recipe_loads` (`url`);
--> statement-breakpoint
CREATE TABLE `meal_sources` (
	`meal_id` integer PRIMARY KEY NOT NULL,
	`source_name` text NOT NULL,
	`source_site` text NOT NULL,
	`source_url` text NOT NULL,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
ALTER TABLE `recipe_video_requests` ADD `source_name` text;
--> statement-breakpoint
ALTER TABLE `recipe_video_requests` ADD `source_site` text;
--> statement-breakpoint
ALTER TABLE `recipe_video_requests` ADD `source_url` text;
