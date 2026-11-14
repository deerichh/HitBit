// Drizzle schema for this space.
//
// Shopping List tab:
//   list_items    — one cached row per Shopping List row from the
//                   HIT-VANDERLANCAL Google Sheet (the sheet is the
//                   system of record; saveList replaces these wholesale).
//   list_meta     — single-row metadata: the sheet's "Updated …" stamp
//                   and when the last refresh landed.
//   checked_items — local check-off state (items the user has purchased),
//                   keyed by section + item so it survives refreshes.
//                   The row carries a checked flag rather than being
//                   deleted on un-check, so restocked_at — set when
//                   that item's on-row "Purchased" button has been
//                   confirmed (its −/+ counter quantity recorded as
//                   a pending stock adjustment) — survives an
//                   un-check / re-check within the same list: a
//                   confirmed item shows "Purchased ✓" again when
//                   re-checked and can't be recorded twice. Rows are
//                   still pruned by saveList when an item leaves the
//                   list, so a new list cycle starts unconfirmed.
//
// HIT List tab:
//   hit_items     — one cached row per item on the sheet's "HIT List"
//                   tab (Category | Item Name | Stock | Store), the
//                   household inventory; saveHitList replaces wholesale.
//   hit_meta      — single-row metadata: when the last HIT refresh
//                   landed. The Meal Planner tab reads its protein
//                   stock from hit_items, so one refresh feeds both.
//   hit_added_items — items added in the app (the sheet connection is
//                   read-only, so adds can't be written back). They
//                   merge into getHitList alongside the sheet cache
//                   and carry the formal product name / SKU the user
//                   typed, the automatic Flipp/website price check
//                   results (price_check_started_at stamps when the
//                   current check began; getHitList fails a check
//                   still pending ten minutes later — its task never
//                   reported back), and a synced_at stamp for the
//                   Vanessa app-sync outbox (null = still to be
//                   included in the updates between the two apps).
//
// Meal Planner tab (ported from the standalone Meal Planner app):
//   meals / meal_proteins / meal_ingredients / picks / meal_matches /
//   shopping_flags — meal ideas with protein option groups (options
//   inside a group are interchangeable; a meal needs one in-stock
//   option per group), structured ingredient lists (quantities for 2
//   people), picks per calendar date, same-meal match records for the
//   heart popup, and proteins flagged for shopping. Every meal idea
//   and every pick carries a meal type — "breakfast", "lunch",
//   "dinner", or "snack" (meals.meal_type / picks.meal_type). A day
//   can hold up to 5 picks in any mix of types (enforced in setPick);
//   several picks may share a type. Picks and matches are addressed
//   by row id / (date, meal_type) — a date alone no longer identifies
//   a pick. Pre-existing rows were migrated to type "dinner".
//   Protein stock is NOT duplicated here: it is looked up from
//   hit_items by exact Item Name (meal_proteins.sheetName).
//
//   web_recipe_loads   — parsed copies of the curated web recipes
//                        the Recipe generator offers per protein
//                        (RecipeTin Eats / BBC Good Food /
//                        Allrecipes). A background agent task reads
//                        the page once and hands the dish title,
//                        stated servings, ingredients (at those
//                        servings) and steps back via
//                        saveWebRecipeLoad; generateRecipe reads the
//                        cached parse and falls back to its
//                        inventory-built recipe when a load failed.
//   meal_sources       — the web source (dish name, site, URL) of a
//                        Meal List meal saved from a generated web
//                        recipe. Local display metadata only — it
//                        never enters the MEAL-SYNC format; it is
//                        attached to the meal's Recipe videos entry
//                        when a cooking video is requested for it.
//
//   item_sources       — where each Shopping List price was found:
//                        the exact URL the price was verified on
//                        (a Flipp flyer/item URL for "flipp", the
//                        store product-page URL for "website"),
//                        keyed by item name + section so the record
//                        survives saveList refreshes and an item
//                        listed in two sections keeps a source per
//                        row. The grocery scan jobs
//                        record them via setItemSource when they
//                        write the Shopping List; getList joins them
//                        onto rows by name + canonical section.
//
// Later additions:
//   stock_adjustments  — pending app-side stock changes (Finish shop
//                        restocks + HIT +/− steppers) the auto-scan
//                        applies to the sheet; effective stock =
//                        sheet stock + unapplied deltas everywhere.
//   watched_items      — sale-watch stars by item name.
//   stock_snapshots    — one stock snapshot per item per day, the
//                        basis for run-out forecasts.
//   price_observations — dated best-price log per Shopping List item,
//                        the basis for lowest-seen price trends.
//   barcode_lookups    — scan-to-add code resolutions.
//   recipe_imports     — recipe-link ingredient import drafts.
//   recipe_video_requests — cooking-video requests (full recipe
//                        snapshots) fulfilled externally by Muse;
//                        listed by the Media tab.
//   usage_log          — explicit usage records (the Meal Planner
//                        calendar's per-pick "Eaten ✓" button, which
//                        logs the meal's proteins at recipe amounts;
//                        the HIT List's old per-item quick-use also
//                        wrote here before it was removed. Picking
//                        a meal never writes here; only an Eaten
//                        tap does. Deductions
//                        also write pending stock_adjustments (source
//                        "usage"); undo writes a reversing adjustment
//                        (source "usage-undo") and marks the entry
//                        undone. Learned defaults are derived from the
//                        most recent non-undone deduction per
//                        (meal, item) and per item.
//   purchase_log       — one row per confirmed Shopping List
//                        purchase (written by confirmPurchased
//                        alongside its "finish-shop" stock
//                        adjustment, linked by adjustment_id). Feeds
//                        the HIT List Activity log next to usage_log
//                        and gives purchases an Undo: undoing deletes
//                        the linked adjustment while it is still
//                        pending, or records a compensating negative
//                        adjustment (source "purchase-undo") once the
//                        auto-scan has applied it.
//   item_expiries      — one optional expiry date ("YYYY-MM-DD") per
//                        HIT List item, keyed by item name. App-side
//                        display data only (the use-soon chip and the
//                        Expiring soon panel) — never written to the
//                        sheet and never synced.
//
// Additions build 2:
//   receipt_scans      — store-receipt photo quick-restock scan
//                        requests (shown in the app as "Receipt
//                        scans"). requestReceiptScan
//                        stores the uploaded receipt photo in
//                        ctx.blobs (only its key +
//                        MIME type live here) and the row sits at
//                        status "pending" until an external process
//                        (Muse, on a schedule, like the recipe-video
//                        pipeline) reads the photo via
//                        getPendingReceiptScans and writes a proposed
//                        restock list back through
//                        setReceiptScanResult (status "proposed"):
//                        lines_json is an array of { receiptText,
//                        item, quantity } — item is the matched HIT
//                        List item name, or null for a receipt line
//                        that matched nothing. The user reviews the
//                        proposal in the app (quantities editable,
//                        lines removable) and ONLY confirmReceiptScan
//                        records anything: one pending
//                        stock_adjustments row per confirmed line
//                        (source "receipt"), and the status becomes
//                        "confirmed". dismissReceiptScan moves a
//                        pending/proposed scan to "dismissed" and
//                        records nothing.
//   alerts             — the in-app alerts feed: rows written by
//                        external jobs (Muse's scans) via addAlert
//                        (kind "sale" | "scan" | "info", title, body,
//                        optional item name) and read in the app via
//                        getAlerts; opening the list marks alerts
//                        read (read_at), dismissAlert stamps
//                        dismissed_at. Display only — alerts never
//                        change inventory, and never sync.

