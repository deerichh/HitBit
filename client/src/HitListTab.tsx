import { useEffect, useMemo, useRef, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api, type ApiResponse } from "./api";
import { RefreshProgress } from "./RefreshProgress";

type HitData = ApiResponse<typeof api, "getHitList">;
type HitItem = HitData["items"][number];
type PriceInfo = NonNullable<HitItem["priceInfo"]>;

// Category accents, cycled in sheet order (Kitchen Cleaning, Kitchen
// Cooking, Gen Cleaning, Outdoors, Freezer, Misc., then anything new)
// through the ONE unified category palette (theme.css --cat-1..6):
// six capped, muted slots shared with the business side, which
// re-declares the same slots hue-shifted to blue. A category's name
// in text always accompanies its colour.
const CATEGORY_SLOTS = 6;

function categorySlot(index: number): number {
  return (index % CATEGORY_SLOTS) + 1;
}

function categoryHue(index: number): string {
  return `var(--cat-${categorySlot(index)}-dot)`;
}

function categorySoft(index: number): string {
  return `var(--cat-${categorySlot(index)}-bg)`;
}

function categoryText(index: number): string {
  return `var(--cat-${categorySlot(index)}-fg)`;
}

function stockPill(stock: number) {
  // The box always reads "Stock: X" — only the colours change with
  // the level: red at 0, amber at 1, and at 2+ the accent tint
  // returned here is the fallback — the item row overrides it with
  // the item's CATEGORY colours (categorySoft / categoryText), so in
  // the list a 2+ box wears its category's colour.
  if (stock === 0)
    return {
      label: `Stock: ${stock}`,
      style: { backgroundColor: "var(--red-soft)", color: "var(--red)" },
    };
  if (stock === 1)
    return {
      label: `Stock: ${stock}`,
      style: {
        backgroundColor: "var(--amber-soft)",
        color: "var(--amber)",
      },
    };
  return {
    label: `Stock: ${stock}`,
    style: {
      backgroundColor: "var(--accent-soft)",
      color: "var(--accent)",
    },
  };
}

// Item names that fit the single-line row keep the standard 14px;
// longer names step down in size so the FULL name shows instead of
// being ellipsized (e.g. "Jamaican Beef Patties").
function nameFontSize(name: string): number {
  const len = name.length;
  if (len <= 16) return 14;
  if (len <= 20) return 13;
  if (len <= 24) return 12;
  if (len <= 28) return 11;
  return 10.5;
}

function formatSynced(iso: string | null): string {
  if (!iso) return "Not synced yet";
  const d = new Date(iso);
  return `Synced ${d.toLocaleDateString("en-CA", {
    month: "short",
    day: "numeric",
  })} · ${d.toLocaleTimeString("en-CA", {
    hour: "numeric",
    minute: "2-digit",
  })}`;
}

function formatMoney(cents: number): string {
  return `$${(cents / 100).toFixed(2)}`;
}

/**
 * Whole days from today (local) until an expiry date key
 * ("YYYY-MM-DD"): negative when the date has passed, 0 for today.
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

/**
 * The compact "use soon" chip for a HIT row: shown ONLY when an
 * expiry is set and is within 3 days or already past — amber within
 * 3 days, red when past. Items without a near expiry get no chip and
 * their row looks exactly as it always has.
 */
function expiryChip(
  expiry: string | null,
): { label: string; style: { backgroundColor: string; color: string } } | null {
  if (!expiry) return null;
  const days = daysUntilExpiry(expiry);
  if (days < 0) {
    return {
      label: "⚠ expired",
      style: { backgroundColor: "var(--red-soft)", color: "var(--red)" },
    };
  }
  if (days <= 3) {
    return {
      label: `⚠ ${days}d`,
      style: {
        backgroundColor: "var(--amber-soft)",
        color: "var(--amber)",
      },
    };
  }
  return null;
}

/** "2026-11-20" -> "Nov 20, 2026" for the Expiring soon panel. */
function formatExpiryDate(dateKey: string): string {
  const [y = 1970, m = 1, d = 1] = dateKey.split("-").map(Number);
  return new Date(y, m - 1, d).toLocaleDateString("en-CA", {
    month: "short",
    day: "numeric",
    year: "numeric",
  });
}

const recheckButtonClass =
  "rounded-full px-2.5 py-0.5 text-[13px] font-bold disabled:opacity-50";

function PriceInfoBlock({
  itemName,
  info,
}: {
  itemName: string;
  info: PriceInfo;
}) {
  const queryClient = useQueryClient();
  const recheck = useMutation({
    mutationFn: async () => await api.recheckItemPrice({ item: itemName }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["hit"] });
    },
  });

  if (info.status === "pending") {
    return (
      <p className="mt-1 text-xs text-[var(--dim)]">
        Price check running — searching this week&rsquo;s flyers and store
        sites…
      </p>
    );
  }

  if (info.status === "failed") {
    return (
      <div className="mt-1 flex flex-wrap items-center gap-2">
        <p className="text-xs" style={{ color: "var(--red)" }}>
          The price check didn&rsquo;t finish.
        </p>
        <button
          type="button"
          aria-label={`Run the price check for ${itemName} again`}
          onClick={() => recheck.mutate()}
          disabled={recheck.isPending}
          className={recheckButtonClass}
          style={{
            backgroundColor: "var(--surface-alt)",
            color: "var(--accent)",
            border: "1px solid var(--accent)",
          }}
        >
          Check again
        </button>
      </div>
    );
  }

  return (
    <div className="mt-1">
      {info.salePriceCents != null ? (
        <p
          className="text-xs font-semibold"
          style={{ color: "var(--ok-text)" }}
        >
          On sale {formatMoney(info.salePriceCents)}
          {info.saleStore ? ` at ${info.saleStore}` : ""}
          {info.saleEnd ? ` · ${info.saleEnd}` : ""}
        </p>
      ) : info.regularPriceCents != null ? (
        <p className="text-xs text-[var(--text)]">
          Regular price {formatMoney(info.regularPriceCents)}
          {info.regularStore ? ` at ${info.regularStore}` : ""}
        </p>
      ) : (
        <p className="text-xs text-[var(--dim)]">No current price found.</p>
      )}
      {info.altName && info.altPriceCents != null && (
        <p className="mt-0.5 text-xs text-[var(--dim)]">
          Cheaper alternative: {info.altName} —{" "}
          {formatMoney(info.altPriceCents)}
          {info.altStore ? ` at ${info.altStore}` : ""}
        </p>
      )}
      {info.note && (
        <p className="mt-0.5 text-xs text-[var(--dim)]">{info.note}</p>
      )}
      <button
        type="button"
        aria-label={`Recheck prices for ${itemName}`}
        onClick={() => recheck.mutate()}
        disabled={recheck.isPending}
        className={`${recheckButtonClass} mt-1`}
        style={{
          backgroundColor: "var(--surface-alt)",
          color: "var(--accent)",
          border: "1px solid var(--border)",
        }}
      >
        {recheck.isPending ? "Starting…" : "Recheck prices"}
      </button>
    </div>
  );
}

const NEW_OPTION = "__new__";

const fieldLabelClass =
  "block text-xs font-bold uppercase tracking-wide text-[var(--dim)]";
const fieldInputClass =
  "mt-1 w-full rounded-xl px-3 py-2 text-sm text-[var(--text)]";
const fieldInputStyle = {
  backgroundColor: "var(--surface)",
  border: "1px solid var(--border)",
} as const;

