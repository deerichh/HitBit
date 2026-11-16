CREATE TABLE `household_setup` (
	`id` integer PRIMARY KEY NOT NULL,
	`answers_json` text DEFAULT '{}' NOT NULL,
	`completed_at` integer
);
--> statement-breakpoint
ALTER TABLE `bit_business` ADD `team_size` text;
