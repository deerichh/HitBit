// Actions for the HitBit app (household HIT + business BIT).
//
// An optional Google Sheet ("Shopping List" tab) can be the system
// of record for the household side — set SPREADSHEET_ID below to
// your sheet's ID to enable it. This app caches its rows in ctx.db:
//   getList     — client reads the cached rows + check-off state
//   saveList    — the refresh agent task writes freshly read sheet rows
//   refreshList — spawns that agent task (also the daily cron target)
//   setChecked  — local check-off toggle (never written back to the sheet)

import {
defineAction,
z,
type ActionsModule,
type Ctx,
} from "@hatch/space-sdk";
import { and, asc, desc, eq, isNotNull, isNull, lt } from "drizzle-orm";
import type { BatchItem } from "drizzle-orm/batch";
import * as schema from "./schema";
import bitScoopExportJson from "./migration/bit-daily-scoop.json";
import bitAnalyticsExportJson from "./migration/bit-scoop-analytics.json";
import accountSettingsExportJson from "./migration/account-settings.json";
import { PDFDocument } from "pdf-lib";
import { buildReqFormPdf } from "./reqFormTemplate";

// Your household Google Sheet's ID (its "Shopping List" and
// "HIT List" tabs), or "" when no sheet is connected: the refresh
// actions refuse until an ID is set, and everything else runs off
// the app's own data. Never commit a real sheet ID here.
const SPREADSHEET_ID = "";

const priceTrendShape = z.object({
  lowestCents: z.number(),
  lowestDate: z.string(),
  // vs the previous observation: the price went down, up, or stayed.
  direction: z.enum(["down", "up", "same"]),
});

const sourceShape = z.object({
  url: z.string(),
  // "flipp" = found on Flipp; "website" = found on a store website.
  sourceType: z.enum(["flipp", "website"]),
  store: z.string().nullable(),
  // Local date key the source was last recorded.
  updatedDate: z.string(),
});

const itemShape = z.object({
  key: z.string(),
  section: z.string(),
  item: z.string(),
  stock: z.number(),
  usualStore: z.string(),
  bestPriceRaw: z.string().nullable(),
  priceCents: z.number().nullable(),
  savingsNote: z.string().nullable(),
  buyAt: z.string().nullable(),
  endOfSale: z.string().nullable(),
  exactProduct: z.string().nullable(),
  checked: z.boolean(),
  // True once this checked item's "Purchased" button has been
  // confirmed and its quantity recorded into the inventory. The item
  // stays checked on the list but leaves the purchased dropdown.
  restocked: z.boolean(),
  // Sale-watch star (set on the HIT List tab): watched items carry a
  // ★ marker when they show up on sale here.
  watched: z.boolean(),
  // Price history from this app's own observation log; null until
  // the item has been seen priced on 2+ refreshes.
  priceTrend: priceTrendShape.nullable(),
  // Where this row's price was found (recorded by the grocery scan
  // jobs via setItemSource): the exact Flipp or store product-page
  // URL the price was verified on. Null when no source has been
  // recorded for the item — the UI then says so plainly and never
  // guesses a link.
  source: sourceShape.nullable(),
});

const getListResponse = z.object({
  updatedStamp: z.string().nullable(),
  refreshedAt: z.string().nullable(),
  items: z.array(itemShape),
});

function itemKey(section: string, item: string): string {
  return `${section}::${item}`;
}

// Shopping List section titles are normalized to the canonical
// current titles on save: the sheet's headers have been renamed over
// time ("0 Stock" → "Out of Stock"; "Costco Alt." → "FFS (Frequent
// Flyer Alternatives)" → "Membership Alternatives"), and cached rows
// must not keep carrying retired spellings. A title that matches no
// known spelling is kept as-is (trimmed), so an unfamiliar section
// still groups under its own name.
const CANONICAL_SECTION_TITLES: Record<string, string> = {
  "0 stock": "Out of Stock",
  "out of stock": "Out of Stock",
  "low stock on sale now": "Low Stock on Sale Now",
  "costco alt.": "Membership Alternatives",
  ffs: "Membership Alternatives",
  "ffs (frequent flyer alternatives)": "Membership Alternatives",
  "membership alternatives": "Membership Alternatives",
};

function canonicalSectionTitle(section: string): string {
  return (
    CANONICAL_SECTION_TITLES[section.trim().toLowerCase()] ??
    section.trim()
  );
}

/** The item-name half of a checked_items key ("section::item"). */
function itemNameOfKey(key: string): string {
  const sep = key.indexOf("::");
  return sep >= 0 ? key.slice(sep + 2) : key;
}

/** Parse "$10.00 (save $5.59, …)" into price cents + savings note. */
function parsePrice(raw: string | null | undefined): {
  priceCents: number | null;
  savingsNote: string | null;
} {
  if (!raw) return { priceCents: null, savingsNote: null };
  const m = raw.match(/\$\s*([\d,]+(?:\.\d{1,2})?)/);
  if (!m || !m[1]) return { priceCents: null, savingsNote: null };
  const priceCents = Math.round(parseFloat(m[1].replace(/,/g, "")) * 100);
  const paren = raw.match(/\(([^)]*)\)/);
  return { priceCents, savingsNote: paren?.[1] ?? null };
}

/** "2026-11-05" -> "Nov 5" for compact trend labels. */
function shortDateLabel(dateKey: string): string {
  const months = [
    "Jan", "Feb", "Mar", "Apr", "May", "Jun",
    "Jul", "Aug", "Sep", "Oct", "Nov", "Dec",
  ];
  const parts = dateKey.split("-").map(Number);
  const month = months[(parts[1] ?? 1) - 1] ?? "";
  return `${month} ${parts[2] ?? ""}`;
}

/** Today's date key in the household's timezone. */
function todayKeyToronto(): string {
  return new Date().toLocaleDateString("en-CA", {
    timeZone: "America/Toronto",
  });
}

/**
 * Decode a base64 payload (a client file upload, e.g. a receipt
 * photo) into bytes for ctx.blobs. Chunked so a multi-megabyte
 * phone photo never hits the argument limit of a single
 * String.fromCharCode call.
 */
function base64ToBytes(dataBase64: string): Uint8Array {
  const binary = atob(dataBase64);
  const bytes = new Uint8Array(binary.length);
  const CHUNK = 0x8000;
  for (let i = 0; i < binary.length; i += CHUNK) {
    const slice = binary.slice(i, i + CHUNK);
    for (let j = 0; j < slice.length; j++) {
      bytes[i + j] = slice.charCodeAt(j);
    }
  }
  return bytes;
}


// ---- Stock adjustments / watch / forecast helpers -------------------
//
// Effective stock = the stock the sheet (or an app add) last reported
// plus the deltas of adjustments the auto-scan hasn't applied to the
// sheet yet. Every surface that shows a stock count uses the
// effective number, with the pending delta exposed alongside.

type StockMaps = {
  /** Effective stock by lowercased item name. */
  effective: Map<string, number>;
  /** Unapplied adjustment total by lowercased item name. */
  pendingDelta: Map<string, number>;
};

async function loadStockMaps(ctx: Ctx): Promise<StockMaps> {
  const db = ctx.db<typeof schema>();
  const [hitRows, addedRows, adjRows] = await Promise.all([
    db.select().from(schema.hitItems),
    db.select().from(schema.hitAddedItems),
    db.select().from(schema.stockAdjustments),
  ]);
  const base = new Map<string, number>();
  for (const r of hitRows) base.set(r.item.trim().toLowerCase(), r.stock);
  for (const r of addedRows) {
    const key = r.item.trim().toLowerCase();
    if (!base.has(key)) base.set(key, r.stock);
  }
  const pendingDelta = new Map<string, number>();
  for (const a of adjRows) {
    if (a.appliedAt != null) continue;
    // An undone adjustment (audit #5 undo coverage) no longer
    // counts: undoing a still-pending adjustment reverses it
    // exactly by excluding it here and from the pending list the
    // auto-scan applies.
    if (a.undone === 1) continue;
    const key = a.item.trim().toLowerCase();
    pendingDelta.set(key, (pendingDelta.get(key) ?? 0) + a.delta);
  }
  const effective = new Map<string, number>();
  for (const [key, stock] of base) {
    effective.set(key, Math.max(0, stock + (pendingDelta.get(key) ?? 0)));
  }
  for (const [key, delta] of pendingDelta) {
    if (!effective.has(key)) effective.set(key, Math.max(0, delta));
  }
  return { effective, pendingDelta };
}

/**
 * HIT-restock → Shopping List settle (Alpha 0.91): when a HIT List
 * stock INCREASE has already been recorded by the caller (the
 * + stepper's quick-adjust or a stocktake correction), and the
 * item is currently on the Shopping List, the shopping entry is
 * settled as Purchased with the increase as the purchased
 * quantity. The caller has ALREADY applied the stock change, so
 * this helper records NO stock adjustment of its own — it only
 * writes the purchase-log entry (linked to the caller's own
 * adjustment, so the Activity log's Undo reverses exactly that
 * restock) and stamps the item's shopping rows Purchased ✓
 * (creating the checked row for a list row that has none yet, so
 * an item the user never struck off still settles). If the item
 * is not on the Shopping List, nothing happens. If the item was
 * already settled by an earlier restock, the increase is added to
 * that restock's purchase-log quantity instead of writing a
 * second entry; an item settled through the Shopping List's own
 * Purchased confirmation is left exactly as it is.
 */
async function settleShoppingPurchaseFromRestock(
  ctx: Ctx,
  canonicalName: string,
  quantity: number,
  adjustmentId: number | null,
): Promise<void> {
  if (quantity <= 0) return;
  const db = ctx.db<typeof schema>();
  const nameKey = canonicalName.trim().toLowerCase();
  const [listRows, checkedRows] = await Promise.all([
    db.select().from(schema.listItems),
    db.select().from(schema.checkedItems),
  ]);
  const onList = listRows.filter(
    (r) => r.item.trim().toLowerCase() === nameKey,
  );
  if (onList.length === 0) return;
  const itemRows = checkedRows.filter(
    (r) => itemNameOfKey(r.itemKey).trim().toLowerCase() === nameKey,
  );
  const already = itemRows.some((r) => r.restockedAt != null);
  const statements: BatchItem<"sqlite">[] = [];
  if (!already) {
    // Attribution (audit #5): the settle is part of the restock
    // action, so its purchase entry carries the acting role.
    const { role } = await loadAccountSettings(ctx);
    statements.push(
      db.insert(schema.purchaseLog).values({
        item: canonicalName,
        quantity,
        adjustmentId,
        actor: role,
      }),
    );
    // Stamp every existing checked row for the item, and create a
    // settled row for each list row that has none yet.
    const existingKeys = new Set(itemRows.map((r) => r.itemKey));
    for (const row of itemRows) {
      statements.push(
        db
          .update(schema.checkedItems)
          .set({ checked: 1, restockedAt: new Date() })
          .where(eq(schema.checkedItems.itemKey, row.itemKey)),
      );
    }
    for (const row of onList) {
      const key = itemKey(row.section, row.item);
      if (existingKeys.has(key)) continue;
      statements.push(
        db.insert(schema.checkedItems).values({
          itemKey: key,
          checked: 1,
          restockedAt: new Date(),
        }),
      );
    }
  } else if (adjustmentId != null) {
    // Already settled: fold this increase into the purchase entry
    // of the restock that settled it when that entry is the
    // item's latest open one and links back to a HIT-side
    // adjustment (quick-adjust / stocktake) — never into a
    // Shopping List Purchased confirmation's own entry.
    const [logRows, adjRows] = await Promise.all([
      db.select().from(schema.purchaseLog),
      db.select().from(schema.stockAdjustments),
    ]);
    const adjSource = new Map(adjRows.map((a) => [a.id, a.source]));
    const candidates = logRows
      .filter(
        (r) =>
          r.item.trim().toLowerCase() === nameKey &&
          r.undone === 0 &&
          r.adjustmentId != null &&
          (adjSource.get(r.adjustmentId) === "quick-adjust" ||
            adjSource.get(r.adjustmentId) === "stocktake"),
      )
      .sort((a, b) => b.id - a.id);
    const latest = candidates[0];
    if (latest) {
      statements.push(
        db
          .update(schema.purchaseLog)
          .set({ quantity: latest.quantity + quantity })
          .where(eq(schema.purchaseLog.id, latest.id)),
      );
    }
  }
  const [first, ...rest] = statements;
  if (first) await db.batch([first, ...rest]);
}

/**
 * Run-out forecasts from the daily stock snapshots: for each item,
 * total the declines between consecutive snapshots and divide by the
 * days spanned to get a daily usage rate; days left = current
 * effective stock / rate. Only items with at least two snapshots, a
 * real decline, and stock on hand get a forecast — everything else
 * stays null (no forecast is ever invented).
 */
function computeForecasts(
  snapshots: { date: string; item: string; stock: number }[],
  effective: Map<string, number>,
): Map<string, number> {
  const byItem = new Map<string, { date: string; stock: number }[]>();
  for (const s of snapshots) {
    const key = s.item.trim().toLowerCase();
    const list = byItem.get(key) ?? [];
    list.push({ date: s.date, stock: s.stock });
    byItem.set(key, list);
  }
  const forecasts = new Map<string, number>();
  for (const [key, list] of byItem) {
    if (list.length < 2) continue;
    list.sort((a, b) => a.date.localeCompare(b.date));
    const first = list[0];
    const last = list[list.length - 1];
    if (!first || !last || first.date === last.date) continue;
    let decline = 0;
    for (let i = 1; i < list.length; i++) {
      const prev = list[i - 1];
      const cur = list[i];
      if (prev && cur && cur.stock < prev.stock) {
        decline += prev.stock - cur.stock;
      }
    }
    if (decline <= 0) continue;
    const days =
      (new Date(`${last.date}T00:00:00`).getTime() -
        new Date(`${first.date}T00:00:00`).getTime()) /
      86_400_000;
    if (days <= 0) continue;
    const rate = decline / days;
    const stock = effective.get(key) ?? 0;
    if (stock <= 0 || rate <= 0) continue;
    forecasts.set(key, Math.max(1, Math.round(stock / rate)));
  }
  return forecasts;
}

/**
 * Name-match a resolved barcode product against the existing HIT
 * List: the "existing item" path for scan-to-add. A match is
 * confident when the formal product name IS an app-added item's
 * recorded formal name (exact, normalized), or when every word of
 * an existing item's name (or an added item's formal name) appears
 * in the resolved product name — "Kirkland Signature Sea Salt, Fine
 * Grain, 850 g" contains every word of "Sea Salt". Returns the
 * inventory item to offer the stock-bump for, or null.
 */
function matchExistingByName(
  formalName: string,
  hitItems: { item: string }[],
  addedItems: { item: string; formalName: string | null }[],
): { item: string; formalName: string | null } | null {
  const norm = (s: string) =>
    s.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
  const target = norm(formalName);
  if (!target) return null;
  for (const a of addedItems) {
    if (a.formalName && norm(a.formalName) === target) {
      return { item: a.item, formalName: a.formalName };
    }
  }
  const targetWords = new Set(target.split(" ").filter(Boolean));
  const containsAllWords = (name: string): boolean => {
    const words = norm(name).split(" ").filter(Boolean);
    return words.length > 0 && words.every((w) => targetWords.has(w));
  };
  for (const a of addedItems) {
    if (containsAllWords(a.item)) {
      return { item: a.item, formalName: a.formalName };
    }
    if (a.formalName && containsAllWords(a.formalName)) {
      return { item: a.item, formalName: a.formalName };
    }
  }
  for (const h of hitItems) {
    if (containsAllWords(h.item)) {
      return { item: h.item, formalName: null };
    }
  }
  return null;
}

// ---- Primary vs Connected accounts (Beta 0.01 batch, audit #5,
// second half) ------------------------------------------------------
// This copy of the app acts as one of two roles: the Primary user
// or a Connected account (account_settings, a single row; the
// role defaults to Primary). Every undoable action type has a
// policy — Permanent or Reversible — stored as a JSON map; a type
// with no stored entry is Reversible, so everything starts
// Reversible. Only the Primary user may edit the policy
// (setUndoPolicy refuses otherwise). Enforcement (undoGate): a
// Permanent type's actions offer no Undo at all; a Reversible
// action can be undone by the Primary user whoever performed it,
// while a Connected account can undo only actions a Connected
// account performed. Records carry the performing role in their
// `actor` column; a null actor (records from before attribution)
// reads as the Primary user's.
type ActorRole = "primary" | "connected";
type UndoMode = "permanent" | "reversible";

const UNDO_POLICY_TYPES = [
  "purchases",
  "stockAdjustments",
  "eaten",
  "receiptScans",
  "bitCountChanges",
  "wasteLog",
  "manifestImports",
  "requisitionCheckOffs",
  "alertDismissals",
  "posSyncs",
] as const;
type UndoPolicyType = (typeof UNDO_POLICY_TYPES)[number];

const undoPolicyShape = z.object({
  purchases: z.enum(["permanent", "reversible"]),
  stockAdjustments: z.enum(["permanent", "reversible"]),
  eaten: z.enum(["permanent", "reversible"]),
  receiptScans: z.enum(["permanent", "reversible"]),
  bitCountChanges: z.enum(["permanent", "reversible"]),
  wasteLog: z.enum(["permanent", "reversible"]),
  manifestImports: z.enum(["permanent", "reversible"]),
  requisitionCheckOffs: z.enum(["permanent", "reversible"]),
  alertDismissals: z.enum(["permanent", "reversible"]),
  posSyncs: z.enum(["permanent", "reversible"]),
});
type UndoPolicy = z.infer<typeof undoPolicyShape>;

function defaultUndoPolicy(): UndoPolicy {
  return {
    purchases: "reversible",
    stockAdjustments: "reversible",
    eaten: "reversible",
    receiptScans: "reversible",
    bitCountChanges: "reversible",
    wasteLog: "reversible",
    manifestImports: "reversible",
    requisitionCheckOffs: "reversible",
    alertDismissals: "reversible",
    posSyncs: "reversible",
  };
}

function parseUndoPolicy(json: string): UndoPolicy {
  const policy = defaultUndoPolicy();
  try {
    const parsed: unknown = JSON.parse(json || "{}");
    if (parsed != null && typeof parsed === "object") {
      const rec = parsed as Record<string, unknown>;
      for (const t of UNDO_POLICY_TYPES) {
        const v = rec[t];
        if (v === "permanent" || v === "reversible") {
          policy[t] = v;
        }
      }
    }
  } catch {
    // A malformed stored policy reads as all-Reversible.
  }
  return policy;
}

async function loadAccountSettings(
  ctx: Ctx,
): Promise<{ role: ActorRole; policy: UndoPolicy }> {
  const db = ctx.db<typeof schema>();
  const rows = await db.select().from(schema.accountSettings);
  const row = rows[0];
  if (!row) return { role: "primary", policy: defaultUndoPolicy() };
  return {
    role: row.actingRole === "connected" ? "connected" : "primary",
    policy: parseUndoPolicy(row.policyJson),
  };
}

/** The role a record was performed by; null (pre-attribution)
    reads as the Primary user's. */
function actorOf(actor: ActorRole | null | undefined): ActorRole {
  return actor === "connected" ? "connected" : "primary";
}

/**
 * The one enforcement point for every Undo (audit #5): returns
 * null when the undo may proceed, or the refusal message when it
 * may not — the type is set Permanent, or a Connected account is
 * trying to undo the Primary user's action.
 */
function undoGate(
  settings: { role: ActorRole; policy: UndoPolicy },
  type: UndoPolicyType,
  actor: ActorRole | null | undefined,
): string | null {
  if (settings.policy[type] === "permanent") {
    return "This kind of action is set to Permanent by the Primary user, so it can't be undone.";
  }
  if (settings.role === "connected" && actorOf(actor) === "primary") {
    return "A Connected account can only undo its own actions — only the Primary user can undo this one.";
  }
  return null;
}

/** The display trio every undoable record's read carries: who
    performed it, whether its type is Permanent, and whether the
    current role may undo it right now (not undone, not
    Permanent, ownership satisfied). */
function undoMeta(
  settings: { role: ActorRole; policy: UndoPolicy },
  type: UndoPolicyType,
  actor: ActorRole | null | undefined,
  undone: boolean,
): { actor: ActorRole; permanent: boolean; canUndo: boolean } {
  return {
    actor: actorOf(actor),
    permanent: settings.policy[type] === "permanent",
    canUndo: !undone && undoGate(settings, type, actor) == null,
  };
}

const undoMetaShape = z.object({
  actor: z.enum(["primary", "connected"]),
  permanent: z.boolean(),
  canUndo: z.boolean(),
});

/**
 * The undo performers (Beta 0.15): each undoable action type's
 * reversal, factored out of its per-record action so BOTH the
 * per-record action (kept for the user's agent) and the single
 * Settings Undo (undoLastAction, which reverts the app's LAST
 * action) run exactly the same reversal — gate check included.
 * The app itself shows no per-record Undo buttons anymore; the
 * one Undo lives in the Settings drawer, under Switch to.
 */
async function performUndoUsage(
  ctx: Ctx,
  id: number,
): Promise<{ ok: boolean; error: string | null }> {
  const db = ctx.db<typeof schema>();
  const rows = await db
    .select()
    .from(schema.usageLog)
    .where(eq(schema.usageLog.id, id));
  const row = rows[0];
  if (!row) return { ok: false, error: "That usage entry no longer exists." };
  if (row.undone === 1) return { ok: false, error: "That entry is already undone." };
  const gate = undoGate(await loadAccountSettings(ctx), "eaten", row.actor);
  if (gate) return { ok: false, error: gate };
  await db
    .update(schema.usageLog)
    .set({ undone: 1, undoneAt: new Date() })
    .where(eq(schema.usageLog.id, id));
  if (row.deducted > 0) {
    await db.insert(schema.stockAdjustments).values({
      item: row.item,
      delta: row.deducted,
      source: "usage-undo",
    });
  }
  ctx.invalidateQueries();
  return { ok: true, error: null };
}

async function performUndoPickEaten(
  ctx: Ctx,
  pickId: number,
): Promise<{ ok: boolean; undoneCount: number; error: string | null }> {
  const db = ctx.db<typeof schema>();
  const rows = await db
    .select()
    .from(schema.usageLog)
    .where(eq(schema.usageLog.pickId, pickId));
  const active = rows.filter((r) => r.undone === 0);
  if (active.length === 0) {
    return {
      ok: false,
      undoneCount: 0,
      error: "That pick has no logged usage to undo.",
    };
  }
  // Policy + ownership (audit #5): the tap is undone as a
  // whole, so every entry it logged must be undoable by the
  // current role — a Permanent Eaten type blocks it, and a
  // Connected account can't undo a tap the Primary user made.
  const settings = await loadAccountSettings(ctx);
  for (const row of active) {
    const gate = undoGate(settings, "eaten", row.actor);
    if (gate) return { ok: false, undoneCount: 0, error: gate };
  }
  const statements: BatchItem<"sqlite">[] = [];
  for (const row of active) {
    statements.push(
      db
        .update(schema.usageLog)
        .set({ undone: 1, undoneAt: new Date() })
        .where(eq(schema.usageLog.id, row.id)),
    );
    if (row.deducted > 0) {
      statements.push(
        db.insert(schema.stockAdjustments).values({
          item: row.item,
          delta: row.deducted,
          source: "usage-undo",
        }),
      );
    }
  }
  const [first, ...rest] = statements;
  if (first) await db.batch([first, ...rest]);
  ctx.invalidateQueries();
  return { ok: true, undoneCount: active.length, error: null };
}

async function performUndoStockAdjustment(
  ctx: Ctx,
  id: number,
): Promise<{ ok: boolean; error: string | null }> {
  const db = ctx.db<typeof schema>();
  const rows = await db
    .select()
    .from(schema.stockAdjustments)
    .where(eq(schema.stockAdjustments.id, id));
  const row = rows[0];
  if (!row) {
    return { ok: false, error: "That adjustment no longer exists." };
  }
  if (row.source !== "quick-adjust" && row.source !== "stocktake") {
    return { ok: false, error: "That entry can't be undone here." };
  }
  if (row.undone === 1) {
    return { ok: false, error: "That adjustment is already undone." };
  }
  const adjGate = undoGate(
    await loadAccountSettings(ctx),
    "stockAdjustments",
    row.actor,
  );
  if (adjGate) return { ok: false, error: adjGate };
  // A restock that settled a Shopping List purchase is undone
  // from the purchase entry, which also clears the Purchased
  // stamps — undoing the adjustment alone would strand them.
  const purchaseRows = await db
    .select()
    .from(schema.purchaseLog)
    .where(eq(schema.purchaseLog.adjustmentId, id));
  if (purchaseRows.some((r) => r.undone === 0)) {
    return {
      ok: false,
      error:
        "That change settled a purchase — undo it from the purchase entry instead.",
    };
  }
  const statements: BatchItem<"sqlite">[] = [
    db
      .update(schema.stockAdjustments)
      .set({ undone: 1, undoneAt: new Date() })
      .where(eq(schema.stockAdjustments.id, id)),
  ];
  if (row.appliedAt != null) {
    statements.push(
      db.insert(schema.stockAdjustments).values({
        item: row.item,
        delta: -row.delta,
        source: "adjustment-undo",
      }),
    );
  }
  const [first, ...rest] = statements;
  if (first) await db.batch([first, ...rest]);
  ctx.invalidateQueries();
  return { ok: true, error: null };
}

async function performUndoPurchase(
  ctx: Ctx,
  id: number,
): Promise<{ ok: boolean; error: string | null }> {
  const db = ctx.db<typeof schema>();
  const rows = await db
    .select()
    .from(schema.purchaseLog)
    .where(eq(schema.purchaseLog.id, id));
  const row = rows[0];
  if (!row) {
    return { ok: false, error: "That purchase entry no longer exists." };
  }
  if (row.undone === 1) {
    return { ok: false, error: "That purchase is already undone." };
  }
  const purchaseGate = undoGate(
    await loadAccountSettings(ctx),
    "purchases",
    row.actor,
  );
  if (purchaseGate) return { ok: false, error: purchaseGate };
  const statements: BatchItem<"sqlite">[] = [
    db
      .update(schema.purchaseLog)
      .set({ undone: 1, undoneAt: new Date() })
      .where(eq(schema.purchaseLog.id, id)),
  ];
  // Reverse the stock effect.
  let reversed = false;
  if (row.adjustmentId != null) {
    const adjRows = await db
      .select()
      .from(schema.stockAdjustments)
      .where(eq(schema.stockAdjustments.id, row.adjustmentId));
    const adj = adjRows[0];
    if (adj && adj.undone === 1) {
      // The adjustment's own Undo already reversed its stock
      // effect — never reverse the same change twice.
      reversed = true;
    } else if (adj && adj.appliedAt == null) {
      // Still pending: deleting the row reverses it exactly.
      statements.push(
        db
          .delete(schema.stockAdjustments)
          .where(eq(schema.stockAdjustments.id, adj.id)),
      );
      reversed = true;
    }
  }
  if (!reversed) {
    // Already applied to the sheet (or the link is missing):
    // record the compensating negative adjustment.
    statements.push(
      db.insert(schema.stockAdjustments).values({
        item: row.item,
        delta: -row.quantity,
        source: "purchase-undo",
      }),
    );
  }
  // Clear the Purchased stamp on the item's checked rows (all
  // sections) so the purchase can be confirmed again.
  const itemKey = row.item.trim().toLowerCase();
  const checkedRows = await db.select().from(schema.checkedItems);
  for (const cr of checkedRows) {
    if (
      cr.restockedAt != null &&
      itemNameOfKey(cr.itemKey).trim().toLowerCase() === itemKey
    ) {
      statements.push(
        db
          .update(schema.checkedItems)
          .set({ restockedAt: null })
          .where(eq(schema.checkedItems.itemKey, cr.itemKey)),
      );
    }
  }
  const [first, ...rest] = statements;
  if (first) await db.batch([first, ...rest]);
  ctx.invalidateQueries();
  return { ok: true, error: null };
}

async function performUndoReceiptScan(
  ctx: Ctx,
  id: number,
): Promise<{ ok: boolean; error: string | null }> {
  const db = ctx.db<typeof schema>();
  const rows = await db
    .select()
    .from(schema.receiptScans)
    .where(eq(schema.receiptScans.id, id));
  const row = rows[0];
  if (!row) {
    return { ok: false, error: "That receipt scan no longer exists." };
  }
  if (row.status !== "confirmed") {
    return { ok: false, error: "That scan wasn't confirmed." };
  }
  if (row.undoneAt != null) {
    return { ok: false, error: "That scan is already undone." };
  }
  const scanGate = undoGate(
    await loadAccountSettings(ctx),
    "receiptScans",
    row.actor,
  );
  if (scanGate) return { ok: false, error: scanGate };
  const statements: BatchItem<"sqlite">[] = [];
  const linked = await db
    .select()
    .from(schema.stockAdjustments)
    .where(eq(schema.stockAdjustments.receiptScanId, id));
  const activeLinked = linked.filter((a) => a.undone === 0);
  if (activeLinked.length > 0) {
    for (const adj of activeLinked) {
      statements.push(
        db
          .update(schema.stockAdjustments)
          .set({ undone: 1, undoneAt: new Date() })
          .where(eq(schema.stockAdjustments.id, adj.id)),
      );
      if (adj.appliedAt != null) {
        statements.push(
          db.insert(schema.stockAdjustments).values({
            item: adj.item,
            delta: -adj.delta,
            source: "receipt-undo",
          }),
        );
      }
    }
  } else {
    // Legacy scan (confirmed before adjustments carried the
    // scan link): reverse from the confirmed lines stored on
    // the scan. Per line, retire a matching still-pending
    // unlinked receipt adjustment when one is there;
    // otherwise record the compensating adjustment (which is
    // also the right correction when the original was already
    // applied to the sheet).
    let lines: { item: string | null; quantity: number }[] = [];
    if (row.linesJson) {
      try {
        const parsed: unknown = JSON.parse(row.linesJson);
        if (Array.isArray(parsed)) {
          lines = parsed as typeof lines;
        }
      } catch {
        lines = [];
      }
    }
    const pool = (
      await db
        .select()
        .from(schema.stockAdjustments)
        .where(eq(schema.stockAdjustments.source, "receipt"))
    ).filter(
      (a) =>
        a.receiptScanId == null && a.undone === 0 && a.appliedAt == null,
    );
    for (const line of lines) {
      if (line.item == null || line.quantity <= 0) continue;
      const key = line.item.trim().toLowerCase();
      const idx = pool.findIndex(
        (a) =>
          a.item.trim().toLowerCase() === key &&
          a.delta === line.quantity,
      );
      const match = idx >= 0 ? pool[idx] : undefined;
      if (match) {
        pool.splice(idx, 1);
        statements.push(
          db
            .update(schema.stockAdjustments)
            .set({ undone: 1, undoneAt: new Date() })
            .where(eq(schema.stockAdjustments.id, match.id)),
        );
      } else {
        statements.push(
          db.insert(schema.stockAdjustments).values({
            item: line.item,
            delta: -line.quantity,
            source: "receipt-undo",
          }),
        );
      }
    }
  }
  statements.push(
    db
      .update(schema.receiptScans)
      .set({ undoneAt: new Date(), updatedAt: new Date() })
      .where(eq(schema.receiptScans.id, id)),
  );
  const [first, ...rest] = statements;
  if (first) await db.batch([first, ...rest]);
  ctx.invalidateQueries();
  return { ok: true, error: null };
}

async function performRestoreAlert(
  ctx: Ctx,
  id: number,
): Promise<{ ok: boolean; error: string | null }> {
  const db = ctx.db<typeof schema>();
  const rows = await db
    .select()
    .from(schema.alerts)
    .where(eq(schema.alerts.id, id));
  const row = rows[0];
  if (!row) return { ok: false, error: "That alert no longer exists." };
  if (row.dismissedAt != null) {
    const settings = await loadAccountSettings(ctx);
    const refusal = undoGate(settings, "alertDismissals", row.dismissedBy);
    if (refusal) return { ok: false, error: refusal };
  }
  const res = await db
    .update(schema.alerts)
    .set({ dismissedAt: null, dismissedBy: null })
    .where(eq(schema.alerts.id, id))
    .returning({ id: schema.alerts.id });
  ctx.invalidateQueries();
  return { ok: res.length > 0, error: null };
}

async function performUndoBitStockEvent(
  ctx: Ctx,
  id: number,
): Promise<{ ok: boolean; error: string | null }> {
  const db = ctx.db<typeof schema>();
  const rows = await db
    .select()
    .from(schema.bitStockEvents)
    .where(eq(schema.bitStockEvents.id, id));
  const row = rows[0];
  if (!row) {
    return { ok: false, error: "That count change no longer exists." };
  }
  if (row.source !== "manual_count") {
    return {
      ok: false,
      error:
        "That change came from a requisition receipt — undo it from the requisition line instead.",
    };
  }
  if (row.undone === 1) {
    return { ok: false, error: "That count change is already undone." };
  }
  const eventGate = undoGate(
    await loadAccountSettings(ctx),
    "bitCountChanges",
    row.actor,
  );
  if (eventGate) return { ok: false, error: eventGate };
  if (row.itemId == null) {
    return { ok: false, error: "That item is no longer tracked." };
  }
  const itemRows = await db
    .select()
    .from(schema.bitItems)
    .where(eq(schema.bitItems.id, row.itemId));
  const item = itemRows[0];
  if (!item) {
    return { ok: false, error: "That item is no longer tracked." };
  }
  const statements: BatchItem<"sqlite">[] = [
    db
      .update(schema.bitStockEvents)
      .set({ undone: 1 })
      .where(eq(schema.bitStockEvents.id, row.id)),
    db
      .update(schema.bitItems)
      .set({ onHand: Math.max(0, item.onHand - row.delta) })
      .where(eq(schema.bitItems.id, item.id)),
  ];
  const [first, ...rest] = statements;
  if (first) await db.batch([first, ...rest]);
  ctx.invalidateQueries();
  return { ok: true, error: null };
}

async function performUndoBitWaste(
  ctx: Ctx,
  id: number,
): Promise<{
  ok: boolean;
  error: string | null;
  onHand: number | null;
}> {
  const db = ctx.db<typeof schema>();
  const rows = await db
    .select()
    .from(schema.bitWasteLog)
    .where(eq(schema.bitWasteLog.id, id));
  const row = rows[0];
  if (!row) {
    return {
      ok: false,
      error: "That waste entry no longer exists.",
      onHand: null,
    };
  }
  if (row.undone === 1) {
    return {
      ok: false,
      error: "That waste entry is already undone.",
      onHand: null,
    };
  }
  const wasteGate = undoGate(
    await loadAccountSettings(ctx),
    "wasteLog",
    row.actor,
  );
  if (wasteGate) {
    return { ok: false, error: wasteGate, onHand: null };
  }
  const statements: BatchItem<"sqlite">[] = [
    db
      .update(schema.bitWasteLog)
      .set({ undone: 1 })
      .where(eq(schema.bitWasteLog.id, row.id)),
  ];
  let onHand: number | null = null;
  if (row.itemId != null) {
    const itemRows = await db
      .select()
      .from(schema.bitItems)
      .where(eq(schema.bitItems.id, row.itemId));
    const item = itemRows[0];
    if (item) {
      onHand = item.onHand + (row.stockDeducted ?? row.quantity);
      statements.push(
        db
          .update(schema.bitItems)
          .set({ onHand })
          .where(eq(schema.bitItems.id, item.id)),
      );
    }
  }
  const [first, ...rest] = statements;
  if (first) await db.batch([first, ...rest]);
  ctx.invalidateQueries();
  return { ok: true, error: null, onHand };
}

async function performUndoBitManifestImport(
  ctx: Ctx,
  id: number,
): Promise<{ ok: boolean; error: string | null }> {
  const db = ctx.db<typeof schema>();
  const rows = await db
    .select()
    .from(schema.bitManifestImports)
    .where(eq(schema.bitManifestImports.id, id));
  const row = rows[0];
  if (!row) {
    return { ok: false, error: "That import no longer exists." };
  }
  if (row.undone === 1) {
    return { ok: false, error: "That import is already undone." };
  }
  const importGate = undoGate(
    await loadAccountSettings(ctx),
    "manifestImports",
    row.actor,
  );
  if (importGate) return { ok: false, error: importGate };
  const changes = bitParseManifestImportChanges(row.changesJson);
  const itemRows = await db
    .select()
    .from(schema.bitItems)
    .where(eq(schema.bitItems.businessId, row.businessId));
  const byId = new Map(itemRows.map((r) => [r.id, r]));
  const byName = new Map(
    itemRows.map((r) => [r.name.trim().toLowerCase(), r]),
  );
  const statements: BatchItem<"sqlite">[] = [
    db
      .update(schema.bitManifestImports)
      .set({ undone: 1 })
      .where(eq(schema.bitManifestImports.id, row.id)),
  ];
  for (const change of changes) {
    const item =
      (change.itemId != null ? byId.get(change.itemId) : undefined) ??
      byName.get(change.name.trim().toLowerCase());
    if (!item) continue;
    if (change.added) {
      statements.push(
        db
          .delete(schema.bitItems)
          .where(eq(schema.bitItems.id, item.id)),
      );
    } else if (change.priorOnHand != null) {
      statements.push(
        db
          .update(schema.bitItems)
          .set({ onHand: change.priorOnHand })
          .where(eq(schema.bitItems.id, item.id)),
      );
    }
  }
  if (row.scanId != null) {
    statements.push(
      db
        .update(schema.bitManifestScans)
        .set({ status: "proposed", updatedAt: new Date() })
        .where(
          and(
            eq(schema.bitManifestScans.id, row.scanId),
            eq(schema.bitManifestScans.status, "confirmed"),
          ),
        ),
    );
  }
  const [first, ...rest] = statements;
  if (first) await db.batch([first, ...rest]);
  ctx.invalidateQueries();
  return { ok: true, error: null };
}

async function performUndoBitPosTransaction(
  ctx: Ctx,
  id: number,
): Promise<{ ok: boolean; error: string | null }> {
  const db = ctx.db<typeof schema>();
  const rows = await db
    .select()
    .from(schema.bitPosTransactions)
    .where(eq(schema.bitPosTransactions.id, id));
  const row = rows[0];
  if (!row) return { ok: false, error: "That entry no longer exists." };
  if (row.matched !== 1 || row.undone === 1 || row.itemId == null) {
    return { ok: false, error: "That entry can't be undone." };
  }
  const posGate = undoGate(
    await loadAccountSettings(ctx),
    "posSyncs",
    row.actor,
  );
  if (posGate) return { ok: false, error: posGate };
  const itemRows = await db
    .select()
    .from(schema.bitItems)
    .where(eq(schema.bitItems.id, row.itemId));
  const item = itemRows[0];
  const statements: BatchItem<"sqlite">[] = [
    db
      .update(schema.bitPosTransactions)
      .set({ undone: 1 })
      .where(eq(schema.bitPosTransactions.id, row.id)),
  ];
  if (item) {
    statements.push(
      db
        .update(schema.bitItems)
        .set({ onHand: Math.min(100000, item.onHand + row.quantity) })
        .where(eq(schema.bitItems.id, item.id)),
    );
  }
  const [first, ...rest] = statements;
  if (first) await db.batch([first, ...rest]);
  ctx.invalidateQueries();
  return { ok: true, error: null };
}

async function performUndoBitRequisitionCheckOff(
  ctx: Ctx,
  lineId: number,
): Promise<{ ok: boolean; reopened: boolean; error: string | null }> {
  const db = ctx.db<typeof schema>();
  const lineRows = await db
    .select()
    .from(schema.bitRequisitionLines)
    .where(eq(schema.bitRequisitionLines.id, lineId));
  const line = lineRows[0];
  if (!line) {
    return { ok: false, reopened: false, error: "That line is gone." };
  }
  if (line.status === "pending") {
    return {
      ok: false,
      reopened: false,
      error: "That line hasn't been checked off.",
    };
  }
  if (line.supersededBy != null) {
    return {
      ok: false,
      reopened: false,
      error:
        "That line was already resubmitted on a newer requisition, so its check-off can't be undone.",
    };
  }
  const lineGate = undoGate(
    await loadAccountSettings(ctx),
    "requisitionCheckOffs",
    line.checkedOffBy,
  );
  if (lineGate) {
    return { ok: false, reopened: false, error: lineGate };
  }
  const reqRows = await db
    .select()
    .from(schema.bitRequisitions)
    .where(eq(schema.bitRequisitions.id, line.requisitionId));
  const req = reqRows[0];
  if (!req) {
    return {
      ok: false,
      reopened: false,
      error: "That requisition is gone.",
    };
  }
  let reopened = false;
  if (req.status === "closed") {
    const others = await db
      .select()
      .from(schema.bitRequisitions)
      .where(
        and(
          eq(schema.bitRequisitions.businessId, req.businessId),
          eq(schema.bitRequisitions.status, "outstanding"),
        ),
      );
    if (others.length > 0) {
      return {
        ok: false,
        reopened: false,
        error:
          "Another requisition is outstanding, so this one can't reopen for the undo.",
      };
    }
    reopened = true;
  }
  const statements: BatchItem<"sqlite">[] = [
    db
      .update(schema.bitRequisitionLines)
      .set({
        status: "pending",
        qtyReceived: null,
        checkedOffBy: null,
        checkedOffAt: null,
      })
      .where(eq(schema.bitRequisitionLines.id, line.id)),
  ];
  if (reopened) {
    statements.push(
      db
        .update(schema.bitRequisitions)
        .set({ status: "outstanding", closedAt: null })
        .where(eq(schema.bitRequisitions.id, req.id)),
    );
  }
  // Take back the stock a "received" mark applied, and retire
  // the stock event it logged.
  if (
    line.status === "received" &&
    line.itemId != null &&
    (line.qtyReceived ?? 0) !== 0
  ) {
    const qty = line.qtyReceived ?? 0;
    const itemRows = await db
      .select()
      .from(schema.bitItems)
      .where(eq(schema.bitItems.id, line.itemId));
    const item = itemRows[0];
    if (item) {
      statements.push(
        db
          .update(schema.bitItems)
          .set({ onHand: Math.max(0, item.onHand - qty) })
          .where(eq(schema.bitItems.id, item.id)),
      );
      const eventRows = await db
        .select()
        .from(schema.bitStockEvents)
        .where(
          and(
            eq(schema.bitStockEvents.itemId, item.id),
            eq(schema.bitStockEvents.source, "requisition_received"),
            eq(schema.bitStockEvents.undone, 0),
          ),
        )
        .orderBy(desc(schema.bitStockEvents.id));
      const event = eventRows.find((e) => e.delta === qty);
      if (event) {
        statements.push(
          db
            .update(schema.bitStockEvents)
            .set({ undone: 1 })
            .where(eq(schema.bitStockEvents.id, event.id)),
        );
      }
    }
  }
  const [first, ...rest] = statements;
  if (first) await db.batch([first, ...rest]);
  ctx.invalidateQueries();
  return { ok: true, reopened, error: null };
}

type UndoCandidate = {
  /** Ordering timestamp (ms since epoch) of the action. */
  at: number;
  /** Plain-words name of the action, shown in Settings. */
  label: string;
  /** Runs the reversal through the type's own performer. */
  run: (ctx: Ctx) => Promise<{ ok: boolean; error: string | null }>;
};

/**
 * Finds the app's LAST action that can still be undone (Beta
 * 0.15): the newest not-yet-undone record across every undoable
 * action type, on both the HIT and BIT sides, that the current
 * role may undo under the undo policy (undoGate). Actions whose
 * type is set Permanent, and — for a Connected account — the
 * Primary user's actions, are not candidates: the Settings Undo
 * reverts the last action it is allowed to revert. Returns null
 * when nothing undoable remains.
 */
async function findLastUndoableAction(
  ctx: Ctx,
): Promise<UndoCandidate | null> {
  const db = ctx.db<typeof schema>();
  const settings = await loadAccountSettings(ctx);
  const candidates: UndoCandidate[] = [];
  const add = (
    type: UndoPolicyType,
    actor: ActorRole | null | undefined,
    at: Date,
    label: string,
    run: UndoCandidate["run"],
  ) => {
    if (undoGate(settings, type, actor) != null) return;
    candidates.push({ at: at.getTime(), label, run });
  };
  const latest = <T,>(rows: T[], time: (r: T) => Date): T | null => {
    let best: T | null = null;
    for (const r of rows) {
      if (best == null || time(r).getTime() > time(best).getTime()) {
        best = r;
      }
    }
    return best;
  };

  // Purchases (Shopping List Purchased confirmations).
  const purchase = latest(
    (await db.select().from(schema.purchaseLog)).filter(
      (r) => r.undone === 0,
    ),
    (r) => r.createdAt,
  );
  if (purchase) {
    add("purchases", purchase.actor, purchase.createdAt,
      `Purchase of ${purchase.item}`,
      (c) => performUndoPurchase(c, purchase.id));
  }

  // Stock adjustments (HIT +/− steppers and stocktake
  // corrections). One that settled a still-active purchase is
  // the purchase's candidate above, never its own.
  const settledAdjIds = new Set(
    (await db.select().from(schema.purchaseLog))
      .filter((r) => r.undone === 0 && r.adjustmentId != null)
      .map((r) => r.adjustmentId as number),
  );
  const adjustment = latest(
    (await db.select().from(schema.stockAdjustments)).filter(
      (r) =>
        r.undone === 0 &&
        (r.source === "quick-adjust" || r.source === "stocktake") &&
        !settledAdjIds.has(r.id),
    ),
    (r) => r.createdAt,
  );
  if (adjustment) {
    add("stockAdjustments", adjustment.actor, adjustment.createdAt,
      `Stock change for ${adjustment.item} (${adjustment.delta > 0 ? "+" : ""}${adjustment.delta})`,
      (c) => performUndoStockAdjustment(c, adjustment.id));
  }

  // Eaten / usage: a Meal Planner pick's Eaten tap is ONE action
  // (all its still-active entries together); a usage entry with
  // no pick is its own action.
  const usageRows = (await db.select().from(schema.usageLog)).filter(
    (r) => r.undone === 0,
  );
  const byPick = new Map<number, typeof usageRows>();
  for (const r of usageRows) {
    if (r.pickId == null) {
      add("eaten", r.actor, r.createdAt,
        `Usage of ${r.item}`,
        (c) => performUndoUsage(c, r.id));
    } else {
      const group = byPick.get(r.pickId) ?? [];
      group.push(r);
      byPick.set(r.pickId, group);
    }
  }
  for (const [pickId, group] of byPick) {
    // The tap is undone as a whole, so it is a candidate only
    // when the current role may undo every entry it logged.
    if (group.some((r) => undoGate(settings, "eaten", r.actor) != null)) {
      continue;
    }
    const at = group.reduce(
      (max, r) => (r.createdAt.getTime() > max.getTime() ? r.createdAt : max),
      group[0]?.createdAt ?? new Date(0),
    );
    const mealName = group.find((r) => r.mealName)?.mealName ?? null;
    candidates.push({
      at: at.getTime(),
      label: mealName
        ? `Marking ${mealName} as eaten`
        : "Marking a meal as eaten",
      run: async (c) => {
        const res = await performUndoPickEaten(c, pickId);
        return { ok: res.ok, error: res.error };
      },
    });
  }

  // Receipt scans (confirmed, not yet undone). A scan's
  // confirmation stamps updatedAt, so that is its action time.
  const scan = latest(
    (await db.select().from(schema.receiptScans)).filter(
      (r) => r.status === "confirmed" && r.undoneAt == null,
    ),
    (r) => r.updatedAt,
  );
  if (scan) {
    add("receiptScans", scan.actor, scan.updatedAt,
      scan.note
        ? `Receipt scan (${scan.note.slice(0, 60)})`
        : "Receipt scan",
      (c) => performUndoReceiptScan(c, scan.id));
  }

  // Alert dismissals (their undo is the restore).
  const alert = latest(
    (await db.select().from(schema.alerts)).filter(
      (r) => r.dismissedAt != null,
    ),
    (r) => r.dismissedAt as Date,
  );
  if (alert?.dismissedAt) {
    add("alertDismissals", alert.dismissedBy, alert.dismissedAt,
      `Dismissed alert “${alert.title.slice(0, 60)}”`,
      (c) => performRestoreAlert(c, alert.id));
  }

  // BIT count changes (Inventory-tab manual counts).
  const countChange = latest(
    (await db.select().from(schema.bitStockEvents)).filter(
      (r) => r.undone === 0 && r.source === "manual_count",
    ),
    (r) => r.createdAt,
  );
  if (countChange) {
    add("bitCountChanges", countChange.actor, countChange.createdAt,
      `Count change for ${countChange.itemName}`,
      (c) => performUndoBitStockEvent(c, countChange.id));
  }

  // BIT waste log entries.
  const waste = latest(
    (await db.select().from(schema.bitWasteLog)).filter(
      (r) => r.undone === 0,
    ),
    (r) => r.createdAt,
  );
  if (waste) {
    add("wasteLog", waste.actor, waste.createdAt,
      `Waste log entry for ${waste.itemName}`,
      async (c) => {
        const res = await performUndoBitWaste(c, waste.id);
        return { ok: res.ok, error: res.error };
      });
  }

  // BIT manifest imports.
  const manifestImport = latest(
    (await db.select().from(schema.bitManifestImports)).filter(
      (r) => r.undone === 0,
    ),
    (r) => r.createdAt,
  );
  if (manifestImport) {
    add("manifestImports", manifestImport.actor, manifestImport.createdAt,
      "Manifest import",
      (c) => performUndoBitManifestImport(c, manifestImport.id));
  }

  // BIT requisition check-offs. A check-off's time is its
  // checked-off stamp; check-offs from before the stamp existed
  // order by their requisition's sent date.
  const reqSentAt = new Map(
    (await db.select().from(schema.bitRequisitions)).map(
      (r) => [r.id, r.sentAt] as const,
    ),
  );
  const checkOff = latest(
    (await db.select().from(schema.bitRequisitionLines)).filter(
      (r) => r.status !== "pending" && r.supersededBy == null,
    ),
    (r) => r.checkedOffAt ?? reqSentAt.get(r.requisitionId) ?? r.createdAt,
  );
  if (checkOff) {
    add("requisitionCheckOffs", checkOff.checkedOffBy,
      checkOff.checkedOffAt ??
        reqSentAt.get(checkOff.requisitionId) ??
        checkOff.createdAt,
      `Delivery check-off for ${checkOff.name}`,
      async (c) => {
        const res = await performUndoBitRequisitionCheckOff(c, checkOff.id);
        return { ok: res.ok, error: res.error };
      });
  }

  // BIT POS transactions (applied sales).
  const posTx = latest(
    (await db.select().from(schema.bitPosTransactions)).filter(
      (r) => r.matched === 1 && r.undone === 0 && r.itemId != null,
    ),
    (r) => r.createdAt,
  );
  if (posTx) {
    add("posSyncs", posTx.actor, posTx.createdAt,
      `POS sale of ${posTx.itemName ?? posTx.posRef}`,
      (c) => performUndoBitPosTransaction(c, posTx.id));
  }

  let best: UndoCandidate | null = null;
  for (const c of candidates) {
    if (best == null || c.at > best.at) best = c;
  }
  return best;
}

// Household setup questionnaire (Alpha 0.90): the saved answer set
// for the HIT setup questionnaire, and the starter-meal table the
// finish seeds from — for each preset "meals you make often" entry,
// the meal type it belongs to and the tracked protein it is built
// around (seeded as the meal's single protein group, pointing at
// the HIT List item of the same name). Custom (Other) meals seed
// as plain dinners with no protein group.
const householdSetupAnswers = z.object({
  householdSize: z.string().max(80).default(""),
  stores: z.array(z.string().min(1).max(80)).max(24).default([]),
  allergies: z.array(z.string().min(1).max(80)).max(24).default([]),
  proteins: z.array(z.string().min(1).max(80)).max(24).default([]),
  staples: z.array(z.string().min(1).max(80)).max(24).default([]),
  meals: z.array(z.string().min(1).max(80)).max(24).default([]),
  reminders: z.string().max(80).default(""),
  sharing: z.string().max(80).default(""),
});

const SETUP_STARTER_MEALS: Record<
  string,
  { mealType: "breakfast" | "lunch" | "dinner" | "snack"; protein?: string }
> = {
  "chicken stir-fry": { mealType: "dinner", protein: "Chicken Breast" },
  "spaghetti bolognese": { mealType: "dinner", protein: "Ground Beef" },
  "taco night": { mealType: "dinner", protein: "Ground Beef" },
  "pancake breakfast": { mealType: "breakfast", protein: "Eggs" },
  "caesar salad": { mealType: "lunch", protein: "Chicken Breast" },
  "veggie omelette": { mealType: "breakfast", protein: "Eggs" },
  "bbq burgers": { mealType: "dinner", protein: "Frozen Burgers" },
  "tomato soup & toast": { mealType: "lunch" },
};

const priceInfoShape = z.object({
  status: z.enum(["pending", "done", "failed"]),
  salePriceCents: z.number().nullable(),
  saleStore: z.string().nullable(),
  saleEnd: z.string().nullable(),
  regularPriceCents: z.number().nullable(),
  regularStore: z.string().nullable(),
  altName: z.string().nullable(),
  altPriceCents: z.number().nullable(),
  altStore: z.string().nullable(),
  note: z.string().nullable(),
  checkedAt: z.string().nullable(),
});

const hitListResponse = z.object({
  refreshedAt: z.string().nullable(),
  // Counted-last stamp (audit #16): the most recent daily stock
  // snapshot date ("YYYY-MM-DD", local) — the last day the
  // household's stock was counted into the app. Null when no
  // snapshot exists yet; the page then reads "Not counted yet".
  lastCountedDate: z.string().nullable(),
  totalItems: z.number(),
  inStock: z.number(),
  outOfStock: z.number(),
  pendingSyncCount: z.number(),
  // Items with app-side stock changes the auto-scan hasn't written
  // to the sheet yet.
  pendingStockCount: z.number(),
  // Every watched (sale-starred) item name, so scans can include
  // them regardless of stock.
  watchedItems: z.array(z.string()),
  items: z.array(
    z.object({
      category: z.string(),
      item: z.string(),
      // Effective stock: last sheet count + unapplied app adjustments.
      stock: z.number(),
      // The count the sheet itself last reported.
      sheetStock: z.number(),
      // Unapplied app-side change (+ bought / − used), 0 when none.
      pendingDelta: z.number(),
      store: z.string(),
      formalName: z.string().nullable(),
      sku: z.string().nullable(),
      pendingSync: z.boolean(),
      watched: z.boolean(),
      // Estimated days until this runs out, from snapshot history;
      // null when there isn't enough history to say.
      forecastDays: z.number().nullable(),
      priceInfo: priceInfoShape.nullable(),
      // Optional expiry date ("YYYY-MM-DD") set in the app; null
      // when none. App-side display data only.
      expiry: z.string().nullable(),
    }),
  ),
});

type PriceInfoOut = z.infer<typeof priceInfoShape>;

function toPriceInfo(
  row: typeof schema.hitAddedItems.$inferSelect,
): PriceInfoOut {
  return {
    status:
      row.priceStatus === "done" || row.priceStatus === "failed"
        ? row.priceStatus
        : "pending",
    salePriceCents: row.salePriceCents,
    saleStore: row.saleStore,
    saleEnd: row.saleEnd,
    regularPriceCents: row.regularPriceCents,
    regularStore: row.regularStore,
    altName: row.altName,
    altPriceCents: row.altPriceCents,
    altStore: row.altStore,
    note: row.priceNote,
    checkedAt: row.priceCheckedAt ? row.priceCheckedAt.toISOString() : null,
  };
}

/** Prompt for the background price check spawned when an item is added. */
function priceCheckPrompt(item: {
  item: string;
  category: string;
  stock: number;
  store: string;
  formalName: string | null;
  sku: string | null;
}): string {
  const product = item.formalName ?? item.item;
  const lines = [
    `Price-check a newly added household inventory item: "${item.item}" (category ${item.category}, stock ${item.stock}, usual store ${item.store}).`,
    `The exact product to look up is "${product}"${item.sku ? ` (SKU / item number: ${item.sku})` : ""}.`,
    "",
    "1. Search for this exact product (same brand and size — never a substitute) in this week's flyers for the household's area, and on the websites of the stores the household shops at. If the usual store above is a membership-only store, only a price from that store counts — never price a membership-store item at another store.",
    "2. Determine, from pages you actually opened (never from a search snippet alone, and never guess a price):",
    "   - salePriceCents / saleStore / saleEnd: if the exact product is on sale anywhere in scope, the lowest sale price in cents, the store, and the sale end exactly as the flyer or page states it (e.g. \"6 days left\" if it gives a flyer end date relative to today, or the end date text) — nulls when it is not on sale.",
    "   - regularPriceCents / regularStore: the lowest verified current regular (non-sale) price for the exact product and where — nulls when no verified price can be found.",
    "   - altName / altPriceCents / altStore: ONLY when the exact product is not on sale — a similar alternative product whose price per comparable unit is at or below the exact product's regular price per unit. Nulls when there is no sale-free alternative that beats it, or when no verified regular price exists to compare against.",
    "   - note: one short line summarising what you found (e.g. \"No current sale; cheapest regular price at No Frills\" or \"Nothing verified in this week's flyers or store sites\").",
    `3. Call the saveItemPriceInfo action exactly once with { item: "${item.item}", ... } and the values above (integer cents, e.g. $1.49 is 149).`,
    "Do not invent prices, SKUs, or sale dates.",
  ];
  return lines.join("\n");
}

async function spawnPriceCheck(
  ctx: Ctx,
  item: {
    item: string;
    category: string;
    stock: number;
    store: string;
    formalName: string | null;
    sku: string | null;
  },
): Promise<{ started: boolean; error: string | null }> {
  const slug =
    item.item
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 40) || "item";
  const result = await ctx.agent.spawnTask(priceCheckPrompt(item), {
    expectsAction: "saveItemPriceInfo",
    dedupeKey: `hit-price-check-${slug}`,
  });
  if (!result.ok) return { started: false, error: result.error };
  return { started: true, error: null };
}

// ---- Meal Planner helpers --------------------------------------------

type StockStatus = "in" | "out" | "unknown";

function optionStatus(stock: number | null | undefined): StockStatus {
  if (stock == null) return "unknown";
  return stock > 0 ? "in" : "out";
}

type MealStatus = "available" | "out" | "unknown";

function mealStatus(
  proteins: { groupIndex: number; stock: number | null }[],
): MealStatus {
  const groups = new Map<number, (number | null)[]>();
  for (const p of proteins) {
    const list = groups.get(p.groupIndex) ?? [];
    list.push(p.stock);
    groups.set(p.groupIndex, list);
  }
  let sawUnknown = false;
  for (const stocks of groups.values()) {
    if (stocks.some((s) => s != null && s > 0)) continue;
    if (stocks.every((s) => s != null)) return "out";
    sawUnknown = true;
  }
  return sawUnknown ? "unknown" : "available";
}

const proteinOptionOut = z.object({
  id: z.number(),
  label: z.string(),
  sheetName: z.string(),
  groupIndex: z.number(),
  stock: z.number().nullable(),
  status: z.enum(["in", "out", "unknown"]),
});

const ingredientOut = z.object({
  id: z.number(),
  name: z.string(),
  quantity: z.number().nullable(),
  unit: z.string().nullable(),
});

// The four meal types a meal idea or a day's pick can be for.
const mealTypeEnum = z.enum(["breakfast", "lunch", "dinner", "snack"]);

// A day can hold at most this many picks, in any mix of meal types.
const MAX_PICKS_PER_DAY = 5;

// Background agent tasks (recipe imports, barcode lookups, web
// recipe loads) report back through a save action; if a task dies
// without ever calling it, its row would sit at "pending" forever
// and the app would poll it indefinitely — the boiling pot /
// "Reading…" / "Looking up…" states would never end. The read
// actions below treat a pending row older than this as failed
// (the same idea as checkRecipeNeeds' stuck-pending retry, and
// the refresh flows' client-side timeout): ten minutes is far
// longer than any of these reads legitimately takes.
const STUCK_PENDING_MS = 10 * 60_000;

function isStuckPending(createdAt: Date): boolean {
  return Date.now() - createdAt.getTime() > STUCK_PENDING_MS;
}

const mealOut = z.object({
  id: z.number(),
  name: z.string(),
  mealType: mealTypeEnum,
  note: z.string().nullable(),
  status: z.enum(["available", "out", "unknown"]),
  proteins: z.array(proteinOptionOut),
  ingredients: z.array(ingredientOut),
  lastEaten: z.string().nullable(),
  pickCount: z.number(),
});

const plannerResponse = z.object({
  meals: z.array(mealOut),
  picks: z.array(
    z.object({
      id: z.number(),
      date: z.string(),
      mealType: mealTypeEnum,
      mealId: z.number(),
      mealName: z.string(),
      proteinId: z.number().nullable(),
      proteinLabel: z.string().nullable(),
      servings: z.number(),
      variant: z.string().nullable(),
    }),
  ),
  inventory: z.array(
    z.object({ sheetName: z.string(), stock: z.number().nullable() }),
  ),
  inventoryUpdatedAt: z.string().nullable(),
  shoppingFlags: z.array(z.object({ sheetName: z.string() })),
  matches: z.array(
    z.object({
      date: z.string(),
      mealType: mealTypeEnum,
      mealId: z.number(),
      mealName: z.string(),
    }),
  ),
});

type PlannerResponse = z.infer<typeof plannerResponse>;

const okResponse = z.object({ ok: z.literal(true) });

async function loadPlanner(ctx: Ctx): Promise<PlannerResponse> {
  const db = ctx.db<typeof schema>();
  const mealRows = await db
    .select()
    .from(schema.meals)
    .orderBy(asc(schema.meals.sortOrder), asc(schema.meals.id));
  const proteinRows = await db
    .select()
    .from(schema.mealProteins)
    .orderBy(asc(schema.mealProteins.sortOrder), asc(schema.mealProteins.id));
  const hitRows = await db.select().from(schema.hitItems);
  const hitMetaRows = await db.select().from(schema.hitMeta);
  const pickRows = await db.select().from(schema.picks);
  const ingredientRows = await db
    .select()
    .from(schema.mealIngredients)
    .orderBy(
      asc(schema.mealIngredients.sortOrder),
      asc(schema.mealIngredients.id),
    );
  const flagRows = await db.select().from(schema.shoppingFlags);
  const matchRows = await db.select().from(schema.mealMatches);
  const usageRows = await db.select().from(schema.usageLog);

  // Protein stock comes from the HIT List cache, keyed by exact Item
  // Name — shown as effective stock (sheet count plus any app-side
  // adjustments the auto-scan hasn't applied yet). A protein with no
  // HIT List row is null — not counted yet, which is deliberately
  // different from 0 (counted, and out).
  const { effective } = await loadStockMaps(ctx);
  const stockBySheet = new Map<string, number>();
  for (const r of hitRows) {
    stockBySheet.set(
      r.item,
      effective.get(r.item.trim().toLowerCase()) ?? r.stock,
    );
  }

  const todayKey = new Date().toLocaleDateString("en-CA", {
    timeZone: "America/Toronto",
  });
  // "Last eaten" and pick counts come from real Eaten confirmations
  // where the meal has any: non-undone usage-log entries linked to
  // the meal. One Eaten tap can write several entries for one pick
  // (Breakfast for dinner logs Bacon AND Eggs), so counts tally
  // distinct eaten picks, dated by their pick date (falling back to
  // the day the entry was logged). Meals with no Eaten history fall
  // back to pick dates up to today, as before.
  const lastEatenByMeal = new Map<number, string>();
  const pickCountByMeal = new Map<number, number>();
  const eatenByMeal = new Map<number, Map<string, string>>();
  for (const u of usageRows) {
    if (u.undone === 1 || u.mealId == null) continue;
    const day =
      u.pickDate ??
      u.createdAt.toLocaleDateString("en-CA", {
        timeZone: "America/Toronto",
      });
    const perMeal = eatenByMeal.get(u.mealId) ?? new Map<string, string>();
    const ref = u.pickId != null ? `pick-${u.pickId}` : `entry-${u.id}`;
    const prevDay = perMeal.get(ref);
    if (!prevDay || day > prevDay) perMeal.set(ref, day);
    eatenByMeal.set(u.mealId, perMeal);
  }
  for (const [mealId, perMeal] of eatenByMeal) {
    pickCountByMeal.set(mealId, perMeal.size);
    let latest: string | null = null;
    for (const day of perMeal.values()) {
      if (!latest || day > latest) latest = day;
    }
    if (latest) lastEatenByMeal.set(mealId, latest);
  }
  for (const pick of pickRows) {
    if (eatenByMeal.has(pick.mealId)) continue;
    if (pick.date > todayKey) continue;
    const prev = lastEatenByMeal.get(pick.mealId);
    if (!prev || pick.date > prev) lastEatenByMeal.set(pick.mealId, pick.date);
    pickCountByMeal.set(pick.mealId, (pickCountByMeal.get(pick.mealId) ?? 0) + 1);
  }

  const meals: PlannerResponse["meals"] = mealRows.map((meal) => {
    const proteins = proteinRows
      .filter((p) => p.mealId === meal.id)
      .map((p) => {
        const stock = stockBySheet.get(p.sheetName) ?? null;
        return {
          id: p.id,
          label: p.label,
          sheetName: p.sheetName,
          groupIndex: p.groupIndex,
          stock,
          status: optionStatus(stock),
        };
      });
    return {
      id: meal.id,
      name: meal.name,
      mealType: mealTypeEnum.parse(meal.mealType),
      note: meal.note,
      status: mealStatus(proteins),
      proteins,
      ingredients: ingredientRows
        .filter((i) => i.mealId === meal.id)
        .map((i) => ({
          id: i.id,
          name: i.name,
          quantity: i.quantity,
          unit: i.unit,
        })),
      lastEaten: lastEatenByMeal.get(meal.id) ?? null,
      pickCount: pickCountByMeal.get(meal.id) ?? 0,
    };
  });

  const mealNameById = new Map(mealRows.map((m) => [m.id, m.name]));
  const proteinLabelById = new Map(proteinRows.map((p) => [p.id, p.label]));
  // Picks come back in calendar order, then meal-of-day order
  // (breakfast, lunch, dinner, snack), then row order — the order the
  // day panel's slot strip shows them in.
  const typeOrder = new Map(mealTypeEnum.options.map((t, i) => [t, i]));
  const picks = pickRows
    .map((pick) => ({
      id: pick.id,
      date: pick.date,
      mealType: mealTypeEnum.parse(pick.mealType),
      mealId: pick.mealId,
      mealName: mealNameById.get(pick.mealId) ?? "Meal",
      proteinId: pick.proteinId,
      proteinLabel:
        pick.proteinId != null
          ? (proteinLabelById.get(pick.proteinId) ?? null)
          : null,
      servings: pick.servings,
      variant: pick.variant,
    }))
    .sort(
      (a, b) =>
        a.date.localeCompare(b.date) ||
        (typeOrder.get(a.mealType) ?? 0) - (typeOrder.get(b.mealType) ?? 0) ||
        a.id - b.id,
    );

  // Inventory panel: every protein any meal references, with its HIT
  // List stock (null when the item has no HIT List row yet).
  const sheetNames = new Set<string>();
  for (const p of proteinRows) sheetNames.add(p.sheetName);
  const inventory = [...sheetNames]
    .sort()
    .map((sheetName) => ({
      sheetName,
      stock: stockBySheet.get(sheetName) ?? null,
    }));

  const hitMeta = hitMetaRows[0];
  return {
    meals,
    picks,
    inventory,
    inventoryUpdatedAt: hitMeta?.refreshedAt
      ? hitMeta.refreshedAt.toISOString()
      : null,
    shoppingFlags: flagRows
      .map((f) => ({ sheetName: f.sheetName }))
      .sort((a, b) => a.sheetName.localeCompare(b.sheetName)),
    matches: matchRows
      .filter((m) => m.dismissed === 0)
      .map((m) => ({
        date: m.date,
        mealType: mealTypeEnum.parse(m.mealType),
        mealId: m.mealId,
        mealName: m.mealName,
      }))
      .sort((a, b) => a.date.localeCompare(b.date)),
  };
}

// ---- Recipe ingredient coverage --------------------------------------
//
// A recipe's ingredients are cross-referenced against the HIT List
// inventory: each ingredient is matched to an inventory item (by the
// item's name or its formal / Brand-Size name — the same style of
// name-matching the barcode scan-to-add path uses) and marked
//   covered — a matching item has enough stock for the recipe's
//             quantity (where the quantity is comparable at all);
//   short   — matched, but the stock is below the needed quantity;
//   missing — no matching item, or the matching item is at stock 0.
// Quantities are comparable only when the ingredient's unit counts
// whole items (no unit, or cloves / cans / boxes / …): a stock count
// can't be weighed against cups or grams, so those ingredients count
// as covered whenever a matching item has stock ≥ 1. Coverage is
// always derived fresh from the meal's stored ingredients (amounts
// for 2 people, the planner convention) and the live effective
// stock — nothing about it is persisted, so a restock removes an
// ingredient from its recipe's needs on the next read by itself.

/** Lowercase, punctuation-free, single-spaced name for comparisons. */
function normalizeIngredientName(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/** Light singular form so "eggs" can match "egg" and back. */
function stemNameWord(word: string): string {
  if (word.length > 3 && word.endsWith("ies")) {
    return `${word.slice(0, -3)}y`;
  }
  if (word.length > 3 && word.endsWith("oes")) return word.slice(0, -2);
  if (word.length > 2 && word.endsWith("s") && !word.endsWith("ss")) {
    return word.slice(0, -1);
  }
  return word;
}

function ingredientNameWords(name: string): Set<string> {
  return new Set(
    normalizeIngredientName(name)
      .split(" ")
      .filter(Boolean)
      .map(stemNameWord),
  );
}

type InventoryEntry = {
  item: string;
  formalName: string | null;
  /** Effective stock (sheet count + unapplied app adjustments). */
  stock: number;
};

/** The whole inventory as matching candidates: sheet rows merged
 * with app-added items (which contribute their formal names), with
 * effective stock — the same merge getHitList shows. */
async function loadInventoryEntries(ctx: Ctx): Promise<InventoryEntry[]> {
  const db = ctx.db<typeof schema>();
  const [hitRows, addedRows] = await Promise.all([
    db.select().from(schema.hitItems),
    db.select().from(schema.hitAddedItems),
  ]);
  const { effective } = await loadStockMaps(ctx);
  const byKey = new Map<string, InventoryEntry>();
  for (const r of hitRows) {
    byKey.set(r.item.trim().toLowerCase(), {
      item: r.item,
      formalName: null,
      stock: effective.get(r.item.trim().toLowerCase()) ?? r.stock,
    });
  }
  for (const r of addedRows) {
    const key = r.item.trim().toLowerCase();
    const existing = byKey.get(key);
    if (existing) {
      if (r.formalName) existing.formalName = r.formalName;
    } else {
      byKey.set(key, {
        item: r.item,
        formalName: r.formalName,
        stock: effective.get(key) ?? r.stock,
      });
    }
  }
  return [...byKey.values()];
}

/**
 * Match one recipe ingredient to an inventory item, barcode-path
 * style: an exact normalized name (item name or formal name) wins;
 * otherwise a name whose every word appears in the ingredient's
 * name ("Sea Salt" inside "fine sea salt"), or an ingredient whose
 * every word appears in the item / formal name ("chicken" inside
 * "Chicken Breast"). Ties go to the shorter item name (the more
 * specific item). Null when nothing matches.
 */
function matchInventoryForIngredient(
  ingredientName: string,
  inventory: InventoryEntry[],
): InventoryEntry | null {
  const target = normalizeIngredientName(ingredientName);
  if (!target) return null;
  const targetWords = ingredientNameWords(ingredientName);
  if (targetWords.size === 0) return null;
  let best: { entry: InventoryEntry; score: number } | null = null;
  for (const entry of inventory) {
    let score = 0;
    const names = [entry.item, entry.formalName].filter(
      (n): n is string => !!n,
    );
    for (const name of names) {
      if (normalizeIngredientName(name) === target) {
        score = Math.max(score, 100);
        continue;
      }
      const words = ingredientNameWords(name);
      if (words.size === 0) continue;
      if ([...words].every((w) => targetWords.has(w))) {
        score = Math.max(score, 80);
      } else if ([...targetWords].every((w) => words.has(w))) {
        score = Math.max(score, 70);
      }
    }
    if (
      score > 0 &&
      (best === null ||
        score > best.score ||
        (score === best.score && entry.item.length < best.entry.item.length))
    ) {
      best = { entry, score };
    }
  }
  return best?.entry ?? null;
}

// Units whose amounts count whole items and can be weighed against
// a stock count. Anything else (cups, grams, tbsp, …) is not
// comparable to a stock count.
const COUNTABLE_UNITS = new Set([
  "", "count", "pc", "piece", "each", "whole", "clove", "head",
  "bunch", "bulb", "stalk", "stock", "sprig", "can", "tin", "pack",
  "package", "box", "bag", "bottle", "jar", "carton", "container",
]);

function unitIsCountable(unit: string | null): boolean {
  const key = (unit ?? "")
    .trim()
    .toLowerCase()
    .replace(/\.$/, "")
    .replace(/s$/, "");
  return COUNTABLE_UNITS.has(key);
}

const coverageEntryShape = z.object({
  name: z.string(),
  quantity: z.number().nullable(),
  unit: z.string().nullable(),
  status: z.enum(["covered", "short", "missing"]),
  matchedItem: z.string().nullable(),
  have: z.number().nullable(),
  need: z.number().nullable(),
  shortfall: z.number().nullable(),
});

type CoverageEntry = z.infer<typeof coverageEntryShape>;

function coverageForIngredient(
  ing: { name: string; quantity: number | null; unit: string | null },
  inventory: InventoryEntry[],
): CoverageEntry {
  const base = { name: ing.name, quantity: ing.quantity, unit: ing.unit };
  const entry = matchInventoryForIngredient(ing.name, inventory);
  if (!entry) {
    return {
      ...base,
      status: "missing",
      matchedItem: null,
      have: null,
      need: null,
      shortfall: null,
    };
  }
  const have = entry.stock;
  const comparable = ing.quantity != null && unitIsCountable(ing.unit);
  const need = comparable ? ing.quantity : null;
  if (have <= 0) {
    return {
      ...base,
      status: "missing",
      matchedItem: entry.item,
      have,
      need,
      shortfall: null,
    };
  }
  if (comparable && ing.quantity != null && have < ing.quantity) {
    return {
      ...base,
      status: "short",
      matchedItem: entry.item,
      have,
      need,
      shortfall: Math.round((ing.quantity - have) * 100) / 100,
    };
  }
  return {
    ...base,
    status: "covered",
    matchedItem: entry.item,
    have,
    need,
    shortfall: null,
  };
}

const needPriceShape = z.object({
  status: z.enum(["pending", "done", "failed"]),
  salePriceCents: z.number().nullable(),
  saleStore: z.string().nullable(),
  saleEnd: z.string().nullable(),
  regularPriceCents: z.number().nullable(),
  regularStore: z.string().nullable(),
  note: z.string().nullable(),
  sourceUrl: z.string().nullable(),
  sourceType: z.enum(["flipp", "website"]).nullable(),
  checkedAt: z.string().nullable(),
});

type NeedPrice = z.infer<typeof needPriceShape>;

const recipeNeedsResponse = z.object({
  meals: z.array(
    z.object({
      mealId: z.number(),
      mealName: z.string(),
      mealType: mealTypeEnum,
      coveredCount: z.number(),
      totalCount: z.number(),
      entries: z.array(
        coverageEntryShape.extend({
          price: needPriceShape.nullable(),
          checked: z.boolean(),
        }),
      ),
    }),
  ),
});

type RecipeNeedsResponse = z.infer<typeof recipeNeedsResponse>;

/** The check-off key for one recipe-needs row. */
function recipeNeedKey(mealId: number, ingredientName: string): string {
  return `${mealId}::${normalizeIngredientName(ingredientName)}`;
}

/**
 * Coverage for every meal that has an ingredient list, with each
 * still-needed ingredient's recorded price check and check-off
 * state joined on. Also prunes check-off rows whose meal or
 * ingredient no longer appears as a need, so a fully covered recipe
 * leaves no state behind.
 */
async function loadRecipeNeeds(ctx: Ctx): Promise<RecipeNeedsResponse> {
  const db = ctx.db<typeof schema>();
  const [mealRows, ingredientRows, inventory, priceRows, checkRows] =
    await Promise.all([
      db
        .select()
        .from(schema.meals)
        .orderBy(asc(schema.meals.sortOrder), asc(schema.meals.id)),
      db
        .select()
        .from(schema.mealIngredients)
        .orderBy(
          asc(schema.mealIngredients.sortOrder),
          asc(schema.mealIngredients.id),
        ),
      loadInventoryEntries(ctx),
      db.select().from(schema.recipeNeedPrices),
      db.select().from(schema.recipeNeedChecks),
    ]);
  const priceByKey = new Map(
    priceRows.map((p) => [`${p.mealId}::${p.ingredientKey}`, p]),
  );
  const checkedKeys = new Set(
    checkRows.filter((r) => r.checked === 1).map((r) => r.needKey),
  );
  const liveNeedKeys = new Set<string>();
  const meals: RecipeNeedsResponse["meals"] = [];
  for (const meal of mealRows) {
    const ings = ingredientRows.filter((i) => i.mealId === meal.id);
    if (ings.length === 0) continue;
    const entries = ings.map((ing) => {
      const cov = coverageForIngredient(ing, inventory);
      const key = recipeNeedKey(meal.id, ing.name);
      let price: NeedPrice | null = null;
      if (cov.status !== "covered") {
        liveNeedKeys.add(key);
        const row = priceByKey.get(key);
        if (row) {
          price = {
            status: row.status,
            salePriceCents: row.salePriceCents,
            saleStore: row.saleStore,
            saleEnd: row.saleEnd,
            regularPriceCents: row.regularPriceCents,
            regularStore: row.regularStore,
            note: row.note,
            sourceUrl: row.sourceUrl,
            sourceType: row.sourceType,
            checkedAt: row.checkedAt
              ? row.checkedAt.toISOString()
              : null,
          };
        }
      }
      return {
        ...cov,
        price,
        checked: cov.status !== "covered" && checkedKeys.has(key),
      };
    });
    meals.push({
      mealId: meal.id,
      mealName: meal.name,
      mealType: mealTypeEnum.parse(meal.mealType),
      coveredCount: entries.filter((e) => e.status === "covered").length,
      totalCount: entries.length,
      entries,
    });
  }
  // Prune check-off rows for needs that no longer exist (meal
  // deleted, ingredient list edited, or the ingredient restocked):
  // check-off state for a need that isn't a need any more is stale.
  const staleKeys = checkRows
    .map((r) => r.needKey)
    .filter((k) => !liveNeedKeys.has(k));
  if (staleKeys.length > 0) {
    const statements: BatchItem<"sqlite">[] = staleKeys.map((k) =>
      db
        .delete(schema.recipeNeedChecks)
        .where(eq(schema.recipeNeedChecks.needKey, k)),
    );
    const [first, ...rest] = statements;
    if (first) await db.batch([first, ...rest]);
  }
  return { meals };
}

/** Prompt for the background price check over one recipe's needs. */
function recipeNeedsPricePrompt(
  mealId: number,
  mealName: string,
  needs: { name: string; quantity: number | null; unit: string | null }[],
): string {
  const list = needs
    .map(
      (n) =>
        `   - "${n.name}"${n.quantity != null ? ` (the recipe needs ${n.quantity}${n.unit ? ` ${n.unit}` : ""})` : ""}`,
    )
    .join("\n");
  return [
    `Price-check the still-needed ingredients of the recipe "${mealName}" for a household shopping list.`,
    "Ingredients needed:",
    list,
    "",
    "For EACH ingredient:",
    "1. Search for it in this week's flyers for the household's area, and on the websites of the stores the household shops at. The ingredient is a plain grocery item, not one specific brand: a standard product for that ingredient is the match (for fresh produce / meat / dairy, the store's usual product for it).",
    "2. Determine, from pages you actually opened (never from a search snippet alone, and never guess a price):",
    "   - salePriceCents / saleStore / saleEnd: if the ingredient is on sale anywhere in scope, the lowest sale price in cents (for the standard pack / per-unit basis the page states), the store, and the sale end exactly as the flyer or page states it — nulls when it is not on sale.",
    "   - regularPriceCents / regularStore: the lowest verified current regular (non-sale) price and where — nulls when no verified price can be found.",
    "   - sourceUrl / sourceType: the exact page the price you report was verified on — the Flipp flyer/item URL (sourceType \"flipp\") or the store product-page URL (sourceType \"website\").",
    "   - note: one short line summarising what you found (e.g. \"On sale at Metro until Wednesday\" or \"No sale; cheapest regular price at No Frills\").",
    `3. Call the saveRecipeNeedPrices action exactly once with { mealId: ${mealId}, results: [ { ingredient, salePriceCents, saleStore, saleEnd, regularPriceCents, regularStore, note, sourceUrl, sourceType }, … ] } — one result per ingredient above, echoing each ingredient's name EXACTLY as written in the list. Prices are integer cents (e.g. $1.49 is 149); use null for anything you could not verify.`,
    "Do not invent prices, stores, or sale dates.",
  ].join("\n");
}

// The household's dinner ideas exactly as recorded in the Meal
// Planner build-and-sync spec (workspace/your_files/meal-planner-
// handoff/meal-planner-build-and-sync-spec.md, Parts A4–A6), which was
// prepared from the standalone Meal Planner app on Nov 12, 2026:
// names, per-meal protein labels (capitalisation differs per meal on
// purpose — Taco Night's differ from the other meals'), the Breakfast
// for dinner note, ingredient lists (quantities for 2 people), and
// the two picks current at spec time. Spellings like "Sheppards pie"
// and "Parmesean Cheese" are the household's own — kept verbatim.
// `sheetName` is the exact Item Name in the HIT List; `label` is what
// the family calls it (sheet "Sausages" is the mild Italian sausage
// option). Seeded once by the post-submit `bootstrapPlanner` action;
// afterwards the rows are user-owned and only change through the UI.
const STARTER_MEALS: {
  name: string;
  note: string | null;
  groups: { label: string; sheetName: string }[][];
  ingredients: { name: string; quantity: number | null; unit: string | null }[];
}[] = [
  {
    name: "Chicken curry",
    note: null,
    groups: [
      [
        { label: "Chicken breast", sheetName: "Chicken Breast" },
        { label: "Chicken thighs", sheetName: "Chicken Thighs" },
      ],
    ],
    ingredients: [
      { name: "Chicken Thighs", quantity: 4, unit: null },
      { name: "Spanish Onion", quantity: 1, unit: null },
      { name: "Garlic", quantity: 4, unit: "Cloves" },
      { name: "Ginger", quantity: 1, unit: "Bulb" },
      { name: "Green Onion", quantity: 5, unit: "Stocks" },
      { name: "Green bell pepper", quantity: 0.5, unit: null },
      { name: "Red bell pepper", quantity: 0.5, unit: null },
      { name: "Carrots", quantity: 3, unit: null },
      { name: "Potatoes", quantity: 5, unit: null },
      { name: "Coconut milk", quantity: 3, unit: "Cans" },
      { name: "Spinach", quantity: 0.5, unit: "Box" },
      { name: "White Rice", quantity: 2, unit: "Cups" },
    ],
  },
  {
    name: "Peanut chicken",
    note: null,
    groups: [
      [
        { label: "Chicken breast", sheetName: "Chicken Breast" },
        { label: "Chicken thighs", sheetName: "Chicken Thighs" },
      ],
    ],
    ingredients: [
      { name: "Chicken Breasts", quantity: 2, unit: null },
      { name: "White Rice", quantity: 2, unit: "Cups" },
      { name: "Spanish Onion", quantity: 0.5, unit: null },
      { name: "Green Onion", quantity: 4, unit: "Stocks" },
      { name: "Yellow bell pepper", quantity: 0.5, unit: null },
      { name: "Red bell pepper", quantity: 0.5, unit: null },
      { name: "Peanut Butter", quantity: 3, unit: "Dollops" },
      { name: "Spinach", quantity: 0.5, unit: "Box" },
      { name: "Crushed Peanuts", quantity: 0.75, unit: "Cup" },
    ],
  },
  {
    name: "Chicken caesar salad",
    note: null,
    groups: [[{ label: "Chicken breast", sheetName: "Chicken Breast" }]],
    ingredients: [
      { name: "Chicken Breasts", quantity: 2, unit: null },
      { name: "Caesar dressing", quantity: 1, unit: null },
      { name: "Romaine Lettuce", quantity: 1, unit: "Head" },
      { name: "Cucumber", quantity: 1, unit: null },
      { name: "Tomatoes", quantity: 2, unit: null },
      { name: "Croutons", quantity: 0.5, unit: "Box" },
      { name: "Bacon", quantity: 1, unit: "Lb" },
      { name: "Parmesean Cheese", quantity: 100, unit: "Grams" },
    ],
  },
  {
    name: "Breakfast for dinner",
    note: "Bacon and eggs are both required — if either is out, this meal is not available. Sausage is optional: the meal can still be made without it.",
    groups: [
      [{ label: "Bacon", sheetName: "Bacon" }],
      [{ label: "Eggs", sheetName: "Eggs" }],
    ],
    ingredients: [
      { name: "Bacon", quantity: 1, unit: "Lb" },
      { name: "Eggs", quantity: 6, unit: null },
      { name: "Tomato", quantity: 1, unit: null },
      { name: "Baked Beans", quantity: 1, unit: "Can" },
      { name: "Hashbrowns", quantity: 4, unit: null },
      { name: "Bread", quantity: 4, unit: "Slices" },
      { name: "Italian Sausage", quantity: 1, unit: null },
      { name: "Mixed Fruit", quantity: 2, unit: null },
      { name: "OJ", quantity: 1, unit: "L" },
    ],
  },
  {
    name: "Spaghetti",
    note: null,
    groups: [
      [
        { label: "Ground Beef", sheetName: "Ground Beef" },
        { label: "Ground bison", sheetName: "Ground Bison" },
        { label: "Mild Italian sausage", sheetName: "Sausages" },
      ],
    ],
    ingredients: [
      { name: "Ground meat", quantity: 1, unit: "Lb" },
      { name: "Spanish Onion", quantity: 1, unit: null },
      { name: "Garlic", quantity: 4, unit: "Cloves" },
      { name: "Tomato Sauce", quantity: 1, unit: "Bottle" },
      { name: "Spinach", quantity: 0.5, unit: "Box" },
      { name: "Pasta", quantity: 400, unit: "Grams" },
    ],
  },
  {
    name: "Sheppards pie",
    note: null,
    groups: [
      [
        { label: "Ground Beef", sheetName: "Ground Beef" },
        { label: "Ground bison", sheetName: "Ground Bison" },
      ],
    ],
    ingredients: [
      { name: "Ground meat", quantity: 1, unit: "Lb" },
      { name: "Potatoes", quantity: 10, unit: null },
      { name: "Frozen veg medley", quantity: 0.5, unit: "Bag" },
      { name: "Spanish Onion", quantity: 1, unit: null },
      { name: "Beef Stock", quantity: 300, unit: "ML" },
      { name: "Corn starch", quantity: 2, unit: "Tbsp" },
    ],
  },
  {
    name: "BBQ burgers",
    note: null,
    groups: [
      [
        { label: "Frozen burgers", sheetName: "Frozen Burgers" },
        { label: "Ground beef", sheetName: "Ground Beef" },
      ],
    ],
    ingredients: [
      { name: "Beef Burgers", quantity: 4, unit: "Patties" },
      { name: "Hamburger buns", quantity: 4, unit: null },
      { name: "Red Onion", quantity: 1, unit: null },
      { name: "Tomato", quantity: 1, unit: null },
      { name: "Pickles", quantity: 100, unit: "Grams" },
      { name: "Lettuce", quantity: 0.25, unit: "Head" },
      { name: "Frozen Fries", quantity: 1, unit: "Bag" },
    ],
  },
  {
    name: "Taco Night",
    note: null,
    groups: [
      [
        { label: "Ground Beef", sheetName: "Ground Beef" },
        { label: "Mild Italian Sausage", sheetName: "Sausages" },
        { label: "Chicken Thighs", sheetName: "Chicken Thighs" },
        { label: "Ground Bison", sheetName: "Ground Bison" },
        { label: "Chicken Breast", sheetName: "Chicken Breast" },
      ],
    ],
    ingredients: [
      { name: "Red Onion", quantity: 2, unit: null },
      { name: "Guac", quantity: 1, unit: "Pint" },
      { name: "Sour cream", quantity: 1, unit: "Pint" },
      { name: "Grated cheese", quantity: 1, unit: "Bag" },
      { name: "Tomatoes", quantity: 2, unit: null },
      { name: "Limes", quantity: 3, unit: null },
      { name: "Taco seasoning", quantity: 1, unit: "Pack" },
      { name: "Bell pepper", quantity: 1, unit: null },
      { name: "Jalapeno", quantity: 1, unit: null },
    ],
  },
];

// The picks current when the spec was written (Part A6), so this tab
// starts identical to the standalone planner: { date, meal name,
// protein label, servings }.
const STARTER_PICKS: {
  date: string;
  mealName: string;
  proteinLabel: string;
  servings: number;
}[] = [
  {
    date: "2026-11-12",
    mealName: "Peanut chicken",
    proteinLabel: "Chicken breast",
    servings: 2,
  },
  {
    date: "2026-11-15",
    mealName: "Spaghetti",
    proteinLabel: "Ground Beef",
    servings: 2,
  },
];

// ---- Recipe generator ----------------------------------------------
// Template/combination logic over the live inventory — no external
// service. A recipe is picked from per-meal-type templates whose
// ingredient slots are filled only with HIT List items actually in
// stock (matched by keyword pools); `variant` rotates the template
// and the slot picks so "Generate another" gives a different
// combination. Quantities are written for 2 people (the planner's
// convention) and the client scales them to the requested servings.

// ---- Curated web recipes -------------------------------------------
// Verified shortlist of free, top-rated recipe sites — RecipeTin
// Eats, BBC Good Food, Allrecipes — keyed by tracked protein (HIT
// List item name). Every URL below was opened and confirmed to be a
// real recipe page with an ingredients list and a step-by-step
// method for that protein. The BBC Good Food links point to
// bbcgoodfoodme.com, the official BBC Good Food edition whose pages
// can be read (bbcgoodfood.com blocks automated reading) — the same
// BBC Good Food recipes. Use these URLs exactly as given.
type WebRecipeEntry = {
  dishName: string;
  site: string;
  url: string;
  mealTypes: string[];
};

const WEB_RECIPES: Record<string, WebRecipeEntry[]> = {
  "chicken breast": [
    {
      dishName: "Honey Garlic Chicken Breast",
      site: "RecipeTin Eats",
      url: "https://www.recipetineats.com/honey-garlic-chicken/",
      mealTypes: ["dinner"],
    },
    {
      dishName: "Oven Baked Chicken Breast",
      site: "RecipeTin Eats",
      url: "https://www.recipetineats.com/oven-baked-chicken-breast/",
      mealTypes: ["dinner"],
    },
  ],
  "chicken thighs": [
    {
      dishName: "Filipino Chicken Adobo (Flavour Kapow!)",
      site: "RecipeTin Eats",
      url: "https://www.recipetineats.com/filipino-chicken-adobo-flavour-kapow/",
      mealTypes: ["dinner"],
    },
    {
      dishName: "Gravy Baked Chicken (thighs & drumsticks)",
      site: "RecipeTin Eats",
      url: "https://www.recipetineats.com/gravy-baked-chicken-thighs-and-drumsticks/",
      mealTypes: ["dinner"],
    },
  ],
  "ground beef": [
    {
      dishName: "Chilli con carne",
      site: "BBC Good Food",
      url: "https://www.bbcgoodfoodme.com/recipes/chilli-con-carne/",
      mealTypes: ["dinner"],
    },
    {
      dishName: "Spaghetti Bolognese",
      site: "RecipeTin Eats",
      url: "https://www.recipetineats.com/spaghetti-bolognese/",
      mealTypes: ["dinner"],
    },
  ],
  "ground bison": [
    {
      dishName: "Grilled Bison Burgers",
      site: "Allrecipes",
      url: "https://www.allrecipes.com/recipe/238315/grilled-bison-burgers/",
      mealTypes: ["dinner"],
    },
    {
      dishName: "Bison and Brown Rice Stuffed Peppers",
      site: "Allrecipes",
      url: "https://www.allrecipes.com/recipe/236628/bison-and-brown-rice-stuffed-peppers/",
      mealTypes: ["dinner"],
    },
  ],
  bacon: [
    {
      dishName: "One-pan English breakfast",
      site: "BBC Good Food",
      url: "https://www.bbcgoodfoodme.com/recipes/onepan-english-breakfast/",
      mealTypes: ["breakfast"],
    },
    {
      dishName: "Full English shakshuka",
      site: "BBC Good Food",
      url: "https://www.bbcgoodfoodme.com/recipes/full-english-shakshuka/",
      mealTypes: ["breakfast"],
    },
  ],
  eggs: [
    {
      dishName: "Shakshuka",
      site: "BBC Good Food",
      url: "https://www.bbcgoodfoodme.com/recipes/spicy-tomato-baked-eggs/",
      mealTypes: ["breakfast", "dinner"],
    },
    {
      dishName: "Healthy shakshuka",
      site: "BBC Good Food",
      url: "https://www.bbcgoodfoodme.com/recipes/healthy-shakshuka/",
      mealTypes: ["breakfast", "dinner"],
    },
  ],
  "frozen burgers": [
    {
      dishName: "The Perfect Basic Burger",
      site: "Allrecipes",
      url: "https://www.allrecipes.com/recipe/25473/the-perfect-basic-burger/",
      mealTypes: ["dinner", "lunch"],
    },
    {
      dishName: "Juiciest Hamburgers Ever",
      site: "Allrecipes",
      url: "https://www.allrecipes.com/recipe/49404/juiciest-hamburgers-ever/",
      mealTypes: ["dinner", "lunch"],
    },
  ],
  sausages: [
    {
      dishName: "Sausage Pasta",
      site: "RecipeTin Eats",
      url: "https://www.recipetineats.com/sausage-pasta/",
      mealTypes: ["dinner"],
    },
    {
      dishName: "Bangers and Mash (Sausage with Onion Gravy)",
      site: "RecipeTin Eats",
      url: "https://www.recipetineats.com/bangers-and-mash-sausage-with-onion-gravy/",
      mealTypes: ["dinner"],
    },
  ],
};

/**
 * Picks the web recipe for a generation: entries for the protein
 * whose meal types include the chosen type first; if none match,
 * any entry for the protein. `variant` rotates through the
 * candidates so repeated generates vary and "Generate another"
 * lands on a different entry before any repeat. Null when the
 * protein has no table entries.
 */
function pickWebRecipe(
  proteinName: string,
  mealType: string,
  variant: number,
): WebRecipeEntry | null {
  const entries = WEB_RECIPES[proteinName.trim().toLowerCase()];
  if (!entries || entries.length === 0) return null;
  const matching = entries.filter((e) => e.mealTypes.includes(mealType));
  const candidates = matching.length > 0 ? matching : entries;
  return candidates[variant % candidates.length] ?? null;
}

/** Parses a stored web recipe load row into the response shape. */
function parseWebRecipeLoad(row: {
  title: string | null;
  servings: number | null;
  ingredientsJson: string | null;
  stepsJson: string | null;
}): RecipeOut["webRecipe"] {
  let ingredients: { name: string; quantity: number | null; unit: string | null }[] = [];
  if (row.ingredientsJson) {
    try {
      const parsed: unknown = JSON.parse(row.ingredientsJson);
      if (Array.isArray(parsed)) {
        ingredients = parsed
          .filter(
            (i): i is Record<string, unknown> =>
              typeof i === "object" && i !== null,
          )
          .map((i) => ({
            name: typeof i.name === "string" ? i.name : "",
            quantity: typeof i.quantity === "number" ? i.quantity : null,
            unit: typeof i.unit === "string" ? i.unit : null,
          }))
          .filter((i) => i.name.length > 0);
      }
    } catch {
      ingredients = [];
    }
  }
  let steps: string[] = [];
  if (row.stepsJson) {
    try {
      const parsed: unknown = JSON.parse(row.stepsJson);
      if (Array.isArray(parsed)) {
        steps = parsed.filter((s): s is string => typeof s === "string");
      }
    } catch {
      steps = [];
    }
  }
  if (!row.title || ingredients.length === 0 || steps.length === 0) {
    return null;
  }
  return { name: row.title, servings: row.servings, ingredients, steps };
}

const recipeIngredientOut = z.object({
  name: z.string(),
  quantity: z.number().nullable(),
  unit: z.string().nullable(),
});

const recipeOut = z.object({
  name: z.string(),
  protein: z.string(),
  proteinInStock: z.boolean(),
  proteinStock: z.number().nullable(),
  mealType: mealTypeEnum,
  servings: z.number(),
  ingredients: z.array(recipeIngredientOut),
  steps: z.array(z.string()),
  note: z.string().nullable(),
  // The curated web recipe chosen for this generation (null when the
  // protein has no table entries): the dish name, site, and exact
  // URL picked from WEB_RECIPES. Present whether the displayed body
  // came from the web page or from the inventory fallback, so the
  // Source dropdown can always link the chosen recipe.
  source: z
    .object({
      dishName: z.string(),
      site: z.string(),
      url: z.string(),
    })
    .nullable(),
  // State of the web page load behind `source`: "none" (no source),
  // "pending" (a background read is in flight — poll
  // getWebRecipeLoad with webLoadId), "done" (webRecipe carries the
  // parsed page), "failed" (the page couldn't be read; the body is
  // the inventory-built fallback).
  webStatus: z.enum(["none", "pending", "done", "failed"]),
  webLoadId: z.number().nullable(),
  // The parsed web recipe when webStatus is "done": dish title from
  // the page, the servings the page states, ingredients at those
  // servings (the client scales them to the chosen headcount), and
  // the page's method as ordered steps.
  webRecipe: z
    .object({
      name: z.string(),
      servings: z.number().nullable(),
      ingredients: z.array(recipeIngredientOut),
      steps: z.array(z.string()),
    })
    .nullable(),
});

type RecipeOut = z.infer<typeof recipeOut>;

type InvItem = { name: string; stock: number; expiry: string | null };

/**
 * Whole days from today (UTC calendar days) until an expiry date
 * key ("YYYY-MM-DD"): negative when the date has passed, 0 for
 * today. Server-side companion to the client's daysUntilExpiry —
 * used only to weigh recipe-generation picks, never for display.
 */
function daysUntilExpiryUtc(dateKey: string): number {
  const [y = 1970, m = 1, d = 1] = dateKey.split("-").map(Number);
  const target = Date.UTC(y, m - 1, d);
  const now = new Date();
  const today = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
  return Math.round((target - today) / 86_400_000);
}

/**
 * Keyword match against an inventory item name. Multi-word keywords
 * match as a phrase; single words must match a whole word (or its
 * simple plural) so "pepper" doesn't claim "Peppercorns" and "corn"
 * never claims "Popcorn".
 */
function nameMatches(name: string, keyword: string): boolean {
  const n = name.toLowerCase();
  if (keyword.includes(" ")) return n.includes(keyword);
  const words = n.split(/[^a-z]+/).filter(Boolean);
  return words.some(
    (w) => w === keyword || w === `${keyword}s` || `${w}s` === keyword,
  );
}

/** First in-stock inventory item whose name matches any keyword. */
function poolPick(
  items: InvItem[],
  keywords: string[],
  exclude: Set<string>,
  rotate: number,
): InvItem | null {
  const matches = items.filter(
    (i) =>
      i.stock > 0 &&
      !exclude.has(i.name.toLowerCase()) &&
      keywords.some((k) => nameMatches(i.name, k)),
  );
  if (matches.length === 0) return null;
  // Use-first priority (Beta 0.03, audit #14): when any match is
  // close to expiry — within the app's one 3-day window or already
  // past, the HIT row chip's set — the pick comes from those
  // matches, soonest-expiry first, with the variant rotation
  // applied within the group so "Generate another" still varies.
  const soon = matches
    .filter(
      (i) => i.expiry != null && daysUntilExpiryUtc(i.expiry) <= 3,
    )
    .sort((a, b) => (a.expiry ?? "").localeCompare(b.expiry ?? ""));
  const pool = soon.length > 0 ? soon : matches;
  return pool[rotate % pool.length] ?? null;
}

function proteinBase(protein: string): { quantity: number; unit: string | null } {
  const p = protein.toLowerCase();
  if (p.includes("egg")) return { quantity: 6, unit: null };
  if (p.includes("bacon")) return { quantity: 0.5, unit: "Lb" };
  if (p.includes("burger")) return { quantity: 4, unit: "Patties" };
  if (p.includes("sausage")) return { quantity: 4, unit: null };
  if (p.includes("thigh")) return { quantity: 4, unit: null };
  if (p.includes("breast")) return { quantity: 2, unit: null };
  if (p.includes("ground")) return { quantity: 1, unit: "Lb" };
  return { quantity: 1, unit: "Lb" };
}

type SlotSpec = {
  keywords: string[];
  quantity: number;
  unit: string | null;
  /** Prefix used when the item's own name isn't descriptive enough. */
  optional?: boolean;
};

type RecipeTemplate = {
  name: (protein: string, picks: Map<string, InvItem>) => string;
  slots: { key: string; spec: SlotSpec }[];
  steps: (protein: string, picks: Map<string, InvItem>) => string[];
};

const VEG = ["onion", "pepper", "carrot", "broccoli", "zucchini", "mushroom", "celery", "cabbage", "spinach", "tomato", "cucumber", "lettuce", "peas", "green bean", "kale", "frozen veg", "vegetable"];
const GRAIN = ["rice", "pasta", "spaghetti", "noodle", "quinoa", "couscous", "orzo", "macaroni"];
const BREAD = ["bread", "bun", "tortilla", "bagel", "english muffin", "pita", "roll"];
const POTATO = ["potato", "hashbrown", "fries", "sweet potato"];
const CHEESE = ["cheese", "parmesan", "mozzarella", "cheddar"];
const SAUCE = ["tomato sauce", "pasta sauce", "salsa", "bbq sauce", "hot sauce", "soy sauce", "soya sauce", "dressing", "gravy", "broth", "stock", "hummus", "guac", "sour cream", "cream"];
const FRUIT = ["apple", "banana", "berries", "berry", "fruit", "orange", "peach", "pear", "melon", "grapes"];
const HERB = ["garlic", "ginger", "green onion", "cilantro", "parsley", "basil", "lemon", "lime"];

const RECIPE_TEMPLATES: Record<string, RecipeTemplate[]> = {
  dinner: [
    {
      name: (p, picks) => `${p} stir-fry${picks.get("grain") ? ` over ${picks.get("grain")!.name}` : ""}`,
      slots: [
        { key: "veg", spec: { keywords: VEG, quantity: 2, unit: null } },
        { key: "grain", spec: { keywords: GRAIN, quantity: 2, unit: "Cups", optional: true } },
        { key: "herb", spec: { keywords: HERB, quantity: 2, unit: null, optional: true } },
        { key: "sauce", spec: { keywords: ["soy sauce", "soya sauce"], quantity: 2, unit: "Tbsp", optional: true } },
      ],
      steps: (p, picks) => [
        `Cook the ${p.toLowerCase()} in a hot pan with a little oil until cooked through; set aside.`,
        `In the same pan, stir-fry the ${picks.get("veg")?.name.toLowerCase() ?? "vegetables"}${picks.get("herb") ? ` with the ${picks.get("herb")!.name.toLowerCase()}` : ""} until tender-crisp.`,
        `Return the ${p.toLowerCase()} to the pan${picks.get("sauce") ? `, add the ${picks.get("sauce")!.name.toLowerCase()}, and toss for a minute` : " and toss everything together"}. Season to taste.`,
        picks.get("grain")
          ? `Serve over the cooked ${picks.get("grain")!.name.toLowerCase()}.`
          : "Serve as is, straight from the pan.",
      ],
    },
    {
      name: (p, picks) => `Skillet ${p.toLowerCase()}${picks.get("potato") ? ` with ${picks.get("potato")!.name.toLowerCase()}` : ""}`,
      slots: [
        { key: "potato", spec: { keywords: POTATO, quantity: 4, unit: null, optional: true } },
        { key: "veg", spec: { keywords: VEG, quantity: 1, unit: null } },
        { key: "cheese", spec: { keywords: CHEESE, quantity: 0.5, unit: "Cup", optional: true } },
      ],
      steps: (p, picks) => [
        picks.get("potato")
          ? `Start the ${picks.get("potato")!.name.toLowerCase()} in a large oven-safe skillet until starting to crisp.`
          : "Heat a large oven-safe skillet over medium-high heat with a little oil.",
        `Add the ${p.toLowerCase()} and cook until browned and cooked through.`,
        `Stir in the ${picks.get("veg")?.name.toLowerCase() ?? "vegetables"} and cook until tender.`,
        picks.get("cheese")
          ? `Scatter the ${picks.get("cheese")!.name.toLowerCase()} over the top and let it melt before serving.`
          : "Season well and serve straight from the skillet.",
      ],
    },
    {
      name: (p, picks) => `${p} ${picks.get("grain") ? picks.get("grain")!.name.toLowerCase() : "bowl"} bowls`,
      slots: [
        { key: "grain", spec: { keywords: [...GRAIN, ...POTATO], quantity: 2, unit: "Cups", optional: true } },
        { key: "veg", spec: { keywords: VEG, quantity: 2, unit: null } },
        { key: "sauce", spec: { keywords: SAUCE, quantity: 0.5, unit: "Cup", optional: true } },
      ],
      steps: (p, picks) => [
        picks.get("grain")
          ? `Cook the ${picks.get("grain")!.name.toLowerCase()} and divide it between bowls.`
          : "Warm your bowls — the toppings carry this one.",
        `Cook the ${p.toLowerCase()} with your favourite seasoning until done.`,
        `Quickly cook or prep the ${picks.get("veg")?.name.toLowerCase() ?? "vegetables"}.`,
        `Pile the ${p.toLowerCase()} and vegetables over the top${picks.get("sauce") ? ` and finish with the ${picks.get("sauce")!.name.toLowerCase()}` : ""}.`,
      ],
    },
    {
      name: (p, picks) => `${p} wraps${picks.get("veg") ? ` with ${picks.get("veg")!.name.toLowerCase()}` : ""}`,
      slots: [
        { key: "bread", spec: { keywords: BREAD, quantity: 4, unit: null, optional: true } },
        { key: "veg", spec: { keywords: VEG, quantity: 1, unit: null } },
        { key: "sauce", spec: { keywords: SAUCE, quantity: 0.5, unit: "Cup", optional: true } },
        { key: "cheese", spec: { keywords: CHEESE, quantity: 0.5, unit: "Cup", optional: true } },
      ],
      steps: (p, picks) => [
        `Cook the ${p.toLowerCase()} until done, then slice or shred it.`,
        `Warm the ${picks.get("bread")?.name.toLowerCase() ?? "wraps"} and prep the ${picks.get("veg")?.name.toLowerCase() ?? "vegetables"}.`,
        `Fill each wrap with the ${p.toLowerCase()} and vegetables${picks.get("cheese") ? `, plus the ${picks.get("cheese")!.name.toLowerCase()}` : ""}${picks.get("sauce") ? ` and a spoonful of ${picks.get("sauce")!.name.toLowerCase()}` : ""}.`,
        "Roll up tight and serve.",
      ],
    },
  ],
  lunch: [
    {
      name: (p, picks) => `${p} salad${picks.get("veg") ? ` with ${picks.get("veg")!.name.toLowerCase()}` : ""}`,
      slots: [
        { key: "veg", spec: { keywords: ["lettuce", "spinach", "cucumber", "tomato", "pepper", "carrot", "cabbage", "kale"], quantity: 1, unit: null } },
        { key: "sauce", spec: { keywords: ["dressing", "hummus", "sour cream"], quantity: 0.5, unit: "Cup", optional: true } },
        { key: "cheese", spec: { keywords: CHEESE, quantity: 0.5, unit: "Cup", optional: true } },
      ],
      steps: (p, picks) => [
        `Cook the ${p.toLowerCase()} until done; let it rest, then slice it.`,
        `Chop the ${picks.get("veg")?.name.toLowerCase() ?? "greens"} into a big bowl.`,
        `Lay the ${p.toLowerCase()} over the top${picks.get("cheese") ? ` with the ${picks.get("cheese")!.name.toLowerCase()}` : ""}.`,
        picks.get("sauce")
          ? `Drizzle with the ${picks.get("sauce")!.name.toLowerCase()} and serve.`
          : "Dress with oil, vinegar, salt and pepper, and serve.",
      ],
    },
    {
      name: (p) => `${p} sandwiches`,
      slots: [
        { key: "bread", spec: { keywords: BREAD, quantity: 4, unit: "Slices", optional: true } },
        { key: "veg", spec: { keywords: VEG, quantity: 1, unit: null, optional: true } },
        { key: "cheese", spec: { keywords: CHEESE, quantity: 2, unit: "Slices", optional: true } },
      ],
      steps: (p, picks) => [
        `Cook the ${p.toLowerCase()} until done (or use it sliced, if it already is).`,
        `Build the sandwiches on the ${picks.get("bread")?.name.toLowerCase() ?? "bread"}${picks.get("cheese") ? ` with the ${picks.get("cheese")!.name.toLowerCase()}` : ""}${picks.get("veg") ? ` and the ${picks.get("veg")!.name.toLowerCase()}` : ""}.`,
        "Toast or press until warm and crisp, then serve.",
      ],
    },
    {
      name: (p, _picks) => `Quick ${p.toLowerCase()} soup`,
      slots: [
        { key: "sauce", spec: { keywords: ["stock", "broth"], quantity: 4, unit: "Cups", optional: true } },
        { key: "veg", spec: { keywords: VEG, quantity: 2, unit: null } },
        { key: "grain", spec: { keywords: GRAIN, quantity: 1, unit: "Cup", optional: true } },
      ],
      steps: (p, picks) => [
        `Simmer the ${picks.get("sauce")?.name.toLowerCase() ?? "stock or water"} with the ${picks.get("veg")?.name.toLowerCase() ?? "vegetables"} until they start to soften.`,
        `Add the ${p.toLowerCase()}${picks.get("grain") ? ` and the ${picks.get("grain")!.name.toLowerCase()}` : ""} and simmer until everything is cooked through.`,
        "Season to taste and serve hot.",
      ],
    },
  ],
  breakfast: [
    {
      name: (p, _picks) => `${p} breakfast skillet`,
      slots: [
        { key: "potato", spec: { keywords: POTATO, quantity: 4, unit: null, optional: true } },
        { key: "veg", spec: { keywords: VEG, quantity: 1, unit: null, optional: true } },
        { key: "cheese", spec: { keywords: CHEESE, quantity: 0.5, unit: "Cup", optional: true } },
      ],
      steps: (p, picks) => [
        picks.get("potato")
          ? `Crisp the ${picks.get("potato")!.name.toLowerCase()} in a skillet.`
          : "Heat a skillet over medium heat with a little butter or oil.",
        `Add the ${p.toLowerCase()}${picks.get("veg") ? ` and the ${picks.get("veg")!.name.toLowerCase()}` : ""} and cook until done.`,
        picks.get("cheese")
          ? `Top with the ${picks.get("cheese")!.name.toLowerCase()}, cover for a minute to melt, and serve.`
          : "Season and serve hot.",
      ],
    },
    {
      name: (p, _picks) => `${p} breakfast wraps`,
      slots: [
        { key: "bread", spec: { keywords: BREAD, quantity: 4, unit: null, optional: true } },
        { key: "cheese", spec: { keywords: CHEESE, quantity: 0.5, unit: "Cup", optional: true } },
        { key: "veg", spec: { keywords: VEG, quantity: 1, unit: null, optional: true } },
      ],
      steps: (p, picks) => [
        `Cook the ${p.toLowerCase()} until done${picks.get("veg") ? ` with the ${picks.get("veg")!.name.toLowerCase()}` : ""}.`,
        `Spoon into warm ${picks.get("bread")?.name.toLowerCase() ?? "wraps"}${picks.get("cheese") ? ` with the ${picks.get("cheese")!.name.toLowerCase()}` : ""}.`,
        "Roll up and serve right away.",
      ],
    },
    {
      name: (p, picks) => `${p} plate${picks.get("fruit") ? ` with ${picks.get("fruit")!.name.toLowerCase()}` : ""}`,
      slots: [
        { key: "fruit", spec: { keywords: FRUIT, quantity: 2, unit: null, optional: true } },
        { key: "bread", spec: { keywords: BREAD, quantity: 4, unit: "Slices", optional: true } },
        { key: "potato", spec: { keywords: POTATO, quantity: 4, unit: null, optional: true } },
      ],
      steps: (p, picks) => [
        `Cook the ${p.toLowerCase()} the way you like it.`,
        picks.get("potato")
          ? `Crisp the ${picks.get("potato")!.name.toLowerCase()} alongside.`
          : "Warm the plates while it cooks.",
        `Plate it up${picks.get("bread") ? ` with the ${picks.get("bread")!.name.toLowerCase()} toasted` : ""}${picks.get("fruit") ? ` and the ${picks.get("fruit")!.name.toLowerCase()} on the side` : ""}.`,
      ],
    },
  ],
  snack: [
    {
      name: (p, picks) => `${p} bites${picks.get("sauce") ? ` with ${picks.get("sauce")!.name.toLowerCase()}` : ""}`,
      slots: [
        { key: "sauce", spec: { keywords: SAUCE, quantity: 0.5, unit: "Cup", optional: true } },
        { key: "bread", spec: { keywords: BREAD, quantity: 2, unit: null, optional: true } },
      ],
      steps: (p, picks) => [
        `Cook the ${p.toLowerCase()} until done and cut it into bite-size pieces.`,
        picks.get("sauce")
          ? `Serve with the ${picks.get("sauce")!.name.toLowerCase()} for dipping${picks.get("bread") ? ` and the ${picks.get("bread")!.name.toLowerCase()} on the side` : ""}.`
          : "Serve hot with your favourite dip.",
      ],
    },
    {
      name: (p, picks) => `Loaded ${p.toLowerCase()}${picks.get("potato") ? ` ${picks.get("potato")!.name.toLowerCase()}` : ""}`,
      slots: [
        { key: "potato", spec: { keywords: POTATO, quantity: 1, unit: "Bag", optional: true } },
        { key: "cheese", spec: { keywords: CHEESE, quantity: 0.5, unit: "Cup", optional: true } },
        { key: "sauce", spec: { keywords: ["sour cream", "salsa", "guac", "hummus"], quantity: 0.5, unit: "Cup", optional: true } },
      ],
      steps: (p, picks) => [
        picks.get("potato")
          ? `Cook the ${picks.get("potato")!.name.toLowerCase()} until crisp.`
          : "Pick a sturdy base from the cupboard and warm it through.",
        `Cook the ${p.toLowerCase()} and chop it over the top.`,
        `Finish with ${[picks.get("cheese")?.name.toLowerCase(), picks.get("sauce")?.name.toLowerCase()].filter(Boolean).join(" and ") || "a sprinkle of seasoning"} and serve.`,
      ],
    },
    {
      name: (p, _picks) => `${p} snack plate`,
      slots: [
        { key: "veg", spec: { keywords: VEG, quantity: 2, unit: null, optional: true } },
        { key: "fruit", spec: { keywords: FRUIT, quantity: 2, unit: null, optional: true } },
        { key: "bread", spec: { keywords: BREAD, quantity: 2, unit: null, optional: true } },
      ],
      steps: (p, picks) => [
        `Cook or slice the ${p.toLowerCase()} so it's easy to pick up.`,
        `Arrange it on a plate${[picks.get("veg")?.name.toLowerCase(), picks.get("fruit")?.name.toLowerCase(), picks.get("bread")?.name.toLowerCase()].filter(Boolean).length > 0 ? ` with the ${[picks.get("veg")?.name.toLowerCase(), picks.get("fruit")?.name.toLowerCase(), picks.get("bread")?.name.toLowerCase()].filter(Boolean).join(", ")}` : ""}.`,
        "Put it in the middle of the table and let everyone graze.",
      ],
    },
  ],
};

// ---- BIT (Business Inventory Tracker) shared shapes/helpers --------
// The BIT side's data lives in its own bit_* tables and never touches
// the household (HIT) tables above.

// Food & beverage oriented business types — every setup type except
// Retail Store and Other. Only these businesses get freezer checks.
const BIT_FOOD_AND_BEVERAGE_TYPES = new Set([
  "Ice Cream Shop",
  "Café / Coffee Shop",
  "Restaurant",
  "Bar / Pub",
  "Bakery",
  "Food Truck",
]);

function isBitFoodAndBeverageType(type: string): boolean {
  return BIT_FOOD_AND_BEVERAGE_TYPES.has(type);
}

// ---- Business-type needs profiles (Alpha 0.75) -------------------
// Researched per business type (Nov 14, 2026): each type chosen in
// the setup questionnaire carries a needs profile that switches
// on the inventory features that type uniquely needs — expiry
// tracking for perishable-heavy types (Ice Cream Shop, Restaurant,
// Bakery, Café / Coffee Shop, Food Truck), a waste log for
// Restaurants (buffet / all-you-can-eat spoilage), and fractional
// (tenths) counting for Bars / Pubs (open bottles and kegs counted
// by fill level). The profile is keyed off the business's STORED
// type, so it applies to every business created from a
// questionnaire type — including ones set up before this build
// (The Daily Scoop, an Ice Cream Shop, gains expiry tracking) —
// while a custom business (type "Other")
// gets the empty profile and is completely unchanged. Freezer
// temperature checks predate the profiles and keep their existing
// food-&-beverage rule above. The client keeps the matching
// profile text (the setup review note) in bitPacks.ts.
interface BitNeedsProfile {
  expiryTracking: boolean;
  wasteLog: boolean;
  fractionalCounting: boolean;
}

const BIT_NEEDS_PROFILES: Record<string, BitNeedsProfile> = {
  "Ice Cream Shop": {
    expiryTracking: true,
    wasteLog: false,
    fractionalCounting: false,
  },
  Restaurant: {
    expiryTracking: true,
    wasteLog: true,
    fractionalCounting: false,
  },
  Bakery: {
    expiryTracking: true,
    wasteLog: false,
    fractionalCounting: false,
  },
  "Café / Coffee Shop": {
    expiryTracking: true,
    wasteLog: false,
    fractionalCounting: false,
  },
  "Bar / Pub": {
    expiryTracking: false,
    wasteLog: false,
    fractionalCounting: true,
  },
  "Food Truck": {
    expiryTracking: true,
    wasteLog: false,
    fractionalCounting: false,
  },
};

const BIT_NO_NEEDS: BitNeedsProfile = {
  expiryTracking: false,
  wasteLog: false,
  fractionalCounting: false,
};

function bitNeedsProfileFor(type: string): BitNeedsProfile {
  return BIT_NEEDS_PROFILES[type] ?? BIT_NO_NEEDS;
}

/** Rounds a count the way the business's profile counts: to the
    nearest tenth for fractional-counting businesses (Bar / Pub),
    to a whole number for everyone else — whole-number behaviour
    is byte-for-byte what it was before profiles existed. */
function bitRoundCount(profile: BitNeedsProfile, value: number): number {
  return profile.fractionalCounting
    ? Math.round(value * 10) / 10
    : Math.round(value);
}

const bitItemShape = z.object({
  id: z.number(),
  name: z.string(),
  category: z.string(),
  zone: z.string(),
  onHand: z.number(),
  unit: z.string(),
  par: z.number(),
  packSize: z.number(),
  supplier: z.string().nullable(),
  sku: z.string().nullable(),
  // Optional expiry date ("YYYY-MM-DD") — set only on businesses
  // whose needs profile includes expiry tracking; null otherwise.
  expiryDate: z.string().nullable(),
  tags: z.array(z.string()),
  // This item's own last-counted stamp (Beta 0.06 batch, audit
  // #16): the newest check snapshot's time for this item (ISO),
  // from bit_item_snapshots; null when no finished check has ever
  // counted it. Filled by getBitState; bitRowToItem leaves null.
  lastCountedAt: z.string().nullable(),
});

const bitWasteLogShape = z.object({
  id: z.number(),
  itemId: z.number().nullable(),
  itemName: z.string(),
  unit: z.string(),
  quantity: z.number(),
  reason: z.enum(["Spoilage", "Expired", "Breakage", "Other"]),
  createdAt: z.string(),
  // Undo coverage (audit #5): true once undoBitWaste has
  // restored the entry's stock and retired the entry.
  undone: z.boolean(),
  // Attribution + policy (audit #5, Primary vs Connected).
  ...undoMetaShape.shape,
});

const bitStockEventShape = z.object({
  id: z.number(),
  itemId: z.number().nullable(),
  itemName: z.string(),
  // The signed change the Inventory-tab count edit applied.
  delta: z.number(),
  createdAt: z.string(),
  undone: z.boolean(),
  // Attribution + policy (audit #5, Primary vs Connected).
  ...undoMetaShape.shape,
});

const bitManifestImportShape = z.object({
  id: z.number(),
  scanId: z.number().nullable(),
  // Item names the import added (new items) vs set the count of
  // (existing items) — the record its Undo reverts.
  addedNames: z.array(z.string()),
  updatedNames: z.array(z.string()),
  createdAt: z.string(),
  undone: z.boolean(),
  // Attribution + policy (audit #5, Primary vs Connected).
  ...undoMetaShape.shape,
});

const bitManifestLineShape = z.object({
  name: z.string(),
  cat: z.string(),
  count: z.number(),
  unit: z.string(),
  par: z.number().nullable(),
  supplier: z.string(),
});

const bitManifestLineRequest = z.object({
  name: z.string().min(1).max(200),
  cat: z.string().max(120),
  count: z.number().int().min(0).max(100000),
  unit: z.string().min(1).max(60),
  par: z.number().int().min(0).max(100000).nullable(),
  supplier: z.string().max(200),
});

const bitFreezerReadingShape = z.object({
  freezer: z.string(),
  tempC: z.number().nullable(),
  alert: z.boolean(),
});

const bitVarianceShape = z.object({
  item: z.string(),
  book: z.number(),
  counted: z.number(),
});

// ---- Requisitions (Alpha 0.71) -------------------------------------
// Applied to businesses with uses_requisition set (chosen in the
// setup wizard). The preparer takes the business's inventory,
// lists replenishment needs on a requisition in the form's order
// sequence (Medical first, then Stationery — the business's Office
// Supplies — then General items), signs it, the approver reviews
// and signs, and it goes to the supplier. The supplier fills as
// stock allows and returns the supplies with the marked
// requisition; the preparer checks off each item received and
// remarks items not received. Items NOT received are never
// back-ordered — they are resubmitted on a subsequent requisition.

const bitRequisitionLineShape = z.object({
  id: z.number(),
  itemId: z.number().nullable(),
  name: z.string(),
  materialNo: z.string().nullable(),
  qtyOrdered: z.number(),
  unit: z.string(),
  category: z.string(),
  status: z.enum(["pending", "received", "not_received"]),
  qtyReceived: z.number().nullable(),
  // Attribution + policy (audit #5, Primary vs Connected) for
  // the line's check-off: who checked it off (null while
  // pending), whether requisition check-offs are set Permanent,
  // and whether the current role may undo the check-off.
  ...undoMetaShape.shape,
});

const bitRequisitionShape = z.object({
  id: z.number(),
  reqNo: z.string(),
  status: z.enum(["outstanding", "closed"]),
  // Approver separation (audit #15): who prepared it (the
  // preparer) and who approved it (the approver), with the
  // dates each was recorded — snapshotted at send time. Null on
  // requisitions sent before the approver step existed.
  preparedBy: z.string().nullable(),
  preparedAt: z.string().nullable(),
  approvedBy: z.string().nullable(),
  approvedAt: z.string().nullable(),
  sentAt: z.string(),
  closedAt: z.string().nullable(),
  lines: z.array(bitRequisitionLineShape),
});

const bitCatalogueShape = z.object({
  id: z.number(),
  materialNo: z.string(),
  description: z.string(),
});

const bitDraftExtraShape = z.object({
  id: z.number(),
  catalogueId: z.number(),
  name: z.string(),
  materialNo: z.string().nullable(),
  qty: z.number(),
  unit: z.string(),
});

/** The requisition order sequence rank for a category: Medical supplies
    first, then Stationery (Office Supplies), then Cleaning
    supplies (general), then everything else. */
function bitReqCategoryRank(category: string): number {
  const c = category.trim().toLowerCase();
  if (c === "medical") return 0;
  if (c === "office supplies" || c === "stationery" || c === "stationary")
    return 1;
  if (c === "cleaning supplies") return 2;
  return 3;
}

/** The short code from the business name (its first 2–4 digit
    run, or "B" + the business id); the requisition number is built
    from it. */
function bitReqCode(biz: BitBusinessRow): string {
  const m = biz.name.match(/(\d{2,4})/);
  return m?.[1] ?? `B${biz.id}`;
}

/** Requisition number in the form's format: <code>-YY-MM-DD,
    dated in America/Toronto (the app's default timezone). */
function bitReqNo(biz: BitBusinessRow, at: Date): string {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/Toronto",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(at);
  const get = (t: string) => parts.find((p) => p.type === t)?.value ?? "";
  const yy = get("year").slice(-2);
  return `${bitReqCode(biz)}-${yy}-${get("month")}-${get("day")}`;
}

/** Item rows on one page of the requisition form. */
const REQ_FORM_LINES_PER_PAGE = 20;

const bitRequisitionFormPdfResponse = z.object({
  ok: z.boolean(),
  filename: z.string().nullable(),
  pdfBase64: z.string().nullable(),
  pageCount: z.number().int(),
  error: z.string().nullable(),
});

// ---- Pre-filled requisition form scan --------------------------------
// Some businesses keep a requisition form already filled in: the
// user uploads that file — a filled-in copy of the requisition
// form (PDF) — or a photo of the paper form, and
// scanBitRequisitionForm reads the lines off it and
// cross-references each one against the business's inventory list
// (the manifest). Nothing is recorded by
// the scan: the Requisition tab reviews the matches and the user
// chooses which ones go onto the requisition being built.

interface ScannedReqFormLine {
  name: string;
  qty: number | null;
  unit: string | null;
  materialNo: string | null;
}

interface ScannedReqForm {
  division: string | null;
  preparerName: string | null;
  approverName: string | null;
  lines: ScannedReqFormLine[];
}

/**
 * Read the lines off a filled-in copy of the requisition form
 * itself: the form is fillable, so a copy filled in and saved (not
 * printed / flattened) still carries its values in the form
 * fields — the same field names buildReqFormPdf writes. Returns
 * null when the PDF can't be read or carries no filled line rows
 * (e.g. a flattened scan of a paper form — the photo path covers
 * that).
 */
async function extractReqFormPdfLines(
  bytes: Uint8Array,
): Promise<ScannedReqForm | null> {
  let doc: PDFDocument;
  try {
    doc = await PDFDocument.load(bytes, { ignoreEncryption: true });
  } catch {
    return null;
  }
  let form: ReturnType<PDFDocument["getForm"]>;
  try {
    form = doc.getForm();
  } catch {
    // Not a form-bearing PDF at all (or not really a PDF).
    return null;
  }
  const read = (field: string): string => {
    try {
      return form.getTextField(field).getText()?.trim() ?? "";
    } catch {
      return "";
    }
  };
  // The generic form names its fields per page (page 2+ carry a
  // "_p2", "_p3", ... suffix, so every page's fields stay unique
  // in one document); read every page in order.
  const lines: ScannedReqFormLine[] = [];
  for (let pg = 0; pg < doc.getPageCount(); pg++) {
    const suffix = pg === 0 ? "" : `_p${pg + 1}`;
    for (let n = 1; n <= REQ_FORM_LINES_PER_PAGE; n++) {
      const name = read(`${n}${suffix}`);
      if (!name) continue;
      const qtyNum = Number.parseInt(read(`Qty${n}${suffix}`), 10);
      lines.push({
        name,
        qty: Number.isFinite(qtyNum) && qtyNum > 0 ? qtyNum : null,
        unit: read(`Unit${n}${suffix}`) || null,
        materialNo: read(`Material ${n}${suffix}`) || null,
      });
    }
  }
  if (lines.length === 0) return null;
  return {
    division: read("Division") || null,
    preparerName: read("Prepared by") || null,
    approverName: read("Approved by") || null,
    lines,
  };
}

/** The shape the photo reader returns for one form photo. */
const reqFormPhotoExtraction = z.object({
  division: z.string().nullable(),
  preparerName: z.string().nullable(),
  approverName: z.string().nullable(),
  lines: z.array(
    z.object({
      name: z.string(),
      qty: z.number().nullable(),
      unit: z.string().nullable(),
      materialNo: z.string().nullable(),
    }),
  ),
});

function normalizeFormMatchText(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
}

function formMatchDigits(s: string | null | undefined): string {
  return (s ?? "").replace(/\D+/g, "");
}

/**
 * Word-based name matching, mirroring the client's
 * bitItemMatchesSearch: every word of the scanned name must match
 * a word of the item's name as a prefix, tolerating singular /
 * plural differences ("ice pack" matches "Ice packs"); a plain
 * containment of one full normalized name in the other also
 * matches.
 */
function scannedWordsMatchItem(
  scannedName: string,
  itemName: string,
): boolean {
  const q = normalizeFormMatchText(scannedName);
  const hay = normalizeFormMatchText(itemName);
  if (!q || !hay) return false;
  if (hay.includes(q) || q.includes(hay)) return true;
  const nameTokens = hay.split(" ").filter(Boolean);
  const queryTokens = q.split(" ").filter(Boolean);
  if (queryTokens.length === 0) return false;
  return queryTokens.every((qt) =>
    nameTokens.some((nt) => {
      if (nt.length < 2 || qt.length < 2) return nt === qt;
      const forms = [qt, `${qt}s`, `${qt}es`];
      if (qt.endsWith("s")) forms.push(qt.slice(0, -1));
      return forms.some((f) => nt.startsWith(f) || f.startsWith(nt));
    }),
  );
}

type BitItemRowForScan = typeof schema.bitItems.$inferSelect;

/**
 * Cross-reference one scanned form line against the station's
 * inventory list. A Material # match wins (the number is the
 * form's own identifier), then an exact name match, then the
 * word-based match. A match is only returned when it is
 * unambiguous — exactly one item qualifies at the winning level;
 * anything else is left unmatched rather than guessed.
 */
function matchScannedReqLine(
  line: ScannedReqFormLine,
  items: BitItemRowForScan[],
): { item: BitItemRowForScan; kind: "material" | "name" | "words" } | null {
  const mat = formMatchDigits(line.materialNo);
  if (mat) {
    const byMat = items.filter((it) => formMatchDigits(it.sku) === mat);
    if (byMat.length === 1 && byMat[0])
      return { item: byMat[0], kind: "material" };
    if (byMat.length > 1) return null;
  }
  const target = normalizeFormMatchText(line.name);
  if (!target) return null;
  const byName = items.filter(
    (it) => normalizeFormMatchText(it.name) === target,
  );
  if (byName.length === 1 && byName[0])
    return { item: byName[0], kind: "name" };
  if (byName.length > 1) return null;
  const byWords = items.filter((it) =>
    scannedWordsMatchItem(line.name, it.name),
  );
  if (byWords.length === 1 && byWords[0])
    return { item: byWords[0], kind: "words" };
  return null;
}

const bitRequisitionFormScanResponse = z.object({
  ok: z.boolean(),
  error: z.string().nullable(),
  // How the form was read: its own fillable fields ("pdf") or a
  // photo read by the model ("photo"). Null when nothing was read.
  source: z.enum(["pdf", "photo"]).nullable(),
  header: z
    .object({
      division: z.string().nullable(),
      preparerName: z.string().nullable(),
      approverName: z.string().nullable(),
    })
    .nullable(),
  lines: z.array(
    z.object({
      scannedName: z.string(),
      qty: z.number().int().nullable(),
      unit: z.string().nullable(),
      materialNo: z.string().nullable(),
      matchedItemId: z.number().nullable(),
      matchedName: z.string().nullable(),
      matchedMaterialNo: z.string().nullable(),
      matchedCategory: z.string().nullable(),
      matchedUnit: z.string().nullable(),
      matchedOnHand: z.number().nullable(),
      matchKind: z.enum(["material", "name", "words"]).nullable(),
    }),
  ),
});

type BitRequisitionRow = typeof schema.bitRequisitions.$inferSelect;
type BitRequisitionLineRow =
  typeof schema.bitRequisitionLines.$inferSelect;

function bitRequisitionToShape(
  req: BitRequisitionRow,
  lines: BitRequisitionLineRow[],
  settings: { role: ActorRole; policy: UndoPolicy },
): z.infer<typeof bitRequisitionShape> {
  return {
    id: req.id,
    reqNo: req.reqNo,
    status: req.status,
    preparedBy: req.preparedBy,
    preparedAt: req.preparedAt?.toISOString() ?? null,
    approvedBy: req.approvedBy,
    approvedAt: req.approvedAt?.toISOString() ?? null,
    sentAt: req.sentAt.toISOString(),
    closedAt: req.closedAt?.toISOString() ?? null,
    lines: lines
      .filter((l) => l.requisitionId === req.id)
      .sort(
        (a, b) =>
          bitReqCategoryRank(a.category) - bitReqCategoryRank(b.category) ||
          a.id - b.id,
      )
      .map((l) => ({
        id: l.id,
        itemId: l.itemId,
        name: l.name,
        materialNo: l.materialNo,
        qtyOrdered: l.qtyOrdered,
        unit: l.unit,
        category: l.category,
        status: l.status,
        qtyReceived: l.qtyReceived,
        ...undoMeta(
          settings,
          "requisitionCheckOffs",
          l.checkedOffBy,
          l.status === "pending",
        ),
      })),
  };
}


function bitParseStringArray(json: string | null | undefined): string[] {
  if (!json) return [];
  try {
    const parsed: unknown = JSON.parse(json);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((v): v is string => typeof v === "string");
  } catch {
    return [];
  }
}

function bitParseColors(
  json: string | null | undefined,
): Record<string, string> {
  if (!json) return {};
  try {
    const parsed: unknown = JSON.parse(json);
    if (typeof parsed !== "object" || parsed === null) return {};
    const out: Record<string, string> = {};
    for (const [k, v] of Object.entries(parsed)) {
      if (typeof v === "string") out[k] = v;
    }
    return out;
  } catch {
    return {};
  }
}

function bitParseManifestLines(
  json: string | null | undefined,
): z.infer<typeof bitManifestLineShape>[] {
  if (!json) return [];
  try {
    const parsed: unknown = JSON.parse(json);
    if (!Array.isArray(parsed)) return [];
    return parsed
      .filter(
        (l): l is Record<string, unknown> =>
          typeof l === "object" && l !== null,
      )
      .map((l) => ({
        name: typeof l.name === "string" ? l.name : "",
        cat: typeof l.cat === "string" ? l.cat : "",
        count:
          typeof l.count === "number" && Number.isFinite(l.count)
            ? Math.max(0, Math.round(l.count))
            : 0,
        unit: typeof l.unit === "string" && l.unit ? l.unit : "units",
        par:
          typeof l.par === "number" && Number.isFinite(l.par)
            ? Math.max(0, Math.round(l.par))
            : null,
        supplier: typeof l.supplier === "string" ? l.supplier : "",
      }))
      .filter((l) => l.name.length > 0);
  } catch {
    return [];
  }
}

/** One recorded change of a manifest import (bit_manifest_imports
    .changes_json): the item the import touched, whether the
    import created it, and — for items it already found — the
    on-hand from before the import set it. */
type BitManifestImportChange = {
  name: string;
  itemId: number | null;
  added: boolean;
  priorOnHand: number | null;
};

function bitParseManifestImportChanges(
  json: string | null | undefined,
): BitManifestImportChange[] {
  if (!json) return [];
  try {
    const parsed: unknown = JSON.parse(json);
    if (!Array.isArray(parsed)) return [];
    return parsed
      .filter(
        (c): c is Record<string, unknown> =>
          typeof c === "object" && c !== null,
      )
      .map((c) => ({
        name: typeof c.name === "string" ? c.name : "",
        itemId:
          typeof c.itemId === "number" && Number.isFinite(c.itemId)
            ? c.itemId
            : null,
        added: c.added === true,
        priorOnHand:
          typeof c.priorOnHand === "number" &&
          Number.isFinite(c.priorOnHand)
            ? c.priorOnHand
            : null,
      }))
      .filter((c) => c.name.length > 0);
  } catch {
    return [];
  }
}

function bitParseVariances(
  json: string | null | undefined,
): z.infer<typeof bitVarianceShape>[] {
  if (!json) return [];
  try {
    const parsed: unknown = JSON.parse(json);
    if (!Array.isArray(parsed)) return [];
    return parsed
      .filter(
        (v): v is Record<string, unknown> =>
          typeof v === "object" && v !== null,
      )
      .map((v) => ({
        item: typeof v.item === "string" ? v.item : "",
        book: typeof v.book === "number" ? v.book : 0,
        counted: typeof v.counted === "number" ? v.counted : 0,
      }))
      .filter((v) => v.item.length > 0);
  } catch {
    return [];
  }
}

function bitParseFreezerReadings(
  json: string | null | undefined,
): z.infer<typeof bitFreezerReadingShape>[] {
  if (!json) return [];
  try {
    const parsed: unknown = JSON.parse(json);
    if (!Array.isArray(parsed)) return [];
    return parsed
      .filter(
        (f): f is Record<string, unknown> =>
          typeof f === "object" && f !== null,
      )
      .map((f) => {
        const tempC =
          typeof f.tempC === "number" && Number.isFinite(f.tempC)
            ? f.tempC
            : null;
        return {
          freezer: typeof f.freezer === "string" ? f.freezer : "",
          tempC,
          alert: tempC != null && tempC > -18,
        };
      })
      .filter((f) => f.freezer.length > 0);
  } catch {
    return [];
  }
}

type BitItemRow = typeof schema.bitItems.$inferSelect;
type BitBusinessRow = typeof schema.bitBusiness.$inferSelect;

/**
 * The business's categories — the ONLY organizing concept in BIT.
 * Categories are the groups picked in the setup questionnaire plus
 * any added later with Add Category. Businesses set up under the
 * earlier category-or-zone choice keep their existing groups as
 * their categories: for a business organized by its (former)
 * zones, the stored zone list IS its category list, and each
 * item's group is its stored zone value; for one organized by
 * category, the stored category list and values are used as-is.
 * Stored rows are never rewritten by this mapping — it only
 * decides which stored list/field the app reads as "category".
 */
function bitBusinessCategories(biz: BitBusinessRow): string[] {
  return biz.organizeBy === "category"
    ? bitParseStringArray(biz.categoriesJson)
    : bitParseStringArray(biz.zonesJson);
}

function bitRowGroup(r: BitItemRow, biz: BitBusinessRow | undefined): string {
  return biz?.organizeBy === "category" ? r.category : r.zone;
}

// ---- Multiple businesses (Alpha 0.69) ------------------------------
// BIT holds more than one business. Every BIT record carries a
// business_id; actions take an optional businessId and fall back to
// the first business (lowest id) when it is absent, so calls made
// before the switcher existed behave exactly as they did with one
// business. The Daily Scoop seed below is the Ice Cream Shop
// starter pack from the BIT demo (client bitPacks.ts), copied here
// so seedDailyScoopBusiness can create that sample business
// server-side; it is used ONLY by that explicit seed action.

const bitBusinessIdRequest = z
  .number()
  .int()
  .positive()
  .nullable()
  .optional();

async function resolveBitBusiness(
  ctx: Ctx,
  businessId?: number | null,
): Promise<BitBusinessRow | undefined> {
  const db = ctx.db<typeof schema>();
  const rows = await db
    .select()
    .from(schema.bitBusiness)
    .orderBy(asc(schema.bitBusiness.id));
  if (businessId != null) {
    return rows.find((r) => r.id === businessId);
  }
  return rows[0];
}

const DAILY_SCOOP_CATEGORIES = [
  "Ice Cream Tubs & Flavours",
  "Cones & Wafers",
  "Toppings & Sauces",
  "Dairy & Ingredients",
  "Cups, Spoons & Packaging",
  "Cleaning & Sanitation",
  "Scoop Station",
  "Front Counter",
  "Freezer Room",
  "Dry Storage",
];

const DAILY_SCOOP_COLORS: Record<string, string> = {
  "Ice Cream Tubs & Flavours": "#538d66",
  "Cones & Wafers": "#a18449",
  "Toppings & Sauces": "#5d7d9d",
  "Dairy & Ingredients": "#b0614f",
  "Cups, Spoons & Packaging": "#876da1",
  "Cleaning & Sanitation": "#478a81",
};

// [name, category, onHand, unit, par, supplier, sku, tags]
const DAILY_SCOOP_ITEMS: [
  string,
  string,
  number,
  string,
  number,
  string,
  string,
  string[],
][] = [
  ["Vanilla Bean — 11 L tub", "Ice Cream Tubs & Flavours", 4, "11 L tubs", 3, "Scoop Wholesale Co.", "SW-VB-11", ["Gluten-free"]],
  ["Chocolate Fudge — 11 L tub", "Ice Cream Tubs & Flavours", 3, "11 L tubs", 3, "Scoop Wholesale Co.", "SW-CF-11", ["Gluten-free"]],
  ["Strawberry — 11 L tub", "Ice Cream Tubs & Flavours", 2, "11 L tubs", 3, "Scoop Wholesale Co.", "SW-ST-11", ["Gluten-free"]],
  ["Mint Chocolate Chip — 11 L tub", "Ice Cream Tubs & Flavours", 5, "11 L tubs", 3, "Scoop Wholesale Co.", "SW-MC-11", []],
  ["Pistachio — 11 L tub", "Ice Cream Tubs & Flavours", 1, "11 L tubs", 2, "Scoop Wholesale Co.", "SW-PI-11", ["Contains nuts"]],
  ["Peanut Butter Swirl — 11 L tub", "Ice Cream Tubs & Flavours", 2, "11 L tubs", 2, "Scoop Wholesale Co.", "SW-PB-11", ["Contains nuts"]],
  ["Cookies & Cream — 11 L tub", "Ice Cream Tubs & Flavours", 4, "11 L tubs", 3, "Scoop Wholesale Co.", "SW-CC-11", ["Contains gluten"]],
  ["Mango Sorbet — 11 L tub", "Ice Cream Tubs & Flavours", 3, "11 L tubs", 2, "Scoop Wholesale Co.", "SW-MS-11", ["Dairy-free", "Gluten-free"]],
  ["Salted Caramel — 11 L tub", "Ice Cream Tubs & Flavours", 2, "11 L tubs", 2, "Scoop Wholesale Co.", "SW-SC-11", ["Seasonal"]],
  ["Pumpkin Spice — 11 L tub", "Ice Cream Tubs & Flavours", 1, "11 L tubs", 2, "Scoop Wholesale Co.", "SW-PS-11", ["Seasonal"]],
  ["Sugar cones", "Cones & Wafers", 2, "cases of 200", 3, "Cone & Wafer Supply", "CW-SC-200", []],
  ["Waffle cones, large", "Cones & Wafers", 3, "cases of 120", 3, "Cone & Wafer Supply", "CW-WC-120", ["Contains gluten"]],
  ["Cake cones", "Cones & Wafers", 5, "cases of 240", 3, "Cone & Wafer Supply", "CW-CC-240", ["Contains gluten"]],
  ["Waffle bowls", "Cones & Wafers", 1, "cases of 60", 2, "Cone & Wafer Supply", "CW-WB-60", ["Contains gluten"]],
  ["Hot fudge sauce", "Toppings & Sauces", 4, "3 L jugs", 3, "Scoop Wholesale Co.", "SW-HF-3L", []],
  ["Caramel sauce", "Toppings & Sauces", 2, "3 L jugs", 3, "Scoop Wholesale Co.", "SW-CS-3L", []],
  ["Rainbow sprinkles", "Toppings & Sauces", 3, "kg", 2, "Scoop Wholesale Co.", "SW-RS-KG", ["Gluten-free"]],
  ["Crushed peanuts", "Toppings & Sauces", 1, "kg", 2, "Scoop Wholesale Co.", "SW-CP-KG", ["Contains nuts"]],
  ["Chocolate chips", "Toppings & Sauces", 4, "kg", 3, "Scoop Wholesale Co.", "SW-CH-KG", []],
  ["Maraschino cherries", "Toppings & Sauces", 2, "jars", 2, "Scoop Wholesale Co.", "SW-MC-JR", []],
  ["Whipping cream", "Dairy & Ingredients", 3, "1 L cartons", 6, "Dairyland Direct", "DD-WC-1L", []],
  ["Whole milk 4 L", "Dairy & Ingredients", 3, "jugs", 6, "Dairyland Direct", "DD-WM-4L", []],
  ["Sweetened condensed milk", "Dairy & Ingredients", 6, "cans", 4, "Dairyland Direct", "DD-CM-CN", []],
  ["Small cups, 4 oz", "Cups, Spoons & Packaging", 340, "cups", 250, "PackRight", "PR-SC-04", []],
  ["Large cups, 8 oz", "Cups, Spoons & Packaging", 180, "cups", 250, "PackRight", "PR-LC-08", []],
  ["Tasting spoons", "Cups, Spoons & Packaging", 900, "spoons", 500, "PackRight", "PR-TS-01", []],
  ["Sundae spoons", "Cups, Spoons & Packaging", 420, "spoons", 300, "PackRight", "PR-SS-01", []],
  ["Pint take-home tubs + lids", "Cups, Spoons & Packaging", 64, "tubs", 50, "PackRight", "PR-PT-16", []],
  ["Paper napkins", "Cups, Spoons & Packaging", 9, "packs", 6, "PackRight", "PR-NP-05", []],
  ["Sanitizer spray", "Cleaning & Sanitation", 2, "bottles", 3, "Costco Business Centre", "CBC-SS-750", []],
  ["Food-safe surface wipes", "Cleaning & Sanitation", 3, "canisters", 3, "Costco Business Centre", "CBC-FW-01", []],
  ["Dish soap, commercial", "Cleaning & Sanitation", 2, "4 L jugs", 2, "Costco Business Centre", "CBC-DS-4L", []],
  ["Disposable gloves, food prep", "Cleaning & Sanitation", 1, "boxes of 100", 3, "Costco Business Centre", "CBC-GL-100", []],
  ["Paper towel rolls", "Cleaning & Sanitation", 13, "rolls", 10, "Costco Business Centre", "CBC-PT-06", []],
];

// ---- BIT Sim 01 (Alpha 0.76) ---------------------------------------
// The 12-month ice-cream-shop simulation the user commissioned
// (Dec 2025 – Nov 2026, recorded as "BIT Sim 01"). seedBitSim01
// loads it into The Daily Scoop: the shop's inventory becomes the
// sim's 23 stock items at their closing counts (Nov 30, 2026),
// and the sim's monthly results, annual menu results and summary
// figures become the business's analytics dataset (the Analytics
// tab computes every statistic it shows from those rows).

const SIM01_CATEGORIES = [
  "Ice Cream Tubs",
  "Cones & Cups",
  "Toppings & Sauces",
  "Dairy & Fresh",
  "Retail",
  "Supplies",
];

const SIM01_COLORS: Record<string, string> = {
  "Ice Cream Tubs": "#538d66",
  "Cones & Cups": "#a18449",
  "Toppings & Sauces": "#5d7d9d",
  "Dairy & Fresh": "#b0614f",
  Retail: "#876da1",
  Supplies: "#478a81",
};

// [name, category, par, onHand (closing count, Nov 30 2026), unit,
//  unit cost $] — the unit costs are the sim's cost model; the
// Analytics tab values the live inventory with them.
const SIM01_ITEMS: [string, string, number, number, string, number][] = [
  ["Vanilla Bean Tub 11.4L", "Ice Cream Tubs", 6, 5.8, "tubs", 45.3],
  ["Chocolate Fudge Tub 11.4L", "Ice Cream Tubs", 6, 5.8, "tubs", 45.3],
  ["Strawberry Tub 11.4L", "Ice Cream Tubs", 5, 4.7, "tubs", 45.3],
  ["Mint Chocolate Chip Tub 11.4L", "Ice Cream Tubs", 5, 4.9, "tubs", 45.3],
  ["Cookies & Cream Tub 11.4L", "Ice Cream Tubs", 6, 5.9, "tubs", 45.3],
  ["Salted Caramel Tub 11.4L", "Ice Cream Tubs", 5, 4.9, "tubs", 45.3],
  ["Mango Sorbet Tub 11.4L", "Ice Cream Tubs", 4, 3.8, "tubs", 45.3],
  ["Pistachio Tub 11.4L", "Ice Cream Tubs", 3, 2.8, "tubs", 45.3],
  ["Waffle Cones", "Cones & Cups", 600, 574, "cones", 0.35],
  ["Sugar Cones", "Cones & Cups", 500, 482, "cones", 0.28],
  ["Paper Cups", "Cones & Cups", 800, 776, "cups", 0.09],
  ["Chocolate Sauce 3L", "Toppings & Sauces", 8, 8, "bottles", 16],
  ["Caramel Sauce 3L", "Toppings & Sauces", 8, 8, "bottles", 16],
  ["Sprinkles 2kg", "Toppings & Sauces", 6, 6, "bags", 14],
  ["Crushed Peanuts 2kg", "Toppings & Sauces", 5, 5, "bags", 13],
  ["Maraschino Cherries", "Toppings & Sauces", 6, 6, "jars", 11],
  ["Whipped Cream", "Toppings & Sauces", 16, 16, "cans", 4.25],
  ["Milk 4L", "Dairy & Fresh", 12, 11, "jugs", 5.75],
  ["Bananas", "Dairy & Fresh", 120, 112, "bananas", 0.65],
  ["Retail Tubs 1L", "Retail", 80, 78, "tubs", 5.5],
  ["Napkins", "Supplies", 20, 19, "packs", 6.5],
  ["Spoons", "Supplies", 10, 9, "boxes", 5],
  ["Straws", "Supplies", 8, 8, "boxes", 4.5],
];

// [monthKey, label, daysOpen, transactions, unitsSold, revenue,
//  cogs, wasteCost, grossProfit, netProfit, ordersPlaced,
//  stockoutEvents, endingInventoryValue]
const SIM01_MONTHS: [
  string, string, number, number, number, number, number, number,
  number, number, number, number, number,
][] = [
  ["2025-12", "Dec 2025", 26, 970, 1303, 8443.75, 2076.37, 199.91, 6167.48, -4312.52, 5, 0, 3434.41],
  ["2026-01", "Jan 2026", 27, 796, 1074, 6980.75, 1724.18, 198.01, 5058.56, -5421.44, 5, 0, 3426.06],
  ["2026-02", "Feb 2026", 24, 840, 1136, 7365.75, 1809.56, 160.78, 5395.41, -5084.59, 4, 0, 3210.53],
  ["2026-03", "Mar 2026", 26, 1430, 1925, 12224.5, 2927.39, 202.27, 9094.84, -1385.16, 5, 0, 3375.6],
  ["2026-04", "Apr 2026", 26, 2199, 2963, 18821.5, 4501.6, 75.06, 14244.84, 3764.84, 5, 0, 3329.17],
  ["2026-05", "May 2026", 27, 3451, 4712, 29873, 7089.72, 100.09, 22683.2, 12203.2, 5, 0, 2914.85],
  ["2026-06", "Jun 2026", 25, 4701, 6389, 40382, 9333.34, 121.51, 30927.15, 16427.15, 5, 0, 3266.97],
  ["2026-07", "Jul 2026", 27, 6283, 8745, 55008.25, 12481.15, 154.55, 42372.55, 27872.55, 5, 5, 2569.93],
  ["2026-08", "Aug 2026", 26, 5938, 7993, 50596, 11551.16, 143.14, 38901.7, 24401.7, 5, 2, 2867.43],
  ["2026-09", "Sep 2026", 26, 3946, 5317, 33791.25, 7952.32, 108.93, 25730.01, 15250.01, 5, 0, 3093.32],
  ["2026-10", "Oct 2026", 27, 2573, 3490, 22167.25, 5311.02, 83.26, 16772.97, 6292.97, 5, 0, 3122.91],
  ["2026-11", "Nov 2026", 25, 1401, 1894, 12047.25, 2888.77, 202.23, 8956.25, -1523.75, 5, 0, 3463.44],
];

// [name, units sold, revenue] — the sim's annual menu results.
const SIM01_MENU: [string, number, number][] = [
  ["Cookies & Cream Scoop", 5377, 30917.75],
  ["Chocolate Fudge Scoop", 5865, 30791.25],
  ["Vanilla Bean Scoop", 5768, 30282.0],
  ["Take-home Tub 1L", 2325, 27900.0],
  ["Milkshake", 3745, 27151.25],
  ["Strawberry Scoop", 4794, 26367.0],
  ["Classic Sundae", 3089, 26256.5],
  ["Salted Caramel Scoop", 4370, 25127.5],
  ["Mint Choc Chip Scoop", 4004, 22022.0],
  ["Mango Sorbet Scoop", 3648, 20064.0],
  ["Banana Split", 1742, 16984.5],
  ["Pistachio Scoop", 2214, 13837.5],
];

// Slow-season tub waste from the sim (tubs written off).
const SIM01_TUB_WASTE: { name: string; tubs: number }[] = [
  { name: "Strawberry", tubs: 4.99 },
  { name: "Mango Sorbet", tubs: 4.14 },
  { name: "Pistachio", tubs: 3.01 },
];

const bitAnalyticsMonthShape = z.object({
  monthKey: z.string(),
  label: z.string(),
  daysOpen: z.number(),
  transactions: z.number(),
  unitsSold: z.number(),
  revenue: z.number(),
  cogs: z.number(),
  wasteCost: z.number(),
  grossProfit: z.number(),
  netProfit: z.number(),
  ordersPlaced: z.number(),
  stockoutEvents: z.number(),
  endingInventoryValue: z.number(),
});

const bitPosSaleLineRequest = z.object({
  sku: z.string().max(200).nullable().optional(),
  name: z.string().max(300).nullable().optional(),
  qty: z.number().int().min(1).max(100000),
});

const bitPosTransactionShape = z.object({
  id: z.number(),
  itemId: z.number().nullable(),
  itemName: z.string().nullable(),
  posRef: z.string(),
  quantity: z.number(),
  source: z.string(),
  externalId: z.string().nullable(),
  belowPar: z.boolean(),
  undone: z.boolean(),
  createdAt: z.string(),
  // Attribution + policy (audit #5, Primary vs Connected).
  ...undoMetaShape.shape,
});

const bitPosUnmatchedShape = z.object({
  id: z.number(),
  posRef: z.string(),
  quantity: z.number(),
  source: z.string(),
  externalId: z.string().nullable(),
  createdAt: z.string(),
});

function bitPosNormalizeRef(ref: string): string {
  return ref.trim().toLowerCase();
}

// ---- POS provider setup details (Alpha 0.66) -----------------------
// Each named provider asks for its own set of setup values in the
// Connect to POS panel (researched per provider, Nov 14 2026). The
// values live in bit_business.pos_details_json as a flat object
// keyed by the field keys below. Fields flagged secret are stored
// server-side only: getBitState returns them masked to their last
// 4 characters, and a save that omits a secret (or sends it back
// masked) keeps the stored value — a secret only changes when a
// new one is typed.

const bitPosDetailsRequest = z.object({
  // "Production" | "Sandbox" — only Square and Clover offer the
  // choice; validated in bitPosParseDetails and the save merge.
  environment: z.string().max(20).nullable().optional(),
  accessToken: z.string().max(1000).nullable().optional(),
  shopDomain: z.string().max(300).nullable().optional(),
  clientId: z.string().max(500).nullable().optional(),
  clientSecret: z.string().max(1000).nullable().optional(),
  domainPrefix: z.string().max(300).nullable().optional(),
  personalToken: z.string().max(1000).nullable().optional(),
  merchantId: z.string().max(300).nullable().optional(),
  apiToken: z.string().max(1000).nullable().optional(),
  restaurantGuid: z.string().max(300).nullable().optional(),
});

type BitPosDetails = z.infer<typeof bitPosDetailsRequest>;

const bitPosDetailsShape = z.object({
  environment: z.string().nullable(),
  accessToken: z.string().nullable(),
  shopDomain: z.string().nullable(),
  clientId: z.string().nullable(),
  clientSecret: z.string().nullable(),
  domainPrefix: z.string().nullable(),
  personalToken: z.string().nullable(),
  merchantId: z.string().nullable(),
  apiToken: z.string().nullable(),
  restaurantGuid: z.string().nullable(),
});

const BIT_POS_SECRET_FIELDS = [
  "accessToken",
  "clientSecret",
  "personalToken",
  "apiToken",
] as const;

const BIT_POS_DETAIL_KEYS = [
  "environment",
  "accessToken",
  "shopDomain",
  "clientId",
  "clientSecret",
  "domainPrefix",
  "personalToken",
  "merchantId",
  "apiToken",
  "restaurantGuid",
] as const;

/** The setup fields each named provider requires (empty for
    Lightspeed Retail (R-Series) — OAuth consent only). Providers
    not listed here (legacy "Lightspeed", custom) have no required
    provider fields. */
const BIT_POS_REQUIRED_FIELDS: Record<string, (keyof BitPosDetails)[]> = {
  Square: ["accessToken"],
  "Shopify POS": ["shopDomain", "clientId", "clientSecret"],
  "Lightspeed Retail (X-Series)": ["domainPrefix", "personalToken"],
  "Lightspeed Retail (R-Series)": [],
  Clover: ["merchantId", "apiToken"],
  Toast: ["clientId", "clientSecret", "restaurantGuid"],
};

function bitPosParseDetails(json: string | null): BitPosDetails {
  if (!json) return {};
  try {
    const parsed: unknown = JSON.parse(json);
    if (parsed == null || typeof parsed !== "object") return {};
    const rec = parsed as Record<string, unknown>;
    const out: BitPosDetails = {};
    for (const key of BIT_POS_DETAIL_KEYS) {
      const v = rec[key];
      if (typeof v !== "string" || !v.trim()) continue;
      // The environment is a two-value choice; anything else is
      // dropped (and an absent environment means Production).
      if (key === "environment" && v !== "Production" && v !== "Sandbox") {
        continue;
      }
      out[key] = v;
    }
    return out;
  } catch {
    return {};
  }
}

function bitPosMaskSecret(value: string): string {
  return value.length <= 4 ? "••••" : `••••${value.slice(-4)}`;
}

function bitPosMaskedDetails(
  details: BitPosDetails,
): z.infer<typeof bitPosDetailsShape> {
  const out: z.infer<typeof bitPosDetailsShape> = {
    environment: null,
    accessToken: null,
    shopDomain: null,
    clientId: null,
    clientSecret: null,
    domainPrefix: null,
    personalToken: null,
    merchantId: null,
    apiToken: null,
    restaurantGuid: null,
  };
  for (const key of BIT_POS_DETAIL_KEYS) {
    const v = details[key];
    if (v == null) continue;
    out[key] = (BIT_POS_SECRET_FIELDS as readonly string[]).includes(key)
      ? bitPosMaskSecret(v)
      : v;
  }
  return out;
}

function bitPosGenerateToken(): string {
  try {
    return `bit_${crypto.randomUUID().replace(/-/g, "")}`;
  } catch {
    return `bit_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 14)}`;
  }
}

async function applyBitPosSaleInternal(
  ctx: Ctx,
  args: {
    businessId: number;
    source: string;
    externalId: string | null;
    lines: { sku?: string | null; name?: string | null; qty: number }[];
  },
): Promise<{ duplicate: boolean; applied: number; unmatched: number }> {
  const db = ctx.db<typeof schema>();
  const businessId = args.businessId;
  const source = args.source.trim() || "POS";
  const externalId = args.externalId?.trim() || null;
  // Attribution (audit #5): every transaction this sale/sync
  // writes carries the role this copy is acting as — the POS
  // syncs policy and ownership rule follow it on Undo.
  const { role: posActor } = await loadAccountSettings(ctx);
  if (externalId) {
    const existing = await db
      .select()
      .from(schema.bitPosTransactions)
      .where(
        and(
          eq(schema.bitPosTransactions.businessId, businessId),
          eq(schema.bitPosTransactions.externalId, externalId),
        ),
      );
    if (existing.length > 0) {
      return { duplicate: true, applied: 0, unmatched: 0 };
    }
  }
  const itemRows = await db
    .select()
    .from(schema.bitItems)
    .where(eq(schema.bitItems.businessId, businessId));
  const itemsById = new Map(itemRows.map((r) => [r.id, { ...r }]));
  const mappingRows = await db
    .select()
    .from(schema.bitPosMappings)
    .where(eq(schema.bitPosMappings.businessId, businessId));
  const mappingByRef = new Map(
    mappingRows.map((m) => [bitPosNormalizeRef(m.posRef), m.itemId]),
  );
  let applied = 0;
  let unmatched = 0;
  const statements: BatchItem<"sqlite">[] = [];
  const now = new Date();
  for (const line of args.lines) {
    const skuRef = line.sku?.trim() || null;
    const nameRef = line.name?.trim() || null;
    const posRef = skuRef ?? nameRef ?? "";
    if (!posRef) {
      unmatched += 1;
      statements.push(
        db.insert(schema.bitPosTransactions).values({
          businessId,
          itemId: null,
          itemName: null,
          posRef: "",
          quantity: line.qty,
          source,
          externalId,
          matched: 0,
          belowPar: 0,
          undone: 0,
          resolved: 0,
          actor: posActor,
          createdAt: now,
        }),
      );
      continue;
    }
    let matchedItem: BitItemRow | undefined;
    // 1) remembered mapping for this exact POS reference
    const mappedId =
      mappingByRef.get(bitPosNormalizeRef(posRef)) ??
      (skuRef ? mappingByRef.get(bitPosNormalizeRef(skuRef)) : undefined) ??
      (nameRef ? mappingByRef.get(bitPosNormalizeRef(nameRef)) : undefined);
    if (mappedId != null) {
      matchedItem = itemsById.get(mappedId);
    }
    // 2) SKU match (first)
    if (!matchedItem && skuRef) {
      matchedItem = [...itemsById.values()].find(
        (r) => r.sku != null && bitPosNormalizeRef(r.sku) === bitPosNormalizeRef(skuRef),
      );
    }
    if (!matchedItem && !skuRef && nameRef) {
      // A name-only line could still carry a SKU value in the name field from CSV/webhook callers
      matchedItem = [...itemsById.values()].find(
        (r) => r.sku != null && bitPosNormalizeRef(r.sku) === bitPosNormalizeRef(nameRef),
      );
    }
    // 3) exact name match, case-insensitive
    if (!matchedItem) {
      const nameCandidate = nameRef ?? posRef;
      matchedItem = [...itemsById.values()].find(
        (r) => bitPosNormalizeRef(r.name) === bitPosNormalizeRef(nameCandidate),
      );
    }
    if (matchedItem) {
      const current = itemsById.get(matchedItem.id) ?? matchedItem;
      const newOnHand = Math.max(0, current.onHand - line.qty);
      const belowPar = newOnHand <= current.par ? 1 : 0;
      itemsById.set(current.id, { ...current, onHand: newOnHand });
      applied += 1;
      statements.push(
        db
          .update(schema.bitItems)
          .set({ onHand: newOnHand })
          .where(eq(schema.bitItems.id, current.id)),
      );
      statements.push(
        db.insert(schema.bitPosTransactions).values({
          businessId,
          itemId: current.id,
          itemName: current.name,
          posRef,
          quantity: line.qty,
          source,
          externalId,
          matched: 1,
          belowPar,
          undone: 0,
          resolved: 0,
          actor: posActor,
          createdAt: now,
        }),
      );
    } else {
      unmatched += 1;
      statements.push(
        db.insert(schema.bitPosTransactions).values({
          businessId,
          itemId: null,
          itemName: null,
          posRef,
          quantity: line.qty,
          source,
          externalId,
          matched: 0,
          belowPar: 0,
          undone: 0,
          resolved: 0,
          actor: posActor,
          createdAt: now,
        }),
      );
    }
  }
  if (statements.length > 0) {
    const [first, ...rest] = statements;
    if (first) await db.batch([first, ...rest]);
  }
  ctx.invalidateQueries();
  return { duplicate: false, applied, unmatched };
}

// ---- POS daily pull (Alpha 0.67) -----------------------------------
// Once a day (and on demand from the panel's "Sync now"), for the
// business whose POS connection reads "Credentials saved — daily
// sync ready", the app's server fetches the previous day's
// completed sales from the provider's own API with the saved
// credentials and applies each order through applyBitPosSaleInternal
// — the provider as the source label, the provider's own order id
// ("<provider>:<id>") as the external transaction id, so the
// existing duplicate protection makes re-pulls and overlapping
// windows harmless. Outbound HTTPS from server actions was proven
// in this build (a probe call to Square's API returned its 401), so
// the pull runs in-app; a daily refresh trigger runs
// pullBitPosDaily. Per-provider endpoints and quirks follow the
// Nov 14 2026 research report (see DATA-PLAN.md). "Yesterday" is
// the previous day in America/Toronto (no per-business timezone is
// stored); for Toast it is the previous businessDate. Quantities
// are whole units in BIT's inventory, so fractional POS quantities
// (weighed items) are rounded to the nearest unit.

const BIT_POS_READY_STATUS = "Credentials saved — daily sync ready";
const BIT_POS_TIMEZONE = "America/Toronto";

const bitPosSyncRunShape = z.object({
  id: z.number(),
  provider: z.string(),
  status: z.string(),
  dayKey: z.string().nullable(),
  ordersSeen: z.number(),
  linesApplied: z.number(),
  linesUnmatched: z.number(),
  duplicates: z.number(),
  error: z.string().nullable(),
  createdAt: z.string(),
});

type BitPosPullLine = {
  sku?: string | null;
  name?: string | null;
  qty: number;
};

type BitPosPullResult = {
  status: "ok" | "skipped" | "error";
  dayKey: string | null;
  ordersSeen: number;
  orders: { externalId: string; lines: BitPosPullLine[] }[];
  error: string | null;
};

function bitPosPullError(message: string): BitPosPullResult {
  return { status: "error", dayKey: null, ordersSeen: 0, orders: [], error: message };
}

function bitPosObj(v: unknown): Record<string, unknown> {
  return v != null && typeof v === "object" && !Array.isArray(v)
    ? (v as Record<string, unknown>)
    : {};
}

function bitPosArr(v: unknown): unknown[] {
  return Array.isArray(v) ? v : [];
}

function bitPosStr(v: unknown): string | null {
  return typeof v === "string" && v.length > 0 ? v : null;
}

function bitPosNum(v: unknown): number {
  if (typeof v === "number" && Number.isFinite(v)) return v;
  if (typeof v === "string") {
    const n = Number(v);
    return Number.isFinite(n) ? n : 0;
  }
  return 0;
}

/** A POS quantity as a whole-unit count (0 = no usable quantity). */
function bitPosQty(v: unknown): number {
  const n = Math.round(bitPosNum(v));
  return n > 0 ? n : 0;
}

type BitPosFetchResult = {
  ok: boolean;
  status: number;
  json: unknown;
  text: string;
};

async function bitPosFetchJson(
  url: string,
  init: {
    method?: string;
    headers?: Record<string, string>;
    body?: string;
  },
): Promise<BitPosFetchResult> {
  const res = await fetch(url, {
    method: init.method ?? "GET",
    headers: init.headers ?? {},
    body: init.body,
  });
  const text = await res.text();
  let json: unknown = null;
  try {
    json = JSON.parse(text);
  } catch {
    json = null;
  }
  return { ok: res.ok, status: res.status, json, text };
}

function bitPosHttpError(what: string, r: BitPosFetchResult): string {
  return `${what} answered HTTP ${r.status}${r.text ? `: ${r.text.slice(0, 200)}` : ""}`;
}

/** Local midnight (in `timeZone`) of the given calendar day, as UTC. */
function bitPosZonedMidnightToUtc(
  y: number,
  m: number,
  d: number,
  timeZone: string,
): Date {
  let guess = Date.UTC(y, m - 1, d, 0, 0, 0);
  const target = guess;
  for (let i = 0; i < 3; i++) {
    const parts = new Intl.DateTimeFormat("en-CA", {
      timeZone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
      hourCycle: "h23",
    }).formatToParts(new Date(guess));
    const get = (t: string) =>
      Number(parts.find((p) => p.type === t)?.value ?? "0");
    const localAsUtc = Date.UTC(
      get("year"),
      get("month") - 1,
      get("day"),
      get("hour"),
      get("minute"),
      get("second"),
    );
    const diff = target - localAsUtc;
    if (diff === 0) break;
    guess += diff;
  }
  return new Date(guess);
}

/** "Yesterday" in `timeZone`: its UTC start/end and YYYY-MM-DD key. */
function bitPosYesterday(
  now: Date,
  timeZone: string,
): { startUtc: Date; endUtc: Date; dayKey: string } {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(now);
  const get = (t: string) =>
    Number(parts.find((p) => p.type === t)?.value ?? "0");
  // Step back one calendar day via a noon-UTC anchor (DST-safe).
  const anchor = new Date(
    Date.UTC(get("year"), get("month") - 1, get("day"), 12) - 24 * 3600 * 1000,
  );
  const y = anchor.getUTCFullYear();
  const m = anchor.getUTCMonth() + 1;
  const d = anchor.getUTCDate();
  const dayKey = `${y}-${String(m).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
  const startUtc = bitPosZonedMidnightToUtc(y, m, d, timeZone);
  const next = new Date(Date.UTC(y, m - 1, d + 1, 12));
  const endUtc = bitPosZonedMidnightToUtc(
    next.getUTCFullYear(),
    next.getUTCMonth() + 1,
    next.getUTCDate(),
    timeZone,
  );
  return { startUtc, endUtc, dayKey };
}

function bitPosParseSkuCache(json: string | null): Record<string, string> {
  if (!json) return {};
  try {
    const parsed: unknown = JSON.parse(json);
    if (parsed == null || typeof parsed !== "object") return {};
    const out: Record<string, string> = {};
    for (const [k, v] of Object.entries(
      parsed as Record<string, unknown>,
    )) {
      if (typeof v === "string" && v) out[k] = v;
    }
    return out;
  } catch {
    return {};
  }
}

/** Square: locations are auto-discovered; orders are searched
    COMPLETED on closed_at over a 4-day window ending at the end of
    yesterday (offline sales can land up to ~72h late — the
    per-order dedupe makes the overlap safe). Line items carry a
    catalog_object_id, not a SKU: SKUs are resolved through the
    Catalog API and cached. */
async function bitPosPullSquare(
  details: BitPosDetails,
  cache: Record<string, string>,
  now: Date,
): Promise<BitPosPullResult> {
  const token = details.accessToken?.trim();
  if (!token) return bitPosPullError("Square access token is missing.");
  const base =
    details.environment === "Sandbox"
      ? "https://connect.squareupsandbox.com"
      : "https://connect.squareup.com";
  const { startUtc, endUtc, dayKey } = bitPosYesterday(now, BIT_POS_TIMEZONE);
  const result: BitPosPullResult = {
    status: "ok",
    dayKey,
    ordersSeen: 0,
    orders: [],
    error: null,
  };
  const headers = {
    Authorization: `Bearer ${token}`,
    "Square-Version": "2024-12-18",
    "Content-Type": "application/json",
  };
  try {
    const locRes = await bitPosFetchJson(`${base}/v2/locations`, {
      headers,
    });
    if (!locRes.ok) {
      return { ...result, status: "error", error: bitPosHttpError("Square locations", locRes) };
    }
    const locationIds = bitPosArr(bitPosObj(locRes.json).locations)
      .map((l) => bitPosStr(bitPosObj(l).id))
      .filter((x): x is string => x != null);
    if (locationIds.length === 0) {
      return { ...result, status: "error", error: "Square returned no locations for this account." };
    }
    const windowStart = new Date(startUtc.getTime() - 3 * 24 * 3600 * 1000);
    const rawOrders: Record<string, unknown>[] = [];
    let cursor: string | null = null;
    do {
      const body: Record<string, unknown> = {
        location_ids: locationIds,
        query: {
          filter: {
            state_filter: { states: ["COMPLETED"] },
            date_time_filter: {
              closed_at: {
                start_at: windowStart.toISOString(),
                end_at: endUtc.toISOString(),
              },
            },
          },
          sort: { sort_field: "CLOSED_AT", sort_order: "ASC" },
        },
        limit: 100,
      };
      if (cursor) body.cursor = cursor;
      const res = await bitPosFetchJson(`${base}/v2/orders/search`, {
        method: "POST",
        headers,
        body: JSON.stringify(body),
      });
      if (!res.ok) {
        return { ...result, status: "error", error: bitPosHttpError("Square orders search", res) };
      }
      const obj = bitPosObj(res.json);
      for (const o of bitPosArr(obj.orders)) rawOrders.push(bitPosObj(o));
      cursor = bitPosStr(obj.cursor);
    } while (cursor);
    result.ordersSeen = rawOrders.length;
    // Resolve any catalog ids we have not cached to their SKUs.
    const missing = new Set<string>();
    for (const o of rawOrders) {
      for (const li of bitPosArr(o.line_items)) {
        const id = bitPosStr(bitPosObj(li).catalog_object_id);
        if (id && !cache[id]) missing.add(id);
      }
    }
    const missingIds = [...missing];
    for (let i = 0; i < missingIds.length; i += 100) {
      const chunk = missingIds.slice(i, i + 100);
      const res = await bitPosFetchJson(
        `${base}/v2/catalog/batch-retrieve`,
        {
          method: "POST",
          headers,
          body: JSON.stringify({
            object_ids: chunk,
            include_related_objects: true,
          }),
        },
      );
      if (!res.ok) {
        return { ...result, status: "error", error: bitPosHttpError("Square catalog", res) };
      }
      for (const entry of bitPosArr(bitPosObj(res.json).objects)) {
        const o = bitPosObj(entry);
        const id = bitPosStr(o.id);
        const sku = bitPosStr(bitPosObj(o.item_variation_data).sku);
        if (id && sku) cache[id] = sku;
      }
    }
    for (const o of rawOrders) {
      const orderId = bitPosStr(o.id);
      if (!orderId) continue;
      const lines: BitPosPullLine[] = [];
      for (const liRaw of bitPosArr(o.line_items)) {
        const li = bitPosObj(liRaw);
        const qty = bitPosQty(li.quantity);
        if (qty <= 0) continue;
        const catId = bitPosStr(li.catalog_object_id);
        lines.push({
          // An unresolved catalog id is itself the line's reference:
          // a manual match on it is remembered for future pulls.
          sku: catId ? (cache[catId] ?? catId) : null,
          name: bitPosStr(li.name),
          qty,
        });
      }
      if (lines.length > 0) {
        result.orders.push({ externalId: `square:${orderId}`, lines });
      }
    }
    return result;
  } catch (e) {
    return {
      ...result,
      status: "error",
      error: `Square pull failed: ${e instanceof Error ? e.message : String(e)}`,
    };
  }
}

/** Shopify POS: a 24-hour token is minted from the saved shop
    domain + Client ID + Client secret (client-credentials grant),
    then yesterday's orders come from the GraphQL Admin API with
    cursor pagination. Line items carry sku + quantity directly. */
async function bitPosPullShopify(
  details: BitPosDetails,
  now: Date,
): Promise<BitPosPullResult> {
  const domain = (details.shopDomain?.trim().toLowerCase() ?? "")
    .replace(/^https?:\/\//, "")
    .replace(/\/.*$/, "");
  const clientId = details.clientId?.trim();
  const clientSecret = details.clientSecret?.trim();
  if (!domain || !clientId || !clientSecret) {
    return bitPosPullError(
      "Shopify needs the shop domain, Client ID and Client secret.",
    );
  }
  const { startUtc, endUtc, dayKey } = bitPosYesterday(now, BIT_POS_TIMEZONE);
  const result: BitPosPullResult = {
    status: "ok",
    dayKey,
    ordersSeen: 0,
    orders: [],
    error: null,
  };
  try {
    const tokenRes = await bitPosFetchJson(
      `https://${domain}/admin/oauth/access_token`,
      {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          grant_type: "client_credentials",
          client_id: clientId,
          client_secret: clientSecret,
        }).toString(),
      },
    );
    if (!tokenRes.ok) {
      return { ...result, status: "error", error: bitPosHttpError("Shopify token exchange", tokenRes) };
    }
    const accessToken = bitPosStr(bitPosObj(tokenRes.json).access_token);
    if (!accessToken) {
      return { ...result, status: "error", error: "Shopify did not return an access token." };
    }
    const query =
      "query PosOrders($q: String!, $cursor: String) { orders(first: 50, sortKey: CREATED_AT, query: $q, after: $cursor) { pageInfo { hasNextPage endCursor } nodes { id cancelledAt displayFinancialStatus lineItems(first: 100) { nodes { sku name quantity currentQuantity } } } } }";
    const search = `created_at:>=${startUtc.toISOString()} AND created_at:<${endUtc.toISOString()}`;
    let cursor: string | null = null;
    let hasNext = true;
    while (hasNext) {
      const res = await bitPosFetchJson(
        `https://${domain}/admin/api/2025-01/graphql.json`,
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "X-Shopify-Access-Token": accessToken,
          },
          body: JSON.stringify({ query, variables: { q: search, cursor } }),
        },
      );
      if (!res.ok) {
        return { ...result, status: "error", error: bitPosHttpError("Shopify orders", res) };
      }
      const orders = bitPosObj(bitPosObj(bitPosObj(res.json).data).orders);
      const pageInfo = bitPosObj(orders.pageInfo);
      for (const nodeRaw of bitPosArr(orders.nodes)) {
        const node = bitPosObj(nodeRaw);
        result.ordersSeen += 1;
        if (node.cancelledAt != null) continue;
        const status = bitPosStr(node.displayFinancialStatus);
        if (
          status != null &&
          status !== "PAID" &&
          status !== "PARTIALLY_PAID" &&
          status !== "PARTIALLY_REFUNDED"
        ) {
          continue;
        }
        const orderId = bitPosStr(node.id);
        if (!orderId) continue;
        const lines: BitPosPullLine[] = [];
        for (const liRaw of bitPosArr(bitPosObj(node.lineItems).nodes)) {
          const li = bitPosObj(liRaw);
          const qty = bitPosQty(li.currentQuantity ?? li.quantity);
          if (qty <= 0) continue;
          lines.push({ sku: bitPosStr(li.sku), name: bitPosStr(li.name), qty });
        }
        if (lines.length > 0) {
          result.orders.push({ externalId: `shopify:${orderId}`, lines });
        }
      }
      hasNext = pageInfo.hasNextPage === true;
      cursor = bitPosStr(pageInfo.endCursor);
      if (hasNext && !cursor) break;
    }
    return result;
  } catch (e) {
    return {
      ...result,
      status: "error",
      error: `Shopify pull failed: ${e instanceof Error ? e.message : String(e)}`,
    };
  }
}

/** Lightspeed Retail (X-Series): sales search by date range with
    the personal token; parked, layby, on-account, open and voided
    sales are excluded. Lines carry product_id — SKUs resolve via
    the products endpoint and are cached. */
async function bitPosPullLightspeedX(
  details: BitPosDetails,
  cache: Record<string, string>,
  now: Date,
): Promise<BitPosPullResult> {
  const prefix = (details.domainPrefix?.trim().toLowerCase() ?? "")
    .replace(/^https?:\/\//, "")
    .replace(/\.retail\.lightspeed\.app.*$/, "")
    .replace(/\/.*$/, "");
  const token = details.personalToken?.trim();
  if (!prefix || !token) {
    return bitPosPullError(
      "Lightspeed X-Series needs the domain prefix and personal token.",
    );
  }
  const { startUtc, endUtc, dayKey } = bitPosYesterday(now, BIT_POS_TIMEZONE);
  const result: BitPosPullResult = {
    status: "ok",
    dayKey,
    ordersSeen: 0,
    orders: [],
    error: null,
  };
  const headers = {
    Authorization: `Bearer ${token}`,
    Accept: "application/json",
  };
  const base = `https://${prefix}.retail.lightspeed.app/api/2.0`;
  const EXCLUDED = ["PARKED", "LAYBY", "ONACCOUNT", "VOIDED", "OPEN", "SAVED"];
  try {
    const url = `${base}/search?type=sales&date_from=${encodeURIComponent(startUtc.toISOString())}&date_to=${encodeURIComponent(endUtc.toISOString())}&page_size=200`;
    const res = await bitPosFetchJson(url, { headers });
    if (!res.ok) {
      return { ...result, status: "error", error: bitPosHttpError("Lightspeed sales search", res) };
    }
    const root = bitPosObj(res.json);
    const salesRaw = bitPosArr(root.data).length > 0
      ? bitPosArr(root.data)
      : bitPosArr(root.register_sales);
    const sales = salesRaw.map((s) => bitPosObj(s));
    result.ordersSeen = sales.length;
    // Resolve product ids → SKUs (best-effort per product: one bad
    // product must not fail the whole pull).
    const missing = new Set<string>();
    for (const s of sales) {
      for (const li of bitPosArr(s.line_items ?? s.register_sale_products)) {
        const pid = bitPosStr(bitPosObj(li).product_id);
        if (pid && !cache[pid]) missing.add(pid);
      }
    }
    for (const pid of missing) {
      try {
        const pres = await bitPosFetchJson(
          `${base}/products/${encodeURIComponent(pid)}`,
          { headers },
        );
        if (!pres.ok) continue;
        const proot = bitPosObj(pres.json);
        const prod = bitPosObj(proot.data ?? proot);
        const sku = bitPosStr(prod.sku);
        if (sku) cache[pid] = sku;
      } catch {
        // leave uncached — the product id itself stays the reference
      }
    }
    for (const s of sales) {
      const status = (bitPosStr(s.status) ?? "").toUpperCase();
      if (EXCLUDED.includes(status)) continue;
      const saleId = bitPosStr(s.id);
      if (!saleId) continue;
      const lines: BitPosPullLine[] = [];
      for (const liRaw of bitPosArr(s.line_items ?? s.register_sale_products)) {
        const li = bitPosObj(liRaw);
        const qty = bitPosQty(li.quantity);
        if (qty <= 0) continue;
        const pid = bitPosStr(li.product_id);
        lines.push({
          sku: pid ? (cache[pid] ?? pid) : null,
          name: null,
          qty,
        });
      }
      if (lines.length > 0) {
        result.orders.push({ externalId: `lightspeed-x:${saleId}`, lines });
      }
    }
    return result;
  } catch (e) {
    return {
      ...result,
      status: "error",
      error: `Lightspeed X-Series pull failed: ${e instanceof Error ? e.message : String(e)}`,
    };
  }
}

/** Clover: orders filtered by createdTime for yesterday, lineItems
    expanded. Fixed-price lines have NO quantity field — quantity
    is the count of line elements per item id; per-unit lines carry
    unitQty in thousandths. Refunded/exchanged lines are excluded.
    Item ids resolve to SKUs via the items endpoint (cached). */
async function bitPosPullClover(
  details: BitPosDetails,
  cache: Record<string, string>,
  now: Date,
): Promise<BitPosPullResult> {
  const merchantId = details.merchantId?.trim();
  const token = details.apiToken?.trim();
  if (!merchantId || !token) {
    return bitPosPullError("Clover needs the Merchant ID and API token.");
  }
  const { startUtc, endUtc, dayKey } = bitPosYesterday(now, BIT_POS_TIMEZONE);
  const result: BitPosPullResult = {
    status: "ok",
    dayKey,
    ordersSeen: 0,
    orders: [],
    error: null,
  };
  const headers = {
    Authorization: `Bearer ${token}`,
    Accept: "application/json",
  };
  const host =
    details.environment === "Sandbox"
      ? "https://apisandbox.dev.clover.com"
      : "https://api.clover.com";
  const base = `${host}/v3/merchants/${encodeURIComponent(merchantId)}`;
  try {
    const rawOrders: Record<string, unknown>[] = [];
    let offset = 0;
    for (let page = 0; page < 20; page++) {
      const url = `${base}/orders?filter=createdTime>=${startUtc.getTime()}&filter=createdTime<${endUtc.getTime()}&expand=lineItems&limit=1000&offset=${offset}`;
      const res = await bitPosFetchJson(url, { headers });
      if (!res.ok) {
        return { ...result, status: "error", error: bitPosHttpError("Clover orders", res) };
      }
      const elements = bitPosArr(bitPosObj(res.json).elements);
      for (const o of elements) rawOrders.push(bitPosObj(o));
      if (elements.length < 1000) break;
      offset += elements.length;
    }
    result.ordersSeen = rawOrders.length;
    const missing = new Set<string>();
    for (const o of rawOrders) {
      for (const li of bitPosArr(bitPosObj(o.lineItems).elements)) {
        const itemId = bitPosStr(bitPosObj(bitPosObj(li).item).id);
        if (itemId && !cache[itemId]) missing.add(itemId);
      }
    }
    for (const itemId of missing) {
      try {
        const ires = await bitPosFetchJson(
          `${base}/items/${encodeURIComponent(itemId)}`,
          { headers },
        );
        if (!ires.ok) continue;
        const item = bitPosObj(ires.json);
        const sku = bitPosStr(item.sku) ?? bitPosStr(item.code);
        if (sku) cache[itemId] = sku;
      } catch {
        // leave uncached — the item id itself stays the reference
      }
    }
    for (const o of rawOrders) {
      if (bitPosStr(o.state) === "voided") continue;
      const orderId = bitPosStr(o.id);
      if (!orderId) continue;
      const byItem = new Map<string, { name: string | null; qty: number }>();
      for (const liRaw of bitPosArr(bitPosObj(o.lineItems).elements)) {
        const li = bitPosObj(liRaw);
        if (li.refunded === true || li.exchanged === true) continue;
        const itemId = bitPosStr(bitPosObj(li.item).id);
        if (!itemId) continue;
        const unitQty = bitPosNum(li.unitQty);
        const contribution = unitQty > 0 ? unitQty / 1000 : 1;
        const existing = byItem.get(itemId);
        byItem.set(itemId, {
          name: bitPosStr(li.name),
          qty: (existing?.qty ?? 0) + contribution,
        });
      }
      const lines: BitPosPullLine[] = [];
      for (const [itemId, agg] of byItem) {
        const qty = Math.round(agg.qty);
        if (qty <= 0) continue;
        lines.push({
          sku: cache[itemId] ?? itemId,
          name: agg.name,
          qty,
        });
      }
      if (lines.length > 0) {
        result.orders.push({ externalId: `clover:${orderId}`, lines });
      }
    }
    return result;
  } catch (e) {
    return {
      ...result,
      status: "error",
      error: `Clover pull failed: ${e instanceof Error ? e.message : String(e)}`,
    };
  }
}

/** Toast: client-credentials login (TOAST_MACHINE_CLIENT), then
    ordersBulk for the previous businessDate. Voided orders, checks
    and selections are excluded. Selection item GUIDs carry no SKU —
    the Menus API provides SKU + name per GUID (SKU is often blank,
    so the name rides along for the engine's name matching and the
    GUID itself is the remembered-mapping reference). */
async function bitPosPullToast(
  details: BitPosDetails,
  cache: Record<string, string>,
  now: Date,
): Promise<BitPosPullResult> {
  const clientId = details.clientId?.trim();
  const clientSecret = details.clientSecret?.trim();
  const guid = details.restaurantGuid?.trim();
  if (!clientId || !clientSecret || !guid) {
    return bitPosPullError(
      "Toast needs the Client ID, client secret and restaurant GUID.",
    );
  }
  const { dayKey } = bitPosYesterday(now, BIT_POS_TIMEZONE);
  const businessDate = (dayKey ?? "").replace(/-/g, "");
  const result: BitPosPullResult = {
    status: "ok",
    dayKey,
    ordersSeen: 0,
    orders: [],
    error: null,
  };
  try {
    const loginRes = await bitPosFetchJson(
      "https://ws-api.toasttab.com/authentication/v1/authentication/login",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          clientId,
          clientSecret,
          userAccessType: "TOAST_MACHINE_CLIENT",
        }),
      },
    );
    if (!loginRes.ok) {
      return { ...result, status: "error", error: bitPosHttpError("Toast login", loginRes) };
    }
    const accessToken = bitPosStr(
      bitPosObj(bitPosObj(loginRes.json).token).accessToken,
    );
    if (!accessToken) {
      return { ...result, status: "error", error: "Toast did not return an access token." };
    }
    const headers = {
      Authorization: `Bearer ${accessToken}`,
      "Toast-Restaurant-External-ID": guid,
      Accept: "application/json",
    };
    // Menu map: GUID → name (and SKU into the shared cache when the
    // menu defines one). Best-effort — selections carry a display
    // name of their own when the menu can't be read.
    const menuNames = new Map<string, string>();
    try {
      const menuRes = await bitPosFetchJson(
        "https://ws-api.toasttab.com/menus/v2/menus",
        { headers },
      );
      if (menuRes.ok) {
        const walk = (v: unknown): void => {
          if (Array.isArray(v)) {
            for (const entry of v) walk(entry);
            return;
          }
          if (v == null || typeof v !== "object") return;
          const o = v as Record<string, unknown>;
          const itemGuid = bitPosStr(o.guid);
          if (itemGuid && ("sku" in o || "plu" in o)) {
            const name = bitPosStr(o.name);
            if (name) menuNames.set(itemGuid, name);
            const sku = bitPosStr(o.sku);
            if (sku) cache[itemGuid] = sku;
          }
          for (const entry of Object.values(o)) walk(entry);
        };
        walk(menuRes.json);
      }
    } catch {
      // menus are best-effort only
    }
    for (let page = 1; page <= 50; page++) {
      const res = await bitPosFetchJson(
        `https://ws-api.toasttab.com/orders/v2/ordersBulk?businessDate=${businessDate}&pageSize=100&page=${page}`,
        { headers },
      );
      if (!res.ok) {
        return { ...result, status: "error", error: bitPosHttpError("Toast ordersBulk", res) };
      }
      const ordersArr = bitPosArr(res.json);
      if (ordersArr.length === 0) break;
      for (const orderRaw of ordersArr) {
        const order = bitPosObj(orderRaw);
        result.ordersSeen += 1;
        if (order.voided === true) continue;
        const orderGuid = bitPosStr(order.guid);
        if (!orderGuid) continue;
        const lines: BitPosPullLine[] = [];
        for (const checkRaw of bitPosArr(order.checks)) {
          const check = bitPosObj(checkRaw);
          if (check.voided === true) continue;
          for (const selRaw of bitPosArr(check.selections)) {
            const sel = bitPosObj(selRaw);
            if (sel.voided === true) continue;
            const qty = bitPosQty(sel.quantity);
            if (qty <= 0) continue;
            const itemGuid = bitPosStr(bitPosObj(sel.item).guid);
            lines.push({
              sku: itemGuid ? (cache[itemGuid] ?? itemGuid) : null,
              name:
                (itemGuid ? menuNames.get(itemGuid) : undefined) ??
                bitPosStr(sel.displayName),
              qty,
            });
          }
        }
        if (lines.length > 0) {
          result.orders.push({ externalId: `toast:${orderGuid}`, lines });
        }
      }
      if (ordersArr.length < 100) break;
    }
    return result;
  } catch (e) {
    return {
      ...result,
      status: "error",
      error: `Toast pull failed: ${e instanceof Error ? e.message : String(e)}`,
    };
  }
}

/** Runs one business's daily pull: fetch from its provider, apply
    every order through the existing sale path, and record the run
    (time, provider, day, orders seen, lines applied / unmatched,
    duplicates, outcome or error) in bit_pos_sync_runs. A provider
    failure is recorded as the run's error — it never throws, so
    one business's failure can't block anything else. */
async function runBitPosPullForBusiness(
  ctx: Ctx,
  biz: BitBusinessRow,
): Promise<z.infer<typeof bitPosSyncRunShape>> {
  const db = ctx.db<typeof schema>();
  const provider = biz.posProvider ?? "POS";
  const details = bitPosParseDetails(biz.posDetailsJson);
  const cache = bitPosParseSkuCache(biz.posSkuCacheJson);
  const now = new Date();
  let result: BitPosPullResult;
  if (provider === "Square") {
    result = await bitPosPullSquare(details, cache, now);
  } else if (provider === "Shopify POS") {
    result = await bitPosPullShopify(details, now);
  } else if (provider === "Lightspeed Retail (X-Series)") {
    result = await bitPosPullLightspeedX(details, cache, now);
  } else if (provider === "Lightspeed Retail (R-Series)") {
    result = {
      status: "skipped",
      dayKey: null,
      ordersSeen: 0,
      orders: [],
      error:
        "Lightspeed Retail (R-Series) connects by sign-in approval only, and this app is not registered with Lightspeed yet — there is no credential to pull with, so this pull was skipped. The connection stays “Awaiting app registration”.",
    };
  } else if (provider === "Clover") {
    result = await bitPosPullClover(details, cache, now);
  } else if (provider === "Toast") {
    result = await bitPosPullToast(details, cache, now);
  } else {
    result = bitPosPullError(
      `No daily pull is built for “${provider}” yet.`,
    );
  }
  let applied = 0;
  let unmatched = 0;
  let duplicates = 0;
  if (result.status === "ok") {
    for (const order of result.orders) {
      const res = await applyBitPosSaleInternal(ctx, {
        businessId: biz.id,
        source: provider,
        externalId: order.externalId,
        lines: order.lines,
      });
      if (res.duplicate) duplicates += 1;
      applied += res.applied;
      unmatched += res.unmatched;
    }
  }
  await db.insert(schema.bitPosSyncRuns).values({
    businessId: biz.id,
    provider,
    status: result.status,
    dayKey: result.dayKey,
    ordersSeen: result.ordersSeen,
    linesApplied: applied,
    linesUnmatched: unmatched,
    duplicates,
    error: result.error,
    createdAt: now,
  });
  // Persist the refreshed id→SKU cache and clear any "Sync now"
  // request stamp — this run serviced it.
  await db
    .update(schema.bitBusiness)
    .set({
      posSkuCacheJson: JSON.stringify(cache),
      posSyncRequestedAt: null,
      updatedAt: new Date(),
    })
    .where(eq(schema.bitBusiness.id, biz.id));
  const rows = await db
    .select()
    .from(schema.bitPosSyncRuns)
    .where(eq(schema.bitPosSyncRuns.businessId, biz.id))
    .orderBy(desc(schema.bitPosSyncRuns.id))
    .limit(1);
  const row = rows[0];
  return {
    id: row?.id ?? 0,
    provider,
    status: result.status,
    dayKey: result.dayKey,
    ordersSeen: result.ordersSeen,
    linesApplied: applied,
    linesUnmatched: unmatched,
    duplicates,
    error: result.error,
    createdAt: (row?.createdAt ?? now).toISOString(),
  };
}

function bitRowToItem(r: BitItemRow): z.infer<typeof bitItemShape> {
  return {
    id: r.id,
    name: r.name,
    category: r.category,
    zone: r.zone,
    onHand: r.onHand,
    unit: r.unit,
    par: r.par,
    packSize: r.packSize,
    supplier: r.supplier,
    sku: r.sku,
    expiryDate: r.expiryDate,
    tags: bitParseStringArray(r.tagsJson),
    lastCountedAt: null,
  };
}

// ---- Bundled sample data (one-time sample import) -----------------
// The generic sample dataset bundled as JSON: The Daily Scoop (a
// sample ice-cream-shop business with its inventory), the Sim 01
// analytics dataset for it, and the default account settings.
// importSampleData loads them into an empty app exactly once, so a
// new user can explore with sample data before setting up their own
// businesses; the setup questionnaire is the clean-start path.
// The shapes below are the exporting actions' response shapes
// (getBitState / getBitAnalytics / getAccountSettings).

interface MigrationBitExport {
  business: {
    id: number;
    name: string;
    type: string;
    customType: string | null;
    categories: string[];
    colors: Record<string, string>;
    freezers: string[];
    usesRequisition: boolean;
    division: string | null;
    preparerName: string | null;
    approverName: string | null;
    teamSize: string | null;
  };
  items: {
    id: number;
    name: string;
    category: string;
    zone: string;
    onHand: number;
    unit: string;
    par: number;
    packSize: number;
    supplier: string | null;
    sku: string | null;
    expiryDate: string | null;
    tags: string[];
  }[];
}
interface MigrationAnalyticsExport {
  label: string | null;
  periodLabel: string | null;
  lostRevenue: number;
  lostUnits: number;
  stockoutEvents: number;
  tubWaste: { name: string; tubs: number }[];
  itemCosts: Record<string, number>;
  months: {
    monthKey: string;
    label: string;
    daysOpen: number;
    transactions: number;
    unitsSold: number;
    revenue: number;
    cogs: number;
    wasteCost: number;
    grossProfit: number;
    netProfit: number;
    ordersPlaced: number;
    stockoutEvents: number;
    endingInventoryValue: number;
  }[];
  menu: { name: string; units: number; revenue: number }[];
}
interface MigrationAccountExport {
  role: "primary" | "connected";
  policy: Record<string, string>;
}

const bitScoopExport = bitScoopExportJson as unknown as MigrationBitExport;
const bitAnalyticsExport =
  bitAnalyticsExportJson as unknown as MigrationAnalyticsExport;
const accountSettingsExport =
  accountSettingsExportJson as unknown as MigrationAccountExport;

const sampleCountsShape = z.object({
  scoopItems: z.number(),
  scoopCategories: z.number(),
  analyticsMonths: z.number(),
});

/** The bundled sample data's counts, read from stored rows. */
async function sampleDataCounts(
  ctx: Ctx,
): Promise<z.infer<typeof sampleCountsShape>> {
  const db = ctx.db<typeof schema>();
  const [bizRows, bitItemRows] = await Promise.all([
    db.select().from(schema.bitBusiness),
    db.select().from(schema.bitItems),
  ]);
  const scoop = bizRows.find(
    (b) => b.name.trim().toLowerCase() === "the daily scoop",
  );
  const scoopItems = scoop
    ? bitItemRows.filter((r) => r.businessId === scoop.id)
    : [];
  const monthRows = scoop
    ? await db
        .select({ id: schema.bitAnalyticsMonths.id })
        .from(schema.bitAnalyticsMonths)
        .where(eq(schema.bitAnalyticsMonths.businessId, scoop.id))
    : [];
  return {
    scoopItems: scoopItems.length,
    scoopCategories: new Set(scoopItems.map((r) => r.category)).size,
    analyticsMonths: monthRows.length,
  };
}

/** The shape the in-app receipt reader returns for one photo. */
const receiptPhotoExtraction = z.object({
  lines: z.array(
    z.object({
      receiptText: z.string(),
      item: z.string().nullable(),
      quantity: z.number(),
      // The price charged for the line, in dollars, as printed;
      // null when no price is printed beside the item or it
      // can't be read.
      price: z.number().nullable(),
    }),
  ),
  // The receipt's grand total (the TOTAL amount) in dollars as
  // printed; null when it isn't legible in the photo.
  total: z.number().nullable(),
  note: z.string().nullable(),
});

/** A money amount read off a receipt, kept only when sane. */
function receiptMoney(value: number | null | undefined): number | null {
  if (value == null || !Number.isFinite(value)) return null;
  if (value < 0 || value > 1_000_000) return null;
  return Math.round(value * 100) / 100;
}

type ReceiptPhotoLine = {
  receiptText: string;
  item: string | null;
  quantity: number;
  price: number | null;
};

/**
 * The vision read itself, shared by the in-app proposal read
 * (readReceiptScanInline) and the totals re-read
 * (rereadReceiptScan): scans the photo for the PURCHASED line
 * items (each matched against the canonical HIT List names — a
 * match is only kept when it names a real list item), each line's
 * price as printed, and the receipt's grand total. Writes
 * nothing; the callers decide what to store.
 */
async function extractReceiptPhoto(
  ctx: Ctx,
  scan: { id: number; qrValue: string | null },
  image: { dataBase64: string; mimeType: "image/jpeg" | "image/png" },
): Promise<{
  lines: ReceiptPhotoLine[];
  total: number | null;
  note: string | null;
}> {
  const db = ctx.db<typeof schema>();
  // Canonical HIT List names (sheet rows + app-added items) — a
  // proposed match is only kept when it names a real item.
  const [hitRows, addedRows] = await Promise.all([
    db.select().from(schema.hitItems),
    db.select().from(schema.hitAddedItems),
  ]);
  const canonical = new Map<string, string>();
  for (const r of hitRows) {
    canonical.set(r.item.trim().toLowerCase(), r.item);
  }
  for (const r of addedRows) {
    const key = r.item.trim().toLowerCase();
    if (!canonical.has(key)) canonical.set(key, r.item);
  }
  const itemNames = [...canonical.values()].sort((a, b) =>
    a.localeCompare(b),
  );
  const read = await ctx.inference.complete(
    [
      "Read the store receipt in this photo and extract the items that were PURCHASED.",
      "For each purchased item return one line: receiptText — the item's text exactly as printed on the receipt (when one item's name wraps over two printed lines, combine them into one line); quantity — how many were bought: when the receipt shows a quantity multiplier for the line (e.g. \"2 @ 3.99\") the quantity is that multiplier, for an item sold by weight (e.g. \"0.260 kg @ $8.80/kg\") the quantity is 1, otherwise 1; price — the amount charged for that line in dollars, as printed at the end of the line (for a \"2 @ 3.99\" line, the line's extended amount when one is printed, otherwise the unit price times the quantity), or null when no price is printed beside the item or it can't be read; item — the HIT List item this purchase plainly is, copied exactly from the list below, or null when no list item plainly matches it. Receipts abbreviate heavily, so match the line to the list item it plainly refers to (the same product); never force a match.",
      "Also return total: the receipt's grand total in dollars — the TOTAL amount printed on the receipt — or null when it isn't legible in the photo. Skip department headers, subtotals, taxes, change, payment and loyalty / points lines, savings summaries, and per-item discount or \"Saving\" lines AS ITEMS — only the items bought become lines; the total is reported separately, never as a line. Do not invent items, quantities, prices or a total that aren't on the receipt.",
      scan.qrValue
        ? `A QR code was decoded from this photo; its value is: ${scan.qrValue}. Read the printed receipt in the photo itself.`
        : "Read the printed receipt in the photo.",
      "note: one short line naming the store and the receipt date when legible; when nothing could be read, say why in the note and return no lines.",
      "",
      "HIT List items:",
      ...itemNames.map((n) => `- ${n}`),
    ].join("\n"),
    {
      images: [
        {
          dataBase64: image.dataBase64,
          mimeType: image.mimeType,
          caption: "A photo of a store receipt",
        },
      ],
      schema: receiptPhotoExtraction,
      timeout_secs: 120,
    },
  );
  const lines = read.lines
    .filter((l) => l.receiptText.trim().length > 0)
    .slice(0, 80)
    .map((l) => ({
      receiptText: l.receiptText.trim().slice(0, 300),
      item:
        l.item != null
          ? (canonical.get(l.item.trim().toLowerCase()) ?? null)
          : null,
      quantity: Number.isFinite(l.quantity)
        ? Math.min(999, Math.max(0, Math.floor(l.quantity)))
        : 0,
      price: receiptMoney(l.price),
    }));
  return {
    lines,
    total: receiptMoney(read.total),
    note: read.note?.trim() ? read.note.trim().slice(0, 300) : null,
  };
}

/**
 * Reads one receipt scan's photo IN THE APP, synchronously: the
 * vision model scans the image for the PURCHASED line items, each
 * matched against the HIT List names (the list rides along in the
 * prompt; a match is only kept when it names a real list item,
 * exactly as setReceiptScanResult validates), each line's price
 * as printed, and the receipt's grand total, and the proposal is
 * written straight onto the scan (status "proposed") — the same
 * write the background reader makes through setReceiptScanResult.
 * This is the primary read: it runs inside the action that asked
 * for it, so a scan's review is ready when the call returns
 * instead of waiting on an outside process to pick the scan up
 * (the failure the user hit — a legible photo sat "waiting to be
 * read" for over an hour because the background task never wrote
 * back). Returns { done: false } in the one case the in-app read
 * can't cover: nothing readable in the photo itself, but the
 * photo's QR code links to the digital receipt — the scan then
 * stays "pending" for the background reader, which can open the
 * link. A photo with nothing readable and no QR link still
 * completes: proposed with no lines and the reader's note saying
 * why. Throws when the model read itself fails; callers fall back
 * to the background reader.
 */
async function readReceiptScanInline(
  ctx: Ctx,
  scan: { id: number; qrValue: string | null },
  image: { dataBase64: string; mimeType: string },
): Promise<{ done: boolean }> {
  const mime = image.mimeType;
  if (mime !== "image/jpeg" && mime !== "image/png") {
    return { done: false };
  }
  const db = ctx.db<typeof schema>();
  const { lines, total, note } = await extractReceiptPhoto(ctx, scan, {
    dataBase64: image.dataBase64,
    mimeType: mime,
  });
  const qrIsLink =
    scan.qrValue != null && /^https?:\/\//i.test(scan.qrValue.trim());
  if (lines.length === 0 && qrIsLink) {
    // Nothing readable in the photo itself, but the QR code links
    // to the digital receipt — leave the scan pending for the
    // background reader, which can open the link.
    return { done: false };
  }
  await db
    .update(schema.receiptScans)
    .set({
      status: "proposed",
      linesJson: JSON.stringify(lines),
      total,
      note,
      updatedAt: new Date(),
    })
    .where(
      and(
        eq(schema.receiptScans.id, scan.id),
        eq(schema.receiptScans.status, "pending"),
      ),
    );
  return { done: true };
}

/**
 * Fallback read for one receipt scan (status "pending"): a
 * background agent task that fetches the scan's photo via
 * getPendingReceiptScans, reads the PURCHASED line items off the
 * receipt (following the photo's QR code to the digital receipt
 * when one was decoded), matches each line to a HIT List item, and
 * writes the proposal back with setReceiptScanResult. The in-app
 * reader (readReceiptScanInline) is the primary read; this task is
 * started only for the case it can't cover — a photo whose only
 * readable content is a QR code linking to the digital receipt —
 * or when the in-app read itself failed. The dedupe key makes
 * repeat calls for the same scan safe. Returns the spawn outcome;
 * on failure the scan keeps its "pending" status and the reason is
 * stamped into its note, where the app shows it.
 */
async function spawnReceiptScanRead(
  ctx: Ctx,
  scan: { id: number; qrValue: string | null },
): Promise<{ ok: boolean; error: string | null }> {
  const result = await ctx.agent.spawnTask(
    [
      `Read a store receipt photo and extract the items purchased, for the HitBit Shopping List app's receipt-scan restock review. The scan is receipt scan #${scan.id}.`,
      "",
      `1. Call the getPendingReceiptScans action and find scan #${scan.id}; open its imageUrl to see the receipt photo.${
        scan.qrValue
          ? ` A QR code was decoded from the photo in the app; its value is: ${scan.qrValue} — when that value is a link to the digital receipt, open it and read the purchased items from the digital receipt. When the photo is only a QR code and the link can't be opened, read whatever the photo itself shows.`
          : " The photo may carry a QR code linking to the digital receipt — if you can decode one from the photo and it links to the receipt, read the purchased items from there; otherwise read the printed receipt in the photo."
      }`,
      "2. Extract every PURCHASED line item on the receipt: the line's text as printed on the receipt, the quantity purchased — when a line shows a quantity multiplier (e.g. \"2 @ 3.99\") the quantity is that multiplier, otherwise 1 — and the price charged for the line in dollars as printed (null when no price is printed beside the item or it can't be read). Also read the receipt's grand total (the TOTAL amount) in dollars, or null when it isn't legible. Skip subtotals, taxes, change, payment and loyalty lines, and per-item discount/savings lines AS ITEMS — only the items bought become lines; the total is reported separately, never as a line. Do not invent items, quantities, prices or a total that aren't on the receipt.",
      "3. Call the getHitList action and match each purchased line to a HIT List item by its exact item name. Receipts abbreviate, so match the line to the HIT List item it plainly refers to (the same product); when no HIT List item plainly matches, leave that line unmatched (item: null). Never force a match.",
      `4. Call the setReceiptScanResult action exactly once with { id: ${scan.id}, lines: [{ receiptText, item, quantity, price }], total: <the receipt's grand total in dollars, or null>, note: <one short line: the store name and receipt date when legible, or why nothing could be read> }. If the photo can't be read, or it shows no purchased items, still call it exactly once with an empty lines list, a null total, and a note saying why.`,
      "Do not confirm anything and do not record any stock — the user reviews the proposal in the app and confirms it themselves.",
    ].join("\n"),
    {
      expectsAction: "setReceiptScanResult",
      dedupeKey: `receipt-scan-${scan.id}`,
    },
  );
  if (!result.ok) {
    const db = ctx.db<typeof schema>();
    await db
      .update(schema.receiptScans)
      .set({
        note: `Automatic reading couldn't be started: ${result.error}`,
        updatedAt: new Date(),
      })
      .where(eq(schema.receiptScans.id, scan.id));
    return { ok: false, error: result.error };
  }
  return { ok: true, error: null };
}

/**
 * The restore itself, shared by restoreReceiptScan (the Receipt
 * scans Restore button) and recoverReceiptScan (Beta 0.14, which
 * restores and then re-reads for the total in one step): a
 * DISMISSED scan goes back to review ("proposed" when it has read
 * lines, "pending" when it was dismissed before its read
 * finished), and a CONFIRMED scan whose confirmation was undone
 * gets its stock additions back — the exact inverse of
 * undoReceiptScan. Returns an error message when the scan doesn't
 * exist or isn't removed; null when the restore was written.
 */
async function performReceiptScanRestore(
  ctx: Ctx,
  id: number,
): Promise<string | null> {
  const db = ctx.db<typeof schema>();
  const rows = await db
    .select()
    .from(schema.receiptScans)
    .where(eq(schema.receiptScans.id, id));
  const row = rows[0];
  if (!row) {
    return "That receipt scan no longer exists.";
  }
  if (row.status === "dismissed") {
    let hasLines = false;
    if (row.linesJson) {
      try {
        const parsed: unknown = JSON.parse(row.linesJson);
        hasLines = Array.isArray(parsed) && parsed.length > 0;
      } catch {
        hasLines = false;
      }
    }
    await db
      .update(schema.receiptScans)
      .set({
        status: hasLines ? "proposed" : "pending",
        updatedAt: new Date(),
      })
      .where(eq(schema.receiptScans.id, id));
    ctx.invalidateQueries();
    return null;
  }
  if (row.status !== "confirmed" || row.undoneAt == null) {
    return "That scan isn't removed — there's nothing to restore.";
  }
  const statements: BatchItem<"sqlite">[] = [];
  const linked = await db
    .select()
    .from(schema.stockAdjustments)
    .where(eq(schema.stockAdjustments.receiptScanId, id));
  const undoneLinked = linked.filter((a) => a.undone === 1);
  if (undoneLinked.length > 0) {
    for (const adj of undoneLinked) {
      if (adj.appliedAt == null) {
        // Retired before it ever counted — let it count again.
        statements.push(
          db
            .update(schema.stockAdjustments)
            .set({ undone: 0, undoneAt: null })
            .where(eq(schema.stockAdjustments.id, adj.id)),
        );
      } else {
        // Already applied when the undo recorded its compensating
        // 'receipt-undo' adjustment — re-add the quantity with a
        // fresh linked adjustment, which nets against the
        // compensation whether or not that has been applied yet.
        statements.push(
          db.insert(schema.stockAdjustments).values({
            item: adj.item,
            delta: adj.delta,
            source: "receipt",
            receiptScanId: id,
            actor: row.actor,
          }),
        );
      }
    }
  } else if (linked.length === 0) {
    // Legacy scan (confirmed before adjustments carried the scan
    // link): re-record from the confirmed lines stored on the
    // scan, linked this time so a later undo reverses exactly
    // these rows.
    let lines: { item: string | null; quantity: number }[] = [];
    if (row.linesJson) {
      try {
        const parsed: unknown = JSON.parse(row.linesJson);
        if (Array.isArray(parsed)) {
          lines = parsed as typeof lines;
        }
      } catch {
        lines = [];
      }
    }
    for (const line of lines) {
      if (line.item == null || line.quantity <= 0) continue;
      statements.push(
        db.insert(schema.stockAdjustments).values({
          item: line.item,
          delta: line.quantity,
          source: "receipt",
          receiptScanId: id,
          actor: row.actor,
        }),
      );
    }
  }
  statements.push(
    db
      .update(schema.receiptScans)
      .set({ undoneAt: null, updatedAt: new Date() })
      .where(eq(schema.receiptScans.id, id)),
  );
  const [first, ...rest] = statements;
  if (first) await db.batch([first, ...rest]);
  ctx.invalidateQueries();
  return null;
}

/**
 * The totals merge, shared by rereadReceiptScan (the in-app
 * re-read) and setReceiptScanTotal (the background recovery
 * reader's write-back): a fresh read's prices are merged onto the
 * scan's stored lines by receipt text and its total onto the scan
 * — items, quantities, matches, status and recorded stock are
 * never touched. A total already on the scan is kept. Writes only
 * when something actually changed; returns the total now on the
 * scan (null when neither the scan nor the fresh read has one).
 */
async function mergeReceiptReread(
  ctx: Ctx,
  row: { id: number; linesJson: string | null; total: number | null },
  freshLines: { receiptText: string; price: number | null }[],
  freshTotal: number | null,
): Promise<number | null> {
  const db = ctx.db<typeof schema>();
  const norm = (s: string) => s.trim().toLowerCase().replace(/\s+/g, " ");
  const priceByText = new Map<string, number>();
  for (const l of freshLines) {
    if (l.price != null) priceByText.set(norm(l.receiptText), l.price);
  }
  type StoredLine = {
    receiptText: string;
    item: string | null;
    quantity: number;
    price?: number | null;
  };
  let stored: StoredLine[] = [];
  if (row.linesJson) {
    try {
      const parsed: unknown = JSON.parse(row.linesJson);
      if (Array.isArray(parsed)) stored = parsed as StoredLine[];
    } catch {
      stored = [];
    }
  }
  let mergedAny = false;
  const nextLines = stored.map((l) => {
    if (l.price != null) return l;
    const price = priceByText.get(norm(l.receiptText ?? ""));
    if (price == null) return l;
    mergedAny = true;
    return { ...l, price };
  });
  const total = row.total ?? receiptMoney(freshTotal);
  if (mergedAny || total !== (row.total ?? null)) {
    await db
      .update(schema.receiptScans)
      .set({
        linesJson: JSON.stringify(nextLines),
        total,
        updatedAt: new Date(),
      })
      .where(eq(schema.receiptScans.id, row.id));
  }
  ctx.invalidateQueries();
  return total;
}

/**
 * Starts the background reader that fills in a recovered scan's
 * missing total (recoverReceiptScan): the task fetches the scan's
 * stored photo via getReceiptScans, reads the receipt's grand
 * total and each line's price off it, and writes them back with
 * setReceiptScanTotal. The dedupe key makes repeat recoveries of
 * the same scan safe. Returns whether the read started; on failure
 * the reason is stamped into the scan's note, where the app shows
 * it, exactly as spawnReceiptScanRead does.
 */
async function spawnReceiptTotalRead(
  ctx: Ctx,
  scan: { id: number },
): Promise<{ ok: boolean; error: string | null }> {
  const result = await ctx.agent.spawnTask(
    [
      `Re-read a store receipt photo to capture its grand total and line prices, for the HitBit Shopping List app. The scan is receipt scan #${scan.id}; it already exists in the app's Receipt scans and its items were already read — only its total (and line prices) are missing, because its original read predates totals being captured.`,
      "",
      `1. Call the getReceiptScans action and find scan #${scan.id}; open its imageUrl to see the receipt photo.`,
      "2. Read the receipt's grand total — the TOTAL amount printed on the receipt — in dollars, and the price charged for each purchased line (the amount at the end of the line, in dollars, as printed). Skip subtotals, taxes, change, payment and loyalty / points lines, savings summaries, and per-item discount or \"Saving\" lines — the total is the grand TOTAL only. Do not invent a total or prices that aren't legible in the photo.",
      `3. Call the setReceiptScanTotal action exactly once with { id: ${scan.id}, total: <the grand total in dollars, or null when it isn't legible>, lines: [{ receiptText: <the purchased line's text exactly as printed on the receipt>, price: <the line's price in dollars, or null when none is printed or it can't be read> }] — one entry per purchased line you could read. If the photo can't be read at all, still call it exactly once with a null total and an empty lines list.`,
      "Do not confirm anything and do not record any stock — this only fills in the total and line prices on a scan that already exists.",
    ].join("\n"),
    {
      expectsAction: "setReceiptScanTotal",
      dedupeKey: `receipt-total-${scan.id}`,
    },
  );
  if (!result.ok) {
    const db = ctx.db<typeof schema>();
    await db
      .update(schema.receiptScans)
      .set({
        note: `The total re-read couldn't be started: ${result.error}`,
        updatedAt: new Date(),
      })
      .where(eq(schema.receiptScans.id, scan.id));
    return { ok: false, error: result.error };
  }
  return { ok: true, error: null };
}

export const Actions = {
  getList: defineAction({
    description:
      "Returns the cached Shopping List rows (from the connected household sheet, when one is set) with check-off state and per-item purchase-confirmation (restocked) state, the sheet's updated stamp, and the last refresh time.",
    request: z.object({}),
    response: getListResponse,
    handler: async (ctx): Promise<z.infer<typeof getListResponse>> => {
      const db = ctx.db<typeof schema>();
      const [rows, metaRows, checkedRows, watchedRows, obsRows, sourceRows] =
        await Promise.all([
          db
            .select()
            .from(schema.listItems)
            .orderBy(asc(schema.listItems.sortOrder)),
          db.select().from(schema.listMeta),
          db.select().from(schema.checkedItems),
          db.select().from(schema.watchedItems),
          db
            .select()
            .from(schema.priceObservations)
            .orderBy(asc(schema.priceObservations.id)),
          db.select().from(schema.itemSources),
        ]);
      const checked = new Set(
        checkedRows.filter((r) => r.checked === 1).map((r) => r.itemKey),
      );
      // A confirmation survives an un-check (the row is kept,
      // flagged unchecked), so restocked is read off every row.
      const restocked = new Set(
        checkedRows
          .filter((r) => r.restockedAt != null)
          .map((r) => r.itemKey),
      );
      const watched = new Set(
        watchedRows.map((r) => r.item.trim().toLowerCase()),
      );
      // Recorded price sources by item name + canonical section
      // (sources live in their own table, so saveList refreshes
      // never wipe them). An item listed in two sections keeps a
      // separate source per row; rows recorded before section
      // keying (section "") fall back to any section of that item.
      const sourceByItemSection = new Map<
        string,
        z.infer<typeof sourceShape>
      >();
      const legacySourceByItem = new Map<
        string,
        z.infer<typeof sourceShape>
      >();
      for (const s of sourceRows) {
        const shape: z.infer<typeof sourceShape> = {
          url: s.url,
          sourceType: s.sourceType,
          store: s.store,
          updatedDate: s.updatedDate,
        };
        const itemName = s.item.trim().toLowerCase();
        if (s.section === "") {
          legacySourceByItem.set(itemName, shape);
        } else {
          sourceByItemSection.set(
            `${itemName}|${canonicalSectionTitle(s.section).toLowerCase()}`,
            shape,
          );
        }
      }
      // Price trends from the observation log: per item, the lowest
      // price seen (with its date) and whether the latest observation
      // moved down, up, or not at all vs the one before it. Needs at
      // least two observations — otherwise no trend is shown.
      const trendByItem = new Map<
        string,
        z.infer<typeof priceTrendShape>
      >();
      const obsByItem = new Map<string, typeof obsRows>();
      for (const o of obsRows) {
        const key = o.item.trim().toLowerCase();
        const list = obsByItem.get(key) ?? [];
        list.push(o);
        obsByItem.set(key, list);
      }
      for (const [key, list] of obsByItem) {
        if (list.length < 2) continue;
        let lowest = list[0];
        for (const o of list) {
          if (lowest && o.priceCents < lowest.priceCents) lowest = o;
        }
        const latest = list[list.length - 1];
        const prev = list[list.length - 2];
        if (!lowest || !latest || !prev) continue;
        trendByItem.set(key, {
          lowestCents: lowest.priceCents,
          lowestDate: shortDateLabel(lowest.date),
          direction:
            latest.priceCents < prev.priceCents
              ? "down"
              : latest.priceCents > prev.priceCents
                ? "up"
                : "same",
        });
      }
      const meta = metaRows[0];
      return {
        updatedStamp: meta?.updatedStamp ?? null,
        refreshedAt: meta?.refreshedAt
          ? meta.refreshedAt.toISOString()
          : null,
        items: rows.map((row) => {
          const key = itemKey(row.section, row.item);
          const itemName = row.item.trim().toLowerCase();
          return {
            key,
            section: row.section,
            item: row.item,
            stock: row.stock,
            usualStore: row.usualStore,
            bestPriceRaw: row.bestPriceRaw,
            priceCents: row.priceCents,
            savingsNote: row.savingsNote,
            buyAt: row.buyAt,
            endOfSale: row.endOfSale,
            exactProduct: row.exactProduct,
            checked: checked.has(key),
            restocked: restocked.has(key),
            watched: watched.has(itemName),
            priceTrend: trendByItem.get(itemName) ?? null,
            source:
              sourceByItemSection.get(
                `${itemName}|${canonicalSectionTitle(row.section).toLowerCase()}`,
              ) ??
              legacySourceByItem.get(itemName) ??
              null,
          };
        }),
      };
    },
  }),

  saveList: defineAction({
    description:
      "Replaces the cached Shopping List with rows freshly read from the household sheet's Shopping List tab. Called by the refresh agent task; preserves check-off state for items still on the list and prunes the rest. Section titles are normalized to the canonical current titles (\"Out of Stock\", \"Low Stock on Sale Now\", \"Membership Alternatives\") as they're stored, so retired spellings (\"0 Stock\", \"FFS (Frequent Flyer Alternatives)\", \"Costco Alt.\") don't linger in the cache, and check-off rows recorded under an old spelling are re-keyed to the canonical one instead of being pruned. Also appends each priced item to the app's price-observation log (one observation per item per day per distinct price) that powers the lowest-seen price trends.",
    request: z.object({
      updatedStamp: z.string().nullable(),
      items: z.array(
        z.object({
          section: z.string().min(1),
          item: z.string().min(1),
          stock: z.number().int().min(0),
          usualStore: z.string(),
          bestPrice: z.string().nullable(),
          buyAt: z.string().nullable(),
          endOfSale: z.string().nullable(),
          exactProduct: z.string().nullable(),
        }),
      ),
    }),
    response: z.object({ saved: z.number() }),
    handler: async (ctx, args): Promise<{ saved: number }> => {
      const db = ctx.db<typeof schema>();
      const statements: BatchItem<"sqlite">[] = [
        db.delete(schema.listItems),
        db
          .insert(schema.listMeta)
          .values({
            id: 1,
            updatedStamp: args.updatedStamp,
            refreshedAt: new Date(),
          })
          .onConflictDoUpdate({
            target: schema.listMeta.id,
            set: {
              updatedStamp: args.updatedStamp,
              refreshedAt: new Date(),
            },
          }),
      ];
      args.items.forEach((it, i) => {
        const { priceCents, savingsNote } = parsePrice(it.bestPrice);
        statements.push(
          db.insert(schema.listItems).values({
            section: canonicalSectionTitle(it.section),
            item: it.item,
            stock: it.stock,
            usualStore: it.usualStore,
            bestPriceRaw: it.bestPrice,
            priceCents,
            savingsNote,
            buyAt: it.buyAt,
            endOfSale: it.endOfSale,
            exactProduct: it.exactProduct,
            sortOrder: i,
          }),
        );
      });
      const keepKeys = new Set(
        args.items.map((it) =>
          itemKey(canonicalSectionTitle(it.section), it.item),
        ),
      );
      const checkedRows = await db.select().from(schema.checkedItems);
      const claimedKeys = new Set<string>();
      for (const row of checkedRows) {
        // A check-off row recorded under a retired section spelling
        // belongs to the same row under its canonical title: re-key
        // it (checked flag and any Purchased stamp ride along)
        // instead of pruning it as if the item had left the list.
        const sep = row.itemKey.indexOf("::");
        const rowSection = sep >= 0 ? row.itemKey.slice(0, sep) : "";
        const normalizedKey = itemKey(
          canonicalSectionTitle(rowSection),
          itemNameOfKey(row.itemKey),
        );
        if (keepKeys.has(normalizedKey) && !claimedKeys.has(normalizedKey)) {
          claimedKeys.add(normalizedKey);
          if (normalizedKey !== row.itemKey) {
            statements.push(
              db
                .update(schema.checkedItems)
                .set({ itemKey: normalizedKey })
                .where(eq(schema.checkedItems.itemKey, row.itemKey)),
            );
          }
        } else {
          statements.push(
            db
              .delete(schema.checkedItems)
              .where(eq(schema.checkedItems.itemKey, row.itemKey)),
          );
        }
      }
      // Price observation log: one dated observation per item per
      // distinct price (a same-day re-refresh at the same price adds
      // nothing). Rows without a parseable price are skipped — the
      // log only ever holds prices actually seen on the sheet.
      const today = todayKeyToronto();
      const existingObs = await db.select().from(schema.priceObservations);
      const seenObs = new Set(
        existingObs.map(
          (o) => `${o.item.trim().toLowerCase()}|${o.date}|${o.priceCents}`,
        ),
      );
      for (const it of args.items) {
        const { priceCents } = parsePrice(it.bestPrice);
        if (priceCents == null) continue;
        const obsKey = `${it.item.trim().toLowerCase()}|${today}|${priceCents}`;
        if (seenObs.has(obsKey)) continue;
        seenObs.add(obsKey);
        statements.push(
          db.insert(schema.priceObservations).values({
            item: it.item,
            priceCents,
            store: it.buyAt,
            date: today,
          }),
        );
      }
      const [first, ...rest] = statements;
      if (first) await db.batch([first, ...rest]);
      ctx.invalidateQueries();
      return { saved: args.items.length };
    },
  }),

  setItemSource: defineAction({
    description:
      "Records (or replaces) where a Shopping List item's price was found: the exact URL the price was verified on — the Flipp flyer/item URL when the sale was found on Flipp (sourceType \"flipp\"), otherwise the store product-page URL (sourceType \"website\"). Keyed by item name + section in its own table, so sheet refreshes never wipe it and an item listed in two sections (Out of Stock + Membership Alternatives) keeps a separate source per row: pass the section the priced row sits in (any known spelling — it's stored under the canonical title). When section is omitted the source is stored section-less and applies to the item in any section (legacy behaviour). The grocery scan jobs call this when they write a price to the Shopping List; only record a URL that was actually opened and verified — never guess one.",
    request: z.object({
      item: z.string().min(1),
      section: z.string().max(120).nullable().optional(),
      url: z
        .string()
        .url()
        .refine((u) => /^https?:\/\//i.test(u), {
          message: "Source URL must be http(s)",
        }),
      sourceType: z.enum(["flipp", "website"]),
      store: z.string().nullable().optional(),
    }),
    response: z.object({ ok: z.literal(true) }),
    handler: async (ctx, args): Promise<{ ok: true }> => {
      const db = ctx.db<typeof schema>();
      const item = args.item.trim();
      const section = args.section?.trim()
        ? canonicalSectionTitle(args.section)
        : "";
      const now = new Date();
      await db
        .insert(schema.itemSources)
        .values({
          item,
          section,
          url: args.url,
          sourceType: args.sourceType,
          store: args.store?.trim() ? args.store.trim() : null,
          updatedDate: todayKeyToronto(),
          updatedAt: now,
        })
        .onConflictDoUpdate({
          target: [schema.itemSources.item, schema.itemSources.section],
          set: {
            url: args.url,
            sourceType: args.sourceType,
            store: args.store?.trim() ? args.store.trim() : null,
            updatedDate: todayKeyToronto(),
            updatedAt: now,
          },
        });
      ctx.invalidateQueries();
      return { ok: true };
    },
  }),

  getItemSources: defineAction({
    description:
      "Returns every recorded Shopping List price source (item name, section — the canonical section title, or \"\" for section-less records — URL, source type \"flipp\"/\"website\", store, and the date it was recorded), newest first. The grocery scan jobs use this to see which items already have a source on file; the Shopping List tab reads the same records through getList.",
    request: z.object({}),
    response: z.object({
      sources: z.array(
        z.object({
          item: z.string(),
          section: z.string(),
          url: z.string(),
          sourceType: z.enum(["flipp", "website"]),
          store: z.string().nullable(),
          updatedDate: z.string(),
        }),
      ),
    }),
    handler: async (
      ctx,
    ): Promise<{
      sources: {
        item: string;
        section: string;
        url: string;
        sourceType: "flipp" | "website";
        store: string | null;
        updatedDate: string;
      }[];
    }> => {
      const db = ctx.db<typeof schema>();
      const rows = await db
        .select()
        .from(schema.itemSources)
        .orderBy(desc(schema.itemSources.updatedAt));
      return {
        sources: rows.map((r) => ({
          item: r.item,
          section: r.section,
          url: r.url,
          sourceType: r.sourceType,
          store: r.store,
          updatedDate: r.updatedDate,
        })),
      };
    },
  }),

  refreshList: defineAction({
    description:
      "Starts a background refresh that re-reads the Shopping List tab of the household Google Sheet and saves the current rows into this app.",
    request: z.object({}),
    response: z.object({
      started: z.boolean(),
      taskId: z.string().nullable(),
      error: z.string().nullable(),
    }),
    handler: async (
      ctx,
    ): Promise<{
      started: boolean;
      taskId: string | null;
      error: string | null;
    }> => {
      if (!SPREADSHEET_ID) {
        return {
          started: false,
          taskId: null,
          error:
            "No household sheet is configured — set SPREADSHEET_ID in server/src/actions.ts to your sheet's ID first.",
        };
      }
      const result = await ctx.agent.spawnTask(
        [
          "Refresh the Shopping List app's cached data from Google Sheets.",
          "",
          `1. Confirm Google Sheets is connected: run \`/opt/hatch/bin/hatch_gws_cli sheets status\`. If it is not connected, stop and report that.`,
          `2. Read the Shopping List tab of the household spreadsheet (spreadsheetId ${SPREADSHEET_ID}): run \`/opt/hatch/bin/hatch_gws_cli sheets spreadsheets values get --params '{"spreadsheetId":"${SPREADSHEET_ID}","range":"Shopping List!A1:Z80"}'\`.`,
          "3. Parse the values grid with these rules:",
          "   - Row 1 is the title (ignore). Row 2 is the updated stamp, e.g. \"Updated Nov 12, 2026\" — pass it verbatim as updatedStamp (null if absent).",
          "   - A row with a single non-empty cell whose text is one of \"Out of Stock\", \"Low Stock on Sale Now\", \"Membership Alternatives\" (older sheets may say \"Membership alternatives\", \"0 Stock\", \"FFS (Frequent Flyer Alternatives)\", \"FFS\", or \"Costco Alt.\") starts a new section; following rows belong to it. Pass the section name through verbatim.",
          "   - A row whose first cell is \"Item\" is a column header (columns: Item, Stock, Usual Store, Best Price, Buy At, End of Sale, Exact Product) — skip it.",
          "   - Blank rows are separators — skip them.",
          "   - Every other row is an item in the current section: item = col A, stock = col B parsed as an integer, usualStore = col C, bestPrice = col D (null when empty — never invent a price), buyAt = col E (null when empty), endOfSale = col F (null when empty), exactProduct = col G (null when empty).",
          "4. Call the saveList action exactly once with { updatedStamp, items } containing every parsed item in sheet order.",
          "Do not edit the spreadsheet. Do not add, drop, or reorder items.",
        ].join("\n"),
        { expectsAction: "saveList", dedupeKey: "shopping-list-refresh" },
      );
      if (!result.ok) {
        return { started: false, taskId: null, error: result.error };
      }
      return { started: true, taskId: result.taskId, error: null };
    },
  }),

  setChecked: defineAction({
    description:
      "Marks a Shopping List item as struck off (checked) or not. Local to this app only; the Google Sheet is not changed, and checking an item off never changes inventory by itself — only the item's Purchased confirmation does. Un-checking flips the row's checked flag rather than deleting the row, so a purchase confirmation (restocked stamp) survives an un-check / re-check within the same list; saveList still prunes rows for items that leave the list.",
    request: z.object({ key: z.string().min(1), checked: z.boolean() }),
    response: z.object({ ok: z.literal(true) }),
    handler: async (ctx, args): Promise<{ ok: true }> => {
      const db = ctx.db<typeof schema>();
      if (args.checked) {
        await db
          .insert(schema.checkedItems)
          .values({ itemKey: args.key, checked: 1 })
          .onConflictDoUpdate({
            target: schema.checkedItems.itemKey,
            set: { checked: 1 },
          });
      } else {
        await db
          .update(schema.checkedItems)
          .set({ checked: 0 })
          .where(eq(schema.checkedItems.itemKey, args.key));
      }
      ctx.invalidateQueries();
      return { ok: true as const };
    },
  }),

  confirmPurchased: defineAction({
    description:
      "Confirms ONE struck-off Shopping List item from its on-row Purchased button: records a pending stock adjustment (+quantity from the row's counter, source 'finish-shop') for the HIT List item it matches by name, so its stock in the app goes up right away, and stamps the item confirmed so its button shows 'Purchased ✓' and it can't be recorded twice. The guard is per INVENTORY ITEM across all sections: the same item can sit in two sections at once (Out of Stock + Membership Alternatives), and a purchase confirmed from any one of its rows blocks a second recording from any other row in the same list — every checked row for the item is stamped together. If the item has no checked row at all there is nothing to stamp, so nothing is recorded. The sheet itself is not edited (read-only connection) — Muse's auto-scan applies the adjustment to the sheet later via getPendingStockAdjustments / markStockAdjustmentsApplied. An item with no matching HIT List item records nothing and reports matched: false; an already-confirmed item reports alreadyConfirmed: true and records nothing again. Each recorded purchase also writes a purchase_log row linked to its adjustment, which the HIT List Activity log lists and undoPurchase can reverse.",
    request: z.object({
      key: z.string().min(1),
      item: z.string().min(1).max(120),
      quantity: z.number().int().min(1).max(999),
    }),
    response: z.object({
      matched: z.boolean(),
      alreadyConfirmed: z.boolean(),
      recorded: z.boolean(),
    }),
    handler: async (
      ctx,
      args,
    ): Promise<{
      matched: boolean;
      alreadyConfirmed: boolean;
      recorded: boolean;
    }> => {
      const db = ctx.db<typeof schema>();
      const [hitRows, addedRows, allCheckedRows] = await Promise.all([
        db.select().from(schema.hitItems),
        db.select().from(schema.hitAddedItems),
        db.select().from(schema.checkedItems),
      ]);
      // Match by item name, preferring the sheet's own spelling.
      const canonical = new Map<string, string>();
      for (const r of hitRows) {
        canonical.set(r.item.trim().toLowerCase(), r.item);
      }
      for (const r of addedRows) {
        const key = r.item.trim().toLowerCase();
        if (!canonical.has(key)) canonical.set(key, r.item);
      }
      const name = canonical.get(args.item.trim().toLowerCase());
      if (!name) {
        return { matched: false, alreadyConfirmed: false, recorded: false };
      }
      // The double-confirm guard is per inventory item across ALL
      // sections: every checked row whose key names this item,
      // whatever section it sits in. One purchase covers the item —
      // if any of its rows is already stamped, nothing records
      // again; if it has no checked row at all, there is nothing to
      // stamp, so nothing records either.
      const nameKey = name.trim().toLowerCase();
      const itemRows = allCheckedRows.filter(
        (r) => itemNameOfKey(r.itemKey).trim().toLowerCase() === nameKey,
      );
      if (itemRows.some((r) => r.restockedAt != null)) {
        return { matched: true, alreadyConfirmed: true, recorded: false };
      }
      if (itemRows.length === 0) {
        return { matched: true, alreadyConfirmed: false, recorded: false };
      }
      // Record the adjustment first so its id can link the
      // purchase-log row (the Activity log's purchase entry, whose
      // Undo reverses exactly this adjustment).
      const { role } = await loadAccountSettings(ctx);
      const [adj] = await db
        .insert(schema.stockAdjustments)
        .values({
          item: name,
          delta: args.quantity,
          source: "finish-shop",
          actor: role,
        })
        .returning({ id: schema.stockAdjustments.id });
      const statements: BatchItem<"sqlite">[] = [
        db.insert(schema.purchaseLog).values({
          item: name,
          quantity: args.quantity,
          adjustmentId: adj?.id ?? null,
          actor: role,
        }),
      ];
      // Stamp every checked row for the item, so its row in any
      // other section also shows "Purchased ✓" and stays blocked.
      for (const row of itemRows) {
        statements.push(
          db
            .update(schema.checkedItems)
            .set({ restockedAt: new Date() })
            .where(eq(schema.checkedItems.itemKey, row.itemKey)),
        );
      }
      const [first, ...rest] = statements;
      if (first) await db.batch([first, ...rest]);
      ctx.invalidateQueries();
      return { matched: true, alreadyConfirmed: false, recorded: true };
    },
  }),

  // ---- HIT List tab -------------------------------------------------
  // The same workbook's "HIT List" tab is the household inventory
  // (Category | Item Name | Stock | Store | Notes, data from row 6).
  // It is cached exactly like the Shopping List; the Meal Planner tab
  // reads its protein stock from this cache.

  getHitList: defineAction({
    description:
      "Returns the household inventory: cached HIT List rows from the sheet merged with items added in the app (which carry their formal name/SKU and price-check results), with totals, the last refresh time, the most recent daily stock snapshot date (lastCountedDate — the counted-last stamp; null when no snapshot exists), and how many app-added items are still waiting to be included in the sync updates to the shared household copy. Stock counts are effective stock (sheet count + app-side adjustments not yet applied to the sheet); each item also carries its sheet count, pending delta, sale-watch star state, a run-out forecast in days when snapshot history supports one, and its optional app-side expiry date. watchedItems lists every starred item so sale scans can include them regardless of stock.",
    request: z.object({}),
    response: hitListResponse,
    handler: async (ctx): Promise<z.infer<typeof hitListResponse>> => {
      const db = ctx.db<typeof schema>();
      // Fail any app-added item's price check that has been pending
      // far past its start: its background task never reported
      // back, and left alone the item would show "Price check
      // running…" forever (and keep this tab polling every few
      // seconds). The failed state offers a "Check again" button.
      // Rows from before the start stamp existed fall back to
      // their creation time.
      const pendingRows = await db
        .select()
        .from(schema.hitAddedItems)
        .where(eq(schema.hitAddedItems.priceStatus, "pending"));
      for (const r of pendingRows) {
        if (isStuckPending(r.priceCheckStartedAt ?? r.createdAt)) {
          await db
            .update(schema.hitAddedItems)
            .set({
              priceStatus: "failed",
              priceNote:
                "The price check didn't come back — it may have been interrupted.",
            })
            .where(eq(schema.hitAddedItems.id, r.id));
        }
      }
      const [rows, metaRows, addedRows, watchedRows, adjRows, snapRows, expiryRows] =
        await Promise.all([
          db
            .select()
            .from(schema.hitItems)
            .orderBy(asc(schema.hitItems.sortOrder)),
          db.select().from(schema.hitMeta),
          db
            .select()
            .from(schema.hitAddedItems)
            .orderBy(asc(schema.hitAddedItems.id)),
          db.select().from(schema.watchedItems),
          db.select().from(schema.stockAdjustments),
          db.select().from(schema.stockSnapshots),
          db.select().from(schema.itemExpiries),
        ]);
      const expiryByKey = new Map(
        expiryRows.map((r) => [r.item.trim().toLowerCase(), r.expiryDate]),
      );
      const meta = metaRows[0];
      const { effective, pendingDelta } = await loadStockMaps(ctx);
      const forecasts = computeForecasts(snapRows, effective);
      const watchedSet = new Set(
        watchedRows.map((r) => r.item.trim().toLowerCase()),
      );
      const pendingStockItems = new Set(
        adjRows
          .filter((a) => a.appliedAt == null)
          .map((a) => a.item.trim().toLowerCase()),
      );
      const addedByKey = new Map(
        addedRows.map((r) => [r.item.trim().toLowerCase(), r]),
      );
      const merged: z.infer<typeof hitListResponse>["items"] = rows.map(
        (row) => {
          const key = row.item.trim().toLowerCase();
          const added = addedByKey.get(key);
          return {
            category: row.category,
            item: row.item,
            stock: effective.get(key) ?? row.stock,
            sheetStock: row.stock,
            pendingDelta: pendingDelta.get(key) ?? 0,
            store: row.store,
            formalName: added?.formalName ?? null,
            sku: added?.sku ?? null,
            pendingSync: added ? added.syncedAt == null : false,
            watched: watchedSet.has(key),
            forecastDays: forecasts.get(key) ?? null,
            priceInfo: added ? toPriceInfo(added) : null,
            expiry: expiryByKey.get(key) ?? null,
          };
        },
      );
      // App-added items not (yet) on the sheet are appended after the
      // sheet rows; the client groups by category either way.
      const sheetKeys = new Set(
        rows.map((r) => r.item.trim().toLowerCase()),
      );
      for (const added of addedRows) {
        const key = added.item.trim().toLowerCase();
        if (sheetKeys.has(key)) continue;
        merged.push({
          category: added.category,
          item: added.item,
          stock: effective.get(key) ?? added.stock,
          sheetStock: added.stock,
          pendingDelta: pendingDelta.get(key) ?? 0,
          store: added.store,
          formalName: added.formalName,
          sku: added.sku,
          pendingSync: added.syncedAt == null,
          watched: watchedSet.has(key),
          forecastDays: forecasts.get(key) ?? null,
          priceInfo: toPriceInfo(added),
          expiry: expiryByKey.get(key) ?? null,
        });
      }
      return {
        refreshedAt: meta?.refreshedAt
          ? meta.refreshedAt.toISOString()
          : null,
        // Snapshot dates are "YYYY-MM-DD" keys, so the max string
        // is the most recent counted day.
        lastCountedDate:
          snapRows.length > 0
            ? snapRows.reduce(
                (max, r) => (r.date > max ? r.date : max),
                snapRows[0]?.date ?? "",
              ) || null
            : null,
        totalItems: merged.length,
        inStock: merged.filter((r) => r.stock > 0).length,
        outOfStock: merged.filter((r) => r.stock === 0).length,
        pendingSyncCount: addedRows.filter((r) => r.syncedAt == null)
          .length,
        pendingStockCount: pendingStockItems.size,
        watchedItems: watchedRows
          .map((r) => r.item)
          .sort((a, b) => a.localeCompare(b)),
        items: merged,
      };
    },
  }),

  saveHitList: defineAction({
    description:
      "Replaces the cached HIT List inventory with rows freshly read from the household sheet's HIT List tab. Called by the refresh agent task. Also records today's per-item stock snapshot (used for run-out forecasts; ~60 days kept).",
    request: z.object({
      items: z.array(
        z.object({
          category: z.string(),
          item: z.string().min(1),
          stock: z.number().int().min(0),
          store: z.string(),
        }),
      ),
    }),
    response: z.object({ saved: z.number() }),
    handler: async (ctx, args): Promise<{ saved: number }> => {
      const db = ctx.db<typeof schema>();
      const statements: BatchItem<"sqlite">[] = [
        db.delete(schema.hitItems),
        db
          .insert(schema.hitMeta)
          .values({ id: 1, refreshedAt: new Date() })
          .onConflictDoUpdate({
            target: schema.hitMeta.id,
            set: { refreshedAt: new Date() },
          }),
      ];
      // Category cells are only filled on the first row of each group
      // in the sheet; carry the last seen category forward.
      let category = "";
      args.items.forEach((it, i) => {
        if (it.category.trim()) category = it.category.trim();
        statements.push(
          db.insert(schema.hitItems).values({
            category,
            item: it.item,
            stock: it.stock,
            store: it.store,
            sortOrder: i,
          }),
        );
      });
      // Daily stock snapshot for run-out forecasts: exactly ONE row
      // per item per local calendar day, upserted on the (date,
      // item) unique index — a same-day re-refresh replaces that
      // day's row instead of adding another, so daily refreshes
      // accumulate the multi-date history the forecasts need.
      // Snapshots older than ~60 days are pruned.
      const today = todayKeyToronto();
      const cutoff = new Date(`${today}T00:00:00`);
      cutoff.setDate(cutoff.getDate() - 60);
      const cutoffKey = `${cutoff.getFullYear()}-${String(cutoff.getMonth() + 1).padStart(2, "0")}-${String(cutoff.getDate()).padStart(2, "0")}`;
      statements.push(
        db
          .delete(schema.stockSnapshots)
          .where(lt(schema.stockSnapshots.date, cutoffKey)),
      );
      for (const it of args.items) {
        statements.push(
          db
            .insert(schema.stockSnapshots)
            .values({
              date: today,
              item: it.item,
              stock: it.stock,
            })
            .onConflictDoUpdate({
              target: [schema.stockSnapshots.date, schema.stockSnapshots.item],
              set: { stock: it.stock },
            }),
        );
      }
      const [first, ...rest] = statements;
      if (first) await db.batch([first, ...rest]);
      ctx.invalidateQueries();
      return { saved: args.items.length };
    },
  }),

  refreshHitList: defineAction({
    description:
      "Starts a background refresh that re-reads the HIT List tab of the household Google Sheet and saves the current inventory rows into this app (also feeds the Meal Planner's protein stock).",
    request: z.object({}),
    response: z.object({
      started: z.boolean(),
      taskId: z.string().nullable(),
      error: z.string().nullable(),
    }),
    handler: async (
      ctx,
    ): Promise<{
      started: boolean;
      taskId: string | null;
      error: string | null;
    }> => {
      if (!SPREADSHEET_ID) {
        return {
          started: false,
          taskId: null,
          error:
            "No household sheet is configured — set SPREADSHEET_ID in server/src/actions.ts to your sheet's ID first.",
        };
      }
      const result = await ctx.agent.spawnTask(
        [
          "Refresh the HIT List tab data in the Shopping List app from Google Sheets.",
          "",
          `1. Confirm Google Sheets is connected: run \`/opt/hatch/bin/hatch_gws_cli sheets status\`. If it is not connected, stop and report that.`,
          `2. Read the HIT List tab of the household spreadsheet (spreadsheetId ${SPREADSHEET_ID}): run \`/opt/hatch/bin/hatch_gws_cli sheets spreadsheets values get --params '{"spreadsheetId":"${SPREADSHEET_ID}","range":"HIT List!A1:E120"}'\`.`,
          "3. Parse the values grid with these rules:",
          '   - Row 1 is the title ("Household Inventory Tracker") — ignore. Rows 2–3 are the totals header and totals — ignore. Row 5 is the column header (Category, Item Name, Stock, Store, Notes). Item rows start at row 6.',
          "   - For each row from row 6 on: category = col A (often empty — the sheet only fills it on the first row of each category group; pass the empty string through and the app carries the last category forward), item = col B (skip the row when empty), stock = col C parsed as an integer, store = col D.",
          "4. Call the saveHitList action exactly once with { items } containing every parsed item in sheet order.",
          "Do not edit the spreadsheet. Do not add, drop, or reorder items. Never invent a stock count.",
        ].join("\n"),
        { expectsAction: "saveHitList", dedupeKey: "hit-list-refresh" },
      );
      if (!result.ok) {
        return { started: false, taskId: null, error: result.error };
      }
      return { started: true, taskId: result.taskId, error: null };
    },
  }),

  addHitItem: defineAction({
    description:
      "Adds a new item to the HIT List from the app: category, item name, stock count, store, and optionally the formal product name and SKU. The item shows in the HIT List right away, is queued for the sync updates to the shared household copy, and an automatic Flipp/website price check starts for it (sale price, regular price, and a cheaper alternative when it isn't on sale). The Google Sheet itself is not edited — the sheet connection is read-only.",
    request: z.object({
      category: z.string().trim().min(1).max(80),
      item: z.string().trim().min(1).max(120),
      stock: z.number().int().min(0).max(9999),
      store: z.string().trim().min(1).max(80),
      formalName: z.string().trim().max(200).nullable().default(null),
      sku: z.string().trim().max(60).nullable().default(null),
    }),
    response: z.object({
      ok: z.boolean(),
      error: z.string().nullable(),
      priceCheckStarted: z.boolean(),
    }),
    handler: async (
      ctx,
      args,
    ): Promise<{
      ok: boolean;
      error: string | null;
      priceCheckStarted: boolean;
    }> => {
      const db = ctx.db<typeof schema>();
      const key = args.item.toLowerCase();
      const [sheetRows, addedRows] = await Promise.all([
        db.select().from(schema.hitItems),
        db.select().from(schema.hitAddedItems),
      ]);
      const dupSheet = sheetRows.some(
        (r) => r.item.trim().toLowerCase() === key,
      );
      const dupAdded = addedRows.some(
        (r) => r.item.trim().toLowerCase() === key,
      );
      if (dupSheet || dupAdded) {
        return {
          ok: false,
          error: `“${args.item}” is already on the HIT List.`,
          priceCheckStarted: false,
        };
      }
      const formalName = args.formalName?.trim() ? args.formalName.trim() : null;
      const sku = args.sku?.trim() ? args.sku.trim() : null;
      await db.insert(schema.hitAddedItems).values({
        category: args.category,
        item: args.item,
        stock: args.stock,
        store: args.store,
        formalName,
        sku,
        priceStatus: "pending",
        priceCheckStartedAt: new Date(),
      });
      const check = await spawnPriceCheck(ctx, {
        item: args.item,
        category: args.category,
        stock: args.stock,
        store: args.store,
        formalName,
        sku,
      });
      if (!check.started) {
        await db
          .update(schema.hitAddedItems)
          .set({ priceStatus: "failed" })
          .where(eq(schema.hitAddedItems.item, args.item));
      }
      ctx.invalidateQueries();
      return { ok: true, error: null, priceCheckStarted: check.started };
    },
  }),

  getHouseholdSetup: defineAction({
    description:
      "Returns the household setup questionnaire answers saved by the last completed HIT setup (household size, stores, allergies/dietary needs, proteins, staples, frequent meals, reminder and sharing choices) and when it was completed, or null when setup has never been finished.",
    request: z.object({}),
    response: z.object({
      setup: z
        .object({
          answers: householdSetupAnswers,
          completedAt: z.string().nullable(),
        })
        .nullable(),
    }),
    handler: async (
      ctx,
    ): Promise<{
      setup: {
        answers: z.infer<typeof householdSetupAnswers>;
        completedAt: string | null;
      } | null;
    }> => {
      const db = ctx.db<typeof schema>();
      const rows = await db.select().from(schema.householdSetup);
      const row = rows[0];
      if (!row) return { setup: null };
      let answers: z.infer<typeof householdSetupAnswers> =
        householdSetupAnswers.parse({});
      try {
        answers = householdSetupAnswers.parse(
          JSON.parse(row.answersJson || "{}"),
        );
      } catch {
        // A malformed stored blob reads as an empty answer set
        // rather than failing the whole read.
        answers = householdSetupAnswers.parse({});
      }
      return {
        setup: {
          answers,
          completedAt: row.completedAt
            ? row.completedAt.toISOString()
            : null,
        },
      };
    },
  }),

  completeHouseholdSetup: defineAction({
    description:
      "Finishes the HIT setup questionnaire NON-DESTRUCTIVELY: saves the answers as the household setup profile (upserting the single household_setup row), then seeds starter content ADDITIVELY — each chosen protein and staple becomes a HIT List item (through the app-added items store, so it shows in the HIT List and syncs like any app add) and each chosen frequent meal becomes a meal idea, but ONLY when that name is not already tracked (dedupe by name, case-insensitive, against the sheet items, the app-added items, and the existing meals). Nothing is ever removed, overwritten, or reset: existing HIT List items, meals, and planner picks are untouched. Seeded items start at stock 0 with no price check (they are questionnaire starters, not price-checked adds). Returns the names actually added so the finish screen can say exactly what was new.",
    request: z.object({ answers: householdSetupAnswers }),
    response: z.object({
      ok: z.literal(true),
      addedItems: z.array(z.string()),
      addedMeals: z.array(z.string()),
    }),
    handler: async (
      ctx,
      args,
    ): Promise<{
      ok: true;
      addedItems: string[];
      addedMeals: string[];
    }> => {
      const db = ctx.db<typeof schema>();
      const answers = args.answers;
      const now = new Date();
      const existingSetup = await db.select().from(schema.householdSetup);
      if (existingSetup.length > 0) {
        await db
          .update(schema.householdSetup)
          .set({ answersJson: JSON.stringify(answers), completedAt: now })
          .where(eq(schema.householdSetup.id, 1));
      } else {
        await db.insert(schema.householdSetup).values({
          id: 1,
          answersJson: JSON.stringify(answers),
          completedAt: now,
        });
      }
      // Additive seeding, deduped by name (case-insensitive) against
      // everything already tracked.
      const [sheetRows, addedRows, mealRows] = await Promise.all([
        db.select().from(schema.hitItems),
        db.select().from(schema.hitAddedItems),
        db.select().from(schema.meals),
      ]);
      const trackedKeys = new Set<string>();
      for (const r of sheetRows) trackedKeys.add(r.item.trim().toLowerCase());
      for (const r of addedRows) trackedKeys.add(r.item.trim().toLowerCase());
      const store = answers.stores[0]?.trim() || "Grocery Store";
      const addedItems: string[] = [];
      const seedItem = async (
        name: string,
        category: string,
      ): Promise<void> => {
        const clean = name.trim();
        if (!clean) return;
        const key = clean.toLowerCase();
        if (trackedKeys.has(key)) return;
        trackedKeys.add(key);
        await db.insert(schema.hitAddedItems).values({
          category,
          item: clean,
          stock: 0,
          store,
          formalName: null,
          sku: null,
          priceStatus: "done",
          priceCheckStartedAt: null,
        });
        addedItems.push(clean);
      };
      for (const p of answers.proteins) await seedItem(p, "Freezer");
      for (const s of answers.staples) await seedItem(s, "Misc.");
      const mealKeys = new Set(
        mealRows.map((m) => m.name.trim().toLowerCase()),
      );
      const addedMeals: string[] = [];
      let sortOrder = mealRows.length;
      for (const mealName of answers.meals) {
        const clean = mealName.trim();
        if (!clean) continue;
        const key = clean.toLowerCase();
        if (mealKeys.has(key)) continue;
        mealKeys.add(key);
        const starter = SETUP_STARTER_MEALS[key];
        const inserted = await db
          .insert(schema.meals)
          .values({
            name: clean,
            mealType: starter?.mealType ?? "dinner",
            sortOrder: sortOrder++,
          })
          .returning({ id: schema.meals.id });
        const meal = inserted[0];
        if (meal && starter?.protein) {
          await db.insert(schema.mealProteins).values({
            mealId: meal.id,
            label: starter.protein,
            sheetName: starter.protein,
            groupIndex: 0,
            sortOrder: 0,
          });
        }
        addedMeals.push(clean);
      }
      ctx.invalidateQueries();
      return { ok: true as const, addedItems, addedMeals };
    },
  }),

  getAccountSettings: defineAction({
    description:
      "Returns the Primary vs Connected account settings (Beta 0.01 batch, audit #5): the role THIS copy of the app is acting as ('primary' — the Primary user — or 'connected' — a Connected account; Primary until changed) and the full undo policy — for each undoable action type (purchases, stockAdjustments, eaten, receiptScans, bitCountChanges, wasteLog, manifestImports, requisitionCheckOffs, alertDismissals, posSyncs) whether its actions are 'permanent' (no Undo is offered) or 'reversible' (the Undo works). Every type defaults to 'reversible'.",
    request: z.object({}),
    response: z.object({
      role: z.enum(["primary", "connected"]),
      policy: undoPolicyShape,
    }),
    handler: async (
      ctx,
    ): Promise<{ role: ActorRole; policy: UndoPolicy }> => {
      return await loadAccountSettings(ctx);
    },
  }),

  setActingRole: defineAction({
    description:
      "Sets the role THIS copy of the app acts as — 'primary' (the Primary user) or 'connected' (a Connected account). The role is this copy's own identity, so it can be switched from either role; it decides which actions this copy may undo (a Connected account undoes only its own actions; the Primary user undoes anyone's) and whether the undo policy below can be edited (Primary only). New undoable actions are stamped with the role in force when they happen.",
    request: z.object({
      role: z.enum(["primary", "connected"]),
    }),
    response: z.object({
      ok: z.literal(true),
      role: z.enum(["primary", "connected"]),
    }),
    handler: async (
      ctx,
      args,
    ): Promise<{ ok: true; role: ActorRole }> => {
      const db = ctx.db<typeof schema>();
      const existing = await db.select().from(schema.accountSettings);
      if (existing.length > 0) {
        await db
          .update(schema.accountSettings)
          .set({ actingRole: args.role })
          .where(eq(schema.accountSettings.id, 1));
      } else {
        await db.insert(schema.accountSettings).values({
          id: 1,
          actingRole: args.role,
          policyJson: "{}",
        });
      }
      ctx.invalidateQueries();
      return { ok: true as const, role: args.role };
    },
  }),

  setUndoPolicy: defineAction({
    description:
      "Sets one undoable action type's policy — 'permanent' (its actions apply with no Undo offered and their records read as permanent) or 'reversible' (the Undo works, under the ownership rule). Editable ONLY while this copy acts as the Primary user: a Connected account's attempt is refused and nothing changes — connected-account actions stay reversible unless the Primary user changes the type here.",
    request: z.object({
      type: z.enum([
        "purchases",
        "stockAdjustments",
        "eaten",
        "receiptScans",
        "bitCountChanges",
        "wasteLog",
        "manifestImports",
        "requisitionCheckOffs",
        "alertDismissals",
        "posSyncs",
      ]),
      mode: z.enum(["permanent", "reversible"]),
    }),
    response: z.object({
      ok: z.boolean(),
      error: z.string().nullable(),
      policy: undoPolicyShape.nullable(),
    }),
    handler: async (
      ctx,
      args,
    ): Promise<{
      ok: boolean;
      error: string | null;
      policy: UndoPolicy | null;
    }> => {
      const settings = await loadAccountSettings(ctx);
      if (settings.role !== "primary") {
        return {
          ok: false,
          error:
            "Only the Primary user can change the undo policy — this copy is acting as a Connected account.",
          policy: null,
        };
      }
      const policy = { ...settings.policy, [args.type]: args.mode };
      const db = ctx.db<typeof schema>();
      const existing = await db.select().from(schema.accountSettings);
      if (existing.length > 0) {
        await db
          .update(schema.accountSettings)
          .set({ policyJson: JSON.stringify(policy) })
          .where(eq(schema.accountSettings.id, 1));
      } else {
        await db.insert(schema.accountSettings).values({
          id: 1,
          actingRole: settings.role,
          policyJson: JSON.stringify(policy),
        });
      }
      ctx.invalidateQueries();
      return { ok: true, error: null, policy };
    },
  }),

  getLastUndoableAction: defineAction({
    description:
      "Reports the app's LAST action that the single Settings Undo button would revert (Beta 0.15): the newest not-yet-undone undoable action across both sides (purchases, stock changes, eaten/usage, receipt scans, alert dismissals, BIT count changes, waste entries, manifest imports, requisition check-offs, POS sales) that the current role may undo under the undo policy — or label null when there is nothing to undo. Read-only; undoLastAction performs the reversal.",
    request: z.object({}),
    response: z.object({ label: z.string().nullable() }),
    handler: async (ctx): Promise<{ label: string | null }> => {
      const candidate = await findLastUndoableAction(ctx);
      return { label: candidate?.label ?? null };
    },
  }),

  undoLastAction: defineAction({
    description:
      "The app's one Undo (Beta 0.15, in Settings under Switch to): reverts the LAST action taken anywhere in the app — the newest not-yet-undone undoable action across both sides that the current role may undo under the undo policy — through that action type's own reversal, and reports what was undone by name. Pressing it again reverts the action before that. When nothing undoable remains it changes nothing and says so.",
    request: z.object({}),
    response: z.object({
      ok: z.boolean(),
      label: z.string().nullable(),
      error: z.string().nullable(),
    }),
    handler: async (
      ctx,
    ): Promise<{
      ok: boolean;
      label: string | null;
      error: string | null;
    }> => {
      const candidate = await findLastUndoableAction(ctx);
      if (!candidate) {
        return {
          ok: false,
          label: null,
          error: "There's nothing to undo — no action can be reverted right now.",
        };
      }
      const res = await candidate.run(ctx);
      if (!res.ok) {
        return {
          ok: false,
          label: candidate.label,
          error: res.error ?? "That action couldn't be undone.",
        };
      }
      return { ok: true, label: candidate.label, error: null };
    },
  }),

  recheckItemPrice: defineAction({
    description:
      "Re-runs the automatic Flipp/website price check for an item that was added in the app (e.g. after a failed check, or in a new flyer week).",
    request: z.object({ item: z.string().min(1).max(120) }),
    response: z.object({
      started: z.boolean(),
      error: z.string().nullable(),
    }),
    handler: async (
      ctx,
      args,
    ): Promise<{ started: boolean; error: string | null }> => {
      const db = ctx.db<typeof schema>();
      const rows = await db
        .select()
        .from(schema.hitAddedItems)
        .where(eq(schema.hitAddedItems.item, args.item));
      const row = rows[0];
      if (!row) {
        return {
          started: false,
          error: "That item wasn't added in the app, so it has no price check.",
        };
      }
      await db
        .update(schema.hitAddedItems)
        .set({
          priceStatus: "pending",
          priceCheckStartedAt: new Date(),
          salePriceCents: null,
          saleStore: null,
          saleEnd: null,
          regularPriceCents: null,
          regularStore: null,
          altName: null,
          altPriceCents: null,
          altStore: null,
          priceNote: null,
          priceCheckedAt: null,
        })
        .where(eq(schema.hitAddedItems.id, row.id));
      const check = await spawnPriceCheck(ctx, row);
      if (!check.started) {
        await db
          .update(schema.hitAddedItems)
          .set({ priceStatus: "failed" })
          .where(eq(schema.hitAddedItems.id, row.id));
        ctx.invalidateQueries();
        return { started: false, error: check.error };
      }
      ctx.invalidateQueries();
      return { started: true, error: null };
    },
  }),

  saveItemPriceInfo: defineAction({
    description:
      "Saves the results of the automatic price check for an app-added HIT List item: current sale price/store/end (nulls when not on sale), lowest verified regular price, and — only when the item is not on sale — a cheaper alternative. Called by the price-check agent task; nulls mean 'not found', never a guess.",
    request: z.object({
      item: z.string().min(1).max(120),
      salePriceCents: z.number().int().min(0).nullable().default(null),
      saleStore: z.string().max(80).nullable().default(null),
      saleEnd: z.string().max(80).nullable().default(null),
      regularPriceCents: z.number().int().min(0).nullable().default(null),
      regularStore: z.string().max(80).nullable().default(null),
      altName: z.string().max(200).nullable().default(null),
      altPriceCents: z.number().int().min(0).nullable().default(null),
      altStore: z.string().max(80).nullable().default(null),
      note: z.string().max(300).nullable().default(null),
    }),
    response: z.object({ saved: z.boolean() }),
    handler: async (ctx, args): Promise<{ saved: boolean }> => {
      const db = ctx.db<typeof schema>();
      const rows = await db
        .select()
        .from(schema.hitAddedItems)
        .where(eq(schema.hitAddedItems.item, args.item));
      const row = rows[0];
      if (!row) return { saved: false };
      const hasSale = args.salePriceCents != null;
      await db
        .update(schema.hitAddedItems)
        .set({
          priceStatus: "done",
          salePriceCents: args.salePriceCents,
          saleStore: hasSale ? args.saleStore : null,
          saleEnd: hasSale ? args.saleEnd : null,
          regularPriceCents: args.regularPriceCents,
          regularStore:
            args.regularPriceCents != null ? args.regularStore : null,
          // An alternative only makes sense when the item itself is
          // not on sale (per the household's price-check rule).
          altName: !hasSale ? args.altName : null,
          altPriceCents: !hasSale ? args.altPriceCents : null,
          altStore: !hasSale ? args.altStore : null,
          priceNote: args.note,
          priceCheckedAt: new Date(),
        })
        .where(eq(schema.hitAddedItems.id, row.id));
      ctx.invalidateQueries();
      return { saved: true };
    },
  }),

  getPendingSync: defineAction({
    description:
      "Lists the HIT List items added in this app that have not yet been included in the sync updates to the shared household copy (category, item, stock, store, formal name, SKU), so the sync process can carry them in its next update.",
    request: z.object({}),
    response: z.object({
      pending: z.array(
        z.object({
          id: z.number(),
          category: z.string(),
          item: z.string(),
          stock: z.number(),
          store: z.string(),
          formalName: z.string().nullable(),
          sku: z.string().nullable(),
          createdAt: z.string(),
        }),
      ),
    }),
    handler: async (ctx) => {
      const db = ctx.db<typeof schema>();
      const rows = await db
        .select()
        .from(schema.hitAddedItems)
        .orderBy(asc(schema.hitAddedItems.id));
      return {
        pending: rows
          .filter((r) => r.syncedAt == null)
          .map((r) => ({
            id: r.id,
            category: r.category,
            item: r.item,
            stock: r.stock,
            store: r.store,
            formalName: r.formalName,
            sku: r.sku,
            createdAt: r.createdAt.toISOString(),
          })),
      };
    },
  }),

  markItemsSynced: defineAction({
    description:
      "Marks app-added HIT List items as included in the sync updates to the shared household copy, clearing them from the pending-sync queue. Called by the sync process after the update carrying them has been sent.",
    request: z.object({ ids: z.array(z.number().int().positive()).min(1) }),
    response: z.object({ marked: z.number() }),
    handler: async (ctx, args): Promise<{ marked: number }> => {
      const db = ctx.db<typeof schema>();
      let marked = 0;
      for (const id of args.ids) {
        const res = await db
          .update(schema.hitAddedItems)
          .set({ syncedAt: new Date() })
          .where(eq(schema.hitAddedItems.id, id))
          .returning({ id: schema.hitAddedItems.id });
        marked += res.length;
      }
      ctx.invalidateQueries();
      return { marked };
    },
  }),

  // ---- Stock adjustments, watch stars, barcode, recipe import -----
  // Pending stock adjustments are how app-side stock changes reach
  // the sheet: the app records them, shows effective stock right
  // away, and Muse's 2-hour auto-scan applies them to the sheet via
  // getPendingStockAdjustments / markStockAdjustmentsApplied.

  adjustStock: defineAction({
    description:
      "Adjusts one HIT List item's stock by exactly +1 or −1 from the app (the HIT List steppers and the barcode stock-bump). Any other delta is rejected — larger corrections go through their own dedicated flows, not this one. Records a pending stock adjustment (source 'quick-adjust') the auto-scan will write to the sheet; the app's effective stock changes immediately and never goes below 0. A +1 increase also settles the item's Shopping List entry as Purchased (quantity = the increase) when the item is currently on the Shopping List — the settle adds no stock of its own, since this adjustment already applied the increase.",
    request: z.object({
      item: z.string().min(1).max(120),
      delta: z
        .number()
        .int()
        .min(-1)
        .max(1)
        .refine((d) => d !== 0, {
          message: "Delta must be +1 or −1",
        }),
    }),
    response: z.object({
      ok: z.boolean(),
      error: z.string().nullable(),
      stock: z.number().nullable(),
    }),
    handler: async (
      ctx,
      args,
    ): Promise<{
      ok: boolean;
      error: string | null;
      stock: number | null;
    }> => {
      const db = ctx.db<typeof schema>();
      const { effective } = await loadStockMaps(ctx);
      const key = args.item.trim().toLowerCase();
      const current = effective.get(key);
      if (current == null) {
        return { ok: false, error: "That item isn't on the HIT List.", stock: null };
      }
      const next = current + args.delta;
      if (next < 0) {
        return {
          ok: false,
          error: "Stock can't go below 0.",
          stock: current,
        };
      }
      // Record the canonical spelling (the sheet's own) so the
      // auto-scan can find the row.
      const [hitRows, addedRows] = await Promise.all([
        db.select().from(schema.hitItems),
        db.select().from(schema.hitAddedItems),
      ]);
      const canonical =
        hitRows.find((r) => r.item.trim().toLowerCase() === key)?.item ??
        addedRows.find((r) => r.item.trim().toLowerCase() === key)?.item ??
        args.item;
      const { role } = await loadAccountSettings(ctx);
      const [adj] = await db
        .insert(schema.stockAdjustments)
        .values({
          item: canonical,
          delta: args.delta,
          source: "quick-adjust",
          actor: role,
        })
        .returning({ id: schema.stockAdjustments.id });
      // Alpha 0.91: a stock INCREASE on the HIT List settles the
      // item's Shopping List entry as Purchased (quantity = the
      // increase) when the item is currently on the list. The
      // adjustment above already applied the increase, so the
      // settle records no stock of its own.
      if (args.delta > 0) {
        await settleShoppingPurchaseFromRestock(
          ctx,
          canonical,
          args.delta,
          adj?.id ?? null,
        );
      }
      ctx.invalidateQueries();
      return { ok: true, error: null, stock: next };
    },
  }),

  getPendingStockAdjustments: defineAction({
    description:
      "Lists the app-side stock adjustments (from Shopping List per-item Purchased confirmations, the HIT List +/− steppers, usage deductions and undos, stocktake corrections, and purchase undos) that have not yet been applied to the Google Sheet, oldest first, so the auto-scan can write them to the HIT List tab.",
    request: z.object({}),
    response: z.object({
      pending: z.array(
        z.object({
          id: z.number(),
          item: z.string(),
          delta: z.number(),
          source: z.string(),
          createdAt: z.string(),
        }),
      ),
    }),
    handler: async (ctx) => {
      const db = ctx.db<typeof schema>();
      const rows = await db
        .select()
        .from(schema.stockAdjustments)
        .orderBy(asc(schema.stockAdjustments.id));
      return {
        pending: rows
          .filter((r) => r.appliedAt == null && r.undone === 0)
          .map((r) => ({
            id: r.id,
            item: r.item,
            delta: r.delta,
            source: r.source,
            createdAt: r.createdAt.toISOString(),
          })),
      };
    },
  }),

  markStockAdjustmentsApplied: defineAction({
    description:
      "Marks pending stock adjustments as written to the Google Sheet, clearing their 'pending' markers in the app. Called by the auto-scan after it updates the HIT List tab.",
    request: z.object({ ids: z.array(z.number().int().positive()).min(1) }),
    response: z.object({ marked: z.number() }),
    handler: async (ctx, args): Promise<{ marked: number }> => {
      const db = ctx.db<typeof schema>();
      let marked = 0;
      for (const id of args.ids) {
        const res = await db
          .update(schema.stockAdjustments)
          .set({ appliedAt: new Date() })
          .where(eq(schema.stockAdjustments.id, id))
          .returning({ id: schema.stockAdjustments.id });
        marked += res.length;
      }
      ctx.invalidateQueries();
      return { marked };
    },
  }),

  toggleItemWatch: defineAction({
    description:
      "Stars or un-stars a HIT List item for sale watching. Watched items are sale-checked regardless of stock level; the watched set is exposed on getHitList (watchedItems) and watched items on sale carry a ★ marker on the Shopping List.",
    request: z.object({
      item: z.string().min(1).max(120),
      watched: z.boolean(),
    }),
    response: okResponse,
    handler: async (ctx, args): Promise<z.infer<typeof okResponse>> => {
      const db = ctx.db<typeof schema>();
      if (args.watched) {
        await db
          .insert(schema.watchedItems)
          .values({ item: args.item })
          .onConflictDoNothing();
      } else {
        const rows = await db.select().from(schema.watchedItems);
        for (const r of rows) {
          if (r.item.trim().toLowerCase() === args.item.trim().toLowerCase()) {
            await db
              .delete(schema.watchedItems)
              .where(eq(schema.watchedItems.item, r.item));
          }
        }
      }
      ctx.invalidateQueries();
      return { ok: true as const };
    },
  }),

  logUsage: defineAction({
    description:
      "Logs usage (the Meal Planner calendar's per-pick 'Eaten ✓' button, which sends the meal's protein deductions at recipe amounts): writes one usage_log entry per used item and, for deductions, a pending stock adjustment (source 'usage', negative delta) through the existing queue the auto-scan applies to the sheet. 'Used some' entries log with no deduction. When a pick's Eaten tap has nothing tracked to deduct (no protein chosen, or the chosen proteins aren't on the HIT List), the client sends a single zero-deduction 'Used some' marker entry (its item is the meal's first protein name, or the meal name when it has none) so the pick still lands in loggedPickIds and shows as eaten — with getUsageLog's noDeductionPickIds flagging that nothing was deducted. Picking a meal never calls this — only tapping Eaten does. (The HIT List's old per-item quick-use button/sheet was removed; historical 'manual' entries remain in the log.)",
    request: z.object({
      entries: z
        .array(
          z.object({
            item: z.string().min(1).max(120),
            deducted: z.number().int().min(0).max(999),
            usedSome: z.boolean(),
          }),
        )
        .min(1)
        .max(60),
      source: z.string().min(1).max(200),
      mealId: z.number().int().positive().nullable().default(null),
      mealName: z.string().max(120).nullable().default(null),
      pickId: z.number().int().positive().nullable().default(null),
      pickDate: z.string().max(20).nullable().default(null),
    }),
    response: z.object({
      ok: z.boolean(),
      logged: z.number(),
      error: z.string().nullable(),
    }),
    handler: async (
      ctx,
      args,
    ): Promise<{ ok: boolean; logged: number; error: string | null }> => {
      const db = ctx.db<typeof schema>();
      const { effective } = await loadStockMaps(ctx);
      const [hitRows, addedRows] = await Promise.all([
        db.select().from(schema.hitItems),
        db.select().from(schema.hitAddedItems),
      ]);
      const canonical = new Map<string, string>();
      for (const r of hitRows) canonical.set(r.item.trim().toLowerCase(), r.item);
      for (const r of addedRows) {
        const k = r.item.trim().toLowerCase();
        if (!canonical.has(k)) canonical.set(k, r.item);
      }
      // Aggregate deductions per item so a batch can't over-deduct.
      const wanted = new Map<string, number>();
      for (const e of args.entries) {
        if (e.usedSome) continue;
        const k = e.item.trim().toLowerCase();
        wanted.set(k, (wanted.get(k) ?? 0) + e.deducted);
      }
      for (const [k, total] of wanted) {
        const cur = effective.get(k);
        if (cur == null) {
          return { ok: false, logged: 0, error: `“${k}” isn't on the HIT List.` };
        }
        if (total > cur) {
          return {
            ok: false,
            logged: 0,
            error: `You can't use ${total} of ${canonical.get(k) ?? k} — only ${cur} on hand.`,
          };
        }
      }
      const { role } = await loadAccountSettings(ctx);
      let logged = 0;
      for (const entry of args.entries) {
        const usedSome = entry.usedSome;
        const deducted = usedSome ? 0 : entry.deducted;
        if (!usedSome && deducted <= 0) continue;
        const name = canonical.get(entry.item.trim().toLowerCase()) ?? entry.item;
        await db.insert(schema.usageLog).values({
          item: name,
          deducted,
          usedSome: usedSome ? 1 : 0,
          source: args.source,
          mealId: args.mealId,
          mealName: args.mealName,
          pickId: args.pickId,
          pickDate: args.pickDate,
          actor: role,
        });
        if (deducted > 0) {
          await db.insert(schema.stockAdjustments).values({
            item: name,
            delta: -deducted,
            source: "usage",
          });
        }
        logged += 1;
      }
      if (logged === 0) {
        return { ok: false, logged: 0, error: "Nothing was marked as used." };
      }
      ctx.invalidateQueries();
      return { ok: true, logged, error: null };
    },
  }),

  getUsageLog: defineAction({
    description:
      "Returns recent usage-log entries (newest first, up to 30, undone entries included and flagged), the pick ids that have non-undone usage logged (drives the Meal Planner calendar's filled/disabled 'Eaten ✓' button state and the day box's 'Usage logged ✓' marker), the subset of those picks whose logged entries deducted nothing (noDeductionPickIds — the pick was eaten but no protein was tracked to deduct, so its day box explains that instead of staying silent), and learned default deductions (the last confirmed deduction per item and per (meal, item) pair — retained for reference; nothing prefills from them, since Eaten deductions come from the recipe amounts).",
    request: z.object({}),
    response: z.object({
      entries: z.array(
        z.object({
          id: z.number(),
          item: z.string(),
          deducted: z.number(),
          usedSome: z.boolean(),
          source: z.string(),
          mealId: z.number().nullable(),
          mealName: z.string().nullable(),
          pickId: z.number().nullable(),
          pickDate: z.string().nullable(),
          createdAt: z.string(),
          undone: z.boolean(),
          // Attribution + policy (audit #5, Primary vs
          // Connected) for the entry's Eaten type.
          ...undoMetaShape.shape,
        }),
      ),
      // Per-pick undo state for the Meal Planner's pick-row
      // Undo (audit #5): for each pick with active usage, who
      // performed the Eaten tap (a tap counts as the Primary
      // user's when any of its entries is), whether Eaten is
      // set Permanent, and whether the current role may undo
      // the tap as a whole.
      pickUndo: z.array(
        z.object({
          pickId: z.number(),
          ...undoMetaShape.shape,
        }),
      ),
      loggedPickIds: z.array(z.number()),
      // Picks with non-undone usage logged but zero total deducted
      // (e.g. an Eaten tap whose meal had no protein chosen, or whose
      // proteins aren't tracked): the pick still counts as eaten —
      // the day box says plainly that nothing was deducted.
      noDeductionPickIds: z.array(z.number()),
      learnedByItem: z.record(z.string(), z.number()),
      learnedByMealItem: z.record(z.string(), z.number()),
    }),
    handler: async (ctx) => {
      const db = ctx.db<typeof schema>();
      const settings = await loadAccountSettings(ctx);
      const rows = await db
        .select()
        .from(schema.usageLog)
        .orderBy(desc(schema.usageLog.id));
      const active = rows.filter((r) => r.undone === 0);
      // Per-pick undo state (audit #5): a pick's Eaten tap is
      // undone as a whole, so its actor is the Primary user when
      // ANY of its active entries is the Primary user's, and its
      // canUndo requires every entry to pass the gate.
      const pickUndoMap = new Map<
        number,
        { actor: ActorRole; canUndo: boolean }
      >();
      for (const r of active) {
        if (r.pickId == null) continue;
        const cur = pickUndoMap.get(r.pickId) ?? {
          actor: "connected" as ActorRole,
          canUndo: true,
        };
        if (actorOf(r.actor) === "primary") cur.actor = "primary";
        if (undoGate(settings, "eaten", r.actor) != null) {
          cur.canUndo = false;
        }
        pickUndoMap.set(r.pickId, cur);
      }
      const pickUndo = [...pickUndoMap.entries()].map(
        ([pickId, v]) => ({
          pickId,
          actor: v.actor,
          permanent: settings.policy.eaten === "permanent",
          canUndo: v.canUndo && settings.policy.eaten !== "permanent",
        }),
      );
      const loggedPickIds = [
        ...new Set(
          active
            .map((r) => r.pickId)
            .filter((v): v is number => v != null),
        ),
      ];
      const deductedByPick = new Map<number, number>();
      for (const r of active) {
        if (r.pickId == null) continue;
        deductedByPick.set(
          r.pickId,
          (deductedByPick.get(r.pickId) ?? 0) + r.deducted,
        );
      }
      const noDeductionPickIds = loggedPickIds.filter(
        (id) => (deductedByPick.get(id) ?? 0) <= 0,
      );
      // Learned defaults: rows are newest-first, so the first
      // deduction seen per key is the most recent confirmed one.
      const learnedByItem: Record<string, number> = {};
      const learnedByMealItem: Record<string, number> = {};
      for (const r of active) {
        if (r.deducted <= 0) continue;
        const itemKey = r.item.trim().toLowerCase();
        if (!(itemKey in learnedByItem)) learnedByItem[itemKey] = r.deducted;
        if (r.mealId != null) {
          const mk = `${r.mealId}::${itemKey}`;
          if (!(mk in learnedByMealItem)) learnedByMealItem[mk] = r.deducted;
        }
      }
      return {
        entries: rows.slice(0, 30).map((r) => ({
          id: r.id,
          item: r.item,
          deducted: r.deducted,
          usedSome: r.usedSome === 1,
          source: r.source,
          mealId: r.mealId,
          mealName: r.mealName,
          pickId: r.pickId,
          pickDate: r.pickDate,
          createdAt: r.createdAt.toISOString(),
          undone: r.undone === 1,
          ...undoMeta(settings, "eaten", r.actor, r.undone === 1),
        })),
        pickUndo,
        loggedPickIds,
        noDeductionPickIds,
        learnedByItem,
        learnedByMealItem,
      };
    },
  }),

  undoUsage: defineAction({
    description:
      "Undoes one usage-log entry: marks it undone and, if it deducted stock, records a reversing pending stock adjustment (+units, source 'usage-undo') through the existing queue.",
    request: z.object({ id: z.number().int().positive() }),
    response: z.object({
      ok: z.boolean(),
      error: z.string().nullable(),
    }),
    handler: async (ctx, args) => await performUndoUsage(ctx, args.id),
  }),

  undoPickEaten: defineAction({
    description:
      "Undoes a Meal Planner pick's whole 'Eaten' tap from the pick row itself (Beta 0.01 batch, audit #5): every non-undone usage-log entry logged for the pick is marked undone and each deduction is reversed with a pending stock adjustment (+units, source 'usage-undo') through the existing queue — the same reversal undoUsage performs per entry, applied to the tap as a whole. The pick returns to its un-eaten state and can be marked eaten again. A pick with no active usage logged reports an error and changes nothing.",
    request: z.object({ pickId: z.number().int().positive() }),
    response: z.object({
      ok: z.boolean(),
      undoneCount: z.number(),
      error: z.string().nullable(),
    }),
    handler: async (ctx, args) =>
      await performUndoPickEaten(ctx, args.pickId),
  }),

  recordStocktake: defineAction({
    description:
      "Records the confirmed result of a HIT List stocktake: for each counted item whose counted value differs from its current effective stock, records ONE pending stock adjustment for the full difference (source 'stocktake', any size — unlike adjustStock, which stays clamped to ±1) through the same queue the auto-scan applies to the sheet. Items whose count matches their effective stock record nothing, and an empty or all-matching counts list records nothing. The sheet itself is never written here. A counted INCREASE for an item currently on the Shopping List also settles that shopping entry as Purchased (quantity = the increase), adding no stock beyond the stocktake adjustment itself.",
    request: z.object({
      counts: z
        .array(
          z.object({
            item: z.string().min(1).max(120),
            counted: z.number().int().min(0).max(9999),
          }),
        )
        .max(500),
    }),
    response: z.object({
      ok: z.boolean(),
      recorded: z.number(),
      changes: z.array(
        z.object({
          item: z.string(),
          from: z.number(),
          to: z.number(),
          delta: z.number(),
        }),
      ),
      error: z.string().nullable(),
    }),
    handler: async (
      ctx,
      args,
    ): Promise<{
      ok: boolean;
      recorded: number;
      changes: {
        item: string;
        from: number;
        to: number;
        delta: number;
      }[];
      error: string | null;
    }> => {
      const db = ctx.db<typeof schema>();
      const { effective } = await loadStockMaps(ctx);
      const [hitRows, addedRows] = await Promise.all([
        db.select().from(schema.hitItems),
        db.select().from(schema.hitAddedItems),
      ]);
      const canonical = new Map<string, string>();
      for (const r of hitRows) {
        canonical.set(r.item.trim().toLowerCase(), r.item);
      }
      for (const r of addedRows) {
        const k = r.item.trim().toLowerCase();
        if (!canonical.has(k)) canonical.set(k, r.item);
      }
      // Validate everything before recording anything.
      const changes: {
        item: string;
        from: number;
        to: number;
        delta: number;
      }[] = [];
      const seen = new Set<string>();
      for (const c of args.counts) {
        const key = c.item.trim().toLowerCase();
        if (seen.has(key)) continue;
        seen.add(key);
        const current = effective.get(key);
        const name = canonical.get(key);
        if (current == null || !name) {
          return {
            ok: false,
            recorded: 0,
            changes: [],
            error: `“${c.item}” isn't on the HIT List.`,
          };
        }
        if (c.counted !== current) {
          changes.push({
            item: name,
            from: current,
            to: c.counted,
            delta: c.counted - current,
          });
        }
      }
      // Alpha 0.91: a counted INCREASE for an item currently on
      // the Shopping List also settles that shopping entry as
      // Purchased (quantity = the increase). The settle needs each
      // increase's own adjustment id, so increases are inserted
      // one by one; the remaining changes keep the batch insert.
      // Either way the stocktake adjustment is the only stock
      // recorded — the settle adds none of its own.
      const increases = changes.filter((ch) => ch.delta > 0);
      const others = changes.filter((ch) => ch.delta <= 0);
      const { role } = await loadAccountSettings(ctx);
      if (others.length > 0) {
        const statements: BatchItem<"sqlite">[] = others.map((ch) =>
          db.insert(schema.stockAdjustments).values({
            item: ch.item,
            delta: ch.delta,
            source: "stocktake",
            actor: role,
          }),
        );
        const [first, ...rest] = statements;
        if (first) await db.batch([first, ...rest]);
      }
      for (const ch of increases) {
        const [adj] = await db
          .insert(schema.stockAdjustments)
          .values({
            item: ch.item,
            delta: ch.delta,
            source: "stocktake",
            actor: role,
          })
          .returning({ id: schema.stockAdjustments.id });
        await settleShoppingPurchaseFromRestock(
          ctx,
          ch.item,
          ch.delta,
          adj?.id ?? null,
        );
      }
      ctx.invalidateQueries();
      return { ok: true, recorded: changes.length, changes, error: null };
    },
  }),

  getActivityLog: defineAction({
    description:
      "Returns the HIT List Activity log: usage entries (Eaten deductions and 'used some' markers from usage_log), purchase confirmations (from purchase_log, written by confirmPurchased), AND direct stock adjustments from the HIT List +/− steppers and stocktakes (stock_adjustments with source 'quick-adjust' / 'stocktake') merged newest-first, up to 40 entries, each labelled by kind ('used' | 'purchased' | 'adjusted') with item, quantity, source, time, and undone state. A stepper/stocktake adjustment that settled a Shopping List purchase is represented by its purchase entry alone (the purchase entry's Undo reverses that adjustment), so it is not listed twice. Undone entries are included and flagged; an undone entry cannot be undone again (undoUsage / undoPurchase / undoStockAdjustment refuse it).",
    request: z.object({}),
    response: z.object({
      entries: z.array(
        z.object({
          // "usage-<id>", "purchase-<id>" or "adjustment-<id>".
          key: z.string(),
          kind: z.enum(["used", "purchased", "adjusted"]),
          refId: z.number(),
          item: z.string(),
          // Units deducted (used) or bought (purchased); 0 for a
          // "used some" marker entry. For "adjusted" entries the
          // SIGNED delta of the stock change.
          quantity: z.number(),
          usedSome: z.boolean(),
          source: z.string(),
          createdAt: z.string(),
          undone: z.boolean(),
          // Attribution + policy (audit #5, Primary vs
          // Connected): who performed the entry, whether its
          // action type is set Permanent, and whether the
          // current role may undo it.
          ...undoMetaShape.shape,
        }),
      ),
    }),
    handler: async (ctx) => {
      const db = ctx.db<typeof schema>();
      const settings = await loadAccountSettings(ctx);
      const [usageRows, purchaseRows, adjustmentRows] = await Promise.all([
        db
          .select()
          .from(schema.usageLog)
          .orderBy(desc(schema.usageLog.id))
          .limit(40),
        db
          .select()
          .from(schema.purchaseLog)
          .orderBy(desc(schema.purchaseLog.id))
          .limit(40),
        db
          .select()
          .from(schema.stockAdjustments)
          .orderBy(desc(schema.stockAdjustments.id))
          .limit(60),
      ]);
      // Adjustments a purchase entry points at are that
      // purchase's stock change — the purchase entry (and its
      // Undo) speaks for them.
      const purchaseAdjustmentIds = new Set(
        purchaseRows
          .map((r) => r.adjustmentId)
          .filter((v): v is number => v != null),
      );
      const merged = [
        ...usageRows.map((r) => ({
          key: `usage-${r.id}`,
          kind: "used" as const,
          refId: r.id,
          item: r.item,
          quantity: r.deducted,
          usedSome: r.usedSome === 1,
          source: r.source,
          createdAt: r.createdAt.toISOString(),
          undone: r.undone === 1,
          ...undoMeta(settings, "eaten", r.actor, r.undone === 1),
          ts: r.createdAt.getTime(),
        })),
        ...purchaseRows.map((r) => ({
          key: `purchase-${r.id}`,
          kind: "purchased" as const,
          refId: r.id,
          item: r.item,
          quantity: r.quantity,
          usedSome: false,
          source: "Shopping List purchase",
          createdAt: r.createdAt.toISOString(),
          undone: r.undone === 1,
          ...undoMeta(settings, "purchases", r.actor, r.undone === 1),
          ts: r.createdAt.getTime(),
        })),
        ...adjustmentRows
          .filter(
            (r) =>
              (r.source === "quick-adjust" || r.source === "stocktake") &&
              !purchaseAdjustmentIds.has(r.id),
          )
          .map((r) => ({
            key: `adjustment-${r.id}`,
            kind: "adjusted" as const,
            refId: r.id,
            item: r.item,
            quantity: r.delta,
            usedSome: false,
            source: r.source === "stocktake" ? "Stocktake" : "Stock stepper",
            createdAt: r.createdAt.toISOString(),
            undone: r.undone === 1,
            ...undoMeta(
              settings,
              "stockAdjustments",
              r.actor,
              r.undone === 1,
            ),
            ts: r.createdAt.getTime(),
          })),
      ]
        .sort((a, b) => b.ts - a.ts)
        .slice(0, 40)
        .map(({ ts: _ts, ...entry }) => entry);
      return { entries: merged };
    },
  }),

  undoStockAdjustment: defineAction({
    description:
      "Undoes one HIT List stock adjustment from the Activity log (a +/− stepper tap, source 'quick-adjust', or a stocktake correction, source 'stocktake'): marks the adjustment undone so the item's stock returns to exactly what it was before it. A still-pending adjustment is simply retired (it stops counting toward effective stock and is never written to the sheet); one the auto-scan already applied to the sheet gets a compensating pending adjustment for the opposite delta (source 'adjustment-undo') so the next auto-scan corrects the sheet. An adjustment that settled a Shopping List purchase is refused — its Undo is the purchase entry's own. An already-undone adjustment records nothing and reports an error.",
    request: z.object({ id: z.number().int().positive() }),
    response: z.object({
      ok: z.boolean(),
      error: z.string().nullable(),
    }),
    handler: async (ctx, args) =>
      await performUndoStockAdjustment(ctx, args.id),
  }),

  undoPurchase: defineAction({
    description:
      "Undoes one purchase-log entry (a Shopping List Purchased confirmation): marks it undone and reverses its stock effect. If the purchase's stock adjustment is still pending, the adjustment row is deleted outright; if the auto-scan has already applied it to the sheet, a compensating negative pending adjustment for the same quantity is recorded (source 'purchase-undo') so the next auto-scan corrects the sheet. The item's checked rows also lose their Purchased stamp, so it can be confirmed again. An already-undone purchase records nothing and reports an error.",
    request: z.object({ id: z.number().int().positive() }),
    response: z.object({
      ok: z.boolean(),
      error: z.string().nullable(),
    }),
    handler: async (ctx, args) => await performUndoPurchase(ctx, args.id),
  }),

  setItemExpiry: defineAction({
    description:
      "Sets or clears the optional expiry date of one HIT List item (app-side display data only — never written to the sheet, never synced). Pass a 'YYYY-MM-DD' date to set it, or null to clear it. The item must be on the HIT List (sheet rows and app-added items both count); the record is keyed by the item's canonical name.",
    request: z.object({
      item: z.string().min(1).max(120),
      date: z
        .string()
        .regex(/^\d{4}-\d{2}-\d{2}$/, "Date must be YYYY-MM-DD")
        .nullable(),
    }),
    response: z.object({
      ok: z.boolean(),
      error: z.string().nullable(),
    }),
    handler: async (
      ctx,
      args,
    ): Promise<{ ok: boolean; error: string | null }> => {
      const db = ctx.db<typeof schema>();
      const [hitRows, addedRows] = await Promise.all([
        db.select().from(schema.hitItems),
        db.select().from(schema.hitAddedItems),
      ]);
      const key = args.item.trim().toLowerCase();
      const name =
        hitRows.find((r) => r.item.trim().toLowerCase() === key)?.item ??
        addedRows.find((r) => r.item.trim().toLowerCase() === key)?.item;
      if (!name) {
        return { ok: false, error: "That item isn't on the HIT List." };
      }
      if (args.date != null) {
        // Reject impossible dates (e.g. 2026-02-31) the regex lets
        // through: parse and compare the round-trip.
        const parsed = new Date(`${args.date}T00:00:00`);
        if (
          Number.isNaN(parsed.getTime()) ||
          parsed.toISOString().slice(0, 10) !== args.date
        ) {
          return { ok: false, error: "That isn't a real calendar date." };
        }
        await db
          .insert(schema.itemExpiries)
          .values({ item: name, expiryDate: args.date })
          .onConflictDoUpdate({
            target: schema.itemExpiries.item,
            set: { expiryDate: args.date, updatedAt: new Date() },
          });
      } else {
        await db
          .delete(schema.itemExpiries)
          .where(eq(schema.itemExpiries.item, name));
      }
      ctx.invalidateQueries();
      return { ok: true, error: null };
    },
  }),

  lookupBarcode: defineAction({
    description:
      "Looks up a barcode / UPC for the Add Item form's scan-to-add. First checks the SKUs recorded on app-added HIT List items: a match returns the existing item (outcome 'existing') so the user can bump its stock instead of adding a duplicate. Otherwise starts a background lookup (product databases / web) whose result lands via saveBarcodeLookup — poll getBarcodeLookup, which also name-matches a resolved product against the whole HIT List so sheet items can surface as 'existing' too. The code itself is always returned so the form can fill the SKU field even when nothing resolves.",
    request: z.object({ code: z.string().trim().min(4).max(40) }),
    response: z.object({
      outcome: z.enum(["existing", "pending"]),
      code: z.string(),
      matchedItem: z.string().nullable(),
      matchedFormalName: z.string().nullable(),
    }),
    handler: async (
      ctx,
      args,
    ): Promise<{
      outcome: "existing" | "pending";
      code: string;
      matchedItem: string | null;
      matchedFormalName: string | null;
    }> => {
      const db = ctx.db<typeof schema>();
      const code = args.code.replace(/\s/g, "");
      const addedRows = await db.select().from(schema.hitAddedItems);
      const match = addedRows.find(
        (r) => r.sku != null && r.sku.replace(/\s/g, "") === code,
      );
      if (match) {
        return {
          outcome: "existing" as const,
          code,
          matchedItem: match.item,
          matchedFormalName: match.formalName,
        };
      }
      const existing = await db
        .select()
        .from(schema.barcodeLookups)
        .where(eq(schema.barcodeLookups.code, code));
      if (!existing[0]) {
        await db.insert(schema.barcodeLookups).values({ code });
      } else if (existing[0].status === "failed") {
        // Restart the lookup; createdAt restarts too, so the
        // stuck-pending sweep in getBarcodeLookup measures the
        // new attempt, not the original one.
        await db
          .update(schema.barcodeLookups)
          .set({
            status: "pending",
            formalName: null,
            note: null,
            createdAt: new Date(),
            resolvedAt: null,
          })
          .where(eq(schema.barcodeLookups.code, code));
      } else if (
        existing[0].status === "pending" &&
        isStuckPending(existing[0].createdAt)
      ) {
        // The earlier attempt never reported back; the spawn
        // below is a fresh attempt, so restart its clock too.
        await db
          .update(schema.barcodeLookups)
          .set({ createdAt: new Date() })
          .where(eq(schema.barcodeLookups.code, code));
      }
      if (!existing[0] || existing[0].status !== "done") {
        const result = await ctx.agent.spawnTask(
          [
            `Look up the product for barcode / UPC "${code}" for a household inventory app.`,
            "",
            "1. Search the web and product databases (e.g. Open Food Facts, UPC lookup sites, retailer listings) for this exact code.",
            "2. If the code resolves to a specific product, note its full formal product name — brand, product, and size exactly as sold (e.g. \"Kirkland Signature Sea Salt, Fine Grain, 850 g\"). Use only what a page you opened actually shows; if sources disagree or the code doesn't resolve, treat it as unresolved.",
            `3. Call the saveBarcodeLookup action exactly once with { code: "${code}", formalName: <the formal name, or null when unresolved>, note: <one short line about what you found, or why it couldn't be resolved> }.`,
            "Do not invent a product for a code you could not resolve.",
          ].join("\n"),
          { expectsAction: "saveBarcodeLookup", dedupeKey: `hit-barcode-${code}` },
        );
        if (!result.ok) {
          await db
            .update(schema.barcodeLookups)
            .set({ status: "failed", note: result.error })
            .where(eq(schema.barcodeLookups.code, code));
        }
      }
      ctx.invalidateQueries();
      return {
        outcome: "pending" as const,
        code,
        matchedItem: null,
        matchedFormalName: null,
      };
    },
  }),

  getBarcodeLookup: defineAction({
    description:
      "Returns the current state of a barcode lookup started by lookupBarcode: pending, done (with the resolved formal product name, or null when the code couldn't be resolved), or failed. When the lookup resolved to a product, the product name is also matched against the existing HIT List (item names and app-added items' formal/Brand names): a confident match returns matchedItem ( + matchedFormalName when known), so the Add Item form can offer the existing-item stock-bump for sheet items too, not just app-added ones.",
    request: z.object({ code: z.string().trim().min(4).max(40) }),
    response: z.object({
      status: z.enum(["pending", "done", "failed", "none"]),
      formalName: z.string().nullable(),
      note: z.string().nullable(),
      matchedItem: z.string().nullable(),
      matchedFormalName: z.string().nullable(),
    }),
    handler: async (
      ctx,
      args,
    ): Promise<{
      status: "pending" | "done" | "failed" | "none";
      formalName: string | null;
      note: string | null;
      matchedItem: string | null;
      matchedFormalName: string | null;
    }> => {
      const db = ctx.db<typeof schema>();
      const code = args.code.replace(/\s/g, "");
      const rows = await db
        .select()
        .from(schema.barcodeLookups)
        .where(eq(schema.barcodeLookups.code, code));
      const row = rows[0];
      if (!row) {
        return {
          status: "none",
          formalName: null,
          note: null,
          matchedItem: null,
          matchedFormalName: null,
        };
      }
      // A lookup task that never reported back leaves the row
      // pending forever and the Add Item form polling it. Past the
      // stuck threshold, fail it in place so the wait ends; a fresh
      // lookupBarcode for the same code re-runs the lookup.
      if (row.status === "pending" && isStuckPending(row.createdAt)) {
        const note =
          "The lookup didn't come back — it may have been interrupted. Try scanning again.";
        await db
          .update(schema.barcodeLookups)
          .set({ status: "failed", note, resolvedAt: new Date() })
          .where(eq(schema.barcodeLookups.code, code));
        return {
          status: "failed",
          formalName: null,
          note,
          matchedItem: null,
          matchedFormalName: null,
        };
      }
      let matchedItem: string | null = null;
      let matchedFormalName: string | null = null;
      if (row.status === "done" && row.formalName) {
        const [hitRows, addedRows] = await Promise.all([
          db.select().from(schema.hitItems),
          db.select().from(schema.hitAddedItems),
        ]);
        const m = matchExistingByName(row.formalName, hitRows, addedRows);
        if (m) {
          matchedItem = m.item;
          matchedFormalName = m.formalName;
        }
      }
      return {
        status:
          row.status === "done" || row.status === "failed"
            ? row.status
            : "pending",
        formalName: row.formalName,
        note: row.note,
        matchedItem,
        matchedFormalName,
      };
    },
  }),

  saveBarcodeLookup: defineAction({
    description:
      "Saves the result of a barcode lookup: the formal product name the code resolves to, or null when it couldn't be resolved. Called by the barcode-lookup agent task; a null name is an honest 'not found', never a guess.",
    request: z.object({
      code: z.string().min(4).max(40),
      formalName: z.string().max(200).nullable().default(null),
      note: z.string().max(300).nullable().default(null),
    }),
    response: z.object({ saved: z.boolean() }),
    handler: async (ctx, args): Promise<{ saved: boolean }> => {
      const db = ctx.db<typeof schema>();
      const code = args.code.replace(/\s/g, "");
      const rows = await db
        .select()
        .from(schema.barcodeLookups)
        .where(eq(schema.barcodeLookups.code, code));
      if (!rows[0]) {
        await db.insert(schema.barcodeLookups).values({
          code,
          status: "done",
          formalName: args.formalName,
          note: args.note,
          resolvedAt: new Date(),
        });
      } else {
        await db
          .update(schema.barcodeLookups)
          .set({
            status: "done",
            formalName: args.formalName,
            note: args.note,
            resolvedAt: new Date(),
          })
          .where(eq(schema.barcodeLookups.code, code));
      }
      ctx.invalidateQueries();
      return { saved: true };
    },
  }),

  previewRecipeImport: defineAction({
    description:
      "Starts a background import of a recipe page's ingredient list: an agent task reads the page and hands back a draft list (quantities scaled to 2 people where the page gives enough to scale, amounts that couldn't be determined flagged uncertain) via saveRecipeImport. Poll getRecipeImport for the result. Nothing is saved to any meal until the user reviews the draft and saves it through setMealIngredients.",
    request: z.object({ url: z.string().trim().url().max(2000) }),
    response: z.object({
      started: z.boolean(),
      importId: z.number().nullable(),
      error: z.string().nullable(),
    }),
    handler: async (
      ctx,
      args,
    ): Promise<{
      started: boolean;
      importId: number | null;
      error: string | null;
    }> => {
      const db = ctx.db<typeof schema>();
      const inserted = await db
        .insert(schema.recipeImports)
        .values({ url: args.url })
        .returning({ id: schema.recipeImports.id });
      const row = inserted[0];
      if (!row) {
        return { started: false, importId: null, error: "Couldn't start the import." };
      }
      const result = await ctx.agent.spawnTask(
        [
          `Read a recipe page and extract its ingredient list for a meal-planning app: ${args.url}`,
          "",
          "1. Open the page and read the recipe's ingredient list. If the page can't be read (blocked, paywalled, not a recipe), say so plainly in the note and return an empty list — never invent ingredients the page doesn't list.",
          "2. Build the draft list with quantities for 2 people: when the recipe states how many it serves, scale each quantity to 2 servings; when it doesn't, keep the listed quantities and say so in the note. Each ingredient: { name, quantity (number or null), unit (string or null), uncertain (true when the amount couldn't be determined or had to be guessed at, e.g. 'a pinch' or a missing amount) }.",
          `3. Call the saveRecipeImport action exactly once with { importId: ${row.id}, ok: <true when you read the page>, ingredients: [...], note: <one short line: the recipe title / servings basis, or why the page couldn't be read> }.`,
          "Do not add ingredients that aren't on the page. Do not edit anything else.",
        ].join("\n"),
        {
          expectsAction: "saveRecipeImport",
          dedupeKey: `recipe-import-${row.id}`,
        },
      );
      if (!result.ok) {
        await db
          .update(schema.recipeImports)
          .set({ status: "failed", note: result.error })
          .where(eq(schema.recipeImports.id, row.id));
        return { started: false, importId: row.id, error: result.error };
      }
      ctx.invalidateQueries();
      return { started: true, importId: row.id, error: null };
    },
  }),

  getRecipeImport: defineAction({
    description:
      "Returns the state of a recipe import started by previewRecipeImport or startRecipeFileImport: pending, failed (the page/file couldn't be read — note says why), or done with the draft ingredient list for review. An import still pending ten minutes after it started is failed in place and reported failed — its reader task never came back, so the app never waits forever.",
    request: z.object({ importId: z.number().int().positive() }),
    response: z.object({
      status: z.enum(["pending", "done", "failed", "none"]),
      ingredients: z.array(
        z.object({
          name: z.string(),
          quantity: z.number().nullable(),
          unit: z.string().nullable(),
          uncertain: z.boolean(),
        }),
      ),
      note: z.string().nullable(),
    }),
    handler: async (
      ctx,
      args,
    ): Promise<{
      status: "pending" | "done" | "failed" | "none";
      ingredients: {
        name: string;
        quantity: number | null;
        unit: string | null;
        uncertain: boolean;
      }[];
      note: string | null;
    }> => {
      const db = ctx.db<typeof schema>();
      const rows = await db
        .select()
        .from(schema.recipeImports)
        .where(eq(schema.recipeImports.id, args.importId));
      const row = rows[0];
      if (!row) return { status: "none", ingredients: [], note: null };
      // A reader task that never reported back leaves the row
      // pending forever and the app polling it (the boiling pot /
      // "Reading…" never ends). Past the stuck threshold, fail it
      // in place so the wait ends with an explanation instead.
      if (row.status === "pending" && isStuckPending(row.createdAt)) {
        const note =
          "The read didn't come back — it may have been interrupted. Please try again.";
        await db
          .update(schema.recipeImports)
          .set({ status: "failed", note, resolvedAt: new Date() })
          .where(eq(schema.recipeImports.id, row.id));
        return { status: "failed", ingredients: [], note };
      }
      let ingredients: {
        name: string;
        quantity: number | null;
        unit: string | null;
        uncertain: boolean;
      }[] = [];
      if (row.ingredientsJson) {
        try {
          const parsed: unknown = JSON.parse(row.ingredientsJson);
          if (Array.isArray(parsed)) {
            ingredients = parsed
              .filter(
                (i): i is Record<string, unknown> =>
                  typeof i === "object" && i !== null,
              )
              .map((i) => ({
                name: typeof i.name === "string" ? i.name : "",
                quantity:
                  typeof i.quantity === "number" ? i.quantity : null,
                unit: typeof i.unit === "string" ? i.unit : null,
                uncertain: i.uncertain === true,
              }))
              .filter((i) => i.name.length > 0);
          }
        } catch {
          ingredients = [];
        }
      }
      return {
        status:
          row.status === "done" || row.status === "failed"
            ? row.status
            : "pending",
        ingredients,
        note: row.note,
      };
    },
  }),

  saveRecipeImport: defineAction({
    description:
      "Saves the draft ingredient list read from a recipe page by the import agent task. Called by that task only; the draft still needs the user's review in the ingredient editor before it becomes a meal's ingredients.",
    request: z.object({
      importId: z.number().int().positive(),
      ok: z.boolean(),
      ingredients: z
        .array(
          z.object({
            name: z.string().min(1).max(120),
            quantity: z.number().positive().max(100000).nullable(),
            unit: z.string().max(40).nullable(),
            uncertain: z.boolean(),
          }),
        )
        .max(60),
      note: z.string().max(300).nullable().default(null),
    }),
    response: z.object({ saved: z.boolean() }),
    handler: async (ctx, args): Promise<{ saved: boolean }> => {
      const db = ctx.db<typeof schema>();
      const rows = await db
        .select()
        .from(schema.recipeImports)
        .where(eq(schema.recipeImports.id, args.importId));
      if (!rows[0]) return { saved: false };
      await db
        .update(schema.recipeImports)
        .set({
          status: args.ok ? "done" : "failed",
          ingredientsJson: args.ok
            ? JSON.stringify(args.ingredients)
            : null,
          note: args.note,
          resolvedAt: new Date(),
        })
        .where(eq(schema.recipeImports.id, args.importId));
      ctx.invalidateQueries();
      return { saved: true };
    },
  }),

  // ---- Recipe file scans ---------------------------------------------
  // The Scan recipe panel's second intake: the user uploads a file
  // (a photo of a recipe card / cookbook page / screenshot, or a
  // recipe document — PDF or plain text) instead of pasting a link.
  // startRecipeFileImport stores the file in ctx.blobs, opens a
  // recipe_imports row for it (url ""), and spawns the same kind of
  // background reader task the link path uses; the task fetches the
  // file via getPendingRecipeFileImports, reads the recipe out of
  // it, and hands the draft back through saveRecipeImport. The
  // client polls getRecipeImport exactly like a link import, so the
  // draft lands in the same review step (editable rows, uncertain
  // amounts flagged) and flows through coverage, save-to-Meal-List
  // and Recipe Needs unchanged. A file that can't be read — or that
  // holds no recipe — comes back as a failed import and the panel
  // shows a pop-up, never a silent nothing.

  startRecipeFileImport: defineAction({
    description:
      "Starts a background scan of an uploaded recipe file (photo of a recipe, or a PDF / plain-text recipe document) for its ingredient list: the file is stored, an agent task reads the recipe out of it and hands back a draft list (quantities scaled to 2 people where the recipe gives enough to scale, amounts that couldn't be determined flagged uncertain) via saveRecipeImport. Poll getRecipeImport for the result. Unsupported or unreadable files are rejected up front in the response's error. Nothing is saved to any meal until the user reviews the draft and saves it.",
    request: z.object({
      file: z.object({
        // Base64 of the uploaded file (from fileToBase64 on the
        // client; photos are downscaled there first). Capped so a
        // single request stays sane.
        dataBase64: z.string().min(1).max(20_000_000),
        mimeType: z.string().min(1).max(100),
        fileName: z.string().max(200).default(""),
      }),
    }),
    response: z.object({
      started: z.boolean(),
      importId: z.number().nullable(),
      error: z.string().nullable(),
    }),
    handler: async (
      ctx,
      args,
    ): Promise<{
      started: boolean;
      importId: number | null;
      error: string | null;
    }> => {
      const mime = args.file.mimeType.trim().toLowerCase();
      const SUPPORTED = new Set([
        "image/jpeg",
        "image/png",
        "application/pdf",
        "text/plain",
      ]);
      if (!SUPPORTED.has(mime)) {
        return {
          started: false,
          importId: null,
          error:
            "That kind of file can't be read — use a photo (JPEG or PNG), a PDF, or a plain-text file.",
        };
      }
      let bytes: Uint8Array;
      try {
        bytes = base64ToBytes(args.file.dataBase64);
      } catch {
        return {
          started: false,
          importId: null,
          error: "That file couldn't be read. Try a different file.",
        };
      }
      if (bytes.length === 0) {
        return {
          started: false,
          importId: null,
          error: "That file was empty.",
        };
      }
      const db = ctx.db<typeof schema>();
      const inserted = await db
        .insert(schema.recipeImports)
        .values({
          url: "",
          fileMimeType: mime,
          fileName: args.file.fileName.trim() || null,
        })
        .returning({ id: schema.recipeImports.id });
      const row = inserted[0];
      if (!row) {
        return {
          started: false,
          importId: null,
          error: "Couldn't start the scan.",
        };
      }
      const key = `recipe-file-imports/${row.id}`;
      await ctx.blobs.put(key, bytes, { contentType: mime });
      await db
        .update(schema.recipeImports)
        .set({ fileBlobKey: key })
        .where(eq(schema.recipeImports.id, row.id));
      const result = await ctx.agent.spawnTask(
        [
          `Read a recipe out of an uploaded file and extract its ingredient list for a meal-planning app. The upload is import #${row.id} (file name: ${args.file.fileName.trim() || "unnamed"}, type: ${mime}).`,
          "",
          `1. Call the getPendingRecipeFileImports action and find import #${row.id}; open its fileUrl to read the file. It is a photo of a recipe (recipe card, cookbook page, or screenshot), a PDF recipe document, or a plain-text recipe. If the file can't be opened or read at all, say so plainly in the note and return an empty list — never invent ingredients the file doesn't list.`,
          "2. Build the draft list with quantities for 2 people: when the recipe states how many it serves, scale each quantity to 2 servings; when it doesn't, keep the listed quantities and say so in the note. Each ingredient: { name, quantity (number or null), unit (string or null), uncertain (true when the amount couldn't be determined or had to be guessed at, e.g. 'a pinch' or a missing amount) }.",
          `3. Call the saveRecipeImport action exactly once with { importId: ${row.id}, ok: <true when you read a recipe out of the file AND found at least one ingredient>, ingredients: [...], note: <one short line: the recipe title / servings basis, or why the file couldn't be read / held no recipe> }.`,
          "Do not add ingredients that aren't in the file. Do not edit anything else.",
        ].join("\n"),
        {
          expectsAction: "saveRecipeImport",
          dedupeKey: `recipe-file-import-${row.id}`,
        },
      );
      if (!result.ok) {
        await db
          .update(schema.recipeImports)
          .set({ status: "failed", note: result.error })
          .where(eq(schema.recipeImports.id, row.id));
        return { started: false, importId: row.id, error: result.error };
      }
      ctx.invalidateQueries();
      return { started: true, importId: row.id, error: null };
    },
  }),

  getPendingRecipeFileImports: defineAction({
    description:
      "Lists the recipe file scans still waiting to be read (status 'pending'), oldest first, each with a URL for its stored uploaded file, so Muse can open the file (a recipe photo, PDF, or text document), extract the ingredient list, and write the draft back with saveRecipeImport.",
    request: z.object({}),
    response: z.object({
      pending: z.array(
        z.object({
          id: z.number(),
          createdAt: z.string(),
          fileMimeType: z.string().nullable(),
          fileName: z.string().nullable(),
          fileUrl: z.string().nullable(),
        }),
      ),
    }),
    handler: async (ctx) => {
      const db = ctx.db<typeof schema>();
      const rows = await db
        .select()
        .from(schema.recipeImports)
        .orderBy(asc(schema.recipeImports.id));
      const pending = rows.filter(
        (r) => r.status === "pending" && r.fileBlobKey != null,
      );
      const out: {
        id: number;
        createdAt: string;
        fileMimeType: string | null;
        fileName: string | null;
        fileUrl: string | null;
      }[] = [];
      for (const r of pending) {
        out.push({
          id: r.id,
          createdAt: r.createdAt.toISOString(),
          fileMimeType: r.fileMimeType,
          fileName: r.fileName,
          fileUrl: r.fileBlobKey
            ? await ctx.blobs.getUrl(r.fileBlobKey)
            : null,
        });
      }
      return { pending: out };
    },
  }),

  // ---- Recipe needs: ingredient coverage + quick price checks -------
  // Coverage cross-references each meal's ingredients with the HIT
  // List inventory (see the helpers above loadRecipeNeeds). The
  // Shopping List shows one "<Recipe> Recipe Needs" section per
  // meal that still needs ingredients, under Membership
  // Alternatives; each need carries a quick Flipp + store-website
  // price check (sale price when on sale, otherwise the lowest
  // verified regular price), run by checkRecipeNeeds.

  getRecipeNeeds: defineAction({
    description:
      "Returns ingredient coverage for every meal that has an ingredient list: per ingredient, whether it's covered (a matching HIT List item has enough stock), short (matched but below the recipe's quantity, with have vs need), or missing (no match, or stock 0), plus the covered/total fraction per meal. Still-needed ingredients carry their quick price check (pending / done with sale or lowest regular price / failed) and their Shopping List check-off state. Coverage is derived live from the meals' ingredients and the inventory's effective stock, so restocks and edits are reflected on the next read.",
    request: z.object({}),
    response: recipeNeedsResponse,
    handler: async (ctx): Promise<RecipeNeedsResponse> =>
      loadRecipeNeeds(ctx),
  }),

  getIngredientCoverage: defineAction({
    description:
      "Cross-references an arbitrary ingredient list (e.g. a scanned recipe's draft, not yet saved as a meal) against the HIT List inventory, returning the same covered / short / missing marks and covered/total fraction getRecipeNeeds gives saved meals. Pure read — nothing is stored.",
    request: z.object({
      ingredients: z
        .array(
          z.object({
            name: z.string().min(1).max(120),
            quantity: z.number().positive().max(100000).nullable(),
            unit: z.string().max(40).nullable(),
          }),
        )
        .max(60),
    }),
    response: z.object({
      coveredCount: z.number(),
      totalCount: z.number(),
      entries: z.array(coverageEntryShape),
    }),
    handler: async (
      ctx,
      args,
    ): Promise<{
      coveredCount: number;
      totalCount: number;
      entries: CoverageEntry[];
    }> => {
      const inventory = await loadInventoryEntries(ctx);
      const entries = args.ingredients.map((ing) =>
        coverageForIngredient(
          {
            name: ing.name.trim(),
            quantity: ing.quantity,
            unit: ing.unit?.trim() ? ing.unit.trim() : null,
          },
          inventory,
        ),
      );
      return {
        coveredCount: entries.filter((e) => e.status === "covered").length,
        totalCount: entries.length,
        entries,
      };
    },
  }),

  checkRecipeNeeds: defineAction({
    description:
      "Runs (or re-runs) the quick price check for one recipe's still-needed ingredients: recomputes the recipe's coverage from its stored ingredients and the live inventory, and for every ingredient still short or missing whose recorded price is missing, failed, or stale (done over a week ago — one flyer cycle; failed over a day ago; a check left pending over 15 minutes), starts ONE background agent task that checks this week's Flipp flyers and the usual store websites and hands verified prices back via saveRecipeNeedPrices. With force: true every current need is re-checked. Needs that are already freshly priced are left alone. Returns how many ingredients are being (re)checked.",
    request: z.object({
      mealId: z.number().int().positive(),
      force: z.boolean().optional(),
    }),
    response: z.object({
      started: z.boolean(),
      checking: z.number(),
      error: z.string().nullable(),
    }),
    handler: async (
      ctx,
      args,
    ): Promise<{
      started: boolean;
      checking: number;
      error: string | null;
    }> => {
      const db = ctx.db<typeof schema>();
      const mealRows = await db
        .select()
        .from(schema.meals)
        .where(eq(schema.meals.id, args.mealId));
      const meal = mealRows[0];
      if (!meal) {
        return { started: false, checking: 0, error: "That recipe no longer exists." };
      }
      const ingRows = await db
        .select()
        .from(schema.mealIngredients)
        .where(eq(schema.mealIngredients.mealId, args.mealId))
        .orderBy(
          asc(schema.mealIngredients.sortOrder),
          asc(schema.mealIngredients.id),
        );
      if (ingRows.length === 0) {
        return { started: false, checking: 0, error: null };
      }
      const inventory = await loadInventoryEntries(ctx);
      const priceRows = await db
        .select()
        .from(schema.recipeNeedPrices)
        .where(eq(schema.recipeNeedPrices.mealId, args.mealId));
      const priceByKey = new Map(
        priceRows.map((p) => [p.ingredientKey, p]),
      );
      const now = Date.now();
      const WEEK_MS = 7 * 86_400_000;
      const DAY_MS = 86_400_000;
      const PENDING_MS = 15 * 60_000;
      const toCheck: {
        name: string;
        quantity: number | null;
        unit: string | null;
      }[] = [];
      for (const ing of ingRows) {
        const cov = coverageForIngredient(ing, inventory);
        if (cov.status === "covered") continue;
        const row = priceByKey.get(normalizeIngredientName(ing.name));
        let stale = args.force === true || !row;
        if (row) {
          if (row.status === "done") {
            stale =
              stale ||
              row.checkedAt == null ||
              now - row.checkedAt.getTime() > WEEK_MS;
          } else if (row.status === "failed") {
            stale =
              stale ||
              row.checkedAt == null ||
              now - row.checkedAt.getTime() > DAY_MS;
          } else {
            // pending: a check that never landed gets retried.
            stale = stale || now - row.updatedAt.getTime() > PENDING_MS;
          }
        }
        if (stale) {
          toCheck.push({
            name: ing.name,
            quantity: ing.quantity,
            unit: ing.unit,
          });
        }
      }
      if (toCheck.length === 0) {
        return { started: false, checking: 0, error: null };
      }
      // Mark the ones being checked pending up front so the UI can
      // show "Checking prices…" while the task runs.
      for (const need of toCheck) {
        await db
          .insert(schema.recipeNeedPrices)
          .values({
            mealId: meal.id,
            ingredientKey: normalizeIngredientName(need.name),
            ingredient: need.name,
            status: "pending",
          })
          .onConflictDoUpdate({
            target: [
              schema.recipeNeedPrices.mealId,
              schema.recipeNeedPrices.ingredientKey,
            ],
            set: { ingredient: need.name, status: "pending", updatedAt: new Date() },
          });
      }
      const result = await ctx.agent.spawnTask(
        recipeNeedsPricePrompt(meal.id, meal.name, toCheck),
        {
          expectsAction: "saveRecipeNeedPrices",
          dedupeKey: `recipe-needs-prices-${meal.id}`,
        },
      );
      if (!result.ok) {
        for (const need of toCheck) {
          await db
            .update(schema.recipeNeedPrices)
            .set({
              status: "failed",
              note: "The price check couldn't start.",
              checkedAt: new Date(),
              updatedAt: new Date(),
            })
            .where(
              and(
                eq(schema.recipeNeedPrices.mealId, meal.id),
                eq(
                  schema.recipeNeedPrices.ingredientKey,
                  normalizeIngredientName(need.name),
                ),
              ),
            );
        }
        return { started: false, checking: 0, error: result.error };
      }
      ctx.invalidateQueries();
      return { started: true, checking: toCheck.length, error: null };
    },
  }),

  saveRecipeNeedPrices: defineAction({
    description:
      "Saves the quick price-check results for one recipe's needed ingredients. Called by the background check task spawned by checkRecipeNeeds only. Each result: the ingredient name exactly as the recipe lists it, the lowest verified sale price + store + sale end when it's on sale (nulls when not), the lowest verified regular price + store, a one-line note, and the exact page the reported price was verified on. A result with no verified price at all is stored as failed so the UI says so instead of showing a guess.",
    request: z.object({
      mealId: z.number().int().positive(),
      results: z
        .array(
          z.object({
            ingredient: z.string().min(1).max(120),
            salePriceCents: z.number().int().min(0).nullable(),
            saleStore: z.string().max(120).nullable(),
            saleEnd: z.string().max(120).nullable(),
            regularPriceCents: z.number().int().min(0).nullable(),
            regularStore: z.string().max(120).nullable(),
            note: z.string().max(300).nullable().default(null),
            sourceUrl: z.string().max(2000).nullable().default(null),
            sourceType: z
              .enum(["flipp", "website"])
              .nullable()
              .default(null),
          }),
        )
        .max(60),
    }),
    response: z.object({ saved: z.number() }),
    handler: async (ctx, args): Promise<{ saved: number }> => {
      const db = ctx.db<typeof schema>();
      const mealRows = await db
        .select()
        .from(schema.meals)
        .where(eq(schema.meals.id, args.mealId));
      if (!mealRows[0]) return { saved: 0 };
      let saved = 0;
      for (const r of args.results) {
        const hasPrice =
          r.salePriceCents != null || r.regularPriceCents != null;
        await db
          .insert(schema.recipeNeedPrices)
          .values({
            mealId: args.mealId,
            ingredientKey: normalizeIngredientName(r.ingredient),
            ingredient: r.ingredient.trim(),
            status: hasPrice ? "done" : "failed",
            salePriceCents: r.salePriceCents,
            saleStore: r.saleStore,
            saleEnd: r.saleEnd,
            regularPriceCents: r.regularPriceCents,
            regularStore: r.regularStore,
            note: r.note,
            sourceUrl: r.sourceUrl,
            sourceType: r.sourceType,
            checkedAt: new Date(),
          })
          .onConflictDoUpdate({
            target: [
              schema.recipeNeedPrices.mealId,
              schema.recipeNeedPrices.ingredientKey,
            ],
            set: {
              ingredient: r.ingredient.trim(),
              status: hasPrice ? "done" : "failed",
              salePriceCents: r.salePriceCents,
              saleStore: r.saleStore,
              saleEnd: r.saleEnd,
              regularPriceCents: r.regularPriceCents,
              regularStore: r.regularStore,
              note: r.note,
              sourceUrl: r.sourceUrl,
              sourceType: r.sourceType,
              checkedAt: new Date(),
              updatedAt: new Date(),
            },
          });
        saved++;
      }
      ctx.invalidateQueries();
      return { saved };
    },
  }),

  setRecipeNeedChecked: defineAction({
    description:
      "Marks one recipe-needs row on the Shopping List as struck off (checked) or not. Local to this app only and display-only: checking a needs row never records a purchase and never changes inventory (unlike the sheet rows' Purchased confirmations).",
    request: z.object({
      mealId: z.number().int().positive(),
      ingredient: z.string().min(1).max(120),
      checked: z.boolean(),
    }),
    response: z.object({ ok: z.literal(true) }),
    handler: async (ctx, args): Promise<{ ok: true }> => {
      const db = ctx.db<typeof schema>();
      const key = recipeNeedKey(args.mealId, args.ingredient);
      if (args.checked) {
        await db
          .insert(schema.recipeNeedChecks)
          .values({ needKey: key, checked: 1 })
          .onConflictDoUpdate({
            target: schema.recipeNeedChecks.needKey,
            set: { checked: 1 },
          });
      } else {
        await db
          .update(schema.recipeNeedChecks)
          .set({ checked: 0 })
          .where(eq(schema.recipeNeedChecks.needKey, key));
      }
      ctx.invalidateQueries();
      return { ok: true as const };
    },
  }),

  addMealWithIngredients: defineAction({
    description:
      "Adds a new meal idea with its ingredient list in one step and no protein option groups — the save path for a recipe brought in through Scan recipe, whose ingredients are known but whose proteins aren't structured picks. The meal joins the Meal List under its meal type exactly like an Add Meal meal; coverage and recipe needs pick it up from its ingredients. (Meals added via addMeal carry protein groups and get their ingredients through setMealIngredients instead.)",
    request: z.object({
      name: z.string().trim().min(1).max(120),
      mealType: mealTypeEnum,
      ingredients: z
        .array(
          z.object({
            name: z.string().min(1).max(120),
            quantity: z.number().positive().max(100000).nullable(),
            unit: z.string().max(40).nullable(),
          }),
        )
        .min(1)
        .max(60),
    }),
    response: z.object({ id: z.number() }),
    handler: async (ctx, args) => {
      const db = ctx.db<typeof schema>();
      const existing = await db.select().from(schema.meals);
      const inserted = await db
        .insert(schema.meals)
        .values({
          name: args.name,
          mealType: args.mealType,
          sortOrder: existing.length,
        })
        .returning({ id: schema.meals.id });
      const meal = inserted[0];
      if (!meal) throw new Error("addMealWithIngredients: insert returned no rows");
      for (const [sortOrder, ing] of args.ingredients.entries()) {
        await db.insert(schema.mealIngredients).values({
          mealId: meal.id,
          name: ing.name.trim(),
          quantity: ing.quantity,
          unit: ing.unit?.trim() ? ing.unit.trim() : null,
          sortOrder,
        });
      }
      ctx.invalidateQueries();
      return { id: meal.id };
    },
  }),

  requestRecipeVideo: defineAction({
    description:
      "Records a cooking-video request for a recipe: a full snapshot (recipe name, meal type, protein, servings, ingredients with quantities as they should appear on screen, walkthrough steps, and the linked meal id/name when the recipe has been saved to the Meal List). Requests are matched by recipe name (case-insensitive): requesting again for the same recipe updates that entry — including linking it to the meal once saved — instead of duplicating it, and never resets a 'ready' video back to 'requested'. The video itself is made externally by Muse: reel-style (vertical), under 5 minutes, showing all the listed ingredients on screen and walking through the steps.",
    request: z.object({
      recipeName: z.string().trim().min(1).max(120),
      mealType: mealTypeEnum,
      protein: z.string().max(120).nullable().default(null),
      servings: z.number().int().min(1).max(12),
      ingredients: z
        .array(
          z.object({
            name: z.string().min(1).max(120),
            quantity: z.number().positive().max(100000).nullable(),
            unit: z.string().max(40).nullable(),
          }),
        )
        .max(60),
      steps: z.array(z.string().min(1).max(600)).max(30),
      mealId: z.number().int().positive().nullable().default(null),
      mealName: z.string().max(120).nullable().default(null),
      // Web source when the recipe came from one of the curated
      // recipe sites: dish name on the site, site name, exact URL.
      // When omitted and mealId names a meal with a stored source
      // (setMealSource), that source is attached instead.
      sourceName: z.string().max(200).nullable().default(null),
      sourceSite: z.string().max(80).nullable().default(null),
      sourceUrl: z.string().max(2000).nullable().default(null),
    }),
    response: z.object({
      id: z.number(),
      status: z.enum(["requested", "ready"]),
    }),
    handler: async (
      ctx,
      args,
    ): Promise<{ id: number; status: "requested" | "ready" }> => {
      const db = ctx.db<typeof schema>();
      const key = args.recipeName.toLowerCase();
      const rows = await db.select().from(schema.recipeVideoRequests);
      const existing = rows.find(
        (r) => r.recipeName.trim().toLowerCase() === key,
      );
      // Web source: explicit args win; otherwise, when the request
      // is for a saved meal, fall back to the source stored with
      // that meal (setMealSource). An update that carries no source
      // keeps whatever source the existing entry already has.
      let sourceName = args.sourceName;
      let sourceSite = args.sourceSite;
      let sourceUrl = args.sourceUrl;
      if (sourceUrl == null && args.mealId != null) {
        const mealSourceRows = await db
          .select()
          .from(schema.mealSources)
          .where(eq(schema.mealSources.mealId, args.mealId));
        const ms = mealSourceRows[0];
        if (ms) {
          sourceName = ms.sourceName;
          sourceSite = ms.sourceSite;
          sourceUrl = ms.sourceUrl;
        }
      }
      if (existing && sourceUrl == null) {
        sourceName = existing.sourceName;
        sourceSite = existing.sourceSite;
        sourceUrl = existing.sourceUrl;
      }
      const snapshot = {
        recipeName: args.recipeName,
        mealType: args.mealType,
        protein: args.protein,
        servings: args.servings,
        ingredientsJson: JSON.stringify(args.ingredients),
        stepsJson: JSON.stringify(args.steps),
        mealId: args.mealId,
        mealName: args.mealName,
        sourceName,
        sourceSite,
        sourceUrl,
        updatedAt: new Date(),
      };
      if (existing) {
        await db
          .update(schema.recipeVideoRequests)
          .set(snapshot)
          .where(eq(schema.recipeVideoRequests.id, existing.id));
        ctx.invalidateQueries();
        return {
          id: existing.id,
          status: existing.status === "ready" ? "ready" : "requested",
        };
      }
      const inserted = await db
        .insert(schema.recipeVideoRequests)
        .values({ ...snapshot, status: "requested" })
        .returning({ id: schema.recipeVideoRequests.id });
      const row = inserted[0];
      if (!row) throw new Error("requestRecipeVideo: insert returned no rows");
      ctx.invalidateQueries();
      return { id: row.id, status: "requested" as const };
    },
  }),

  getRecipeVideos: defineAction({
    description:
      "Lists every cooking-video request (shown in the Meal Planner tab's 'Recipe videos' dropdown): recipe snapshot, walkthrough steps, status ('requested' or 'ready'), and the video URL when one has been delivered. Newest first.",
    request: z.object({}),
    response: z.object({
      videos: z.array(
        z.object({
          id: z.number(),
          recipeName: z.string(),
          mealType: mealTypeEnum,
          protein: z.string().nullable(),
          servings: z.number(),
          ingredients: z.array(
            z.object({
              name: z.string(),
              quantity: z.number().nullable(),
              unit: z.string().nullable(),
            }),
          ),
          steps: z.array(z.string()),
          mealId: z.number().nullable(),
          mealName: z.string().nullable(),
          status: z.enum(["requested", "ready"]),
          videoUrl: z.string().nullable(),
          note: z.string().nullable(),
          // Web source (dish name, site, exact URL) when the recipe
          // came from one of the curated recipe sites; nulls for
          // inventory-built recipes.
          sourceName: z.string().nullable(),
          sourceSite: z.string().nullable(),
          sourceUrl: z.string().nullable(),
          createdAt: z.string(),
        }),
      ),
    }),
    handler: async (ctx) => {
      const db = ctx.db<typeof schema>();
      const rows = await db
        .select()
        .from(schema.recipeVideoRequests)
        .orderBy(asc(schema.recipeVideoRequests.id));
      const parseList = <T,>(json: string): T[] => {
        try {
          const parsed: unknown = JSON.parse(json);
          return Array.isArray(parsed) ? (parsed as T[]) : [];
        } catch {
          return [];
        }
      };
      return {
        videos: rows
          .map((r) => ({
            id: r.id,
            recipeName: r.recipeName,
            mealType: mealTypeEnum.parse(r.mealType),
            protein: r.protein,
            servings: r.servings,
            ingredients: parseList<{
              name: string;
              quantity: number | null;
              unit: string | null;
            }>(r.ingredientsJson),
            steps: parseList<string>(r.stepsJson),
            mealId: r.mealId,
            mealName: r.mealName,
            status:
              r.status === "ready"
                ? ("ready" as const)
                : ("requested" as const),
            videoUrl: r.videoUrl,
            note: r.note,
            sourceName: r.sourceName,
            sourceSite: r.sourceSite,
            sourceUrl: r.sourceUrl,
            createdAt: r.createdAt.toISOString(),
          }))
          .reverse(),
      };
    },
  }),

  setMealSource: defineAction({
    description:
      "Stores the web source (dish name on the site, site name, exact recipe URL) of a Meal List meal that was saved from a generated web recipe. Local display metadata only: Meal List rows don't show it and it never enters the MEAL-SYNC format — it surfaces on the meal's Recipe videos entry when a cooking video is requested for the meal.",
    request: z.object({
      mealId: z.number().int().positive(),
      sourceName: z.string().trim().min(1).max(200),
      sourceSite: z.string().trim().min(1).max(80),
      sourceUrl: z.string().trim().url().max(2000),
    }),
    response: z.object({ saved: z.boolean() }),
    handler: async (ctx, args): Promise<{ saved: boolean }> => {
      const db = ctx.db<typeof schema>();
      const mealRows = await db
        .select({ id: schema.meals.id })
        .from(schema.meals)
        .where(eq(schema.meals.id, args.mealId));
      if (!mealRows[0]) return { saved: false };
      const values = {
        mealId: args.mealId,
        sourceName: args.sourceName,
        sourceSite: args.sourceSite,
        sourceUrl: args.sourceUrl,
      };
      const existing = await db
        .select()
        .from(schema.mealSources)
        .where(eq(schema.mealSources.mealId, args.mealId));
      if (existing[0]) {
        await db
          .update(schema.mealSources)
          .set(values)
          .where(eq(schema.mealSources.mealId, args.mealId));
      } else {
        await db.insert(schema.mealSources).values(values);
      }
      ctx.invalidateQueries();
      return { saved: true };
    },
  }),

  getPendingVideoRequests: defineAction({
    description:
      "Lists the cooking-video requests still waiting to be made (status 'requested'), oldest first, with their full recipe snapshots, so Muse can generate the videos externally and mark them ready with setRecipeVideoStatus.",
    request: z.object({}),
    response: z.object({
      pending: z.array(
        z.object({
          id: z.number(),
          recipeName: z.string(),
          mealType: mealTypeEnum,
          protein: z.string().nullable(),
          servings: z.number(),
          ingredients: z.array(
            z.object({
              name: z.string(),
              quantity: z.number().nullable(),
              unit: z.string().nullable(),
            }),
          ),
          steps: z.array(z.string()),
          mealId: z.number().nullable(),
          mealName: z.string().nullable(),
          createdAt: z.string(),
        }),
      ),
    }),
    handler: async (ctx) => {
      const db = ctx.db<typeof schema>();
      const rows = await db
        .select()
        .from(schema.recipeVideoRequests)
        .orderBy(asc(schema.recipeVideoRequests.id));
      const parseList = <T,>(json: string): T[] => {
        try {
          const parsed: unknown = JSON.parse(json);
          return Array.isArray(parsed) ? (parsed as T[]) : [];
        } catch {
          return [];
        }
      };
      return {
        pending: rows
          .filter((r) => r.status !== "ready")
          .map((r) => ({
            id: r.id,
            recipeName: r.recipeName,
            mealType: mealTypeEnum.parse(r.mealType),
            protein: r.protein,
            servings: r.servings,
            ingredients: parseList<{
              name: string;
              quantity: number | null;
              unit: string | null;
            }>(r.ingredientsJson),
            steps: parseList<string>(r.stepsJson),
            mealId: r.mealId,
            mealName: r.mealName,
            createdAt: r.createdAt.toISOString(),
          })),
      };
    },
  }),

  setRecipeVideoStatus: defineAction({
    description:
      "Updates a cooking-video request's status: 'requested' or 'ready', with the delivered video's URL and an optional note. Called by Muse after generating the video externally (reel-style, vertical, under 5 minutes, all ingredients shown on screen, steps walked through).",
    request: z.object({
      id: z.number().int().positive(),
      status: z.enum(["requested", "ready"]),
      videoUrl: z.string().max(2000).nullable().default(null),
      note: z.string().max(300).nullable().default(null),
    }),
    response: z.object({ saved: z.boolean() }),
    handler: async (ctx, args): Promise<{ saved: boolean }> => {
      const db = ctx.db<typeof schema>();
      const res = await db
        .update(schema.recipeVideoRequests)
        .set({
          status: args.status,
          videoUrl: args.videoUrl,
          note: args.note,
          updatedAt: new Date(),
        })
        .where(eq(schema.recipeVideoRequests.id, args.id))
        .returning({ id: schema.recipeVideoRequests.id });
      ctx.invalidateQueries();
      return { saved: res.length > 0 };
    },
  }),

  generateRecipe: defineAction({
    description:
      "Generates one recipe from the live inventory: built around the chosen protein (a HIT List item name) and the chosen meal type, with supporting ingredients drawn only from items currently in stock — close-to-expiry items (expiry within 3 days or already past, the app's one use-first window) are weighed first for every ingredient slot — quantities written for 2 people, and short numbered steps. variant rotates the template and ingredient picks so asking again gives a different combination. When the protein is out of stock the recipe still generates but proteinInStock is false so the app can flag it clearly. For proteins in the curated web recipe table (WEB_RECIPES — RecipeTin Eats / BBC Good Food / Allrecipes), the response also carries the chosen web recipe as `source` and the state of its page load: the parsed page (webRecipe) when already read, 'pending' with a webLoadId to poll via getWebRecipeLoad while a background task reads the page, or 'failed' when the page couldn't be read — the inventory-built body above is the fallback in the pending/failed cases and is replaced by the web recipe in the app once the load lands.",
    request: z.object({
      protein: z.string().min(1).max(120),
      mealType: mealTypeEnum,
      servings: z.number().int().min(1).max(12),
      variant: z.number().int().min(0).max(999).default(0),
    }),
    response: recipeOut,
    handler: async (ctx, args): Promise<RecipeOut> => {
      const db = ctx.db<typeof schema>();
      const hitRows = await db.select().from(schema.hitItems);
      const addedRows = await db.select().from(schema.hitAddedItems);
      const expiryRows = await db.select().from(schema.itemExpiries);
      const expiryByKey = new Map(
        expiryRows.map((r) => [r.item.trim().toLowerCase(), r.expiryDate]),
      );
      const { effective } = await loadStockMaps(ctx);
      const inventory: InvItem[] = [];
      const seenInv = new Set<string>();
      for (const r of hitRows) {
        const key = r.item.trim().toLowerCase();
        if (seenInv.has(key)) continue;
        seenInv.add(key);
        inventory.push({
          name: r.item,
          stock: effective.get(key) ?? r.stock,
          expiry: expiryByKey.get(key) ?? null,
        });
      }
      for (const r of addedRows) {
        const key = r.item.trim().toLowerCase();
        if (seenInv.has(key)) continue;
        seenInv.add(key);
        inventory.push({
          name: r.item,
          stock: effective.get(key) ?? r.stock,
          expiry: expiryByKey.get(key) ?? null,
        });
      }
      const proteinKey = args.protein.trim().toLowerCase();
      const proteinRow = inventory.find(
        (i) => i.name.trim().toLowerCase() === proteinKey,
      );
      const proteinStock = proteinRow ? proteinRow.stock : null;
      const proteinName = proteinRow?.name ?? args.protein;
      // Web recipe: the protein dictates which curated recipe is
      // chosen; `variant` rotates through the candidates. The page
      // itself is read by a background agent task (the same
      // machinery as the recipe-link import) and cached in
      // web_recipe_loads — this action starts the load when needed
      // and reports its state; the client polls getWebRecipeLoad.
      const webEntry = pickWebRecipe(proteinName, args.mealType, args.variant);
      let webStatus: RecipeOut["webStatus"] = "none";
      let webLoadId: number | null = null;
      let webRecipe: RecipeOut["webRecipe"] = null;
      if (webEntry) {
        const loadRows = await db
          .select()
          .from(schema.webRecipeLoads)
          .where(eq(schema.webRecipeLoads.url, webEntry.url));
        let load = loadRows[0];
        // A failed load is retried once it's more than a day old —
        // a site block today shouldn't retire the recipe forever.
        const staleFailed =
          load?.status === "failed" &&
          load.resolvedAt != null &&
          Date.now() - load.resolvedAt.getTime() > 24 * 60 * 60 * 1000;
        // A load whose reader task never reported back is stuck at
        // pending; past the stuck threshold, drop the row so this
        // generation starts a fresh load instead of reporting
        // "pending" forever.
        const stuckPending =
          load?.status === "pending" && isStuckPending(load.createdAt);
        if (load && (staleFailed || stuckPending)) {
          await db
            .delete(schema.webRecipeLoads)
            .where(eq(schema.webRecipeLoads.id, load.id));
          load = undefined;
        }
        if (!load) {
          const insertedLoad = await db
            .insert(schema.webRecipeLoads)
            .values({ url: webEntry.url })
            .returning({ id: schema.webRecipeLoads.id });
          const newLoad = insertedLoad[0];
          if (newLoad) {
            load = {
              id: newLoad.id,
              url: webEntry.url,
              status: "pending",
              title: null,
              servings: null,
              ingredientsJson: null,
              stepsJson: null,
              note: null,
              createdAt: new Date(),
              resolvedAt: null,
            };
            const task = await ctx.agent.spawnTask(
              [
                `Read a recipe page and extract the full recipe for a meal-planning app: ${webEntry.url}`,
                "",
                "1. Open the page and read the recipe. If the page can't be read (blocked, paywalled, not a recipe) or has no ingredient list / method, say so plainly in the note and return ok: false with empty lists — never invent ingredients or steps the page doesn't give.",
                "2. Ingredients: every ingredient the page lists, each as { name, quantity (number or null when the page gives no amount, e.g. 'to taste'), unit (string or null) }. Keep the quantities EXACTLY as the page states them, for the number of servings the page states — do not scale anything.",
                "3. Steps: the recipe's method as an ordered list of step strings, in the page's own order, complete enough to cook from (combine micro-steps that belong together, but don't drop any cooking action, time, or temperature the page gives).",
                "4. Servings: the number of people the page says the recipe serves, as an integer, or null when the page doesn't state it.",
                `5. Call the saveWebRecipeLoad action exactly once with { loadId: ${newLoad.id}, ok: <true when you read the page>, title: <the dish title as it appears on the page, or null>, servings: <integer or null>, ingredients: [...], steps: [...], note: <one short line: the recipe title / servings basis, or why the page couldn't be read> }.`,
                "Do not edit anything else.",
              ].join("\n"),
              {
                expectsAction: "saveWebRecipeLoad",
                dedupeKey: `web-recipe-load-${newLoad.id}`,
              },
            );
            if (!task.ok) {
              await db
                .update(schema.webRecipeLoads)
                .set({
                  status: "failed",
                  note: task.error,
                  resolvedAt: new Date(),
                })
                .where(eq(schema.webRecipeLoads.id, newLoad.id));
              load.status = "failed";
              load.note = task.error;
            }
          }
        }
        if (load) {
          webLoadId = load.id;
          if (load.status === "done") {
            webRecipe = parseWebRecipeLoad(load);
            webStatus = webRecipe ? "done" : "failed";
          } else if (load.status === "failed") {
            webStatus = "failed";
          } else {
            webStatus = "pending";
          }
        }
      }
      const templates =
        RECIPE_TEMPLATES[args.mealType] ?? RECIPE_TEMPLATES.dinner ?? [];
      const template =
        templates[args.variant % Math.max(1, templates.length)];
      if (!template) throw new Error("No recipe templates available.");
      const used = new Set<string>([proteinKey]);
      const picks = new Map<string, InvItem>();
      for (const slot of template.slots) {
        const pick = poolPick(
          inventory,
          slot.spec.keywords,
          used,
          args.variant,
        );
        if (pick) {
          picks.set(slot.key, pick);
          used.add(pick.name.toLowerCase());
        } else if (!slot.spec.optional) {
          // A required slot with nothing in stock: leave it out
          // rather than invent an ingredient the household may not
          // have — the steps fall back to generic wording.
        }
      }
      const base = proteinBase(proteinName);
      const ingredients: RecipeOut["ingredients"] = [
        { name: proteinName, quantity: base.quantity, unit: base.unit },
      ];
      for (const slot of template.slots) {
        const pick = picks.get(slot.key);
        if (!pick) continue;
        ingredients.push({
          name: pick.name,
          quantity: slot.spec.quantity,
          unit: slot.spec.unit,
        });
      }
      return {
        name: template.name(proteinName, picks),
        protein: proteinName,
        proteinInStock: proteinStock != null && proteinStock > 0,
        proteinStock,
        mealType: args.mealType,
        servings: args.servings,
        ingredients,
        steps: template.steps(proteinName, picks),
        note:
          proteinStock == null
            ? `${proteinName} isn't on the HIT List yet, so its stock is unknown.`
            : proteinStock <= 0
              ? `${proteinName} is out of stock right now — this recipe is one to make after a shop.`
              : null,
        source: webEntry
          ? {
              dishName: webEntry.dishName,
              site: webEntry.site,
              url: webEntry.url,
            }
          : null,
        webStatus,
        webLoadId,
        webRecipe,
      };
    },
  }),

  getWebRecipeLoad: defineAction({
    description:
      "Returns the state of a web recipe page load started by generateRecipe: pending while the background read is in flight, failed (the page couldn't be read — the generator's inventory-built recipe is the fallback), or done with the parsed recipe (dish title, the servings the page states, ingredients at those servings, and the method as ordered steps).",
    request: z.object({ loadId: z.number().int().positive() }),
    response: z.object({
      status: z.enum(["pending", "done", "failed", "none"]),
      recipe: z
        .object({
          name: z.string(),
          servings: z.number().nullable(),
          ingredients: z.array(recipeIngredientOut),
          steps: z.array(z.string()),
        })
        .nullable(),
      note: z.string().nullable(),
    }),
    handler: async (
      ctx,
      args,
    ): Promise<{
      status: "pending" | "done" | "failed" | "none";
      recipe: RecipeOut["webRecipe"];
      note: string | null;
    }> => {
      const db = ctx.db<typeof schema>();
      const rows = await db
        .select()
        .from(schema.webRecipeLoads)
        .where(eq(schema.webRecipeLoads.id, args.loadId));
      const row = rows[0];
      if (!row) return { status: "none", recipe: null, note: null };
      // A load task that never reported back leaves the row
      // pending forever and the generator card polling it. Past
      // the stuck threshold, fail it in place: the card keeps its
      // inventory-built fallback, and generateRecipe retries the
      // load once the failed row is a day old, like any failure.
      if (row.status === "pending" && isStuckPending(row.createdAt)) {
        const note =
          "The recipe page read didn't come back — it may have been interrupted.";
        await db
          .update(schema.webRecipeLoads)
          .set({ status: "failed", note, resolvedAt: new Date() })
          .where(eq(schema.webRecipeLoads.id, row.id));
        return { status: "failed", recipe: null, note };
      }
      if (row.status === "done") {
        const recipe = parseWebRecipeLoad(row);
        return {
          status: recipe ? "done" : "failed",
          recipe,
          note: row.note,
        };
      }
      return {
        status: row.status === "failed" ? "failed" : "pending",
        recipe: null,
        note: row.note,
      };
    },
  }),

  saveWebRecipeLoad: defineAction({
    description:
      "Saves the recipe read from a curated web recipe page by the generator's background load task. Called by that task only. Ingredients must be exactly as the page states them, at the servings the page states — scaling to the household's headcount happens in the app, never here.",
    request: z.object({
      loadId: z.number().int().positive(),
      ok: z.boolean(),
      title: z.string().trim().min(1).max(200).nullable().default(null),
      servings: z.number().int().min(1).max(100).nullable().default(null),
      ingredients: z
        .array(
          z.object({
            name: z.string().min(1).max(160),
            quantity: z.number().positive().max(100000).nullable(),
            unit: z.string().max(40).nullable(),
          }),
        )
        .max(80),
      steps: z.array(z.string().min(1).max(1500)).max(40),
      note: z.string().max(300).nullable().default(null),
    }),
    response: z.object({ saved: z.boolean() }),
    handler: async (ctx, args): Promise<{ saved: boolean }> => {
      const db = ctx.db<typeof schema>();
      const rows = await db
        .select()
        .from(schema.webRecipeLoads)
        .where(eq(schema.webRecipeLoads.id, args.loadId));
      if (!rows[0]) return { saved: false };
      const usable =
        args.ok &&
        args.title != null &&
        args.ingredients.length > 0 &&
        args.steps.length > 0;
      await db
        .update(schema.webRecipeLoads)
        .set({
          status: usable ? "done" : "failed",
          title: usable ? args.title : null,
          servings: usable ? args.servings : null,
          ingredientsJson: usable ? JSON.stringify(args.ingredients) : null,
          stepsJson: usable ? JSON.stringify(args.steps) : null,
          note: args.note,
          resolvedAt: new Date(),
        })
        .where(eq(schema.webRecipeLoads.id, args.loadId));
      ctx.invalidateQueries();
      return { saved: true };
    },
  }),

  // ---- Meal Planner tab ----------------------------------------------
  // Ported from the standalone Meal Planner app: same actions and
  // semantics, except protein stock is looked up from this app's HIT
  // List cache (hit_items) instead of a separate inventory table.

  getPlanner: defineAction({
    description:
      "Returns the meal ideas (each tagged breakfast, lunch, dinner, or snack) with per-protein stock status (from the HIT List cache), all picks by date (up to 5 per day, each with its meal type), tracked protein inventory, shopping flags, and undismissed same-meal matches.",
    request: z.object({}),
    response: plannerResponse,
    handler: async (ctx): Promise<PlannerResponse> => loadPlanner(ctx),
  }),

  setPick: defineAction({
    description:
      "Adds or updates one meal pick for a calendar date. A pick is addressed by pickId when updating an existing one; without pickId a new pick is added, as long as the day still has fewer than 5 picks (any mix of meal types — several picks may share a type). mealType says which meal of the day it is (breakfast, lunch, dinner, snack) and must match the meal idea's own type. Optionally carries the chosen protein option, how many people it cooks for (servings defaults to the existing pick's, or 2), and a style variant for meals that have one (variant null clears it; omitting it on an update keeps the existing pick's). A same-meal match (the heart popup) is recorded ONLY when a new pick is created for a date + meal type where a pick of the same meal already exists from a separate save — never for in-place edits of an existing pick. Picking never changes inventory.",
    request: z.object({
      date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
      mealType: mealTypeEnum,
      mealId: z.number().int().positive(),
      pickId: z.number().int().positive().nullable().default(null),
      proteinId: z.number().int().positive().nullable().default(null),
      servings: z.number().int().min(1).max(12).optional(),
      variant: z.string().min(1).max(60).nullable().optional(),
    }),
    response: okResponse,
    handler: async (ctx, args): Promise<z.infer<typeof okResponse>> => {
      const db = ctx.db<typeof schema>();
      const meal = await db
        .select()
        .from(schema.meals)
        .where(eq(schema.meals.id, args.mealId));
      if (!meal[0]) throw new Error("That meal idea no longer exists.");
      if (meal[0].mealType !== args.mealType) {
        throw new Error("That meal idea belongs to a different meal type.");
      }
      if (args.proteinId != null) {
        const protein = await db
          .select()
          .from(schema.mealProteins)
          .where(eq(schema.mealProteins.id, args.proteinId));
        if (!protein[0] || protein[0].mealId !== args.mealId) {
          throw new Error("That protein is not an option for this meal.");
        }
      }
      const dayPicks = await db
        .select()
        .from(schema.picks)
        .where(eq(schema.picks.date, args.date));
      const prev =
        args.pickId != null
          ? dayPicks.find((p) => p.id === args.pickId)
          : undefined;
      if (args.pickId != null && !prev) {
        throw new Error("That pick no longer exists.");
      }
      if (prev) {
        const newServings = args.servings ?? prev.servings;
        const newVariant =
          args.variant !== undefined ? args.variant : prev.variant;
        const newType = args.mealType;
        const sameMeal = prev.mealId === args.mealId;
        if (!sameMeal || prev.mealType !== newType) {
          // The slot's meal changed (or the pick moved slots): any
          // match recorded for the old meal/slot no longer stands.
          await db
            .delete(schema.mealMatches)
            .where(
              and(
                eq(schema.mealMatches.date, args.date),
                eq(schema.mealMatches.mealType, prev.mealType),
              ),
            );
        }
        // In-place edits NEVER record a same-meal match: re-saving
        // a pick unchanged, changing only its protein, servings, or
        // style is one planner editing their own pick, not two
        // planners landing on the same meal. Matches are recorded
        // only in the create branch below.
        await db
          .update(schema.picks)
          .set({
            mealType: newType,
            mealId: args.mealId,
            proteinId: args.proteinId,
            servings: newServings,
            variant: newVariant,
            updatedAt: new Date(),
          })
          .where(eq(schema.picks.id, prev.id));
      } else {
        if (dayPicks.length >= MAX_PICKS_PER_DAY) {
          throw new Error(
            `That day already has ${MAX_PICKS_PER_DAY} meals picked — clear one first.`,
          );
        }
        // Same-meal match: a genuinely NEW pick is being created
        // for a date + meal type where a pick of the same meal
        // already exists from a separate save — the two planners
        // picked the same meal independently. Record it so the
        // heart popup can celebrate it, including on a later open.
        const twin = dayPicks.find(
          (p) => p.mealId === args.mealId && p.mealType === args.mealType,
        );
        if (twin) {
          const matchRows = await db
            .select()
            .from(schema.mealMatches)
            .where(
              and(
                eq(schema.mealMatches.date, args.date),
                eq(schema.mealMatches.mealType, args.mealType),
              ),
            );
          if (!matchRows[0]) {
            await db.insert(schema.mealMatches).values({
              date: args.date,
              mealType: args.mealType,
              mealId: args.mealId,
              mealName: meal[0].name,
            });
          }
        }
        await db.insert(schema.picks).values({
          date: args.date,
          mealType: args.mealType,
          mealId: args.mealId,
          proteinId: args.proteinId,
          servings: args.servings ?? 2,
          variant: args.variant ?? null,
        });
      }
      ctx.invalidateQueries();
      return { ok: true as const };
    },
  }),

  clearPick: defineAction({
    description:
      "Removes one meal pick (by its pick id) from its calendar date, along with any same-meal match recorded for that pick's meal type on that date.",
    request: z.object({
      pickId: z.number().int().positive(),
    }),
    response: okResponse,
    handler: async (ctx, args): Promise<z.infer<typeof okResponse>> => {
      const db = ctx.db<typeof schema>();
      const rows = await db
        .select()
        .from(schema.picks)
        .where(eq(schema.picks.id, args.pickId));
      const pick = rows[0];
      if (pick) {
        await db
          .delete(schema.picks)
          .where(eq(schema.picks.id, args.pickId));
        await db
          .delete(schema.mealMatches)
          .where(
            and(
              eq(schema.mealMatches.date, pick.date),
              eq(schema.mealMatches.mealType, pick.mealType),
            ),
          );
      }
      ctx.invalidateQueries();
      return { ok: true as const };
    },
  }),

  dismissMatch: defineAction({
    description:
      "Marks the same-meal match recorded for a date and meal type as seen, so its heart popup does not appear again.",
    request: z.object({
      date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
      mealType: mealTypeEnum,
    }),
    response: okResponse,
    handler: async (ctx, args): Promise<z.infer<typeof okResponse>> => {
      const db = ctx.db<typeof schema>();
      await db
        .update(schema.mealMatches)
        .set({ dismissed: 1 })
        .where(
          and(
            eq(schema.mealMatches.date, args.date),
            eq(schema.mealMatches.mealType, args.mealType),
          ),
        );
      ctx.invalidateQueries();
      return { ok: true as const };
    },
  }),

  updateMealNote: defineAction({
    description:
      "Saves the recipe / ingredients note for a meal idea; an empty note clears it.",
    request: z.object({
      mealId: z.number().int().positive(),
      note: z.string().max(4000),
    }),
    response: okResponse,
    handler: async (ctx, args): Promise<z.infer<typeof okResponse>> => {
      const db = ctx.db<typeof schema>();
      const trimmed = args.note.trim();
      await db
        .update(schema.meals)
        .set({ note: trimmed === "" ? null : trimmed })
        .where(eq(schema.meals.id, args.mealId));
      ctx.invalidateQueries();
      return { ok: true as const };
    },
  }),

  setMealIngredients: defineAction({
    description:
      "Replaces a meal's structured ingredient list. Quantities are for 2 people; the planner scales them by the pick's servings. A null quantity means no amount (e.g. 'to taste').",
    request: z.object({
      mealId: z.number().int().positive(),
      ingredients: z
        .array(
          z.object({
            name: z.string().min(1).max(120),
            quantity: z.number().positive().max(100000).nullable(),
            unit: z.string().max(40).nullable(),
          }),
        )
        .max(60),
    }),
    response: okResponse,
    handler: async (ctx, args): Promise<z.infer<typeof okResponse>> => {
      const db = ctx.db<typeof schema>();
      const meal = await db
        .select()
        .from(schema.meals)
        .where(eq(schema.meals.id, args.mealId));
      if (!meal[0]) throw new Error("That meal idea no longer exists.");
      await db
        .delete(schema.mealIngredients)
        .where(eq(schema.mealIngredients.mealId, args.mealId));
      for (const [sortOrder, ing] of args.ingredients.entries()) {
        await db.insert(schema.mealIngredients).values({
          mealId: args.mealId,
          name: ing.name.trim(),
          quantity: ing.quantity,
          unit: ing.unit?.trim() ? ing.unit.trim() : null,
          sortOrder,
        });
      }
      ctx.invalidateQueries();
      return { ok: true as const };
    },
  }),

  flagForShopping: defineAction({
    description:
      "Flags a protein (by its HIT List item name) as needed for shopping, e.g. because a meal that needs it is out of stock.",
    request: z.object({ sheetName: z.string().min(1).max(120) }),
    response: okResponse,
    handler: async (ctx, args): Promise<z.infer<typeof okResponse>> => {
      const db = ctx.db<typeof schema>();
      const existing = await db
        .select()
        .from(schema.shoppingFlags)
        .where(eq(schema.shoppingFlags.sheetName, args.sheetName));
      if (!existing[0]) {
        await db
          .insert(schema.shoppingFlags)
          .values({ sheetName: args.sheetName });
      }
      ctx.invalidateQueries();
      return { ok: true as const };
    },
  }),

  unflagForShopping: defineAction({
    description: "Removes a protein's shopping flag.",
    request: z.object({ sheetName: z.string().min(1).max(120) }),
    response: okResponse,
    handler: async (ctx, args): Promise<z.infer<typeof okResponse>> => {
      const db = ctx.db<typeof schema>();
      await db
        .delete(schema.shoppingFlags)
        .where(eq(schema.shoppingFlags.sheetName, args.sheetName));
      ctx.invalidateQueries();
      return { ok: true as const };
    },
  }),

  addMeal: defineAction({
    description:
      "Adds a new meal idea for one meal type (breakfast, lunch, dinner, or snack) with its protein option groups (options within a group are interchangeable; each group must have an in-stock option for the meal to be available).",
    request: z.object({
      name: z.string().min(1).max(120),
      mealType: mealTypeEnum,
      groups: z
        .array(
          z
            .array(
              z.object({
                label: z.string().min(1).max(80),
                sheetName: z.string().min(1).max(120),
              }),
            )
            .min(1)
            .max(6),
        )
        .min(1)
        .max(3),
    }),
    response: z.object({ id: z.number() }),
    handler: async (ctx, args) => {
      const db = ctx.db<typeof schema>();
      const existing = await db.select().from(schema.meals);
      const inserted = await db
        .insert(schema.meals)
        .values({
          name: args.name.trim(),
          mealType: args.mealType,
          sortOrder: existing.length,
        })
        .returning({ id: schema.meals.id });
      const meal = inserted[0];
      if (!meal) throw new Error("addMeal: insert returned no rows");
      for (const [groupIndex, group] of args.groups.entries()) {
        for (const [sortOrder, option] of group.entries()) {
          await db.insert(schema.mealProteins).values({
            mealId: meal.id,
            label: option.label.trim(),
            sheetName: option.sheetName.trim(),
            groupIndex,
            sortOrder,
          });
        }
      }
      ctx.invalidateQueries();
      return { id: meal.id };
    },
  }),

  deleteMeal: defineAction({
    description:
      "Deletes a meal idea, its protein options, ingredients, any picks that chose it, and its same-meal match records and stored web-recipe source, so no orphaned rows are left behind.",
    request: z.object({ mealId: z.number().int().positive() }),
    response: okResponse,
    handler: async (ctx, args): Promise<z.infer<typeof okResponse>> => {
      const db = ctx.db<typeof schema>();
      await db.delete(schema.picks).where(eq(schema.picks.mealId, args.mealId));
      await db
        .delete(schema.mealIngredients)
        .where(eq(schema.mealIngredients.mealId, args.mealId));
      await db
        .delete(schema.mealProteins)
        .where(eq(schema.mealProteins.mealId, args.mealId));
      await db
        .delete(schema.mealMatches)
        .where(eq(schema.mealMatches.mealId, args.mealId));
      await db
        .delete(schema.mealSources)
        .where(eq(schema.mealSources.mealId, args.mealId));
      await db.delete(schema.meals).where(eq(schema.meals.id, args.mealId));
      ctx.invalidateQueries();
      return { ok: true as const };
    },
  }),

  // ---- Receipt scans + alerts ---------------------------------------
  // Receipt-photo quick-restock scan: the user photographs a store
  // RECEIPT and the app reads it itself, automatically —
  // requestReceiptScan stores the photo in ctx.blobs, opens the
  // row "pending", and reads the photo in that same call
  // (readReceiptScanInline above: the vision model scans the image
  // for the PURCHASED line items, matches each to a HIT List item,
  // and writes the proposed restock list onto the scan, moving it
  // to "proposed"). The background reader task
  // (spawnReceiptScanRead, writing back via setReceiptScanResult)
  // remains only as the fallback for a photo whose only readable
  // content is a QR code linking to the digital receipt, or when
  // the in-app read itself fails. Scans still "pending" (sent
  // before in-app reading existed, or whose read never completed)
  // are picked up whenever the app shows them: the Receipt scans
  // area fetches the scan's stored photo and sends it to
  // readReceiptScanNow, which reads it in the app the same way
  // (readPendingReceiptScans remains the background-reader
  // fallback starter). The user reviews the proposal
  // in the app — quantities editable, lines removable — and ONLY
  // confirmReceiptScan records stock (pending adjustments, source
  // "receipt"). Dismissing records nothing. The intake is
  // QR-compatible: a photo of a printed receipt, a photo that
  // carries a QR code, and a photo that is only a QR code are all
  // accepted; when the app decoded a QR code from the photo its
  // value is stored on the scan (qrValue) so the reader can follow
  // it to the digital receipt. Alerts are a separate display-only
  // feed written by external jobs via addAlert.

  requestReceiptScan: defineAction({
    description:
      "Stores a photo of a store receipt the user took or uploaded via the Shopping List tab's 'Receipt scan' button, opens a receipt-scan request, and reads the photo automatically in this same call: the app's own reader scans the image for the purchased items, matches each to a HIT List item, and writes the proposed restock list onto the scan — so on success the response's status is usually 'proposed' and the review is ready immediately. The one case the in-app read can't cover (a photo whose only readable content is a QR code linking to the digital receipt) or an in-app read failure falls back to the background reader task, and the status stays 'pending' while it works. The photo may be a printed receipt, a receipt photo carrying a QR code, or a photo that is only a QR code linking to a digital receipt — all are accepted. The photo bytes go to blob storage; when the app decoded a QR code from the photo, its value is passed as qrValue and stored with the scan. This call records nothing into the inventory — the user reviews the proposal and confirms (or dismisses) it in the app. If neither read could be started, the response's ok is false and its error says so; the photo stays saved as a pending scan (its note carries the reason) that readPendingReceiptScans can pick up later.",
    request: z.object({
      image: z.object({
        // Base64 of the photo file (from fileToBase64 on the
        // client). Capped so a single request stays sane.
        dataBase64: z.string().min(1).max(20_000_000),
        mimeType: z.string().min(1).max(100),
      }),
      // A QR code the app decoded from the photo, when the
      // platform supports in-browser decoding; null otherwise (the
      // reader then attempts decoding from the photo itself).
      qrValue: z.string().max(4000).nullable().default(null),
    }),
    response: z.object({
      ok: z.boolean(),
      id: z.number().nullable(),
      // Where the scan stands when this call returns: "proposed"
      // when the in-app read already finished (the usual case),
      // "pending" while the fallback background reader works.
      status: z.enum(["pending", "proposed"]).nullable(),
      error: z.string().nullable(),
    }),
    handler: async (
      ctx,
      args,
    ): Promise<{
      ok: boolean;
      id: number | null;
      status: "pending" | "proposed" | null;
      error: string | null;
    }> => {
      const mime = args.image.mimeType.trim().toLowerCase();
      if (mime !== "image/jpeg" && mime !== "image/png") {
        return {
          ok: false,
          id: null,
          status: null,
          error: "That photo format isn't supported — use a JPEG or PNG.",
        };
      }
      let bytes: Uint8Array;
      try {
        bytes = base64ToBytes(args.image.dataBase64);
      } catch {
        return {
          ok: false,
          id: null,
          status: null,
          error: "That photo couldn't be read. Try again.",
        };
      }
      if (bytes.length === 0) {
        return {
          ok: false,
          id: null,
          status: null,
          error: "That photo was empty.",
        };
      }
      const qrValue = args.qrValue?.trim() ? args.qrValue.trim() : null;
      const db = ctx.db<typeof schema>();
      const inserted = await db
        .insert(schema.receiptScans)
        .values({ status: "pending", imageMimeType: mime, qrValue })
        .returning({ id: schema.receiptScans.id });
      const row = inserted[0];
      if (!row) throw new Error("requestReceiptScan: insert returned no rows");
      const key = `receipt-scans/${row.id}`;
      await ctx.blobs.put(key, bytes, { contentType: mime });
      await db
        .update(schema.receiptScans)
        .set({ imageBlobKey: key, updatedAt: new Date() })
        .where(eq(schema.receiptScans.id, row.id));
      // Read it automatically, right away, in this call — the
      // app's own reader scans the photo for the purchased items,
      // so the proposal is ready when the send returns. Only the
      // case the in-app read can't cover (a QR-link-only photo) or
      // an in-app read failure falls back to the background reader
      // task; the scan then stays "pending" while that works.
      let status: "pending" | "proposed" = "pending";
      try {
        const read = await readReceiptScanInline(
          ctx,
          { id: row.id, qrValue },
          { dataBase64: args.image.dataBase64, mimeType: mime },
        );
        if (read.done) status = "proposed";
      } catch {
        // The in-app read failed — the background reader below is
        // the fallback, so the scan is still read automatically.
      }
      if (status === "pending") {
        const read = await spawnReceiptScanRead(ctx, {
          id: row.id,
          qrValue,
        });
        ctx.invalidateQueries();
        if (!read.ok) {
          return {
            ok: false,
            id: row.id,
            status,
            error:
              "Your receipt photo was saved, but automatic reading couldn't be started. It's listed below — it will be picked up for reading, or you can dismiss it and send the photo again.",
          };
        }
      }
      ctx.invalidateQueries();
      return { ok: true, id: row.id, status, error: null };
    },
  }),

  readPendingReceiptScans: defineAction({
    description:
      "Starts the background reader for every receipt scan still waiting to be read (status 'pending') — the fallback pickup, used when the app couldn't fetch a waiting scan's stored photo to read it in the app itself (readReceiptScanNow is the primary pickup: the Shopping List tab fetches the photo and sends it there to be read in the call). Each scan gets the background reader task (dedupe-keyed per scan, so calling this again while a read is already running starts nothing new). Returns how many scans are waiting and how many background reads this call started.",
    request: z.object({}),
    response: z.object({
      waiting: z.number(),
      started: z.number(),
    }),
    handler: async (
      ctx,
    ): Promise<{ waiting: number; started: number }> => {
      const db = ctx.db<typeof schema>();
      const rows = await db
        .select()
        .from(schema.receiptScans)
        .where(eq(schema.receiptScans.status, "pending"))
        .orderBy(asc(schema.receiptScans.id));
      let started = 0;
      for (const row of rows) {
        const read = await spawnReceiptScanRead(ctx, {
          id: row.id,
          qrValue: row.qrValue,
        });
        if (read.ok) started += 1;
      }
      if (started > 0) ctx.invalidateQueries();
      return { waiting: rows.length, started };
    },
  }),

  readReceiptScanNow: defineAction({
    description:
      "Reads one waiting receipt scan (status 'pending') in the app, now: the Shopping List tab fetches the scan's stored photo (via the URL getPendingReceiptScans returns for it) and sends the photo here; this call scans the image for the purchased items with the app's own reader, matches them to HIT List items, and writes the proposal onto the scan — the same read requestReceiptScan runs on a fresh send, for scans sent before in-app reading existed or whose read never finished. The sent photo is checked against the stored photo's size before anything is read, so a scan is only ever read from its own photo. A scan that isn't pending anymore is answered with its current status and nothing is read. The one case the in-app read can't cover (a photo whose only readable content is a QR code linking to the digital receipt) or an in-app read failure falls back to the background reader task, and the status stays 'pending' while it works. Records NO stock — only the user's in-app Confirm does that.",
    request: z.object({
      id: z.number().int().positive(),
      image: z.object({
        dataBase64: z.string().min(1).max(20_000_000),
        mimeType: z.string().min(1).max(100),
      }),
    }),
    response: z.object({
      ok: z.boolean(),
      status: z
        .enum(["pending", "proposed", "confirmed", "dismissed"])
        .nullable(),
      error: z.string().nullable(),
    }),
    handler: async (
      ctx,
      args,
    ): Promise<{
      ok: boolean;
      status: "pending" | "proposed" | "confirmed" | "dismissed" | null;
      error: string | null;
    }> => {
      const db = ctx.db<typeof schema>();
      const rows = await db
        .select()
        .from(schema.receiptScans)
        .where(eq(schema.receiptScans.id, args.id));
      const row = rows[0];
      if (!row) {
        return {
          ok: false,
          status: null,
          error: "That receipt scan no longer exists.",
        };
      }
      if (row.status !== "pending") {
        return { ok: true, status: row.status, error: null };
      }
      const mime = args.image.mimeType.trim().toLowerCase();
      if (mime !== "image/jpeg" && mime !== "image/png") {
        return {
          ok: false,
          status: row.status,
          error: "That photo format isn't supported — use a JPEG or PNG.",
        };
      }
      let bytes: Uint8Array;
      try {
        bytes = base64ToBytes(args.image.dataBase64);
      } catch {
        return {
          ok: false,
          status: row.status,
          error: "That photo couldn't be read. Try again.",
        };
      }
      if (bytes.length === 0) {
        return { ok: false, status: row.status, error: "That photo was empty." };
      }
      // The photo sent must be the scan's own stored photo (the
      // tab fetched it from the scan's blob URL) — check its size
      // against the stored blob before reading anything from it.
      if (row.imageBlobKey) {
        const head = await ctx.blobs.head(row.imageBlobKey);
        if (head && head.sizeBytes !== bytes.length) {
          return {
            ok: false,
            status: row.status,
            error: "That photo doesn't match this scan's stored photo.",
          };
        }
      }
      let status: "pending" | "proposed" = "pending";
      try {
        const read = await readReceiptScanInline(
          ctx,
          { id: row.id, qrValue: row.qrValue },
          { dataBase64: args.image.dataBase64, mimeType: mime },
        );
        if (read.done) status = "proposed";
      } catch {
        // The in-app read failed — the background reader below is
        // the fallback, so the scan is still read automatically.
      }
      if (status === "pending") {
        const read = await spawnReceiptScanRead(ctx, {
          id: row.id,
          qrValue: row.qrValue,
        });
        ctx.invalidateQueries();
        if (!read.ok) {
          return {
            ok: false,
            status,
            error:
              "Automatic reading couldn't be started for this scan. It stays listed below — or you can dismiss it and send the photo again.",
          };
        }
      }
      ctx.invalidateQueries();
      return { ok: true, status, error: null };
    },
  }),

  getReceiptScans: defineAction({
    description:
      "Lists receipt-scan requests for the Shopping List tab's 'Receipt scans' area, newest first: each scan's status ('pending' while its automatic read runs, 'proposed' awaiting the user's review, 'confirmed', 'dismissed'), when it was sent, its proposed lines (the line as printed on the receipt, matched HIT List item or null when unmatched, quantity purchased, and the line's price in dollars when the read captured one), the receipt's grand total in dollars when the read captured one (null otherwise — scans read before totals were captured have none until re-read), a URL for the scan's stored receipt photo (so the tab can send the photo back for a re-read), any note from the reader, and the QR code value decoded from the photo (null when none was found). Confirmed scans also report how many lines / units were recorded into the inventory.",
    request: z.object({}),
    response: z.object({
      scans: z.array(
        z.object({
          id: z.number(),
          status: z.enum(["pending", "proposed", "confirmed", "dismissed"]),
          createdAt: z.string(),
          qrValue: z.string().nullable(),
          lines: z.array(
            z.object({
              receiptText: z.string(),
              item: z.string().nullable(),
              quantity: z.number(),
              price: z.number().nullable(),
            }),
          ),
          total: z.number().nullable(),
          imageUrl: z.string().nullable(),
          note: z.string().nullable(),
          confirmedUnits: z.number().nullable(),
          // True once a confirmed scan's stock additions have
          // been undone from the scan's own record (audit #5).
          undone: z.boolean(),
          // Attribution + policy (audit #5, Primary vs
          // Connected) for the scan's confirmation.
          ...undoMetaShape.shape,
        }),
      ),
    }),
    handler: async (ctx) => {
      const db = ctx.db<typeof schema>();
      const settings = await loadAccountSettings(ctx);
      const rows = await db
        .select()
        .from(schema.receiptScans)
        .orderBy(desc(schema.receiptScans.id))
        .limit(12);
      const parseLines = (
        json: string | null,
      ): {
        receiptText: string;
        item: string | null;
        quantity: number;
        price: number | null;
      }[] => {
        if (!json) return [];
        try {
          const parsed: unknown = JSON.parse(json);
          if (!Array.isArray(parsed)) return [];
          return parsed
            .filter(
              (l): l is Record<string, unknown> =>
                typeof l === "object" && l !== null,
            )
            .map((l) => ({
              receiptText:
                typeof l.receiptText === "string" ? l.receiptText : "",
              item: typeof l.item === "string" ? l.item : null,
              quantity:
                typeof l.quantity === "number" &&
                Number.isFinite(l.quantity)
                  ? Math.max(0, Math.round(l.quantity))
                  : 0,
              price:
                typeof l.price === "number" &&
                Number.isFinite(l.price) &&
                l.price >= 0
                  ? Math.round(l.price * 100) / 100
                  : null,
            }));
        } catch {
          return [];
        }
      };
      const scans: {
        id: number;
        status: "pending" | "proposed" | "confirmed" | "dismissed";
        createdAt: string;
        qrValue: string | null;
        lines: ReturnType<typeof parseLines>;
        total: number | null;
        imageUrl: string | null;
        note: string | null;
        confirmedUnits: number | null;
        undone: boolean;
        actor: "primary" | "connected";
        permanent: boolean;
        canUndo: boolean;
      }[] = [];
      for (const r of rows) {
        const lines = parseLines(r.linesJson);
        const matched = lines.filter((l) => l.item != null);
        scans.push({
          id: r.id,
          status: r.status,
          createdAt: r.createdAt.toISOString(),
          qrValue: r.qrValue,
          lines,
          total: r.total ?? null,
          imageUrl: r.imageBlobKey
            ? await ctx.blobs.getUrl(r.imageBlobKey)
            : null,
          note: r.note,
          confirmedUnits:
            r.status === "confirmed"
              ? matched.reduce((sum, l) => sum + l.quantity, 0)
              : null,
          undone: r.undoneAt != null,
          ...undoMeta(
            settings,
            "receiptScans",
            r.actor,
            r.undoneAt != null,
          ),
        });
      }
      return { scans };
    },
  }),

  getPendingReceiptScans: defineAction({
    description:
      "Lists the receipt-scan requests still waiting to be read (status 'pending'), oldest first, each with a URL for its stored receipt photo and the QR code value decoded from the photo when one was found (qrValue, null otherwise), so Muse can fetch the photo, extract the PURCHASED line items with the quantities bought, each line's price and the receipt's grand total, match each to a HIT List item (exact item names from getHitList), and write the proposal back with setReceiptScanResult. When the photo carries a QR code — or is only a QR code — and qrValue is set, follow it to the digital receipt and read the purchased items from there; when qrValue is null, attempt QR decoding from the photo itself before falling back to reading the printed receipt.",
    request: z.object({}),
    response: z.object({
      pending: z.array(
        z.object({
          id: z.number(),
          createdAt: z.string(),
          imageMimeType: z.string().nullable(),
          imageUrl: z.string().nullable(),
          qrValue: z.string().nullable(),
        }),
      ),
    }),
    handler: async (ctx) => {
      const db = ctx.db<typeof schema>();
      const rows = await db
        .select()
        .from(schema.receiptScans)
        .orderBy(asc(schema.receiptScans.id));
      const pending = rows.filter((r) => r.status === "pending");
      const out: {
        id: number;
        createdAt: string;
        imageMimeType: string | null;
        imageUrl: string | null;
        qrValue: string | null;
      }[] = [];
      for (const r of pending) {
        out.push({
          id: r.id,
          createdAt: r.createdAt.toISOString(),
          imageMimeType: r.imageMimeType,
          imageUrl: r.imageBlobKey
            ? await ctx.blobs.getUrl(r.imageBlobKey)
            : null,
          qrValue: r.qrValue,
        });
      }
      return { pending: out };
    },
  }),

  setReceiptScanResult: defineAction({
    description:
      "Writes the proposed restock list for a pending receipt scan (called by Muse after reading the receipt photo, or the digital receipt a QR code in the photo links to): one line per item PURCHASED on the receipt — the line's text as printed on the receipt, the matched HIT List item name (exact spelling from getHitList) or null when the purchased item matched nothing, the quantity purchased, and the line's price in dollars when one was read — plus the receipt's grand total in dollars when legible, and an optional note. Matched names that aren't on the HIT List are dropped to unmatched rather than trusted. Moves the scan to status 'proposed' for the user to review in the app; records NO stock — only the user's in-app Confirm does that.",
    request: z.object({
      id: z.number().int().positive(),
      lines: z
        .array(
          z.object({
            receiptText: z.string().min(1).max(300),
            item: z.string().max(120).nullable().default(null),
            quantity: z.number().int().min(0).max(999),
            price: z.number().min(0).max(1_000_000).nullable().default(null),
          }),
        )
        .max(80),
      total: z.number().min(0).max(1_000_000).nullable().default(null),
      note: z.string().max(300).nullable().default(null),
    }),
    response: z.object({
      ok: z.boolean(),
      error: z.string().nullable(),
    }),
    handler: async (
      ctx,
      args,
    ): Promise<{ ok: boolean; error: string | null }> => {
      const db = ctx.db<typeof schema>();
      const rows = await db
        .select()
        .from(schema.receiptScans)
        .where(eq(schema.receiptScans.id, args.id));
      const row = rows[0];
      if (!row) {
        return { ok: false, error: "That receipt scan no longer exists." };
      }
      if (row.status !== "pending") {
        return {
          ok: false,
          error: "That receipt scan already has a result.",
        };
      }
      // Canonical HIT List names (sheet rows + app-added items) —
      // a proposed match is only kept when it names a real item.
      const [hitRows, addedRows] = await Promise.all([
        db.select().from(schema.hitItems),
        db.select().from(schema.hitAddedItems),
      ]);
      const canonical = new Map<string, string>();
      for (const r of hitRows) {
        canonical.set(r.item.trim().toLowerCase(), r.item);
      }
      for (const r of addedRows) {
        const key = r.item.trim().toLowerCase();
        if (!canonical.has(key)) canonical.set(key, r.item);
      }
      const lines = args.lines.map((l) => ({
        receiptText: l.receiptText,
        item:
          l.item != null
            ? (canonical.get(l.item.trim().toLowerCase()) ?? null)
            : null,
        quantity: l.quantity,
        price: receiptMoney(l.price),
      }));
      await db
        .update(schema.receiptScans)
        .set({
          status: "proposed",
          linesJson: JSON.stringify(lines),
          total: receiptMoney(args.total),
          note: args.note,
          updatedAt: new Date(),
        })
        .where(eq(schema.receiptScans.id, args.id));
      ctx.invalidateQueries();
      return { ok: true, error: null };
    },
  }),

  confirmReceiptScan: defineAction({
    description:
      "Confirms a reviewed receipt-scan proposal (the in-app Confirm — the two-factor step): records ONE pending stock adjustment per confirmed line for its HIT List item (source 'receipt', applied to the sheet later by the auto-scan) and marks the scan 'confirmed', storing the confirmed lines on it — plus the proposal's unmatched lines (item null), kept as leftovers so they stay listed beside the confirmed scan with their Add button. Only a scan in status 'proposed' can be confirmed, every line's item must be on the HIT List and its quantity 1–999 — if any line fails, nothing is recorded. Lines the user removed in review are simply not sent, so they record nothing.",
    request: z.object({
      id: z.number().int().positive(),
      lines: z
        .array(
          z.object({
            item: z.string().min(1).max(120),
            quantity: z.number().int().min(1).max(999),
          }),
        )
        .min(1)
        .max(80),
    }),
    response: z.object({
      ok: z.boolean(),
      recorded: z.number(),
      error: z.string().nullable(),
    }),
    handler: async (
      ctx,
      args,
    ): Promise<{ ok: boolean; recorded: number; error: string | null }> => {
      const db = ctx.db<typeof schema>();
      const rows = await db
        .select()
        .from(schema.receiptScans)
        .where(eq(schema.receiptScans.id, args.id));
      const row = rows[0];
      if (!row) {
        return {
          ok: false,
          recorded: 0,
          error: "That receipt scan no longer exists.",
        };
      }
      if (row.status !== "proposed") {
        return {
          ok: false,
          recorded: 0,
          error: "That receipt scan isn't waiting for review.",
        };
      }
      const [hitRows, addedRows] = await Promise.all([
        db.select().from(schema.hitItems),
        db.select().from(schema.hitAddedItems),
      ]);
      const canonical = new Map<string, string>();
      for (const r of hitRows) {
        canonical.set(r.item.trim().toLowerCase(), r.item);
      }
      for (const r of addedRows) {
        const key = r.item.trim().toLowerCase();
        if (!canonical.has(key)) canonical.set(key, r.item);
      }
      // Validate EVERY line first — a confirm records all of its
      // lines or none of them.
      const resolved: { item: string; quantity: number }[] = [];
      for (const l of args.lines) {
        const name = canonical.get(l.item.trim().toLowerCase());
        if (!name) {
          return {
            ok: false,
            recorded: 0,
            error: `“${l.item}” isn't on the HIT List, so nothing was recorded.`,
          };
        }
        resolved.push({ item: name, quantity: l.quantity });
      }
      // Keep the confirmed lines alongside their receipt text where
      // the proposal had one, so the scan's history stays readable.
      let proposedLines: {
        receiptText: string;
        item: string | null;
        quantity: number;
        price?: number | null;
      }[] = [];
      if (row.linesJson) {
        try {
          const parsed: unknown = JSON.parse(row.linesJson);
          if (Array.isArray(parsed)) {
            proposedLines = parsed as typeof proposedLines;
          }
        } catch {
          proposedLines = [];
        }
      }
      const confirmedLines = resolved.map((l) => {
        const proposed = proposedLines.find(
          (p) =>
            p.item != null &&
            p.item.trim().toLowerCase() === l.item.trim().toLowerCase(),
        );
        return {
          receiptText: proposed?.receiptText ?? l.item,
          item: l.item,
          quantity: l.quantity,
          price: receiptMoney(proposed?.price),
        };
      });
      // The proposal's unmatched lines ride along as leftovers:
      // the recognized items are now logged into the inventory,
      // and the lines that matched nothing stay on the confirmed
      // scan so the user can still add them to the HIT List from
      // its history entry. They record nothing — undo skips
      // item-null lines and the confirmed-units count sums only
      // matched lines.
      const leftoverLines = proposedLines
        .filter((p) => p.item == null)
        .map((p) => ({
          receiptText: p.receiptText,
          item: null,
          quantity: p.quantity,
          price: receiptMoney(p.price),
        }));
      const storedLines = [...confirmedLines, ...leftoverLines];
      const { role } = await loadAccountSettings(ctx);
      const statements: BatchItem<"sqlite">[] = resolved.map((l) =>
        db.insert(schema.stockAdjustments).values({
          item: l.item,
          delta: l.quantity,
          source: "receipt",
          // Link each adjustment to this scan so the scan's own
          // Undo (undoReceiptScan) reverses exactly these rows.
          receiptScanId: args.id,
          actor: role,
        }),
      );
      statements.push(
        db
          .update(schema.receiptScans)
          .set({
            status: "confirmed",
            linesJson: JSON.stringify(storedLines),
            updatedAt: new Date(),
            // Attribution (audit #5): the confirming role is the
            // scan's actor — its Undo follows it.
            actor: role,
          })
          .where(eq(schema.receiptScans.id, args.id)),
      );
      const [first, ...rest] = statements;
      if (first) await db.batch([first, ...rest]);
      ctx.invalidateQueries();
      return { ok: true, recorded: resolved.length, error: null };
    },
  }),

  undoReceiptScan: defineAction({
    description:
      "Undoes a confirmed receipt scan from the scan's own record (Beta 0.01 batch, audit #5): reverses exactly the stock additions its confirmation recorded and stamps the scan undone (its status stays 'confirmed' — the scan was confirmed; its effect is what is reversed). Adjustments linked to the scan are marked undone — a still-pending one simply stops counting, one already applied to the sheet gets a compensating pending adjustment (source 'receipt-undo'). Scans confirmed before adjustments carried the link fall back to their confirmed lines: a matching still-pending receipt adjustment is retired per line, otherwise a compensating adjustment is recorded. Only a confirmed, not-yet-undone scan can be undone.",
    request: z.object({ id: z.number().int().positive() }),
    response: z.object({
      ok: z.boolean(),
      error: z.string().nullable(),
    }),
    handler: async (ctx, args) =>
      await performUndoReceiptScan(ctx, args.id),
  }),

  dismissReceiptScan: defineAction({
    description:
      "Dismisses a receipt scan that is still pending or proposed: marks it 'dismissed' and records nothing into the inventory. A confirmed scan can't be dismissed (its stock was already recorded — undoReceiptScan on the scan's own record reverses it).",
    request: z.object({ id: z.number().int().positive() }),
    response: z.object({
      ok: z.boolean(),
      error: z.string().nullable(),
    }),
    handler: async (
      ctx,
      args,
    ): Promise<{ ok: boolean; error: string | null }> => {
      const db = ctx.db<typeof schema>();
      const rows = await db
        .select()
        .from(schema.receiptScans)
        .where(eq(schema.receiptScans.id, args.id));
      const row = rows[0];
      if (!row) {
        return { ok: false, error: "That receipt scan no longer exists." };
      }
      if (row.status === "confirmed") {
        return {
          ok: false,
          error: "That scan was already confirmed into the inventory.",
        };
      }
      if (row.status === "dismissed") {
        return { ok: true, error: null };
      }
      await db
        .update(schema.receiptScans)
        .set({ status: "dismissed", updatedAt: new Date() })
        .where(eq(schema.receiptScans.id, args.id));
      ctx.invalidateQueries();
      return { ok: true, error: null };
    },
  }),

  restoreReceiptScan: defineAction({
    description:
      "Restores a receipt scan the user removed by accident (Beta 0.13): a DISMISSED scan goes back to review ('proposed' when it has read lines, 'pending' when it was dismissed before its read finished — the tab's automatic pickup then reads it), and a CONFIRMED scan whose confirmation was undone gets its stock additions back — the exact inverse of undoReceiptScan: adjustments the undo retired before they were applied count again, and for ones already applied (where the undo recorded a compensating 'receipt-undo' adjustment) a fresh linked 'receipt' adjustment re-adds the quantity; scans confirmed before adjustments carried the link are re-recorded from their confirmed lines. The scan's undone stamp is cleared either way. A scan that isn't dismissed or undone is answered with an error and nothing changes.",
    request: z.object({ id: z.number().int().positive() }),
    response: z.object({
      ok: z.boolean(),
      error: z.string().nullable(),
    }),
    handler: async (
      ctx,
      args,
    ): Promise<{ ok: boolean; error: string | null }> => {
      const error = await performReceiptScanRestore(ctx, args.id);
      return error == null
        ? { ok: true, error: null }
        : { ok: false, error };
    },
  }),

  rereadReceiptScan: defineAction({
    description:
      "Re-reads a receipt scan's stored photo to fill in what its original read didn't capture: the receipt's grand total and each line's price (reads before Beta 0.13 captured items and quantities only, so no total was ever stored for them and none could be shown). The Shopping List tab fetches the scan's stored photo (via the URL getReceiptScans returns for it) and sends it here; the sent photo is size-checked against the stored photo before anything is read, so a scan is only ever re-read from its own photo. The fresh read's prices are merged onto the scan's stored lines by receipt text and its total onto the scan — items, quantities, matches, status and recorded stock are never touched. A scan still waiting for its first read is answered as-is (its own read path owns it). Returns the total now on the scan — null when the photo's total still couldn't be read.",
    request: z.object({
      id: z.number().int().positive(),
      image: z.object({
        dataBase64: z.string().min(1).max(20_000_000),
        mimeType: z.string().min(1).max(100),
      }),
    }),
    response: z.object({
      ok: z.boolean(),
      total: z.number().nullable(),
      error: z.string().nullable(),
    }),
    handler: async (
      ctx,
      args,
    ): Promise<{ ok: boolean; total: number | null; error: string | null }> => {
      const db = ctx.db<typeof schema>();
      const rows = await db
        .select()
        .from(schema.receiptScans)
        .where(eq(schema.receiptScans.id, args.id));
      const row = rows[0];
      if (!row) {
        return {
          ok: false,
          total: null,
          error: "That receipt scan no longer exists.",
        };
      }
      if (row.status === "pending") {
        return { ok: true, total: row.total ?? null, error: null };
      }
      const mime = args.image.mimeType.trim().toLowerCase();
      if (mime !== "image/jpeg" && mime !== "image/png") {
        return {
          ok: false,
          total: row.total ?? null,
          error: "That photo format isn't supported — use a JPEG or PNG.",
        };
      }
      let bytes: Uint8Array;
      try {
        bytes = base64ToBytes(args.image.dataBase64);
      } catch {
        return {
          ok: false,
          total: row.total ?? null,
          error: "That photo couldn't be read. Try again.",
        };
      }
      if (bytes.length === 0) {
        return {
          ok: false,
          total: row.total ?? null,
          error: "That photo was empty.",
        };
      }
      // The photo sent must be the scan's own stored photo (the
      // tab fetched it from the scan's blob URL) — check its size
      // against the stored blob before reading anything from it.
      if (row.imageBlobKey) {
        const head = await ctx.blobs.head(row.imageBlobKey);
        if (head && head.sizeBytes !== bytes.length) {
          return {
            ok: false,
            total: row.total ?? null,
            error: "That photo doesn't match this scan's stored photo.",
          };
        }
      }
      let fresh: { lines: ReceiptPhotoLine[]; total: number | null };
      try {
        fresh = await extractReceiptPhoto(
          ctx,
          { id: row.id, qrValue: row.qrValue },
          { dataBase64: args.image.dataBase64, mimeType: mime },
        );
      } catch {
        return {
          ok: false,
          total: row.total ?? null,
          error: "The re-read didn't finish. Try again in a moment.",
        };
      }
      // Merge only what the original read couldn't capture: a
      // price for each stored line whose receipt text the fresh
      // read priced, and the total. Stored items, quantities and
      // matches stay exactly as they are (mergeReceiptReread).
      const total = await mergeReceiptReread(ctx, row, fresh.lines, fresh.total);
      return { ok: true, total, error: null };
    },
  }),

  setReceiptScanTotal: defineAction({
    description:
      "Writes back a totals re-read for an existing receipt scan (called by Muse after re-reading the scan's stored photo during a recovery): the receipt's grand total in dollars and one entry per purchased line — its text as printed and the price charged — are merged onto the scan exactly the way rereadReceiptScan merges its in-app re-read: prices land on stored lines matched by receipt text, a total already on the scan is kept, and items, quantities, matches, status and recorded stock are never touched. A scan still waiting for its first read is refused (its own read path owns it — setReceiptScanResult is that write-back). Returns the total now on the scan.",
    request: z.object({
      id: z.number().int().positive(),
      total: z.number().nullable(),
      lines: z
        .array(
          z.object({
            receiptText: z.string().min(1).max(300),
            price: z.number().nullable(),
          }),
        )
        .max(80),
    }),
    response: z.object({
      ok: z.boolean(),
      total: z.number().nullable(),
      error: z.string().nullable(),
    }),
    handler: async (
      ctx,
      args,
    ): Promise<{ ok: boolean; total: number | null; error: string | null }> => {
      const db = ctx.db<typeof schema>();
      const rows = await db
        .select()
        .from(schema.receiptScans)
        .where(eq(schema.receiptScans.id, args.id));
      const row = rows[0];
      if (!row) {
        return {
          ok: false,
          total: null,
          error: "That receipt scan no longer exists.",
        };
      }
      if (row.status === "pending") {
        return {
          ok: false,
          total: row.total ?? null,
          error: "That scan is still waiting for its first read.",
        };
      }
      const total = await mergeReceiptReread(
        ctx,
        row,
        args.lines.map((l) => ({
          receiptText: l.receiptText,
          price: receiptMoney(l.price),
        })),
        args.total,
      );
      return { ok: true, total, error: null };
    },
  }),

  recoverReceiptScan: defineAction({
    description:
      "Recovers a receipt scan the user removed by accident, in one step (Beta 0.14 — the user's Metro receipt sat confirmed-but-undone with no total, and restoring it alone still left the total invisible): when the scan is dismissed or its confirmation was undone, it is restored exactly as restoreReceiptScan restores it (a dismissed scan returns to review; an undone confirmation gets its stock additions back); then, when the scan still has no grand total — its original read predates totals being captured, so none was ever stored even though the total is printed on the photo — a background reader is started to re-read the stored photo for the total and the line prices and write them back with setReceiptScanTotal (dedupe-keyed per scan). A scan still waiting for its first read is left to its own read path, which captures the total itself. Returns whether the scan was restored, the total now on it (null while the re-read runs), and whether that re-read started. Records no stock beyond what the restore itself reverses.",
    request: z.object({ id: z.number().int().positive() }),
    response: z.object({
      ok: z.boolean(),
      restored: z.boolean(),
      total: z.number().nullable(),
      rereadStarted: z.boolean(),
      error: z.string().nullable(),
    }),
    handler: async (
      ctx,
      args,
    ): Promise<{
      ok: boolean;
      restored: boolean;
      total: number | null;
      rereadStarted: boolean;
      error: string | null;
    }> => {
      const db = ctx.db<typeof schema>();
      const rows = await db
        .select()
        .from(schema.receiptScans)
        .where(eq(schema.receiptScans.id, args.id));
      let row = rows[0];
      if (!row) {
        return {
          ok: false,
          restored: false,
          total: null,
          rereadStarted: false,
          error: "That receipt scan no longer exists.",
        };
      }
      let restored = false;
      if (
        row.status === "dismissed" ||
        (row.status === "confirmed" && row.undoneAt != null)
      ) {
        const error = await performReceiptScanRestore(ctx, args.id);
        if (error != null) {
          return {
            ok: false,
            restored: false,
            total: row.total ?? null,
            rereadStarted: false,
            error,
          };
        }
        restored = true;
        const after = await db
          .select()
          .from(schema.receiptScans)
          .where(eq(schema.receiptScans.id, args.id));
        if (after[0]) row = after[0];
      }
      if (row.status === "pending") {
        // Its own read path owns it — and that read captures the
        // total itself, so no separate re-read is started.
        return {
          ok: true,
          restored,
          total: row.total ?? null,
          rereadStarted: false,
          error: null,
        };
      }
      if (row.total == null && row.imageBlobKey) {
        const started = await spawnReceiptTotalRead(ctx, { id: row.id });
        return {
          ok: true,
          restored,
          total: null,
          rereadStarted: started.ok,
          error: started.ok ? null : started.error,
        };
      }
      return {
        ok: true,
        restored,
        total: row.total ?? null,
        rereadStarted: false,
        error: null,
      };
    },
  }),

  addAlert: defineAction({
    description:
      "Adds one alert to the in-app alerts feed at the top of the Shopping List tab (written by Muse's external jobs, e.g. the grocery scans): kind 'sale' for a watched or low-stock item on sale, 'scan' for a scan summary, 'info' for anything else, with a short title, a body line, and optionally the item it concerns. Alerts are display only — they never change inventory. New alerts start unread; opening the alerts list in the app marks them read.",
    request: z.object({
      kind: z.enum(["sale", "scan", "info"]),
      title: z.string().trim().min(1).max(160),
      body: z.string().trim().min(1).max(600),
      item: z.string().trim().max(120).nullable().default(null),
    }),
    response: z.object({ id: z.number() }),
    handler: async (ctx, args): Promise<{ id: number }> => {
      const db = ctx.db<typeof schema>();
      const inserted = await db
        .insert(schema.alerts)
        .values({
          kind: args.kind,
          title: args.title,
          body: args.body,
          item: args.item,
        })
        .returning({ id: schema.alerts.id });
      const row = inserted[0];
      if (!row) throw new Error("addAlert: insert returned no rows");
      ctx.invalidateQueries();
      return { id: row.id };
    },
  }),

  getAlerts: defineAction({
    description:
      "Returns the in-app alerts feed for the strip at the top of the Shopping List tab: non-dismissed alerts newest first (up to 30) with kind, title, body, optional item, time, and read state, plus the unread count the strip shows, plus the recently dismissed alerts (up to 10, newest first) so a dismissal can be undone with restoreAlert. The banner count stays the non-dismissed list alone — dismissed alerts are listed separately and never counted. Reading this does NOT mark alerts read — the app calls markAlertsRead when the user opens the list.",
    request: z.object({}),
    response: z.object({
      unreadCount: z.number(),
      alerts: z.array(
        z.object({
          id: z.number(),
          kind: z.enum(["sale", "scan", "info"]),
          title: z.string(),
          body: z.string(),
          item: z.string().nullable(),
          read: z.boolean(),
          createdAt: z.string(),
        }),
      ),
      dismissed: z.array(
        z.object({
          id: z.number(),
          kind: z.enum(["sale", "scan", "info"]),
          title: z.string(),
          body: z.string(),
          item: z.string().nullable(),
          read: z.boolean(),
          createdAt: z.string(),
          // Attribution + policy (audit #5, Primary vs
          // Connected) for the dismissal: who dismissed it,
          // whether alert dismissals are set Permanent, and
          // whether the current role may restore it.
          ...undoMetaShape.shape,
        }),
      ),
    }),
    handler: async (ctx) => {
      const db = ctx.db<typeof schema>();
      const settings = await loadAccountSettings(ctx);
      const rows = await db
        .select()
        .from(schema.alerts)
        .orderBy(desc(schema.alerts.id))
        .limit(200);
      const visible = rows.filter((r) => r.dismissedAt == null);
      const dismissed = rows.filter((r) => r.dismissedAt != null);
      const toShape = (r: (typeof rows)[number]) => ({
        id: r.id,
        kind: r.kind,
        title: r.title,
        body: r.body,
        item: r.item,
        read: r.readAt != null,
        createdAt: r.createdAt.toISOString(),
      });
      return {
        unreadCount: visible.filter((r) => r.readAt == null).length,
        alerts: visible.slice(0, 30).map(toShape),
        dismissed: dismissed.slice(0, 10).map((r) => ({
          ...toShape(r),
          ...undoMeta(settings, "alertDismissals", r.dismissedBy, false),
        })),
      };
    },
  }),

  markAlertsRead: defineAction({
    description:
      "Marks every currently-unread, non-dismissed alert as read (the app calls this when the user opens the alerts list). Returns how many were marked. Alerts added afterwards still arrive unread.",
    request: z.object({}),
    response: z.object({ marked: z.number() }),
    handler: async (ctx): Promise<{ marked: number }> => {
      const db = ctx.db<typeof schema>();
      const res = await db
        .update(schema.alerts)
        .set({ readAt: new Date() })
        .where(
          and(isNull(schema.alerts.readAt), isNull(schema.alerts.dismissedAt)),
        )
        .returning({ id: schema.alerts.id });
      ctx.invalidateQueries();
      return { marked: res.length };
    },
  }),

  dismissAlert: defineAction({
    description:
      "Dismisses one alert from the in-app feed: it leaves the list and no longer counts as unread. Display only — dismissing never touches inventory. The dismissal is reversible: restoreAlert brings the alert back.",
    request: z.object({ id: z.number().int().positive() }),
    response: z.object({ ok: z.boolean() }),
    handler: async (ctx, args): Promise<{ ok: boolean }> => {
      const db = ctx.db<typeof schema>();
      // Attribution (audit #5): the dismissal records the acting
      // role — its Restore follows the alert-dismissals policy
      // and the ownership rule against it.
      const { role } = await loadAccountSettings(ctx);
      const res = await db
        .update(schema.alerts)
        .set({ dismissedAt: new Date(), dismissedBy: role })
        .where(eq(schema.alerts.id, args.id))
        .returning({ id: schema.alerts.id });
      ctx.invalidateQueries();
      return { ok: res.length > 0 };
    },
  }),

  restoreAlert: defineAction({
    description:
      "Restores one dismissed alert to the in-app feed (Beta 0.01 batch, audit #5 — the dismissal's Undo): clears its dismissed stamp so it shows in the alerts list again with its read state as it was. Display only — restoring never touches inventory. Policy (audit #5, Primary vs Connected): refused when alert dismissals are set Permanent, and a Connected account can restore only its own dismissals — the Primary user can restore anyone's.",
    request: z.object({ id: z.number().int().positive() }),
    response: z.object({
      ok: z.boolean(),
      error: z.string().nullable(),
    }),
    handler: async (ctx, args) => await performRestoreAlert(ctx, args.id),
  }),

  bootstrapPlanner: defineAction({
    description:
      "One-time seed for the Meal Planner tab: inserts the household's eight dinner ideas with their protein options, ingredient lists, and the picks current at seed time (from the Meal Planner build-and-sync spec), only when no meals exist yet. Also starts the first HIT List refresh when the HIT cache is still empty, so the HIT List tab populates without waiting for the daily refresh.",
    request: z.object({}),
    response: z.object({ seeded: z.boolean() }),
    handler: async (ctx): Promise<{ seeded: boolean }> => {
      const db = ctx.db<typeof schema>();
      // First-load population for the HIT List tab: if the cache has
      // never been filled, start the same refresh the Refresh button
      // and the daily schedule use.
      const hitRows = await db.select().from(schema.hitItems);
      if (hitRows.length === 0) {
        await ctx.agent.spawnTask(
          [
            "Refresh the HIT List tab data in the Shopping List app from Google Sheets.",
            "",
            `1. Confirm Google Sheets is connected: run \`/opt/hatch/bin/hatch_gws_cli sheets status\`. If it is not connected, stop and report that.`,
            `2. Read the HIT List tab of the household spreadsheet (spreadsheetId ${SPREADSHEET_ID}): run \`/opt/hatch/bin/hatch_gws_cli sheets spreadsheets values get --params '{"spreadsheetId":"${SPREADSHEET_ID}","range":"HIT List!A1:E120"}'\`.`,
            "3. Parse the values grid with these rules:",
            '   - Row 1 is the title ("Household Inventory Tracker") — ignore. Rows 2–3 are the totals header and totals — ignore. Row 5 is the column header (Category, Item Name, Stock, Store, Notes). Item rows start at row 6.',
            "   - For each row from row 6 on: category = col A (often empty — the sheet only fills it on the first row of each category group; pass the empty string through and the app carries the last category forward), item = col B (skip the row when empty), stock = col C parsed as an integer, store = col D.",
            "4. Call the saveHitList action exactly once with { items } containing every parsed item in sheet order.",
            "Do not edit the spreadsheet. Do not add, drop, or reorder items. Never invent a stock count.",
          ].join("\n"),
          { expectsAction: "saveHitList", dedupeKey: "hit-list-refresh" },
        );
      }
      const existing = await db.select().from(schema.meals);
      if (existing.length > 0) return { seeded: false };
      const proteinIdByMealLabel = new Map<string, number>();
      for (const [sortOrder, meal] of STARTER_MEALS.entries()) {
        const inserted = await db
          .insert(schema.meals)
          .values({ name: meal.name, note: meal.note, sortOrder })
          .returning({ id: schema.meals.id });
        const row = inserted[0];
        if (!row) throw new Error("bootstrapPlanner: meal insert returned no rows");
        for (const [groupIndex, group] of meal.groups.entries()) {
          for (const [optOrder, option] of group.entries()) {
            const protein = await db
              .insert(schema.mealProteins)
              .values({
                mealId: row.id,
                label: option.label,
                sheetName: option.sheetName,
                groupIndex,
                sortOrder: optOrder,
              })
              .returning({ id: schema.mealProteins.id });
            const proteinRow = protein[0];
            if (proteinRow) {
              proteinIdByMealLabel.set(
                `${meal.name}::${option.label}`,
                proteinRow.id,
              );
            }
          }
        }
        for (const [ingOrder, ing] of meal.ingredients.entries()) {
          await db.insert(schema.mealIngredients).values({
            mealId: row.id,
            name: ing.name,
            quantity: ing.quantity,
            unit: ing.unit,
            sortOrder: ingOrder,
          });
        }
      }
      const mealIdByName = new Map<string, number>();
      const allMeals = await db.select().from(schema.meals);
      for (const m of allMeals) mealIdByName.set(m.name, m.id);
      for (const pick of STARTER_PICKS) {
        const mealId = mealIdByName.get(pick.mealName);
        const proteinId = proteinIdByMealLabel.get(
          `${pick.mealName}::${pick.proteinLabel}`,
        );
        if (mealId == null || proteinId == null) continue;
        await db.insert(schema.picks).values({
          date: pick.date,
          mealId,
          proteinId,
          servings: pick.servings,
          variant: null,
        });
      }
      ctx.invalidateQueries();
      return { seeded: true };
    },
  }),

  // ---- BIT — Business Inventory Tracker ------------------------------
  // The business side of the app. Everything below reads and writes
  // ONLY the bit_* tables; the household (HIT) actions and tables
  // above are untouched by this side.

  getBitState: defineAction({
    description:
      "Reads the whole BIT (Business Inventory Tracker) side in one call: the business profile from the setup wizard (null until setup is completed) with its categories (the only organizing concept — for a business set up under the earlier category-or-zone choice, its existing groups are presented as its categories and each item's category is its group) and its saved POS connection (null until one is connected from the Inventory tab), every inventory item with its on-hand (book) count, par, unit, pack size, supplier, SKU, category and tags, the recent finished rounds with their variance / below-par / freezer summaries, and the manifest photo scans awaiting or holding a reader proposal. The business also carries its business-type needs profile (Alpha 0.75 — expiry tracking / waste log / fractional counting, keyed off the stored type), each item its optional expiry date, and, for waste-log (Restaurant) businesses, the waste history. For a requisition business (usesRequisition) it also returns the current outstanding requisition with its check-off lines, the closed requisition history, the not-received lines carried onto the next build as resubmissions, and the catalogue draft extras on the requisition being built. The business also carries the requisition approver name and the recorded-at stamps for the preparer and approver names (audit #15), each requisition its snapshotted prepared-by / approved-by names and dates, and each item its own last-counted stamp from the finished-check snapshots (audit #16; null when never counted). (Catalogue reference entries come back separately from the inventory items.)",
    request: z.object({ businessId: bitBusinessIdRequest }),
    response: z.object({
      businesses: z.array(
        z.object({
          id: z.number(),
          name: z.string(),
          type: z.string(),
        }),
      ),
      business: z
        .object({
          id: z.number(),
          type: z.string(),
          customType: z.string().nullable(),
          name: z.string(),
          categories: z.array(z.string()),
          freezers: z.array(z.string()),
          colors: z.record(z.string(), z.string()),
          // Requisition workflow (Alpha 0.71): the flag gates the
          // Requisition tab, catalogue and check-off flow;
          // division and the preparer's name are the requisition
          // form's stored, editable header fields (null until set).
          usesRequisition: z.boolean(),
          division: z.string().nullable(),
          preparerName: z.string().nullable(),
          // Approver separation (audit #15): the approver
          // recorded for this business, and when each header name
          // was recorded (ISO; null until set).
          approverName: z.string().nullable(),
          approverRecordedAt: z.string().nullable(),
          preparerRecordedAt: z.string().nullable(),
          // Team size saved by the setup wizard's team-size step
          // (Alpha 0.90); null for businesses set up before it.
          teamSize: z.string().nullable(),
          // Business-type needs profile (Alpha 0.75), keyed off
          // the stored business type: which type-specific
          // features are switched on for this business. All false
          // for Retail Store, Other / custom businesses and
          // businesses with no profile.
          needs: z.object({
            expiryTracking: z.boolean(),
            wasteLog: z.boolean(),
            fractionalCounting: z.boolean(),
          }),
          // Analytics tab gate (Alpha 0.76): true only when the
          // business has a stored analytics dataset (monthly rows
          // in bit_analytics_months) — today only The Daily Scoop
          // (the BIT Sim 01 dataset).
          hasAnalytics: z.boolean(),
          // The saved POS connection (null = none connected).
          pos: z
            .object({
              provider: z.string(),
              kind: z.enum(["named", "custom"]),
              status: z.string(),
              shareMethod: z.string().nullable(),
              endpointUrl: z.string().nullable(),
              apiKey: z.string().nullable(),
              locationId: z.string().nullable(),
              notes: z.string().nullable(),
              // Per-provider setup values with secrets masked
              // (null for custom connections and R-Series).
              details: bitPosDetailsShape.nullable(),
              intakeToken: z.string().nullable(),
              // Daily pull (Alpha 0.67): whether the daily sync
              // is on for this connection, the newest recorded
              // pull (null until the first one runs), and any
              // outstanding "Sync now" request stamp.
              dailySyncOn: z.boolean(),
              lastSync: bitPosSyncRunShape.nullable(),
              syncRequestedAt: z.string().nullable(),
              connectedAt: z.string(),
            })
            .nullable(),
        })
        .nullable(),
      items: z.array(bitItemShape),
      rounds: z.array(
        z.object({
          id: z.number(),
          counterName: z.string(),
          zoneFilter: z.string().nullable(),
          counted: z.number(),
          total: z.number(),
          variances: z.array(bitVarianceShape),
          belowPar: z.array(z.string()),
          freezerReadings: z.array(bitFreezerReadingShape),
          createdAt: z.string(),
        }),
      ),
      scans: z.array(
        z.object({
          id: z.number(),
          status: z.enum(["pending", "proposed", "confirmed", "dismissed"]),
          createdAt: z.string(),
          lines: z.array(bitManifestLineShape),
          note: z.string().nullable(),
        }),
      ),
      // Requisition workflow (Alpha 0.71): all empty / null for
      // businesses without the requisition flag. `requisition`
      // is the business's current outstanding requisition awaiting
      // check-off, `requisitionHistory` the completed ones kept on
      // file, `resubmittedLines` the not-received lines from closed
      // requisitions that carry onto the next requisition build,
      // and `draftExtras` the catalogue entries put straight onto
      // the requisition being built. The `catalogue` rows are the
      // Alpha 0.71 reference entries, kept on file for any draft
      // extras that still point at them; the client no longer
      // renders this list.
      catalogue: z.array(bitCatalogueShape),
      // Waste history (Alpha 0.75): newest first, populated only
      // for businesses whose needs profile includes the waste log
      // (Restaurant); empty for every other business.
      wasteLog: z.array(bitWasteLogShape),
      // Undo coverage (audit #5): recent Inventory-tab count
      // changes (manual_count stock events, newest first) with
      // their undone state, and recent manifest imports with the
      // names each added / updated — the records those surfaces'
      // Undos revert.
      stockEvents: z.array(bitStockEventShape),
      manifestImports: z.array(bitManifestImportShape),
      requisition: bitRequisitionShape.nullable(),
      requisitionHistory: z.array(bitRequisitionShape),
      resubmittedLines: z.array(bitRequisitionLineShape),
      draftExtras: z.array(bitDraftExtraShape),
    }),
    handler: async (ctx, args) => {
      const db = ctx.db<typeof schema>();
      // Attribution + policy (audit #5): every undoable record
      // in this read carries its actor / permanent / canUndo
      // trio, computed against the one settings row.
      const settings = await loadAccountSettings(ctx);
      const allBizRows = await db
        .select()
        .from(schema.bitBusiness)
        .orderBy(asc(schema.bitBusiness.id));
      const biz =
        args.businessId != null
          ? allBizRows.find((r) => r.id === args.businessId)
          : allBizRows[0];
      const businessId = biz?.id ?? -1;
      const [itemRows, roundRows, scanRows, syncRows, analyticsRows] =
        await Promise.all([
          db
            .select()
            .from(schema.bitItems)
            .where(eq(schema.bitItems.businessId, businessId))
            .orderBy(asc(schema.bitItems.sortOrder), asc(schema.bitItems.id)),
          db
            .select()
            .from(schema.bitRounds)
            .where(eq(schema.bitRounds.businessId, businessId))
            .orderBy(desc(schema.bitRounds.id))
            .limit(10),
          db
            .select()
            .from(schema.bitManifestScans)
            .where(eq(schema.bitManifestScans.businessId, businessId))
            .orderBy(desc(schema.bitManifestScans.id))
            .limit(12),
          db
            .select()
            .from(schema.bitPosSyncRuns)
            .where(eq(schema.bitPosSyncRuns.businessId, businessId))
            .orderBy(desc(schema.bitPosSyncRuns.id))
            .limit(20),
          db
            .select({ id: schema.bitAnalyticsMonths.id })
            .from(schema.bitAnalyticsMonths)
            .where(eq(schema.bitAnalyticsMonths.businessId, businessId))
            .limit(1),
        ]);
      // The last pull shown is the newest run for the CURRENTLY
      // connected provider (a provider switch must not surface
      // the previous provider's result).
      const lastSyncRow = syncRows.find(
        (r) => r.provider === biz?.posProvider,
      );
      // Requisition workflow data — only for businesses with the
      // flag; every other business reads empty.
      const reqBiz = biz && biz.usesRequisition === 1 ? biz : null;
      const [catalogueRows, reqRows, reqLineRows, draftExtraRows] =
        reqBiz
          ? await Promise.all([
              db
                .select()
                .from(schema.bitCatalogue)
                .where(eq(schema.bitCatalogue.businessId, reqBiz.id))
                .orderBy(
                  asc(schema.bitCatalogue.sortOrder),
                  asc(schema.bitCatalogue.id),
                ),
              db
                .select()
                .from(schema.bitRequisitions)
                .where(eq(schema.bitRequisitions.businessId, reqBiz.id))
                .orderBy(desc(schema.bitRequisitions.id)),
              db
                .select()
                .from(schema.bitRequisitionLines)
                .where(
                  eq(schema.bitRequisitionLines.businessId, reqBiz.id),
                )
                .orderBy(asc(schema.bitRequisitionLines.id)),
              db
                .select()
                .from(schema.bitRequisitionDraftExtras)
                .where(
                  eq(
                    schema.bitRequisitionDraftExtras.businessId,
                    reqBiz.id,
                  ),
                )
                .orderBy(asc(schema.bitRequisitionDraftExtras.id)),
            ])
          : [[], [], [], []];
      const outstandingReq =
        reqRows.find((r) => r.status === "outstanding") ?? null;
      const closedReqIds = new Set(
        reqRows.filter((r) => r.status === "closed").map((r) => r.id),
      );
      // Not-received lines from CLOSED requisitions that no later
      // requisition line has superseded carry onto the next build
      // (No back orders — resubmit instead).
      const resubmittedRows = reqLineRows.filter(
        (l) =>
          l.status === "not_received" &&
          l.supersededBy == null &&
          closedReqIds.has(l.requisitionId),
      );
      const isFoodBusiness = biz
        ? isBitFoodAndBeverageType(biz.businessType)
        : false;
      // Business-type needs profile (Alpha 0.75), from the stored
      // type. The waste history is read only for waste-log
      // businesses (Restaurant profile); everyone else reads empty.
      const needsProfile = biz
        ? bitNeedsProfileFor(biz.businessType)
        : BIT_NO_NEEDS;
      const wasteRows =
        biz && needsProfile.wasteLog
          ? await db
              .select()
              .from(schema.bitWasteLog)
              .where(eq(schema.bitWasteLog.businessId, biz.id))
              .orderBy(desc(schema.bitWasteLog.id))
              .limit(50)
          : [];
      // Undo coverage (audit #5): the Inventory tab's recent
      // manual count changes and the business's recent manifest
      // imports — the records those surfaces' Undos act on.
      const [stockEventRows, manifestImportRows] = biz
        ? await Promise.all([
            db
              .select()
              .from(schema.bitStockEvents)
              .where(
                and(
                  eq(schema.bitStockEvents.businessId, biz.id),
                  eq(schema.bitStockEvents.source, "manual_count"),
                ),
              )
              .orderBy(desc(schema.bitStockEvents.id))
              .limit(20),
            db
              .select()
              .from(schema.bitManifestImports)
              .where(eq(schema.bitManifestImports.businessId, biz.id))
              .orderBy(desc(schema.bitManifestImports.id))
              .limit(10),
          ])
        : [[], []];
      // Per-item last-counted stamps (audit #16): the newest
      // finished-check snapshot per item, from bit_item_snapshots
      // — an item never counted in a finished check has none.
      const itemSnapRows = biz
        ? await db
            .select({
              itemId: schema.bitItemSnapshots.itemId,
              createdAt: schema.bitItemSnapshots.createdAt,
            })
            .from(schema.bitItemSnapshots)
            .where(eq(schema.bitItemSnapshots.businessId, biz.id))
        : [];
      const lastCountedByItem = new Map<number, number>();
      for (const s of itemSnapRows) {
        if (s.itemId == null) continue;
        const t = s.createdAt.getTime();
        if (t > (lastCountedByItem.get(s.itemId) ?? 0))
          lastCountedByItem.set(s.itemId, t);
      }
      // Ensure a webhook/API-key custom POS has an intake token.
      let intakeToken = biz?.posIntakeToken ?? null;
      if (
        biz &&
        biz.posKind === "custom" &&
        (biz.posShareMethod === "Webhook" || biz.posShareMethod === "API key") &&
        !intakeToken
      ) {
        intakeToken = bitPosGenerateToken();
        await db
          .update(schema.bitBusiness)
          .set({ posIntakeToken: intakeToken, updatedAt: new Date() })
          .where(eq(schema.bitBusiness.id, biz.id));
      }
      return {
        businesses: allBizRows.map((b) => ({
          id: b.id,
          name: b.name,
          type:
            b.businessType === "Other" && b.customType
              ? b.customType
              : b.businessType,
        })),
        business: biz
          ? {
              id: biz.id,
              type: biz.businessType,
              customType: biz.customType,
              name: biz.name,
              // Categories only: a business set up under the old
              // category-or-zone choice presents its existing
              // groups as its categories.
              categories: bitBusinessCategories(biz),
              // Freezer checks exist only for food & beverage
              // businesses — a stored freezer list on any other
              // type (e.g. saved before this rule) is not surfaced.
              freezers: isFoodBusiness
                ? bitParseStringArray(biz.freezersJson)
                : [],
              colors: bitParseColors(biz.colorsJson),
              usesRequisition: biz.usesRequisition === 1,
              division: biz.division,
              preparerName: biz.preparerName,
              approverName: biz.approverName,
              approverRecordedAt:
                biz.approverRecordedAt?.toISOString() ?? null,
              preparerRecordedAt:
                biz.preparerRecordedAt?.toISOString() ?? null,
              teamSize: biz.teamSize,
              needs: needsProfile,
              hasAnalytics: analyticsRows.length > 0,
              pos:
                biz.posProvider && biz.posKind && biz.posConnectedAt
                  ? {
                      provider: biz.posProvider,
                      kind: biz.posKind,
                      status: biz.posStatus ?? "",
                      shareMethod: biz.posShareMethod,
                      endpointUrl: biz.posEndpointUrl,
                      // A custom connection's API key is a secret
                      // too — never returned raw.
                      apiKey: biz.posApiKey
                        ? bitPosMaskSecret(biz.posApiKey)
                        : null,
                      locationId: biz.posLocationId,
                      notes: biz.posNotes,
                      details:
                        biz.posKind === "named"
                          ? bitPosMaskedDetails(
                              bitPosParseDetails(biz.posDetailsJson),
                            )
                          : null,
                      intakeToken,
                      dailySyncOn: biz.posStatus === BIT_POS_READY_STATUS,
                      lastSync:
                        biz.posKind === "named" && lastSyncRow
                          ? {
                              id: lastSyncRow.id,
                              provider: lastSyncRow.provider,
                              status: lastSyncRow.status,
                              dayKey: lastSyncRow.dayKey,
                              ordersSeen: lastSyncRow.ordersSeen,
                              linesApplied: lastSyncRow.linesApplied,
                              linesUnmatched: lastSyncRow.linesUnmatched,
                              duplicates: lastSyncRow.duplicates,
                              error: lastSyncRow.error,
                              createdAt: lastSyncRow.createdAt.toISOString(),
                            }
                          : null,
                      syncRequestedAt:
                        biz.posSyncRequestedAt?.toISOString() ?? null,
                      connectedAt: biz.posConnectedAt.toISOString(),
                    }
                  : null,
            }
          : null,
        items: itemRows.map((r) => {
          const item = bitRowToItem(r);
          // Each item's category is its group: for a business set
          // up organized by its former zones, that is the item's
          // stored zone value; the legacy zone field mirrors it.
          const group = bitRowGroup(r, biz);
          const lastCountedMs = lastCountedByItem.get(r.id);
          return {
            ...item,
            category: group,
            zone: group,
            lastCountedAt:
              lastCountedMs != null
                ? new Date(lastCountedMs).toISOString()
                : null,
          };
        }),
        rounds: roundRows.map((r) => ({
          id: r.id,
          counterName: r.counterName,
          zoneFilter: r.zoneFilter,
          counted: r.counted,
          total: r.total,
          variances: bitParseVariances(r.variancesJson),
          belowPar: bitParseStringArray(r.belowParJson),
          freezerReadings: isFoodBusiness
            ? bitParseFreezerReadings(r.freezerJson)
            : [],
          createdAt: r.createdAt.toISOString(),
        })),
        scans: scanRows.map((s) => ({
          id: s.id,
          status: s.status,
          createdAt: s.createdAt.toISOString(),
          lines: bitParseManifestLines(s.linesJson),
          note: s.note,
        })),
        catalogue: catalogueRows.map((c) => ({
          id: c.id,
          materialNo: c.materialNo,
          description: c.description,
        })),
        wasteLog: wasteRows.map((w) => ({
          id: w.id,
          itemId: w.itemId,
          itemName: w.itemName,
          unit: w.unit,
          quantity: w.quantity,
          reason: w.reason,
          createdAt: w.createdAt.toISOString(),
          undone: w.undone === 1,
          ...undoMeta(settings, "wasteLog", w.actor, w.undone === 1),
        })),
        stockEvents: stockEventRows.map((e) => ({
          id: e.id,
          itemId: e.itemId,
          itemName: e.itemName,
          delta: e.delta,
          createdAt: e.createdAt.toISOString(),
          undone: e.undone === 1,
          ...undoMeta(
            settings,
            "bitCountChanges",
            e.actor,
            e.undone === 1,
          ),
        })),
        manifestImports: manifestImportRows.map((r) => {
          const changes = bitParseManifestImportChanges(r.changesJson);
          return {
            id: r.id,
            scanId: r.scanId,
            addedNames: changes.filter((c) => c.added).map((c) => c.name),
            updatedNames: changes
              .filter((c) => !c.added)
              .map((c) => c.name),
            createdAt: r.createdAt.toISOString(),
            undone: r.undone === 1,
            ...undoMeta(
              settings,
              "manifestImports",
              r.actor,
              r.undone === 1,
            ),
          };
        }),
        requisition: outstandingReq
          ? bitRequisitionToShape(outstandingReq, reqLineRows, settings)
          : null,
        requisitionHistory: reqRows
          .filter((r) => r.status === "closed")
          .map((r) => bitRequisitionToShape(r, reqLineRows, settings)),
        resubmittedLines: resubmittedRows.map((l) => ({
          id: l.id,
          itemId: l.itemId,
          name: l.name,
          materialNo: l.materialNo,
          qtyOrdered: l.qtyOrdered,
          unit: l.unit,
          category: l.category,
          status: l.status,
          qtyReceived: l.qtyReceived,
          ...undoMeta(
            settings,
            "requisitionCheckOffs",
            l.checkedOffBy,
            false,
          ),
        })),
        draftExtras: draftExtraRows.map((d) => ({
          id: d.id,
          catalogueId: d.catalogueId,
          name: d.name,
          materialNo: d.materialNo,
          qty: d.qty,
          unit: d.unit,
        })),
      };
    },
  }),

  seedDailyScoopBusiness: defineAction({
    description:
      "Seeds the sample ice-cream business 'The Daily Scoop' as an additional BIT business (Alpha 0.69): the Ice Cream Shop starter pack from the BIT demo — 34 items with their categories, par levels, suppliers, SKUs and tags, its categories and freezers — with NO POS connection. Idempotent: when a business named 'The Daily Scoop' already exists it changes nothing and reports created: false. It never touches any other business's rows.",
    request: z.object({}),
    response: z.object({
      ok: z.literal(true),
      created: z.boolean(),
      businessId: z.number().nullable(),
      itemCount: z.number(),
    }),
    handler: async (
      ctx,
    ): Promise<{
      ok: true;
      created: boolean;
      businessId: number | null;
      itemCount: number;
    }> => {
      const db = ctx.db<typeof schema>();
      const existing = await db
        .select()
        .from(schema.bitBusiness)
        .orderBy(asc(schema.bitBusiness.id));
      const already = existing.find(
        (b) => b.name.trim().toLowerCase() === "the daily scoop",
      );
      if (already) {
        const count = await db
          .select()
          .from(schema.bitItems)
          .where(eq(schema.bitItems.businessId, already.id));
        return {
          ok: true as const,
          created: false,
          businessId: already.id,
          itemCount: count.length,
        };
      }
      const inserted = await db
        .insert(schema.bitBusiness)
        .values({
          businessType: "Ice Cream Shop",
          customType: null,
          name: "The Daily Scoop",
          zonesJson: JSON.stringify(DAILY_SCOOP_CATEGORIES),
          organizeBy: "category",
          categoriesJson: JSON.stringify(DAILY_SCOOP_CATEGORIES),
          freezersJson: JSON.stringify(["Dipping Cabinet", "Freezer Room"]),
          colorsJson: JSON.stringify(DAILY_SCOOP_COLORS),
          updatedAt: new Date(),
        })
        .returning({ id: schema.bitBusiness.id });
      const biz = inserted[0];
      if (!biz) throw new Error("seedDailyScoopBusiness: no business row");
      const statements: BatchItem<"sqlite">[] = DAILY_SCOOP_ITEMS.map(
        (t, i) =>
          db.insert(schema.bitItems).values({
            businessId: biz.id,
            name: t[0],
            category: t[1],
            zone: t[1],
            onHand: t[2],
            unit: t[3],
            par: t[4],
            packSize: 1,
            supplier: t[5],
            sku: t[6],
            tagsJson: JSON.stringify(t[7]),
            sortOrder: i,
          }),
      );
      const [first, ...rest] = statements;
      if (first) await db.batch([first, ...rest]);
      ctx.invalidateQueries();
      return {
        ok: true as const,
        created: true,
        businessId: biz.id,
        itemCount: DAILY_SCOOP_ITEMS.length,
      };
    },
  }),

  getBitAnalytics: defineAction({
    description:
      "Reads one BIT business's analytics dataset (Alpha 0.76): the stored monthly results (days open, transactions, units sold, revenue, COGS, waste cost, gross and net profit, orders placed, stockout events, ending inventory value), the annual menu results, and the dataset summary (label, period, stockout lost revenue/units, notable waste breakdown, per-item unit costs). available is false when the business has no dataset — the Analytics tab exists only for businesses that do (today: The Daily Scoop, from the BIT Sim 01 simulation).",
    request: z.object({ businessId: bitBusinessIdRequest }),
    response: z.object({
      available: z.boolean(),
      label: z.string().nullable(),
      periodLabel: z.string().nullable(),
      months: z.array(bitAnalyticsMonthShape),
      menu: z.array(
        z.object({
          name: z.string(),
          units: z.number(),
          revenue: z.number(),
        }),
      ),
      lostRevenue: z.number(),
      lostUnits: z.number(),
      stockoutEvents: z.number(),
      tubWaste: z.array(z.object({ name: z.string(), tubs: z.number() })),
      itemCosts: z.record(z.string(), z.number()),
    }),
    handler: async (ctx, args) => {
      const db = ctx.db<typeof schema>();
      const biz = await resolveBitBusiness(ctx, args.businessId);
      const empty = {
        available: false,
        label: null,
        periodLabel: null,
        months: [],
        menu: [],
        lostRevenue: 0,
        lostUnits: 0,
        stockoutEvents: 0,
        tubWaste: [],
        itemCosts: {},
      };
      if (!biz) return empty;
      const [monthRows, menuRows, summaryRows] = await Promise.all([
        db
          .select()
          .from(schema.bitAnalyticsMonths)
          .where(eq(schema.bitAnalyticsMonths.businessId, biz.id))
          .orderBy(asc(schema.bitAnalyticsMonths.monthKey)),
        db
          .select()
          .from(schema.bitAnalyticsMenu)
          .where(eq(schema.bitAnalyticsMenu.businessId, biz.id))
          .orderBy(asc(schema.bitAnalyticsMenu.sortOrder)),
        db
          .select()
          .from(schema.bitAnalyticsSummary)
          .where(eq(schema.bitAnalyticsSummary.businessId, biz.id))
          .limit(1),
      ]);
      if (monthRows.length === 0) return empty;
      const summary = summaryRows[0];
      let tubWaste: { name: string; tubs: number }[] = [];
      let itemCosts: Record<string, number> = {};
      if (summary) {
        try {
          const parsed: unknown = JSON.parse(summary.wasteJson);
          if (Array.isArray(parsed)) {
            tubWaste = parsed.filter(
              (w): w is { name: string; tubs: number } =>
                typeof w === "object" &&
                w !== null &&
                typeof (w as { name?: unknown }).name === "string" &&
                typeof (w as { tubs?: unknown }).tubs === "number",
            );
          }
        } catch {
          tubWaste = [];
        }
        try {
          const parsed: unknown = JSON.parse(summary.itemCostsJson);
          if (typeof parsed === "object" && parsed !== null) {
            for (const [k, v] of Object.entries(
              parsed as Record<string, unknown>,
            )) {
              if (typeof v === "number") itemCosts[k] = v;
            }
          }
        } catch {
          itemCosts = {};
        }
      }
      return {
        available: true,
        label: summary?.label ?? null,
        periodLabel: summary?.periodLabel ?? null,
        months: monthRows.map((m) => ({
          monthKey: m.monthKey,
          label: m.label,
          daysOpen: m.daysOpen,
          transactions: m.transactions,
          unitsSold: m.unitsSold,
          revenue: m.revenue,
          cogs: m.cogs,
          wasteCost: m.wasteCost,
          grossProfit: m.grossProfit,
          netProfit: m.netProfit,
          ordersPlaced: m.ordersPlaced,
          stockoutEvents: m.stockoutEvents,
          endingInventoryValue: m.endingInventoryValue,
        })),
        menu: menuRows.map((m) => ({
          name: m.name,
          units: m.units,
          revenue: m.revenue,
        })),
        lostRevenue: summary?.lostRevenue ?? 0,
        lostUnits: summary?.lostUnits ?? 0,
        stockoutEvents: summary?.stockoutEvents ?? 0,
        tubWaste,
        itemCosts,
      };
    },
  }),

  seedBitSim01: defineAction({
    description:
      "Loads the BIT Sim 01 simulation results into The Daily Scoop (Alpha 0.76): the shop's inventory is replaced with the sim's 23 stock items at their closing counts (Nov 30, 2026) under the sim's six categories, and the sim's 12 monthly results (Dec 2025 – Nov 2026), annual menu results and summary figures (stockout losses, slow-season tub waste, per-item unit costs) are stored as the business's analytics dataset behind the Analytics tab. The business keeps its Ice Cream Shop type (freezer checks + expiry tracking needs profile), its freezers and its (absent) POS state. Idempotent: when the inventory already matches the sim's 23 items and the dataset is already stored, it changes nothing and reports seeded: false. No other business is touched.",
    request: z.object({}),
    response: z.object({
      ok: z.literal(true),
      seeded: z.boolean(),
      businessId: z.number().nullable(),
      itemCount: z.number(),
      monthCount: z.number(),
    }),
    handler: async (
      ctx,
    ): Promise<{
      ok: true;
      seeded: boolean;
      businessId: number | null;
      itemCount: number;
      monthCount: number;
    }> => {
      const db = ctx.db<typeof schema>();
      const all = await db
        .select()
        .from(schema.bitBusiness)
        .orderBy(asc(schema.bitBusiness.id));
      const scoop = all.find(
        (b) => b.name.trim().toLowerCase() === "the daily scoop",
      );
      if (!scoop) {
        return {
          ok: true as const,
          seeded: false,
          businessId: null,
          itemCount: 0,
          monthCount: 0,
        };
      }
      const [items, monthRows] = await Promise.all([
        db
          .select()
          .from(schema.bitItems)
          .where(eq(schema.bitItems.businessId, scoop.id)),
        db
          .select()
          .from(schema.bitAnalyticsMonths)
          .where(eq(schema.bitAnalyticsMonths.businessId, scoop.id)),
      ]);
      const targetNames = new Set(
        SIM01_ITEMS.map(([name]) => name.trim().toLowerCase()),
      );
      const alreadyLoaded =
        items.length === SIM01_ITEMS.length &&
        items.every((r) => targetNames.has(r.name.trim().toLowerCase())) &&
        monthRows.length === SIM01_MONTHS.length;
      if (alreadyLoaded) {
        return {
          ok: true as const,
          seeded: false,
          businessId: scoop.id,
          itemCount: items.length,
          monthCount: monthRows.length,
        };
      }
      const statements: BatchItem<"sqlite">[] = [];
      // Replace the inventory: the old sample items go (POS
      // mappings pointing at them go too — the shop has no POS
      // connection; rounds keep their name snapshots).
      const oldIds = new Set(items.map((r) => r.id));
      if (oldIds.size > 0) {
        const mappings = await db
          .select()
          .from(schema.bitPosMappings)
          .where(eq(schema.bitPosMappings.businessId, scoop.id));
        for (const m of mappings) {
          if (oldIds.has(m.itemId)) {
            statements.push(
              db
                .delete(schema.bitPosMappings)
                .where(eq(schema.bitPosMappings.id, m.id)),
            );
          }
        }
      }
      statements.push(
        db
          .delete(schema.bitItems)
          .where(eq(schema.bitItems.businessId, scoop.id)),
      );
      SIM01_ITEMS.forEach(([name, category, par, onHand, unit], i) => {
        statements.push(
          db.insert(schema.bitItems).values({
            businessId: scoop.id,
            name,
            category,
            zone: category,
            onHand,
            unit,
            par,
            packSize: 1,
            supplier: null,
            sku: null,
            tagsJson: "[]",
            sortOrder: i,
          }),
        );
      });
      // The business's category list becomes the sim's six
      // categories (both stored lists kept in step); type,
      // freezers and POS state are untouched.
      statements.push(
        db
          .update(schema.bitBusiness)
          .set({
            categoriesJson: JSON.stringify(SIM01_CATEGORIES),
            zonesJson: JSON.stringify(SIM01_CATEGORIES),
            colorsJson: JSON.stringify(SIM01_COLORS),
            updatedAt: new Date(),
          })
          .where(eq(schema.bitBusiness.id, scoop.id)),
      );
      // The analytics dataset: months, menu, summary.
      statements.push(
        db
          .delete(schema.bitAnalyticsMonths)
          .where(eq(schema.bitAnalyticsMonths.businessId, scoop.id)),
        db
          .delete(schema.bitAnalyticsMenu)
          .where(eq(schema.bitAnalyticsMenu.businessId, scoop.id)),
        db
          .delete(schema.bitAnalyticsSummary)
          .where(eq(schema.bitAnalyticsSummary.businessId, scoop.id)),
      );
      for (const m of SIM01_MONTHS) {
        statements.push(
          db.insert(schema.bitAnalyticsMonths).values({
            businessId: scoop.id,
            monthKey: m[0],
            label: m[1],
            daysOpen: m[2],
            transactions: m[3],
            unitsSold: m[4],
            revenue: m[5],
            cogs: m[6],
            wasteCost: m[7],
            grossProfit: m[8],
            netProfit: m[9],
            ordersPlaced: m[10],
            stockoutEvents: m[11],
            endingInventoryValue: m[12],
          }),
        );
      }
      SIM01_MENU.forEach(([name, units, revenue], i) => {
        statements.push(
          db.insert(schema.bitAnalyticsMenu).values({
            businessId: scoop.id,
            name,
            units,
            revenue,
            sortOrder: i,
          }),
        );
      });
      const itemCosts: Record<string, number> = {};
      for (const [name, , , , , cost] of SIM01_ITEMS) itemCosts[name] = cost;
      statements.push(
        db.insert(schema.bitAnalyticsSummary).values({
          businessId: scoop.id,
          label: "BIT Sim 01",
          periodLabel: "Dec 2025 – Nov 2026",
          lostRevenue: 2133.5,
          lostUnits: 271,
          stockoutEvents: 7,
          wasteJson: JSON.stringify(SIM01_TUB_WASTE),
          itemCostsJson: JSON.stringify(itemCosts),
        }),
      );
      const [first, ...rest] = statements;
      if (first) await db.batch([first, ...rest]);
      ctx.invalidateQueries();
      return {
        ok: true as const,
        seeded: true,
        businessId: scoop.id,
        itemCount: SIM01_ITEMS.length,
        monthCount: SIM01_MONTHS.length,
      };
    },
  }),

  updateBitRequisitionProfile: defineAction({
    description:
      "Stores the requisition form's editable header fields on a requisition business: the Division, the preparer's name, and the approver's name (audit #15). All start blank and stay exactly what the user sets; blank clears the field. When a name changes, its recorded-at stamp moves to now (and clears with the name). The approver must differ from the preparer: recording the same name as both is rejected and nothing is saved.",
    request: z.object({
      businessId: bitBusinessIdRequest,
      division: z.string().max(120).nullable(),
      preparerName: z.string().max(120).nullable(),
      approverName: z.string().max(120).nullable(),
    }),
    response: z.object({
      ok: z.boolean(),
      error: z.string().nullable(),
    }),
    handler: async (
      ctx,
      args,
    ): Promise<{ ok: boolean; error: string | null }> => {
      const db = ctx.db<typeof schema>();
      const biz = await resolveBitBusiness(ctx, args.businessId);
      if (!biz) throw new Error("updateBitRequisitionProfile: no business");
      const division = args.division?.trim() ? args.division.trim() : null;
      const preparerName = args.preparerName?.trim()
        ? args.preparerName.trim()
        : null;
      const approverName = args.approverName?.trim()
        ? args.approverName.trim()
        : null;
      // Approver separation: the approver can never be the
      // preparer who prepared it.
      if (
        approverName &&
        preparerName &&
        approverName.toLowerCase() === preparerName.toLowerCase()
      ) {
        return {
          ok: false,
          error:
            "The approver must be different from the preparer — the same name can't be recorded as both.",
        };
      }
      const now = new Date();
      await db
        .update(schema.bitBusiness)
        .set({
          division,
          preparerName,
          approverName,
          preparerRecordedAt:
            preparerName === biz.preparerName
              ? biz.preparerRecordedAt
              : preparerName
                ? now
                : null,
          approverRecordedAt:
            approverName === biz.approverName
              ? biz.approverRecordedAt
              : approverName
                ? now
                : null,
          updatedAt: now,
        })
        .where(eq(schema.bitBusiness.id, biz.id));
      ctx.invalidateQueries();
      return { ok: true, error: null };
    },
  }),

  getBitRequisitionFormPdf: defineAction({
    description:
      "Builds the filled requisition form (a generic PDF drawn for this requisition) for the requisition currently being prepared: the header boxes (Division, Business, today's date, preparer name, approver name) and the given lines (Item/Description, Qty, Unit, Material #) are filled in, 20 lines per page, repeating the page for longer requisitions with each page numbered (\"Page X of Y\"). The two signature boxes are signed with the initials typed in the Requisition tab: the client renders them in a generic cursive and passes a transparent PNG of each (null when that box's initials are blank, leaving the signature box blank). Returns the PDF as base64 for the client to download. Nothing is recorded — sending still goes through sendBitRequisition.",
    request: z.object({
      businessId: bitBusinessIdRequest,
      // The header exactly as it stands in the tab's header boxes
      // (it may hold edits not yet saved to the business profile).
      division: z.string().max(120).nullable(),
      preparerName: z.string().max(200).nullable(),
      approverName: z.string().max(200).nullable(),
      // Cursive renderings of the typed initials (transparent
      // PNG, base64) for the two signature boxes.
      preparerSignaturePng: z.string().max(500_000).nullable(),
      approverSignaturePng: z.string().max(500_000).nullable(),
      lines: z
        .array(
          z.object({
            name: z.string().min(1).max(200),
            materialNo: z.string().max(80).nullable(),
            qty: z.number().int().min(1).max(100000),
            unit: z.string().min(1).max(60),
          }),
        )
        .min(1)
        .max(1000),
    }),
    response: bitRequisitionFormPdfResponse,
    handler: async (
      ctx,
      args,
    ): Promise<z.infer<typeof bitRequisitionFormPdfResponse>> => {
      const biz = await resolveBitBusiness(ctx, args.businessId);
      if (!biz || biz.usesRequisition !== 1) {
        return {
          ok: false,
          filename: null,
          pdfBase64: null,
          pageCount: 0,
          error: "This business does not use requisitions.",
        };
      }
      const now = new Date();
      const reqNo = bitReqNo(biz, now);
      const dateLong = new Intl.DateTimeFormat("en-CA", {
        timeZone: "America/Toronto",
        year: "numeric",
        month: "long",
        day: "numeric",
      }).format(now);
      try {
        const { base64, pageCount } = await buildReqFormPdf({
          division: args.division?.trim() ?? "",
          businessName: biz.name,
          date: dateLong,
          preparerName: args.preparerName?.trim() ?? "",
          approverName: args.approverName?.trim() ?? "",
          preparerSignaturePng: args.preparerSignaturePng,
          approverSignaturePng: args.approverSignaturePng,
          lines: args.lines.map((l) => ({
            name: l.name.trim(),
            materialNo: l.materialNo?.trim() ? l.materialNo.trim() : null,
            qty: l.qty,
            unit: l.unit.trim() || "units",
          })),
        });
        return {
          ok: true,
          filename: `Requisition ${reqNo}.pdf`,
          pdfBase64: base64,
          pageCount,
          error: null,
        };
      } catch {
        return {
          ok: false,
          filename: null,
          pdfBase64: null,
          pageCount: 0,
          error: "The filled form couldn't be built. Try again.",
        };
      }
    },
  }),

  scanBitRequisitionForm: defineAction({
    description:
      "Scans a pre-populated requisition form the user uploads in the BIT Requisition tab — either the filled-in requisition-form PDF itself (its fillable form fields are read directly) or a photo of the paper form (read by the model) — and cross-references every line on the form against the business's inventory list: a line is matched to an inventory item by Material # first, then by exact item name, then by word-based name matching, and only when the match is unambiguous. Returns the form's header details (Division, preparer name, approver name) and, per line, what the form says plus the matched inventory item (or null when nothing on the list matches). Nothing is recorded and nothing is added to any requisition by this call — the tab reviews the matches and the user picks which ones go onto the draft. A PDF with no readable form fields (a flattened scan) and an unreadable photo are refused with an error saying so.",
    request: z.object({
      businessId: bitBusinessIdRequest,
      file: z.object({
        // Base64 of the uploaded file (from fileToBase64 on the
        // client). Capped so a single request stays sane.
        dataBase64: z.string().min(1).max(20_000_000),
        mimeType: z.string().min(1).max(100),
      }),
    }),
    response: bitRequisitionFormScanResponse,
    handler: async (
      ctx,
      args,
    ): Promise<z.infer<typeof bitRequisitionFormScanResponse>> => {
      const fail = (error: string): z.infer<typeof bitRequisitionFormScanResponse> => ({
        ok: false,
        error,
        source: null,
        header: null,
        lines: [],
      });
      const biz = await resolveBitBusiness(ctx, args.businessId);
      if (!biz || biz.usesRequisition !== 1) {
        return fail("This business does not use requisitions.");
      }
      const mime = args.file.mimeType.trim().toLowerCase();
      let bytes: Uint8Array;
      try {
        bytes = base64ToBytes(args.file.dataBase64);
      } catch {
        return fail("That file couldn't be read. Try again.");
      }
      if (bytes.length === 0) return fail("That file was empty.");

      let scanned: ScannedReqForm | null = null;
      let source: "pdf" | "photo";
      if (mime === "application/pdf") {
        source = "pdf";
        scanned = await extractReqFormPdfLines(bytes);
        if (!scanned) {
          return fail(
            "No filled-in lines could be read from that PDF — if it's a scan or a printed copy of the form, take a photo of it instead; if it's the fillable REQ form, make sure the copy you upload still has its filled fields (a copy saved from this app's Download PDF is flattened and can't be read back).",
          );
        }
      } else if (mime === "image/jpeg" || mime === "image/png") {
        source = "photo";
        try {
          const read = await ctx.inference.complete(
            "Read the requisition form in this photo. Extract the header details — the Division, the preparer name, and the approver name — and every filled-in line row: the Item/Description text exactly as written, the Qty, the Unit, and the Material #. Skip completely blank rows. Copy the text as written; do not invent or complete anything that is not legible — use null for any value you cannot read.",
            {
              images: [
                {
                  dataBase64: args.file.dataBase64,
                  mimeType: mime,
                  caption: "A filled-in requisition form",
                },
              ],
              schema: reqFormPhotoExtraction,
              timeout_secs: 120,
            },
          );
          const lines: ScannedReqFormLine[] = read.lines
            .filter((l) => l.name.trim().length > 0)
            .map((l) => ({
              name: l.name.trim(),
              qty:
                l.qty != null && Number.isFinite(l.qty) && l.qty > 0
                  ? Math.floor(l.qty)
                  : null,
              unit: l.unit?.trim() ? l.unit.trim() : null,
              materialNo: l.materialNo?.trim() ? l.materialNo.trim() : null,
            }));
          if (lines.length > 0) {
            scanned = {
              division: read.division?.trim() ? read.division.trim() : null,
              preparerName: read.preparerName?.trim()
                ? read.preparerName.trim()
                : null,
              approverName: read.approverName?.trim()
                ? read.approverName.trim()
                : null,
              lines,
            };
          }
        } catch {
          return fail(
            "That photo couldn't be read. Try a clearer, straight-on photo of the form.",
          );
        }
        if (!scanned) {
          return fail(
            "No items could be read off that photo. Try a clearer, straight-on photo of the form.",
          );
        }
      } else {
        return fail(
          "That file type isn't supported — upload the filled-in requisition form (PDF), or a JPEG / PNG photo of the form.",
        );
      }

      // Cross-reference every scanned line against the station's
      // inventory list. Lines that land on the same item are
      // merged into one (quantities added), so an item never
      // appears twice in the review.
      const db = ctx.db<typeof schema>();
      const items = await db
        .select()
        .from(schema.bitItems)
        .where(eq(schema.bitItems.businessId, biz.id));
      const out: z.infer<typeof bitRequisitionFormScanResponse>["lines"] =
        [];
      const byItemId = new Map<
        number,
        z.infer<typeof bitRequisitionFormScanResponse>["lines"][number]
      >();
      for (const line of scanned.lines) {
        const match = matchScannedReqLine(line, items);
        if (match) {
          const existing = byItemId.get(match.item.id);
          if (existing) {
            existing.qty =
              existing.qty != null || line.qty != null
                ? (existing.qty ?? 0) + (line.qty ?? 0)
                : null;
            continue;
          }
          const row = {
            scannedName: line.name,
            qty: line.qty,
            unit: line.unit,
            materialNo: line.materialNo,
            matchedItemId: match.item.id,
            matchedName: match.item.name,
            matchedMaterialNo: match.item.sku,
            matchedCategory: match.item.category,
            matchedUnit: match.item.unit,
            matchedOnHand: match.item.onHand,
            matchKind: match.kind,
          };
          byItemId.set(match.item.id, row);
          out.push(row);
        } else {
          out.push({
            scannedName: line.name,
            qty: line.qty,
            unit: line.unit,
            materialNo: line.materialNo,
            matchedItemId: null,
            matchedName: null,
            matchedMaterialNo: null,
            matchedCategory: null,
            matchedUnit: null,
            matchedOnHand: null,
            matchKind: null,
          });
        }
      }
      return {
        ok: true,
        error: null,
        source,
        header: {
          division: scanned.division,
          preparerName: scanned.preparerName,
          approverName: scanned.approverName,
        },
        lines: out,
      };
    },
  }),

  sendBitRequisition: defineAction({
    description:
      "Marks a requisition as sent to the supplier: records it (auto-generated Req. No. in the form's <code>-YY-MM-DD format, today's date, the exact lines sent) as the business's current outstanding requisition, awaiting the delivery check-off. Any not-received lines from earlier closed requisitions that this requisition resubmits are marked superseded, and catalogue draft extras folded into the lines are cleared. Refused while another requisition is still outstanding. Approver separation (audit #15): refused until an approver is recorded on the business, and refused if the approver is the same name as the preparer; the preparer / approver names and their recorded dates are snapshotted onto the requisition at send time.",
    request: z.object({
      businessId: bitBusinessIdRequest,
      lines: z
        .array(
          z.object({
            itemId: z.number().int().positive().nullable(),
            name: z.string().min(1).max(200),
            materialNo: z.string().max(80).nullable(),
            qty: z.number().int().min(1).max(100000),
            unit: z.string().min(1).max(60),
            category: z.string().min(1).max(120),
            resubmittedFromLineId: z
              .number()
              .int()
              .positive()
              .nullable(),
          }),
        )
        .min(1)
        .max(200),
    }),
    response: z.object({
      ok: z.boolean(),
      reqNo: z.string().nullable(),
      error: z.string().nullable(),
    }),
    handler: async (
      ctx,
      args,
    ): Promise<{
      ok: boolean;
      reqNo: string | null;
      error: string | null;
    }> => {
      const db = ctx.db<typeof schema>();
      const biz = await resolveBitBusiness(ctx, args.businessId);
      if (!biz || biz.usesRequisition !== 1) {
        return {
          ok: false,
          reqNo: null,
          error: "This business does not use requisitions.",
        };
      }
      // Approver separation (audit #15): no approver recorded —
      // no send. This cannot be waived (the client's pre-send
      // popup says the same and offers the approver field there).
      if (!biz.approverName?.trim()) {
        return {
          ok: false,
          reqNo: null,
          error:
            "An approver is required before sending — record the approver's name first.",
        };
      }
      if (
        biz.preparerName?.trim() &&
        biz.approverName.trim().toLowerCase() ===
          biz.preparerName.trim().toLowerCase()
      ) {
        return {
          ok: false,
          reqNo: null,
          error:
            "The approver must be different from the preparer.",
        };
      }
      const existing = await db
        .select()
        .from(schema.bitRequisitions)
        .where(
          and(
            eq(schema.bitRequisitions.businessId, biz.id),
            eq(schema.bitRequisitions.status, "outstanding"),
          ),
        );
      if (existing.length > 0) {
        return {
          ok: false,
          reqNo: null,
          error:
            "A requisition is already outstanding — check off its delivery before sending another.",
        };
      }
      const now = new Date();
      const reqNo = bitReqNo(biz, now);
      const inserted = await db
        .insert(schema.bitRequisitions)
        .values({
          businessId: biz.id,
          reqNo,
          status: "outstanding",
          // Prepared by → Approved by → Sent, snapshotted from
          // the header fields so the state stays on file.
          preparedBy: biz.preparerName,
          preparedAt: biz.preparerRecordedAt,
          approvedBy: biz.approverName,
          approvedAt: biz.approverRecordedAt,
          sentAt: now,
        })
        .returning({ id: schema.bitRequisitions.id });
      const req = inserted[0];
      if (!req) throw new Error("sendBitRequisition: insert returned no rows");
      const statements: BatchItem<"sqlite">[] = args.lines.map((l) =>
        db.insert(schema.bitRequisitionLines).values({
          requisitionId: req.id,
          businessId: biz.id,
          itemId: l.itemId,
          name: l.name.trim(),
          materialNo: l.materialNo?.trim() ? l.materialNo.trim() : null,
          qtyOrdered: l.qty,
          unit: l.unit.trim() || "units",
          category: l.category.trim() || "Other",
          status: "pending",
        }),
      );
      const [first, ...rest] = statements;
      if (first) await db.batch([first, ...rest]);
      // Mark the resubmitted source lines superseded by the new
      // lines that carry them (matched in request order).
      const newLines = await db
        .select()
        .from(schema.bitRequisitionLines)
        .where(eq(schema.bitRequisitionLines.requisitionId, req.id))
        .orderBy(asc(schema.bitRequisitionLines.id));
      const supersede: BatchItem<"sqlite">[] = [];
      args.lines.forEach((l, i) => {
        const created = newLines[i];
        if (l.resubmittedFromLineId != null && created) {
          supersede.push(
            db
              .update(schema.bitRequisitionLines)
              .set({ supersededBy: created.id })
              .where(
                eq(
                  schema.bitRequisitionLines.id,
                  l.resubmittedFromLineId,
                ),
              ),
          );
        }
      });
      const [sFirst, ...sRest] = supersede;
      if (sFirst) await db.batch([sFirst, ...sRest]);
      // The catalogue extras folded into this requisition are
      // spent — clear the draft.
      await db
        .delete(schema.bitRequisitionDraftExtras)
        .where(eq(schema.bitRequisitionDraftExtras.businessId, biz.id));
      ctx.invalidateQueries();
      return { ok: true, reqNo, error: null };
    },
  }),

  approveBitRequisitionForm: defineAction({
    description:
      "Approves the filled requisition form from the review pop-up that opens the moment an inventory check finishes (the user's submission flow): the header fields as reviewed in the pop-up (Division, preparer name, approver name) are recorded on the business exactly the way updateBitRequisitionProfile records them (a changed name moves its recorded-at stamp to now), the requisition is recorded as sent under the same guards as sendBitRequisition (an approver is required, the approver cannot be the preparer, and no other requisition may be outstanding; resubmitted source lines are superseded and catalogue draft extras cleared), and the filled requisition-form PDF — built from the reviewed header, lines and typed-initial signatures — is saved on the requisition row (base64, page count, saved-at stamp) so the Requisition tab's Download PDF button serves exactly the approved copy. The form is built before anything is recorded: if a guard fails or the form cannot be built, nothing is recorded and nothing is saved.",
    request: z.object({
      businessId: bitBusinessIdRequest,
      // The header exactly as reviewed in the pop-up.
      division: z.string().max(120).nullable(),
      preparerName: z.string().max(200).nullable(),
      approverName: z.string().max(200).nullable(),
      // Cursive renderings of the typed initials (transparent
      // PNG, base64) for the two signature boxes.
      preparerSignaturePng: z.string().max(500_000).nullable(),
      approverSignaturePng: z.string().max(500_000).nullable(),
      lines: z
        .array(
          z.object({
            itemId: z.number().int().positive().nullable(),
            name: z.string().min(1).max(200),
            materialNo: z.string().max(80).nullable(),
            qty: z.number().int().min(1).max(100000),
            unit: z.string().min(1).max(60),
            category: z.string().min(1).max(120),
            resubmittedFromLineId: z
              .number()
              .int()
              .positive()
              .nullable(),
          }),
        )
        .min(1)
        .max(200),
    }),
    response: z.object({
      ok: z.boolean(),
      reqNo: z.string().nullable(),
      pageCount: z.number().int(),
      error: z.string().nullable(),
    }),
    handler: async (
      ctx,
      args,
    ): Promise<{
      ok: boolean;
      reqNo: string | null;
      pageCount: number;
      error: string | null;
    }> => {
      const db = ctx.db<typeof schema>();
      const biz = await resolveBitBusiness(ctx, args.businessId);
      if (!biz || biz.usesRequisition !== 1) {
        return {
          ok: false,
          reqNo: null,
          pageCount: 0,
          error: "This business does not use requisitions.",
        };
      }
      const division = args.division?.trim() ? args.division.trim() : null;
      const preparerName = args.preparerName?.trim()
        ? args.preparerName.trim()
        : null;
      const approverName = args.approverName?.trim()
        ? args.approverName.trim()
        : null;
      // Approver separation (audit #15), same as everywhere: the
      // approver is required and can never be the preparer.
      if (
        approverName &&
        preparerName &&
        approverName.toLowerCase() === preparerName.toLowerCase()
      ) {
        return {
          ok: false,
          reqNo: null,
          pageCount: 0,
          error:
            "The approver must be different from the preparer — the same name can't be recorded as both.",
        };
      }
      if (!approverName) {
        return {
          ok: false,
          reqNo: null,
          pageCount: 0,
          error:
            "An approver is required before the form can be approved — record the approver's name first.",
        };
      }
      const existing = await db
        .select()
        .from(schema.bitRequisitions)
        .where(
          and(
            eq(schema.bitRequisitions.businessId, biz.id),
            eq(schema.bitRequisitions.status, "outstanding"),
          ),
        );
      if (existing.length > 0) {
        return {
          ok: false,
          reqNo: null,
          pageCount: 0,
          error:
            "A requisition is already outstanding — check off its delivery before approving another.",
        };
      }
      const now = new Date();
      const reqNo = bitReqNo(biz, now);
      const dateLong = new Intl.DateTimeFormat("en-CA", {
        timeZone: "America/Toronto",
        year: "numeric",
        month: "long",
        day: "numeric",
      }).format(now);
      // Build the exact form the reviewer saw BEFORE recording
      // anything: a form that can't be built approves nothing.
      let built: { base64: string; pageCount: number };
      try {
        built = await buildReqFormPdf({
          division: division ?? "",
          businessName: biz.name,
          date: dateLong,
          preparerName: preparerName ?? "",
          approverName: approverName ?? "",
          preparerSignaturePng: args.preparerSignaturePng,
          approverSignaturePng: args.approverSignaturePng,
          lines: args.lines.map((l) => ({
            name: l.name.trim(),
            materialNo: l.materialNo?.trim() ? l.materialNo.trim() : null,
            qty: l.qty,
            unit: l.unit.trim() || "units",
          })),
        });
      } catch {
        return {
          ok: false,
          reqNo: null,
          pageCount: 0,
          error: "The filled form couldn't be built. Try again.",
        };
      }
      // Record the reviewed header on the business profile, with
      // the same recorded-at stamp movement as
      // updateBitRequisitionProfile; the requisition snapshots
      // the same stamps as its Prepared / Approved record.
      const preparedAt =
        preparerName === biz.preparerName
          ? biz.preparerRecordedAt
          : preparerName
            ? now
            : null;
      const approvedAt =
        approverName === biz.approverName
          ? biz.approverRecordedAt
          : now;
      await db
        .update(schema.bitBusiness)
        .set({
          division,
          preparerName,
          approverName,
          preparerRecordedAt: preparedAt,
          approverRecordedAt: approvedAt,
          updatedAt: now,
        })
        .where(eq(schema.bitBusiness.id, biz.id));
      const inserted = await db
        .insert(schema.bitRequisitions)
        .values({
          businessId: biz.id,
          reqNo,
          status: "outstanding",
          preparedBy: preparerName,
          preparedAt,
          approvedBy: approverName,
          approvedAt,
          sentAt: now,
          // The approved form itself, saved on the requisition.
          formPdfBase64: built.base64,
          formPageCount: built.pageCount,
          formSavedAt: now,
        })
        .returning({ id: schema.bitRequisitions.id });
      const req = inserted[0];
      if (!req)
        throw new Error("approveBitRequisitionForm: insert returned no rows");
      const statements: BatchItem<"sqlite">[] = args.lines.map((l) =>
        db.insert(schema.bitRequisitionLines).values({
          requisitionId: req.id,
          businessId: biz.id,
          itemId: l.itemId,
          name: l.name.trim(),
          materialNo: l.materialNo?.trim() ? l.materialNo.trim() : null,
          qtyOrdered: l.qty,
          unit: l.unit.trim() || "units",
          category: l.category.trim() || "Other",
          status: "pending",
        }),
      );
      const [first, ...rest] = statements;
      if (first) await db.batch([first, ...rest]);
      // Mark the resubmitted source lines superseded by the new
      // lines that carry them (matched in request order).
      const newLines = await db
        .select()
        .from(schema.bitRequisitionLines)
        .where(eq(schema.bitRequisitionLines.requisitionId, req.id))
        .orderBy(asc(schema.bitRequisitionLines.id));
      const supersede: BatchItem<"sqlite">[] = [];
      args.lines.forEach((l, i) => {
        const created = newLines[i];
        if (l.resubmittedFromLineId != null && created) {
          supersede.push(
            db
              .update(schema.bitRequisitionLines)
              .set({ supersededBy: created.id })
              .where(
                eq(
                  schema.bitRequisitionLines.id,
                  l.resubmittedFromLineId,
                ),
              ),
          );
        }
      });
      const [sFirst, ...sRest] = supersede;
      if (sFirst) await db.batch([sFirst, ...sRest]);
      // The catalogue extras folded into this requisition are
      // spent — clear the draft.
      await db
        .delete(schema.bitRequisitionDraftExtras)
        .where(eq(schema.bitRequisitionDraftExtras.businessId, biz.id));
      ctx.invalidateQueries();
      return { ok: true, reqNo, pageCount: built.pageCount, error: null };
    },
  }),

  getBitSavedRequisitionFormInfo: defineAction({
    description:
      "Reports the latest approved-and-saved requisition form for a BIT requisition business (saved on its requisition by approveBitRequisitionForm from the post-check review pop-up): the requisition number it belongs to, when it was saved, and its page count — or exists=false when no form has been saved yet. The Requisition tab's Download PDF button reads this to know whether it serves the saved approved form or builds one from the current draft.",
    request: z.object({
      businessId: bitBusinessIdRequest,
    }),
    response: z.object({
      exists: z.boolean(),
      reqNo: z.string().nullable(),
      savedAt: z.string().nullable(),
      pageCount: z.number().int(),
    }),
    handler: async (
      ctx,
      args,
    ): Promise<{
      exists: boolean;
      reqNo: string | null;
      savedAt: string | null;
      pageCount: number;
    }> => {
      const db = ctx.db<typeof schema>();
      const biz = await resolveBitBusiness(ctx, args.businessId);
      if (!biz) {
        return { exists: false, reqNo: null, savedAt: null, pageCount: 0 };
      }
      const rows = await db
        .select()
        .from(schema.bitRequisitions)
        .where(
          and(
            eq(schema.bitRequisitions.businessId, biz.id),
            isNotNull(schema.bitRequisitions.formPdfBase64),
          ),
        )
        .orderBy(desc(schema.bitRequisitions.id));
      const row = rows[0];
      if (!row || !row.formPdfBase64) {
        return { exists: false, reqNo: null, savedAt: null, pageCount: 0 };
      }
      return {
        exists: true,
        reqNo: row.reqNo,
        savedAt: row.formSavedAt?.toISOString() ?? null,
        pageCount: row.formPageCount ?? 1,
      };
    },
  }),

  downloadBitSavedRequisitionForm: defineAction({
    description:
      "Returns the latest approved-and-saved requisition form PDF (base64) for a BIT requisition business — the exact copy the reviewer approved in the post-check review pop-up, saved on its requisition by approveBitRequisitionForm. The Requisition tab's Download PDF button downloads this copy when one exists; ok=false when no form has been saved yet.",
    request: z.object({
      businessId: bitBusinessIdRequest,
    }),
    response: bitRequisitionFormPdfResponse,
    handler: async (
      ctx,
      args,
    ): Promise<z.infer<typeof bitRequisitionFormPdfResponse>> => {
      const db = ctx.db<typeof schema>();
      const biz = await resolveBitBusiness(ctx, args.businessId);
      if (!biz) {
        return {
          ok: false,
          filename: null,
          pdfBase64: null,
          pageCount: 0,
          error: "That business is gone.",
        };
      }
      const rows = await db
        .select()
        .from(schema.bitRequisitions)
        .where(
          and(
            eq(schema.bitRequisitions.businessId, biz.id),
            isNotNull(schema.bitRequisitions.formPdfBase64),
          ),
        )
        .orderBy(desc(schema.bitRequisitions.id));
      const row = rows[0];
      if (!row || !row.formPdfBase64) {
        return {
          ok: false,
          filename: null,
          pdfBase64: null,
          pageCount: 0,
          error: "No approved form has been saved yet.",
        };
      }
      return {
        ok: true,
        filename: `Requisition ${row.reqNo}.pdf`,
        pdfBase64: row.formPdfBase64,
        pageCount: row.formPageCount ?? 1,
        error: null,
      };
    },
  }),

  checkOffBitRequisitionLine: defineAction({
    description:
      "The delivery check-off on one line of the outstanding requisition: 'received' applies the received quantity (default the ordered quantity) to the tracked item's stock; 'not_received' remarks the line — it is never back-ordered and will resurface badged 'Resubmitted' on the next requisition build. When every line is checked off, the requisition closes and stays on file in the requisition history.",
    request: z.object({
      lineId: z.number().int().positive(),
      outcome: z.enum(["received", "not_received"]),
      qtyReceived: z.number().int().min(0).max(100000).nullable(),
    }),
    response: z.object({
      ok: z.boolean(),
      closed: z.boolean(),
      error: z.string().nullable(),
    }),
    handler: async (
      ctx,
      args,
    ): Promise<{
      ok: boolean;
      closed: boolean;
      error: string | null;
    }> => {
      const db = ctx.db<typeof schema>();
      const lineRows = await db
        .select()
        .from(schema.bitRequisitionLines)
        .where(eq(schema.bitRequisitionLines.id, args.lineId));
      const line = lineRows[0];
      if (!line) {
        return { ok: false, closed: false, error: "That line is gone." };
      }
      const reqRows = await db
        .select()
        .from(schema.bitRequisitions)
        .where(eq(schema.bitRequisitions.id, line.requisitionId));
      const req = reqRows[0];
      if (!req || req.status !== "outstanding") {
        return {
          ok: false,
          closed: false,
          error: "That requisition is already closed.",
        };
      }
      if (line.status !== "pending") {
        return {
          ok: false,
          closed: false,
          error: "That line is already checked off.",
        };
      }
      const receivedQty =
        args.outcome === "received"
          ? (args.qtyReceived ?? line.qtyOrdered)
          : null;
      // Attribution (audit #5): the check-off records the acting
      // role on the line (its Undo follows it) and on the stock
      // event a receipt logs.
      const { role } = await loadAccountSettings(ctx);
      await db
        .update(schema.bitRequisitionLines)
        .set({
          status: args.outcome,
          qtyReceived: receivedQty,
          checkedOffBy: role,
          checkedOffAt: new Date(),
        })
        .where(eq(schema.bitRequisitionLines.id, line.id));
      // Received supplies go onto the station stock.
      if (args.outcome === "received" && line.itemId != null) {
        const itemRows = await db
          .select()
          .from(schema.bitItems)
          .where(eq(schema.bitItems.id, line.itemId));
        const item = itemRows[0];
        if (item) {
          await db
            .update(schema.bitItems)
            .set({ onHand: item.onHand + (receivedQty ?? 0) })
            .where(eq(schema.bitItems.id, item.id));
          // Trend collection (Alpha 0.79): the receipt is logged
          // as a dated stock-in event so usage between checks can
          // be computed (previous count + receipts − current
          // count).
          if ((receivedQty ?? 0) !== 0) {
            await db.insert(schema.bitStockEvents).values({
              businessId: item.businessId,
              itemId: item.id,
              itemName: item.name,
              delta: receivedQty ?? 0,
              source: "requisition_received",
              actor: role,
            });
          }
        }
      }
      // Completing the check-off closes the requisition; it stays
      // on file in the history.
      const remaining = await db
        .select()
        .from(schema.bitRequisitionLines)
        .where(
          and(
            eq(schema.bitRequisitionLines.requisitionId, req.id),
            eq(schema.bitRequisitionLines.status, "pending"),
          ),
        );
      let closed = false;
      if (remaining.length === 0) {
        await db
          .update(schema.bitRequisitions)
          .set({ status: "closed", closedAt: new Date() })
          .where(eq(schema.bitRequisitions.id, req.id));
        closed = true;
      }
      ctx.invalidateQueries();
      return { ok: true, closed, error: null };
    },
  }),

  undoBitRequisitionCheckOff: defineAction({
    description:
      "Undoes one requisition line's delivery check-off (Beta 0.01 batch, audit #5): the line returns to 'pending' with no received quantity, and a 'received' mark's stock is taken back off the tracked item (its requisition_received stock event is marked undone too, so Trends' usage math stays exact). If the check-off had closed the requisition, the requisition reopens as outstanding. A line already resubmitted onto a newer requisition can't be undone (the newer requisition carries it now), and a closed requisition can't reopen while another requisition is outstanding.",
    request: z.object({ lineId: z.number().int().positive() }),
    response: z.object({
      ok: z.boolean(),
      reopened: z.boolean(),
      error: z.string().nullable(),
    }),
    handler: async (ctx, args) =>
      await performUndoBitRequisitionCheckOff(ctx, args.lineId),
  }),

  removeBitRequisitionDraftExtra: defineAction({
    description:
      "Removes one catalogue draft extra from the requisition currently being built.",
    request: z.object({ id: z.number().int().positive() }),
    response: z.object({ ok: z.literal(true) }),
    handler: async (ctx, args): Promise<{ ok: true }> => {
      const db = ctx.db<typeof schema>();
      await db
        .delete(schema.bitRequisitionDraftExtras)
        .where(eq(schema.bitRequisitionDraftExtras.id, args.id));
      ctx.invalidateQueries();
      return { ok: true as const };
    },
  }),

  completeBitSetup: defineAction({
    description:
      "Finishes the BIT Business setup wizard by creating a BRAND-NEW business: stores the new business's profile (type, custom type for 'Other', name, the chosen categories — the only organizing concept — freezers, category colours) and seeds its inventory with the supplied starter-pack items already merged with any manifest lines confirmed in the wizard. Only the categories the user actually picked are stored, and only items in those categories are seeded — a completed setup stores exactly the picked set, nothing more. Setup is add-only (Alpha 0.88): it ALWAYS inserts a new business and returns its id; it never updates, replaces, or deletes an existing business's profile or inventory, and it never touches any household (HIT) data. Pass
      usesRequisition true when the business orders by requisition —
      the wizard's Review step asks — and the business gets the
      Requisition tab instead of the Order Email tab.",
    request: z.object({
      businessType: z.string().min(1).max(80),
      customType: z.string().max(120).nullable(),
      name: z.string().min(1).max(120),
      // Team size from the wizard's team-size step (Alpha 0.90):
      // one of the eight bands or a custom Other entry; null when
      // the step was skipped.
      teamSize: z.string().max(60).nullable().default(null),
      // Whether this business orders by requisition (the wizard's
      // Review step asks): true gives it the Requisition tab with
      // the preparer / approver flow instead of the Order Email tab.
      usesRequisition: z.boolean().default(false),
      categories: z.array(z.string().min(1).max(120)).max(24),
      freezers: z.array(z.string().min(1).max(80)).max(12),
      colors: z.record(z.string(), z.string()),
      items: z
        .array(
          z.object({
            name: z.string().min(1).max(200),
            category: z.string().min(1).max(120),
            zone: z.string().min(1).max(80),
            onHand: z.number().int().min(0).max(100000),
            unit: z.string().min(1).max(60),
            par: z.number().int().min(0).max(100000),
            packSize: z.number().int().min(1).max(100000),
            supplier: z.string().max(200).nullable(),
            sku: z.string().max(80).nullable(),
            tags: z.array(z.string().max(60)).max(8),
          }),
        )
        .max(400),
    }),
    response: z.object({
      ok: z.literal(true),
      businessId: z.number(),
      itemCount: z.number(),
    }),
    handler: async (
      ctx,
      args,
    ): Promise<{ ok: true; businessId: number; itemCount: number }> => {
      const db = ctx.db<typeof schema>();
      // Dedupe by name (case-insensitive); the LAST occurrence wins,
      // so manifest-confirmed lines the wizard merged after the pack
      // override the pack's own counts.
      const byName = new Map<
        string,
        (typeof args.items)[number] & { order: number }
      >();
      args.items.forEach((it, i) => {
        byName.set(it.name.trim().toLowerCase(), { ...it, order: i });
      });
      const deduped = [...byName.values()].sort((a, b) => a.order - b.order);
      // Only the categories the user actually picked are stored,
      // and only items in those categories are seeded: items in any
      // other category are dropped here as well as in the wizard,
      // so a completed setup stores exactly the picked set, nothing
      // more. (An empty picked set seeds no items at all.)
      const groupSet = new Set(args.categories);
      const items = deduped.filter((it) =>
        groupSet.has(it.category.trim()),
      );
      // Setup is add-only (Alpha 0.88): finishing the wizard
      // ALWAYS creates a brand-new business alongside any existing
      // ones. There is deliberately no update/replace path here —
      // an existing business's profile and inventory can never be
      // overwritten or wiped by setup.
      const profile = {
        businessType: args.businessType,
        customType: args.customType,
        name: args.name,
        teamSize: args.teamSize?.trim() ? args.teamSize.trim() : null,
        // Categories are the only organizing concept; the
        // legacy zone list and organizing-axis columns are kept
        // in step with the categories so stored data stays
        // consistent.
        zonesJson: JSON.stringify(args.categories),
        organizeBy: "category" as const,
        categoriesJson: JSON.stringify(args.categories),
        // Freezer checks are only for food & beverage businesses.
        freezersJson: JSON.stringify(
          isBitFoodAndBeverageType(args.businessType) ? args.freezers : [],
        ),
        colorsJson: JSON.stringify(args.colors),
        usesRequisition: args.usesRequisition ? 1 : 0,
        updatedAt: new Date(),
      };
      const insertedBiz = await db
        .insert(schema.bitBusiness)
        .values(profile)
        .returning({ id: schema.bitBusiness.id });
      const row = insertedBiz[0];
      if (!row) throw new Error("completeBitSetup: no business row");
      const businessId = row.id;
      const statements: BatchItem<"sqlite">[] = [];
      items.forEach((it, i) => {
        statements.push(
          db.insert(schema.bitItems).values({
            businessId,
            name: it.name.trim(),
            category: it.category.trim(),
            zone: it.zone.trim(),
            onHand: it.onHand,
            unit: it.unit,
            par: it.par,
            packSize: it.packSize,
            supplier: it.supplier,
            sku: it.sku,
            tagsJson: JSON.stringify(it.tags),
            sortOrder: i,
          }),
        );
      });
      if (statements.length > 0) {
        const [first, ...rest] = statements;
        if (first) await db.batch([first, ...rest]);
      }
      ctx.invalidateQueries();
      return { ok: true as const, businessId, itemCount: items.length };
    },
  }),

  addBitItem: defineAction({
    description:
      "Adds one item to the BIT inventory from the Inventory tab's Add Item form. Item names are unique case-insensitively: a duplicate name is rejected with an error and nothing is saved.",
    request: z.object({
      businessId: bitBusinessIdRequest,
      name: z.string().min(1).max(200),
      category: z.string().min(1).max(120),
      zone: z.string().min(1).max(80),
      onHand: z.number().int().min(0).max(100000),
      unit: z.string().min(1).max(60),
      par: z.number().int().min(0).max(100000),
      packSize: z.number().int().min(1).max(100000),
      supplier: z.string().max(200).nullable(),
      sku: z.string().max(80).nullable(),
    }),
    response: z.object({
      ok: z.boolean(),
      id: z.number().nullable(),
      error: z.string().nullable(),
    }),
    handler: async (
      ctx,
      args,
    ): Promise<{ ok: boolean; id: number | null; error: string | null }> => {
      const db = ctx.db<typeof schema>();
      const biz = await resolveBitBusiness(ctx, args.businessId);
      if (!biz) {
        return {
          ok: false,
          id: null,
          error: "Set up the business before adding items.",
        };
      }
      const existing = await db
        .select()
        .from(schema.bitItems)
        .where(eq(schema.bitItems.businessId, biz.id));
      const wanted = args.name.trim().toLowerCase();
      if (existing.some((r) => r.name.trim().toLowerCase() === wanted)) {
        return {
          ok: false,
          id: null,
          error: "An item with that name is already in the inventory.",
        };
      }
      const maxOrder = existing.reduce(
        (m, r) => Math.max(m, r.sortOrder),
        -1,
      );
      const inserted = await db
        .insert(schema.bitItems)
        .values({
          businessId: biz.id,
          name: args.name.trim(),
          category: args.category.trim(),
          zone: args.zone.trim(),
          onHand: args.onHand,
          unit: args.unit,
          par: args.par,
          packSize: args.packSize,
          supplier: args.supplier,
          sku: args.sku,
          tagsJson: "[]",
          sortOrder: maxOrder + 1,
        })
        .returning({ id: schema.bitItems.id });
      const row = inserted[0];
      if (!row) throw new Error("addBitItem: insert returned no rows");
      ctx.invalidateQueries();
      return { ok: true, id: row.id, error: null };
    },
  }),

  setBitItemCount: defineAction({
    description:
      "Sets one BIT inventory item's on-hand count directly (the Inventory tab's − / + steppers). Rounds write counts back through finishBitRound instead. The value is rounded the way the item's business counts: whole numbers normally, tenths for a fractional-counting (Bar / Pub profile) business, so a stepper tap on a 0.7 bottle lands on 1.7 or stays exact rather than being rejected.",
    request: z.object({
      itemId: z.number().int().positive(),
      onHand: z.number().min(0).max(100000),
    }),
    response: z.object({ ok: z.literal(true) }),
    handler: async (ctx, args): Promise<{ ok: true }> => {
      const db = ctx.db<typeof schema>();
      const itemRows = await db
        .select()
        .from(schema.bitItems)
        .where(eq(schema.bitItems.id, args.itemId));
      const item = itemRows[0];
      const biz = item
        ? await resolveBitBusiness(ctx, item.businessId)
        : undefined;
      const profile = biz
        ? bitNeedsProfileFor(biz.businessType)
        : BIT_NO_NEEDS;
      const newOnHand = bitRoundCount(profile, args.onHand);
      await db
        .update(schema.bitItems)
        .set({ onHand: newOnHand })
        .where(eq(schema.bitItems.id, args.itemId));
      // Trend collection (Alpha 0.79): a count changed outside a
      // check is logged as a dated stock event so usage between
      // checks can be computed (previous count + receipts −
      // current count).
      if (item && newOnHand !== item.onHand) {
        const { role } = await loadAccountSettings(ctx);
        await db.insert(schema.bitStockEvents).values({
          businessId: item.businessId,
          itemId: item.id,
          itemName: item.name,
          delta: newOnHand - item.onHand,
          source: "manual_count",
          actor: role,
        });
      }
      ctx.invalidateQueries();
      return { ok: true as const };
    },
  }),

  undoBitStockEvent: defineAction({
    description:
      "Undoes one Inventory-tab count change (a manual_count stock event, Beta 0.01 batch, audit #5): reverses the event's delta on the item's on-hand count, restoring the count from before that change, and marks the event undone so Trends' usage math excludes it. Requisition receipts are not undone here — their Undo is the requisition line's check-off Undo. Already-undone events, and events whose item is no longer tracked, report an error and change nothing.",
    request: z.object({ id: z.number().int().positive() }),
    response: z.object({
      ok: z.boolean(),
      error: z.string().nullable(),
    }),
    handler: async (ctx, args) =>
      await performUndoBitStockEvent(ctx, args.id),
  }),

  setBitItemPar: defineAction({
    description:
      "Sets the par level (the inventory threshold) of one existing BIT inventory item (Alpha 0.79). Par was previously write-once at item creation; this is the editor behind the Inventory Checks Finish summary's per-item Par fields and the Inventory tab's tappable 'Par N'. Par must be a whole number ≥ 0; 0 means no threshold set (the item never auto-appears on a requisition / order build).",
    request: z.object({
      itemId: z.number().int().positive(),
      par: z.number().int().min(0).max(100000),
    }),
    response: z.object({ ok: z.literal(true) }),
    handler: async (ctx, args): Promise<{ ok: true }> => {
      const db = ctx.db<typeof schema>();
      await db
        .update(schema.bitItems)
        .set({ par: args.par })
        .where(eq(schema.bitItems.id, args.itemId));
      ctx.invalidateQueries();
      return { ok: true as const };
    },
  }),

  setBitItemExpiry: defineAction({
    description:
      "Sets or clears the optional expiry date of one BIT inventory item (Alpha 0.75 expiry tracking). Pass a 'YYYY-MM-DD' date to set it, or null to clear it. Only items of a business whose needs profile includes expiry tracking (Ice Cream Shop, Restaurant, Bakery, Café / Coffee Shop, Food Truck) accept a date; anything else is refused and nothing is saved.",
    request: z.object({
      itemId: z.number().int().positive(),
      date: z
        .string()
        .regex(/^\d{4}-\d{2}-\d{2}$/, "Date must be YYYY-MM-DD")
        .nullable(),
    }),
    response: z.object({
      ok: z.boolean(),
      error: z.string().nullable(),
    }),
    handler: async (
      ctx,
      args,
    ): Promise<{ ok: boolean; error: string | null }> => {
      const db = ctx.db<typeof schema>();
      const itemRows = await db
        .select()
        .from(schema.bitItems)
        .where(eq(schema.bitItems.id, args.itemId));
      const item = itemRows[0];
      if (!item) {
        return { ok: false, error: "That item isn't in the inventory." };
      }
      const biz = await resolveBitBusiness(ctx, item.businessId);
      if (!biz || !bitNeedsProfileFor(biz.businessType).expiryTracking) {
        return {
          ok: false,
          error: "This business doesn't track expiry dates.",
        };
      }
      if (args.date != null) {
        // Reject impossible dates (e.g. 2026-02-31) the regex lets
        // through: parse and compare the round-trip.
        const parsed = new Date(`${args.date}T00:00:00`);
        if (
          Number.isNaN(parsed.getTime()) ||
          parsed.toISOString().slice(0, 10) !== args.date
        ) {
          return { ok: false, error: "That isn't a real calendar date." };
        }
      }
      await db
        .update(schema.bitItems)
        .set({ expiryDate: args.date })
        .where(eq(schema.bitItems.id, item.id));
      ctx.invalidateQueries();
      return { ok: true, error: null };
    },
  }),

  logBitWaste: defineAction({
    description:
      "Records one waste entry for a Restaurant-profile business (Alpha 0.75 waste log): the quantity is deducted from the item's on-hand count (never below zero) and the entry — item, quantity, reason (Spoilage / Expired / Breakage / Other) — is kept in the business's waste history. Businesses without the waste-log profile are refused and nothing is saved or deducted.",
    request: z.object({
      businessId: bitBusinessIdRequest,
      itemId: z.number().int().positive(),
      quantity: z.number().int().min(1).max(100000),
      reason: z.enum(["Spoilage", "Expired", "Breakage", "Other"]),
    }),
    response: z.object({
      ok: z.boolean(),
      error: z.string().nullable(),
      onHand: z.number().nullable(),
    }),
    handler: async (
      ctx,
      args,
    ): Promise<{
      ok: boolean;
      error: string | null;
      onHand: number | null;
    }> => {
      const db = ctx.db<typeof schema>();
      const biz = await resolveBitBusiness(ctx, args.businessId);
      if (!biz) {
        return {
          ok: false,
          error: "Set up the business before logging waste.",
          onHand: null,
        };
      }
      if (!bitNeedsProfileFor(biz.businessType).wasteLog) {
        return {
          ok: false,
          error: "This business doesn't have a waste log.",
          onHand: null,
        };
      }
      const itemRows = await db
        .select()
        .from(schema.bitItems)
        .where(
          and(
            eq(schema.bitItems.id, args.itemId),
            eq(schema.bitItems.businessId, biz.id),
          ),
        );
      const item = itemRows[0];
      if (!item) {
        return {
          ok: false,
          error: "That item isn't in this business's inventory.",
          onHand: null,
        };
      }
      const onHand = Math.max(0, item.onHand - args.quantity);
      await db
        .update(schema.bitItems)
        .set({ onHand })
        .where(eq(schema.bitItems.id, item.id));
      const { role } = await loadAccountSettings(ctx);
      await db.insert(schema.bitWasteLog).values({
        businessId: biz.id,
        itemId: item.id,
        itemName: item.name,
        unit: item.unit,
        quantity: args.quantity,
        reason: args.reason,
        actor: role,
        // The amount actually deducted (the clamp at zero can
        // make it less than the quantity logged) — the entry's
        // Undo restores exactly this.
        stockDeducted: item.onHand - onHand,
      });
      ctx.invalidateQueries();
      return { ok: true, error: null, onHand };
    },
  }),

  undoBitWaste: defineAction({
    description:
      "Undoes one BIT waste log entry (Beta 0.01 batch, audit #5): restores exactly the stock the entry deducted to the item's on-hand count and marks the entry undone — it stays in the waste history, marked Undone. Entries logged before the actual deducted amount was recorded restore their logged quantity. An already-undone entry reports an error and changes nothing; if the item itself is gone, the entry is still marked undone and no stock is restored.",
    request: z.object({ id: z.number().int().positive() }),
    response: z.object({
      ok: z.boolean(),
      error: z.string().nullable(),
      onHand: z.number().nullable(),
    }),
    handler: async (ctx, args) => await performUndoBitWaste(ctx, args.id),
  }),

  renameBitCategory: defineAction({
    description:
      "Renames a BIT inventory category, or merges it into another category when the new name matches an existing one: every item in the old category moves to the new name and the category's colour follows it.",
    request: z.object({
      businessId: bitBusinessIdRequest,
      from: z.string().min(1).max(120),
      to: z.string().min(1).max(120),
    }),
    response: z.object({ ok: z.literal(true), updated: z.number() }),
    handler: async (
      ctx,
      args,
    ): Promise<{ ok: true; updated: number }> => {
      const db = ctx.db<typeof schema>();
      const from = args.from.trim();
      const to = args.to.trim();
      const biz = await resolveBitBusiness(ctx, args.businessId);
      const items = biz
        ? await db
            .select()
            .from(schema.bitItems)
            .where(
              and(
                eq(schema.bitItems.businessId, biz.id),
                eq(schema.bitItems.category, from),
              ),
            )
        : [];
      if (from !== to && items.length > 0 && biz) {
        await db
          .update(schema.bitItems)
          .set({ category: to })
          .where(
            and(
              eq(schema.bitItems.businessId, biz.id),
              eq(schema.bitItems.category, from),
            ),
          );
        if (biz) {
          const colors = bitParseColors(biz.colorsJson);
          const moved = colors[from];
          if (moved != null) {
            delete colors[from];
            if (colors[to] == null) colors[to] = moved;
            await db
              .update(schema.bitBusiness)
              .set({ colorsJson: JSON.stringify(colors), updatedAt: new Date() })
              .where(eq(schema.bitBusiness.id, biz.id));
          }
        }
      }
      ctx.invalidateQueries();
      return { ok: true as const, updated: from === to ? 0 : items.length };
    },
  }),

  addBitGroup: defineAction({
    description:
      "Adds one new category to the BIT business from the Inventory tab's Add Category panel: the name is appended to the business's categories, so it appears as a (for now empty) category group in the Inventory tab, as a choice in the Add Item form's category list, and in the Inventory Checks category filter. Category names are unique case-insensitively: a duplicate name is rejected with an error and nothing is saved.",
    request: z.object({
      businessId: bitBusinessIdRequest,
      name: z.string().min(1).max(120),
    }),
    response: z.object({
      ok: z.boolean(),
      error: z.string().nullable(),
    }),
    handler: async (
      ctx,
      args,
    ): Promise<{ ok: boolean; error: string | null }> => {
      const db = ctx.db<typeof schema>();
      const biz = await resolveBitBusiness(ctx, args.businessId);
      if (!biz) {
        return {
          ok: false,
          error: "Set up the business before adding categories.",
        };
      }
      const name = args.name.trim();
      const groups = bitBusinessCategories(biz);
      if (
        groups.some((g) => g.trim().toLowerCase() === name.toLowerCase())
      ) {
        return {
          ok: false,
          error: "A category with that name already exists.",
        };
      }
      // The legacy zone list is kept in step with the categories
      // (the two are one list now): append to each stored list
      // that doesn't already hold the name.
      const appendUnique = (list: string[]) =>
        list.some(
          (g) => g.trim().toLowerCase() === name.toLowerCase(),
        )
          ? list
          : [...list, name];
      await db
        .update(schema.bitBusiness)
        .set({
          categoriesJson: JSON.stringify(
            appendUnique(bitParseStringArray(biz.categoriesJson)),
          ),
          zonesJson: JSON.stringify(
            appendUnique(bitParseStringArray(biz.zonesJson)),
          ),
          updatedAt: new Date(),
        })
        .where(eq(schema.bitBusiness.id, biz.id));
      ctx.invalidateQueries();
      return { ok: true, error: null };
    },
  }),

  finishBitRound: defineAction({
    description:
      "Finishes a BIT inventory check (a round): writes each counted item's count back as its new on-hand (book) count, and records the check — who counted (for a requisition business, the shift letter instead of a name, stored in the same counter field and displayed as 'Shift A'), the category filter, counted-of-total, every variance (counted vs the previous book count), the items left at or below par, and the freezer temperature readings (anything warmer than −18°C flagged as an alert; recorded only for food & beverage businesses). Counts are rounded to tenths for a fractional-counting (Bar / Pub profile) business and to whole numbers for every other business. Returns that same summary for the Inventory Checks tab to display. Since Alpha 0.79 it also writes one bit_item_snapshots row for EVERY counted item (name, category, book count before the check, counted value, par at the time, round id) — the per-item count history behind the Trends view — and returns those counted items so the Finish summary can offer a par editor per item. Alpha 0.82: each counted item also carries its snapshot id so the summary can record a variance reason (setBitVarianceReason) or submit the one blind recount (recountBitItem) for that item's round record. Alpha 0.85: when the request carries itemIds (a weekly cycle-count check started from getBitWeeklyCount's proposal), the check is scoped to exactly that item set — its counted-of total is the set's size and counts for items outside the set are ignored; snapshots are written as usual, which is what advances each item's cycle schedule.",
    request: z.object({
      businessId: bitBusinessIdRequest,
      counterName: z.string().min(1).max(80),
      zoneFilter: z.string().max(80).nullable(),
      // Alpha 0.85: a weekly cycle-count check sends the exact
      // proposed item set; the check's scope (and its counted-of
      // total) is that set. Null/absent = the normal category
      // scope, unchanged.
      itemIds: z
        .array(z.number().int().positive())
        .max(5000)
        .nullable()
        .optional(),
      counts: z
        .array(
          z.object({
            itemId: z.number().int().positive(),
            // A count is a whole number for every business except
            // a fractional-counting one (Bar / Pub profile, Alpha
            // 0.75), whose open bottles / kegs are counted in
            // tenths; the handler rounds each count the way the
            // business's profile counts.
            counted: z.number().min(0).max(100000),
          }),
        )
        .max(500),
      freezerTemps: z
        .array(
          z.object({
            freezer: z.string().min(1).max(80),
            tempC: z.number().min(-80).max(60).nullable(),
          }),
        )
        .max(12),
    }),
    response: z.object({
      ok: z.literal(true),
      roundId: z.number(),
      counted: z.number(),
      total: z.number(),
      variances: z.array(bitVarianceShape),
      belowPar: z.array(
        z.object({ name: z.string(), onHand: z.number(), par: z.number() }),
      ),
      freezerReadings: z.array(bitFreezerReadingShape),
      // Every counted item (Alpha 0.79), so the Finish summary
      // can list book → counted with an editable par per item.
      // Alpha 0.82 adds the snapshot id plus the variance-reason /
      // recount state, so the summary's reason picker and blind
      // recount write straight onto the item's snapshot.
      countedItems: z.array(
        z.object({
          itemId: z.number(),
          snapshotId: z.number(),
          name: z.string(),
          category: z.string(),
          book: z.number(),
          counted: z.number(),
          par: z.number(),
          varianceReason: z.string().nullable(),
          recounted: z.boolean(),
        }),
      ),
    }),
    handler: async (
      ctx,
      args,
    ): Promise<{
      ok: true;
      roundId: number;
      counted: number;
      total: number;
      variances: z.infer<typeof bitVarianceShape>[];
      belowPar: { name: string; onHand: number; par: number }[];
      freezerReadings: z.infer<typeof bitFreezerReadingShape>[];
      countedItems: {
        itemId: number;
        snapshotId: number;
        name: string;
        category: string;
        book: number;
        counted: number;
        par: number;
        varianceReason: string | null;
        recounted: boolean;
      }[];
    }> => {
      const db = ctx.db<typeof schema>();
      const scopeBiz = await resolveBitBusiness(ctx, args.businessId);
      const allItems = scopeBiz
        ? await db
            .select()
            .from(schema.bitItems)
            .where(eq(schema.bitItems.businessId, scopeBiz.id))
        : [];
      const byId = new Map(allItems.map((r) => [r.id, { ...r }]));
      // The check's filter names one of the business's
      // categories (the filter value travels in the zoneFilter
      // field — its stored name predates categories-only); an
      // item's group is its category (for a business set up under
      // the old zone choice, its stored zone value).
      // Alpha 0.85: a weekly cycle-count check is scoped to
      // exactly its proposed item set when one is sent.
      const weeklySet =
        args.itemIds && args.itemIds.length > 0
          ? new Set(args.itemIds)
          : null;
      const scope = weeklySet
        ? allItems.filter((r) => weeklySet.has(r.id))
        : args.zoneFilter
          ? allItems.filter(
              (r) => bitRowGroup(r, scopeBiz) === args.zoneFilter,
            )
          : allItems;
      const variances: z.infer<typeof bitVarianceShape>[] = [];
      const statements: BatchItem<"sqlite">[] = [];
      // Counts are stored the way this business counts: tenths
      // for a fractional-counting (Bar / Pub) business, whole
      // numbers for everyone else (unchanged behaviour there).
      const countProfile = scopeBiz
        ? bitNeedsProfileFor(scopeBiz.businessType)
        : BIT_NO_NEEDS;
      let counted = 0;
      // One entry per counted item (Alpha 0.79): the snapshot
      // rows written for the Trends history and the counted-items
      // list the Finish summary renders with par editors. The
      // book count and par are captured BEFORE the count is
      // written back.
      const countedItems: {
        itemId: number;
        snapshotId: number;
        name: string;
        category: string;
        book: number;
        counted: number;
        par: number;
        varianceReason: string | null;
        recounted: boolean;
      }[] = [];
      for (const c of args.counts) {
        const item = byId.get(c.itemId);
        if (!item) continue;
        // A weekly cycle-count check counts only its proposed
        // set, even if extra counts were sent.
        if (weeklySet && !weeklySet.has(c.itemId)) continue;
        counted += 1;
        const countedValue = bitRoundCount(countProfile, c.counted);
        countedItems.push({
          itemId: item.id,
          // Filled in once the snapshot row is inserted below.
          snapshotId: 0,
          name: item.name,
          category: bitRowGroup(item, scopeBiz),
          book: item.onHand,
          counted: countedValue,
          par: item.par,
          varianceReason: null,
          recounted: false,
        });
        if (countedValue !== item.onHand) {
          variances.push({
            item: item.name,
            book: item.onHand,
            counted: countedValue,
          });
        }
        item.onHand = countedValue;
        statements.push(
          db
            .update(schema.bitItems)
            .set({ onHand: countedValue })
            .where(eq(schema.bitItems.id, item.id)),
        );
      }
      const belowPar = [...byId.values()]
        .filter((r) => r.onHand <= r.par)
        .map((r) => ({ name: r.name, onHand: r.onHand, par: r.par }));
      // Freezer readings are recorded only for food & beverage
      // businesses; any temperatures sent for another type are
      // ignored so no freezer check appears in its summaries or
      // order email.
      const bizType = scopeBiz?.businessType ?? "";
      const freezerReadings: z.infer<typeof bitFreezerReadingShape>[] =
        isBitFoodAndBeverageType(bizType)
          ? args.freezerTemps.map((f) => ({
              freezer: f.freezer,
              tempC: f.tempC,
              alert: f.tempC != null && f.tempC > -18,
            }))
          : [];
      const inserted = await db
        .insert(schema.bitRounds)
        .values({
          businessId: scopeBiz?.id ?? 1,
          counterName: args.counterName.trim(),
          zoneFilter: args.zoneFilter,
          counted,
          total: scope.length,
          variancesJson: JSON.stringify(variances),
          belowParJson: JSON.stringify(belowPar.map((b) => b.name)),
          freezerJson: JSON.stringify(
            freezerReadings.map((f) => ({
              freezer: f.freezer,
              tempC: f.tempC,
            })),
          ),
        })
        .returning({ id: schema.bitRounds.id });
      const round = inserted[0];
      if (!round) throw new Error("finishBitRound: insert returned no rows");
      // Trend collection (Alpha 0.79): one snapshot row for
      // EVERY counted item — not just the variances — batched
      // with the on-hand write-backs. The snapshot ids are read
      // back afterwards so the Finish summary's variance-reason
      // picker and blind recount (Alpha 0.82) can write onto
      // each item's snapshot.
      for (const ci of countedItems) {
        statements.push(
          db.insert(schema.bitItemSnapshots).values({
            businessId: scopeBiz?.id ?? 1,
            itemId: ci.itemId,
            itemName: ci.name,
            category: ci.category,
            bookCount: ci.book,
            counted: ci.counted,
            par: ci.par,
            roundId: round.id,
          }),
        );
      }
      if (statements.length > 0) {
        const [first, ...rest] = statements;
        if (first) await db.batch([first, ...rest]);
      }
      const snapshotRows = await db
        .select({
          id: schema.bitItemSnapshots.id,
          itemId: schema.bitItemSnapshots.itemId,
        })
        .from(schema.bitItemSnapshots)
        .where(eq(schema.bitItemSnapshots.roundId, round.id));
      const snapshotIdByItem = new Map(
        snapshotRows.map((s) => [s.itemId, s.id]),
      );
      for (const ci of countedItems) {
        ci.snapshotId = snapshotIdByItem.get(ci.itemId) ?? 0;
      }
      ctx.invalidateQueries();
      return {
        ok: true as const,
        roundId: round.id,
        counted,
        total: scope.length,
        variances,
        belowPar,
        freezerReadings,
        countedItems,
      };
    },
  }),

  setBitVarianceReason: defineAction({
    description:
      "Records (or clears, with null) the reason for one BIT check variance (Alpha 0.82): one of Used / Damaged / Expired / Missing / Counting error, written onto the counted item's bit_item_snapshots row for that round from the Inventory Checks Finish summary. Write-through and never blocking — a variance may simply be left without a reason. Only a snapshot whose counted value differs from its book count accepts a reason.",
    request: z.object({
      snapshotId: z.number().int().positive(),
      reason: z
        .enum(["Used", "Damaged", "Expired", "Missing", "Counting error"])
        .nullable(),
    }),
    response: z.object({
      ok: z.boolean(),
      error: z.string().nullable(),
    }),
    handler: async (
      ctx,
      args,
    ): Promise<{ ok: boolean; error: string | null }> => {
      const db = ctx.db<typeof schema>();
      const rows = await db
        .select()
        .from(schema.bitItemSnapshots)
        .where(eq(schema.bitItemSnapshots.id, args.snapshotId));
      const snap = rows[0];
      if (!snap) {
        return { ok: false, error: "That count record is gone." };
      }
      if (args.reason != null && snap.counted === snap.bookCount) {
        return {
          ok: false,
          error: "That count matched the book count — no variance to explain.",
        };
      }
      await db
        .update(schema.bitItemSnapshots)
        .set({ varianceReason: args.reason })
        .where(eq(schema.bitItemSnapshots.id, snap.id));
      ctx.invalidateQueries();
      return { ok: true, error: null };
    },
  }),

  recountBitItem: defineAction({
    description:
      "Submits the one blind recount allowed per item per BIT check round (Alpha 0.82), prompted on the Finish summary when a variance is large (|counted − book| ≥ 5 units or ≥ 25% of book). The recount value replaces the item's counted value for the round: the item's on-hand, its bit_item_snapshots row for the round, and the round's stored variance / below-par summary are all recomputed; any reason recorded for the old variance is cleared (the reason picker then applies to the new variance, if one remains). The book count is never changed, and a second recount for the same item and round is refused. The value is rounded the way the business counts (tenths for a fractional-counting business, whole numbers otherwise).",
    request: z.object({
      snapshotId: z.number().int().positive(),
      counted: z.number().min(0).max(100000),
    }),
    response: z.object({
      ok: z.boolean(),
      error: z.string().nullable(),
      counted: z.number().nullable(),
      variances: z.array(bitVarianceShape),
      belowPar: z.array(
        z.object({ name: z.string(), onHand: z.number(), par: z.number() }),
      ),
    }),
    handler: async (
      ctx,
      args,
    ): Promise<{
      ok: boolean;
      error: string | null;
      counted: number | null;
      variances: z.infer<typeof bitVarianceShape>[];
      belowPar: { name: string; onHand: number; par: number }[];
    }> => {
      const db = ctx.db<typeof schema>();
      const fail = (error: string) => ({
        ok: false,
        error,
        counted: null,
        variances: [],
        belowPar: [],
      });
      const snapRows = await db
        .select()
        .from(schema.bitItemSnapshots)
        .where(eq(schema.bitItemSnapshots.id, args.snapshotId));
      const snap = snapRows[0];
      if (!snap) return fail("That count record is gone.");
      if (snap.recounted === 1) {
        return fail("This item was already recounted for this check.");
      }
      const biz = await resolveBitBusiness(ctx, snap.businessId);
      const countProfile = biz
        ? bitNeedsProfileFor(biz.businessType)
        : BIT_NO_NEEDS;
      const newCounted = bitRoundCount(countProfile, args.counted);
      const statements: BatchItem<"sqlite">[] = [
        db
          .update(schema.bitItemSnapshots)
          .set({
            counted: newCounted,
            recounted: 1,
            // The reason described the old variance; the picker
            // now applies to whatever variance remains.
            varianceReason: null,
          })
          .where(eq(schema.bitItemSnapshots.id, snap.id)),
      ];
      if (snap.itemId != null) {
        statements.push(
          db
            .update(schema.bitItems)
            .set({ onHand: newCounted })
            .where(eq(schema.bitItems.id, snap.itemId)),
        );
      }
      // Recompute the round's stored summary from its snapshots
      // (variances) and the business's items (below par, with
      // this item's new on-hand applied).
      const roundSnaps = await db
        .select()
        .from(schema.bitItemSnapshots)
        .where(eq(schema.bitItemSnapshots.roundId, snap.roundId));
      const variances: z.infer<typeof bitVarianceShape>[] = [];
      for (const s of roundSnaps) {
        const c = s.id === snap.id ? newCounted : s.counted;
        if (c !== s.bookCount) {
          variances.push({ item: s.itemName, book: s.bookCount, counted: c });
        }
      }
      const bizItems = biz
        ? await db
            .select()
            .from(schema.bitItems)
            .where(eq(schema.bitItems.businessId, biz.id))
        : [];
      const belowPar = bizItems
        .map((r) => ({
          name: r.name,
          onHand: r.id === snap.itemId ? newCounted : r.onHand,
          par: r.par,
        }))
        .filter((r) => r.onHand <= r.par);
      statements.push(
        db
          .update(schema.bitRounds)
          .set({
            variancesJson: JSON.stringify(variances),
            belowParJson: JSON.stringify(belowPar.map((b) => b.name)),
          })
          .where(eq(schema.bitRounds.id, snap.roundId)),
      );
      const [first, ...rest] = statements;
      if (first) await db.batch([first, ...rest]);
      ctx.invalidateQueries();
      return {
        ok: true,
        error: null,
        counted: newCounted,
        variances,
        belowPar,
      };
    },
  }),

  getBitTrends: defineAction({
    description:
      "Reads the BIT Trends view data for one business (Alpha 0.79): the per-item count history collected by finishBitRound (bit_item_snapshots — one row per counted item per finished check, starting with the first check finished after Alpha 0.79; nothing is backfilled) plus the dated stock events logged outside checks (bit_stock_events). Per item it returns its checks over time (book, counted, par at the time), total usage between checks (previous count + stock-in events − current count, summed over consecutive check pairs), how many checks varied from book, how many checks landed at or below par, and a par suggestion (the largest single between-checks usage, rounded up — a suggestion only, never applied). hasHistory is false until the first check is finished, and the client shows an honest empty state. Alpha 0.82: each check entry also carries its recorded variance reason and recount flag, and the repeated-variances list carries each item's recorded reasons with counts. Alpha 0.84: each item also carries a days-of-cover forecast when it honestly can have one — at least two counts on different days (UTC calendar days between the first and last count) and positive total usage over that span: avgDailyUsage = usageTotal ÷ span days, daysOfCover = the item's current on-hand ÷ avgDailyUsage, runOutDate = today (UTC) + days of cover rounded to whole days, as a YYYY-MM-DD key. Items with zero or negative recorded usage, or whose current on-hand is unknown (item since removed), get forecast null — never an infinite cover. notEnoughHistory counts the items whose counts span fewer than two different days, so the client can say so in one quiet line.",
    request: z.object({
      businessId: bitBusinessIdRequest,
    }),
    response: z.object({
      hasHistory: z.boolean(),
      items: z.array(
        z.object({
          itemId: z.number().nullable(),
          name: z.string(),
          category: z.string(),
          currentPar: z.number(),
          checks: z.array(
            z.object({
              at: z.string(),
              book: z.number(),
              counted: z.number(),
              par: z.number(),
              varianceReason: z.string().nullable(),
              recounted: z.boolean(),
            }),
          ),
          usageTotal: z.number(),
          intervals: z.number(),
          varianceCount: z.number(),
          belowParCount: z.number(),
          varianceReasons: z.array(
            z.object({ reason: z.string(), count: z.number() }),
          ),
          suggestedPar: z.number().nullable(),
          // Days-of-cover forecast (Alpha 0.84); null when the
          // item cannot honestly be forecast (see description).
          forecast: z
            .object({
              onHand: z.number(),
              avgDailyUsage: z.number(),
              daysOfCover: z.number(),
              runOutDate: z.string(),
            })
            .nullable(),
        }),
      ),
      // Items whose counts span fewer than two different days
      // (Alpha 0.84) — counted so the client can note them in one
      // quiet line instead of per-item noise.
      notEnoughHistory: z.number(),
      repeatVariances: z.array(
        z.object({
          name: z.string(),
          varianceCount: z.number(),
          // The recorded variance reasons for this item (Alpha
          // 0.82), most frequent first — e.g. repeated "Missing"
          // reads as the shrinkage signal it is.
          reasons: z.array(
            z.object({ reason: z.string(), count: z.number() }),
          ),
        }),
      ),
      mostBelowPar: z.array(
        z.object({ name: z.string(), belowParCount: z.number() }),
      ),
    }),
    handler: async (ctx, args) => {
      const db = ctx.db<typeof schema>();
      const biz = await resolveBitBusiness(ctx, args.businessId);
      if (!biz) {
        return {
          hasHistory: false,
          items: [],
          repeatVariances: [],
          mostBelowPar: [],
          notEnoughHistory: 0,
        };
      }
      const [snapshotRows, eventRows, itemRows] = await Promise.all([
        db
          .select()
          .from(schema.bitItemSnapshots)
          .where(eq(schema.bitItemSnapshots.businessId, biz.id))
          .orderBy(
            asc(schema.bitItemSnapshots.createdAt),
            asc(schema.bitItemSnapshots.id),
          ),
        db
          .select()
          .from(schema.bitStockEvents)
          .where(eq(schema.bitStockEvents.businessId, biz.id))
          .orderBy(
            asc(schema.bitStockEvents.createdAt),
            asc(schema.bitStockEvents.id),
          ),
        db
          .select()
          .from(schema.bitItems)
          .where(eq(schema.bitItems.businessId, biz.id)),
      ]);
      const currentParById = new Map(itemRows.map((r) => [r.id, r.par]));
      const onHandById = new Map(itemRows.map((r) => [r.id, r.onHand]));
      // One "today" for every forecast in this read (Alpha 0.84):
      // UTC calendar day, matching the ISO dates snapshots carry.
      const nowDate = new Date();
      const todayStartMs = Date.UTC(
        nowDate.getUTCFullYear(),
        nowDate.getUTCMonth(),
        nowDate.getUTCDate(),
      );
      // Group snapshots per item (by id when present, else by
      // the snapshotted name) and stock events per item id.
      type Snap = (typeof snapshotRows)[number];
      const snapsByKey = new Map<string, Snap[]>();
      for (const s of snapshotRows) {
        const key = s.itemId != null ? `id:${s.itemId}` : `name:${s.itemName}`;
        const list = snapsByKey.get(key);
        if (list) list.push(s);
        else snapsByKey.set(key, [s]);
      }
      const eventsByItemId = new Map<number, typeof eventRows>();
      // Undone events (audit #5) had their stock change reversed,
      // so they play no part in usage between checks.
      for (const e of eventRows.filter((r) => r.undone === 0)) {
        if (e.itemId == null) continue;
        const list = eventsByItemId.get(e.itemId);
        if (list) list.push(e);
        else eventsByItemId.set(e.itemId, [e]);
      }
      const items = [...snapsByKey.values()].map((snaps) => {
        const first = snaps[0];
        const itemId = first?.itemId ?? null;
        const checks = snaps.map((s) => ({
          at: s.createdAt.toISOString(),
          book: s.bookCount,
          counted: s.counted,
          par: s.par,
          varianceReason: s.varianceReason ?? null,
          recounted: s.recounted === 1,
        }));
        // Recorded reasons across this item's variance checks
        // (Alpha 0.82), most frequent first.
        const reasonCounts = new Map<string, number>();
        for (const s of snaps) {
          if (s.counted !== s.bookCount && s.varianceReason) {
            reasonCounts.set(
              s.varianceReason,
              (reasonCounts.get(s.varianceReason) ?? 0) + 1,
            );
          }
        }
        const varianceReasons = [...reasonCounts.entries()]
          .map(([reason, count]) => ({ reason, count }))
          .sort((a, b) => b.count - a.count);
        const varianceCount = snaps.filter(
          (s) => s.counted !== s.bookCount,
        ).length;
        const belowParCount = snaps.filter(
          (s) => s.par > 0 && s.counted <= s.par,
        ).length;
        // Usage between consecutive checks: previous count +
        // stock that arrived between the two checks − this
        // count. Stock events are matched by timestamp window.
        const itemEvents =
          itemId != null ? (eventsByItemId.get(itemId) ?? []) : [];
        let usageTotal = 0;
        let maxUsage: number | null = null;
        let intervals = 0;
        for (let i = 1; i < snaps.length; i++) {
          const prev = snaps[i - 1];
          const next = snaps[i];
          if (!prev || !next) continue;
          const from = prev.createdAt.getTime();
          const to = next.createdAt.getTime();
          const stockIn = itemEvents
            .filter((e) => {
              const t = e.createdAt.getTime();
              return t > from && t <= to;
            })
            .reduce((sum, e) => sum + e.delta, 0);
          const usage = prev.counted + stockIn - next.counted;
          usageTotal += usage;
          maxUsage = maxUsage == null ? usage : Math.max(maxUsage, usage);
          intervals += 1;
        }
        // Days-of-cover forecast (Alpha 0.84). Honest gates: the
        // counts must span at least two different days (UTC
        // calendar days between the first and last count) and the
        // recorded usage over the span must be positive — zero or
        // negative usage means no forecast, never infinite cover.
        // All math stays in decimals so fractional (tenths)
        // counts forecast correctly.
        const firstSnap = snaps[0];
        const lastSnap = snaps[snaps.length - 1];
        let enoughHistory = false;
        let forecast: {
          onHand: number;
          avgDailyUsage: number;
          daysOfCover: number;
          runOutDate: string;
        } | null = null;
        if (firstSnap && lastSnap) {
          const dayStartMs = (d: Date) =>
            Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate());
          const spanDays = Math.round(
            (dayStartMs(lastSnap.createdAt) - dayStartMs(firstSnap.createdAt)) /
              86_400_000,
          );
          if (spanDays >= 1) {
            enoughHistory = true;
            const onHand =
              itemId != null ? onHandById.get(itemId) : undefined;
            if (usageTotal > 0 && onHand != null) {
              const avgDailyUsage = usageTotal / spanDays;
              const daysOfCover = onHand / avgDailyUsage;
              forecast = {
                onHand,
                avgDailyUsage,
                daysOfCover,
                runOutDate: new Date(
                  todayStartMs + Math.round(daysOfCover) * 86_400_000,
                )
                  .toISOString()
                  .slice(0, 10),
              };
            }
          }
        }
        return {
          itemId,
          name: first?.itemName ?? "",
          category: first?.category ?? "",
          currentPar:
            itemId != null
              ? (currentParById.get(itemId) ?? first?.par ?? 0)
              : (first?.par ?? 0),
          checks,
          varianceReasons,
          usageTotal,
          intervals,
          varianceCount,
          belowParCount,
          // A suggestion only: par covering the heaviest usage
          // seen between two checks. Null until an item has two
          // checks with positive usage between them.
          suggestedPar:
            maxUsage != null && maxUsage > 0 ? Math.ceil(maxUsage) : null,
          forecast,
          enoughHistory,
        };
      });
      items.sort((a, b) => a.name.localeCompare(b.name));
      const repeatVariances = items
        .filter((i) => i.varianceCount >= 2)
        .map((i) => ({
          name: i.name,
          varianceCount: i.varianceCount,
          reasons: i.varianceReasons,
        }))
        .sort((a, b) => b.varianceCount - a.varianceCount);
      const mostBelowPar = items
        .filter((i) => i.belowParCount >= 1)
        .map((i) => ({ name: i.name, belowParCount: i.belowParCount }))
        .sort((a, b) => b.belowParCount - a.belowParCount)
        .slice(0, 10);
      const notEnoughHistory = items.filter(
        (i) => !i.enoughHistory,
      ).length;
      return {
        hasHistory: snapshotRows.length > 0,
        items: items.map(({ enoughHistory: _enoughHistory, ...rest }) => rest),
        repeatVariances,
        mostBelowPar,
        notEnoughHistory,
      };
    },
  }),

  getBitWeeklyCount: defineAction({
    description:
      "Computes this week's proposed cycle-count set for one BIT business (Alpha 0.85), from the same history Trends reads (bit_item_snapshots + bit_stock_events, collected since Alpha 0.79; nothing is backfilled). Each current inventory item is classified from its recorded activity: A — high usage (total usage between counts of 20 or more units) or repeated variances (2 or more counts that differed from book) — due every week; B — some recorded activity (any usage, one variance, or any stock event) — due every 4 weeks; C — low or no recorded activity — due every 12 weeks. An item is due when it has never been counted, or when its class interval (7 / 28 / 84 whole days) has elapsed since its last count. Never-counted class C items are staggered across their 12-week rotation: each item's position in the business's stable item order (sortOrder, then id — the order getBitState returns) is its fixed rotation slot, and only items whose position modulo 12 matches the current week number (whole weeks since the epoch) are due, so roughly a twelfth are proposed each week instead of the whole catalogue at once, and counting other items never moves an item's slot. Never-counted A or B items (activity recorded but never counted) are due immediately. Returns the due items in inventory order, each with its class, its interval in plain words, whether it was never counted, and whole days since its last count (null when never counted), plus the business's total item count. Starting the proposed check goes through finishBitRound with itemIds set to exactly this set.",
    request: z.object({
      businessId: bitBusinessIdRequest,
    }),
    response: z.object({
      due: z.array(
        z.object({
          itemId: z.number(),
          name: z.string(),
          category: z.string(),
          cls: z.enum(["A", "B", "C"]),
          intervalLabel: z.string(),
          neverCounted: z.boolean(),
          daysSinceLastCount: z.number().nullable(),
        }),
      ),
      totalItems: z.number(),
    }),
    handler: async (
      ctx,
      args,
    ): Promise<{
      due: {
        itemId: number;
        name: string;
        category: string;
        cls: "A" | "B" | "C";
        intervalLabel: string;
        neverCounted: boolean;
        daysSinceLastCount: number | null;
      }[];
      totalItems: number;
    }> => {
      const db = ctx.db<typeof schema>();
      const biz = await resolveBitBusiness(ctx, args.businessId);
      if (!biz) return { due: [], totalItems: 0 };
      const [itemRows, snapshotRows, eventRows] = await Promise.all([
        db
          .select()
          .from(schema.bitItems)
          .where(eq(schema.bitItems.businessId, biz.id))
          .orderBy(
            asc(schema.bitItems.sortOrder),
            asc(schema.bitItems.id),
          ),
        db
          .select()
          .from(schema.bitItemSnapshots)
          .where(eq(schema.bitItemSnapshots.businessId, biz.id))
          .orderBy(
            asc(schema.bitItemSnapshots.createdAt),
            asc(schema.bitItemSnapshots.id),
          ),
        db
          .select()
          .from(schema.bitStockEvents)
          .where(eq(schema.bitStockEvents.businessId, biz.id))
          .orderBy(
            asc(schema.bitStockEvents.createdAt),
            asc(schema.bitStockEvents.id),
          ),
      ]);
      type Snap = (typeof snapshotRows)[number];
      const snapsByItemId = new Map<number, Snap[]>();
      for (const s of snapshotRows) {
        if (s.itemId == null) continue;
        const list = snapsByItemId.get(s.itemId);
        if (list) list.push(s);
        else snapsByItemId.set(s.itemId, [s]);
      }
      const eventsByItemId = new Map<number, typeof eventRows>();
      // Undone events (audit #5) had their stock change reversed,
      // so they play no part in usage between checks.
      for (const e of eventRows.filter((r) => r.undone === 0)) {
        if (e.itemId == null) continue;
        const list = eventsByItemId.get(e.itemId);
        if (list) list.push(e);
        else eventsByItemId.set(e.itemId, [e]);
      }
      const DAY_MS = 86_400_000;
      const nowMs = Date.now();
      // Whole weeks since the epoch: the rotation bucket the
      // never-counted class C stagger keys off.
      const weekIndex = Math.floor(nowMs / (7 * DAY_MS));
      const INTERVAL_DAYS = { A: 7, B: 28, C: 84 } as const;
      const INTERVAL_LABEL = {
        A: "weekly",
        B: "every 4 weeks",
        C: "every 12 weeks",
      } as const;
      // First pass: classify every item and find its last count.
      type Classified = {
        item: (typeof itemRows)[number];
        cls: "A" | "B" | "C";
        lastCountedMs: number | null;
      };
      const classified: Classified[] = itemRows.map((item) => {
        const snaps = snapsByItemId.get(item.id) ?? [];
        const itemEvents = eventsByItemId.get(item.id) ?? [];
        const varianceCount = snaps.filter(
          (s) => s.counted !== s.bookCount,
        ).length;
        // Total usage between counts — the same math Trends
        // shows: previous count + stock-in events in the
        // interval − this count, summed over consecutive pairs.
        let usageTotal = 0;
        for (let i = 1; i < snaps.length; i++) {
          const prev = snaps[i - 1];
          const next = snaps[i];
          if (!prev || !next) continue;
          const from = prev.createdAt.getTime();
          const to = next.createdAt.getTime();
          const stockIn = itemEvents
            .filter((e) => {
              const t = e.createdAt.getTime();
              return t > from && t <= to;
            })
            .reduce((sum, e) => sum + e.delta, 0);
          usageTotal += prev.counted + stockIn - next.counted;
        }
        const cls: "A" | "B" | "C" =
          varianceCount >= 2 || usageTotal >= 20
            ? "A"
            : usageTotal > 0 || varianceCount >= 1 || itemEvents.length > 0
              ? "B"
              : "C";
        const last = snaps[snaps.length - 1];
        return {
          item,
          cls,
          lastCountedMs: last ? last.createdAt.getTime() : null,
        };
      });
      // Second pass: due-ness, staggering the never-counted
      // class C items across their 12-week rotation by the
      // item's own position in the stable item order — a fixed
      // slot per item, so counting other items never moves an
      // item's rotation week.
      const due: {
        itemId: number;
        name: string;
        category: string;
        cls: "A" | "B" | "C";
        intervalLabel: string;
        neverCounted: boolean;
        daysSinceLastCount: number | null;
      }[] = [];
      classified.forEach((c, position) => {
        let isDue = false;
        let daysSinceLastCount: number | null = null;
        if (c.lastCountedMs == null) {
          if (c.cls === "C") {
            isDue = position % 12 === weekIndex % 12;
          } else {
            isDue = true;
          }
        } else {
          daysSinceLastCount = Math.floor(
            (nowMs - c.lastCountedMs) / DAY_MS,
          );
          isDue = daysSinceLastCount >= INTERVAL_DAYS[c.cls];
        }
        if (isDue) {
          due.push({
            itemId: c.item.id,
            name: c.item.name,
            category: bitRowGroup(c.item, biz),
            cls: c.cls,
            intervalLabel: INTERVAL_LABEL[c.cls],
            neverCounted: c.lastCountedMs == null,
            daysSinceLastCount,
          });
        }
      });
      return { due, totalItems: itemRows.length };
    },
  }),

  importBitManifest: defineAction({
    description:
      "Confirms a reviewed BIT manifest import (the shared review used by the setup wizard's manifest step and the Inventory tab's Import manifest): lines whose name matches an existing inventory item (case-insensitive) SET that item's on-hand count; new lines are added as items (par defaults to the imported count when the line has none; a new item is placed in its category — the line's category when it names one of the business's categories, otherwise the business's first category). When scanId names a manifest photo scan, that scan is marked 'confirmed'. Returns how many items were added vs updated. Undo coverage (audit #5): every import that changes anything also writes a bit_manifest_imports record — per line, the item it created or the on-hand it replaced — which undoBitManifestImport reverts from, and whose id is returned as importId (null when nothing changed).",
    request: z.object({
      businessId: bitBusinessIdRequest,
      lines: z.array(bitManifestLineRequest).max(500),
      scanId: z.number().int().positive().nullable(),
    }),
    response: z.object({
      added: z.number(),
      updated: z.number(),
      importId: z.number().nullable(),
    }),
    handler: async (
      ctx,
      args,
    ): Promise<{ added: number; updated: number; importId: number | null }> => {
      const db = ctx.db<typeof schema>();
      const biz = await resolveBitBusiness(ctx, args.businessId);
      const existing = biz
        ? await db
            .select()
            .from(schema.bitItems)
            .where(eq(schema.bitItems.businessId, biz.id))
        : [];
      // A new item's group is its category: the line's category
      // when it names one of the business's categories, otherwise
      // the first category.
      const bizCategories = biz ? bitBusinessCategories(biz) : [];
      const byName = new Map(
        existing.map((r) => [r.name.trim().toLowerCase(), r]),
      );
      let nextOrder =
        existing.reduce((m, r) => Math.max(m, r.sortOrder), -1) + 1;
      let added = 0;
      let updated = 0;
      const statements: BatchItem<"sqlite">[] = [];
      // The import's undo record: one change per line touched.
      const changes: BitManifestImportChange[] = [];
      const seen = new Set<string>();
      for (const line of args.lines) {
        const key = line.name.trim().toLowerCase();
        if (!key || seen.has(key)) continue;
        seen.add(key);
        const match = byName.get(key);
        if (match) {
          updated += 1;
          changes.push({
            name: match.name,
            itemId: match.id,
            added: false,
            priorOnHand: match.onHand,
          });
          statements.push(
            db
              .update(schema.bitItems)
              .set({ onHand: line.count })
              .where(eq(schema.bitItems.id, match.id)),
          );
        } else {
          added += 1;
          const lineCat = line.cat.trim();
          const category = bizCategories.includes(lineCat)
            ? lineCat
            : (bizCategories[0] ?? (lineCat || "General"));
          // New items are inserted one by one (not batched) so
          // the undo record can name the exact item each line
          // created.
          const [inserted] = await db
            .insert(schema.bitItems)
            .values({
              businessId: biz?.id ?? 1,
              name: line.name.trim(),
              category,
              zone: category,
              onHand: line.count,
              unit: line.unit.trim() || "units",
              par: line.par ?? line.count,
              packSize: 1,
              supplier: line.supplier.trim() || null,
              sku: null,
              tagsJson: "[]",
              sortOrder: nextOrder++,
            })
            .returning({ id: schema.bitItems.id });
          changes.push({
            name: line.name.trim(),
            itemId: inserted?.id ?? null,
            added: true,
            priorOnHand: null,
          });
        }
      }
      if (args.scanId != null) {
        statements.push(
          db
            .update(schema.bitManifestScans)
            .set({ status: "confirmed", updatedAt: new Date() })
            .where(eq(schema.bitManifestScans.id, args.scanId)),
        );
      }
      if (statements.length > 0) {
        const [first, ...rest] = statements;
        if (first) await db.batch([first, ...rest]);
      }
      let importId: number | null = null;
      if (changes.length > 0) {
        const { role } = await loadAccountSettings(ctx);
        const [record] = await db
          .insert(schema.bitManifestImports)
          .values({
            businessId: biz?.id ?? 1,
            scanId: args.scanId,
            changesJson: JSON.stringify(changes),
            actor: role,
          })
          .returning({ id: schema.bitManifestImports.id });
        importId = record?.id ?? null;
      }
      ctx.invalidateQueries();
      return { added, updated, importId };
    },
  }),

  undoBitManifestImport: defineAction({
    description:
      "Undoes one recorded BIT manifest import (Beta 0.01 batch, audit #5): reverts exactly what that import did — items the import created are removed from the inventory, and items whose counts the import set get their pre-import on-hand back. The import record is marked undone, and a photo scan the import confirmed returns to 'proposed' so its lines can be reviewed again. An already-undone import reports an error and changes nothing. Items created by the import that have since been removed are simply skipped.",
    request: z.object({ id: z.number().int().positive() }),
    response: z.object({
      ok: z.boolean(),
      error: z.string().nullable(),
    }),
    handler: async (ctx, args) =>
      await performUndoBitManifestImport(ctx, args.id),
  }),

  requestBitManifestScan: defineAction({
    description:
      "Stores a photo of an inventory manifest uploaded in BIT's manifest import (setup wizard or Inventory tab) and opens a manifest scan request (status 'pending'). The photo bytes go to blob storage; nothing is read and nothing is imported by this call. An external reader job picks pending scans up via getPendingBitManifestScans, extracts the manifest lines, and writes them back with setBitManifestScanResult; the user reviews those lines in the manifest review and only confirming imports them.",
    request: z.object({
      businessId: bitBusinessIdRequest,
      image: z.object({
        dataBase64: z.string().min(1).max(20_000_000),
        mimeType: z.string().min(1).max(100),
      }),
    }),
    response: z.object({
      ok: z.boolean(),
      id: z.number().nullable(),
      error: z.string().nullable(),
    }),
    handler: async (
      ctx,
      args,
    ): Promise<{ ok: boolean; id: number | null; error: string | null }> => {
      const mime = args.image.mimeType.trim().toLowerCase();
      if (mime !== "image/jpeg" && mime !== "image/png") {
        return {
          ok: false,
          id: null,
          error: "That photo format isn't supported — use a JPEG or PNG.",
        };
      }
      let bytes: Uint8Array;
      try {
        bytes = base64ToBytes(args.image.dataBase64);
      } catch {
        return {
          ok: false,
          id: null,
          error: "That photo couldn't be read. Try again.",
        };
      }
      if (bytes.length === 0) {
        return { ok: false, id: null, error: "That photo was empty." };
      }
      const db = ctx.db<typeof schema>();
      const scanBiz = await resolveBitBusiness(ctx, args.businessId);
      const inserted = await db
        .insert(schema.bitManifestScans)
        .values({
          businessId: scanBiz?.id ?? 1,
          status: "pending",
          imageMimeType: mime,
        })
        .returning({ id: schema.bitManifestScans.id });
      const row = inserted[0];
      if (!row) {
        throw new Error("requestBitManifestScan: insert returned no rows");
      }
      const key = `bit-manifest-scans/${row.id}`;
      await ctx.blobs.put(key, bytes, { contentType: mime });
      await db
        .update(schema.bitManifestScans)
        .set({ imageBlobKey: key, updatedAt: new Date() })
        .where(eq(schema.bitManifestScans.id, row.id));
      ctx.invalidateQueries();
      return { ok: true, id: row.id, error: null };
    },
  }),

  getPendingBitManifestScans: defineAction({
    description:
      "Lists the BIT manifest photo scans still waiting to be read (status 'pending'), oldest first, each with a URL for its stored photo, so Muse can fetch the photo, extract every manifest line (item name, category, count, unit, par, supplier — count 1 and unit 'units' when the photo doesn't say), and write the lines back with setBitManifestScanResult.",
    request: z.object({}),
    response: z.object({
      pending: z.array(
        z.object({
          id: z.number(),
          businessId: z.number(),
          createdAt: z.string(),
          imageMimeType: z.string().nullable(),
          imageUrl: z.string().nullable(),
        }),
      ),
    }),
    handler: async (ctx) => {
      const db = ctx.db<typeof schema>();
      const rows = await db
        .select()
        .from(schema.bitManifestScans)
        .orderBy(asc(schema.bitManifestScans.id));
      const pending = rows.filter((r) => r.status === "pending");
      const out: {
        id: number;
        businessId: number;
        createdAt: string;
        imageMimeType: string | null;
        imageUrl: string | null;
      }[] = [];
      for (const r of pending) {
        out.push({
          id: r.id,
          businessId: r.businessId,
          createdAt: r.createdAt.toISOString(),
          imageMimeType: r.imageMimeType,
          imageUrl: r.imageBlobKey
            ? await ctx.blobs.getUrl(r.imageBlobKey)
            : null,
        });
      }
      return { pending: out };
    },
  }),

  setBitManifestScanResult: defineAction({
    description:
      "Writes the extracted manifest lines for a pending BIT manifest photo scan (called by Muse after reading the photo): one line per item on the manifest — name, category (empty string when unclear), count, unit, par (null when the manifest doesn't give one), supplier (empty string when unclear) — plus an optional note. Moves the scan to 'proposed' so the lines land in the app's manifest review; imports NOTHING — only the user's in-app Confirm does that.",
    request: z.object({
      id: z.number().int().positive(),
      lines: z.array(bitManifestLineRequest).max(200),
      note: z.string().max(300).nullable().default(null),
    }),
    response: z.object({
      ok: z.boolean(),
      error: z.string().nullable(),
    }),
    handler: async (
      ctx,
      args,
    ): Promise<{ ok: boolean; error: string | null }> => {
      const db = ctx.db<typeof schema>();
      const rows = await db
        .select()
        .from(schema.bitManifestScans)
        .where(eq(schema.bitManifestScans.id, args.id));
      const row = rows[0];
      if (!row) {
        return { ok: false, error: "That manifest scan no longer exists." };
      }
      if (row.status !== "pending") {
        return {
          ok: false,
          error: "That manifest scan already has a result.",
        };
      }
      await db
        .update(schema.bitManifestScans)
        .set({
          status: "proposed",
          linesJson: JSON.stringify(args.lines),
          note: args.note,
          updatedAt: new Date(),
        })
        .where(eq(schema.bitManifestScans.id, args.id));
      ctx.invalidateQueries();
      return { ok: true, error: null };
    },
  }),

  saveBitPosConnection: defineAction({
    description:
      "Saves the BIT business's one POS connection from the Inventory tab's Connect to POS panel. Named providers are the six researched systems (Square, Shopify POS, Lightspeed Retail (X-Series), Lightspeed Retail (R-Series), Clover, Toast); each has its own required setup fields, sent in `details` and stored server-side in pos_details_json — a named save with its required fields present is stored with status 'Credentials saved — daily sync ready'. Lightspeed Retail (R-Series) has no merchant credential to paste (OAuth consent only, once this app is registered with Lightspeed), so it saves with status 'Awaiting app registration' and no details. Secret fields inside details (tokens, client secrets) are never returned raw — getBitState masks them — and a save that omits a secret, or sends it back masked, keeps the stored value for the same provider; a secret changes only when a new one is typed. Square and Clover connections also carry an `environment` detail ('Production' or 'Sandbox', default Production) choosing which of the provider's API hosts the daily pull calls. A custom provider (from the Other / Custom POS popup) is stored with status 'Details saved' together with the popup's entries: how it shares data, API endpoint URL, API key / access token, optional location / store ID, and optional notes. Saving replaces any existing connection and clears the previous provider's stored fields. This is the setup layer only — no provider API call is made.",
    request: z.object({
      businessId: bitBusinessIdRequest,
      provider: z.string().min(1).max(120),
      kind: z.enum(["named", "custom"]),
      shareMethod: z.string().max(60).nullable(),
      endpointUrl: z.string().max(500).nullable(),
      apiKey: z.string().max(500).nullable(),
      locationId: z.string().max(120).nullable(),
      notes: z.string().max(1000).nullable(),
      details: bitPosDetailsRequest.nullable().optional(),
    }),
    response: z.object({
      ok: z.boolean(),
      error: z.string().nullable(),
    }),
    handler: async (
      ctx,
      args,
    ): Promise<{ ok: boolean; error: string | null }> => {
      const db = ctx.db<typeof schema>();
      const existingBiz = await resolveBitBusiness(ctx, args.businessId);
      if (!existingBiz) {
        return { ok: false, error: "Set up the business first." };
      }
      const name = args.provider.trim();
      if (!name) return { ok: false, error: "Give the POS a name." };
      const shareMethod = args.shareMethod?.trim() || null;
      const needsToken =
        args.kind === "custom" &&
        (shareMethod === "Webhook" || shareMethod === "API key");

      // Per-provider setup details (named providers only).
      let detailsJson: string | null = null;
      let status: string;
      if (args.kind === "custom") {
        status = "Details saved";
      } else if (name === "Lightspeed Retail (R-Series)") {
        // No merchant credential exists to paste for R-Series —
        // connection is OAuth consent once this app is registered.
        status = "Awaiting app registration";
      } else {
        const required = BIT_POS_REQUIRED_FIELDS[name] ?? [];
        const sameProvider =
          existingBiz?.posKind === "named" && existingBiz?.posProvider === name;
        const stored = sameProvider
          ? bitPosParseDetails(existingBiz?.posDetailsJson ?? null)
          : {};
        const merged: BitPosDetails = {};
        for (const key of BIT_POS_DETAIL_KEYS) {
          let incoming = args.details?.[key]?.trim() || null;
          // The environment is a two-value choice (Square and
          // Clover); anything else is ignored, keeping the stored
          // value — absent means Production.
          if (
            key === "environment" &&
            incoming !== "Production" &&
            incoming !== "Sandbox"
          ) {
            incoming = null;
          }
          const isSecret = (BIT_POS_SECRET_FIELDS as readonly string[]).includes(
            key,
          );
          if (isSecret) {
            // Omitted, blank, or sent back masked = keep the
            // stored secret; anything else is the new value.
            merged[key] =
              incoming == null || incoming.startsWith("••••")
                ? (stored[key] ?? null) ?? undefined
                : incoming;
          } else if (required.includes(key) || incoming != null) {
            merged[key] = incoming ?? stored[key];
          }
          if (merged[key] == null) delete merged[key];
        }
        const missing = required.filter((k) => !merged[k]);
        if (missing.length > 0) {
          return {
            ok: false,
            error: `That provider needs all of its setup fields filled in before it can be saved.`,
          };
        }
        detailsJson =
          Object.keys(merged).length > 0 ? JSON.stringify(merged) : null;
        status =
          required.length > 0
            ? "Credentials saved — daily sync ready"
            : "Awaiting authorization";
      }

      // A custom connection's API key follows the same rule: blank
      // (or the masked value sent back) on a re-save of the same
      // custom POS keeps the stored key.
      let apiKey = args.apiKey?.trim() || null;
      if (
        args.kind === "custom" &&
        existingBiz?.posKind === "custom" &&
        existingBiz?.posProvider === name &&
        (apiKey == null || apiKey.startsWith("••••"))
      ) {
        apiKey = existingBiz?.posApiKey ?? null;
      }

      await db.update(schema.bitBusiness).set({
        posProvider: name,
        posKind: args.kind,
        posStatus: status,
        posShareMethod: shareMethod,
        posEndpointUrl: args.endpointUrl?.trim() || null,
        posApiKey: apiKey,
        posLocationId: args.locationId?.trim() || null,
        posNotes: args.notes?.trim() || null,
        posDetailsJson: detailsJson,
        posIntakeToken: needsToken
          ? (existingBiz?.posIntakeToken ?? bitPosGenerateToken())
          : null,
        // The id→SKU cache belongs to one provider's ids — keep
        // it only when the same connection is re-saved.
        posSkuCacheJson:
          existingBiz?.posProvider === name &&
          existingBiz?.posKind === args.kind
            ? (existingBiz?.posSkuCacheJson ?? null)
            : null,
        posConnectedAt: new Date(),
        updatedAt: new Date(),
      }).where(eq(schema.bitBusiness.id, existingBiz.id));
      ctx.invalidateQueries();
      return { ok: true, error: null };
    },
  }),

  clearBitPosConnection: defineAction({
    description:
      "Disconnects the BIT business's POS: clears every stored POS connection field on the business record. Inventory items, rounds and the business profile itself are untouched.",
    request: z.object({ businessId: bitBusinessIdRequest }),
    response: z.object({ ok: z.literal(true) }),
    handler: async (ctx, args): Promise<{ ok: true }> => {
      const db = ctx.db<typeof schema>();
      const biz = await resolveBitBusiness(ctx, args.businessId);
      if (biz) {
        await db
          .update(schema.bitBusiness)
          .set({
            posProvider: null,
            posKind: null,
            posStatus: null,
            posShareMethod: null,
            posEndpointUrl: null,
            posApiKey: null,
            posLocationId: null,
            posNotes: null,
            posDetailsJson: null,
            posIntakeToken: null,
            posSyncRequestedAt: null,
            posSkuCacheJson: null,
            posConnectedAt: null,
            updatedAt: new Date(),
          })
          .where(eq(schema.bitBusiness.id, biz.id));
      }
      ctx.invalidateQueries();
      return { ok: true as const };
    },
  }),

  applyBitPosSale: defineAction({
    description:
      "Applies a POS sale to the BIT inventory: each line is matched by remembered mapping, then SKU, then exact name (case-insensitive); matched lines decrement the item's count (never below 0) and are recorded in the POS log, unmatched lines are recorded as unmatched and not applied. If the external transaction id was already applied for this business the whole sale is ignored as a duplicate.",
    request: z.object({
      businessId: bitBusinessIdRequest,
      source: z.string().min(1).max(120),
      externalId: z.string().max(200).nullable().default(null),
      lines: z.array(bitPosSaleLineRequest).min(1).max(500),
    }),
    response: z.object({
      ok: z.boolean(),
      duplicate: z.boolean(),
      applied: z.number(),
      unmatched: z.number(),
      error: z.string().nullable(),
    }),
    handler: async (
      ctx,
      args,
    ): Promise<{
      ok: boolean;
      duplicate: boolean;
      applied: number;
      unmatched: number;
      error: string | null;
    }> => {
      const biz = await resolveBitBusiness(ctx, args.businessId);
      if (!biz) {
        return { ok: false, duplicate: false, applied: 0, unmatched: 0, error: "Set up the business first." };
      }
      const res = await applyBitPosSaleInternal(ctx, {
        businessId: biz.id,
        source: args.source,
        externalId: args.externalId,
        lines: args.lines,
      });
      return { ok: true, duplicate: res.duplicate, applied: res.applied, unmatched: res.unmatched, error: null };
    },
  }),

  applyBitPosWebhookSale: defineAction({
    description:
      "Webhook/API-key intake for a custom POS: accepts a JSON sale payload together with the business's per-business intake token and runs the same sale-application path, using the connected POS name as the source. A wrong token is rejected and nothing is applied.",
    request: z.object({
      token: z.string().min(1).max(300),
      transaction_id: z.string().max(200).nullable().default(null),
      lines: z.array(bitPosSaleLineRequest).min(1).max(500),
    }),
    response: z.object({
      ok: z.boolean(),
      duplicate: z.boolean(),
      applied: z.number(),
      unmatched: z.number(),
      error: z.string().nullable(),
    }),
    handler: async (
      ctx,
      args,
    ): Promise<{
      ok: boolean;
      duplicate: boolean;
      applied: number;
      unmatched: number;
      error: string | null;
    }> => {
      const db = ctx.db<typeof schema>();
      // The intake token identifies the business: it is searched
      // across every business's custom connection.
      const bizRows = await db
        .select()
        .from(schema.bitBusiness)
        .orderBy(asc(schema.bitBusiness.id));
      const biz = bizRows.find(
        (b) =>
          b.posKind === "custom" &&
          b.posIntakeToken != null &&
          args.token.trim() === b.posIntakeToken,
      );
      if (!biz || !biz.posProvider) {
        return { ok: false, duplicate: false, applied: 0, unmatched: 0, error: "Invalid intake token." };
      }
      const res = await applyBitPosSaleInternal(ctx, {
        businessId: biz.id,
        source: biz.posProvider,
        externalId: args.transaction_id,
        lines: args.lines,
      });
      return { ok: true, duplicate: res.duplicate, applied: res.applied, unmatched: res.unmatched, error: null };
    },
  }),

  listBitPosLog: defineAction({
    description:
      "Lists recent BIT POS transactions newest-first: matched/applied entries (with item, quantity, source, time, below-par flag and undone flag) and unmatched lines still waiting to be matched to an item.",
    request: z.object({ businessId: bitBusinessIdRequest }),
    response: z.object({
      transactions: z.array(bitPosTransactionShape),
      unmatched: z.array(bitPosUnmatchedShape),
    }),
    handler: async (ctx, args) => {
      const db = ctx.db<typeof schema>();
      const settings = await loadAccountSettings(ctx);
      const biz = await resolveBitBusiness(ctx, args.businessId);
      const rows = biz
        ? await db
            .select()
            .from(schema.bitPosTransactions)
            .where(eq(schema.bitPosTransactions.businessId, biz.id))
            .orderBy(desc(schema.bitPosTransactions.id))
            .limit(100)
        : [];
      const transactions = rows
        .filter((r) => r.matched === 1)
        .slice(0, 50)
        .map((r) => ({
          id: r.id,
          itemId: r.itemId,
          itemName: r.itemName,
          posRef: r.posRef,
          quantity: r.quantity,
          source: r.source,
          externalId: r.externalId,
          belowPar: r.belowPar === 1,
          undone: r.undone === 1,
          createdAt: r.createdAt.toISOString(),
          ...undoMeta(settings, "posSyncs", r.actor, r.undone === 1),
        }));
      const unmatched = rows
        .filter((r) => r.matched === 0 && r.resolved === 0)
        .slice(0, 50)
        .map((r) => ({
          id: r.id,
          posRef: r.posRef,
          quantity: r.quantity,
          source: r.source,
          externalId: r.externalId,
          createdAt: r.createdAt.toISOString(),
        }));
      return { transactions, unmatched };
    },
  }),

  undoBitPosTransaction: defineAction({
    description:
      "Undoes one applied POS transaction: restores the item's count by the transaction quantity and marks the log entry undone. Already-undone or unmatched entries are not changed.",
    request: z.object({ id: z.number().int().positive() }),
    response: z.object({ ok: z.boolean(), error: z.string().nullable() }),
    handler: async (ctx, args) =>
      await performUndoBitPosTransaction(ctx, args.id),
  }),

  matchBitPosUnmatched: defineAction({
    description:
      "Matches one unmatched POS line to a chosen inventory item: applies the decrement to that item, remembers the POS reference to item mapping for future sales, and marks the log entry as a matched/applied transaction (flagged below-par if the item lands at or below par).",
    request: z.object({
      id: z.number().int().positive(),
      itemId: z.number().int().positive(),
    }),
    response: z.object({ ok: z.boolean(), error: z.string().nullable() }),
    handler: async (
      ctx,
      args,
    ): Promise<{ ok: boolean; error: string | null }> => {
      const db = ctx.db<typeof schema>();
      const rows = await db
        .select()
        .from(schema.bitPosTransactions)
        .where(eq(schema.bitPosTransactions.id, args.id));
      const row = rows[0];
      if (!row) return { ok: false, error: "That entry no longer exists." };
      if (row.matched !== 0 || row.resolved !== 0) {
        return { ok: false, error: "That entry was already matched." };
      }
      const itemRows = await db
        .select()
        .from(schema.bitItems)
        .where(eq(schema.bitItems.id, args.itemId));
      const item = itemRows[0];
      if (!item) return { ok: false, error: "That item no longer exists." };
      if (item.businessId !== row.businessId) {
        return { ok: false, error: "That item belongs to another business." };
      }
      const newOnHand = Math.max(0, item.onHand - row.quantity);
      const belowPar = newOnHand <= item.par ? 1 : 0;
      const normalized = bitPosNormalizeRef(row.posRef);
      const statements: BatchItem<"sqlite">[] = [
        db
          .update(schema.bitItems)
          .set({ onHand: newOnHand })
          .where(eq(schema.bitItems.id, item.id)),
        db
          .update(schema.bitPosTransactions)
          .set({
            matched: 1,
            resolved: 1,
            itemId: item.id,
            itemName: item.name,
            belowPar,
          })
          .where(eq(schema.bitPosTransactions.id, row.id)),
      ];
      if (normalized) {
        statements.push(
          db
            .insert(schema.bitPosMappings)
            .values({
              businessId: row.businessId,
              posRef: normalized,
              itemId: item.id,
            })
            .onConflictDoUpdate({
              target: [
                schema.bitPosMappings.businessId,
                schema.bitPosMappings.posRef,
              ],
              set: { itemId: item.id },
            }),
        );
      }
      const [first, ...rest] = statements;
      if (first) await db.batch([first, ...rest]);
      ctx.invalidateQueries();
      return { ok: true, error: null };
    },
  }),

  pullBitPosDaily: defineAction({
    description:
      "Runs the BIT POS daily pull in-app (outbound HTTPS from server actions is available — proven against Square's API during the Alpha 0.67 build): when the business's POS connection is 'Credentials saved — daily sync ready', it fetches the previous day's completed sales from the provider's API with the saved credentials — Square over a 4-day closed_at window (offline sales land late; order-id dedupe makes the overlap safe), Shopify POS via a client-credentials token + GraphQL orders, Lightspeed Retail (X-Series) via sales search, Clover via createdTime-filtered orders, Toast via ordersBulk for the previous businessDate — Square and Clover calls go to the connection's saved environment host (Sandbox: connect.squareupsandbox.com / apisandbox.dev.clover.com; otherwise the production hosts) — and applies each order through the POS sale path with the provider as source and '<provider>:<order id>' as the external transaction id. Lightspeed Retail (R-Series) cannot be pulled (no vendor OAuth client exists) and records a 'skipped' run instead. Every run is recorded in bit_pos_sync_runs (time, provider, day, orders seen, lines applied / unmatched, duplicate orders, outcome or error) and surfaced in the POS panel as the last pull; a provider failure is recorded as that run's error and never throws. With no ready connection it records nothing and reports ran: false. This is also the daily refresh trigger's target and what the panel's 'Sync now' runs.",
    request: z.object({ businessId: bitBusinessIdRequest }),
    response: z.object({
      ok: z.literal(true),
      ran: z.boolean(),
      run: bitPosSyncRunShape.nullable(),
    }),
    handler: async (
      ctx,
      args,
    ): Promise<{
      ok: true;
      ran: boolean;
      run: z.infer<typeof bitPosSyncRunShape> | null;
    }> => {
      const db = ctx.db<typeof schema>();
      // With a businessId, pull just that business (the panel's
      // "Sync now"). Without one (the daily trigger), pull every
      // business whose connection is ready, in id order.
      const bizRows = await db
        .select()
        .from(schema.bitBusiness)
        .orderBy(asc(schema.bitBusiness.id));
      const targets =
        args.businessId != null
          ? bizRows.filter((b) => b.id === args.businessId)
          : bizRows;
      let lastRun: z.infer<typeof bitPosSyncRunShape> | null = null;
      for (const biz of targets) {
        if (!biz.posProvider || biz.posKind !== "named") continue;
        const pullable =
          biz.posStatus === BIT_POS_READY_STATUS ||
          biz.posProvider === "Lightspeed Retail (R-Series)";
        if (!pullable) continue;
        lastRun = await runBitPosPullForBusiness(ctx, biz);
      }
      ctx.invalidateQueries();
      return { ok: true as const, ran: lastRun != null, run: lastRun };
    },
  }),

  requestBitPosSync: defineAction({
    description:
      "Records a 'Sync now' request from the BIT POS panel: stamps the business's pos_sync_requested_at so the request is on record (the panel then runs pullBitPosDaily, which performs the pull immediately and clears the stamp). Returns the stamp, or an error when no POS is connected.",
    request: z.object({ businessId: bitBusinessIdRequest }),
    response: z.object({
      ok: z.boolean(),
      error: z.string().nullable(),
      requestedAt: z.string().nullable(),
    }),
    handler: async (
      ctx,
      args,
    ): Promise<{
      ok: boolean;
      error: string | null;
      requestedAt: string | null;
    }> => {
      const db = ctx.db<typeof schema>();
      const biz = await resolveBitBusiness(ctx, args.businessId);
      if (!biz || !biz.posProvider) {
        return { ok: false, error: "No POS is connected.", requestedAt: null };
      }
      const now = new Date();
      await db
        .update(schema.bitBusiness)
        .set({ posSyncRequestedAt: now, updatedAt: now })
        .where(eq(schema.bitBusiness.id, biz.id));
      ctx.invalidateQueries();
      return { ok: true, error: null, requestedAt: now.toISOString() };
    },
  }),

  dismissBitManifestScan: defineAction({
    description:
      "Dismisses a BIT manifest photo scan (pending or proposed) without importing anything from it.",
    request: z.object({ id: z.number().int().positive() }),
    response: z.object({ ok: z.literal(true) }),
    handler: async (ctx, args): Promise<{ ok: true }> => {
      const db = ctx.db<typeof schema>();
      await db
        .update(schema.bitManifestScans)
        .set({ status: "dismissed", updatedAt: new Date() })
        .where(eq(schema.bitManifestScans.id, args.id));
      ctx.invalidateQueries();
      return { ok: true as const };
    },
  }),

  importSampleData: defineAction({
    description:
      "One-time load of the bundled sample dataset (The Daily Scoop sample business with its inventory, the Sim 01 analytics dataset for it, and the default account settings). Runs ONLY when no business exists yet — if anything is already stored it changes nothing and reports imported: false, so it can never overwrite data entered in this copy. BIT history tables (check rounds, snapshots, stock events) start empty by design.",
    request: z.object({}),
    response: z.object({
      imported: z.boolean(),
      counts: sampleCountsShape,
    }),
    handler: async (
      ctx,
    ): Promise<{
      imported: boolean;
      counts: z.infer<typeof sampleCountsShape>;
    }> => {
      const db = ctx.db<typeof schema>();
      const [bizExisting] = await Promise.all([
        db
          .select({ id: schema.bitBusiness.id })
          .from(schema.bitBusiness)
          .limit(1),
      ]);
      if (bizExisting.length > 0) {
        return { imported: false, counts: await sampleDataCounts(ctx) };
      }

      const statements: BatchItem<"sqlite">[] = [];

      // ---- BIT sample business + inventory (export ids preserved). ----
      const b = bitScoopExport.business;
      statements.push(
        db.insert(schema.bitBusiness).values({
          id: b.id,
          businessType: b.type,
          customType: b.customType,
          name: b.name,
          zonesJson: JSON.stringify(b.categories),
          organizeBy: "category",
          categoriesJson: JSON.stringify(b.categories),
          freezersJson: JSON.stringify(b.freezers),
          colorsJson: JSON.stringify(b.colors),
          usesRequisition: b.usesRequisition ? 1 : 0,
          division: b.division,
          preparerName: b.preparerName,
          approverName: b.approverName,
          teamSize: b.teamSize,
        }),
      );
      bitScoopExport.items.forEach((it, i) => {
        statements.push(
          db.insert(schema.bitItems).values({
            id: it.id,
            businessId: b.id,
            name: it.name,
            category: it.category,
            zone: it.zone,
            onHand: it.onHand,
            unit: it.unit,
            par: it.par,
            packSize: it.packSize,
            supplier: it.supplier,
            sku: it.sku,
            expiryDate: it.expiryDate,
            tagsJson: JSON.stringify(it.tags),
            sortOrder: i,
          }),
        );
      });

      // ---- BIT Sim 01 analytics dataset (The Daily Scoop). ----
      const ana = bitAnalyticsExport;
      const scoopId = bitScoopExport.business.id;
      for (const m of ana.months) {
        statements.push(
          db.insert(schema.bitAnalyticsMonths).values({
            businessId: scoopId,
            monthKey: m.monthKey,
            label: m.label,
            daysOpen: m.daysOpen,
            transactions: m.transactions,
            unitsSold: m.unitsSold,
            revenue: m.revenue,
            cogs: m.cogs,
            wasteCost: m.wasteCost,
            grossProfit: m.grossProfit,
            netProfit: m.netProfit,
            ordersPlaced: m.ordersPlaced,
            stockoutEvents: m.stockoutEvents,
            endingInventoryValue: m.endingInventoryValue,
          }),
        );
      }
      ana.menu.forEach((m, i) => {
        statements.push(
          db.insert(schema.bitAnalyticsMenu).values({
            businessId: scoopId,
            name: m.name,
            units: m.units,
            revenue: m.revenue,
            sortOrder: i,
          }),
        );
      });
      statements.push(
        db.insert(schema.bitAnalyticsSummary).values({
          businessId: scoopId,
          label: ana.label ?? "",
          periodLabel: ana.periodLabel ?? "",
          lostRevenue: ana.lostRevenue,
          lostUnits: ana.lostUnits,
          stockoutEvents: ana.stockoutEvents,
          wasteJson: JSON.stringify(ana.tubWaste),
          itemCostsJson: JSON.stringify(ana.itemCosts),
        }),
      );

      // ---- Account settings (role + undo policy, as bundled). ----
      statements.push(
        db.insert(schema.accountSettings).values({
          id: 1,
          actingRole: accountSettingsExport.role,
          policyJson: JSON.stringify(accountSettingsExport.policy),
        }),
      );

      // Run in chunks so no single batch is oversized.
      for (let i = 0; i < statements.length; i += 400) {
        const chunk = statements.slice(i, i + 400);
        const [first, ...rest] = chunk;
        if (first) await db.batch([first, ...rest]);
      }
      ctx.invalidateQueries();
      return { imported: true, counts: await sampleDataCounts(ctx) };
    },
  }),

} satisfies ActionsModule;
