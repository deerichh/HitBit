import {
Fragment,
useEffect,
useMemo,
useRef,
useState,
} from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api, type ApiResponse } from "./api";
import { AlertsStrip, ReceiptScansSection } from "./ShoppingExtras";
import { RefreshProgress } from "./RefreshProgress";
import { SourceDropdown } from "./SourceDropdown";
import {
INFO_BUTTON_STYLE,
useHoldInfo,
useMenuDismiss,
} from "./popupHooks";

type ListData = ApiResponse<typeof api, "getList">;
type Item = ListData["items"][number];

// Recipe needs: a meal's ingredients cross-referenced with the HIT
// List (getRecipeNeeds). One "Recipe Needs" section sits under
// Membership Alternatives in the By section view. Nothing is listed
// by default: its search bar surfaces matching Meal List recipes as
// subsections over their still-needed ingredients — each need
// carrying its quick price check — covered recipes included.
type RecipeNeedsData = ApiResponse<typeof api, "getRecipeNeeds">;
type NeedsMeal = RecipeNeedsData["meals"][number];
type NeedsEntry = NeedsMeal["entries"][number];

// Sections are matched by MEANING, not by exact sheet title: the
// sheet's section headers have been renamed over time ("0 Stock" →
// "Out of Stock"; "Costco Alt." → "FFS (Frequent Flyer Alternatives)"
// → "Membership Alternatives"), and cached rows may carry any of
// those spellings. canonicalSection folds every known spelling into
// one of the three canonical sections below; a section title that
// matches none of them keeps its own title as a fallback group, so
// no rows ever vanish over a rename.
type CanonicalSection = "out" | "low" | "membership";

function canonicalSection(section: string): CanonicalSection | null {
  switch (section.trim().toLowerCase()) {
    case "0 stock":
    case "out of stock":
      return "out";
    case "low stock on sale now":
      return "low";
    case "costco alt.":
    case "ffs":
    case "ffs (frequent flyer alternatives)":
    case "membership alternatives":
      return "membership";
    default:
      return null;
  }
}

const SECTION_DEFS: { id: CanonicalSection; title: string }[] = [
  { id: "out", title: "Out of Stock" },
  { id: "low", title: "Low Stock on Sale Now" },
  { id: "membership", title: "Membership Alternatives" },
];

function money(cents: number): string {
  return `$${(cents / 100).toFixed(2)}`;
}

// FFS formal-name display: the sheet's Exact Product text reads like
// "Tinnel's Spicy Jamaican Beef Patties, 10-pack, 1.12 kg" — the
// FIRST comma (right after the product name, before the size/pack
// descriptor) is dropped for display only; later commas stay. The
// stored/sheet text is untouched.
function displayFormalName(name: string): string {
  const i = name.indexOf(",");
  return i === -1 ? name : name.slice(0, i) + name.slice(i + 1);
}

// The formal-name heading steps DOWN in size as it gets longer —
// same approach as the HIT List's long-name shrink — so a long sale
// name doesn't push the price past the end of the row. Length counts
// the whole heading line (formal name + bracketed inventory name).
function ffsNameFontSize(totalLength: number): number {
  if (totalLength <= 24) return 14;
  if (totalLength <= 32) return 13;
  if (totalLength <= 40) return 12;
  if (totalLength <= 48) return 11;
  return 10.5;
}

// Collapsible group header titles — the By section headers and the
// By store group headers — all use ONE uniform font size (user
// request, Nov 13, 2026), instead of the old length-based step-down
// that made longer titles render smaller. 20px is the largest size
// at which the longest title, "Membership Alternatives" (23
// characters), still displays in full on a phone-width screen.
// Titles are NEVER truncated with an ellipsis: the full title
// always shows, wrapping to a second line if it still needs the
// room. That includes the Out of Stock section's display title,
// "Shopping List - N" (app display only — the sheet section the
// scans write stays "Out of Stock"), N the number of unpurchased
// items in the section (Alpha 0.99): it renders at the same 20px
// as every other header, beside the banner's info (ⓘ) button. (It
// also carried an "N to get" label until Beta 0.01 removed it as
// redundant with the count in the title.)
// ONE exception: the Membership Alternatives header appends the
// NUMBER of the household's memberships to its title ("Membership
// Alternatives - 2"), so ITS font steps down as the title grows —
// see membershipTitleFontSize. What each count counts lives
// behind the small info (ⓘ) button beside the count in the
// banner: the membership names for Membership Alternatives
// (Alpha 0.97), the section's item names for Shopping List
// (Alpha 0.99).
const GROUP_TITLE_FONT_SIZE = 20;

// The stores the household holds a membership with — alternatives
// are priced against these (Costco and Amazon; Amazon is treated
// exactly like Costco). The Membership Alternatives banner counts
// every one of these that appears among the HIT List inventory's
// usual stores, and its ⓘ popup lists them by name.
const MEMBERSHIP_STORES = ["Costco", "Amazon"];

// The Membership Alternatives title carries the membership count
// ("Membership Alternatives - 2"), which can push it past the
// uniform 20px width once the ⓘ button beside the count is
// counted in. Its font steps DOWN as the full title gets longer —
// the same shrink-to-fit idea as the locked "Sales by Store"
// header — so the whole title always fits on one line. The plain
// title (23 chars, no count) keeps the uniform 20px.
function membershipTitleFontSize(totalLength: number): number {
  if (totalLength <= 26) return GROUP_TITLE_FONT_SIZE;
  if (totalLength <= 32) return 17;
  if (totalLength <= 38) return 15;
  if (totalLength <= 46) return 12.5;
  if (totalLength <= 54) return 11;
  return 10;
}

// Sections whose items are on sale right now (as opposed to the
// Out of Stock priority section). A sale-watched item carries its
// ★ marker when it appears in one of these.
function isOnSaleSection(section: string): boolean {
  const c = canonicalSection(section);
  return c === "low" || c === "membership";
}

// Membership-store alternative rows compare the sale price against
// the membership store's price, which the sheet carries inside the
// Best Price bracket text.
function isMembershipSection(section: string): boolean {
  return canonicalSection(section) === "membership";
}