import {
integer,
primaryKey,
real,
sqliteTable,
text,
uniqueIndex,
} from "drizzle-orm/sqlite-core";

export const listItems = sqliteTable("list_items", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  section: text("section").notNull(),
  item: text("item").notNull(),
  stock: integer("stock").notNull(),
  usualStore: text("usual_store").notNull(),
  bestPriceRaw: text("best_price_raw"),
  priceCents: integer("price_cents"),
  savingsNote: text("savings_note"),
  buyAt: text("buy_at"),
  endOfSale: text("end_of_sale"),
  exactProduct: text("exact_product"),
  sortOrder: integer("sort_order").notNull(),
});

export const listMeta = sqliteTable("list_meta", {
  id: integer("id").primaryKey(),
  updatedStamp: text("updated_stamp"),
  refreshedAt: integer("refreshed_at", { mode: "timestamp_ms" }),
});

export const checkedItems = sqliteTable("checked_items", {
  itemKey: text("item_key").primaryKey(),
  // 1 = currently struck off the list; 0 = un-struck. Kept as a flag
  // (instead of deleting the row) so the restocked confirmation
  // below survives an un-check / re-check.
  checked: integer("checked").notNull().default(1),
  checkedAt: integer("checked_at", { mode: "timestamp_ms" })
    .notNull()
    .$defaultFn(() => new Date()),
  // Set by confirmPurchased once this item's bought quantity has
  // been recorded into the inventory; null = not yet confirmed.
  restockedAt: integer("restocked_at", { mode: "timestamp_ms" }),
});

export const hitItems = sqliteTable("hit_items", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  category: text("category").notNull(),
  item: text("item").notNull(),
  stock: integer("stock").notNull(),
  store: text("store").notNull(),
  sortOrder: integer("sort_order").notNull(),
});

export const hitMeta = sqliteTable("hit_meta", {
  id: integer("id").primaryKey(),
  refreshedAt: integer("refreshed_at", { mode: "timestamp_ms" }),
});

export const hitAddedItems = sqliteTable("hit_added_items", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  category: text("category").notNull(),
  item: text("item").notNull().unique(),
  stock: integer("stock").notNull(),
  store: text("store").notNull(),
  formalName: text("formal_name"),
  sku: text("sku"),
  // "pending" (check not finished) | "done" | "failed"
  priceStatus: text("price_status").notNull().default("pending"),
  // When the current price check was started (the add, or the
  // latest Recheck). getHitList fails a check still "pending" long
  // past this — its task never reported back — so the item doesn't
  // show "Price check running…" (and keep the tab polling) forever.
  priceCheckStartedAt: integer("price_check_started_at", {
    mode: "timestamp_ms",
  }),
  salePriceCents: integer("sale_price_cents"),
  saleStore: text("sale_store"),
  saleEnd: text("sale_end"),
  regularPriceCents: integer("regular_price_cents"),
  regularStore: text("regular_store"),
  altName: text("alt_name"),
  altPriceCents: integer("alt_price_cents"),
  altStore: text("alt_store"),
  priceNote: text("price_note"),
  priceCheckedAt: integer("price_checked_at", { mode: "timestamp_ms" }),
  syncedAt: integer("synced_at", { mode: "timestamp_ms" }),
  createdAt: integer("created_at", { mode: "timestamp_ms" })
    .notNull()
    .$defaultFn(() => new Date()),
});

export const meals = sqliteTable("meals", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  name: text("name").notNull(),
  note: text("note"),
  // "breakfast" | "lunch" | "dinner" | "snack" — which meal of the
  // day this idea is for. Existing ideas predate the column and are
  // all dinners (the migration default).
  mealType: text("meal_type").notNull().default("dinner"),
  sortOrder: integer("sort_order").notNull().default(0),
  createdAt: integer("created_at", { mode: "timestamp_ms" })
    .notNull()
    .$defaultFn(() => new Date()),
});

export const mealProteins = sqliteTable("meal_proteins", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  mealId: integer("meal_id")
    .notNull()
    .references(() => meals.id),
  label: text("label").notNull(),
  sheetName: text("sheet_name").notNull(),
  groupIndex: integer("group_index").notNull().default(0),
  sortOrder: integer("sort_order").notNull().default(0),
});

export const mealIngredients = sqliteTable("meal_ingredients", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  mealId: integer("meal_id")
    .notNull()
    .references(() => meals.id),
  name: text("name").notNull(),
  quantity: real("quantity"),
  unit: text("unit"),
  sortOrder: integer("sort_order").notNull().default(0),
});

export const shoppingFlags = sqliteTable("shopping_flags", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  sheetName: text("sheet_name").notNull().unique(),
  flaggedAt: integer("flagged_at", { mode: "timestamp_ms" })
    .notNull()
    .$defaultFn(() => new Date()),
});

export const picks = sqliteTable("picks", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  date: text("date").notNull(),
  // "breakfast" | "lunch" | "dinner" | "snack". A day holds up to 5
  // picks (enforced in setPick) in any mix of types.
  mealType: text("meal_type").notNull().default("dinner"),
  mealId: integer("meal_id")
    .notNull()
    .references(() => meals.id),
  proteinId: integer("protein_id").references(() => mealProteins.id),
  servings: integer("servings").notNull().default(2),
  variant: text("variant"),
  createdAt: integer("created_at", { mode: "timestamp_ms" })
    .notNull()
    .$defaultFn(() => new Date()),
  updatedAt: integer("updated_at", { mode: "timestamp_ms" })
    .notNull()
    .$defaultFn(() => new Date()),
});

