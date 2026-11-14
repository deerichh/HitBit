DROP TABLE entries;
--> statement-breakpoint
CREATE TABLE list_items (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  section TEXT NOT NULL,
  item TEXT NOT NULL,
  stock INTEGER NOT NULL,
  usual_store TEXT NOT NULL,
  best_price_raw TEXT,
  price_cents INTEGER,
  savings_note TEXT,
  buy_at TEXT,
  end_of_sale TEXT,
  exact_product TEXT,
  sort_order INTEGER NOT NULL
);
--> statement-breakpoint
CREATE TABLE list_meta (
  id INTEGER PRIMARY KEY,
  updated_stamp TEXT,
  refreshed_at INTEGER
);
--> statement-breakpoint
CREATE TABLE checked_items (
  item_key TEXT PRIMARY KEY,
  checked_at INTEGER NOT NULL
);
