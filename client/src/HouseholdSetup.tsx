import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "./api";

/**
 * HIT setup questionnaire (Alpha 0.90) — the household setup flow
 * from the staging copies, brought into the hub app. An IN-FLOW
 * page: it renders in the document and scrolls with it, with the
 * step navigation in the flow under each step's options — never a
 * fixed overlay with its own scroller.
 *
 * Under every step's questions sits the "Your setup so far" preview
 * box, rendered ~30% smaller than the full-size Review summary: its
 * labels always show, its values start blank and fill in as answers
 * are given. Every chosen option — defaults included — takes the
 * filled highlight plus a ✓ beside its label. Every choice step
 * offers its presets plus an Other button with manual text entry;
 * a typed entry behaves exactly like a preset (highlight + ✓,
 * preview box, Review screen, saved).
 *
 * Finishing is NON-DESTRUCTIVE: it saves the answers as the
 * household setup profile, and any starter items/meals it seeds
 * are added only when not already tracked (the server dedupes by
 * name, case-insensitive). Existing HIT List items, meals and
 * planner picks are never removed, overwritten, or reset.
 */

interface SetupAnswers {
  householdSize: string;
  stores: string[];
  allergies: string[];
  proteins: string[];
  staples: string[];
  meals: string[];
  reminders: string;
  sharing: string;
}

const EMPTY_ANSWERS: SetupAnswers = {
  householdSize: "",
  stores: [],
  allergies: [],
  proteins: [],
  staples: [],
  meals: [],
  reminders: "",
  sharing: "",
};

type AnswerKey = keyof SetupAnswers;

interface SetupStep {
  key: AnswerKey | "review";
  title: string;
  sub?: string;
  kind: "single" | "multi" | "review";
  options?: string[];
  /** Multi steps: choosing this option clears every other pick. */
  noneVal?: string;
}

const SETUP_STEPS: SetupStep[] = [
  {
    key: "householdSize",
    title: "How many people are you shopping for?",
    sub: "A few quick questions so the tracker fits your household. Everything can be changed later.",
    kind: "single",
    options: ["Just me", "2 people", "Family of 3–4", "5+ people"],
  },
  {
    key: "stores",
    title: "Where do you usually shop?",
    sub: "Pick every store your household shops at — Ontario's most popular grocery stores.",
    kind: "multi",
    options: [
      "Costco",
      "Walmart",
      "Loblaws",
      "No Frills",
      "Real Canadian Superstore",
      "Metro",
      "Food Basics",
      "Sobeys",
    ],
  },
  {
    key: "allergies",
    title: "Any allergies or dietary needs?",
    sub: "These help meal suggestions fit your household. Pick everything that applies to anyone in the house.",
    kind: "multi",
    options: [
      "Peanuts",
      "Tree nuts",
      "Dairy",
      "Eggs",
      "Gluten",
      "Shellfish",
      "Soy",
      "Vegetarian",
      "Vegan",
      "None",
    ],
    noneVal: "None",
  },
  {
    key: "proteins",
    title: "Which proteins do you buy most?",
    sub: "These become your tracked proteins for meal planning. Any that aren't tracked yet are added to your HIT List when you finish.",
    kind: "multi",
    options: [
      "Chicken Breast",
      "Ground Beef",
      "Eggs",
      "Frozen Burgers",
      "Fish",
      "Turkey",
      "Pork Chops",
      "Salmon Fillets",
    ],
  },
  {
    key: "staples",
    title: "Staples to track from day one",
    sub: "Any that aren't tracked yet are added to your HIT List when you finish.",
    kind: "multi",
    options: [
      "Rice & Pasta",
      "Coffee & Tea",
      "Paper Towels",
      "Cleaning Spray",
      "Pet food",
      "Baking Basics",
      "Breakfast Cereal",
      "Snacks & Lunchbox",
    ],
  },
  {
    key: "meals",
    title: "Meals you make often",
    sub: "These seed your Meal List so planning works right away — only the ones you don't already have are added.",
    kind: "multi",
    options: [
      "Chicken Stir-Fry",
      "Spaghetti Bolognese",
      "Taco Night",
      "Pancake Breakfast",
      "Caesar Salad",
      "Veggie Omelette",
      "BBQ Burgers",
      "Tomato Soup & Toast",
    ],
  },
  {
    key: "reminders",
    title: "Reminders & sale checks",
    sub: "Choose what the app should keep an eye on for you.",
    kind: "single",
    options: [
      "Daily stock reminders",
      "Weekly sale checks",
      "Both",
      "Neither for now",
    ],
  },
  {
    key: "sharing",
    title: "Share with a household partner?",
    sub: "A partner can see the same lists and meal picks. Optional — add one later any time.",
    kind: "single",
    options: ["Yes, add a partner later", "No, just me for now"],
  },
  { key: "review", title: "Review your setup", kind: "review" },
];

