// Meal Planner tab — a month calendar of meals, ported from the
// standalone Meal Planner app.
//
// The tab opens on the month calendar, which is display-only: no
// picking happens there. Tapping a day in the month calendar jumps
// to week view focused on that day; there, the day box shows the
// day's picks at the top and, below them, one consolidated
// first-step query — "Plan a…" with tappable Breakfast / Lunch /
// Dinner / Snack choices. Choosing a type reveals that type's
// dropdown + suggestions picking flow beneath the choices, and the
// chosen type defines a new pick's meal type. A
// day can hold up to 5 picks in any mix of types. Meals and their
// protein options are tinted by stock from this app's HIT List tab:
// green when the protein is in stock, red when it's out, sand when it
// hasn't been counted yet. Picking is suggestive only — it never
// changes inventory. Usage is logged from the calendar itself: in
// week view every pick shows a small "Eaten?" button beside its
// meal name (it becomes "Eaten ✓" once logged), and tapping it deducts the recipe's protein amount
// from inventory through the pending stock-adjustment queue — no
// popup, no confirmation step. Once logged, the button stays filled
// and disabled so a pick can't be logged twice. Month view stays
// clean — no button there at all: just the compact meal name, plus
// a plain ✓ beside it once that pick has been marked eaten in week
// view.

import {
Fragment,
useEffect,
useMemo,
useRef,
useState,
type ReactNode,
} from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { fileToBase64 } from "@hatch/space-sdk/client";
import { api, type ApiResponse } from "./api";
import { RecipeVideosSection } from "./RecipeVideosSection";
import { buildEatenEntries } from "./UsageFlow";
import { SourceDropdown } from "./SourceDropdown";

type Planner = ApiResponse<typeof api, "getPlanner">;
type Meal = Planner["meals"][number];
type ProteinOption = Meal["proteins"][number];
type Pick = Planner["picks"][number];
type Status = ProteinOption["status"];
type MealStatus = Meal["status"];
type MealType = Meal["mealType"];

/** The four meals of the day, in the order they're picked and shown. */
const MEAL_TYPES: { id: MealType; label: string }[] = [
  { id: "breakfast", label: "Breakfast" },
  { id: "lunch", label: "Lunch" },
  { id: "dinner", label: "Dinner" },
  { id: "snack", label: "Snack" },
];

function mealTypeLabel(type: MealType): string {
  return MEAL_TYPES.find((t) => t.id === type)?.label ?? type;
}

/** A day can hold at most this many picks (mirrors the server cap). */
const MAX_PICKS_PER_DAY = 5;

const WEEKDAYS = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];
const MONTHS = [
  "January", "February", "March", "April", "May", "June",
  "July", "August", "September", "October", "November", "December",
];

