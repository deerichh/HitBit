import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api, type ApiResponse } from "./api";

/**
 * Accessibility (Beta 0.01 batch, audit #5, second half): the
 * Primary vs Connected account settings. This page is the one
 * place the account system lives — it is NOT sprinkled through
 * the daily shopping / counting / requisition flows; those only
 * show each record's actor label and its Undo (or "Permanent")
 * state.
 *
 * - Acting as: this copy's role — Primary user or Connected
 *   account (Primary until changed). The role is this copy's own
 *   identity, so it can be switched from either role.
 * - Undo policy: per action type, Permanent (the action applies
 *   with no Undo offered and its records read as permanent) or
 *   Reversible (the 7a Undo works). Everything starts Reversible.
 *   The table is editable ONLY while acting as Primary; acting as
 *   Connected it is read-only — connected-account actions stay
 *   reversible unless the Primary user changes a type here.
 * - Ownership: the Primary user can undo anyone's action; a
 *   Connected account can undo only its own actions (the server
 *   refuses the rest, and the Undo simply isn't offered).
 */

export type ActorRole = "primary" | "connected";
type SettingsData = ApiResponse<typeof api, "getAccountSettings">;
export type PolicyType = keyof SettingsData["policy"];

export const ACTOR_LABEL: Record<ActorRole, string> = {
  primary: "Primary",
  connected: "Connected account",
};

const POLICY_ROWS: { type: PolicyType; label: string; blurb: string }[] = [
  {
    type: "purchases",
    label: "Purchases",
    blurb: "Shopping List purchases confirmed with the Purchased button.",
  },
  {
    type: "stockAdjustments",
    label: "Stock adjustments & stocktake",
    blurb: "HIT List +/− stepper taps and stocktake corrections.",
  },
  {
    type: "eaten",
    label: "Eaten",
    blurb: "Meal Planner “Eaten ✓” taps and their stock deductions.",
  },
  {
    type: "receiptScans",
    label: "Receipt scans",
    blurb: "Confirmed receipt scans and the stock they added.",
  },
  {
    type: "bitCountChanges",
    label: "BIT count changes",
    blurb: "Count edits made on the BIT Inventory tab.",
  },
  {
    type: "wasteLog",
    label: "Waste log",
    blurb: "BIT waste entries and the stock they deducted.",
  },
  {
    type: "manifestImports",
    label: "Manifest imports",
    blurb: "BIT manifest imports and the items / counts they set.",
  },
  {
    type: "requisitionCheckOffs",
    label: "Requisition check-offs",
    blurb: "Received / Not received marks on requisition lines.",
  },
  {
    type: "alertDismissals",
    label: "Alert dismissals",
    blurb: "Dismissed alerts on the Shopping List (Restore is the Undo).",
  },
  {
    type: "posSyncs",
    label: "POS syncs",
    blurb: "POS sales and syncs applied to BIT stock.",
  },
];

/**
 * The small actor / permanence tag shown on an undoable record:
 * who performed it ("Primary" / "Connected account") and, when
 * its action type is set Permanent, that it is permanent. Renders
 * nothing extra beyond the words themselves so it can sit inside
 * existing one-line record rows.
 */
export function ActorTag({
  actor,
  permanent,
}: {
  actor: ActorRole;
  permanent: boolean;
}) {
  return (
    <>
      {" · "}
      {ACTOR_LABEL[actor]}
      {permanent ? " · Permanent" : ""}
    </>
  );
}

