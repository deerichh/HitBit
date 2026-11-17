import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { api, type ApiResponse } from "./api";
import { SourceDropdown } from "./SourceDropdown";

type VideosData = ApiResponse<typeof api, "getRecipeVideos">;
type VideoEntry = VideosData["videos"][number];

const MEAL_TYPE_LABELS: Record<VideoEntry["mealType"], string> = {
  breakfast: "Breakfast",
  lunch: "Lunch",
  dinner: "Dinner",
  snack: "Snack",
};

/** Kitchen-style quantity formatting (½, ¼, ¾) for snapshot amounts. */
function formatQuantity(v: number): string {
  const rounded = Math.round(v * 4) / 4;
  const whole = Math.floor(rounded);
  const frac = rounded - whole;
  const fracStr =
    frac === 0.25 ? "¼" : frac === 0.5 ? "½" : frac === 0.75 ? "¾" : "";
  if (fracStr) return whole > 0 ? `${whole}${fracStr}` : fracStr;
  if (Number.isInteger(rounded)) return String(rounded);
  return String(Math.round(v * 100) / 100);
}

function VideoCard({ entry }: { entry: VideoEntry }) {
  const ready = entry.status === "ready";
  return (
    <li
      className="rounded-2xl px-4 py-4"
      style={{
        backgroundColor: "var(--surface)",
        border: "1px solid var(--border)",
      }}
    >
      <div className="flex items-baseline justify-between gap-3">
        <h3 className="text-lg font-bold leading-snug text-[var(--text)]">
          {entry.recipeName}
        </h3>
        <span
          className="shrink-0 rounded-full px-2 py-0.5 text-[13px] font-bold"
          style={
            ready
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
          {ready ? "Video ready" : "Video requested"}
        </span>
      </div>
      <p className="mt-0.5 text-sm text-[var(--dim)]">
        {MEAL_TYPE_LABELS[entry.mealType]}
        {entry.protein ? ` · ${entry.protein}` : ""} · for{" "}
        {entry.servings} {entry.servings === 1 ? "person" : "people"}
        {entry.mealName ? " · saved on the Meal List" : ""}
      </p>

      {ready && entry.videoUrl ? (
        <video
          controls
          playsInline
          preload="metadata"
          src={entry.videoUrl}
          aria-label={`Cooking video for ${entry.recipeName}`}
          className="mt-3 w-full rounded-xl"
          style={{ backgroundColor: "var(--surface-alt)" }}
        />
      ) : (
        <p className="mt-3 text-sm font-medium text-[var(--dim)]">
          {ready
            ? "The video is marked ready — its link hasn't been added yet."
            : "Video requested — Muse is making it. It'll play here when it's ready."}
        </p>
      )}
      {entry.note && (
        <p className="mt-1 text-xs text-[var(--dim)]">{entry.note}</p>
      )}

      {entry.sourceUrl && entry.sourceSite && (
        <div className="mt-3">
          <SourceDropdown
            name={entry.sourceName ?? entry.recipeName}
            headingBefore="Recipe from"
            siteName={entry.sourceSite}
            url={entry.sourceUrl}
            itemLabel={entry.sourceName ?? entry.recipeName}
          />
        </div>
      )}

      {entry.ingredients.length > 0 && (
        <>
          <h4 className="mt-4 text-sm font-semibold text-[var(--text)]">
            Ingredients · for {entry.servings}{" "}
            {entry.servings === 1 ? "person" : "people"}
          </h4>
          <ul className="mt-1.5 space-y-1 text-sm text-[var(--text)]">
            {entry.ingredients.map((ing, i) => (
              <li key={i} className="flex gap-2">
                <span className="w-24 shrink-0 font-medium">
                  {ing.quantity != null
                    ? `${formatQuantity(ing.quantity)}${ing.unit ? ` ${ing.unit}` : ""}`
                    : (ing.unit ?? "")}
                </span>
                <span>{ing.name}</span>
              </li>
            ))}
          </ul>
        </>
      )}

      {entry.steps.length > 0 && (
        <>
          <h4 className="mt-4 text-sm font-semibold text-[var(--text)]">
            Walkthrough
          </h4>
          <ol className="mt-1.5 list-decimal space-y-1.5 pl-5 text-sm text-[var(--text)]">
            {entry.steps.map((step, i) => (
              <li key={i}>{step}</li>
            ))}
          </ol>
        </>
      )}
    </li>
  );
}

/**
 * Recipe videos — collapsible section that lives in the settings
 * drawer (the gear beside the app title), moved there from the
 * bottom of the Meal Planner tab (before that it was its own
 * top-level Media tab). Collapsed by default, styled like the Meal
 * List collapsible. Expanded it shows exactly what
 * the Media tab showed: every recipe with a video requested or
 * ready — name, meal type, protein, people, ingredients,
 * walkthrough, and the embedded player when a video URL is stored.
 */
export function RecipeVideosSection() {
  const [open, setOpen] = useState(false);
  const videos = useQuery({
    queryKey: ["videos"],
    queryFn: () => api.getRecipeVideos({}),
    // Poll gently so a video Muse finishes shows up without a
    // manual refresh.
    refetchInterval: 30000,
  });

  const entries = videos.data?.videos ?? [];
  const count = entries.length;

  return (
    <div className="mt-2">
      <button
        type="button"
        aria-expanded={open}
        aria-controls="recipe-videos-panel"
        onClick={() => setOpen((v) => !v)}
        className="flex w-full items-center justify-between gap-2 rounded-[var(--radius)] border border-[var(--border)] bg-[var(--surface)] px-4 py-3 text-left text-[var(--text)]"
      >
        <span className="text-base font-semibold">Recipe videos</span>
        <span className="flex items-center gap-2 text-sm text-[var(--dim)]">
          <span>
            {count === 0
              ? "none yet"
              : `${count} ${count === 1 ? "recipe" : "recipes"}`}
          </span>
          <span aria-hidden="true">{open ? "▾" : "▸"}</span>
        </span>
      </button>

      {open && (
        <div id="recipe-videos-panel" className="mt-2">
          <p className="text-sm text-[var(--dim)]">
            Recipes you&rsquo;ve asked Muse to film — the ingredients,
            the walkthrough, and the video when it&rsquo;s ready.
          </p>

          {videos.isPending ? (
            <p className="py-8 text-center text-sm text-[var(--dim)]">
              Loading your videos…
            </p>
          ) : videos.error ? (
            <p
              className="py-8 text-center text-sm"
              style={{ color: "var(--red)" }}
            >
              The videos couldn&rsquo;t be loaded. Try again in a moment.
            </p>
          ) : entries.length === 0 ? (
            <div className="py-8 text-center">
              <p className="text-base font-semibold text-[var(--text)]">
                No cooking videos yet
              </p>
              <p className="mx-auto mt-2 max-w-xs text-sm text-[var(--dim)]">
                Generate a recipe in the Meal Planner and tap “Make
                the cooking video”, or use the same button on any meal
                in the Meal List — the recipe and its video will live
                here.
              </p>
            </div>
          ) : (
            <ul className="mt-2 space-y-4">
              {entries.map((entry) => (
                <VideoCard key={entry.id} entry={entry} />
              ))}
            </ul>
          )}
        </div>
      )}
    </div>
  );
}