function toKey(d: Date): string {
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${d.getFullYear()}-${m}-${day}`;
}

function parseKey(key: string): Date {
  const [y = 1970, m = 1, d = 1] = key.split("-").map(Number);
  return new Date(y, m - 1, d);
}

function formatLong(key: string): string {
  const d = parseKey(key);
  return `${WEEKDAYS[(d.getDay() + 6) % 7]}, ${MONTHS[d.getMonth()]} ${d.getDate()}`;
}

function statusClasses(status: Status): string {
  if (status === "in") return "bg-[var(--ok-bg)] text-[var(--ok-text)]";
  if (status === "out") return "bg-[var(--out-bg)] text-[var(--out-text)]";
  return "bg-[var(--unknown-bg)] text-[var(--unknown-text)]";
}

function mealStatusClasses(status: MealStatus): string {
  if (status === "available")
    return "bg-[var(--ok-bg)] text-[var(--ok-text)]";
  if (status === "out") return "bg-[var(--out-bg)] text-[var(--out-text)]";
  return "bg-[var(--unknown-bg)] text-[var(--unknown-text)]";
}

function statusWord(status: Status, stock: number | null): string {
  if (status === "in") return `${stock} in stock`;
  if (status === "out") return "out of stock";
  return "not counted yet";
}

function mealStatusWord(meal: Meal): string {
  if (meal.status === "available") return "Protein in stock";
  if (meal.status === "out") return "Protein out of stock";
  return "Protein not counted yet";
}

function formatShort(key: string): string {
  const d = parseKey(key);
  return `${(MONTHS[d.getMonth()] ?? "").slice(0, 3)} ${d.getDate()}`;
}

function lastEatenWord(meal: Meal): string {
  return meal.lastEaten
    ? `Last eaten ${formatShort(meal.lastEaten)}`
    : "Not eaten yet";
}

/**
 * Ingredient quantities are written for 2 people; scale by servings / 2
 * and format kitchen-style (½, ¼, ¾) where that lands cleanly.
 */
function scaledQuantity(quantity: number, servings: number): string {
  const v = (quantity * servings) / 2;
  const rounded = Math.round(v * 4) / 4;
  const whole = Math.floor(rounded);
  const frac = rounded - whole;
  const fracStr =
    frac === 0.25 ? "¼" : frac === 0.5 ? "½" : frac === 0.75 ? "¾" : "";
  if (fracStr) return whole > 0 ? `${whole}${fracStr}` : fracStr;
  if (Number.isInteger(rounded)) return String(rounded);
  return String(Math.round(v * 100) / 100);
}

/** "Longest since last eaten" ordering: never-eaten first, then oldest. */
function byLongestSinceEaten(a: Meal, b: Meal): number {
  if (a.lastEaten === null && b.lastEaten !== null) return -1;
  if (a.lastEaten !== null && b.lastEaten === null) return 1;
  if (a.lastEaten && b.lastEaten) return a.lastEaten.localeCompare(b.lastEaten);
  return a.id - b.id;
}

/** "Most picked" ordering: highest pick count first, ties broken by longest since eaten. */
function byMostPicked(a: Meal, b: Meal): number {
  if (b.pickCount !== a.pickCount) return b.pickCount - a.pickCount;
  return byLongestSinceEaten(a, b);
}

/** Small seeded PRNG (mulberry32): same seed always gives the same sequence. */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * Fisher–Yates shuffle driven by the launch seed. Deterministic for a
 * given seed and input order, so the suggestions stay put while the
 * app is open (even across refetches) but come out in a fresh random
 * order on the next launch, when App generates a new seed.
 */
function shuffledWithSeed<T>(items: readonly T[], seed: number): T[] {
  const result = [...items];
  const rand = mulberry32(seed);
  for (let i = result.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    const current = result[i];
    const target = result[j];
    if (current !== undefined && target !== undefined) {
      result[i] = target;
      result[j] = current;
    }
  }
  return result;
}

/**
 * Favourites are meals picked at least twice that sit at the top of
 * the most-picked ranking within their own meal type (breakfasts
 * compete with breakfasts, dinners with dinners). A single pick isn't
 * enough evidence yet, so with little history there may be no
 * favourites. Favourites are only a badge in the Meal List and on a
 * suggested pick — they no longer decide which meals get suggested
 * (that is random per launch now).
 */
function favouriteIdsOf(meals: Meal[]): Set<number> {
  const ids = new Set<number>();
  for (const type of MEAL_TYPES) {
    const candidates = meals
      .filter((m) => m.mealType === type.id && m.pickCount >= 2)
      .sort(byMostPicked);
    for (const m of candidates.slice(0, 2)) ids.add(m.id);
  }
  return ids;
}

function pickCountWord(meal: Meal): string {
  if (meal.pickCount === 0) return "";
  return meal.pickCount === 1 ? "Picked once" : `Picked ${meal.pickCount} times`;
}

/** Lowercase, punctuation-free, single-spaced name for comparisons. */
function normalizeMealName(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Existing meals that might be the same dish as a name being typed: an
 * exact match ignoring case and punctuation, one name contained in the
 * other ("Chicken" vs "Chicken curry"), or a strong overlap in the words
 * used ("Chicken Caesar" vs "Caesar chicken salad"). Best matches first,
 * at most two.
 */
function possibleDuplicates(name: string, meals: Meal[]): Meal[] {
  const target = normalizeMealName(name);
  if (target.length < 3) return [];
  const targetWords = new Set(target.split(" "));
  const scored: { meal: Meal; score: number }[] = [];
  for (const meal of meals) {
    const other = normalizeMealName(meal.name);
    if (!other) continue;
    let score = 0;
    if (other === target) {
      score = 3;
    } else if (other.includes(target) || target.includes(other)) {
      score = 2;
    } else {
      const otherWords = new Set(other.split(" "));
      const shared = [...targetWords].filter((w) => otherWords.has(w)).length;
      const union = new Set([...targetWords, ...otherWords]).size;
      if (union > 0 && shared / union >= 0.5) score = 1;
    }
    if (score > 0) scored.push({ meal, score });
  }
  return scored
    .sort((a, b) => b.score - a.score)
    .slice(0, 2)
    .map((s) => s.meal);
}

/** Groups of a meal's protein options, in group order. */
function groupsOf(meal: Meal): { groupIndex: number; options: ProteinOption[] }[] {
  const map = new Map<number, ProteinOption[]>();
  for (const p of meal.proteins) {
    const list = map.get(p.groupIndex) ?? [];
    list.push(p);
    map.set(p.groupIndex, list);
  }
  return [...map.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([groupIndex, options]) => ({ groupIndex, options }));
}

/** The group the picker chooses from: the first group with >1 option. */
function choiceGroupOf(meal: Meal) {
  return groupsOf(meal).find((g) => g.options.length > 1) ?? null;
}

// Month-view day cells are narrow, so a pick's meal name steps DOWN
// in size as it gets longer — the same step-down approach as the HIT
// List item names and the Membership Alternatives formal names —
// and wraps inside its cell instead of clipping at one fixed size
// ("Chicken caesar salad" at 10px overflowed its cell).
function monthNameFontSize(name: string): number {
  const len = name.length;
  if (len <= 12) return 10;
  if (len <= 16) return 9.5;
  if (len <= 20) return 9;
  return 8.5;
}

/**
 * Meals that ask for a serving style on top of the protein choice, and
 * the styles on offer. Matched by meal name (case-insensitively) so the
 * step survives the meal being removed and re-added from the Meal List.
 */
const MEAL_VARIANTS: { match: string; label: string; options: string[] }[] = [
  {
    match: "taco night",
    label: "Choose the style",
    options: ["Taco bowls", "Soft shell", "Hard shell", "Both"],
  },
];

function variantSpecOf(meal: Meal) {
  const name = meal.name.trim().toLowerCase();
  return MEAL_VARIANTS.find((v) => v.match === name) ?? null;
}

export function MealPlannerTab({
  suggestionSeed,
}: {
  suggestionSeed?: number;
} = {}) {
  // Fallback seed for standalone use (App normally supplies one per
  // launch): generated once when this tab first mounts.
  const [fallbackSeed] = useState(
    () => Math.floor(Math.random() * 2_147_483_647) + 1,
  );
  const effectiveSuggestionSeed = suggestionSeed ?? fallbackSeed;
  const queryClient = useQueryClient();
  const planner = useQuery({
    queryKey: ["planner"],
    queryFn: () => api.getPlanner({}),
  });
  // HIT List item names feed the add-meal form's item suggestions.
  const hit = useQuery({
    queryKey: ["hit"],
    queryFn: () => api.getHitList({}),
  });

  const today = useMemo(() => new Date(), []);
  const [cursor, setCursor] = useState(() => ({
    year: today.getFullYear(),
    month: today.getMonth(),
  }));
  const [selectedDate, setSelectedDate] = useState(() => toKey(today));
  const [view, setView] = useState<"month" | "week">("month");
  const [weekAnchor, setWeekAnchor] = useState(() => toKey(today));
  // Week view is an accordion: every day has a header row, the
  // selected day's header is expanded to show its day box, and
  // tapping the expanded day's header collapses it back to a slim
  // row (this flag). Picking a different day, pressing Today, or
  // switching back to Week view clears it so the newly focused day
  // starts expanded.
  const [weekDayCollapsed, setWeekDayCollapsed] = useState(false);
  // The Meal List block sits between the day panel (the pick-a-meal
  // box) and the protein stock box: a row of three action buttons
  // (Add Meal, Scan Recipe, Recipe Generator) first, and directly
  // below it the collapsible "Meal List" heading, a slim full-width
  // row. Their panels (the add-meal form, the scan-recipe intake,
  // and the recipe generator dropdown) open directly under the
  // block. The calendar header row holds only the [‹] title [›]
  // group; the toolbar row holds the Month/Week toggle + Today.
  const [mealListOpen, setMealListOpen] = useState(false);
  // The three action panels are mutually exclusive: at most one of
  // "add" | "scan" | "generator" is open at a time, and tapping the
  // open panel's button closes it (back to none). The Meal List
  // toggle below the button row is NOT part of this exclusivity.
  const [openPanel, setOpenPanel] = useState<
    "add" | "scan" | "generator" | null
  >(null);
  const addMealOpen = openPanel === "add";
  const generatorOpen = openPanel === "generator";
  const scanOpen = openPanel === "scan";
  const togglePanel = (panel: "add" | "scan" | "generator") =>
    setOpenPanel((cur) => (cur === panel ? null : panel));
  // Set when a pick lands on the same meal that slot already had
  // picked — the heart popup celebrates the match.
  const [heartMatch, setHeartMatch] = useState<{
    mealName: string;
    mealType: MealType;
    dateKey: string;
  } | null>(null);
  // "date|type|meal" key of the heart popup the user has closed this
  // session; the server copy is dismissed too, this just covers the
  // refetch gap.
  const [closedMatchKey, setClosedMatchKey] = useState<string | null>(null);

  const invalidate = () =>
    queryClient.invalidateQueries({ queryKey: ["planner"] });

  const setPick = useMutation({
    mutationFn: async (args: {
      date: string;
      mealType: MealType;
      mealId: number;
      pickId: number | null;
      proteinId: number | null;
      servings?: number;
      variant?: string | null;
    }) => await api.setPick(args),
    onSuccess: invalidate,
  });
  const clearPick = useMutation({
    mutationFn: async (pickId: number) => await api.clearPick({ pickId }),
    onSuccess: invalidate,
  });
  const dismissMatch = useMutation({
    mutationFn: async (args: { date: string; mealType: MealType }) =>
      await api.dismissMatch(args),
    onSuccess: invalidate,
  });
  const flagForShopping = useMutation({
    mutationFn: async (sheetName: string) =>
      await api.flagForShopping({ sheetName }),
    onSuccess: invalidate,
  });
  const unflagForShopping = useMutation({
    mutationFn: async (sheetName: string) =>
      await api.unflagForShopping({ sheetName }),
    onSuccess: invalidate,
  });

  // Eaten ✓ logging: the usage log's non-undone pick ids decide each
  // calendar button's state, and tapping a button logs that pick's
  // protein usage (recipe amounts, via buildEatenEntries) in one
  // logUsage call, through the pending-adjustment queue; the entries
  // show up in the HIT List tab's Usage log dropdown.
  const usageLog = useQuery({
    queryKey: ["usage"],
    queryFn: () => api.getUsageLog({}),
  });
  const eatenPickIds = useMemo(
    () => new Set(usageLog.data?.loggedPickIds ?? []),
    [usageLog.data],
  );
  // Picks that were marked eaten but had nothing tracked to deduct
  // (no protein chosen, or the proteins aren't on the HIT List)
  // still count as eaten — the button locks via eatenPickIds — and
  // the day box (which reads noDeductionPickIds itself) says plainly
  // that nothing was deducted.
  const [eatenError, setEatenError] = useState<string | null>(null);
  const markEaten = useMutation({
    mutationFn: async (args: { pick: Pick; meal: Meal }) => {
      const entries = buildEatenEntries({
        ingredients: args.meal.ingredients,
        proteins: args.meal.proteins,
        chosenProteinId: args.pick.proteinId,
        servings: args.pick.servings,
      });
      if (entries.length === 0) {
        // Nothing tracked to deduct — but the meal WAS eaten, so
        // record a zero-deduction marker entry: the pick lands in
        // loggedPickIds (button locks to "Eaten ✓", Month view shows
        // its ✓) and in noDeductionPickIds (the day box explains
        // that nothing was deducted). The marker's item is the
        // meal's first protein name, or the meal name when the meal
        // has no proteins at all.
        return await api.logUsage({
          entries: [
            {
              item: args.meal.proteins[0]?.sheetName ?? args.meal.name,
              deducted: 0,
              usedSome: true,
            },
          ],
          source: `${args.meal.name} · ${args.pick.date}`,
          mealId: args.meal.id,
          mealName: args.meal.name,
          pickId: args.pick.id,
          pickDate: args.pick.date,
        });
      }
      return await api.logUsage({
        entries,
        source: `${args.meal.name} · ${args.pick.date}`,
        mealId: args.meal.id,
        mealName: args.meal.name,
        pickId: args.pick.id,
        pickDate: args.pick.date,
      });
    },
    onSuccess: (res) => {
      if (res.ok) {
        setEatenError(null);
        queryClient.invalidateQueries({ queryKey: ["usage"] });
        queryClient.invalidateQueries({ queryKey: ["hit"] });
        queryClient.invalidateQueries({ queryKey: ["planner"] });
        queryClient.invalidateQueries({ queryKey: ["list"] });
      } else {
        setEatenError(res.error ?? "That usage couldn't be logged.");
      }
    },
    onError: () =>
      setEatenError("That usage couldn't be logged. Try again."),
  });

  const data = planner.data;
  // All of a day's picks (up to 5), already in meal-of-day order from
  // the server.
  const picksByDate = useMemo(() => {
    const map = new Map<string, Pick[]>();
    for (const pick of data?.picks ?? []) {
      const list = map.get(pick.date) ?? [];
      list.push(pick);
      map.set(pick.date, list);
    }
    return map;
  }, [data]);

  // Monday-first month grid: 6 rows of 7, padded with neighbour-month days.
  const cells = useMemo(() => {
    const first = new Date(cursor.year, cursor.month, 1);
    const lead = (first.getDay() + 6) % 7;
    const start = new Date(cursor.year, cursor.month, 1 - lead);
    return Array.from({ length: 42 }, (_, i) => {
      const d = new Date(start.getFullYear(), start.getMonth(), start.getDate() + i);
      return { key: toKey(d), date: d, inMonth: d.getMonth() === cursor.month };
    });
  }, [cursor]);

  const moveMonth = (delta: number) => {
    setCursor((c) => {
      const next = new Date(c.year, c.month + delta, 1);
      return { year: next.getFullYear(), month: next.getMonth() };
    });
  };

  // Monday-first week containing the anchor date.
  const weekCells = useMemo(() => {
    const anchor = parseKey(weekAnchor);
    const monday = new Date(
      anchor.getFullYear(),
      anchor.getMonth(),
      anchor.getDate() - ((anchor.getDay() + 6) % 7),
    );
    return Array.from({ length: 7 }, (_, i) => {
      const d = new Date(
        monday.getFullYear(),
        monday.getMonth(),
        monday.getDate() + i,
      );
      return { key: toKey(d), date: d };
    });
  }, [weekAnchor]);

  // Week view display order: the same 7 days, rotated so the list
  // starts with the selected day itself at the top, then the
  // proceeding days of the week in order, wrapping around
  // (Saturday selected → Sat, Sun, Mon, Tue, Wed, Thu, Fri).
  // The rotation re-anchors whenever the selection changes. When the
  // selected date isn't in the displayed week (e.g. after paging with
  // the arrows, which move the period without moving the selection),
  // the natural Monday-first order stands.
  const weekCellsOrdered = useMemo(() => {
    const idx = weekCells.findIndex((c) => c.key === selectedDate);
    if (idx < 0) return weekCells;
    const start = idx; // the selected day heads the list
    return [...weekCells.slice(start), ...weekCells.slice(0, start)];
  }, [weekCells, selectedDate]);

  const moveWeek = (delta: number) => {
    const anchor = parseKey(weekAnchor);
    const next = new Date(
      anchor.getFullYear(),
      anchor.getMonth(),
      anchor.getDate() + delta * 7,
    );
    setWeekAnchor(toKey(next));
  };

  const goToday = () => {
    const now = new Date();
    setCursor({ year: now.getFullYear(), month: now.getMonth() });
    setWeekAnchor(toKey(now));
    setSelectedDate(toKey(now));
    setWeekDayCollapsed(false);
  };

  const flagSet = useMemo(
    () => new Set((data?.shoppingFlags ?? []).map((f) => f.sheetName)),
    [data],
  );

  const toggleFlag = (sheetName: string) => {
    if (flagSet.has(sheetName)) unflagForShopping.mutate(sheetName);
    else flagForShopping.mutate(sheetName);
  };

  // All of the selected day's picks; the day box shows them at its
  // top, grouped under their meal type, and manages which pick
  // (if any) is being changed internally.
  const dayPicks = picksByDate.get(selectedDate) ?? [];

  // The heart popup to show: a match just made in this session, or the
  // newest match the server recorded earlier that hasn't been
  // dismissed yet.
  const pendingMatch = data?.matches[data.matches.length - 1] ?? null;
  const activeMatch =
    heartMatch ??
    (pendingMatch
      ? {
          mealName: pendingMatch.mealName,
          mealType: pendingMatch.mealType,
          dateKey: pendingMatch.date,
        }
      : null);
  const activeMatchKey = activeMatch
    ? `${activeMatch.dateKey}|${activeMatch.mealType}|${activeMatch.mealName}`
    : null;
  const closeHeartPopup = () => {
    if (activeMatchKey) setClosedMatchKey(activeMatchKey);
    if (activeMatch) {
      dismissMatch.mutate({
        date: activeMatch.dateKey,
        mealType: activeMatch.mealType,
      });
    }
    setHeartMatch(null);
  };

  const knownItems = (hit.data?.items ?? []).map((i) => i.item);

  // The day box for the selected date. It renders in week view only:
  // it opens under the chosen day's header row while the other days
  // stay slim (and the chosen day's header can collapse it again).
  // Month view is calendar-only — tapping a month day jumps to week
  // view focused on that day, where the box lives. It falls back to
  // below the calendar only when the selected date isn't in the week
  // on screen (e.g. after paging with the arrows, which move the
  // period without moving the selection).
  const selectedInWeek = weekCells.some((c) => c.key === selectedDate);

  // Tapping a day in the month calendar: select that date and switch
  // to week view focused on it (week containing it, day expanded).
  const openDayInWeek = (key: string) => {
    setSelectedDate(key);
    setWeekAnchor(key);
    setWeekDayCollapsed(false);
    setView("week");
  };

  // The Eaten? / Eaten ✓ button for one pick, rendered beside its
  // meal name in week view (the only view that can mark a pick eaten).
  const renderEatenButton = (p: Pick) => {
    const m = data?.meals.find((x) => x.id === p.mealId) ?? null;
    if (!m) return null;
    return (
      <EatenButton
        mealName={p.mealName}
        eaten={eatenPickIds.has(p.id)}
        pending={
          markEaten.isPending && markEaten.variables?.pick.id === p.id
        }
        onMarkEaten={() => {
          setEatenError(null);
          markEaten.mutate({ pick: p, meal: m });
        }}
      />
    );
  };

  const renderDayPanel = (embedded: boolean) => (
    <DayPanel
      key={selectedDate}
      embedded={embedded}
      dateKey={selectedDate}
      meals={data?.meals ?? []}
      dayPicks={dayPicks}
      flags={flagSet}
      suggestionSeed={effectiveSuggestionSeed}
      saving={setPick.isPending || clearPick.isPending}
      onSave={(mealType, mealId, proteinId, servings, variant, pickId) =>
        setPick.mutate({
          date: selectedDate,
          mealType,
          mealId,
          pickId,
          proteinId,
          servings,
          variant,
        })
      }
      onClear={(pickId) => clearPick.mutate(pickId)}
      onToggleFlag={toggleFlag}
      onSameMealMatch={(meal, mealType) =>
        setHeartMatch({
          mealName: meal.name,
          mealType,
          dateKey: selectedDate,
        })
      }
      renderEatenButton={renderEatenButton}
    />
  );

  return (
    <div>
      {/* Month / week navigation. In both views the paging arrows
          sit on either side of the title in one left-aligned group
          ([‹] November 2026 [›] / [‹] Nov 9 – 15, 2026 [›]) and the
          row holds nothing else; Today sits in the toolbar row
          below, beside the Month/Week toggle, and Add Meal lives
          down in the Meal List row. */}
      {view === "month" ? (
        <div className="flex items-center gap-2 pt-2">
          <div className="flex items-center gap-1">
            <button
              type="button"
              aria-label="Previous month"
              onClick={() => moveMonth(-1)}
              className="min-h-4 rounded-lg border border-[var(--border)] bg-[var(--surface)] px-1.5 text-[9px] leading-[14px] text-[var(--text)]"
            >
              ‹
            </button>
            <h2 className="text-2xl font-bold text-[var(--text)]">
              {`${MONTHS[cursor.month]} ${cursor.year}`}
            </h2>
            <button
              type="button"
              aria-label="Next month"
              onClick={() => moveMonth(1)}
              className="min-h-4 rounded-lg border border-[var(--border)] bg-[var(--surface)] px-1.5 text-[9px] leading-[14px] text-[var(--text)]"
            >
              ›
            </button>
          </div>
        </div>
      ) : (
        <div className="flex items-center gap-2 pt-2">
          <div className="flex items-center gap-1">
            <button
              type="button"
              aria-label="Previous week"
              onClick={() => moveWeek(-1)}
              className="min-h-4 rounded-lg border border-[var(--border)] bg-[var(--surface)] px-1.5 text-[9px] leading-[14px] text-[var(--text)]"
            >
              ‹
            </button>
            <h2 className="text-2xl font-bold text-[var(--text)]">
              {weekCells[0] && weekCells[6]
                ? weekCells[0].date.getMonth() === weekCells[6].date.getMonth()
                  ? `${formatShort(weekCells[0].key)} – ${weekCells[6].date.getDate()}, ${weekCells[6].date.getFullYear()}`
                  : `${formatShort(weekCells[0].key)} – ${formatShort(weekCells[6].key)}, ${weekCells[6].date.getFullYear()}`
                : ""}
            </h2>
            <button
              type="button"
              aria-label="Next week"
              onClick={() => moveWeek(1)}
              className="min-h-4 rounded-lg border border-[var(--border)] bg-[var(--surface)] px-1.5 text-[9px] leading-[14px] text-[var(--text)]"
            >
              ›
            </button>
          </div>
        </div>
      )}

      <div className="mt-2 flex items-center gap-2">
        <div
          role="group"
          aria-label="Calendar view"
          className="flex shrink-0 overflow-hidden rounded-lg border border-[var(--border)]"
        >
          <button
            type="button"
            aria-pressed={view === "month"}
            onClick={() => setView("month")}
            className={`px-3 py-1.5 text-sm font-medium ${
              view === "month"
                ? "bg-[var(--accent)] text-[var(--accent-text)]"
                : "bg-[var(--surface)] text-[var(--text)]"
            }`}
          >
            Month
          </button>
          <button
            type="button"
            aria-pressed={view === "week"}
            onClick={() => {
              setWeekAnchor(selectedDate);
              setWeekDayCollapsed(false);
              setView("week");
            }}
            className={`px-3 py-1.5 text-sm font-medium ${
              view === "week"
                ? "bg-[var(--accent)] text-[var(--accent-text)]"
                : "bg-[var(--surface)] text-[var(--text)]"
            }`}
          >
            Week
          </button>
        </div>
        <button
          type="button"
          onClick={goToday}
          className="shrink-0 rounded-lg border border-[var(--border)] bg-[var(--surface)] px-3 text-sm font-medium text-[var(--text)]"
        >
          Today
        </button>
      </div>

      <div className="mt-2 flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-[var(--dim)]">
        <span className="flex items-center gap-1.5">
          <span className="inline-block h-2.5 w-2.5 rounded-full bg-[var(--ok-text)]" />
          Protein in stock
        </span>
        <span className="flex items-center gap-1.5">
          <span className="inline-block h-2.5 w-2.5 rounded-full bg-[var(--out-text)]" />
          Out of stock
        </span>
        <span className="flex items-center gap-1.5">
          <span className="inline-block h-2.5 w-2.5 rounded-full bg-[var(--unknown-text)]" />
          Not counted yet
        </span>
      </div>

      {eatenError && (
        <p
          className="mt-2 text-sm"
          style={{ color: "var(--red)" }}
          role="alert"
        >
          {eatenError}
        </p>
      )}

      {planner.isPending && (
        <p className="py-16 text-center text-[var(--dim)]">
          Loading the calendar…
        </p>
      )}
      {planner.error && (
        <p className="py-16 text-center text-[var(--out-text)]">
          The planner couldn&apos;t load. Check your connection and reopen it.
        </p>
      )}

      {data && data.meals.length === 0 && (
        <div className="py-12 text-center">
          <p className="text-base font-semibold text-[var(--text)]">
            No meals yet
          </p>
          <p className="mx-auto mt-2 max-w-xs text-sm text-[var(--dim)]">
            Add your first meal with the Add Meal button in the Meal
            List row below and it will show up in the picker here.
          </p>
        </div>
      )}

      {data && data.meals.length > 0 && (
        <>
          {/* Calendar grid. Month view is the calendar only — no day
              box, no picking; tapping a day switches to week view
              focused on that day. In week view the days form an
              accordion — every day keeps a header row, the chosen
              day's box opens under its header while the other days
              stay slim, and tapping the chosen day's header collapses
              its box away again. The box is the meal picker when no
              meal is chosen yet, and the meal / protein / last-eaten /
              ingredients view when one is. */}
          {view === "month" ? (
            <>
              <div className="mt-2 grid grid-cols-7 gap-1 text-center text-xs font-medium text-[var(--dim)]">
                {WEEKDAYS.map((d) => (
                  <div key={d} className="py-1">
                    {d}
                  </div>
                ))}
              </div>
              <div className="flex flex-col gap-1">
                {Array.from({ length: 6 }, (_, r) =>
                  cells.slice(r * 7, r * 7 + 7),
                ).map((row, ri) => (
                  <div key={ri} className="grid grid-cols-7 gap-1">
                      {row.map((cell) => {
                        const cellPicks = picksByDate.get(cell.key) ?? [];
                        const isToday = cell.key === toKey(new Date());
                        const isSelected = cell.key === selectedDate;
                        return (
                          // ONE interactive element per cell: the
                          // whole cell is the button (no nested
                          // clickable date button inside a clickable
                          // wrapper).
                          <button
                            key={cell.key}
                            type="button"
                            aria-label={`${formatLong(cell.key)}${cellPicks.length > 0 ? `: ${cellPicks.map((p) => `${mealTypeLabel(p.mealType)}: ${p.mealName}`).join(", ")}` : ""}`}
                            aria-pressed={isSelected}
                            onClick={() => openDayInWeek(cell.key)}
                            className={`flex min-h-[64px] flex-col items-stretch rounded-[var(--radius)] border p-1 text-left text-[var(--text)] sm:min-h-[84px] sm:p-1.5 ${
                              isSelected
                                ? "border-[var(--accent)] ring-2 ring-[var(--accent)]"
                                : "border-[var(--border)]"
                            } ${cellPicks.length > 0 ? "bg-[var(--ok-bg)]" : "bg-[var(--surface)]"} ${
                              cell.inMonth ? "" : "opacity-45"
                            }`}
                          >
                            <span
                              className={`self-start text-sm font-medium ${
                                isToday
                                  ? "flex h-6 w-6 items-center justify-center rounded-full bg-[var(--accent)] text-[var(--accent-text)]"
                                  : ""
                              }`}
                            >
                              {cell.date.getDate()}
                            </span>
                            {/* Each pick shows its compact meal name,
                                stepped down in size the longer it is
                                so it fits the cell. No Eaten button
                                here — marking eaten happens in week
                                view only. A pick that has been marked
                                eaten gets a plain ✓ beside its name
                                as a passive marker. */}
                            {cellPicks.map((p) => (
                              <span
                                key={p.id}
                                className="mt-0.5 flex items-start gap-1"
                              >
                                <span
                                  className="min-w-0 flex-1 leading-tight font-semibold break-words"
                                  style={{
                                    fontSize: monthNameFontSize(p.mealName),
                                  }}
                                >
                                  {p.mealName}
                                </span>
                                {eatenPickIds.has(p.id) && (
                                  <span
                                    role="img"
                                    aria-label={`${p.mealName} eaten — usage logged`}
                                    title="Eaten — usage logged"
                                    className="shrink-0 text-[10px] leading-tight font-bold"
                                    style={{ color: "var(--ok-text)" }}
                                  >
                                    ✓
                                  </span>
                                )}
                              </span>
                            ))}
                          </button>
                        );
                      })}
                  </div>
                ))}
              </div>
            </>
          ) : (
            <>
              <ul className="mt-2 space-y-1.5">
                {weekCellsOrdered.map((cell, cellIndex) => {
                  const cellPicks = picksByDate.get(cell.key) ?? [];
                  const isToday = cell.key === toKey(new Date());
                  const isSelected = cell.key === selectedDate;
                  // Accordion: the selected day is expanded unless
                  // the user collapsed it; every other day is a slim
                  // collapsed header row. Tapping a collapsed day
                  // expands it (and selects it); tapping the expanded
                  // day's header collapses it back to a slim row.
                  const isExpanded = isSelected && !weekDayCollapsed;
                  const toggleDay = () => {
                    if (isExpanded) {
                      setWeekDayCollapsed(true);
                    } else {
                      setSelectedDate(cell.key);
                      setWeekDayCollapsed(false);
                    }
                  };
                  // Week-boundary seam: when the rotated list wraps
                  // from a Sunday box straight into a Monday box, a
                  // slim "New week" divider sits between them so the
                  // week change is visible. In natural Monday-first
                  // order no Sunday→Monday adjacency occurs inside
                  // the list, so no divider appears.
                  const prevCell =
                    cellIndex > 0
                      ? weekCellsOrdered[cellIndex - 1]
                      : undefined;
                  const weekBoundary =
                    prevCell != null &&
                    prevCell.date.getDay() === 0 &&
                    cell.date.getDay() === 1;
                  return (
                    <Fragment key={cell.key}>
                      {weekBoundary && (
                        <li
                          aria-hidden="true"
                          className="flex items-center gap-2 px-1"
                        >
                          <span className="h-px flex-1 bg-[var(--border)]" />
                          <span className="text-[13px] font-medium text-[var(--dim)]">
                            New week
                          </span>
                          <span className="h-px flex-1 bg-[var(--border)]" />
                        </li>
                      )}
                      <li>
                      <div
                        onClick={toggleDay}
                        className={`flex w-full cursor-pointer items-center justify-between gap-3 rounded-[var(--radius)] border bg-[var(--surface)] px-3 text-left text-[var(--text)] ${
                          isExpanded
                            ? "border-[var(--accent)] ring-2 ring-[var(--accent)]"
                            : "border-[var(--border)]"
                        } ${selectedInWeek && !weekDayCollapsed ? "py-1.5" : "py-2.5"}`}
                      >
                        <button
                          type="button"
                          aria-label={`${formatLong(cell.key)}${cellPicks.length > 0 ? `: ${cellPicks.map((p) => `${mealTypeLabel(p.mealType)}: ${p.mealName}`).join(", ")}` : ""}`}
                          aria-expanded={isExpanded}
                          onClick={(e) => {
                            e.stopPropagation();
                            toggleDay();
                          }}
                          className="flex shrink-0 items-baseline gap-2"
                        >
                          <span className="w-9 text-sm font-semibold">
                            {WEEKDAYS[(cell.date.getDay() + 6) % 7]}
                          </span>
                          <span
                            className={
                              isToday
                                ? "flex h-6 w-6 items-center justify-center rounded-full bg-[var(--accent)] text-sm font-medium text-[var(--accent-text)]"
                                : "text-sm font-medium"
                            }
                          >
                            {cell.date.getDate()}
                          </span>
                        </button>
                        <span className="flex min-w-0 items-center gap-2">
                          {cellPicks.length > 0 ? (
                            <span className="flex min-w-0 flex-wrap items-center justify-end gap-1">
                              {cellPicks.map((p) => (
                                <span
                                  key={p.id}
                                  className="flex items-center gap-1"
                                >
                                  <span className="truncate rounded-md bg-[var(--ok-bg)] px-2 py-1 text-sm font-medium text-[var(--ok-text)]"
                                >
                                  {p.mealName}
                                </span>
                                  {renderEatenButton(p)}
                                </span>

                              ))}
                            </span>
                          ) : (
                            <span className="text-sm text-[var(--dim)]">
                              Nothing picked yet
                            </span>
                          )}
                          <button
                            type="button"
                            aria-label={
                              isExpanded
                                ? `Collapse ${formatLong(cell.key)}`
                                : `Expand ${formatLong(cell.key)}`
                            }
                            aria-expanded={isExpanded}
                            onClick={(e) => {
                              e.stopPropagation();
                              toggleDay();
                            }}
                            className="min-h-0 shrink-0 px-1 text-sm text-[var(--dim)]"
                          >
                            {isExpanded ? "▾" : "▸"}
                          </button>
                        </span>
                      </div>
                      {isExpanded && (
                        <div className="mt-1.5">{renderDayPanel(true)}</div>
                      )}
                      </li>
                    </Fragment>
                  );
                })}
              </ul>
              {!selectedInWeek && renderDayPanel(false)}
            </>
          )}
        </>
      )}

      {data && (
        <>
          {/* Meal List block: below the pick-a-meal box (day panel),
              above the protein stock box. A row of three action
              buttons — Add Meal, Scan Recipe, Recipe Generator, left
              to right — comes first; directly under it, the Meal
              List collapse toggle, a slim full-width row of its own.
              The meal list, the add-meal form, the recipe generator,
              and the scan-recipe panel each open directly under the
              block. */}
          <div className="mt-2">
            <div className="flex items-stretch gap-2">
              <button
                type="button"
                aria-expanded={addMealOpen}
                onClick={() => togglePanel("add")}
                className={
                  addMealOpen
                    ? "min-w-0 flex-1 rounded-[var(--radius)] bg-[var(--accent)] px-2 py-2 text-sm font-medium text-[var(--accent-text)]"
                    : "min-w-0 flex-1 rounded-[var(--radius)] border border-[var(--border)] bg-[var(--surface)] px-2 py-2 text-sm font-medium text-[var(--text)]"
                }
              >
                {addMealOpen ? "Close" : "Add Meal"}
              </button>
              <button
                type="button"
                aria-expanded={scanOpen}
                aria-controls="scan-recipe-panel"
                onClick={() => togglePanel("scan")}
                className={
                  scanOpen
                    ? "min-w-0 flex-1 rounded-[var(--radius)] bg-[var(--accent)] px-2 py-2 text-sm font-medium text-[var(--accent-text)]"
                    : "min-w-0 flex-1 rounded-[var(--radius)] border border-[var(--border)] bg-[var(--surface)] px-2 py-2 text-sm font-medium text-[var(--text)]"
                }
              >
                {scanOpen ? "Close" : "Scan Recipe"}
              </button>
              <button
                type="button"
                aria-expanded={generatorOpen}
                aria-controls="recipe-generator-panel"
                onClick={() => togglePanel("generator")}
                className={
                  generatorOpen
                    ? "shrink-0 rounded-[var(--radius)] bg-[var(--accent)] px-2 py-1 text-center text-[13px] leading-[1.15] font-medium whitespace-nowrap text-[var(--accent-text)]"
                    : "shrink-0 rounded-[var(--radius)] border border-[var(--border)] bg-[var(--surface)] px-2 py-1 text-center text-[13px] leading-[1.15] font-medium whitespace-nowrap text-[var(--text)]"
                }
              >
                {generatorOpen ? "Close" : "Recipe Generator"}
              </button>
            </div>
            <button
              type="button"
              aria-expanded={mealListOpen}
              aria-controls="meal-list"
              onClick={() => setMealListOpen((v) => !v)}
              className="mt-2 flex w-full min-w-0 items-center justify-between gap-2 rounded-[var(--radius)] border border-[var(--border)] bg-[var(--surface)] px-3 py-1.5 text-left text-[var(--text)]"
            >
              <span className="text-sm font-semibold">Meal List</span>
              <span className="flex items-center gap-2 text-xs text-[var(--dim)]">
                <span>
                  {data.meals.length}{" "}
                  {data.meals.length === 1 ? "meal" : "meals"}
                </span>
                <span aria-hidden="true">{mealListOpen ? "▾" : "▸"}</span>
              </span>
            </button>
            <MealIdeas
              meals={data.meals}
              knownItems={knownItems}
              listOpen={mealListOpen}
              formOpen={addMealOpen}
              onFormOpenChange={(open) =>
                setOpenPanel(open ? "add" : null)
              }
              onListOpenChange={setMealListOpen}
            />
            {/* The generator and scan panels stay mounted while
                collapsed (hidden) so collapsing one never discards
                its state: a file scan keeps polling in the
                background and its draft still lands, and a
                half-filled form or generated recipe survives. */}
            <div id="recipe-generator-panel" hidden={!generatorOpen}>
              <RecipeGenerator
                inventory={data.inventory}
                onMealSaved={() => setMealListOpen(true)}
              />
            </div>
            <div id="scan-recipe-panel" hidden={!scanOpen}>
              <ScanRecipePanel onSaved={() => setMealListOpen(true)} />
            </div>
          </div>

          <InventoryPanel
            inventory={data.inventory}
            updatedAt={data.inventoryUpdatedAt}
            flags={flagSet}
            onToggleFlag={toggleFlag}
          />
        </>
      )}
      {data && <RecipeVideosSection />}
      {activeMatch && activeMatchKey !== closedMatchKey && (
        <HeartMatchPopup
          mealName={activeMatch.mealName}
          mealType={activeMatch.mealType}
          dateKey={activeMatch.dateKey}
          onClose={closeHeartPopup}
        />
      )}
    </div>
  );
}

/**
 * The heart popup: it appears when a pick lands on a slot whose
 * existing pick is the same meal — both planners picked the same meal
 * for the same slot on the same day. Matches are recorded server-side
 * when the matching pick is saved, so the popup also appears on the
 * next open if the match landed while the app was closed; closing it
 * dismisses the record. The message sits inside a big heart; tapping
 * anywhere (backdrop, heart, or the button) or pressing Escape closes
 * it.
 */
function HeartMatchPopup({
  mealName,
  mealType,
  dateKey,
  onClose,
}: {
  mealName: string;
  mealType: MealType;
  dateKey: string;
  onClose: () => void;
}) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/45 p-6"
      onClick={onClose}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-label={`You both picked ${mealName}`}
        className="heart-pop w-[330px] max-w-full"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="relative">
          <svg
            viewBox="0 0 100 92"
            aria-hidden="true"
            className="block w-full drop-shadow-2xl"
          >
            <path
              d="M50 86C28 68 8 50 8 29 8 15 18 6 30 6c8.5 0 16.5 4.8 20 12.6C53.5 10.8 61.5 6 70 6c12 0 22 9 22 23 0 21-20 39-42 57z"
              fill="var(--heart)"
            />
          </svg>
          <div className="absolute inset-0 flex flex-col items-center justify-center px-14 pt-1 text-center text-[var(--heart-text)]">
            <p className="text-2xl leading-tight font-semibold">
              Great minds think alike!
            </p>
            <p className="mt-2 text-sm leading-snug">
              You both picked <strong>{mealName}</strong> for{" "}
              {mealTypeLabel(mealType).toLowerCase()} on{" "}
              {formatLong(dateKey)}.
            </p>
          </div>
        </div>
        <button
          type="button"
          autoFocus
          onClick={onClose}
          className="mx-auto mt-3 block rounded-full bg-[var(--surface)] px-6 py-2 font-medium text-[var(--text)] shadow-lg"
        >
          Sweet!
        </button>
      </div>
    </div>
  );
}

/**
 * The small "Eaten?" button shown beside a pick's meal name in
 * week view — the only place a pick can be marked eaten. Before it
 * is tapped it reads "Eaten?" with no checkmark; once the pick has
 * usage logged it reads "Eaten ✓". Tapping it
 * logs the meal's protein usage immediately — no popup. Once the
 * pick has usage logged it renders filled and disabled, so the
 * same pick can't be logged twice (undo lives in the HIT List's
 * Usage log). Month view has no button: it shows a plain ✓ beside
 * the meal name of a pick that has been marked eaten here.
 */
function EatenButton({
  mealName,
  eaten,
  pending,
  onMarkEaten,
}: {
  mealName: string;
  eaten: boolean;
  pending: boolean;
  onMarkEaten: () => void;
}) {
  if (eaten) {
    return (
      <button
        type="button"
        disabled
        aria-label={`${mealName} eaten — protein usage logged`}
        className="min-h-0 shrink-0 rounded-full px-2 py-0.5 text-xs font-bold"
        style={{
          backgroundColor: "var(--accent)",
          color: "var(--accent-text)",
        }}
      >
        Eaten ✓
      </button>
    );
  }
  return (
    <button
      type="button"
      disabled={pending}
      aria-label={`Mark ${mealName} as eaten and log its protein usage`}
      onClick={(e) => {
        e.stopPropagation();
        onMarkEaten();
      }}
      className="min-h-0 shrink-0 rounded-full border px-2 py-0.5 text-xs font-bold disabled:opacity-50"
      style={{
        borderColor: "var(--ok-text)",
        color: "var(--ok-text)",
        backgroundColor: "var(--surface)",
      }}
    >
      {pending ? "Logging…" : "Eaten?"}
    </button>
  );
}

/**
 * The day box (week view). The day's existing picks display at the
 * top, grouped by meal of the day, each with its full display —
 * protein, servings, Eaten button, Change / Clear. Below them a
 * single first-step query asks "Plan a…" with four tappable
 * choices — Breakfast, Lunch, Dinner, Snack. Choosing one reveals
 * that meal type's picking flow beneath the choices: the
 * choose-meal dropdown filtered to that type, the launch-shuffled
 * suggestions, then the protein / style / servings flow once a meal
 * is chosen — the same picking system as before, revealed for one
 * type at a time instead of four always-visible sections. The type
 * chosen in the "Plan a…" step defines a new pick's meal type —
 * there is no separate "which meal is this?" step. "Change meal" on
 * a pick jumps the picker to that pick's type, pre-filled with the
 * pick; saving updates the pick in place. A type with no meals on
 * the list yet shows the same empty dropdown and note after being
 * chosen. A day still holds at most MAX_PICKS_PER_DAY picks across
 * all four types combined.
 */
function DayPanel({
  dateKey,
  meals,
  dayPicks,
  embedded,
  flags,
  suggestionSeed,
  saving,
  onSave,
  onClear,
  onToggleFlag,
  onSameMealMatch,
  renderEatenButton,
}: {
  dateKey: string;
  meals: Meal[];
  /** All of the day's picks (up to 5), in meal-of-day order. */
  dayPicks: Pick[];
  embedded?: boolean;
  flags: Set<string>;
  suggestionSeed: number;
  saving: boolean;
  onSave: (
    mealType: MealType,
    mealId: number,
    proteinId: number | null,
    servings: number,
    variant: string | null,
    pickId: number | null,
  ) => void;
  onClear: (pickId: number) => void;
  onToggleFlag: (sheetName: string) => void;
  onSameMealMatch: (meal: Meal, mealType: MealType) => void;
  renderEatenButton: (pick: Pick) => ReactNode;
}) {
  const favouriteIds = useMemo(() => favouriteIdsOf(meals), [meals]);
  const atCap = dayPicks.length >= MAX_PICKS_PER_DAY;

  // The "Plan a…" step: which meal of the day is being planned.
  // Null until one of the four choices is tapped (or a pick's
  // Change button jumps straight to that pick's type).
  const [activeType, setActiveType] = useState<MealType | null>(null);
  // The pick being changed through the picker, with a sequence
  // number so asking to change the same pick again re-opens the
  // picker pre-filled even after a previous change was finished.
  const [changeRequest, setChangeRequest] = useState<{
    pick: Pick;
    seq: number;
  } | null>(null);
  const changeSeqRef = useRef(0);

  // Usage markers for the day's picks: which have been marked
  // eaten, and which of those deducted nothing.
  const usageLog = useQuery({
    queryKey: ["usage"],
    queryFn: () => api.getUsageLog({}),
  });
  const loggedPickIds = usageLog.data?.loggedPickIds ?? [];
  const noDeductionPickIds = usageLog.data?.noDeductionPickIds ?? [];

  const startChange = (p: Pick) => {
    changeSeqRef.current += 1;
    setChangeRequest({ pick: p, seq: changeSeqRef.current });
    setActiveType(p.mealType);
  };

  const chooseType = (t: MealType) => {
    setChangeRequest(null);
    setActiveType((cur) => (cur === t ? null : t));
  };

  const changingPick =
    changeRequest && changeRequest.pick.mealType === activeType
      ? changeRequest.pick
      : null;

  return (
    <section
      aria-label={`Meals for ${formatLong(dateKey)}`}
      className={`${embedded ? "" : "mt-2 "}rounded-[var(--radius)] border border-[var(--border)] bg-[var(--surface)] p-4 text-[var(--text)]`}
    >
      <h2 className="text-xl font-semibold">{formatLong(dateKey)}</h2>
      {atCap && (
        <p className="mt-1 text-sm text-[var(--dim)]">
          That&apos;s {MAX_PICKS_PER_DAY} meals — the most a day holds.
          Clear a pick below to make room for another.
        </p>
      )}

      {/* The day's existing picks, at the top, grouped by meal of
          the day in Breakfast → Snack order, each with its full
          display. */}
      {MEAL_TYPES.map((t) => {
        const picks = dayPicks.filter((p) => p.mealType === t.id);
        if (picks.length === 0) return null;
        return (
          <div
            key={t.id}
            className="mt-4 border-t border-[var(--border)] pt-3"
          >
            <h3 className="text-lg font-semibold">{t.label}</h3>
            {picks.map((p) => (
              <DayPick
                key={p.id}
                pick={p}
                meal={meals.find((m) => m.id === p.mealId) ?? null}
                dateKey={dateKey}
                flags={flags}
                saving={saving}
                usageLogged={loggedPickIds.includes(p.id)}
                noDeduction={noDeductionPickIds.includes(p.id)}
                onStartChange={startChange}
                onClear={onClear}
                onSave={onSave}
                onToggleFlag={onToggleFlag}
                renderEatenButton={renderEatenButton}
              />
            ))}
          </div>
        );
      })}

      {/* Step 1 of picking: the "Plan a…" query. Tapping a choice
          reveals that type's picking flow beneath it; tapping the
          chosen type again folds the flow away. Once the day is
          full the query hides — a pick can still be changed from
          its display above, which re-opens the picker on its own. */}
      {!atCap && (
        <div className="mt-4 border-t border-[var(--border)] pt-3">
          <p className="text-lg font-semibold">Plan a…</p>
          <div
            className="mt-2 flex flex-wrap gap-2"
            role="group"
            aria-label="Which meal are you planning?"
          >
            {MEAL_TYPES.map((t) => (
              <button
                key={t.id}
                type="button"
                aria-pressed={activeType === t.id}
                onClick={() => chooseType(t.id)}
                className={`rounded-full border border-[var(--border)] bg-[var(--surface)] px-4 py-2 text-sm font-medium ${
                  activeType === t.id
                    ? "ring-2 ring-[var(--accent)]"
                    : ""
                }`}
              >
                {t.label}
              </button>
            ))}
          </div>
        </div>
      )}

      {/* The chosen type's picking flow, directly beneath the
          "Plan a…" choices. Keyed by type and change request so
          switching types — or starting a change — opens it fresh,
          pre-filled when a pick is being changed. */}
      {activeType && (!atCap || changingPick) && (
        <MealTypePicker
          key={`${activeType}|${changeRequest ? changeRequest.seq : "new"}`}
          type={activeType}
          meals={meals}
          typePicks={dayPicks.filter((p) => p.mealType === activeType)}
          favouriteIds={favouriteIds}
          flags={flags}
          suggestionSeed={suggestionSeed}
          saving={saving}
          changingPick={changingPick}
          onSave={onSave}
          onToggleFlag={onToggleFlag}
          onSameMealMatch={onSameMealMatch}
          onFinishChange={() => setChangeRequest(null)}
        />
      )}
    </section>
  );
}

/**
 * One of the day's existing picks, displayed at the top of the day
 * box under its meal type: meal name with protein and style, the
 * Eaten button, the stock status, the style and servings
 * quick-editors, ingredients, notes, and Change / Clear. "Change
 * meal" hands the pick to the day box's picker below the "Plan a…"
 * choices, pre-filled with it; saving there updates it in place.
 */
function DayPick({
  pick: p,
  meal: pMeal,
  dateKey,
  flags,
  saving,
  usageLogged,
  noDeduction,
  onStartChange,
  onClear,
  onSave,
  onToggleFlag,
  renderEatenButton,
}: {
  pick: Pick;
  meal: Meal | null;
  dateKey: string;
  flags: Set<string>;
  saving: boolean;
  usageLogged: boolean;
  noDeduction: boolean;
  onStartChange: (p: Pick) => void;
  onClear: (pickId: number) => void;
  onSave: (
    mealType: MealType,
    mealId: number,
    proteinId: number | null,
    servings: number,
    variant: string | null,
    pickId: number | null,
  ) => void;
  onToggleFlag: (sheetName: string) => void;
  renderEatenButton: (pick: Pick) => ReactNode;
}) {
  const noProteinChosen =
    pMeal != null &&
    p.proteinId == null &&
    (pMeal.proteins.length === 0 || choiceGroupOf(pMeal) != null);
  return (
    <div className="mt-2">
      <div className="flex flex-wrap items-center gap-2">
        <p className="text-lg font-medium">
          {p.mealName}
          {p.proteinLabel && (
            <span className="text-[var(--dim)]">
              {" "}
              · {p.proteinLabel}
            </span>
          )}
          {p.variant && (
            <span className="text-[var(--dim)]"> · {p.variant}</span>
          )}
        </p>
        {renderEatenButton(p)}
      </div>
      {pMeal ? (
        <>
          <p
            className={`mt-1 text-sm ${mealStatusClasses(pMeal.status)} inline-block rounded-full px-2 py-0.5`}
          >
            {mealStatusWord(pMeal)}
          </p>
          {pMeal.lastEaten && pMeal.lastEaten !== dateKey && (
            <p className="mt-1 text-sm text-[var(--dim)]">
              {lastEatenWord(pMeal)}
            </p>
          )}
          {(() => {
            const spec = variantSpecOf(pMeal);
            if (!spec) return null;
            return (
              <div className="mt-3">
                <p className="text-sm font-medium text-[var(--dim)]">
                  {spec.label}
                  {p.variant == null && (
                    <span className="font-normal">
                      {" "}
                      — not chosen yet
                    </span>
                  )}
                </p>
                <div className="mt-1.5 flex flex-wrap gap-2">
                  {spec.options.map((option) => (
                    <button
                      key={option}
                      type="button"
                      disabled={saving}
                      aria-pressed={p.variant === option}
                      onClick={() =>
                        onSave(
                          p.mealType,
                          p.mealId,
                          p.proteinId,
                          p.servings,
                          option,
                          p.id,
                        )
                      }
                      className={`rounded-full border border-[var(--border)] bg-[var(--surface)] px-3 py-2 text-sm font-medium disabled:opacity-40 ${
                        p.variant === option
                          ? "ring-2 ring-[var(--accent)]"
                          : ""
                      }`}
                    >
                      {option}
                    </button>
                  ))}
                </div>
              </div>
            );
          })()}
          <div className="mt-3 flex items-center gap-3">
            <span className="text-sm font-medium text-[var(--dim)]">
              Cooking for
            </span>
            <ServingsStepper
              value={p.servings}
              disabled={saving}
              onChange={(n) =>
                onSave(
                  p.mealType,
                  p.mealId,
                  p.proteinId,
                  n,
                  p.variant,
                  p.id,
                )
              }
            />
          </div>
          <IngredientSection meal={pMeal} servings={p.servings} />
          <NoteEditor meal={pMeal} />
          <OutProteinFlags
            meal={pMeal}
            flags={flags}
            onToggleFlag={onToggleFlag}
          />
          {usageLogged && (
            <p className="mt-3">
              <span
                className="rounded-full px-2.5 py-1 text-xs font-bold"
                style={{
                  backgroundColor: "var(--ok-bg)",
                  color: "var(--ok-text)",
                }}
              >
                Usage logged ✓
              </span>
            </p>
          )}
          {noDeduction && (
            <p className="mt-2 text-sm text-[var(--dim)]">
              {noProteinChosen
                ? "No protein chosen — nothing tracked to deduct"
                : "Eaten — nothing tracked to deduct"}
            </p>
          )}
          <div className="mt-4 flex gap-2">
            <button
              type="button"
              onClick={() => onStartChange(p)}
              className="rounded-lg bg-[var(--accent)] px-4 py-2 font-medium text-[var(--accent-text)]"
            >
              Change meal
            </button>
            <button
              type="button"
              onClick={() => onClear(p.id)}
              disabled={saving}
              className="rounded-lg border border-[var(--border)] px-4 py-2 font-medium"
            >
              Clear pick
            </button>
          </div>
        </>
      ) : (
        <div className="mt-2">
          <button
            type="button"
            onClick={() => onClear(p.id)}
            disabled={saving}
            className="rounded-lg border border-[var(--border)] px-4 py-2 font-medium"
          >
            Clear pick
          </button>
        </div>
      )}
    </div>
  );
}

/**
 * The picking flow for one meal of the day, revealed in the day box
 * beneath the "Plan a…" choices once that type is chosen — or
 * opened pre-filled by a pick's "Change meal" button: the type's
 * meal dropdown, the launch-shuffled suggestions, then the chosen
 * meal's protein choice (with the style variant where a meal has
 * one), servings, and ingredients. Saving with a pick pre-filled
 * updates that pick in place; otherwise the save adds a new pick of
 * this type.
 */
function MealTypePicker({
  type,
  meals,
  typePicks,
  favouriteIds,
  flags,
  suggestionSeed,
  saving,
  changingPick,
  onSave,
  onToggleFlag,
  onSameMealMatch,
  onFinishChange,
}: {
  type: MealType;
  meals: Meal[];
  /** This day's picks of this meal type. */
  typePicks: Pick[];
  favouriteIds: Set<number>;
  flags: Set<string>;
  suggestionSeed: number;
  saving: boolean;
  /** The pick being changed, pre-filled into the picker; null
      while the picker is adding a new pick of this type. */
  changingPick: Pick | null;
  onSave: (
    mealType: MealType,
    mealId: number,
    proteinId: number | null,
    servings: number,
    variant: string | null,
    pickId: number | null,
  ) => void;
  onToggleFlag: (sheetName: string) => void;
  onSameMealMatch: (meal: Meal, mealType: MealType) => void;
  /** Leaves change mode after a changed pick is saved or kept. */
  onFinishChange: () => void;
}) {
  const typeLower = mealTypeLabel(type).toLowerCase();
  const isChanging = changingPick != null;

  const [chosenMealId, setChosenMealId] = useState<number | null>(
    changingPick?.mealId ?? null,
  );
  const [chosenProteinId, setChosenProteinId] = useState<number | null>(
    changingPick?.proteinId ?? null,
  );
  const [chosenServings, setChosenServings] = useState<number>(
    changingPick?.servings ?? 2,
  );
  const [chosenVariant, setChosenVariant] = useState<string | null>(
    changingPick?.variant ?? null,
  );

  // The heart popup fires at most once per meal while this picker
  // is open, so re-tapping the same suggestion doesn't spam it.
  const celebratedRef = useRef<Set<number>>(new Set());

  // Meals of this type — the dropdown and the suggestions only ever
  // offer these.
  const typeMeals = useMemo(
    () => meals.filter((m) => m.mealType === type),
    [meals, type],
  );

  // The five suggestions shown under the dropdown are a random
  // shuffle of this meal type's meals for this launch: the launch
  // seed (generated once in App when the app is opened) shuffles the
  // type's list and the first five are shown. The shuffle is seeded,
  // so it stays the same while the app is open — switching days or
  // tabs doesn't reshuffle — and a fresh seed on the next launch
  // gives a new random five, in a new random order.
  const suggestions = useMemo(
    () => shuffledWithSeed(typeMeals, suggestionSeed).slice(0, 5),
    [typeMeals, suggestionSeed],
  );

  const chosenMeal = meals.find((m) => m.id === chosenMealId) ?? null;
  const choiceGroup = chosenMeal ? choiceGroupOf(chosenMeal) : null;
  const needsProteinChoice = choiceGroup != null;
  const variantSpec = chosenMeal ? variantSpecOf(chosenMeal) : null;
  const needsVariantChoice = variantSpec != null;
  const canSave =
    chosenMeal != null &&
    (!needsProteinChoice || chosenProteinId != null) &&
    (!needsVariantChoice || chosenVariant != null);

  const resetPicker = () => {
    setChosenMealId(null);
    setChosenProteinId(null);
    setChosenServings(2);
    setChosenVariant(null);
  };

  const selectMeal = (m: Meal) => {
    setChosenMealId(m.id);
    // Keep the pick's style when re-picking its own meal while
    // changing it; otherwise the style step starts unanswered.
    setChosenVariant(
      changingPick && changingPick.mealId === m.id
        ? (changingPick.variant ?? null)
        : null,
    );
    const group = choiceGroupOf(m);
    if (!group) {
      setChosenProteinId(null);
      return;
    }
    // Preselect the pick's protein when changing to the same meal,
    // else the first in-stock option.
    if (
      changingPick &&
      changingPick.mealId === m.id &&
      changingPick.proteinId != null
    ) {
      setChosenProteinId(changingPick.proteinId);
    } else {
      const firstIn = group.options.find((o) => o.status === "in");
      setChosenProteinId(firstIn?.id ?? null);
    }
  };

  /** The dropdown + suggestions + chosen-meal flow for this type. */
  const picker = (
    <div>
      {typeMeals.length === 0 ? (
        <>
          {/* No meals of this type yet: the section still shows its
              dropdown (empty) and says so plainly. */}
          <div className="relative mt-1">
            <select
              id={`meal-dropdown-${type}`}
              aria-label={`Pick a ${typeLower}`}
              value=""
              disabled
              style={{ minHeight: "1rem" }}
              className="w-full appearance-none rounded border border-[var(--border)] bg-[var(--surface)] px-2 py-1.5 pr-[22px] text-[10px] leading-[14px] text-[var(--text)] disabled:opacity-60"
            >
              <option value="">Choose a {typeLower}…</option>
            </select>
            <span
              aria-hidden="true"
              className="pointer-events-none absolute top-1/2 right-2 -translate-y-1/2 text-[10px] text-[var(--dim)]"
            >
              ▾
            </span>
          </div>
          <p className="mt-2 text-sm text-[var(--dim)]">
            No {typeLower} meals on the list yet — add one with the Add
            Meal button in the Meal List row and it will show up here.
          </p>
        </>
      ) : (
        <>
          {/* Week-view choices render at half size (Derek's
              request): the dropdown and the tappable suggestions
              below it carry halved font size, padding, minimum
              height, and gaps. The dropdown still renders 25%
              larger than the suggestions: the decision takes
              priority over the suggestion. */}
          <div className="relative mt-1">
            <select
              id={`meal-dropdown-${type}`}
              aria-label={`Pick a ${typeLower}`}
              value={chosenMealId ?? ""}
              onChange={(e) => {
                const m = meals.find(
                  (x) => x.id === Number(e.target.value),
                );
                if (m) selectMeal(m);
              }}
              style={{ minHeight: "1rem" }}
              className="w-full appearance-none rounded border border-[var(--border)] bg-[var(--surface)] px-2 py-1.5 pr-[22px] text-[10px] leading-[14px] text-[var(--text)]"
            >
              <option value="" disabled>
                Choose a {typeLower}…
              </option>
              {typeMeals.map((m) => (
                <option key={m.id} value={m.id}>
                  {m.name} — {mealStatusWord(m).toLowerCase()}
                </option>
              ))}
            </select>
            <span
              aria-hidden="true"
              className="pointer-events-none absolute top-1/2 right-2 -translate-y-1/2 text-[10px] text-[var(--dim)]"
            >
              ▾
            </span>
          </div>

          <p className="mt-2 text-sm font-medium text-[var(--dim)]">
            …or one of these suggested picks — randomly shuffled for
            this visit
          </p>
          <ul className="mt-[3px] space-y-[3px]">
            {suggestions.map((m) => {
              const isFavourite = favouriteIds.has(m.id);
              const countWord = pickCountWord(m);
              return (
                <li key={m.id}>
                  <button
                    type="button"
                    aria-pressed={chosenMealId === m.id}
                    onClick={() => selectMeal(m)}
                    style={{ minHeight: "1rem" }}
                    className={`flex w-full items-center justify-between gap-1 rounded px-1.5 py-1 text-left text-[8px] leading-3 font-medium ${mealStatusClasses(m.status)} ${
                      chosenMealId === m.id
                        ? "ring-2 ring-[var(--accent)]"
                        : ""
                    }`}
                  >
                    <span>
                      {m.name}
                      {isFavourite && (
                        <span className="ml-1 rounded-full bg-[var(--surface)] px-1 py-[1px] text-[6px] leading-2 font-semibold text-[var(--accent)]">
                          ★ Favourite
                        </span>
                      )}
                    </span>
                    <span className="flex shrink-0 flex-col items-end text-[6px] leading-2 font-normal">
                      <span>{mealStatusWord(m)}</span>
                      <span>
                        {countWord
                          ? `${countWord} · ${lastEatenWord(m)}`
                          : lastEatenWord(m)}
                      </span>
                    </span>
                  </button>
                </li>
              );
            })}
          </ul>
        </>
      )}

      {chosenMeal && (
        <div className="mt-4">
          {groupsOf(chosenMeal).map((group) => {
            const isChoice = choiceGroup?.groupIndex === group.groupIndex;
            return (
              <div key={group.groupIndex} className="mt-2">
                <p className="text-sm font-medium text-[var(--dim)]">
                  {chosenMeal.proteins.length > 1
                    ? isChoice
                      ? "Choose the protein"
                      : groupsOf(chosenMeal).length > 1
                        ? "Also needs"
                        : "Protein"
                    : "Protein"}
                </p>
                <div className="mt-1.5 flex flex-wrap gap-2">
                  {group.options.map((option) =>
                    isChoice ? (
                      <button
                        key={option.id}
                        type="button"
                        aria-pressed={chosenProteinId === option.id}
                        onClick={() => setChosenProteinId(option.id)}
                        className={`rounded-full px-3 py-2 text-sm font-medium ${statusClasses(option.status)} ${
                          chosenProteinId === option.id
                            ? "ring-2 ring-[var(--accent)]"
                            : ""
                        }`}
                      >
                        {option.label} ·{" "}
                        {statusWord(option.status, option.stock)}
                      </button>
                    ) : (
                      <span
                        key={option.id}
                        className={`rounded-full px-3 py-2 text-sm font-medium ${statusClasses(option.status)}`}
                      >
                        {option.label} ·{" "}
                        {statusWord(option.status, option.stock)}
                      </span>
                    ),
                  )}
                </div>
              </div>
            );
          })}

          {variantSpec && (
            <div className="mt-2">
              <p className="text-sm font-medium text-[var(--dim)]">
                {variantSpec.label}
              </p>
              <div className="mt-1.5 flex flex-wrap gap-2">
                {variantSpec.options.map((option) => (
                  <button
                    key={option}
                    type="button"
                    aria-pressed={chosenVariant === option}
                    onClick={() => setChosenVariant(option)}
                    className={`rounded-full border border-[var(--border)] bg-[var(--surface)] px-3 py-2 text-sm font-medium ${
                      chosenVariant === option
                        ? "ring-2 ring-[var(--accent)]"
                        : ""
                    }`}
                  >
                    {option}
                  </button>
                ))}
              </div>
            </div>
          )}

          <OutProteinFlags
            meal={chosenMeal}
            flags={flags}
            onToggleFlag={onToggleFlag}
          />

          <div className="mt-4 flex items-center gap-3">
            <span className="text-sm font-medium text-[var(--dim)]">
              Cooking for
            </span>
            <ServingsStepper
              value={chosenServings}
              onChange={setChosenServings}
            />
          </div>

          <IngredientSection
            key={chosenMeal.id}
            meal={chosenMeal}
            servings={chosenServings}
          />

          <div className="mt-4 flex gap-2">
            <button
              type="button"
              disabled={!canSave || saving}
              onClick={() => {
                if (!chosenMeal) return;
                // The heart popup celebrates a genuinely NEW pick
                // that lands on the same meal a pick from a separate
                // save already chose for this type — never an
                // in-place edit or re-save of an existing pick (the
                // server records the match on the same rule).
                if (
                  !isChanging &&
                  typePicks.some((p) => p.mealId === chosenMeal.id) &&
                  !celebratedRef.current.has(chosenMeal.id)
                ) {
                  celebratedRef.current.add(chosenMeal.id);
                  onSameMealMatch(chosenMeal, type);
                }
                onSave(
                  type,
                  chosenMeal.id,
                  needsProteinChoice ? chosenProteinId : null,
                  chosenServings,
                  needsVariantChoice ? chosenVariant : null,
                  changingPick ? changingPick.id : null,
                );
                if (isChanging) {
                  onFinishChange();
                } else {
                  resetPicker();
                }
              }}
              className="rounded-lg bg-[var(--accent)] px-4 py-2 font-medium text-[var(--accent-text)] disabled:opacity-40"
            >
              {isChanging ? "Save new pick" : `Pick this ${typeLower}`}
            </button>
            {isChanging && (
              <button
                type="button"
                onClick={onFinishChange}
                className="rounded-lg border border-[var(--border)] px-4 py-2 font-medium"
              >
                Keep current pick
              </button>
            )}
          </div>
          {needsProteinChoice && chosenProteinId == null && (
            <p className="mt-2 text-sm text-[var(--dim)]">
              Choose a protein above first — it decides what needs
              defrosting or buying.
            </p>
          )}
          {needsVariantChoice && chosenVariant == null && (
            <p className="mt-2 text-sm text-[var(--dim)]">
              Choose a style above too — bowls, soft shell, hard shell,
              or both.
            </p>
          )}
        </div>
      )}
    </div>
  );

  return <div className="mt-3">{picker}</div>;
}

function ServingsStepper({
  value,
  onChange,
  disabled,
}: {
  value: number;
  onChange: (n: number) => void;
  disabled?: boolean;
}) {
  return (
    <span className="inline-flex items-center gap-1">
      <button
        type="button"
        aria-label="One fewer person"
        disabled={disabled || value <= 1}
        onClick={() => onChange(value - 1)}
        className="rounded-lg border border-[var(--border)] bg-[var(--surface)] px-3 font-medium disabled:opacity-40"
      >
        −
      </button>
      <span className="min-w-20 text-center text-sm font-medium">
        {value} {value === 1 ? "person" : "people"}
      </span>
      <button
        type="button"
        aria-label="One more person"
        disabled={disabled || value >= 12}
        onClick={() => onChange(value + 1)}
        className="rounded-lg border border-[var(--border)] bg-[var(--surface)] px-3 font-medium disabled:opacity-40"
      >
        +
      </button>
    </span>
  );
}

/** Flag-for-shopping rows for a meal's out-of-stock protein options. */
function OutProteinFlags({
  meal,
  flags,
  onToggleFlag,
}: {
  meal: Meal;
  flags: Set<string>;
  onToggleFlag: (sheetName: string) => void;
}) {
  const seen = new Map<string, ProteinOption>();
  for (const o of meal.proteins) {
    if (o.status === "out" && !seen.has(o.sheetName)) seen.set(o.sheetName, o);
  }
  if (seen.size === 0) return null;
  return (
    <div className="mt-3 space-y-1.5">
      {[...seen.values()].map((o) => {
        const flagged = flags.has(o.sheetName);
        return (
          <div
            key={o.sheetName}
            className="flex items-center justify-between gap-2 rounded-lg bg-[var(--out-bg)] px-3 py-2"
          >
            <span className="text-sm font-medium text-[var(--out-text)]">
              {o.label} is out of stock
              {flagged ? " — flagged for shopping" : ""}
            </span>
            <button
              type="button"
              onClick={() => onToggleFlag(o.sheetName)}
              className="shrink-0 rounded-md border border-[var(--border)] bg-[var(--surface)] px-3 py-1 text-sm font-medium text-[var(--text)]"
            >
              {flagged ? "Unflag" : "Flag for shopping"}
            </button>
          </div>
        );
      })}
    </div>
  );
}

// ---- Ingredient coverage -------------------------------------------
// A recipe's ingredients cross-referenced with the HIT List: the
// server works out, per ingredient, whether a matching inventory
// item covers it, is short of the recipe's amount, or is missing /
// out of stock (getRecipeNeeds for saved meals, getIngredientCoverage
// for drafts like a freshly scanned recipe or a generated recipe).
// These two presenters are shared by every surface that shows it.

type RecipeNeedsData = ApiResponse<typeof api, "getRecipeNeeds">;
type SavedCoverageEntry = RecipeNeedsData["meals"][number]["entries"][number];

type CoverageMark = {
  status: "covered" | "short" | "missing";
  matchedItem: string | null;
  have: number | null;
  need: number | null;
  shortfall: number | null;
  unit: string | null;
};

/** The headline fraction: "You have 7 of 10 ingredients". */
function CoverageFraction({
  covered,
  total,
}: {
  covered: number;
  total: number;
}) {
  if (total <= 0) return null;
  return (
    <p
      className="text-base font-bold"
      style={{
        color: covered === total ? "var(--ok-text)" : "var(--text)",
      }}
    >
      You have {covered} of {total} ingredients
      {covered < total && (
        <span style={{ color: "var(--red)" }}>
          {" "}
          · {total - covered} still needed
        </span>
      )}
    </p>
  );
}

/** One ingredient's on-hand mark, beside its name in a list. */
function CoverageChip({ mark }: { mark: CoverageMark }) {
  if (mark.status === "covered") {
    return (
      <span
        className="shrink-0 rounded-full px-2 py-0.5 text-[13px] font-bold"
        style={{
          backgroundColor: "var(--ok-bg)",
          color: "var(--ok-text)",
        }}
      >
        ✓ On hand
      </span>
    );
  }
  if (mark.status === "short") {
    return (
      <span
        className="min-w-0 rounded-full px-2 py-0.5 text-[13px] font-bold"
        style={{
          backgroundColor: "var(--amber-soft)",
          color: "var(--amber)",
        }}
      >
        Short — have {mark.have ?? 0}, need {mark.need ?? "?"}
        {mark.unit ? ` ${mark.unit}` : ""}
        {mark.matchedItem ? ` of ${mark.matchedItem}` : ""}
      </span>
    );
  }
  return (
    <span
      className="min-w-0 rounded-full px-2 py-0.5 text-[13px] font-bold"
      style={{ backgroundColor: "var(--red-soft)", color: "var(--red)" }}
    >
      {mark.matchedItem ? `Out of stock · ${mark.matchedItem}` : "Not in the inventory"}
    </span>
  );
}

type IngredientDraft = { name: string; quantity: string; unit: string };

/**
 * A meal's ingredient list, shown in a collapsible dropdown named
 * "Ingredient list" whenever a meal is selected. Stored quantities are
 * for 2 people; the list shown scales them to `servings`. The editor
 * always edits the 2-person base amounts. `defaultExpanded` opens the
 * dropdown on first render (used by the Meal List, where the Edit button
 * already acts as the toggle).
 */
function IngredientSection({
  meal,
  servings,
  defaultExpanded = false,
}: {
  meal: Meal;
  servings: number;
  defaultExpanded?: boolean;
}) {
  const queryClient = useQueryClient();
  const [expanded, setExpanded] = useState(defaultExpanded);
  const [editing, setEditing] = useState(false);
  const [drafts, setDrafts] = useState<IngredientDraft[]>([]);
  const [error, setError] = useState<string | null>(null);

  // Ingredient coverage: this meal's ingredients cross-referenced
  // with the HIT List (the same getRecipeNeeds the Shopping List's
  // Recipe Needs sections are built from). Entries line up with
  // meal.ingredients by position; the name check guards the join.
  const needsQuery = useQuery({
    queryKey: ["recipe-needs"],
    queryFn: () => api.getRecipeNeeds({}),
  });
  const coverageMeal =
    needsQuery.data?.meals.find((m) => m.mealId === meal.id) ?? null;
  const markFor = (
    ing: Meal["ingredients"][number],
    idx: number,
  ): SavedCoverageEntry | null => {
    if (!coverageMeal) return null;
    const byIndex = coverageMeal.entries[idx];
    if (
      byIndex &&
      byIndex.name.trim().toLowerCase() === ing.name.trim().toLowerCase()
    ) {
      return byIndex;
    }
    return (
      coverageMeal.entries.find(
        (e) =>
          e.name.trim().toLowerCase() === ing.name.trim().toLowerCase(),
      ) ?? null
    );
  };

  // Recipe-link import: paste a recipe URL and a draft ingredient
  // list (for 2 people) is read from the page for review here.
  // Nothing is saved until "Save ingredients" is tapped, which goes
  // through the same setMealIngredients as manual edits.
  const [importUrl, setImportUrl] = useState("");
  const [importId, setImportId] = useState<number | null>(null);
  const [importNote, setImportNote] = useState<string | null>(null);
  const [importError, setImportError] = useState<string | null>(null);
  const [uncertainIdx, setUncertainIdx] = useState<Set<number>>(
    new Set(),
  );

  const startImport = useMutation({
    mutationFn: async (url: string) =>
      await api.previewRecipeImport({ url }),
    onSuccess: (res) => {
      if (res.started && res.importId != null) {
        setImportId(res.importId);
        setImportError(null);
        setImportNote(null);
      } else {
        setImportError(
          res.error ?? "The import couldn't start. Check the link.",
        );
      }
    },
    onError: () =>
      setImportError("The import couldn't start. Check the link."),
  });

  const importResult = useQuery({
    queryKey: ["recipe-import", importId],
    queryFn: () => api.getRecipeImport({ importId: importId ?? 0 }),
    enabled: importId != null,
    refetchInterval: (q) =>
      q.state.data?.status === "pending" ? 3000 : false,
  });

  useEffect(() => {
    if (importId == null || !importResult.data) return;
    const d = importResult.data;
    if (d.status === "done") {
      setDrafts(
        d.ingredients.map((i) => ({
          name: i.name,
          quantity: i.quantity != null ? String(i.quantity) : "",
          unit: i.unit ?? "",
        })),
      );
      setUncertainIdx(
        new Set(
          d.ingredients
            .map((ing, idx) => (ing.uncertain ? idx : -1))
            .filter((idx) => idx >= 0),
        ),
      );
      setImportNote(
        d.note
          ? `Imported from the page — ${d.note} Check the amounts over, then save.`
          : "Imported from the page — check the amounts over, then save.",
      );
      setImportId(null);
    } else if (d.status === "failed") {
      setImportError(
        d.note
          ? `That recipe page couldn't be read (${d.note}) Your ingredient list is unchanged.`
          : "That recipe page couldn't be read — your ingredient list is unchanged.",
      );
      setImportId(null);
    }
  }, [importId, importResult.data]);

  const save = useMutation({
    mutationFn: async (
      ingredients: {
        name: string;
        quantity: number | null;
        unit: string | null;
      }[],
    ) => await api.setMealIngredients({ mealId: meal.id, ingredients }),
    onSuccess: () => {
      setEditing(false);
      setError(null);
      queryClient.invalidateQueries({ queryKey: ["planner"] });
      queryClient.invalidateQueries({ queryKey: ["recipe-needs"] });
    },
    onError: () =>
      setError("Those ingredients couldn't be saved. Try again."),
  });

  const startEditing = () => {
    setDrafts(
      meal.ingredients.length > 0
        ? meal.ingredients.map((i) => ({
            name: i.name,
            quantity: i.quantity != null ? String(i.quantity) : "",
            unit: i.unit ?? "",
          }))
        : [{ name: "", quantity: "", unit: "" }],
    );
    setError(null);
    setImportUrl("");
    setImportId(null);
    setImportNote(null);
    setImportError(null);
    setUncertainIdx(new Set());
    setEditing(true);
  };

  const submit = () => {
    const parsed: {
      name: string;
      quantity: number | null;
      unit: string | null;
    }[] = [];
    for (const d of drafts) {
      const name = d.name.trim();
      if (!name) continue;
      const qText = d.quantity.trim();
      const quantity = qText === "" ? null : Number(qText);
      if (quantity != null && (Number.isNaN(quantity) || quantity <= 0)) {
        setError(
          `"${name}" needs a number for its amount — or leave the amount blank.`,
        );
        return;
      }
      parsed.push({
        name,
        quantity,
        unit: d.unit.trim() === "" ? null : d.unit.trim(),
      });
    }
    save.mutate(parsed);
  };

  const setDraft = (index: number, patch: Partial<IngredientDraft>) =>
    setDrafts((prev) =>
      prev.map((d, i) => (i === index ? { ...d, ...patch } : d)),
    );

  if (!editing) {
    return (
      <div className="mt-3 rounded-lg bg-[var(--surface-alt)] p-3">
        <button
          type="button"
          aria-expanded={expanded}
          onClick={() => setExpanded((v) => !v)}
          className="flex w-full items-center justify-between gap-2 text-left text-[var(--text)]"
        >
          <span className="flex min-w-0 items-center gap-2">
            <span className="text-sm font-semibold">
              Ingredient list · for {servings}{" "}
              {servings === 1 ? "person" : "people"}
            </span>
            {coverageMeal && coverageMeal.totalCount > 0 && (
              <span
                className="shrink-0 rounded-full px-2 py-0.5 text-[13px] font-bold"
                style={
                  coverageMeal.coveredCount === coverageMeal.totalCount
                    ? {
                        backgroundColor: "var(--ok-bg)",
                        color: "var(--ok-text)",
                      }
                    : {
                        backgroundColor: "var(--amber-soft)",
                        color: "var(--amber)",
                      }
                }
              >
                {coverageMeal.coveredCount}/{coverageMeal.totalCount} on
                hand
              </span>
            )}
          </span>
          <span aria-hidden="true" className="text-[var(--dim)]">
            {expanded ? "▾" : "▸"}
          </span>
        </button>
        {expanded && (
          <div className="mt-2">
            {meal.ingredients.length > 0 ? (
              <>
                {coverageMeal && (
                  <div className="mb-2">
                    <CoverageFraction
                      covered={coverageMeal.coveredCount}
                      total={coverageMeal.totalCount}
                    />
                  </div>
                )}
                <ul className="space-y-1 text-sm text-[var(--text)]">
                  {meal.ingredients.map((ing, idx) => {
                    const mark = markFor(ing, idx);
                    return (
                      <li
                        key={ing.id}
                        className="flex flex-wrap items-center gap-2"
                      >
                        <span className="w-24 shrink-0 font-medium">
                          {ing.quantity != null
                            ? `${scaledQuantity(ing.quantity, servings)}${ing.unit ? ` ${ing.unit}` : ""}`
                            : (ing.unit ?? "")}
                        </span>
                        <span className="min-w-0 flex-1">{ing.name}</span>
                        {mark && <CoverageChip mark={mark} />}
                      </li>
                    );
                  })}
                </ul>
                <p className="mt-2 text-xs text-[var(--dim)]">
                  Amounts are written for 2 people
                  {servings !== 2
                    ? ` and scaled up for ${servings} here.`
                    : "."}
                </p>
              </>
            ) : (
              <p className="text-sm text-[var(--dim)]">
                No ingredient list yet — add one with amounts for 2 people
                and they&apos;ll scale automatically when you cook for
                more.
              </p>
            )}
            <button
              type="button"
              onClick={startEditing}
              className="mt-2 rounded-md border border-[var(--border)] bg-[var(--surface)] px-3 py-1 text-sm font-medium text-[var(--text)]"
            >
              {meal.ingredients.length > 0
                ? "Edit ingredients"
                : "Add ingredients"}
            </button>
          </div>
        )}
      </div>
    );
  }

  return (
    <div className="mt-3 rounded-lg bg-[var(--surface-alt)] p-3 text-[var(--text)]">
      <h3 className="text-sm font-semibold">
        Ingredients for {meal.name} — amounts for 2 people
      </h3>
      <p className="mt-1 text-sm text-[var(--dim)]">
        Leave the amount blank for things like &quot;to taste&quot;.
      </p>
      <div className="mt-3 rounded-lg border border-[var(--border)] bg-[var(--surface)] p-3">
        <label
          htmlFor={`recipe-import-${meal.id}`}
          className="text-sm font-semibold"
        >
          Import ingredients from a recipe link
        </label>
        <div className="mt-2 flex flex-wrap gap-2">
          <input
            id={`recipe-import-${meal.id}`}
            type="url"
            inputMode="url"
            value={importUrl}
            onChange={(e) => setImportUrl(e.target.value)}
            placeholder="Paste a recipe URL"
            className="min-w-40 flex-1 rounded-lg border border-[var(--border)] bg-[var(--surface)] px-3 py-2 text-[var(--text)]"
          />
          <button
            type="button"
            disabled={
              !importUrl.trim() || startImport.isPending || importId != null
            }
            onClick={() => startImport.mutate(importUrl.trim())}
            className="rounded-lg bg-[var(--accent)] px-4 py-2 text-sm font-medium text-[var(--accent-text)] disabled:opacity-40"
          >
            {importId != null ? "Reading…" : "Import"}
          </button>
        </div>
        {importId != null && (
          <p className="mt-2 text-sm text-[var(--dim)]">
            Reading the recipe page — the draft list will appear here
            for you to check before saving.
          </p>
        )}
        {importNote && (
          <p className="mt-2 text-sm text-[var(--ok-text)]">{importNote}</p>
        )}
        {importError && (
          <p className="mt-2 text-sm text-[var(--out-text)]">
            {importError}
          </p>
        )}
      </div>
      {drafts.map((draft, i) => (
        <div key={i} className="mt-2 flex flex-wrap gap-2">
          <input
            aria-label={`Ingredient ${i + 1} amount`}
            value={draft.quantity}
            onChange={(e) => setDraft(i, { quantity: e.target.value })}
            placeholder="Amount"
            inputMode="decimal"
            className="w-24 rounded-lg border border-[var(--border)] bg-[var(--surface)] px-3 py-2 text-[var(--text)]"
          />
          <input
            aria-label={`Ingredient ${i + 1} unit`}
            value={draft.unit}
            onChange={(e) => setDraft(i, { unit: e.target.value })}
            placeholder="Unit (cups, tbsp…)"
            className="w-32 rounded-lg border border-[var(--border)] bg-[var(--surface)] px-3 py-2 text-[var(--text)]"
          />
          <input
            aria-label={`Ingredient ${i + 1} name`}
            value={draft.name}
            onChange={(e) => setDraft(i, { name: e.target.value })}
            placeholder="Ingredient"
            className="min-w-40 flex-1 rounded-lg border border-[var(--border)] bg-[var(--surface)] px-3 py-2 text-[var(--text)]"
          />
          <button
            type="button"
            aria-label={`Remove ingredient ${i + 1}`}
            onClick={() =>
              setDrafts((prev) => prev.filter((_, j) => j !== i))
            }
            className="rounded-lg border border-[var(--border)] bg-[var(--surface)] px-3 font-medium text-[var(--dim)]"
          >
            ✕
          </button>
          {uncertainIdx.has(i) && (
            <span className="w-full text-xs font-medium text-[var(--amber)]">
              Amount couldn&rsquo;t be determined from the page — check
              it before saving.
            </span>
          )}
        </div>
      ))}
      <button
        type="button"
        onClick={() =>
          setDrafts((prev) => [...prev, { name: "", quantity: "", unit: "" }])
        }
        className="mt-2 rounded-lg border border-[var(--border)] bg-[var(--surface)] px-3 py-1.5 text-sm font-medium text-[var(--text)]"
      >
        Add another ingredient
      </button>
      {error && <p className="mt-2 text-sm text-[var(--out-text)]">{error}</p>}
      <div className="mt-3 flex gap-2">
        <button
          type="button"
          disabled={save.isPending}
          onClick={submit}
          className="rounded-lg bg-[var(--accent)] px-4 py-2 text-sm font-medium text-[var(--accent-text)] disabled:opacity-40"
        >
          Save ingredients
        </button>
        <button
          type="button"
          onClick={() => setEditing(false)}
          className="rounded-lg border border-[var(--border)] bg-[var(--surface)] px-4 py-2 text-sm font-medium"
        >
          Cancel
        </button>
      </div>
    </div>
  );
}