function AddItemForm({
  categories,
  stores,
  onClose,
  onAdded,
}: {
  categories: string[];
  stores: string[];
  onClose: () => void;
  onAdded: (category: string) => void;
}) {
  const queryClient = useQueryClient();
  const [categoryChoice, setCategoryChoice] = useState(
    categories[0] ?? NEW_OPTION,
  );
  const [newCategory, setNewCategory] = useState("");
  const [itemName, setItemName] = useState("");
  const [stockText, setStockText] = useState("1");
  const [storeChoice, setStoreChoice] = useState(stores[0] ?? NEW_OPTION);
  const [newStore, setNewStore] = useState("");
  const [formalName, setFormalName] = useState("");
  const [sku, setSku] = useState("");
  const [error, setError] = useState<string | null>(null);

  // ---- Barcode scan-to-add -----------------------------------------
  // A scanned or typed code fills the SKU field and is looked up:
  // a code that matches an item already on the list surfaces that
  // item (with a stock bump instead of a duplicate add); a code that
  // resolves to a product pre-fills the formal name; an unresolved
  // code still lands in the SKU field for a manual name. A scan
  // never saves anything by itself.
  type ScanState =
    | { kind: "pending"; code: string }
    | { kind: "existing"; item: string }
    | { kind: "found"; formalName: string }
    | { kind: "unresolved" }
    | { kind: "failed"; message: string };
  const [barcode, setBarcode] = useState("");
  const [scan, setScan] = useState<ScanState | null>(null);
  const [bumped, setBumped] = useState(false);
  const [cameraOn, setCameraOn] = useState(false);
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const detectTimerRef = useRef<number | null>(null);

  const lookup = useMutation({
    mutationFn: async (code: string) =>
      await api.lookupBarcode({ code }),
    onSuccess: (res) => {
      setSku(res.code);
      setBumped(false);
      if (res.outcome === "existing") {
        setScan({ kind: "existing", item: res.matchedItem ?? "" });
      } else {
        setScan({ kind: "pending", code: res.code });
      }
    },
    onError: () =>
      setScan({
        kind: "failed",
        message: "The lookup couldn't start — the code is in the SKU field either way.",
      }),
  });

  const pendingCode = scan?.kind === "pending" ? scan.code : null;
  const barcodeResult = useQuery({
    queryKey: ["barcode", pendingCode],
    queryFn: () => api.getBarcodeLookup({ code: pendingCode ?? "" }),
    enabled: pendingCode != null,
    refetchInterval: (q) =>
      q.state.data?.status === "pending" ? 3000 : false,
  });
  useEffect(() => {
    if (!pendingCode || !barcodeResult.data) return;
    const d = barcodeResult.data;
    if (d.status === "done") {
      if (d.matchedItem) {
        // The resolved product name-matches an item already on the
        // HIT List (sheet items included): offer the stock bump
        // instead of a duplicate add.
        setScan({ kind: "existing", item: d.matchedItem });
      } else if (d.formalName) {
        setFormalName(d.formalName);
        setScan({ kind: "found", formalName: d.formalName });
      } else {
        setScan({ kind: "unresolved" });
      }
    } else if (d.status === "failed") {
      setScan({
        kind: "failed",
        message:
          d.note ??
          "The lookup didn't finish — the code is in the SKU field either way.",
      });
    }
  }, [pendingCode, barcodeResult.data]);

  const bumpExisting = useMutation({
    mutationFn: async (item: string) =>
      await api.adjustStock({ item, delta: 1 }),
    onSuccess: () => {
      setBumped(true);
      queryClient.invalidateQueries({ queryKey: ["hit"] });
    },
  });

  const stopCamera = () => {
    if (detectTimerRef.current != null) {
      window.clearInterval(detectTimerRef.current);
      detectTimerRef.current = null;
    }
    streamRef.current?.getTracks().forEach((t) => t.stop());
    streamRef.current = null;
    setCameraOn(false);
  };
  useEffect(() => stopCamera, []);

  const startCamera = async () => {
    type Detector = new () => {
      detect: (
        source: HTMLVideoElement,
      ) => Promise<{ rawValue?: string }[]>;
    };
    const BarcodeDetectorCtor = (
      window as unknown as { BarcodeDetector?: Detector }
    ).BarcodeDetector;
    if (!BarcodeDetectorCtor || !navigator.mediaDevices?.getUserMedia) {
      setScan({
        kind: "failed",
        message:
          "Camera scanning isn't available here — type or paste the code instead.",
      });
      return;
    }
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        video: { facingMode: "environment" },
      });
      streamRef.current = stream;
      setCameraOn(true);
      window.requestAnimationFrame(() => {
        void (async () => {
          const video = videoRef.current;
          if (!video) {
            stopCamera();
            return;
          }
          video.srcObject = stream;
          await video.play().catch(() => undefined);
          const detector = new BarcodeDetectorCtor();
          detectTimerRef.current = window.setInterval(() => {
            void (async () => {
              try {
                const codes = await detector.detect(video);
                const code = codes[0]?.rawValue;
                if (code) {
                  stopCamera();
                  setBarcode(code);
                  lookup.mutate(code);
                }
              } catch {
                // Keep trying on the next tick.
              }
            })();
          }, 400);
        })();
      });
    } catch {
      setScan({
        kind: "failed",
        message:
          "The camera couldn't be opened — type or paste the code instead.",
      });
    }
  };

  const category =
    categoryChoice === NEW_OPTION ? newCategory.trim() : categoryChoice;
  const store = storeChoice === NEW_OPTION ? newStore.trim() : storeChoice;
  const stock = Number(stockText);
  const valid =
    category.length > 0 &&
    itemName.trim().length > 0 &&
    store.length > 0 &&
    stockText.trim() !== "" &&
    Number.isInteger(stock) &&
    stock >= 0 &&
    stock <= 9999;

  const add = useMutation({
    mutationFn: async () =>
      await api.addHitItem({
        category,
        item: itemName.trim(),
        stock,
        store,
        formalName: formalName.trim() ? formalName.trim() : null,
        sku: sku.trim() ? sku.trim() : null,
      }),
    onSuccess: (res) => {
      if (res.ok) {
        queryClient.invalidateQueries({ queryKey: ["hit"] });
        onAdded(category);
      } else {
        setError(res.error ?? "That item couldn't be added.");
      }
    },
    onError: () => setError("That item couldn't be added. Try again."),
  });

  return (
    <form
      className="mt-2 rounded-2xl px-4 py-4"
      style={{
        backgroundColor: "var(--surface)",
        border: "1px solid var(--border)",
      }}
      onSubmit={(e) => {
        e.preventDefault();
        if (valid && !add.isPending) add.mutate();
      }}
    >
      <div className="flex items-center justify-between gap-3">
        <h2 className="text-base font-bold text-[var(--text)]">
          Add an item
        </h2>
        <button
          type="button"
          aria-label="Cancel adding an item"
          onClick={onClose}
          className="rounded-full px-3 py-1 text-sm font-bold text-[var(--dim)]"
        >
          Cancel
        </button>
      </div>

      <div
        className="mt-3 rounded-xl px-3 py-3"
        style={{ backgroundColor: "var(--surface-alt)" }}
      >
        <p className={fieldLabelClass}>Scan a barcode</p>
        <div className="mt-2 flex flex-wrap gap-2">
          <input
            type="text"
            inputMode="numeric"
            value={barcode}
            onChange={(e) => setBarcode(e.target.value)}
            placeholder="Barcode / UPC"
            aria-label="Barcode or UPC code"
            className="min-w-40 flex-1 rounded-xl px-3 py-2 text-sm text-[var(--text)]"
            style={fieldInputStyle}
          />
          <button
            type="button"
            onClick={() => {
              const code = barcode.trim();
              if (code) lookup.mutate(code);
            }}
            disabled={!barcode.trim() || lookup.isPending}
            className="rounded-full px-4 py-1 text-sm font-bold disabled:opacity-50"
            style={{
              backgroundColor: "var(--surface)",
              color: "var(--accent)",
              border: "1.5px solid var(--accent)",
            }}
          >
            {lookup.isPending ? "Looking up…" : "Look up"}
          </button>
          <button
            type="button"
            aria-label={cameraOn ? "Stop the barcode camera" : "Scan a barcode with the camera"}
            onClick={() => (cameraOn ? stopCamera() : void startCamera())}
            className="rounded-full px-4 py-1 text-sm font-bold"
            style={{
              backgroundColor: "var(--surface)",
              color: "var(--accent)",
              border: "1.5px solid var(--accent)",
            }}
          >
            {cameraOn ? "Stop camera" : "Scan with camera"}
          </button>
        </div>
        {cameraOn && (
          <video
            ref={videoRef}
            muted
            playsInline
            aria-label="Barcode camera view — hold the barcode in front of the camera"
            className="mt-2 w-full rounded-xl"
          />
        )}
        {scan?.kind === "pending" && (
          <p className="mt-2 text-xs text-[var(--dim)]">
            Looking that code up…
          </p>
        )}
        {scan?.kind === "found" && (
          <p className="mt-2 text-xs font-semibold" style={{ color: "var(--ok-text)" }}>
            Found: {scan.formalName} — filled in below. Check it over,
            then add.
          </p>
        )}
        {scan?.kind === "unresolved" && (
          <p className="mt-2 text-xs text-[var(--dim)]">
            That code didn&rsquo;t match a known product. It&rsquo;s in
            the SKU field — just name the item below.
          </p>
        )}
        {scan?.kind === "existing" && (
          <div className="mt-2 flex flex-wrap items-center gap-2">
            <p className="text-xs text-[var(--text)]">
              That code is <strong>{scan.item}</strong> — already on
              the HIT List.
            </p>
            {bumped ? (
              <p className="text-xs font-semibold" style={{ color: "var(--ok-text)" }}>
                Added 1 to its stock.
              </p>
            ) : (
              <button
                type="button"
                aria-label={`Add one to the stock of ${scan.item} instead of adding a duplicate`}
                disabled={bumpExisting.isPending}
                onClick={() => bumpExisting.mutate(scan.item)}
                className="rounded-full px-3 py-0.5 text-xs font-bold disabled:opacity-50"
                style={{
                  backgroundColor: "var(--accent)",
                  color: "var(--accent-text)",
                }}
              >
                Add 1 to its stock instead
              </button>
            )}
          </div>
        )}
        {scan?.kind === "failed" && (
          <p className="mt-2 text-xs" style={{ color: "var(--red)" }}>
            {scan.message}
          </p>
        )}
      </div>

      <div className="mt-3 grid grid-cols-1 gap-3 sm:grid-cols-2">
        <div>
          <label htmlFor="add-category" className={fieldLabelClass}>
            Category
          </label>
          <select
            id="add-category"
            value={categoryChoice}
            onChange={(e) => setCategoryChoice(e.target.value)}
            className={fieldInputClass}
            style={fieldInputStyle}
          >
            {categories.map((c) => (
              <option key={c} value={c}>
                {c}
              </option>
            ))}
            <option value={NEW_OPTION}>New category…</option>
          </select>
          {categoryChoice === NEW_OPTION && (
            <input
              type="text"
              value={newCategory}
              onChange={(e) => setNewCategory(e.target.value)}
              placeholder="Category name"
              aria-label="New category name"
              className={`${fieldInputClass} mt-2`}
              style={fieldInputStyle}
            />
          )}
        </div>

        <div>
          <label htmlFor="add-item" className={fieldLabelClass}>
            Item name
          </label>
          <input
            id="add-item"
            type="text"
            value={itemName}
            onChange={(e) => setItemName(e.target.value)}
            placeholder="e.g. Dish Soap"
            className={fieldInputClass}
            style={fieldInputStyle}
          />
        </div>

        <div>
          <label htmlFor="add-stock" className={fieldLabelClass}>
            Stock count
          </label>
          <input
            id="add-stock"
            type="number"
            inputMode="numeric"
            min={0}
            max={9999}
            step={1}
            value={stockText}
            onChange={(e) => setStockText(e.target.value)}
            className={fieldInputClass}
            style={fieldInputStyle}
          />
        </div>

        <div>
          <label htmlFor="add-store" className={fieldLabelClass}>
            Store
          </label>
          <select
            id="add-store"
            value={storeChoice}
            onChange={(e) => setStoreChoice(e.target.value)}
            className={fieldInputClass}
            style={fieldInputStyle}
          >
            {stores.map((s) => (
              <option key={s} value={s}>
                {s}
              </option>
            ))}
            <option value={NEW_OPTION}>Another store…</option>
          </select>
          {storeChoice === NEW_OPTION && (
            <input
              type="text"
              value={newStore}
              onChange={(e) => setNewStore(e.target.value)}
              placeholder="Store name"
              aria-label="Other store name"
              className={`${fieldInputClass} mt-2`}
              style={fieldInputStyle}
            />
          )}
        </div>

        <div>
          <label htmlFor="add-formal" className={fieldLabelClass}>
            Formal item name <span className="normal-case">(optional)</span>
          </label>
          <input
            id="add-formal"
            type="text"
            value={formalName}
            onChange={(e) => setFormalName(e.target.value)}
            placeholder="Full product name, brand & size"
            className={fieldInputClass}
            style={fieldInputStyle}
          />
        </div>

        <div>
          <label htmlFor="add-sku" className={fieldLabelClass}>
            SKU <span className="normal-case">(if available)</span>
          </label>
          <input
            id="add-sku"
            type="text"
            value={sku}
            onChange={(e) => setSku(e.target.value)}
            placeholder="Store SKU / item number"
            className={fieldInputClass}
            style={fieldInputStyle}
          />
        </div>
      </div>

      {error && (
        <p className="mt-3 text-sm" style={{ color: "var(--red)" }}>
          {error}
        </p>
      )}

      <button
        type="submit"
        disabled={!valid || add.isPending}
        className="mt-4 w-full rounded-full py-2 text-sm font-bold disabled:opacity-50"
        style={{
          backgroundColor: "var(--accent)",
          color: "var(--accent-text)",
        }}
      >
        {add.isPending ? "Adding…" : "Add to HIT List"}
      </button>
      <p className="mt-2 text-center text-xs text-[var(--dim)]">
        The item appears right away, a price check starts automatically,
        and the add is queued for the sync updates to Vanessa&rsquo;s app.
      </p>
    </form>
  );
}

