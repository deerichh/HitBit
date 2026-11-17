# Contributing to HitBit

HitBit is a household (HIT) and business (BIT) inventory tracker: a
React client in `client/`, server actions in `server/src/actions.ts`,
the schema in `server/src/schema.ts`, and Drizzle SQL migrations in
`drizzle/` (see `space.json` for the app name and slug).

## Commands

```sh
bun install
bun run typecheck   # client + server, no emit
bun run build       # server bundle, then client bundle
```

## Layout

- `client/src/` — React app: `App.tsx` (side chooser + Settings
  drawer), `HitListTab.tsx`, `BitApp.tsx` (business inventory,
  checks, requisitions), `MealPlannerTab.tsx`, `SettingsDrawer.tsx`.
- `server/src/actions.ts` — all server actions (HIT + BIT).
- `server/src/schema.ts` — Drizzle schema and shared constants.
- `server/src/reqFormTemplate.ts` — builds the generic requisition
  PDF form from scratch with pdf-lib (no official form is embedded).
- `server/src/migration/` — seed/sample data JSON only: the generic
  sample business (The Daily Scoop) and its analytics dataset.
- `drizzle/` — migrations `0001`–`0039` plus `meta/_journal.json`.
  Keep migration order and the journal consistent; never renumber a
  shipped migration. `0027` is a documented no-op kept so the order
  stays intact.

## Rules

- **No user data in the repo.** No database file, no household or
  business records, no receipt photos, no personal identifiers, no
  real sheet IDs, keys, or tokens. `SPREADSHEET_ID` in
  `server/src/actions.ts` ships blank.
- **Never guess** a SKU, UPC, price, or dimension. Prices are
  verified on the product page, never from a search snippet.
- **Sample data only.** The only seeded business is the generic
  sample shop, loaded by `importSampleData` when no business exists
  yet. A new user starts clean and enters or uploads their own info.
- **Requisitions stay generic.** Preparer / approver sign-off, free-
  text Division, recipient typed per send. No organisation-specific
  form, email, division list, or catalogue ships here.
- **Undo policy.** Undo reverts the last action (Settings → "Undo
  last action"). Permanent action types are skipped; a connected
  account can only revert its own actions.
- `package.json` lists `@hatch/space-sdk` as a `file:` dependency on
  the original build runtime's path — point it at your own published
  copy (or drop it) when setting the project up elsewhere.
