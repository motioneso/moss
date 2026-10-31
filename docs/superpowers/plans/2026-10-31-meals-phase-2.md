# Build plan: Meals phase 2, core planning (#3317)

| Key            | Value                                                                                       |
| -------------- | ------------------------------------------------------------------------------------------- |
| Spec           | `docs/superpowers/specs/2026-10-09-meals-meal-planning-design.md` (Final, 2026-10-25)       |
| Agreed screens | Phase 1 prototype, PR #3880, `docs/superpowers/specs/assets/2026-10-09-meals/`              |
| Phase 1 plan   | `docs/superpowers/plans/2026-10-25-meals-build.md` (not edited here)                        |
| Rulings        | Kill gate rulings of 2026-10-31 (PR #3882) and the owner rulings in section 5               |
| Issue          | #3317, one `task` issue per slice (section 7)                                               |
| Platform deps  | Job enqueue #3722 (PR #3884); page writes #1699, slices #3723 and #3724                     |
| Bar to beat    | `~/moss-research/meals/2026-10-31-competitor-study.md` and `2026-10-30-competitor-notes.md` |

The research files live outside the repo on purpose. Slices cite them by file name and section.
This plan says only what Meals does.

## 0. Gates

- Spec approved: Final, 2026-10-25.
- Mockups agreed: the phase 1 prototype on PR #3880 is the design for every phase 2 screen.
- Kill gate after phase 1 passed on 2026-10-31. Build it. Ruling 2 accepts the day-by-day
  generation wait, and the wait for platform work is accepted.
- "Meals owner" in this plan means the Meals build session, deciding under Ben's delegation of
  2026-10-31. Ben can overrule any of its calls.
- Task issues: one per slice, each `Part of #3317`, on project 2.
- Hard platform dependencies, both accepted as waits:
  - S2 onward needs `ctx.jobs.enqueue` (#3722, PR #3884). This plan treats section 13.2.1 of
    `docs/module-developer-guide.md` on `feat/module-job-enqueue-slice-4` as landed.
  - S11 needs the page write route (#3723) and the host tools handle (#3724).

## 1. Seams check

Checked against `39646acfe` (origin/main) and the head of `feat/module-job-enqueue-slice-4`.

### 1.1 Present

| Capability                                                    | Evidence                                                                                                         | Plan use                                                |
| ------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------- |
| Structured AI call with tier hint                             | `packages/module-registry/src/external/worker-rpc-host.ts:575` (keys: schema, prompt, maxOutputTokens, tierHint) | Recipe, Safety and estimator calls                      |
| 500 AI calls per run                                          | `worker-rpc-host.ts:122`                                                                                         | Per-day job budget, section 3.1                         |
| Hard ceiling 120 s default, 600 s declared                    | `worker-runtime.ts:40-41`; `packages/module-sdk/src/external-module.ts:95`                                       | `timeoutMs: 600000` on generation queues                |
| 30 s stall timer, paused while a host call is in flight       | `worker-runtime.ts:185`, `:364-371` (pause), `:410-415` (re-arm)                                                 | Answers Q4 in code; S2 still probes it live             |
| Module job enqueue                                            | slice 4 branch `packages/module-sdk/src/worker.ts:57-78`; guide section 13.2.1 lines 536-593                     | Day chaining, swaps, log estimates                      |
| Queue declaration fields                                      | slice 4 branch `external-module.ts:121-134` (retryLimit, allowModuleEnqueue, timeoutMs, paramsSchema)            | Section 6.4                                             |
| Page reads through read tools                                 | `packages/ai/src/routes.ts:943-990`; Food client `external-modules/food/src/web/api.ts:43-70`                    | Every page read                                         |
| Read results trimmed to the declared output schema            | `packages/ai/src/routes.ts:959-989`                                                                              | Every read tool declares a full output schema           |
| 60 page reads per minute per session                          | `packages/ai/src/routes.ts:26`                                                                                   | Polling budget, section 6.7                             |
| Read result cap 2,000,000 characters                          | `packages/ai/src/gateway/output-validation.ts:11`                                                                | A 28-day plan fits                                      |
| Page props: host actions and refresh count                    | `apps/web/src/external-modules/loader.ts:10-20`                                                                  | Open chat with a starter line; reload after chat writes |
| Open chat with a starter line                                 | `external-modules/food/src/web/root.tsx:480-492`                                                                 | Entry points until page writes land                     |
| Module page imported into the host document                   | `apps/web/src/external-modules/loader.ts:77`                                                                     | Screen wake lock works (secure pages only)              |
| In-module router idiom                                        | `external-modules/finance/src/web/router.ts:1-40`                                                                | Routes under `/m/meals`                                 |
| Settings through the header cog                               | `settingsPath` in `external-modules/finance/jarvis.module.json:55`                                               | `/settings` route                                       |
| Module SQL: one statement, narrow allowlist incl. ALTER TABLE | `packages/db/src/migrations/module-sql-runner.ts:13-21`                                                          | Additive DDL per slice                                  |
| Owner-only RLS generated for owned tables                     | `packages/db/src/module-rls-emitter.ts`; ADR 0011                                                                | Every Meals table                                       |
| Limits: 4 nav entries, 16 queues, 32 owned tables             | `validate-declarations.ts:26`; `validate.ts:330`; `validate.ts:825`                                              | Meals uses 1, 3 and 20                                  |
| Unlisted modules keep source and installed copies             | `scripts/publish-module-registry.ts:34-36`                                                                       | Meals hidden until S12; Food unlisted in S12            |
| Install list built from the published index                   | `packages/settings/src/module-registry-rows.ts:48-65`                                                            | Section 2                                               |
| Admin enable, then per-user switch                            | `packages/settings/src/routes-modules.ts:210-260`, `:421-470`                                                    | Live proofs                                             |
| Browser test installs a locally built module                  | `tests/uat/specs/3526-typography-copy.uat.spec.ts:127-158`                                                       | Meals browser test                                      |
| Browser test brings up a real model and pins it               | `tests/uat/specs/real-chat-signin.ts:165-190`                                                                    | The pin also serves module AI calls (ledger L6)         |
| Food estimator to copy                                        | `external-modules/food/src/estimator/run.ts:73`, `schema.ts`                                                     | Calorie fit (S2), Log (S6)                              |
| Food tool declaration shape                                   | `external-modules/food/jarvis.module.json:168-205`                                                               | Section 6.3                                             |

### 1.2 Absent or pending

| Gap                                     | Evidence                                                                                               | Blocks              | Plan response                                          |
| --------------------------------------- | ------------------------------------------------------------------------------------------------------ | ------------------- | ------------------------------------------------------ |
| Module job enqueue not on main          | PR #3884 open                                                                                          | S2 onward           | Accepted wait                                          |
| Page writes: route and host handle      | #3723, #3724 open; only the confirmation store landed (#3733)                                          | Every page control  | Controls built behind one adapter, lit in S11 (Fork W) |
| A module AI call cannot name its task   | `worker-rpc-host.ts:575`; #3716 open                                                                   | Per-task model rows | Tier hint carries intent; spec correction C4           |
| Module tables in the user data download | `readExternalModuleExportRows` at `packages/settings/src/data-export.ts:229` has no caller; #1694 open | Export story        | Follow-up on #1694, not a slice (section 2.4)          |
| Kitchen shared across users             | ADR 0011; owner-only RLS                                                                               | Phase 5             | `kitchen_id` stored from day one                       |

### 1.3 Corrections to the spec

Each builder writes its correction back into the spec in the same PR.

| #   | Spec says                                           | Correction                                                                                        | Why                                                                                          | Slice   |
| --- | --------------------------------------------------- | ------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------- | ------- |
| C1  | One job per day, chained                            | Kept. Each meal is saved as it finishes, and a retried day picks up at the first unfinished meal  | A job killed at the ceiling loses one meal, not a day                                        | S2      |
| C2  | Pack sizes in a module-owned table                  | Pack sizes are a code table                                                                       | Owned tables are owner-only, so a shared reference table cannot be one                       | S4      |
| C3  | Self member reads the owner's nutrition preferences | Self targets live on the self member row                                                          | Those preferences belong to Food, which leaves in S13; modules cannot read each other's data | S1      |
| C4  | Each AI call names its task                         | Tier hint only until #3716                                                                        | The structured call rejects unknown keys                                                     | S2      |
| C5  | Export declaration covers every table               | Waits for #1694                                                                                   | No export path reads module tables yet                                                       | none    |
| C6  | Optional `linked_user_id`                           | Store the typed account email; resolve it in phase 5                                              | A module cannot look up other users                                                          | S1      |
| C7  | Leftovers and receipt text in phase 2               | Moved to phase 3                                                                                  | Ruling 2026-10-31                                                                            | S1      |
| C8  | No undo on Mark cooked or Bought                    | One-step Undo on both                                                                             | Owner ruling U2                                                                              | S4, S10 |
| C9  | Lines that leave the plan are removed               | A ticked line that leaves the plan stays, marked "No longer in the plan", until Bought or removed | It is probably already in the basket                                                         | S4      |
| C10 | Any number of days                                  | 1 to 28 days                                                                                      | Bounds the enqueue count under the hourly cap                                                | S2      |
| C11 | Re-plan skips meals whose slot time has passed      | Slot rules carry an optional usual time                                                           | The Meal pattern has no times                                                                | S9      |
| C12 | No screen wake lock                                 | The list keeps a phone screen awake                                                               | Owner ruling U4                                                                              | S4      |

## 2. Reaching users

### 2.1 How a module reaches users

1. Source lives in `external-modules/<id>`.
2. `scripts/publish-module-registry.ts` builds the published index from every module folder except
   `UNLISTED_MODULE_IDS` (`:36`). CI's registry check runs it with `--check` to catch drift.
3. Each install reads that index into its install list (`module-registry-rows.ts:48-65`).
4. An admin downloads, the boot reconcile accepts it, the admin enables it, and each person
   switches it on (`routes-modules.ts:210-260`, `:421-470`).

A repo folder alone never reaches anyone. Dev and browser tests install a locally built copy into
the modules folder (`3526-typography-copy.uat.spec.ts:127-158`).

### 2.2 Meals stays unreachable until usable

- S1 adds `meals` to `UNLISTED_MODULE_IDS` and to `tests/unit/publish-module-registry.test.ts`.
- S1 to S11 ship inside an unlisted module, so prod sees nothing. Every one of them is
  `Category: N/A`.
- S12 lists Meals, after page writes (Fork L).

### 2.3 Food keeps working

- Food stays listed and untouched until S12.
- S12 moves `food` into `UNLISTED_MODULE_IDS`. Installed copies keep running, as for Job Search.
  New installs stop seeing Food.
- S13 removes Food's source, after the Log rebuild (S6) and the listing (S12) are live. Installed
  copies still run from their modules folder.
- Old Food log data is not moved into Meals (spec).

### 2.4 Export

The platform's data download does not read module tables yet. The reader at
`packages/settings/src/data-export.ts:229` has no caller, and #1694 is open. Meals lists every
table in `database.ownedTables`, so the download can include them once #1694 lands. That work is a
follow-up on #1694, not a phase 2 slice.

## 3. Forks, ranked

### Fork G: what one generation job writes

| Option                                                                          | For                                                                                                                   | Against                                                                                       |
| ------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------- |
| **G1. One job per day, chained, saving each meal as it finishes (recommended)** | Matches the spec and the owner's Stop ruling. Seven enqueues for a week. A retry resumes at the first unfinished meal | A big day (6 meals, 2 solo eaters) runs long. Measured 3.5 min per day in phase 1 research    |
| G2. One job per meal, chained                                                   | Each job is short                                                                                                     | A 14-day plan with 6 slots is 84 enqueues against the hourly cap of 120. A queue hop per meal |

G1 wins because resume-on-retry removes its only real weakness. The S2 kill gate checks the long-day
case live.

Call budget per meal: one recipe call, one Safety call, one estimate call, and at most two
regenerations. Seven calls at worst, so 42 for a six-meal day, well under 500.

### Fork P: page-started background work before page writes

| Option                                                              | For                                          | Against                                                                                                                                    |
| ------------------------------------------------------------------- | -------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------ |
| **P2. Chat starts everything until page writes land (recommended)** | One write path. Nothing to delete later      | Testers start plans from chat until S11                                                                                                    |
| P1. Page starts jobs through the manual run route now               | Start, Stop and Retry work on the page early | A second path to remove. Body is params only, a 5 s duplicate guard per queue, 6 per minute (`apps/api/src/external-module-jobs.ts:23-97`) |

P2 wins because Meals stays unlisted until page writes land (Fork L). An early page path would
serve only testers.

### Fork W: page write controls

| Option                                                                                                              | For                                                        | Against                                                     |
| ------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------- | ----------------------------------------------------------- |
| **W1. Each area slice builds its controls behind one adapter; they render only with the host handle (recommended)** | S11 stays small. Each control is tested with its own slice | Controls are not seen on a real page until S11              |
| W2. Area slices are read-only; S11 builds every control                                                             | No code waits unused                                       | S11 becomes the biggest slice and the riskiest              |
| W3. Controls open chat with a drafted command                                                                       | Works today                                                | Routes deterministic actions through a model turn. Rejected |

W1 wins because the brief asks for a small final slice, and the draft contract
(`docs/superpowers/specs/2026-10-25-module-page-write-tools-design.md`) is stable enough to code
against. The host's `assistantSurface` prop is the precedent for an optional prop that fails
closed (`loader.ts:17-18`).

Until S11, each area page offers one "Ask Moss" action that opens chat with a starter line, the
same as Food's "Log a meal" (`food/src/web/root.tsx:480-492`). The person finishes the sentence
and sends it, so this is not W3.

### Fork T: where self targets live

| Option                                       | For                                                         | Against                                                    |
| -------------------------------------------- | ----------------------------------------------------------- | ---------------------------------------------------------- |
| **T1. On the self member row (recommended)** | One place for every eater's target. Survives Food's removal | The Log reads targets from the household                   |
| T2. Host preferences on the Meals manifest   | Matches Food today                                          | Two homes for targets: self in preferences, others on rows |

### Fork N: tool shape

| Option                                                                                                            | For                                                                      | Against                                   |
| ----------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------ | ----------------------------------------- |
| **N1. About 30 tools, one per intent; small edits of equal risk share a tool with an action field (recommended)** | Keeps the chat tool list short; long tool lists hurt tool choice (#2175) | Each shared tool checks per-action fields |
| N2. One tool per action, about 45                                                                                 | Simple schemas                                                           | Crowds the chat tool list                 |

Destructive actions always get their own tool, so the host's confirmation rule stays per tool.

### Fork L: when Meals is listed

| Option                                        | For                                            | Against                                                                                      |
| --------------------------------------------- | ---------------------------------------------- | -------------------------------------------------------------------------------------------- |
| **L1. After page writes (S11) (recommended)** | The page works as designed, which is ruling B1 | Waits on #3723 and #3724                                                                     |
| L2. After S6, with chat-only writes           | Reaches people sooner                          | This is option B2, rejected on 2026-10-30. Ticking a list through chat in a shop is unusable |

## 4. Determinism boundary

- Every piece of page feedback renders from records. That covers day progress, "Thursday did not
  finish", Safety results, calorie fit, Undo toasts and list changes.
- Meals never adds turns to the host chat. Chat replies come from tool results.
- Three model jobs, no more:
  1. Write one recipe to a schema.
  2. Judge Safety for each eater. This job can only add a failure, never clear one.
  3. Estimate nutrition, using the estimator copied from Food.
- Everything else is TypeScript over records. That covers the plan skeleton, target split, portions,
  calorie fit, the no-repeat rule, the brand rule, units, list building, Pantry subtraction, Undo
  and re-plan scope.
- Each prompt and the onboarding guidance stay under 150 words.

Guards on model-authored values:

| Guard                   | Recipe                                                                                                                             | Safety                                           | Estimate                            |
| ----------------------- | ---------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------ | ----------------------------------- |
| Schema descriptions     | Every field in `RECIPE_SCHEMA`                                                                                                     | Every field in `SAFETY_SCHEMA`                   | Food's `ESTIMATE_SCHEMA`            |
| Prompt with an example  | One worked recipe                                                                                                                  | One worked fail                                  | Food's prompt                       |
| Boundary validator      | `parseRecipe`; deterministic Safety; no-repeat; cook-time cap; "only on hand" check                                                | `parseSafety`; an unknown eater index is ignored | Food's `parseEstimateResult`        |
| Before/after acceptance | Never overwrites a locked, cooked or text meal; Regenerate shows how many meals it replaces; a swap applies only the choice picked | A failure shows its reason and offers a swap     | Correct and re-estimate, as in Food |

The brand flag follows the same rule. The model's per-ingredient flag is kept, and the
deterministic brand rule can add a flag but never clear one.

## 5. Rulings this plan carries

| #   | Ruling                                                                                                                                                                                           | Reason                                                | Where           |
| --- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ----------------------------------------------------- | --------------- |
| B1  | Page writes come from #1699 before the page is called done                                                                                                                                       | A shopping list ticked through chat is unusable       | Forks W, L; S11 |
| A1  | Generation chains through the platform enqueue call                                                                                                                                              | Chat-started plans finish with the tab closed         | S2              |
| K1  | The AI Safety pass stays                                                                                                                                                                         | Ruling 2026-10-31                                     | S2              |
| K2  | Receipt text and opt-in Leftovers move to phase 3                                                                                                                                                | Ruling 2026-10-31                                     | C7              |
| K3  | The Log rebuild stays in phase 2                                                                                                                                                                 | Ruling 2026-10-31                                     | S6              |
| U1  | Plan edits never reset the list. It is rebuilt from the plan, and ticks and manual lines carry over by line identity. A ticked line whose amount changed keeps its tick and shows the new amount | This was the main failure of a closed rival           | S4              |
| U2  | One-step Undo on Mark cooked and on Bought, reversing only that action. Full Pantry history stays in phase 3                                                                                     | A phone mis-tap otherwise means retyping Pantry items | S4, S10         |
| U3  | Generation has Stop and a retry for one failed day. Stop is a plan flag that the remaining day jobs check before they run                                                                        | No platform cancel is needed                          | S2              |
| U4  | The list keeps the screen awake while shopping. No offline support in phase 2                                                                                                                    | A sleeping phone in a shop                            | S4              |

U1 to U4 come from the Meals owner (section 0) on 2026-10-31.

## 6. Contracts

### 6.1 Package layout

Mirror `external-modules/food`.

```text
external-modules/meals/
  jarvis.module.json
  sql/NNNN_*.sql                 one statement per file
  src/contracts.ts               views shared by worker and page
  src/domain/*.ts                pure functions, no I/O
  src/ai/recipe.ts, safety.ts    schemas, prompt builders, parsers
  src/estimator/                 copied from Food in S2
  src/worker/index.ts, registry.ts, store.ts, handlers/*.ts
  src/web/index.ts, root.tsx, router.ts, api.ts, writes.ts, screens/*.tsx, styles.ts
```

Root wiring each slice adds:

- `package.json`: `build:external:meals`, and `meals` in `check:external-modules` (S1).
- `tsconfig.tests.json`: the Meals page test in the external JSX exclude list, as for Food (S1).
- `tests/unit/typography-external-audit.test.tsx:152`: `meals` in the module list (S1).

### 6.2 Manifest, S1 shape

Later slices add tools, queues, tables and app-map entries only.

```json
{
  "schemaVersion": 1,
  "id": "meals",
  "name": "Meals",
  "version": "0.1.0",
  "publisher": "Moss Project",
  "lifecycle": "optional",
  "compatibility": { "jarv1s": ">=0.1.0" },
  "description": "Plan the week's meals for your household, then shop and cook from the plan.",
  "storage": [{ "namespace": "meals.settings", "scopes": ["user"] }],
  "database": {
    "ownedTables": [
      "app.meals_kitchens",
      "app.meals_household_members",
      "app.meals_meal_slot_rules"
    ]
  },
  "runtime": { "workerEntrypoint": "dist/worker.js", "workerContractVersion": 1 },
  "web": { "entrypoint": "dist/web/index.js", "contractVersion": 2 },
  "navigation": [{ "id": "meals", "label": "Meals", "path": "/", "icon": "utensils" }],
  "settingsPath": "/settings",
  "assistantActionFamilies": [
    {
      "id": "meal_planning",
      "label": "Meal planning",
      "description": "Plan meals, manage the household, list, Pantry and cooking.",
      "defaultTier": "ask_each_time",
      "allowedTiers": ["ask_each_time", "trusted_auto", "always_confirm"]
    }
  ],
  "assistantTools": [],
  "appMap": { "screens": [], "features": [] }
}
```

- `assistantTools` holds the four S1 tools from 6.3, and `appMap` holds the S1 entries from section 7.
- S2 adds `worker.queues`.
- S6 adds the `meal_logging` family, copied from Food.

### 6.3 Tools

Write tools declare `executionPolicy: "auto"` and `selfOperationGrant: "granted_at_install"`.
Destructive tools declare `confirm_always`. Every read tool declares an `outputSchema` that covers
every field of its view, because the page sees only declared fields.

| Tool                     | Risk        | Slice | Input (beyond ids)                                                              | Returns             |
| ------------------------ | ----------- | ----- | ------------------------------------------------------------------------------- | ------------------- |
| `meals.kitchen.get`      | read        | S1    | none                                                                            | `KitchenView`       |
| `meals.kitchen.save`     | write       | S1    | units, default Pantry mode, slot rules                                          | `KitchenView`       |
| `meals.household.save`   | write       | S1    | member fields; no id means add                                                  | `MemberView`        |
| `meals.household.remove` | destructive | S1    | memberId                                                                        | `{ removed: true }` |
| `meals.plan.create`      | write       | S2    | startDate, days 1-28, pantryMode, request text, allowRepeats, idempotencyKey    | `PlanView`          |
| `meals.plan.get`         | read        | S2    | planId or date                                                                  | `PlanView`          |
| `meals.plan.control`     | write       | S2    | action `stop`, `resume`, `retry_day`; S7 adds `regenerate`; S9 adds `replan`    | `PlanView`          |
| `meals.plan.delete`      | destructive | S2    | planId                                                                          | `{ deleted: true }` |
| `meals.meal.get`         | read        | S2    | mealId                                                                          | `RecipeView`        |
| `meals.list.get`         | read        | S4    | none                                                                            | `ShoppingListView`  |
| `meals.list.build`       | write       | S4    | planId                                                                          | `ShoppingListView`  |
| `meals.list.edit`        | write       | S4    | action `add`, `update`, `remove`, `tick`, `untick`; line fields                 | `ListEditResult`    |
| `meals.list.bought`      | write       | S4    | lines with edited amounts; default every ticked line                            | `BoughtResult`      |
| `meals.list.clear`       | destructive | S4    | listId                                                                          | `{ cleared: true }` |
| `meals.undo`             | write       | S4    | actionId                                                                        | `UndoResult`        |
| `meals.pantry.get`       | read        | S5    | none                                                                            | `PantryView`        |
| `meals.pantry.edit`      | write       | S5    | action `add`, `update`, `remove`; target `item` or `staple`                     | `PantryEditResult`  |
| `meals.log.*` (6 tools)  | as Food     | S6    | `list`, `summarize`, `add` (Food's `log`), `correct`, `reestimate`, `delete`    | as Food             |
| `meals.meal.edit`        | write       | S7    | action `lock`, `unlock`; S8 adds `move`, `set_eaters`; S10 adds `set_servings`  | `PlannedMealView`   |
| `meals.meal.swap`        | write       | S7    | action `request_choices`, `choose`; S9 adds `quick`                             | `RecipeView`        |
| `meals.day.edit`         | write       | S8    | action `set_text`, `clear_text`, `add_one_off`, `set_cook_limit`, `set_sharing` | `PlanDayView`       |
| `meals.meal.cooked`      | write       | S10   | mealId                                                                          | `CookedResult`      |
| `meals.meal.rate`        | write       | S10   | ratings per member, 1-5 stars                                                   | `PlannedMealView`   |
| `meals.favourites.edit`  | write       | S10   | action `add`, `remove`, `place`                                                 | `KitchenView`       |

Twenty-nine tools in total, counting the six log tools. Every plan-changing write rebuilds a list tied
to that plan (U1).

### 6.4 Queues

| Queue                | Params (no strings)                                                                                      | Key                                      | Settings                                           | Slice |
| -------------------- | -------------------------------------------------------------------------------------------------------- | ---------------------------------------- | -------------------------------------------------- | ----- |
| `meals.plan-day`     | `planId` uuid, `dayId` uuid, `generation` integer 1-100000                                               | `plan-day:<dayId>:g<generation>`         | allowModuleEnqueue, timeoutMs 600000, retryLimit 1 | S2    |
| `meals.meal-job`     | `mealId` uuid, `generation` integer 1-100000, `mode` enum `swap_choices`, `quick_swap`, `safety_recheck` | `meal-job:<mealId>:<mode>:g<generation>` | allowModuleEnqueue, timeoutMs 600000, retryLimit 1 | S7    |
| `meals.log-estimate` | `entryId` uuid, `revision` integer 1-1000000                                                             | `log-estimate:<entryId>:r<revision>`     | allowModuleEnqueue, retryLimit 2                   | S6    |

S7 declares the whole `mode` enum up front and handles `swap_choices` and `safety_recheck`. Its
handler rejects `quick_swap` until S9 lands. S8 and S10 both start `safety_recheck`, so neither
needs the other.

Day job rules:

- It writes every pending, unlocked meal of its day in slot order, saving each one as it finishes.
- It exits quietly when its `generation` no longer matches the day row, because a newer job owns the day.
- Before each meal and before chaining, it checks the plan's Stop flag.
- It enqueues the next pending day only while the plan is `active`.
- `duplicate` from the next enqueue counts as success.
- `limited` sets the plan to `paused` with the limit name. `resume` bumps the day's generation and
  enqueues again.

### 6.5 Shared types (`src/contracts.ts`)

```ts
export type PantryMode = "ignore" | "prefer" | "only";
export type UnitsSystem = "us" | "metric";
export type Sharing = "shared" | "solo";
export type WriteStatus = "pending" | "writing" | "ready" | "failed";
export type StoreSection =
  | "produce"
  | "meat_fish"
  | "dairy_eggs"
  | "bakery"
  | "frozen"
  | "pantry"
  | "spices"
  | "drinks"
  | "household"
  | "other";
export type GenerationFailure =
  | "needs_config"
  | "provider_error"
  | "usage_limited"
  | "validation_failed"
  | "aborted"
  | "safety_cap"
  | "timeout"
  | "stopped";

export interface MacroTargets {
  readonly proteinG: number | null;
  readonly carbG: number | null;
  readonly fatG: number | null;
}
export interface MemberView {
  readonly memberId: string;
  readonly name: string;
  readonly isSelf: boolean;
  readonly linkedAccountEmail: string | null;
  readonly calorieTarget: number | null;
  readonly macroTargets: MacroTargets;
  readonly mealPattern: readonly string[];
  readonly restrictions: readonly string[];
  readonly preferences: readonly string[];
  readonly favouriteRecipeIds: readonly string[]; // always [] until S10 adds favourites
}
export interface SlotRuleView {
  readonly slotName: string;
  readonly soloWeekdays: readonly number[];
  readonly usualTime: string | null;
}
export interface KitchenView {
  readonly kitchenId: string;
  readonly unitsSystem: UnitsSystem;
  readonly defaultPantryMode: PantryMode;
  readonly members: readonly MemberView[];
  readonly slotRules: readonly SlotRuleView[];
}

export interface CalorieFit {
  readonly targetKcal: number;
  readonly estimatedKcal: number;
  readonly band: "under" | "on" | "over";
  readonly differenceKcal: number;
}
export interface EaterView {
  readonly memberId: string;
  readonly name: string;
  readonly portion: number;
  readonly safety: "pending" | "pass" | "fail";
  readonly safetyReason: string | null;
  readonly fit: CalorieFit | null;
}
export interface PlannedMealView {
  readonly mealId: string;
  readonly slotName: string;
  readonly kind: "recipe" | "text";
  readonly sharing: Sharing;
  readonly status: WriteStatus;
  readonly failureReason: GenerationFailure | null;
  readonly locked: boolean;
  readonly oneOffFor: string | null;
  readonly favouriteOf: string | null;
  readonly title: string | null;
  readonly plainText: string | null;
  readonly cookMinutes: number | null;
  readonly servings: number;
  readonly eaters: readonly EaterView[];
  readonly checkLabelCount: number;
  readonly cookedAt: string | null;
}
export interface PlanDayView {
  readonly dayId: string;
  readonly date: string;
  readonly status: WriteStatus;
  readonly failureReason: GenerationFailure | null;
  readonly cookTimeLimitMinutes: number | null;
  readonly meals: readonly PlannedMealView[];
  readonly dayFit: readonly { readonly memberId: string; readonly fit: CalorieFit }[];
}
export interface PlanView {
  readonly planId: string;
  readonly startDate: string;
  readonly dayCount: number;
  readonly pantryMode: PantryMode;
  readonly state: "active" | "stopped" | "paused";
  readonly pausedReason: "invocation" | "pending" | "hourly" | null;
  readonly progress: { readonly ready: number; readonly total: number };
  readonly days: readonly PlanDayView[];
}
export interface IngredientView {
  readonly originalText: string;
  readonly name: string;
  readonly quantity: number | null;
  readonly unit: string | null;
  readonly display: string | null;
  readonly section: StoreSection;
  readonly checkLabel: boolean;
  readonly missing: boolean;
}
export interface SwapChoiceView {
  readonly choiceId: string;
  readonly status: WriteStatus;
  readonly title: string | null;
  readonly cookMinutes: number | null;
  readonly eaters: readonly EaterView[];
}
export interface RecipeView {
  readonly meal: PlannedMealView;
  readonly recipeId: string | null;
  readonly baseServings: number | null;
  readonly servingsOverride: number | null;
  readonly steps: readonly string[];
  readonly ingredients: readonly IngredientView[];
  readonly swapChoices: readonly SwapChoiceView[];
}

export interface ListLineView {
  readonly lineId: string;
  readonly name: string;
  readonly quantity: number | null;
  readonly unit: string | null;
  readonly purchase: { readonly quantity: number; readonly unit: string } | null;
  readonly section: StoreSection;
  readonly manual: boolean;
  readonly coveredByPantry: boolean;
  readonly notInPlan: boolean;
  readonly convertedFrom: readonly string[];
  readonly sources: readonly { readonly mealId: string; readonly label: string }[];
  readonly checkedAt: string | null;
  readonly boughtAt: string | null;
}
export interface ShoppingListView {
  readonly listId: string;
  readonly planId: string | null;
  readonly pantryMode: PantryMode;
  readonly lines: readonly ListLineView[];
}
export interface PantryItemView {
  readonly itemId: string;
  readonly name: string;
  readonly quantity: number | null;
  readonly unit: string | null;
  readonly source: "manual" | "bought";
  readonly updatedAt: string;
}
export interface StapleView {
  readonly stapleId: string;
  readonly name: string;
}
export interface PantryView {
  readonly items: readonly PantryItemView[];
  readonly staples: readonly StapleView[];
}

export interface UndoToken {
  readonly actionId: string;
  readonly kind: "bought" | "cooked" | "removed";
  readonly count: number;
}
export interface ListEditResult {
  readonly list: ShoppingListView;
  readonly undo: UndoToken | null;
}
export interface BoughtResult {
  readonly list: ShoppingListView;
  readonly pantryAdded: number;
  readonly undo: UndoToken;
}
export interface PantryEditResult {
  readonly pantry: PantryView;
  readonly undo: UndoToken | null;
}
export interface UndoResult {
  readonly restored: number;
  readonly skipped: number;
}
export interface CookedResult {
  readonly meal: PlannedMealView;
  readonly pantryChanges: readonly {
    readonly name: string;
    readonly before: number | null;
    readonly after: number | null;
    readonly unit: string | null;
  }[];
  readonly undo: UndoToken;
  readonly logOffer: { readonly description: string; readonly servingNote: string } | null;
}
```

S6 copies Food's log view types under `Meals` names.

### 6.6 Domain signatures

```ts
// src/domain/skeleton.ts
export function planSkeleton(
  kitchen: KitchenView,
  input: { startDate: string; days: number }
): readonly SkeletonDay[];
// src/domain/targets.ts
export function mealShareKcal(member: MemberView, slotName: string): number | null; // even split over the pattern
export function portionFor(shareKcal: number | null, kcalPerServing: number | null): number; // halves, 0.5-2
export function calorieFit(targetKcal: number, estimatedKcal: number): CalorieFit; // "on" within 15%
// src/domain/safety.ts
export function deterministicSafety(
  ingredients: readonly IngredientDraft[],
  restrictions: readonly string[]
): SafetyVerdict;
export function mergeSafety(rule: SafetyVerdict, model: SafetyVerdict | null): SafetyVerdict; // model only adds failures
export function brandRule(originalText: string): boolean;
// src/domain/repeats.ts
export function titleKey(title: string): string;
export function isRepeat(key: string, recent: ReadonlySet<string>): boolean;
// src/domain/units.ts
export type UnitFamily = "mass" | "volume" | "count" | "other";
export function unitFamily(unit: string | null): UnitFamily;
export function convert(quantity: number, from: string, to: string): number | null;
export function kitchenDisplay(
  quantity: number | null,
  unit: string | null,
  system: UnitsSystem
): string | null;
// src/domain/list.ts
export function buildList(input: ListBuildInput): readonly GeneratedLine[];
export function reconcileList(
  stored: readonly StoredLine[],
  generated: readonly GeneratedLine[]
): ListDiff; // U1
export function purchaseAmount(line: GeneratedLine): { quantity: number; unit: string } | null;
// src/domain/pack-sizes.ts
export const PACK_SIZES: Readonly<Record<string, readonly { quantity: number; unit: string }[]>>;
// src/domain/pantry.ts
export function subtractCooked(
  pantry: readonly PantryItemView[],
  used: readonly ScaledIngredient[]
): readonly PantryChange[];
export function undoPlan(
  action: StoredUndoAction,
  current: readonly PantryRowSnapshot[]
): { restore: readonly PantryRowSnapshot[]; skipped: number };
// src/domain/replan.ts
export function replanScope(
  plan: PlanView,
  now: Date,
  timeZone: string,
  rules: readonly SlotRuleView[]
): readonly string[];
export function missingFor(
  ingredients: readonly IngredientDraft[],
  pantry: PantryView
): readonly string[];
```

A line's identity is its normalised name plus unit family. Manual lines use their own id.

### 6.7 Page contracts

```ts
// src/web/api.ts: reads only, through the read-tool route, as Food's invokeTool
export function readTool<V>(
  name: MealsReadToolName,
  input: Readonly<Record<string, unknown>>
): Promise<V>;

// src/web/writes.ts: the only file that knows the host's write handle
export type MealsWriteOutcome =
  | { readonly kind: "succeeded"; readonly result: unknown }
  | { readonly kind: "cancelled" }
  | { readonly kind: "rejected"; readonly moduleCode?: string }
  | { readonly kind: "invalid_input" }
  | { readonly kind: "failed" };
export interface MealsWrites {
  invoke(
    name: MealsWriteToolName,
    input: Readonly<Record<string, unknown>>
  ): Promise<MealsWriteOutcome>;
}
/** Null when the host passes no tools handle. Every write control then stays hidden. */
export function bindWrites(props: Readonly<Record<string, unknown>>): MealsWrites | null;
```

- The page polls `meals.plan.get` every 4 s while any day is pending or writing, and only while
  the page is visible. That is 15 reads a minute, under the 60 limit.
- A change to `refreshKey` reloads the open area.
- Routes match the prototype, under `/m/meals`.

### 6.8 DDL

Every file is one statement. Every table carries `owner_user_id uuid NOT NULL REFERENCES
app.users(id) ON DELETE CASCADE`, written as `owner` below. Every table except `meals_kitchens`
and the three log tables adds `kitchen_id uuid NOT NULL` with `FOREIGN KEY (owner_user_id,
kitchen_id) REFERENCES app.meals_kitchens (owner_user_id, kitchen_id) ON DELETE CASCADE`, written
as `kitchen` below. Child tables carry it too, so phase 5 can scope sharing by `kitchen_id` without
a backfill. `UNIQUE (owner_user_id)` allows one Kitchen per owner, so a child's `kitchen_id` always
equals its parent's in phase 2; phase 5 adds `kitchen_id` to the parent keys. Every table has
`created_at` and `updated_at timestamptz NOT NULL DEFAULT now()`, omitted below. Every change is
additive, so reverting a slice's code leaves unused tables, never broken ones.

S1:

```sql
CREATE TABLE app.meals_kitchens (owner, kitchen_id uuid NOT NULL,
  units_system text NOT NULL DEFAULT 'us' CHECK (units_system IN ('us','metric')),
  default_pantry_mode text NOT NULL DEFAULT 'prefer' CHECK (default_pantry_mode IN ('ignore','prefer','only')),
  PRIMARY KEY (owner_user_id, kitchen_id), UNIQUE (owner_user_id));

CREATE TABLE app.meals_household_members (owner, kitchen, member_id uuid NOT NULL,
  name text NOT NULL CHECK (char_length(name) BETWEEN 1 AND 80),
  is_self boolean NOT NULL DEFAULT false,
  linked_account_email text NULL CHECK (char_length(linked_account_email) BETWEEN 3 AND 320),
  calorie_target integer NULL CHECK (calorie_target BETWEEN 800 AND 6000),
  protein_target_g integer NULL CHECK (protein_target_g BETWEEN 0 AND 600),
  carb_target_g integer NULL CHECK (carb_target_g BETWEEN 0 AND 1000),
  fat_target_g integer NULL CHECK (fat_target_g BETWEEN 0 AND 400),
  meal_pattern jsonb NOT NULL DEFAULT '["breakfast","lunch","dinner"]'
    CHECK (jsonb_typeof(meal_pattern) = 'array' AND jsonb_array_length(meal_pattern) BETWEEN 1 AND 6),
  restrictions jsonb NOT NULL DEFAULT '[]' CHECK (jsonb_typeof(restrictions) = 'array' AND jsonb_array_length(restrictions) <= 40),
  preferences jsonb NOT NULL DEFAULT '[]' CHECK (jsonb_typeof(preferences) = 'array' AND jsonb_array_length(preferences) <= 40),
  sort_order integer NOT NULL DEFAULT 0,
  PRIMARY KEY (owner_user_id, member_id));

CREATE UNIQUE INDEX meals_household_members_one_self
  ON app.meals_household_members (owner_user_id, kitchen_id) WHERE is_self;

CREATE TABLE app.meals_meal_slot_rules (owner, kitchen,
  slot_name text NOT NULL CHECK (char_length(slot_name) BETWEEN 1 AND 40),
  solo_weekdays smallint[] NOT NULL DEFAULT '{}',
  usual_time time NULL,
  PRIMARY KEY (owner_user_id, kitchen_id, slot_name));
```

S2:

```sql
CREATE TABLE app.meals_plans (owner, kitchen, plan_id uuid NOT NULL,
  start_date date NOT NULL, day_count smallint NOT NULL CHECK (day_count BETWEEN 1 AND 28),
  pantry_mode text NOT NULL CHECK (pantry_mode IN ('ignore','prefer','only')),
  request_text text NULL CHECK (char_length(request_text) <= 1000),
  allow_repeats boolean NOT NULL DEFAULT false,
  state text NOT NULL DEFAULT 'active' CHECK (state IN ('active','stopped','paused')),
  paused_reason text NULL CHECK (paused_reason IN ('invocation','pending','hourly')),
  idempotency_key text NOT NULL CHECK (char_length(idempotency_key) BETWEEN 1 AND 128),
  PRIMARY KEY (owner_user_id, plan_id), UNIQUE (owner_user_id, idempotency_key));

CREATE TABLE app.meals_plan_days (owner, kitchen, plan_id uuid NOT NULL, day_id uuid NOT NULL,
  day_date date NOT NULL,
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','writing','ready','failed')),
  failure_reason text NULL CHECK (failure_reason IN ('needs_config','provider_error','usage_limited','validation_failed','aborted','safety_cap','timeout','stopped')),
  cook_time_limit_minutes smallint NULL CHECK (cook_time_limit_minutes BETWEEN 5 AND 240),
  sharing_overrides jsonb NOT NULL DEFAULT '{}' CHECK (jsonb_typeof(sharing_overrides) = 'object'),
  generation integer NOT NULL DEFAULT 1,
  PRIMARY KEY (owner_user_id, day_id), UNIQUE (owner_user_id, plan_id, day_date),
  FOREIGN KEY (owner_user_id, plan_id) REFERENCES app.meals_plans (owner_user_id, plan_id) ON DELETE CASCADE);

CREATE TABLE app.meals_recipes (owner, kitchen, recipe_id uuid NOT NULL,
  title text NOT NULL CHECK (char_length(title) BETWEEN 1 AND 120),
  title_key text NOT NULL CHECK (char_length(title_key) BETWEEN 1 AND 120),
  steps jsonb NOT NULL CHECK (jsonb_typeof(steps) = 'array' AND jsonb_array_length(steps) BETWEEN 1 AND 30),
  cook_minutes smallint NOT NULL CHECK (cook_minutes BETWEEN 1 AND 600),
  base_servings numeric(3,1) NOT NULL CHECK (base_servings BETWEEN 0.5 AND 24),
  kcal_per_serving integer NULL CHECK (kcal_per_serving BETWEEN 0 AND 5000),
  source text NOT NULL CHECK (source IN ('generated','favourite','imported')),
  PRIMARY KEY (owner_user_id, recipe_id));

CREATE INDEX meals_recipes_title_key ON app.meals_recipes (owner_user_id, title_key);

CREATE TABLE app.meals_recipe_ingredients (owner, kitchen, recipe_id uuid NOT NULL, position smallint NOT NULL,
  original_text text NOT NULL CHECK (char_length(original_text) BETWEEN 1 AND 200),
  name text NOT NULL CHECK (char_length(name) BETWEEN 1 AND 80),
  name_key text NOT NULL CHECK (char_length(name_key) BETWEEN 1 AND 80),
  quantity numeric(10,3) NULL CHECK (quantity > 0),
  unit text NULL CHECK (char_length(unit) BETWEEN 1 AND 24),
  store_section text NOT NULL CHECK (store_section IN ('produce','meat_fish','dairy_eggs','bakery','frozen','pantry','spices','drinks','household','other')),
  check_label boolean NOT NULL DEFAULT false,
  PRIMARY KEY (owner_user_id, recipe_id, position),
  FOREIGN KEY (owner_user_id, recipe_id) REFERENCES app.meals_recipes (owner_user_id, recipe_id) ON DELETE CASCADE);

CREATE TABLE app.meals_planned_meals (owner, kitchen, day_id uuid NOT NULL, meal_id uuid NOT NULL,
  slot_name text NOT NULL CHECK (char_length(slot_name) BETWEEN 1 AND 40),
  slot_position smallint NOT NULL,
  kind text NOT NULL CHECK (kind IN ('recipe','text')),
  sharing text NOT NULL CHECK (sharing IN ('shared','solo')),
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','writing','ready','failed')),
  failure_reason text NULL CHECK (failure_reason IN ('needs_config','provider_error','usage_limited','validation_failed','aborted','safety_cap','timeout','stopped')),
  locked boolean NOT NULL DEFAULT false,
  one_off_for uuid NULL, favourite_of uuid NULL,
  servings_override numeric(3,1) NULL CHECK (servings_override BETWEEN 0.5 AND 24 AND servings_override * 2 = floor(servings_override * 2)),
  recipe_id uuid NULL,
  plain_text text NULL CHECK (char_length(plain_text) BETWEEN 1 AND 200),
  cooked_at timestamptz NULL,
  attempts smallint NOT NULL DEFAULT 0,
  generation integer NOT NULL DEFAULT 1,
  PRIMARY KEY (owner_user_id, meal_id),
  FOREIGN KEY (owner_user_id, day_id) REFERENCES app.meals_plan_days (owner_user_id, day_id) ON DELETE CASCADE,
  FOREIGN KEY (owner_user_id, recipe_id) REFERENCES app.meals_recipes (owner_user_id, recipe_id),
  FOREIGN KEY (owner_user_id, one_off_for) REFERENCES app.meals_household_members (owner_user_id, member_id) ON DELETE SET NULL (one_off_for),
  FOREIGN KEY (owner_user_id, favourite_of) REFERENCES app.meals_household_members (owner_user_id, member_id) ON DELETE SET NULL (favourite_of),
  CHECK (kind = 'recipe' OR plain_text IS NOT NULL));

CREATE TABLE app.meals_planned_meal_eaters (owner, kitchen, meal_id uuid NOT NULL, member_id uuid NOT NULL,
  portion numeric(3,1) NOT NULL DEFAULT 1 CHECK (portion BETWEEN 0.5 AND 4),
  estimated_kcal integer NULL CHECK (estimated_kcal BETWEEN 0 AND 10000),
  safety text NOT NULL DEFAULT 'pending' CHECK (safety IN ('pending','pass','fail')),
  safety_reason text NULL CHECK (char_length(safety_reason) <= 200),
  PRIMARY KEY (owner_user_id, meal_id, member_id),
  FOREIGN KEY (owner_user_id, meal_id) REFERENCES app.meals_planned_meals (owner_user_id, meal_id) ON DELETE CASCADE,
  FOREIGN KEY (owner_user_id, member_id) REFERENCES app.meals_household_members (owner_user_id, member_id) ON DELETE CASCADE);
```

S4:

```sql
CREATE TABLE app.meals_shopping_lists (owner, kitchen, list_id uuid NOT NULL, plan_id uuid NULL,
  PRIMARY KEY (owner_user_id, list_id), UNIQUE (owner_user_id, kitchen_id));

CREATE TABLE app.meals_shopping_list_items (owner, kitchen, list_id uuid NOT NULL, line_id uuid NOT NULL,
  line_key text NULL CHECK (char_length(line_key) BETWEEN 1 AND 120),
  name text NOT NULL CHECK (char_length(name) BETWEEN 1 AND 80),
  quantity numeric(10,3) NULL CHECK (quantity > 0),
  unit text NULL CHECK (char_length(unit) BETWEEN 1 AND 24),
  purchase_quantity numeric(10,3) NULL, purchase_unit text NULL,
  store_section text NOT NULL CHECK (store_section IN ('produce','meat_fish','dairy_eggs','bakery','frozen','pantry','spices','drinks','household','other')),
  manual boolean NOT NULL DEFAULT false,
  covered_by_pantry boolean NOT NULL DEFAULT false,
  not_in_plan boolean NOT NULL DEFAULT false,
  converted_from jsonb NOT NULL DEFAULT '[]' CHECK (jsonb_typeof(converted_from) = 'array'),
  source_meal_ids uuid[] NOT NULL DEFAULT '{}',
  checked_at timestamptz NULL, bought_at timestamptz NULL,
  PRIMARY KEY (owner_user_id, line_id),
  FOREIGN KEY (owner_user_id, list_id) REFERENCES app.meals_shopping_lists (owner_user_id, list_id) ON DELETE CASCADE,
  CHECK (manual OR line_key IS NOT NULL));

CREATE UNIQUE INDEX meals_shopping_list_items_line_key
  ON app.meals_shopping_list_items (owner_user_id, list_id, line_key) WHERE line_key IS NOT NULL;

CREATE TABLE app.meals_pantry_items (owner, kitchen, item_id uuid NOT NULL,
  name text NOT NULL CHECK (char_length(name) BETWEEN 1 AND 80),
  name_key text NOT NULL CHECK (char_length(name_key) BETWEEN 1 AND 80),
  quantity numeric(10,3) NULL CHECK (quantity >= 0),
  unit text NULL CHECK (char_length(unit) BETWEEN 1 AND 24),
  source text NOT NULL CHECK (source IN ('manual','bought','leftover','receipt')),
  PRIMARY KEY (owner_user_id, item_id));

CREATE INDEX meals_pantry_items_name_key ON app.meals_pantry_items (owner_user_id, kitchen_id, name_key);

CREATE TABLE app.meals_undo_actions (owner, kitchen, action_id uuid NOT NULL,
  kind text NOT NULL CHECK (kind IN ('bought','cooked','removed')),
  before_state jsonb NOT NULL CHECK (jsonb_typeof(before_state) = 'object'),
  undone_at timestamptz NULL,
  PRIMARY KEY (owner_user_id, action_id));
```

S5:

```sql
CREATE TABLE app.meals_staples (owner, kitchen, staple_id uuid NOT NULL,
  name text NOT NULL CHECK (char_length(name) BETWEEN 1 AND 80),
  name_key text NOT NULL CHECK (char_length(name_key) BETWEEN 1 AND 80),
  PRIMARY KEY (owner_user_id, staple_id), UNIQUE (owner_user_id, kitchen_id, name_key));
```

S6 copies Food's four SQL files (`external-modules/food/sql/`). The three log tables become
`app.meals_log_entries`, `app.meals_log_estimates` and `app.meals_log_estimate_items`, with the same
columns and checks, and Food's owner and local-date index moves to `app.meals_log_entries`. The
tables carry `owner_user_id` only, because the log is personal and never moves into a Kitchen.

S7:

```sql
CREATE TABLE app.meals_swap_choices (owner, kitchen, meal_id uuid NOT NULL, choice_id uuid NOT NULL,
  position smallint NOT NULL CHECK (position BETWEEN 1 AND 3),
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','writing','ready','failed')),
  recipe_id uuid NULL, generation integer NOT NULL DEFAULT 1,
  PRIMARY KEY (owner_user_id, choice_id),
  FOREIGN KEY (owner_user_id, meal_id) REFERENCES app.meals_planned_meals (owner_user_id, meal_id) ON DELETE CASCADE,
  FOREIGN KEY (owner_user_id, recipe_id) REFERENCES app.meals_recipes (owner_user_id, recipe_id));
```

S9:

```sql
ALTER TABLE app.meals_planned_meals ADD COLUMN quick_max_minutes smallint NULL CHECK (quick_max_minutes BETWEEN 5 AND 240);
```

S10:

```sql
CREATE TABLE app.meals_ratings (owner, kitchen, member_id uuid NOT NULL, recipe_id uuid NOT NULL,
  stars smallint NOT NULL CHECK (stars BETWEEN 1 AND 5), rated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (owner_user_id, member_id, recipe_id),
  FOREIGN KEY (owner_user_id, member_id) REFERENCES app.meals_household_members (owner_user_id, member_id) ON DELETE CASCADE,
  FOREIGN KEY (owner_user_id, recipe_id) REFERENCES app.meals_recipes (owner_user_id, recipe_id) ON DELETE CASCADE);

CREATE TABLE app.meals_favourites (owner, kitchen, member_id uuid NOT NULL, recipe_id uuid NOT NULL,
  PRIMARY KEY (owner_user_id, member_id, recipe_id),
  FOREIGN KEY (owner_user_id, member_id) REFERENCES app.meals_household_members (owner_user_id, member_id) ON DELETE CASCADE,
  FOREIGN KEY (owner_user_id, recipe_id) REFERENCES app.meals_recipes (owner_user_id, recipe_id) ON DELETE CASCADE);
```

That makes 20 owned tables. Each slice adds its tables to `database.ownedTables`.

## 7. Slices

Order rules:

- Every slice ships and reverts alone.
- Any prefix leaves Meals working, and prod untouched, because Meals is unlisted until S12.
- The parts least likely to be cut come first. S1 to S4 are the smallest useful Meals (household,
  generate, read on the page, shopping list). Ben's review after S6 may cut any of S7 to S10.
  S8, S9 and S10 each extend S7's tools, so cutting S7 cuts all four. S8, S9 and S10 need
  nothing from each other, so any one of them can go alone.
  S11 then lights only the controls of slices that landed.

| #   | Slice                               | Issue | Needs                       | UI  |
| --- | ----------------------------------- | ----- | --------------------------- | --- |
| S1  | Package, household, page shell      | #3885 | none                        | yes |
| S2  | Plan writing engine, through chat   | #3886 | S1, #3722                   | no  |
| S3  | Plan page and recipe view           | #3887 | S2                          | yes |
| S4  | Shopping list and Bought            | #3888 | S2                          | yes |
| S5  | Pantry, Staples, Pantry-aware plans | #3889 | S4                          | yes |
| S6  | Log rebuild                         | #3890 | S1, S2                      | yes |
| S7  | Lock, regenerate, swap choices      | #3891 | S3, S4                      | yes |
| S8  | Arrange the week                    | #3892 | S4, S7                      | yes |
| S9  | Mid-week re-plan and quick swap     | #3893 | S5, S7                      | yes |
| S10 | Cooking, ratings, favourites        | #3894 | S5, S6, S7                  | yes |
| S11 | Page write controls                 | #3895 | #3723, #3724, landed slices | yes |
| S12 | List Meals, unlist Food             | #3896 | S11, S6                     | no  |
| S13 | Remove Food from the repo           | #3897 | S12                         | no  |

### 7.0 Shared rules for every slice

Tests:

- Main seam: module tool handlers with a fake store and a scripted fake AI, as in
  `tests/unit/external-module-food-handlers.test.ts`. Tests assert on returned records and rendered
  state, never on prompts or model prose.
- Database seam, every slice that adds a table: two actors, neither can read, write or delete the
  other's rows in the new tables, and a clean install reaches the new schema. Pattern:
  `tests/integration/finance-tables-install.test.ts`.
- Manifest test: every handler exists, and every read tool's output schema covers every field of
  its view. The second check fails if a field is added to a view and not to the schema, which would
  blank it on the page.
- Page tests render the real `Root`. Controls are tested with a fake tools handle, and a second
  test asserts no write control renders without one.

Live proof, every slice:

- Install the built module on a dev instance: build it, copy it into the instance's modules folder,
  run the reconcile, enable it under Settings, Admin / Setup, Instance modules, and switch it on.
- Generation slices use the real-model test copy (moss-proof).
- Record what was done and seen on the PR. Without that the slice is code-complete, unverified.

Definition of done, every UI slice (Ben, 2026-10-31):

- View the screen at desktop (1280) and phone (390 and 320) width, in light and dark theme, with
  real data, in every state: empty, loading, error and long text.
- Long text means an 80-character member name, a 120-character recipe title, a 200-character
  ingredient line, and a list section of 30 lines.
- Fix anything crowded, flat or unfinished before review.
- The PR shows the screenshots.
- Built from `@moss/ui` through `@moss/module-web-sdk`. Module CSS is layout only, with the `mls-`
  prefix. `pnpm check:ui-classes` passes.
- Gaps of at least 8px between controls and 12px between a control and its text. No text under
  11px. Text contrast at least 4.5:1 on every surface.
- Settings only through the header cog. No explanatory or reassuring lines on screens.
- The live proof includes this visual pass on the dev instance.
- Each UI slice names the study section it must beat. The slice's "Meals does" list is the bar.

App map, every slice: module-owned entries in the manifest's `appMap`, in the same PR.

Release note, S1 to S11: `Category: N/A`, because Meals is unlisted.

### S1. Package, household, page shell

- Goal: an installable Meals with a Kitchen, household members and slot rules, managed through
  chat. The page shell has the area tabs and read views of Household and Settings.
- Files:
  - `external-modules/meals/` scaffold (6.1, 6.2)
  - `sql/0001` to `0004` (6.8 S1)
  - handlers for the four S1 tools
  - `src/domain/skeleton.ts` types only
  - `src/web/root.tsx`, `router.ts`, `api.ts`, `writes.ts`, `screens/household.tsx`, `screens/settings.tsx`
  - root wiring (6.1); `scripts/publish-module-registry.ts:36` adds `meals`; its test
  - spec write-back C3, C6, C7
- Decisions:
  - The Kitchen and a self member named "You" are created on first use. Planning for yourself needs no setup.
  - Restrictions are strict ("Never serve"). Preferences are soft.
  - Area tabs are Plan, List, Pantry, Household and Log. Areas without data yet show their empty state.
- Tests that fail first:
  - `meals.kitchen.get` on a new account returns one Kitchen and one self member. It fails if the
    Kitchen is not created lazily, or a second call creates a second self member.
  - Add, edit and remove members; the pattern defaults to breakfast, lunch, dinner; the self member
    cannot be removed. It fails if remove deletes the self row.
  - Self targets come from the self member row. It fails if the handler reads any preference store.
  - A slot rule with Monday to Friday solo returns those weekdays. It fails if the rule is stored per weekday row.
  - The publish test lists `meals` as unlisted. It fails if Meals reaches the published index.
  - Page: with no tools handle, Household shows members and no edit controls.
  - Database seam for the three tables.
- App map:
  - `meals.household`: "Who eats, each person's meals of the day, Never serve list, preferences and
    optional calorie target."
  - `meals.settings`: "Units (US or metric) and the default Pantry mode."
  - Feature `meals.chat-household`: "Add or change household members through Moss."
- Live proof: in chat, "add Sam, vegetarian, no peanuts, 1800 calories". Household shows Sam after
  the refresh. Do the visual pass on Household and Settings.
- Bar to beat: study section 6 and section 8. Meals does:
  - A household of one with no setup.
  - Targets on the person.
  - "Never serve" kept distinct from preferences.
  - Setup that asks only who eats and what they never eat.

### S2. Plan writing engine, through chat

- Goal: "plan next week" in chat writes a plan day by day, with Safety, the brand note, calorie fit
  and no repeats. Stop, Resume and Retry day work. AI errors fail only the day.
- Needs: #3722 merged.
- Files:
  - `sql/0005` onward (6.8 S2)
  - `src/ai/recipe.ts`, `src/ai/safety.ts`
  - `src/estimator/` copied from Food (copied, not imported, for module isolation)
  - `src/domain/` skeleton, targets, safety, repeats
  - handlers for `meals.plan.*` and `meals.meal.get`
  - the `meals.plan-day` queue and handler
  - one platform test in `tests/unit/external-worker-runtime.test.ts`
  - spec write-back C1, C4, C10
- Decisions:
  - Recipe and Safety calls pass `tierHint: "reasoning"`. The copied estimator passes
    `"economy"`, where Food passes `"interactive"`, because spec story 83c puts nutrition
    estimates on the economy tier. S6 reuses it unchanged. The queue declares `timeoutMs: 600000`.
  - Safety order: the deterministic check first; a failure regenerates without the model call.
    Then the model judgement. Two regenerations at most, then the meal fails with `safety_cap`.
  - A no-repeat hit regenerates and counts against the same cap.
  - Calorie fit: each eater's target is split evenly over their pattern, and the portion rounds to
    halves between 0.5 and 2. "On" means within 15%.
  - The request text is stored on the plan row and read inside the job. Job params carry ids and
    counts only.
  - An AI error marks the meal and the day failed with its kind. Every tool that makes no AI call
    keeps working.
- Tests that fail first:
  - A 3-day plan chains in date order. The fake enqueue records three keys in order. It fails if
    days run in parallel or a day is skipped.
  - Each meal is saved as it finishes. A fake AI that throws on meal 3 leaves meals 1 and 2 ready.
    A retry writes only meal 3. It fails if a retry rewrites ready meals.
  - A job with a stale `generation` writes nothing. It fails without the generation check.
  - Stop: with the flag set before meal 2, the job writes nothing more and enqueues no next day. It
    fails if the flag is checked only between days.
  - `limited` pauses the plan with its reason, and `resume` enqueues with a new key. It fails if
    resume reuses the key, which the platform would reject as a duplicate for up to 14 days.
  - Safety: a peanut ingredient fails a no-peanut eater without a model call. A model fail on a
    rule pass marks the eater failed. A model pass on a rule fail stays failed. The cap is reached
    at three attempts.
  - The brand rule adds `check_label`, and the model flag is never cleared.
  - Each of the five AI error kinds fails the day, and `meals.kitchen.get` still works.
  - Timeout is not stalling. The platform test holds a fake host call for longer than the stall
    window and expects the run to finish. It must fail when the pause at `worker-runtime.ts:364-371`
    is removed.
  - Database seam for the six tables.
- App map:
  - Feature `meals.chat-plan`: "Ask Moss to plan any number of days up to 28. Days are written one by
    one. Stop, resume, or retry one day."
  - Feature `meals.safety`: "Every meal is checked against each eater's Never serve list. Packaged
    or branded ingredients carry a check-the-label note."
- Live proof, which is the Q4 probe (kill gate G-S2):
  - On the real-model test copy, ask "plan 7 days for me and Sam".
  - Log timing per meal and per day from job records.
  - Then "stop", "resume" and "retry Thursday".
  - Record the day times, any job that hit the ceiling, and whether resume finished it.

### S3. Plan page and recipe view

- Goal: the Plan area shows the week as it is written, day by day, and the recipe view shows the
  full recipe.
- Files:
  - `screens/plan.tsx`, `screens/plan-writing.tsx`, `screens/recipe.tsx`, `screens/day.tsx`
  - `src/domain/units.ts` (display only)
  - the polling hook, modelled on Food's
  - start of the Meals browser test, `tests/uat/specs/3317-meals-phase-2.uat.spec.ts`
- Routes: `plan`, `plan/writing`, `plan/failed`, `plan/day/:date`, `recipe/:mealId`. The Start,
  Stop and Retry controls are built behind the adapter (Fork W).
- Tests that fail first:
  - Days still writing show a placeholder with the day name. It fails if the list jumps when a day
    arrives.
  - A failed day shows its reason and keeps the other days.
  - Each meal shows its Safety result per eater before its title. It fails if a meal renders before
    its Safety result is known.
  - The recipe view shows the original ingredient line beside the kitchen amount.
  - Polling stops when the page is hidden and when every day is ready or failed.
  - Browser test, first part:
    - install and enable Meals
    - real model through `bringUpRealChatModel`
    - "plan 2 days" in chat
    - days appear on the Plan page
    - open a recipe
    - at desktop and narrow widths
- App map: screens `meals.plan` (path `/`), `meals.recipe` (`/recipe/:mealId`), `meals.day` (`/plan/day/:date`).
- Live proof: watch a 7-day plan fill in on the page, leave mid-run, return, and the page shows
  where it was. Do the visual pass.
- Bar to beat: study sections 1, 2 and 3. Meals does:
  - Each day as a row of eaters, Solo and Shared visible.
  - Days that fill in one by one with Safety already attached.
  - A plain failure line per day.
  - The original ingredient text one tap away.
  - Kitchen amounts rounded to sensible measures.
- Kill gate G-S3 (section 8).

### S4. Shopping list and Bought

- Goal: a list built from the plan, with sections, purchase amounts, manual lines, ticks, Bought
  into the Pantry, and one-step Undo.
- Files:
  - `sql` (6.8 S4)
  - `src/domain/list.ts`, `pack-sizes.ts`, `units.ts` conversion, `pantry.ts` undo
  - `meals.list.*` and `meals.undo` handlers
  - `screens/list.tsx`, `list-add.tsx`, `list-edit.tsx`, `list-bought.tsx`
  - spec write-back C2, C8, C9, C12
- Decisions:
  - Lines merge by normalised name and unit family. Volume and mass convert within their family
    and record what they converted from. Count and other units never merge across.
  - A servings override feeds the amounts.
  - With the Pantry mode set to prefer, lines the Pantry covers go to a quiet "You have this" group
    instead of disappearing.
  - The list keeps a phone screen awake while the List area is visible, through the browser's
    screen wake lock. It does nothing where the browser does not offer it, which includes plain
    http pages.
- Tests that fail first:
  - U1, rebuild after a plan change:
    - ticked lines stay ticked
    - manual lines stay
    - a ticked line whose amount changed keeps its tick and shows the new amount
    - a ticked line that left the plan stays, marked not in plan
    - an unticked line that left the plan goes
    - It fails if the rebuild deletes and recreates lines.
  - 1 cup plus 200 ml merge into one line that shows the conversion. 2 cloves plus 10 g stay apart.
  - Purchase amounts round up to the pack table, else the raw amount.
  - Each line lists its source meals.
  - Bought writes Pantry rows with the edited amounts and stamps `bought_at`.
  - Undo after Bought removes those rows and clears `bought_at`. A row edited after Bought is
    skipped and counted. It fails if Undo overwrites the later edit.
  - Remove line returns an Undo token, and Undo restores the line.
  - `meals.list.clear` is destructive and asks.
  - Page: the wake lock is requested on a touch device while List is visible, and released on hide.
  - Database seam for the four tables.
- App map:
  - Screen `meals.list` (`/list`): "The shopping list by store section, with amounts to buy, where
    each line came from, a You have this group, and Bought."
  - Feature `meals.chat-list`: "Add to the list, I bought everything, and undo through Moss."
- Live proof:
  - Build the list from the S3 plan.
  - "Add milk" in chat.
  - Tick three lines, rebuild the list through chat, and confirm the ticks survive.
  - "I bought everything", then "undo that".
  - On a phone, on the dev instance's https address, the screen stays awake on List.
  - Do the visual pass.
- Bar to beat: study section 4. Meals does:
  - Plan edits that change only the lines that changed.
  - Ticks that never lose a line.
  - Why each line is there.
  - A "You have this" group.
  - Conversions shown.
  - Quick add in thumb reach on a phone.
  - Bought with one-step Undo.
  - Screen kept awake.
- Kill gate G-S4.

### S5. Pantry, Staples, Pantry-aware plans

- Goal: the Pantry and Staples are visible and editable, and plans follow the Pantry mode.
- Files: `sql` (6.8 S5); `meals.pantry.*` handlers; `screens/pantry.tsx`, `pantry-add.tsx`,
  `pantry-edit.tsx`, `pantry-staples.tsx`; recipe prompt input gains Pantry and Staples.
- Decisions:
  - Staples count as on hand and never reach the list.
  - Quantities are optional ("have some").
  - With "cook only from on hand", a recipe that needs anything beyond Pantry and Staples is
    regenerated, and counts against the cap.
- Tests that fail first:
  - Each mode's list result:
    - ignore lists everything
    - prefer subtracts and groups what is covered
    - only lists nothing beyond Staples
  - The "only on hand" check regenerates an off-Pantry recipe. It fails if the mode is passed to
    the prompt and never checked.
  - Remove item returns an Undo token.
  - Staples never appear as list lines.
  - Database seam for the staples table.
- App map: screens `meals.pantry` (`/pantry`) and `meals.staples` (`/pantry/staples`); feature
  `meals.pantry-modes`.
- Live proof: add Pantry items in chat, plan 2 days with "use what I have", and the list shows
  them under "You have this". Do the visual pass.
- Bar to beat: study section 5. Meals does:
  - The mode shown at the top of the list.
  - Staples kept apart from stock.
  - Quantities optional.

### S6. Log rebuild

- Goal: the Log area replaces Food's log, with the copied estimator and targets from the self
  member.
- Files:
  - `sql` (6.8 S6)
  - `meals.log.*` handlers, adapted from Food's
  - the `meals.log-estimate` queue
  - `screens/log.tsx`, `log-edit.tsx`
  - Food's domain, handler and store tests ported to Meals names
- Decisions:
  - `meals.log.add` enqueues the estimate job through `ctx.jobs.enqueue`.
  - Day totals show against the self member's targets, with a calm over or under, never red.
  - Old Food log data is not moved.
- Tests that fail first:
  - The ported Food tests, renamed, red until the handlers exist.
  - Totals read the self member's targets. It fails if any preference store is read.
  - Correct with a stale revision is rejected.
  - Delete asks.
  - Database seam for the three log tables, owner only.
- App map: screen `meals.log` (`/log`); feature `meals.chat-log` ("Log what you ate through Moss.
  Moss estimates calories and macros.").
- Live proof: log two meals in chat, correct one, and check totals against the target. Do the
  visual pass.
- Bar to beat: study section 7. Meals does:
  - "Ate something else" as one free entry.
  - Calm totals against a target range.
  - No barcode library.
- Review gate after S6: Ben reviews S1 to S6 on dev and may cut any of S7 to S10. Cutting S7
  cuts S8, S9 and S10, because each extends S7's tools.

### S7. Lock, regenerate, swap choices

- Goal: lock meals, regenerate all, a day or a meal, and pick from two or three swap choices.
- Files: `sql` (6.8 S7); `meals.meal.edit` (lock), `meals.plan.control` regenerate,
  `meals.meal.swap`; the `meals.meal-job` queue with the `swap_choices` and `safety_recheck`
  modes; routes `plan/swap/:mealId`, `plan/new`.
- Tests that fail first:
  - Regenerate never rewrites locked, cooked or text meals, and reports how many it will replace.
  - Each swap choice passes Safety before it is shown.
  - `safety_recheck` re-runs Safety on a meal's recipe for its current eaters, and a failure marks
    the meal with its reason.
  - Choose replaces the meal and rebuilds the list (U1).
  - Repeat requests with a new generation get a new key.
- App map: features `meals.lock-regenerate` and `meals.swap`; screen `meals.swap` (`/plan/swap/:mealId`).
- Live proof: lock two meals, regenerate the week, both survive; request swaps and choose one.
  Tick list lines, regenerate one day, and confirm the ticks survive and only changed lines show
  a new amount. Do the visual pass.
- Bar to beat: study section 1. Meals does:
  - Lock per meal with a count before regenerate.
  - Recently had dishes avoided by default.

### S8. Arrange the week

- Goal: move meals, change eaters, plain-text slots, One-off meals, a cook-time limit per night,
  and a per-day Shared or Solo override.
- Files: `meals.meal.edit` (move, set_eaters); `meals.day.edit`; routes `plan/move/:mealId`,
  `plan/eaters/:mealId`, `plan/text/:mealId`.
- Tests that fail first:
  - Move rebuilds the list and keeps ticks.
  - Changing eaters re-runs Safety for the new eaters, through S7's `safety_recheck` mode. It
    fails if Safety runs only at generation.
  - A text slot never reaches the list.
  - The cook-time limit regenerates a longer recipe.
  - A Solo override writes one meal per eater for that day only.
- App map: feature `meals.arrange`; screens for move, eaters and text.
- Live proof: move a dinner, make a lunch "eating out", set a 20-minute limit on Wednesday, and
  regenerate Wednesday. Do the visual pass.
- Bar to beat: study sections 1 and 6. Meals does:
  - Move to... on a phone.
  - Servings that follow the eaters.

### S9. Mid-week re-plan and quick swap

- Goal: re-plan the rest of the week from the Pantry as it is now, and a quick swap such as
  "15-minute meal tonight".
- Files: `sql` (6.8 S9); `meals.plan.control` replan; `meals.meal.swap` quick; `src/domain/replan.ts`;
  routes `plan/replan`, `plan/quick`; spec write-back C11.
- Decisions: the quick swap passes `tierHint: "interactive"`, per spec story 83c.
- Tests that fail first:
  - Re-plan touches only future, unlocked, uncooked meals, and today's meals whose usual time has
    not passed.
  - Re-plan forces "prefer on hand".
  - A quick swap honours the time cap and lists what is still to buy.
- App map: features `meals.replan` and `meals.quick-swap`.
- Live proof: on a mid-week day, "re-plan the rest of the week" and "15-minute dinner tonight".
  Do the visual pass.
- Bar to beat: study section 2. Meals does:
  - Keep the days already written.
  - Show what a quick swap still needs.

### S10. Cooking, ratings, favourites

- Goal: change servings, Mark cooked with Pantry subtraction and Undo, offer to log a portion,
  rate with a near-veto, favourites per person, and repeats on request.
- Files: `sql` (6.8 S10); `meals.meal.cooked`, `meals.meal.rate`, `meals.favourites.edit`,
  `meals.meal.edit` set_servings; routes `recipe/:mealId/cooked`, `recipe/:mealId/rate`,
  `plan/favourite/:date/:slot`; spec write-back C8.
- Decisions:
  - Servings step in halves, and the list follows them.
  - Mark cooked never takes a Pantry item below zero.
  - The log offer is returned in the result and logs through `meals.log.add`, so the estimate job
    runs as for any meal.
  - A 1-star rating keeps that recipe out of plans that include that member, unless asked.
- Tests that fail first:
  - Pantry subtraction scaled to the eaters.
  - Undo restores the Pantry, skipping rows edited since.
  - The log offer logs one portion.
  - The near-veto excludes the recipe, and an explicit request overrides it.
  - A favourite placed in a slot passes Safety first, through S7's `safety_recheck` mode.
  - Database seam for the two tables.
- App map: features `meals.cooking`, `meals.ratings`, `meals.favourites`.
- Live proof: in chat, "I cooked tonight's dinner", accept the log offer, "undo that", rate it,
  and favourite it for Sam. Do the visual pass.
- Bar to beat: study section 3. Meals does:
  - One servings stepper with reset.
  - Mark cooked showing what it took, with Undo.

### S11. Page write controls

- Goal: every control built in landed slices works on the page.
- Needs: #3723 and #3724 merged.
- Files: `src/web/writes.ts` bound to the landed handle; manifest changes the landed contract asks
  for; the browser test completes the spec's flow through the page.
- Decisions:
  - The adapter is the only file that names the host's prop.
  - Removals show an Undo toast. Deleting a plan, a member or the whole list asks through the host
    dialog.
- Tests that fail first:
  - Each control calls its tool through the real handle prop.
  - Cancelled, rejected, invalid and failed outcomes each show their own message from the record.
  - The full browser test, through the page:
    - add a member
    - generate a week
    - lock and swap a meal
    - open the list, tick, and mark Bought
    - check the Pantry
    - mark a meal cooked, rate it, and confirm the logged portion in Log
    - at desktop and narrow widths
- App map: update every screen description to name its controls.
- Live proof: the browser test's flow by hand on dev, then key steps through chat. The visual pass
  covers every control on every screen, including the host dialog and Undo toasts.
- Kill gate G-S11.

### S12. List Meals, unlist Food

- Goal: Meals reaches people. Food stops being offered, and installed copies keep working.
- Files: `scripts/publish-module-registry.ts:36` (remove `meals`, add `food`); its test; the
  registry artifacts the publish script regenerates.
- Tests that fail first: the publish test expects Meals listed and Food unlisted.
- App map: no change.
- Release note:
  - Category: Added
  - Title: Meals
  - Description: "Plan your household's meals for the week, get a shopping list built from the
    plan, keep track of what's in your kitchen, and log what you eat. Meals replaces Food for new
    installs, and Food keeps working where it is installed."
- Live proof: on a dev instance reading a registry built from this branch, Meals shows in the
  install list and Food does not. An instance that already has Food still runs it.

### S13. Remove Food from the repo

- Goal: Food's source and tests leave the repo.
- Needs: S12 merged and live.
- Files:
  - `external-modules/food/`
  - `package.json:22`, `:24`
  - `tsconfig.tests.json:21`
  - `tests/unit/typography-external-audit.test.tsx:152`
  - `tests/unit/publish-module-registry.test.ts:250`
  - `tests/unit/module-preferences-routes.test.ts`
  - `tests/unit/module-registry-workflow-validation.test.ts:80`, `:82`, `:104`, `:606`
  - `tests/unit/gateway-write-confirmation-coverage.test.ts:176`
  - every `tests/unit/external-module-food-*` file
  - `tests/e2e/food-log-and-read.spec.ts`
  - `tests/uat/specs/926-food-real-chat.uat.spec.ts`
  - `tests/live/food-926-uat.spec.ts`
  - `tests/uat/specs/3526-typography-copy.uat.spec.ts:128-181`
- Left alone: `apps/web/src/settings/settings-activity-labels.ts:17`, `:39`. That folder is outside
  this lane. A Food label with no Food module is inert. File a follow-up for its owner.
- Tests that fail first: `pnpm typecheck` and the unit gate with Food gone. Each red points at a
  reference to remove.
- Release note: `Category: N/A`, because Food was unlisted in S12.
- Live proof: a dev instance with Food installed boots and runs Food after this change.

## 8. Kill gates

| Gate   | When     | Observation that stops the line                                                                                | Call                     |
| ------ | -------- | -------------------------------------------------------------------------------------------------------------- | ------------------------ |
| G-S2   | After S2 | The probe shows a stall kill, a day that resume cannot finish, or a median day over 8 minutes on the test copy | Meals owner, told to Ben |
| G-S3   | After S3 | On a plain two-person household, more than 1 meal in 10 fails, over three 7-day runs                           | Meals owner, told to Ben |
| G-S4   | After S4 | A 7-day list has more than two duplicate lines a shopper would merge by hand                                   | Meals owner              |
| Review | After S6 | Ben's review on dev cuts any of S7 to S10; cutting S7 cuts S8 to S10                                           | Ben                      |
| G-S11  | At S11   | The landed page-write contract differs from the draft in more than the adapter                                 | Meals owner re-plans S11 |

A failed G-S2 switches to Fork G2 or a shorter day before S3 starts.

## 9. Open questions

| #   | Question                                                                                              | Owner       | Fallback                                                                     |
| --- | ----------------------------------------------------------------------------------------------------- | ----------- | ---------------------------------------------------------------------------- |
| Q1  | Does the cheapest pinned model in the browser test write recipes that pass the schema in time?        | S3 builder  | A disclosed seed through chat with a fixed request, never faked network data |
| Q2  | Does the landed tools handle keep the draft's outcome kinds?                                          | S11 builder | G-S11                                                                        |
| Q3  | Meals' activity label lives in `apps/web/src/settings/settings-activity-labels.ts`, outside this lane | Meals owner | Follow-up issue; generic label until then                                    |
| Q4  | When do #1694 (export) and #3716 (per-task models) land?                                              | Meals owner | Follow-ups; no slice waits                                                   |

## 10. Verification

Each command keeps its exit code. Database tests run only through the `verify-gate` skill.

```bash
pnpm build:external:meals > /tmp/meals-build.log 2>&1; echo "EXIT=$?"            # 0
pnpm typecheck > /tmp/meals-tc.log 2>&1; echo "EXIT=$?"                          # 0
pnpm test:unit tests/unit/external-module-meals > /tmp/meals-unit.log 2>&1; echo "EXIT=$?"  # 0
pnpm check:ui-classes > /tmp/meals-ui.log 2>&1; echo "EXIT=$?"                   # 0, UI slices
pnpm exec prettier --check external-modules/meals docs/superpowers > /tmp/meals-fmt.log 2>&1; echo "EXIT=$?"  # 0
scripts/run-gate.sh                                                              # through verify-gate; sentinel reports 0
pnpm test:uat 3317-meals-phase-2.uat.spec.ts > /tmp/meals-uat.log 2>&1; echo "EXIT=$?"  # 0, S3 onward
```

Known local reds that are not the branch: the 8 chat tests in a fleet lane, the module SDK worker
tests, and the gateway pattern timeout (#1673).

## 11. Rulings ledger

Facts found while writing this plan, kept so nobody derives them again.

| #   | Fact or decision                                                                                                      | Evidence                                                                                 |
| --- | --------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------- |
| L1  | An in-flight host call pauses the 30 s stall timer, so a long AI call does not stall a job                            | `worker-runtime.ts:364-371`, `:410-415`                                                  |
| L2  | The manual run route exists but takes params only, with a 5 s duplicate guard per queue and person. Not used (Fork P) | `apps/api/src/external-module-jobs.ts:23-97`                                             |
| L3  | Unlisted modules keep their source and installed copies                                                               | `scripts/publish-module-registry.ts:34-36`                                               |
| L4  | No export path reads module tables                                                                                    | `packages/settings/src/data-export.ts:229`, no caller                                    |
| L5  | Page writes landed only their confirmation store. The route and handle are open                                       | #3733 merged; #3723, #3724 open                                                          |
| L6  | The browser test pins the cheapest JSON-capable model, and a pin beats a module binding, so module AI calls use it    | `tests/uat/specs/real-chat-signin.ts:165-190`; `packages/ai/src/repository.ts:1405-1410` |
| L7  | Module pages run in the host document, so a screen wake lock is available on secure pages                             | `apps/web/src/external-modules/loader.ts:77`                                             |
| L8  | Module SQL may use ALTER TABLE, so later slices add columns                                                           | `module-sql-runner.ts:13-21`                                                             |
| L9  | No per-module tool count limit exists. Tool count is a chat-quality choice                                            | searched `packages/module-registry/src`                                                  |
| L10 | Rejected: a shared pack-size table. Owned tables are owner-only                                                       | ADR 0011; `module-rls-emitter.ts`                                                        |
| L11 | Rejected: per-meal jobs. 84 enqueues for 14 days of 6 slots, against 120 per hour                                     | guide section 13.2.1, line 578 on the slice 4 branch                                     |
| L12 | The structured AI call rejects unknown keys, so no task name                                                          | `worker-rpc-host.ts:574-578`                                                             |
| L13 | A queue key blocks for 14 days unstarted and 7 days after finishing, so every repeat bumps a generation number        | guide section 13.2.1, line 568 on the slice 4 branch                                     |
