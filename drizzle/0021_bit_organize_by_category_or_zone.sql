ALTER TABLE `bit_business` ADD COLUMN `organize_by` text DEFAULT 'zone' NOT NULL;
--> statement-breakpoint
ALTER TABLE `bit_business` ADD COLUMN `categories_json` text DEFAULT '[]' NOT NULL;
