ALTER TABLE `bit_business` ADD COLUMN `approver_name` text;
--> statement-breakpoint
ALTER TABLE `bit_business` ADD COLUMN `approver_recorded_at` integer;
--> statement-breakpoint
ALTER TABLE `bit_business` ADD COLUMN `preparer_recorded_at` integer;
--> statement-breakpoint
ALTER TABLE `bit_requisitions` ADD COLUMN `prepared_by` text;
--> statement-breakpoint
ALTER TABLE `bit_requisitions` ADD COLUMN `prepared_at` integer;
--> statement-breakpoint
ALTER TABLE `bit_requisitions` ADD COLUMN `approved_by` text;
--> statement-breakpoint
ALTER TABLE `bit_requisitions` ADD COLUMN `approved_at` integer;
