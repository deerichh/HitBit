import { Fragment, useEffect, useMemo, useRef, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api, type ApiResponse } from "./api";
import { AlertsStrip, ReceiptScansSection } from "./ShoppingExtras";
import { RefreshProgress } from "./RefreshProgress";
import { SourceDropdown } from "./SourceDropdown";

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
// room. That includes the Out of Stock section's longer display
// title, "Out of Stock - Shopping List" (app display only — the
// sheet section the scans write stays "Out of Stock"): it renders
// at the same 20px as every other header and wraps beside its
// "N to get" count rather than stepping down in size.
// ONE exception (Nov 13, 2026): the Membership Alternatives header
// appends the household's membership store names to its title
// ("Membership Alternatives · Costco, Amazon"), so ITS font steps
// down as the name list grows — see membershipTitleFontSize.
const GROUP_TITLE_FONT_SIZE = 20;

// The stores the household holds a membership with — alternatives
// are priced against these (Costco and Amazon; Amazon is treated
// exactly like Costco). The Membership Alternatives header lists
// every one of these that appears among the HIT List inventory's
// usual stores.
const MEMBERSHIP_STORES = ["Costco", "Amazon"];

// The Membership Alternatives header names the household's
// membership stores, so the title can grow well past the uniform
// 20px width. Its font steps DOWN as the full title gets longer —
// the same shrink-to-fit idea as the locked "Sales by Store"
// header — so the whole title always fits on one line. The plain
// title (23 chars, no stores) keeps the uniform 20px.
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
  // Two-step purchase: striking the item off alone changes nothing.
  // While it's struck and unconfirmed, the row grows a −/+ counter
  // beside the name and a Purchased button beside the price; only
  // pressing Purchased records the quantity into the inventory.
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
      <div className="min-w-0 flex-1">
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
                  no price yet
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
              <button
                type="button"
                aria-expanded={savingsOpen}
                aria-label={`${savingsOpen ? "Hide" : "Show"} savings details for ${item.item}`}
                onClick={() => setSavingsOpen((v) => !v)}
                className="inline-flex items-center gap-[3.45px] rounded-full px-[6.9px] py-[1.725px] text-[10.4px] font-bold"
                style={{
                  backgroundColor: "var(--surface-alt)",
                  color: "var(--accent)",
                  border: "1px solid var(--border)",
                  // 15% larger than the 16.5px size this toggle
                  // previously had — also overrides the global 2rem
                  // button minimum in theme.css, which would
                  // otherwise make this small button taller.
                  minHeight: "19px",
                }}
              >
                Savings
                <span aria-hidden="true">{savingsOpen ? "▴" : "▾"}</span>
              </button>
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
                className="inline-flex items-center gap-[3.45px] rounded-full px-[6.9px] py-[1.725px] text-[10.4px] font-bold"
                style={{
                  backgroundColor: "var(--surface-alt)",
                  color: "var(--accent)",
                  border: "1px solid var(--border)",
                  // Same size as the Savings toggle (see its
                  // comment): overrides the global 2rem button
                  // minimum so the toggle stays compact.
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
                no price yet
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
              : remaining > 0
                ? `${remaining} to get`
                : `${needs.length} to get`}
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
  meals,
  allMeals,
  collapsed,
  search,
  recheckingMealId,
  onToggleSection,
  onSearchChange,
  onRecheck,
  onToggleNeed,
}: {
  meals: NeedsMeal[];
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
        <span className="shrink-0 text-xs font-medium text-[var(--dim)]">
          {meals.length > 0
            ? `${meals.length} ${meals.length === 1 ? "recipe" : "recipes"}`
            : ""}
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
        meals={needsMeals}
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
  // button beside its price, right on its row; only pressing
  // Purchased records a pending +quantity stock adjustment for the
  // HIT List item it matches. The button then flips to a disabled
  // "Purchased ✓", and the confirmation survives un-striking and
  // re-striking the item, so it can't be recorded twice. The sheet
  // itself is read-only — the auto-scan writes the adjustments to
  // it later; the app's stock counts include them right away.
  // (This inventory read also feeds the Membership Alternatives
  // header's membership-store names — see membershipStores.)
  const hit = useQuery({
    queryKey: ["hit"],
    queryFn: () => api.getHitList({}),
  });
  const [quantities, setQuantities] = useState<Record<string, number>>(
    {},
  );
  const [confirmNote, setConfirmNote] = useState<string | null>(null);

  const hitNameByKey = useMemo(() => {
    const map = new Map<string, string>();
    for (const i of hit.data?.items ?? []) {
      map.set(i.item.trim().toLowerCase(), i.item);
    }
    return map;
  }, [hit.data]);

  const confirmPurchase = useMutation({
    mutationFn: async (item: Item) =>
      await api.confirmPurchased({
        key: item.key,
        item: item.item,
        quantity: quantities[item.key] ?? 1,
      }),
    onSuccess: (res, item) => {
      if (res.recorded) {
        const qty = quantities[item.key] ?? 1;
        setConfirmNote(
          `${item.item} × ${qty} added to the inventory — counts are updated here now and will be written to the sheet on the next auto-scan.`,
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

  // The household's membership stores, named in the Membership
  // Alternatives header: EVERY membership store represented in
  // the HIT List inventory — the distinct membership stores
  // (MEMBERSHIP_STORES) among the inventory items' usual stores,
  // in canonical order — whether or not an alternative for that
  // store happens to be on the Shopping List right now. (For this
  // household: Costco and Amazon, since Amazon items are tracked
  // in the inventory too.) While the inventory hasn't loaded, or
  // holds no membership-store items, fall back to the usual
  // stores of the items sitting in the Membership Alternatives
  // section, as before. Empty only when neither source names a
  // store, in which case the header keeps its plain title.
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
      for (const item of visible) {
        // Items with no buy-at store yet aren't shown in the By store
        // view; they still appear under By section.
        if (!item.buyAt) continue;
        const store = item.buyAt;
        const arr = byStore.get(store) ?? [];
        arr.push(item);
        byStore.set(store, arr);
      }
      return Array.from(byStore.entries()).map(([title, groupItems]) => {
        const remaining = groupItems.filter((i) => !i.checked);
        return {
          key: `store:${title}`,
          title,
          titleFontSize: null,
          // Plain count only — no descriptive text beside the
          // store name: how many items are still to get at this
          // store, or the plain item count when all are struck off.
          countLabel:
            remaining.length > 0
              ? `${remaining.length} to get`
              : `${groupItems.length}`,
          items: groupItems,
          showStore: false,
          membership: false,
          collapsible: true,
        };
      });
    }
    // By section: group by canonical section (matched by meaning —
    // see canonicalSection), displayed under the current titles.
    const sectionGroups = SECTION_DEFS.map((def) => {
      const groupItems = visible.filter(
        (i) => canonicalSection(i.section) === def.id,
      );
      const remaining = groupItems.filter((i) => !i.checked);
      // The Membership Alternatives title names the household's
      // membership stores from the HIT List inventory ("Membership
      // Alternatives · Costco, Amazon") and steps its font down to
      // fit (membershipTitleFontSize); every other title keeps the
      // uniform group size (titleFontSize null).
      const title =
        def.id === "out"
          ? "Out of Stock - Shopping List"
          : def.id === "membership" && membershipStores.length > 0
            ? `Membership Alternatives · ${membershipStores.join(", ")}`
            : def.title;
      return {
        key: `section:${def.id}`,
        title,
        titleFontSize:
          def.id === "membership"
            ? membershipTitleFontSize(title.length)
            : null,
        // Plain count only, where a count was already part of the
        // header (Out of Stock); the other sections carried
        // descriptive text only, so they show no label now.
        countLabel:
          def.id === "out" ? `${remaining.length} to get` : null,
        items: groupItems,
        showStore: true,
        membership: def.id === "membership",
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
            {group.membership ? (
              // Membership Alternatives header: the section title
              // spans the full width across the top of the box on
              // one line, naming the household's membership stores
              // after the title; its font steps down as the name
              // list grows so the full title always fits (see
              // membershipTitleFontSize). The whole header is the
              // collapse toggle.
              <button
                type="button"
                aria-expanded={!isCollapsed}
                aria-controls={panelId}
                aria-label={`${isCollapsed ? "Expand" : "Collapse"} ${group.title} section`}
                onClick={() => toggleSection(group.key)}
                className="block w-full rounded-xl px-3 py-2 text-left"
                style={{
                  backgroundColor: "var(--accent-soft)",
                  border: "2px solid var(--accent)",
                }}
              >
                <span className="flex items-center gap-1.5">
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
                </span>
              </button>
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
              className="mt-1.5 divide-y overflow-hidden rounded-2xl"
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
                    confirmPurchase.variables?.key === item.key
                  }
                  onToggle={(i) => toggle.mutate(i)}
                  onQtyChange={(q) =>
                    setQuantities((prev) => ({ ...prev, [item.key]: q }))
                  }
                  onConfirm={(i) => {
                    setConfirmNote(null);
                    confirmPurchase.mutate(i);
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
          the item itself. Set how many you got with the −/+ counter
          beside its name, then tap Purchased beside its price to add
          them back into the inventory — counts update here right away
          and reach the sheet on the next auto-scan.
        </p>
      )}
    </div>
  );
}
