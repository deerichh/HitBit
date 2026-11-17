import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
Bar,
BarChart,
CartesianGrid,
Cell,
ResponsiveContainer,
Tooltip,
XAxis,
YAxis,
} from "recharts";
import { fileToBase64 } from "@hatch/space-sdk/client";
import { PdfViewer } from "@hatch/space-sdk/pdf";
import { api, type ApiResponse } from "./api";
import { AccountPolicy, ActorTag } from "./AccountPolicy";
import {
GearButton,
SettingsDrawer,
SettingsDrawerItem,
UndoLastActionItem,
} from "./SettingsDrawer";
import { INFO_BUTTON_STYLE, useHoldInfo } from "./popupHooks";
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

/** The requisition order sequence: Medical supplies first,
    then Stationery (Office Supplies), then Cleaning supplies
    (general), then everything else. */
function reqCategoryRank(category: string): number {
  const c = category.trim().toLowerCase();
  if (c === "medical") return 0;
  if (c === "office supplies" || c === "stationery" || c === "stationary")
    return 1;
  if (c === "cleaning supplies") return 2;
  return 3;
}

/** The tag carried by every inventory item that came from a
    filled-in requisition form supplied by the user, set
    server-side when such a form is imported. The Requisition tab
    lists exactly the items carrying it — nothing else. */
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

/** The short code from the business name (its first 2–4 digit
    run, or "B" + the business id), used in the requisition
    number. */
function reqCodeOf(business: BitBusiness): string {
  const m = business.name.match(/(\d{2,4})/);
  return m?.[1] ?? `B${business.id}`;
}

/**
 * Render typed initials as a "signature": the lettering is drawn
 * in the generic cursive (Great Vibes, the .req-signature font)
 * on a transparent canvas and returned as base64 PNG, which the
 * server draws into the filled requisition form's signature box. Returns
 * null when the initials are blank or the drawing fails — the
 * signature box then stays blank, as before.
 */
async function renderSignaturePng(
  initials: string,
): Promise<string | null> {
  const text = initials.trim();
  if (!text) return null;
  try {
    // Wait for the cursive web font so the drawing uses it; if it
    // can't load, the canvas falls back to the platform cursive.
    try {
      await document.fonts.load('80px "Great Vibes"', text);
    } catch {
      // Font loading is best-effort — draw with the fallback.
    }
    const fontPx = 96;
    const font = `${fontPx}px "Great Vibes", "Snell Roundhand", cursive`;
    const measure = document.createElement("canvas").getContext("2d");
    if (!measure) return null;
    measure.font = font;
    const textW = Math.max(1, Math.ceil(measure.measureText(text).width));
    // Draw on an oversized canvas first: Great Vibes capitals
    // carry swashes that reach far above and below the em box —
    // well past a lowercase letter's height — so a canvas sized
    // to the font size clips them, and a canvas with fixed
    // padding leaves the capitals' ink filling nearly the whole
    // image while lowercase ink fills a fraction of it, which is
    // why capitals loomed too big for the form's signature box
    // once the server fitted the image into it. Drawing large
    // and cropping to the actual ink (below) makes the returned
    // PNG hug the lettering whatever case it is in, so the
    // server's fit-to-box scaling treats capitals and lowercase
    // alike.
    const canvas = document.createElement("canvas");
    canvas.width = textW + 64;
    canvas.height = fontPx * 3;
    const ctx2d = canvas.getContext("2d");
    if (!ctx2d) return null;
    ctx2d.font = font;
    ctx2d.textBaseline = "alphabetic";
    ctx2d.fillStyle = "#191d26";
    ctx2d.fillText(text, 32, fontPx * 1.9);
    // Find the ink's bounding box from the drawn pixels.
    const img = ctx2d.getImageData(0, 0, canvas.width, canvas.height);
    let minX = canvas.width;
    let minY = canvas.height;
    let maxX = -1;
    let maxY = -1;
    for (let y = 0; y < canvas.height; y++) {
      for (let x = 0; x < canvas.width; x++) {
        if ((img.data[(y * canvas.width + x) * 4 + 3] ?? 0) > 8) {
          if (x < minX) minX = x;
          if (x > maxX) maxX = x;
          if (y < minY) minY = y;
          if (y > maxY) maxY = y;
        }
      }
    }
    if (maxX < 0) return null;
    const pad = 6;
    const sx = Math.max(0, minX - pad);
    const sy = Math.max(0, minY - pad);
    const sw = Math.min(canvas.width, maxX + pad + 1) - sx;
    const sh = Math.min(canvas.height, maxY + pad + 1) - sy;
    const cropped = document.createElement("canvas");
    cropped.width = sw;
    cropped.height = sh;
    const cctx = cropped.getContext("2d");
    if (!cctx) return null;
    cctx.drawImage(canvas, sx, sy, sw, sh, 0, 0, sw, sh);
    const dataUrl = cropped.toDataURL("image/png");
    const comma = dataUrl.indexOf(",");
    return comma >= 0 ? dataUrl.slice(comma + 1) : null;
  } catch {
    return null;
  }
}

/**
 * The cursive signature preview inside a signature box. Great
 * Vibes capitals are drawn far taller than its lowercase — at a
 * fixed font size an all-capitals signature towers out of the
 * box while a lowercase one sits small. So the preview measures
 * the lettering's actual ink height (canvas measureText at a
 * reference size, once the cursive has loaded) and picks the
 * font size that gives the ink a constant height, whatever case
 * the initials are typed in — the same normalizing the filled
 * form's signature gets from renderSignaturePng's ink crop.
 */
