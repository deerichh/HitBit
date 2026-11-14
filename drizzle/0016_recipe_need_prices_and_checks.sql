CREATE TABLE `recipe_need_prices` (
	`meal_id` integer NOT NULL,
	`ingredient_key` text NOT NULL,
	`ingredient` text NOT NULL,
	`status` text DEFAULT 'pending' NOT NULL,
	`sale_price_cents` integer,
	`sale_store` text,
	`sale_end` text,
	`regular_price_cents` integer,
	`regular_store` text,
	`note` text,
	`source_url` text,
	`source_type` text,
	`checked_at` integer,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	PRIMARY KEY(`meal_id`, `ingredient_key`)
);
--> statement-breakpoint
CREATE TABLE `recipe_need_checks` (
	`need_key` text PRIMARY KEY NOT NULL,
	`checked` integer DEFAULT 1 NOT NULL,
	`checked_at` integer NOT NULL
);