function NoteEditor({ meal }: { meal: Meal }) {
  const queryClient = useQueryClient();
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(meal.note ?? "");
  const save = useMutation({
    mutationFn: async () =>
      await api.updateMealNote({ mealId: meal.id, note: draft }),
    onSuccess: () => {
      setEditing(false);
      queryClient.invalidateQueries({ queryKey: ["planner"] });
    },
  });

  if (!editing) {
    return (
      <div className="mt-3 rounded-lg bg-[var(--surface-alt)] p-3 text-[var(--text)]">
        <div className="flex items-center justify-between gap-2">
          <h3 className="text-sm font-semibold">Recipe note</h3>
          <button
            type="button"
            onClick={() => {
              setDraft(meal.note ?? "");
              setEditing(true);
            }}
            className="rounded-md border border-[var(--border)] bg-[var(--surface)] px-3 py-1 text-sm font-medium"
          >
            {meal.note ? "Edit note" : "Add note"}
          </button>
        </div>
        {meal.note ? (
          <p className="mt-1 text-sm whitespace-pre-wrap">{meal.note}</p>
        ) : (
          <p className="mt-1 text-sm text-[var(--dim)]">No notes yet</p>
        )}
      </div>
    );
  }

  return (
    <div className="mt-3 rounded-lg bg-[var(--surface-alt)] p-3 text-[var(--text)]">
      <label htmlFor={`note-${meal.id}`} className="text-sm font-semibold">
        Recipe note for {meal.name}
      </label>
      <textarea
        id={`note-${meal.id}`}
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        rows={5}
        placeholder="Ingredients, quantities, anything to grab at the store…"
        className="mt-2 w-full rounded-lg border border-[var(--border)] bg-[var(--surface)] p-2 text-sm text-[var(--text)]"
      />
      <div className="mt-2 flex gap-2">
        <button
          type="button"
          disabled={save.isPending}
          onClick={() => save.mutate()}
          className="rounded-lg bg-[var(--accent)] px-4 py-2 text-sm font-medium text-[var(--accent-text)] disabled:opacity-40"
        >
          Save note
        </button>
        <button
          type="button"
          onClick={() => setEditing(false)}
          className="rounded-lg border border-[var(--border)] bg-[var(--surface)] px-4 py-2 text-sm font-medium"
        >
          Cancel
        </button>
      </div>
    </div>
  );
}

