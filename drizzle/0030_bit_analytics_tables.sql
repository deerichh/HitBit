CREATE TABLE `bit_analytics_months` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`business_id` integer DEFAULT 1 NOT NULL,
	`month_key` text NOT NULL,
	`label` text NOT NULL,
	`days_open` integer NOT NULL,
	`transactions` integer NOT NULL,
	`units_sold` integer NOT NULL,
	`revenue` real NOT NULL,
	`cogs` real NOT NULL,
	`waste_cost` real NOT NULL,
	`gross_profit` real NOT NULL,
	`net_profit` real NOT NULL,
	`orders_placed` integer NOT NULL,
	`stockout_events` integer NOT NULL,
	`ending_inventory_value` real NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `bit_analytics_months_business_month_unique` ON `bit_analytics_months` (`business_id`,`month_key`);
--> statement-breakpoint
CREATE TABLE `bit_analytics_menu` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`business_id` integer DEFAULT 1 NOT NULL,
	`name` text NOT NULL,
	`units` integer NOT NULL,
	`revenue` real NOT NULL,
	`sort_order` integer DEFAULT 0 NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `bit_analytics_menu_business_name_unique` ON `bit_analytics_menu` (`business_id`,`name`);
--> statement-breakpoint
CREATE TABLE `bit_analytics_summary` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`business_id` integer DEFAULT 1 NOT NULL,
	`label` text NOT NULL,
	`period_label` text NOT NULL,
	`lost_revenue` real NOT NULL,
	`lost_units` integer NOT NULL,
	`stockout_events` integer NOT NULL,
	`waste_json` text DEFAULT '[]' NOT NULL,
	`item_costs_json` text DEFAULT '{}' NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `bit_analytics_summary_business_unique` ON `bit_analytics_summary` (`business_id`);