export const mealMatches = sqliteTable("meal_matches", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  date: text("date").notNull(),
  // The meal type of the pick this match celebrates; a date can hold
  // one match per type.
  mealType: text("meal_type").notNull().default("dinner"),
  mealId: integer("meal_id").notNull(),
  mealName: text("meal_name").notNull(),
  dismissed: integer("dismissed").notNull().default(0),
  createdAt: integer("created_at", { mode: "timestamp_ms" })
    .notNull()
    .$defaultFn(() => new Date()),
});

// ---- Stock adjustments, watch stars, forecasts, price trends ------
// The sheet connection is read-only, so stock changes made in the app
// (the Shopping List per-item "Purchased" confirmations and the HIT
// List +/− steppers) are recorded as pending adjustments. The app shows
// effective stock = sheet stock + unapplied deltas; Muse's 2-hour
// auto-scan applies them to the sheet via
// getPendingStockAdjustments / markStockAdjustmentsApplied, mirroring
// the app-added items' pending-sync outbox.
export const stockAdjustments = sqliteTable("stock_adjustments", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  item: text("item").notNull(),
  delta: integer("delta").notNull(),
  // "finish-shop" | "quick-adjust" | "usage" | "usage-undo" |
  // "stocktake" | "purchase-undo" | "receipt"
  source: text("source").notNull(),
  createdAt: integer("created_at", { mode: "timestamp_ms" })
    .notNull()
    .$defaultFn(() => new Date()),
  appliedAt: integer("applied_at", { mode: "timestamp_ms" }),
});

// Sale-watch stars: item names the household wants sale-checked
// regardless of stock level. Keyed by item name so the set survives
// sheet refreshes.
export const watchedItems = sqliteTable("watched_items", {
  item: text("item").primaryKey(),
  watchedAt: integer("watched_at", { mode: "timestamp_ms" })
    .notNull()
    .$defaultFn(() => new Date()),
});

// One stock snapshot per item per day (Toronto date), recorded by
// saveHitList, pruned to the last ~60 days. Run-out forecasts are
// estimated from declines between snapshots — nothing is forecast
// without at least two snapshots showing change. The unique index
// on (date, item) makes the one-row-per-item-per-day rule structural:
// saveHitList upserts against it, so repeated refreshes on the same
// day can never pile up duplicate rows for a day.
export const stockSnapshots = sqliteTable(
  "stock_snapshots",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    date: text("date").notNull(),
    item: text("item").notNull(),
    stock: integer("stock").notNull(),
  },
  (t) => [
    uniqueIndex("stock_snapshots_date_item_unique").on(t.date, t.item),
  ],
);

// One row per dated price observation from saveList (item's numeric
// best price + buy-at store), so the Shopping List can show the
// lowest price seen and a trend vs the previous observation. The log
// starts empty and only grows from real refreshes.
export const priceObservations = sqliteTable("price_observations", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  item: text("item").notNull(),
  priceCents: integer("price_cents").notNull(),
  store: text("store"),
  date: text("date").notNull(),
  observedAt: integer("observed_at", { mode: "timestamp_ms" })
    .notNull()
    .$defaultFn(() => new Date()),
});

// Where a Shopping List item's price was found: the exact page the
// price was verified on. Keyed by item name + section (composite
// primary key) in its own table — NOT on list_items — because
// saveList replaces list_items wholesale on every sheet refresh and
// recorded sources must survive that. The section half matters
// because the same inventory item can sit in two sections at once
// (Out of Stock + Membership Alternatives) with a different price
// verified on a different page per row; `section` holds the
// canonical section title ("Out of Stock", "Low Stock on Sale Now",
// "Membership Alternatives") or the row's own title when it matches
// none of those. Rows recorded before section keying carry section
// "" and act as a legacy fallback for the item in any section.
// getList matches rows to sources by (item name, canonical section),
// trimmed + case-insensitive, falling back to a legacy "" row.
export const itemSources = sqliteTable(
  "item_sources",
  {
    item: text("item").notNull(),
    // Canonical section title of the Shopping List row this source
    // belongs to; "" for rows recorded before section keying.
    section: text("section").notNull().default(""),
    url: text("url").notNull(),
    // "flipp" | "website"
    sourceType: text("source_type", { enum: ["flipp", "website"] }).notNull(),
    store: text("store"),
    // Toronto date key ("2026-11-13") the source was last recorded.
    updatedDate: text("updated_date").notNull(),
    updatedAt: integer("updated_at", { mode: "timestamp_ms" })
      .notNull()
      .$defaultFn(() => new Date()),
  },
  (t) => [primaryKey({ columns: [t.item, t.section] })],
);

// Barcode lookups for the Add Item form's scan-to-add: a scanned /
// typed code is checked against known SKUs first, then resolved by a
// background agent task (saveBarcodeLookup hand-back). A lookup never
// saves an item by itself — the form is pre-filled for confirmation.
export const barcodeLookups = sqliteTable("barcode_lookups", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  code: text("code").notNull().unique(),
  // "pending" | "done" | "failed"
  status: text("status").notNull().default("pending"),
  formalName: text("formal_name"),
  note: text("note"),
  createdAt: integer("created_at", { mode: "timestamp_ms" })
    .notNull()
    .$defaultFn(() => new Date()),
  resolvedAt: integer("resolved_at", { mode: "timestamp_ms" }),
});

// Recipe-link ingredient imports: previewRecipeImport starts a
// background task that reads the recipe page and hands a draft
// ingredient list (quantities for 2 people, uncertain amounts
// flagged) back through saveRecipeImport. The user reviews the draft
// in the ingredient editor; saving still goes through
// setMealIngredients. File uploads ride the SAME table and hand-back:
// startRecipeFileImport stores the uploaded file in ctx.blobs (its
// key + MIME type + original name live in the file_* columns; url is
// "" for file rows) and spawns a reader task that opens the file via
// getPendingRecipeFileImports and hands the draft back through the
// same saveRecipeImport.
export const recipeImports = sqliteTable("recipe_imports", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  url: text("url").notNull(),
  // File-upload rows only: the blob key of the stored upload, its
  // MIME type, and the original file name. Null on link rows.
  fileBlobKey: text("file_blob_key"),
  fileMimeType: text("file_mime_type"),
  fileName: text("file_name"),
  // "pending" | "done" | "failed"
  status: text("status").notNull().default("pending"),
  // JSON array of { name, quantity, unit, uncertain }
  ingredientsJson: text("ingredients_json"),
  note: text("note"),
  createdAt: integer("created_at", { mode: "timestamp_ms" })
    .notNull()
    .$defaultFn(() => new Date()),
  resolvedAt: integer("resolved_at", { mode: "timestamp_ms" }),
});