/**
 * The boiling-pot loading indicator shown while an uploaded recipe
 * file is being scanned for ingredients: an SVG pot with three
 * steam wisps looping up and fading (staggered via pot-steam-2/3)
 * and a lid that rattles in a short bounce loop. Pure CSS animation
 * (theme.css: pot-steam / pot-lid), switched off under
 * prefers-reduced-motion.
 */
function BoilingPot() {
  return (
    <span
      role="img"
      aria-label="A pot boiling"
      className="inline-block shrink-0"
    >
      <svg width="76" height="72" viewBox="0 0 76 72" aria-hidden="true">
        {/* steam wisps */}
        <g
          fill="none"
          stroke="var(--dim)"
          strokeWidth="3"
          strokeLinecap="round"
          opacity="0.8"
        >
          <path
            className="pot-steam"
            d="M26 26c-2.5-3 2.5-4.5 0-7.5"
          />
          <path
            className="pot-steam pot-steam-2"
            d="M38 27c-2.5-3 2.5-4.5 0-7.5"
          />
          <path
            className="pot-steam pot-steam-3"
            d="M50 26c-2.5-3 2.5-4.5 0-7.5"
          />
        </g>
        {/* lid (handle + dome) — bounces as the pot boils */}
        <g className="pot-lid">
          <circle cx="38" cy="26" r="2.6" fill="var(--dim)" />
          <path
            d="M18 33a20 7 0 0 1 40 0z"
            fill="var(--surface-alt)"
            stroke="var(--dim)"
            strokeWidth="2"
          />
        </g>
        {/* pot body + side handles */}
        <path
          d="M10 36h6M60 36h6"
          stroke="var(--dim)"
          strokeWidth="3.4"
          strokeLinecap="round"
        />
        <path
          d="M16 35h44l-3.4 27a6 6 0 0 1-6 5.2H25.4a6 6 0 0 1-6-5.2z"
          fill="var(--accent-soft)"
          stroke="var(--accent)"
          strokeWidth="2.4"
        />
        <path
          d="M21 45h34"
          stroke="var(--accent)"
          strokeWidth="2"
          strokeLinecap="round"
          opacity="0.45"
        />
      </svg>
    </span>
  );
}