export function AccountPolicy({ onClose }: { onClose: () => void }) {
  const queryClient = useQueryClient();
  const [note, setNote] = useState<string | null>(null);
  const settings = useQuery({
    queryKey: ["account-settings"],
    queryFn: () => api.getAccountSettings({}),
  });

  // Role and policy changes affect every record's actor /
  // canUndo state app-wide, so a change refreshes everything.
  const refreshAll = () => {
    void queryClient.invalidateQueries();
  };

  const setRole = useMutation({
    mutationFn: async (role: ActorRole) => await api.setActingRole({ role }),
    onSuccess: (res) => {
      setNote(
        res.role === "primary"
          ? "This copy now acts as the Primary user — it can undo anyone's actions and edit the policy below."
          : "This copy now acts as a Connected account — it can undo only its own actions, and the policy below is read-only.",
      );
      refreshAll();
    },
    onError: () => setNote("That change couldn't be saved. Try again."),
  });

  const setPolicy = useMutation({
    mutationFn: async (vars: {
      type: PolicyType;
      mode: "permanent" | "reversible";
    }) => await api.setUndoPolicy({ type: vars.type, mode: vars.mode }),
    onSuccess: (res) => {
      setNote(
        res.ok
          ? "Policy saved."
          : (res.error ?? "That change couldn't be saved."),
      );
      refreshAll();
    },
    onError: () => setNote("That change couldn't be saved. Try again."),
  });

  const data = settings.data;
  const role: ActorRole = data?.role ?? "primary";
  const isPrimary = role === "primary";

  const roleButton = (r: ActorRole, label: string) => (
    <button
      key={r}
      type="button"
      aria-pressed={role === r}
      disabled={setRole.isPending || role === r}
      onClick={() => setRole.mutate(r)}
      className="min-w-0 flex-1 rounded-full px-3 py-2 text-sm font-bold disabled:opacity-100"
      style={
        role === r
          ? {
              backgroundColor: "var(--accent)",
              color: "var(--accent-text)",
            }
          : { color: "var(--dim)" }
      }
    >
      {label}
    </button>
  );

  return (
    <div className="pt-3">
      <div className="flex items-center justify-between gap-2">
        <h2 className="text-xl font-extrabold">Accessibility</h2>
        <button
          type="button"
          onClick={onClose}
          className="shrink-0 rounded-full px-3 py-1.5 text-xs font-bold"
          style={{
            backgroundColor: "var(--surface-alt)",
            color: "var(--text)",
          }}
        >
          Done
        </button>
      </div>

      <section
        className="mt-3 rounded-2xl border p-4"
        style={{
          borderColor: "var(--border)",
          backgroundColor: "var(--surface)",
        }}
      >
        <h3 className="text-base font-bold">Acting as</h3>
        <p className="mt-1 text-sm text-[var(--dim)]">
          This copy of the app acts as one account. Everything it
          does — purchases, stock changes, waste entries, check-offs
          — is recorded under this role, and the role decides what
          it may undo: the Primary user can undo anyone&rsquo;s
          actions; a Connected account can undo only its own.
        </p>
        <div
          className="mt-3 flex rounded-full p-1"
          style={{ backgroundColor: "var(--surface-alt)" }}
          role="group"
          aria-label="Acting role"
        >
          {roleButton("primary", "Primary user")}
          {roleButton("connected", "Connected account")}
        </div>
        <p className="mt-2 text-sm font-semibold">
          {settings.isPending
            ? "Loading…"
            : `Currently acting as: ${isPrimary ? "Primary user" : "Connected account"}`}
        </p>
      </section>

      <section
        className="mt-3 rounded-2xl border p-4"
        style={{
          borderColor: "var(--border)",
          backgroundColor: "var(--surface)",
        }}
      >
        <h3 className="text-base font-bold">Undo policy</h3>
        <p className="mt-1 text-sm text-[var(--dim)]">
          For each kind of action, choose whether it is{" "}
          <strong>Reversible</strong> — its records offer an Undo —
          or <strong>Permanent</strong> — it applies with no Undo
          and its records read as permanent. Everything starts
          Reversible, including every Connected account action.
        </p>
        {!isPrimary && (
          <p
            className="mt-2 rounded-xl px-3 py-2 text-sm font-semibold"
            style={{
              backgroundColor: "var(--amber-soft)",
              color: "var(--amber)",
            }}
          >
            Read-only while acting as a Connected account — only
            the Primary user can change this policy.
          </p>
        )}
        <ul className="mt-2 divide-y divide-[var(--border)]">
          {POLICY_ROWS.map((row) => {
            const mode = data?.policy[row.type];
            const isPermanent = mode === "permanent";
            return (
              <li key={row.type} className="py-2.5">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <span className="text-sm font-bold">{row.label}</span>
                  <span
                    className="flex rounded-full p-0.5"
                    style={{ backgroundColor: "var(--surface-alt)" }}
                    role="group"
                    aria-label={`${row.label} policy`}
                  >
                    {(["reversible", "permanent"] as const).map((m) => {
                      const active = isPermanent === (m === "permanent");
                      return (
                        <button
                          key={m}
                          type="button"
                          aria-pressed={active}
                          disabled={
                            !isPrimary || setPolicy.isPending || active
                          }
                          onClick={() =>
                            setPolicy.mutate({ type: row.type, mode: m })
                          }
                          className="rounded-full px-2.5 py-1 text-xs font-bold disabled:opacity-100"
                          style={
                            active
                              ? {
                                  backgroundColor: "var(--accent)",
                                  color: "var(--accent-text)",
                                }
                              : { color: "var(--dim)" }
                          }
                        >
                          {m === "permanent" ? "Permanent" : "Reversible"}
                        </button>
                      );
                    })}
                  </span>
                </div>
                <p className="mt-0.5 text-xs text-[var(--dim)]">
                  {row.blurb}
                </p>
              </li>
            );
          })}
        </ul>
        {note && (
          <p className="mt-2 text-sm font-semibold" role="status">
            {note}
          </p>
        )}
      </section>
    </div>
  );
}