// Cooking-video requests: the app can't render video, so "Make the
// cooking video" stores a full snapshot of the recipe (name, meal
// type, protein, servings, ingredients with quantities, walkthrough
// steps, and the linked meal id/name when the recipe has been saved
// to the Meal List). Muse picks requests up via
// getPendingVideoRequests, generates the reel-style video externally
// (vertical, under 5 minutes, all ingredients shown, steps walked
// through), and marks it ready with setRecipeVideoStatus. Requests
// are matched by recipe name, so saving a recipe after requesting
// its video links the same entry instead of duplicating it. The
// Media tab lists these rows.
export const usageLog = sqliteTable("usage_log", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  item: text("item").notNull(),
  deducted: integer("deducted").notNull().default(0),
  // 1 when the user marked "Used some" (partial use, no deduction).
  usedSome: integer("used_some").notNull().default(0),
  // Human-readable source: e.g. "Spaghetti · 2026-11-15" or "manual".
  source: text("source").notNull(),
  mealId: integer("meal_id"),
  mealName: text("meal_name"),
  pickId: integer("pick_id"),
  pickDate: text("pick_date"),
  createdAt: integer("created_at", { mode: "timestamp_ms" })
    .notNull()
    .$defaultFn(() => new Date()),
  undone: integer("undone").notNull().default(0),
  undoneAt: integer("undone_at", { mode: "timestamp_ms" }),
});

export const recipeVideoRequests = sqliteTable("recipe_video_requests", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  recipeName: text("recipe_name").notNull(),
  mealType: text("meal_type").notNull().default("dinner"),
  protein: text("protein"),
  servings: integer("servings").notNull().default(2),
  // JSON array of { name, quantity, unit } — quantities as they
  // should appear on screen (scaled to `servings`).
  ingredientsJson: text("ingredients_json").notNull().default("[]"),
  // JSON array of walkthrough step strings, in order.
  stepsJson: text("steps_json").notNull().default("[]"),
  mealId: integer("meal_id"),
  mealName: text("meal_name"),
  // "requested" | "ready"
  status: text("status").notNull().default("requested"),
  videoUrl: text("video_url"),
  note: text("note"),
  // Web source of the recipe when it came from one of the curated
  // recipe sites (the generator's per-protein table): the dish name
  // on the site, the site name, and the exact recipe URL. Null for
  // inventory-built recipes. Local display metadata only.
  sourceName: text("source_name"),
  sourceSite: text("source_site"),
  sourceUrl: text("source_url"),
  createdAt: integer("created_at", { mode: "timestamp_ms" })
    .notNull()
    .$defaultFn(() => new Date()),
  updatedAt: integer("updated_at", { mode: "timestamp_ms" })
    .notNull()
    .$defaultFn(() => new Date()),
});

// Parsed web recipes for the Recipe generator, one row per curated
// URL. generateRecipe inserts a "pending" row and starts a
// background agent task that reads the page (the same machinery as
// the recipe-link import); the task hands the parsed recipe back
// through saveWebRecipeLoad. Ingredients are stored at the recipe's
// own stated servings — the client scales them to the number of
// people chosen. A "failed" row (page blocked / no structured
// recipe) is retried only once it is more than a day old.
export const webRecipeLoads = sqliteTable("web_recipe_loads", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  url: text("url").notNull().unique(),
  // "pending" | "done" | "failed"
  status: text("status").notNull().default("pending"),
  // The dish title as it appears on the page.
  title: text("title"),
  // How many people the page says the recipe serves (null when the
  // page doesn't state it).
  servings: integer("servings"),
  // JSON array of { name, quantity, unit } at `servings`.
  ingredientsJson: text("ingredients_json"),
  // JSON array of walkthrough step strings, in order.
  stepsJson: text("steps_json"),
  note: text("note"),
  createdAt: integer("created_at", { mode: "timestamp_ms" })
    .notNull()
    .$defaultFn(() => new Date()),
  resolvedAt: integer("resolved_at", { mode: "timestamp_ms" }),
});

// The web source of a Meal List meal that was saved from a generated
// web recipe. Keyed by meal id. Shown only on the meal's Recipe
// videos entry (attached by requestRecipeVideo); Meal List rows
// themselves don't display it, and it never syncs.
export const mealSources = sqliteTable("meal_sources", {
  mealId: integer("meal_id").primaryKey(),
  sourceName: text("source_name").notNull(),
  sourceSite: text("source_site").notNull(),
  sourceUrl: text("source_url").notNull(),
  createdAt: integer("created_at", { mode: "timestamp_ms" })
    .notNull()
    .$defaultFn(() => new Date()),
});

// One row per confirmed Shopping List purchase, written by
// confirmPurchased together with its "finish-shop" stock adjustment
// and linked to that adjustment by id. The HIT List Activity log
// lists these beside usage_log entries; undo (undoPurchase) marks the
// row undone and reverses the stock effect — deleting the linked
// adjustment while it is still pending, or recording a compensating
// negative adjustment (source "purchase-undo") once the auto-scan
// has applied it to the sheet.
export const purchaseLog = sqliteTable("purchase_log", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  item: text("item").notNull(),
  quantity: integer("quantity").notNull(),
  // The stock_adjustments row this purchase recorded; null only for
  // rows where the link could not be captured.
  adjustmentId: integer("adjustment_id"),
  createdAt: integer("created_at", { mode: "timestamp_ms" })
    .notNull()
    .$defaultFn(() => new Date()),
  undone: integer("undone").notNull().default(0),
  undoneAt: integer("undone_at", { mode: "timestamp_ms" }),
});

// One optional expiry date per HIT List item, keyed by item name
// (the sheet's spelling). Date only ("YYYY-MM-DD"), no time. Pure
// app-side display data: it drives the row's use-soon chip and the
// Expiring soon panel, and is never written to the sheet or synced.
export const itemExpiries = sqliteTable("item_expiries", {
  item: text("item").primaryKey(),
  expiryDate: text("expiry_date").notNull(),
  updatedAt: integer("updated_at", { mode: "timestamp_ms" })
    .notNull()
    .$defaultFn(() => new Date()),
});

