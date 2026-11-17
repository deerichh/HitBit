// Usage tracking. Picking a meal never touches inventory — usage is
// recorded through the logUsage action, with deductions riding the
// existing pending stock-adjustment queue:
//
// - The Meal Planner's per-pick "Eaten ✓" button, shown beside the
//   meal name in the calendar's week view — the only place a pick
//   can be marked eaten (month view shows just a passive ✓ beside
//   the name of a pick already marked eaten). Tapping
//   it means the meal was eaten and the recipe's protein amount was
//   what got used: buildEatenEntries below derives the deductions —
//   the chosen protein of the pick's choice group plus every protein
//   of the meal's single-option groups (Breakfast for dinner logs
//   Bacon AND Eggs), each at its recipe amount scaled to the pick's
//   servings and capped at stock on hand. Only the proteins are
//   logged by that button; other ingredients are not part of it.
//   There is no popup and no confirmation step. When the derivation
//   comes back empty (no protein chosen, or the chosen proteins
//   aren't tracked), the tap still records a zero-deduction marker
//   entry, so the pick shows as eaten and its day box explains that
//   nothing was deducted — never a silent no-op.
//
// The HIT List's per-item "Use" button and its quick-use sheet were
// removed (Nov 13, 2026): there is no manual quick-use any more.
// Usage is recorded by meal Eaten confirmations and read back in
// the HIT List tab's Usage log dropdown; older manual
// entries in that log remain as history.

export type IngredientLike = {
  name: string;
  quantity: number | null;
  unit: string | null;
};
export type ProteinOptionLike = {
  id: number;
  label: string;
  sheetName: string;
  groupIndex: number;
  /** Effective stock of the option's HIT item; null when untracked. */
  stock: number | null;
};

function normalize(name: string): string {
  return name.toLowerCase().replace(/\s+/g, " ").trim();
}

function singularWord(w: string): string {
  if (w.endsWith("oes")) return w.slice(0, -2);
  if (w.endsWith("ies") && w.length > 3) return `${w.slice(0, -3)}y`;
  if (w.endsWith("s") && !w.endsWith("ss")) return w.slice(0, -1);
  return w;
}

function wordsOf(name: string): string[] {
  return normalize(name)
    .split(/[^a-z0-9]+/)
    .filter(Boolean)
    .map(singularWord);
}

function samePhrase(a: string, b: string): boolean {
  const wa = wordsOf(a);
  const wb = wordsOf(b);
  return wa.length === wb.length && wa.every((w, i) => w === wb[i]);
}

export type EatenEntry = { item: string; deducted: number; usedSome: boolean };

/**
 * The usage entries a pick's "Eaten ✓" tap logs: the meal's proteins
 * only, at the recipe's amounts. A meal's proteins form groups —
 * interchangeable options the picker chooses between (the first
 * group with more than one option is the choice group, the same
 * rule the planner's picker uses), or single required proteins.
 * The Eaten action logs:
 * - the pick's chosen option from the choice group, and
 * - every option of every other group (Breakfast for dinner has two
 *   one-option groups — Bacon and Eggs — and both are deducted).
 * Each protein deducts its group's recipe amount: the ingredient
 * line naming one of the group's options (the chosen one first —
 * Chicken curry's "Chicken Thighs 4" line sets the amount even when
 * the breast was picked), or the generic "Ground meat" line for the
 * group the pick chose from. Amounts are written for 2 people, so
 * they scale by servings / 2, round to whole units, and cap at the
 * stock on hand ("Chicken Breasts 2" → 2; "Ground meat 1 Lb" → 1).
 * A protein no ingredient line names deducts 1. Proteins that aren't
 * on the HIT List are skipped (there is nothing to log against).
 * When every protein caps to zero (all out of stock), a single
 * "Used some" entry for the first tracked protein still marks the
 * pick eaten without deducting anything.
 */
export function buildEatenEntries(args: {
  ingredients: IngredientLike[];
  proteins: ProteinOptionLike[];
  chosenProteinId: number | null;
  servings: number;
}): EatenEntry[] {
  const { ingredients, proteins, chosenProteinId, servings } = args;

  const byIndex = new Map<number, ProteinOptionLike[]>();
  for (const p of proteins) {
    const list = byIndex.get(p.groupIndex) ?? [];
    list.push(p);
    byIndex.set(p.groupIndex, list);
  }
  const groups: ProteinOptionLike[][] = [];
  for (const idx of [...byIndex.keys()].sort((a, b) => a - b)) {
    const list = byIndex.get(idx);
    if (list) groups.push(list);
  }
  const choiceGroup = groups.find((g) => g.length > 1) ?? null;

  const findIngredient = (
    names: string[],
    allowGroundMeat: boolean,
  ): IngredientLike | null => {
    for (const n of names) {
      const hit = ingredients.find((ing) => samePhrase(ing.name, n));
      if (hit) return hit;
    }
    if (allowGroundMeat) {
      return (
        ingredients.find((ing) => samePhrase(ing.name, "Ground meat")) ??
        null
      );
    }
    return null;
  };

  const deductedByItem = new Map<string, { total: number; stock: number }>();
  let fallbackItem: string | null = null;

  for (const group of groups) {
    const isChoice = group === choiceGroup;
    const selected = isChoice
      ? group.filter((o) => o.id === chosenProteinId)
      : group;
    if (selected.length === 0) continue;
    const ordered = [
      ...selected,
      ...group.filter((o) => !selected.includes(o)),
    ];
    const ing = findIngredient(
      ordered.flatMap((o) => [o.sheetName, o.label]),
      chosenProteinId != null &&
        group.some((o) => o.id === chosenProteinId),
    );
    const amount =
      ing && ing.quantity != null && ing.quantity > 0
        ? Math.max(1, Math.round((ing.quantity * servings) / 2))
        : 1;
    for (const option of selected) {
      if (option.stock == null) continue;
      if (fallbackItem == null) fallbackItem = option.sheetName;
      const capped = Math.min(amount, option.stock);
      if (capped <= 0) continue;
      const prev = deductedByItem.get(option.sheetName);
      deductedByItem.set(option.sheetName, {
        total: Math.min((prev?.total ?? 0) + capped, option.stock),
        stock: option.stock,
      });
    }
  }

  const entries: EatenEntry[] = [...deductedByItem.entries()].map(
    ([item, v]) => ({ item, deducted: v.total, usedSome: false }),
  );
  if (entries.length === 0 && fallbackItem != null) {
    entries.push({ item: fallbackItem, deducted: 0, usedSome: true });
  }
  return entries;
}

