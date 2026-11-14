CREATE TABLE `item_sources` (
	`item` text PRIMARY KEY NOT NULL,
	`url` text NOT NULL,
	`source_type` text NOT NULL,
	`store` text,
	`updated_date` text NOT NULL,
	`updated_at` integer NOT NULL
);
