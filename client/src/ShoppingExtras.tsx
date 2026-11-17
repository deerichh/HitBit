import { useEffect, useRef, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { fileToBase64 } from "@hatch/space-sdk/client";
import { api, type ApiResponse } from "./api";
import { ActorTag } from "./AccountPolicy";
import { INFO_BUTTON_STYLE, useHoldInfo } from "./popupHooks";

type AlertsData = ApiResponse<typeof api, "getAlerts">;
type AlertItem = AlertsData["alerts"][number];
type ReceiptScansData = ApiResponse<typeof api, "getReceiptScans">;
type ReceiptScan = ReceiptScansData["scans"][number];
type ReceiptLine = ReceiptScan["lines"][number];

// The same rotating chevron the section headers use (points down
// when expanded, sideways when collapsed).
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
 * release.
 */
function InfoListButton({
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

function alertTime(iso: string): string {
  const d = new Date(iso);
  return d.toLocaleString("en-CA", {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}

/** A receipt money amount the way it belongs on a receipt: $12.34. */
function receiptMoneyText(value: number): string {
  return `$${value.toFixed(2)}`;
}

const ALERT_KIND_LABEL: Record<AlertItem["kind"], string> = {
  sale: "Sale",
  scan: "Scan",
  info: "Info",
};

/**
 * The alerts strip at the very top of the Shopping List tab (above
 * the locked "Sales by Store" header). It uses the one header spec
 * (Beta 0.05, audit #9): the standard accent box with its chevron
 * on the left, ONE count in the title — "Alerts - X", X the total
 * number of alerts — and an ⓘ beside it listing the alert titles.
 * Which alerts are new shows on the rows themselves (unread rows
 * are bold), never as a second count. Tapping the title expands
 * the feed (newest first, each alert dismissible) and marks the
 * alerts read. Dismissed alerts collect in a Dismissed list below
 * the feed, each with a Restore — a dismissal is reversible
 * (audit #5). Alerts are written by Muse's external scan jobs
 * and are display only. With no alerts at all, the strip renders
 * nothing.
 */
export function AlertsStrip() {
  const queryClient = useQueryClient();
  const [open, setOpen] = useState(false);
  const alerts = useQuery({
    queryKey: ["alerts"],
    queryFn: () => api.getAlerts({}),
    // Scan jobs write alerts while the app sits open; poll gently
    // so a fresh sale alert shows up without a manual refresh.
    refetchInterval: 60_000,
  });
  const markRead = useMutation({
    mutationFn: async () => await api.markAlertsRead({}),
    onSuccess: () =>
      queryClient.invalidateQueries({ queryKey: ["alerts"] }),
  });
  const dismiss = useMutation({
    mutationFn: async (id: number) => await api.dismissAlert({ id }),
    onSuccess: () =>
      queryClient.invalidateQueries({ queryKey: ["alerts"] }),
  });
  const data = alerts.data;
  if (
    !data ||
    (data.alerts.length === 0 &&
      data.unreadCount === 0 &&
      data.dismissed.length === 0)
  ) {
    return null;
  }
  const unread = data.unreadCount;

  const toggle = () => {
    const next = !open;
    setOpen(next);
    // Opening the list marks its alerts read.
    if (next && unread > 0) markRead.mutate();
  };

  return (
    <section className="pt-2">
      <div
        className="flex w-full items-center rounded-xl px-3 py-2"
        style={{
          backgroundColor: "var(--accent-soft)",
          border: "2px solid var(--accent)",
        }}
      >
        <button
          type="button"
          aria-expanded={open}
          aria-label={
            unread > 0
              ? `Alerts, ${unread} unread`
              : "Alerts"
          }
          onClick={toggle}
          // -my-2 py-2 (audit #10): the toggle's tappable area
          // fills the banner's full height, like the other banner
          // toggles — the negative margins cancel the extra
          // padding in layout, so the banner doesn't grow.
          className="-my-2 flex min-w-0 flex-1 items-center gap-1.5 py-2 text-left"
        >
          <Chevron collapsed={!open} />
          <span
            className="font-bold text-[var(--text)]"
            style={{ fontSize: "20px", lineHeight: 1.2 }}
          >
            Alerts - {data.alerts.length}
          </span>
        </button>
        <InfoListButton
          names={data.alerts.map((a) => a.title)}
          emptyText="No alerts"
          ariaLabel="Show the alerts in this section"
        />
      </div>
      {open && (
        <ul
          className="mt-1.5 divide-y rounded-2xl"
          style={{
            backgroundColor: "var(--surface)",
            border: "1px solid var(--border)",
          }}
        >
            {data.alerts.map((a) => (
              <li key={a.id} className="flex gap-2 px-3 py-2">
                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-center gap-x-2 gap-y-0.5">
                    <span
                      className="rounded-full px-1.5 py-0.5 text-[13px] font-bold"
                      style={{
                        backgroundColor:
                          a.kind === "sale"
                            ? "var(--accent-soft)"
                            : "var(--surface-alt)",
                        color:
                          a.kind === "sale"
                            ? "var(--accent)"
                            : "var(--dim)",
                      }}
                    >
                      {ALERT_KIND_LABEL[a.kind]}
                    </span>
                    <p
                      className={`text-sm leading-snug text-[var(--text)] ${
                        a.read ? "font-medium" : "font-bold"
                      }`}
                    >
                      {a.title}
                    </p>
                  </div>
                  <p className="mt-0.5 text-xs leading-snug text-[var(--dim)]">
                    {a.body}
                  </p>
                  <p className="mt-0.5 text-[13px] text-[var(--dim)]">
                    {a.item ? `${a.item} · ` : ""}
                    {alertTime(a.createdAt)}
                  </p>
                </div>
                <button
                  type="button"
                  aria-label={`Dismiss alert: ${a.title}`}
                  disabled={dismiss.isPending && dismiss.variables === a.id}
                  onClick={() => dismiss.mutate(a.id)}
                  className="flex h-8 w-8 shrink-0 items-center justify-center self-start rounded-full text-base text-[var(--dim)] disabled:opacity-50"
                >
                  ×
                </button>
              </li>
            ))}
        </ul>
      )}
      {open && data.dismissed.length > 0 && (
        <div className="mt-1.5">
          <p className="px-1 text-xs font-bold text-[var(--dim)]">
            Dismissed
          </p>
          <ul
            className="mt-1 divide-y rounded-2xl opacity-75"
            style={{
              backgroundColor: "var(--surface)",
              border: "1px solid var(--border)",
            }}
          >
            {data.dismissed.map((a) => (
              <li key={a.id} className="flex gap-2 px-3 py-2">
                <div className="min-w-0 flex-1">
                  <p className="text-sm font-medium leading-snug text-[var(--text)]">
                    {a.title}
                  </p>
                  <p className="mt-0.5 text-[13px] text-[var(--dim)]">
                    {a.item ? `${a.item} · ` : ""}
                    {alertTime(a.createdAt)}
                    <ActorTag actor={a.actor} permanent={a.permanent} />
                  </p>
                </div>
              </li>
            ))}
          </ul>
        </div>
      )}
    </section>
  );
}

/**
 * Downscale a receipt photo before upload: phone photos are several
 * megabytes, and a long edge around 2000px keeps every receipt line
 * legible for the reader while the upload stays small. Falls back
 * to the original file whenever anything about the resize fails.
 */
async function prepareReceiptImage(
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

/**
 * Try to decode a QR code from the photo in the browser, using the
 * platform's BarcodeDetector when it exists (the same API the HIT
 * List barcode scanner uses). Receipts often carry a QR code, and
 * some receipts are only a QR code linking to a digital copy — the
 * decoded value is stored with the scan so the reader can follow
 * it to the digital receipt. Returns null when decoding isn't
 * supported or no QR code is found; the photo is still uploaded
 * either way and the reader attempts decoding on its side.
 */
async function decodeQrCode(file: File): Promise<string | null> {
  try {
    type Detector = new (options?: {
      formats?: string[];
    }) => {
      detect: (
        source: ImageBitmap,
      ) => Promise<{ rawValue?: string }[]>;
    };
    const BarcodeDetectorCtor = (
      window as unknown as { BarcodeDetector?: Detector }
    ).BarcodeDetector;
    if (!BarcodeDetectorCtor) return null;
    let detector: InstanceType<Detector>;
    try {
      detector = new BarcodeDetectorCtor({ formats: ["qr_code"] });
    } catch {
      detector = new BarcodeDetectorCtor();
    }
    const bitmap = await createImageBitmap(file);
    try {
      const codes = await detector.detect(bitmap);
      const value = codes[0]?.rawValue?.trim();
      return value ? value : null;
    } finally {
      bitmap.close();
    }
  } catch {
    return null;
  }
}

/**
 * The review card for one proposed receipt scan: the items
 * purchased on the receipt matched to HIT List items, with editable
 * quantities (the quantities purchased) and a remove control,
 * unmatched receipt lines listed with an Add button beside each
 * (it jumps to the HIT List's Add item form, so the leftover can
 * be put on the list), and the Confirm / Dismiss pair. Nothing is
 * recorded until Confirm is pressed.
 */

/**
 * One receipt line the reader couldn't match to the HIT List, with
 * its Add button: tapping it takes the user to the HIT List tab
 * with the Add item form open — the same place the HIT List's own
 * "Add item" button leads — so the leftover item can be added to
 * the list from there.
 */
function LeftoverLine({
  line,
  onAddItem,
}: {
  line: ReceiptLine;
  onAddItem: () => void;
}) {
  return (
    <li className="flex items-center gap-2">
      <span className="min-w-0 flex-1 text-xs text-[var(--dim)]">
        {line.receiptText}
        {line.quantity > 0 ? ` × ${line.quantity}` : ""}
        {line.price != null ? ` · ${receiptMoneyText(line.price)}` : ""}
      </span>
      <button
        type="button"
        aria-label={`Add ${line.receiptText} to the HIT List`}
        onClick={onAddItem}
        className="shrink-0 rounded-full px-3 py-0.5 text-xs font-bold"
        style={{
          backgroundColor: "var(--surface)",
          color: "var(--accent)",
          border: "1px solid var(--accent)",
        }}
      >
        Add
      </button>
    </li>
  );
}

function ReceiptProposal({
  scan,
  onDone,
  onAddItem,
}: {
  scan: ReceiptScan;
  onDone: (message: string) => void;
  onAddItem: () => void;
}) {
  const queryClient = useQueryClient();
  const [lines, setLines] = useState<ReceiptLine[]>(() =>
    scan.lines.filter((l) => l.item != null),
  );
  const unmatched = scan.lines.filter((l) => l.item == null);

  const invalidate = () => {
    queryClient.invalidateQueries({ queryKey: ["receipt-scans"] });
    queryClient.invalidateQueries({ queryKey: ["hit"] });
  };
  const confirm = useMutation({
    mutationFn: async () =>
      await api.confirmReceiptScan({
        id: scan.id,
        lines: lines.map((l) => ({
          item: l.item as string,
          quantity: l.quantity,
        })),
      }),
    onSuccess: (res) => {
      if (res.ok) {
        onDone(
          `Added ${res.recorded} ${res.recorded === 1 ? "item" : "items"} from the receipt — counts are updated here now.`,
        );
      } else {
        onDone(res.error ?? "Those items couldn't be saved. Try again.");
      }
      invalidate();
    },
    onError: () => onDone("Those items couldn't be saved. Try again."),
  });
  const dismissScan = useMutation({
    mutationFn: async () => await api.dismissReceiptScan({ id: scan.id }),
    onSuccess: () => {
      onDone("Receipt scan dismissed — nothing was added.");
      invalidate();
    },
    onError: () => onDone("That scan couldn't be dismissed. Try again."),
  });

  const setQty = (idx: number, qty: number) =>
    setLines((prev) =>
      prev.map((l, i) =>
        i === idx ? { ...l, quantity: Math.min(999, Math.max(1, qty)) } : l,
      ),
    );
  const removeLine = (idx: number) =>
    setLines((prev) => prev.filter((_, i) => i !== idx));

  return (
    <div
      className="rounded-xl px-3 py-2"
      style={{ backgroundColor: "var(--surface-alt)" }}
    >
      <p className="text-xs font-bold text-[var(--text)]">
        Ready to review · {alertTime(scan.createdAt)}
      </p>
      {scan.qrValue && (
        <p className="mt-0.5 text-xs text-[var(--dim)]">
          QR code found on this receipt.
        </p>
      )}
      {scan.note && (
        <p className="mt-0.5 text-xs text-[var(--dim)]">{scan.note}</p>
      )}
      {lines.length > 0 ? (
        <ul className="mt-1.5 flex flex-col gap-1.5">
          {lines.map((l, idx) => (
            <li key={`${l.item}-${idx}`} className="flex items-center gap-2">
              <div className="min-w-0 flex-1">
                <p className="truncate text-sm font-semibold text-[var(--text)]">
                  {l.item}
                  {l.price != null && (
                    <span className="font-normal text-[var(--dim)]">
                      {" "}
                      · {receiptMoneyText(l.price)}
                    </span>
                  )}
                </p>
                {l.receiptText && l.receiptText !== l.item && (
                  <p className="truncate text-[13px] text-[var(--dim)]">
                    Receipt: {l.receiptText}
                  </p>
                )}
              </div>
              <span className="inline-flex shrink-0 items-center gap-1">
                <button
                  type="button"
                  aria-label={`One fewer of ${l.item}`}
                  disabled={l.quantity <= 1}
                  onClick={() => setQty(idx, l.quantity - 1)}
                  className="rounded-lg border border-[var(--border)] bg-[var(--surface)] px-2.5 font-medium disabled:opacity-40"
                >
                  −
                </button>
                <span className="min-w-6 text-center text-sm font-medium tabular-nums">
                  {l.quantity}
                </span>
                <button
                  type="button"
                  aria-label={`One more of ${l.item}`}
                  onClick={() => setQty(idx, l.quantity + 1)}
                  className="rounded-lg border border-[var(--border)] bg-[var(--surface)] px-2.5 font-medium"
                >
                  +
                </button>
              </span>
              <button
                type="button"
                aria-label={`Remove ${l.item} from this receipt scan`}
                onClick={() => removeLine(idx)}
                className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full text-base text-[var(--dim)]"
              >
                ×
              </button>
            </li>
          ))}
        </ul>
      ) : (
        <p className="mt-1.5 text-xs text-[var(--dim)]">
          All matched lines removed — dismiss the scan, or leave it
          here to review again later.
        </p>
      )}
      {unmatched.length > 0 && (
        <div className="mt-2">
          <p className="text-[13px] font-bold text-[var(--dim)]">
            On the receipt but not matched to the HIT List:
          </p>
          <ul className="mt-0.5 flex flex-col gap-1">
            {unmatched.map((l, idx) => (
              <LeftoverLine key={idx} line={l} onAddItem={onAddItem} />
            ))}
          </ul>
        </div>
      )}
      {scan.total != null && (
        <p className="mt-2 text-sm font-bold text-[var(--text)]">
          Receipt total: {receiptMoneyText(scan.total)}
        </p>
      )}
      <div className="mt-2 flex items-center gap-2">
        <button
          type="button"
          aria-label="Confirm adding these purchased items to the inventory"
          disabled={lines.length === 0 || confirm.isPending}
          onClick={() => confirm.mutate()}
          className="rounded-full px-4 py-1 text-sm font-bold disabled:opacity-50"
          style={{
            backgroundColor: "var(--accent)",
            color: "var(--accent-text)",
          }}
        >
          {confirm.isPending ? "Adding…" : "Confirm"}
        </button>
        <button
          type="button"
          aria-label="Dismiss this receipt scan"
          disabled={dismissScan.isPending}
          onClick={() => dismissScan.mutate()}
          className="rounded-full px-4 py-1 text-sm font-bold disabled:opacity-50"
          style={{
            backgroundColor: "var(--surface)",
            color: "var(--dim)",
            border: "1px solid var(--border)",
          }}
        >
          Dismiss
        </button>
      </div>
    </div>
  );
}

/**
 * The collapsible "Receipt scans" area in the Shopping List tab:
 * the "Receipt scan" entry point (take or upload a photo of a store
 * receipt — a printed receipt, a receipt photo carrying a QR code,
 * or a photo that is only a QR code), any proposal awaiting review,
 * scans whose read is still running, and past scans' outcomes in
 * brief. Sending a photo reads it automatically in that same send
 * (requestReceiptScan — the app scans the photo itself for the
 * purchased items, so the review is usually ready right away), and
 * any scan found still waiting gets read from here the same way
 * (its stored photo is fetched and sent to readReceiptScanNow) —
 * retried every few minutes while it stays waiting, with a
 * "Read now" button on each waiting scan's card, so nothing
 * sits unread. Sending a
 * photo records nothing — stock only moves when a proposal's
 * Confirm is pressed. (The Meal Planner tab's separate "Scan
 * recipe" link / file import that saves a meal is a different
 * feature and is not touched by this area.)
 */
export function ReceiptScansSection({
  onAddItem,
}: {
  onAddItem: () => void;
}) {
  const queryClient = useQueryClient();
  const fileRef = useRef<HTMLInputElement>(null);
  const [openOverride, setOpenOverride] = useState<boolean | null>(null);
  const [note, setNote] = useState<string | null>(null);
  // Scans whose total re-read a Restore started (Beta 0.14): the
  // list polls while one is outstanding, so the total appears on
  // its own when the re-read writes it back.
  const [totalWatchIds, setTotalWatchIds] = useState<number[]>([]);

  const scans = useQuery({
    queryKey: ["receipt-scans"],
    queryFn: () => api.getReceiptScans({}),
    // A pending scan's proposal lands asynchronously; poll while
    // one is outstanding so the review card appears on its own.
    // A restored scan's total re-read lands the same way.
    refetchInterval: (query) =>
      query.state.data?.scans.some((s) => s.status === "pending") ||
      (query.state.data?.scans ?? []).some(
        (s) => totalWatchIds.includes(s.id) && s.total == null,
      )
        ? 8000
        : false,
  });

  // Stop watching a scan once its total has landed (or it has
  // left the list) — the poll above keys off this list.
  const watchedScans = scans.data?.scans;
  useEffect(() => {
    setTotalWatchIds((prev) => {
      if (prev.length === 0 || !watchedScans) return prev;
      const next = prev.filter((id) => {
        const scan = watchedScans.find((s) => s.id === id);
        return scan != null && scan.total == null;
      });
      return next.length === prev.length ? prev : next;
    });
  }, [watchedScans]);

  const send = useMutation({
    mutationFn: async (file: File) => {
      // Decode any QR code from the photo in parallel with the
      // downscale; a QR-only photo is accepted like any other, and
      // the decoded value rides along so the reader can follow it
      // to the digital receipt. When in-browser decoding isn't
      // available, qrValue is null and the reader tries on its side.
      const [image, qrValue] = await Promise.all([
        prepareReceiptImage(file),
        decodeQrCode(file),
      ]);
      const res = await api.requestReceiptScan({ image, qrValue });
      return { res, qrFound: qrValue != null };
    },
    onSuccess: ({ res, qrFound }) => {
      if (res.ok) {
        setNote(
          res.status === "proposed"
            ? "Receipt read — the items you purchased are below for your review. Nothing is added to the inventory until you confirm."
            : qrFound
              ? "Receipt photo sent — QR code found, so the reader can follow it to the digital receipt. It's being read now, and the items you purchased will appear here for your review. Nothing is added until you confirm."
              : "Receipt photo sent — it's being read now, and the items you purchased will appear here for your review. Nothing is added until you confirm.",
        );
        setOpenOverride(true);
      } else {
        setNote(res.error ?? "That receipt photo couldn't be sent. Try again.");
      }
      queryClient.invalidateQueries({ queryKey: ["receipt-scans"] });
    },
    onError: () => setNote("That receipt photo couldn't be sent. Try again."),
  });

  // Restore (Beta 0.13, recovery flow Beta 0.14): brings back a
  // scan that was removed by accident — a dismissed scan returns
  // to review, and a confirmed scan whose Undo was tapped by
  // mistake gets the stock it added back. recoverReceiptScan does
  // that restore and, when the scan has no total stored (its
  // original read predates totals being captured, so none was
  // ever saved even though the total is printed on the photo),
  // also starts a re-read of the photo for the total, so the
  // restored scan comes back complete.
  const restoreScan = useMutation({
    mutationFn: async (id: number) => await api.recoverReceiptScan({ id }),
    onSuccess: (res, id) => {
      if (res.ok && res.rereadStarted) {
        setTotalWatchIds((prev) =>
          prev.includes(id) ? prev : [...prev, id],
        );
      }
      setNote(
        !res.ok
          ? (res.error ?? "That scan couldn't be restored.")
          : res.rereadStarted
            ? "Receipt scan restored — its photo is being re-read for the total, which will show here shortly."
            : res.total != null
              ? `Receipt scan restored — its total is ${receiptMoneyText(res.total)}.`
              : "Receipt scan restored.",
      );
      queryClient.invalidateQueries({ queryKey: ["receipt-scans"] });
      queryClient.invalidateQueries({ queryKey: ["hit"] });
      queryClient.invalidateQueries({ queryKey: ["activity"] });
      queryClient.invalidateQueries({ queryKey: ["list"] });
    },
    onError: () => setNote("That scan couldn't be restored. Try again."),
  });

  // Re-read for the total (Beta 0.13): scans read before totals
  // were captured have no total stored — the reader back then
  // only pulled items and quantities — so their cards offer this:
  // the tab fetches the scan's stored photo and sends it to
  // rereadReceiptScan, which fills in the receipt's total and the
  // line prices from the photo and changes nothing else.
  const [rereadingIds, setRereadingIds] = useState<number[]>([]);
  const rereadScan = useMutation({
    mutationFn: async (scan: ReceiptScan) => {
      if (!scan.imageUrl) throw new Error("no stored photo");
      const res = await fetch(scan.imageUrl);
      if (!res.ok) throw new Error("stored photo fetch failed");
      const photo = await res.blob();
      const image = await fileToBase64(photo);
      if (!image.mimeType) {
        image.mimeType = "image/jpeg";
      }
      return await api.rereadReceiptScan({ id: scan.id, image });
    },
    onMutate: (scan) =>
      setRereadingIds((prev) =>
        prev.includes(scan.id) ? prev : [...prev, scan.id],
      ),
    onSuccess: (res) => {
      setNote(
        !res.ok
          ? (res.error ?? "That receipt couldn't be re-read.")
          : res.total != null
            ? `Receipt re-read — its total is ${receiptMoneyText(res.total)}.`
            : "That receipt was re-read, but its total still couldn't be read from the photo.",
      );
      queryClient.invalidateQueries({ queryKey: ["receipt-scans"] });
    },
    onError: () => setNote("That receipt couldn't be re-read. Try again."),
    onSettled: (_res, _err, scan) =>
      setRereadingIds((prev) => prev.filter((x) => x !== scan.id)),
  });

  // Automatic reading for scans still waiting: any scan the list
  // shows as pending gets read by the app's own reader — the tab
  // fetches the scan's stored photo and sends it to
  // readReceiptScanNow, which scans the image for the purchased
  // items in that call. If the photo can't be fetched at all, the
  // background reader is started instead (readPendingReceiptScans).
  // This picks up scans sent before in-app reading existed, or
  // whose read never finished, without the user sending anything
  // new. The pickup is not one-shot: while a scan stays pending
  // (its read fell back to the background reader, which can
  // stall), the tab retries the in-app read every few minutes,
  // up to a few attempts per scan — and each waiting scan's card
  // carries its own "Read now" button running the same read on
  // the spot.
  const startReads = useMutation({
    mutationFn: async () => await api.readPendingReceiptScans({}),
    onSuccess: () =>
      queryClient.invalidateQueries({ queryKey: ["receipt-scans"] }),
  });
  const startReadsMutate = startReads.mutate;
  // Scans whose in-app read is running right now — drives the
  // "Reading…" state on the cards' Read now buttons and keeps
  // the automatic pickup from doubling up on a scan.
  const [readingIds, setReadingIds] = useState<number[]>([]);
  const readNow = useMutation({
    mutationFn: async (scanId: number) => {
      const pending = await api.getPendingReceiptScans({});
      const entry = pending.pending.find((p) => p.id === scanId);
      if (!entry?.imageUrl) throw new Error("no stored photo");
      const res = await fetch(entry.imageUrl);
      if (!res.ok) throw new Error("stored photo fetch failed");
      const photo = await res.blob();
      const image = await fileToBase64(photo);
      if (!image.mimeType) {
        image.mimeType = entry.imageMimeType ?? "image/jpeg";
      }
      return await api.readReceiptScanNow({ id: scanId, image });
    },
    onMutate: (scanId) =>
      setReadingIds((prev) =>
        prev.includes(scanId) ? prev : [...prev, scanId],
      ),
    onSuccess: (res) => {
      if (res.status === "proposed") {
        setNote(
          "Receipt read — the items you purchased are below for your review. Nothing is added to the inventory until you confirm.",
        );
      } else if (!res.ok && res.error) {
        setNote(res.error);
      }
      queryClient.invalidateQueries({ queryKey: ["receipt-scans"] });
    },
    onError: () => startReadsMutate(),
    onSettled: (_res, _err, scanId) =>
      setReadingIds((prev) => prev.filter((x) => x !== scanId)),
  });
  const readNowMutate = readNow.mutate;
  const pendingIds = (scans.data?.scans ?? [])
    .filter((s) => s.status === "pending")
    .map((s) => s.id);
  const pendingKey = pendingIds.join(",");
  const readAttempts = useRef(
    new Map<number, { count: number; lastAt: number }>(),
  );
  const scansUpdatedAt = scans.dataUpdatedAt;
  useEffect(() => {
    if (!pendingKey) return;
    const now = Date.now();
    for (const id of pendingIds) {
      if (readingIds.includes(id)) continue;
      const prev = readAttempts.current.get(id);
      // Retry a still-waiting scan's in-app read every few
      // minutes (the list polls every 8s while a scan is
      // pending, which is what re-runs this), up to 4 attempts
      // per scan per showing — after that the card's Read now
      // button remains.
      if (prev && (prev.count >= 4 || now - prev.lastAt < 150_000)) {
        continue;
      }
      readAttempts.current.set(id, {
        count: (prev?.count ?? 0) + 1,
        lastAt: now,
      });
      readNowMutate(id);
    }
    // pendingIds is derived from pendingKey; scansUpdatedAt is
    // the poll tick that re-checks the retries. readingIds is
    // read for the in-flight guard only.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pendingKey, scansUpdatedAt, readNowMutate]);

  const rows = scans.data?.scans ?? [];
  const proposed = rows.filter((s) => s.status === "proposed");
  const pending = rows.filter((s) => s.status === "pending");
  const past = rows.filter(
    (s) => s.status === "confirmed" || s.status === "dismissed",
  );
  const open = openOverride ?? proposed.length > 0;
  // The one header spec (Beta 0.05, audit #9): the pending count
  // lives in the banner title ("Receipt scans - X") — every scan
  // still waiting, whether it's ready to review or still being
  // read — and the ⓘ beside it lists exactly those scans, so the
  // number always matches the list.
  const pendingCount = proposed.length + pending.length;
  const pendingNames = [
    ...proposed.map(
      (s) => `Ready to review · ${alertTime(s.createdAt)}`,
    ),
    ...pending.map(
      (s) => `Waiting to be read · ${alertTime(s.createdAt)}`,
    ),
  ];

  return (
    <section className="mt-2">
      <div className="flex items-center gap-2">
        <div
          className="flex min-w-0 flex-1 items-center rounded-xl px-3 py-2"
          style={{
            backgroundColor: "var(--accent-soft)",
            border: "2px solid var(--accent)",
          }}
        >
          <button
            type="button"
            aria-expanded={open}
            aria-label={`${open ? "Collapse" : "Expand"} Receipt scans section`}
            onClick={() => setOpenOverride(!open)}
            // -my-2 py-2 (audit #10): the toggle's tappable area
            // fills the banner's full height, like the other
            // banner toggles — the negative margins cancel the
            // extra padding in layout, so the banner doesn't grow.
            className="-my-2 flex min-w-0 flex-1 items-center gap-1.5 py-2 text-left"
          >
            <Chevron collapsed={!open} />
            <span
              className="font-bold whitespace-nowrap text-[var(--text)]"
              style={{
                // The banner shares its row with the "Receipt
                // scan" button, so its title steps down a touch
                // from the 20px banner size to always fit beside
                // it (the Membership Alternatives shrink-to-fit
                // idea) — the ⓘ never overlaps the count.
                fontSize:
                  `Receipt scans - ${pendingCount}`.length > 17
                    ? 16
                    : 18,
                lineHeight: 1.2,
              }}
            >
              Receipt scans - {pendingCount}
            </span>
          </button>
          <InfoListButton
            names={pendingNames}
            emptyText="No scans waiting"
            ariaLabel="Show the scans waiting in this section"
          />
        </div>
        <button
          type="button"
          aria-label="Scan a photo of a receipt"
          disabled={send.isPending}
          onClick={() => fileRef.current?.click()}
          className="shrink-0 rounded-full px-3 py-1 text-sm font-bold disabled:opacity-50"
          style={{
            backgroundColor: "var(--surface)",
            color: "var(--accent)",
            border: "1.5px solid var(--accent)",
          }}
        >
          {send.isPending ? "Reading…" : "Receipt scan"}
        </button>
        <input
          ref={fileRef}
          type="file"
          accept="image/*"
          aria-label="Receipt photo"
          className="hidden"
          onChange={(e) => {
            const file = e.target.files?.[0];
            e.target.value = "";
            if (file) {
              setNote(null);
              send.mutate(file);
            }
          }}
        />
      </div>
      {note && <p className="mt-2 px-1 text-sm text-[var(--dim)]">{note}</p>}
      {open && (
        <div className="mt-1.5 flex flex-col gap-2">
          {proposed.map((scan) => (
            <ReceiptProposal
              key={scan.id}
              scan={scan}
              onDone={setNote}
              onAddItem={onAddItem}
            />
          ))}
          {pending.map((scan) => (
            <div
              key={scan.id}
              className="rounded-xl px-3 py-2"
              style={{ backgroundColor: "var(--surface-alt)" }}
            >
              <p className="text-xs font-bold text-[var(--text)]">
                Receipt photo sent {alertTime(scan.createdAt)} — waiting
                to be read
              </p>
              {scan.qrValue && (
                <p className="mt-0.5 text-xs text-[var(--dim)]">
                  QR code found — the reader can follow it to the
                  digital copy of this receipt.
                </p>
              )}
              {scan.note && (
                <p className="mt-0.5 text-xs text-[var(--dim)]">
                  {scan.note}
                </p>
              )}
              <p className="mt-0.5 text-xs text-[var(--dim)]">
                &ldquo;Waiting to be read&rdquo; means the photo is
                saved but its read hasn&rsquo;t finished yet. Reads
                run automatically — the app scans the photo for the
                items you bought — and the items appear here for
                your review when one lands. Nothing is added to the
                inventory until you confirm it. If a read stalls,
                tap Read now to run it again on the spot.
              </p>
              <div className="mt-1.5 flex flex-wrap items-center gap-2">
                <button
                  type="button"
                  aria-label="Read this receipt scan now"
                  disabled={readingIds.includes(scan.id)}
                  onClick={() => readNow.mutate(scan.id)}
                  className="rounded-full px-3 py-1 text-xs font-bold disabled:opacity-50"
                  style={{
                    backgroundColor: "var(--accent)",
                    color: "var(--accent-text)",
                  }}
                >
                  {readingIds.includes(scan.id) ? "Reading…" : "Read now"}
                </button>
                <DismissPendingButton scanId={scan.id} onDone={setNote} />
              </div>
            </div>
          ))}
          {past.length > 0 && (
            <ul className="flex flex-col gap-1 px-1">
              {past.map((scan) => {
                // Leftover lines on a confirmed scan: the reader
                // read them off the receipt but they matched
                // nothing on the HIT List, so confirming logged
                // only the recognized items. They stay listed
                // here, each with the same Add button as the
                // review card's leftovers.
                const leftovers =
                  scan.status === "confirmed"
                    ? scan.lines.filter((l) => l.item == null)
                    : [];
                return (
                <li
                  key={scan.id}
                  className="text-xs text-[var(--dim)]"
                >
                  <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
                  <span>
                    {scan.status === "confirmed"
                      ? `Confirmed · ${alertTime(scan.createdAt)} — ${scan.confirmedUnits ?? 0} ${
                          scan.confirmedUnits === 1 ? "item" : "items"
                        } added from the receipt${scan.undone ? " · Undone" : ""}${scan.total != null ? ` · Total ${receiptMoneyText(scan.total)}` : ""}`
                      : `Dismissed · ${alertTime(scan.createdAt)}${scan.total != null ? ` · Total ${receiptMoneyText(scan.total)}` : ""}`}
                    {scan.status === "confirmed" && (
                      <ActorTag
                        actor={scan.actor}
                        permanent={scan.permanent}
                      />
                    )}
                  </span>
                  {((scan.status === "confirmed" && scan.undone) ||
                    scan.status === "dismissed") && (
                    <button
                      type="button"
                      aria-label="Restore this receipt scan"
                      disabled={
                        restoreScan.isPending &&
                        restoreScan.variables === scan.id
                      }
                      onClick={() => restoreScan.mutate(scan.id)}
                      className="rounded-full px-2.5 py-0.5 text-xs font-bold disabled:opacity-50"
                      style={{
                        backgroundColor: "var(--surface)",
                        color: "var(--accent)",
                        border: "1px solid var(--border)",
                      }}
                    >
                      Restore
                    </button>
                  )}
                  {scan.total == null && scan.imageUrl != null && (
                    <button
                      type="button"
                      aria-label="Re-read this receipt photo to find its total"
                      disabled={rereadingIds.includes(scan.id)}
                      onClick={() => rereadScan.mutate(scan)}
                      className="rounded-full px-2.5 py-0.5 text-xs font-bold disabled:opacity-50"
                      style={{
                        backgroundColor: "var(--surface)",
                        color: "var(--accent)",
                        border: "1px solid var(--border)",
                      }}
                    >
                      {rereadingIds.includes(scan.id)
                        ? "Reading…"
                        : "Find total"}
                    </button>
                  )}
                  </div>
                  {leftovers.length > 0 && (
                    <div className="mt-0.5">
                      <p className="text-[13px] font-bold text-[var(--dim)]">
                        Left on the receipt — not on the HIT List:
                      </p>
                      <ul className="mt-0.5 flex flex-col gap-1">
                        {leftovers.map((l, idx) => (
                          <LeftoverLine
                            key={idx}
                            line={l}
                            onAddItem={onAddItem}
                          />
                        ))}
                      </ul>
                    </div>
                  )}
                </li>
                );
              })}
            </ul>
          )}
          {rows.length === 0 && !scans.isPending && (
            <p className="px-1 text-xs text-[var(--dim)]">
              No receipt scans yet. Tap “Receipt scan” and photograph
              a store receipt — even one that&rsquo;s just a QR code
              for a digital receipt — and the items you purchased
              appear here to review and confirm, so they go back on
              the HIT List without adding them one by one.
            </p>
          )}
        </div>
      )}
    </section>
  );
}

function DismissPendingButton({
  scanId,
  onDone,
}: {
  scanId: number;
  onDone: (message: string) => void;
}) {
  const queryClient = useQueryClient();
  const dismissScan = useMutation({
    mutationFn: async () => await api.dismissReceiptScan({ id: scanId }),
    onSuccess: () => {
      onDone("Receipt scan dismissed — nothing was added.");
      queryClient.invalidateQueries({ queryKey: ["receipt-scans"] });
    },
    onError: () => onDone("That scan couldn't be dismissed. Try again."),
  });
  return (
    <button
      type="button"
      aria-label="Dismiss this receipt scan"
      disabled={dismissScan.isPending}
      onClick={() => dismissScan.mutate()}
      className="rounded-full px-3 py-1 text-xs font-bold disabled:opacity-50"
      style={{
        backgroundColor: "var(--surface)",
        color: "var(--dim)",
        border: "1px solid var(--border)",
      }}
    >
      Dismiss
    </button>
  );
}
