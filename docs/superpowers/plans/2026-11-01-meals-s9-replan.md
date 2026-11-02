# Meals S9 build plan - mid-week re-plan and quick swap

Issue #3893, Vikunja card 314. Parent plan section S9 and section 6.6/6.8 in
[the phase 2 plan](2026-10-31-meals-phase-2.md). Spec stories 46a to 46d and 83c.

## Seams check (verified on this branch, slices 7 and 10 merged)

- `meals.plan.control` exists with stop/resume/retry_day/regenerate. It returns a plan view.
  File `external-modules/meals/src/plans/tools.ts`, function `planControl`.
- `meals.meal.swap` exists with request_choices/choose. File
  `external-modules/meals/src/plans/meal-tools.ts`, function `mealSwap`.
- The meal job already declares the `quick_swap` mode and rejects it. File
  `external-modules/meals/src/plans/meal-job.ts`, function `runMealJob`. Removing that rejection
  is the quick swap seam. Job params stay meal id, generation and mode only.
- One drafting path serves the day job and swap choices. File
  `external-modules/meals/src/plans/draft.ts`, function `draftSafeRecipe`. It already checks the
  cook-time cap, Safety, repeats, the one-star veto and the Pantry rule.
- Slot rules already carry an optional usual time. Spec correction C11 needs no new field there.
- The recipe view already has a per-ingredient `missing` flag. It is always false today. File
  `external-modules/meals/src/plans/view.ts`, function `recipeView`.
- The last SQL file is 0026. S9 adds 0027. Slice S8 runs at the same time and may also take 0027. Whoever merges second renumbers.

## Decisions

1. New domain file `src/domain/replan.ts` with the two signatures the parent plan names.
   - `replanScope(plan, now, timeZone, rules)` returns the meal ids a re-plan replaces.
   - `missingFor(ingredients, pantry)` returns the names a recipe still needs to buy.
2. Re-plan scope rule. A meal is in scope when all of these hold.
   - It passes the existing replaceable rule (recipe kind, unlocked, uncooked, ready or failed).
   - Its day is after today in the given time zone.
   - Or its day is today and its slot has no usual time, or the usual time has not passed yet.
     A usual time equal to now has not passed.
   - Past days never change. That is the "keep the days already written" bar.
3. Re-plan forces on-hand cooking. When the plan mode is `ignore`, a re-plan raises it to
   `prefer` and stores that on the plan. `prefer` and `only` stay as they are. The day job then
   reads the Pantry as it does today, so no new job param is needed.
4. Re-plan reuses Regenerate's reset and enqueue path. Only the scope and the Pantry mode
   differ. No second reset path.
5. The clock is a seam, not a global. The plan deps gain an optional `now` function. Tests set
   it. Live code uses the real clock. The tool takes an optional `timeZone` string. The page
   sends its own zone. Chat sends none and the handler falls back to UTC, which can misjudge a
   meal near midnight. That limit goes in the tool description.
6. Quick swap input is `maxMinutes`, a whole number from 5 to 240. It is stored on the meal in
   the new `quick_max_minutes` column from SQL 0027, so a queued job that runs late still knows
   the cap. Job params carry no strings and no cap, per the parent plan.
7. The quick swap job drafts one recipe through the same drafting path, with two changes.
   - The cook-time cap is the stored quick cap.
   - The model call passes the interactive tier hint, per spec story 83c. The drafting path
     gains an optional tier hint. Every existing caller keeps the reasoning tier.
   - The Pantry is read in `prefer` mode even when the plan ignores it, per story 46d. The
     drafting path gains an optional Pantry mode override. No other caller changes.
8. The quick swap writes straight onto the meal, not into swap choices. New store methods claim
   and save against the meal job generation, so a stale quick job writes nothing. On success the
   shopping list rebuilds through the existing plan-change hook. On failure the meal is marked
   failed with the drafting reason, like a day job meal.
9. Still to buy. The recipe view sets `missing` from the Pantry the worker can read, using
   `missingFor`. Names only, no amounts, matching the parent plan signature. The recipe screen
   lists the missing names under a "Still to buy" line. When nothing is missing it says so in
   the same place only after a quick swap. A plain recipe read with no Pantry store keeps
   `missing` false.
10. Views and manifest. The planned meal view gains `quickMaxMinutes` (number or null). Every
    output schema that carries a planned meal gains the field, or the page would blank it.
    The module version goes 0.6.1 to 0.7.0. S8 may land 0.7.0 first. Whoever merges second
    takes the next patch number.
