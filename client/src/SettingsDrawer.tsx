import { useEffect, useState, type ReactNode } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "./api";

/**
 * Settings gear + left drawer.
 *
 * A gear button sits beside the app title in both the HIT and BIT
 * headers. The gear is pronounced — 44px, accent-filled, with a
 * slow stepped idle rotation and a fuller spin on tap (theme.css
 * .gear-icon) — and both header titles are enlarged to fill their
 * row, flexing/truncating before they could crowd the gear out.
 * Pressing it opens a panel that slides in from the LEFT
 * side of the screen — the app's settings tab. The controls that
 * used to live in the side strips and the BIT business box moved
 * here: the Accessibility page entry, Household Setup (HIT side),
 * the Switch to HIT / BIT control, the Undo last action button
 * (Beta 0.15 — the app's only Undo, under Switch on both sides),
 * and the Recipe Videos section (HIT side).
 *
 * Dismissal follows the app's existing popup rules: a tap on the
 * backdrop (outside the panel) or Escape closes it. The drawer
 * holds no typed form input, so a backdrop tap can never discard
 * anything typed.
 */
export function GearButton({
  open,
  onClick,
}: {
  open: boolean;
  onClick: () => void;
}) {
  // A tap gives the gear a fuller spin while the drawer opens:
  // the spin class stays on for a beat after the press (and for
  // as long as the drawer is open), on top of the gear's slow
  // stepped idle rotation (see .gear-icon in theme.css).
  const [spinning, setSpinning] = useState(false);
  useEffect(() => {
    if (!spinning) return;
    const t = setTimeout(() => setSpinning(false), 900);
    return () => clearTimeout(t);
  }, [spinning]);
  return (
    <button
      type="button"
      aria-label="Settings"
      aria-haspopup="dialog"
      aria-expanded={open}
      onClick={() => {
        setSpinning(true);
        onClick();
      }}
      className="flex shrink-0 items-center justify-center rounded-full shadow-md"
      style={{
        width: 44,
        height: 44,
        backgroundColor: "var(--accent)",
        color: "var(--accent-text)",
      }}
    >
      <svg
        width="28"
        height="28"
        viewBox="0 0 24 24"
        fill="currentColor"
        aria-hidden="true"
        className={
          spinning || open ? "gear-icon gear-icon-spin" : "gear-icon"
        }
      >
        <g>
          {[0, 45, 90, 135, 180, 225, 270, 315].map((deg) => (
            <rect
              key={deg}
              x="10.8"
              y="1.4"
              width="2.4"
              height="5.6"
              rx="1"
              transform={`rotate(${deg} 12 12)`}
            />
          ))}
          <circle cx="12" cy="12" r="6.8" />
          <circle cx="12" cy="12" r="3" fill="var(--accent)" />
        </g>
      </svg>
    </button>
  );
}

/** One full-width entry row inside the settings drawer. */
export function SettingsDrawerItem({
  label,
  onClick,
}: {
  label: string;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="flex w-full items-center justify-between gap-2 rounded-[var(--radius)] border border-[var(--border)] bg-[var(--surface)] px-4 py-3 text-left text-base font-semibold text-[var(--text)]"
    >
      <span>{label}</span>
      <span aria-hidden="true" className="text-[var(--dim)]">
        ›
      </span>
    </button>
  );
}

/**
 * The app's ONE Undo (Beta 0.15): a drawer entry under the
 * Switch control on both sides. There are no per-record Undo
 * buttons anywhere anymore — this button reverts the LAST
 * action taken anywhere in the app (the newest undoable one,
 * under the undo policy), naming it underneath so it's clear
 * what a press will revert; pressing again reverts the action
 * before that. The result of a press is reported in place.
 */
export function UndoLastActionItem() {
  const queryClient = useQueryClient();
  const [msg, setMsg] = useState<string | null>(null);
  const [msgIsError, setMsgIsError] = useState(false);
  const last = useQuery({
    queryKey: ["lastUndoableAction"],
    queryFn: async () => await api.getLastUndoableAction({}),
  });
  const undo = useMutation({
    mutationFn: async () => await api.undoLastAction({}),
    onSuccess: (res) => {
      if (res.ok) {
        setMsg(`Undone — ${res.label ?? "the last action"}.`);
        setMsgIsError(false);
      } else {
        setMsg(res.error ?? "That action couldn't be undone.");
        setMsgIsError(true);
      }
      void queryClient.invalidateQueries();
    },
    onError: () => {
      setMsg("That action couldn't be undone. Try again.");
      setMsgIsError(true);
    },
  });
  const label = last.data?.label ?? null;
  return (
    <div>
      <button
        type="button"
        disabled={undo.isPending || last.isPending || label == null}
        onClick={() => undo.mutate()}
        className="flex w-full items-center justify-between gap-2 rounded-[var(--radius)] border border-[var(--border)] bg-[var(--surface)] px-4 py-3 text-left text-base font-semibold text-[var(--text)] disabled:opacity-50"
      >
        <span>{undo.isPending ? "Undoing…" : "↩ Undo last action"}</span>
      </button>
      <p className="px-1 pt-1.5 text-sm text-[var(--dim)]">
        {last.isPending
          ? "Checking the last action…"
          : label != null
            ? `Last action: ${label}`
            : "Nothing to undo right now."}
      </p>
      {msg && (
        <p
          className="px-1 pt-1 text-sm font-semibold"
          style={{ color: msgIsError ? "var(--red)" : "var(--accent)" }}
          role="status"
        >
          {msg}
        </p>
      )}
    </div>
  );
}

export function SettingsDrawer({
  open,
  onClose,
  children,
}: {
  open: boolean;
  onClose: () => void;
  children: ReactNode;
}) {
  // Escape closes the drawer — the same dismissal the app's other
  // menus and popups use.
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, onClose]);

  if (!open) return null;

  return (
    <div className="fixed inset-0 z-50">
      {/* Backdrop: a tap outside the panel closes the drawer. */}
      <div
        aria-hidden="true"
        onClick={onClose}
        className="settings-drawer-backdrop absolute inset-0"
        style={{ backgroundColor: "rgba(0, 0, 0, 0.45)" }}
      />
      <aside
        role="dialog"
        aria-modal="true"
        aria-label="Settings"
        className="settings-drawer-panel absolute top-0 left-0 flex h-full flex-col overflow-y-auto shadow-2xl"
        style={{
          width: "min(330px, 88vw)",
          backgroundColor: "var(--surface)",
          color: "var(--text)",
          paddingTop: "env(safe-area-inset-top)",
        }}
      >
        <div className="flex items-center justify-between gap-2 px-4 pt-4 pb-2">
          <h2 className="text-xl font-bold">Settings</h2>
          <button
            type="button"
            aria-label="Close settings"
            onClick={onClose}
            className="flex shrink-0 items-center justify-center rounded-full text-lg leading-none font-bold"
            style={{
              width: 32,
              height: 32,
              backgroundColor: "var(--surface-alt)",
              color: "var(--text)",
            }}
          >
            ✕
          </button>
        </div>
        <div className="flex flex-col gap-2 px-4 pt-2 pb-6">{children}</div>
      </aside>
    </div>
  );
}
