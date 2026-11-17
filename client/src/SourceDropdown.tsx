import { useRef, useState } from "react";
import { useMenuDismiss } from "./popupHooks";

/**
 * The small "Source ▾" dropdown, mirroring the Shopping List tab's
 * Source dropdown: a compact pill toggle; expanded it shows the
 * dish / product name it points at and a short provenance line
 * (e.g. "Found on Flipp" / "Recipe from RecipeTin Eats") in which
 * the website's name itself is the hyperlink — tapping it opens
 * the recorded page in a new tab. The full URL is never shown as
 * text. The URL is always one recorded by the app — never
 * guessed or built here. The dropdown follows the app's one
 * dismissal spec: an outside tap, a scroll, or Escape closes it.
 */
export function SourceDropdown({
  name,
  headingBefore,
  siteName,
  headingAfter,
  url,
  itemLabel,
}: {
  /** The dish / product name the source points at. */
  name: string;
  /** Provenance text before the site name, e.g. "Found on" /
      "Found on the" / "Recipe from". */
  headingBefore: string;
  /** The website the source is from — the hyperlink's text,
      e.g. "Flipp", "Food Basics", "RecipeTin Eats". */
  siteName: string;
  /** Optional provenance text after the site name, e.g.
      "website" in "Found on the Food Basics website". */
  headingAfter?: string;
  url: string;
  /** Accessible-name context, e.g. the recipe name. */
  itemLabel: string;
}) {
  const [open, setOpen] = useState(false);
  // One dismissal spec (Beta 0.04, audit #6): an outside tap, a
  // scroll, or Escape closes the dropdown.
  const wrapRef = useRef<HTMLDivElement | null>(null);
  useMenuDismiss(open, wrapRef, () => {
    setOpen(false);
  });

  return (
    <div ref={wrapRef}>
      <button
        type="button"
        aria-expanded={open}
        aria-label={`${open ? "Hide" : "Show"} source for ${itemLabel}`}
        onClick={() => {
          setOpen((v) => !v);
        }}
        className="hit24y-lg inline-flex items-center gap-[3px] rounded-full px-[6px] py-[1.25px] text-[12px] leading-none font-bold"
        style={{
          backgroundColor: "var(--surface-alt)",
          color: "var(--accent)",
          border: "1px solid var(--border)",
          // Same small size as the Shopping List tab's Source
          // toggle: overrides the global 2rem button minimum in
          // theme.css so the toggle stays little. The text sits
          // at the 12px floor (audit #10) on a line-height of 1,
          // so the pill's visual height is unchanged; the
          // .hit24y-lg overlay (theme.css) grows the tappable
          // height to 24.5px.
          minHeight: "16.5px",
        }}
      >
        Source
        <span aria-hidden="true">{open ? "▴" : "▾"}</span>
      </button>
      {open && (
        <div className="mt-1.5">
          <p className="text-xs font-medium text-[var(--text)]">{name}</p>
          <p className="flex flex-wrap items-center gap-x-1.5 text-[13px] font-medium text-[var(--dim)]">
            <span>{headingBefore}</span>
            <a
              href={url}
              target="_blank"
              rel="noreferrer"
              aria-label={`Open the ${siteName} page for ${itemLabel}`}
              className="font-bold underline"
              style={{ color: "var(--accent)" }}
            >
              {siteName}
            </a>
            {headingAfter && <span>{headingAfter}</span>}
          </p>
        </div>
      )}
    </div>
  );
}