// Store-receipt photo quick-restock scan requests (the app's
// "Receipt scans" area). The receipt photo itself lives in
// ctx.blobs under image_blob_key (the MIME type is kept here so
// readers know what they're fetching); this row carries the
// workflow state. Status flow: "pending" (photo stored, waiting for
// the external reader) → "proposed" (setReceiptScanResult wrote the
// matched purchased-items proposal in lines_json) → "confirmed"
// (the user confirmed in the app; pending stock adjustments with
// source "receipt" were recorded) or "dismissed" (the user
// dismissed it; nothing was recorded). lines_json entries are
// { receiptText, item, quantity }: receiptText is the line as
// printed on the receipt, item the matched HIT List item name
// (null when the line matched nothing), quantity the number
// purchased. qr_value holds a QR code decoded from the photo in
// the app when the platform supports it (receipts often carry a QR
// code, and some receipts are only a QR code linking to a digital
// copy) so the reader can follow it to the digital receipt; it is
// null when no QR was decoded in-browser — the reader then tries
// decoding the photo itself.
export const receiptScans = sqliteTable("receipt_scans", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  imageBlobKey: text("image_blob_key"),
  imageMimeType: text("image_mime_type"),
  qrValue: text("qr_value"),
  status: text("status", {
    enum: ["pending", "proposed", "confirmed", "dismissed"],
  })
    .notNull()
    .default("pending"),
  linesJson: text("lines_json"),
  // Short note from the external reader (e.g. why a read failed).
  note: text("note"),
  createdAt: integer("created_at", { mode: "timestamp_ms" })
    .notNull()
    .$defaultFn(() => new Date()),
  updatedAt: integer("updated_at", { mode: "timestamp_ms" })
    .notNull()
    .$defaultFn(() => new Date()),
});

// Recipe needs (ingredient coverage) additions:
//   recipe_need_prices — the quick price check for one recipe's
//                        still-needed ingredient: keyed by meal id +
//                        normalized ingredient name. Written by the
//                        background price-check task that
//                        checkRecipeNeeds spawns (handed back via
//                        saveRecipeNeedPrices): a sale price + store
//                        + end-of-sale when the ingredient is on
//                        sale, otherwise the lowest verified regular
//                        price + store. The ingredient coverage
//                        itself (covered / short / missing) is NOT
//                        stored — it is derived on every read from
//                        the meal's ingredients and the live
//                        inventory, so a restock drops an ingredient
//                        off its recipe's needs by itself. Price rows
//                        for ingredients that stop being needed are
//                        simply ignored on read.
//   recipe_need_checks — tap-to-check-off state for recipe-needs
//                        rows on the Shopping List, keyed
//                        "<mealId>::<ingredientKey>". Kept apart
//                        from checked_items because saveList prunes
//                        that table to sheet rows on every refresh;
//                        needs rows are app-derived, never sheet
//                        rows. Checking a needs row is display only
//                        — it never records a purchase or changes
//                        inventory.

// In-app alerts, written by external jobs (Muse's grocery scans)
// via addAlert and shown at the top of the Shopping List tab.
// read_at is stamped when the user opens the alerts list;
// dismissed_at hides the alert for good. Display only.
export const alerts = sqliteTable("alerts", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  kind: text("kind", { enum: ["sale", "scan", "info"] }).notNull(),
  title: text("title").notNull(),
  body: text("body").notNull(),
  // The HIT List / Shopping List item the alert is about, when any.
  item: text("item"),
  readAt: integer("read_at", { mode: "timestamp_ms" }),
  dismissedAt: integer("dismissed_at", { mode: "timestamp_ms" }),
  createdAt: integer("created_at", { mode: "timestamp_ms" })
    .notNull()
    .$defaultFn(() => new Date()),
});

// One price-check row per (meal, needed ingredient). Status flow:
// "pending" (checkRecipeNeeds spawned the background check) →
// "done" (saveRecipeNeedPrices wrote verified prices — sale fields
// set when the ingredient is on sale, regular fields always the
// lowest verified regular price) or "failed" (the check couldn't
// run / found nothing verifiable; note says why). checked_at is
// when the last completed check landed; a "done" row counts as
// fresh for a week (one flyer cycle), then the Shopping List may
// re-check it automatically.
export const recipeNeedPrices = sqliteTable(
  "recipe_need_prices",
  {
    mealId: integer("meal_id").notNull(),
    // Normalized ingredient name (lowercase, punctuation-free,
    // single-spaced) — the join key against the meal's ingredients.
    ingredientKey: text("ingredient_key").notNull(),
    // The ingredient's name as the meal lists it (display).
    ingredient: text("ingredient").notNull(),
    status: text("status", { enum: ["pending", "done", "failed"] })
      .notNull()
      .default("pending"),
    salePriceCents: integer("sale_price_cents"),
    saleStore: text("sale_store"),
    saleEnd: text("sale_end"),
    regularPriceCents: integer("regular_price_cents"),
    regularStore: text("regular_store"),
    note: text("note"),
    // The exact page the shown price was verified on (Flipp item
    // URL or store product page), with which kind it was.
    sourceUrl: text("source_url"),
    sourceType: text("source_type", { enum: ["flipp", "website"] }),
    checkedAt: integer("checked_at", { mode: "timestamp_ms" }),
    createdAt: integer("created_at", { mode: "timestamp_ms" })
      .notNull()
      .$defaultFn(() => new Date()),
    updatedAt: integer("updated_at", { mode: "timestamp_ms" })
      .notNull()
      .$defaultFn(() => new Date()),
  },
  (t) => [primaryKey({ columns: [t.mealId, t.ingredientKey] })],
);

