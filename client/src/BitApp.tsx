import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  Bar,
  BarChart,
  CartesianGrid,
  Cell,
  ReferenceLine,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import { fileToBase64 } from "@hatch/space-sdk/client";
import { api, type ApiResponse } from "./api";
import {
  BIZ_TYPES,
  PACKS_TYPED,
  bitNeedsProfile,
  isFoodAndBeverageType,
  packCategoryOptions,
  parseManifestText,
  type ManifestLine,
} from "./bitPacks";

// BIT — Business Inventory Tracker: the business side of the app,
// merged in beside the household (HIT) side. All of its data comes
// from the bit_* server actions (getBitState and friends) and never
// touches the household tables. Visual language follows the HIT
// side (soft colours, category colour coding, collapsible bars,
// one-line rows with steppers); the .bit-scope wrapper in App swaps
// the accent so the two sides read differently at a glance.

type BitState = ApiResponse<typeof api, "getBitState">;
type BitBusiness = NonNullable<BitState["business"]>;
type BitItem = BitState["items"][number];
type BitScan = BitState["scans"][number];
type BitRequisition = NonNullable<BitState["requisition"]>;
type RoundSummary = ApiResponse<typeof api, "finishBitRound">;

/** The SOG F-SUPP order sequence for a requisition: Medical
    supplies first, then Stationery (Office Supplies), then
    Cleaning supplies (general), then everything else. */
function reqCategoryRank(category: string): number {
  const c = category.trim().toLowerCase();
  if (c === "medical") return 0;
  if (c === "office supplies" || c === "stationery" || c === "stationary")
    return 1;
  if (c === "cleaning supplies") return 2;
  return 3;
}

/** The tag carried by every TFS inventory item that came from
    the user's filled requisition form (the third file supplied
    Nov 14, 2026), set server-side by
    importBitTfsFilledRequisitionItems. The Requisition tab lists
    exactly the items carrying it — nothing else. */
const FILLED_REQ_TAG = "Filled requisition form";

/** Word-based search matching for inventory items: every word of
    the query must match a word of the item's name (or SKU) as a
    prefix, tolerating singular/plural differences — so "ice pack"
    finds "Ice packs" and "gloves xl" finds "XL Medical gloves".
    A plain substring of the full name/SKU also matches, which
    keeps Material # and model-number searches ("cf289yc") working. */
