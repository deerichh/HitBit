ALTER TABLE `bit_items` ADD COLUMN `business_id` integer DEFAULT 1 NOT NULL;
--> statement-breakpoint
ALTER TABLE `bit_rounds` ADD COLUMN `business_id` integer DEFAULT 1 NOT NULL;
--> statement-breakpoint
ALTER TABLE `bit_manifest_scans` ADD COLUMN `business_id` integer DEFAULT 1 NOT NULL;
--> statement-breakpoint
ALTER TABLE `bit_pos_transactions` ADD COLUMN `business_id` integer DEFAULT 1 NOT NULL;
--> statement-breakpoint
ALTER TABLE `bit_pos_mappings` ADD COLUMN `business_id` integer DEFAULT 1 NOT NULL;
--> statement-breakpoint
ALTER TABLE `bit_pos_sync_runs` ADD COLUMN `business_id` integer DEFAULT 1 NOT NULL;
--> statement-breakpoint
DROP INDEX `bit_items_name_unique`;
--> statement-breakpoint
CREATE UNIQUE INDEX `bit_items_business_name_unique` ON `bit_items` (`business_id`, `name`);
--> statement-breakpoint
DROP INDEX `bit_pos_mappings_pos_ref_unique`;
--> statement-breakpoint
CREATE UNIQUE INDEX `bit_pos_mappings_business_pos_ref_unique` ON `bit_pos_mappings` (`business_id`, `pos_ref`);
