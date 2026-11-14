import { useState } from "react";

/**
 * The small "Source ▾" dropdown, mirroring the Shopping List tab's
 * Source dropdown: a compact pill toggle; expanded it shows a short
 * heading line (e.g. "Recipe from RecipeTin Eats"), the dish /
 * product name it points at, and the full URL as a wrapping
 * hyperlink. Tapping the link opens a tiny menu with exactly "Open
 * link" and "Copy link" (with a "Copied ✓" confirmation). The URL
 * is always one recorded by the app — never guessed or built here.
 */
export function SourceDropdown({
  name,
  heading,
  url,
  itemLabel,
}: {
  /** The dish / product name the source points at. */
  name: string;
  /** Short provenance line, e.g. "Recipe from RecipeTin Eats". */
  heading: string;
  url: string;
  /** Accessible-name context, e.g. the recipe name. */
  itemLabel: string;
}) {
  const [open, setOpen] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);
  const [copied, setCopied] = useState(false);

  const copyLink = async () => {
    try {
      await navigator.clipboard.writeText(url);
    } catch {
      // Clipboard API unavailable (older webview): fall back to a
      // temporary textarea + execCommand copy.
      const ta = document.createElement("textarea");
      ta.value = url;
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
    setCopied(true);
    window.setTimeout(() => setCopied(false), 2000);
  };

  return (
    <div>
      <button
        type="button"
        aria-expanded={open}
        aria-label={`${open ? "Hide" : "Show"} source for ${itemLabel}`}
        onClick={() => {
          setOpen((v) => !v);
          setMenuOpen(false);
        }}
        className="inline-flex items-center gap-[3px] rounded-full px-[6px] py-[1.5px] text-[9px] font-bold"
        style={{
          backgroundColor: "var(--surface-alt)",
          color: "var(--accent)",
          border: "1px solid var(--border)",
          // Same small size as the Shopping List tab's Source
          // toggle: overrides the global 2rem button minimum in
          // theme.css so the toggle stays little.
          minHeight: "16.5px",
        }}
      >
        Source
        <span aria-hidden="true">{open ? "▴" : "▾"}</span>
      </button>
      {open && (
        <div className="mt-1.5">
          <p className="text-xs font-medium text-[var(--text)]">{name}</p>
          <p className="text-[13px] font-medium text-[var(--dim)]">
            {heading}
          </p>
          <button
            type="button"
            aria-haspopup="menu"
            aria-expanded={menuOpen}
            aria-label={`Source link options for ${itemLabel}`}
            onClick={() => setMenuOpen((v) => !v)}
            className="mt-0.5 block max-w-full text-left text-xs font-medium break-all underline"
            style={{ color: "var(--accent)" }}
          >
            {url}
          </button>
          {menuOpen && (
            <div
              role="menu"
              aria-label="Source link actions"
              className="mt-1.5 inline-flex overflow-hidden rounded-lg"
              style={{ border: "1px solid var(--border)" }}
            >
              <a
                role="menuitem"
                href={url}
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
                onClick={copyLink}
                className="px-3 text-xs font-bold"
                style={{
                  backgroundColor: "var(--surface-alt)",
                  color: "var(--accent)",
                }}
              >
                {copied ? "Copied ✓" : "Copy link"}
              </button>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
