ALTER TABLE `meals` ADD COLUMN `meal_type` text DEFAULT 'dinner' NOT NULL;
--> statement-breakpoint
ALTER TABLE `picks` ADD COLUMN `meal_type` text DEFAULT 'dinner' NOT NULL;
--> statement-breakpoint
DROP INDEX `picks_date_unique`;
--> statement-breakpoint
ALTER TABLE `meal_matches` ADD COLUMN `meal_type` text DEFAULT 'dinner' NOT NULL;
--> statement-breakpoint
DROP INDEX `meal_matches_date_unique`;
