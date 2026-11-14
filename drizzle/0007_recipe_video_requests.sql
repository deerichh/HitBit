CREATE TABLE `recipe_video_requests` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`recipe_name` text NOT NULL,
	`meal_type` text DEFAULT 'dinner' NOT NULL,
	`protein` text,
	`servings` integer DEFAULT 2 NOT NULL,
	`ingredients_json` text DEFAULT '[]' NOT NULL,
	`steps_json` text DEFAULT '[]' NOT NULL,
	`meal_id` integer,
	`meal_name` text,
	`status` text DEFAULT 'requested' NOT NULL,
	`video_url` text,
	`note` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