/** File types the recipe file scan can read. */
const RECIPE_FILE_ACCEPT =
  "image/jpeg,image/png,application/pdf,text/plain,.jpg,.jpeg,.png,.pdf,.txt";

/**
 * Prepare an uploaded recipe file for the scan: photos are
 * downscaled to a ~2000px long edge and re-encoded as JPEG (phone
 * photos are several megabytes; the reader needs the writing
 * legible, not the pixels), PDFs and text files go as-is. Falls
 * back to the original file whenever the resize fails.
 */
async function prepareRecipeFile(
  file: File,
): Promise<{ dataBase64: string; mimeType: string }> {
  if (!file.type.startsWith("image/")) {
    return await fileToBase64(file);
  }
  try {
    const bitmap = await createImageBitmap(file);
    const MAX_EDGE = 2000;
    const scale = Math.min(
      1,
      MAX_EDGE / Math.max(bitmap.width, bitmap.height),
    );
    if (scale >= 1 && file.type === "image/jpeg") {
      bitmap.close();
      return await fileToBase64(file);
    }
    const canvas = document.createElement("canvas");
    canvas.width = Math.round(bitmap.width * scale);
    canvas.height = Math.round(bitmap.height * scale);
    const ctx2d = canvas.getContext("2d");
    if (!ctx2d) throw new Error("no 2d context");
    ctx2d.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
    bitmap.close();
    const blob = await new Promise<Blob | null>((resolve) =>
      canvas.toBlob(resolve, "image/jpeg", 0.85),
    );
    if (!blob) throw new Error("encode failed");
    return await fileToBase64(blob);
  } catch {
    return await fileToBase64(file);
  }
}

/**
 * Scan recipe: two intakes into the same review. (a) Paste a recipe
 * link — the page's ingredient list is read by the same background
 * import the ingredient editor uses (previewRecipeImport →
 * saveRecipeImport). (b) Upload a file — a photo of a recipe or a
 * recipe document (PDF / text) — startRecipeFileImport stores it
 * and a background reader extracts the ingredients from the file
 * itself, handing back through the same saveRecipeImport; while
 * the file is being scanned a boiling-pot indicator stands in for
 * a spinner, and a file that can't be read (or holds no recipe)
 * gets a modal pop-up rather than a quiet note. Either way the
 * draft is shown here for review — nothing is saved until "Save
 * to Meal List" is tapped. While the
 * draft is reviewed, its ingredients are cross-referenced with the
 * HIT List live (getIngredientCoverage): the fraction of ingredients
 * on hand, and a covered / short / missing mark per row. Saving
 * goes through addMealWithIngredients; the saved meal's still-needed
 * ingredients then appear on the Shopping List in the "Recipe
 * Needs" section under the meal's name, like any other meal's.
 */
