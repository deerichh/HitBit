ALTER TABLE `bit_requisitions` ADD COLUMN `form_pdf_base64` text;
--> statement-breakpoint
ALTER TABLE `bit_requisitions` ADD COLUMN `form_page_count` integer;
--> statement-breakpoint
ALTER TABLE `bit_requisitions` ADD COLUMN `form_saved_at` integer;