// ---- BIT — Business Inventory Tracker ------------------------------
// The business side of the app, merged in beside the household (HIT)
// side. Its data is COMPLETELY separate: its own tables below, no
// shared rows with any HIT table. The app's launch chooser picks a
// side; the BIT side runs its own setup wizard, rounds, inventory,
// order email, and manifest import against these tables only.
//
//   bit_business       — one row per business (Alpha 0.69: BIT can
//                        hold several businesses and the app switches
//                        between them; every other bit_* table carries
//                        a business_id scoping its rows to one of
//                        them, existing rows defaulting to business 1).
//                        Each row is the business profile written by
//                        the setup wizard: business type (+ free-text
//                        custom type for "Other"), name, the chosen
//                        categories and freezers (JSON arrays), and
//                        the category colour map (JSON object).
//                        Categories are the ONLY organizing concept:
//                        categories_json holds the business's
//                        categories, and the legacy zones_json /
//                        organize_by columns are kept in step with
//                        them (rows written under the earlier
//                        category-or-zone choice record which stored
//                        list/field holds the business's groups, so
//                        those groups read back as its categories).
//                        No row = setup has not been completed yet.
//   bit_items          — the business inventory: one row per item
//                        with category, zone (legacy mirror of the
//                        category), on-hand (book) count, par level,
//                        unit, pack size, supplier, SKU, and tags
//                        (JSON array — allergen / seasonal labels
//                        from the starter packs).
//   bit_rounds         — one row per finished round: who counted,
//                        the category filter used (stored in the
//                        legacy-named zone_filter column), how many
//                        of how many were counted, and JSON
//                        summaries of the variances, below-par
//                        items, and freezer readings (with > −18°C
//                        alerts). Finishing a round writes the
//                        counted values back into bit_items.on_hand.
//   bit_waste_log      — the waste history (Alpha 0.75):
//                        Restaurant-profile businesses log spoiled,
//                        expired, broken or otherwise wasted stock;
//                        each entry deducts from the item's on-hand.
//                        Business-type needs profiles (Alpha 0.75)
//                        are keyed off the business's stored type:
//                        expiry dates live on bit_items.expiry_date,
//                        fractional (tenths) counts in bit_items
//                        .on_hand — no profile column is stored.
//   bit_manifest_scans — manifest PHOTO scans, the same hand-off
//                        shape as receipt_scans: the photo lives in
//                        ctx.blobs (key + MIME type here), the row
//                        sits "pending" until an external reader job
//                        extracts its lines via
//                        getPendingBitManifestScans /
//                        setBitManifestScanResult ("proposed"); the
//                        user reviews them in the manifest review and
//                        only confirming (importBitManifest with the
//                        scan id) imports anything and marks the
//                        scan "confirmed". Dismissing records
//                        nothing. File manifests never touch this
//                        table — they are parsed client-side.
export const bitBusiness = sqliteTable("bit_business", {
  id: integer("id").primaryKey(),
  businessType: text("business_type").notNull(),
  customType: text("custom_type"),
  name: text("name").notNull(),
  zonesJson: text("zones_json").notNull().default("[]"),
  // Legacy organizing axis from the earlier category-or-zone
  // choice. Categories are the only organizing concept now; this
  // records which stored list/field holds the business's groups
  // (its categories) for rows written before the lump.
  organizeBy: text("organize_by", { enum: ["zone", "category"] })
    .notNull()
    .default("zone"),
  categoriesJson: text("categories_json").notNull().default("[]"),
  freezersJson: text("freezers_json").notNull().default("[]"),
  colorsJson: text("colors_json").notNull().default("{}"),
  // POS connection (Alpha 0.64): ONE point-of-sale connection per
  // business, saved from the Inventory tab's "Connect to POS"
  // panel. pos_provider is the provider name; pos_kind is "named"
  // (one of the six listed systems — Square, Shopify POS,
  // Lightspeed Retail (X-Series), Lightspeed Retail (R-Series),
  // Clover, Toast) or "custom" (an "Other / Custom POS" entry from
  // the popup form, displayed as "Custom: <name>").
  // pos_status is "Credentials saved — daily sync ready" for a
  // named provider whose required setup fields are saved,
  // "Awaiting app registration" for Lightspeed Retail (R-Series)
  // (OAuth consent only — nothing for the merchant to paste), or
  // "Details saved" for a custom one. The remaining
  // fields are the custom popup's entries: how the system shares
  // data, its API endpoint URL, the API key / access token the
  // owner pasted, an optional location / store ID, and optional
  // notes. pos_connected_at is when the connection was saved.
  // All null = no POS connected. The daily pull (Alpha 0.67)
  // reads these fields plus pos_details_json for its provider
  // calls and records each run in bit_pos_sync_runs.
  posProvider: text("pos_provider"),
  posKind: text("pos_kind", { enum: ["named", "custom"] }),
  posStatus: text("pos_status"),
  posShareMethod: text("pos_share_method"),
  posEndpointUrl: text("pos_endpoint_url"),
  posApiKey: text("pos_api_key"),
  posLocationId: text("pos_location_id"),
  posNotes: text("pos_notes"),
  // Per-provider setup fields (Alpha 0.66): a JSON object holding
  // the exact values the picked provider's setup asks for (e.g.
  // Square's production access token, Shopify's shop domain +
  // Client ID + Client secret, Toast's restaurant GUID). Secret
  // values inside are NEVER returned raw by getBitState — it masks
  // them to their last 4 characters. Null for custom connections
  // and for Lightspeed Retail (R-Series), which has no fields.
  posDetailsJson: text("pos_details_json"),
  posIntakeToken: text("pos_intake_token"),
  // Daily pull (Alpha 0.67): when a "Sync now" was last requested
  // from the POS panel (the daily pull action clears it once it
  // has run for this business), and the cached provider-id → SKU
  // map (JSON object) built while resolving line items whose POS
  // reference is an internal id rather than a SKU (Square catalog
  // ids, Lightspeed product ids, Clover item ids, Toast menu-item
  // GUIDs). Null until the first pull needs it.
  posSyncRequestedAt: integer("pos_sync_requested_at", {
    mode: "timestamp_ms",
  }),
  posSkuCacheJson: text("pos_sku_cache_json"),
  posConnectedAt: integer("pos_connected_at", { mode: "timestamp_ms" }),
  // Quartermaster requisition workflow (Alpha 0.71, TFS SOG F-SUPP
  // "Supplies and Ordering"): uses_requisition gates the whole
  // requisition flow — set for TFS station 226 only; every other
  // business keeps the Order Email tab exactly as before. division
  // and duty_officer_name are the requisition form's header fields,
  // stored on the business and editable from the Requisition tab;
  // both start blank until the user sets them.
  usesRequisition: integer("uses_requisition").notNull().default(0),
  division: text("division"),
  dutyOfficerName: text("duty_officer_name"),
  updatedAt: integer("updated_at", { mode: "timestamp_ms" })
    .notNull()
    .$defaultFn(() => new Date()),
});

// One sent requisition (Alpha 0.71): the station's current
// outstanding requisition (status "outstanding") or a completed one
// kept on file in the requisition history (status "closed", once
// every line has been checked off Received / Not received).
export const bitRequisitions = sqliteTable("bit_requisitions", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  businessId: integer("business_id").notNull().default(1),
  // Fire Station-YY-MM-DD, e.g. 226-26-11-14.
  reqNo: text("req_no").notNull(),
  status: text("status", { enum: ["outstanding", "closed"] })
    .notNull()
    .default("outstanding"),
  sentAt: integer("sent_at", { mode: "timestamp_ms" }).notNull(),
  closedAt: integer("closed_at", { mode: "timestamp_ms" }),
  createdAt: integer("created_at", { mode: "timestamp_ms" })
    .notNull()
    .$defaultFn(() => new Date()),
});