function bitItemMatchesSearch(
  query: string,
  name: string,
  sku: string | null | undefined,
): boolean {
  const q = query.trim().toLowerCase();
  if (!q) return true;
  const hay = `${name} ${sku ?? ""}`.toLowerCase();
  if (hay.includes(q)) return true;
  const nameTokens = hay.split(/[^a-z0-9]+/).filter(Boolean);
  const queryTokens = q.split(/[^a-z0-9]+/).filter(Boolean);
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

/** The station number from the business name ("TFS station 226
    Inventory" → "226"), used in the requisition number. */
function stationNoOf(business: BitBusiness): string {
  const m = business.name.match(/(\d{2,4})/);
  return m?.[1] ?? "226";
}

/** Today's requisition number: Fire Station-YY-MM-DD. */
function reqNoToday(business: BitBusiness): string {
  const now = new Date();
  const yy = String(now.getFullYear()).slice(-2);
  const mm = String(now.getMonth() + 1).padStart(2, "0");
  const dd = String(now.getDate()).padStart(2, "0");
  return `${stationNoOf(business)}-${yy}-${mm}-${dd}`;
}

type BitTab = "rounds" | "inventory" | "order" | "analytics";

/**
 * A category's colour from the ONE unified category palette
 * (theme.css --cat-1..6): the same six capped, muted slots the
 * household side uses, hue-shifted into the blue family by the
 * .bit-scope overrides. The slot follows the category's position
 * in the business's category order (the stored colour record's
 * key order); an unknown category hashes into the same six slots.
 * The stored per-pack hexes now only carry that ordering — the
 * rendered colour always comes from the palette tokens.
 */
function catColor(colors: Record<string, string>, cat: string): string {
  let idx = Object.keys(colors).indexOf(cat);
  if (idx < 0) {
    let hash = 0;
    for (const ch of cat) hash += ch.charCodeAt(0);
    idx = Math.abs(hash);
  }
  return `var(--cat-${(idx % 6) + 1}-dot)`;
}

function typeLabel(business: BitBusiness): string {
  return business.type === "Other" && business.customType
    ? business.customType
    : business.type;
}

type BitWasteEntry = BitState["wasteLog"][number];

/** A count for display: whole numbers plain, fractional counts
    (Bar / Pub tenths) with their one decimal — 0.7 stays "0.7",
    never "0.7000000001". */
function fmtCount(n: number): string {
  return Number.isInteger(n) ? String(n) : String(Math.round(n * 10) / 10);
}

/** Money for the Analytics tab: $1,234.56, negatives -$1,234.56. */
function fmtMoney(n: number): string {
  const abs = Math.abs(n).toLocaleString("en-CA", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
  return `${n < 0 ? "-" : ""}$${abs}`;
}

/** Compact axis money: $55k. */
function fmtMoneyShort(n: number): string {
  if (Math.abs(n) >= 1000) return `$${Math.round(n / 1000)}k`;
  return `$${Math.round(n)}`;
}

type BitAnalytics = ApiResponse<typeof api, "getBitAnalytics">;
type BitAnalyticsMonth = BitAnalytics["months"][number];

/**
 * Whole days from today (local) until an expiry date key
 * ("YYYY-MM-DD"): negative when the date has passed, 0 for today.
 * (Same helper the HIT side uses for its item expiries.)
 */
function daysUntilExpiry(dateKey: string): number {
  const [y = 1970, m = 1, d = 1] = dateKey.split("-").map(Number);
  const target = new Date(y, m - 1, d).getTime();
  const now = new Date();
  const today = new Date(
    now.getFullYear(),
    now.getMonth(),
    now.getDate(),
  ).getTime();
  return Math.round((target - today) / 86_400_000);
}

/** "2026-11-20" -> "Nov 20, 2026". */
function formatExpiryDate(dateKey: string): string {
  const [y = 1970, m = 1, d = 1] = dateKey.split("-").map(Number);
  return new Date(y, m - 1, d).toLocaleDateString("en-CA", {
    month: "short",
    day: "numeric",
    year: "numeric",
  });
}

/** Items grouped by category, in first-appearance order. */
function groupByCategory(
  items: BitItem[],
): { category: string; items: BitItem[] }[] {
  const order: string[] = [];
  const map = new Map<string, BitItem[]>();
  for (const it of items) {
    if (!map.has(it.category)) {
      map.set(it.category, []);
      order.push(it.category);
    }
    map.get(it.category)?.push(it);
  }
  return order.map((category) => ({
    category,
    items: map.get(category) ?? [],
  }));
}

function Chevron({ collapsed }: { collapsed: boolean }) {
  return (
    <span
      aria-hidden="true"
      className="inline-flex h-5 w-5 shrink-0 items-center justify-center self-center text-[var(--dim)] transition-transform duration-200"
      style={{ transform: collapsed ? "rotate(-90deg)" : "rotate(0deg)" }}
    >
      <svg
        width="14"
        height="14"
        viewBox="0 0 14 14"
        fill="none"
        aria-hidden="true"
      >
        <path
          d="M3 5.5L7 9.5L11 5.5"
          stroke="currentColor"
          strokeWidth="1.8"
          strokeLinecap="round"
          strokeLinejoin="round"
        />
      </svg>
    </span>
  );
}

function TagChips({ tags }: { tags: string[] }) {
  if (tags.length === 0) return null;
  return (
    <span className="ml-2 inline-flex flex-wrap gap-1 align-middle">
      {tags.map((t) => (
        <span
          key={t}
          className="rounded-full px-1.5 py-0.5 text-[13px] font-bold"
          style={
            t === "Seasonal"
              ? {
                  backgroundColor: "var(--amber-soft)",
                  color: "var(--amber)",
                }
              : {
                  backgroundColor: "var(--red-soft)",
                  color: "var(--red)",
                }
          }
        >
          {t}
        </span>
      ))}
    </span>
  );
}

function roundDate(iso: string): string {
  return new Date(iso).toLocaleString("en-CA", {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}

/**
 * Downscale a manifest photo to a ~2000px long edge and re-encode it
 * as JPEG before upload (phone photos are several megabytes; the
 * reader needs the lines legible, not the full resolution). Falls
 * back to the original file when anything about the resize fails —
 * the server validates the format either way.
 */
async function prepareManifestImage(
  file: File,
): Promise<{ dataBase64: string; mimeType: string }> {
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

// ---- Manifest import (shared: setup wizard step 4 + Inventory tab) --

type ManifestRow = ManifestLine & { key: number };

interface ManifestImportProps {
  /** The business the import belongs to (Alpha 0.69 multi-business). */
  businessId?: number | null;
  /** Lowercase item names that already exist (dup detection). */
  existingNames: string[];
  /** Category suggestions for the review rows. */
  categories: string[];
  /** Manifest photo scans (from getBitState) to surface in the review area. */
  scans: BitScan[];
  /**
   * Called when the user confirms the review. Returns the summary
   * line to show (e.g. "Imported 3 new items · updated 2 counts").
   */
  onConfirm: (
    rows: ManifestLine[],
    scanId: number | null,
  ) => Promise<string>;
  onDismissScan: (scan: BitScan) => void;
}

function ManifestImport({
  businessId,
  existingNames,
  categories,
  scans,
  onConfirm,
  onDismissScan,
}: ManifestImportProps) {
  const queryClient = useQueryClient();
  const [rows, setRows] = useState<ManifestRow[] | null>(null);
  const [activeScanId, setActiveScanId] = useState<number | null>(null);
  const [summary, setSummary] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [fileName, setFileName] = useState<string | null>(null);
  const [photoPreview, setPhotoPreview] = useState<string | null>(null);
  const [photoNote, setPhotoNote] = useState<string | null>(null);
  const keyRef = useRef(1);

  const sendPhoto = useMutation({
    mutationFn: async (file: File) => {
      const image = await prepareManifestImage(file);
      return await api.requestBitManifestScan({
        businessId: businessId ?? null,
        image,
      });
    },
    onSuccess: (res) => {
      if (res.ok) {
        setPhotoNote(
          "Photo queued for reading — once it's been read, its lines will appear here for your review. Nothing is imported until you review and confirm.",
        );
        void queryClient.invalidateQueries({ queryKey: ["bit"] });
      } else {
        setError(res.error ?? "That photo couldn't be sent.");
      }
    },
    onError: () => setError("That photo couldn't be sent. Try again."),
  });

  const confirm = useMutation({
    mutationFn: async () => {
      const clean = (rows ?? [])
        .map((r) => ({
          name: r.name.trim(),
          cat: r.cat.trim(),
          count: Math.max(0, Math.floor(Number(r.count) || 0)),
          unit: r.unit.trim() || "units",
          par:
            r.par == null || !Number.isFinite(r.par)
              ? null
              : Math.max(0, Math.floor(r.par)),
          supplier: r.supplier.trim(),
        }))
        .filter((r) => r.name.length > 0);
      return await onConfirm(clean, activeScanId);
    },
    onSuccess: (line) => {
      setSummary(line);
      setRows(null);
      setActiveScanId(null);
      setError(null);
    },
    onError: () => setError("The import didn't go through. Try again."),
  });

  async function handleFile(file: File) {
    setError(null);
    setSummary(null);
    setFileName(file.name);
    if (/\.(xls|xlsx|ods)$/i.test(file.name)) {
      setError(
        "That looks like a spreadsheet file — export it as CSV (or TSV / plain text) and upload that instead.",
      );
      return;
    }
    try {
      const text = await file.text();
      const parsed = parseManifestText(text);
      if (parsed.length === 0) {
        setError(
          "No items could be read from that file. A CSV with a name column, or a plain list with one item per line, works best.",
        );
        return;
      }
      setRows(parsed.map((r) => ({ ...r, key: keyRef.current++ })));
      setActiveScanId(null);
    } catch {
      setError("That file couldn't be read. Try again.");
    }
  }

  function updateRow(key: number, patch: Partial<ManifestLine>) {
    setRows((prev) =>
      prev
        ? prev.map((r) => (r.key === key ? { ...r, ...patch } : r))
        : prev,
    );
  }

  const pendingScans = scans.filter((s) => s.status === "pending");
  const proposedScans = scans.filter((s) => s.status === "proposed");

  return (
    <div className="mt-2">
      <div className="grid gap-2 sm:grid-cols-2">
        <div
          className="rounded-xl border p-3"
          style={{
            borderColor: "var(--border)",
            backgroundColor: "var(--surface)",
          }}
        >
          <p className="text-sm font-bold">Upload a file</p>
          <p className="mt-1 text-xs text-[var(--dim)]">
            CSV, TSV or plain-text list. A header row with name, category,
            count, unit, par or supplier is picked up automatically; a
            plain list of names, one per line, works too.
          </p>
          <label
            className="mt-2 inline-flex cursor-pointer items-center rounded-full px-3 py-1.5 text-sm font-bold"
            style={{
              backgroundColor: "var(--accent)",
              color: "var(--accent-text)",
            }}
          >
            Upload a file
            <input
              type="file"
              accept=".csv,.tsv,.txt,text/csv,text/plain"
              className="sr-only"
              aria-label="Upload a manifest file"
              onChange={(e) => {
                const f = e.target.files?.[0];
                if (f) void handleFile(f);
                e.target.value = "";
              }}
            />
          </label>
          {fileName && (
            <span className="ml-2 text-xs text-[var(--dim)]">{fileName}</span>
          )}
        </div>
        <div
          className="rounded-xl border p-3"
          style={{
            borderColor: "var(--border)",
            backgroundColor: "var(--surface)",
          }}
        >
          <p className="text-sm font-bold">Upload a photo</p>
          <p className="mt-1 text-xs text-[var(--dim)]">
            A photo of a printed or handwritten manifest, a supplier
            sheet, or a shelf list — from your camera or photo library.
          </p>
          <label
            className="mt-2 inline-flex cursor-pointer items-center rounded-full px-3 py-1.5 text-sm font-bold"
            style={{
              backgroundColor: "var(--accent)",
              color: "var(--accent-text)",
            }}
          >
            {sendPhoto.isPending ? "Sending…" : "Upload a photo"}
            <input
              type="file"
              accept="image/*"
              className="sr-only"
              aria-label="Upload a manifest photo"
              onChange={(e) => {
                const f = e.target.files?.[0];
                if (f) {
                  setPhotoPreview(URL.createObjectURL(f));
                  setError(null);
                  sendPhoto.mutate(f);
                }
                e.target.value = "";
              }}
            />
          </label>
        </div>
      </div>

      {photoPreview && (
        <div className="mt-2">
          <img
            src={photoPreview}
            alt="Preview of the uploaded manifest photo"
            className="max-h-56 rounded-xl border object-contain"
            style={{ borderColor: "var(--border)" }}
          />
        </div>
      )}
      {photoNote && (
        <p className="mt-2 text-xs text-[var(--dim)]">{photoNote}</p>
      )}
      {pendingScans.length > 0 && (
        <p className="mt-2 text-xs font-semibold text-[var(--dim)]">
          {pendingScans.length} manifest photo
          {pendingScans.length === 1 ? " is" : "s are"} queued for
          reading — the extracted lines will appear here for review.
        </p>
      )}
      {proposedScans.map((scan) => (
        <div
          key={scan.id}
          className="mt-2 flex flex-wrap items-center gap-2 rounded-xl border p-3"
          style={{
            borderColor: "var(--border)",
            backgroundColor: "var(--surface-alt)",
          }}
        >
          <span className="min-w-0 flex-1 text-sm">
            <strong>Manifest photo read</strong> — {scan.lines.length}{" "}
            line{scan.lines.length === 1 ? "" : "s"} extracted
            {scan.note ? ` · ${scan.note}` : ""}
          </span>
          <button
            type="button"
            className="rounded-full px-3 py-1.5 text-sm font-bold"
            style={{
              backgroundColor: "var(--accent)",
              color: "var(--accent-text)",
            }}
            onClick={() => {
              setRows(
                scan.lines.map((l) => ({ ...l, key: keyRef.current++ })),
              );
              setActiveScanId(scan.id);
              setSummary(null);
              setError(null);
            }}
          >
            Review lines
          </button>
          <button
            type="button"
            className="rounded-full px-3 py-1.5 text-sm font-bold text-[var(--dim)]"
            onClick={() => onDismissScan(scan)}
          >
            Dismiss
          </button>
        </div>
      ))}

      {error && (
        <p role="alert" className="mt-2 text-sm font-semibold text-[var(--red)]">
          {error}
        </p>
      )}
      {summary && (
        <p
          className="mt-2 rounded-xl px-3 py-2 text-sm font-semibold"
          style={{
            backgroundColor: "var(--ok-bg)",
            color: "var(--ok-text)",
          }}
        >
          {summary}
        </p>
      )}

      {rows && (
        <div className="mt-3">
          <h4 className="text-base font-bold">Review before importing</h4>
          <p className="text-xs text-[var(--dim)]">
            Edit any line, remove lines you don't want, or add a row.
            Nothing is saved until you confirm.
          </p>
          <datalist id="bit-manifest-cats">
            {categories.map((c) => (
              <option key={c} value={c} />
            ))}
          </datalist>
          <div className="mt-2 flex flex-col gap-2">
            {rows.map((r) => {
              const isDup =
                r.name.trim().length > 0 &&
                existingNames.includes(r.name.trim().toLowerCase());
              return (
                <div
                  key={r.key}
                  className="rounded-xl border p-2"
                  style={{
                    borderColor: "var(--border)",
                    backgroundColor: "var(--surface)",
                  }}
                >
                  <div className="grid grid-cols-2 gap-2">
                    <label className="col-span-2 flex flex-col gap-0.5 text-xs font-semibold text-[var(--dim)]">
                      Item name
                      <input
                        value={r.name}
                        aria-label="Manifest item name"
                        onChange={(e) =>
                          updateRow(r.key, { name: e.target.value })
                        }
                        className="rounded-lg border px-2 py-1.5 text-sm font-normal text-[var(--text)]"
                        style={{
                          borderColor: "var(--border)",
                          backgroundColor: "var(--surface)",
                        }}
                        autoComplete="off"
                      />
                    </label>
                    <label className="flex flex-col gap-0.5 text-xs font-semibold text-[var(--dim)]">
                      Category
                      <input
                        value={r.cat}
                        aria-label="Manifest item category"
                        onChange={(e) =>
                          updateRow(r.key, { cat: e.target.value })
                        }
                        list="bit-manifest-cats"
                        className="rounded-lg border px-2 py-1.5 text-sm font-normal text-[var(--text)]"
                        style={{
                          borderColor: "var(--border)",
                          backgroundColor: "var(--surface)",
                        }}
                        autoComplete="off"
                        placeholder="Category"
                      />
                    </label>
                    <label className="flex flex-col gap-0.5 text-xs font-semibold text-[var(--dim)]">
                      Count
                      <input
                        type="number"
                        min={0}
                        step={1}
                        value={r.count}
                        aria-label="Manifest item count"
                        onChange={(e) =>
                          updateRow(r.key, {
                            count: Number(e.target.value),
                          })
                        }
                        className="rounded-lg border px-2 py-1.5 text-sm font-normal text-[var(--text)]"
                        style={{
                          borderColor: "var(--border)",
                          backgroundColor: "var(--surface)",
                        }}
                      />
                    </label>
                    <label className="flex flex-col gap-0.5 text-xs font-semibold text-[var(--dim)]">
                      Unit
                      <input
                        value={r.unit}
                        aria-label="Manifest item unit"
                        onChange={(e) =>
                          updateRow(r.key, { unit: e.target.value })
                        }
                        className="rounded-lg border px-2 py-1.5 text-sm font-normal text-[var(--text)]"
                        style={{
                          borderColor: "var(--border)",
                          backgroundColor: "var(--surface)",
                        }}
                        autoComplete="off"
                      />
                    </label>
                    <label className="flex flex-col gap-0.5 text-xs font-semibold text-[var(--dim)]">
                      Par (optional)
                      <input
                        type="number"
                        min={0}
                        step={1}
                        value={r.par ?? ""}
                        aria-label="Manifest item par"
                        onChange={(e) =>
                          updateRow(r.key, {
                            par:
                              e.target.value === ""
                                ? null
                                : Number(e.target.value),
                          })
                        }
                        className="rounded-lg border px-2 py-1.5 text-sm font-normal text-[var(--text)]"
                        style={{
                          borderColor: "var(--border)",
                          backgroundColor: "var(--surface)",
                        }}
                      />
                    </label>
                    <label className="col-span-2 flex flex-col gap-0.5 text-xs font-semibold text-[var(--dim)]">
                      Supplier
                      <input
                        value={r.supplier}
                        aria-label="Manifest item supplier"
                        onChange={(e) =>
                          updateRow(r.key, { supplier: e.target.value })
                        }
                        className="rounded-lg border px-2 py-1.5 text-sm font-normal text-[var(--text)]"
                        style={{
                          borderColor: "var(--border)",
                          backgroundColor: "var(--surface)",
                        }}
                        autoComplete="off"
                      />
                    </label>
                  </div>
                  <div className="mt-1.5 flex items-center justify-between gap-2">
                    <span
                      className="text-xs font-bold"
                      style={{
                        color: isDup
                          ? "var(--amber)"
                          : "var(--ok-text)",
                      }}
                    >
                      {isDup
                        ? "Already in inventory — its count will be updated"
                        : "New item"}
                    </span>
                    <button
                      type="button"
                      className="rounded-full px-2.5 py-1 text-xs font-bold text-[var(--red)]"
                      onClick={() =>
                        setRows((prev) =>
                          prev
                            ? prev.filter((x) => x.key !== r.key)
                            : prev,
                        )
                      }
                    >
                      Remove
                    </button>
                  </div>
                </div>
              );
            })}
          </div>
          <div className="mt-2 flex flex-wrap gap-2">
            <button
              type="button"
              className="rounded-full px-3 py-1.5 text-sm font-bold"
              style={{
                backgroundColor: "var(--surface-alt)",
                color: "var(--text)",
              }}
              onClick={() =>
                setRows((prev) => [
                  ...(prev ?? []),
                  {
                    key: keyRef.current++,
                    name: "",
                    cat: "",
                    count: 1,
                    unit: "units",
                    par: null,
                    supplier: "",
                  },
                ])
              }
            >
              + Add a row
            </button>
            <button
              type="button"
              className="rounded-full px-4 py-1.5 text-sm font-bold"
              style={{
                backgroundColor: "var(--accent)",
                color: "var(--accent-text)",
              }}
              disabled={confirm.isPending || rows.length === 0}
              onClick={() => confirm.mutate()}
            >
              {confirm.isPending ? "Importing…" : "Confirm import"}
            </button>
            <button
              type="button"
              className="rounded-full px-3 py-1.5 text-sm font-bold text-[var(--dim)]"
              onClick={() => {
                setRows(null);
                setActiveScanId(null);
              }}
            >
              Cancel
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

// ---- Business setup wizard ------------------------------------------
// An IN-FLOW page: it renders in the document and scrolls with it,
// with Back / Skip / Continue in the flow under each step's options —
// never a fixed overlay with its own scroller (the household app's
// standing rule, learned the hard way).

interface WizardProps {
  business: BitBusiness | null;
  /** The business this setup run targets (the active business). */
  businessId?: number | null;
  scans: BitScan[];
  onDone: () => void;
  /** Null on first run (nothing to go back to). */
  onCancel: (() => void) | null;
  onDismissScan: (scan: BitScan) => void;
}

function BitSetupWizard({
  business,
  businessId,
  scans,
  onDone,
  onCancel,
  onDismissScan,
}: WizardProps) {
  const queryClient = useQueryClient();
  const [step, setStep] = useState(1);
  const [bizType, setBizType] = useState(
    business?.type ?? "Ice Cream Shop",
  );
  const [customType, setCustomType] = useState(business?.customType ?? "");
  const initialPack =
    PACKS_TYPED[business?.type ?? "Ice Cream Shop"] ??
    PACKS_TYPED["Other"];
  const [name, setName] = useState(
    business?.name ?? initialPack?.defaultName ?? "",
  );
  // Categories are the ONLY organizing concept: the chosen
  // categories are the ones the user actually picks here (plus any
  // added later with Add Category) — nothing is pre-picked, so a
  // completed setup stores exactly the picked set. A business
  // already set up keeps its existing groups as its categories —
  // the server presents them that way.
  const [groups, setGroups] = useState<string[]>(
    business ? business.categories : [],
  );
  const [customGroup, setCustomGroup] = useState("");
  const [wizLines, setWizLines] = useState<ManifestLine[]>([]);
  const [scanConfirm, setScanConfirm] = useState<{
    scanId: number;
    rows: ManifestLine[];
  } | null>(null);
  const [finishError, setFinishError] = useState<string | null>(null);

  const pack = PACKS_TYPED[bizType] ?? PACKS_TYPED["Other"];
  if (!pack) return null;

  // The category options for this pack: ONE combined list — the
  // pack's categories and its former zones together, all presented
  // as categories, duplicates merged.
  const groupOptions = packCategoryOptions(pack);
  // A starter-pack item is in scope when its category — or its
  // former zone, now treated as a category — was picked. It is
  // grouped under its category when that was picked, otherwise
  // under its former-zone category.
  const inChosenGroup = (t: (typeof pack.items)[number]) =>
    groups.includes(t[1]) || groups.includes(t[2]);
  const groupFor = (t: (typeof pack.items)[number]) =>
    groups.includes(t[1]) ? t[1] : t[2];

  const packNames = pack.items
    .filter(inChosenGroup)
    .map((t) => t[0].toLowerCase());
  const wizExistingNames = [
    ...packNames,
    ...wizLines.map((l) => l.name.toLowerCase()),
  ];

  function pickType(t: string) {
    setBizType(t);
    const p = PACKS_TYPED[t] ?? PACKS_TYPED["Other"];
    if (!p) return;
    setName(p.defaultName);
    // Switching type starts the category picks over: only the
    // categories the user picks for this type are stored.
    setGroups([]);
  }

  function toggleGroup(g: string) {
    setGroups((prev) =>
      prev.includes(g) ? prev.filter((x) => x !== g) : [...prev, g],
    );
  }

  const finish = useMutation({
    mutationFn: async () => {
      // Only the categories the user actually picked are included:
      // starter-pack items belonging to any other category are not
      // seeded at all, so the business ends up with exactly the
      // chosen categories.
      const seedItems = pack.items
        .filter(inChosenGroup)
        .map((t) => ({
          name: t[0],
          category: groupFor(t),
          zone: groupFor(t),
          onHand: t[3],
          unit: t[4],
          par: t[5],
          packSize: 1,
          supplier: t[7] ? t[7] : null,
          sku: t[8] ? t[8] : null,
          tags: [...t[9]],
        }));
      const byName = new Map(
        seedItems.map((it) => [it.name.toLowerCase(), it]),
      );
      const merged = [...seedItems];
      for (const line of wizLines) {
        const match = byName.get(line.name.trim().toLowerCase());
        if (match) {
          match.onHand = line.count;
          if (line.par != null) match.par = line.par;
          if (line.supplier.trim()) match.supplier = line.supplier.trim();
        } else {
          // The new item is placed in a category — the manifest
          // line's category when it names a chosen one, otherwise
          // the first chosen category.
          const lineCat = line.cat.trim();
          const category = groups.includes(lineCat)
            ? lineCat
            : (groups[0] ??
              Object.keys(pack.colors)[0] ??
              "General");
          merged.push({
            name: line.name.trim(),
            category,
            zone: category,
            onHand: line.count,
            unit: line.unit.trim() || "units",
            par: line.par ?? line.count,
            packSize: 1,
            supplier: line.supplier.trim() || null,
            sku: null,
            tags: [],
          });
        }
      }
      await api.completeBitSetup({
        businessId: businessId ?? business?.id ?? null,
        businessType: bizType,
        customType:
          bizType === "Other" ? customType.trim() || null : null,
        name: name.trim() || pack.defaultName,
        // The business's categories are exactly the ones picked.
        categories: groups,
        // Freezer checks are only for food & beverage businesses.
        freezers: isFoodAndBeverageType(bizType)
          ? pack.freezers.slice()
          : [],
        colors: { ...pack.colors },
        items: merged,
      });
      if (scanConfirm) {
        await api.importBitManifest({
          businessId: businessId ?? business?.id ?? null,
          lines: scanConfirm.rows,
          scanId: scanConfirm.scanId,
        });
      }
      return merged.length;
    },
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ["bit"] });
      onDone();
    },
    onError: () =>
      setFinishError("Setup didn't save. Please try again."),
  });

  const stepTitle = [
    "What kind of business is this for?",
    "What's the business called?",
    "Which categories do you want?",
    "Already have an inventory list?",
    "Review your setup",
  ][step - 1];

  return (
    <section aria-label="Business setup" className="pt-2 pb-12">
      <p className="text-xs font-bold tracking-wide text-[var(--dim)]">
        BUSINESS SETUP · STEP {step} OF 5
      </p>
      <h2 className="mt-1 text-2xl font-bold">{stepTitle}</h2>

      {step === 1 && (
        <div className="mt-4">
          <div className="flex flex-wrap gap-2">
            {BIZ_TYPES.map((t) => {
              const selected = bizType === t;
              return (
                <button
                  key={t}
                  type="button"
                  aria-pressed={selected}
                  onClick={() => pickType(t)}
                  className="rounded-full border px-4 py-2 text-sm font-bold"
                  style={
                    selected
                      ? {
                          backgroundColor: "var(--accent)",
                          color: "var(--accent-text)",
                          borderColor: "var(--accent)",
                        }
                      : {
                          borderColor: "var(--border)",
                          backgroundColor: "var(--surface)",
                          color: "var(--text)",
                        }
                  }
                >
                  {t}
                </button>
              );
            })}
          </div>
          {bizType === "Other" && (
            <label className="mt-3 flex flex-col gap-1 text-sm font-semibold text-[var(--dim)]">
              What kind of business is it?
              <input
                value={customType}
                onChange={(e) => setCustomType(e.target.value)}
                placeholder="e.g. Pet grooming salon"
                className="rounded-xl border px-3 py-2 text-base font-normal text-[var(--text)]"
                style={{
                  borderColor: "var(--border)",
                  backgroundColor: "var(--surface)",
                }}
                autoComplete="off"
              />
            </label>
          )}
          <p className="mt-3 text-sm text-[var(--dim)]">
            Choosing a type populates the app with a starter pack
            tailored to that business — its categories, items, pars,
            units and suppliers. You can change everything
            afterwards.
          </p>
        </div>
      )}

      {step === 2 && (
        <div className="mt-4">
          <label className="flex flex-col gap-1 text-sm font-semibold text-[var(--dim)]">
            Business name
            <input
              value={name}
              aria-label="Business name"
              onChange={(e) => setName(e.target.value)}
              className="rounded-xl border px-3 py-2 text-base font-normal text-[var(--text)]"
              style={{
                borderColor: "var(--border)",
                backgroundColor: "var(--surface)",
              }}
              autoComplete="off"
            />
          </label>
          <p className="mt-2 text-sm text-[var(--dim)]">
            This name appears in the app header and on the order email.
          </p>
        </div>
      )}

      {step === 3 && (
        <div className="mt-4">
          <p className="text-sm text-[var(--dim)]">
            Select all that apply — only the categories you pick are
            added to the business, and only items in those categories
            are included. Nothing is pre-picked.
          </p>
          <div className="mt-3 flex flex-wrap gap-2">
            {groupOptions.map((g) => {
              const selected = groups.includes(g);
              return (
                <button
                  key={g}
                  type="button"
                  aria-pressed={selected}
                  onClick={() => toggleGroup(g)}
                  className="rounded-full border px-4 py-2 text-sm font-bold"
                  style={
                    selected
                      ? {
                          backgroundColor: "var(--accent)",
                          color: "var(--accent-text)",
                          borderColor: "var(--accent)",
                        }
                      : {
                          borderColor: "var(--border)",
                          backgroundColor: "var(--surface)",
                          color: "var(--text)",
                        }
                  }
                >
                  {g}
                </button>
              );
            })}
            {groups
              .filter((g) => !groupOptions.includes(g))
              .map((g) => (
                <button
                  key={g}
                  type="button"
                  aria-pressed={true}
                  onClick={() => toggleGroup(g)}
                  className="rounded-full border px-4 py-2 text-sm font-bold"
                  style={{
                    backgroundColor: "var(--accent)",
                    color: "var(--accent-text)",
                    borderColor: "var(--accent)",
                  }}
                >
                  {g} ✕
                </button>
              ))}
          </div>
          <div className="mt-3 flex gap-2">
            <input
              value={customGroup}
              onChange={(e) => setCustomGroup(e.target.value)}
              placeholder="Add your own category…"
              aria-label="Add your own category"
              className="min-w-0 flex-1 rounded-xl border px-3 py-2 text-base"
              style={{
                borderColor: "var(--border)",
                backgroundColor: "var(--surface)",
              }}
              autoComplete="off"
            />
            <button
              type="button"
              className="rounded-full px-4 py-2 text-sm font-bold"
              style={{
                backgroundColor: "var(--surface-alt)",
                color: "var(--text)",
              }}
              onClick={() => {
                const g = customGroup.trim();
                if (g && !groups.includes(g)) setGroups([...groups, g]);
                setCustomGroup("");
              }}
            >
              Add category
            </button>
          </div>
        </div>
      )}

      {step === 4 && (
        <div className="mt-4">
          <p className="text-sm text-[var(--dim)]">
            Optional — import a manifest you already have and its items
            fold into the setup: lines matching a starter-pack item set
            that item's count, and new lines are added. Or skip this
            step and import any time from the Inventory tab.
          </p>
          <ManifestImport
            businessId={businessId ?? business?.id ?? null}
            existingNames={wizExistingNames}
            categories={groups}
            scans={scans}
            onDismissScan={onDismissScan}
            onConfirm={async (rows, scanId) => {
              setWizLines((prev) => {
                const byName = new Map(
                  prev.map((l) => [l.name.toLowerCase(), l]),
                );
                for (const r of rows) byName.set(r.name.toLowerCase(), r);
                return [...byName.values()];
              });
              if (scanId != null) setScanConfirm({ scanId, rows });
              return `${rows.length} manifest line${rows.length === 1 ? "" : "s"} added to this setup — they'll be included when you finish.`;
            }}
          />
          {wizLines.length > 0 && (
            <p className="mt-2 text-sm font-semibold">
              {wizLines.length} imported line
              {wizLines.length === 1 ? "" : "s"} so far.
            </p>
          )}
        </div>
      )}

      {step === 5 && (
        <div className="mt-4 flex flex-col gap-2">
          {[
            [
              "Business type",
              bizType === "Other" && customType
                ? `Other — ${customType}`
                : bizType,
            ],
            ["Business name", name.trim() || pack.defaultName],
            [
              "Categories",
              groups.length > 0 ? groups.join(", ") : "None picked",
            ],
            [
              "Starter pack",
              `${pack.items.filter(inChosenGroup).length} items in ${groups.length} categories`,
            ],
            ...(isFoodAndBeverageType(bizType) && pack.freezers.length > 0
              ? [
                  [
                    "Freezer check",
                    `${pack.freezers.join(", ")} — logged every check, flagged warmer than −18°C`,
                  ] as [string, string],
                ]
              : []),
            ...(wizLines.length > 0
              ? [
                  [
                    "Manifest import",
                    `${wizLines.length} line${wizLines.length === 1 ? "" : "s"} folded into the setup`,
                  ] as [string, string],
                ]
              : []),
          ].map(([label, value]) => (
            <div
              key={label}
              className="rounded-xl border px-3 py-2"
              style={{
                borderColor: "var(--border)",
                backgroundColor: "var(--surface)",
              }}
            >
              <p className="text-xs font-bold tracking-wide text-[var(--dim)]">
                {label}
              </p>
              <p className="text-base font-semibold">{value}</p>
            </div>
          ))}
          {/* The chosen type's needs profile (Alpha 0.75): the
              unique inventory needs researched for this kind of
              business, and the features they switch on. */}
          <div
            className="rounded-xl border px-3 py-2"
            style={{
              borderColor: "var(--accent)",
              backgroundColor: "var(--accent-soft)",
            }}
          >
            <p className="text-xs font-bold tracking-wide text-[var(--dim)]">
              Considered for this business type
            </p>
            <p className="text-base font-semibold">
              {bitNeedsProfile(bizType).note}
            </p>
          </div>
          {business && (
            <p className="text-sm font-semibold text-[var(--amber)]">
              Finishing replaces the current BIT inventory with this
              starter pack (plus any manifest lines above). Past
              inventory checks are kept.
            </p>
          )}
          {finishError && (
            <p role="alert" className="text-sm font-semibold text-[var(--red)]">
              {finishError}
            </p>
          )}
        </div>
      )}

      {/* In-flow step navigation — directly under the step's options. */}
      <div className="mt-6 flex flex-wrap items-center gap-2">
        {step > 1 && (
          <button
            type="button"
            className="rounded-full px-4 py-2 text-sm font-bold"
            style={{
              backgroundColor: "var(--surface-alt)",
              color: "var(--text)",
            }}
            onClick={() => setStep(step - 1)}
          >
            Back
          </button>
        )}
        {step === 1 && onCancel && (
          <button
            type="button"
            className="rounded-full px-4 py-2 text-sm font-bold"
            style={{
              backgroundColor: "var(--surface-alt)",
              color: "var(--text)",
            }}
            onClick={onCancel}
          >
            Cancel
          </button>
        )}
        {step < 5 ? (
          <>
            <button
              type="button"
              className="rounded-full px-5 py-2 text-sm font-bold"
              style={{
                backgroundColor: "var(--accent)",
                color: "var(--accent-text)",
              }}
              onClick={() => setStep(step + 1)}
            >
              Continue
            </button>
            {step === 4 && (
              <button
                type="button"
                className="rounded-full px-4 py-2 text-sm font-bold text-[var(--dim)]"
                onClick={() => setStep(5)}
              >
                Skip
              </button>
            )}
          </>
        ) : (
          <button
            type="button"
            className="rounded-full px-5 py-2 text-sm font-bold"
            style={{
              backgroundColor: "var(--accent)",
              color: "var(--accent-text)",
            }}
            disabled={finish.isPending}
            onClick={() => finish.mutate()}
          >
            {finish.isPending ? "Setting up…" : "Finish setup"}
          </button>
        )}
      </div>
    </section>
  );
}

// ---- Inventory Checks tab (formerly Rounds) --------------------------

function RoundsTab({
  business,
  items,
  rounds,
}: {
  business: BitBusiness;
  items: BitItem[];
  rounds: BitState["rounds"];
}) {
  const queryClient = useQueryClient();
  const [counterName, setCounterName] = useState("");
  const [groupFilter, setGroupFilter] = useState("");
  const [counts, setCounts] = useState<Record<number, number>>({});
  const [editing, setEditing] = useState<{ id: number; text: string } | null>(
    null,
  );
  const [remainingOnly, setRemainingOnly] = useState(false);
  const [temps, setTemps] = useState<Record<string, string>>({});
  const [summary, setSummary] = useState<RoundSummary | null>(null);
  const [finishError, setFinishError] = useState<string | null>(null);

  // The check runs by category: only the categories chosen in the
  // setup questionnaire (plus any added later with Add Category)
  // are shown — the business's stored categories, nothing derived
  // from item rows.
  const groupOf = (it: BitItem) => it.category;
  const bizGroups = business.categories;
  const isFoodBusiness = isFoodAndBeverageType(business.type);
  const showFreezerCheck = isFoodBusiness && business.freezers.length > 0;
  // Fractional counting (Alpha 0.75, Bar / Pub profile): counts
  // may be entered in tenths — an open bottle or keg counted by
  // fill level. Every other business keeps whole-number counts.
  const fractional = business.needs.fractionalCounting;

  // The check only covers inventory in the chosen groups.
  const groupItems = items.filter((it) =>
    bizGroups.includes(groupOf(it)),
  );
  const scope = groupFilter
    ? groupItems.filter((it) => groupOf(it) === groupFilter)
    : groupItems;
  const countedCount = scope.filter((it) => counts[it.id] != null).length;
  const visible = remainingOnly
    ? scope.filter((it) => counts[it.id] == null)
    : scope;
  const groups = groupByCategory(visible);

  const finish = useMutation({
    mutationFn: async () =>
      await api.finishBitRound({
        businessId: business.id,
        counterName: counterName.trim(),
        // The filter names one of the business's categories; the
        // server scopes the check to that category.
        zoneFilter: groupFilter || null,
        counts: Object.entries(counts)
          .filter(([id]) =>
            scope.some((it) => it.id === Number(id)),
          )
          .map(([id, counted]) => ({ itemId: Number(id), counted })),
        freezerTemps: showFreezerCheck
          ? business.freezers.map((f) => {
              const raw = (temps[f] ?? "").trim();
              const v = raw === "" ? null : Number(raw);
              return {
                freezer: f,
                tempC: v != null && Number.isFinite(v) ? v : null,
              };
            })
          : [],
      }),
    onSuccess: (res) => {
      setSummary(res);
      setCounts({});
      setTemps({});
      setFinishError(null);
      void queryClient.invalidateQueries({ queryKey: ["bit"] });
    },
    onError: () =>
      setFinishError("The check didn't save. Please try again."),
  });

  function setCount(id: number, value: number) {
    setCounts((prev) => ({
      ...prev,
      [id]: Math.max(
        0,
        fractional ? Math.round(value * 10) / 10 : Math.floor(value),
      ),
    }));
  }

  function commitEdit(id: number) {
    if (!editing) return;
    const v = Number(editing.text);
    if (editing.text.trim() !== "" && Number.isFinite(v)) setCount(id, v);
    setEditing(null);
  }

  return (
    <div className="flex flex-col gap-2 pt-2">
      {business.usesRequisition && (
        <p
          className="text-sm font-bold tracking-wide"
          style={{ color: "var(--accent)" }}
        >
          Fire Station Supply Inventory
        </p>
      )}
      {summary && (
        <div
          className="rounded-xl border p-3"
          style={{
            borderColor: "var(--accent)",
            backgroundColor: "var(--surface)",
          }}
          role="status"
        >
          <h3 className="text-lg font-bold">Inventory check finished</h3>
          <p className="text-sm text-[var(--dim)]">
            Counted {summary.counted} of {summary.total} · counts written
            back to the inventory.
          </p>
          {showFreezerCheck && summary.freezerReadings.some((f) => f.alert) && (
            <p
              className="mt-2 rounded-lg px-3 py-2 text-sm font-bold"
              style={{
                backgroundColor: "var(--red-soft)",
                color: "var(--red)",
              }}
            >
              🧊 Food-safety alert:{" "}
              {summary.freezerReadings
                .filter((f) => f.alert)
                .map((f) => `${f.freezer} at ${f.tempC}°C`)
                .join(", ")}{" "}
              — warmer than −18°C. Check the freezer and move stock if
              needed.
            </p>
          )}
          {summary.variances.length > 0 ? (
            <div className="mt-2">
              <p className="text-sm font-bold">
                Variances ({summary.variances.length})
              </p>
              <ul className="mt-1 flex flex-col gap-0.5 text-sm">
                {summary.variances.map((v) => (
                  <li key={v.item} className="flex justify-between gap-2">
                    <span className="min-w-0">{v.item}</span>
                    <span className="shrink-0 font-semibold">
                      book {fmtCount(v.book)} → counted{" "}
                      {fmtCount(v.counted)}{" "}
                      <span
                        style={{
                          color:
                            v.counted - v.book < 0
                              ? "var(--red)"
                              : "var(--ok-text)",
                        }}
                      >
                        ({v.counted - v.book > 0 ? "+" : ""}
                        {fmtCount(v.counted - v.book)})
                      </span>
                    </span>
                  </li>
                ))}
              </ul>
            </div>
          ) : (
            <p className="mt-2 text-sm">
              No variances — every count matched the book count.
            </p>
          )}
          {summary.belowPar.length > 0 && (
            <p className="mt-2 text-sm">
              <strong>At or below par ({summary.belowPar.length}):</strong>{" "}
              {summary.belowPar.map((b) => b.name).join(", ")} — see the{" "}
              {business.usesRequisition ? "Requisition" : "Order Email"}{" "}
              tab.
            </p>
          )}
          {showFreezerCheck && summary.freezerReadings.length > 0 && (
            <p className="mt-1 text-sm text-[var(--dim)]">
              Freezer check:{" "}
              {summary.freezerReadings
                .map(
                  (f) =>
                    `${f.freezer} ${f.tempC == null ? "not recorded" : `${f.tempC}°C${f.alert ? " ⚠" : " ✓"}`}`,
                )
                .join(" · ")}
            </p>
          )}
          <button
            type="button"
            className="mt-3 rounded-full px-4 py-2 text-sm font-bold"
            style={{
              backgroundColor: "var(--accent)",
              color: "var(--accent-text)",
            }}
            onClick={() => setSummary(null)}
          >
            Start a new check
          </button>
        </div>
      )}

      <div
        className="rounded-xl border p-3"
        style={{
          borderColor: "var(--border)",
          backgroundColor: "var(--surface)",
        }}
      >
        <div className="grid gap-2 sm:grid-cols-2">
          <label className="flex flex-col gap-0.5 text-xs font-semibold text-[var(--dim)]">
            Who's counting?
            <input
              value={counterName}
              onChange={(e) => setCounterName(e.target.value)}
              placeholder="Counter's name"
              className="rounded-lg border px-2 py-1.5 text-sm font-normal text-[var(--text)]"
              style={{
                borderColor: "var(--border)",
                backgroundColor: "var(--surface)",
              }}
              autoComplete="off"
            />
          </label>
          <label className="flex flex-col gap-0.5 text-xs font-semibold text-[var(--dim)]">
            Category
            <select
              value={groupFilter}
              onChange={(e) => setGroupFilter(e.target.value)}
              className="rounded-lg border px-2 py-1.5 text-sm font-normal text-[var(--text)]"
              style={{
                borderColor: "var(--border)",
                backgroundColor: "var(--surface)",
              }}
              aria-label="Category filter"
            >
              <option value="">All categories</option>
              {bizGroups.map((g) => (
                <option key={g} value={g}>
                  {g}
                </option>
              ))}
            </select>
          </label>
        </div>
        <div className="mt-3 flex items-center justify-between gap-2">
          <p className="text-sm font-bold">
            Counted {countedCount} of {scope.length}
          </p>
          <label className="flex items-center gap-1.5 text-sm font-semibold text-[var(--dim)]">
            <input
              type="checkbox"
              checked={remainingOnly}
              onChange={(e) => setRemainingOnly(e.target.checked)}
              className="h-4 w-4"
              aria-label="Remaining only"
            />
            Remaining only
          </label>
        </div>
        <div
          className="mt-1 h-2 overflow-hidden rounded-full"
          style={{ backgroundColor: "var(--border)" }}
          role="progressbar"
          aria-valuenow={countedCount}
          aria-valuemin={0}
          aria-valuemax={scope.length}
          aria-label="Inventory check progress"
        >
          <div
            className="h-full rounded-full"
            style={{
              width:
                scope.length > 0
                  ? `${(countedCount / scope.length) * 100}%`
                  : "0%",
              backgroundColor: "var(--accent)",
            }}
          />
        </div>
        <p className="mt-1 text-xs text-[var(--dim)]">
          Counting is blind — book counts stay hidden until you finish.
          Use the steppers, tap the count box to type an exact number,
          or tap "Matches book count" when an item checks out.
          {fractional &&
            " Open bottles and kegs are counted by fill level — type the count in tenths (e.g. 0.7)."}
        </p>
      </div>

      {groups.map((g) => (
        <section key={g.category} aria-label={g.category}>
          <h3
            className="flex items-center gap-2 rounded-lg px-2 py-1 text-sm font-bold"
            style={{ backgroundColor: "var(--accent-soft)" }}
          >
            <span
              aria-hidden="true"
              className="h-3 w-3 shrink-0 rounded-full"
              style={{
                backgroundColor: catColor(business.colors, g.category),
              }}
            />
            {g.category}
          </h3>
          <div className="mt-1 flex flex-col gap-1">
            {g.items.map((it) => {
              const counted = counts[it.id];
              const isCounted = counted != null;
              return (
                <div
                  key={it.id}
                  className="flex items-center gap-2 rounded-xl border px-2 py-1.5"
                  style={{
                    borderColor: "var(--border)",
                    backgroundColor: "var(--surface)",
                    opacity: isCounted ? 0.75 : 1,
                  }}
                >
                  <div className="min-w-0 flex-1">
                    <p className="text-sm font-semibold leading-tight">
                      {it.name}
                      <TagChips tags={it.tags} />
                    </p>
                    <p className="text-xs text-[var(--dim)]">
                      {groupOf(it)} · {it.unit}
                    </p>
                    <button
                      type="button"
                      className="text-xs font-bold"
                      style={{ color: "var(--accent)" }}
                      onClick={() => setCount(it.id, it.onHand)}
                    >
                      Matches book count
                    </button>
                  </div>
                  <div className="flex shrink-0 items-center gap-1">
                    <button
                      type="button"
                      aria-label={`Decrease count for ${it.name}`}
                      className="h-8 w-8 rounded-full text-lg font-bold"
                      style={{ backgroundColor: "var(--surface-alt)" }}
                      disabled={!isCounted || counted <= 0}
                      onClick={() => setCount(it.id, (counted ?? 0) - 1)}
                    >
                      −
                    </button>
                    {editing?.id === it.id ? (
                      <input
                        type="number"
                        min={0}
                        step={fractional ? 0.1 : 1}
                        autoFocus
                        aria-label={`Exact count for ${it.name}`}
                        value={editing.text}
                        onChange={(e) =>
                          setEditing({ id: it.id, text: e.target.value })
                        }
                        onBlur={() => commitEdit(it.id)}
                        onKeyDown={(e) => {
                          if (e.key === "Enter") commitEdit(it.id);
                        }}
                        className="w-16 rounded-lg border px-1 py-1 text-center text-sm font-bold"
                        style={{
                          borderColor: "var(--accent)",
                          backgroundColor: "var(--surface)",
                        }}
                      />
                    ) : (
                      <button
                        type="button"
                        aria-label={`Enter count for ${it.name}`}
                        className="min-w-14 rounded-lg px-2 py-1.5 text-center text-sm font-bold"
                        style={{
                          backgroundColor: isCounted
                            ? "var(--ok-bg)"
                            : "var(--unknown-bg)",
                          color: isCounted
                            ? "var(--ok-text)"
                            : "var(--unknown-text)",
                        }}
                        onClick={() =>
                          setEditing({
                            id: it.id,
                            text: isCounted ? String(counted) : "",
                          })
                        }
                      >
                        {isCounted ? fmtCount(counted) : "Count"}
                      </button>
                    )}
                    <button
                      type="button"
                      aria-label={`Increase count for ${it.name}`}
                      className="h-8 w-8 rounded-full text-lg font-bold"
                      style={{ backgroundColor: "var(--surface-alt)" }}
                      onClick={() =>
                        setCount(it.id, (counted ?? 0) + 1)
                      }
                    >
                      +
                    </button>
                  </div>
                </div>
              );
            })}
          </div>
        </section>
      ))}
      {visible.length === 0 && (
        <p className="py-4 text-center text-sm text-[var(--dim)]">
          {remainingOnly && scope.length > 0
            ? "Everything in scope is counted."
            : "No items in this category yet."}
        </p>
      )}

      {showFreezerCheck && (
        <section
          aria-label="Freezer check"
          className="rounded-xl border p-3"
          style={{
            borderColor: "var(--border)",
            backgroundColor: "var(--surface)",
          }}
        >
          <h3 className="text-base font-bold">Freezer check</h3>
          <p className="text-xs text-[var(--dim)]">
            Record each freezer's temperature during this check. Anything
            warmer than −18°C is flagged as a food-safety alert in the
            check summary and the order email.
          </p>
          <div className="mt-2 flex flex-col">
            {business.freezers.map((f) => {
              const raw = temps[f] ?? "";
              const v = raw.trim() === "" ? null : Number(raw);
              const valid = v != null && Number.isFinite(v);
              const alert = valid && v > -18;
              return (
                <div
                  key={f}
                  className="flex flex-wrap items-center gap-2 border-b py-2 last:border-b-0"
                  style={{ borderColor: "var(--border)" }}
                >
                  <span className="min-w-32 flex-1 text-sm font-bold">
                    {f}
                  </span>
                  <input
                    type="number"
                    step="0.1"
                    inputMode="decimal"
                    placeholder="°C"
                    aria-label={`Temperature for ${f} in degrees Celsius`}
                    value={raw}
                    onChange={(e) =>
                      setTemps((prev) => ({ ...prev, [f]: e.target.value }))
                    }
                    className="w-24 rounded-lg border px-2 py-1.5 text-center text-sm font-bold"
                    style={{
                      borderColor: "var(--border)",
                      backgroundColor: "var(--surface)",
                    }}
                  />
                  <span
                    className="text-xs font-bold"
                    style={{
                      color: !valid
                        ? "var(--dim)"
                        : alert
                          ? "var(--red)"
                          : "var(--ok-text)",
                    }}
                  >
                    {!valid
                      ? "Not recorded"
                      : alert
                        ? "⚠ Warmer than −18°C"
                        : "✓ In range"}
                  </span>
                </div>
              );
            })}
          </div>
        </section>
      )}

      {finishError && (
        <p role="alert" className="text-sm font-semibold text-[var(--red)]">
          {finishError}
        </p>
      )}
      <button
        type="button"
        className="rounded-full px-5 py-2.5 text-base font-bold"
        style={{
          backgroundColor: "var(--accent)",
          color: "var(--accent-text)",
          opacity:
            countedCount === 0 || counterName.trim() === "" ? 0.5 : 1,
        }}
        disabled={
          finish.isPending || countedCount === 0 || counterName.trim() === ""
        }
        onClick={() => finish.mutate()}
      >
        {finish.isPending ? "Finishing…" : "Finish check"}
      </button>
      {(countedCount === 0 || counterName.trim() === "") && (
        <p className="-mt-1 text-xs text-[var(--dim)]">
          {counterName.trim() === ""
            ? "Add the counter's name above to finish a check."
            : "Count at least one item to finish a check."}
        </p>
      )}

      {rounds.length > 0 && (
        <section aria-label="Recent inventory checks" className="mt-2">
          <h3 className="text-base font-bold">Recent inventory checks</h3>
          <div className="mt-1 flex flex-col gap-1">
            {rounds.map((r) => {
              const alerts = isFoodBusiness
                ? r.freezerReadings.filter((f) => f.alert)
                : [];
              return (
                <div
                  key={r.id}
                  className="rounded-xl border px-3 py-2 text-sm"
                  style={{
                    borderColor: "var(--border)",
                    backgroundColor: "var(--surface)",
                  }}
                >
                  <p className="font-semibold">
                    {roundDate(r.createdAt)} · {r.counterName}
                    {r.zoneFilter
                      ? ` · ${r.zoneFilter}`
                      : " · All categories"}
                  </p>
                  <p className="text-xs text-[var(--dim)]">
                    Counted {r.counted} of {r.total} ·{" "}
                    {r.variances.length} variance
                    {r.variances.length === 1 ? "" : "s"} ·{" "}
                    {r.belowPar.length} at or below par
                    {alerts.length > 0
                      ? ` · 🧊 ${alerts
                          .map((f) => `${f.freezer} ${f.tempC}°C`)
                          .join(", ")}`
                      : ""}
                  </p>
                </div>
              );
            })}
          </div>
        </section>
      )}
    </div>
  );
}

// ---- POS connection (Inventory tab panel) ---------------------------

type BitPos = NonNullable<BitBusiness["pos"]>;

/** One setup field a provider asks for in the Connect to POS
    panel. `key` matches the details keys stored server-side. */
type PosFieldDef = {
  key: string;
  label: string;
  secret?: boolean;
  hint?: string;
};

/** A named POS provider's own setup: the exact fields the app
    needs, a plain-words step-by-step guide to finding them in
    that provider's dashboard, and any caution the business
    should read first. Researched per provider (Nov 14, 2026). */
type PosProviderDef = {
  name: string;
  intro: string;
  fields: PosFieldDef[];
  steps: string[];
  cautions: string[];
  /** True when the provider offers a Production / Sandbox
      environment choice (Square and Clover only). */
  environment?: boolean;
};

const POS_PROVIDERS: PosProviderDef[] = [
  {
    name: "Square",
    environment: true,
    intro:
      "Square connects with one value: the access token from your own Square developer app. Pick the environment below — Production for the live account, Sandbox for a test account — and use that environment's token.",
    fields: [
      {
        key: "accessToken",
        label: "Access token",
        secret: true,
      },
    ],
    steps: [
      "Go to developer.squareup.com and sign in with the Square account that owns the business.",
      "Click + / New Application (or open an existing application) and name it, for example “HitBit Inventory Sync”.",
      "Open the application, then open Credentials.",
      "Set the environment toggle to the environment you pick below (Production or Sandbox).",
      "Copy that environment's Access token and paste it below.",
    ],
    cautions: [
      "Caution: this token has full access to the whole Square account — payments, refunds, customers, everything. Treat it like a master key: don't share it anywhere else.",
    ],
  },
  {
    name: "Shopify POS",
    intro:
      "Shopify POS sales are ordinary Shopify orders, so one connection covers them. Since January 2026 Shopify no longer lets you create the old in-admin custom app with a copyable token — the working route is a small app you create in Shopify's Dev Dashboard, below.",
    fields: [
      {
        key: "shopDomain",
        label: "Shop domain",
        hint: "Your store's permanent domain, ending in .myshopify.com — not a custom domain.",
      },
      { key: "clientId", label: "Client ID" },
      { key: "clientSecret", label: "Client secret", secret: true },
    ],
    steps: [
      "In Shopify admin, go to Settings → Apps and sales channels → Develop apps.",
      "Click “Build apps in Dev Dashboard” — it opens the Dev Dashboard for your store's organization. (You need to be the store owner, or staff with the Develop permission under App development.)",
      "Choose Apps → Create app → Start from Dev Dashboard, name it (for example “HitBit Inventory Sync”), and click Create.",
      "On “Create a version”, set the Admin API access scopes to read_orders, read_products and read_locations, then click Release.",
      "Install the app on your store: from the app's Installs / Home card, pick the store and approve the scopes.",
      "Open the app's Settings page in the Dev Dashboard and copy the Client ID and Client secret, then paste them below along with your shop domain.",
    ],
    cautions: [],
  },
  {
    name: "Lightspeed Retail (X-Series)",
    intro:
      "Lightspeed Retail comes in two unrelated versions — this is X-Series (your address looks like yourstore.retail.lightspeed.app). It connects with a personal token.",
    fields: [
      {
        key: "domainPrefix",
        label: "Domain prefix",
        hint: "The first part of your Lightspeed address — for mystore.retail.lightspeed.app, the prefix is “mystore”.",
      },
      { key: "personalToken", label: "Personal token", secret: true },
    ],
    steps: [
      "Sign in to Lightspeed Retail (X-Series) as an Admin user.",
      "Go to Setup → Personal tokens.",
      "Click “Add Personal token”.",
      "Give it a name (for example “HitBit Inventory Sync”) and leave the expiry date off, so the connection doesn't lapse.",
      "Click “Generate personal token” and copy the token right away — it is shown only once — then paste it below, together with your domain prefix.",
    ],
    cautions: [
      "Personal tokens are only available on Lightspeed's Plus plan, and only an Admin user can create one — if you don't see Personal tokens under Setup, that's why.",
      "Caution: a personal token is not limited to read-only access — it carries the full permissions of the admin user who created it. Treat it like a master key.",
    ],
  },
  {
    name: "Lightspeed Retail (R-Series)",
    intro:
      "Lightspeed Retail comes in two unrelated versions — this is R-Series. Unlike the others, there is no token or key for you to create and paste here: R-Series connects only when you sign in at Lightspeed and approve this app, and that approval screen can only exist once this app itself is registered with Lightspeed as an OAuth app.",
    fields: [],
    steps: [
      "For now, just save this choice below — nothing else is needed from you today.",
      "Once this app's registration with Lightspeed is complete, you'll click Connect here, sign in at Lightspeed with a user who can authorize apps, review the permissions, and click Authorize.",
      "Lightspeed then sends you back here, and the daily sales sync can use the connection — you never handle a credential.",
    ],
    cautions: [],
  },
  {
    name: "Clover",
    environment: true,
    intro:
      "Clover connects per location: each location is its own merchant, with its own Merchant ID and its own API token. Pick the environment below — Production for a live location, Sandbox for a test merchant — and use that environment's values.",
    fields: [
      {
        key: "merchantId",
        label: "Merchant ID",
        hint: "Per location — repeat this setup for each location you want synced.",
      },
      { key: "apiToken", label: "API token", secret: true },
    ],
    steps: [
      "Find your Merchant ID first: sign in to the Clover Dashboard and open Account & Setup → Merchants (or Business Information) — the Merchant ID is shown under the business name.",
      "Click the Settings gear (top right) → View all settings.",
      "Under Business Operations, open API tokens.",
      "Click “Create new token”, name it (for example “HitBit Inventory Sync”), and tick the Read permissions for Orders, Inventory and Merchant.",
      "Click Create Token, copy the token, and paste it below together with the Merchant ID.",
    ],
    cautions: [
      "Worth knowing: Clover officially describes this dashboard token as a testing token, and its supported route for production apps is installing an approved app from the Clover App Market. In practice the token works and many tools rely on it — but that's the trade-off, and the choice is yours.",
    ],
  },
  {
    name: "Toast",
    intro:
      "Toast connects with read-only “Standard API” credentials you create in Toast Web, plus one restaurant GUID per location.",
    fields: [
      { key: "clientId", label: "Client ID" },
      { key: "clientSecret", label: "Client secret", secret: true },
      {
        key: "restaurantGuid",
        label: "Restaurant GUID",
        hint: "Per location — Toast emails it to you (step 6 below).",
      },
    ],
    steps: [
      "Before you start: you must be an active employee of the location with the Manage Integrations permission, and the location needs a Toast Restaurant Management Suite (RMS) Essentials-or-higher subscription — without those, the pages below won't appear.",
      "Sign in to Toast Web and go to Integrations → Toast API access → Manage credentials.",
      "Click the dropdown arrow on “Create new credentials” and choose Standard API.",
      "Name the credential (for example “HitBit Inventory Sync”), tick the read scopes — orders:read, plus menus:read and restaurants:read — choose the location(s), then Apply → Confirm.",
      "On the Credentials page, copy the Client ID and the client secret right away — the secret is shown only once — and paste them below.",
      "Toast sends an access-confirmation email listing each location's name and restaurant GUID. Copy this location's GUID from that email and paste it below.",
    ],
    cautions: [],
  },
];

function posProviderDef(name: string): PosProviderDef | null {
  return POS_PROVIDERS.find((p) => p.name === name) ?? null;
}

/** Labels for the saved-detail rows in the connection summary. */
const POS_DETAIL_LABELS: Record<string, string> = {
  environment: "Environment",
  accessToken: "Access token",
  shopDomain: "Shop domain",
  clientId: "Client ID",
  clientSecret: "Client secret",
  domainPrefix: "Domain prefix",
  personalToken: "Personal token",
  merchantId: "Merchant ID",
  apiToken: "API token",
  restaurantGuid: "Restaurant GUID",
};

/** How a custom POS can share its data (the popup's choice). */
const POS_SHARE_METHODS = [
  "API key",
  "OAuth sign-in",
  "Webhook",
  "Scheduled CSV export",
] as const;

/** "Custom: <name>" for a custom POS, the plain name otherwise. */
function posDisplayName(pos: BitPos): string {
  return pos.kind === "custom" ? `Custom: ${pos.provider}` : pos.provider;
}

/** " · Sandbox" when the connection points at the provider's test
    environment, so a test connection is never mistaken for a live
    one. Production (or unset) adds nothing. */
function posEnvironmentSuffix(pos: BitPos): string {
  return pos.details?.environment === "Sandbox" ? " · Sandbox" : "";
}

/**
 * The Connect to POS panel: with no connection it lists the six
 * named POS systems plus "Other / Custom POS". Picking a named
 * system shows THAT provider's own setup — the exact fields it
 * needs and a step-by-step guide to finding them in the
 * provider's dashboard (see POS_PROVIDERS). Secrets are stored
 * server-side only and come back masked; the form pre-fills
 * non-secret values and asks for a secret again only to change
 * it. A named save with its fields filled in reads "Credentials
 * saved — daily sync ready"; Lightspeed Retail (R-Series) has
 * no fields — it saves as "Awaiting app registration". Picking
 * Other opens a popup form for an unknown system's connection
 * details, saved as "Details saved". With a connection saved,
 * the panel shows its summary with Change POS (back to the list)
 * and Disconnect (confirmed inline first). Saving stores the
 * setup only — no provider API call is made from it. The summary
 * also carries the daily pull (Alpha 0.67): whether daily sync is
 * on, the last recorded pull's result, and a "Sync now" button
 * that records a sync request and runs the same pull on demand.
 */
function parsePosCsv(text: string): { ref: string; qty: number }[] {
  const lines = text.split(/\r?\n/).filter((l) => l.trim().length > 0);
  if (lines.length < 2) return [];
  const splitRow = (row: string): string[] => {
    const out: string[] = [];
    let cur = "";
    let inQuotes = false;
    for (let i = 0; i < row.length; i++) {
      const ch = row[i] ?? "";
      if (inQuotes) {
        if (ch === '"') {
          if (row[i + 1] === '"') { cur += '"'; i++; } else inQuotes = false;
        } else cur += ch;
      } else if (ch === '"') inQuotes = true;
      else if (ch === "," || ch === "\t" || ch === ";") { out.push(cur.trim()); cur = ""; }
      else cur += ch;
    }
    out.push(cur.trim());
    return out;
  };
  const headers = splitRow(lines[0] ?? "").map((h) => h.trim().toLowerCase());
  const findCol = (names: string[], contains: string[]): number => {
    let idx = headers.findIndex((h) => names.includes(h));
    if (idx >= 0) return idx;
    idx = headers.findIndex((h) => contains.some((c) => h.includes(c)));
    return idx;
  };
  const skuIdx = findCol(["sku", "item sku", "product sku", "upc", "code", "barcode"], ["sku", "upc"]);
  const nameIdx = findCol(["item", "name", "item name", "product", "product name", "description", "title"], ["name", "item", "product"]);
  const qtyIdx = findCol(["qty", "quantity", "sold", "quantity sold", "units", "units sold", "count"], ["qty", "quantity", "sold"]);
  const refIdx = skuIdx >= 0 ? skuIdx : nameIdx;
  if (refIdx < 0 || qtyIdx < 0) return [];
  const out: { ref: string; qty: number }[] = [];
  for (const row of lines.slice(1)) {
    const cols = splitRow(row);
    const ref = (cols[refIdx] ?? "").trim();
    const qty = Math.floor(Number(cols[qtyIdx] ?? ""));
    if (ref && Number.isFinite(qty) && qty > 0) out.push({ ref, qty });
  }
  return out;
}

function PosPanel({
  pos,
  items,
  businessId,
}: {
  pos: BitPos | null;
  items: BitItem[];
  businessId: number;
}) {
  const queryClient = useQueryClient();
  const [view, setView] = useState<"summary" | "list" | "connect">(
    pos ? "summary" : "list",
  );
  const posLog = useQuery({
    queryKey: ["bit-pos-log", businessId],
    queryFn: async () => await api.listBitPosLog({ businessId }),
  });
  const [testItemId, setTestItemId] = useState<string>("");
  const [testQty, setTestQty] = useState<string>("1");
  const [testMsg, setTestMsg] = useState<string | null>(null);
  const [csvPreview, setCsvPreview] = useState<
    { ref: string; qty: number; willMatch: boolean; matchedName: string | null }[] | null
  >(null);
  const [csvMsg, setCsvMsg] = useState<string | null>(null);
  const [matchPicks, setMatchPicks] = useState<Record<number, string>>({});
  const invalidatePos = () => {
    void queryClient.invalidateQueries({ queryKey: ["bit"] });
    void queryClient.invalidateQueries({ queryKey: ["bit-pos-log"] });
  };
  const applySale = useMutation({
    mutationFn: async (vars: {
      source: string;
      externalId: string | null;
      lines: { sku?: string | null; name?: string | null; qty: number }[];
    }) => await api.applyBitPosSale({ businessId, ...vars }),
    onSuccess: (res, vars) => {
      if (res.ok) {
        if (vars.source === "Test") {
          setTestMsg(
            res.duplicate
              ? "That sale was already applied (duplicate) — nothing changed."
              : `Test sale applied: ${res.applied} matched, ${res.unmatched} unmatched.`,
          );
        } else {
          setCsvMsg(
            res.duplicate
              ? "That import was already applied (duplicate) — nothing changed."
              : `CSV import applied: ${res.applied} matched, ${res.unmatched} unmatched.`,
          );
          if (!res.duplicate) setCsvPreview(null);
        }
      } else {
        if (vars.source === "Test") setTestMsg(res.error ?? "The test sale couldn't be applied.");
        else setCsvMsg(res.error ?? "The CSV import couldn't be applied.");
      }
      invalidatePos();
    },
    onError: () => setTestMsg("That sale couldn't be applied. Try again."),
  });
  const undoTx = useMutation({
    mutationFn: async (id: number) => await api.undoBitPosTransaction({ id }),
    onSuccess: () => invalidatePos(),
  });
  const matchTx = useMutation({
    mutationFn: async (vars: { id: number; itemId: number }) =>
      await api.matchBitPosUnmatched(vars),
    onSuccess: () => invalidatePos(),
  });
  const [syncMsg, setSyncMsg] = useState<string | null>(null);
  /** "Sync now": record the request, then run the same daily pull
      the daily trigger runs — the panel shows the recorded result
      as the last pull. */
  const syncNow = useMutation({
    mutationFn: async (): Promise<
      | { ok: false; error: string | null }
      | {
          ok: true;
          error: null;
          ran: boolean;
          run: ApiResponse<typeof api, "pullBitPosDaily">["run"];
        }
    > => {
      const req = await api.requestBitPosSync({ businessId });
      if (!req.ok) return { ok: false, error: req.error };
      const res = await api.pullBitPosDaily({ businessId });
      return { ok: true, error: null, ran: res.ran, run: res.run };
    },
    onSuccess: (res) => {
      if (!res.ok) {
        setSyncMsg(res.error ?? "The sync couldn't be started.");
      } else if (!res.ran || !res.run) {
        setSyncMsg("Daily sync isn't on for this connection yet.");
      } else if (res.run.status === "ok") {
        setSyncMsg(
          `Sync finished: ${res.run.ordersSeen} orders seen, ${res.run.linesApplied} lines applied, ${res.run.linesUnmatched} unmatched${res.run.duplicates > 0 ? `, ${res.run.duplicates} duplicate orders ignored` : ""}.`,
        );
      } else if (res.run.status === "skipped") {
        setSyncMsg(res.run.error ?? "This provider can't be pulled yet.");
      } else {
        setSyncMsg(res.run.error ?? "The sync failed.");
      }
      invalidatePos();
    },
    onError: () => setSyncMsg("The sync couldn't run. Try again."),
  });
  const [provider, setProvider] = useState<string | null>(null);
  /** The picked provider's setup-field inputs. Non-secret fields
      pre-fill from the saved (unmasked) values; secret fields
      start blank — blank means "keep the saved one". */
  const [detailValues, setDetailValues] = useState<Record<string, string>>({});
  const openConnect = (def: PosProviderDef) => {
    const initial: Record<string, string> = {};
    for (const f of def.fields) {
      initial[f.key] =
        !f.secret && pos && pos.provider === def.name
          ? (pos.details?.[f.key as keyof NonNullable<BitPos["details"]>] ?? "")
          : "";
    }
    if (def.environment) {
      initial.environment =
        pos && pos.provider === def.name
          ? (pos.details?.environment ?? "Production")
          : "Production";
    }
    setDetailValues(initial);
    setProvider(def.name);
    setError(null);
    setView("connect");
  };
  const [customOpen, setCustomOpen] = useState(false);
  const [confirmingDisconnect, setConfirmingDisconnect] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [custom, setCustom] = useState({
    name: "",
    shareMethod: "API key",
    endpointUrl: "",
    apiKey: "",
    locationId: "",
    notes: "",
  });

  const save = useMutation({
    mutationFn: async (vars: {
      provider: string;
      kind: "named" | "custom";
      shareMethod: string | null;
      endpointUrl: string | null;
      apiKey: string | null;
      locationId: string | null;
      notes: string | null;
      details: {
        environment?: string | null;
        accessToken?: string | null;
        shopDomain?: string | null;
        clientId?: string | null;
        clientSecret?: string | null;
        domainPrefix?: string | null;
        personalToken?: string | null;
        merchantId?: string | null;
        apiToken?: string | null;
        restaurantGuid?: string | null;
      } | null;
    }) => await api.saveBitPosConnection({ businessId, ...vars }),
    onSuccess: (res) => {
      if (res.ok) {
        setError(null);
        setCustomOpen(false);
        setConfirmingDisconnect(false);
        setView("summary");
        void queryClient.invalidateQueries({ queryKey: ["bit"] });
      } else {
        setError(res.error ?? "The connection couldn't be saved.");
      }
    },
    onError: () => setError("The connection couldn't be saved. Try again."),
  });

  const disconnect = useMutation({
    mutationFn: async () => await api.clearBitPosConnection({ businessId }),
    onSuccess: () => {
      setConfirmingDisconnect(false);
      setProvider(null);
      setView("list");
      void queryClient.invalidateQueries({ queryKey: ["bit"] });
    },
    onError: () => setError("Disconnecting didn't work. Try again."),
  });

  const field =
    "rounded-lg border px-2 py-1.5 text-sm font-normal text-[var(--text)]";
  const fieldStyle = {
    borderColor: "var(--border)",
    backgroundColor: "var(--surface)",
  } as const;
  const primaryBtn =
    "rounded-full bg-[var(--accent)] px-4 py-2 text-sm font-bold text-[var(--accent-text)]";
  const plainBtn =
    "rounded-full border border-[var(--border)] bg-[var(--surface)] px-4 py-2 text-sm font-bold text-[var(--text)]";

  return (
    <div
      className="rounded-xl border p-3"
      style={{
        borderColor: "var(--border)",
        backgroundColor: "var(--surface)",
      }}
    >
      <h3 className="text-base font-bold">Connect to POS</h3>

      {view === "summary" && pos && (
        <div className="mt-1">
          <dl className="mt-1 flex flex-col gap-1 text-sm">
            <div className="flex gap-2">
              <dt className="w-24 shrink-0 font-semibold text-[var(--dim)]">
                Provider
              </dt>
              <dd className="font-bold">
                {posDisplayName(pos)}
                {posEnvironmentSuffix(pos)}
              </dd>
            </div>
            <div className="flex gap-2">
              <dt className="w-24 shrink-0 font-semibold text-[var(--dim)]">
                Status
              </dt>
              <dd>{pos.status}</dd>
            </div>
            <div className="flex gap-2">
              <dt className="w-24 shrink-0 font-semibold text-[var(--dim)]">
                Set up
              </dt>
              <dd>{roundDate(pos.connectedAt)}</dd>
            </div>
            <div className="flex gap-2">
              <dt className="w-24 shrink-0 font-semibold text-[var(--dim)]">
                Access
              </dt>
              <dd>
                {pos.kind === "named"
                  ? pos.provider === "Lightspeed Retail (R-Series)"
                    ? "Sign-in approval at Lightspeed (OAuth) — no credential is stored here; it activates once this app is registered with Lightspeed."
                    : pos.details
                      ? "The setup values below, saved for the daily sales sync. Secrets are stored on the server and shown masked."
                      : "Read-only access to orders / transactions and the product catalogue, granted by signing in at the provider."
                  : `Shares data by: ${pos.shareMethod ?? "—"}`}
              </dd>
            </div>
            {pos.kind === "named" &&
              pos.details &&
              Object.entries(pos.details)
                .filter(([, v]) => v != null && v !== "")
                .map(([key, v]) => (
                  <div key={key} className="flex gap-2">
                    <dt className="w-24 shrink-0 font-semibold text-[var(--dim)]">
                      {POS_DETAIL_LABELS[key] ?? key}
                    </dt>
                    <dd className="min-w-0 break-all">{v}</dd>
                  </div>
                ))}
            {pos.kind === "custom" && pos.endpointUrl && (
              <div className="flex gap-2">
                <dt className="w-24 shrink-0 font-semibold text-[var(--dim)]">
                  Endpoint
                </dt>
                <dd className="min-w-0 break-all">{pos.endpointUrl}</dd>
              </div>
            )}
            {pos.kind === "custom" && pos.locationId && (
              <div className="flex gap-2">
                <dt className="w-24 shrink-0 font-semibold text-[var(--dim)]">
                  Location
                </dt>
                <dd>{pos.locationId}</dd>
              </div>
            )}
            {pos.kind === "custom" && pos.notes && (
              <div className="flex gap-2">
                <dt className="w-24 shrink-0 font-semibold text-[var(--dim)]">
                  Notes
                </dt>
                <dd>{pos.notes}</dd>
              </div>
            )}
            {pos.kind === "named" && (
              <div className="flex gap-2">
                <dt className="w-24 shrink-0 font-semibold text-[var(--dim)]">
                  Daily sync
                </dt>
                <dd>
                  {pos.dailySyncOn
                    ? "On — yesterday's completed sales are pulled from the provider automatically once a day and applied to the counts."
                    : pos.provider === "Lightspeed Retail (R-Series)"
                      ? "Not available yet — R-Series connects by sign-in approval once this app is registered with Lightspeed, so there is no credential to pull with."
                      : "Off — it turns on once this connection's setup values are saved."}
                </dd>
              </div>
            )}
            {pos.kind === "named" && (
              <div className="flex gap-2">
                <dt className="w-24 shrink-0 font-semibold text-[var(--dim)]">
                  Last pull
                </dt>
                <dd>
                  {pos.lastSync == null
                    ? "No pull has run yet."
                    : pos.lastSync.status === "ok"
                      ? `${roundDate(pos.lastSync.createdAt)} — ${pos.lastSync.ordersSeen} orders seen, ${pos.lastSync.linesApplied} lines applied, ${pos.lastSync.linesUnmatched} unmatched${pos.lastSync.duplicates > 0 ? `, ${pos.lastSync.duplicates} duplicate orders ignored` : ""}${pos.lastSync.dayKey ? ` (day ${pos.lastSync.dayKey})` : ""}.`
                      : pos.lastSync.status === "skipped"
                        ? `${roundDate(pos.lastSync.createdAt)} — skipped. ${pos.lastSync.error ?? ""}`
                        : `${roundDate(pos.lastSync.createdAt)} — failed. ${pos.lastSync.error ?? ""}`}
                </dd>
              </div>
            )}
          </dl>
          {confirmingDisconnect ? (
            <div className="mt-3 flex flex-wrap items-center gap-2">
              <span className="text-sm font-semibold">
                Disconnect {posDisplayName(pos)}? The saved connection
                details will be cleared.
              </span>
              <button
                type="button"
                className="rounded-full px-4 py-2 text-sm font-bold"
                style={{
                  backgroundColor: "var(--red)",
                  color: "var(--heart-text)",
                }}
                disabled={disconnect.isPending}
                onClick={() => disconnect.mutate()}
              >
                {disconnect.isPending ? "Disconnecting…" : "Yes, disconnect"}
              </button>
              <button
                type="button"
                className={plainBtn}
                onClick={() => setConfirmingDisconnect(false)}
              >
                Keep it
              </button>
            </div>
          ) : (
            <div className="mt-3 flex flex-wrap gap-2">
              {pos.kind === "named" && (
                <button
                  type="button"
                  className={primaryBtn}
                  disabled={syncNow.isPending}
                  onClick={() => syncNow.mutate()}
                >
                  {syncNow.isPending ? "Syncing…" : "Sync now"}
                </button>
              )}
              <button
                type="button"
                className={primaryBtn}
                onClick={() => {
                  setProvider(null);
                  setView("list");
                }}
              >
                Change POS
              </button>
              <button
                type="button"
                className={plainBtn}
                onClick={() => setConfirmingDisconnect(true)}
              >
                Disconnect
              </button>
            </div>
          )}
          {syncMsg && (
            <p className="mt-2 text-sm font-semibold" role="status">
              {syncMsg}
            </p>
          )}
        </div>
      )}

      {view === "list" && (
        <div className="mt-1">
          <p className="text-sm text-[var(--dim)]">
            Pick the point-of-sale system this business uses. BIT can
            watch its sales to keep counts up to date once the
            connection is authorized.
          </p>
          <div className="mt-2 flex flex-col gap-1.5">
            {POS_PROVIDERS.map((p) => (
              <button
                key={p.name}
                type="button"
                className="rounded-lg border px-3 py-2 text-left text-sm font-bold"
                style={{
                  borderColor: "var(--border)",
                  backgroundColor: "var(--surface)",
                }}
                onClick={() => openConnect(p)}
              >
                {p.name}
              </button>
            ))}
            <button
              type="button"
              className="rounded-lg border px-3 py-2 text-left text-sm font-bold"
              style={{
                borderColor: "var(--border)",
                backgroundColor: "var(--surface-alt)",
              }}
              onClick={() => {
                setError(null);
                setCustomOpen(true);
              }}
            >
              Other / Custom POS
            </button>
          </div>
          {pos && (
            <button
              type="button"
              className="mt-2 text-sm font-bold text-[var(--dim)]"
              onClick={() => setView("summary")}
            >
              ← Back to the current connection
            </button>
          )}
        </div>
      )}

      {view === "connect" && provider && posProviderDef(provider) && (
        <div className="mt-1">
          {(() => {
            const def = posProviderDef(provider) as PosProviderDef;
            const savedHere = pos != null && pos.provider === provider;
            const savedMasked = (key: string): string | null =>
              savedHere
                ? (pos.details?.[
                    key as keyof NonNullable<BitPos["details"]>
                  ] ?? null)
                : null;
            const allFilled = def.fields.every((f) => {
              const v = (detailValues[f.key] ?? "").trim();
              return v !== "" || (f.secret && savedMasked(f.key) != null);
            });
            return (
              <>
                <p className="text-sm font-bold">{def.name}</p>
                <p className="mt-1 text-sm text-[var(--dim)]">{def.intro}</p>

                <h4 className="mt-3 text-sm font-bold">
                  {def.fields.length > 0
                    ? "How to get set up, step by step"
                    : "What happens next"}
                </h4>
                <ol className="mt-1 flex list-decimal flex-col gap-1 pl-5 text-sm text-[var(--dim)]">
                  {def.steps.map((s) => (
                    <li key={s}>{s}</li>
                  ))}
                </ol>
                {def.cautions.map((c) => (
                  <p
                    key={c}
                    className="mt-2 rounded-lg px-2 py-1.5 text-sm font-semibold"
                    style={{
                      backgroundColor: "var(--amber-soft)",
                      color: "var(--amber)",
                    }}
                  >
                    {c}
                  </p>
                ))}

                {def.fields.length > 0 && (
                  <form
                    className="mt-3 flex flex-col gap-2"
                    onSubmit={(e) => {
                      e.preventDefault();
                      const details: Record<string, string | null> = {};
                      for (const f of def.fields) {
                        details[f.key] =
                          (detailValues[f.key] ?? "").trim() || null;
                      }
                      if (def.environment) {
                        details.environment =
                          detailValues.environment === "Sandbox"
                            ? "Sandbox"
                            : "Production";
                      }
                      save.mutate({
                        provider,
                        kind: "named",
                        shareMethod: null,
                        endpointUrl: null,
                        apiKey: null,
                        locationId: null,
                        notes: null,
                        details,
                      });
                    }}
                  >
                    {def.environment && (
                      <div className="flex flex-col gap-0.5">
                        <span className="text-xs font-semibold text-[var(--dim)]">
                          Environment
                        </span>
                        <div
                          className="flex rounded-full p-1"
                          style={{ backgroundColor: "var(--surface-alt)" }}
                          role="group"
                          aria-label={`${def.name} environment`}
                        >
                          {(["Production", "Sandbox"] as const).map(
                            (env) => (
                              <button
                                key={env}
                                type="button"
                                aria-pressed={
                                  (detailValues.environment ??
                                    "Production") === env
                                }
                                onClick={() =>
                                  setDetailValues({
                                    ...detailValues,
                                    environment: env,
                                  })
                                }
                                className="flex-1 rounded-full px-2 py-1.5 text-sm font-bold"
                                style={
                                  (detailValues.environment ??
                                    "Production") === env
                                    ? {
                                        backgroundColor: "var(--accent)",
                                        color: "var(--accent-text)",
                                      }
                                    : { color: "var(--dim)" }
                                }
                              >
                                {env}
                              </button>
                            ),
                          )}
                        </div>
                        <span className="text-xs font-normal text-[var(--dim)]">
                          Sandbox is the provider's test environment —
                          use it with a test account; its sales never
                          touch a live business.
                        </span>
                      </div>
                    )}
                    {def.fields.map((f) => {
                      const masked = f.secret ? savedMasked(f.key) : null;
                      return (
                        <label
                          key={f.key}
                          className="flex flex-col gap-0.5 text-xs font-semibold text-[var(--dim)]"
                        >
                          {f.label}
                          <input
                            type={f.secret ? "password" : "text"}
                            value={detailValues[f.key] ?? ""}
                            aria-label={`${def.name} ${f.label}`}
                            placeholder={
                              masked
                                ? `Saved (${masked}) — leave blank to keep it`
                                : undefined
                            }
                            onChange={(e) =>
                              setDetailValues({
                                ...detailValues,
                                [f.key]: e.target.value,
                              })
                            }
                            className={field}
                            style={fieldStyle}
                            autoComplete="off"
                          />
                          {f.hint && (
                            <span className="font-normal">{f.hint}</span>
                          )}
                          {masked && (
                            <span className="font-normal">
                              A value is already saved ({masked}). Only type
                              a new one if you want to replace it.
                            </span>
                          )}
                        </label>
                      );
                    })}
                    <div className="mt-1 flex flex-wrap gap-2">
                      <button
                        type="submit"
                        className={primaryBtn}
                        disabled={save.isPending || !allFilled}
                      >
                        {save.isPending
                          ? "Saving…"
                          : savedHere
                            ? "Save setup"
                            : `Save ${def.name} setup`}
                      </button>
                      <button
                        type="button"
                        className={plainBtn}
                        onClick={() => {
                          setProvider(null);
                          setView("list");
                        }}
                      >
                        Back
                      </button>
                    </div>
                  </form>
                )}

                {def.fields.length === 0 && (
                  <div className="mt-3 flex flex-wrap gap-2">
                    <button
                      type="button"
                      className={primaryBtn}
                      disabled={save.isPending}
                      onClick={() =>
                        save.mutate({
                          provider,
                          kind: "named",
                          shareMethod: null,
                          endpointUrl: null,
                          apiKey: null,
                          locationId: null,
                          notes: null,
                          details: null,
                        })
                      }
                    >
                      {save.isPending
                        ? "Saving…"
                        : `Save ${def.name} as my POS`}
                    </button>
                    <button
                      type="button"
                      className={plainBtn}
                      onClick={() => {
                        setProvider(null);
                        setView("list");
                      }}
                    >
                      Back
                    </button>
                  </div>
                )}
              </>
            );
          })()}
        </div>
      )}

      {error && (
        <p role="alert" className="mt-2 text-sm font-semibold text-[var(--red)]">
          {error}
        </p>
      )}

      {customOpen && (
        <div
          className="fixed inset-0 z-50 flex items-end justify-center p-4 sm:items-center"
          style={{ backgroundColor: "rgba(0, 0, 0, 0.45)" }}
          onClick={() => setCustomOpen(false)}
        >
          <div
            role="dialog"
            aria-modal="true"
            aria-label="Custom POS details"
            className="max-h-[90dvh] w-full max-w-md overflow-y-auto rounded-2xl border p-4"
            style={{
              borderColor: "var(--border)",
              backgroundColor: "var(--surface)",
            }}
            onClick={(e) => e.stopPropagation()}
          >
            <h3 className="text-base font-bold">Custom POS details</h3>
            <p className="mt-1 text-sm text-[var(--dim)]">
              Tell BIT what this system is and how it can share its
              sales data, so the connection can be set up.
            </p>
            <form
              className="mt-2 flex flex-col gap-2"
              onSubmit={(e) => {
                e.preventDefault();
                if (!custom.name.trim()) {
                  setError("Give the POS a name.");
                  return;
                }
                save.mutate({
                  provider: custom.name.trim(),
                  kind: "custom",
                  shareMethod: custom.shareMethod,
                  endpointUrl: custom.endpointUrl.trim() || null,
                  apiKey: custom.apiKey.trim() || null,
                  locationId: custom.locationId.trim() || null,
                  notes: custom.notes.trim() || null,
                  details: null,
                });
              }}
            >
              <label className="flex flex-col gap-0.5 text-xs font-semibold text-[var(--dim)]">
                POS name (required)
                <input
                  value={custom.name}
                  aria-label="Custom POS name"
                  onChange={(e) =>
                    setCustom({ ...custom, name: e.target.value })
                  }
                  className={field}
                  style={fieldStyle}
                  autoComplete="off"
                />
              </label>
              <label className="flex flex-col gap-0.5 text-xs font-semibold text-[var(--dim)]">
                How it can share data
                <select
                  value={custom.shareMethod}
                  aria-label="How the POS shares data"
                  onChange={(e) =>
                    setCustom({ ...custom, shareMethod: e.target.value })
                  }
                  className={field}
                  style={fieldStyle}
                >
                  {POS_SHARE_METHODS.map((m) => (
                    <option key={m} value={m}>
                      {m}
                    </option>
                  ))}
                </select>
              </label>
              <label className="flex flex-col gap-0.5 text-xs font-semibold text-[var(--dim)]">
                API endpoint URL
                <input
                  value={custom.endpointUrl}
                  aria-label="POS API endpoint URL"
                  onChange={(e) =>
                    setCustom({ ...custom, endpointUrl: e.target.value })
                  }
                  className={field}
                  style={fieldStyle}
                  autoComplete="off"
                  inputMode="url"
                  placeholder="https://…"
                />
              </label>
              <label className="flex flex-col gap-0.5 text-xs font-semibold text-[var(--dim)]">
                API key / access token
                <input
                  type="password"
                  value={custom.apiKey}
                  aria-label="POS API key or access token"
                  onChange={(e) =>
                    setCustom({ ...custom, apiKey: e.target.value })
                  }
                  className={field}
                  style={fieldStyle}
                  autoComplete="off"
                />
              </label>
              <label className="flex flex-col gap-0.5 text-xs font-semibold text-[var(--dim)]">
                Location / store ID (optional)
                <input
                  value={custom.locationId}
                  aria-label="POS location or store ID"
                  onChange={(e) =>
                    setCustom({ ...custom, locationId: e.target.value })
                  }
                  className={field}
                  style={fieldStyle}
                  autoComplete="off"
                />
              </label>
              <label className="flex flex-col gap-0.5 text-xs font-semibold text-[var(--dim)]">
                Notes about the system (optional)
                <textarea
                  value={custom.notes}
                  aria-label="Notes about the POS system"
                  onChange={(e) =>
                    setCustom({ ...custom, notes: e.target.value })
                  }
                  className={field}
                  style={fieldStyle}
                  rows={3}
                />
              </label>
              <div className="mt-1 flex flex-wrap gap-2">
                <button
                  type="submit"
                  className={primaryBtn}
                  disabled={save.isPending || !custom.name.trim()}
                >
                  {save.isPending ? "Saving…" : "Save POS details"}
                </button>
                <button
                  type="button"
                  className={plainBtn}
                  onClick={() => setCustomOpen(false)}
                >
                  Cancel
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* ---- POS sync intakes + log (Alpha 0.65) ---- */}
      <div className="mt-4 border-t pt-3" style={{ borderColor: "var(--border)" }}>
        <h4 className="text-sm font-bold">Test sale</h4>
        <p className="mt-0.5 text-sm text-[var(--dim)]">
          Works with no POS connected — it runs through the same sale path as a real POS sale.
        </p>
        <div className="mt-2 flex flex-wrap items-end gap-2">
          <label className="flex min-w-0 flex-1 flex-col gap-0.5 text-xs font-semibold text-[var(--dim)]">
            Item
            <select
              aria-label="Test sale item"
              value={testItemId}
              onChange={(e) => setTestItemId(e.target.value)}
              className={field}
              style={fieldStyle}
            >
              <option value="">Pick an item…</option>
              {items.map((it) => (
                <option key={it.id} value={String(it.id)}>
                  {it.name}
                </option>
              ))}
            </select>
          </label>
          <label className="flex w-24 flex-col gap-0.5 text-xs font-semibold text-[var(--dim)]">
            Quantity
            <input
              aria-label="Test sale quantity"
              type="number"
              min={1}
              value={testQty}
              onChange={(e) => setTestQty(e.target.value)}
              className={field}
              style={fieldStyle}
            />
          </label>
          <button
            type="button"
            className={primaryBtn}
            disabled={applySale.isPending || !testItemId}
            onClick={() => {
              const item = items.find((it) => String(it.id) === testItemId);
              if (!item) return;
              const qty = Math.max(1, Math.floor(Number(testQty) || 1));
              setTestMsg(null);
              applySale.mutate({
                source: "Test",
                externalId: null,
                lines: [
                  item.sku
                    ? { sku: item.sku, qty }
                    : { name: item.name, qty },
                ],
              });
            }}
          >
            Apply test sale
          </button>
        </div>
        {testMsg && <p className="mt-1 text-sm font-semibold">{testMsg}</p>}

        <h4 className="mt-4 text-sm font-bold">CSV sales report import</h4>
        <p className="mt-0.5 text-sm text-[var(--dim)]">
          Upload a CSV with an item/name or SKU column and a qty/quantity/sold column.
        </p>
        <label className="mt-2 flex flex-col gap-0.5 text-xs font-semibold text-[var(--dim)]">
          CSV sales report file
          <input
            type="file"
            accept=".csv,text/csv,text/plain"
            aria-label="CSV sales report file"
            className={field}
            style={fieldStyle}
            onChange={async (e) => {
              const file = e.target.files?.[0];
              setCsvMsg(null);
              if (!file) { setCsvPreview(null); return; }
              const text = await file.text();
              const parsed = parsePosCsv(text);
              if (parsed.length === 0) {
                setCsvPreview(null);
                setCsvMsg("No sale lines could be read from that CSV — check it has an item/SKU column and a quantity column.");
                return;
              }
              setCsvPreview(
                parsed.map((row) => {
                  const matched =
                    items.find(
                      (it) =>
                        (it.sku && it.sku.toLowerCase() === row.ref.toLowerCase()) ||
                        it.name.toLowerCase() === row.ref.toLowerCase(),
                    ) ?? null;
                  return {
                    ref: row.ref,
                    qty: row.qty,
                    willMatch: matched != null,
                    matchedName: matched?.name ?? null,
                  };
                }),
              );
            }}
          />
        </label>
        {csvPreview && (
          <div className="mt-2">
            <p className="text-sm font-semibold">
              Preview — {csvPreview.filter((r) => r.willMatch).length} will match,{" "}
              {csvPreview.filter((r) => !r.willMatch).length} won&apos;t match
            </p>
            <ul className="mt-1 flex flex-col gap-0.5 text-sm">
              {csvPreview.map((row, i) => (
                <li key={`${row.ref}-${i}`}>
                  {row.willMatch
                    ? `Will match: ${row.matchedName ?? row.ref} × ${row.qty}`
                    : `Won't match: ${row.ref} × ${row.qty}`}
                </li>
              ))}
            </ul>
            <button
              type="button"
              className={`${primaryBtn} mt-2`}
              disabled={applySale.isPending}
              onClick={() => {
                setCsvMsg(null);
                applySale.mutate({
                  source: "CSV import",
                  externalId: null,
                  lines: csvPreview.map((row) => ({
                    sku: row.ref,
                    name: row.ref,
                    qty: row.qty,
                  })),
                });
              }}
            >
              Apply CSV import
            </button>
          </div>
        )}
        {csvMsg && <p className="mt-1 text-sm font-semibold">{csvMsg}</p>}

        {pos &&
          pos.kind === "custom" &&
          (pos.shareMethod === "Webhook" || pos.shareMethod === "API key") && (
            <div className="mt-4">
              <h4 className="text-sm font-bold">Webhook intake</h4>
              {pos.intakeToken ? (
                <div className="mt-1 text-sm">
                  <p>
                    Intake token:{" "}
                    <span className="break-all font-bold">{pos.intakeToken}</span>
                  </p>
                  <p className="mt-1 text-[var(--dim)]">
                    Have the POS POST a JSON sale together with this token to the
                    app&apos;s POS intake action (applyBitPosWebhookSale):
                  </p>
                  <pre className="mt-1 overflow-x-auto rounded-lg p-2 text-xs" style={{ backgroundColor: "var(--surface-alt)" }}>
{`{ "token": "<intake token>", "transaction_id": "...", "lines": [{ "sku": "...", "qty": 1 }] }`}
                  </pre>
                  <p className="mt-1 text-[var(--dim)]">
                    Each line uses {`{"sku" or "name": "...", "qty": n}`}. This app
                    does not expose a public webhook URL, so the POS (or a small
                    relay you control) calls that action with the token above —
                    no public URL is shown because none exists yet.
                  </p>
                </div>
              ) : (
                <p className="mt-1 text-sm text-[var(--dim)]">
                  Re-save this connection to generate its intake token.
                </p>
              )}
            </div>
          )}

        <h4 className="mt-4 text-sm font-bold">POS log</h4>
        {posLog.isLoading && <p className="mt-1 text-sm text-[var(--dim)]">Loading POS log…</p>}
        {posLog.data && posLog.data.transactions.length === 0 && posLog.data.unmatched.length === 0 && (
          <p className="mt-1 text-sm text-[var(--dim)]">No POS transactions yet.</p>
        )}
        {posLog.data && posLog.data.transactions.length > 0 && (
          <ul className="mt-1 flex flex-col gap-1.5">
            {posLog.data.transactions.map((tx) => (
              <li
                key={tx.id}
                className="flex flex-wrap items-center gap-2 rounded-lg border px-2 py-1.5 text-sm"
                style={{ borderColor: "var(--border)" }}
              >
                <span className="font-bold">{tx.itemName ?? tx.posRef}</span>
                <span>× {tx.quantity}</span>
                <span className="text-[var(--dim)]">{tx.source}</span>
                <span className="text-[var(--dim)]">{roundDate(tx.createdAt)}</span>
                {tx.belowPar && !tx.undone && (
                  <span
                    className="rounded-full px-2 py-0.5 text-xs font-bold"
                    style={{ backgroundColor: "var(--amber-soft)", color: "var(--amber)" }}
                  >
                    Below par
                  </span>
                )}
                {tx.undone ? (
                  <span className="font-semibold text-[var(--dim)]">Undone</span>
                ) : (
                  <button
                    type="button"
                    aria-label={`Undo sale of ${tx.itemName ?? tx.posRef}`}
                    className={plainBtn}
                    disabled={undoTx.isPending}
                    onClick={() => undoTx.mutate(tx.id)}
                  >
                    Undo
                  </button>
                )}
              </li>
            ))}
          </ul>
        )}
        {posLog.data && posLog.data.unmatched.length > 0 && (
          <div className="mt-3">
            <h5 className="text-sm font-bold">Unmatched lines</h5>
            <ul className="mt-1 flex flex-col gap-1.5">
              {posLog.data.unmatched.map((u) => (
                <li
                  key={u.id}
                  className="flex flex-wrap items-center gap-2 rounded-lg border px-2 py-1.5 text-sm"
                  style={{ borderColor: "var(--border)" }}
                >
                  <span className="font-bold">{u.posRef || "(no reference)"}</span>
                  <span>× {u.quantity}</span>
                  <span className="text-[var(--dim)]">{u.source}</span>
                  <span className="text-[var(--dim)]">{roundDate(u.createdAt)}</span>
                  <label className="flex items-center gap-1 text-xs font-semibold text-[var(--dim)]">
                    Match to item
                    <select
                      aria-label={`Match ${u.posRef} to item`}
                      value={matchPicks[u.id] ?? ""}
                      onChange={(e) =>
                        setMatchPicks((prev) => ({ ...prev, [u.id]: e.target.value }))
                      }
                      className={field}
                      style={fieldStyle}
                    >
                      <option value="">Pick an item…</option>
                      {items.map((it) => (
                        <option key={it.id} value={String(it.id)}>
                          {it.name}
                        </option>
                      ))}
                    </select>
                  </label>
                  <button
                    type="button"
                    aria-label={`Match ${u.posRef} to selected item`}
                    className={primaryBtn}
                    disabled={matchTx.isPending || !matchPicks[u.id]}
                    onClick={() => {
                      const itemId = Number(matchPicks[u.id]);
                      if (itemId) matchTx.mutate({ id: u.id, itemId });
                    }}
                  >
                    Match to item
                  </button>
                </li>
              ))}
            </ul>
          </div>
        )}
      </div>
    </div>
  );
}

// ---- Inventory tab ----------------------------------------------------

/**
 * One item's expiry control (Alpha 0.75 expiry tracking, shown
 * only for businesses whose needs profile includes it): a date
 * input to set / edit / clear the item's expiry date, plus the
 * flag the date earns — "Expired" in the alert style once the
 * date has passed, "Expires soon" within 2 days, and the days
 * remaining shown whenever a date is set. No date = no flag and
 * the item behaves exactly as before.
 */
function BitItemExpiryRow({
  item,
  onSet,
}: {
  item: BitItem;
  onSet: (date: string | null) => void;
}) {
  const days = item.expiryDate ? daysUntilExpiry(item.expiryDate) : null;
  return (
    <div className="mt-1 flex flex-wrap items-center gap-1.5">
      <label
        htmlFor={`bit-expiry-${item.id}`}
        className="text-xs font-semibold text-[var(--dim)]"
      >
        Expiry
      </label>
      <input
        id={`bit-expiry-${item.id}`}
        type="date"
        aria-label={`Expiry date for ${item.name}`}
        value={item.expiryDate ?? ""}
        onChange={(e) => onSet(e.target.value ? e.target.value : null)}
        className="rounded-md border px-1.5 py-0.5 text-xs font-normal text-[var(--text)]"
        style={{
          borderColor: "var(--border)",
          backgroundColor: "var(--surface)",
        }}
      />
      {days != null && item.expiryDate && days < 0 && (
        <>
          <span
            className="rounded-full px-2 py-0.5 text-[13px] font-bold"
            style={{
              backgroundColor: "var(--red-soft)",
              color: "var(--red)",
            }}
          >
            Expired
          </span>
          <span className="text-xs text-[var(--dim)]">
            {formatExpiryDate(item.expiryDate)}
          </span>
        </>
      )}
      {days != null && item.expiryDate && days >= 0 && days <= 2 && (
        <>
          <span
            className="rounded-full px-2 py-0.5 text-[13px] font-bold"
            style={{
              backgroundColor: "var(--amber-soft)",
              color: "var(--amber)",
            }}
          >
            Expires soon
          </span>
          <span className="text-xs text-[var(--dim)]">
            {days === 0
              ? "today"
              : days === 1
                ? "tomorrow"
                : `in ${days} days`}
          </span>
        </>
      )}
      {days != null && item.expiryDate && days > 2 && (
        <span className="text-xs text-[var(--dim)]">
          Expires {formatExpiryDate(item.expiryDate)} · {days} days left
        </span>
      )}
    </div>
  );
}

const WASTE_REASONS = ["Spoilage", "Expired", "Breakage", "Other"] as const;
type WasteReason = (typeof WASTE_REASONS)[number];

/**
 * The waste log (Alpha 0.75, Restaurant needs profile only):
 * record an item, a quantity and a reason — logging deducts the
 * quantity from the item's on-hand count — and the business's
 * waste history below it.
 */
function WasteLogPanel({
  business,
  items,
  wasteLog,
}: {
  business: BitBusiness;
  items: BitItem[];
  wasteLog: BitWasteEntry[];
}) {
  const queryClient = useQueryClient();
  const [itemId, setItemId] = useState<number | null>(null);
  const [qty, setQty] = useState("");
  const [reason, setReason] = useState<WasteReason>("Spoilage");
  const [msg, setMsg] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const selectedId = itemId ?? items[0]?.id ?? null;
  const selectedItem = items.find((i) => i.id === selectedId) ?? null;

  const logWaste = useMutation({
    mutationFn: async () =>
      await api.logBitWaste({
        businessId: business.id,
        itemId: selectedId ?? 0,
        quantity: Math.max(1, Math.floor(Number(qty) || 0)),
        reason,
      }),
    onSuccess: (res) => {
      if (res.ok) {
        setError(null);
        setMsg(
          `Logged — ${selectedItem?.name ?? "item"} is down to ${res.onHand ?? 0} on hand.`,
        );
        setQty("");
        void queryClient.invalidateQueries({ queryKey: ["bit"] });
      } else {
        setMsg(null);
        setError(res.error ?? "That waste entry couldn't be logged.");
      }
    },
    onError: () => {
      setMsg(null);
      setError("That waste entry couldn't be logged. Try again.");
    },
  });

  const fieldCls =
    "rounded-lg border px-2 py-1.5 text-sm font-normal text-[var(--text)]";
  const fieldStyle = {
    borderColor: "var(--border)",
    backgroundColor: "var(--surface)",
  } as const;

  return (
    <section
      aria-label="Waste log"
      className="rounded-xl border p-3"
      style={{
        borderColor: "var(--border)",
        backgroundColor: "var(--surface)",
      }}
    >
      <h3 className="text-base font-bold">Waste log</h3>
      <p className="text-xs text-[var(--dim)]">
        Log spoiled, expired or broken stock — the quantity comes
        off the item's on-hand count and the entry is kept in the
        history below.
      </p>
      <div className="mt-2 grid grid-cols-2 gap-2">
        <label className="col-span-2 flex flex-col gap-0.5 text-xs font-semibold text-[var(--dim)]">
          Item
          <select
            aria-label="Waste item"
            value={selectedId ?? ""}
            onChange={(e) => setItemId(Number(e.target.value))}
            className={fieldCls}
            style={fieldStyle}
          >
            {items.map((i) => (
              <option key={i.id} value={i.id}>
                {i.name} ({fmtCount(i.onHand)} {i.unit} on hand)
              </option>
            ))}
          </select>
        </label>
        <label className="flex flex-col gap-0.5 text-xs font-semibold text-[var(--dim)]">
          Quantity
          <input
            type="number"
            min={1}
            step={1}
            value={qty}
            aria-label="Waste quantity"
            onChange={(e) => setQty(e.target.value)}
            className={fieldCls}
            style={fieldStyle}
          />
        </label>
        <label className="flex flex-col gap-0.5 text-xs font-semibold text-[var(--dim)]">
          Reason
          <select
            aria-label="Waste reason"
            value={reason}
            onChange={(e) => setReason(e.target.value as WasteReason)}
            className={fieldCls}
            style={fieldStyle}
          >
            {WASTE_REASONS.map((r) => (
              <option key={r} value={r}>
                {r}
              </option>
            ))}
          </select>
        </label>
      </div>
      {error && (
        <p role="alert" className="mt-2 text-sm font-semibold text-[var(--red)]">
          {error}
        </p>
      )}
      {msg && <p className="mt-2 text-sm font-semibold">{msg}</p>}
      <button
        type="button"
        className="mt-3 rounded-full px-4 py-2 text-sm font-bold"
        style={{
          backgroundColor: "var(--accent)",
          color: "var(--accent-text)",
          opacity: selectedId == null || !(Number(qty) > 0) ? 0.5 : 1,
        }}
        disabled={
          logWaste.isPending || selectedId == null || !(Number(qty) > 0)
        }
        onClick={() => logWaste.mutate()}
      >
        {logWaste.isPending ? "Logging…" : "Log waste"}
      </button>
      {wasteLog.length > 0 && (
        <div className="mt-3">
          <p className="text-sm font-bold">Waste history</p>
          <div className="mt-1 flex flex-col">
            {wasteLog.map((w) => (
              <div
                key={w.id}
                className="flex flex-wrap items-baseline justify-between gap-2 border-b py-1.5 last:border-b-0"
                style={{ borderColor: "var(--border)" }}
              >
                <span className="min-w-0 text-sm font-semibold">
                  {w.itemName}{" "}
                  <span className="font-normal text-[var(--dim)]">
                    — {w.quantity} {w.unit} · {w.reason}
                  </span>
                </span>
                <span className="shrink-0 text-xs text-[var(--dim)]">
                  {roundDate(w.createdAt)}
                </span>
              </div>
            ))}
          </div>
        </div>
      )}
    </section>
  );
}

function InventoryTab({
  business,
  items,
  scans,
  wasteLog,
  onDismissScan,
}: {
  business: BitBusiness;
  items: BitItem[];
  scans: BitScan[];
  wasteLog: BitWasteEntry[];
  onDismissScan: (scan: BitScan) => void;
}) {
  const queryClient = useQueryClient();
  const [search, setSearch] = useState("");
  const [belowParOnly, setBelowParOnly] = useState(false);
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  // The four action panels are mutually exclusive: at most one of
  // "add" | "import" | "category" | "pos" is open at a time, and
  // tapping the open panel's button closes it (back to none) — the
  // same toggle behaviour as the Meal Planner's block buttons.
  const [openPanel, setOpenPanel] = useState<
    "add" | "import" | "category" | "pos" | null
  >(null);
  const showAdd = openPanel === "add";
  const showImport = openPanel === "import";
  const showGroupMgr = openPanel === "category";
  const showPos = openPanel === "pos";
  const togglePanel = (panel: "add" | "import" | "category" | "pos") =>
    setOpenPanel((cur) => (cur === panel ? null : panel));
  const [groupName, setGroupName] = useState("");
  const [groupMsg, setGroupMsg] = useState<string | null>(null);
  const [groupError, setGroupError] = useState<string | null>(null);
  const [addForm, setAddForm] = useState({
    name: "",
    group: "",
    unit: "units",
    packSize: "1",
    par: "0",
    onHand: "0",
    supplier: "",
    sku: "",
  });
  const [addError, setAddError] = useState<string | null>(null);

  // The business's categories are exactly the ones chosen in
  // setup (plus any added later with Add Category): an item's
  // group is its category, and nothing else appears in this
  // tab's lists.
  const groupOf = (it: BitItem) => it.category;
  const bizGroups = business.categories;

  const filtered = items.filter((it) => {
    if (belowParOnly && it.onHand > it.par) return false;
    if (search.trim() && !bitItemMatchesSearch(search, it.name, it.sku))
      return false;
    return true;
  });
  const searching = search.trim().length > 0;
  const filtering = searching || belowParOnly;
  // Items group under their category. Every stored category gets
  // a heading — a category with no items yet (e.g. one just added
  // with the Add Category panel) shows as an empty group — except
  // while a search / below-par filter is narrowing the list, when
  // only categories with matching items show. A category found on
  // an item but not in the stored list still gets a heading after
  // them, so no item is ever hidden.
  const groups = useMemo(() => {
    const byGroup = new Map<string, BitItem[]>();
    for (const it of filtered) {
      const key = groupOf(it);
      const list = byGroup.get(key);
      if (list) list.push(it);
      else byGroup.set(key, [it]);
    }
    const ordered: { name: string; items: BitItem[] }[] = [];
    const seen = new Set<string>();
    for (const g of bizGroups) {
      seen.add(g);
      ordered.push({ name: g, items: byGroup.get(g) ?? [] });
    }
    for (const [g, its] of byGroup) {
      if (!seen.has(g)) ordered.push({ name: g, items: its });
    }
    return filtering
      ? ordered.filter((g) => g.items.length > 0)
      : ordered;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [filtered, bizGroups, filtering]);

  const setCount = useMutation({
    mutationFn: async (vars: { itemId: number; onHand: number }) =>
      await api.setBitItemCount(vars),
    onSettled: () =>
      void queryClient.invalidateQueries({ queryKey: ["bit"] }),
  });

  // Expiry dates (Alpha 0.75): only rendered for businesses whose
  // needs profile includes expiry tracking; the server refuses
  // the save for any other business.
  const expiryTracking = business.needs.expiryTracking;
  const setExpiry = useMutation({
    mutationFn: async (vars: { itemId: number; date: string | null }) =>
      await api.setBitItemExpiry(vars),
    onSettled: () =>
      void queryClient.invalidateQueries({ queryKey: ["bit"] }),
  });

  const addItem = useMutation({
    mutationFn: async () =>
      await api.addBitItem({
        businessId: business.id,
        name: addForm.name.trim(),
        // The item is placed into one of the business's
        // categories, so it belongs to exactly that category.
        category: addForm.group.trim() || bizGroups[0] || "Main Area",
        zone: addForm.group.trim() || bizGroups[0] || "Main Area",
        onHand: Math.max(0, Math.floor(Number(addForm.onHand) || 0)),
        unit: addForm.unit.trim() || "units",
        par: Math.max(0, Math.floor(Number(addForm.par) || 0)),
        packSize: Math.max(1, Math.floor(Number(addForm.packSize) || 1)),
        supplier: addForm.supplier.trim() || null,
        sku: addForm.sku.trim() || null,
      }),
    onSuccess: (res) => {
      if (res.ok) {
        setAddForm({
          name: "",
          group: "",
          unit: "units",
          packSize: "1",
          par: "0",
          onHand: "0",
          supplier: "",
          sku: "",
        });
        setAddError(null);
        setOpenPanel(null);
        void queryClient.invalidateQueries({ queryKey: ["bit"] });
      } else {
        setAddError(res.error ?? "That item couldn't be added.");
      }
    },
    onError: () => setAddError("That item couldn't be added. Try again."),
  });

  const addGroup = useMutation({
    mutationFn: async (name: string) =>
      await api.addBitGroup({ businessId: business.id, name }),
    onSuccess: (res, name) => {
      if (res.ok) {
        setGroupName("");
        setGroupError(null);
        setGroupMsg(`Category "${name.trim()}" added.`);
        void queryClient.invalidateQueries({ queryKey: ["bit"] });
      } else {
        setGroupMsg(null);
        setGroupError(res.error ?? "That category couldn't be added.");
      }
    },
    onError: () => {
      setGroupMsg(null);
      setGroupError("That category couldn't be added. Try again.");
    },
  });

  function toggleGroup(group: string) {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(group)) next.delete(group);
      else next.add(group);
      return next;
    });
  }

  const addField =
    "rounded-lg border px-2 py-1.5 text-sm font-normal text-[var(--text)]";
  const addFieldStyle = {
    borderColor: "var(--border)",
    backgroundColor: "var(--surface)",
  } as const;

  return (
    <div className="flex flex-col gap-2 pt-2">
      <div className="flex flex-wrap items-center gap-2">
        <input
          type="search"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder="Search inventory…"
          aria-label="Search inventory"
          className="min-w-0 flex-1 rounded-full border px-3 py-2 text-sm"
          style={{
            borderColor: "var(--border)",
            backgroundColor: "var(--surface)",
          }}
        />
        <label className="flex items-center gap-1.5 text-sm font-semibold text-[var(--dim)]">
          <input
            type="checkbox"
            checked={belowParOnly}
            onChange={(e) => setBelowParOnly(e.target.checked)}
            className="h-4 w-4"
            aria-label="Below par only"
          />
          Below par only
        </label>
      </div>
      {/* The four action buttons share ONE toggle behaviour (the
          Meal Planner block-button pattern): at rest all four are
          visible, plain and unhighlighted, with their normal
          labels. Tapping one opens its panel, highlights THAT
          button, switches its label to "Close", and hides the
          other three — only the open panel's button stays visible.
          Tapping it again closes the panel and restores all four,
          plain, with their normal labels. Styling is class-based
          and depends only on which panel is open, so no button
          keeps a highlight (or a stale inline style) once its
          panel closes; closing also drops the button's focus so
          no focus tint lingers. */}
      <div className="flex flex-wrap gap-2">
        {(openPanel === null || showAdd) && (
          <button
            type="button"
            aria-expanded={showAdd}
            onClick={(e) => {
              togglePanel("add");
              if (showAdd) e.currentTarget.blur();
            }}
            className={
              showAdd
                ? "rounded-full bg-[var(--accent)] px-4 py-2 text-sm font-bold text-[var(--accent-text)]"
                : "rounded-full border border-[var(--border)] bg-[var(--surface)] px-4 py-2 text-sm font-bold text-[var(--text)]"
            }
          >
            {showAdd ? "Close" : "Add item"}
          </button>
        )}
        {(openPanel === null || showImport) && (
          <button
            type="button"
            aria-expanded={showImport}
            onClick={(e) => {
              togglePanel("import");
              if (showImport) e.currentTarget.blur();
            }}
            className={
              showImport
                ? "rounded-full bg-[var(--accent)] px-4 py-2 text-sm font-bold text-[var(--accent-text)]"
                : "rounded-full border border-[var(--border)] bg-[var(--surface)] px-4 py-2 text-sm font-bold text-[var(--text)]"
            }
          >
            {showImport ? "Close" : "Import manifest"}
          </button>
        )}
        {(openPanel === null || showGroupMgr) && (
          <button
            type="button"
            aria-expanded={showGroupMgr}
            onClick={(e) => {
              togglePanel("category");
              if (showGroupMgr) e.currentTarget.blur();
            }}
            className={
              showGroupMgr
                ? "rounded-full bg-[var(--accent)] px-4 py-2 text-sm font-bold text-[var(--accent-text)]"
                : "rounded-full border border-[var(--border)] bg-[var(--surface)] px-4 py-2 text-sm font-bold text-[var(--text)]"
            }
          >
            {showGroupMgr ? "Close" : "Add Category"}
          </button>
        )}
        {(openPanel === null || showPos) && (
          <button
            type="button"
            aria-expanded={showPos}
            onClick={(e) => {
              togglePanel("pos");
              if (showPos) e.currentTarget.blur();
            }}
            className={
              showPos
                ? "rounded-full bg-[var(--accent)] px-4 py-2 text-sm font-bold text-[var(--accent-text)]"
                : "rounded-full border border-[var(--border)] bg-[var(--surface)] px-4 py-2 text-sm font-bold text-[var(--text)]"
            }
          >
            {showPos
              ? "Close"
              : business.pos
                ? `POS: ${posDisplayName(business.pos)}${posEnvironmentSuffix(business.pos)}`
                : "Connect to POS"}
          </button>
        )}
      </div>

      {showPos && (
        <PosPanel pos={business.pos} items={items} businessId={business.id} />
      )}

      {showImport && (
        <div
          className="rounded-xl border p-3"
          style={{
            borderColor: "var(--border)",
            backgroundColor: "var(--surface)",
          }}
        >
          <h3 className="text-base font-bold">Import manifest</h3>
          <ManifestImport
            businessId={business.id}
            existingNames={items.map((i) => i.name.toLowerCase())}
            categories={bizGroups}
            scans={scans}
            onDismissScan={onDismissScan}
            onConfirm={async (rows, scanId) => {
              const res = await api.importBitManifest({
                businessId: business.id,
                lines: rows,
                scanId,
              });
              void queryClient.invalidateQueries({ queryKey: ["bit"] });
              return `Imported ${res.added} new item${res.added === 1 ? "" : "s"} · updated ${res.updated} count${res.updated === 1 ? "" : "s"}`;
            }}
          />
        </div>
      )}

      {showAdd && (
        <form
          className="rounded-xl border p-3"
          style={{
            borderColor: "var(--border)",
            backgroundColor: "var(--surface)",
          }}
          onSubmit={(e) => {
            e.preventDefault();
            if (addForm.name.trim() && addForm.group.trim()) {
              addItem.mutate();
            } else {
              setAddError("Give the item a name and a category.");
            }
          }}
        >
          <h3 className="text-base font-bold">Add item</h3>
          <datalist id="bit-add-groups">
            {bizGroups.map((g) => (
              <option key={g} value={g} />
            ))}
          </datalist>
          <div className="mt-2 grid grid-cols-2 gap-2">
            <label className="col-span-2 flex flex-col gap-0.5 text-xs font-semibold text-[var(--dim)]">
              Item name
              <input
                value={addForm.name}
                aria-label="New item name"
                onChange={(e) =>
                  setAddForm({ ...addForm, name: e.target.value })
                }
                className={addField}
                style={addFieldStyle}
                autoComplete="off"
              />
            </label>
            <label className="flex flex-col gap-0.5 text-xs font-semibold text-[var(--dim)]">
              Category
              <input
                value={addForm.group}
                aria-label="New item category"
                onChange={(e) =>
                  setAddForm({ ...addForm, group: e.target.value })
                }
                list="bit-add-groups"
                className={addField}
                style={addFieldStyle}
                autoComplete="off"
              />
            </label>
            <label className="flex flex-col gap-0.5 text-xs font-semibold text-[var(--dim)]">
              Unit
              <input
                value={addForm.unit}
                aria-label="New item unit"
                onChange={(e) =>
                  setAddForm({ ...addForm, unit: e.target.value })
                }
                className={addField}
                style={addFieldStyle}
                autoComplete="off"
              />
            </label>
            <label className="flex flex-col gap-0.5 text-xs font-semibold text-[var(--dim)]">
              Pack size
              <input
                type="number"
                min={1}
                step={1}
                value={addForm.packSize}
                aria-label="New item pack size"
                onChange={(e) =>
                  setAddForm({ ...addForm, packSize: e.target.value })
                }
                className={addField}
                style={addFieldStyle}
              />
            </label>
            <label className="flex flex-col gap-0.5 text-xs font-semibold text-[var(--dim)]">
              Par level
              <input
                type="number"
                min={0}
                step={1}
                value={addForm.par}
                aria-label="New item par level"
                onChange={(e) =>
                  setAddForm({ ...addForm, par: e.target.value })
                }
                className={addField}
                style={addFieldStyle}
              />
            </label>
            <label className="flex flex-col gap-0.5 text-xs font-semibold text-[var(--dim)]">
              On hand now
              <input
                type="number"
                min={0}
                step={1}
                value={addForm.onHand}
                aria-label="New item on hand"
                onChange={(e) =>
                  setAddForm({ ...addForm, onHand: e.target.value })
                }
                className={addField}
                style={addFieldStyle}
              />
            </label>
            <label className="flex flex-col gap-0.5 text-xs font-semibold text-[var(--dim)]">
              Supplier
              <input
                value={addForm.supplier}
                aria-label="New item supplier"
                onChange={(e) =>
                  setAddForm({ ...addForm, supplier: e.target.value })
                }
                className={addField}
                style={addFieldStyle}
                autoComplete="off"
              />
            </label>
            <label className="flex flex-col gap-0.5 text-xs font-semibold text-[var(--dim)]">
              SKU (optional)
              <input
                value={addForm.sku}
                aria-label="New item SKU"
                onChange={(e) =>
                  setAddForm({ ...addForm, sku: e.target.value })
                }
                className={addField}
                style={addFieldStyle}
                autoComplete="off"
              />
            </label>
          </div>
          {addError && (
            <p role="alert" className="mt-2 text-sm font-semibold text-[var(--red)]">
              {addError}
            </p>
          )}
          <div className="mt-3 flex gap-2">
            <button
              type="submit"
              className="rounded-full px-4 py-2 text-sm font-bold"
              style={{
                backgroundColor: "var(--accent)",
                color: "var(--accent-text)",
              }}
              disabled={addItem.isPending}
            >
              {addItem.isPending ? "Adding…" : "Add item"}
            </button>
            <button
              type="button"
              className="rounded-full px-3 py-2 text-sm font-bold text-[var(--dim)]"
              onClick={() => setOpenPanel(null)}
            >
              Cancel
            </button>
          </div>
        </form>
      )}

      {showGroupMgr && (
        <form
          className="rounded-xl border p-3"
          style={{
            borderColor: "var(--border)",
            backgroundColor: "var(--surface)",
          }}
          onSubmit={(e) => {
            e.preventDefault();
            const name = groupName.trim();
            if (!name) {
              setGroupMsg(null);
              setGroupError("Give the new category a name.");
              return;
            }
            if (
              bizGroups.some(
                (g) => g.trim().toLowerCase() === name.toLowerCase(),
              )
            ) {
              setGroupMsg(null);
              setGroupError(
                "A category with that name already exists.",
              );
              return;
            }
            addGroup.mutate(name);
          }}
        >
          <h3 className="text-base font-bold">Add Category</h3>
          <p className="text-xs text-[var(--dim)]">
            Categories are the groups the inventory is organised
            under. A new category starts empty — add items into it
            with Add item, or pick it in an inventory check.
          </p>
          <div className="mt-2 flex flex-col gap-1.5">
            {bizGroups.map((g) => {
              const count = items.filter(
                (i) => groupOf(i) === g,
              ).length;
              return (
                <div key={g} className="flex items-center gap-2">
                  <span
                    aria-hidden="true"
                    className="h-3 w-3 shrink-0 rounded-full"
                    style={{
                      backgroundColor: catColor(business.colors, g),
                    }}
                  />
                  <span className="min-w-0 flex-1 text-sm font-semibold">
                    {g}{" "}
                    <span className="text-[var(--dim)]">
                      ({count} item{count === 1 ? "" : "s"})
                    </span>
                  </span>
                </div>
              );
            })}
          </div>
          <div className="mt-3 flex flex-wrap items-center gap-2">
            <input
              value={groupName}
              onChange={(e) => setGroupName(e.target.value)}
              placeholder="New category name…"
              aria-label="New category name"
              className="min-w-0 flex-1 rounded-lg border px-2 py-1.5 text-sm"
              style={{
                borderColor: "var(--border)",
                backgroundColor: "var(--surface)",
              }}
              autoComplete="off"
            />
            <button
              type="submit"
              className="rounded-full px-4 py-2 text-sm font-bold"
              style={{
                backgroundColor: "var(--accent)",
                color: "var(--accent-text)",
              }}
              disabled={addGroup.isPending || !groupName.trim()}
            >
              {addGroup.isPending ? "Adding…" : "Add Category"}
            </button>
          </div>
          {groupError && (
            <p
              role="alert"
              className="mt-2 text-sm font-semibold text-[var(--red)]"
            >
              {groupError}
            </p>
          )}
          {groupMsg && (
            <p className="mt-2 text-sm font-semibold">{groupMsg}</p>
          )}
        </form>
      )}

      {groups.map((g) => {
        const atPar = g.items.filter((i) => i.onHand > i.par).length;
        const totalInGroup = items.filter(
          (i) => groupOf(i) === g.name,
        ).length;
        const shown = g.items;
        const pct = totalInGroup > 0 ? (atPar / totalInGroup) * 100 : 100;
        const fracStyle =
          pct >= 75
            ? { backgroundColor: "var(--ok-bg)", color: "var(--ok-text)" }
            : pct >= 25
              ? {
                  backgroundColor: "var(--amber-soft)",
                  color: "var(--amber)",
                }
              : {
                  backgroundColor: "var(--out-bg)",
                  color: "var(--out-text)",
                };
        const isOpen = searching || expanded.has(g.name);
        return (
          <section key={g.name} aria-label={g.name}>
            <button
              type="button"
              aria-expanded={isOpen}
              onClick={() => toggleGroup(g.name)}
              className="flex w-full items-center gap-2 rounded-xl border-2 px-3 py-2 text-left"
              style={{
                borderColor: "var(--accent)",
                backgroundColor: "var(--accent-soft)",
              }}
            >
              <span
                aria-hidden="true"
                className="h-3.5 w-3.5 shrink-0 rounded-full"
                style={{
                  backgroundColor: catColor(business.colors, g.name),
                }}
              />
              <span
                className="min-w-0 flex-1 truncate font-bold"
                style={{
                  // Long group names step down so the full name
                  // stays readable beside the at-par fraction box
                  // (the HIT List's long-name shrink, applied here).
                  fontSize:
                    g.name.length <= 19
                      ? 20
                      : g.name.length <= 25
                        ? 15
                        : 13,
                }}
              >
                {g.name}
              </span>
              <span
                className="shrink-0 rounded-md px-1.5 py-0.5 text-xs font-bold"
                style={fracStyle}
              >
                {atPar}/{totalInGroup} at par
              </span>
              <Chevron collapsed={!isOpen} />
            </button>
            {isOpen && (
              <div className="mt-1 flex flex-col gap-1">
                {shown.length === 0 && (
                  <p className="px-2 py-1.5 text-sm text-[var(--dim)]">
                    No items in this category yet.
                  </p>
                )}
                {shown.map((it) => {
                  const status =
                    it.onHand <= 0
                      ? "out"
                      : it.onHand <= it.par
                        ? "low"
                        : "ok";
                  return (
                    <div
                      key={it.id}
                      className="flex items-center gap-2 rounded-xl border px-2 py-1.5"
                      style={{
                        borderColor: "var(--border)",
                        backgroundColor: "var(--surface)",
                      }}
                    >
                      <div className="min-w-0 flex-1">
                        <p className="text-sm font-semibold leading-tight">
                          {it.name}
                          <TagChips tags={it.tags} />
                        </p>
                        <p className="text-xs text-[var(--dim)]">
                          Par {it.par} · {groupOf(it)}
                          {it.supplier ? ` · ${it.supplier}` : ""}
                          {it.sku ? ` · SKU ${it.sku}` : ""}
                        </p>
                        {expiryTracking && (
                          <BitItemExpiryRow
                            item={it}
                            onSet={(date) =>
                              setExpiry.mutate({ itemId: it.id, date })
                            }
                          />
                        )}
                      </div>
                      <span
                        className="shrink-0 rounded-full px-2 py-0.5 text-[13px] font-bold"
                        style={
                          status === "out"
                            ? {
                                backgroundColor: "var(--out-bg)",
                                color: "var(--out-text)",
                              }
                            : status === "low"
                              ? {
                                  backgroundColor: "var(--amber-soft)",
                                  color: "var(--amber)",
                                }
                              : {
                                  backgroundColor: "var(--ok-bg)",
                                  color: "var(--ok-text)",
                                }
                        }
                      >
                        {status === "out"
                          ? "Out"
                          : status === "low"
                            ? "At/below par"
                            : "In stock"}
                      </span>
                      <div className="flex shrink-0 items-center gap-1">
                        <button
                          type="button"
                          aria-label={`Decrease stock for ${it.name}`}
                          className="h-8 w-8 rounded-full text-lg font-bold"
                          style={{ backgroundColor: "var(--surface-alt)" }}
                          disabled={it.onHand <= 0}
                          onClick={() =>
                            setCount.mutate({
                              itemId: it.id,
                              onHand: it.onHand - 1,
                            })
                          }
                        >
                          −
                        </button>
                        <span
                          className="min-w-20 rounded-lg px-2 py-1.5 text-center text-sm font-bold"
                          style={{
                            backgroundColor:
                              status === "out"
                                ? "var(--out-bg)"
                                : status === "low"
                                  ? "var(--amber-soft)"
                                  : "var(--ok-bg)",
                            color:
                              status === "out"
                                ? "var(--out-text)"
                                : status === "low"
                                  ? "var(--amber)"
                                  : "var(--ok-text)",
                          }}
                        >
                          Stock: {fmtCount(it.onHand)} {it.unit}
                        </span>
                        <button
                          type="button"
                          aria-label={`Increase stock for ${it.name}`}
                          className="h-8 w-8 rounded-full text-lg font-bold"
                          style={{ backgroundColor: "var(--surface-alt)" }}
                          onClick={() =>
                            setCount.mutate({
                              itemId: it.id,
                              onHand: it.onHand + 1,
                            })
                          }
                        >
                          +
                        </button>
                      </div>
                    </div>
                  );
                })}
              </div>
            )}
          </section>
        );
      })}
      {filtered.length === 0 && (
        <p className="py-4 text-center text-sm text-[var(--dim)]">
          {items.length === 0
            ? "No inventory items yet — add one or import a manifest."
            : "No items match that search."}
        </p>
      )}

      {/* Waste log (Alpha 0.75): Restaurant needs profile only. */}
      {business.needs.wasteLog && (
        <WasteLogPanel
          business={business}
          items={items}
          wasteLog={wasteLog}
        />
      )}
    </div>
  );
}

// ---- Requisition tab (TFS SOG F-SUPP, requisition businesses only) -----

interface ReqBuildLine {
  key: string;
  itemId: number | null;
  name: string;
  materialNo: string | null;
  qty: number;
  unit: string;
  category: string;
  resubmittedFromLineId: number | null;
  resubmitted: boolean;
  draftExtraId: number | null;
  /** Added by hand from the item search (not auto-built, not a
      resubmission, not a catalogue draft extra): carries a Remove
      control and comes off the draft when removed. */
  manual: boolean;
}

function RequisitionTab({
  business,
  items,
  requisition,
  history,
  resubmittedLines,
  draftExtras,
}: {
  business: BitBusiness;
  items: BitItem[];
  requisition: BitRequisition | null;
  history: BitState["requisitionHistory"];
  resubmittedLines: BitState["resubmittedLines"];
  draftExtras: BitState["draftExtras"];
}) {
  const queryClient = useQueryClient();
  const stationNo = stationNoOf(business);
  const reqNo = reqNoToday(business);
  const todayLong = new Date().toLocaleDateString("en-CA", {
    year: "numeric",
    month: "long",
    day: "numeric",
  });

  const [division, setDivision] = useState(business.division ?? "");
  const [doName, setDoName] = useState(business.dutyOfficerName ?? "");
  const [profileMsg, setProfileMsg] = useState<string | null>(null);
  const [qtyEdits, setQtyEdits] = useState<Record<string, number>>({});
  const [receivedEdits, setReceivedEdits] = useState<
    Record<number, number>
  >({});
  const [copied, setCopied] = useState(false);
  const [sendMsg, setSendMsg] = useState<string | null>(null);
  const [sendError, setSendError] = useState<string | null>(null);
  const [checkMsg, setCheckMsg] = useState<string | null>(null);
  const [historyOpen, setHistoryOpen] = useState(false);
  // Item search (Alpha 0.72): the ids of inventory items added to
  // this draft by hand, the live search text, and the build-line
  // key currently flashed (when a search result is already on the
  // draft, tapping it again flashes its line instead of adding a
  // duplicate).
  const [addedIds, setAddedIds] = useState<number[]>([]);
  const [itemSearch, setItemSearch] = useState("");
  const [flashKey, setFlashKey] = useState<string | null>(null);
  const flashTimer = useRef<number | null>(null);

  function flashLine(key: string) {
    setFlashKey(key);
    if (flashTimer.current != null) {
      window.clearTimeout(flashTimer.current);
    }
    flashTimer.current = window.setTimeout(() => setFlashKey(null), 1600);
    window.setTimeout(() => {
      document
        .getElementById(`req-line-${key}`)
        ?.scrollIntoView({ block: "nearest", behavior: "smooth" });
    }, 60);
  }

  const saveProfile = useMutation({
    mutationFn: async () =>
      await api.updateBitRequisitionProfile({
        businessId: business.id,
        division: division.trim() || null,
        dutyOfficerName: doName.trim() || null,
      }),
    onSuccess: () => {
      setProfileMsg("Saved.");
      void queryClient.invalidateQueries({ queryKey: ["bit"] });
    },
    onError: () => setProfileMsg("That didn't save. Try again."),
  });

  // The build list: items at or below par (qty = order-up-to
  // minus on hand), merged with the not-received lines carried
  // over from the last closed requisition (badged "Resubmitted" —
  // the SOG has no back orders), the catalogue draft extras, and
  // any items added by hand from the search — all laid out in the
  // SOG order sequence. Only items WITH a par auto-appear: an
  // item with no par set (par 0 — e.g. the Quartermaster
  // catalogue items) is ordered only when added by hand.
  const buildLines = useMemo<ReqBuildLine[]>(() => {
    const lines: ReqBuildLine[] = [];
    const byItemId = new Map<number, ReqBuildLine>();
    const byName = new Map<string, ReqBuildLine>();
    for (const it of items.filter((i) => i.par > 0 && i.onHand <= i.par)) {
      const line: ReqBuildLine = {
        key: `item-${it.id}`,
        itemId: it.id,
        name: it.name,
        materialNo: it.sku,
        qty: Math.max(0, it.par - it.onHand),
        unit: it.unit,
        category: it.category,
        resubmittedFromLineId: null,
        resubmitted: false,
        draftExtraId: null,
        manual: false,
      };
      lines.push(line);
      byItemId.set(it.id, line);
      byName.set(it.name.trim().toLowerCase(), line);
    }
    for (const rl of resubmittedLines) {
      const match =
        (rl.itemId != null ? byItemId.get(rl.itemId) : undefined) ??
        byName.get(rl.name.trim().toLowerCase());
      if (match) {
        match.resubmitted = true;
        match.resubmittedFromLineId = rl.id;
      } else {
        lines.push({
          key: `resub-${rl.id}`,
          itemId: rl.itemId,
          name: rl.name,
          materialNo: rl.materialNo,
          qty: rl.qtyOrdered,
          unit: rl.unit,
          category: rl.category,
          resubmittedFromLineId: rl.id,
          resubmitted: true,
          draftExtraId: null,
          manual: false,
        });
      }
    }
    for (const ex of draftExtras) {
      lines.push({
        key: `extra-${ex.id}`,
        itemId: null,
        name: ex.name,
        materialNo: ex.materialNo,
        qty: ex.qty,
        unit: ex.unit,
        category: "Other",
        resubmittedFromLineId: null,
        resubmitted: false,
        draftExtraId: ex.id,
        manual: false,
      });
    }
    // Items added by hand from the search: a line each (qty 1 to
    // start), unless the item is already on the draft.
    for (const id of addedIds) {
      if (byItemId.has(id)) continue;
      const it = items.find((i) => i.id === id);
      if (!it) continue;
      const line: ReqBuildLine = {
        key: `manual-${it.id}`,
        itemId: it.id,
        name: it.name,
        materialNo: it.sku,
        qty: 1,
        unit: it.unit,
        category: it.category,
        resubmittedFromLineId: null,
        resubmitted: false,
        draftExtraId: null,
        manual: true,
      };
      lines.push(line);
      byItemId.set(it.id, line);
    }
    lines.sort(
      (a, b) =>
        reqCategoryRank(a.category) - reqCategoryRank(b.category) ||
        a.name.localeCompare(b.name),
    );
    return lines;
  }, [items, resubmittedLines, draftExtras, addedIds]);

  // Live search over the station's INVENTORY items only — nothing
  // else is ever offered here — by name or by SKU / Material #,
  // word-based so "ice pack" finds "Ice packs".
  const searchQuery = itemSearch.trim().toLowerCase();
  const searchResults =
    searchQuery.length === 0
      ? []
      : items
          .filter((it) => bitItemMatchesSearch(itemSearch, it.name, it.sku))
          .slice(0, 30);

  // Exactly the inventory items added from the filled requisition
  // form the user supplied (the third file) — they carry the
  // provenance tag; nothing else is listed in that section.
  const filledReqItems = useMemo(
    () =>
      items
        .filter((it) => it.tags.includes(FILLED_REQ_TAG))
        .sort(
          (a, b) =>
            reqCategoryRank(a.category) - reqCategoryRank(b.category) ||
            a.name.localeCompare(b.name),
        ),
    [items],
  );
  const [filledReqOpen, setFilledReqOpen] = useState(false);

  function addFromSearch(item: BitItem) {
    const existing = buildLines.find((l) => l.itemId === item.id);
    if (existing) {
      // Already a line on this draft — never duplicate it; flash
      // the line that's there instead.
      flashLine(existing.key);
      return;
    }
    setAddedIds((prev) => (prev.includes(item.id) ? prev : [...prev, item.id]));
    flashLine(`manual-${item.id}`);
  }

  function removeManualLine(line: ReqBuildLine) {
    if (line.itemId != null) {
      setAddedIds((prev) => prev.filter((id) => id !== line.itemId));
    }
    setQtyEdits((prev) => {
      const next = { ...prev };
      delete next[line.key];
      return next;
    });
  }

  const qtyOf = (line: ReqBuildLine) => qtyEdits[line.key] ?? line.qty;

  const sendLines = buildLines
    .map((l) => ({ line: l, qty: qtyOf(l) }))
    .filter((x) => x.qty >= 1);

  const emailSubject = `Requisition ${reqNo} — TFS Station ${stationNo}`;
  const requisitionText = useMemo(() => {
    const out: string[] = [
      "TORONTO FIRE SERVICES",
      "QUARTERMASTER SECTION — REQUISITION",
      "SEND TO: tfsqm@toronto.ca",
      "",
      `Division: ${division.trim() || ""}`,
      `Station: ${stationNo}`,
      `Date: ${todayLong}`,
      `Req. No.: ${reqNo}`,
      `D.O. Name: ${doName.trim() || ""}`,
      "",
      "Item / Description | Qty | Unit | Material # | GL | Comments",
    ];
    for (const { line, qty } of sendLines) {
      out.push(
        `${line.name} | ${qty} | ${line.unit} | ${line.materialNo ?? ""} | |`,
      );
    }
    out.push(
      "",
      "D.O. Signature: ______________________",
      "DC/PC/DVC Signature: ______________________",
    );
    return out.join("\n");
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sendLines, division, doName, reqNo, todayLong, stationNo]);

  const mailto = `mailto:tfsqm@toronto.ca?subject=${encodeURIComponent(emailSubject)}&body=${encodeURIComponent(requisitionText)}`;

  async function copyText() {
    try {
      await navigator.clipboard.writeText(
        `To: tfsqm@toronto.ca\nSubject: ${emailSubject}\n\n${requisitionText}`,
      );
      setCopied(true);
      window.setTimeout(() => setCopied(false), 2500);
    } catch {
      setCopied(false);
    }
  }

  const send = useMutation({
    mutationFn: async () =>
      await api.sendBitRequisition({
        businessId: business.id,
        lines: sendLines.map(({ line, qty }) => ({
          itemId: line.itemId,
          name: line.name,
          materialNo: line.materialNo,
          qty,
          unit: line.unit,
          category: line.category,
          resubmittedFromLineId: line.resubmittedFromLineId,
        })),
      }),
    onSuccess: (res) => {
      if (res.ok) {
        setSendError(null);
        setSendMsg(
          `Requisition ${res.reqNo ?? reqNo} marked as sent — it's now the station's outstanding requisition, ready for the delivery check-off.`,
        );
        setQtyEdits({});
        setAddedIds([]);
        setItemSearch("");
        void queryClient.invalidateQueries({ queryKey: ["bit"] });
      } else {
        setSendMsg(null);
        setSendError(res.error ?? "The requisition couldn't be sent.");
      }
    },
    onError: () => {
      setSendMsg(null);
      setSendError("The requisition couldn't be sent. Try again.");
    },
  });

  const checkOff = useMutation({
    mutationFn: async (vars: {
      lineId: number;
      outcome: "received" | "not_received";
      qtyReceived: number | null;
    }) => await api.checkOffBitRequisitionLine(vars),
    onSuccess: (res, vars) => {
      if (res.ok) {
        setCheckMsg(
          res.closed
            ? "Check-off complete — the requisition is closed and on file in the history below."
            : vars.outcome === "received"
              ? "Marked received — stock updated."
              : "Marked not received — it will be resubmitted on the next requisition.",
        );
        void queryClient.invalidateQueries({ queryKey: ["bit"] });
      } else {
        setCheckMsg(res.error ?? "That check-off didn't save.");
      }
    },
    onError: () => setCheckMsg("That check-off didn't save. Try again."),
  });

  const removeExtra = useMutation({
    mutationFn: async (id: number) =>
      await api.removeBitRequisitionDraftExtra({ id }),
    onSuccess: () =>
      void queryClient.invalidateQueries({ queryKey: ["bit"] }),
  });

  const profileDirty =
    division !== (business.division ?? "") ||
    doName !== (business.dutyOfficerName ?? "");

  const fieldCls =
    "rounded-lg border px-2 py-1.5 text-sm font-normal text-[var(--text)]";
  const fieldStyle = {
    borderColor: "var(--border)",
    backgroundColor: "var(--surface)",
  } as const;

  return (
    <div className="flex flex-col gap-2 pt-2">
      {requisition ? (
        <>
          <div
            className="rounded-xl border p-3"
            style={{
              borderColor: "var(--accent)",
              backgroundColor: "var(--surface)",
            }}
          >
            <h3 className="text-base font-bold">
              Outstanding requisition {requisition.reqNo}
            </h3>
            <p className="text-sm text-[var(--dim)]">
              Sent{" "}
              {new Date(requisition.sentAt).toLocaleDateString("en-CA", {
                year: "numeric",
                month: "long",
                day: "numeric",
              })}{" "}
              to the Quartermaster Section. When the supplies come
              back with the marked requisition, check off each item
              received and remark the ones not received — items not
              received are never back-ordered; they are resubmitted
              on the next requisition.
            </p>
            {checkMsg && (
              <p className="mt-2 text-sm font-semibold" role="status">
                {checkMsg}
              </p>
            )}
            <div className="mt-2 flex flex-col gap-1">
              {requisition.lines.map((l) => {
                const receivedQty =
                  receivedEdits[l.id] ?? l.qtyOrdered;
                return (
                  <div
                    key={l.id}
                    className="rounded-xl border px-2 py-1.5"
                    style={{
                      borderColor: "var(--border)",
                      backgroundColor: "var(--surface)",
                    }}
                  >
                    <div className="flex items-center gap-2">
                      <div className="min-w-0 flex-1">
                        <p className="text-sm font-semibold leading-tight">
                          {l.name}
                        </p>
                        <p className="text-xs text-[var(--dim)]">
                          Ordered {l.qtyOrdered} {l.unit}
                          {l.materialNo
                            ? ` · Material # ${l.materialNo}`
                            : ""}
                        </p>
                      </div>
                      {l.status === "received" && (
                        <span
                          className="shrink-0 rounded-full px-2 py-0.5 text-[13px] font-bold"
                          style={{
                            backgroundColor: "var(--ok-bg)",
                            color: "var(--ok-text)",
                          }}
                        >
                          Received {l.qtyReceived ?? l.qtyOrdered}
                        </span>
                      )}
                      {l.status === "not_received" && (
                        <span
                          className="shrink-0 rounded-full px-2 py-0.5 text-[13px] font-bold"
                          style={{
                            backgroundColor: "var(--out-bg)",
                            color: "var(--out-text)",
                          }}
                        >
                          Not received — will resubmit
                        </span>
                      )}
                    </div>
                    {l.status === "pending" && (
                      <div className="mt-1.5 flex flex-wrap items-center gap-2">
                        <label className="flex items-center gap-1 text-xs font-semibold text-[var(--dim)]">
                          Qty received
                          <input
                            type="number"
                            inputMode="numeric"
                            min={0}
                            value={receivedQty}
                            aria-label={`Quantity received of ${l.name}`}
                            onChange={(e) =>
                              setReceivedEdits((prev) => ({
                                ...prev,
                                [l.id]: Math.max(
                                  0,
                                  Math.floor(Number(e.target.value) || 0),
                                ),
                              }))
                            }
                            className="w-16 rounded-lg border px-2 py-1 text-sm font-normal text-[var(--text)]"
                            style={fieldStyle}
                          />
                        </label>
                        <button
                          type="button"
                          className="rounded-full px-3 py-1.5 text-sm font-bold"
                          style={{
                            backgroundColor: "var(--accent)",
                            color: "var(--accent-text)",
                          }}
                          disabled={checkOff.isPending}
                          onClick={() =>
                            checkOff.mutate({
                              lineId: l.id,
                              outcome: "received",
                              qtyReceived: receivedQty,
                            })
                          }
                        >
                          Received
                        </button>
                        <button
                          type="button"
                          className="rounded-full px-3 py-1.5 text-sm font-bold"
                          style={{
                            backgroundColor: "var(--surface-alt)",
                            color: "var(--text)",
                          }}
                          disabled={checkOff.isPending}
                          onClick={() =>
                            checkOff.mutate({
                              lineId: l.id,
                              outcome: "not_received",
                              qtyReceived: null,
                            })
                          }
                        >
                          Not received
                        </button>
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          </div>
        </>
      ) : (
        <>
          <p className="text-sm text-[var(--dim)]">
            Built from everything at or below par after the Fire
            Station Supply Inventory, in the requisition's order —
            Medical supplies first, then Stationery, then general
            items. The Duty Officer signs, the District Chief reviews
            and signs, and it goes to the Quartermaster Section.
          </p>

          <div
            className="rounded-xl border p-3"
            style={{
              borderColor: "var(--border)",
              backgroundColor: "var(--surface)",
            }}
          >
            <div className="grid grid-cols-2 gap-2">
              <label className="flex flex-col gap-0.5 text-xs font-semibold text-[var(--dim)]">
                Division
                <input
                  value={division}
                  aria-label="Division"
                  onChange={(e) => setDivision(e.target.value)}
                  placeholder="Not set yet"
                  className={fieldCls}
                  style={fieldStyle}
                  autoComplete="off"
                />
              </label>
              <label className="flex flex-col gap-0.5 text-xs font-semibold text-[var(--dim)]">
                D.O. Name
                <input
                  value={doName}
                  aria-label="Duty Officer name"
                  onChange={(e) => setDoName(e.target.value)}
                  placeholder="Not set yet"
                  className={fieldCls}
                  style={fieldStyle}
                  autoComplete="off"
                />
              </label>
            </div>
            <p className="mt-2 text-sm">
              <strong>Station:</strong> {stationNo} ·{" "}
              <strong>Date:</strong> {todayLong} ·{" "}
              <strong>Req. No.:</strong> {reqNo}
            </p>
            {(profileDirty || profileMsg) && (
              <div className="mt-2 flex items-center gap-2">
                <button
                  type="button"
                  className="rounded-full px-3 py-1.5 text-sm font-bold"
                  style={{
                    backgroundColor: "var(--accent)",
                    color: "var(--accent-text)",
                  }}
                  disabled={!profileDirty || saveProfile.isPending}
                  onClick={() => saveProfile.mutate()}
                >
                  {saveProfile.isPending ? "Saving…" : "Save header details"}
                </button>
                {profileMsg && (
                  <span className="text-sm font-semibold">{profileMsg}</span>
                )}
              </div>
            )}
          </div>

          <div>
            <input
              type="search"
              value={itemSearch}
              onChange={(e) => setItemSearch(e.target.value)}
              placeholder="Add an item…"
              aria-label="Add an item to the requisition"
              className="w-full rounded-full border px-3 py-2 text-sm"
              style={{
                borderColor: "var(--border)",
                backgroundColor: "var(--surface)",
              }}
              autoComplete="off"
            />
            {searchQuery.length > 0 && (
              <div className="mt-1 flex flex-col gap-1">
                {searchResults.map((it) => {
                  const onDraft = buildLines.some(
                    (l) => l.itemId === it.id,
                  );
                  return (
                    <button
                      key={it.id}
                      type="button"
                      onClick={() => addFromSearch(it)}
                      aria-label={`Add ${it.name} to the requisition`}
                      className="flex items-center gap-2 rounded-xl border px-2 py-1.5 text-left"
                      style={{
                        borderColor: "var(--border)",
                        backgroundColor: "var(--surface)",
                      }}
                    >
                      <span className="min-w-0 flex-1">
                        <span className="block truncate text-sm font-semibold leading-tight">
                          {it.name}
                        </span>
                        <span className="block text-xs text-[var(--dim)]">
                          {it.category}
                          {it.sku
                            ? ` · Material # ${it.sku}`
                            : " · Material # —"}
                          {` · ${it.onHand} on hand`}
                        </span>
                      </span>
                      <span
                        className="shrink-0 rounded-full px-2.5 py-1 text-xs font-bold"
                        style={
                          onDraft
                            ? {
                                backgroundColor: "var(--surface-alt)",
                                color: "var(--text)",
                              }
                            : {
                                backgroundColor: "var(--accent)",
                                color: "var(--accent-text)",
                              }
                        }
                      >
                        {onDraft ? "On requisition" : "Add"}
                      </span>
                    </button>
                  );
                })}
                {searchResults.length === 0 && (
                  <p className="px-2 py-1.5 text-sm text-[var(--dim)]">
                    No inventory items match that search.
                  </p>
                )}
              </div>
            )}
          </div>

          <section
            aria-label="Items added from the filled requisition"
            className="rounded-xl border"
            style={{
              borderColor: "var(--border)",
              backgroundColor: "var(--surface)",
            }}
          >
            <button
              type="button"
              aria-expanded={filledReqOpen}
              onClick={() => setFilledReqOpen((o) => !o)}
              className="flex w-full items-center gap-2 px-3 py-2.5 text-left"
            >
              <span className="min-w-0 flex-1">
                <span className="block text-sm font-bold">
                  Added from the filled requisition — 3rd file
                </span>
                <span className="block text-xs text-[var(--dim)]">
                  {filledReqItems.length}{" "}
                  {filledReqItems.length === 1 ? "item" : "items"} from
                  that form are on the inventory list — these, and
                  nothing else, came from that file.
                </span>
              </span>
              <span
                className="shrink-0 rounded-full px-2.5 py-1 text-xs font-bold"
                style={{
                  backgroundColor: "var(--surface-alt)",
                  color: "var(--text)",
                }}
              >
                {filledReqOpen ? "Hide" : "Show"}
              </span>
            </button>
            {filledReqOpen && (
              <div className="flex flex-col gap-1 px-3 pb-3">
                {filledReqItems.map((it) => (
                  <div
                    key={it.id}
                    className="flex items-center gap-2 rounded-lg px-2 py-1.5"
                    style={{ backgroundColor: "var(--surface-alt)" }}
                  >
                    <span className="min-w-0 flex-1 text-sm font-semibold">
                      {it.name}
                    </span>
                    <span className="shrink-0 text-xs text-[var(--dim)]">
                      {it.category} · {it.onHand} on hand
                    </span>
                  </div>
                ))}
                {filledReqItems.length === 0 && (
                  <p className="text-sm text-[var(--dim)]">
                    No items from that form are on the inventory list
                    yet.
                  </p>
                )}
              </div>
            )}
          </section>

          {buildLines.length === 0 ? (
            <p
              className="rounded-xl px-3 py-3 text-sm font-semibold"
              style={{
                backgroundColor: "var(--ok-bg)",
                color: "var(--ok-text)",
              }}
            >
              Nothing to requisition — every item is above par and
              nothing is waiting to be resubmitted. Use the search
              above to add an item by hand.
            </p>
          ) : (
            <div className="flex flex-col gap-1">
              {buildLines.map((line) => {
                const qty = qtyOf(line);
                return (
                  <div
                    key={line.key}
                    id={`req-line-${line.key}`}
                    className="flex items-center gap-2 rounded-xl border px-2 py-1.5"
                    style={
                      flashKey === line.key
                        ? {
                            borderColor: "var(--accent)",
                            backgroundColor: "var(--accent-soft)",
                          }
                        : {
                            borderColor: "var(--border)",
                            backgroundColor: "var(--surface)",
                          }
                    }
                  >
                    <div className="min-w-0 flex-1">
                      <p className="text-sm font-semibold leading-tight">
                        {line.name}
                        {line.resubmitted && (
                          <span
                            className="ml-2 rounded-full px-1.5 py-0.5 text-[13px] font-bold"
                            style={{
                              backgroundColor: "var(--amber-soft)",
                              color: "var(--amber)",
                            }}
                          >
                            Resubmitted
                          </span>
                        )}
                      </p>
                      <p className="text-xs text-[var(--dim)]">
                        {line.category}
                        {line.materialNo
                          ? ` · Material # ${line.materialNo}`
                          : " · Material # —"}
                      </p>
                    </div>
                    <span className="shrink-0 text-xs font-semibold text-[var(--dim)]">
                      Qty
                    </span>
                    <div className="flex shrink-0 items-center gap-1">
                      <button
                        type="button"
                        aria-label={`Order fewer of ${line.name}`}
                        className="h-8 w-8 rounded-full text-lg font-bold"
                        style={{ backgroundColor: "var(--surface-alt)" }}
                        disabled={qty <= 0}
                        onClick={() =>
                          setQtyEdits((prev) => ({
                            ...prev,
                            [line.key]: Math.max(0, qty - 1),
                          }))
                        }
                      >
                        −
                      </button>
                      <span className="min-w-10 rounded-lg px-1 py-1.5 text-center text-sm font-bold" style={{ backgroundColor: "var(--surface-alt)" }}>
                        {qty}
                      </span>
                      <button
                        type="button"
                        aria-label={`Order more of ${line.name}`}
                        className="h-8 w-8 rounded-full text-lg font-bold"
                        style={{ backgroundColor: "var(--surface-alt)" }}
                        onClick={() =>
                          setQtyEdits((prev) => ({
                            ...prev,
                            [line.key]: qty + 1,
                          }))
                        }
                      >
                        +
                      </button>
                    </div>
                    <span className="w-12 shrink-0 text-xs text-[var(--dim)]">
                      {line.unit}
                    </span>
                    {line.draftExtraId != null && (
                      <button
                        type="button"
                        aria-label={`Remove ${line.name} from the requisition`}
                        className="shrink-0 rounded-full px-2 py-1 text-xs font-bold"
                        style={{
                          backgroundColor: "var(--surface-alt)",
                          color: "var(--text)",
                        }}
                        onClick={() =>
                          removeExtra.mutate(line.draftExtraId as number)
                        }
                      >
                        Remove
                      </button>
                    )}
                    {line.manual && (
                      <button
                        type="button"
                        aria-label={`Remove ${line.name} from the requisition`}
                        className="shrink-0 rounded-full px-2 py-1 text-xs font-bold"
                        style={{
                          backgroundColor: "var(--surface-alt)",
                          color: "var(--text)",
                        }}
                        onClick={() => removeManualLine(line)}
                      >
                        Remove
                      </button>
                    )}
                  </div>
                );
              })}
            </div>
          )}

          <div
            className="rounded-xl border p-3"
            style={{
              borderColor: "var(--border)",
              backgroundColor: "var(--surface)",
            }}
          >
            <h3 className="text-base font-bold">Requisition</h3>
            <p className="mt-1 text-xs font-semibold text-[var(--dim)]">
              To: tfsqm@toronto.ca · Subject: {emailSubject}
            </p>
            <pre
              className="mt-2 overflow-x-auto whitespace-pre-wrap rounded-lg border p-2 text-xs"
              style={{
                borderColor: "var(--border)",
                backgroundColor: "var(--surface-alt)",
              }}
            >
              {requisitionText}
            </pre>
            <div className="mt-3 flex flex-wrap items-center gap-2">
              <a
                href={mailto}
                className="rounded-full px-4 py-2 text-sm font-bold"
                style={{
                  backgroundColor: "var(--accent)",
                  color: "var(--accent-text)",
                }}
              >
                Open in email app
              </a>
              <button
                type="button"
                className="rounded-full px-4 py-2 text-sm font-bold"
                style={{
                  backgroundColor: "var(--surface-alt)",
                  color: "var(--text)",
                }}
                onClick={() => void copyText()}
              >
                Copy requisition text
              </button>
              <button
                type="button"
                className="rounded-full px-4 py-2 text-sm font-bold"
                style={{
                  backgroundColor: "var(--surface-alt)",
                  color: "var(--text)",
                }}
                disabled={send.isPending || sendLines.length === 0}
                onClick={() => send.mutate()}
              >
                {send.isPending ? "Sending…" : "Mark requisition as sent"}
              </button>
              {copied && (
                <span className="text-sm font-bold text-[var(--ok-text)]">
                  Copied ✓
                </span>
              )}
            </div>
            {sendLines.length === 0 && buildLines.length > 0 && (
              <p className="mt-2 text-sm text-[var(--dim)]">
                Every quantity is 0 — raise at least one quantity to
                send the requisition.
              </p>
            )}
            {sendError && (
              <p
                role="alert"
                className="mt-2 text-sm font-semibold text-[var(--red)]"
              >
                {sendError}
              </p>
            )}
            {sendMsg && (
              <p className="mt-2 text-sm font-semibold" role="status">
                {sendMsg}
              </p>
            )}
          </div>
        </>
      )}

      {history.length > 0 && (
        <section aria-label="Requisition history">
          <button
            type="button"
            aria-expanded={historyOpen}
            onClick={() => setHistoryOpen((o) => !o)}
            className="flex w-full items-center gap-2 rounded-xl border-2 px-3 py-2 text-left"
            style={{
              borderColor: "var(--accent)",
              backgroundColor: "var(--accent-soft)",
            }}
          >
            <span className="min-w-0 flex-1 font-bold">
              Requisition history{" "}
              <span className="text-sm font-semibold text-[var(--dim)]">
                ({history.length} on file)
              </span>
            </span>
            <Chevron collapsed={!historyOpen} />
          </button>
          {historyOpen && (
            <div className="mt-1 flex flex-col gap-1">
              {history.map((h) => (
                <div
                  key={h.id}
                  className="rounded-xl border px-2 py-1.5"
                  style={{
                    borderColor: "var(--border)",
                    backgroundColor: "var(--surface)",
                  }}
                >
                  <p className="text-sm font-semibold">
                    {h.reqNo} · sent{" "}
                    {new Date(h.sentAt).toLocaleDateString("en-CA", {
                      year: "numeric",
                      month: "long",
                      day: "numeric",
                    })}
                    {h.closedAt
                      ? ` · checked off ${new Date(h.closedAt).toLocaleDateString("en-CA", { month: "long", day: "numeric" })}`
                      : ""}
                  </p>
                  <p className="text-xs text-[var(--dim)]">
                    {h.lines.filter((l) => l.status === "received").length}{" "}
                    received ·{" "}
                    {h.lines.filter((l) => l.status === "not_received").length}{" "}
                    not received
                    {h.lines.some((l) => l.status === "not_received")
                      ? `: ${h.lines
                          .filter((l) => l.status === "not_received")
                          .map((l) => l.name)
                          .join(", ")}`
                      : ""}
                  </p>
                </div>
              ))}
            </div>
          )}
        </section>
      )}
    </div>
  );
}

// ---- Order Email tab ----------------------------------------------------

function suggestedOrderQty(it: BitItem): number {
  const need = Math.max(0, it.par - it.onHand);
  if (need === 0) return 0;
  const pack = Math.max(1, it.packSize);
  return Math.ceil(need / pack) * pack;
}

function OrderEmailTab({
  business,
  items,
  rounds,
}: {
  business: BitBusiness;
  items: BitItem[];
  rounds: BitState["rounds"];
}) {
  const needItems = items.filter((it) => it.onHand <= it.par);
  const [qtyEdits, setQtyEdits] = useState<Record<number, number>>({});
  const [to, setTo] = useState("");
  const [subjectEdit, setSubjectEdit] = useState<string | null>(null);
  const [bodyOverride, setBodyOverride] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  const today = new Date().toLocaleDateString("en-CA", {
    year: "numeric",
    month: "long",
    day: "numeric",
  });
  const defaultSubject = `Inventory order — ${business.name} — ${today}`;
  const subject = subjectEdit ?? defaultSubject;

  const groups = useMemo(() => {
    const map = new Map<string, BitItem[]>();
    for (const it of needItems) {
      const key = it.supplier?.trim() || "No supplier recorded";
      if (!map.has(key)) map.set(key, []);
      map.get(key)?.push(it);
    }
    return [...map.entries()].map(([supplier, list]) => ({
      supplier,
      items: list,
    }));
    // needItems is derived from props each render; grouping is cheap.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [items]);

  // Freezer alerts only exist for food & beverage businesses.
  const latestAlerts = isFoodAndBeverageType(business.type)
    ? (rounds[0]?.freezerReadings ?? []).filter((f) => f.alert)
    : [];

  const computedBody = useMemo(() => {
    const lines: string[] = [
      "Hi team,",
      "",
      `Here's the inventory order list for ${business.name} (${today}) — everything at or below par after the latest count:`,
      "",
    ];
    for (const g of groups) {
      lines.push(`${g.supplier}:`);
      for (const it of g.items) {
        const qty = qtyEdits[it.id] ?? suggestedOrderQty(it);
        lines.push(
          `  • ${it.name} — order ${qty} ${it.unit} (on hand: ${it.onHand}, par: ${it.par}${it.sku ? `, SKU ${it.sku}` : ""})`,
        );
      }
      lines.push("");
    }
    if (latestAlerts.length > 0) {
      lines.push(
        `Freezer check alert: ${latestAlerts
          .map((f) => `${f.freezer} at ${f.tempC}°C (warmer than −18°C)`)
          .join("; ")}.`,
        "",
      );
    }
    lines.push("Thanks,", `${business.name} · sent from BIT — Business Inventory Tracker`);
    return lines.join("\n");
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [groups, qtyEdits, business.name]);

  const body = bodyOverride ?? computedBody;
  const mailto = `mailto:${encodeURIComponent(to.trim())}?subject=${encodeURIComponent(subject)}&body=${encodeURIComponent(body)}`;

  async function copyBody() {
    try {
      await navigator.clipboard.writeText(
        `To: ${to}\nSubject: ${subject}\n\n${body}`,
      );
      setCopied(true);
      window.setTimeout(() => setCopied(false), 2500);
    } catch {
      setCopied(false);
    }
  }

  return (
    <div className="flex flex-col gap-2 pt-2">
      <p className="text-sm text-[var(--dim)]">
        Everything at or below par, grouped by supplier. Suggested
        quantities bring each item back up to par, rounded up to whole
        packs — adjust any of them before sending.
      </p>
      {groups.length === 0 ? (
        <p
          className="rounded-xl px-3 py-3 text-sm font-semibold"
          style={{
            backgroundColor: "var(--ok-bg)",
            color: "var(--ok-text)",
          }}
        >
          Nothing to order — every item is above par.
        </p>
      ) : (
        groups.map((g) => (
          <section key={g.supplier} aria-label={`Order from ${g.supplier}`}>
            <h3
              className="rounded-lg px-2 py-1 text-sm font-bold"
              style={{ backgroundColor: "var(--accent-soft)" }}
            >
              {g.supplier}
            </h3>
            <div className="mt-1 flex flex-col gap-1">
              {g.items.map((it) => {
                const qty = qtyEdits[it.id] ?? suggestedOrderQty(it);
                return (
                  <div
                    key={it.id}
                    className="flex items-center gap-2 rounded-xl border px-2 py-1.5"
                    style={{
                      borderColor: "var(--border)",
                      backgroundColor: "var(--surface)",
                    }}
                  >
                    <div className="min-w-0 flex-1">
                      <p className="text-sm font-semibold leading-tight">
                        {it.name}
                      </p>
                      <p className="text-xs text-[var(--dim)]">
                        On hand {it.onHand} {it.unit} · par {it.par}
                        {it.packSize > 1
                          ? ` · packs of ${it.packSize}`
                          : ""}
                      </p>
                    </div>
                    <span className="shrink-0 text-xs font-semibold text-[var(--dim)]">
                      Order
                    </span>
                    <div className="flex shrink-0 items-center gap-1">
                      <button
                        type="button"
                        aria-label={`Order fewer of ${it.name}`}
                        className="h-8 w-8 rounded-full text-lg font-bold"
                        style={{ backgroundColor: "var(--surface-alt)" }}
                        disabled={qty <= 0}
                        onClick={() =>
                          setQtyEdits((prev) => ({
                            ...prev,
                            [it.id]: Math.max(0, qty - 1),
                          }))
                        }
                      >
                        −
                      </button>
                      <span className="min-w-10 rounded-lg px-1 py-1.5 text-center text-sm font-bold" style={{ backgroundColor: "var(--surface-alt)" }}>
                        {qty}
                      </span>
                      <button
                        type="button"
                        aria-label={`Order more of ${it.name}`}
                        className="h-8 w-8 rounded-full text-lg font-bold"
                        style={{ backgroundColor: "var(--surface-alt)" }}
                        onClick={() =>
                          setQtyEdits((prev) => ({
                            ...prev,
                            [it.id]: qty + 1,
                          }))
                        }
                      >
                        +
                      </button>
                    </div>
                  </div>
                );
              })}
            </div>
          </section>
        ))
      )}

      {latestAlerts.length > 0 && (
        <p
          className="rounded-xl px-3 py-2 text-sm font-bold"
          style={{
            backgroundColor: "var(--red-soft)",
            color: "var(--red)",
          }}
        >
          🧊 Freezer alert from the latest inventory check:{" "}
          {latestAlerts
            .map((f) => `${f.freezer} at ${f.tempC}°C`)
            .join(", ")}{" "}
          — included in the email below.
        </p>
      )}

      <div
        className="rounded-xl border p-3"
        style={{
          borderColor: "var(--border)",
          backgroundColor: "var(--surface)",
        }}
      >
        <h3 className="text-base font-bold">Order email</h3>
        <div className="mt-2 flex flex-col gap-2">
          <label className="flex flex-col gap-0.5 text-xs font-semibold text-[var(--dim)]">
            To
            <input
              type="email"
              value={to}
              aria-label="Order email recipient"
              onChange={(e) => setTo(e.target.value)}
              placeholder="supervisor@example.com"
              className="rounded-lg border px-2 py-1.5 text-sm font-normal text-[var(--text)]"
              style={{
                borderColor: "var(--border)",
                backgroundColor: "var(--surface)",
              }}
              autoComplete="off"
            />
          </label>
          <label className="flex flex-col gap-0.5 text-xs font-semibold text-[var(--dim)]">
            Subject
            <input
              value={subject}
              aria-label="Order email subject"
              onChange={(e) => setSubjectEdit(e.target.value)}
              className="rounded-lg border px-2 py-1.5 text-sm font-normal text-[var(--text)]"
              style={{
                borderColor: "var(--border)",
                backgroundColor: "var(--surface)",
              }}
              autoComplete="off"
            />
          </label>
          <label className="flex flex-col gap-0.5 text-xs font-semibold text-[var(--dim)]">
            Message
            <textarea
              value={body}
              aria-label="Order email message"
              onChange={(e) => setBodyOverride(e.target.value)}
              rows={12}
              className="rounded-lg border px-2 py-1.5 text-sm font-normal text-[var(--text)]"
              style={{
                borderColor: "var(--border)",
                backgroundColor: "var(--surface)",
              }}
            />
          </label>
          {bodyOverride != null && (
            <button
              type="button"
              className="self-start text-xs font-bold"
              style={{ color: "var(--accent)" }}
              onClick={() => setBodyOverride(null)}
            >
              Reset message to the auto-written version
            </button>
          )}
        </div>
        <div className="mt-3 flex flex-wrap items-center gap-2">
          <a
            href={mailto}
            className="rounded-full px-4 py-2 text-sm font-bold"
            style={{
              backgroundColor: "var(--accent)",
              color: "var(--accent-text)",
            }}
          >
            Open in email app
          </a>
          <button
            type="button"
            className="rounded-full px-4 py-2 text-sm font-bold"
            style={{
              backgroundColor: "var(--surface-alt)",
              color: "var(--text)",
            }}
            onClick={() => void copyBody()}
          >
            Copy email text
          </button>
          {copied && (
            <span className="text-sm font-bold text-[var(--ok-text)]">
              Copied ✓
            </span>
          )}
        </div>
      </div>
    </div>
  );
}

// ---- Analytics tab (Alpha 0.76) -------------------------------------
// Shown only for businesses with a stored analytics dataset
// (business.hasAnalytics — today The Daily Scoop's BIT Sim 01
// results). Every figure is computed here from the stored monthly
// rows, the stored menu results and the LIVE item list; nothing is
// hard-coded copy.

function AnalyticsPanel({
  title,
  children,
}: {
  title: string;
  children: ReactNode;
}) {
  return (
    <section
      className="rounded-xl border p-3"
      style={{
        borderColor: "var(--border)",
        backgroundColor: "var(--surface)",
      }}
    >
      <h3 className="text-base font-bold">{title}</h3>
      <div className="mt-2">{children}</div>
    </section>
  );
}

function AnalyticsStatRow({
  label,
  value,
  alert,
}: {
  label: string;
  value: string;
  alert?: boolean;
}) {
  return (
    <div className="flex items-baseline justify-between gap-3 py-1">
      <span className="text-sm text-[var(--dim)]">{label}</span>
      <span
        className="text-right text-sm font-bold"
        style={alert ? { color: "var(--red)" } : undefined}
      >
        {value}
      </span>
    </div>
  );
}

function AnalyticsTab({
  business,
  items,
}: {
  business: BitBusiness;
  items: BitItem[];
}) {
  const analytics = useQuery({
    queryKey: ["bit-analytics", business.id],
    queryFn: () => api.getBitAnalytics({ businessId: business.id }),
  });
  const rootRef = useRef<HTMLDivElement>(null);
  // Chart colours come from the app's theme tokens (the BIT blue
  // accent, the alert red, axis greys), read off the rendered
  // scope so the charts follow light/dark mode.
  const [colors, setColors] = useState({
    accent: "#1e4f8a",
    red: "#a02c18",
    dim: "#46564c",
    border: "#c9cfc9",
  });
  const available = analytics.data?.available ?? false;
  useEffect(() => {
    const el = rootRef.current;
    if (!el) return;
    const cs = getComputedStyle(el);
    const pick = (name: string, fallback: string) =>
      cs.getPropertyValue(name).trim() || fallback;
    setColors({
      accent: pick("--accent", "#1e4f8a"),
      red: pick("--red", "#a02c18"),
      dim: pick("--dim", "#46564c"),
      border: pick("--border", "#c9cfc9"),
    });
  }, [available]);

  const stats = useMemo(() => {
    const data = analytics.data;
    if (!data || !data.available || data.months.length === 0) return null;
    const months = data.months;
    const sum = (f: (m: BitAnalyticsMonth) => number) =>
      months.reduce((acc, m) => acc + f(m), 0);
    const totalRevenue = sum((m) => m.revenue);
    const totalGross = sum((m) => m.grossProfit);
    const totalNet = sum((m) => m.netProfit);
    const totalTx = sum((m) => m.transactions);
    const totalUnits = sum((m) => m.unitsSold);
    const totalDays = sum((m) => m.daysOpen);
    const totalCogs = sum((m) => m.cogs);
    const totalWaste = sum((m) => m.wasteCost);
    const totalStockouts = sum((m) => m.stockoutEvents);
    const best = months.reduce((a, m) => (m.revenue > a.revenue ? m : a));
    const slowest = months.reduce((a, m) =>
      m.revenue < a.revenue ? m : a,
    );
    const daily = (m: BitAnalyticsMonth) =>
      m.daysOpen > 0 ? m.transactions / m.daysOpen : 0;
    const bestDaily = months.reduce((a, m) => (daily(m) > daily(a) ? m : a));
    const slowestDaily = months.reduce((a, m) =>
      daily(m) < daily(a) ? m : a,
    );
    const shareOf = (keys: string[]) => {
      const part = months
        .filter((m) => keys.includes(m.monthKey.slice(5)))
        .reduce((acc, m) => acc + m.revenue, 0);
      return totalRevenue > 0 ? (part / totalRevenue) * 100 : 0;
    };
    const avgInventoryValue =
      sum((m) => m.endingInventoryValue) / months.length;
    const currentInventoryValue = items.reduce((acc, it) => {
      const cost = data.itemCosts[it.name];
      return cost != null ? acc + cost * it.onHand : acc;
    }, 0);
    const topMenu = [...data.menu]
      .sort((a, b) => b.revenue - a.revenue)
      .slice(0, 5);
    const profitMin = Math.min(0, ...months.map((m) => m.netProfit));
    const profitMax = Math.max(0, ...months.map((m) => m.netProfit));
    const chartMonths = months.map((m) => ({
      ...m,
      short: m.label.split(" ")[0] ?? m.label,
    }));
    const pct = (n: number) => `${n.toFixed(1)}%`;
    return {
      data,
      months,
      chartMonths,
      totalRevenue,
      totalGross,
      totalNet,
      totalTx,
      totalUnits,
      totalDays,
      totalCogs,
      totalWaste,
      totalStockouts,
      grossMarginPct: totalRevenue > 0 ? (totalGross / totalRevenue) * 100 : 0,
      profitableMonths: months.filter((m) => m.netProfit > 0).length,
      best,
      slowest,
      bestDaily,
      slowestDaily,
      bestDailyRate: daily(bestDaily),
      slowestDailyRate: daily(slowestDaily),
      avgDailyTx: totalDays > 0 ? totalTx / totalDays : 0,
      peakToTrough: slowest.revenue > 0 ? best.revenue / slowest.revenue : 0,
      summerShare: shareOf(["06", "07", "08"]),
      winterShare: shareOf(["12", "01", "02"]),
      avgInventoryValue,
      turnover: avgInventoryValue > 0 ? totalCogs / avgInventoryValue : 0,
      currentInventoryValue,
      topMenu,
      profitMin,
      profitMax,
      pct,
    };
  }, [analytics.data, items]);

  return (
    <div ref={rootRef} className="flex flex-col gap-3 pt-3">
      {analytics.isPending && (
        <p className="py-6 text-center text-sm text-[var(--dim)]">
          Loading analytics…
        </p>
      )}
      {analytics.isError && (
        <p className="py-6 text-center text-sm font-semibold text-[var(--red)]">
          The analytics couldn't load.
        </p>
      )}
      {analytics.data && !analytics.data.available && (
        <p className="py-6 text-center text-sm text-[var(--dim)]">
          No analytics data for this business yet.
        </p>
      )}
      {stats && (
        <>
          <p className="text-sm text-[var(--dim)]">
            <span
              className="mr-2 rounded-full px-2 py-0.5 text-xs font-bold"
              style={{
                backgroundColor: "var(--accent-soft)",
                color: "var(--accent)",
              }}
            >
              Sim 01
            </span>
            {stats.data.label} — simulation data, {stats.data.periodLabel}.
            Statistics below are computed from the stored monthly results.
          </p>

          {/* Headline cards */}
          <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">
            {[
              {
                label: "Total revenue",
                value: fmtMoney(stats.totalRevenue),
                sub: `${stats.months.length} months · ${stats.totalDays} days open`,
              },
              {
                label: "Gross margin",
                value: stats.pct(stats.grossMarginPct),
                sub: `Gross profit ${fmtMoney(stats.totalGross)}`,
              },
              {
                label: "Net profit",
                value: fmtMoney(stats.totalNet),
                sub: `Profitable ${stats.profitableMonths} of ${stats.months.length} months`,
                alert: stats.totalNet < 0,
              },
              {
                label: "Total transactions",
                value: stats.totalTx.toLocaleString("en-CA"),
                sub: `${stats.totalUnits.toLocaleString("en-CA")} units sold`,
              },
              {
                label: "Avg daily transactions",
                value: stats.avgDailyTx.toFixed(1),
                sub: `Best: ${stats.bestDaily.label} · ${stats.bestDailyRate.toFixed(1)}/day`,
              },
              {
                label: "Slowest daily pace",
                value: `${stats.slowestDailyRate.toFixed(1)}/day`,
                sub: `${stats.slowestDaily.label} · ${stats.slowestDaily.transactions.toLocaleString("en-CA")} transactions`,
              },
            ].map((card) => (
              <div
                key={card.label}
                className="rounded-xl border p-3"
                style={{
                  borderColor: "var(--border)",
                  backgroundColor: "var(--surface)",
                }}
              >
                <p className="text-xs font-semibold text-[var(--dim)]">
                  {card.label}
                </p>
                <p
                  className="mt-0.5 text-xl font-extrabold"
                  style={
                    "alert" in card && card.alert
                      ? { color: "var(--red)" }
                      : undefined
                  }
                >
                  {card.value}
                </p>
                <p className="mt-0.5 text-xs text-[var(--dim)]">{card.sub}</p>
              </div>
            ))}
          </div>

          {/* Revenue by month */}
          <AnalyticsPanel title="Revenue by month">
            <p className="mb-1 text-xs text-[var(--dim)]">
              Best month highlighted: {stats.best.label} (
              {fmtMoney(stats.best.revenue)})
            </p>
            <div style={{ width: "100%", height: 220 }}>
              <ResponsiveContainer>
                <BarChart
                  data={stats.chartMonths}
                  margin={{ top: 8, right: 4, bottom: 0, left: 4 }}
                >
                  <CartesianGrid
                    stroke={colors.border}
                    strokeDasharray="3 3"
                    vertical={false}
                  />
                  <XAxis
                    dataKey="short"
                    tick={{ fontSize: 11, fill: colors.dim }}
                    tickLine={{ stroke: colors.border }}
                    axisLine={{ stroke: colors.border }}
                    interval={0}
                  />
                  <YAxis
                    domain={[0, "dataMax"]}
                    tick={{ fontSize: 11, fill: colors.dim }}
                    tickLine={false}
                    axisLine={false}
                    tickFormatter={(v: number) => fmtMoneyShort(v)}
                    width={46}
                  />
                  <Tooltip
                    cursor={{ fill: "#888888", fillOpacity: 0.12 }}
                    formatter={(v) => [
                      fmtMoney(typeof v === "number" ? v : 0),
                      "Revenue",
                    ]}
                  />
                  <Bar dataKey="revenue" radius={[3, 3, 0, 0]}>
                    {stats.chartMonths.map((m) => (
                      <Cell
                        key={m.monthKey}
                        fill={colors.accent}
                        fillOpacity={m.monthKey === stats.best.monthKey ? 1 : 0.45}
                      />
                    ))}
                  </Bar>
                </BarChart>
              </ResponsiveContainer>
            </div>
          </AnalyticsPanel>

          {/* Net profit by month */}
          <AnalyticsPanel title="Net profit by month">
            <p className="mb-1 text-xs text-[var(--dim)]">
              Months that lost money are shown in the alert colour.
            </p>
            <div style={{ width: "100%", height: 220 }}>
              <ResponsiveContainer>
                <BarChart
                  data={stats.chartMonths}
                  margin={{ top: 8, right: 4, bottom: 0, left: 4 }}
                >
                  <CartesianGrid
                    stroke={colors.border}
                    strokeDasharray="3 3"
                    vertical={false}
                  />
                  <XAxis
                    dataKey="short"
                    tick={{ fontSize: 11, fill: colors.dim }}
                    tickLine={{ stroke: colors.border }}
                    axisLine={{ stroke: colors.border }}
                    interval={0}
                  />
                  <YAxis
                    domain={[stats.profitMin, stats.profitMax]}
                    tick={{ fontSize: 11, fill: colors.dim }}
                    tickLine={false}
                    axisLine={false}
                    tickFormatter={(v: number) => fmtMoneyShort(v)}
                    width={46}
                  />
                  <Tooltip
                    cursor={{ fill: "#888888", fillOpacity: 0.12 }}
                    formatter={(v) => [
                      fmtMoney(typeof v === "number" ? v : 0),
                      "Net profit",
                    ]}
                  />
                  <ReferenceLine y={0} stroke={colors.dim} />
                  <Bar dataKey="netProfit" radius={[3, 3, 0, 0]}>
                    {stats.chartMonths.map((m) => (
                      <Cell
                        key={m.monthKey}
                        fill={m.netProfit < 0 ? colors.red : colors.accent}
                      />
                    ))}
                  </Bar>
                </BarChart>
              </ResponsiveContainer>
            </div>
            <div className="mt-2 overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="text-left text-xs text-[var(--dim)]">
                    <th className="py-1 pr-2 font-semibold">Month</th>
                    <th className="py-1 pr-2 text-right font-semibold">
                      Revenue
                    </th>
                    <th className="py-1 pr-2 text-right font-semibold">
                      Net profit
                    </th>
                    <th className="py-1 text-right font-semibold">
                      Transactions
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {stats.months.map((m) => (
                    <tr
                      key={m.monthKey}
                      className="border-t"
                      style={{ borderColor: "var(--border)" }}
                    >
                      <td className="py-1 pr-2 font-semibold">{m.label}</td>
                      <td className="py-1 pr-2 text-right">
                        {fmtMoney(m.revenue)}
                      </td>
                      <td
                        className="py-1 pr-2 text-right"
                        style={
                          m.netProfit < 0
                            ? { color: "var(--red)", fontWeight: 700 }
                            : undefined
                        }
                      >
                        {fmtMoney(m.netProfit)}
                      </td>
                      <td className="py-1 text-right">
                        {m.transactions.toLocaleString("en-CA")}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </AnalyticsPanel>

          {/* Seasonality */}
          <AnalyticsPanel title="Busy & slow times of year">
            <AnalyticsStatRow
              label="Busiest month"
              value={`${stats.best.label} — ${fmtMoney(stats.best.revenue)}`}
            />
            <AnalyticsStatRow
              label="Slowest month"
              value={`${stats.slowest.label} — ${fmtMoney(stats.slowest.revenue)}`}
            />
            <AnalyticsStatRow
              label="Peak-to-trough revenue ratio"
              value={`${stats.peakToTrough.toFixed(1)}×`}
            />
            <AnalyticsStatRow
              label="Jun–Aug share of annual revenue"
              value={stats.pct(stats.summerShare)}
            />
            <AnalyticsStatRow
              label="Dec–Feb share of annual revenue"
              value={stats.pct(stats.winterShare)}
            />
            <AnalyticsStatRow
              label="Busiest daily pace"
              value={`${stats.bestDaily.label} — ${stats.bestDailyRate.toFixed(1)} transactions/day`}
            />
            <AnalyticsStatRow
              label="Slowest daily pace"
              value={`${stats.slowestDaily.label} — ${stats.slowestDailyRate.toFixed(1)} transactions/day`}
            />
          </AnalyticsPanel>

          {/* Top menu items */}
          <AnalyticsPanel title="Top menu items by revenue">
            <ol className="flex flex-col">
              {stats.topMenu.map((item, i) => (
                <li
                  key={item.name}
                  className="flex items-baseline justify-between gap-3 py-1"
                >
                  <span className="min-w-0 text-sm">
                    <span className="font-bold text-[var(--dim)]">
                      {i + 1}.
                    </span>{" "}
                    <span className="font-semibold">{item.name}</span>{" "}
                    <span className="text-[var(--dim)]">
                      · {item.units.toLocaleString("en-CA")} sold
                    </span>
                  </span>
                  <span className="shrink-0 text-sm font-bold">
                    {fmtMoney(item.revenue)}{" "}
                    <span className="font-semibold text-[var(--dim)]">
                      (
                      {stats.pct(
                        stats.totalRevenue > 0
                          ? (item.revenue / stats.totalRevenue) * 100
                          : 0,
                      )}
                      )
                    </span>
                  </span>
                </li>
              ))}
            </ol>
          </AnalyticsPanel>

          {/* Inventory */}
          <AnalyticsPanel title="Inventory">
            <AnalyticsStatRow
              label="Inventory turnover (annual COGS ÷ avg inventory value)"
              value={`${stats.turnover.toFixed(1)}×`}
            />
            <AnalyticsStatRow
              label="Average inventory value"
              value={fmtMoney(stats.avgInventoryValue)}
            />
            <AnalyticsStatRow
              label="Current inventory value (live stock, at cost)"
              value={fmtMoney(stats.currentInventoryValue)}
            />
            <AnalyticsStatRow
              label="Total waste cost"
              value={fmtMoney(stats.totalWaste)}
            />
            <AnalyticsStatRow
              label="Stockout events"
              value={`${stats.totalStockouts} — ${fmtMoney(stats.data.lostRevenue)} lost revenue (${stats.data.lostUnits} units)`}
              alert={stats.totalStockouts > 0}
            />
            <AnalyticsStatRow
              label="Supplier orders placed"
              value={String(
                stats.months.reduce((acc, m) => acc + m.ordersPlaced, 0),
              )}
            />
            {stats.data.tubWaste.length > 0 && (
              <div className="pt-1">
                <p className="text-sm font-semibold">
                  Slow-season tub waste (written off)
                </p>
                {stats.data.tubWaste.map((w) => (
                  <AnalyticsStatRow
                    key={w.name}
                    label={w.name}
                    value={`${w.tubs.toFixed(2)} tubs`}
                  />
                ))}
              </div>
            )}
          </AnalyticsPanel>
        </>
      )}
    </div>
  );
}

// ---- BIT root -----------------------------------------------------------

const BIT_TABS: { id: BitTab; label: string }[] = [
  { id: "inventory", label: "Inventory" },
  { id: "rounds", label: "Inventory Checks" },
  { id: "order", label: "Order Email" },
];

export function BitApp({ onSwitch }: { onSwitch: () => void }) {
  const queryClient = useQueryClient();
  const [tab, setTab] = useState<BitTab>("inventory");
  const [setupOpen, setSetupOpen] = useState(false);
  // The active business (Alpha 0.69): null = the first business,
  // exactly the pre-switcher behaviour. Switching swaps every tab
  // — inventory, checks, order email, POS — to the chosen business.
  const [activeBusinessId, setActiveBusinessId] = useState<number | null>(
    null,
  );
  const state = useQuery({
    queryKey: ["bit", activeBusinessId],
    queryFn: () => api.getBitState({ businessId: activeBusinessId }),
    refetchInterval: (query) =>
      query.state.data?.scans.some((s) => s.status === "pending")
        ? 5000
        : false,
  });

  const dismissScan = useMutation({
    mutationFn: async (scan: BitScan) =>
      await api.dismissBitManifestScan({ id: scan.id }),
    onSuccess: () =>
      void queryClient.invalidateQueries({ queryKey: ["bit"] }),
  });

  const data = state.data;
  const business = data?.business ?? null;
  const showWizard = business == null || setupOpen;

  return (
    <div className="bit-scope">
      <div className="flex items-center justify-between gap-2 pt-2">
        <span
          className="text-xs font-bold tracking-wide"
          style={{ color: "var(--accent)" }}
        >
          BIT — BUSINESS INVENTORY TRACKER
        </span>
        <button
          type="button"
          onClick={onSwitch}
          className="shrink-0 rounded-full px-3 py-1.5 text-xs font-bold"
          style={{
            backgroundColor: "var(--surface-alt)",
            color: "var(--text)",
          }}
        >
          ⇄ Switch app
        </button>
      </div>

      {state.isPending && (
        <p className="py-8 text-center text-sm text-[var(--dim)]">
          Loading the business side…
        </p>
      )}
      {state.isError && (
        <div className="py-8 text-center">
          <p className="text-sm font-semibold text-[var(--red)]">
            The business side couldn't load.
          </p>
          <button
            type="button"
            className="mt-2 rounded-full px-4 py-2 text-sm font-bold"
            style={{
              backgroundColor: "var(--accent)",
              color: "var(--accent-text)",
            }}
            onClick={() => void state.refetch()}
          >
            Try again
          </button>
        </div>
      )}

      {data && showWizard && (
        <BitSetupWizard
          business={business}
          businessId={business?.id ?? activeBusinessId}
          scans={data.scans}
          onDone={() => setSetupOpen(false)}
          onCancel={business ? () => setSetupOpen(false) : null}
          onDismissScan={(scan) => dismissScan.mutate(scan)}
        />
      )}

      {data && business && !showWizard && (
        <>
          {data.businesses.length > 1 && (
            <div className="flex items-center gap-2 pt-2">
              <label
                htmlFor="bit-business-switcher"
                className="shrink-0 text-sm font-bold text-[var(--dim)]"
              >
                Business
              </label>
              <select
                id="bit-business-switcher"
                aria-label="Switch business"
                value={business.id}
                onChange={(e) => {
                  setActiveBusinessId(Number(e.target.value));
                  setSetupOpen(false);
                  setTab("inventory");
                }}
                className="min-w-0 flex-1 rounded-full border px-3 py-2 text-sm font-bold"
                style={{
                  borderColor: "var(--border)",
                  backgroundColor: "var(--surface)",
                  color: "var(--text)",
                }}
              >
                {data.businesses.map((b) => (
                  <option key={b.id} value={b.id}>
                    {b.name}
                  </option>
                ))}
              </select>
            </div>
          )}
          <header className="pt-1">
            <h2 className="truncate text-2xl font-bold">
              {business.name}
            </h2>
            <p className="text-sm text-[var(--dim)]">
              {typeLabel(business)} · {data.items.length} items ·{" "}
              {
                data.items.filter(
                  (i) =>
                    i.onHand <= i.par &&
                    // A requisition business's no-par items (par 0 —
                    // e.g. the Quartermaster catalogue group) never
                    // count toward the requisition build.
                    (!business.usesRequisition || i.par > 0),
                ).length
              }{" "}
              at or below par
            </p>
          </header>

          <nav aria-label="Business tracker" className="pt-2">
            <div
              className="flex rounded-full p-1"
              style={{ backgroundColor: "var(--surface)" }}
              role="group"
            >
              {(business.hasAnalytics
                ? [...BIT_TABS, { id: "analytics" as BitTab, label: "Analytics" }]
                : BIT_TABS
              ).map((t) => {
                const badge =
                  t.id === "order"
                    ? data.items.filter(
                        (i) =>
                          i.onHand <= i.par &&
                          (!business.usesRequisition || i.par > 0),
                      ).length
                    : 0;
                // Requisition businesses (TFS) call the third tab
                // "Requisition"; every other business keeps
                // "Order Email".
                const label =
                  t.id === "order" && business.usesRequisition
                    ? "Requisition"
                    : t.label;
                return (
                  <button
                    key={t.id}
                    type="button"
                    aria-pressed={tab === t.id}
                    onClick={() => setTab(t.id)}
                    className="min-w-0 flex-1 truncate rounded-full px-0.5 py-2 text-[11.5px] font-bold"
                    style={
                      tab === t.id
                        ? {
                            backgroundColor: "var(--accent)",
                            color: "var(--accent-text)",
                          }
                        : { color: "var(--dim)" }
                    }
                  >
                    {label}
                    {badge > 0 ? ` (${badge})` : ""}
                  </button>
                );
              })}
            </div>
          </nav>
          <div className="flex justify-end pt-1">
            <button
              type="button"
              className="text-xs font-bold"
              style={{ color: "var(--accent)" }}
              onClick={() => setSetupOpen(true)}
            >
              Business setup
            </button>
          </div>

          {tab === "rounds" && (
            <RoundsTab
              business={business}
              items={data.items}
              rounds={data.rounds}
            />
          )}
          {tab === "inventory" && (
            <InventoryTab
              business={business}
              items={data.items}
              scans={data.scans}
              wasteLog={data.wasteLog}
              onDismissScan={(scan) => dismissScan.mutate(scan)}
            />
          )}
          {tab === "analytics" && business.hasAnalytics && (
            <AnalyticsTab business={business} items={data.items} />
          )}
          {tab === "order" &&
            (business.usesRequisition ? (
              <RequisitionTab
                business={business}
                items={data.items}
                requisition={data.requisition}
                history={data.requisitionHistory}
                resubmittedLines={data.resubmittedLines}
                draftExtras={data.draftExtras}
              />
            ) : (
              <OrderEmailTab
                business={business}
                items={data.items}
                rounds={data.rounds}
              />
            ))}
        </>
      )}
    </div>
  );
}
