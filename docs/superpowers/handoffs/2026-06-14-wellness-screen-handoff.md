# Handoff — Wellness screen (Jarvis Design System web implementation)

**Date:** 2026-06-14 · **From:** "Jarvis design" session (chat drawer just landed). **Your job:** bring the **Wellness** screen of the design-system prototype into `apps/web`, wired to the real backend, as the functional baseline. Ben separates functionality from design — build a functional default, ship live, he annotates the look via agentation.

## Branch / scope discipline (IMPORTANT)

- The design work so far (foundation + Today + Tasks + shell + Chat drawer) is committed as `40f6742` and is in **PR #219** (`phase2-portable-deploy` → `main`). **Do NOT add commits to `phase2-portable-deploy`** — that would pollute #219.
- **Create your own branch off `40f6742`** (it has the design foundation you need): e.g. `git switch -c feat/web-wellness phase2-portable-deploy`. Commit Wellness there, separately. Open its own PR when done.
- Shared working tree — other sessions exist. **Stage only your own paths, never `git add -A`.** Coordinate via the `herdr-pane-message` skill if you touch anything tree-wide.

## Hard rules (do not skip)

- **Full gate before any commit:** `pnpm --filter @jarv1s/web typecheck`, `pnpm lint`, `pnpm format:check` (run `npx prettier --write` on touched files), and **`pnpm check:file-size`**. The last one is enforced and easy to forget: **no source file — CSS included — may exceed 1000 lines.** If a `wellness.css` port is large, split it by section into `wellness-*.css` and import the pieces **in original order** so the cascade is unchanged (that's how `kit.css`/`components.css` were handled → `kit-*.css`, `components-*.css`).
- **`tokens.css` is the ONLY file with hex/rgb literals.** Swap any `#fff` → `var(--white)`, etc.
- **Verify without auth via a static harness:** the app needs login, so assert the screen's DOM and computed layout using the real CSS (`tokens.css`, `components-core/-jarvis.css`, the `kit-*.css` set, your new wellness CSS) + lucide CDN in an HTML harness with Playwright (resolve `@playwright/test` by absolute path; `.cjs`; toggle `data-theme` for light/dark).
- Comms: terse, lead with results, no preamble or closing recap+offer.

## Get the prototype

- Claude Design project **"Jarvis Design System"**, `projectId = 82a2256f-ea39-4ae5-9b94-4aec68cdaa56`. Read files with the **`DesignSync`** tool (`ToolSearch` → `select:DesignSync`, then `DesignSync({method:"get_file", projectId, path})`). NOTE: Task-tool **subagents cannot** call DesignSync — call it from your top-level session.
- Files you need:
  - `ui_kits/jarvis-app/Wellness.jsx` (screen structure — analyzed below)
  - `ui_kits/jarvis-app/WellnessCheckin.jsx` (guided check-in modal)
  - `ui_kits/jarvis-app/WellnessCharts.jsx` (the combined mood+med chart)
  - `ui_kits/jarvis-app/wellness-data.js` (emotion set, `computeInsights`, `medColor`, mood-index math)
  - `ui_kits/jarvis-app/wellness.css` (the `wl-*` styles) — large; if it auto-persists to `tool-results/*.txt`, extract with `jq -r '.content' <path> > dest` so it doesn't bloat context.
- Bake the prototype tweak DEFAULTS as fixed design (no tweak UI): `checkinStyle=Guided`, `emotionTint=on` (color emotions), `wellDensity=Comfortable`, `medStrip=Dots`.

## Prototype Wellness — structure (from Wellness.jsx)

One scrolling screen: **Hero** (3 stats: meds-today · mood·14d · check-in streak) → **Today** (`MedToday`: morning/evening med groups, toggle taken, progress bar, Manage; `CheckinToday`: emotion-strip quick-start OR done-state showing emotion/feeling/sensations/intensity/note) → **Insights** ("what this month is telling you", `computeInsights`) → **Trends** (`CombinedChart`: mood line + med dots, 14/30d toggle, help popover, emotion legend) → **Check-in history** (expandable rows, edit, notes filter) → **Therapy notes** ("for your next session" pad) → modals: `WellnessCheckin` (guided), `ManageMeds`.

## Real backend (already built — this is a REBUILD, not a re-skin)

- App side today is **basic**: `apps/web/src/wellness/wellness-page.tsx` = a Feelings/Medications tab toggle + `FeelingsCheckinModal` + `MedicationsView`. Plain generic classes. You're rebuilding it to the prototype.
- **Contracts:** `packages/shared/src/wellness-api.ts`. Check-ins use the **6-core Gloria Willcox Feelings Wheel** — `feelingCore` ∈ {mad, sad, scared, joyful, powerful, peaceful} → `feelingSecondary` → `feelingTertiary`, plus `sensations[]`, `intensity`, `energy`, `note`, `identifiedVia`. Medications have full scheduling (`frequencyType`: once_daily/times_per_day/as_needed/cyclical/…, `scheduleTimes`, `dosage`, `active`) + per-date schedule + taken/skipped/prn logs.
- **API client:** `apps/web/src/api/client.ts` — `listWellnessCheckins`, `createWellnessCheckin`, `listMedications`, `createMedication`, medication schedule(date), medication logs.

## Scope gaps → decisions to confirm WITH BEN before building (he likes review-then-discuss, one fork at a time)

1. **Emotion model.** Prototype uses an ad-hoc emotion set + single "feeling" string. **Keep the real 6-core wheel** (it's deliberately built and matches the Emotion/Sensation/Feeling wheel in `uploads/`); map the prototype's emotion coloring/labels onto the 6 cores. Don't rebuild around the prototype's simpler set. (Strong recommendation — confirm.)
2. **Therapy notes** — **no backend exists.** New persistence = its own slice + spec ("spec before build"). Recommend **defer** (log an issue), don't build in this design pass.
3. **Trends chart + Insights** — **no new backend needed**; both are client-derivable from real check-ins + med logs (same honest-derivation principle as the chat empty-state seeds). Recommend include this pass, derived from real data.
4. **Staging** — the screen is large; consider staged commits (Today-actions first, then trends/history) to keep diffs reviewable and files under the size limit.

## Useful references in-repo

- `apps/web/src/today/today-page.tsx` — data patterns (useQuery on `listTasks`/`listCalendarEvents`, date helpers, `cmd-*`/serif editorial layout).
- `apps/web/src/chat/chat-drawer.tsx` + `chat/seeds.ts` — the just-landed re-skin: honest client-derived content, `<details>` collapsibles, real-API wiring — a good template for tone/approach.
- `apps/web/src/tasks/focus.ts` — reusable task predicates.
- Dev servers are live (web :5173 `--host`, API :3000); Vite HMR picks up edits. **Do NOT run `pnpm install`** (node_modules present).
