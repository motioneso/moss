# Build plan: Meals, weekly meal planning (#3317)

**Spec:** `docs/superpowers/specs/2026-10-09-meals-meal-planning-design.md` (Final, merged in #3440)
**Issue:** #3317 (`task`)
**Package:** `external-modules/meals/`, replacing `external-modules/food/`
**Plan scope:** Phase 1 (clickable prototype) in detail. Phase 2 is named with its blockers and
forks so they can be settled while the prototype is built. Phases 3 to 5 are named only.

---

## 0. Gates

| Gate                        | State                                                                 |
| --------------------------- | --------------------------------------------------------------------- |
| Approved design spec        | Done. Spec marked Final 2026-10-25 after a user-story review          |
| Task issue                  | Done. #3317, labels `task`, `ready-for-agent`                         |
| Agreed screens for a module | Phase 1 of this plan. Ben ruled the prototype replaces static mockups |
| Platform blockers for build | Open. See §1.2. None of them blocks phase 1                           |

Phase 1 needs no platform capability. It is static files under `docs/`.

---

## 1. Seams check

Verified 2026-10-25 against `origin/main` at `3adeb2de3`.

### 1.1 Present

| Capability                                    | Evidence                                                                                                                                |
| --------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------- |
| Structured AI call from a module              | `packages/module-sdk/src/worker.ts:122-131`; keys `schema`, `prompt`, `maxOutputTokens`, `tierHint` only (`worker-rpc-host.ts:574-600`) |
| AI error kinds returned, not thrown           | `packages/module-registry/src/external/worker-rpc-host.ts:407-409`, `:417`                                                              |
| 500 AI calls per invocation                   | `worker-rpc-host.ts:122`                                                                                                                |
| Manifest cron schedules, one per active user  | `packages/module-sdk/src/external-module.ts:133-141`; `validate.ts:386-410`; `job-reconciler.ts:150-170`                                |
| Owner-only RLS and deletion from owned tables | `packages/db/src/module-rls-emitter.ts:24-70`; `packages/module-registry/src/index.ts:3531-3540`                                        |
| Extra columns such as `kitchen_id` allowed    | `packages/db/src/migrations/module-sql-runner.ts:14-16`, `:35-45` (prefix check only)                                                   |
| Job params carry ids                          | `packages/jobs/src/module-jobs.ts:58`, `:83-93`; ids typed `uuid`/`identifier` inside `params`, 2 KB cap                                |
| Navigation, settings cog, app map             | `external-module.ts:252-260`, `:442-446` (`settingsPath`), `:295-306` (`appMap`); `apps/web/src/shell/module-settings-button.tsx:8`     |
| Admin purge of the old module                 | `packages/settings/src/repository-external-modules.ts:364-380`; queues via `job-reconciler.ts:207-216`                                  |
| Existing estimator to reuse                   | `external-modules/food/src/estimator/run.ts:73-80`                                                                                      |
| Prototype loading real Moss styles by path    | `docs/superpowers/specs/assets/2026-09-04-workshop/index.html:7-11`                                                                     |

### 1.2 Absent, and what each blocks

| Gap                                              | Evidence                                                                                                                        | Blocks                        | Issue                      |
| ------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------- | ----------------------------- | -------------------------- |
| Module page cannot run its own write tools       | `packages/ai/src/routes.ts:967-990` returns 403 `confirmation_required`                                                         | Every page action in phase 2  | #1699, reopened 2026-10-25 |
| A job or tool handler cannot enqueue a job       | No enqueue member in `worker.ts:56-182` or `worker-rpc-host.ts:211-534`                                                         | Day-by-day plan generation    | #3715                      |
| Data export for downloaded modules               | No export key in `external-module.ts:389-457`; `validate.ts:915-950`                                                            | Live-path gate for all phases | #1694 open                 |
| Module attachments; image input to structured AI | Spec §Platform Blockers                                                                                                         | Receipt and fridge photos     | #1695, #1696 open          |
| Per-task AI binding inside a module              | RPC has no task field (`worker-rpc-host.ts:574-600`); admin pane lists chat and email only (`settings-ai-admin-pane.tsx:72-86`) | Stories 83b to 83d            | #3716                      |
| Instance AI pin overrides module bindings        | `packages/ai/src/repository.ts:1405-1410`; the module bridge never sets `requireExplicitBinding`                                | Stories 83b to 83d            | #3716                      |
| Cross-user Kitchen RLS                           | One owner predicate for all tables (`module-rls-emitter.ts:43-69`)                                                              | Phase 5 sharing               | Not filed                  |

### 1.3 Corrections to the spec

- **#1699 is not retired.** The spec lists it as covered. The issue was closed on 2026-09-19 with an
  audit comment confirming the gap, and the route still 403s. Phase 2 cannot ship a working page
  without it.
- **"One job per day, chained" cannot be built today.** Nothing lets a handler start the next job.
- **The ten-minute run ceiling needs `timeoutMs: 600000` on the queue.** Without it the hard limit
  is 120 s (`worker-runtime.ts:40-41`, `:113-115`).
- **A 30 s stall timeout applies** (`worker-runtime.ts:185`). Whether an in-flight AI call counts as
  activity is unverified (open question Q4).
- **The default tier hint is `economy`** (`repository.ts:1377-1384`). Plan writing must pass
  `reasoning` explicitly.
- **Per-task binding falls back to `module.worker`, not `module.meals`** (`repository.ts:1421-1422`).
  The per-task blocker must fix the fallback order the spec describes.

The spec gets a follow-up edit for these once Ben rules on §2.

---

## 2. Design forks, ranked

Both forks gate phase 2, not phase 1. Ben delegated both to the Meals build on 2026-10-30.

**Settled 2026-10-30: A1 and B1.**

- A1, because it is the only option where a plan started from chat finishes with the tab closed,
  and it costs nothing while no plan is being written. The enqueue spec is drafted
  (`docs/superpowers/specs/2026-10-25-module-job-enqueue-design.md`, #3715). A2 stays the fallback
  only if that spec is rejected.
- B1, because ticking a list line, locking a meal and marking Bought are page actions done many
  times a minute, and an approval prompt on each one makes the page unusable in a shop. The page
  write spec is drafted (`docs/superpowers/specs/2026-10-25-module-page-write-tools-design.md`,
  #1699).

### Fork A: how a plan gets written day by day

| Option                                             | For                                                        | Against                                                                                           |
| -------------------------------------------------- | ---------------------------------------------------------- | ------------------------------------------------------------------------------------------------- |
| **A1. New platform enqueue call (recommended)**    | Matches the spec. Chat-started plans work. No polling cost | New blocker issue and spec. Phase 2 generation waits on it                                        |
| A2. Per-user cron every minute drains pending days | Works today. No platform change                            | Up to a minute of dead time per day. A job runs every minute for every user with Meals enabled    |
| A3. The page starts each day through manual run    | Works today                                                | Breaks when the tab closes. Chat-started plans never finish. Rate limit of 6 per minute           |
| A4. One job writes the whole plan                  | Simplest                                                   | 3.5 min per day observed on Melio, so 7 days overruns ten minutes. Any-length plans make it worse |

The case for A2 is that it ships with no dependency, and the dead time is small next to a
three-minute day. It loses because it charges every Meals user a job a minute forever to fix one
platform gap. A2 stays the fallback if A1 has not landed when phase 2 starts.

### Fork B: page writes while #1699 is open

| Option                                         | For                        | Against                                                              |
| ---------------------------------------------- | -------------------------- | -------------------------------------------------------------------- |
| **B1. Build #1699 first (recommended)**        | The page works as designed | Platform work ahead of phase 2                                       |
| B2. Ship phase 2 with every write through Chat | No platform dependency     | Ticking a list line through an approval prompt is unusable in a shop |

B2 is rejected because ticking, locking and marking Bought happen many times a minute.

---

## 3. Determinism boundary

Binding for every phase.

- Every piece of page feedback renders from records. That covers day progress, day status,
  Safety check outcome, list totals, Pantry amounts, calorie fit and "written by" labels.
- Meals never injects a turn into chat. Chat tools return records and the host renders them.
- The model has three jobs, one more than the house rule allows:
  1. Write one recipe to a schema for named eaters, targets, restrictions and Pantry contents.
     Plan, regenerate, swap and quick swap all use this job.
  2. Judge one recipe against restrictions, returning pass or fail with the failing ingredient.
     This is the second pass after the deterministic term check.
  3. Turn free text into structured items. Receipt text uses it, and the reused estimator already
     does it for the log.

  Job 2 stays (section 5, ruling 4).

- Everything else is TypeScript over records. That includes aggregation, Pantry subtraction,
  Purchase amounts, calorie fit, no-repeat, locking and the check-the-label flag.
- `assistantOnboarding.guidance` stays at 150 words or fewer.
- Model values that reach user data (recipes, amounts, receipt items) carry four guards. These are
  schema field descriptions, one worked example per prompt, a boundary validator and a confirm
  step where the user accepts before the Pantry changes.

---

## 4. Phase 1: clickable prototype

Delivers the screens for every story in the spec, on fake data, at desktop and narrow widths.
Throwaway code. Nothing in `external-modules/` imports it.

### Location and shape

- Folder: `docs/superpowers/specs/assets/2026-10-09-meals/`
- Files: `index.html`, `prototype.css`, `prototype.js`, `fake-data.js`, `README.md`
- Styles load from the real tree by relative path, as the Workshop prototype does:
  `apps/web/src/styles/tokens.css` and `packages/ui/src/styles/components-*.css`. No frozen copy.
- `prototype.css` holds only `mls-` classes for layout the design system lacks. Each one is listed
  in the README with why no `jds-*` primitive fits.
- Static navbar, hash routing per screen (`#plan`, `#list`, `#pantry`, `#household`, `#log`, and
  sub-routes for dialogs and states).
- A review bar, labelled as review tooling, switches states (empty, writing, failed, AI unavailable,
  narrow) and fires canned completion events.
- `.prettierignore` gains the folder, per the frozen-mockup format-check trap.

The builder uses the `design-system` skill before writing any markup.

### Task 1. Shell, fake data, review bar

- Navbar, five areas, header cog opening Meals settings (units, default Pantry mode, model shown
  per task).
- Fake data: a two-person household with breakfast, lunch and dinner patterns, a weekday Solo
  lunch rule, one restriction each, a stocked Pantry and last week's plan.

### Task 2. Household

Stories 1 to 13 and 18a. Set up for just yourself or a household. Member editor covering Meal
pattern with free names, restrictions, preferences, an optional calorie target and an account link
stub. Kitchen-level Shared or Solo rule per meal with weekday sets.

### Task 3. Plan

Stories 14 to 32, 38 to 46d, 23, 24 and 36.

- Ask for a plan with a start date and a day count that defaults to seven. Pantry mode choice.
- Days fill in one by one with the writing animation. Finished days are readable while later days
  write. Cancel.
- Day states are pending, writing, ready and "could not finish" with Retry.
- Meal card shows eaters, calorie fit per eater, lock, Favourite label, check-the-label note and
  "written by".
- Plain-text slots, editable later. Per-day cook-time limit. Per-day Shared or Solo override.
- Regenerate all unlocked, one day or one meal. Swap with two or three choices. Move a meal. Change
  eaters. Place a Favourite. Repeat request for patterns and meal prep.
- Mid-week re-plan of future days. Quick swap ("15-minute meal tonight") showing what to buy.
- AI unavailable banner, with list, Pantry and household still usable.

### Task 4. Recipe, cooking, rating

Stories 47 to 52 and 72 to 77. Recipe detail with original ingredient text beside parsed amounts,
servings stepper (scaled start, hand override), units. Mark cooked with Pantry subtraction preview,
Leftovers, log-portion offer, then per-eater Rating with skip.

### Task 5. Shopping list

Stories 53 to 67. Sections, merged lines with their source meals, separate lines for
unconvertible units, manual items, Staples, tick, Bought with edited amounts. Receipt text review
with confirm before the Pantry changes. Photo receipt shown disabled with "coming later".

### Task 6. Pantry

Stories 68 to 71. Items with optional amounts, Staples editor, add and edit by hand.

### Task 7. Log

Stories 79 and 80. Day view with totals and corrections.

### Task 8. Later phases

Phase 3 to 5 screens, each marked "later" in the review bar. They cover expiry and storage, the
low-staple rule, restock items, fridge photo, Pantry history and undo, the onion-to-grams list line
and substitutes. Then what Moss learned per member, budget, rebalance, recipe import, store-walk
order and the USDA gap flag. Then Kitchen invite, accept, decline, put-away and leave, live-change
marker, reminders and the weekly draft setting.

### Task 9. States and widths

Every screen in its empty, loading and failed state. Every screen at 1440 px and 390 px. No
crowding, per the spacing-and-fonts ruling.

### Phase 1 test

`tests/e2e/meals-prototype-clickthrough.spec.ts` opens `index.html` by `file://` path, as the
Workshop prototype allows, because the suite's web server roots at `apps/web` and cannot reach
`docs/` (`playwright.config.ts:19-24`). It visits
every route at both widths, asserts zero console errors and a non-empty main region, and saves a
screenshot per route when `MEALS_PROTOTYPE_SHOTS` is set. Screenshots are opt-in because full-page
captures of every route at both widths took minutes on a loaded box, and the test also runs inside
CI's ten-minute browser step. It would fail on a broken route, a missing fake-data reference or an
unstyled screen with no content.

### Phase 1 verification

Never pipe. Expected exit code beside each.

```bash
grep -rhoE "jds-[a-zA-Z0-9_-]+" docs/superpowers/specs/assets/2026-10-09-meals > /tmp/meals-used-raw.txt; echo "EXIT=$?"  # expect EXIT=0
sort -u -o /tmp/meals-used.txt /tmp/meals-used-raw.txt; echo "EXIT=$?"                                     # expect EXIT=0
grep -rhoE "\.jds-[a-zA-Z0-9_-]+" apps/web/src/styles packages/ui/src/styles > /tmp/meals-def-raw.txt; echo "EXIT=$?"  # expect EXIT=0
sed 's/^\.//' /tmp/meals-def-raw.txt > /tmp/meals-def-strip.txt; echo "EXIT=$?"                          # expect EXIT=0
sort -u -o /tmp/meals-def.txt /tmp/meals-def-strip.txt; echo "EXIT=$?"                                     # expect EXIT=0
comm -23 /tmp/meals-used.txt /tmp/meals-def.txt > /tmp/meals-candidates.txt; echo "EXIT=$?"                  # expect EXIT=0
grep -v -e '-$' -e '^jds-masthead$' /tmp/meals-candidates.txt > /tmp/meals-invented.txt; test ! -s /tmp/meals-invented.txt; echo "EXIT=$?"  # expect EXIT=0
pnpm exec prettier --check docs/superpowers/plans tests/e2e/meals-prototype-clickthrough.spec.ts > /tmp/meals-fmt.log 2>&1; echo "EXIT=$?"  # expect EXIT=0
pnpm exec eslint docs/superpowers/specs/assets/2026-10-09-meals tests/e2e/meals-prototype-clickthrough.spec.ts > /tmp/meals-lint.log 2>&1; echo "EXIT=$?"  # expect EXIT=0
pnpm exec playwright test tests/e2e/meals-prototype-clickthrough.spec.ts > /tmp/meals-e2e.log 2>&1; echo "EXIT=$?"  # expect EXIT=0
```

The invented-class lines are the `design-system` skill's audit, aimed at the prototype, because
`pnpm check:ui-classes` scans only `.tsx` under `apps/web/src`, `packages` and `external-modules`
(`scripts/check-ui-classes.ts:57`, `:133`). A non-empty `/tmp/meals-invented.txt` is a defect. The filter drops the skill's documented
exceptions: prefixes such as `jds-btn--` that the helpers complete at runtime, and the bare
`jds-masthead` hook the shared component also sets. The click-through test closes the runtime gap
by checking every class on each rendered page against the stylesheets.
Prettier cannot parse `.prettierignore` itself, so the format line checks the files it governs. The
prototype folder is ignored, which keeps hand-aligned markup intact. ESLint does lint the folder,
so the prototype scripts must pass it. Confirm the Playwright log shows a non-zero test count before
believing green.

### Phase 1 done means

- Ben has clicked through every screen on a running URL, at both widths.
- Every change he asks for is made, and any change of behaviour is written back into the spec.

---

## 5. Kill gate: after phase 1, before phase 2 tickets

**Owner: Ben.**

Ben judges these on the prototype:

1. **Is the weekly plan worth having?** If the Plan screen reads as more work than writing a list
   by hand, stop. The line ends here, and Food stays as it is.
2. **Is the wait acceptable?** Real days take minutes each. If watching days fill in feels broken
   rather than alive, Fork A is moot and the design needs a background-only flow first.
3. **Fork A and Fork B rulings.** Settled 2026-10-30 as A1 and B1 (section 2).
4. **Model job 2.** Keep the AI Safety pass or go deterministic only.
5. **Scope cut.** Which phase 2 items move later once the screens show their real weight.

Phase 2 is planned in detail only after these five are answered.

### Rulings, 2026-10-31

Ben asked for Meals to be built overnight and put the Meals build in charge of the remaining
calls. Ruling 1 is Ben's. Rulings 2 to 5 are the Meals build session's, made under that
delegation, and Ben can overrule any of them. He reviews the prototype (#3880) in the morning and
can still cut scope then, so every phase 2 slice must ship and be revertable on its own.

1. **Worth having: yes, build it.** Ben's ruling.
2. **The wait: accepted.** Under A1 each day is its own background job, so a plan started from
   chat or the page finishes with the tab closed. The page only shows each day as it lands. That is
   the background-only flow this question asked for, so the design does not change.
3. **Forks A and B:** A1 and B1, settled 2026-10-30 (section 2).
4. **Model job 2: kept.** The term check (`deterministicSafety` in the phase 2 plan, #3898) runs
   first, and the AI pass can only add a failure, never clear one. A term list misses allergens
   hidden in compound ingredients such as pesto or Worcestershire sauce. The cost is one extra
   model call per recipe.
5. **Scope cut: receipt text and opt-in Leftovers move to phase 3.** Both are additions with no
   current users. A plain-text "leftovers" slot stays in phase 2, because it is only slot text.
   The Log rebuild stays in phase 2, because phase 2 removes Food and Food's log goes with it.

---

## 6. Phase 2 and beyond, named only

Phase 2 depends on Fork B being settled and, under A1, on the enqueue blocker. Its rough work units
are as follows:

- Package skeleton, manifest and owned SQL (all tables from the spec's data model, with
  `owner_user_id` and `kitchen_id`). Remove `external-modules/food`.
- Household tools.
- Generation: day jobs, recipe job, Safety check, calorie fit, no-repeat. `timeoutMs: 600000` and
  `tierHint: "reasoning"`.
- Plan editing tools: lock, regenerate, swap, move, re-plan, quick swap.
- Shopping list aggregation and Bought.
- Pantry and Staples. Receipt text and opt-in Leftovers move to phase 3 (section 5, ruling 5).
- Cooking, Rating, Favourites and the log rebuild on the reused estimator.
- Page wiring, app map entries and the settings cog.
- Tests at the spec's three seams, and a live run on a dev instance.

Phases 3 to 5 follow the spec's phase list. Each gets its own plan after the phase before it ships.

---

## 7. Open questions

| #   | Question                                              | Owner         |
| --- | ----------------------------------------------------- | ------------- |
| Q4  | Does an in-flight AI call reset the 30 s stall timer? | Phase 2 build |

---

## 8. Rulings ledger

| #   | Ruling                                                                                      | Evidence                                                              |
| --- | ------------------------------------------------------------------------------------------- | --------------------------------------------------------------------- |
| R1  | Module page write tools still 403 with `confirmation_required`. #1699 closed without a fix  | `packages/ai/src/routes.ts:967-990`; #1699 comment 2026-09-15         |
| R2  | No module code path can enqueue a job                                                       | `packages/module-sdk/src/worker.ts:56-182`                            |
| R3  | Ten-minute ceiling requires a declared `timeoutMs`; default hard limit is 120 s             | `worker-runtime.ts:40-41`, `:113-115`                                 |
| R4  | Structured AI rejects unknown request keys, so a `task` field cannot be added from a module | `worker-rpc-host.ts:574-600`                                          |
| R5  | An instance AI pin beats any module binding                                                 | `packages/ai/src/repository.ts:1405-1410`                             |
| R6  | Unknown top-level manifest keys are dropped silently; nested ones are rejected              | `validate.ts:915-950`, `:452-454`                                     |
| R7  | A changed manifest hash stops an enabled module's queues                                    | `job-reconciler.ts:106-109`; `worker-module-gate.ts:20-35`            |
| R8  | Admin purge leaves pg-boss alone; the reconciler removes queues and schedules               | `repository-external-modules.ts:364-380`; `job-reconciler.ts:207-216` |
