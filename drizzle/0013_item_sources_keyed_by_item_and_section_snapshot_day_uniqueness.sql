CREATE TABLE `item_sources_new` (
	`item` text NOT NULL,
	`section` text DEFAULT '' NOT NULL,
	`url` text NOT NULL,
	`source_type` text NOT NULL,
	`store` text,
	`updated_date` text NOT NULL,
	`updated_at` integer NOT NULL,
	PRIMARY KEY(`item`, `section`)
);
--> statement-breakpoint
INSERT INTO `item_sources_new` (`item`, `section`, `url`, `source_type`, `store`, `updated_date`, `updated_at`) SELECT `item`, '', `url`, `source_type`, `store`, `updated_date`, `updated_at` FROM `item_sources`;
--> statement-breakpoint
DROP TABLE `item_sources`;
--> statement-breakpoint
ALTER TABLE `item_sources_new` RENAME TO `item_sources`;
--> statement-breakpoint
DELETE FROM `stock_snapshots` WHERE `id` NOT IN (SELECT MAX(`id`) FROM `stock_snapshots` GROUP BY `date`, `item`);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS `stock_snapshots_date_item_unique` ON `stock_snapshots` (`date`, `item`);
