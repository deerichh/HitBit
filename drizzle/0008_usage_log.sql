CREATE TABLE `usage_log` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`item` text NOT NULL,
	`deducted` integer DEFAULT 0 NOT NULL,
	`used_some` integer DEFAULT 0 NOT NULL,
	`source` text NOT NULL,
	`meal_id` integer,
	`meal_name` text,
	`pick_id` integer,
	`pick_date` text,
	`created_at` integer NOT NULL,
	`undone` integer DEFAULT 0 NOT NULL,
	`undone_at` integer
);
