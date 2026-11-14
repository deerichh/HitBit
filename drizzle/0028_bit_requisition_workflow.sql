ALTER TABLE bit_business ADD COLUMN uses_requisition integer NOT NULL DEFAULT 0;
--> statement-breakpoint
ALTER TABLE bit_business ADD COLUMN division text;
--> statement-breakpoint
ALTER TABLE bit_business ADD COLUMN duty_officer_name text;
--> statement-breakpoint
CREATE TABLE bit_requisitions (
  id integer PRIMARY KEY AUTOINCREMENT,
  business_id integer NOT NULL DEFAULT 1,
  req_no text NOT NULL,
  status text NOT NULL DEFAULT 'outstanding',
  sent_at integer NOT NULL,
  closed_at integer,
  created_at integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE bit_requisition_lines (
  id integer PRIMARY KEY AUTOINCREMENT,
  requisition_id integer NOT NULL,
  business_id integer NOT NULL DEFAULT 1,
  item_id integer,
  name text NOT NULL,
  material_no text,
  qty_ordered integer NOT NULL,
  unit text NOT NULL DEFAULT 'units',
  category text NOT NULL DEFAULT 'Other',
  status text NOT NULL DEFAULT 'pending',
  qty_received integer,
  superseded_by integer,
  created_at integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE bit_catalogue (
  id integer PRIMARY KEY AUTOINCREMENT,
  business_id integer NOT NULL DEFAULT 1,
  material_no text NOT NULL,
  description text NOT NULL,
  sort_order integer NOT NULL DEFAULT 0,
  created_at integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX bit_catalogue_business_material_unique ON bit_catalogue (business_id, material_no);
--> statement-breakpoint
CREATE TABLE bit_requisition_draft_extras (
  id integer PRIMARY KEY AUTOINCREMENT,
  business_id integer NOT NULL DEFAULT 1,
  catalogue_id integer NOT NULL,
  name text NOT NULL,
  material_no text,
  qty integer NOT NULL DEFAULT 1,
  unit text NOT NULL DEFAULT 'each',
  created_at integer NOT NULL
);
--> statement-breakpoint
UPDATE bit_business SET uses_requisition = 1 WHERE lower(name) LIKE 'tfs station 226%';
