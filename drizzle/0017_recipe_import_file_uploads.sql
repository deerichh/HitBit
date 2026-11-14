ALTER TABLE `recipe_imports` ADD COLUMN `file_blob_key` text;
--> statement-breakpoint
ALTER TABLE `recipe_imports` ADD COLUMN `file_mime_type` text;
--> statement-breakpoint
ALTER TABLE `recipe_imports` ADD COLUMN `file_name` text;