function SignaturePreview({ text }: { text: string }) {
  const [fontSize, setFontSize] = useState(20);
  useEffect(() => {
    let cancelled = false;
    const target = 20; // px of actual ink height inside the box
    const refPx = 100;
    void (async () => {
      try {
        await document.fonts.load(`${refPx}px "Great Vibes"`, text);
      } catch {
        // Best-effort — measure with the fallback cursive.
      }
      if (cancelled) return;
      const c = document.createElement("canvas").getContext("2d");
      if (!c) return;
      c.font = `${refPx}px "Great Vibes", "Snell Roundhand", cursive`;
      const m = c.measureText(text);
      const ink =
        (m.actualBoundingBoxAscent ?? refPx * 0.7) +
        (m.actualBoundingBoxDescent ?? refPx * 0.25);
      if (ink > 0) {
        const size = Math.round((refPx * target) / ink);
        if (!cancelled) setFontSize(Math.min(24, Math.max(11, size)));
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [text]);
  return (
    <span
      className="req-signature truncate leading-none"
      style={{ fontSize }}
    >
      {text}
    </span>
  );
}

/** Division is free text the user sets (a division recorded
    another way — e.g. read off a scanned pre-populated form — is
    kept exactly as read, never silently lost). */
function DivisionSelect({
  value,
  onChange,
}: {
  value: string;
  onChange: (v: string) => void;
}) {
  return (
    <input
      value={value}
      aria-label="Division"
      onChange={(e) => onChange(e.target.value)}
      placeholder="Not set yet"
      className="rounded-lg border px-2 py-1.5 text-sm font-normal text-[var(--text)]"
      style={{
        borderColor: "var(--border)",
        backgroundColor: "var(--surface)",
      }}
      autoComplete="off"
    />
  );
}

/** Save a base64 PDF to the device or PC as a file download.
    Returns false when the download couldn't be started. */
function downloadPdfBase64(base64: string, filename: string): boolean {
  try {
    const bytes = Uint8Array.from(atob(base64), (c) => c.charCodeAt(0));
    const blob = new Blob([bytes], { type: "application/pdf" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
    window.setTimeout(() => URL.revokeObjectURL(url), 5000);
    return true;
  } catch {
    return false;
  }
}

/** Today's requisition number: Fire Station-YY-MM-DD. */
function reqNoToday(business: BitBusiness): string {
  const now = new Date();
  const yy = String(now.getFullYear()).slice(-2);
  const mm = String(now.getMonth() + 1).padStart(2, "0");
  const dd = String(now.getDate()).padStart(2, "0");
  return `${reqCodeOf(business)}-${yy}-${mm}-${dd}`;
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
type BitStockEvent = BitState["stockEvents"][number];
type BitManifestImport = BitState["manifestImports"][number];

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

/**
 * The ⓘ button of the one header spec (Beta 0.05, audit #9): it
 * sits beside a banner's title count and its popup lists — names
 * only, one per line — what the count counts, so the number
 * always matches the list. HOLD-TO-SHOW, like every ⓘ in the app
 * (see popupHooks): shown while held, gone within 2 seconds of
 * release. Category groups don't carry one — expanding the group
 * already shows its items; this serves banners whose counted set
 * isn't the expanded rows (Requisition history's numbers).
 */
function BitInfoListButton({
  names,
  emptyText,
  ariaLabel,
}: {
  names: string[];
  emptyText: string;
  ariaLabel: string;
}) {
  const hold = useHoldInfo();

  return (
    <span
      data-hold-info-root=""
      className="relative inline-flex shrink-0 items-center"
    >
      {hold.visible && (
        <span
          role="tooltip"
          className="pointer-events-none absolute top-full right-0 z-50 mt-1 rounded-lg border px-2.5 py-1.5 text-left shadow-lg"
          style={{
            backgroundColor: "var(--surface)",
            color: "var(--text)",
            borderColor: "var(--border)",
            fontSize: 13,
            boxShadow: "0 6px 20px rgba(0,0,0,0.22)",
            opacity: hold.fading ? 0 : 1,
            transition: "opacity 0.7s ease",
          }}
        >
          {names.length > 0 ? (
            names.map((name, idx) => (
              <span
                key={`${name}-${idx}`}
                className="block font-semibold whitespace-nowrap"
              >
                {name}
              </span>
            ))
          ) : (
            <span className="block font-semibold whitespace-nowrap">
              {emptyText}
            </span>
          )}
        </span>
      )}
      <button
        type="button"
        aria-label={ariaLabel}
        {...hold.buttonProps}
        className="hit24 inline-flex shrink-0 items-center justify-center rounded-full leading-none"
        style={{
          width: 18,
          height: 18,
          // Overrides the global 2rem button minimum in theme.css
          // so the button stays small and quiet beside the count.
          // The visible box stays 18×18; the .hit24 overlay
          // (theme.css, audit #10) grows the tappable area to
          // 24×24 without changing the layout.
          minHeight: 18,
          padding: 0,
          fontSize: 13,
          color: "var(--dim)",
          backgroundColor: "transparent",
          ...INFO_BUTTON_STYLE,
        }}
      >
        ⓘ
      </button>
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

/** Whole local calendar days from a date's day to today. */
function daysAgoFrom(d: Date): number {
  const startOfDay = (x: Date) =>
    new Date(x.getFullYear(), x.getMonth(), x.getDate()).getTime();
  return Math.round((startOfDay(new Date()) - startOfDay(d)) / 86_400_000);
}

/** The counted-last stamp (audit #16), in plain words with the
    date and its relative age: "Last counted: Sat Nov 15 · today",
    "· yesterday", "· 3 days ago" — or "Not counted yet" when
    there is no finished count to point at. */
function lastCountedLabel(iso: string | null): string {
  if (!iso) return "Not counted yet";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "Not counted yet";
  const days = daysAgoFrom(d);
  const rel =
    days <= 0 ? "today" : days === 1 ? "yesterday" : `${days} days ago`;
  const date = d.toLocaleDateString("en-CA", {
    weekday: "short",
    month: "short",
    day: "numeric",
  });
  return `Last counted: ${date} · ${rel}`;
}

/** A long-form date ("November 15, 2026") for the requisition
    state lines; "" when the stamp is missing or invalid. */
function longDateOrEmpty(iso: string | null): string {
  if (!iso) return "";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  return d.toLocaleDateString("en-CA", {
    year: "numeric",
    month: "long",
    day: "numeric",
  });
}

/** A requisition's state, shown plainly (audit #15): Prepared by
    (name, date) → Approved by (name, date) → Sent (date). Parts
    never recorded are skipped — a requisition sent before the
    approver step existed only knows its sent date. */
function RequisitionStateLine({ req }: { req: BitRequisition }) {
  const parts: string[] = [];
  if (req.preparedBy) {
    const d = longDateOrEmpty(req.preparedAt);
    parts.push(`Prepared by ${req.preparedBy}${d ? ` · ${d}` : ""}`);
  }
  if (req.approvedBy) {
    const d = longDateOrEmpty(req.approvedAt);
    parts.push(`Approved by ${req.approvedBy}${d ? ` · ${d}` : ""}`);
  }
  const sent = longDateOrEmpty(req.sentAt);
  parts.push(sent ? `Sent ${sent}` : "Sent");
  return (
    <p className="text-xs font-semibold text-[var(--dim)]">
      {parts.join(" → ")}
    </p>
  );
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

/** Team-size bands for the wizard's team-size step (Alpha 0.90):
    eight presets, plus Other with manual entry. */
const TEAM_SIZE_BANDS = [
  "Just me",
  "2–3",
  "4–5",
  "6–10",
  "11–15",
  "16–25",
  "26–50",
  "More than 50",
];

/** Extra category options used to pad a pack's category list to
    eight presets on the wizard's categories step (Alpha 0.90),
    mirroring the staging questionnaire. */
const WIZARD_CATEGORY_EXTRAS = [
  "Packaging",
  "Cleaning & Janitorial",
  "Equipment & Smallwares",
  "Seasonal & Specials",
  "Office & Admin",
  "Merchandise",
  "Deliveries",
  "Repairs & Maintenance",
];

const wizChipBase =
  "rounded-full border-2 px-4 py-2 text-sm font-bold text-left";
const wizChipOn = {
  backgroundColor: "var(--accent)",
  color: "var(--accent-text)",
  borderColor: "var(--accent)",
} as const;
const wizChipOff = {
  borderColor: "var(--border)",
  backgroundColor: "var(--surface)",
  color: "var(--text)",
} as const;

/**
 * The wizard's "Your setup so far" preview box (Alpha 0.90): the
 * same label/value rows as the Review step, rendered ~30% smaller,
 * sitting under each step's questions. Labels always show; values
 * fill in as answers are given (team size and categories start
 * blank — nothing is pre-picked for them).
 */
function BitSetupPreview({ rows }: { rows: [string, string][] }) {
  return (
    <div
      className="mt-6 rounded-xl border px-3 py-2"
      style={{
        borderColor: "var(--border)",
        backgroundColor: "var(--surface-alt)",
        fontSize: "11.5px",
        lineHeight: "16px",
      }}
      aria-label="Your setup so far"
    >
      <p className="font-bold" style={{ fontSize: "11.5px" }}>
        Your setup so far — fills in as you answer
      </p>
      <table className="mt-1 w-full" style={{ fontSize: "11.5px" }}>
        <tbody>
          {rows.map(([label, value]) => (
            <tr key={label}>
              <th
                className="py-0.5 pr-2 text-left align-top font-bold whitespace-nowrap"
                style={{ color: "var(--dim)" }}
              >
                {label}
              </th>
              <td className="py-0.5 font-semibold">{value}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

interface WizardProps {
  /** Always null since Alpha 0.88: setup only ever creates a NEW
      business (first run, or "Add New Business"), so the wizard
      never prefills from — and can never overwrite — an existing
      business. Kept as a prop so the call site states that
      explicitly. */
  business: BitBusiness | null;
  /** Business that manifest photo scans uploaded during the
      wizard attach to (null on first run / add mode). The items a
      confirmed scan contributes are imported into the NEW business
      at Finish, via the id completeBitSetup returns. */
  businessId?: number | null;
  scans: BitScan[];
  /** Called with the newly created business's id. */
  onDone: (newBusinessId: number) => void;
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
  // Team-size step (Alpha 0.90): one of the eight bands, or a
  // custom entry typed through Other (stored exactly like a band).
  const [teamSize, setTeamSize] = useState("");
  // Whether this business orders by requisition (asked on the
  // Review step): true gives it the Requisition tab with the
  // preparer / approver flow instead of the Order Email tab.
  const [usesRequisition, setUsesRequisition] = useState(false);
  const [teamOtherOpen, setTeamOtherOpen] = useState(false);
  const [teamOtherDraft, setTeamOtherDraft] = useState("");
  // Business-type Other entry (Alpha 0.90): a type typed through
  // the Other… button behaves exactly like a preset — it selects
  // the "Other" type with the typed text as its custom type, takes
  // a ✓ chip, and shows in the preview box and on Review.
  const [typeOtherOpen, setTypeOtherOpen] = useState(false);
  const [typeOtherDraft, setTypeOtherDraft] = useState("");
  const [typeCustomApplied, setTypeCustomApplied] = useState(false);
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
  // as categories, duplicates merged — padded to eight presets
  // with the questionnaire's extra options (Alpha 0.90).
  const groupOptions = packCategoryOptions(pack);
  for (const extra of WIZARD_CATEGORY_EXTRAS) {
    if (groupOptions.length >= 8) break;
    if (!groupOptions.includes(extra)) groupOptions.push(extra);
  }
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
    if (t !== "Other") setTypeCustomApplied(false);
    const p = PACKS_TYPED[t] ?? PACKS_TYPED["Other"];
    if (!p) return;
    setName(p.defaultName);
    // Switching type starts the category picks over: only the
    // categories the user picks for this type are stored.
    setGroups([]);
  }

  function applyTypeOther() {
    const v = typeOtherDraft.trim();
    if (!v) return;
    pickType("Other");
    setCustomType(v);
    setTypeCustomApplied(true);
    setTypeOtherDraft("");
    setTypeOtherOpen(false);
  }

  function applyTeamOther() {
    const v = teamOtherDraft.trim();
    if (!v) return;
    setTeamSize(v);
    setTeamOtherDraft("");
    setTeamOtherOpen(false);
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
      // Add-only (Alpha 0.88): completeBitSetup always creates a
      // brand-new business and returns its id — no existing
      // business is targeted, so nothing existing can be
      // overwritten or wiped by finishing setup.
      const setup = await api.completeBitSetup({
        businessType: bizType,
        customType:
          bizType === "Other" ? customType.trim() || null : null,
        name: name.trim() || pack.defaultName,
        teamSize: teamSize.trim() ? teamSize.trim() : null,
        usesRequisition,
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
        // The confirmed scan's lines belong to the NEW business
        // this setup just created — never to an existing one.
        await api.importBitManifest({
          businessId: setup.businessId,
          lines: scanConfirm.rows,
          scanId: scanConfirm.scanId,
        });
      }
      return setup.businessId;
    },
    onSuccess: (newBusinessId) => {
      void queryClient.invalidateQueries({ queryKey: ["bit"] });
      onDone(newBusinessId);
    },
    onError: () =>
      setFinishError("Setup didn't save. Please try again."),
  });

  const stepTitle = [
    "What kind of business is this for?",
    "What's the business called?",
    "How many people are on your team?",
    "Which categories do you want?",
    "Already have an inventory list?",
    "Review your setup",
  ][step - 1];

  const typeDisplay =
    bizType === "Other" && customType.trim()
      ? `Other — ${customType.trim()}`
      : bizType;

  return (
    <section aria-label="Business setup" className="pt-2 pb-12">
      <p className="text-xs font-bold tracking-wide text-[var(--dim)]">
        BUSINESS SETUP · STEP {step} OF 6
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
                  className="rounded-full border-2 px-4 py-2 text-sm font-bold"
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
                  {selected ? `✓ ${t}` : t}
                </button>
              );
            })}
            {typeCustomApplied && customType.trim() && (
              <button
                type="button"
                aria-pressed={true}
                className={wizChipBase}
                style={wizChipOn}
                onClick={() => {
                  setTypeCustomApplied(false);
                  setCustomType("");
                }}
              >
                ✓ {customType.trim()}
              </button>
            )}
            <button
              type="button"
              aria-pressed={typeOtherOpen}
              className={wizChipBase}
              style={wizChipOff}
              onClick={() => setTypeOtherOpen((v) => !v)}
            >
              Other…
            </button>
          </div>
          {typeOtherOpen && (
            <div className="mt-3 flex flex-wrap gap-2">
              <input
                value={typeOtherDraft}
                onChange={(e) => setTypeOtherDraft(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") {
                    e.preventDefault();
                    applyTypeOther();
                  }
                }}
                placeholder="Type your own business type…"
                aria-label="Your own business type"
                className="min-w-0 flex-1 rounded-xl border px-3 py-2 text-base"
                style={{
                  borderColor: "var(--border)",
                  backgroundColor: "var(--surface)",
                }}
                autoComplete="off"
                autoFocus
              />
              <button
                type="button"
                className="rounded-full px-4 py-2 text-sm font-bold"
                style={{
                  backgroundColor: "var(--accent)",
                  color: "var(--accent-text)",
                }}
                onClick={applyTypeOther}
              >
                Use this
              </button>
              <button
                type="button"
                className="rounded-full px-3 py-2 text-sm font-bold text-[var(--dim)]"
                onClick={() => {
                  setTypeOtherOpen(false);
                  setTypeOtherDraft("");
                }}
              >
                Cancel
              </button>
            </div>
          )}
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
            Everyone who counts, receives or orders stock — team size
            shapes how rounds and requisitions are set up.
          </p>
          <div className="mt-3 flex flex-wrap gap-2">
            {TEAM_SIZE_BANDS.map((band) => {
              const selected = teamSize === band;
              return (
                <button
                  key={band}
                  type="button"
                  aria-pressed={selected}
                  className={wizChipBase}
                  style={selected ? wizChipOn : wizChipOff}
                  onClick={() => setTeamSize(band)}
                >
                  {selected ? `✓ ${band}` : band}
                </button>
              );
            })}
            {teamSize && !TEAM_SIZE_BANDS.includes(teamSize) && (
              <button
                type="button"
                aria-pressed={true}
                className={wizChipBase}
                style={wizChipOn}
                onClick={() => setTeamSize("")}
              >
                ✓ {teamSize}
              </button>
            )}
            <button
              type="button"
              aria-pressed={teamOtherOpen}
              className={wizChipBase}
              style={wizChipOff}
              onClick={() => setTeamOtherOpen((v) => !v)}
            >
              Other…
            </button>
          </div>
          {teamOtherOpen && (
            <div className="mt-3 flex flex-wrap gap-2">
              <input
                value={teamOtherDraft}
                onChange={(e) => setTeamOtherDraft(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") {
                    e.preventDefault();
                    applyTeamOther();
                  }
                }}
                placeholder="Type your own team size…"
                aria-label="Your own team size"
                className="min-w-0 flex-1 rounded-xl border px-3 py-2 text-base"
                style={{
                  borderColor: "var(--border)",
                  backgroundColor: "var(--surface)",
                }}
                autoComplete="off"
                autoFocus
              />
              <button
                type="button"
                className="rounded-full px-4 py-2 text-sm font-bold"
                style={{
                  backgroundColor: "var(--accent)",
                  color: "var(--accent-text)",
                }}
                onClick={applyTeamOther}
              >
                Use this
              </button>
              <button
                type="button"
                className="rounded-full px-3 py-2 text-sm font-bold text-[var(--dim)]"
                onClick={() => {
                  setTeamOtherOpen(false);
                  setTeamOtherDraft("");
                }}
              >
                Cancel
              </button>
            </div>
          )}
        </div>
      )}

      {step === 4 && (
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
                  className="rounded-full border-2 px-4 py-2 text-sm font-bold"
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
                  {selected ? `✓ ${g}` : g}
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
                  className="rounded-full border-2 px-4 py-2 text-sm font-bold"
                  style={{
                    backgroundColor: "var(--accent)",
                    color: "var(--accent-text)",
                    borderColor: "var(--accent)",
                  }}
                >
                  ✓ {g} ✕
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

      {step === 5 && (
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

      {step === 6 && (
        <div className="mt-4 flex flex-col gap-2">
          {[
            [
              "Business type",
              bizType === "Other" && customType
                ? `Other — ${customType}`
                : bizType,
            ],
            ["Business name", name.trim() || pack.defaultName],
            ["Team size", teamSize.trim() || "Not specified"],
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
            [
              "Orders by requisition",
              usesRequisition
                ? "Yes — the Requisition tab with preparer / approver sign-off"
                : "No — the Order Email tab",
            ],
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
          <label
            className="flex items-start gap-2 rounded-xl border px-3 py-2 text-sm font-semibold"
            style={{
              borderColor: "var(--border)",
              backgroundColor: "var(--surface)",
            }}
          >
            <input
              type="checkbox"
              checked={usesRequisition}
              onChange={(e) => setUsesRequisition(e.target.checked)}
              className="mt-0.5"
              aria-label="Order by requisition"
            />
            <span>
              Order by requisition — this business orders stock on a
              requisition form, signed by a preparer and approved by
              a different approver, instead of the Order Email tab.
            </span>
          </label>
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
          {finishError && (
            <p role="alert" className="text-sm font-semibold text-[var(--red)]">
              {finishError}
            </p>
          )}
        </div>
      )}

      {/* The preview box sits under the questions on every step but
          Review — the Review summary takes its place there. */}
      {step < 6 && (
        <BitSetupPreview
          rows={[
            ["Business type", typeDisplay],
            ["Business name", name],
            ["Team size", teamSize],
            ["Categories", groups.join(", ")],
          ]}
        />
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
        {step < 6 ? (
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
            {step === 5 && (
              <button
                type="button"
                className="rounded-full px-4 py-2 text-sm font-bold text-[var(--dim)]"
                onClick={() => setStep(6)}
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

// ---- Par editor (Alpha 0.79) -----------------------------------------
// The one par (threshold) editor, shared by the Inventory Checks
// Finish summary and the Inventory tab: a number field prefilled
// with the item's current par, saved through setBitItemPar. When
// a counted value is passed (the Finish summary), a one-tap
// "Par = counted" shortcut sets par to that count. Par is a whole
// number ≥ 0; 0 means no threshold set.

function ParEditor({
  itemId,
  itemName,
  par,
  countedValue,
  shortcutLabel = "Par = counted",
}: {
  itemId: number;
  itemName: string;
  par: number;
  countedValue?: number;
  shortcutLabel?: string;
}) {
  const queryClient = useQueryClient();
  const [text, setText] = useState(String(par));
  const [dirty, setDirty] = useState(false);
  const [saved, setSaved] = useState(false);

  // Keep the field in step with the stored par (e.g. after a
  // save refetches) — but never overwrite what the user is typing.
  useEffect(() => {
    if (!dirty) setText(String(par));
  }, [par, dirty]);

  const save = useMutation({
    mutationFn: async (value: number) =>
      await api.setBitItemPar({ itemId, par: value }),
    onSuccess: () => {
      setDirty(false);
      setSaved(true);
      void queryClient.invalidateQueries({ queryKey: ["bit"] });
      void queryClient.invalidateQueries({ queryKey: ["bit-trends"] });
    },
  });

  const parsed = Math.floor(Number(text));
  const valid =
    text.trim() !== "" && Number.isFinite(parsed) && parsed >= 0;
  const shortcutPar =
    countedValue != null ? Math.max(0, Math.ceil(countedValue)) : null;

  return (
    <span className="inline-flex flex-wrap items-center gap-1.5">
      <label
        className="text-xs font-semibold text-[var(--dim)]"
        htmlFor={`par-input-${itemId}`}
      >
        Par
      </label>
      <input
        id={`par-input-${itemId}`}
        type="number"
        min={0}
        step={1}
        inputMode="numeric"
        aria-label={`Par level for ${itemName}`}
        value={text}
        onChange={(e) => {
          setText(e.target.value);
          setDirty(true);
          setSaved(false);
        }}
        className="w-16 rounded-lg border px-2 py-1 text-center text-sm font-bold"
        style={{
          borderColor: "var(--border)",
          backgroundColor: "var(--surface)",
        }}
      />
      <button
        type="button"
        className="rounded-full px-3 py-1 text-xs font-bold"
        style={{
          backgroundColor: "var(--accent)",
          color: "var(--accent-text)",
          opacity: !dirty || !valid || save.isPending ? 0.5 : 1,
        }}
        disabled={!dirty || !valid || save.isPending}
        onClick={() => save.mutate(parsed)}
      >
        {save.isPending ? "Saving…" : "Save par"}
      </button>
      {shortcutPar != null && (
        <button
          type="button"
          className="rounded-full px-3 py-1 text-xs font-bold"
          style={{ backgroundColor: "var(--surface-alt)" }}
          disabled={save.isPending}
          onClick={() => {
            setText(String(shortcutPar));
            save.mutate(shortcutPar);
          }}
        >
          {shortcutLabel} ({fmtCount(countedValue ?? 0)})
        </button>
      )}
      {saved && !dirty && (
        <span
          className="text-xs font-bold"
          style={{ color: "var(--ok-text)" }}
        >
          Saved ✓
        </span>
      )}
      {save.isError && (
        <span className="text-xs font-bold text-[var(--red)]">
          Didn't save — try again.
        </span>
      )}
    </span>
  );
}

// ---- Variance follow-through (Alpha 0.82) ----------------------------
// On the Finish summary, every variance gets a one-tap reason
// picker (Used / Damaged / Expired / Missing / Counting error)
// that writes straight onto the item's snapshot for the round —
// prompted, never blocking. A large variance (|counted − book|
// ≥ 5 units or ≥ 25% of book) also offers the one blind recount
// allowed per item per round: the book value and the first count
// stay hidden while recounting, and submitting replaces the
// counted value everywhere the round recorded it. Alpha 0.83:
// "hidden" is enforced across the whole summary — while a recount
// is open, the parent masks that item's figures in its variance
// header and in the counted-items list (including the ParEditor's
// "Par = counted" shortcut label, which prints the counted value).

const VARIANCE_REASONS = [
  "Used",
  "Damaged",
  "Expired",
  "Missing",
  "Counting error",
] as const;

function isLargeVariance(book: number, counted: number): boolean {
  const diff = Math.abs(counted - book);
  return diff >= 5 || (book > 0 && diff >= book * 0.25);
}

type SummaryCountedItem = RoundSummary["countedItems"][number];

function VarianceFollowUp({
  item,
  fractional,
  recountOpen,
  onRecountOpenChange,
  onReasonSaved,
  onRecounted,
}: {
  item: SummaryCountedItem;
  fractional: boolean;
  // The open/closed state lives in the summary's parent (Alpha
  // 0.83): while a recount is open, the parent masks this item's
  // book and first counted values everywhere else on the summary
  // — the variance header and the counted-items list — so the
  // recount is genuinely blind.
  recountOpen: boolean;
  onRecountOpenChange: (open: boolean) => void;
  onReasonSaved: (reason: string | null) => void;
  onRecounted: (
    newCounted: number,
    variances: RoundSummary["variances"],
    belowPar: RoundSummary["belowPar"],
  ) => void;
}) {
  const queryClient = useQueryClient();
  const [recountText, setRecountText] = useState("");
  const [recountError, setRecountError] = useState<string | null>(null);

  const saveReason = useMutation({
    mutationFn: async (reason: string | null) =>
      await api.setBitVarianceReason({
        snapshotId: item.snapshotId,
        reason: reason as
          | "Used"
          | "Damaged"
          | "Expired"
          | "Missing"
          | "Counting error"
          | null,
      }),
    onSuccess: (res, reason) => {
      if (res.ok) {
        onReasonSaved(reason);
        void queryClient.invalidateQueries({ queryKey: ["bit-trends"] });
      }
    },
  });

  const submitRecount = useMutation({
    mutationFn: async (counted: number) =>
      await api.recountBitItem({ snapshotId: item.snapshotId, counted }),
    onSuccess: (res) => {
      if (!res.ok || res.counted == null) {
        setRecountError(res.error ?? "The recount didn't save.");
        return;
      }
      onRecountOpenChange(false);
      setRecountText("");
      setRecountError(null);
      onRecounted(res.counted, res.variances, res.belowPar);
      void queryClient.invalidateQueries({ queryKey: ["bit"] });
      void queryClient.invalidateQueries({ queryKey: ["bit-trends"] });
    },
    onError: () => setRecountError("The recount didn't save. Try again."),
  });

  const recountValue = Number(recountText);
  const recountValid =
    recountText.trim() !== "" &&
    Number.isFinite(recountValue) &&
    recountValue >= 0;
  const large = isLargeVariance(item.book, item.counted);

  return (
    <div className="mt-1 flex flex-col gap-1.5">
      <div
        className="flex flex-wrap items-center gap-1"
        role="group"
        aria-label={`Reason for the ${item.name} variance`}
      >
        <span className="text-xs font-semibold text-[var(--dim)]">
          Why?
        </span>
        {VARIANCE_REASONS.map((r) => {
          const selected = item.varianceReason === r;
          return (
            <button
              key={r}
              type="button"
              aria-pressed={selected}
              disabled={saveReason.isPending}
              onClick={() => saveReason.mutate(selected ? null : r)}
              className="rounded-full border px-2.5 py-1 text-xs font-bold"
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
              {r}
            </button>
          );
        })}
        {saveReason.isPending && (
          <span className="text-xs text-[var(--dim)]">Saving…</span>
        )}
        {saveReason.isError && (
          <span className="text-xs font-bold text-[var(--red)]">
            Didn't save — try again.
          </span>
        )}
      </div>
      {item.recounted ? (
        <p className="text-xs font-semibold text-[var(--dim)]">
          Recounted ✓ — the recount is this item's count for the check.
        </p>
      ) : (
        large &&
        !recountOpen && (
          <div>
            <button
              type="button"
              onClick={() => {
                onRecountOpenChange(true);
                setRecountError(null);
              }}
              className="rounded-full px-3 py-1 text-xs font-bold"
              style={{
                backgroundColor: "var(--amber-soft)",
                color: "var(--amber)",
              }}
            >
              ⚠ Big difference — recount {item.name}
            </button>
          </div>
        )
      )}
      {recountOpen && !item.recounted && (
        <div
          className="rounded-lg border p-2"
          style={{
            borderColor: "var(--amber)",
            backgroundColor: "var(--surface)",
          }}
        >
          <label
            className="flex flex-col gap-1 text-xs font-semibold text-[var(--dim)]"
            htmlFor={`recount-input-${item.snapshotId}`}
          >
            Blind recount — count {item.name} again and enter it here.
            The book count and your first count stay hidden; one
            recount per item per check.
            <span className="flex items-center gap-2">
              <input
                id={`recount-input-${item.snapshotId}`}
                type="number"
                min={0}
                step={fractional ? 0.1 : 1}
                inputMode="decimal"
                aria-label={`Blind recount for ${item.name}`}
                value={recountText}
                onChange={(e) => setRecountText(e.target.value)}
                className="w-24 rounded-lg border px-2 py-1.5 text-center text-sm font-bold text-[var(--text)]"
                style={{
                  borderColor: "var(--border)",
                  backgroundColor: "var(--surface)",
                }}
              />
              <button
                type="button"
                className="rounded-full px-3 py-1.5 text-xs font-bold"
                style={{
                  backgroundColor: "var(--accent)",
                  color: "var(--accent-text)",
                  opacity:
                    !recountValid || submitRecount.isPending ? 0.5 : 1,
                }}
                disabled={!recountValid || submitRecount.isPending}
                onClick={() => submitRecount.mutate(recountValue)}
              >
                {submitRecount.isPending ? "Saving…" : "Save recount"}
              </button>
              <button
                type="button"
                className="rounded-full px-3 py-1.5 text-xs font-bold"
                style={{ backgroundColor: "var(--surface-alt)" }}
                onClick={() => onRecountOpenChange(false)}
              >
                Cancel
              </button>
            </span>
          </label>
          {recountError && (
            <p role="alert" className="mt-1 text-xs font-bold text-[var(--red)]">
              {recountError}
            </p>
          )}
        </div>
      )}
    </div>
  );
}

// ---- Trends view (Alpha 0.79) -----------------------------------------
// Reached from the Inventory Checks tab. Everything shown comes
// from getBitTrends: the per-item snapshots finishBitRound has
// written since Alpha 0.79 plus the stock events logged outside
// checks. Until the first check is finished there is no history,
// and the view says so honestly — nothing is backfilled.

type BitTrends = ApiResponse<typeof api, "getBitTrends">;

function TrendsView({
  business,
  onBack,
}: {
  business: BitBusiness;
  onBack: () => void;
}) {
  const trends = useQuery({
    queryKey: ["bit-trends", business.id],
    queryFn: async () =>
      await api.getBitTrends({ businessId: business.id }),
  });
  const data: BitTrends | undefined = trends.data;
  const withUsage = (data?.items ?? []).filter((i) => i.intervals > 0);
  const suggestions = (data?.items ?? []).filter(
    (i) => i.suggestedPar != null && i.suggestedPar !== i.currentPar,
  );
  // Running low watchlist (Alpha 0.84): every item getBitTrends
  // could honestly forecast, soonest run-out first.
  const runningLow = (data?.items ?? [])
    .flatMap((i) => (i.forecast ? [{ name: i.name, ...i.forecast }] : []))
    .sort((a, b) => a.daysOfCover - b.daysOfCover);

  return (
    <div className="flex flex-col gap-2 pt-2">
      <div className="flex items-center justify-between gap-2">
        <h3 className="text-lg font-bold">Trends</h3>
        <button
          type="button"
          onClick={onBack}
          className="shrink-0 rounded-full px-3 py-1.5 text-xs font-bold"
          style={{
            backgroundColor: "var(--surface-alt)",
            color: "var(--text)",
          }}
        >
          ← Back to checks
        </button>
      </div>

      {trends.isPending && (
        <p className="py-4 text-center text-sm text-[var(--dim)]">
          Loading trends…
        </p>
      )}
      {trends.isError && (
        <p role="alert" className="text-sm font-semibold text-[var(--red)]">
          Trends couldn't load. Please try again.
        </p>
      )}
      {data && !data.hasHistory && (
        <div
          className="rounded-xl border p-4 text-center"
          style={{
            borderColor: "var(--border)",
            backgroundColor: "var(--surface)",
          }}
        >
          <p className="text-base font-bold">No count history yet</p>
          <p className="mt-1 text-sm text-[var(--dim)]">
            Trends build from your finished inventory checks — finish
            a check and counts over time, usage between checks, and
            running-low forecasts start appearing here.
          </p>
        </div>
      )}

      {data && data.hasHistory && (
        <>
          {(runningLow.length > 0 || data.notEnoughHistory > 0) && (
            <section
              aria-label="Running low"
              className="rounded-xl border p-3"
              style={{
                borderColor: "var(--border)",
                backgroundColor: "var(--surface)",
              }}
            >
              <h4 className="text-base font-bold">Running low</h4>
              <p className="text-xs text-[var(--dim)]">
                Stockout forecasts from your count history: on-hand ÷
                average daily usage between checks.
              </p>
              {runningLow.length > 0 && (
                <ul className="mt-1 flex flex-col gap-1 text-sm">
                  {runningLow.map((r) => (
                    <li
                      key={r.name}
                      className="flex items-baseline justify-between gap-2"
                    >
                      <span className="min-w-0">{r.name}</span>
                      <span className="shrink-0 text-right">
                        <span className="font-semibold">
                          {r.daysOfCover.toFixed(1)} days of cover
                        </span>
                        <span className="block text-xs font-normal text-[var(--dim)]">
                          {fmtCount(r.onHand)} on hand ·{" "}
                          {fmtCount(r.avgDailyUsage)}/day · runs out{" "}
                          {formatExpiryDate(r.runOutDate)}
                        </span>
                      </span>
                    </li>
                  ))}
                </ul>
              )}
              {data.notEnoughHistory > 0 && (
                <p className="mt-1 text-xs text-[var(--dim)]">
                  {data.notEnoughHistory} item
                  {data.notEnoughHistory === 1
                    ? " doesn't"
                    : "s don't"}{" "}
                  have enough count history yet to forecast.
                </p>
              )}
            </section>
          )}

          <section
            aria-label="Counts over time"
            className="rounded-xl border p-3"
            style={{
              borderColor: "var(--border)",
              backgroundColor: "var(--surface)",
            }}
          >
            <h4 className="text-base font-bold">Counts over time</h4>
            <div className="mt-1 flex flex-col">
              {data.items.map((it) => (
                <div
                  key={it.name}
                  className="border-b py-2 last:border-b-0"
                  style={{ borderColor: "var(--border)" }}
                >
                  <p className="text-sm font-semibold">
                    {it.name}
                    <span className="font-normal text-[var(--dim)]">
                      {" "}
                      · {it.category} · par {it.currentPar}
                    </span>
                  </p>
                  <p className="text-xs text-[var(--dim)]">
                    {it.checks
                      .map(
                        (c) =>
                          `${roundDate(c.at)}: ${fmtCount(c.counted)}`,
                      )
                      .join(" · ")}
                  </p>
                  <p className="text-xs text-[var(--dim)]">
                    {it.varianceCount > 0
                      ? `Varied from book in ${it.varianceCount} of ${it.checks.length} check${it.checks.length === 1 ? "" : "s"}`
                      : "Matched book every check"}
                    {it.belowParCount > 0
                      ? ` · at or below par in ${it.belowParCount} check${it.belowParCount === 1 ? "" : "s"}`
                      : ""}
                  </p>
                </div>
              ))}
            </div>
          </section>

          {withUsage.length > 0 && (
            <section
              aria-label="Usage between checks"
              className="rounded-xl border p-3"
              style={{
                borderColor: "var(--border)",
                backgroundColor: "var(--surface)",
              }}
            >
              <h4 className="text-base font-bold">Usage between checks</h4>
              <p className="text-xs text-[var(--dim)]">
                Previous count + stock received − next count, from the
                checks and receipts on record.
              </p>
              <ul className="mt-1 flex flex-col gap-0.5 text-sm">
                {withUsage.map((it) => (
                  <li key={it.name} className="flex justify-between gap-2">
                    <span className="min-w-0">{it.name}</span>
                    <span className="shrink-0 font-semibold">
                      {fmtCount(it.usageTotal)} used over {it.intervals}{" "}
                      interval{it.intervals === 1 ? "" : "s"}
                    </span>
                  </li>
                ))}
              </ul>
            </section>
          )}

          {data.repeatVariances.length > 0 && (
            <section
              aria-label="Repeated variances"
              className="rounded-xl border p-3"
              style={{
                borderColor: "var(--border)",
                backgroundColor: "var(--surface)",
              }}
            >
              <h4 className="text-base font-bold">Repeated variances</h4>
              <ul className="mt-1 flex flex-col gap-0.5 text-sm">
                {data.repeatVariances.map((r) => (
                  <li key={r.name}>
                    <div className="flex justify-between gap-2">
                      <span className="min-w-0">{r.name}</span>
                      <span className="shrink-0 font-semibold">
                        differed from book {r.varianceCount} times
                      </span>
                    </div>
                    {r.reasons.length > 0 && (
                      <p className="text-xs text-[var(--dim)]">
                        Reasons recorded:{" "}
                        {r.reasons
                          .map(
                            (x) =>
                              `${x.reason}${x.count > 1 ? ` ×${x.count}` : ""}`,
                          )
                          .join(", ")}
                      </p>
                    )}
                  </li>
                ))}
              </ul>
            </section>
          )}

          {data.mostBelowPar.length > 0 && (
            <section
              aria-label="Most often at or below par"
              className="rounded-xl border p-3"
              style={{
                borderColor: "var(--border)",
                backgroundColor: "var(--surface)",
              }}
            >
              <h4 className="text-base font-bold">
                Most often at or below par
              </h4>
              <ul className="mt-1 flex flex-col gap-0.5 text-sm">
                {data.mostBelowPar.map((r) => (
                  <li key={r.name} className="flex justify-between gap-2">
                    <span className="min-w-0">{r.name}</span>
                    <span className="shrink-0 font-semibold">
                      at/below par in {r.belowParCount} check
                      {r.belowParCount === 1 ? "" : "s"}
                    </span>
                  </li>
                ))}
              </ul>
            </section>
          )}

          {suggestions.length > 0 && (
            <section
              aria-label="Par suggestions"
              className="rounded-xl border p-3"
              style={{
                borderColor: "var(--amber)",
                backgroundColor: "var(--surface)",
              }}
            >
              <h4 className="text-base font-bold">
                Par suggestions — suggestions only
              </h4>
              <p className="text-xs text-[var(--dim)]">
                Based on the heaviest usage seen between two checks.
                Nothing is changed automatically — set a par from a
                check's Finish summary or the Inventory tab when a
                suggestion looks right.
              </p>
              <ul className="mt-1 flex flex-col gap-0.5 text-sm">
                {suggestions.map((it) => (
                  <li key={it.name} className="flex justify-between gap-2">
                    <span className="min-w-0">{it.name}</span>
                    <span className="shrink-0 font-semibold">
                      suggested par {it.suggestedPar} (currently{" "}
                      {it.currentPar})
                    </span>
                  </li>
                ))}
              </ul>
            </section>
          )}
        </>
      )}
    </div>
  );
}

// ---- Inventory Checks tab (formerly Rounds) --------------------------

function RoundsTab({
  business,
  items,
  rounds,
  resubmittedLines,
  draftExtras,
}: {
  business: BitBusiness;
  items: BitItem[];
  rounds: BitState["rounds"];
  resubmittedLines: BitState["resubmittedLines"];
  draftExtras: BitState["draftExtras"];
}) {
  const queryClient = useQueryClient();
  const [counterName, setCounterName] = useState("");
  // A requisition business counts by shift, not by name
  // (Alpha 0.80): the round's counter identity is the shift
  // letter, defaulting to A. Other businesses keep the name field.
  const usesRequisition = business.usesRequisition;
  const [shift, setShift] = useState("A");
  const [summaryShift, setSummaryShift] = useState<string | null>(null);
  const counterMissing = !usesRequisition && counterName.trim() === "";
  const [groupFilter, setGroupFilter] = useState("");
  const [counts, setCounts] = useState<Record<number, number>>({});
  const [editing, setEditing] = useState<{ id: number; text: string } | null>(
    null,
  );
  const [remainingOnly, setRemainingOnly] = useState(false);
  // Item search for the open check: a full-width bar under the
  // Shift / Category row, above the "Counted …" row. It narrows
  // the visible items (same word-based matching as the Items tab
  // search) without touching the check's scope or counts.
  const [search, setSearch] = useState("");
  // Voice search for the bar above: the microphone button at the
  // right end of the search row dictates into the search text via
  // the browser's speech recognition, where the device offers it.
  // Listening state + a short note line for "not available here"
  // and recognition errors; the recognition object itself lives in
  // a ref so re-renders never restart it.
  const [listening, setListening] = useState(false);
  const [voiceNote, setVoiceNote] = useState<string | null>(null);
  // Microphone pop-up (the activation sequence): tapping the
  // mic button first checks whether the microphone is allowed
  // for this site/app, reading the kept-current permission
  // state (micPermRef below). Allowed → voice search starts,
  // synchronously in the tap. Not allowed → this pop-up opens:
  // it says the microphone hasn't been activated yet and shows
  // how to switch it on in the browser (the website) and in
  // the phone's app settings (the app). When the user confirms
  // they've activated it, checkMicAllowed runs again; if the
  // mic is allowed now, the pop-up closes and voice search
  // starts.
  const [micBlockedOpen, setMicBlockedOpen] = useState(false);
  const [unblockChecking, setUnblockChecking] = useState(false);
  // Feedback for a confirmation check that still finds the mic
  // off: without it a failed check changed nothing on screen
  // (the pop-up was already showing the steps) and read as a
  // dead button. Set on every failed check while the pop-up is
  // open; cleared when the pop-up (re)opens or a check passes.
  const [unblockNote, setUnblockNote] = useState<string | null>(null);
  const unblockBusyRef = useRef(false);
  const recognitionRef = useRef<{
    stop: () => void;
  } | null>(null);
  useEffect(
    () => () => {
      recognitionRef.current?.stop();
      recognitionRef.current = null;
    },
    [],
  );
  // The last known microphone permission state, kept current for
  // the life of this tab: queried on mount, updated whenever the
  // browser reports a change, and set outright by a passed
  // activation check below. The mic button reads it to decide —
  // synchronously, inside the tap — whether voice search can
  // start right away or the activation pop-up has to open.
  // Starting the recognizer has to happen inside the tap handler
  // itself: browsers that gate speech recognition on a fresh
  // user gesture (Safari especially) drop the gesture across an
  // awaited permission query, and the recognizer then never
  // starts even though the microphone is allowed — the sequence
  // completes, but the button reads as dead. "unknown" means no
  // check has answered yet, or this browser has no Permissions
  // API for the microphone.
  const micPermRef = useRef<"granted" | "denied" | "prompt" | "unknown">(
    "unknown",
  );
  useEffect(() => {
    let status: PermissionStatus | null = null;
    let cancelled = false;
    const update = () => {
      if (!status) return;
      micPermRef.current =
        status.state === "granted"
          ? "granted"
          : status.state === "denied"
            ? "denied"
            : "prompt";
    };
    navigator.permissions
      ?.query({ name: "microphone" as PermissionName })
      .then((s) => {
        if (cancelled) return;
        status = s;
        update();
        s.addEventListener("change", update);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
      status?.removeEventListener("change", update);
    };
  }, []);
  // Stop voice search and clear the listening state right away,
  // without waiting for the recognizer's end event: some
  // browsers fire an error (or a stop) without an end, and a
  // stuck "listening" flag turns the next tap into a no-op stop
  // instead of a fresh start.
  function stopRecognition() {
    const rec = recognitionRef.current;
    recognitionRef.current = null;
    if (rec) {
      try {
        rec.stop();
      } catch {
        // Already stopped — nothing to do.
      }
    }
    setListening(false);
  }
  function startRecognition() {
    const w = window as unknown as {
      SpeechRecognition?: new () => {
        lang: string;
        interimResults: boolean;
        onresult: ((e: unknown) => void) | null;
        onerror: ((e: unknown) => void) | null;
        onend: (() => void) | null;
        start: () => void;
        stop: () => void;
      };
      webkitSpeechRecognition?: new () => {
        lang: string;
        interimResults: boolean;
        onresult: ((e: unknown) => void) | null;
        onerror: ((e: unknown) => void) | null;
        onend: (() => void) | null;
        start: () => void;
        stop: () => void;
      };
    };
    const Ctor = w.SpeechRecognition ?? w.webkitSpeechRecognition;
    if (!Ctor) {
      setVoiceNote(
        "Voice search isn't available in this browser — type to search instead.",
      );
      return;
    }
    setVoiceNote(null);
    // Clear out any earlier session that never reported its end
    // (some webviews drop the end event): a stale recognizer left
    // in the ref makes the fresh start below throw or no-op, and
    // the button reads as dead.
    if (recognitionRef.current) {
      try {
        recognitionRef.current.stop();
      } catch {
        // Already stopped — nothing to do.
      }
      recognitionRef.current = null;
    }
    const rec = new Ctor();
    rec.lang = "en-CA";
    rec.interimResults = false;
    rec.onresult = (e: unknown) => {
      const ev = e as {
        results: ArrayLike<ArrayLike<{ transcript: string }>>;
      };
      const first = ev.results[0]?.[0];
      if (first?.transcript) setSearch(first.transcript.trim());
    };
    rec.onerror = (e: unknown) => {
      const code = (e as { error?: string }).error;
      // Clear the listening state here, not only in onend: some
      // browsers fire the error without an end event, and a stuck
      // "listening" flag turns the next tap into a no-op stop
      // instead of a fresh start.
      setListening(false);
      if (code === "not-allowed") {
        // The microphone itself isn't allowed: the activation
        // pop-up takes over from the old one-line note.
        setVoiceNote(null);
        setUnblockNote(null);
        setMicBlockedOpen(true);
      } else if (code === "service-not-allowed") {
        // The browser refused the speech-recognition service
        // itself, which is a different problem from the
        // microphone permission. If the mic is in fact allowed,
        // this view can't run voice recognition at all (common
        // inside an embedded app panel) — say so plainly instead
        // of looping back into the activation pop-up, whose
        // steps can't fix it. If the mic isn't allowed, the
        // pop-up is the right next step after all.
        void checkMicAllowed().then((allowed) => {
          if (allowed === true) {
            micPermRef.current = "granted";
            setVoiceNote(
              "Voice recognition isn't available in this view, even though the microphone is allowed. Open the app in a full browser tab to use voice search — typing works here.",
            );
          } else {
            setVoiceNote(null);
            setUnblockNote(null);
            setMicBlockedOpen(true);
          }
        });
      } else if (code === "audio-capture") {
        setVoiceNote(
          "No microphone could be reached — check the device microphone and try again.",
        );
      } else if (code === "aborted") {
        // The session was ended on purpose (a stop tap): not an
        // error, so no note.
        setVoiceNote(null);
      } else {
        setVoiceNote(
          "Voice search didn't catch that — try again or type instead.",
        );
      }
    };
    rec.onend = () => {
      recognitionRef.current = null;
      setListening(false);
    };
    recognitionRef.current = rec;
    try {
      rec.start();
      setListening(true);
    } catch {
      recognitionRef.current = null;
      setVoiceNote("Voice search couldn't start — type to search instead.");
    }
  }
  // The one microphone check, run by the pop-up's confirm
  // button (and by the recognizer's service-refusal branch):
  // read the saved microphone permission for this site/app.
  // "granted" means activated; "denied" and "prompt" both mean
  // it hasn't been activated yet. Returns null where the
  // browser offers no Permissions API — there the recognition
  // attempt itself is the check (it prompts, or reports the
  // block through its error handler). The mic button itself
  // doesn't await this: it reads the kept-current state in
  // micPermRef, which this same query feeds on mount and on
  // every permission change.
  async function checkMicAllowed(): Promise<boolean | null> {
    try {
      const status = await navigator.permissions?.query({
        name: "microphone" as PermissionName,
      });
      if (!status) return null;
      return status.state === "granted";
    } catch {
      return null;
    }
  }
  function toggleVoiceSearch() {
    if (listening) {
      stopRecognition();
      return;
    }
    // Step 1 of the sequence: is the microphone allowed? The
    // answer comes from the permission state this tab keeps
    // current (micPermRef — checked on mount, on every browser
    // permission change, and by the pop-up's confirm check), so
    // the decision, and the recognition start when allowed,
    // happen synchronously inside this tap. The previous flow
    // awaited a fresh permission query between the tap and the
    // start; on gesture-gated browsers (Safari especially) the
    // tap's activation doesn't survive that await, so the
    // recognizer never started even with the microphone
    // allowed — the sequence completed and the button did
    // nothing.
    const perm = micPermRef.current;
    if (perm === "granted" || perm === "unknown") {
      // Allowed — we're good: start voice search. "unknown"
      // covers browsers with no Permissions API for the
      // microphone (and the first instant before the mount
      // check answers): there the recognition attempt itself
      // is the check — it prompts, or reports the block
      // through its error handler, which opens the pop-up.
      startRecognition();
      return;
    }
    // "denied" or "prompt": the microphone hasn't been
    // activated yet — cue the pop-up with the activation steps
    // instead of starting a recognition attempt that can only
    // fail the same way.
    setUnblockNote(null);
    setMicBlockedOpen(true);
  }
  // The pop-up's confirm button ("I've activated it — check
  // again"): the user says they've switched the microphone on,
  // so run the same check as the initial one again. If the mic
  // is allowed now, close the pop-up and start voice search.
  // The saved permission can lag behind a change made in the
  // phone's Settings app, so a "not yet" answer to an explicit
  // confirm gets one live probe — asking the browser for the
  // microphone itself (which also surfaces the browser's own
  // Allow prompt where one is pending) — before the pop-up
  // reports back. The probe is raced against a timeout: in
  // some embedded browsers it neither resolves nor rejects,
  // which would leave the button stuck on "Checking…" forever.
  // The quiet variant (the pop-up's automatic re-check when
  // the user returns to the page) runs only the permission
  // check — no probe, so returning never springs a prompt —
  // and stays silent when the mic is still off.
  async function confirmMicActivated(opts?: { quiet?: boolean }) {
    if (unblockBusyRef.current) return;
    unblockBusyRef.current = true;
    setUnblockChecking(true);
    let granted = (await checkMicAllowed()) === true;
    let noAnswer = false;
    if (!granted && !opts?.quiet) {
      try {
        const md = navigator.mediaDevices;
        if (md?.getUserMedia) {
          let timedOut = false;
          const request = md.getUserMedia({ audio: true });
          // If the request only answers after the timeout below,
          // stop its tracks so the microphone isn't left running.
          request.then(
            (s) => {
              if (timedOut) s.getTracks().forEach((t) => t.stop());
            },
            () => {},
          );
          const stream = await Promise.race([
            request.catch(() => null),
            new Promise<null>((resolve) =>
              setTimeout(() => {
                timedOut = true;
                resolve(null);
              }, 10000),
            ),
          ]);
          if (stream) {
            stream.getTracks().forEach((t) => t.stop());
            granted = true;
          } else if (timedOut) {
            noAnswer = true;
          }
        }
      } catch {
        granted = false;
      }
    }
    unblockBusyRef.current = false;
    setUnblockChecking(false);
    if (granted) {
      // Record the pass in the kept-current state, so the mic
      // button's next tap starts recognition synchronously
      // instead of re-checking.
      micPermRef.current = "granted";
      setUnblockNote(null);
      setMicBlockedOpen(false);
      startRecognition();
    } else if (!opts?.quiet) {
      setUnblockNote(
        noAnswer
          ? "The browser didn't answer the microphone request. If this app is open inside another app's panel, open it in a full browser tab instead, then tap the button again."
          : "Still not activated — checked just now. Work through the steps above once more, then tap the button again. If you set Microphone to Allow and it still says this, tap Reload the app below: browsers often apply a changed setting only to a freshly loaded page.",
      );
    }
  }
  const confirmMicRef = useRef(confirmMicActivated);
  useEffect(() => {
    confirmMicRef.current = confirmMicActivated;
  });
  // While the pop-up is open, re-run the same check quietly on
  // its own when the user returns to the page (e.g. back from
  // the browser's or phone's settings) or when the browser
  // reports the microphone permission changed — if the mic is
  // allowed now, the pop-up closes and voice search starts
  // without another tap.
  useEffect(() => {
    if (!micBlockedOpen) return;
    const recheck = () => {
      if (document.visibilityState === "visible") {
        void confirmMicRef.current({ quiet: true });
      }
    };
    document.addEventListener("visibilitychange", recheck);
    let permStatus: PermissionStatus | null = null;
    let cancelled = false;
    navigator.permissions
      ?.query({ name: "microphone" as PermissionName })
      .then((s) => {
        if (cancelled) return;
        permStatus = s;
        s.addEventListener("change", recheck);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
      document.removeEventListener("visibilitychange", recheck);
      permStatus?.removeEventListener("change", recheck);
    };
  }, [micBlockedOpen]);
  const [temps, setTemps] = useState<Record<string, string>>({});
  const [summary, setSummary] = useState<RoundSummary | null>(null);
  // Requisition review pop-up (the submission flow): for a requisition
  // requisition business, the moment a check finishes, the draft
  // it produced (everything now at or below par) opens as the
  // filled requisition form for review; approving saves the form and
  // records the requisition as sent.
  const [reviewLines, setReviewLines] = useState<ReqBuildLine[] | null>(
    null,
  );
  const [reviewMsg, setReviewMsg] = useState<string | null>(null);
  // Alpha 0.83: which summary item (if any) has its blind recount
  // open. While set, that item's book and first counted values are
  // masked everywhere on the summary so the recount stays blind.
  const [recountOpenItemId, setRecountOpenItemId] = useState<
    number | null
  >(null);
  const [finishError, setFinishError] = useState<string | null>(null);
  const [showTrends, setShowTrends] = useState(false);
  // Inventory Checks collapsibles: every category group in the
  // check (Medical Supplies, First Aid, Office Supplies, etc.),
  // the weekly cycle-count panel, the freezer check, the recent
  // checks list and the Finish summary's par groups all start
  // COLLAPSED when the app is launched — empty sets / false by
  // default, view-only state that never affects counting.
  const [expandedGroups, setExpandedGroups] = useState<Set<string>>(
    new Set(),
  );
  const [summaryExpanded, setSummaryExpanded] = useState<Set<string>>(
    new Set(),
  );
  const [weeklyOpen, setWeeklyOpen] = useState(false);
  const [freezerOpen, setFreezerOpen] = useState(false);
  const [recentOpen, setRecentOpen] = useState(false);
  function toggleCheckGroup(category: string) {
    setExpandedGroups((prev) => {
      const next = new Set(prev);
      if (next.has(category)) next.delete(category);
      else next.add(category);
      return next;
    });
  }
  function toggleSummaryGroup(category: string) {
    setSummaryExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(category)) next.delete(category);
      else next.add(category);
      return next;
    });
  }
  // Cycle-count scheduling (Alpha 0.85): the server's "This
  // week's count" proposal (getBitWeeklyCount), and — once the
  // counter starts it — the exact proposed item set the open
  // check is scoped to. Null = a normal full/category check.
  const weekly = useQuery({
    queryKey: ["bit-weekly", business.id],
    queryFn: async () =>
      await api.getBitWeeklyCount({ businessId: business.id }),
  });
  const [weeklyIds, setWeeklyIds] = useState<number[] | null>(null);
  const weeklySet = weeklyIds ? new Set(weeklyIds) : null;

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
  // A weekly cycle-count check (Alpha 0.85) is scoped to exactly
  // its proposed set instead of the category filter.
  const scope = weeklySet
    ? items.filter((it) => weeklySet.has(it.id))
    : groupFilter
      ? groupItems.filter((it) => groupOf(it) === groupFilter)
      : groupItems;
  const countedCount = scope.filter((it) => counts[it.id] != null).length;
  const searching = search.trim().length > 0;
  const visible = scope.filter(
    (it) =>
      (!remainingOnly || counts[it.id] == null) &&
      (!searching || bitItemMatchesSearch(search, it.name, it.sku)),
  );
  const groups = groupByCategory(visible);

  const finish = useMutation({
    mutationFn: async () =>
      await api.finishBitRound({
        businessId: business.id,
        // Requisition-business rounds store the shift letter as the
        // counter identity; every other business stores the
        // counter's name.
        counterName: usesRequisition ? shift : counterName.trim(),
        // The filter names one of the business's categories; the
        // server scopes the check to that category. A weekly
        // cycle-count check (Alpha 0.85) instead sends its exact
        // proposed item set, and the server scopes to that.
        zoneFilter: weeklyIds
          ? "This week's count"
          : groupFilter || null,
        itemIds: weeklyIds,
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
      setSummaryShift(usesRequisition ? shift : null);
      setRecountOpenItemId(null);
      setCounts({});
      setTemps({});
      setFinishError(null);
      // A finished weekly check clears the weekly scope; the
      // snapshots it just wrote move the proposal forward.
      setWeeklyIds(null);
      // The requisition review pop-up opens the moment the check
      // finishes: the counts just written back decide the draft
      // (counted items at their new on-hand, everything else as
      // it stands), built exactly the way the Requisition tab
      // builds it. No draft — nothing at or below par — no pop-up.
      if (usesRequisition) {
        const countedById = new Map(
          res.countedItems.map((ci) => [ci.itemId, ci.counted]),
        );
        const effective = items.map((it) => {
          const counted = countedById.get(it.id);
          return counted != null ? { ...it, onHand: counted } : it;
        });
        const lines = buildReqAutoLines(
          effective,
          resubmittedLines,
          draftExtras,
        ).filter((l) => l.qty >= 1);
        if (lines.length > 0) setReviewLines(lines);
      }
      void queryClient.invalidateQueries({ queryKey: ["bit"] });
      void queryClient.invalidateQueries({ queryKey: ["bit-weekly"] });
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

  if (showTrends) {
    return (
      <TrendsView business={business} onBack={() => setShowTrends(false)} />
    );
  }

  // Variance follow-through (Alpha 0.82): a reason saved from the
  // summary, or a submitted blind recount, updates the summary in
  // place so the nudge count, the variance list and the counted
  // items all reflect the round's new state.
  const applyReason = (itemId: number, reason: string | null) => {
    setSummary((s) =>
      s
        ? {
            ...s,
            countedItems: s.countedItems.map((ci) =>
              ci.itemId === itemId ? { ...ci, varianceReason: reason } : ci,
            ),
          }
        : s,
    );
  };
  const applyRecount = (
    itemId: number,
    newCounted: number,
    variances: RoundSummary["variances"],
    belowPar: RoundSummary["belowPar"],
  ) => {
    setSummary((s) =>
      s
        ? {
            ...s,
            variances,
            belowPar,
            countedItems: s.countedItems.map((ci) =>
              ci.itemId === itemId
                ? {
                    ...ci,
                    counted: newCounted,
                    recounted: true,
                    varianceReason: null,
                  }
                : ci,
            ),
          }
        : s,
    );
  };
  const unreasonedVariances = summary
    ? summary.countedItems.filter(
        (ci) => ci.counted !== ci.book && !ci.varianceReason,
      ).length
    : 0;

  // The Finish summary's counted items, grouped by category for
  // the par editors (Alpha 0.79).
  const countedGroups: {
    category: string;
    items: RoundSummary["countedItems"];
  }[] = [];
  if (summary) {
    const byCat = new Map<string, RoundSummary["countedItems"]>();
    for (const ci of summary.countedItems) {
      const list = byCat.get(ci.category);
      if (list) list.push(ci);
      else byCat.set(ci.category, [ci]);
    }
    for (const [category, list] of byCat)
      countedGroups.push({ category, items: list });
  }

  return (
    <div className="flex flex-col gap-2 pt-2">
      {/* Counted-last stamp (audit #16): the business's most
          recent finished check round — "Not counted yet" until
          the first real check is finished. */}
      <p className="text-sm font-semibold text-[var(--dim)]">
        {lastCountedLabel(rounds[0]?.createdAt ?? null)}
      </p>
      <div className="flex items-center justify-between gap-2">
        {business.usesRequisition ? (
          <p
            className="text-sm font-bold tracking-wide"
            style={{ color: "var(--accent)" }}
          >
            Fire Station Supply Inventory
          </p>
        ) : (
          <span />
        )}
        <button
          type="button"
          onClick={() => setShowTrends(true)}
          className="shrink-0 rounded-full px-3 py-1.5 text-xs font-bold"
          style={{
            backgroundColor: "var(--surface-alt)",
            color: "var(--text)",
          }}
        >
          📈 Trends
        </button>
      </div>
      <p className="text-xs text-[var(--dim)]">
        Par levels (your reorder thresholds) are set on the Finish
        summary after a check and in the Inventory tab — counting
        itself stays blind.
      </p>
      {!weeklyIds && (
        <div
          className="rounded-xl border p-3"
          style={{
            borderColor: "var(--border)",
            backgroundColor: "var(--surface)",
          }}
        >
          <button
            type="button"
            aria-expanded={weeklyOpen}
            aria-label="This week's count"
            onClick={() => setWeeklyOpen((v) => !v)}
            className="flex w-full items-center gap-2 text-left"
          >
            <Chevron collapsed={!weeklyOpen} />
            <span className="min-w-0 flex-1 text-base font-bold">
              This week's count
              {weekly.data && weekly.data.due.length > 0
                ? ` - ${weekly.data.due.length} due`
                : ""}
            </span>
            <span className="shrink-0 text-xs font-bold text-[var(--dim)]">
              {weeklyOpen ? "Hide" : "Show"}
            </span>
          </button>
          {weeklyOpen && (
            <>
          <p className="mt-1 text-xs text-[var(--dim)]">
            Cycle counting: busy or problem items (A) are due
            weekly, items with some activity (B) every 4 weeks,
            and quiet items (C) every 12 weeks — so a big
            inventory gets counted in small weekly sets instead
            of all at once.
          </p>
          {weekly.isPending && (
            <p className="mt-2 text-sm text-[var(--dim)]">
              Working out this week's count…
            </p>
          )}
          {weekly.isError && (
            <p
              role="alert"
              className="mt-2 text-sm font-semibold text-[var(--red)]"
            >
              This week's count couldn't load. Please try again.
            </p>
          )}
          {weekly.data && weekly.data.due.length === 0 && (
            <p className="mt-2 text-sm font-semibold">
              Nothing due this week
            </p>
          )}
          {weekly.data && weekly.data.due.length > 0 && (
            <>
              <ul className="mt-2 flex flex-col">
                {weekly.data.due.slice(0, 40).map((d) => (
                  <li
                    key={d.itemId}
                    className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-0.5 border-b py-1.5 last:border-b-0"
                    style={{ borderColor: "var(--border)" }}
                  >
                    <span className="min-w-0 text-sm font-semibold">
                      {d.name}
                    </span>
                    <span className="shrink-0 text-xs text-[var(--dim)]">
                      {d.neverCounted
                        ? `${d.cls} · ${d.intervalLabel} · due — never counted`
                        : `${d.cls} · ${d.intervalLabel}, last counted ${d.daysSinceLastCount} ${d.daysSinceLastCount === 1 ? "day" : "days"} ago`}
                    </span>
                  </li>
                ))}
              </ul>
              {weekly.data.due.length > 40 && (
                <p className="mt-1 text-xs text-[var(--dim)]">
                  …and {weekly.data.due.length - 40} more due this
                  week — all of them are in the count when you
                  start it.
                </p>
              )}
              <button
                type="button"
                className="mt-3 rounded-full px-4 py-2 text-sm font-bold"
                style={{
                  backgroundColor: "var(--accent)",
                  color: "var(--accent-text)",
                }}
                onClick={() => {
                  setWeeklyIds(
                    (weekly.data?.due ?? []).map((d) => d.itemId),
                  );
                  setGroupFilter("");
                  setCounts({});
                  setSummary(null);
                  setSummaryShift(null);
                  setRemainingOnly(false);
                  setFinishError(null);
                  setWeeklyOpen(false);
                }}
              >
                Start this week's count
              </button>
            </>
          )}
            </>
          )}
        </div>
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
            Counted {summary.counted} of {summary.total}
            {summaryShift ? ` · Shift ${summaryShift}` : ""} · counts
            written back to the inventory.
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
              {unreasonedVariances > 0 && (
                <p
                  className="mt-0.5 text-xs font-semibold"
                  style={{ color: "var(--amber)" }}
                >
                  {unreasonedVariances} variance
                  {unreasonedVariances === 1 ? "" : "s"} without a
                  reason — tap one below if you know it. Optional;
                  nothing is blocked either way.
                </p>
              )}
              <ul className="mt-1 flex flex-col gap-1 text-sm">
                {summary.variances.map((v) => {
                  const ci = summary.countedItems.find(
                    (c) => c.name === v.item,
                  );
                  // Alpha 0.83: while this item's blind recount is
                  // open, its book and first counted values are
                  // masked here (and in the counted-items list
                  // below) so neither number is on screen.
                  const recounting =
                    ci != null && recountOpenItemId === ci.itemId;
                  return (
                    <li
                      key={v.item}
                      className="border-b pb-1.5 last:border-b-0"
                      style={{ borderColor: "var(--border)" }}
                    >
                      <div className="flex flex-wrap justify-between gap-2">
                        <span className="min-w-0">{v.item}</span>
                        {recounting ? (
                          <span className="shrink-0 font-semibold text-[var(--dim)]">
                            variance — counts hidden during recount
                          </span>
                        ) : (
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
                        )}
                      </div>
                      {ci && (
                        <VarianceFollowUp
                          item={ci}
                          fractional={fractional}
                          recountOpen={recounting}
                          onRecountOpenChange={(open) =>
                            setRecountOpenItemId(open ? ci.itemId : null)
                          }
                          onReasonSaved={(reason) =>
                            applyReason(ci.itemId, reason)
                          }
                          onRecounted={(newCounted, variances, belowPar) =>
                            applyRecount(
                              ci.itemId,
                              newCounted,
                              variances,
                              belowPar,
                            )
                          }
                        />
                      )}
                    </li>
                  );
                })}
              </ul>
            </div>
          ) : (
            <p className="mt-2 text-sm">
              No variances — every count matched the book count.
            </p>
          )}
          {summary.countedItems.length > 0 && (
            <div className="mt-3">
              <p className="text-sm font-bold">
                Set par levels for this check
              </p>
              <p className="text-xs text-[var(--dim)]">
                Par is the threshold that puts an item on the{" "}
                {business.usesRequisition ? "Requisition" : "Order Email"}{" "}
                build when a count lands at or below it. Set them here,
                with the real counts in front of you.
              </p>
              {countedGroups.map((g) => {
                const isOpen = summaryExpanded.has(g.category);
                return (
                <div key={g.category} className="mt-2">
                  <button
                    type="button"
                    aria-expanded={isOpen}
                    aria-label={g.category}
                    onClick={() => toggleSummaryGroup(g.category)}
                    className="flex w-full items-center gap-2 rounded-lg px-2 py-1.5 text-left"
                    style={{ backgroundColor: "var(--accent-soft)" }}
                  >
                    <Chevron collapsed={!isOpen} />
                    <span
                      className="min-w-0 flex-1 truncate text-xs font-bold tracking-wide"
                      style={{ color: "var(--accent)" }}
                    >
                      {g.category} - {g.items.length}
                    </span>
                  </button>
                  {isOpen && (
                  <div className="flex flex-col">
                    {g.items.map((ci) => {
                      // Alpha 0.83: while this item's blind recount
                      // is open above, hide its book/counted figures
                      // here too, and drop the "Par = counted"
                      // shortcut, whose label prints the counted
                      // value.
                      const recounting = recountOpenItemId === ci.itemId;
                      return (
                        <div
                          key={ci.itemId}
                          className="flex flex-wrap items-center gap-x-3 gap-y-1 border-b py-1.5 last:border-b-0"
                          style={{ borderColor: "var(--border)" }}
                        >
                          <div className="min-w-40 flex-1">
                            <p className="text-sm font-semibold leading-tight">
                              {ci.name}
                            </p>
                            <p className="text-xs text-[var(--dim)]">
                              {recounting
                                ? "counts hidden during recount"
                                : `book ${fmtCount(ci.book)} → counted ${fmtCount(ci.counted)}`}
                            </p>
                          </div>
                          <ParEditor
                            itemId={ci.itemId}
                            itemName={ci.name}
                            par={ci.par}
                            countedValue={
                              recounting ? undefined : ci.counted
                            }
                          />
                        </div>
                      );
                    })}
                  </div>
                  )}
                </div>
                );
              })}
            </div>
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
            onClick={() => {
              setSummary(null);
              setSummaryShift(null);
              setRecountOpenItemId(null);
            }}
          >
            Start a new check
          </button>
        </div>
      )}
      {reviewMsg && (
        <p className="text-sm font-semibold" role="status">
          {reviewMsg}
        </p>
      )}
      {reviewLines && (
        <ReqFormReviewPopup
          business={business}
          lines={reviewLines}
          onClose={() => setReviewLines(null)}
          onApproved={(reqNo) => {
            setReviewLines(null);
            setReviewMsg(
              `Requisition ${reqNo} approved — the filled form is saved. Download it any time with the Requisition tab's “Download PDF” button.`,
            );
            void queryClient.invalidateQueries({ queryKey: ["bit"] });
            void queryClient.invalidateQueries({
              queryKey: ["bit-req-saved-form", business.id],
            });
          }}
        />
      )}

      <div
        className="rounded-xl border p-3"
        style={{
          borderColor: "var(--border)",
          backgroundColor: "var(--surface)",
        }}
      >
        {weeklyIds && (
          <div
            className="mb-3 flex flex-wrap items-center justify-between gap-2 rounded-lg px-3 py-2"
            style={{ backgroundColor: "var(--accent-soft)" }}
          >
            <p className="text-sm font-bold">
              This week's count — {weeklyIds.length} item
              {weeklyIds.length === 1 ? "" : "s"} due
            </p>
            <button
              type="button"
              className="shrink-0 rounded-full px-3 py-1.5 text-xs font-bold"
              style={{
                backgroundColor: "var(--surface)",
                color: "var(--text)",
              }}
              onClick={() => {
                setWeeklyIds(null);
                setCounts({});
              }}
            >
              Count everything instead
            </button>
          </div>
        )}
        <div className="grid gap-2 sm:grid-cols-2">
          {usesRequisition ? (
            <div className="flex flex-col gap-0.5">
              <span className="text-xs font-semibold text-[var(--dim)]">
                Shift
              </span>
              <div className="flex gap-1" role="group" aria-label="Shift">
                {["A", "B", "C", "D"].map((s) => (
                  <button
                    key={s}
                    type="button"
                    aria-pressed={shift === s}
                    onClick={() => setShift(s)}
                    className="flex-1 rounded-lg border px-2 py-1.5 text-sm font-bold"
                    style={
                      shift === s
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
                    {s}
                  </button>
                ))}
              </div>
            </div>
          ) : (
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
          )}
          <label className="flex flex-col gap-0.5 text-xs font-semibold text-[var(--dim)]">
            Category
            <select
              value={groupFilter}
              onChange={(e) => setGroupFilter(e.target.value)}
              disabled={weeklyIds != null}
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
        {/* Search row: the bar and the microphone button together
            fill the whole row, under the Shift / Category row and
            above the "Counted …" row. Typing narrows the items
            below to matches (name or Material #); the category
            groups auto-open while searching so matches are visible
            without tapping each one. The microphone button at the
            right end dictates into the same search text. */}
        <div className="mt-2 flex w-full items-stretch gap-2">
          <input
            type="search"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search items in this check…"
            aria-label="Search items in this check"
            className="min-w-0 flex-1 rounded-lg border px-3 py-2 text-sm"
            style={{
              borderColor: "var(--border)",
              backgroundColor: "var(--surface)",
            }}
          />
          <button
            type="button"
            onClick={toggleVoiceSearch}
            aria-label={
              listening ? "Stop voice search" : "Search by voice"
            }
            aria-pressed={listening}
            title={listening ? "Stop voice search" : "Search by voice"}
            className="flex shrink-0 items-center justify-center rounded-lg border px-3"
            style={{
              borderColor: listening
                ? "var(--red)"
                : "var(--border)",
              backgroundColor: listening
                ? "var(--red-soft)"
                : "var(--surface)",
              color: listening ? "var(--red)" : "var(--dim)",
            }}
          >
            <svg
              viewBox="0 0 24 24"
              width="20"
              height="20"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              strokeLinecap="round"
              strokeLinejoin="round"
              aria-hidden="true"
            >
              <rect x="9" y="2" width="6" height="12" rx="3" />
              <path d="M5 10a7 7 0 0 0 14 0" />
              <line x1="12" y1="19" x2="12" y2="22" />
            </svg>
          </button>
        </div>
        {listening && (
          <p className="mt-1 text-xs font-semibold text-[var(--red)]">
            Listening… speak the item name, or tap the microphone
            again to stop.
          </p>
        )}
        {voiceNote && (
          <p className="mt-1 text-xs font-semibold text-[var(--dim)]">
            {voiceNote}
          </p>
        )}
        {/* Microphone activation pop-up: cued by the mic button
            whenever the pre-check finds the microphone isn't
            allowed yet. It says the microphone hasn't been
            activated yet and shows how to switch it on in the
            browser (the website) and in the phone's app settings
            (the app). The confirm button re-runs the same check
            as the mic button's initial one; if the mic is
            allowed now the pop-up closes and voice search
            starts, and if it still isn't, the pop-up says so
            (never a silent no-op). While it's open the check
            also re-runs quietly when the user returns to the
            page, and Reload the app covers browsers that only
            apply a changed site setting to a freshly loaded
            page. */}
        {micBlockedOpen && (
          <div
            className="fixed inset-0 z-50 flex items-end justify-center p-4 sm:items-center"
            style={{ backgroundColor: "rgba(0, 0, 0, 0.45)" }}
            onClick={() => setMicBlockedOpen(false)}
          >
            <div
              role="dialog"
              aria-modal="true"
              aria-label="Microphone hasn't been activated yet"
              className="max-h-[85vh] w-full max-w-md overflow-y-auto rounded-2xl border p-4"
              style={{
                borderColor: "var(--border)",
                backgroundColor: "var(--surface)",
              }}
              onClick={(e) => e.stopPropagation()}
            >
              <h3 className="flex items-center gap-2 text-base font-bold">
                <svg
                  viewBox="0 0 24 24"
                  width="20"
                  height="20"
                  fill="none"
                  stroke="var(--red)"
                  strokeWidth="2"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  aria-hidden="true"
                >
                  <rect x="9" y="2" width="6" height="12" rx="3" />
                  <path d="M5 10a7 7 0 0 0 14 0" />
                  <line x1="12" y1="19" x2="12" y2="22" />
                  <line x1="3" y1="3" x2="21" y2="21" />
                </svg>
                Microphone hasn&apos;t been activated yet
              </h3>
              <p className="mt-1 text-sm text-[var(--dim)]">
                Voice search needs the microphone, and it
                isn&apos;t switched on for this app yet. Here&apos;s
                how to activate it — on the website and in the
                app. Once you&apos;ve switched it on, tap the
                confirm button below and the app will check again.
              </p>
              <p className="mt-3 text-sm font-bold">
                On the website (in your browser)
              </p>
              <ol className="mt-1 list-decimal space-y-1.5 pl-5 text-sm">
                <li>
                  Tap the tune (sliders) or padlock icon at the
                  left of the address bar.
                </li>
                <li>
                  Open <strong>Site settings</strong>.
                </li>
                <li>
                  Set <strong>Microphone</strong> to{" "}
                  <strong>Allow</strong>.
                </li>
              </ol>
              <p className="mt-3 text-sm font-bold">
                In the app (your phone&apos;s settings)
              </p>
              <ol className="mt-1 list-decimal space-y-1.5 pl-5 text-sm">
                <li>
                  Open your phone&apos;s <strong>Settings</strong>{" "}
                  app.
                </li>
                <li>
                  Tap <strong>Apps</strong>, then the app you
                  opened HitBit in — your browser, or the app whose
                  window you&apos;re reading this in. On iPhone,
                  scroll to that app in Settings instead.
                </li>
                <li>
                  Tap <strong>Permissions</strong> →{" "}
                  <strong>Microphone</strong> →{" "}
                  <strong>Allow</strong>. On iPhone, turn the{" "}
                  <strong>Microphone</strong> switch on.
                </li>
                <li>
                  Come back here and tap the confirm button below.
                </li>
              </ol>
              <p className="mt-2 text-sm text-[var(--dim)]">
                If this app is open inside another app&apos;s panel
                rather than a full browser tab, open it in the
                browser first — an embedded panel can block the mic
                on its own. Typing in the search bar works either
                way.
              </p>
              {unblockNote && (
                <p
                  role="status"
                  className="mt-2 text-sm font-semibold"
                  style={{ color: "var(--red)" }}
                >
                  {unblockNote}
                </p>
              )}
              <button
                type="button"
                onClick={() => window.location.reload()}
                className="mt-3 w-full rounded-lg border px-3 py-2 text-sm font-bold"
                style={{
                  borderColor: "var(--border)",
                  color: "var(--dim)",
                }}
              >
                Reload the app
              </button>
              <div className="mt-3 flex gap-2">
                <button
                  type="button"
                  onClick={() => setMicBlockedOpen(false)}
                  className="flex-1 rounded-lg border px-3 py-2 text-sm font-bold"
                  style={{
                    borderColor: "var(--border)",
                    color: "var(--dim)",
                  }}
                >
                  Cancel
                </button>
                <button
                  type="button"
                  onClick={() => void confirmMicActivated()}
                  disabled={unblockChecking}
                  className="flex-1 rounded-lg px-3 py-2 text-sm font-bold"
                  style={{
                    backgroundColor: "var(--accent)",
                    color: "var(--accent-text)",
                    opacity: unblockChecking ? 0.6 : 1,
                  }}
                >
                  {unblockChecking
                    ? "Checking…"
                    : "I've activated it — check again"}
                </button>
              </div>
            </div>
          </div>
        )}
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

      {searching && visible.length === 0 && (
        <p className="text-sm font-semibold text-[var(--dim)]">
          No items in this check match “{search.trim()}”.
        </p>
      )}

      {groups.map((g) => {
        // While searching, groups open automatically so matches
        // show without tapping each category header.
        const isOpen = searching || expandedGroups.has(g.category);
        const countedInGroup = g.items.filter(
          (it) => counts[it.id] != null,
        ).length;
        return (
        <section key={g.category} aria-label={g.category}>
          <button
            type="button"
            aria-expanded={isOpen}
            aria-label={g.category}
            onClick={() => toggleCheckGroup(g.category)}
            className="flex w-full items-center gap-2 rounded-lg border-2 px-2 py-2 text-left text-sm font-bold"
            style={{
              backgroundColor: "var(--accent-soft)",
              borderColor: "var(--accent)",
            }}
          >
            <Chevron collapsed={!isOpen} />
            <span
              aria-hidden="true"
              className="h-3 w-3 shrink-0 rounded-full"
              style={{
                backgroundColor: catColor(business.colors, g.category),
              }}
            />
            <span className="min-w-0 flex-1 truncate">
              {g.category} - {g.items.length}
            </span>
            {countedInGroup > 0 && (
              <span className="shrink-0 text-xs font-bold text-[var(--dim)]">
                {countedInGroup} counted
              </span>
            )}
          </button>
          {isOpen && (
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
                      // 44×44 (audit #10): the Checks steppers are
                      // the gloved-counting control at the station,
                      // so they meet the platform size even though
                      // the Inventory tab's steppers stay at 32.
                      className="h-11 w-11 rounded-full text-lg font-bold"
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
                      className="h-11 w-11 rounded-full text-lg font-bold"
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
          )}
        </section>
        );
      })}
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
          <button
            type="button"
            aria-expanded={freezerOpen}
            aria-label="Freezer check"
            onClick={() => setFreezerOpen((v) => !v)}
            className="flex w-full items-center gap-2 text-left"
          >
            <Chevron collapsed={!freezerOpen} />
            <span className="min-w-0 flex-1 text-base font-bold">
              Freezer check
            </span>
            <span className="shrink-0 text-xs font-bold text-[var(--dim)]">
              {freezerOpen ? "Hide" : "Show"}
            </span>
          </button>
          {freezerOpen && (
            <>
          <p className="mt-1 text-xs text-[var(--dim)]">
            Record each freezer's temperature during this check. Anything
            warmer than −18°C is flagged as a food-safety alert in the
            check summary and the order email. Freezers run below zero —
            tap +/− beside a box (or type the minus sign) to enter a
            negative temperature.
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
                  <div className="flex shrink-0 items-center gap-1">
                    <button
                      type="button"
                      aria-label={`Toggle negative temperature for ${f}`}
                      aria-pressed={raw.trim().startsWith("-")}
                      onClick={() =>
                        setTemps((prev) => {
                          const cur = prev[f] ?? "";
                          return {
                            ...prev,
                            [f]: cur.trim().startsWith("-")
                              ? cur.replace("-", "")
                              : `-${cur}`,
                          };
                        })
                      }
                      // 44×44 (audit #10), like the counting
                      // steppers on this same Checks screen.
                      className="h-11 w-11 rounded-full text-sm font-bold"
                      style={{ backgroundColor: "var(--surface-alt)" }}
                    >
                      +/−
                    </button>
                    <input
                      type="number"
                      step="0.1"
                      min={-40}
                      inputMode="decimal"
                      placeholder="°C"
                      aria-label={`Temperature for ${f} in degrees Celsius`}
                      value={raw}
                      onChange={(e) =>
                        setTemps((prev) => ({
                          ...prev,
                          [f]: e.target.value,
                        }))
                      }
                      className="w-24 rounded-lg border px-2 py-1.5 text-center text-sm font-bold"
                      style={{
                        borderColor: "var(--border)",
                        backgroundColor: "var(--surface)",
                      }}
                    />
                  </div>
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
            </>
          )}
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
          opacity: countedCount === 0 || counterMissing ? 0.5 : 1,
        }}
        disabled={finish.isPending || countedCount === 0 || counterMissing}
        onClick={() => finish.mutate()}
      >
        {finish.isPending ? "Finishing…" : "Finish check"}
      </button>
      {(countedCount === 0 || counterMissing) && (
        <p className="-mt-1 text-xs text-[var(--dim)]">
          {counterMissing
            ? "Add the counter's name above to finish a check."
            : "Count at least one item to finish a check."}
        </p>
      )}

      {rounds.length > 0 && (
        <section aria-label="Recent inventory checks" className="mt-2">
          <button
            type="button"
            aria-expanded={recentOpen}
            aria-label="Recent inventory checks"
            onClick={() => setRecentOpen((v) => !v)}
            className="flex w-full items-center gap-2 rounded-lg px-2 py-2 text-left"
            style={{ backgroundColor: "var(--accent-soft)" }}
          >
            <Chevron collapsed={!recentOpen} />
            <span className="min-w-0 flex-1 text-base font-bold">
              Recent inventory checks - {rounds.length}
            </span>
            <span className="shrink-0 text-xs font-bold text-[var(--dim)]">
              {recentOpen ? "Hide" : "Show"}
            </span>
          </button>
          {recentOpen && (
          <div className="mt-1 flex flex-col gap-1">
            {rounds.map((r) => {
              const alerts = isFoodBusiness
                ? r.freezerReadings.filter((f) => f.alert)
                : [];
              // Requisition-business rounds store the shift letter as the counter
              // identity and read "Shift A"; anything else stored
              // (a name) shows as-is.
              const counterLabel =
                usesRequisition && /^[A-D]$/.test(r.counterName)
                  ? `Shift ${r.counterName}`
                  : r.counterName;
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
                    {roundDate(r.createdAt)} · {counterLabel}
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
          )}
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
  // Backdrop guard (Beta 0.04, audit #6 — approved in review: "a
  // backdrop tap can never discard typed input"). The Custom POS
  // popup holds typed form input, so while any field differs from
  // its untouched state the popup counts as holding unsaved input
  // and a backdrop tap does nothing; Cancel stays the deliberate
  // exit. With every field untouched, a backdrop tap still closes
  // it as before.
  const customDirty =
    custom.name !== "" ||
    custom.shareMethod !== "API key" ||
    custom.endpointUrl !== "" ||
    custom.apiKey !== "" ||
    custom.locationId !== "" ||
    custom.notes !== "";
  // Escape closes the Custom POS popup under the same guard as
  // its backdrop: never while it holds unsaved input.
  useEffect(() => {
    if (!customOpen) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape" && !customDirty) setCustomOpen(false);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [customOpen, customDirty]);

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
          onClick={() => {
            // Backdrop guard: never discard typed input — with
            // unsaved input in the fields a backdrop tap does
            // nothing (see customDirty above).
            if (!customDirty) setCustomOpen(false);
          }}
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
                <span className="text-[var(--dim)]">
                  {tx.actor === "connected" ? "Connected account" : "Primary"}
                  {tx.permanent ? " · Permanent" : ""}
                </span>
                {tx.belowPar && !tx.undone && (
                  <span
                    className="rounded-full px-2 py-0.5 text-xs font-bold"
                    style={{ backgroundColor: "var(--amber-soft)", color: "var(--amber)" }}
                  >
                    Below par
                  </span>
                )}
                {tx.undone && (
                  <span className="font-semibold text-[var(--dim)]">Undone</span>
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
 * date has passed, a "Use first" flag within 3 days (Beta 0.03,
 * audit #14 — the same window as the household side's expiry
 * chip, so both sides share one definition of close-to-expiry),
 * and the days remaining shown whenever a date is set. No date =
 * no flag and the item behaves exactly as before.
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
      {days != null && item.expiryDate && days >= 0 && days <= 3 && (
        <>
          <span
            className="rounded-full px-2 py-0.5 text-[13px] font-bold"
            style={{
              backgroundColor: "var(--amber-soft)",
              color: "var(--amber)",
            }}
          >
            Use first
          </span>
          <span className="text-xs text-[var(--dim)]">
            {days === 0
              ? "expires today"
              : days === 1
                ? "expires tomorrow"
                : `expires in ${days} days`}
          </span>
        </>
      )}
      {days != null && item.expiryDate && days > 3 && (
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
                className={`flex flex-wrap items-baseline justify-between gap-2 border-b py-1.5 last:border-b-0 ${w.undone ? "opacity-55" : ""}`}
                style={{ borderColor: "var(--border)" }}
              >
                <span className="min-w-0 text-sm font-semibold">
                  {w.itemName}{" "}
                  <span className="font-normal text-[var(--dim)]">
                    — {w.quantity} {w.unit} · {w.reason}
                    <ActorTag actor={w.actor} permanent={w.permanent} />
                  </span>
                  {w.undone && (
                    <span className="ml-1 text-xs font-bold text-[var(--dim)]">
                      Undone
                    </span>
                  )}
                </span>
                <span className="flex shrink-0 items-baseline gap-2">
                  <span className="text-xs text-[var(--dim)]">
                    {roundDate(w.createdAt)}
                  </span>
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
  rounds,
  scans,
  wasteLog,
  stockEvents,
  manifestImports,
  onDismissScan,
}: {
  business: BitBusiness;
  items: BitItem[];
  rounds: BitState["rounds"];
  scans: BitScan[];
  wasteLog: BitWasteEntry[];
  stockEvents: BitStockEvent[];
  manifestImports: BitManifestImport[];
  onDismissScan: (scan: BitScan) => void;
}) {
  const queryClient = useQueryClient();
  const [search, setSearch] = useState("");
  const [belowParOnly, setBelowParOnly] = useState(false);
  // The item whose par editor is open (Alpha 0.79): tapping a
  // row's "Par N" opens the shared ParEditor under that row.
  const [parEditId, setParEditId] = useState<number | null>(null);
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
      {/* Counted-last stamp (audit #16): the business's most
          recent finished check round — "Not counted yet" until
          the first real check is finished. */}
      <p className="text-sm font-semibold text-[var(--dim)]">
        {lastCountedLabel(rounds[0]?.createdAt ?? null)}
      </p>
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
          {manifestImports.length > 0 && (
            <div className="mt-3">
              <p className="text-sm font-bold">Recent imports</p>
              <div className="mt-1 flex flex-col">
                {manifestImports.map((imp) => (
                  <div
                    key={imp.id}
                    className={`flex flex-wrap items-baseline justify-between gap-2 border-b py-1.5 last:border-b-0 ${imp.undone ? "opacity-55" : ""}`}
                    style={{ borderColor: "var(--border)" }}
                  >
                    <span className="min-w-0 text-sm">
                      <span className="font-semibold">
                        {imp.scanId != null
                          ? "Manifest photo import"
                          : "Manifest import"}
                      </span>{" "}
                      <span className="text-[var(--dim)]">
                        — {imp.addedNames.length} added
                        {imp.addedNames.length > 0
                          ? ` (${imp.addedNames.join(", ")})`
                          : ""}
                        {" · "}
                        {imp.updatedNames.length} counts set
                        {imp.updatedNames.length > 0
                          ? ` (${imp.updatedNames.join(", ")})`
                          : ""}
                        <ActorTag
                          actor={imp.actor}
                          permanent={imp.permanent}
                        />
                      </span>
                      {imp.undone && (
                        <span className="ml-1 text-xs font-bold text-[var(--dim)]">
                          Undone
                        </span>
                      )}
                    </span>
                    <span className="flex shrink-0 items-baseline gap-2">
                      <span className="text-xs text-[var(--dim)]">
                        {roundDate(imp.createdAt)}
                      </span>
                    </span>
                  </div>
                ))}
              </div>
            </div>
          )}
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
        // The fraction counts items strictly ABOVE par (onHand >
        // par) — the header label says "above par" to match
        // (Beta 0.02, audit #3).
        const abovePar = g.items.filter((i) => i.onHand > i.par).length;
        const totalInGroup = items.filter(
          (i) => groupOf(i) === g.name,
        ).length;
        const shown = g.items;
        const pct = totalInGroup > 0 ? (abovePar / totalInGroup) * 100 : 100;
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
              {/* One header spec (Beta 0.05, audit #9): chevron on
                  the LEFT and the item count in the title as
                  "- X", like every banner in the app — no count
                  text on the right. The above-par health figure
                  lives inside the expanded group (below), not in
                  the header. No ⓘ here: expanding the group
                  already shows its items. */}
              <Chevron collapsed={!isOpen} />
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
                  // stays readable (the HIT List's long-name
                  // shrink, applied here).
                  fontSize:
                    g.name.length <= 19
                      ? 20
                      : g.name.length <= 25
                        ? 15
                        : 13,
                }}
              >
                {g.name} - {totalInGroup}
              </span>
            </button>
            {isOpen && (
              <div className="mt-1 flex flex-col gap-1">
                {totalInGroup > 0 && (
                  <p
                    className="px-2 pt-0.5 text-xs font-bold"
                    style={{ color: fracStyle.color }}
                  >
                    {abovePar} of {totalInGroup} above par
                  </p>
                )}
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
                          <button
                            type="button"
                            aria-label={`Set par level for ${it.name}`}
                            aria-expanded={parEditId === it.id}
                            className="font-bold underline"
                            style={{ color: "var(--accent)" }}
                            onClick={() =>
                              setParEditId(
                                parEditId === it.id ? null : it.id,
                              )
                            }
                          >
                            Par {it.par}
                          </button>{" "}
                          · {groupOf(it)}
                          {it.supplier ? ` · ${it.supplier}` : ""}
                          {it.sku ? ` · SKU ${it.sku}` : ""}
                          {/* This item's own last-counted date
                              (audit #16), from its check
                              snapshots; absent until a finished
                              check has counted it. */}
                          {it.lastCountedAt
                            ? ` · Counted ${new Date(it.lastCountedAt).toLocaleDateString("en-CA", { month: "short", day: "numeric", year: "numeric" })}`
                            : ""}
                        </p>
                        {parEditId === it.id && (
                          <span className="mt-1 block">
                            <ParEditor
                              itemId={it.id}
                              itemName={it.name}
                              par={it.par}
                              countedValue={it.onHand}
                              shortcutLabel="Par = on hand"
                            />
                          </span>
                        )}
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
        // The no-match message names the active filter that caused
        // it (Beta 0.05, audit #7): the search text, the
        // "Below par only" filter, or both.
        <p className="py-4 text-center text-sm text-[var(--dim)]">
          {items.length === 0
            ? "No inventory items yet — add one or import a manifest."
            : searching && belowParOnly
              ? `No items match “${search.trim()}” with “Below par only” on.`
              : belowParOnly
                ? "Nothing is at or below par right now — turn off “Below par only” to see everything."
                : `No items match “${search.trim()}”.`}
        </p>
      )}

      {/* Recent count changes (audit #5): the Inventory tab's
          own count edits, newest first. */}
      {stockEvents.length > 0 && (
        <section
          aria-label="Recent count changes"
          className="rounded-xl border p-3"
          style={{
            borderColor: "var(--border)",
            backgroundColor: "var(--surface)",
          }}
        >
          <h3 className="text-base font-bold">Recent count changes</h3>
          <div className="mt-1 flex flex-col">
            {stockEvents.map((e) => (
              <div
                key={e.id}
                className={`flex flex-wrap items-baseline justify-between gap-2 border-b py-1.5 last:border-b-0 ${e.undone ? "opacity-55" : ""}`}
                style={{ borderColor: "var(--border)" }}
              >
                <span className="min-w-0 text-sm font-semibold">
                  {e.itemName}{" "}
                  <span className="font-normal text-[var(--dim)]">
                    — {e.delta >= 0 ? "+" : "−"}
                    {fmtCount(Math.abs(e.delta))} from a count edit
                    <ActorTag actor={e.actor} permanent={e.permanent} />
                  </span>
                  {e.undone && (
                    <span className="ml-1 text-xs font-bold text-[var(--dim)]">
                      Undone
                    </span>
                  )}
                </span>
                <span className="flex shrink-0 items-baseline gap-2">
                  <span className="text-xs text-[var(--dim)]">
                    {roundDate(e.createdAt)}
                  </span>
                </span>
              </div>
            ))}
          </div>
        </section>
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

// ---- Requisition tab (requisition businesses only) -----

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

/**
 * The requisition review pop-up (the submission flow): opens the
 * moment an inventory check finishes on a requisition
 * business, showing the filled requisition form built from the items the
 * check left at or below par. The header boxes and the typed
 * initials can be adjusted right here — the preview rebuilds to
 * match, so what is reviewed is what gets saved — and "Approve &
 * save form" records the requisition as sent with exactly this
 * form saved on it (approveBitRequisitionForm), so the
 * Requisition tab's Download PDF button serves the approved
 * copy. "Not yet" closes the pop-up without saving anything; the
 * draft still waits in the Requisition tab.
 */
function ReqFormReviewPopup({
  business,
  lines,
  onClose,
  onApproved,
}: {
  business: BitBusiness;
  lines: ReqBuildLine[];
  onClose: () => void;
  onApproved: (reqNo: string) => void;
}) {
  const reqCode = reqCodeOf(business);
  const reqNo = reqNoToday(business);
  const [division, setDivision] = useState(business.division ?? "");
  const [preparerName, setPreparerName] = useState(business.preparerName ?? "");
  const [approver, setApprover] = useState(business.approverName ?? "");
  // Typed initials that "sign" the form, exactly as in the
  // Requisition tab: rendered in cursive into the signature
  // boxes; blank leaves that box blank. Not saved anywhere.
  const [preparerInitials, setPreparerInitials] = useState("");
  const [approverInitials, setApproverInitials] = useState("");
  const [previewUrl, setPreviewUrl] = useState<string | null>(null);
  const [previewError, setPreviewError] = useState<string | null>(null);
  const [approveError, setApproveError] = useState<string | null>(null);
  const urlRef = useRef<string | null>(null);
  const seqRef = useRef(0);

  const formLines = lines.filter((l) => l.qty >= 1);
  const linesKey = formLines
    .map((l) => `${l.name}:${l.qty}:${l.unit}`)
    .join("|");

  // Build (and rebuild) the preview of the filled form from the
  // header and initials exactly as they stand, debounced so
  // typing doesn't rebuild on every keystroke.
  useEffect(() => {
    const seq = ++seqRef.current;
    const timer = window.setTimeout(() => {
      void (async () => {
        try {
          const res = await api.getBitRequisitionFormPdf({
            businessId: business.id,
            division: division.trim() || null,
            preparerName: preparerName.trim() || null,
            approverName: approver.trim() || null,
            preparerSignaturePng: await renderSignaturePng(preparerInitials),
            approverSignaturePng:
              await renderSignaturePng(approverInitials),
            lines: formLines.map((l) => ({
              name: l.name,
              materialNo: l.materialNo,
              qty: l.qty,
              unit: l.unit,
            })),
          });
          if (seqRef.current !== seq) return;
          if (!res.ok || !res.pdfBase64) {
            setPreviewError(
              res.error ?? "The form preview couldn't be built.",
            );
            return;
          }
          const bytes = Uint8Array.from(atob(res.pdfBase64), (c) =>
            c.charCodeAt(0),
          );
          const url = URL.createObjectURL(
            new Blob([bytes], { type: "application/pdf" }),
          );
          if (urlRef.current) URL.revokeObjectURL(urlRef.current);
          urlRef.current = url;
          setPreviewUrl(url);
          setPreviewError(null);
        } catch {
          if (seqRef.current === seq) {
            setPreviewError("The form preview couldn't be built.");
          }
        }
      })();
    }, 450);
    return () => window.clearTimeout(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    business.id,
    division,
    preparerName,
    approver,
    preparerInitials,
    approverInitials,
    linesKey,
  ]);

  useEffect(
    () => () => {
      if (urlRef.current) URL.revokeObjectURL(urlRef.current);
    },
    [],
  );

  const approve = useMutation({
    mutationFn: async () =>
      await api.approveBitRequisitionForm({
        businessId: business.id,
        division: division.trim() || null,
        preparerName: preparerName.trim() || null,
        approverName: approver.trim() || null,
        preparerSignaturePng: await renderSignaturePng(preparerInitials),
        approverSignaturePng: await renderSignaturePng(approverInitials),
        lines: formLines.map((l) => ({
          itemId: l.itemId,
          name: l.name,
          materialNo: l.materialNo,
          qty: l.qty,
          unit: l.unit,
          category: l.category,
          resubmittedFromLineId: l.resubmittedFromLineId,
        })),
      }),
    onSuccess: (res) => {
      if (res.ok && res.reqNo) {
        onApproved(res.reqNo);
      } else {
        setApproveError(
          res.error ?? "The form couldn't be approved. Try again.",
        );
      }
    },
    onError: () =>
      setApproveError("The form couldn't be approved. Try again."),
  });

  const fieldCls =
    "rounded-lg border px-2 py-1.5 text-sm font-normal text-[var(--text)]";
  const fieldStyle = {
    borderColor: "var(--border)",
    backgroundColor: "var(--surface)",
  } as const;

  return (
    <div
      className="fixed inset-0 z-50 flex items-end justify-center p-4 sm:items-center"
      style={{ backgroundColor: "rgba(0, 0, 0, 0.45)" }}
      onClick={onClose}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-label="Review the requisition form"
        className="max-h-[92vh] w-full max-w-lg overflow-y-auto rounded-2xl border p-4"
        style={{
          borderColor: "var(--border)",
          backgroundColor: "var(--surface)",
        }}
        onClick={(e) => e.stopPropagation()}
      >
        <h3 className="text-base font-bold">Review the requisition form</h3>
        <p className="mt-1 text-sm text-[var(--dim)]">
          The inventory check is finished. The {formLines.length}{" "}
          item{formLines.length === 1 ? "" : "s"} it left at or below
          par are on the filled requisition form for Requisition {reqNo} —
          {business.name}. Check the form over; approving saves
          it and records the requisition as sent.
        </p>
        {previewError ? (
          <p
            role="alert"
            className="mt-2 text-sm font-semibold text-[var(--red)]"
          >
            {previewError}
          </p>
        ) : previewUrl ? (
          <PdfViewer
            src={previewUrl}
            ariaLabel="Filled requisition form preview"
            className="mt-2 w-full rounded-lg border"
            style={{ borderColor: "var(--border)", height: 360 }}
          />
        ) : (
          <p className="mt-2 text-sm text-[var(--dim)]">
            Building the filled form…
          </p>
        )}
        <div className="mt-3 grid grid-cols-2 gap-2">
          <label className="flex flex-col gap-0.5 text-xs font-semibold text-[var(--dim)]">
            Division
            <DivisionSelect value={division} onChange={setDivision} />
          </label>
          <label className="flex flex-col gap-0.5 text-xs font-semibold text-[var(--dim)]">
            Prepared by
            <input
              value={preparerName}
              aria-label="Preparer name"
              onChange={(e) => setPreparerName(e.target.value)}
              placeholder="Not set yet"
              className={fieldCls}
              style={fieldStyle}
              autoComplete="off"
            />
          </label>
        </div>
        <label className="mt-2 flex flex-col gap-0.5 text-xs font-semibold text-[var(--dim)]">
          Approver
          <input
            value={approver}
            aria-label="Approver name"
            onChange={(e) => setApprover(e.target.value)}
            placeholder="Not recorded yet"
            className={fieldCls}
            style={fieldStyle}
            autoComplete="off"
          />
        </label>
        {approver.trim() &&
          preparerName.trim() &&
          approver.trim().toLowerCase() ===
            preparerName.trim().toLowerCase() && (
            <p
              role="alert"
              className="mt-1 text-xs font-semibold text-[var(--red)]"
            >
              The approver must be different from the preparer who
              prepared the requisition.
            </p>
          )}
        {!approver.trim() && (
          <p className="mt-1 text-xs text-[var(--dim)]">
            An approver is required before the form can be approved.
          </p>
        )}
        {/* Signatures: the same typed-initials boxes as the
            Requisition tab — what is typed here signs the saved
            form in a generic cursive. */}
        <div className="mt-3 grid grid-cols-2 gap-2">
          <div>
            <label className="flex flex-col gap-0.5 text-xs font-semibold text-[var(--dim)]">
              Preparer initials
              <input
                value={preparerInitials}
                aria-label="Preparer initials"
                onChange={(e) => setPreparerInitials(e.target.value)}
                placeholder="Type initials"
                maxLength={8}
                className={fieldCls}
                style={fieldStyle}
                autoComplete="off"
              />
            </label>
            <div
              aria-label="Preparer signature"
              className="mt-1 flex min-h-12 items-center overflow-hidden rounded-lg border px-2"
              style={{
                borderColor: "var(--border)",
                backgroundColor: "var(--surface-alt)",
              }}
            >
              {preparerInitials.trim() ? (
                <SignaturePreview text={preparerInitials.trim()} />
              ) : (
                <span className="text-xs text-[var(--dim)]">
                  Preparer signature
                </span>
              )}
            </div>
          </div>
          <div>
            <label className="flex flex-col gap-0.5 text-xs font-semibold text-[var(--dim)]">
              Approver Initials
              <input
                value={approverInitials}
                aria-label="Approver initials"
                onChange={(e) => setApproverInitials(e.target.value)}
                placeholder="Type initials"
                maxLength={8}
                className={fieldCls}
                style={fieldStyle}
                autoComplete="off"
              />
            </label>
            <div
              aria-label="Approver signature"
              className="mt-1 flex min-h-12 items-center overflow-hidden rounded-lg border px-2"
              style={{
                borderColor: "var(--border)",
                backgroundColor: "var(--surface-alt)",
              }}
            >
              {approverInitials.trim() ? (
                <SignaturePreview text={approverInitials.trim()} />
              ) : (
                <span className="text-xs text-[var(--dim)]">
                  Approver Signature
                </span>
              )}
            </div>
          </div>
        </div>
        {approveError && (
          <p
            role="alert"
            className="mt-2 text-sm font-semibold text-[var(--red)]"
          >
            {approveError}
          </p>
        )}
        <div className="mt-3 flex flex-wrap gap-2">
          <button
            type="button"
            className="rounded-full px-4 py-2 text-sm font-bold"
            style={{
              backgroundColor: "var(--surface-alt)",
              color: "var(--text)",
            }}
            onClick={onClose}
          >
            Not yet
          </button>
          <button
            type="button"
            className="rounded-full px-4 py-2 text-sm font-bold"
            style={{
              backgroundColor: "var(--accent)",
              color: "var(--accent-text)",
            }}
            disabled={approve.isPending || formLines.length === 0}
            onClick={() => {
              setApproveError(null);
              approve.mutate();
            }}
          >
            {approve.isPending ? "Saving…" : "Approve & save form"}
          </button>
        </div>
      </div>
    </div>
  );
}

/** The requisition build order: the order sequence
    (category rank), then by name. */
function reqLineCompare(a: ReqBuildLine, b: ReqBuildLine): number {
  return (
    reqCategoryRank(a.category) - reqCategoryRank(b.category) ||
    a.name.localeCompare(b.name)
  );
}

/**
 * The automatic part of the requisition build list, shared by
 * the Requisition tab and the post-check review pop-up so both
 * always show the same draft: items at or below par (qty =
 * order-up-to minus on hand), merged with the not-received lines
 * carried over from the last closed requisition (badged
 * "Resubmitted" — there are no back orders) and the catalogue
 * draft extras, all in the order sequence. Only items WITH
 * a par auto-appear: an item with no par set (par 0 — e.g. the
 * catalogue items) is ordered only when added by
 * hand (the tab layers those on top of this list).
 */
function buildReqAutoLines(
  items: BitItem[],
  resubmittedLines: BitState["resubmittedLines"],
  draftExtras: BitState["draftExtras"],
): ReqBuildLine[] {
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
  lines.sort(reqLineCompare);
  return lines;
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
  const reqCode = reqCodeOf(business);
  const reqNo = reqNoToday(business);
  const todayLong = new Date().toLocaleDateString("en-CA", {
    year: "numeric",
    month: "long",
    day: "numeric",
  });

  const [division, setDivision] = useState(business.division ?? "");
  const [preparerName, setPreparerName] = useState(business.preparerName ?? "");
  const [approver, setApprover] = useState(business.approverName ?? "");
  // Typed initials that "sign" the filled requisition form: whatever is
  // typed here is rendered in a generic cursive into the matching
  // signature box on the downloaded form (and shown in the
  // signature boxes below). Signing is per-download — the
  // initials are not saved with the header details.
  const [preparerInitials, setPreparerInitials] = useState("");
  const [approverInitials, setApproverInitials] = useState("");
  // Who the requisition email goes to — typed per send, not
  // stored: the supplier's email address.
  const [sendTo, setSendTo] = useState("");
  const [profileMsg, setProfileMsg] = useState<string | null>(null);
  // Pre-send completeness popup (audit #8): opened by "Mark
  // requisition as sent" whenever a header box is unfilled. The
  // popup carries its own approver field — a missing approver is
  // the one gap that cannot be waived.
  const [sendPopupOpen, setSendPopupOpen] = useState(false);
  const [popupApprover, setPopupApprover] = useState("");
  const [popupError, setPopupError] = useState<string | null>(null);
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
  // The build list's category groups collapse exactly like the
  // category groups on the Inventory tab: a set of the expanded
  // category names, empty (all collapsed) by default. View-only —
  // the requisition text and the send use every build line
  // regardless of which groups are collapsed.
  const [expanded, setExpanded] = useState<Set<string>>(new Set());

  function toggleGroup(category: string) {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(category)) next.delete(category);
      else next.add(category);
      return next;
    });
  }

  function expandGroup(category: string) {
    setExpanded((prev) => {
      if (prev.has(category)) return prev;
      const next = new Set(prev);
      next.add(category);
      return next;
    });
  }
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
    mutationFn: async (vars: { approverName?: string }) =>
      await api.updateBitRequisitionProfile({
        businessId: business.id,
        division: division.trim() || null,
        preparerName: preparerName.trim() || null,
        // The pre-send popup can supply the approver it collected.
        approverName: (vars.approverName ?? approver).trim() || null,
      }),
    onSuccess: (res) => {
      if (res.ok) {
        setProfileMsg("Saved.");
        void queryClient.invalidateQueries({ queryKey: ["bit"] });
      } else {
        // E.g. approver recorded as the preparer's own name — the
        // server rejects it and nothing was saved.
        setProfileMsg(res.error ?? "That didn't save. Try again.");
      }
    },
    onError: () => setProfileMsg("That didn't save. Try again."),
  });

  // The build list: the shared automatic build (buildReqAutoLines
  // — at/below-par items, resubmitted lines, catalogue draft
  // extras) plus any items added by hand from the search.
  const buildLines = useMemo<ReqBuildLine[]>(() => {
    const lines = buildReqAutoLines(items, resubmittedLines, draftExtras);
    const byItemId = new Map<number, ReqBuildLine>();
    for (const l of lines) {
      if (l.itemId != null) byItemId.set(l.itemId, l);
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
    lines.sort(reqLineCompare);
    return lines;
  }, [items, resubmittedLines, draftExtras, addedIds]);

  // The build list grouped by category for display. buildLines is
  // already in the requisition order sequence, so first-appearance order
  // keeps the groups in that sequence: Medical, then Stationery /
  // Office Supplies, then Cleaning / General, then the rest.
  const lineGroups = useMemo(() => {
    const map = new Map<string, ReqBuildLine[]>();
    for (const line of buildLines) {
      const list = map.get(line.category);
      if (list) list.push(line);
      else map.set(line.category, [line]);
    }
    return [...map.entries()].map(([category, lines]) => ({
      category,
      lines,
    }));
  }, [buildLines]);

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

  // Pre-filled form scan: some halls keep a requisition form
  // already filled in. The user uploads that file (the filled-in
  // a filled-in requisition form (PDF) or a photo of the paper form; scanBitRequisitionForm
  // reads it and cross-references its lines against this station's
  // inventory list. The review in the tab lists what matched
  // (ticked by default) and what didn't; "Add … to this
  // requisition" puts the ticked matches onto the draft at the
  // form's quantities. Nothing is added until that button.
  const [formScan, setFormScan] = useState<ApiResponse<
    typeof api,
    "scanBitRequisitionForm"
  > | null>(null);
  const [formScanFile, setFormScanFile] = useState<string | null>(null);
  const [formScanError, setFormScanError] = useState<string | null>(null);
  const [formScanSelected, setFormScanSelected] = useState<Set<number>>(
    new Set(),
  );
  const [formScanMsg, setFormScanMsg] = useState<string | null>(null);

  const scanForm = useMutation({
    mutationFn: async (vars: { dataBase64: string; mimeType: string }) =>
      await api.scanBitRequisitionForm({
        businessId: business.id,
        file: vars,
      }),
    onSuccess: (res) => {
      if (!res.ok) {
        setFormScan(null);
        setFormScanError(
          res.error ?? "That form couldn't be scanned. Try again.",
        );
        return;
      }
      setFormScan(res);
      setFormScanError(null);
      setFormScanMsg(null);
      setFormScanSelected(
        new Set(
          res.lines
            .map((l) => l.matchedItemId)
            .filter((id): id is number => id != null),
        ),
      );
      // Fill any header box the form can fill and this draft
      // hasn't yet — the form's own Division / preparer / approver.
      const h = res.header;
      if (h) {
        if (h.division && !division.trim()) setDivision(h.division);
        if (h.preparerName && !preparerName.trim())
          setPreparerName(h.preparerName);
        if (h.approverName && !approver.trim()) setApprover(h.approverName);
      }
    },
    onError: () =>
      setFormScanError("That form couldn't be scanned. Try again."),
  });

  async function handleFormScanFile(file: File) {
    setFormScanError(null);
    setFormScanMsg(null);
    setFormScanFile(file.name);
    try {
      if (file.type === "application/pdf") {
        const { dataBase64 } = await fileToBase64(file);
        scanForm.mutate({ dataBase64, mimeType: "application/pdf" });
      } else {
        // Downscaled to a legible ~2000px JPEG, like a manifest
        // photo — the reader needs the lines, not the megapixels.
        const image = await prepareManifestImage(file);
        scanForm.mutate(image);
      }
    } catch {
      setFormScanError("That file couldn't be read. Try again.");
    }
  }

  /** Put the scan review's ticked matches onto this draft, at the
      quantities the form asked for. Matches already on the draft
      keep the quantity they already have. */
  function applyFormScan() {
    if (!formScan) return;
    const newIds: number[] = [];
    const qtyUpdates: Record<string, number> = {};
    const cats = new Set<string>();
    let already = 0;
    for (const line of formScan.lines) {
      if (line.matchedItemId == null) continue;
      if (!formScanSelected.has(line.matchedItemId)) continue;
      const item = items.find((i) => i.id === line.matchedItemId);
      if (!item) continue;
      if (
        buildLines.some((l) => l.itemId === item.id) ||
        addedIds.includes(item.id) ||
        newIds.includes(item.id)
      ) {
        already++;
        continue;
      }
      newIds.push(item.id);
      if (line.qty != null && line.qty > 0) {
        qtyUpdates[`manual-${item.id}`] = line.qty;
      }
      cats.add(item.category);
    }
    if (newIds.length > 0) {
      setAddedIds((prev) => [
        ...prev,
        ...newIds.filter((id) => !prev.includes(id)),
      ]);
    }
    if (Object.keys(qtyUpdates).length > 0) {
      setQtyEdits((prev) => ({ ...prev, ...qtyUpdates }));
    }
    cats.forEach((c) => expandGroup(c));
    const parts: string[] = [];
    if (newIds.length > 0) {
      parts.push(
        `Added ${newIds.length} ${newIds.length === 1 ? "item" : "items"} from the form to this requisition.`,
      );
    }
    if (already > 0) {
      parts.push(
        `${already} ${already === 1 ? "was" : "were"} already on the requisition.`,
      );
    }
    setFormScanMsg(parts.length > 0 ? parts.join(" ") : "Nothing was ticked to add.");
  }

  function addFromSearch(item: BitItem) {
    const existing = buildLines.find((l) => l.itemId === item.id);
    if (existing) {
      // Already a line on this draft — never duplicate it; flash
      // the line that's there instead (opening its category group
      // first, so the flash lands on a visible line).
      expandGroup(existing.category);
      flashLine(existing.key);
      return;
    }
    setAddedIds((prev) => (prev.includes(item.id) ? prev : [...prev, item.id]));
    expandGroup(item.category);
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

  const emailSubject = `Requisition ${reqNo}`;
  const requisitionText = useMemo(() => {
    const out: string[] = [
      business.name.toUpperCase(),
      "REQUISITION",
      `SEND TO: ${sendTo.trim() || "—"}`,
      "",
      `Division: ${division.trim() || ""}`,
      `Business: ${business.name}`,
      `Date: ${todayLong}`,
      `Req. No.: ${reqNo}`,
      `Prepared by: ${preparerName.trim() || ""}`,
      `Approver: ${approver.trim() || ""}`,
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
      // Plain text can't carry the cursive, so the email / copy
      // text shows the typed initials themselves on the
      // signature line; the filled PDF form signs in cursive.
      preparerInitials.trim()
        ? `Preparer signature: ${preparerInitials.trim()}`
        : "Preparer signature: ______________________",
      approverInitials.trim()
        ? `Approver signature: ${approverInitials.trim()}`
        : "Approver signature: ______________________",
    );
    return out.join("\n");
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    sendLines,
    division,
    preparerName,
    approver,
    preparerInitials,
    approverInitials,
    reqNo,
    todayLong,
    sendTo,
    business.name,
  ]);

  const mailto = `mailto:${sendTo.trim()}?subject=${encodeURIComponent(emailSubject)}&body=${encodeURIComponent(requisitionText)}`;

  async function copyText() {
    try {
      await navigator.clipboard.writeText(
        `To: ${sendTo}\nSubject: ${emailSubject}\n\n${requisitionText}`,
      );
      setCopied(true);
      window.setTimeout(() => setCopied(false), 2500);
    } catch {
      setCopied(false);
    }
  }

  // The filled requisition form (PDF): the server builds the
  // generic requisition form with this draft's header and lines;
  // the returned base64 becomes a download named for the requisition.
  const [formPdfMsg, setFormPdfMsg] = useState<string | null>(null);
  const [formPdfError, setFormPdfError] = useState<string | null>(null);
  const formPdf = useMutation({
    mutationFn: async () =>
      await api.getBitRequisitionFormPdf({
        businessId: business.id,
        division: division.trim() || null,
        preparerName: preparerName.trim() || null,
        approverName: approver.trim() || null,
        // The typed initials, rendered in cursive, sign the
        // form's two signature boxes (null = left blank).
        preparerSignaturePng: await renderSignaturePng(preparerInitials),
        approverSignaturePng: await renderSignaturePng(approverInitials),
        lines: sendLines.map(({ line, qty }) => ({
          name: line.name,
          materialNo: line.materialNo,
          qty,
          unit: line.unit,
        })),
      }),
    onSuccess: (res) => {
      if (!res.ok || !res.pdfBase64) {
        setFormPdfMsg(null);
        setFormPdfError(
          res.error ?? "The filled form couldn't be built.",
        );
        return;
      }
      if (
        downloadPdfBase64(
          res.pdfBase64,
          res.filename ?? `Requisition ${reqNo}.pdf`,
        )
      ) {
        setFormPdfError(null);
        setFormPdfMsg(
          res.pageCount > 1
            ? `Filled requisition form downloaded — ${res.pageCount} pages, numbered page by page.`
            : "Filled requisition form downloaded.",
        );
      } else {
        setFormPdfMsg(null);
        setFormPdfError("The filled form couldn't be downloaded.");
      }
    },
    onError: () => {
      setFormPdfMsg(null);
      setFormPdfError("The filled form couldn't be built. Try again.");
    },
  });

  // The saved approved form (the post-check review flow): once a
  // form has been approved in the review pop-up and saved,
  // "Download PDF" serves that exact copy; until then it builds
  // one from the current draft (the formPdf mutation above).
  const savedFormInfo = useQuery({
    queryKey: ["bit-req-saved-form", business.id],
    queryFn: async () =>
      await api.getBitSavedRequisitionFormInfo({
        businessId: business.id,
      }),
  });
  const hasSavedForm = savedFormInfo.data?.exists === true;
  const savedDownload = useMutation({
    mutationFn: async () =>
      await api.downloadBitSavedRequisitionForm({
        businessId: business.id,
      }),
    onSuccess: (res) => {
      if (!res.ok || !res.pdfBase64) {
        setFormPdfMsg(null);
        setFormPdfError(
          res.error ?? "The saved form couldn't be downloaded.",
        );
        return;
      }
      if (
        downloadPdfBase64(
          res.pdfBase64,
          res.filename ?? `Requisition ${reqNo}.pdf`,
        )
      ) {
        setFormPdfError(null);
        setFormPdfMsg(
          res.pageCount > 1
            ? `Saved requisition form downloaded — ${res.pageCount} pages, numbered page by page.`
            : "Saved requisition form downloaded.",
        );
      } else {
        setFormPdfMsg(null);
        setFormPdfError("The saved form couldn't be downloaded.");
      }
    },
    onError: () => {
      setFormPdfMsg(null);
      setFormPdfError("The saved form couldn't be downloaded. Try again.");
    },
  });

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
    preparerName !== (business.preparerName ?? "") ||
    approver !== (business.approverName ?? "");

  // Pre-send completeness (audit #8): which header boxes are
  // unfilled, read from the fields exactly as they stand.
  const missingDivision = division.trim() === "";
  const missingDoName = preparerName.trim() === "";
  const missingApprover = approver.trim() === "";
  const anyMissing = missingDivision || missingDoName || missingApprover;

  /** Save any unsaved header edits, then mark the requisition
      sent. A rejected save (approver recorded as the preparer's own
      name) stops the send and surfaces its message. */
  async function doSend() {
    if (profileDirty) {
      try {
        const res = await saveProfile.mutateAsync({});
        if (!res.ok) {
          setSendMsg(null);
          setSendError(res.error ?? "The header details didn't save.");
          return;
        }
      } catch {
        setSendMsg(null);
        setSendError("The header details didn't save. Try again.");
        return;
      }
    }
    send.mutate();
  }

  /** "Mark requisition as sent": if anything is unfilled, the
      completeness popup lists exactly which boxes are empty
      first; a complete header sends straight away. */
  function attemptSend() {
    setSendError(null);
    if (anyMissing) {
      setPopupApprover(approver);
      setPopupError(null);
      setSendPopupOpen(true);
      return;
    }
    void doSend();
  }

  /** The popup's send button. Division / Prepared by gaps are
      waived ("Send anyway"); a missing approver is not — the
      popup's own approver field must hold a name different from
      the preparer's, which is recorded before the send. */
  async function confirmPopupSend() {
    if (missingApprover) {
      const name = popupApprover.trim();
      if (!name) {
        setPopupError(
          "An approver is required before sending — enter the approver's name.",
        );
        return;
      }
      if (
        preparerName.trim() &&
        name.toLowerCase() === preparerName.trim().toLowerCase()
      ) {
        setPopupError(
          "The approver must be different from the preparer.",
        );
        return;
      }
      setApprover(name);
      setSendPopupOpen(false);
      try {
        const res = await saveProfile.mutateAsync({
          approverName: name,
        });
        if (!res.ok) {
          setSendMsg(null);
          setSendError(res.error ?? "The header details didn't save.");
          return;
        }
      } catch {
        setSendMsg(null);
        setSendError("The header details didn't save. Try again.");
        return;
      }
      send.mutate();
      return;
    }
    setSendPopupOpen(false);
    void doSend();
  }

  // The draft's state, shown plainly like a sent requisition's
  // (audit #15). A recorded date shows when the name on screen is
  // the one on file; a name still being typed has no date yet.
  const draftPreparedDate =
    preparerName.trim() && preparerName.trim() === (business.preparerName ?? "")
      ? longDateOrEmpty(business.preparerRecordedAt)
      : "";
  const draftApprovedDate =
    approver.trim() && approver.trim() === (business.approverName ?? "")
      ? longDateOrEmpty(business.approverRecordedAt)
      : "";
  const draftState = [
    preparerName.trim()
      ? `Prepared by ${preparerName.trim()}${draftPreparedDate ? ` · ${draftPreparedDate}` : ""}`
      : "Prepared by —",
    approver.trim()
      ? `Approved by ${approver.trim()}${draftApprovedDate ? ` · ${draftApprovedDate}` : ""}`
      : "Approved by —",
    "Not sent yet",
  ].join(" → ");

  // The form scan's lines, split for the review: matched against
  // the inventory list vs. on the form but not found on it.
  const formScanMatched = formScan?.ok
    ? formScan.lines.filter((l) => l.matchedItemId != null)
    : [];
  const formScanUnmatched = formScan?.ok
    ? formScan.lines.filter((l) => l.matchedItemId == null)
    : [];

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
              to the supplier. When the supplies come
              back with the marked requisition, check off each item
              received and remark the ones not received — items not
              received are never back-ordered; they are resubmitted
              on the next requisition.
            </p>
            <div className="mt-1">
              <RequisitionStateLine req={requisition} />
            </div>
            {hasSavedForm && savedFormInfo.data && (
              <div className="mt-2 flex flex-wrap items-center gap-2">
                <button
                  type="button"
                  className="rounded-full px-4 py-2 text-sm font-bold"
                  style={{
                    backgroundColor: "var(--surface-alt)",
                    color: "var(--text)",
                  }}
                  disabled={savedDownload.isPending}
                  onClick={() => savedDownload.mutate()}
                >
                  {savedDownload.isPending
                    ? "Preparing PDF…"
                    : "Download PDF"}
                </button>
                <span className="text-sm text-[var(--dim)]">
                  The approved form for Requisition{" "}
                  {savedFormInfo.data.reqNo}
                  {savedFormInfo.data.savedAt
                    ? `, saved ${longDateOrEmpty(savedFormInfo.data.savedAt)}`
                    : ""}
                  .
                </span>
              </div>
            )}
            {formPdfError && (
              <p
                role="alert"
                className="mt-2 text-sm font-semibold text-[var(--red)]"
              >
                {formPdfError}
              </p>
            )}
            {formPdfMsg && (
              <p className="mt-2 text-sm font-semibold" role="status">
                {formPdfMsg}
              </p>
            )}
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
                      {l.status !== "pending" && (
                        <span className="shrink-0 text-xs text-[var(--dim)]">
                          {l.actor === "connected"
                            ? "Connected account"
                            : "Primary"}
                          {l.permanent ? " · Permanent" : ""}
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
            Built from everything at or below par after the latest
            inventory check, in the requisition's order —
            Medical supplies first, then Stationery, then general
            items. The preparer signs, the approver reviews
            and signs, and it goes to the supplier.
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
                <DivisionSelect value={division} onChange={setDivision} />
              </label>
              <label className="flex flex-col gap-0.5 text-xs font-semibold text-[var(--dim)]">
                Prepared by
                <input
                  value={preparerName}
                  aria-label="Preparer name"
                  onChange={(e) => setPreparerName(e.target.value)}
                  placeholder="Not set yet"
                  className={fieldCls}
                  style={fieldStyle}
                  autoComplete="off"
                />
              </label>
            </div>
            {/* Approver separation (audit #15): the approver —
                the form's approver name/signature line — recorded
                apart from the preparer who prepared it. No
                approver, no send; and the approver can never be
                the preparer's own name. */}
            <label className="mt-2 flex flex-col gap-0.5 text-xs font-semibold text-[var(--dim)]">
              Approver
              <input
                value={approver}
                aria-label="Approver name"
                onChange={(e) => setApprover(e.target.value)}
                placeholder="Not recorded yet"
                className={fieldCls}
                style={fieldStyle}
                autoComplete="off"
              />
            </label>
            {approver.trim() &&
              preparerName.trim() &&
              approver.trim().toLowerCase() ===
                preparerName.trim().toLowerCase() && (
                <p
                  role="alert"
                  className="mt-1 text-xs font-semibold text-[var(--red)]"
                >
                  The approver must be different from the preparer who
                  prepared the requisition.
                </p>
              )}
            <p className="mt-1 text-xs text-[var(--dim)]">
              {business.approverName && business.approverRecordedAt
                ? `Approver recorded ${longDateOrEmpty(business.approverRecordedAt)}.`
                : "No approver recorded yet — one is required before this requisition can be sent."}
            </p>
            {/* Signatures: type initials in a box and they sign
                the matching signature box of the filled requisition form
                in a generic cursive — the boxes below preview
                exactly what the form gets. Blank initials leave
                that signature box blank. */}
            <div className="mt-3 grid grid-cols-2 gap-2">
              <div>
                <label className="flex flex-col gap-0.5 text-xs font-semibold text-[var(--dim)]">
                  Preparer initials
                  <input
                    value={preparerInitials}
                    aria-label="Preparer initials"
                    onChange={(e) => setPreparerInitials(e.target.value)}
                    placeholder="Type initials"
                    maxLength={8}
                    className={fieldCls}
                    style={fieldStyle}
                    autoComplete="off"
                  />
                </label>
                <div
                  aria-label="Preparer signature"
                  className="mt-1 flex min-h-12 items-center overflow-hidden rounded-lg border px-2"
                  style={{
                    borderColor: "var(--border)",
                    backgroundColor: "var(--surface-alt)",
                  }}
                >
                  {preparerInitials.trim() ? (
                    <SignaturePreview text={preparerInitials.trim()} />
                  ) : (
                    <span className="text-xs text-[var(--dim)]">
                      Preparer signature
                    </span>
                  )}
                </div>
              </div>
              <div>
                <label className="flex flex-col gap-0.5 text-xs font-semibold text-[var(--dim)]">
                  Approver Initials
                  <input
                    value={approverInitials}
                    aria-label="Approver initials"
                    onChange={(e) => setApproverInitials(e.target.value)}
                    placeholder="Type initials"
                    maxLength={8}
                    className={fieldCls}
                    style={fieldStyle}
                    autoComplete="off"
                  />
                </label>
                <div
                  aria-label="Approver signature"
                  className="mt-1 flex min-h-12 items-center overflow-hidden rounded-lg border px-2"
                  style={{
                    borderColor: "var(--border)",
                    backgroundColor: "var(--surface-alt)",
                  }}
                >
                  {approverInitials.trim() ? (
                    <SignaturePreview text={approverInitials.trim()} />
                  ) : (
                    <span className="text-xs text-[var(--dim)]">
                      Approver Signature
                    </span>
                  )}
                </div>
              </div>
            </div>
            <p className="mt-1 text-xs text-[var(--dim)]">
              Typed initials sign the filled requisition form&rsquo;s
              signature boxes in cursive when you download it below.
            </p>
            <p className="mt-2 text-sm">
              <strong>Business:</strong> {business.name} ·{" "}
              <strong>Date:</strong> {todayLong} ·{" "}
              <strong>Req. No.:</strong> {reqNo}
            </p>
            <p className="mt-1 text-xs font-semibold text-[var(--dim)]">
              {draftState}
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
                  onClick={() => saveProfile.mutate({})}
                >
                  {saveProfile.isPending ? "Saving…" : "Save header details"}
                </button>
                {profileMsg && (
                  <span className="text-sm font-semibold">{profileMsg}</span>
                )}
              </div>
            )}
          </div>

          <section
            aria-label="Scan a pre-filled requisition form"
            className="rounded-xl border p-3"
            style={{
              borderColor: "var(--border)",
              backgroundColor: "var(--surface)",
            }}
          >
            <h3 className="text-sm font-bold">
              Already have a filled-in form?
            </h3>
            <p className="mt-1 text-xs text-[var(--dim)]">
              Some halls keep a requisition form already filled in.
              Upload that file — the filled-in requisition form — or take a
              photo of the paper form. It&rsquo;s scanned and checked
              against this station&rsquo;s inventory list, and the
              items it finds can go straight onto this requisition.
            </p>
            <div className="mt-2 flex flex-wrap items-center gap-2">
              <label
                className="inline-flex cursor-pointer items-center rounded-full px-3 py-1.5 text-sm font-bold"
                style={{
                  backgroundColor: "var(--accent)",
                  color: "var(--accent-text)",
                  opacity: scanForm.isPending ? 0.6 : 1,
                }}
              >
                {scanForm.isPending ? "Scanning…" : "Upload the form (PDF)"}
                <input
                  type="file"
                  accept="application/pdf,.pdf"
                  className="sr-only"
                  aria-label="Upload a filled-in requisition form PDF"
                  disabled={scanForm.isPending}
                  onChange={(e) => {
                    const f = e.target.files?.[0];
                    if (f) void handleFormScanFile(f);
                    e.target.value = "";
                  }}
                />
              </label>
              <label
                className="inline-flex cursor-pointer items-center rounded-full px-3 py-1.5 text-sm font-bold"
                style={{
                  backgroundColor: "var(--surface-alt)",
                  color: "var(--text)",
                  opacity: scanForm.isPending ? 0.6 : 1,
                }}
              >
                Take a photo of the form
                <input
                  type="file"
                  accept="image/*"
                  className="sr-only"
                  aria-label="Take or upload a photo of a filled-in requisition form"
                  disabled={scanForm.isPending}
                  onChange={(e) => {
                    const f = e.target.files?.[0];
                    if (f) void handleFormScanFile(f);
                    e.target.value = "";
                  }}
                />
              </label>
              {formScanFile && (
                <span className="text-xs text-[var(--dim)]">
                  {formScanFile}
                </span>
              )}
            </div>
            {formScanError && (
              <p
                role="alert"
                className="mt-2 text-sm font-semibold text-[var(--red)]"
              >
                {formScanError}
              </p>
            )}
            {formScan && formScan.ok && (
              <div
                className="mt-3 border-t pt-3"
                style={{ borderColor: "var(--border)" }}
              >
                <p className="text-sm font-semibold">
                  Scanned {formScan.lines.length}{" "}
                  {formScan.lines.length === 1 ? "line" : "lines"} from
                  the {formScan.source === "pdf" ? "file" : "photo"} —{" "}
                  {formScanMatched.length} matched this station&rsquo;s
                  inventory list
                  {formScanUnmatched.length > 0
                    ? `, ${formScanUnmatched.length} didn't`
                    : ""}
                  .
                </p>
                {formScan.header &&
                  (formScan.header.division ||
                    formScan.header.preparerName ||
                    formScan.header.approverName) && (
                    <p className="mt-1 text-xs text-[var(--dim)]">
                      On the form:{" "}
                      {[
                        formScan.header.division &&
                          `Division ${formScan.header.division}`,
                        formScan.header.preparerName &&
                          `Preparer ${formScan.header.preparerName}`,
                        formScan.header.approverName &&
                          `Approver ${formScan.header.approverName}`,
                      ]
                        .filter(Boolean)
                        .join(" · ")}
                      . Any header box above that was blank has been
                      filled from it.
                    </p>
                  )}
                {formScanMatched.length > 0 && (
                  <div className="mt-2 flex flex-col gap-1">
                    {formScanMatched.map((l) => (
                      <label
                        key={l.matchedItemId}
                        className="flex cursor-pointer items-center gap-2 rounded-lg px-2 py-1.5"
                        style={{
                          backgroundColor: "var(--surface-alt)",
                        }}
                      >
                        <input
                          type="checkbox"
                          checked={formScanSelected.has(
                            l.matchedItemId ?? -1,
                          )}
                          onChange={(e) => {
                            const id = l.matchedItemId;
                            if (id == null) return;
                            setFormScanSelected((prev) => {
                              const next = new Set(prev);
                              if (e.target.checked) next.add(id);
                              else next.delete(id);
                              return next;
                            });
                          }}
                          aria-label={`Add ${l.matchedName} from the scanned form`}
                          className="h-4 w-4 shrink-0"
                        />
                        <span className="min-w-0 flex-1">
                          <span className="block truncate text-sm font-semibold leading-tight">
                            {l.matchedName}
                          </span>
                          <span className="block text-xs text-[var(--dim)]">
                            {l.matchedCategory}
                            {l.matchedMaterialNo
                              ? ` · Material # ${l.matchedMaterialNo}`
                              : ""}
                            {` · ${l.matchedOnHand} on hand`}
                            {l.matchKind === "material"
                              ? " · matched by Material #"
                              : ""}
                          </span>
                          <span className="block text-xs text-[var(--dim)]">
                            Form says: &ldquo;{l.scannedName}&rdquo;
                            {l.qty != null
                              ? ` × ${l.qty}${l.unit ? ` ${l.unit}` : ""}`
                              : ""}
                          </span>
                        </span>
                      </label>
                    ))}
                  </div>
                )}
                {formScanUnmatched.length > 0 && (
                  <div className="mt-2">
                    <p className="text-xs font-bold text-[var(--dim)]">
                      On the form, but not in this station&rsquo;s
                      inventory list:
                    </p>
                    <div className="mt-1 flex flex-col gap-1">
                      {formScanUnmatched.map((l, i) => (
                        <div
                          key={`${l.scannedName}-${i}`}
                          className="rounded-lg px-2 py-1.5 text-sm"
                          style={{
                            backgroundColor: "var(--surface-alt)",
                          }}
                        >
                          {l.scannedName}
                          <span className="text-xs text-[var(--dim)]">
                            {l.qty != null
                              ? ` · × ${l.qty}${l.unit ? ` ${l.unit}` : ""}`
                              : ""}
                            {l.materialNo
                              ? ` · Material # ${l.materialNo}`
                              : ""}
                          </span>
                        </div>
                      ))}
                    </div>
                    <p className="mt-1 text-xs text-[var(--dim)]">
                      If one of these is on the list under a different
                      name, the search below can add it by hand.
                    </p>
                  </div>
                )}
                <div className="mt-2 flex flex-wrap items-center gap-2">
                  <button
                    type="button"
                    className="rounded-full px-3 py-1.5 text-sm font-bold disabled:opacity-50"
                    style={{
                      backgroundColor: "var(--accent)",
                      color: "var(--accent-text)",
                    }}
                    disabled={formScanSelected.size === 0}
                    onClick={applyFormScan}
                  >
                    Add {formScanSelected.size} ticked{" "}
                    {formScanSelected.size === 1 ? "item" : "items"} to
                    this requisition
                  </button>
                  <button
                    type="button"
                    className="rounded-full px-3 py-1.5 text-sm font-bold"
                    style={{
                      backgroundColor: "var(--surface-alt)",
                      color: "var(--text)",
                    }}
                    onClick={() => {
                      setFormScan(null);
                      setFormScanMsg(null);
                      setFormScanFile(null);
                    }}
                  >
                    Dismiss scan
                  </button>
                </div>
                {formScanMsg && (
                  <p className="mt-2 text-sm font-semibold" role="status">
                    {formScanMsg}
                  </p>
                )}
              </div>
            )}
          </section>

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
            <div className="flex flex-col gap-2">
              {lineGroups.map((g) => {
                const isOpen = expanded.has(g.category);
                return (
                  <section key={g.category} aria-label={g.category}>
                    <button
                      type="button"
                      aria-expanded={isOpen}
                      onClick={() => toggleGroup(g.category)}
                      className="flex w-full items-center gap-2 rounded-xl border-2 px-3 py-2 text-left"
                      style={{
                        borderColor: "var(--accent)",
                        backgroundColor: "var(--accent-soft)",
                      }}
                    >
                      {/* One header spec (Beta 0.05, audit #9):
                          chevron on the LEFT, item count in the
                          title as "- X", no right-side count. */}
                      <Chevron collapsed={!isOpen} />
                      <span
                        aria-hidden="true"
                        className="h-3.5 w-3.5 shrink-0 rounded-full"
                        style={{
                          backgroundColor: catColor(
                            business.colors,
                            g.category,
                          ),
                        }}
                      />
                      <span className="min-w-0 flex-1 truncate font-bold">
                        {g.category} - {g.lines.length}
                      </span>
                    </button>
                    {isOpen && (
                      <div className="mt-1 flex flex-col gap-1">
                        {g.lines.map((line) => {
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
                  </section>
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
            <label className="mt-2 flex flex-col gap-0.5 text-xs font-semibold text-[var(--dim)]">
              Send to (email)
              <input
                value={sendTo}
                aria-label="Send to email address"
                onChange={(e) => setSendTo(e.target.value)}
                placeholder="Supplier's email address"
                className={fieldCls}
                style={fieldStyle}
                autoComplete="off"
              />
            </label>
            <p className="mt-1 text-xs font-semibold text-[var(--dim)]">
              To: {sendTo.trim() || "Not set yet"} · Subject: {emailSubject}
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
                disabled={
                  formPdf.isPending ||
                  savedDownload.isPending ||
                  (!hasSavedForm && sendLines.length === 0)
                }
                onClick={() => {
                  if (hasSavedForm) savedDownload.mutate();
                  else formPdf.mutate();
                }}
              >
                {formPdf.isPending || savedDownload.isPending
                  ? "Preparing PDF…"
                  : "Download PDF"}
              </button>
              <button
                type="button"
                className="rounded-full px-4 py-2 text-sm font-bold"
                style={{
                  backgroundColor: "var(--surface-alt)",
                  color: "var(--text)",
                }}
                disabled={send.isPending || sendLines.length === 0}
                onClick={attemptSend}
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
            {formPdfError && (
              <p
                role="alert"
                className="mt-2 text-sm font-semibold text-[var(--red)]"
              >
                {formPdfError}
              </p>
            )}
            {formPdfMsg && (
              <p className="mt-2 text-sm font-semibold" role="status">
                {formPdfMsg}
              </p>
            )}
            {hasSavedForm && savedFormInfo.data && (
              <p className="mt-2 text-sm text-[var(--dim)]">
                Download PDF gets the approved form for Requisition{" "}
                {savedFormInfo.data.reqNo}
                {savedFormInfo.data.savedAt
                  ? `, saved ${longDateOrEmpty(savedFormInfo.data.savedAt)}`
                  : ""}{" "}
                — the copy reviewed and approved after the inventory
                check.
              </p>
            )}
          </div>
        </>
      )}

      {!requisition && checkMsg && (
        <p className="text-sm font-semibold" role="status">
          {checkMsg}
        </p>
      )}

      {history.length > 0 && (
        <section aria-label="Requisition history">
          {/* One header spec (Beta 0.05, audit #9): the standard
              accent box, chevron on the LEFT, the count in the
              title as "- X" (never "(N on file)"), and an ⓘ beside
              it listing the requisition numbers it counts. */}
          <div
            className="flex w-full items-center gap-2 rounded-xl border-2 px-3 py-2"
            style={{
              borderColor: "var(--accent)",
              backgroundColor: "var(--accent-soft)",
            }}
          >
            <button
              type="button"
              aria-expanded={historyOpen}
              onClick={() => setHistoryOpen((o) => !o)}
              // -my-2 py-2 (audit #10): the toggle's tappable
              // area fills the banner's full height, like the
              // other banner toggles — the negative margins
              // cancel the extra padding in layout, so the
              // banner doesn't grow.
              className="-my-2 flex min-w-0 flex-1 items-center gap-2 py-2 text-left"
            >
              <Chevron collapsed={!historyOpen} />
              <span className="min-w-0 flex-1 font-bold">
                Requisition history - {history.length}
              </span>
            </button>
            <BitInfoListButton
              names={history.map((h) => h.reqNo)}
              emptyText="No requisitions"
              ariaLabel="Show the requisitions in this history"
            />
          </div>
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
                  <RequisitionStateLine req={h} />
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
                  {/* Each line's check-off mark (audit #5
                      attribution). */}
                  <div className="mt-1 flex flex-col gap-1">
                    {h.lines.map((l) => (
                      <div
                        key={l.id}
                        className="flex flex-wrap items-center gap-2"
                      >
                        <span className="min-w-0 flex-1 text-xs">
                          {l.name}{" "}
                          <span className="text-[var(--dim)]">
                            — ordered {l.qtyOrdered} {l.unit}
                          </span>
                        </span>
                        {l.status === "received" && (
                          <span
                            className="shrink-0 rounded-full px-2 py-0.5 text-xs font-bold"
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
                            className="shrink-0 rounded-full px-2 py-0.5 text-xs font-bold"
                            style={{
                              backgroundColor: "var(--out-bg)",
                              color: "var(--out-text)",
                            }}
                          >
                            Not received
                          </span>
                        )}
                        {l.status !== "pending" && (
                          <span className="shrink-0 text-xs text-[var(--dim)]">
                            {l.actor === "connected"
                              ? "Connected account"
                              : "Primary"}
                            {l.permanent ? " · Permanent" : ""}
                          </span>
                        )}
                      </div>
                    ))}
                  </div>
                </div>
              ))}
            </div>
          )}
        </section>
      )}

      {/* Pre-send completeness popup (audit #8): lists exactly
          which header boxes are unfilled. Division and Prepared by
          can be waived with "Send anyway"; a missing approver
          cannot — the popup offers the approver field right here
          and that is the only way through. The backdrop follows
          the typed-input guard: while the popup's approver field
          holds text that isn't on file, a backdrop tap does
          nothing (Go back is the deliberate exit). */}
      {sendPopupOpen && (
        <div
          className="fixed inset-0 z-50 flex items-end justify-center p-4 sm:items-center"
          style={{ backgroundColor: "rgba(0, 0, 0, 0.45)" }}
          onClick={() => {
            if (popupApprover === approver) setSendPopupOpen(false);
          }}
        >
          <div
            role="dialog"
            aria-modal="true"
            aria-label="Before you send"
            className="w-full max-w-md rounded-2xl border p-4"
            style={{
              borderColor: "var(--border)",
              backgroundColor: "var(--surface)",
            }}
            onClick={(e) => e.stopPropagation()}
          >
            <h3 className="text-base font-bold">Before you send</h3>
            <p className="mt-1 text-sm text-[var(--dim)]">
              These boxes are still unfilled:
            </p>
            <ul className="mt-2 flex list-disc flex-col gap-1 pl-5 text-sm font-semibold">
              {missingDivision && <li>Division</li>}
              {missingDoName && <li>Prepared by</li>}
              {missingApprover && <li>Approver</li>}
            </ul>
            {missingApprover ? (
              <>
                <p className="mt-2 text-sm">
                  An approver is required before sending — this one
                  can&rsquo;t be waived. The approver must be
                  different from the preparer who prepared the
                  requisition.
                </p>
                <label className="mt-2 flex flex-col gap-0.5 text-xs font-semibold text-[var(--dim)]">
                  Approver
                  <input
                    value={popupApprover}
                    aria-label="Approver name"
                    onChange={(e) => {
                      setPopupApprover(e.target.value);
                      setPopupError(null);
                    }}
                    placeholder="Approver's name"
                    className={fieldCls}
                    style={fieldStyle}
                    autoComplete="off"
                  />
                </label>
                {popupError && (
                  <p
                    role="alert"
                    className="mt-2 text-sm font-semibold text-[var(--red)]"
                  >
                    {popupError}
                  </p>
                )}
              </>
            ) : (
              <p className="mt-2 text-sm text-[var(--dim)]">
                You can go back and fill them in, or send anyway —
                the requisition goes out with them blank.
              </p>
            )}
            <div className="mt-3 flex flex-wrap gap-2">
              <button
                type="button"
                className="rounded-full px-4 py-2 text-sm font-bold"
                style={{
                  backgroundColor: "var(--surface-alt)",
                  color: "var(--text)",
                }}
                onClick={() => setSendPopupOpen(false)}
              >
                Go back
              </button>
              <button
                type="button"
                className="rounded-full px-4 py-2 text-sm font-bold"
                style={{
                  backgroundColor: "var(--accent)",
                  color: "var(--accent-text)",
                }}
                disabled={send.isPending || saveProfile.isPending}
                onClick={() => void confirmPopupSend()}
              >
                {missingApprover ? "Record approver & send" : "Send anyway"}
              </button>
            </div>
          </div>
        </div>
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

/** The in-app group label for items with no supplier on file.
    It is a grouping label ONLY (audit #8): it never appears in
    the outgoing email body — supplier-less items are listed
    there under their category groups instead. */
const NO_SUPPLIER_LABEL = "No supplier recorded";

function OrderEmailTab({
  business,
  items,
  rounds,
}: {
  business: BitBusiness;
  items: BitItem[];
  rounds: BitState["rounds"];
}) {
  // ONE par definition app-wide (Beta 0.02, audit #3): an item
  // needs ordering when it is at or below par AND a par is set
  // (par > 0) — the same rule the Requisition build list uses.
  const needItems = items.filter(
    (it) => it.onHand <= it.par && it.par > 0,
  );
  const [qtyEdits, setQtyEdits] = useState<Record<number, number>>({});
  const [to, setTo] = useState("");
  const [subjectEdit, setSubjectEdit] = useState<string | null>(null);
  const [bodyOverride, setBodyOverride] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  // Pre-send completeness popup (audit #8): opened by "Open in
  // email app" when the To field is empty or any item being
  // ordered has no supplier recorded.
  const [emailPopupOpen, setEmailPopupOpen] = useState(false);
  // Supplier groups collapse exactly like the category groups on
  // the Inventory tab: a set of the expanded group names, empty
  // (all collapsed) by default. View-only — the email body below
  // is computed from every group regardless of collapse state.
  const [expanded, setExpanded] = useState<Set<string>>(new Set());

  function toggleGroup(supplier: string) {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(supplier)) next.delete(supplier);
      else next.add(supplier);
      return next;
    });
  }

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
      const key = it.supplier?.trim() || NO_SUPPLIER_LABEL;
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
    // A line whose order quantity is 0 is omitted from the email
    // body (Beta 0.02, audit #3) — an item sitting exactly at par
    // needs nothing ordered. A group left with no lines is
    // omitted entirely, heading included.
    const lineFor = (it: BitItem): string | null => {
      const qty = qtyEdits[it.id] ?? suggestedOrderQty(it);
      if (qty <= 0) return null;
      return `  • ${it.name} — order ${qty} ${it.unit} (on hand: ${it.onHand}, par: ${it.par}${it.sku ? `, SKU ${it.sku}` : ""})`;
    };
    for (const g of groups) {
      if (g.supplier === NO_SUPPLIER_LABEL) {
        // "No supplier recorded" is an in-app grouping ONLY
        // (audit #8): the heading never appears in the email a
        // supplier reads. Supplier-less items are listed under
        // their category groups, with no supplier heading.
        const byCategory = new Map<string, string[]>();
        for (const it of g.items) {
          const line = lineFor(it);
          if (!line) continue;
          const list = byCategory.get(it.category);
          if (list) list.push(line);
          else byCategory.set(it.category, [line]);
        }
        for (const [category, itemLines] of byCategory) {
          lines.push(`${category}:`, ...itemLines, "");
        }
        continue;
      }
      const itemLines: string[] = [];
      for (const it of g.items) {
        const line = lineFor(it);
        if (line) itemLines.push(line);
      }
      if (itemLines.length === 0) continue;
      lines.push(`${g.supplier}:`, ...itemLines, "");
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

  // What the pre-send popup checks (audit #8): an empty recipient
  // and the items actually being ordered (quantity above 0) that
  // have no supplier recorded.
  const missingTo = to.trim() === "";
  const supplierlessOrdered = needItems.filter(
    (it) =>
      !it.supplier?.trim() &&
      (qtyEdits[it.id] ?? suggestedOrderQty(it)) > 0,
  );
  const emailIncomplete = missingTo || supplierlessOrdered.length > 0;

  /** The popup's "Send anyway": go ahead and open the email app
      with the mailto exactly as composed. */
  function sendEmailAnyway() {
    setEmailPopupOpen(false);
    window.location.href = mailto;
  }

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
        groups.map((g) => {
          const isOpen = expanded.has(g.supplier);
          return (
          <section key={g.supplier} aria-label={`Order from ${g.supplier}`}>
            <button
              type="button"
              aria-expanded={isOpen}
              onClick={() => toggleGroup(g.supplier)}
              className="flex w-full items-center gap-2 rounded-xl border-2 px-3 py-2 text-left"
              style={{
                borderColor: "var(--accent)",
                backgroundColor: "var(--accent-soft)",
              }}
            >
              {/* One header spec (Beta 0.05, audit #9): chevron on
                  the LEFT, item count in the title as "- X", no
                  right-side count. */}
              <Chevron collapsed={!isOpen} />
              <span className="min-w-0 flex-1 truncate font-bold">
                {g.supplier} - {g.items.length}
              </span>
            </button>
            {isOpen && (
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
            )}
          </section>
          );
        })
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
            onClick={(e) => {
              // Pre-send completeness (audit #8): anything
              // unfilled, the popup lists it before the email
              // app opens.
              if (emailIncomplete) {
                e.preventDefault();
                setEmailPopupOpen(true);
              }
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

      {/* Pre-send completeness popup (audit #8): an empty To field
          and any items with no supplier recorded are listed
          before the email goes out; both can be waived with
          "Send anyway". The popup holds no typed input, so its
          backdrop closes it freely. */}
      {emailPopupOpen && (
        <div
          className="fixed inset-0 z-50 flex items-end justify-center p-4 sm:items-center"
          style={{ backgroundColor: "rgba(0, 0, 0, 0.45)" }}
          onClick={() => setEmailPopupOpen(false)}
        >
          <div
            role="dialog"
            aria-modal="true"
            aria-label="Before you send"
            className="w-full max-w-md rounded-2xl border p-4"
            style={{
              borderColor: "var(--border)",
              backgroundColor: "var(--surface)",
            }}
            onClick={(e) => e.stopPropagation()}
          >
            <h3 className="text-base font-bold">Before you send</h3>
            <p className="mt-1 text-sm text-[var(--dim)]">
              Before this email goes out:
            </p>
            <ul className="mt-2 flex list-disc flex-col gap-1 pl-5 text-sm font-semibold">
              {missingTo && <li>The recipient (To) field is empty</li>}
              {supplierlessOrdered.length > 0 && (
                <li>
                  No supplier recorded for:{" "}
                  {supplierlessOrdered.map((it) => it.name).join(", ")}
                </li>
              )}
            </ul>
            <p className="mt-2 text-sm text-[var(--dim)]">
              You can go back and fill these in, or send anyway.
            </p>
            <div className="mt-3 flex flex-wrap gap-2">
              <button
                type="button"
                className="rounded-full px-4 py-2 text-sm font-bold"
                style={{
                  backgroundColor: "var(--surface-alt)",
                  color: "var(--text)",
                }}
                onClick={() => setEmailPopupOpen(false)}
              >
                Go back
              </button>
              <button
                type="button"
                className="rounded-full px-4 py-2 text-sm font-bold"
                style={{
                  backgroundColor: "var(--accent)",
                  color: "var(--accent-text)",
                }}
                onClick={sendEmailAnyway}
              >
                Send anyway
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

// ---- Analytics screen (Alpha 0.77) ----------------------------------
// Shown only for businesses with a stored analytics dataset
// (business.hasAnalytics — today The Daily Scoop's BIT Sim 01
// results), opened from the "Analytics" button beside Business
// setup. A timeframe showcase: exactly one timeframe is selected
// at a time, and every statistic, observation and suggestion is
// computed live from the stored monthly rows for that timeframe's
// months; nothing is hard-coded copy.

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

type BitTimeframe = "quarter" | "firstHalf" | "secondHalf" | "year";

/** "Dec 2025" -> "Dec". */
function monthShortName(label: string): string {
  return label.split(" ")[0] ?? label;
}

/** A month range for picker sublabels: "Sep – Nov 2026" when the
    months share a year, "Dec 2025 – Nov 2026" when they don't. */
function monthRangeLabel(months: BitAnalyticsMonth[]): string {
  const first = months[0];
  const last = months[months.length - 1];
  if (!first || !last) return "";
  if (first.monthKey === last.monthKey) return first.label;
  const sameYear = first.monthKey.slice(0, 4) === last.monthKey.slice(0, 4);
  return sameYear
    ? `${monthShortName(first.label)} – ${last.label}`
    : `${first.label} – ${last.label}`;
}

function AnalyticsTab({ business }: { business: BitBusiness }) {
  const analytics = useQuery({
    queryKey: ["bit-analytics", business.id],
    queryFn: () => api.getBitAnalytics({ businessId: business.id }),
  });
  const [timeframe, setTimeframe] = useState<BitTimeframe>("quarter");
  const rootRef = useRef<HTMLDivElement>(null);
  // Chart colours come from the app's theme tokens (the BIT blue
  // accent, axis greys), read off the rendered scope so the chart
  // follows light/dark mode.
  const [colors, setColors] = useState({
    accent: "#1e4f8a",
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
      dim: pick("--dim", "#46564c"),
      border: pick("--border", "#c9cfc9"),
    });
  }, [available]);

  const view = useMemo(() => {
    const data = analytics.data;
    if (!data || !data.available || data.months.length === 0) return null;
    const months = data.months;
    const latest = months[months.length - 1];
    if (!latest) return null;
    const latestYear = Number(latest.monthKey.slice(0, 4));
    const inYear = months.filter((m) =>
      m.monthKey.startsWith(`${latestYear}-`),
    );
    const firstHalf = inYear.filter((m) => m.monthKey.slice(5) <= "06");
    const secondHalf = inYear.filter((m) => m.monthKey.slice(5) >= "07");
    const defs: {
      id: BitTimeframe;
      title: string;
      sub: string;
      months: BitAnalyticsMonth[];
    }[] = [
      {
        id: "quarter",
        title: "Past Quarter",
        sub: monthRangeLabel(months.slice(-3)),
        months: months.slice(-3),
      },
      {
        id: "firstHalf",
        title: `1H ${latestYear}`,
        sub: monthRangeLabel(firstHalf),
        months: firstHalf,
      },
      {
        id: "secondHalf",
        title: `2H ${latestYear}`,
        sub:
          monthRangeLabel(secondHalf) +
          (secondHalf.length < 6
            ? ` · ${secondHalf.length} of 6 months`
            : ""),
        months: secondHalf,
      },
      {
        id: "year",
        title: "Past Year",
        sub: monthRangeLabel(months.slice(-12)),
        months: months.slice(-12),
      },
    ];
    const quarterDef = defs[0];
    let active = defs.find((d) => d.id === timeframe) ?? quarterDef;
    if (!active || active.months.length === 0) active = quarterDef;
    if (!active) return null;
    const tf = active.months;

    const sum = (f: (m: BitAnalyticsMonth) => number) =>
      tf.reduce((acc, m) => acc + f(m), 0);
    const revenue = sum((m) => m.revenue);
    const grossProfit = sum((m) => m.grossProfit);
    const netProfit = sum((m) => m.netProfit);
    const transactions = sum((m) => m.transactions);
    const units = sum((m) => m.unitsSold);
    const waste = sum((m) => m.wasteCost);
    const stockouts = sum((m) => m.stockoutEvents);
    const netMarginPct = revenue > 0 ? (netProfit / revenue) * 100 : 0;
    const grossMarginPct = revenue > 0 ? (grossProfit / revenue) * 100 : 0;
    const avgTicket = transactions > 0 ? revenue / transactions : 0;
    const wastePct = revenue > 0 ? (waste / revenue) * 100 : 0;
    const pct = (n: number) => `${n.toFixed(1)}%`;
    // Waste is a small share of revenue, so it keeps two decimals
    // (0.58% reads honestly where 0.6% would round it away).
    const pct2 = (n: number) => `${n.toFixed(2)}%`;

    const best = tf.reduce((a, m) => (m.revenue > a.revenue ? m : a));
    const weakest = tf.reduce((a, m) => (m.revenue < a.revenue ? m : a));
    const lossMonths = tf.filter((m) => m.netProfit < 0);
    const lossTotal = lossMonths.reduce((acc, m) => acc - m.netProfit, 0);
    const worstWaste = tf.reduce((a, m) =>
      m.wasteCost > a.wasteCost ? m : a,
    );
    const stockoutMonths = tf.filter((m) => m.stockoutEvents > 0);
    const monthNames = (list: BitAnalyticsMonth[]) =>
      list.map((m) => m.label).join(", ");

    // ---- Observations (priority order, first 5 that apply) ----
    const observations: string[] = [];
    // a. Strongest vs weakest month.
    observations.push(
      `${best.label} was the strongest month at ${fmtMoney(best.revenue)} — ${
        weakest.revenue > 0
          ? `${(best.revenue / weakest.revenue).toFixed(1)}× `
          : ""
      }${weakest.label}, the weakest at ${fmtMoney(weakest.revenue)}.`,
    );
    // b. Loss-making months.
    if (lossMonths.length > 0) {
      observations.push(
        `${lossMonths.length} month${lossMonths.length === 1 ? "" : "s"} lost money — ${monthNames(lossMonths)} — a combined loss of ${fmtMoney(lossTotal)}.`,
      );
    } else {
      const weakestNet = tf.reduce((a, m) =>
        m.netProfit < a.netProfit ? m : a,
      );
      observations.push(
        `Every month in this period was profitable — even the weakest, ${weakestNet.label}, made ${fmtMoney(weakestNet.netProfit)}.`,
      );
    }
    // c. Margin structure.
    const grossMargins = tf.map((m) =>
      m.revenue > 0 ? (m.grossProfit / m.revenue) * 100 : 0,
    );
    const netMargins = tf.map((m) =>
      m.revenue > 0 ? (m.netProfit / m.revenue) * 100 : 0,
    );
    observations.push(
      `Gross margin held in a narrow band (${pct(Math.min(...grossMargins))}–${pct(Math.max(...grossMargins))}) while net margin swung from ${pct(Math.min(...netMargins))} to ${pct(Math.max(...netMargins))} — profit here is volume-driven: the same product margins, spread over fixed costs.`,
    );
    // d. Waste.
    observations.push(
      `Waste cost ${fmtMoney(waste)} (${pct2(wastePct)} of revenue), worst in ${worstWaste.label} at ${fmtMoney(worstWaste.wasteCost)}.`,
    );
    // e. Stockouts. Every claim here is gated to the numbers
    // shown (Beta 0.05, audit #11): the timeframe's events are
    // counted from the timeframe itself, and dataset-wide figures
    // are labelled as dataset-wide in their own sentence — no
    // unconditional claims about when stockouts happen.
    if (stockouts > 0) {
      observations.push(
        `${stockouts} stockout event${stockouts === 1 ? "" : "s"} in this period, in ${stockoutMonths
          .map((m) => `${m.label} (${m.stockoutEvents})`)
          .join(", ")}.`,
      );
    } else if (data.stockoutEvents > 0) {
      observations.push(
        `No stockouts in this period. Across the full dataset there have been ${data.stockoutEvents} stockout event${data.stockoutEvents === 1 ? "" : "s"} in total.`,
      );
    }
    // f. Momentum.
    const firstMonth = tf[0];
    const lastMonth = tf[tf.length - 1];
    if (firstMonth && lastMonth && tf.length >= 2 && firstMonth.revenue > 0) {
      const change =
        ((lastMonth.revenue - firstMonth.revenue) / firstMonth.revenue) * 100;
      observations.push(
        `Revenue ${change >= 0 ? "grew" : "fell"} ${pct(Math.abs(change))} from ${firstMonth.label} (${fmtMoney(firstMonth.revenue)}) to ${lastMonth.label} (${fmtMoney(lastMonth.revenue)}) across the period.`,
      );
    }

    // ---- Suggestions (conditional rules, first 5 that apply) ----
    const suggestions: string[] = [];
    // a. Slow-month plan.
    if (lossMonths.length > 0) {
      suggestions.push(
        `Plan for the slow months: ${monthNames(lossMonths)} lost a combined ${fmtMoney(lossTotal)}. Lower pars, shorter hours or a trimmed slow-season menu in those months would cut the fixed-cost bleed.`,
      );
    }
    // b. Stockout pars. The timeframe count and the dataset-wide
    // lost-sales estimate stay in separate sentences, the
    // dataset figure labelled as dataset-wide (Beta 0.05, #11).
    if (stockouts > 0) {
      suggestions.push(
        `Raise pars on the peak-season sellers before the rush: ${stockouts} stockout event${stockouts === 1 ? "" : "s"} in ${monthNames(stockoutMonths)}. Across the full dataset, stockouts cost an estimated ${fmtMoney(data.lostRevenue)} in lost sales (${data.lostUnits.toLocaleString("en-CA")} units).`,
      );
    }
    // c. Waste tightening.
    if (wastePct >= 0.5) {
      if (active.id === "year" && data.tubWaste.length > 0) {
        suggestions.push(
          `Tighten slow-season pars: waste ran ${pct2(wastePct)} of revenue (${fmtMoney(waste)}). Across the full dataset, the biggest write-offs were ${data.tubWaste
            .map((w) => `${w.name} (${w.tubs.toFixed(2)} tubs)`)
            .join(", ")} — order those flavours lighter in the slow months.`,
        );
      } else {
        suggestions.push(
          `Tighten slow-season pars: waste ran ${pct2(wastePct)} of revenue (${fmtMoney(waste)}), worst in ${worstWaste.label} at ${fmtMoney(worstWaste.wasteCost)} — trim orders heading into the slow weeks.`,
        );
      }
    }
    // d. Peak preparation.
    const sortedRevenue = tf.map((m) => m.revenue).sort((a, b) => a - b);
    const mid = Math.floor(sortedRevenue.length / 2);
    const medianRevenue =
      sortedRevenue.length % 2 === 1
        ? (sortedRevenue[mid] ?? 0)
        : ((sortedRevenue[mid - 1] ?? 0) + (sortedRevenue[mid] ?? 0)) / 2;
    if (medianRevenue > 0 && best.revenue >= 2 * medianRevenue) {
      suggestions.push(
        `Set peak-season pars by the peak month, not the average month: ${best.label} brought in ${fmtMoney(best.revenue)}, ${(best.revenue / medianRevenue).toFixed(1)}× the typical month (${fmtMoney(medianRevenue)}).`,
      );
    }
    // e. Price lever.
    const tickets = tf.map((m) =>
      m.transactions > 0 ? m.revenue / m.transactions : 0,
    );
    const ticketSpread = Math.max(...tickets) - Math.min(...tickets);
    if (ticketSpread < 0.25) {
      suggestions.push(
        `The average ticket barely moved across the period (${fmtMoney(Math.min(...tickets))}–${fmtMoney(Math.max(...tickets))}), so a small price increase on the top sellers is the cleanest lever for the slow months — volume, not price, is what swings here.`,
      );
    }
    // f. Always-available fallback.
    suggestions.push(
      `Keep the weekly par-restock rhythm: it held waste to ${pct2(wastePct)} of revenue across ${transactions.toLocaleString("en-CA")} transactions in this period.`,
    );

    const chartMonths = tf.map((m) => ({
      ...m,
      short: monthShortName(m.label),
    }));

    return {
      data,
      defs,
      active,
      revenue,
      grossProfit,
      netProfit,
      transactions,
      units,
      waste,
      stockouts,
      netMarginPct,
      grossMarginPct,
      avgTicket,
      wastePct,
      pct,
      pct2,
      observations: observations.slice(0, 5),
      suggestions: suggestions.slice(0, 5),
      chartMonths,
      bestKey: best.monthKey,
    };
  }, [analytics.data, timeframe]);

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
          No analytics for this business yet. Analytics are built
          from a business&rsquo;s monthly sales results — revenue,
          profit, waste, and stockouts. Once a month of results is
          on file, the charts, observations, and suggestions appear
          here.
        </p>
      )}
      {view && (
        <>
          {/* Timeframe picker: single-select, one timeframe at a time */}
          <div
            className="grid grid-cols-2 gap-2"
            role="group"
            aria-label="Analytics timeframe"
          >
            {view.defs.map((d) => {
              const selected = d.id === view.active.id;
              return (
                <button
                  key={d.id}
                  type="button"
                  aria-pressed={selected}
                  onClick={() => setTimeframe(d.id)}
                  className="rounded-xl border-2 p-3 text-left"
                  style={
                    selected
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
                  <span className="block text-base font-bold">{d.title}</span>
                  <span className="block text-xs text-[var(--dim)]">
                    {d.sub}
                  </span>
                </button>
              );
            })}
          </div>
          <p className="text-sm text-[var(--dim)]">
            {view.data.label ?? "Analytics"}
            {view.data.periodLabel ? ` · ${view.data.periodLabel}` : ""}
          </p>

          {/* Statistics for the selected timeframe */}
          <div className="grid grid-cols-2 gap-2">
            {[
              {
                label: "Revenue",
                value: fmtMoney(view.revenue),
              },
              {
                label: "Net profit",
                value: fmtMoney(view.netProfit),
                sub: `Net margin ${view.pct(view.netMarginPct)}`,
                alert: view.netProfit < 0,
              },
              {
                label: "Gross margin",
                value: view.pct(view.grossMarginPct),
                sub: `Gross profit ${fmtMoney(view.grossProfit)}`,
              },
              {
                label: "Transactions",
                value: view.transactions.toLocaleString("en-CA"),
                sub: `Avg ticket ${fmtMoney(view.avgTicket)}`,
              },
              {
                label: "Units sold",
                value: view.units.toLocaleString("en-CA"),
              },
              {
                label: "Waste cost",
                value: fmtMoney(view.waste),
                sub: `${view.pct2(view.wastePct)} of revenue`,
              },
              {
                label: "Stockout events",
                value: String(view.stockouts),
                alert: view.stockouts > 0,
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
                {"sub" in card && card.sub && (
                  <p className="mt-0.5 text-xs text-[var(--dim)]">{card.sub}</p>
                )}
              </div>
            ))}
          </div>

          {/* Monthly revenue for the selected timeframe */}
          <AnalyticsPanel title="Revenue by month">
            <div style={{ width: "100%", height: 180 }}>
              <ResponsiveContainer>
                <BarChart
                  data={view.chartMonths}
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
                    {view.chartMonths.map((m) => (
                      <Cell
                        key={m.monthKey}
                        fill={colors.accent}
                        fillOpacity={m.monthKey === view.bestKey ? 1 : 0.45}
                      />
                    ))}
                  </Bar>
                </BarChart>
              </ResponsiveContainer>
            </div>
          </AnalyticsPanel>

          {/* Observations */}
          <AnalyticsPanel title="Observations">
            <ul className="flex list-disc flex-col gap-1.5 pl-5 text-sm">
              {view.observations.map((o) => (
                <li key={o}>{o}</li>
              ))}
            </ul>
          </AnalyticsPanel>

          {/* Suggestions */}
          <AnalyticsPanel title="Suggestions">
            <ul className="flex list-disc flex-col gap-1.5 pl-5 text-sm">
              {view.suggestions.map((s) => (
                <li key={s}>{s}</li>
              ))}
            </ul>
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
  // Add-only setup (Alpha 0.88): true while the "Add New Business"
  // flow at the bottom of the BIT view is open. There is no
  // re-run/edit mode for an existing business's setup anymore —
  // once a business is set up, its setup cannot be erased.
  const [addOpen, setAddOpen] = useState(false);
  // The active business (Alpha 0.69): null = the first business,
  // exactly the pre-switcher behaviour. Switching swaps every tab
  // — inventory, checks, order email, POS — to the chosen business.
  const [activeBusinessId, setActiveBusinessId] = useState<number | null>(
    null,
  );
  // Accessibility (audit #5, second half): the Primary vs
  // Connected settings page, shared with the household side —
  // opened from the settings drawer, it replaces the BIT content
  // while open. The policy covers BIT action types too, so it is
  // reachable from here as well as from HIT.
  const [policyOpen, setPolicyOpen] = useState(false);
  // Settings drawer: opened by the gear beside the BIT title; it
  // holds the Accessibility entry, the Switch to HIT control
  // (moved out of this strip and the business box), and the Undo
  // last action button under it (Beta 0.15).
  const [settingsOpen, setSettingsOpen] = useState(false);
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
  const showWizard = business == null || addOpen;

  return (
    <div className="bit-scope">
      {/* Header strip: the BIT title, enlarged to fill its row,
          with the settings gear beside it. The title flexes and
          truncates first — the gear is shrink-0 and is never
          crowded out. The gear opens the settings drawer from the
          left, which now holds the Accessibility entry, the
          Switch to HIT control (moved out of this strip and the
          business box), and the Undo last action button under
          Switch, so there is always exactly one way back
          to HIT, whatever state the business side is in. */}
      <div className="flex items-center gap-2 pt-2">
        <span
          className="min-w-0 flex-1 truncate text-base font-extrabold tracking-wide sm:text-xl"
          style={{ color: "var(--accent)" }}
        >
          BIT — BUSINESS INVENTORY TRACKER
        </span>
        <GearButton
          open={settingsOpen}
          onClick={() => setSettingsOpen(true)}
        />
      </div>

      <SettingsDrawer
        open={settingsOpen}
        onClose={() => setSettingsOpen(false)}
      >
        <SettingsDrawerItem
          label="Accessibility"
          onClick={() => {
            setSettingsOpen(false);
            setPolicyOpen(true);
          }}
        />
        <SettingsDrawerItem
          label="⇄ Switch to HIT"
          onClick={() => {
            setSettingsOpen(false);
            onSwitch();
          }}
        />
        {/* The app's one Undo (Beta 0.15), under Switch to:
            reverts the last action taken anywhere in the app.
            There are no per-record Undo buttons. */}
        <UndoLastActionItem />
      </SettingsDrawer>

      {policyOpen && (
        <AccountPolicy onClose={() => setPolicyOpen(false)} />
      )}

      {!policyOpen && state.isPending && (
        <p className="py-8 text-center text-sm text-[var(--dim)]">
          Loading the business side…
        </p>
      )}
      {!policyOpen && state.isError && (
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

      {!policyOpen && data && showWizard && (
        <BitSetupWizard
          // The wizard only ever creates a NEW business (first
          // run, or an additional one via "Add New Business"), so
          // it is never handed an existing business to prefill
          // from or target — existing setups stay untouched.
          business={null}
          businessId={null}
          scans={addOpen ? [] : data.scans}
          onDone={(newBusinessId) => {
            setAddOpen(false);
            // Land on the business just created; it also appears
            // in the business switcher alongside the existing
            // ones, which are completely untouched.
            setActiveBusinessId(newBusinessId);
          }}
          onCancel={business ? () => setAddOpen(false) : null}
          onDismissScan={(scan) => dismissScan.mutate(scan)}
        />
      )}

      {!policyOpen && data && business && !showWizard && (
        <>
          {/* The business box: the active business's name and
              stats, and its business switcher. (The switch control
              back to HIT lives in the settings drawer now.) */}
          <div
            className="mt-2 rounded-2xl border p-3"
            style={{
              borderColor: "var(--border)",
              backgroundColor: "var(--surface)",
            }}
          >
            <div className="flex items-start justify-between gap-2">
              <header className="min-w-0">
                <h2 className="truncate text-2xl font-bold">
                  {business.name}
                </h2>
                <p className="text-sm text-[var(--dim)]">
                  {typeLabel(business)} · {data.items.length} items ·{" "}
                  {
                    data.items.filter(
                      (i) =>
                        // ONE par definition app-wide (Beta 0.02,
                        // audit #3): an item needs ordering when it
                        // is at or below par AND a par is set
                        // (par > 0). No-par items (par 0 — e.g. the
                        // catalogue group) never count.
                        i.onHand <= i.par && i.par > 0,
                    ).length
                  }{" "}
                  at or below par
                </p>
              </header>
            </div>
            {data.businesses.length > 1 && (
              <div className="mt-2 flex items-center gap-2">
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
                    setAddOpen(false);
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
          </div>

          <nav aria-label="Business tracker" className="pt-2">
            <div
              className="flex rounded-full p-1"
              style={{ backgroundColor: "var(--surface)" }}
              role="group"
            >
              {BIT_TABS.map((t) => {
                const badge =
                  t.id === "order"
                    ? data.items.filter(
                        // Same one par definition as the business-box
                        // subtitle (Beta 0.02, audit #3): at or below
                        // par with a par set (par > 0).
                        (i) => i.onHand <= i.par && i.par > 0,
                      ).length
                    : 0;
                // Requisition businesses call the third tab
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
                    className="min-w-0 flex-1 truncate rounded-full px-0.5 py-2 text-[12px] font-bold"
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
          <div className="flex items-center justify-between gap-2 pt-1">
            {business.hasAnalytics ? (
              <button
                type="button"
                aria-pressed={tab === "analytics"}
                onClick={() => setTab("analytics")}
                className="rounded-full px-4 py-2 text-sm font-bold"
                style={{
                  backgroundColor: "var(--accent)",
                  color: "var(--accent-text)",
                  ...(tab === "analytics"
                    ? {
                        boxShadow:
                          "0 0 0 2px var(--bg), 0 0 0 4.5px var(--accent)",
                      }
                    : {}),
                }}
              >
                Analytics
              </button>
            ) : (
              <span />
            )}
          </div>

          {tab === "rounds" && (
            <RoundsTab
              business={business}
              items={data.items}
              rounds={data.rounds}
              resubmittedLines={data.resubmittedLines}
              draftExtras={data.draftExtras}
            />
          )}
          {tab === "inventory" && (
            <InventoryTab
              business={business}
              items={data.items}
              rounds={data.rounds}
              scans={data.scans}
              wasteLog={data.wasteLog}
              stockEvents={data.stockEvents}
              manifestImports={data.manifestImports}
              onDismissScan={(scan) => dismissScan.mutate(scan)}
            />
          )}
          {tab === "analytics" && business.hasAnalytics && (
            <AnalyticsTab business={business} />
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

          {/* Add New Business (Alpha 0.88): the very last element
              of the BIT view, below every tab's content. It opens
              the setup wizard in add-only mode — finishing adds a
              new business alongside the existing ones; there is
              no way to erase or reset an existing business's
              setup. Sized a touch smaller than the old "Business
              setup" button it replaces, with its text at the
              app's 12px floor (audit #10). */}
          <div className="flex justify-center pt-8 pb-2">
            <button
              type="button"
              onClick={() => setAddOpen(true)}
              className="font-bold"
              style={{
                color: "var(--accent)",
                fontSize: "12px",
                lineHeight: "16.2px",
                padding: "7.2px 14.4px",
              }}
            >
              Add New Business
            </button>
          </div>
        </>
      )}
    </div>
  );
}