// One line of a sent requisition. item_id links back to the
// tracked inventory item when the line came from stock (null for
// catalogue lines ordered straight onto the requisition). status
// is the SOG check-off: "pending" until the Duty Officer checks
// the delivery, then "received" (qty_received applied to stock) or
// "not_received". A not-received line is NEVER back-ordered: it
// resurfaces on the next requisition build badged "Resubmitted"
// until a later requisition line supersedes it (superseded_by =
// that line's id).
export const bitRequisitionLines = sqliteTable("bit_requisition_lines", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  requisitionId: integer("requisition_id").notNull(),
  businessId: integer("business_id").notNull().default(1),
  itemId: integer("item_id"),
  name: text("name").notNull(),
  materialNo: text("material_no"),
  qtyOrdered: integer("qty_ordered").notNull(),
  unit: text("unit").notNull().default("units"),
  category: text("category").notNull().default("Other"),
  status: text("status", {
    enum: ["pending", "received", "not_received"],
  })
    .notNull()
    .default("pending"),
  qtyReceived: integer("qty_received"),
  supersededBy: integer("superseded_by"),
  createdAt: integer("created_at", { mode: "timestamp_ms" })
    .notNull()
    .$defaultFn(() => new Date()),
});

// Quartermaster catalogue reference entries (Alpha 0.71): for TFS,
// the OfficiallyDressed "SHORELINE" PPE catalogue items 125–208
// (description + Material # = the catalogue number), seeded by the
// seed action. Since Alpha 0.72 the catalogue items are regular
// tracked inventory (bit_items, category "Quartermaster
// catalogue", converted by convertBitTfsCatalogueToInventory);
// these rows are kept on file as the original reference list and
// for any draft extras that still point at them.
export const bitCatalogue = sqliteTable(
  "bit_catalogue",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    businessId: integer("business_id").notNull().default(1),
    materialNo: text("material_no").notNull(),
    description: text("description").notNull(),
    sortOrder: integer("sort_order").notNull().default(0),
    createdAt: integer("created_at", { mode: "timestamp_ms" })
      .notNull()
      .$defaultFn(() => new Date()),
  },
  (t) => [
    uniqueIndex("bit_catalogue_business_material_unique").on(
      t.businessId,
      t.materialNo,
    ),
  ],
);

// Catalogue entries the user has put straight onto the requisition
// currently being built (they are not tracked inventory). Folded
// into the requisition's lines when it is marked sent, then
// cleared.
export const bitRequisitionDraftExtras = sqliteTable(
  "bit_requisition_draft_extras",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    businessId: integer("business_id").notNull().default(1),
    catalogueId: integer("catalogue_id").notNull(),
    name: text("name").notNull(),
    materialNo: text("material_no"),
    qty: integer("qty").notNull().default(1),
    unit: text("unit").notNull().default("each"),
    createdAt: integer("created_at", { mode: "timestamp_ms" })
      .notNull()
      .$defaultFn(() => new Date()),
  },
);

export const bitItems = sqliteTable(
  "bit_items",
  {
  id: integer("id").primaryKey({ autoIncrement: true }),
  // The business this item belongs to (bit_business.id). Item
  // names are unique per business, not globally.
  businessId: integer("business_id").notNull().default(1),
  name: text("name").notNull(),
  category: text("category").notNull(),
  zone: text("zone").notNull(),
  // On-hand is a REAL: whole-number businesses only ever store
  // whole counts, but a Bar / Pub profile business counts open
  // bottles and kegs in tenths (Alpha 0.75 fractional counting),
  // so a count like 0.7 must round-trip. (SQLite stores the
  // fractional values in the integer-affinity column as REAL —
  // the column type in the database is unchanged.)
  onHand: real("on_hand").notNull().default(0),
  unit: text("unit").notNull().default("units"),
  par: integer("par").notNull().default(0),
  packSize: integer("pack_size").notNull().default(1),
  supplier: text("supplier"),
  sku: text("sku"),
  // Optional expiry date ("YYYY-MM-DD", Alpha 0.75): only
  // businesses whose needs profile includes expiry tracking set
  // it (Ice Cream Shop, Restaurant, Bakery, Café / Coffee Shop,
  // Food Truck). Null = no date tracked; the item behaves exactly
  // as before.
  expiryDate: text("expiry_date"),
  tagsJson: text("tags_json").notNull().default("[]"),
  sortOrder: integer("sort_order").notNull().default(0),
  createdAt: integer("created_at", { mode: "timestamp_ms" })
    .notNull()
    .$defaultFn(() => new Date()),
  },
  (t) => [
    uniqueIndex("bit_items_business_name_unique").on(t.businessId, t.name),
  ],
);

// Waste log (Alpha 0.75): one row per waste entry recorded from
// the Inventory tab — Restaurant-profile businesses only (their
// needs profile is the only one with a waste log). Logging an
// entry deducts the quantity from the item's on-hand count; the
// item's name and unit are snapshotted so the history stays
// readable even if the item is later renamed or removed.
export const bitWasteLog = sqliteTable("bit_waste_log", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  businessId: integer("business_id").notNull().default(1),
  itemId: integer("item_id"),
  itemName: text("item_name").notNull(),
  unit: text("unit").notNull().default("units"),
  quantity: integer("quantity").notNull(),
  reason: text("reason", {
    enum: ["Spoilage", "Expired", "Breakage", "Other"],
  })
    .notNull()
    .default("Spoilage"),
  createdAt: integer("created_at", { mode: "timestamp_ms" })
    .notNull()
    .$defaultFn(() => new Date()),
});

export const bitRounds = sqliteTable("bit_rounds", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  businessId: integer("business_id").notNull().default(1),
  counterName: text("counter_name").notNull(),
  // Category the round was filtered to; null = all categories.
  // (Column name predates categories-only.)
  zoneFilter: text("zone_filter"),
  counted: integer("counted").notNull(),
  total: integer("total").notNull(),
  // JSON array of { item, book, counted } for counted items whose
  // count differed from the book count.
  variancesJson: text("variances_json").notNull().default("[]"),
  // JSON array of item names at or below par after the round.
  belowParJson: text("below_par_json").notNull().default("[]"),
  // JSON array of { freezer, tempC } readings taken during the
  // round (tempC null = not recorded).
  freezerJson: text("freezer_json").notNull().default("[]"),
  createdAt: integer("created_at", { mode: "timestamp_ms" })
    .notNull()
    .$defaultFn(() => new Date()),
});