const PREVIEW_ROWS: { label: string; key: AnswerKey }[] = [
  { label: "Household size", key: "householdSize" },
  { label: "Shops at", key: "stores" },
  { label: "Allergies & dietary", key: "allergies" },
  { label: "Proteins", key: "proteins" },
  { label: "Staples", key: "staples" },
  { label: "Meals you make often", key: "meals" },
  { label: "Reminders & sale checks", key: "reminders" },
  { label: "Sharing", key: "sharing" },
];

function answerText(answers: SetupAnswers, key: AnswerKey): string {
  const v = answers[key];
  return Array.isArray(v) ? v.join(", ") : v;
}

const chipBase =
  "rounded-full border-2 px-4 py-2 text-sm font-bold text-left";
const chipOn = {
  backgroundColor: "var(--accent)",
  color: "var(--accent-text)",
  borderColor: "var(--accent)",
} as const;
const chipOff = {
  borderColor: "var(--border)",
  backgroundColor: "var(--surface)",
  color: "var(--text)",
} as const;

/**
 * The "Your setup so far" preview box: same label/value rows as the
 * Review summary, rendered ~30% smaller, sitting UNDER the step's
 * questions. Labels always show; values start blank and fill in as
 * answers are given.
 */
function SetupPreview({ answers }: { answers: SetupAnswers }) {
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
          {PREVIEW_ROWS.map((row) => (
            <tr key={row.key}>
              <th
                className="py-0.5 pr-2 text-left align-top font-bold whitespace-nowrap"
                style={{ color: "var(--dim)" }}
              >
                {row.label}
              </th>
              <td className="py-0.5 font-semibold">
                {answerText(answers, row.key)}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export function HouseholdSetup({ onClose }: { onClose: () => void }) {
  const queryClient = useQueryClient();
  const [step, setStep] = useState(0);
  const [answers, setAnswers] = useState<SetupAnswers>(EMPTY_ANSWERS);
  const [otherOpen, setOtherOpen] = useState(false);
  const [otherDraft, setOtherDraft] = useState("");
  const [otherError, setOtherError] = useState<string | null>(null);
  const [finished, setFinished] = useState<{
    addedItems: string[];
    addedMeals: string[];
  } | null>(null);

  const saved = useQuery({
    queryKey: ["household-setup"],
    queryFn: () => api.getHouseholdSetup({}),
  });

  const finish = useMutation({
    mutationFn: async () => await api.completeHouseholdSetup({ answers }),
    onSuccess: (res) => {
      setFinished({
        addedItems: res.addedItems,
        addedMeals: res.addedMeals,
      });
      void queryClient.invalidateQueries({ queryKey: ["hit"] });
      void queryClient.invalidateQueries({ queryKey: ["planner"] });
      void queryClient.invalidateQueries({ queryKey: ["household-setup"] });
    },
  });

  const current = SETUP_STEPS[step];
  if (!current) return null;
  const isReview = current.kind === "review";

  const selectedList = (key: AnswerKey): string[] => {
    const v = answers[key];
    return Array.isArray(v) ? v : v ? [v] : [];
  };

  function pickSingle(key: AnswerKey, value: string) {
    setAnswers((prev) => ({ ...prev, [key]: value }));
  }

  function toggleMulti(stepDef: SetupStep, value: string) {
    const key = stepDef.key as AnswerKey;
    setAnswers((prev) => {
      const cur = [...selectedList(key)];
      const idx = cur.indexOf(value);
      if (stepDef.noneVal && value === stepDef.noneVal) {
        return { ...prev, [key]: idx > -1 ? [] : [value] };
      }
      let next: string[];
      if (idx > -1) {
        next = cur.filter((x) => x !== value);
      } else {
        next = [...cur.filter((x) => x !== stepDef.noneVal), value];
      }
      return { ...prev, [key]: next };
    });
  }

  function applyOther() {
    const stepDef = current;
    if (!stepDef) return;
    const value = otherDraft.trim();
    if (!value) {
      setOtherError("Type an option first — or tap Cancel.");
      return;
    }
    if (stepDef.kind === "single") {
      pickSingle(stepDef.key as AnswerKey, value);
    } else if (stepDef.kind === "multi") {
      const key = stepDef.key as AnswerKey;
      const cur = selectedList(key);
      if (!cur.some((x) => x.toLowerCase() === value.toLowerCase())) {
        toggleMulti(stepDef, value);
      }
    }
    setOtherDraft("");
    setOtherOpen(false);
    setOtherError(null);
  }

  function goTo(next: number) {
    setStep(Math.max(0, Math.min(SETUP_STEPS.length - 1, next)));
    setOtherOpen(false);
    setOtherDraft("");
    setOtherError(null);
    window.scrollTo(0, 0);
  }

  if (finished) {
    return (
      <section aria-label="Household setup complete" className="pt-2 pb-12">
        <h2 className="text-2xl font-bold">Setup saved</h2>
        <p className="mt-2 text-sm text-[var(--dim)]">
          Your household setup answers are saved. Nothing you already
          had was removed or changed — finishing setup only ever adds
          what&rsquo;s new.
        </p>
        {finished.addedItems.length > 0 && (
          <p className="mt-3 text-sm">
            <span className="font-bold">Added to your HIT List: </span>
            {finished.addedItems.join(", ")}
          </p>
        )}
        {finished.addedMeals.length > 0 && (
          <p className="mt-2 text-sm">
            <span className="font-bold">Added to your Meal List: </span>
            {finished.addedMeals.join(", ")}
          </p>
        )}
        {finished.addedItems.length === 0 &&
          finished.addedMeals.length === 0 && (
            <p className="mt-3 text-sm">
              Everything you picked is already tracked, so nothing new
              was added.
            </p>
          )}
        <button
          type="button"
          className="mt-5 rounded-full px-5 py-2 text-sm font-bold"
          style={{
            backgroundColor: "var(--accent)",
            color: "var(--accent-text)",
          }}
          onClick={onClose}
        >
          Done
        </button>
      </section>
    );
  }

  const options = current.options ?? [];
  const customs =
    current.kind === "multi"
      ? selectedList(current.key as AnswerKey).filter(
          (v) => !options.includes(v),
        )
      : current.kind === "single" &&
          answers[current.key as AnswerKey] &&
          !options.includes(answers[current.key as AnswerKey] as string)
        ? [answers[current.key as AnswerKey] as string]
        : [];

  return (
    <section aria-label="Household setup questionnaire" className="pt-2 pb-12">
      <div className="flex items-center justify-between gap-2">
        <p className="text-xs font-bold tracking-wide text-[var(--dim)]">
          HOUSEHOLD SETUP · STEP {step + 1} OF {SETUP_STEPS.length}
        </p>
        <button
          type="button"
          className="shrink-0 rounded-full px-3 py-1.5 text-xs font-bold"
          style={{
            backgroundColor: "var(--surface-alt)",
            color: "var(--text)",
          }}
          onClick={onClose}
        >
          Set up later
        </button>
      </div>
      <h2 className="mt-1 text-2xl font-bold">{current.title}</h2>
      {current.sub && (
        <p className="mt-1 text-sm text-[var(--dim)]">{current.sub}</p>
      )}
      {step === 0 && saved.data?.setup?.completedAt && (
        <p className="mt-2 text-sm text-[var(--dim)]">
          You last finished setup on{" "}
          {new Date(saved.data.setup.completedAt).toLocaleDateString(
            "en-CA",
            { month: "short", day: "numeric", year: "numeric" },
          )}
          . Running it again only saves your answers and adds anything
          new — it never removes or resets what you have.
        </p>
      )}

      {!isReview && (
        <div className="mt-4">
          {current.kind === "multi" && (
            <p
              className="mb-2 text-sm font-bold"
              style={{ color: "var(--accent)" }}
            >
              Select all that apply
              {selectedList(current.key as AnswerKey).length > 0
                ? ` · ${selectedList(current.key as AnswerKey).length} selected`
                : ""}
            </p>
          )}
          <div className="flex flex-wrap gap-2">
            {options.map((o) => {
              const selected =
                current.kind === "multi"
                  ? selectedList(current.key as AnswerKey).includes(o)
                  : answers[current.key as AnswerKey] === o;
              return (
                <button
                  key={o}
                  type="button"
                  aria-pressed={selected}
                  className={chipBase}
                  style={selected ? chipOn : chipOff}
                  onClick={() =>
                    current.kind === "multi"
                      ? toggleMulti(current, o)
                      : pickSingle(current.key as AnswerKey, o)
                  }
                >
                  {selected ? `✓ ${o}` : o}
                </button>
              );
            })}
            {customs.map((o) => (
              <button
                key={o}
                type="button"
                aria-pressed={true}
                className={chipBase}
                style={chipOn}
                onClick={() =>
                  current.kind === "multi"
                    ? toggleMulti(current, o)
                    : pickSingle(current.key as AnswerKey, "")
                }
              >
                ✓ {o}
              </button>
            ))}
            <button
              type="button"
              aria-pressed={otherOpen}
              className={chipBase}
              style={chipOff}
              onClick={() => {
                setOtherOpen((v) => !v);
                setOtherError(null);
              }}
            >
              Other…
            </button>
          </div>
          {otherOpen && (
            <div className="mt-3">
              <div className="flex flex-wrap gap-2">
                <input
                  value={otherDraft}
                  onChange={(e) => setOtherDraft(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") {
                      e.preventDefault();
                      applyOther();
                    }
                  }}
                  placeholder="Type your own option…"
                  aria-label="Your own option"
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
                  onClick={applyOther}
                >
                  Use this
                </button>
                <button
                  type="button"
                  className="rounded-full px-3 py-2 text-sm font-bold text-[var(--dim)]"
                  onClick={() => {
                    setOtherOpen(false);
                    setOtherDraft("");
                    setOtherError(null);
                  }}
                >
                  Cancel
                </button>
              </div>
              <p className="mt-2 text-sm text-[var(--dim)]">
                Your own option counts exactly like a preset — it takes
                the highlight and ✓, and shows in “Your setup so far”
                and on the Review screen.
              </p>
              {otherError && (
                <p
                  role="alert"
                  className="mt-1 text-sm font-semibold text-[var(--red)]"
                >
                  {otherError}
                </p>
              )}
            </div>
          )}
        </div>
      )}

      {isReview && (
        <div className="mt-4 flex flex-col gap-2">
          {PREVIEW_ROWS.map((row) => (
            <div
              key={row.key}
              className="rounded-xl border px-3 py-2"
              style={{
                borderColor: "var(--border)",
                backgroundColor: "var(--surface)",
              }}
            >
              <p className="text-xs font-bold tracking-wide text-[var(--dim)]">
                {row.label}
              </p>
              <p className="text-base font-semibold">
                {answerText(answers, row.key) || "—"}
              </p>
            </div>
          ))}
          <p className="text-sm text-[var(--dim)]">
            Finishing saves these answers as your household setup.
            Starter items and meals are added only when they
            aren&rsquo;t already tracked — nothing is removed,
            overwritten, or reset.
          </p>
          {finish.isError && (
            <p
              role="alert"
              className="text-sm font-semibold text-[var(--red)]"
            >
              Setup didn&rsquo;t save. Please try again.
            </p>
          )}
        </div>
      )}

      {/* The preview box sits UNDER the questions on every step but
          Review — the Review summary takes its place there. */}
      {!isReview && <SetupPreview answers={answers} />}

      {/* In-flow step navigation — directly under the step. */}
      <div className="mt-6 flex flex-wrap items-center gap-2">
        {step > 0 && (
          <button
            type="button"
            className="rounded-full px-4 py-2 text-sm font-bold"
            style={{
              backgroundColor: "var(--surface-alt)",
              color: "var(--text)",
            }}
            onClick={() => goTo(step - 1)}
          >
            Back
          </button>
        )}
        {!isReview ? (
          <>
            <button
              type="button"
              className="rounded-full px-5 py-2 text-sm font-bold"
              style={{
                backgroundColor: "var(--accent)",
                color: "var(--accent-text)",
              }}
              onClick={() => goTo(step + 1)}
            >
              Continue
            </button>
            <button
              type="button"
              className="rounded-full px-4 py-2 text-sm font-bold text-[var(--dim)]"
              onClick={() => goTo(step + 1)}
            >
              Skip
            </button>
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
            {finish.isPending ? "Saving…" : "Finish setup"}
          </button>
        )}
      </div>
    </section>
  );
}
