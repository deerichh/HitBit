CREATE TABLE `receipt_scans` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`image_blob_key` text,
	`image_mime_type` text,
	`status` text DEFAULT 'pending' NOT NULL,
	`lines_json` text,
	`note` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `alerts` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`kind` text NOT NULL,
	`title` text NOT NULL,
	`body` text NOT NULL,
	`item` text,
	`read_at` integer,
	`dismissed_at` integer,
	`created_at` integer NOT NULL
);
