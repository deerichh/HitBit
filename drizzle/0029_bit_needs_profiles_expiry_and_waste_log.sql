ALTER TABLE bit_items ADD COLUMN expiry_date text;
--> statement-breakpoint
CREATE TABLE bit_waste_log (
  id integer PRIMARY KEY AUTOINCREMENT,
  business_id integer NOT NULL DEFAULT 1,
  item_id integer,
  item_name text NOT NULL,
  unit text NOT NULL DEFAULT 'units',
  quantity integer NOT NULL,
  reason text NOT NULL DEFAULT 'Spoilage',
  created_at integer NOT NULL
);