function ScanRecipePanel({ onSaved }: { onSaved: () => void }) {
  const queryClient = useQueryClient();
  const [url, setUrl] = useState("");
  // "link" = paste a recipe URL (the original intake); "file" =
  // upload a recipe photo / document to be scanned.
  const [mode, setMode] = useState<"link" | "file">("link");
  // Where the import currently being polled came from — a failed
  // FILE scan gets the pop-up; a failed link keeps its inline note.
  const [importSource, setImportSource] = useState<"link" | "file">(
    "link",
  );
  const [importId, setImportId] = useState<number | null>(null);
  const [importNote, setImportNote] = useState<string | null>(null);
  const [importError, setImportError] = useState<string | null>(null);
  // Unreadable-file pop-up: the plain-words message, or null.
  const [filePopup, setFilePopup] = useState<string | null>(null);
  const [fileName, setFileName] = useState<string | null>(null);
  const [fileBusy, setFileBusy] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [drafts, setDrafts] = useState<IngredientDraft[] | null>(null);
  const [uncertainIdx, setUncertainIdx] = useState<Set<number>>(
    new Set(),
  );
  const [name, setName] = useState("");
  const [mealType, setMealType] = useState<MealType>("dinner");
  const [saveError, setSaveError] = useState<string | null>(null);
  const [savedName, setSavedName] = useState<string | null>(null);

  const startImport = useMutation({
    mutationFn: async (u: string) => await api.previewRecipeImport({ url: u }),
    onSuccess: (res) => {
      if (res.started && res.importId != null) {
        setImportSource("link");
        setImportId(res.importId);
        setImportError(null);
        setImportNote(null);
        setSavedName(null);
      } else {
        setImportError(
          res.error ?? "The import couldn't start. Check the link.",
        );
      }
    },
    onError: () =>
      setImportError("The import couldn't start. Check the link."),
  });

  const startFileScan = useMutation({
    mutationFn: async (file: File) => {
      const prepared = await prepareRecipeFile(file);
      return await api.startRecipeFileImport({
        file: { ...prepared, fileName: file.name },
      });
    },
    onSuccess: (res, file) => {
      setFileBusy(false);
      if (res.started && res.importId != null) {
        setImportSource("file");
        setImportId(res.importId);
        setImportError(null);
        setImportNote(null);
        setSavedName(null);
      } else {
        // Rejected up front (unsupported type, empty, unreadable
        // bytes) — the pop-up, in plain words.
        setFilePopup(
          res.error ??
            `“${file.name}” couldn't be read. Try a clearer photo of the recipe, or a PDF or text file.`,
        );
        setFileName(null);
      }
    },
    onError: (_err, file) => {
      setFileBusy(false);
      setFilePopup(
        `“${file.name}” couldn't be read. Try a clearer photo of the recipe, or a PDF or text file.`,
      );
      setFileName(null);
    },
  });

  const onFileChosen = (file: File | null) => {
    if (!file) return;
    setFileName(file.name);
    setFilePopup(null);
    setFileBusy(true);
    startFileScan.mutate(file);
  };

  const importResult = useQuery({
    queryKey: ["recipe-import", importId],
    queryFn: () => api.getRecipeImport({ importId: importId ?? 0 }),
    enabled: importId != null,
    refetchInterval: (q) =>
      q.state.data?.status === "pending" ? 3000 : false,
  });

  useEffect(() => {
    if (importId == null || !importResult.data) return;
    const d = importResult.data;
    const fromFile = importSource === "file";
    if (d.status === "done" && !(fromFile && d.ingredients.length === 0)) {
      setDrafts(
        d.ingredients.map((i) => ({
          name: i.name,
          quantity: i.quantity != null ? String(i.quantity) : "",
          unit: i.unit ?? "",
        })),
      );
      setUncertainIdx(
        new Set(
          d.ingredients
            .map((ing, idx) => (ing.uncertain ? idx : -1))
            .filter((idx) => idx >= 0),
        ),
      );
      setImportNote(
        fromFile
          ? d.note
            ? `Read from your file — ${d.note} Check the list over, name the recipe, then save it.`
            : "Read from your file — check the list over, name the recipe, then save it."
          : d.note
            ? `Read from the page — ${d.note} Check the list over, name the recipe, then save it.`
            : "Read from the page — check the list over, name the recipe, then save it.",
      );
      setImportId(null);
    } else if (d.status === "done" || d.status === "failed") {
      // A finished file scan with nothing in it is a failed read,
      // same as an outright failure: the pop-up explains, in plain
      // words, and offers another try. Link failures keep the
      // panel's inline note.
      if (fromFile) {
        setFilePopup(
          d.status === "done"
            ? "No recipe ingredients were found in that file. If it's a photo, try a clearer, straight-on shot of the recipe; otherwise try a PDF or text file of the recipe instead."
            : d.note
              ? `That file couldn't be read — ${d.note} Try a clearer photo of the recipe, or a PDF or text file.`
              : "That file couldn't be read. Try a clearer photo of the recipe, or a PDF or text file.",
        );
        setFileName(null);
      } else {
        setImportError(
          d.note
            ? `That recipe page couldn't be read (${d.note})`
            : "That recipe page couldn't be read.",
        );
      }
      setImportId(null);
    }
  }, [importId, importResult.data, importSource]);

  // Draft rows with a name, parsed for coverage and saving; each
  // keeps its draft-row index so coverage marks line up with the
  // editor rows (blank rows in between are skipped).
  const parsed = (drafts ?? [])
    .map((d, draftIndex) => {
      const qText = d.quantity.trim();
      const q = qText === "" ? null : Number(qText);
      return {
        draftIndex,
        name: d.name.trim(),
        quantity:
          q != null && !Number.isNaN(q) && q > 0 ? q : null,
        unit: d.unit.trim() === "" ? null : d.unit.trim(),
      };
    })
    .filter((d) => d.name.length > 0);
  const parsedKey = JSON.stringify(
    parsed.map(({ name: n, quantity, unit }) => ({
      name: n,
      quantity,
      unit,
    })),
  );
  const coverage = useQuery({
    queryKey: ["ingredient-coverage", parsedKey],
    queryFn: () =>
      api.getIngredientCoverage({
        ingredients: parsed.map(({ name: n, quantity, unit }) => ({
          name: n,
          quantity,
          unit,
        })),
      }),
    enabled: parsed.length > 0,
  });
  const markByDraftIndex = new Map<number, CoverageMark>();
  coverage.data?.entries.forEach((entry, i) => {
    const p = parsed[i];
    if (p) markByDraftIndex.set(p.draftIndex, entry);
  });

  const saveMeal = useMutation({
    mutationFn: async () =>
      await api.addMealWithIngredients({
        name: name.trim(),
        mealType,
        ingredients: parsed.map(({ name: n, quantity, unit }) => ({
          name: n,
          quantity,
          unit,
        })),
      }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["planner"] });
      queryClient.invalidateQueries({ queryKey: ["recipe-needs"] });
      setSavedName(name.trim());
      setDrafts(null);
      setName("");
      setMealType("dinner");
      setUrl("");
      setFileName(null);
      setImportNote(null);
      setSaveError(null);
      onSaved();
    },
    onError: () =>
      setSaveError("That recipe couldn't be saved. Try again."),
  });

  const submitSave = () => {
    for (const d of drafts ?? []) {
      if (!d.name.trim()) continue;
      const qText = d.quantity.trim();
      if (qText === "") continue;
      const q = Number(qText);
      if (Number.isNaN(q) || q <= 0) {
        setSaveError(
          `"${d.name.trim()}" needs a number for its amount — or leave the amount blank.`,
        );
        return;
      }
    }
    setSaveError(null);
    saveMeal.mutate();
  };

  const setDraft = (index: number, patch: Partial<IngredientDraft>) =>
    setDrafts((prev) =>
      prev
        ? prev.map((d, i) => (i === index ? { ...d, ...patch } : d))
        : prev,
    );

  return (
    <section
      aria-label="Scan recipe"
      className="mt-2 rounded-[var(--radius)] border border-[var(--border)] bg-[var(--surface)] p-4 text-[var(--text)]"
    >
      <h2 className="text-xl font-semibold">Scan recipe</h2>
      <p className="mt-0.5 text-sm text-[var(--dim)]">
        Paste a link to a recipe, or upload a file — a photo of a
        recipe card or cookbook page, or a recipe document. Its
        ingredients are read and checked against the HIT List as you
        review them. When you save the recipe, anything still needed
        shows up on the Shopping List in the Recipe Needs section,
        under the recipe's name, with prices checked for you.
      </p>
      <div
        role="group"
        aria-label="Recipe source"
        className="mt-3 flex rounded-full p-1"
        style={{ backgroundColor: "var(--surface-alt)" }}
      >
        {(
          [
            { id: "link", label: "Paste a link" },
            { id: "file", label: "Upload a file" },
          ] as const
        ).map((m) => (
          <button
            key={m.id}
            type="button"
            aria-pressed={mode === m.id}
            onClick={() => setMode(m.id)}
            className="min-w-0 flex-1 rounded-full px-2 py-1.5 text-sm font-bold"
            style={
              mode === m.id
                ? {
                    backgroundColor: "var(--accent)",
                    color: "var(--accent-text)",
                  }
                : { color: "var(--dim)" }
            }
          >
            {m.label}
          </button>
        ))}
      </div>
      {mode === "link" && (
        <div className="mt-3 flex flex-wrap gap-2">
          <input
            type="url"
            inputMode="url"
            aria-label="Recipe link"
            value={url}
            onChange={(e) => setUrl(e.target.value)}
            placeholder="Paste a recipe URL"
            className="min-w-40 flex-1 rounded-lg border border-[var(--border)] bg-[var(--surface)] px-3 py-2 text-[var(--text)]"
          />
          <button
            type="button"
            disabled={!url.trim() || startImport.isPending || importId != null}
            onClick={() => startImport.mutate(url.trim())}
            className="rounded-lg bg-[var(--accent)] px-4 py-2 text-sm font-medium text-[var(--accent-text)] disabled:opacity-40"
          >
            {importId != null && importSource === "link"
              ? "Reading…"
              : "Read recipe"}
          </button>
        </div>
      )}
      {mode === "file" && (
        <div className="mt-3">
          <input
            ref={fileInputRef}
            type="file"
            accept={RECIPE_FILE_ACCEPT}
            aria-label="Recipe file"
            className="hidden"
            onChange={(e) => {
              onFileChosen(e.target.files?.[0] ?? null);
              e.target.value = "";
            }}
          />
          <div className="flex flex-wrap items-center gap-2">
            <button
              type="button"
              disabled={fileBusy || importId != null}
              onClick={() => fileInputRef.current?.click()}
              className="rounded-lg bg-[var(--accent)] px-4 py-2 text-sm font-medium text-[var(--accent-text)] disabled:opacity-40"
            >
              {fileName ? "Choose a different file" : "Choose a file"}
            </button>
            {fileName && (
              <span className="min-w-0 truncate text-sm text-[var(--dim)]">
                {fileName}
              </span>
            )}
          </div>
          <p className="mt-1.5 text-xs text-[var(--dim)]">
            A photo of the recipe (JPEG or PNG), a PDF, or a plain
            text file.
          </p>
        </div>
      )}
      {importId != null && importSource === "link" && (
        <p className="mt-2 text-sm text-[var(--dim)]">
          Reading the recipe page — the ingredient list will appear
          here for you to check before anything is saved.
        </p>
      )}
      {(fileBusy || (importId != null && importSource === "file")) && (
        <div
          role="status"
          className="mt-3 flex items-center gap-3"
        >
          <BoilingPot />
          <p className="text-sm text-[var(--dim)]">
            Scanning {fileName ? `“${fileName}”` : "your file"} for
            ingredients — the list will appear here for you to check
            before anything is saved.
          </p>
        </div>
      )}
      {filePopup != null && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center p-4"
          style={{ backgroundColor: "rgba(0, 0, 0, 0.45)" }}
          onClick={() => setFilePopup(null)}
        >
          <div
            role="alertdialog"
            aria-modal="true"
            aria-labelledby="recipe-file-popup-title"
            aria-describedby="recipe-file-popup-body"
            className="w-full max-w-sm rounded-[var(--radius)] border border-[var(--border)] bg-[var(--surface)] p-5 text-[var(--text)] shadow-xl"
            onClick={(e) => e.stopPropagation()}
          >
            <h3
              id="recipe-file-popup-title"
              className="text-lg font-semibold"
            >
              That file couldn&rsquo;t be read
            </h3>
            <p
              id="recipe-file-popup-body"
              className="mt-1.5 text-sm text-[var(--dim)]"
            >
              {filePopup}
            </p>
            <div className="mt-4 flex gap-2">
              <button
                type="button"
                onClick={() => {
                  setFilePopup(null);
                  fileInputRef.current?.click();
                }}
                className="rounded-lg bg-[var(--accent)] px-4 py-2 text-sm font-medium text-[var(--accent-text)]"
              >
                Try another file
              </button>
              <button
                type="button"
                onClick={() => setFilePopup(null)}
                className="rounded-lg border border-[var(--border)] bg-[var(--surface)] px-4 py-2 text-sm font-medium"
              >
                Dismiss
              </button>
            </div>
          </div>
        </div>
      )}
      {importNote && (
        <p className="mt-2 text-sm text-[var(--ok-text)]">{importNote}</p>
      )}
      {importError && (
        <p className="mt-2 text-sm text-[var(--out-text)]">{importError}</p>
      )}
      {savedName && (
        <p className="mt-2 text-sm text-[var(--ok-text)]">
          “{savedName}” is on the Meal List now — pick it any day.
          Anything it still needs is on the Shopping List in the
          Recipe Needs section, under “{savedName}”.
        </p>
      )}
      {drafts && (
        <div className="mt-3">
          {coverage.data ? (
            <CoverageFraction
              covered={coverage.data.coveredCount}
              total={coverage.data.totalCount}
            />
          ) : (
            parsed.length > 0 && (
              <p className="text-sm text-[var(--dim)]">
                Checking these against the HIT List…
              </p>
            )
          )}
          <p className="mt-1 text-xs text-[var(--dim)]">
            Amounts are for 2 people, the planner&rsquo;s convention.
          </p>
          {drafts.map((draft, i) => {
            const mark = markByDraftIndex.get(i) ?? null;
            return (
              <div key={i} className="mt-2 flex flex-wrap items-center gap-2">
                <input
                  aria-label={`Scanned ingredient ${i + 1} amount`}
                  value={draft.quantity}
                  onChange={(e) => setDraft(i, { quantity: e.target.value })}
                  placeholder="Amount"
                  inputMode="decimal"
                  className="w-24 rounded-lg border border-[var(--border)] bg-[var(--surface)] px-3 py-2 text-[var(--text)]"
                />
                <input
                  aria-label={`Scanned ingredient ${i + 1} unit`}
                  value={draft.unit}
                  onChange={(e) => setDraft(i, { unit: e.target.value })}
                  placeholder="Unit (cups, tbsp…)"
                  className="w-32 rounded-lg border border-[var(--border)] bg-[var(--surface)] px-3 py-2 text-[var(--text)]"
                />
                <input
                  aria-label={`Scanned ingredient ${i + 1} name`}
                  value={draft.name}
                  onChange={(e) => setDraft(i, { name: e.target.value })}
                  placeholder="Ingredient"
                  className="min-w-40 flex-1 rounded-lg border border-[var(--border)] bg-[var(--surface)] px-3 py-2 text-[var(--text)]"
                />
                <button
                  type="button"
                  aria-label={`Remove scanned ingredient ${i + 1}`}
                  onClick={() =>
                    setDrafts((prev) =>
                      prev ? prev.filter((_, j) => j !== i) : prev,
                    )
                  }
                  className="rounded-lg border border-[var(--border)] bg-[var(--surface)] px-3 font-medium text-[var(--dim)]"
                >
                  ✕
                </button>
                {mark && <CoverageChip mark={mark} />}
                {uncertainIdx.has(i) && (
                  <span className="w-full text-xs font-medium text-[var(--amber)]">
                    Amount couldn&rsquo;t be determined from the page —
                    check it before saving.
                  </span>
                )}
              </div>
            );
          })}
          <button
            type="button"
            onClick={() =>
              setDrafts((prev) =>
                prev
                  ? [...prev, { name: "", quantity: "", unit: "" }]
                  : prev,
              )
            }
            className="mt-2 rounded-lg border border-[var(--border)] bg-[var(--surface)] px-3 py-1.5 text-sm font-medium text-[var(--text)]"
          >
            Add another ingredient
          </button>
          <div className="mt-4">
            <label
              htmlFor="scan-recipe-name"
              className="text-sm font-semibold"
            >
              Recipe name
            </label>
            <input
              id="scan-recipe-name"
              type="text"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="e.g. Chicken tikka masala"
              className="mt-1 w-full rounded-lg border border-[var(--border)] bg-[var(--surface)] px-3 py-2 text-[var(--text)]"
            />
          </div>
          <p className="mt-3 text-sm font-medium text-[var(--dim)]">
            Which meal is this?
          </p>
          <div
            role="group"
            aria-label="Scanned recipe meal type"
            className="mt-1.5 flex flex-wrap gap-2"
          >
            {MEAL_TYPES.map((t) => (
              <button
                key={t.id}
                type="button"
                aria-pressed={mealType === t.id}
                onClick={() => setMealType(t.id)}
                className={`rounded-full px-4 py-2 text-sm font-medium ${
                  mealType === t.id
                    ? "bg-[var(--accent)] text-[var(--accent-text)]"
                    : "border border-[var(--border)] bg-[var(--surface)] text-[var(--text)]"
                }`}
              >
                {t.label}
              </button>
            ))}
          </div>
          {saveError && (
            <p className="mt-2 text-sm text-[var(--out-text)]">
              {saveError}
            </p>
          )}
          <div className="mt-3 flex gap-2">
            <button
              type="button"
              disabled={
                !name.trim() || parsed.length === 0 || saveMeal.isPending
              }
              onClick={submitSave}
              className="rounded-lg bg-[var(--accent)] px-4 py-2 text-sm font-medium text-[var(--accent-text)] disabled:opacity-40"
            >
              {saveMeal.isPending ? "Saving…" : "Save to Meal List"}
            </button>
            <button
              type="button"
              onClick={() => {
                setDrafts(null);
                setImportNote(null);
                setSaveError(null);
              }}
              className="rounded-lg border border-[var(--border)] bg-[var(--surface)] px-4 py-2 text-sm font-medium"
            >
              Discard
            </button>
          </div>
        </div>
      )}
    </section>
  );
}

type GeneratedRecipe = ApiResponse<typeof api, "generateRecipe">;
type WebRecipe = NonNullable<GeneratedRecipe["webRecipe"]>;

