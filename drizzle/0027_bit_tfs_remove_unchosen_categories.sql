-- TFS station 226 (BIT business 1) was set up under the old
-- category-or-zone scheme: it is stored organize_by='zone', its
-- chosen categories (Office Supplies, Medical, Cleaning supplies,
-- Other) sit in zones_json, categories_json is empty, and its 12
-- items are grouped by the starter pack's zone names (Storage,
-- Main Area, Front Counter, Back Room) -- categories the user never
-- picked and does not want. Move the business to categories-only
-- with exactly its chosen categories in both stored lists, and
-- re-group the items that sit under a removed zone name onto the
-- chosen category matching each item's own stored pack category
-- (Cleaning & Supplies -> Cleaning supplies, Office -> Office
-- Supplies, anything else -> Other). Item names, counts, pars,
-- units, suppliers and SKUs are untouched; no item is removed.
-- Scoped to the TFS business only; every other business (incl.
-- The Daily Scoop) is untouched. Idempotent: once applied, the
-- WHERE clauses match nothing.
UPDATE bit_business
SET organize_by = 'category',
    categories_json = COALESCE((
      SELECT json_group_array(value)
      FROM json_each(bit_business.zones_json)
      WHERE lower(replace(value, ' ', '')) NOT IN ('storage', 'mainarea', 'frontcounter', 'backroom')
    ), '[]'),
    zones_json = COALESCE((
      SELECT json_group_array(value)
      FROM json_each(bit_business.zones_json)
      WHERE lower(replace(value, ' ', '')) NOT IN ('storage', 'mainarea', 'frontcounter', 'backroom')
    ), '[]')
WHERE lower(name) LIKE 'tfs station 226%';
--> statement-breakpoint
UPDATE bit_items
SET category = CASE lower(trim(category))
      WHEN 'cleaning & supplies' THEN 'Cleaning supplies'
      WHEN 'office' THEN 'Office Supplies'
      ELSE 'Other'
    END
WHERE business_id IN (SELECT id FROM bit_business WHERE lower(name) LIKE 'tfs station 226%')
  AND lower(replace(trim(zone), ' ', '')) IN ('storage', 'mainarea', 'frontcounter', 'backroom');
--> statement-breakpoint
UPDATE bit_items
SET zone = category
WHERE business_id IN (SELECT id FROM bit_business WHERE lower(name) LIKE 'tfs station 226%')
  AND lower(replace(trim(zone), ' ', '')) IN ('storage', 'mainarea', 'frontcounter', 'backroom');