export const bitManifestScans = sqliteTable("bit_manifest_scans", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  businessId: integer("business_id").notNull().default(1),
  imageBlobKey: text("image_blob_key"),
  imageMimeType: text("image_mime_type"),
  status: text("status", {
    enum: ["pending", "proposed", "confirmed", "dismissed"],
  })
    .notNull()
    .default("pending"),
  // JSON array of { name, category, count, unit, par, supplier }
  // extracted by the reader job.
  linesJson: text("lines_json"),
  note: text("note"),
  createdAt: integer("created_at", { mode: "timestamp_ms" })
    .notNull()
    .$defaultFn(() => new Date()),
  updatedAt: integer("updated_at", { mode: "timestamp_ms" })
    .notNull()
    .$defaultFn(() => new Date()),
});

export const bitPosTransactions = sqliteTable("bit_pos_transactions", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  businessId: integer("business_id").notNull().default(1),
  itemId: integer("item_id"),
  itemName: text("item_name"),
  posRef: text("pos_ref").notNull(),
  quantity: integer("quantity").notNull(),
  source: text("source").notNull(),
  externalId: text("external_id"),
  matched: integer("matched").notNull().default(1),
  belowPar: integer("below_par").notNull().default(0),
  undone: integer("undone").notNull().default(0),
  resolved: integer("resolved").notNull().default(0),
  createdAt: integer("created_at", { mode: "timestamp_ms" })
    .notNull()
    .$defaultFn(() => new Date()),
});

// One row per daily-pull run (Alpha 0.67): when it ran, which
// provider, which day it pulled (day_key — a YYYY-MM-DD calendar
// day, or a Toast YYYYMMDD businessDate), how many orders it saw,
// how many lines applied / stayed unmatched / were duplicates of
// an earlier pull, and its outcome — status "ok", "skipped" (the
// provider cannot be pulled yet), or "error" with the failure in
// `error`. The POS panel shows the newest row as the last pull.
export const bitPosSyncRuns = sqliteTable("bit_pos_sync_runs", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  businessId: integer("business_id").notNull().default(1),
  provider: text("provider").notNull(),
  status: text("status").notNull(),
  dayKey: text("day_key"),
  ordersSeen: integer("orders_seen").notNull().default(0),
  linesApplied: integer("lines_applied").notNull().default(0),
  linesUnmatched: integer("lines_unmatched").notNull().default(0),
  duplicates: integer("duplicates").notNull().default(0),
  error: text("error"),
  createdAt: integer("created_at", { mode: "timestamp_ms" })
    .notNull()
    .$defaultFn(() => new Date()),
});

export const bitPosMappings = sqliteTable(
  "bit_pos_mappings",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    businessId: integer("business_id").notNull().default(1),
    // Unique per business: two businesses can each remember a
    // mapping for the same POS reference.
    posRef: text("pos_ref").notNull(),
    itemId: integer("item_id").notNull(),
    createdAt: integer("created_at", { mode: "timestamp_ms" })
      .notNull()
      .$defaultFn(() => new Date()),
  },
  (t) => [
    uniqueIndex("bit_pos_mappings_business_pos_ref_unique").on(
      t.businessId,
      t.posRef,
    ),
  ],
);

// Business analytics (Alpha 0.76): a per-business monthly
// dataset behind the BIT Analytics tab, which is shown only for
// businesses that have rows here. Seeded for The Daily Scoop from
// the "BIT Sim 01" 12-month simulation (Dec 2025 – Nov 2026) by
// the seedBitSim01 action; every statistic the tab shows is
// computed from these rows (plus the live item list for the
// current inventory value). Money columns are REAL dollars.
export const bitAnalyticsMonths = sqliteTable(
  "bit_analytics_months",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    businessId: integer("business_id").notNull().default(1),
    // "YYYY-MM" — the sort key; label is the display form
    // ("Dec 2025").
    monthKey: text("month_key").notNull(),
    label: text("label").notNull(),
    daysOpen: integer("days_open").notNull(),
    transactions: integer("transactions").notNull(),
    unitsSold: integer("units_sold").notNull(),
    revenue: real("revenue").notNull(),
    cogs: real("cogs").notNull(),
    wasteCost: real("waste_cost").notNull(),
    grossProfit: real("gross_profit").notNull(),
    netProfit: real("net_profit").notNull(),
    ordersPlaced: integer("orders_placed").notNull(),
    stockoutEvents: integer("stockout_events").notNull(),
    endingInventoryValue: real("ending_inventory_value").notNull(),
  },
  (t) => [
    uniqueIndex("bit_analytics_months_business_month_unique").on(
      t.businessId,
      t.monthKey,
    ),
  ],
);

// Annual menu results for the same dataset: one row per menu
// item with its units sold and revenue over the period.
export const bitAnalyticsMenu = sqliteTable(
  "bit_analytics_menu",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    businessId: integer("business_id").notNull().default(1),
    name: text("name").notNull(),
    units: integer("units").notNull(),
    revenue: real("revenue").notNull(),
    sortOrder: integer("sort_order").notNull().default(0),
  },
  (t) => [
    uniqueIndex("bit_analytics_menu_business_name_unique").on(
      t.businessId,
      t.name,
    ),
  ],
);

// One summary row per business with a dataset: the dataset's
// label and period, the stockout loss figures, the notable waste
// breakdown (JSON array of { name, tubs }), and the per-item unit
// costs (JSON object, inventory item name → dollars) the tab
// multiplies by the LIVE on-hand counts to value the inventory
// currently on the shelves.
export const bitAnalyticsSummary = sqliteTable(
  "bit_analytics_summary",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    businessId: integer("business_id").notNull().default(1),
    label: text("label").notNull(),
    periodLabel: text("period_label").notNull(),
    lostRevenue: real("lost_revenue").notNull(),
    lostUnits: integer("lost_units").notNull(),
    stockoutEvents: integer("stockout_events").notNull(),
    wasteJson: text("waste_json").notNull().default("[]"),
    itemCostsJson: text("item_costs_json").notNull().default("{}"),
  },
  (t) => [
    uniqueIndex("bit_analytics_summary_business_unique").on(t.businessId),
  ],
);

// Check-off state for recipe-needs rows on the Shopping List,
// keyed "<mealId>::<ingredientKey>". Same flag pattern as
// checked_items (the row is kept and flipped, never deleted on
// un-check), but pruned by getRecipeNeeds reads instead of
// saveList: a row whose meal or ingredient no longer needs
// anything is dropped when it is next read as stale.
export const recipeNeedChecks = sqliteTable("recipe_need_checks", {
  needKey: text("need_key").primaryKey(),
  checked: integer("checked").notNull().default(1),
  checkedAt: integer("checked_at", { mode: "timestamp_ms" })
    .notNull()
    .$defaultFn(() => new Date()),
});