/**
 * Swaps a parsed web recipe into the generated result: the dish
 * name, ingredients, and walkthrough come from the recipe page. The
 * page's quantities are stated for the page's own servings, so they
 * are re-based to the planner's 2-people convention here (the card
 * and the save/video flows then scale exactly like an
 * inventory-built recipe). When the page states no servings, its
 * amounts are taken to be for the headcount that was asked for.
 */
function applyWebRecipe(
  base: GeneratedRecipe,
  web: WebRecipe,
): GeneratedRecipe {
  const pageServings = web.servings ?? base.servings;
  const factor = pageServings > 0 ? 2 / pageServings : 1;
  return {
    ...base,
    name: web.name,
    ingredients: web.ingredients.map((i) => ({
      name: i.name,
      quantity:
        i.quantity != null
          ? Math.round(i.quantity * factor * 100) / 100
          : null,
      unit: i.unit,
    })),
    steps: web.steps,
  };
}

/**
 * Recipe generator: pick how many people, a meal type, and a protein.
 * For proteins in the curated web recipe table, the generator picks
 * a recipe from one of the top-rated free sites (RecipeTin Eats,
 * BBC Good Food, Allrecipes — the protein dictates which), reads
 * the page in the background, and shows that recipe — dish name,
 * ingredients scaled to the number of people, and the method as the
 * walkthrough — with a Source dropdown linking the original page.
 * While the page is loading, or when it can't be read, the body is
 * the inventory-built recipe (the protein plus in-stock supporting
 * ingredients) and the Source dropdown still names the chosen web
 * recipe. Proteins with no table entries just get the
 * inventory-built recipe. A keeper can be saved to the Meal List
 * (ingredients re-based to 2 people, like every other meal), and a
 * cooking video can be requested — Muse makes the reel externally
 * and it lands in the Recipe videos section below the generator.
 */
function RecipeGenerator({
  inventory,
  onMealSaved,
}: {
  inventory: Planner["inventory"];
  onMealSaved: () => void;
}) {
  const queryClient = useQueryClient();
  const [protein, setProtein] = useState<string>("");
  const [mealType, setMealType] = useState<MealType>("dinner");
  const [servings, setServings] = useState(2);
  const [variant, setVariant] = useState(0);
  const [recipe, setRecipe] = useState<GeneratedRecipe | null>(null);
  const [savedMealId, setSavedMealId] = useState<number | null>(null);
  const [videoStatus, setVideoStatus] = useState<
    "none" | "requested" | "ready"
  >("none");
  const [message, setMessage] = useState<string | null>(null);
  // Web recipe page load for the current generation: while it's
  // pending the card shows the inventory-built recipe; when it lands
  // the web recipe takes over the card. `webFromPage` marks that the
  // displayed body is the page's recipe (not the fallback).
  const [webLoadId, setWebLoadId] = useState<number | null>(null);
  const [webFromPage, setWebFromPage] = useState(false);
  const [webFailed, setWebFailed] = useState(false);

  const generate = useMutation({
    mutationFn: async (args: {
      protein: string;
      mealType: MealType;
      servings: number;
      variant: number;
    }) => await api.generateRecipe(args),
    onSuccess: (res) => {
      setSavedMealId(null);
      setVideoStatus("none");
      setMessage(null);
      setWebFailed(res.webStatus === "failed");
      if (res.webStatus === "done" && res.webRecipe) {
        setRecipe(applyWebRecipe(res, res.webRecipe));
        setWebFromPage(true);
        setWebLoadId(null);
      } else {
        setRecipe(res);
        setWebFromPage(false);
        setWebLoadId(res.webStatus === "pending" ? res.webLoadId : null);
      }
    },
    onError: () =>
      setMessage("That recipe couldn't be generated. Try again."),
  });

  const webLoad = useQuery({
    queryKey: ["web-recipe-load", webLoadId],
    queryFn: () => api.getWebRecipeLoad({ loadId: webLoadId ?? 0 }),
    enabled: webLoadId != null,
    refetchInterval: (q) =>
      q.state.data?.status === "pending" ? 3000 : false,
  });

  useEffect(() => {
    if (webLoadId == null || !webLoad.data) return;
    const d = webLoad.data;
    if (d.status === "done" && d.recipe) {
      const web = d.recipe;
      setRecipe((prev) =>
        prev && prev.webLoadId === webLoadId
          ? applyWebRecipe(prev, web)
          : prev,
      );
      setWebFromPage(true);
      setWebLoadId(null);
    } else if (d.status === "failed" || d.status === "none") {
      // The page couldn't be read — the inventory-built recipe
      // already on the card stays as the fallback body.
      setWebFailed(true);
      setWebLoadId(null);
    }
  }, [webLoadId, webLoad.data]);

  const runGenerate = (nextVariant: number) => {
    if (!protein) return;
    setVariant(nextVariant);
    generate.mutate({ protein, mealType, servings, variant: nextVariant });
  };

  // Ingredient coverage for the generated recipe: its ingredients
  // (at the 2-person base amounts, before the card's servings
  // scaling) cross-referenced with the HIT List, same as a saved
  // meal's — so the fraction and per-ingredient marks show before
  // the recipe is saved, and its needs land on the Shopping List
  // once it is.
  const generatedIngredients = recipe?.ingredients ?? [];
  const generatedCoverage = useQuery({
    queryKey: [
      "ingredient-coverage",
      JSON.stringify(generatedIngredients),
    ],
    queryFn: () =>
      api.getIngredientCoverage({
        ingredients: generatedIngredients.map((i) => ({
          name: i.name,
          quantity: i.quantity,
          unit: i.unit,
        })),
      }),
    enabled: generatedIngredients.length > 0,
  });

  const linkVideoToMeal = useMutation({
    mutationFn: async (args: {
      recipe: GeneratedRecipe;
      mealId: number;
    }) =>
      await api.requestRecipeVideo({
        recipeName: args.recipe.name,
        mealType: args.recipe.mealType,
        protein: args.recipe.protein,
        servings: args.recipe.servings,
        ingredients: args.recipe.ingredients.map((i) => ({
          name: i.name,
          quantity:
            i.quantity != null
              ? Math.round(((i.quantity * args.recipe.servings) / 2) * 100) /
                100
              : null,
          unit: i.unit,
        })),
        steps: args.recipe.steps,
        mealId: args.mealId,
        mealName: args.recipe.name,
        sourceName: args.recipe.source?.dishName ?? null,
        sourceSite: args.recipe.source?.site ?? null,
        sourceUrl: args.recipe.source?.url ?? null,
      }),
    onSuccess: () =>
      queryClient.invalidateQueries({ queryKey: ["videos"] }),
  });

  const addToMealList = useMutation({
    mutationFn: async (r: GeneratedRecipe) => {
      const added = await api.addMeal({
        name: r.name,
        mealType: r.mealType,
        groups: [[{ label: r.protein, sheetName: r.protein }]],
      });
      await api.setMealIngredients({
        mealId: added.id,
        ingredients: r.ingredients.map((i) => ({
          name: i.name,
          quantity: i.quantity,
          unit: i.unit,
        })),
      });
      // A web-sourced recipe keeps its source with the saved meal
      // (local metadata — it surfaces on the meal's Recipe videos
      // entry, never in the Meal List rows or the sync format).
      if (r.source) {
        await api.setMealSource({
          mealId: added.id,
          sourceName: r.source.dishName,
          sourceSite: r.source.site,
          sourceUrl: r.source.url,
        });
      }
      return added.id;
    },
    onSuccess: (mealId, r) => {
      setSavedMealId(mealId);
      setMessage(`“${r.name}” is on the Meal List now — pick it any day.`);
      queryClient.invalidateQueries({ queryKey: ["planner"] });
      queryClient.invalidateQueries({ queryKey: ["recipe-needs"] });
      // If a video was already requested for this recipe, link the
      // request to the saved meal (matched by name server-side).
      if (videoStatus !== "none") {
        linkVideoToMeal.mutate({ recipe: r, mealId });
      }
      onMealSaved();
    },
    onError: () =>
      setMessage("That recipe couldn't be added to the Meal List."),
  });

  const requestVideo = useMutation({
    mutationFn: async (r: GeneratedRecipe) =>
      await api.requestRecipeVideo({
        recipeName: r.name,
        mealType: r.mealType,
        protein: r.protein,
        servings: r.servings,
        ingredients: r.ingredients.map((i) => ({
          name: i.name,
          quantity:
            i.quantity != null
              ? Math.round(((i.quantity * r.servings) / 2) * 100) / 100
              : null,
          unit: i.unit,
        })),
        steps: r.steps,
        mealId: savedMealId,
        mealName: savedMealId != null ? r.name : null,
        sourceName: r.source?.dishName ?? null,
        sourceSite: r.source?.site ?? null,
        sourceUrl: r.source?.url ?? null,
      }),
    onSuccess: (res) => {
      setVideoStatus(res.status);
      setMessage(
        res.status === "ready"
          ? "That recipe's video is ready — watch it in Recipe videos below."
          : "Video requested — Muse will make the cooking video and it'll show up in Recipe videos below.",
      );
      queryClient.invalidateQueries({ queryKey: ["videos"] });
    },
    onError: () => setMessage("The video request couldn't be saved."),
  });

  return (
    <section
      aria-label="Recipe generator"
      className="mt-2 rounded-[var(--radius)] border border-[var(--border)] bg-[var(--surface)] p-4 text-[var(--text)]"
    >
      <h2 className="text-xl font-semibold">Recipe generator</h2>
      <p className="mt-0.5 text-sm text-[var(--dim)]">
        Pick how many people you&rsquo;re cooking for, which meal
        it is, and a protein — for most proteins the recipe comes
        from a top-rated site (RecipeTin Eats, BBC Good Food,
        Allrecipes); otherwise it&rsquo;s built from what&rsquo;s
        in the inventory right now.
      </p>

      <div className="mt-4 flex items-center gap-3">
        <span className="text-sm font-medium text-[var(--dim)]">
          Cooking for
        </span>
        <ServingsStepper value={servings} onChange={setServings} />
      </div>

      <p className="mt-4 text-sm font-medium text-[var(--dim)]">
        Which meal is this?
      </p>
      <div
        role="group"
        aria-label="Generator meal type"
        className="mt-1.5 flex flex-wrap gap-2"
      >
        {MEAL_TYPES.map((t) => (
          <button
            key={t.id}
            type="button"
            aria-pressed={mealType === t.id}
            onClick={() => setMealType(t.id)}
            className={`rounded-full px-4 py-2 text-sm font-medium ${
              mealType === t.id
                ? "bg-[var(--accent)] text-[var(--accent-text)]"
                : "border border-[var(--border)] bg-[var(--surface)] text-[var(--text)]"
            }`}
          >
            {t.label}
          </button>
        ))}
      </div>

      <label
        htmlFor="generator-protein"
        className="mt-4 block text-sm font-medium text-[var(--dim)]"
      >
        Protein
      </label>
      <div className="relative mt-1">
        <select
          id="generator-protein"
          value={protein}
          onChange={(e) => setProtein(e.target.value)}
          className={`w-full appearance-none rounded-lg border border-[var(--border)] bg-[var(--surface)] px-4 py-2.5 pr-11 text-base ${
            protein ? "text-[var(--text)]" : "text-[var(--dim)]"
          }`}
        >
          <option value="" disabled>
            Protein Choice
          </option>
          {inventory.map((item) => (
            <option key={item.sheetName} value={item.sheetName}>
              {item.sheetName} —{" "}
              {item.stock == null
                ? "not counted yet"
                : item.stock === 0
                  ? "out of stock"
                  : `${item.stock} on hand`}
            </option>
          ))}
        </select>
        <span
          aria-hidden="true"
          className="pointer-events-none absolute top-1/2 right-4 -translate-y-1/2 text-[var(--dim)]"
        >
          ▾
        </span>
      </div>

      <button
        type="button"
        disabled={!protein || generate.isPending}
        onClick={() => runGenerate(0)}
        className="mt-4 rounded-lg bg-[var(--accent)] px-4 py-2 font-medium text-[var(--accent-text)] disabled:opacity-40"
      >
        {generate.isPending ? "Generating…" : "Generate recipe"}
      </button>

      {message && <p className="mt-3 text-sm text-[var(--dim)]">{message}</p>}

      {recipe && (
        <div className="mt-4 rounded-lg bg-[var(--surface-alt)] p-4">
          <h3 className="text-lg font-semibold">{recipe.name}</h3>
          <p className="mt-0.5 text-sm text-[var(--dim)]">
            {mealTypeLabel(recipe.mealType)} · {recipe.protein} · for{" "}
            {recipe.servings}{" "}
            {recipe.servings === 1 ? "person" : "people"}
          </p>
          {!recipe.proteinInStock && (
            <p
              className="mt-2 rounded-lg px-3 py-2 text-sm font-medium"
              style={{
                backgroundColor: "var(--out-bg)",
                color: "var(--out-text)",
              }}
            >
              {recipe.proteinStock == null
                ? `${recipe.protein} isn't on the HIT List yet, so we can't tell if it's on hand.`
                : `${recipe.protein} is out of stock right now — one to make after a shop.`}
            </p>
          )}

          <h4 className="mt-4 text-sm font-semibold">
            Ingredients · for {recipe.servings}{" "}
            {recipe.servings === 1 ? "person" : "people"}
          </h4>
          <ul className="mt-1.5 space-y-1 text-sm">
            {recipe.ingredients.map((ing, i) => {
              const mark = generatedCoverage.data?.entries[i] ?? null;
              return (
                <li key={i} className="flex flex-wrap items-center gap-2">
                  <span className="w-24 shrink-0 font-medium">
                    {ing.quantity != null
                      ? `${scaledQuantity(ing.quantity, recipe.servings)}${ing.unit ? ` ${ing.unit}` : ""}`
                      : (ing.unit ?? "")}
                  </span>
                  <span className="min-w-0 flex-1">{ing.name}</span>
                  {mark && <CoverageChip mark={mark} />}
                </li>
              );
            })}
          </ul>
          {generatedCoverage.data && (
            <div className="mt-2">
              <CoverageFraction
                covered={generatedCoverage.data.coveredCount}
                total={generatedCoverage.data.totalCount}
              />
            </div>
          )}

          <h4 className="mt-4 text-sm font-semibold">Walkthrough</h4>
          <ol className="mt-1.5 list-decimal space-y-1.5 pl-5 text-sm">
            {recipe.steps.map((step, i) => (
              <li key={i}>{step}</li>
            ))}
          </ol>

          {recipe.source && (
            <div className="mt-4">
              {webLoadId != null ? (
                <p className="mb-1.5 text-xs text-[var(--dim)]">
                  Reading “{recipe.source.dishName}” from{" "}
                  {recipe.source.site}… this version is built from your
                  inventory until it lands.
                </p>
              ) : webFailed && !webFromPage ? (
                <p className="mb-1.5 text-xs text-[var(--dim)]">
                  {recipe.source.site} couldn&rsquo;t be read just
                  now, so this version is built from your inventory —
                  the original recipe is linked here.
                </p>
              ) : null}
              <SourceDropdown
                name={recipe.source.dishName}
                heading={`Recipe from ${recipe.source.site}`}
                url={recipe.source.url}
                itemLabel={recipe.source.dishName}
              />
            </div>
          )}

          <div className="mt-4 flex flex-wrap gap-2">
            <button
              type="button"
              disabled={generate.isPending}
              onClick={() => runGenerate(variant + 1)}
              className="rounded-lg border border-[var(--border)] bg-[var(--surface)] px-4 py-2 text-sm font-medium disabled:opacity-40"
            >
              Generate another
            </button>
            {savedMealId == null ? (
              <button
                type="button"
                disabled={addToMealList.isPending}
                onClick={() => addToMealList.mutate(recipe)}
                className="rounded-lg bg-[var(--accent)] px-4 py-2 text-sm font-medium text-[var(--accent-text)] disabled:opacity-40"
              >
                {addToMealList.isPending
                  ? "Adding…"
                  : "Add to meal list"}
              </button>
            ) : (
              <span className="rounded-lg bg-[var(--ok-bg)] px-4 py-2 text-sm font-medium text-[var(--ok-text)]">
                On the Meal List ✓
              </span>
            )}
            {videoStatus === "none" ? (
              <button
                type="button"
                disabled={requestVideo.isPending}
                onClick={() => requestVideo.mutate(recipe)}
                className="rounded-lg border border-[var(--border)] bg-[var(--surface)] px-4 py-2 text-sm font-medium disabled:opacity-40"
              >
                {requestVideo.isPending
                  ? "Requesting…"
                  : "Make the cooking video"}
              </button>
            ) : (
              <span className="rounded-lg bg-[var(--surface)] px-4 py-2 text-sm font-medium text-[var(--dim)]">
                {videoStatus === "ready"
                  ? "Video ready — see Recipe videos below"
                  : "Video requested — see Recipe videos below"}
              </span>
            )}
          </div>
        </div>
      )}
    </section>
  );
}

/**
 * Protein stock panel: the proteins the meals reference, with counts
 * read from this app's HIT List cache. Refreshing runs the same HIT
 * List refresh as the HIT List tab, so one sync feeds both.
 */