11. App map. Features `meals.replan` and `meals.quick-swap` in the manifest app map, in this PR.
    Release note stays Category N/A because Meals is unlisted until S12.
12. Page. The Plan screen gains a "Re-plan the rest of the week" control with a confirm dialog,
    shown only when the plan has days after today. Each ready meal gains a "Quick swap" control
    that asks for minutes (default 15) and calls the swap tool. Both go through the existing
    write handle and stay hidden without one. No new screen, so routes stay as they are.
13. Spec write-back. Correction C11 already sits in the parent plan table. The spec gains one
    line under story 46a noting the usual-time rule, if it is not already plain there.

## Determinism boundary

All page feedback renders from returned records. The model only writes recipes and judges
Safety. It never writes page text, counts or the still-to-buy list. Those come from the store
and the pure Pantry rule.

## Tests that fail first

Unit, at the tool and job seam with the in-memory store and scripted model.

- Re-plan replaces only future unlocked uncooked meals, and today's meals whose usual time has
  not passed. A meal today after its usual time, a locked meal, a cooked meal and a past day all
  keep their recipes. It fails if re-plan is just whole-plan regenerate.
- Re-plan on an ignore-mode plan drafts from the Pantry. The scripted model first offers a dish
  needing food nobody has, in `only`-style rejection it would fail, so the assert is weaker and
  exact. The plan view after re-plan shows `prefer`. It fails if the mode is untouched.
- Quick swap honours the cap. The model first offers a 45-minute dish for a 15-minute ask. The
  saved recipe cooks in 15 minutes or less. It fails if the day's cook limit is used instead.
- Quick swap passes the interactive tier. The scripted model records the tier hint of the recipe
  call. It fails if the hint stays reasoning.
- Quick swap lists what is still to buy. The Pantry holds rice only. The saved recipe's view
  marks the other ingredients missing and rice not missing. It fails while `missing` stays false.
- A one-star dish is never the quick swap result, and a favourite recipe still shows its marks
  after a quick swap. Both ride the shared drafting path, so these guard against a private
  quick path that skips them.
- A stale quick job writes nothing. Two quick asks in a row, the first job runs last and the
  meal keeps the second recipe.
- The old test that expects quick_swap to be rejected is updated to expect it to run.

Database seam, through the gate. SQL 0027 installs on a clean module install, and the quick cap
column reads back per owner with the two owners kept apart by the existing plan store tests.

Manifest. The swap tool accepts `quick` and `maxMinutes`. The plan control accepts `replan`.
Every planned meal schema carries `quickMaxMinutes`.

Page. With a write handle, the Plan screen shows Re-plan and Quick swap and calls the tools with
the right input. Without a handle, neither control renders.

## Verification

```bash
pnpm build:external:meals > /mnt/unity-nvme/scratch/meals-s9/build.log 2>&1; echo "EXIT=$?"
pnpm typecheck > /mnt/unity-nvme/scratch/meals-s9/tc.log 2>&1; echo "EXIT=$?"
pnpm test:unit tests/unit/external-module-meals > /mnt/unity-nvme/scratch/meals-s9/unit.log 2>&1; echo "EXIT=$?"
pnpm check:ui-classes > /mnt/unity-nvme/scratch/meals-s9/ui.log 2>&1; echo "EXIT=$?"
scripts/run-gate.sh start --gate test:integration
```

The gate runs through the verify-gate skill. Its sentinel exit code is the verdict.

## Live proof

Own throwaway instance. Ports from devports, own Postgres container, never the dev database.
Enable Meals, sign in with the saved Claude sign-in, plan a week, then through the real page
re-plan the rest of the week mid-week and quick swap tonight's dinner to 15 minutes. Check the
still-to-buy line on the recipe. Visual pass at 1280 and 390, light and dark, empty, loading,
error and long text. Cropped screenshots stay on disk under the scratch folder and go on the PR
as a comment. Then clean up servers, ports, container and scratch.

## Kill gate

If the shared drafting path cannot take a tier hint and a Pantry override without branching the
day job's behaviour, stop and tell the coordinator. A second drafting path for quick swaps is
not acceptable. It would drift from Safety and the veto rule.

## Out of scope

Page write controls beyond these two buttons (S11), arranging the week (S8), and any change to
the other lane's branch.