// Chevron for a collapsible section header — the same rotating
// chevron the HIT List category headers use (points down when
// expanded, sideways when collapsed).
function SectionChevron({ collapsed }: { collapsed: boolean }) {
  return (
    <span
      aria-hidden="true"
      className="inline-flex h-5 w-5 shrink-0 items-center justify-center self-center text-[var(--dim)] transition-transform duration-200"
      style={{
        transform: collapsed ? "rotate(-90deg)" : "rotate(0deg)",
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
  );
}

/**
 * The small, visually quiet info (ⓘ) button that sits beside the
 * count in a section banner, with its popup listing — names only,
 * one per line, no heading — what the count counts. Shared by the
 * Membership Alternatives banner (the household's membership
 * stores; empty state "No stores") and the Shopping List
 * banner (the section's unpurchased item names; empty state
 * "No items"). The popup is anchored to the banner's right edge
 * and is HOLD-TO-SHOW (Beta 0.04, audit #6): it appears while the
 * ⓘ is held and fades away within 2 seconds of release; holding
 * the ⓘ never expands or collapses the section — the banner
 * title itself does that.
 */
function BannerInfoButton({
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
            names.map((name) => (
              <span
                key={name}
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

function daysLeft(endOfSale: string | null): number | null {
  if (!endOfSale) return null;
  if (/today/i.test(endOfSale)) return 0;
  const m = endOfSale.match(/(\d+)\s*day/);
  return m && m[1] ? parseInt(m[1], 10) : null;
}

function ItemRow({
  item,
  showStore,
  priority,
  qty,
  matchedHit,
  confirming,
  onToggle,
  onQtyChange,
  onConfirm,
}: {
  item: Item;
  showStore: boolean;
  priority: boolean;
  /** This row's −/+ counter value (shown beside the name while the
   * item is struck off and not yet confirmed). */
  qty: number;
  /** Whether the item matches a HIT List item by name; null while
   * the HIT List hasn't loaded yet. */
  matchedHit: boolean | null;
  /** True while this item's Purchased confirmation is saving. */
  confirming: boolean;
  onToggle: (item: Item) => void;
  onQtyChange: (qty: number) => void;
  onConfirm: (item: Item) => void;
}) {
  const days = daysLeft(item.endOfSale);
  const urgent = days !== null && days <= 2;
  // FFS rows are headed by the FORMAL product name of the
  // alternative on sale — the sheet's Exact Product text (e.g.
  // "Colgate or Crest Toothpaste, 50–100 mL", displayed with its
  // first comma dropped: "Colgate or Crest Toothpaste 50–100 mL")
  // — with the inventory item name in brackets right beside it
  // ("… [Toothpaste]") and the sale price pinned at the end: the
  // name shrinks (min-w-0, smaller font when long) and the price
  // block never shrinks or wraps, so the price always stays inside
  // the box. A row with no Exact Product text falls back to the
  // inventory name alone, no brackets. The comparison details from
  // the sheet's Best Price bracket, e.g. "save $3.05, $2.50 vs
  // $4.02/L, Costco $18.99", live behind a small "Savings ▾"
  // button placed directly UNDER the sale price in the price
  // column. The bracket is split here: the trailing "Costco $…" /
  // "Amazon $…" segment is the membership price, shown first in
  // the expanded content; the rest (the "save $…" and per-unit
  // comparison) is the savings detail, shown after it. Rows with
  // no bracket in the sheet text have no savingsNote and just show
  // the name with the plain price — nothing is invented here.
  const isFfs = isMembershipSection(item.section);
  const formalName = isFfs
    ? item.exactProduct
      ? displayFormalName(item.exactProduct)
      : item.exactProduct
    : null;
  // Heading font size: only FFS rows headed by a formal name step
  // down by length; other rows keep the default text-sm.
  const headingFontSize = formalName
    ? ffsNameFontSize(formalName.length + item.item.length + 3)
    : undefined;
  const bracketNote = isFfs ? item.savingsNote : null;
  const bracketMatch = bracketNote
    ? bracketNote.match(
        /^(.*?)(?:,\s*)?((?:Costco|Amazon)\s+\$[\d,]+(?:\.\d{2})?)\s*$/,
      )
    : null;
  const membershipNote = bracketMatch?.[2] ?? null;
  const savingsDetail = bracketMatch
    ? bracketMatch[1]?.replace(/,\s*$/, "").trim() || null
    : bracketNote;
  const [savingsOpen, setSavingsOpen] = useState(false);
  // Source dropdown: every row carrying a found price gets a small
  // "Source" toggle. Expanding shows the exact page the price was
  // verified on (recorded by the scan jobs) as the FULL URL, styled
  // as a hyperlink; tapping the URL opens a tiny menu with exactly
  // "Open link" and "Copy link". When no source has been recorded
  // for the item, the expanded area says so — no URL is ever
  // guessed or constructed here.
  const [sourceOpen, setSourceOpen] = useState(false);
  const [sourceMenuOpen, setSourceMenuOpen] = useState(false);
  const [sourceCopied, setSourceCopied] = useState(false);
  const hasPrice = item.priceCents !== null;
  const copySourceLink = async () => {
    if (!item.source) return;
    try {
      await navigator.clipboard.writeText(item.source.url);
    } catch {
      // Clipboard API unavailable (older webview): fall back to a
      // temporary textarea + execCommand copy.
      const ta = document.createElement("textarea");
      ta.value = item.source.url;
      ta.style.position = "fixed";
      ta.style.opacity = "0";
      document.body.appendChild(ta);
      ta.select();
      try {
        document.execCommand("copy");
      } catch {
        /* copy unavailable — the URL stays visible to copy by hand */
      }
      document.body.removeChild(ta);
    }
    setSourceCopied(true);
    window.setTimeout(() => setSourceCopied(false), 2000);
  };
  // One dismissal spec for the row's dropdown menus (Beta 0.04,
  // audit #6): while the Savings or Source menu is open, a tap
  // outside this row's content, a scroll, or Escape closes it —
  // they no longer close only by re-tapping their toggle.
  const rowMenuRef = useRef<HTMLDivElement | null>(null);
  useMenuDismiss(savingsOpen || sourceOpen, rowMenuRef, () => {
    setSavingsOpen(false);
    setSourceOpen(false);
    setSourceMenuOpen(false);
  });
  // Two-step purchase: striking the item off alone changes nothing.
  // While it's struck and unconfirmed, the row grows a −/+ counter
  // beside the name and a Purchased button beside the price; tapping
  // Purchased opens the quantity popup, and only confirming THAT
  // records the quantity into the inventory.
  const showConfirmControls =
    item.checked && !item.restocked && matchedHit === true;
  return (
    <li
      className={`flex gap-[9px] px-3 py-[9px] ${
        item.checked && item.restocked && priority ? "opacity-45" : ""
      }`}
    >
      <button
        type="button"
        role="checkbox"
        aria-checked={item.checked}
        aria-label={
          priority
            ? `Mark ${item.item} as purchased`
            : `Mark ${item.item} as picked up`
        }
        onClick={() => onToggle(item)}
        className="mt-0.5 flex h-[33px] w-[33px] shrink-0 items-center justify-center rounded-full border-2 text-sm font-bold"
        style={{
          borderColor: item.checked ? "var(--accent)" : "var(--border)",
          backgroundColor: item.checked ? "var(--accent)" : "transparent",
          color: item.checked ? "var(--accent-text)" : "transparent",
        }}
      >
        ✓
      </button>
      <div ref={rowMenuRef} className="min-w-0 flex-1">
        <div className="flex items-start justify-between gap-2">
          <div className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1">
            <p
              className={`min-w-0 text-sm font-semibold leading-snug text-[var(--text)] ${
                item.checked ? "line-through" : ""
              }`}
              style={
                headingFontSize ? { fontSize: headingFontSize } : undefined
              }
            >
              {formalName ?? item.item}
              {formalName && (
                <span className="font-medium text-[var(--dim)]">
                  {" "}
                  [{item.item}]
                </span>
              )}
              {item.watched && isOnSaleSection(item.section) && (
                <span
                  className="ml-1.5 inline-block rounded-full px-1.5 py-0.5 align-middle text-[13px] font-bold"
                  style={{
                    backgroundColor: "var(--amber-soft)",
                    color: "var(--amber)",
                  }}
                  aria-label="Watched for sales"
                  title="Watched for sales"
                >
                  ★ Watched
                </span>
              )}
            </p>
            {showConfirmControls && (
              <span className="inline-flex shrink-0 items-center gap-1">
                <button
                  type="button"
                  aria-label={`One fewer of ${item.item}`}
                  disabled={qty <= 1}
                  onClick={() => onQtyChange(Math.max(1, qty - 1))}
                  className="rounded-lg border border-[var(--border)] bg-[var(--surface)] px-2.5 font-medium disabled:opacity-40"
                >
                  −
                </button>
                <span className="min-w-6 text-center text-sm font-medium tabular-nums">
                  {qty}
                </span>
                <button
                  type="button"
                  aria-label={`One more of ${item.item}`}
                  onClick={() => onQtyChange(qty + 1)}
                  className="rounded-lg border border-[var(--border)] bg-[var(--surface)] px-2.5 font-medium"
                >
                  +
                </button>
              </span>
            )}
          </div>
          <div className="flex shrink-0 flex-col items-end gap-1">
            <div className="flex items-center justify-end gap-2">
              {item.priceCents !== null ? (
                <p className="shrink-0 whitespace-nowrap text-right text-base font-bold tabular-nums text-[var(--text)]">
                  {money(item.priceCents)}
                </p>
              ) : (
                <p className="shrink-0 whitespace-nowrap text-xs italic text-[var(--dim)]">
                  No verified price found yet
                </p>
              )}
              {item.checked && item.restocked && (
                <button
                  type="button"
                  disabled
                  aria-label={`${item.item} purchase confirmed into the inventory`}
                  className="shrink-0 rounded-full px-3 py-1 text-xs font-bold"
                  style={{
                    backgroundColor: "var(--accent)",
                    color: "var(--accent-text)",
                  }}
                >
                  Purchased ✓
                </button>
              )}
              {showConfirmControls && (
                <button
                  type="button"
                  aria-label={`Confirm ${item.item} as purchased`}
                  disabled={confirming}
                  onClick={() => onConfirm(item)}
                  className="shrink-0 rounded-full px-3 py-1 text-xs font-bold disabled:opacity-50"
                  style={{
                    backgroundColor: "var(--accent)",
                    color: "var(--accent-text)",
                  }}
                >
                  {confirming ? "Adding…" : "Purchased"}
                </button>
              )}
            </div>
            {bracketNote && (membershipNote || savingsDetail) && (
              <span className="relative inline-flex items-center gap-1">
                <button
                  type="button"
                  aria-expanded={savingsOpen}
                  aria-label={`${savingsOpen ? "Hide" : "Show"} savings details for ${item.item}`}
                  onClick={() => setSavingsOpen((v) => !v)}
                  className="hit24y inline-flex items-center gap-[3.45px] rounded-full px-[6.9px] py-[1.725px] text-[12px] leading-none font-bold"
                  style={{
                    backgroundColor: "var(--surface-alt)",
                    color: "var(--accent)",
                    border: "1px solid var(--border)",
                    // 15% larger than the 16.5px size this toggle
                    // previously had — also overrides the global 2rem
                    // button minimum in theme.css, which would
                    // otherwise make this small button taller. The
                    // text sits at the 12px floor (audit #10) on a
                    // line-height of 1, so the pill's visual height
                    // is unchanged; the .hit24y overlay (theme.css)
                    // grows the tappable height to 24px.
                    minHeight: "19px",
                  }}
                >
                  Savings
                  <span aria-hidden="true">{savingsOpen ? "▴" : "▾"}</span>
                </button>
              </span>
            )}
            {hasPrice && (
              <button
                type="button"
                aria-expanded={sourceOpen}
                aria-label={`${sourceOpen ? "Hide" : "Show"} source for ${item.item}`}
                onClick={() => {
                  setSourceOpen((v) => !v);
                  setSourceMenuOpen(false);
                }}
                className="hit24y inline-flex items-center gap-[3.45px] rounded-full px-[6.9px] py-[1.725px] text-[12px] leading-none font-bold"
                style={{
                  backgroundColor: "var(--surface-alt)",
                  color: "var(--accent)",
                  border: "1px solid var(--border)",
                  // Same size as the Savings toggle (see its
                  // comment): overrides the global 2rem button
                  // minimum so the toggle stays compact, with the
                  // same 12px text and 24px tappable height.
                  minHeight: "19px",
                }}
              >
                Source
                <span aria-hidden="true">{sourceOpen ? "▴" : "▾"}</span>
              </button>
            )}
          </div>
        </div>
        {savingsOpen && bracketNote && (membershipNote || savingsDetail) && (
          <div className="mt-1 flex flex-col items-end gap-1 text-right">
            {membershipNote && (
              <span className="text-xs font-semibold text-[var(--dim)]">
                {membershipNote}
              </span>
            )}
            {savingsDetail && (
              <p
                className="inline-block rounded px-1.5 py-0.5 text-[13px] font-semibold"
                style={{
                  backgroundColor: "var(--accent-soft)",
                  color: "var(--accent)",
                }}
              >
                Save {savingsDetail.replace(/^save\s*/i, "")}
              </p>
            )}
          </div>
        )}
        {sourceOpen && hasPrice && (
          <div className="mt-1.5">
            {item.source ? (
              <>
                <p className="text-[13px] font-medium text-[var(--dim)]">
                  {item.source.sourceType === "flipp"
                    ? "Found on Flipp"
                    : item.source.store
                      ? `Found on the ${item.source.store} website`
                      : "Found on a store website"}
                </p>
                <button
                  type="button"
                  aria-haspopup="menu"
                  aria-expanded={sourceMenuOpen}
                  aria-label={`Source link options for ${item.item}`}
                  onClick={() => setSourceMenuOpen((v) => !v)}
                  className="mt-0.5 block max-w-full text-left text-xs font-medium break-all underline"
                  style={{ color: "var(--accent)" }}
                >
                  {item.source.url}
                </button>
                {sourceMenuOpen && (
                  <div
                    role="menu"
                    aria-label="Source link actions"
                    className="mt-1.5 inline-flex overflow-hidden rounded-lg"
                    style={{ border: "1px solid var(--border)" }}
                  >
                    <a
                      role="menuitem"
                      href={item.source.url}
                      target="_blank"
                      rel="noreferrer"
                      className="inline-flex items-center px-3 text-xs font-bold"
                      style={{
                        backgroundColor: "var(--surface)",
                        color: "var(--accent)",
                        minHeight: "2rem",
                      }}
                    >
                      Open link
                    </a>
                    <button
                      type="button"
                      role="menuitem"
                      onClick={copySourceLink}
                      className="px-3 text-xs font-bold"
                      style={{
                        backgroundColor: "var(--surface-alt)",
                        color: "var(--accent)",
                      }}
                    >
                      {sourceCopied ? "Copied ✓" : "Copy link"}
                    </button>
                  </div>
                )}
              </>
            ) : (
              <p className="text-xs italic text-[var(--dim)]">
                No source recorded yet
              </p>
            )}
          </div>
        )}
        {item.checked && !item.restocked && matchedHit === false && (
          <p className="mt-0.5 text-xs text-[var(--dim)]">
            Not on the HIT List — not added
          </p>
        )}
        {/* On FFS rows the Exact Product text is already the row's
            heading (formalName above), so it isn't repeated here;
            other sections keep their small exact-product line. */}
        {item.exactProduct && !formalName && (
          <p className="mt-0.5 text-xs leading-snug text-[var(--dim)]">
            {item.exactProduct}
          </p>
        )}
        {item.savingsNote && !bracketNote && (
          <p
            className="mt-0.5 inline-block rounded px-1.5 py-0.5 text-[13px] font-semibold"
            style={{
              backgroundColor: "var(--accent-soft)",
              color: "var(--accent)",
            }}
          >
            Save {item.savingsNote.replace(/^save\s*/i, "")}
          </p>
        )}
        {item.priceTrend && (
          <p
            className="mt-0.5 text-[13px] text-[var(--dim)]"
            aria-label={`Lowest price seen ${money(item.priceTrend.lowestCents)} on ${item.priceTrend.lowestDate}; price ${item.priceTrend.direction === "down" ? "went down" : item.priceTrend.direction === "up" ? "went up" : "unchanged"} since the previous check`}
          >
            Lowest seen {money(item.priceTrend.lowestCents)} ·{" "}
            {item.priceTrend.lowestDate} ·{" "}
            {item.priceTrend.direction === "down"
              ? "↓"
              : item.priceTrend.direction === "up"
                ? "↑"
                : "→"}
          </p>
        )}
        <div className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-1 text-[13px]">
          {item.stock === 0 ? (
            <span
              className="rounded-full px-2 py-0.5 font-bold"
              style={{
                backgroundColor: "var(--red-soft)",
                color: "var(--red)",
              }}
            >
              Out of stock
            </span>
          ) : (
            <span className="text-[var(--dim)]">{item.stock} left</span>
          )}
          {showStore && item.buyAt && (
            <span className="font-semibold text-[var(--text)]">
              {item.buyAt}
            </span>
          )}
          {item.endOfSale && (
            <span
              className="font-semibold"
              style={{ color: urgent ? "var(--red)" : "var(--amber)" }}
            >
              {item.endOfSale}
            </span>
          )}
        </div>
      </div>
    </li>
  );
}

/**
 * One still-needed ingredient in a Recipe Needs section: the
 * ingredient, how it falls short, and its quick price check (sale
 * price + store + end of sale when on sale, otherwise the lowest
 * verified regular price). The round check-off works like the sheet
 * rows' but is display-only — checking a needs row never records a
 * purchase or changes inventory.
 */
function RecipeNeedRow({
  meal,
  entry,
  onToggle,
}: {
  meal: NeedsMeal;
  entry: NeedsEntry;
  onToggle: (meal: NeedsMeal, entry: NeedsEntry) => void;
}) {
  const price = entry.price;
  const donePrice = price?.status === "done" ? price : null;
  const onSale = donePrice != null && donePrice.salePriceCents != null;
  const shownCents = donePrice
    ? (donePrice.salePriceCents ?? donePrice.regularPriceCents)
    : null;
  const shownStore = donePrice
    ? onSale
      ? donePrice.saleStore
      : donePrice.regularStore
    : null;
  const saleEnd = onSale && donePrice ? donePrice.saleEnd : null;
  const days = daysLeft(entry.price?.saleEnd ?? null);
  const urgent = days !== null && days <= 2;
  const detailParts: string[] = [];
  if (entry.quantity != null) {
    detailParts.push(
      `Recipe needs ${entry.quantity}${entry.unit ? ` ${entry.unit}` : ""}`,
    );
  }
  if (entry.status === "short") {
    detailParts.push(
      `have ${entry.have ?? 0}${entry.matchedItem ? ` of ${entry.matchedItem}` : ""} — short ${entry.shortfall ?? ""}`.trim(),
    );
  } else if (entry.matchedItem) {
    detailParts.push(`${entry.matchedItem} is out of stock`);
  } else {
    detailParts.push("Not on the HIT List");
  }
  return (
    <li className="flex gap-[9px] px-3 py-[9px]">
      <button
        type="button"
        role="checkbox"
        aria-checked={entry.checked}
        aria-label={`Mark ${entry.name} for ${meal.mealName} as picked up`}
        onClick={() => onToggle(meal, entry)}
        className="mt-0.5 flex h-[33px] w-[33px] shrink-0 items-center justify-center rounded-full border-2 text-sm font-bold"
        style={{
          borderColor: entry.checked ? "var(--accent)" : "var(--border)",
          backgroundColor: entry.checked ? "var(--accent)" : "transparent",
          color: entry.checked ? "var(--accent-text)" : "transparent",
        }}
      >
        ✓
      </button>
      <div className="min-w-0 flex-1">
        <div className="flex items-start justify-between gap-2">
          <p
            className={`min-w-0 text-sm leading-snug font-semibold text-[var(--text)] ${
              entry.checked ? "line-through" : ""
            }`}
          >
            {entry.name}
          </p>
          <div className="flex shrink-0 flex-col items-end gap-1">
            {shownCents != null ? (
              <p className="shrink-0 whitespace-nowrap text-right text-base font-bold tabular-nums text-[var(--text)]">
                {money(shownCents)}
              </p>
            ) : price?.status === "pending" ? (
              <p className="shrink-0 text-xs whitespace-nowrap text-[var(--dim)] italic">
                Checking prices…
              </p>
            ) : (
              <p className="shrink-0 text-xs whitespace-nowrap text-[var(--dim)] italic">
                No verified price found yet
              </p>
            )}
            {price?.sourceUrl && (
              <SourceDropdown
                name={entry.name}
                heading={
                  price.sourceType === "flipp"
                    ? "Found on Flipp"
                    : shownStore
                      ? `Found on the ${shownStore} website`
                      : "Found on a store website"
                }
                url={price.sourceUrl}
                itemLabel={entry.name}
              />
            )}
          </div>
        </div>
        <p className="mt-0.5 text-xs leading-snug text-[var(--dim)]">
          {detailParts.join(" · ")}
        </p>
        {donePrice && (
          <div className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-1 text-[13px]">
            {onSale ? (
              <span
                className="rounded-full px-2 py-0.5 font-bold"
                style={{
                  backgroundColor: "var(--accent-soft)",
                  color: "var(--accent)",
                }}
              >
                On sale
              </span>
            ) : (
              <span className="text-[var(--dim)]">Lowest regular price</span>
            )}
            {shownStore && (
              <span className="font-semibold text-[var(--text)]">
                {shownStore}
              </span>
            )}
            {onSale && saleEnd && (
              <span
                className="font-semibold"
                style={{ color: urgent ? "var(--red)" : "var(--amber)" }}
              >
                {saleEnd}
              </span>
            )}
          </div>
        )}
        {price?.status === "failed" && (
          <p className="mt-0.5 text-xs text-[var(--dim)] italic">
            {price.note ?? "No verified price found yet"}
          </p>
        )}
        {donePrice?.note && (
          <p className="mt-0.5 text-xs text-[var(--dim)]">
            {donePrice.note}
          </p>
        )}
      </div>
    </li>
  );
}

/**
 * One recipe's subsection inside the "Recipe Needs" section: the
 * recipe's name as a subheading with its own Recheck prices button,
 * over its still-needed ingredients. A recipe with nothing needed
 * (reachable through the section's search) shows an "all
 * ingredients on hand" line and no ingredient rows.
 */
function RecipeNeedsSubsection({
  meal,
  rechecking,
  onRecheck,
  onToggleNeed,
}: {
  meal: NeedsMeal;
  rechecking: boolean;
  onRecheck: () => void;
  onToggleNeed: (meal: NeedsMeal, entry: NeedsEntry) => void;
}) {
  const needs = meal.entries.filter((e) => e.status !== "covered");
  // "To get" (Beta 0.02, audit #2): the needs not yet picked up.
  // When every need is checked this is 0 and the label below reads
  // "0 to get" — it never falls back to the full needs count.
  const remaining = needs.filter((e) => !e.checked).length;
  const anyPending = needs.some((e) => e.price?.status === "pending");
  return (
    <div>
      <div className="flex items-center justify-between gap-3 px-3 pt-2.5 pb-1">
        <p className="flex min-w-0 flex-wrap items-baseline gap-x-2">
          <span className="text-base font-bold text-[var(--text)]">
            {meal.mealName}
          </span>
          <span className="text-xs font-medium text-[var(--dim)]">
            {needs.length === 0
              ? "all ingredients on hand"
              : `${remaining} to get`}
          </span>
        </p>
        {needs.length > 0 && (
          <button
            type="button"
            aria-label={`Recheck prices for ${meal.mealName}`}
            disabled={rechecking || anyPending}
            onClick={onRecheck}
            className="shrink-0 rounded-full border border-[var(--border)] bg-[var(--surface)] px-3 py-1 text-xs font-bold text-[var(--accent)] disabled:opacity-50"
          >
            {rechecking || anyPending ? "Checking…" : "Recheck prices"}
          </button>
        )}
      </div>
      {needs.length === 0 ? (
        <p className="px-3 pb-2.5 text-sm text-[var(--dim)]">
          ✓ All ingredients on hand — you have {meal.coveredCount} of{" "}
          {meal.totalCount} ingredients for this recipe.
        </p>
      ) : (
        <ul className="divide-y">
          {needs.map((entry) => (
            <RecipeNeedRow
              key={entry.name}
              meal={meal}
              entry={entry}
              onToggle={onToggleNeed}
            />
          ))}
        </ul>
      )}
    </div>
  );
}

/**
 * The single "Recipe Needs" section: the pronounced group bar (same
 * treatment as the other By section headers) over a search bar. No
 * recipes are listed by default — the section sits at just its bar,
 * the search bar, and a hint. Typing in the search bar filters the
 * Meal List's recipes by partial name and surfaces matching
 * subsections (name header + still-needed ingredients, coverage
 * derived fresh on every read, so a restocked ingredient drops
 * off); a fully covered match shows as all on hand, with no
 * ingredient rows. Clearing the search returns the section to its
 * empty, search-only state.
 */
function RecipeNeedsSection({
  allMeals,
  collapsed,
  search,
  recheckingMealId,
  onToggleSection,
  onSearchChange,
  onRecheck,
  onToggleNeed,
}: {
  allMeals: NeedsMeal[];
  collapsed: boolean;
  search: string;
  recheckingMealId: number | null;
  onToggleSection: () => void;
  onSearchChange: (value: string) => void;
  onRecheck: (meal: NeedsMeal) => void;
  onToggleNeed: (meal: NeedsMeal, entry: NeedsEntry) => void;
}) {
  const query = search.trim().toLowerCase();
  const searching = query.length > 0;
  // Nothing is listed until the user searches: matches come from the
  // Meal List's recipes (allMeals), partial-name matched.
  const shown = searching
    ? allMeals.filter((m) => m.mealName.toLowerCase().includes(query))
    : [];
  const panelId = "shop-group-recipe-needs";
  return (
    <section className="mt-2">
      <button
        type="button"
        aria-expanded={!collapsed}
        aria-controls={panelId}
        aria-label={`${collapsed ? "Expand" : "Collapse"} Recipe Needs section`}
        onClick={onToggleSection}
        className="flex w-full items-center justify-between gap-3 rounded-xl px-3 py-2 text-left"
        style={{
          backgroundColor: "var(--accent-soft)",
          border: "2px solid var(--accent)",
        }}
      >
        <span className="flex min-w-0 items-center gap-1.5">
          <SectionChevron collapsed={collapsed} />
          <span
            className="font-bold text-[var(--text)]"
            style={{
              fontSize: `${GROUP_TITLE_FONT_SIZE}px`,
              lineHeight: 1.2,
            }}
          >
            Recipe Needs
          </span>
        </span>
      </button>
      {!collapsed && (
        <div
          id={panelId}
          className="mt-1.5 overflow-hidden rounded-2xl"
          style={{
            backgroundColor: "var(--surface)",
            border: "1px solid var(--border)",
          }}
        >
          <div className="px-3 pt-3">
            <label className="sr-only" htmlFor="recipe-needs-search">
              Search for a recipe
            </label>
            <input
              id="recipe-needs-search"
              type="search"
              value={search}
              onChange={(e) => onSearchChange(e.target.value)}
              placeholder="Search for a recipe…"
              className="w-full rounded-full border border-[var(--border)] bg-[var(--surface-alt)] px-4 py-2 text-sm text-[var(--text)]"
            />
          </div>
          {shown.length === 0 ? (
            <p className="px-3 py-3 text-sm text-[var(--dim)]">
              {searching
                ? `No recipe matches “${search.trim()}”.`
                : "Search for a recipe to see what it needs."}
            </p>
          ) : (
            <div className="divide-y">
              {shown.map((meal) => (
                <RecipeNeedsSubsection
                  key={meal.mealId}
                  meal={meal}
                  rechecking={recheckingMealId === meal.mealId}
                  onRecheck={() => onRecheck(meal)}
                  onToggleNeed={onToggleNeed}
                />
              ))}
            </div>
          )}
        </div>
      )}
    </section>
  );
}

export function ShoppingTab() {
  const queryClient = useQueryClient();
  const [view, setView] = useState<"section" | "store">("section");
  const [hidePurchased, setHidePurchased] = useState(false);
  // Collapsible groups start COLLAPSED when the app launches —
  // every By section group (Out of Stock, Low Stock on Sale Now,
  // Membership Alternatives, Recipe Needs) and every By store
  // group. The state tracks which groups the user has EXPANDED
  // (empty on launch = everything collapsed); tapping a group
  // header toggles just that group. View-local state only — no
  // data changes, and it resets on relaunch.
  const [expandedSections, setExpandedSections] = useState<
    ReadonlySet<string>
  >(new Set());
  const toggleSection = (key: string) =>
    setExpandedSections((prev) => {
      const next = new Set(prev);
      if (next.has(key)) {
        next.delete(key);
      } else {
        next.add(key);
      }
      return next;
    });
  const [refreshingSince, setRefreshingSince] = useState<string | null>(null);
  const [refreshFailed, setRefreshFailed] = useState(false);
  // When the in-flight refresh started, for the timeout below.
  const refreshStartedAtRef = useRef<number | null>(null);

  const list = useQuery({
    queryKey: ["list"],
    queryFn: () => api.getList({}),
    refetchInterval: refreshingSince ? 4000 : false,
  });


  const refreshedAt = list.data?.refreshedAt ?? null;
  useEffect(() => {
    if (refreshingSince && refreshedAt && refreshedAt !== refreshingSince) {
      setRefreshingSince(null);
      refreshStartedAtRef.current = null;
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
    mutationFn: async () => await api.refreshList({}),
    onSuccess: (res) => {
      if (res.started) {
        refreshStartedAtRef.current = Date.now();
        setRefreshFailed(false);
        setRefreshingSince(refreshedAt ?? "pending");
      }
    },
  });

  const toggle = useMutation({
    mutationFn: async (item: Item) =>
      await api.setChecked({ key: item.key, checked: !item.checked }),
    onSuccess: () =>
      queryClient.invalidateQueries({ queryKey: ["list"] }),
  });

  // ---- Recipe needs ---------------------------------------------------
  // Derived from the Meal Planner's meals + the HIT List: one
  // "Recipe Needs" section (By section view, under Membership
  // Alternatives) lists nothing by default; its search bar surfaces
  // matching recipes' subsections, covered ones included. When needs
  // show up without a fresh price, a
  // quick price check starts on its own (the server only re-checks
  // what's actually stale); while any price is pending the query
  // polls for the result.
  const [needsSearch, setNeedsSearch] = useState("");
  const needsQuery = useQuery({
    queryKey: ["recipe-needs"],
    queryFn: () => api.getRecipeNeeds({}),
    refetchInterval: (q) =>
      q.state.data?.meals.some((m) =>
        m.entries.some((e) => e.price?.status === "pending"),
      )
        ? 4000
        : false,
  });
  const needsMeals = (needsQuery.data?.meals ?? []).filter((m) =>
    m.entries.some((e) => e.status !== "covered"),
  );

  const checkNeeds = useMutation({
    mutationFn: async (args: { mealId: number; force?: boolean }) =>
      await api.checkRecipeNeeds({
        mealId: args.mealId,
        force: args.force,
      }),
    onSuccess: () =>
      queryClient.invalidateQueries({ queryKey: ["recipe-needs"] }),
  });
  const triggeredNeedsRef = useRef<Set<string>>(new Set());
  useEffect(() => {
    if (!needsQuery.data) return;
    const WEEK_MS = 7 * 86_400_000;
    const DAY_MS = 86_400_000;
    for (const m of needsQuery.data.meals) {
      const mealNeeds = m.entries.filter((e) => e.status !== "covered");
      if (mealNeeds.length === 0) continue;
      const anyStale = mealNeeds.some((e) => {
        const p = e.price;
        if (!p) return true;
        if (p.status === "pending") return false;
        if (!p.checkedAt) return true;
        const age = Date.now() - new Date(p.checkedAt).getTime();
        return p.status === "failed" ? age > DAY_MS : age > WEEK_MS;
      });
      if (!anyStale) continue;
      const signature = `${m.mealId}|${mealNeeds.map((e) => e.name).join("|")}`;
      if (triggeredNeedsRef.current.has(signature)) continue;
      triggeredNeedsRef.current.add(signature);
      checkNeeds.mutate({ mealId: m.mealId });
    }
    // checkNeeds is a stable mutation object; the guard ref above
    // keeps this from looping.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [needsQuery.data]);

  const toggleNeed = useMutation({
    mutationFn: async (args: {
      mealId: number;
      ingredient: string;
      checked: boolean;
    }) => await api.setRecipeNeedChecked(args),
    onSuccess: () =>
      queryClient.invalidateQueries({ queryKey: ["recipe-needs"] }),
  });

  const allNeedsMeals = needsQuery.data?.meals ?? [];
  const needsSection =
    view === "section" && allNeedsMeals.length > 0 ? (
      <RecipeNeedsSection
        allMeals={allNeedsMeals}
        collapsed={!expandedSections.has("recipe-needs")}
        search={needsSearch}
        recheckingMealId={
          checkNeeds.isPending
            ? (checkNeeds.variables?.mealId ?? null)
            : null
        }
        onToggleSection={() => toggleSection("recipe-needs")}
        onSearchChange={setNeedsSearch}
        onRecheck={(meal) =>
          checkNeeds.mutate({ mealId: meal.mealId, force: true })
        }
        onToggleNeed={(m, entry) =>
          toggleNeed.mutate({
            mealId: m.mealId,
            ingredient: entry.name,
            checked: !entry.checked,
          })
        }
      />
    ) : null;

  // ---- Purchased confirmations --------------------------------------
  // Two-step purchase, like a two-factor check: striking an item off
  // the list changes nothing in the inventory. A struck-off item
  // grows a −/+ quantity counter beside its name and a "Purchased"
  // button beside its price, right on its row. Tapping Purchased
  // opens a popup window asking how many were bought (Alpha 0.91):
  // the quantity starts at the row's counter value — the quantity
  // the row calls for, or 1 when it was never adjusted — and only
  // CONFIRMING the popup records a pending +quantity stock
  // adjustment for the HIT List item it matches. Cancelling the
  // popup changes nothing. Once confirmed, the button flips to a
  // disabled "Purchased ✓", and the confirmation survives
  // un-striking and re-striking the item, so it can't be recorded
  // twice. The sheet itself is read-only — the auto-scan writes
  // the adjustments to it later; the app's stock counts include
  // them right away.
  // (This inventory read also feeds the Membership Alternatives
  // banner's membership count and ⓘ list — see membershipStores.
  // The Shopping List banner's count and ⓘ list come from the
  // section's own rows.)
  const hit = useQuery({
    queryKey: ["hit"],
    queryFn: () => api.getHitList({}),
  });
  const [quantities, setQuantities] = useState<Record<string, number>>(
    {},
  );
  const [confirmNote, setConfirmNote] = useState<string | null>(null);
  // The Purchased quantity popup: the item awaiting confirmation
  // and the quantity typed/stepped inside the popup.
  const [purchasePrompt, setPurchasePrompt] = useState<Item | null>(
    null,
  );
  const [promptQty, setPromptQty] = useState(1);
  // The section banners' ⓘ popups (the Membership Alternatives
  // membership stores, Alpha 0.97; the Shopping List item names,
  // Alpha 0.99) are self-contained — see BannerInfoButton.

  const hitNameByKey = useMemo(() => {
    const map = new Map<string, string>();
    for (const i of hit.data?.items ?? []) {
      map.set(i.item.trim().toLowerCase(), i.item);
    }
    return map;
  }, [hit.data]);

  const confirmPurchase = useMutation({
    mutationFn: async (args: { item: Item; quantity: number }) =>
      await api.confirmPurchased({
        key: args.item.key,
        item: args.item.item,
        quantity: args.quantity,
      }),
    onSuccess: (res, args) => {
      const { item } = args;
      setPurchasePrompt(null);
      if (res.recorded) {
        setConfirmNote(
          `${item.item} × ${args.quantity} added to the inventory — counts are updated here now.`,
        );
        setQuantities((prev) => {
          const next = { ...prev };
          delete next[item.key];
          return next;
        });
      } else if (res.alreadyConfirmed) {
        setConfirmNote(
          `${item.item} was already confirmed — it wasn't added twice.`,
        );
      } else {
        setConfirmNote(
          `${item.item} isn't on the HIT List, so it wasn't added to the inventory.`,
        );
      }
      queryClient.invalidateQueries({ queryKey: ["hit"] });
      queryClient.invalidateQueries({ queryKey: ["list"] });
    },
    onError: () =>
      setConfirmNote("That purchase couldn't be saved. Try again."),
  });

  // Escape closes the quantity popup under the same guard as its
  // backdrop (Beta 0.04, audit #6): only while nothing is pending.
  useEffect(() => {
    if (!purchasePrompt) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape" && !confirmPurchase.isPending)
        setPurchasePrompt(null);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [purchasePrompt, confirmPurchase.isPending]);

  const items = list.data?.items ?? [];
  // "Hide purchased" hides only CONFIRMED purchases (Purchased ✓):
  // an item merely struck off but not yet confirmed stays visible —
  // it still needs its Purchased tap.
  const visible = hidePurchased
    ? items.filter((i) => !i.restocked)
    : items;
  // Header: every store on the list with how many items are at it,
  // under the title "Sales by Store". Counts cover the whole list
  // (checked-off items included) — the out-of-stock count now lives
  // on the HIT List tab. Items with no buy-at store yet don't appear
  // in the header at all.
  // The header panel is locked at its current height (132px — the
  // height it renders at with 4 stores, 16px store names / 14px
  // counts, py-3 panel padding and py-0.5 rows). It never grows or
  // shrinks: the title fits inside that same 132px, and the store
  // rows' font-shrink logic absorbs it — the title counts as one
  // extra row unit when scaling, so with more content the font
  // scales down and every store still fits inside the same panel,
  // and with fewer stores the rows spread to fill the same height
  // at full font size.
  const STORE_HEADER_HEIGHT = 132;
  const STORE_HEADER_BASE_ROWS = 4;
  const storeCounts = useMemo(() => {
    const counts = new Map<string, number>();
    for (const item of items) {
      if (!item.buyAt) continue;
      const store = item.buyAt;
      counts.set(store, (counts.get(store) ?? 0) + 1);
    }
    return Array.from(counts.entries())
      .map(([store, count]) => ({ store, count }))
      .sort(
        (a, b) => b.count - a.count || a.store.localeCompare(b.store),
      );
  }, [items]);

  // Font scale for the locked header: full size (16px / 14px) up to
  // the baseline 4 row units, then proportionally smaller as the
  // content grows so all rows fit the fixed 132px height. The
  // "Sales by Store" title counts as one row unit, so the store
  // fonts shrink a step sooner than before and absorb the title
  // inside the unchanged panel height.
  const storeHeaderUnits = storeCounts.length + 1;
  const storeHeaderScale =
    storeHeaderUnits > STORE_HEADER_BASE_ROWS
      ? STORE_HEADER_BASE_ROWS / storeHeaderUnits
      : 1;
  const storeNameFontSize = Math.max(8, 16 * storeHeaderScale);
  const storeCountFontSize = Math.max(7, 14 * storeHeaderScale);

  // The household's membership stores, counted in the Membership
  // Alternatives banner ("Membership Alternatives - 2") and
  // listed by name in the banner's ⓘ popup: EVERY membership
  // store represented in the HIT List inventory — the distinct
  // membership stores (MEMBERSHIP_STORES) among the inventory
  // items' usual stores, in canonical order — whether or not an
  // alternative for that store happens to be on the Shopping List
  // right now. (For this household: Costco and Amazon, since
  // Amazon items are tracked in the inventory too.) While the
  // inventory hasn't loaded, or holds no membership-store items,
  // fall back to the usual stores of the items sitting in the
  // Membership Alternatives section, as before. Empty only when
  // neither source names a store, in which case the banner shows
  // a count of 0 and the popup says "No stores".
  const membershipStores = useMemo(() => {
    const inventoryStores = new Set(
      (hit.data?.items ?? []).map((i) => i.store.trim().toLowerCase()),
    );
    const fromInventory = MEMBERSHIP_STORES.filter((s) =>
      inventoryStores.has(s.toLowerCase()),
    );
    if (fromInventory.length > 0) return fromInventory;
    const stores: string[] = [];
    for (const item of items) {
      if (canonicalSection(item.section) !== "membership") continue;
      const store = item.usualStore.trim();
      if (store && !stores.includes(store)) stores.push(store);
    }
    return stores;
  }, [hit.data, items]);

  const groups = useMemo(() => {
    if (view === "store") {
      const byStore = new Map<string, Item[]>();
      // Items with no buy-at store yet get their own group at the
      // end (Beta 0.05, audit #7) instead of vanishing from this
      // view, so every row appears somewhere and the per-store
      // counts plus this group sum to the list total.
      const noStoreItems: Item[] = [];
      for (const item of visible) {
        if (!item.buyAt) {
          noStoreItems.push(item);
          continue;
        }
        const store = item.buyAt;
        const arr = byStore.get(store) ?? [];
        arr.push(item);
        byStore.set(store, arr);
      }
      const storeGroup = (title: string, groupItems: Item[], key: string) => {
        // "To get" has ONE meaning app-wide (Beta 0.02, audit #2):
        // unpurchased — not settled via the Purchased confirmation
        // (restocked), matching the Shopping List banner's count.
        // A struck-but-not-Purchased row still counts as to get.
        const remaining = groupItems.filter((i) => !i.restocked);
        return {
          key,
          title,
          titleFontSize: null,
          // Plain count only — no descriptive text beside the
          // store name: how many items are still to get at this
          // store, or the plain item count when all are purchased.
          countLabel:
            remaining.length > 0
              ? `${remaining.length} to get`
              : `${groupItems.length}`,
          items: groupItems,
          showStore: false,
          membership: false,
          infoNames: null as string[] | null,
          infoEmptyText: "",
          infoAriaLabel: "",
          collapsible: true,
        };
      };
      const storeGroups = Array.from(byStore.entries()).map(
        ([title, groupItems]) =>
          storeGroup(title, groupItems, `store:${title}`),
      );
      if (noStoreItems.length > 0) {
        storeGroups.push(
          storeGroup("No store yet", noStoreItems, "store:__none__"),
        );
      }
      return storeGroups;
    }
    // By section: group by canonical section (matched by meaning —
    // see canonicalSection), displayed under the current titles.
    const sectionGroups = SECTION_DEFS.map((def) => {
      const groupItems = visible.filter(
        (i) => canonicalSection(i.section) === def.id,
      );
      // Three banners carry a COUNT in their title, with the
      // counted names listed in the banner's ⓘ popup
      // (BannerInfoButton) — the one header spec app-wide
      // (Beta 0.05, audit #9): the Membership Alternatives title
      // carries the NUMBER of the household's memberships from
      // the HIT List inventory ("Membership Alternatives - 2");
      // the Out of Stock section's title is "Shopping List - N"
      // (Alpha 0.99) and Low Stock on Sale Now follows the same
      // shape ("Low Stock on Sale Now - N"), N in both cases the
      // number of UNPURCHASED items in the section — items not
      // settled via the Purchased confirmation (restocked). A
      // merely struck-off row still counts as unpurchased:
      // striking changes nothing until Purchased is confirmed
      // (update 92). Each popup lists exactly the items its
      // number counts, so the number always matches the list.
      // The Membership Alternatives and Low Stock titles step
      // their font down to fit (membershipTitleFontSize); the
      // Shopping List title keeps the uniform group size.
      const unpurchased =
        def.id === "out" || def.id === "low"
          ? groupItems.filter((i) => !i.restocked)
          : groupItems;
      const title =
        def.id === "out"
          ? `Shopping List - ${unpurchased.length}`
          : def.id === "low"
            ? `Low Stock on Sale Now - ${unpurchased.length}`
            : def.id === "membership"
              ? `Membership Alternatives - ${membershipStores.length}`
              : def.title;
      return {
        key: `section:${def.id}`,
        title,
        titleFontSize:
          def.id === "membership" || def.id === "low"
            ? membershipTitleFontSize(title.length)
            : null,
        // No count label on any section header: the Shopping List
        // section's count lives in its title ("Shopping List - N"),
        // so the old "N to get" label beside it was redundant and
        // was removed (Beta 0.01); the other sections carried
        // descriptive text only, so they show no label either.
        countLabel: null,
        items: groupItems,
        showStore: true,
        membership: def.id === "membership",
        infoNames:
          def.id === "out" || def.id === "low"
            ? unpurchased.map((i) => i.item)
            : def.id === "membership"
              ? membershipStores
              : null,
        // The two ⓘ wordings are parallel (Beta 0.05, audit #1):
        // "Show the items in this section" / "No items" for the
        // item banners, "Show the stores in this section" /
        // "No stores" for Membership Alternatives.
        infoEmptyText:
          def.id === "membership" ? "No stores" : "No items",
        infoAriaLabel:
          def.id === "membership"
            ? "Show the stores in this section"
            : "Show the items in this section",
        collapsible: true,
      };
    }).filter((g) => g.items.length > 0);
    // Fallback: rows whose section title matches no known section
    // keep their own title as a group, so a sheet rename can never
    // make rows disappear from this view.
    const knownTitles = new Set(
      visible
        .filter((i) => canonicalSection(i.section) !== null)
        .map((i) => i.section),
    );
    const extraTitles: string[] = [];
    for (const i of visible) {
      if (!knownTitles.has(i.section) && !extraTitles.includes(i.section)) {
        extraTitles.push(i.section);
      }
    }
    for (const title of extraTitles) {
      sectionGroups.push({
        key: `section:extra:${title}`,
        title,
        titleFontSize: null,
        countLabel: null,
        items: visible.filter((i) => i.section === title),
        showStore: true,
        membership: false,
        infoNames: null as string[] | null,
        infoEmptyText: "",
        infoAriaLabel: "",
        collapsible: true,
      });
    }
    return sectionGroups;
  }, [view, visible, membershipStores]);

  return (
    <div>
      {/* Alerts feed — above (never inside) the locked header */}
      <AlertsStrip />

      {/* Stores on this list */}
      <section className="pt-2">
        <div
          className="overflow-hidden rounded-2xl px-5 py-3"
          style={{
            backgroundColor: "var(--surface-alt)",
            color: "var(--text)",
            height: `${STORE_HEADER_HEIGHT}px`,
            minHeight: `${STORE_HEADER_HEIGHT}px`,
            maxHeight: `${STORE_HEADER_HEIGHT}px`,
          }}
        >
          <div className="flex h-full flex-col">
            <h2 className="shrink-0 text-base leading-tight font-bold text-[var(--text)] underline">
              Sales by Store
            </h2>
            {storeCounts.length === 0 ? (
              <div className="flex flex-1 items-center">
                <p className="text-sm font-medium text-[var(--dim)]">
                  No stores yet — the list is empty.
                </p>
              </div>
            ) : (
              <ul className="flex min-h-0 flex-1 flex-col">
              {storeCounts.map(({ store, count }) => (
                <li
                  key={store}
                  className="flex min-h-0 flex-1 items-center justify-between gap-3"
                >
                  <span
                    className="min-w-0 truncate font-semibold"
                    style={{
                      fontSize: `${storeNameFontSize}px`,
                      lineHeight: 1.25,
                    }}
                  >
                    {store}
                  </span>
                  <span
                    className="shrink-0 font-medium tabular-nums text-[var(--dim)]"
                    style={{
                      fontSize: `${storeCountFontSize}px`,
                      lineHeight: 1.25,
                    }}
                  >
                    {count} {count === 1 ? "item" : "items"}
                  </span>
                </li>
                ))}
              </ul>
            )}
          </div>
        </div>
        <div className="mt-2 flex items-center justify-between gap-3">
          <p className="text-sm text-[var(--dim)]">
            {list.data?.updatedStamp ?? "Not loaded yet"}
            {refreshingSince && " · refreshing…"}
          </p>
          <button
            type="button"
            aria-label="Refresh list from the sheet"
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
      </section>

      {/* View controls */}
      <section className="mt-2 flex items-center justify-between gap-3">
        <div
          className="flex rounded-full p-1"
          style={{ backgroundColor: "var(--surface)" }}
          role="group"
          aria-label="Group list by"
        >
          {(
            [
              ["section", "By section"],
              ["store", "By store"],
            ] as const
          ).map(([value, label]) => (
            <button
              key={value}
              type="button"
              aria-pressed={view === value}
              onClick={() => setView(value)}
              className="rounded-full px-4 py-1 text-sm font-bold"
              style={
                view === value
                  ? {
                      backgroundColor: "var(--accent)",
                      color: "var(--accent-text)",
                    }
                  : { color: "var(--dim)" }
              }
            >
              {label}
            </button>
          ))}
        </div>
        <label className="flex cursor-pointer items-center gap-2 py-2 text-sm font-medium text-[var(--text)]">
          <input
            type="checkbox"
            checked={hidePurchased}
            onChange={(e) => setHidePurchased(e.target.checked)}
            className="h-5 w-5"
            style={{ accentColor: "var(--accent)" }}
          />
          Hide purchased
        </label>
      </section>

      {confirmNote && (
        <p className="mt-2 text-sm text-[var(--dim)]">{confirmNote}</p>
      )}

      {/* "Hide purchased" on with everything purchased (Beta 0.05,
          audit #7): say so explicitly instead of leaving a blank
          area where the list was. */}
      {hidePurchased && items.length > 0 && visible.length === 0 && (
        <p
          className="mt-3 rounded-2xl px-4 py-6 text-center text-sm text-[var(--dim)]"
          style={{
            backgroundColor: "var(--surface)",
            border: "1px solid var(--border)",
          }}
        >
          Everything on the list is purchased — nothing left to get.
          Turn off “Hide purchased” to see the items again.
        </p>
      )}

      {/* List */}
      {list.isPending ? (
        <p className="py-12 text-center text-sm text-[var(--dim)]">
          Loading your list…
        </p>
      ) : list.error ? (
        <p
          className="py-12 text-center text-sm"
          style={{ color: "var(--red)" }}
        >
          The list couldn’t be loaded. Try Refresh above.
        </p>
      ) : items.length === 0 && needsMeals.length === 0 ? (
        <div className="py-12 text-center">
          <p className="text-base font-semibold text-[var(--text)]">
            Nothing on the list right now
          </p>
          <p className="mx-auto mt-2 max-w-xs text-sm text-[var(--dim)]">
            When the next sale scan adds items to the Shopping List tab,
            they’ll show up here. Tap Refresh to pull the latest from the
            sheet.
          </p>
        </div>
      ) : (
        groups.map((group) => {
          const isCollapsed =
            group.collapsible && !expandedSections.has(group.key);
          const panelId = `shop-group-${group.key.replace(/[^a-z0-9]+/gi, "-")}`;
          return (
          <Fragment key={group.key}>
          <section className="mt-2">
            {group.infoNames !== null ? (
              // Count banner (Membership Alternatives, the
              // Shopping List section, and Low Stock on Sale Now):
              // the section title spans the
              // top of the box on one line, carrying a COUNT after
              // the title ("Membership Alternatives - 2",
              // "Shopping List - 4"); the Membership Alternatives
              // font steps down as the title grows so it always
              // fits (see membershipTitleFontSize). The title is
              // the collapse toggle; beside the count sits a small
              // info (ⓘ) button whose popup lists what the count
              // counts, names only — tapping it never toggles the
              // section.
              <div
                className="flex w-full items-center rounded-xl px-3 py-2"
                style={{
                  backgroundColor: "var(--accent-soft)",
                  border: "2px solid var(--accent)",
                }}
              >
                <button
                  type="button"
                  aria-expanded={!isCollapsed}
                  aria-controls={panelId}
                  aria-label={`${isCollapsed ? "Expand" : "Collapse"} ${group.title} section`}
                  onClick={() => toggleSection(group.key)}
                  // -my-2 py-2 (audit #10): the toggle's tappable
                  // area fills the banner's full height, like the
                  // whole-banner toggles — the negative margins
                  // cancel the extra padding in layout, so the
                  // banner itself doesn't grow.
                  className="-my-2 flex min-w-0 flex-1 items-center gap-1.5 py-2 text-left"
                >
                  <SectionChevron collapsed={isCollapsed} />
                  <span
                    className="whitespace-nowrap font-bold text-[var(--text)]"
                    style={{
                      fontSize: `${group.titleFontSize ?? GROUP_TITLE_FONT_SIZE}px`,
                      lineHeight: 1.2,
                    }}
                  >
                    {group.title}
                  </span>
                </button>
                {group.countLabel && (
                  <span className="mr-2 shrink-0 text-xs font-medium text-[var(--dim)]">
                    {group.countLabel}
                  </span>
                )}
                <BannerInfoButton
                  names={group.infoNames}
                  emptyText={group.infoEmptyText}
                  ariaLabel={group.infoAriaLabel}
                />
              </div>
            ) : group.collapsible ? (
              <button
                type="button"
                aria-expanded={!isCollapsed}
                aria-controls={panelId}
                aria-label={`${isCollapsed ? "Expand" : "Collapse"} ${group.title} section`}
                onClick={() => toggleSection(group.key)}
                className="flex w-full items-center justify-between gap-3 rounded-xl px-3 py-2 text-left"
                style={{
                  backgroundColor: "var(--accent-soft)",
                  border: "2px solid var(--accent)",
                }}
              >
                <span className="flex min-w-0 items-center gap-1.5">
                  <SectionChevron collapsed={isCollapsed} />
                  <span
                    className="font-bold text-[var(--text)]"
                    style={{
                      fontSize: `${GROUP_TITLE_FONT_SIZE}px`,
                      lineHeight: 1.2,
                    }}
                  >
                    {group.title}
                  </span>
                </span>
                {group.countLabel && (
                  <span className="shrink-0 text-xs font-medium text-[var(--dim)]">
                    {group.countLabel}
                  </span>
                )}
              </button>
            ) : (
              <div
                className="flex items-center justify-between gap-3 rounded-xl px-3 py-2"
                style={{
                  backgroundColor: "var(--accent-soft)",
                  border: "2px solid var(--accent)",
                }}
              >
                <h2 className="text-xl font-bold text-[var(--text)]">
                  {group.title}
                </h2>
                {group.countLabel && (
                  <p className="shrink-0 text-xs font-medium text-[var(--dim)]">
                    {group.countLabel}
                  </p>
                )}
              </div>
            )}
            {!isCollapsed && (
            <ul
              id={group.collapsible ? panelId : undefined}
              className="mt-1.5 divide-y rounded-2xl"
              style={{
                backgroundColor: "var(--surface)",
                border: "1px solid var(--border)",
                ["--tw-divide-opacity" as string]: "1",
              }}
            >
              {group.items.map((item) => (
                <ItemRow
                  key={item.key}
                  item={item}
                  showStore={group.showStore}
                  priority={item.stock === 0}
                  qty={quantities[item.key] ?? 1}
                  matchedHit={
                    hit.data == null
                      ? null
                      : hitNameByKey.has(item.item.trim().toLowerCase())
                  }
                  confirming={
                    confirmPurchase.isPending &&
                    confirmPurchase.variables?.item.key === item.key
                  }
                  onToggle={(i) => toggle.mutate(i)}
                  onQtyChange={(q) =>
                    setQuantities((prev) => ({ ...prev, [item.key]: q }))
                  }
                  onConfirm={(i) => {
                    // Tapping Purchased opens the quantity popup;
                    // nothing is recorded until it is confirmed.
                    setConfirmNote(null);
                    setPromptQty(quantities[i.key] ?? 1);
                    setPurchasePrompt(i);
                  }}
                />
              ))}
            </ul>
            )}
          </section>
          {/* The Recipe Needs section sits directly below Membership
              Alternatives (the last sheet section). */}
          {group.key === "section:membership" && needsSection}
          </Fragment>
          );
        })
      )}
      {view === "section" &&
        !groups.some((g) => g.key === "section:membership") &&
        needsSection}

      {/* Receipt scans — receipt-photo purchased-item proposals to review */}
      <ReceiptScansSection />

      {items.length > 0 && (
        <p className="mt-4 text-center text-xs text-[var(--dim)]">
          Striking an item off here is just for this run — the
          inventory doesn&rsquo;t change until you press Purchased on
          the item itself. Tapping Purchased opens a window asking how
          many you bought; confirming adds them to the inventory right
          away.
        </p>
      )}

      {/* Purchased quantity popup (Alpha 0.91): opened by a row's
          Purchased button. Confirming records the entered quantity
          into the inventory and completes the row as purchased;
          cancelling — or tapping the backdrop — changes nothing. */}
      {purchasePrompt && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center p-4"
          style={{ backgroundColor: "rgba(0, 0, 0, 0.45)" }}
          onClick={() => {
            if (!confirmPurchase.isPending) setPurchasePrompt(null);
          }}
        >
          <div
            role="dialog"
            aria-modal="true"
            aria-label={`How many ${purchasePrompt.item} did you buy?`}
            className="w-full max-w-xs rounded-2xl p-4"
            style={{
              backgroundColor: "var(--surface)",
              border: "1px solid var(--border)",
            }}
            onClick={(e) => e.stopPropagation()}
          >
            <h2 className="text-base font-bold text-[var(--text)]">
              {purchasePrompt.item}
            </h2>
            <p className="mt-1 text-sm text-[var(--dim)]">
              How many did you buy? Confirming adds them to the
              inventory and marks this item purchased.
            </p>
            <div className="mt-3 flex items-center justify-center gap-2">
              <button
                type="button"
                aria-label="One fewer"
                disabled={promptQty <= 1 || confirmPurchase.isPending}
                onClick={() => setPromptQty(Math.max(1, promptQty - 1))}
                className="rounded-lg border border-[var(--border)] bg-[var(--surface)] px-3 font-medium disabled:opacity-40"
              >
                −
              </button>
              <input
                type="number"
                inputMode="numeric"
                min={1}
                max={999}
                aria-label={`Quantity of ${purchasePrompt.item} purchased`}
                value={promptQty}
                onChange={(e) => {
                  const n = Math.floor(Number(e.target.value));
                  setPromptQty(
                    Number.isFinite(n) ? Math.min(999, Math.max(1, n)) : 1,
                  );
                }}
                className="w-20 rounded-lg border border-[var(--border)] bg-[var(--surface)] px-2 py-1.5 text-center text-base font-semibold tabular-nums text-[var(--text)]"
              />
              <button
                type="button"
                aria-label="One more"
                disabled={confirmPurchase.isPending}
                onClick={() => setPromptQty(Math.min(999, promptQty + 1))}
                className="rounded-lg border border-[var(--border)] bg-[var(--surface)] px-3 font-medium disabled:opacity-40"
              >
                +
              </button>
            </div>
            <div className="mt-4 flex gap-2">
              <button
                type="button"
                disabled={confirmPurchase.isPending}
                onClick={() => setPurchasePrompt(null)}
                className="flex-1 rounded-full px-3 py-2 text-sm font-bold disabled:opacity-50"
                style={{
                  backgroundColor: "var(--surface-alt)",
                  color: "var(--text)",
                }}
              >
                Cancel
              </button>
              <button
                type="button"
                disabled={confirmPurchase.isPending}
                onClick={() =>
                  confirmPurchase.mutate({
                    item: purchasePrompt,
                    quantity: promptQty,
                  })
                }
                className="flex-1 rounded-full px-3 py-2 text-sm font-bold disabled:opacity-50"
                style={{
                  backgroundColor: "var(--accent)",
                  color: "var(--accent-text)",
                }}
              >
                {confirmPurchase.isPending
                  ? "Adding…"
                  : "Confirm purchase"}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