function InventoryPanel({
  inventory,
  updatedAt,
  flags,
  onToggleFlag,
}: {
  inventory: Planner["inventory"];
  updatedAt: string | null;
  flags: Set<string>;
  onToggleFlag: (sheetName: string) => void;
}) {
  const queryClient = useQueryClient();
  const [message, setMessage] = useState<string | null>(null);
  const [expanded, setExpanded] = useState(false);
  const refresh = useMutation({
    mutationFn: async () => await api.refreshHitList({}),
    onSuccess: (result) => {
      setMessage(
        result.started
          ? "Refreshing from the HIT List — new counts land here within a minute or so."
          : "The refresh couldn't start. Try again in a bit.",
      );
      // Give the background task a head start, then refetch.
      setTimeout(() => {
        queryClient.invalidateQueries({ queryKey: ["planner"] });
        queryClient.invalidateQueries({ queryKey: ["hit"] });
      }, 20000);
    },
    onError: () =>
      setMessage("The refresh couldn't start. Try again in a bit."),
  });

  const uncounted = inventory.filter((i) => i.stock == null);

  const syncedLabel = updatedAt
    ? `Last synced ${new Date(updatedAt).toLocaleString(undefined, {
        month: "short",
        day: "numeric",
        hour: "numeric",
        minute: "2-digit",
      })}`
    : null;

  return (
    <section
      aria-label="Protein stock"
      className="mt-2 rounded-[var(--radius)] border border-[var(--border)] bg-[var(--surface)] text-[var(--text)]"
    >
      <div className="flex items-center justify-between gap-2 p-4">
        <button
          type="button"
          aria-expanded={expanded}
          aria-controls="protein-stock-panel"
          onClick={() => setExpanded((v) => !v)}
          className="flex min-w-0 flex-1 items-center justify-between gap-3 text-left"
        >
          <span className="min-w-0">
            <span className="block text-xl font-semibold">
              Protein stock
            </span>
            <span className="mt-0.5 block truncate text-sm text-[var(--dim)]">
              {inventory.length} items
              {syncedLabel ? ` · ${syncedLabel}` : ""}
              {flags.size > 0
                ? ` · ${flags.size} flagged for shopping`
                : ""}
            </span>
          </span>
          <span
            aria-hidden="true"
            className="shrink-0 text-lg text-[var(--dim)]"
          >
            {expanded ? "▾" : "▸"}
          </span>
        </button>
      </div>
      {expanded && (
        <div
          id="protein-stock-panel"
          className="border-t border-[var(--border)] px-4 pt-3 pb-4"
        >
          <div className="flex items-center justify-between gap-2">
            <p className="text-sm text-[var(--dim)]">
              Counts come from the HIT List tab — the same inventory as
              the HIT List tab in this app.
            </p>
            <button
              type="button"
              disabled={refresh.isPending}
              onClick={() => {
                setMessage(null);
                refresh.mutate();
              }}
              className="shrink-0 rounded-lg border border-[var(--border)] bg-[var(--surface)] px-3 py-1.5 text-sm font-medium disabled:opacity-40"
            >
              {refresh.isPending ? "Starting…" : "Refresh from HIT List"}
            </button>
          </div>
          {message && <p className="mt-2 text-sm">{message}</p>}
          <ul className="mt-3 grid grid-cols-1 gap-1.5 sm:grid-cols-2">
            {inventory.map((item) => {
              const status: Status =
                item.stock == null ? "unknown" : item.stock > 0 ? "in" : "out";
              const flagged = flags.has(item.sheetName);
              return (
                <li
                  key={item.sheetName}
                  className={`flex items-center justify-between gap-2 rounded-lg px-3 py-2 ${statusClasses(status)}`}
                >
                  <span className="font-medium">{item.sheetName}</span>
                  <span className="flex items-center gap-2">
                    <span className="text-sm">
                      {item.stock == null
                        ? "Not counted yet"
                        : item.stock === 0
                          ? "Out"
                          : `${item.stock} on hand`}
                    </span>
                    {(item.stock === 0 || flagged) && (
                      <button
                        type="button"
                        onClick={() => onToggleFlag(item.sheetName)}
                        className="shrink-0 rounded-md border border-[var(--border)] bg-[var(--surface)] px-2 py-1 text-xs font-medium text-[var(--text)]"
                      >
                        {flagged ? "Flagged ✓ · Unflag" : "Flag for shopping"}
                      </button>
                    )}
                  </span>
                </li>
              );
            })}
          </ul>
          {uncounted.length > 0 && (
            <p className="mt-2 text-sm text-[var(--dim)]">
              {uncounted.map((i) => i.sheetName).join(", ")}{" "}
              {uncounted.length === 1 ? "isn't" : "aren't"} in the HIT List
              yet — add a row there and the next sync will count{" "}
              {uncounted.length === 1 ? "it" : "them"} here.
            </p>
          )}
          {flags.size > 0 && (
            <div className="mt-4">
              <h3 className="text-sm font-semibold">Flagged for shopping</h3>
              <ul className="mt-1.5 flex flex-wrap gap-1.5">
                {[...flags].sort().map((sheetName) => (
                  <li
                    key={sheetName}
                    className="flex items-center gap-1 rounded-full bg-[var(--out-bg)] py-1 pr-1 pl-3 text-sm font-medium text-[var(--out-text)]"
                  >
                    {sheetName}
                    <button
                      type="button"
                      aria-label={`Remove shopping flag for ${sheetName}`}
                      onClick={() => onToggleFlag(sheetName)}
                      className="rounded-full px-1.5 font-medium"
                    >
                      ✕
                    </button>
                  </li>
                ))}
              </ul>
            </div>
          )}
        </div>
      )}
    </section>
  );
}

type OptionDraft = { label: string; sheetName: string };

/**
 * The Meal List dropdown body and the add-meal form. Both toggles —
 * "Meal List" and "Add Meal" — sit in the Meal List block, between
 * the day panel (the pick-a-meal box) and the protein stock box,
 * and the list and the form each render directly under that block.
 */
function MealIdeas({
  meals,
  knownItems,
  listOpen,
  formOpen,
  onFormOpenChange,
  onListOpenChange,
}: {
  meals: Meal[];
  knownItems: string[];
  listOpen: boolean;
  formOpen: boolean;
  onFormOpenChange: (open: boolean) => void;
  onListOpenChange: (open: boolean) => void;
}) {
  const queryClient = useQueryClient();
  const invalidate = () =>
    queryClient.invalidateQueries({ queryKey: ["planner"] });

  const [name, setName] = useState("");
  const [newMealType, setNewMealType] = useState<MealType>("dinner");
  const [options, setOptions] = useState<OptionDraft[]>([
    { label: "", sheetName: "" },
  ]);
  const [alsoNeeds, setAlsoNeeds] = useState<OptionDraft | null>(null);
  const [confirmDeleteId, setConfirmDeleteId] = useState<number | null>(null);
  const [openIngredientsId, setOpenIngredientsId] = useState<number | null>(
    null,
  );
  const favouriteIds = favouriteIdsOf(meals);

  // Cooking videos for saved meals: the request snapshot carries the
  // meal's name, type, protein, and ingredients (for 2 people, the
  // planner's convention); Muse makes the video externally and it
  // lands in the Recipe videos section below the generator.
  const videos = useQuery({
    queryKey: ["videos"],
    queryFn: () => api.getRecipeVideos({}),
  });
  const videoByMealName = useMemo(
    () =>
      new Map(
        (videos.data?.videos ?? []).map((v) => [
          v.recipeName.trim().toLowerCase(),
          v,
        ]),
      ),
    [videos.data],
  );
  const requestMealVideo = useMutation({
    mutationFn: async (meal: Meal) =>
      await api.requestRecipeVideo({
        recipeName: meal.name,
        mealType: meal.mealType,
        protein: meal.proteins[0]?.label ?? null,
        servings: 2,
        ingredients: meal.ingredients.map((i) => ({
          name: i.name,
          quantity: i.quantity,
          unit: i.unit,
        })),
        steps: meal.note
          ? meal.note
              .split(/\n+/)
              .map((s) => s.trim())
              .filter(Boolean)
          : [],
        mealId: meal.id,
        mealName: meal.name,
      }),
    onSuccess: () =>
      queryClient.invalidateQueries({ queryKey: ["videos"] }),
  });

  const addMeal = useMutation({
    mutationFn: async () =>
      await api.addMeal({
        name: name.trim(),
        mealType: newMealType,
        groups: [
          options
            .filter((o) => o.label.trim() && o.sheetName.trim())
            .map((o) => ({ label: o.label.trim(), sheetName: o.sheetName.trim() })),
          ...(alsoNeeds && alsoNeeds.label.trim() && alsoNeeds.sheetName.trim()
            ? [
                [
                  {
                    label: alsoNeeds.label.trim(),
                    sheetName: alsoNeeds.sheetName.trim(),
                  },
                ],
              ]
            : []),
        ],
      }),
    onSuccess: () => {
      onFormOpenChange(false);
      onListOpenChange(true);
      setName("");
      setNewMealType("dinner");
      setOptions([{ label: "", sheetName: "" }]);
      setAlsoNeeds(null);
      invalidate();
    },
  });

  const deleteMeal = useMutation({
    mutationFn: async (mealId: number) => await api.deleteMeal({ mealId }),
    onSuccess: () => {
      setConfirmDeleteId(null);
      invalidate();
    },
  });

  const validOptions = options.filter(
    (o) => o.label.trim() && o.sheetName.trim(),
  );
  const canAdd = name.trim().length > 0 && validOptions.length > 0;

  // Possible doubles for the name being typed, so the user can compare
  // before adding a meal that's already on the list. Only meals of the
  // type being added count — a breakfast "Pancakes" doesn't clash with
  // a dinner of the same name.
  const dupes = useMemo(
    () =>
      possibleDuplicates(
        name,
        meals.filter((m) => m.mealType === newMealType),
      ),
    [name, meals, newMealType],
  );

  const setOption = (index: number, patch: Partial<OptionDraft>) =>
    setOptions((prev) =>
      prev.map((o, i) => (i === index ? { ...o, ...patch } : o)),
    );

  if (!listOpen && !formOpen) return null;

  return (
    <section aria-label="Meal list" className="mt-2 text-[var(--text)]">
      {listOpen && (
      <ul id="meal-list" className="space-y-1.5">
        {meals.map((meal) => (
          <li
            key={meal.id}
            className="rounded-lg border border-[var(--border)] bg-[var(--surface)] px-3 py-2"
          >
            <div className="flex items-center justify-between gap-2">
            <div>
              <span className="font-medium">{meal.name}</span>
              <span className="ml-2 rounded-full bg-[var(--surface-alt)] px-2 py-0.5 text-xs font-semibold text-[var(--dim)]">
                {mealTypeLabel(meal.mealType)}
              </span>
              {favouriteIds.has(meal.id) && (
                <span className="ml-2 rounded-full bg-[var(--ok-bg)] px-2 py-0.5 text-xs font-semibold text-[var(--ok-text)]">
                  ★ Favourite
                </span>
              )}
              <span className="block text-sm text-[var(--dim)]">
                {groupsOf(meal)
                  .map((g) => g.options.map((o) => o.label).join(" or "))
                  .join(" + ")}
              </span>
              {variantSpecOf(meal) && (
                <span className="block text-sm text-[var(--dim)]">
                  Style: {variantSpecOf(meal)?.options.join(", ")}
                </span>
              )}
              <span className="block text-sm text-[var(--dim)]">
                {pickCountWord(meal)
                  ? `${pickCountWord(meal)} · ${lastEatenWord(meal)}`
                  : lastEatenWord(meal)}
              </span>
            </div>
            {confirmDeleteId === meal.id ? (
              <span className="flex shrink-0 gap-1">
                <button
                  type="button"
                  disabled={deleteMeal.isPending}
                  onClick={() => deleteMeal.mutate(meal.id)}
                  className="rounded-md px-3 py-1.5 text-sm font-medium text-white"
                  style={{ backgroundColor: "var(--red)" }}
                >
                  Remove it
                </button>
                <button
                  type="button"
                  onClick={() => setConfirmDeleteId(null)}
                  className="rounded-md border border-[var(--border)] px-3 py-1.5 text-sm font-medium"
                >
                  Keep
                </button>
              </span>
            ) : (
              <span className="flex shrink-0 gap-1">
                <button
                  type="button"
                  aria-expanded={openIngredientsId === meal.id}
                  aria-label={`Edit ${meal.name}`}
                  onClick={() =>
                    setOpenIngredientsId((id) =>
                      id === meal.id ? null : meal.id,
                    )
                  }
                  className="rounded-md border border-[var(--border)] px-3 py-1.5 text-sm font-medium text-[var(--dim)]"
                >
                  Edit
                </button>
                <button
                  type="button"
                  aria-label={`Remove ${meal.name}`}
                  onClick={() => setConfirmDeleteId(meal.id)}
                  className="rounded-md border border-[var(--border)] px-3 py-1.5 text-base font-medium text-[var(--dim)]"
                >
                  ✕
                </button>
              </span>
            )}
            </div>
            <div className="mt-2">
              {(() => {
                const video = videoByMealName.get(
                  meal.name.trim().toLowerCase(),
                );
                if (video?.status === "ready") {
                  return (
                    <span className="text-sm font-medium text-[var(--ok-text)]">
                      Cooking video ready — watch it in Recipe videos below
                    </span>
                  );
                }
                if (video?.status === "requested") {
                  return (
                    <span className="text-sm font-medium text-[var(--dim)]">
                      Cooking video requested — Muse is making it
                    </span>
                  );
                }
                return (
                  <button
                    type="button"
                    aria-label={`Make the cooking video for ${meal.name}`}
                    disabled={requestMealVideo.isPending}
                    onClick={() => requestMealVideo.mutate(meal)}
                    className="rounded-md border border-[var(--border)] px-3 py-1.5 text-sm font-medium text-[var(--text)] disabled:opacity-40"
                  >
                    Make the cooking video
                  </button>
                );
              })()}
            </div>
            {openIngredientsId === meal.id && (
              <IngredientSection meal={meal} servings={2} defaultExpanded />
            )}
          </li>
        ))}
      </ul>
      )}

      {formOpen && (
        <form
          className={`${listOpen ? "mt-2 " : ""}rounded-[var(--radius)] border border-[var(--border)] bg-[var(--surface)] p-4`}
          onSubmit={(e) => {
            e.preventDefault();
            if (canAdd) addMeal.mutate();
          }}
        >
          <label htmlFor="new-meal-name" className="text-sm font-semibold">
            Meal name
          </label>
          <input
            id="new-meal-name"
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="e.g. Taco night"
            className="mt-1 w-full rounded-lg border border-[var(--border)] bg-[var(--surface)] px-3 py-2 text-[var(--text)]"
          />

          <p className="mt-4 text-sm font-semibold">
            Which meal is it?
          </p>
          <div
            role="group"
            aria-label="New meal type"
            className="mt-1.5 flex flex-wrap gap-2"
          >
            {MEAL_TYPES.map((t) => (
              <button
                key={t.id}
                type="button"
                aria-pressed={newMealType === t.id}
                onClick={() => setNewMealType(t.id)}
                className={`rounded-full px-4 py-2 text-sm font-medium ${
                  newMealType === t.id
                    ? "bg-[var(--accent)] text-[var(--accent-text)]"
                    : "border border-[var(--border)] bg-[var(--surface)] text-[var(--text)]"
                }`}
              >
                {t.label}
              </button>
            ))}
          </div>

          {dupes.length > 0 && (
            <div
              role="alert"
              className="mt-3 rounded-lg bg-[var(--unknown-bg)] p-3 text-[var(--unknown-text)]"
            >
              <p className="text-sm font-semibold">
                {dupes.length === 1
                  ? "This might already be on your list — is it the same meal?"
                  : "These might already be on your list — are any of them the same meal?"}
              </p>
              <ul className="mt-2 space-y-1.5">
                {dupes.map((dupe) => (
                  <li
                    key={dupe.id}
                    className="rounded-md bg-[var(--surface)] px-3 py-2 text-[var(--text)]"
                  >
                    <span className="font-medium">{dupe.name}</span>
                    {favouriteIds.has(dupe.id) && (
                      <span className="ml-2 rounded-full bg-[var(--ok-bg)] px-2 py-0.5 text-xs font-semibold text-[var(--ok-text)]">
                        ★ Favourite
                      </span>
                    )}
                    <span className="block text-sm text-[var(--dim)]">
                      {groupsOf(dupe)
                        .map((g) => g.options.map((o) => o.label).join(" or "))
                        .join(" + ")}
                    </span>
                    <span className="block text-sm text-[var(--dim)]">
                      {pickCountWord(dupe)
                        ? `${pickCountWord(dupe)} · ${lastEatenWord(dupe)}`
                        : lastEatenWord(dupe)}
                    </span>
                  </li>
                ))}
              </ul>
              <p className="mt-2 text-sm">
                If it&apos;s a different meal, add it anyway below. If it&apos;s the
                same, close the form — it&apos;s already there.
              </p>
            </div>
          )}

          <p className="mt-4 text-sm font-semibold">
            Protein — needs one of these
          </p>
          <p className="text-sm text-[var(--dim)]">
            The HIT List item is the exact name in the inventory sheet, so the
            stock count lines up (sausages are just &quot;Sausages&quot; there).
          </p>
          <datalist id="hit-items">
            {knownItems.map((item) => (
              <option key={item} value={item} />
            ))}
          </datalist>
          {options.map((option, i) => (
            <div key={i} className="mt-2 flex flex-wrap gap-2">
              <input
                aria-label={`Protein option ${i + 1} name`}
                value={option.label}
                onChange={(e) => setOption(i, { label: e.target.value })}
                placeholder="Name, e.g. Mild Italian sausage"
                className="min-w-40 flex-1 rounded-lg border border-[var(--border)] bg-[var(--surface)] px-3 py-2 text-[var(--text)]"
              />
              <input
                aria-label={`Protein option ${i + 1} HIT List item`}
                value={option.sheetName}
                onChange={(e) => setOption(i, { sheetName: e.target.value })}
                placeholder="HIT List item, e.g. Sausages"
                list="hit-items"
                className="min-w-40 flex-1 rounded-lg border border-[var(--border)] bg-[var(--surface)] px-3 py-2 text-[var(--text)]"
              />
              {options.length > 1 && (
                <button
                  type="button"
                  aria-label={`Remove protein option ${i + 1}`}
                  onClick={() =>
                    setOptions((prev) => prev.filter((_, j) => j !== i))
                  }
                  className="rounded-lg border border-[var(--border)] px-3 font-medium text-[var(--dim)]"
                >
                  ✕
                </button>
              )}
            </div>
          ))}
          <button
            type="button"
            onClick={() =>
              setOptions((prev) => [...prev, { label: "", sheetName: "" }])
            }
            className="mt-2 rounded-lg border border-[var(--border)] px-3 py-1.5 text-sm font-medium"
          >
            Add another option
          </button>

          <div className="mt-4">
            {alsoNeeds == null ? (
              <button
                type="button"
                onClick={() => setAlsoNeeds({ label: "", sheetName: "" })}
                className="rounded-lg border border-[var(--border)] px-3 py-1.5 text-sm font-medium"
              >
                It also needs a second protein (like eggs with bacon)
              </button>
            ) : (
              <div>
                <p className="text-sm font-semibold">Also needs</p>
                <div className="mt-2 flex flex-wrap gap-2">
                  <input
                    aria-label="Second required protein name"
                    value={alsoNeeds.label}
                    onChange={(e) =>
                      setAlsoNeeds({ ...alsoNeeds, label: e.target.value })
                    }
                    placeholder="Name, e.g. Eggs"
                    className="min-w-40 flex-1 rounded-lg border border-[var(--border)] bg-[var(--surface)] px-3 py-2 text-[var(--text)]"
                  />
                  <input
                    aria-label="Second required protein HIT List item"
                    value={alsoNeeds.sheetName}
                    onChange={(e) =>
                      setAlsoNeeds({ ...alsoNeeds, sheetName: e.target.value })
                    }
                    placeholder="HIT List item, e.g. Eggs"
                    list="hit-items"
                    className="min-w-40 flex-1 rounded-lg border border-[var(--border)] bg-[var(--surface)] px-3 py-2 text-[var(--text)]"
                  />
                  <button
                    type="button"
                    aria-label="Remove second required protein"
                    onClick={() => setAlsoNeeds(null)}
                    className="rounded-lg border border-[var(--border)] px-3 font-medium text-[var(--dim)]"
                  >
                    ✕
                  </button>
                </div>
              </div>
            )}
          </div>

          {addMeal.error && (
            <p className="mt-2 text-sm text-[var(--out-text)]">
              That meal couldn&apos;t be added — check the protein names and try
              again.
            </p>
          )}
          <button
            type="submit"
            disabled={!canAdd || addMeal.isPending}
            className="mt-4 rounded-lg bg-[var(--accent)] px-4 py-2 font-medium text-[var(--accent-text)] disabled:opacity-40"
          >
            {dupes.length > 0 ? "Add anyway — it's different" : "Add meal"}
          </button>
        </form>
      )}
    </section>
  );
}