function fractionBoxStyle(inStock: number, total: number) {
  const pct = total > 0 ? (inStock / total) * 100 : 0;
  if (pct >= 75) {
    return {
      backgroundColor: "var(--ok-bg)",
      color: "var(--ok-text)",
      border: "1px solid var(--ok-text)",
    };
  }
  if (pct >= 25) {
    return {
      backgroundColor: "var(--amber-soft)",
      color: "var(--amber)",
      border: "1px solid var(--amber)",
    };
  }
  return {
    backgroundColor: "var(--red-soft)",
    color: "var(--red)",
    border: "1px solid var(--red)",
  };
}

export function HitListTab() {
  const [query, setQuery] = useState("");
  const [showLowOnly, setShowLowOnly] = useState(false);
  const [showForm, setShowForm] = useState(false);
  const [refreshingSince, setRefreshingSince] = useState<string | null>(null);
  const [refreshFailed, setRefreshFailed] = useState(false);
  // When the in-flight refresh started, for the timeout below.
  const refreshStartedAtRef = useRef<number | null>(null);
  // Categories start collapsed; this set holds the ones the user has
  // manually expanded. While a search is active, any category with a
  // matching item is force-expanded regardless of this set.
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [activityOpen, setActivityOpen] = useState(false);
  const [expiringOpen, setExpiringOpen] = useState(false);
  // Stocktake mode: while on, each row shows an editable counted
  // value (drafts keyed by item name, seeded from effective stock
  // when the mode starts). "editing" shows the rows; "review" shows
  // the differences-only summary before anything is recorded.
  const [stocktakeOn, setStocktakeOn] = useState(false);
  const [stocktakeStage, setStocktakeStage] = useState<
    "editing" | "review"
  >("editing");
  const [counts, setCounts] = useState<Record<string, number>>({});
  const [stocktakeError, setStocktakeError] = useState<string | null>(
    null,
  );
  // Stocktake is part of Refresh now: when a refresh started from
  // the Refresh button completes successfully, this counter bumps
  // and an effect below starts the stocktake, seeded from the
  // freshly refreshed stock. A timed-out / failed refresh never
  // bumps it, so no stocktake opens on failure.
  const [stocktakeKick, setStocktakeKick] = useState(0);
  // Add-expiry row in the Expiring soon panel.
  const [newExpiryItem, setNewExpiryItem] = useState("");
  const [newExpiryDate, setNewExpiryDate] = useState("");

  const toggleCategory = (category: string) => {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(category)) {
        next.delete(category);
      } else {
        next.add(category);
      }
      return next;
    });
  };

  const hit = useQuery({
    queryKey: ["hit"],
    queryFn: () => api.getHitList({}),
    // Poll while a sheet refresh is in flight, and while any added
    // item's automatic price check is still running.
    refetchInterval: (queryArg) => {
      const pricePending = (queryArg.state.data?.items ?? []).some(
        (i) => i.priceInfo?.status === "pending",
      );
      return refreshingSince || pricePending ? 4000 : false;
    },
  });

  const refreshedAt = hit.data?.refreshedAt ?? null;
  useEffect(() => {
    if (refreshingSince && refreshedAt && refreshedAt !== refreshingSince) {
      setRefreshingSince(null);
      refreshStartedAtRef.current = null;
      // The refresh landed: flow straight into a stocktake.
      setStocktakeKick((k) => k + 1);
    }
  }, [refreshingSince, refreshedAt]);

  // A background refresh that never lands (the task failed, or the
  // sheet read stalled) must not spin "Refreshing…" forever: after
  // ~75 seconds the refreshing state ends with a plain failure note.
  useEffect(() => {
    if (!refreshingSince) return;
    const startedAt = refreshStartedAtRef.current ?? Date.now();
    const remaining = Math.max(0, 75_000 - (Date.now() - startedAt));
    const timer = window.setTimeout(() => {
      setRefreshingSince(null);
      refreshStartedAtRef.current = null;
      setRefreshFailed(true);
    }, remaining);
    return () => window.clearTimeout(timer);
  }, [refreshingSince]);

  const refresh = useMutation({
    mutationFn: async () => await api.refreshHitList({}),
    onSuccess: (res) => {
      if (res.started) {
        refreshStartedAtRef.current = Date.now();
        setRefreshFailed(false);
        setRefreshingSince(refreshedAt ?? "pending");
      }
    },
  });

  const queryClient = useQueryClient();
  // Quick stock +/−: changes the effective count here right away and
  // records a pending adjustment for the auto-scan to write to the
  // sheet.
  const adjust = useMutation({
    mutationFn: async (args: { item: string; delta: number }) =>
      await api.adjustStock(args),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["hit"] });
      queryClient.invalidateQueries({ queryKey: ["planner"] });
    },
  });
  // Sale-watch stars: watched items get sale-checked regardless of
  // stock, and show a ★ marker when they land on the Shopping List
  // on sale.
  const toggleWatch = useMutation({
    mutationFn: async (args: { item: string; watched: boolean }) =>
      await api.toggleItemWatch(args),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["hit"] });
      queryClient.invalidateQueries({ queryKey: ["list"] });
    },
  });

  const activity = useQuery({
    queryKey: ["activity"],
    queryFn: () => api.getActivityLog({}),
  });
  const undoUsage = useMutation({
    mutationFn: async (id: number) => await api.undoUsage({ id }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["usage"] });
      queryClient.invalidateQueries({ queryKey: ["activity"] });
      queryClient.invalidateQueries({ queryKey: ["hit"] });
      queryClient.invalidateQueries({ queryKey: ["planner"] });
    },
  });
  const undoPurchase = useMutation({
    mutationFn: async (id: number) => await api.undoPurchase({ id }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["activity"] });
      queryClient.invalidateQueries({ queryKey: ["hit"] });
      queryClient.invalidateQueries({ queryKey: ["list"] });
      queryClient.invalidateQueries({ queryKey: ["planner"] });
    },
  });
  // Stocktake confirm: records the differences as pending stock
  // adjustments (source "stocktake") for the auto-scan to apply.
  const recordStocktake = useMutation({
    mutationFn: async (diffs: { item: string; counted: number }[]) =>
      await api.recordStocktake({ counts: diffs }),
    onSuccess: (res) => {
      if (res.ok) {
        setStocktakeOn(false);
        setStocktakeStage("editing");
        setCounts({});
        setStocktakeError(null);
        queryClient.invalidateQueries({ queryKey: ["hit"] });
        queryClient.invalidateQueries({ queryKey: ["planner"] });
        queryClient.invalidateQueries({ queryKey: ["activity"] });
      } else {
        setStocktakeError(
          res.error ?? "The stocktake couldn't be recorded.",
        );
      }
    },
    onError: () =>
      setStocktakeError("The stocktake couldn't be recorded. Try again."),
  });
  const setExpiry = useMutation({
    mutationFn: async (args: { item: string; date: string | null }) =>
      await api.setItemExpiry(args),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["hit"] });
    },
  });

  const allItems = hit.data?.items ?? [];
  const formCategories = useMemo(
    () => [...new Set(allItems.map((i) => i.category))].filter(Boolean),
    [allItems],
  );
  const formStores = useMemo(
    () =>
      [...new Set(allItems.map((i) => i.store))].filter(Boolean).sort(),
    [allItems],
  );
  const q = query.trim().toLowerCase();
  const filtered = allItems.filter((i) => {
    if (showLowOnly && i.stock > 1) return false;
    if (q && !i.item.toLowerCase().includes(q)) return false;
    return true;
  });

  const groups = useMemo(() => {
    const order: string[] = [];
    const byCategory = new Map<string, HitItem[]>();
    for (const item of allItems) {
      if (!byCategory.has(item.category)) {
        byCategory.set(item.category, []);
        order.push(item.category);
      }
    }
    for (const item of filtered) {
      byCategory.get(item.category)?.push(item);
    }
    return order
      .map((category, index) => {
        const catAll = allItems.filter((i) => i.category === category);
        const totalInCat = catAll.length;
        const inStockInCat = catAll.filter((i) => i.stock > 0).length;
        return {
          category,
          index,
          items: byCategory.get(category) ?? [],
          totalInCat,
          inStockInCat,
        };
      })
      .filter((g) => g.items.length > 0);
  }, [allItems, filtered]);

  const total = hit.data?.totalItems ?? 0;
  const out = hit.data?.outOfStock ?? 0;
  const health =
    total > 0 ? Math.round(((hit.data?.inStock ?? 0) / total) * 1000) / 10 : 0;

  // ---- Stocktake ---------------------------------------------------
  const countedOf = (item: HitItem): number =>
    counts[item.item] ?? item.stock;
  const stocktakeDiffs = stocktakeOn
    ? allItems
        .filter((i) => countedOf(i) !== i.stock)
        .map((i) => ({
          item: i.item,
          from: i.stock,
          to: countedOf(i),
          delta: countedOf(i) - i.stock,
        }))
    : [];
  const startStocktake = () => {
    // Seed every count from the current effective stock, and open
    // every category so the whole list can be walked.
    setCounts(
      Object.fromEntries(allItems.map((i) => [i.item, i.stock])),
    );
    setExpanded(
      new Set(
        [...new Set(allItems.map((i) => i.category))].filter(Boolean),
      ),
    );
    setStocktakeStage("editing");
    setStocktakeError(null);
    setStocktakeOn(true);
  };
  const cancelStocktake = () => {
    setStocktakeOn(false);
    setStocktakeStage("editing");
    setCounts({});
    setStocktakeError(null);
  };
  // A completed manual refresh flows straight into a stocktake,
  // seeded from the stock that refresh just brought in. Runs once
  // per kick; if a stocktake is already open it is left as is.
  const lastKickRef = useRef(0);
  useEffect(() => {
    if (stocktakeKick > 0 && stocktakeKick !== lastKickRef.current) {
      lastKickRef.current = stocktakeKick;
      if (!stocktakeOn) startStocktake();
    }
    // startStocktake reads the current items; the kick changing is
    // the trigger, not its identity.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [stocktakeKick]);

  // ---- Expiry --------------------------------------------------------
  const expiringItems = allItems
    .filter((i) => i.expiry != null)
    .sort((a, b) => (a.expiry ?? "").localeCompare(b.expiry ?? ""));
  const itemsWithoutExpiry = allItems.filter((i) => i.expiry == null);

  return (
    <div>
      {/* Inventory summary */}
      <section className="pt-2">
        <div
          className="flex items-start justify-between gap-3 rounded-2xl px-5 py-4"
          style={{ backgroundColor: "var(--surface-alt)" }}
        >
          <div>
            <div className="flex items-start gap-2">
              <p className="text-4xl font-bold tabular-nums leading-none text-[var(--text)]">
                {out}
              </p>
              <p className="pt-1 text-[17.5px] font-medium leading-tight text-[var(--dim)]">
                {out === 1 ? "item" : "items"} out of stock
              </p>
            </div>
            <div className="mt-2 flex items-start gap-2">
              <p className="text-4xl font-bold tabular-nums leading-none text-[var(--text)]">
                {total}
              </p>
              <div className="flex h-9 flex-col justify-between py-0.5">
                <p className="text-xs font-medium leading-4 text-[var(--dim)]">
                  tracked items
                </p>
                <p className="text-xs font-medium leading-4 text-[var(--dim)]">
                  {health}% in stock
                </p>
              </div>
            </div>
          </div>
          {/* Add item sits on top of Refresh (25% bigger), with the
              latest update stamp under Refresh, in brackets. */}
          <div className="flex shrink-0 flex-col items-end gap-2">
            <button
              type="button"
              aria-label="Add a new item to the HIT List"
              aria-expanded={showForm}
              onClick={() => setShowForm((v) => !v)}
              className="rounded-full px-5 py-[5px] text-[17.5px] font-bold"
              style={{
                backgroundColor: "var(--accent)",
                color: "var(--accent-text)",
              }}
            >
              {showForm ? "Close" : "Add item"}
            </button>
            <button
              type="button"
              aria-label="Refresh HIT List from the sheet"
              onClick={() => refresh.mutate()}
              disabled={refresh.isPending || !!refreshingSince}
              className="relative overflow-hidden rounded-full px-4 py-1 text-sm font-bold disabled:opacity-50"
              style={{
                backgroundColor: "var(--surface)",
                color: "var(--accent)",
                border: "1.5px solid var(--accent)",
              }}
            >
              {refreshingSince ? "Refreshing…" : "Refresh"}
              {/* Progress fill along the button's bottom edge */}
              <RefreshProgress
                active={!!refreshingSince}
                failed={refreshFailed}
              />
            </button>
            {/* The stamp always shows the LAST completed refresh —
                while one is running, the button's "Refreshing…"
                label is the only in-progress wording. */}
            <p className="text-right text-xs text-[var(--dim)]">
              ({formatSynced(refreshedAt)})
            </p>
          </div>
        </div>
        {refresh.data && !refresh.data.started && refresh.data.error && (
          <p className="mt-2 text-sm" style={{ color: "var(--red)" }}>
            Couldn’t start a refresh: {refresh.data.error}
          </p>
        )}
        {refreshFailed && !refreshingSince && (
          <p className="mt-2 text-sm" style={{ color: "var(--red)" }}>
            Refresh didn’t finish — try again.
          </p>
        )}
        {(hit.data?.pendingSyncCount ?? 0) > 0 && (
          <p className="mt-2 text-sm text-[var(--dim)]">
            {hit.data?.pendingSyncCount}{" "}
            {hit.data?.pendingSyncCount === 1 ? "item" : "items"} added
            here will be included in the next sync update to
            Vanessa&rsquo;s app.
          </p>
        )}
        {(hit.data?.pendingStockCount ?? 0) > 0 && (
          <p className="mt-2 text-sm text-[var(--dim)]">
            Stock changes on {hit.data?.pendingStockCount}{" "}
            {hit.data?.pendingStockCount === 1 ? "item are" : "items are"}{" "}
            counted here and waiting to be written to the sheet on the
            next auto-scan.
          </p>
        )}
        {showForm && (
          <AddItemForm
            categories={formCategories}
            stores={formStores}
            onClose={() => setShowForm(false)}
            onAdded={(category) => {
              setShowForm(false);
              setExpanded((prev) => new Set(prev).add(category));
            }}
          />
        )}
      </section>

      {/* Stocktake bar / review summary */}
      {stocktakeOn && (
        <section
          className="mt-2 rounded-2xl px-4 py-3"
          style={{
            backgroundColor: "var(--surface)",
            border: "1.5px solid var(--accent)",
          }}
        >
          {stocktakeStage === "editing" ? (
            <div className="flex flex-wrap items-center justify-between gap-2">
              <p className="min-w-0 text-sm text-[var(--text)]">
                <strong>Stocktake.</strong> Set each item&rsquo;s
                counted amount to what&rsquo;s actually on the shelf —{" "}
                {stocktakeDiffs.length === 0
                  ? "nothing differs yet."
                  : `${stocktakeDiffs.length} ${stocktakeDiffs.length === 1 ? "item differs" : "items differ"} so far.`}
              </p>
              <div className="flex shrink-0 gap-2">
                <button
                  type="button"
                  aria-label="Cancel the stocktake and record nothing"
                  onClick={cancelStocktake}
                  className="rounded-full px-3 py-1 text-sm font-bold"
                  style={{
                    backgroundColor: "var(--surface-alt)",
                    color: "var(--dim)",
                    border: "1px solid var(--border)",
                  }}
                >
                  Cancel
                </button>
                <button
                  type="button"
                  aria-label="Finish the stocktake and review the differences"
                  onClick={() => setStocktakeStage("review")}
                  className="rounded-full px-4 py-1 text-sm font-bold"
                  style={{
                    backgroundColor: "var(--accent)",
                    color: "var(--accent-text)",
                  }}
                >
                  Finish stocktake
                </button>
              </div>
            </div>
          ) : (
            <div>
              <p className="text-sm font-bold text-[var(--text)]">
                {stocktakeDiffs.length === 0
                  ? "Everything matches"
                  : `Record ${stocktakeDiffs.length} ${stocktakeDiffs.length === 1 ? "change" : "changes"}?`}
              </p>
              {stocktakeDiffs.length === 0 ? (
                <p className="mt-1 text-sm text-[var(--dim)]">
                  Every counted amount matches the stock on record, so
                  there is nothing to record.
                </p>
              ) : (
                <ul className="mt-2 divide-y divide-[var(--border)]">
                  {stocktakeDiffs.map((d) => (
                    <li
                      key={d.item}
                      className="flex items-center justify-between gap-3 py-1.5 text-sm"
                    >
                      <span className="min-w-0 truncate font-semibold text-[var(--text)]">
                        {d.item}
                      </span>
                      <span className="shrink-0 tabular-nums text-[var(--dim)]">
                        {d.from} →{" "}
                        <strong className="text-[var(--text)]">
                          {d.to}
                        </strong>{" "}
                        (
                        <span
                          style={{
                            color:
                              d.delta > 0
                                ? "var(--ok-text)"
                                : "var(--red)",
                          }}
                        >
                          {d.delta > 0 ? `+${d.delta}` : d.delta}
                        </span>
                        )
                      </span>
                    </li>
                  ))}
                </ul>
              )}
              <p className="mt-2 text-xs text-[var(--dim)]">
                Confirming records the differences as pending stock
                changes — the auto-scan writes them to the sheet, like
                the +/− steppers and purchases.
              </p>
              {stocktakeError && (
                <p
                  className="mt-2 text-sm"
                  style={{ color: "var(--red)" }}
                >
                  {stocktakeError}
                </p>
              )}
              <div className="mt-3 flex flex-wrap gap-2">
                <button
                  type="button"
                  aria-label="Back to counting without recording"
                  onClick={() => setStocktakeStage("editing")}
                  className="rounded-full px-3 py-1 text-sm font-bold"
                  style={{
                    backgroundColor: "var(--surface-alt)",
                    color: "var(--dim)",
                    border: "1px solid var(--border)",
                  }}
                >
                  Back
                </button>
                <button
                  type="button"
                  aria-label="Cancel the stocktake and record nothing"
                  onClick={cancelStocktake}
                  className="rounded-full px-3 py-1 text-sm font-bold"
                  style={{
                    backgroundColor: "var(--surface-alt)",
                    color: "var(--dim)",
                    border: "1px solid var(--border)",
                  }}
                >
                  Cancel
                </button>
                {stocktakeDiffs.length > 0 && (
                  <button
                    type="button"
                    aria-label="Confirm the stocktake changes"
                    disabled={recordStocktake.isPending}
                    onClick={() =>
                      recordStocktake.mutate(
                        stocktakeDiffs.map((d) => ({
                          item: d.item,
                          counted: d.to,
                        })),
                      )
                    }
                    className="rounded-full px-4 py-1 text-sm font-bold disabled:opacity-50"
                    style={{
                      backgroundColor: "var(--accent)",
                      color: "var(--accent-text)",
                    }}
                  >
                    {recordStocktake.isPending
                      ? "Recording…"
                      : "Confirm changes"}
                  </button>
                )}
              </div>
            </div>
          )}
        </section>
      )}

      {/* Find + filter */}
      <section className="mt-2 flex items-center gap-3">
        <input
          type="search"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Search the inventory…"
          aria-label="Search the inventory"
          className="min-w-0 flex-1 rounded-full px-4 py-2 text-sm text-[var(--text)]"
          style={{
            backgroundColor: "var(--surface)",
            border: "1px solid var(--border)",
          }}
        />
        <label className="flex shrink-0 cursor-pointer items-center gap-2 py-2 text-sm font-medium text-[var(--text)]">
          <input
            type="checkbox"
            checked={showLowOnly}
            onChange={(e) => setShowLowOnly(e.target.checked)}
            className="h-5 w-5"
          />
          Low &amp; out only
        </label>
      </section>

      {/* Inventory groups */}
      {hit.isPending ? (
        <p className="py-12 text-center text-sm text-[var(--dim)]">
          Loading the inventory…
        </p>
      ) : hit.error ? (
        <p
          className="py-12 text-center text-sm"
          style={{ color: "var(--red)" }}
        >
          The inventory couldn’t be loaded. Try Refresh above.
        </p>
      ) : allItems.length === 0 ? (
        <div className="py-12 text-center">
          <p className="text-base font-semibold text-[var(--text)]">
            The HIT List hasn’t been pulled in yet
          </p>
          <p className="mx-auto mt-2 max-w-xs text-sm text-[var(--dim)]">
            Tap Refresh to read the HIT List tab from the sheet — the
            whole household inventory will show up here, grouped by
            category.
          </p>
        </div>
      ) : filtered.length === 0 ? (
        <p className="py-12 text-center text-sm text-[var(--dim)]">
          Nothing matches that search.
        </p>
      ) : (
        groups.map((group) => {
          // During an active search, categories with matches open up so
          // the matching items are visible; otherwise a category shows
          // only if the user expanded it (all start collapsed).
          const searching = q.length > 0;
          const isCollapsed = searching
            ? false
            : !expanded.has(group.category);
          const panelId = `hit-cat-${group.category.replace(/[^a-z0-9]+/gi, "-")}`;
          return (
            <section key={group.category} className="mt-2">
              <button
                type="button"
                aria-expanded={!isCollapsed}
                aria-controls={panelId}
                aria-label={`${group.category}, ${group.inStockInCat} of ${group.totalInCat} in stock. ${isCollapsed ? "Expand" : "Collapse"} category`}
                onClick={() => toggleCategory(group.category)}
                className="flex w-full items-center justify-between gap-3 px-1 text-left"
              >
                <span className="flex min-w-0 items-center gap-2">
                  <span
                    aria-hidden="true"
                    className="inline-flex h-5 w-5 shrink-0 items-center justify-center text-[var(--dim)] transition-transform duration-200"
                    style={{
                      transform: isCollapsed ? "rotate(-90deg)" : "rotate(0deg)",
                    }}
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
                  <span
                    aria-hidden="true"
                    className="inline-block h-3 w-3 shrink-0 rounded-full"
                    style={{ backgroundColor: categoryHue(group.index) }}
                  />
                  <span className="truncate text-xl font-bold text-[var(--text)]">
                    {group.category}
                  </span>
                </span>
                <span
                  className="shrink-0 rounded-md px-2 py-1 text-xs font-bold tabular-nums leading-none"
                  style={fractionBoxStyle(group.inStockInCat, group.totalInCat)}
                >
                  {group.inStockInCat}/{group.totalInCat} stock
                </span>
              </button>
              {!isCollapsed && (
                <ul
                  id={panelId}
                  className="mt-1.5 divide-y overflow-hidden rounded-2xl"
                  style={{
                    backgroundColor: "var(--surface)",
                    border: "1px solid var(--border)",
                    borderTop: `3px solid ${categoryHue(group.index)}`,
                    ["--tw-divide-opacity" as string]: "1",
                  }}
                >
                  {group.items.map((item) => {
                    const pill = stockPill(item.stock);
                    const hasExtraInfo =
                      (item.forecastDays != null && item.stock > 0) ||
                      !!item.formalName ||
                      !!item.sku ||
                      !!item.priceInfo;
                    return (
                      <li
                        key={`${item.category}-${item.item}`}
                        className="px-3 py-2"
                      >
                        {/* One single line: name + store on the left;
                            on the right, − [stock box] + with the
                            sale-watch star just before the steppers. */}
                        <div className="flex items-center gap-1.5">
                          <div className="flex min-w-0 flex-1 items-center gap-1">
                            <span
                              className="whitespace-nowrap font-semibold text-[var(--text)]"
                              style={{ fontSize: nameFontSize(item.item) }}
                            >
                              {item.item}
                            </span>
                            {(() => {
                              const chip = expiryChip(item.expiry);
                              return chip ? (
                                <span
                                  className="shrink-0 rounded-full px-1.5 py-0.5 text-[13px] font-bold leading-none"
                                  style={chip.style}
                                  title={`Expires ${item.expiry ? formatExpiryDate(item.expiry) : ""}`}
                                >
                                  {chip.label}
                                </span>
                              ) : null;
                            })()}
                            {item.pendingSync && (
                              <span
                                className="shrink-0 rounded-full px-1.5 py-0.5 text-[13px] font-bold leading-none"
                                style={{
                                  backgroundColor: "var(--amber-soft)",
                                  color: "var(--amber)",
                                }}
                              >
                                Pending sync
                              </span>
                            )}
                            {item.pendingDelta !== 0 && (
                              <span
                                className="shrink-0 rounded-full px-1.5 py-0.5 text-[13px] font-bold leading-none"
                                style={{
                                  backgroundColor: "var(--amber-soft)",
                                  color: "var(--amber)",
                                }}
                                title={`${item.pendingDelta > 0 ? `+${item.pendingDelta}` : item.pendingDelta} pending — counted here now; the auto-scan writes it to the sheet`}
                              >
                                {item.pendingDelta > 0
                                  ? `+${item.pendingDelta}`
                                  : item.pendingDelta}
                              </span>
                            )}
                            <span className="min-w-0 truncate text-xs text-[var(--dim)]">
                              {item.store}
                            </span>
                          </div>
                          <div className="flex shrink-0 items-center gap-1">
                            <button
                              type="button"
                              aria-pressed={item.watched}
                              aria-label={
                                item.watched
                                  ? `Stop watching ${item.item} for sales`
                                  : `Watch ${item.item} for sales, whatever the stock`
                              }
                              title={
                                item.watched
                                  ? "Watched: sale-checked whatever the stock"
                                  : "Watch for sales"
                              }
                              onClick={() =>
                                toggleWatch.mutate({
                                  item: item.item,
                                  watched: !item.watched,
                                })
                              }
                              className="rounded-full px-0.5 py-0.5 text-base leading-none"
                              style={{
                                color: item.watched
                                  ? "var(--amber)"
                                  : "var(--dim)",
                              }}
                            >
                              {item.watched ? "★" : "☆"}
                            </button>
                            {stocktakeOn ? (
                              <>
                                <span
                                  className="shrink-0 whitespace-nowrap rounded-full px-1.5 py-1 text-[13px] font-bold leading-none"
                                  style={{
                                    ...pill.style,
                                    ...(item.stock === 1
                                      ? {}
                                      : item.stock === 0
                                        ? {}
                                        : {
                                            backgroundColor:
                                              categorySoft(group.index),
                                            color: categoryText(group.index),
                                          }),
                                  }}
                                >
                                  {pill.label}
                                </span>
                                <span
                                  aria-hidden="true"
                                  className="shrink-0 text-xs text-[var(--dim)]"
                                >
                                  →
                                </span>
                                <button
                                  type="button"
                                  aria-label={`Count one fewer ${item.item}`}
                                  disabled={countedOf(item) <= 0}
                                  onClick={() =>
                                    setCounts((prev) => ({
                                      ...prev,
                                      [item.item]: Math.max(
                                        0,
                                        countedOf(item) - 1,
                                      ),
                                    }))
                                  }
                                  className="flex h-8 w-7 shrink-0 items-center justify-center rounded-md text-base font-bold disabled:opacity-40"
                                  style={{
                                    backgroundColor: "var(--surface-alt)",
                                    color: "var(--text)",
                                    border: "1px solid var(--border)",
                                  }}
                                >
                                  −
                                </button>
                                <input
                                  type="number"
                                  inputMode="numeric"
                                  min={0}
                                  max={9999}
                                  step={1}
                                  value={countedOf(item)}
                                  aria-label={`Counted stock for ${item.item} (currently ${item.stock} on record)`}
                                  onChange={(e) => {
                                    const n = Number(e.target.value);
                                    setCounts((prev) => ({
                                      ...prev,
                                      [item.item]:
                                        e.target.value === "" ||
                                        !Number.isFinite(n)
                                          ? 0
                                          : Math.max(
                                              0,
                                              Math.min(9999, Math.trunc(n)),
                                            ),
                                    }));
                                  }}
                                  className="h-8 w-14 shrink-0 rounded-md px-1 text-center text-sm font-bold tabular-nums text-[var(--text)]"
                                  style={{
                                    backgroundColor: "var(--surface)",
                                    border:
                                      countedOf(item) !== item.stock
                                        ? "1.5px solid var(--accent)"
                                        : "1px solid var(--border)",
                                  }}
                                />
                                <button
                                  type="button"
                                  aria-label={`Count one more ${item.item}`}
                                  onClick={() =>
                                    setCounts((prev) => ({
                                      ...prev,
                                      [item.item]: Math.min(
                                        9999,
                                        countedOf(item) + 1,
                                      ),
                                    }))
                                  }
                                  className="flex h-8 w-7 shrink-0 items-center justify-center rounded-md text-base font-bold"
                                  style={{
                                    backgroundColor: "var(--surface-alt)",
                                    color: "var(--text)",
                                    border: "1px solid var(--border)",
                                  }}
                                >
                                  +
                                </button>
                              </>
                            ) : (
                              <>
                            <button
                              type="button"
                              aria-label={`Use one ${item.item}`}
                              disabled={
                                item.stock <= 0 ||
                                (adjust.isPending &&
                                  adjust.variables?.item === item.item)
                              }
                              onClick={() =>
                                adjust.mutate({ item: item.item, delta: -1 })
                              }
                              className="flex h-8 w-7 shrink-0 items-center justify-center rounded-md text-base font-bold disabled:opacity-40"
                              style={{
                                backgroundColor: "var(--surface-alt)",
                                color: "var(--text)",
                                border: "1px solid var(--border)",
                              }}
                            >
                              −
                            </button>
                            <span
                              className="shrink-0 whitespace-nowrap rounded-full px-1.5 py-1 text-[13px] font-bold leading-none"
                              style={{
                                ...pill.style,
                                ...(item.stock === 1
                                  ? {}
                                  : item.stock === 0
                                    ? {}
                                    : {
                                        backgroundColor: categorySoft(group.index),
                                        color: categoryText(group.index),
                                      }),
                              }}
                            >
                              {pill.label}
                            </span>
                            <button
                              type="button"
                              aria-label={`Add one ${item.item}`}
                              disabled={
                                adjust.isPending &&
                                adjust.variables?.item === item.item
                              }
                              onClick={() =>
                                adjust.mutate({ item: item.item, delta: 1 })
                              }
                              className="flex h-8 w-7 shrink-0 items-center justify-center rounded-md text-base font-bold disabled:opacity-40"
                              style={{
                                backgroundColor: "var(--surface-alt)",
                                color: "var(--text)",
                                border: "1px solid var(--border)",
                              }}
                            >
                              +
                            </button>
                              </>
                            )}
                          </div>
                        </div>
                        {hasExtraInfo && (
                          <div className="mt-1">
                            {item.forecastDays != null && item.stock > 0 && (
                              <p className="text-xs text-[var(--dim)]">
                                Runs out in ~{item.forecastDays}{" "}
                                {item.forecastDays === 1 ? "day" : "days"} at
                                the recent pace
                              </p>
                            )}
                            {(item.formalName || item.sku) && (
                              <p className="text-xs text-[var(--dim)]">
                                {item.formalName}
                                {item.formalName && item.sku ? " · " : ""}
                                {item.sku ? `SKU ${item.sku}` : ""}
                              </p>
                            )}
                            {item.priceInfo && (
                              <PriceInfoBlock
                                itemName={item.item}
                                info={item.priceInfo}
                              />
                            )}
                          </div>
                        )}
                      </li>
                    );
                  })}
                </ul>
              )}
            </section>
          );
        })
      )}

      {/* Expiring soon */}
      <section className="mt-2">
        <button
          type="button"
          aria-expanded={expiringOpen}
          aria-controls="expiring-panel"
          onClick={() => setExpiringOpen((v) => !v)}
          className="flex w-full items-center justify-between gap-2 rounded-[var(--radius)] border border-[var(--border)] bg-[var(--surface)] px-4 py-3 text-left text-[var(--text)]"
        >
          <span className="text-base font-semibold">Expiring soon</span>
          <span className="flex items-center gap-2 text-sm text-[var(--dim)]">
            <span>
              {expiringItems.length === 0
                ? "no dates set"
                : `${expiringItems.length} ${expiringItems.length === 1 ? "item" : "items"}`}
            </span>
            <span aria-hidden="true">{expiringOpen ? "▾" : "▸"}</span>
          </span>
        </button>
        {expiringOpen && (
          <div
            id="expiring-panel"
            className="mt-2 overflow-hidden rounded-2xl"
            style={{
              backgroundColor: "var(--surface)",
              border: "1px solid var(--border)",
            }}
          >
            {expiringItems.length === 0 ? (
              <p className="px-4 py-3 text-sm text-[var(--dim)]">
                No expiry dates set yet. Add one below for anything
                that goes off — items within 3 days of their date get
                a ⚠ chip on their row.
              </p>
            ) : (
              <ul className="divide-y divide-[var(--border)]">
                {expiringItems.map((i) => {
                  const days = i.expiry
                    ? daysUntilExpiry(i.expiry)
                    : null;
                  return (
                    <li
                      key={i.item}
                      className="flex flex-wrap items-center gap-2 px-4 py-2.5"
                    >
                      <div className="min-w-0 flex-1">
                        <p className="truncate text-sm font-semibold text-[var(--text)]">
                          {i.item}
                        </p>
                        <p className="text-xs text-[var(--dim)]">
                          {i.expiry
                            ? formatExpiryDate(i.expiry)
                            : ""}
                          {days != null &&
                            (days < 0
                              ? " · expired"
                              : days === 0
                                ? " · today"
                                : ` · in ${days} ${days === 1 ? "day" : "days"}`)}
                        </p>
                      </div>
                      <input
                        type="date"
                        value={i.expiry ?? ""}
                        aria-label={`Expiry date for ${i.item}`}
                        disabled={setExpiry.isPending}
                        onChange={(e) => {
                          if (e.target.value) {
                            setExpiry.mutate({
                              item: i.item,
                              date: e.target.value,
                            });
                          }
                        }}
                        className="rounded-md px-2 py-1 text-sm text-[var(--text)]"
                        style={{
                          backgroundColor: "var(--surface)",
                          border: "1px solid var(--border)",
                        }}
                      />
                      <button
                        type="button"
                        aria-label={`Clear the expiry date for ${i.item}`}
                        disabled={setExpiry.isPending}
                        onClick={() =>
                          setExpiry.mutate({ item: i.item, date: null })
                        }
                        className="shrink-0 rounded-full px-3 py-1 text-xs font-bold disabled:opacity-50"
                        style={{
                          backgroundColor: "var(--surface-alt)",
                          color: "var(--accent)",
                          border: "1px solid var(--border)",
                        }}
                      >
                        Clear
                      </button>
                    </li>
                  );
                })}
              </ul>
            )}
            {/* Add expiry row */}
            <div
              className="flex flex-wrap items-end gap-2 px-4 py-3"
              style={{
                borderTop:
                  expiringItems.length > 0
                    ? "1px solid var(--border)"
                    : undefined,
                backgroundColor: "var(--surface-alt)",
              }}
            >
              <div className="min-w-36 flex-1">
                <label
                  htmlFor="expiry-add-item"
                  className={fieldLabelClass}
                >
                  Add expiry
                </label>
                <select
                  id="expiry-add-item"
                  value={newExpiryItem}
                  onChange={(e) => setNewExpiryItem(e.target.value)}
                  className="mt-1 w-full rounded-md px-2 py-1.5 text-sm text-[var(--text)]"
                  style={fieldInputStyle}
                >
                  <option value="">Choose an item…</option>
                  {itemsWithoutExpiry.map((i) => (
                    <option key={i.item} value={i.item}>
                      {i.item}
                    </option>
                  ))}
                </select>
              </div>
              <input
                type="date"
                value={newExpiryDate}
                aria-label="Expiry date to add"
                onChange={(e) => setNewExpiryDate(e.target.value)}
                className="rounded-md px-2 py-1.5 text-sm text-[var(--text)]"
                style={fieldInputStyle}
              />
              <button
                type="button"
                aria-label="Add the expiry date to the chosen item"
                disabled={
                  !newExpiryItem || !newExpiryDate || setExpiry.isPending
                }
                onClick={() => {
                  setExpiry.mutate(
                    { item: newExpiryItem, date: newExpiryDate },
                    {
                      onSuccess: () => {
                        setNewExpiryItem("");
                        setNewExpiryDate("");
                      },
                    },
                  );
                }}
                className="rounded-full px-4 py-1.5 text-sm font-bold disabled:opacity-50"
                style={{
                  backgroundColor: "var(--accent)",
                  color: "var(--accent-text)",
                }}
              >
                Add
              </button>
            </div>
          </div>
        )}
      </section>

      {/* Activity log */}
      <section className="mt-2">
        <button
          type="button"
          aria-expanded={activityOpen}
          aria-controls="activity-panel"
          onClick={() => setActivityOpen((v) => !v)}
          className="flex w-full items-center justify-between gap-2 rounded-[var(--radius)] border border-[var(--border)] bg-[var(--surface)] px-4 py-3 text-left text-[var(--text)]"
        >
          <span className="text-base font-semibold">Activity</span>
          <span className="flex items-center gap-2 text-sm text-[var(--dim)]">
            <span>
              {(activity.data?.entries ?? []).filter((e) => !e.undone)
                .length}{" "}
              entries
            </span>
            <span aria-hidden="true">{activityOpen ? "▾" : "▸"}</span>
          </span>
        </button>
        {activityOpen && (
          <div
            id="activity-panel"
            className="mt-2 overflow-hidden rounded-2xl"
            style={{
              backgroundColor: "var(--surface)",
              border: "1px solid var(--border)",
            }}
          >
            {(activity.data?.entries ?? []).length === 0 ? (
              <p className="px-4 py-4 text-sm text-[var(--dim)]">
                Nothing yet. Meals marked &ldquo;Eaten ✓&rdquo; on the
                Meal Planner calendar and purchases confirmed on the
                Shopping List will show up here.
              </p>
            ) : (
              <ul className="divide-y divide-[var(--border)]">
                {(activity.data?.entries ?? []).map((e) => (
                  <li
                    key={e.key}
                    className={`flex items-start justify-between gap-3 px-4 py-2.5 ${e.undone ? "opacity-55" : ""}`}
                  >
                    <div className="min-w-0">
                      <p className="text-sm font-semibold text-[var(--text)]">
                        <span
                          className="mr-2 rounded-full px-1.5 py-0.5 align-middle text-[13px] font-bold leading-none"
                          style={
                            e.kind === "purchased"
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
                          {e.kind === "purchased" ? "Purchased" : "Used"}
                        </span>
                        {e.item}
                        <span className="ml-2 font-normal text-[var(--dim)]">
                          {e.kind === "purchased"
                            ? `+${e.quantity}`
                            : e.usedSome
                              ? "used some"
                              : `−${e.quantity}`}
                        </span>
                        {e.undone && (
                          <span className="ml-2 text-xs font-bold text-[var(--dim)]">
                            Undone
                          </span>
                        )}
                      </p>
                      <p className="mt-0.5 text-xs text-[var(--dim)]">
                        {e.kind === "used" && e.source === "manual"
                          ? "Quick use"
                          : e.source}
                        {" · "}
                        {new Date(e.createdAt).toLocaleString("en-CA", {
                          month: "short",
                          day: "numeric",
                          hour: "numeric",
                          minute: "2-digit",
                        })}
                      </p>
                    </div>
                    {!e.undone && (
                      <button
                        type="button"
                        aria-label={
                          e.kind === "purchased"
                            ? `Undo the purchase of ${e.item}`
                            : `Undo usage of ${e.item}`
                        }
                        disabled={
                          undoUsage.isPending || undoPurchase.isPending
                        }
                        onClick={() =>
                          e.kind === "purchased"
                            ? undoPurchase.mutate(e.refId)
                            : undoUsage.mutate(e.refId)
                        }
                        className="shrink-0 rounded-full px-3 py-1 text-xs font-bold disabled:opacity-50"
                        style={{
                          backgroundColor: "var(--surface-alt)",
                          color: "var(--accent)",
                          border: "1px solid var(--border)",
                        }}
                      >
                        Undo
                      </button>
                    )}
                  </li>
                ))}
              </ul>
            )}
          </div>
        )}
      </section>

      {allItems.length > 0 && (
        <p className="mt-4 text-center text-xs text-[var(--dim)]">
          Tap − or + beside an item&rsquo;s stock to use one or add
          one — the count changes here right away and is written to
          the sheet on the next auto-scan. The ★ stars an item for
          sale checks whatever its stock. Items added here appear
          right away, get an automatic price check, and are queued
          for Vanessa&rsquo;s app sync. Refreshing also starts a
          stocktake, walking the whole list to correct the counts;
          the Activity log below covers both usage and purchases,
          each with an Undo.
        </p>
      )}
    </div>
  );
}
