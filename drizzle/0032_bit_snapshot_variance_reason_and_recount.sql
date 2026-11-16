ALTER TABLE `bit_item_snapshots` ADD COLUMN `variance_reason` text;
--> statement-breakpoint
ALTER TABLE `bit_item_snapshots` ADD COLUMN `recounted` integer DEFAULT 0 NOT NULL;
