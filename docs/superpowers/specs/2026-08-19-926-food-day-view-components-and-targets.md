# Food day view: per-item breakdown, daily targets, keyline redesign (#926 phase 2)

Extends `2026-08-18-926-food-nutrition-tracking.md`. That spec stands except where this one
explicitly supersedes it. Phase 1 remains the shipped baseline; nothing here is a prerequisite for
it.

Approved by Ben 2026-08-19 across a design review of rendered mockups
(`food-proposed.png`, `food-keyline.png`, `food-keyline-colour.png`).

## Problem Statement

Phase 1 shipped a correct Food page that nobody wants to look at, and a data model that cannot
answer the first question a user asks of a logged meal.

Two distinct defects:

1. **A meal is an opaque lump.** "6 hot wings + 2 breadsticks from Epic Wings, 32oz Coke Zero"
   produces exactly one set of seven numbers. The user cannot see which part of the meal cost what,
   cannot correct one component without re-describing the whole meal, and cannot learn anything
   transferable from the record. Every comparable product — MacroFactor, Cronometer, Lose It —
   expands a meal into its individual foods.
2. **Numbers with nothing to measure against.** Phase 1 renders raw grams. A raw gram figure is not
   actionable; the same figure against a target is. Phase 1 placed targets out of scope
   (`2026-08-18` spec, Out of Scope, line 382). **That exclusion is superseded by product-owner
   ruling, Ben 2026-08-19:** Food gets user-configured daily targets, held in Food's own settings
   the same way News and Sports hold theirs.

A third, cosmetic defect was fixed separately on PR #1733 and is folded in here for completeness:
the page applied zero host design classes, so it rendered as unstyled prose.

## Rulings taken during this review (binding)

- **Nutrient set stays at seven.** Calories, protein, carbohydrates, fat, fiber, sugar, sodium. No
  micronutrients. Rationale: our values are model estimates from a free-text description. That is
  defensible for large, common quantities and indefensible for micrograms of folate. Cronometer's
  micronutrient screen is backed by a lab-measured food database, not by a model. Database-backed
  lookup is filed as **#1736** and is explicitly out of scope here.
- **No floating cards.** Cards read as a generic AI-design tell (Ben, 2026-08-19). The page is built
  from the authored keyline primitives in `apps/web/src/styles/components-keyline.css`, whose stated
  idiom is "hairline rules + committed fields, no floating cards".
- **The word "module" never appears outside Settings.** Already applied to the page header on
  PR #1733. The navigation section header is the same defect, tracked as **#1734**.
- **Meal totals are the sum of the items, never a separate model estimate.** One source of truth;
  the parts cannot disagree with the whole; correcting one component updates the total for free.

## Solution

A meal becomes a container of items. The estimator identifies the items and estimates each one; the
meal's numbers are derived. The day view leads with calories against a target, shows protein, net
carbs and fat as ruled instrument fields, groups meals by occasion with a time-of-day accent, and
expands any meal into its components.

### Story additions

Numbering continues from the phase 1 spec's 38.

39. As a user, I want a logged meal broken into the foods it contains, each with its own calories
    and macros, so that I can see which part of the meal cost what.
40. As a user, I want the meal's totals to be the sum of its items, so that the parts and the whole
    always agree.
41. As a user, I want to correct one item of a meal without re-describing the whole meal, so that
    fixing "6 wings" to "8 wings" is a small action.
42. As a user, I want a meal whose items could not all be estimated shown as incomplete rather than
    under-counted, so that a partial estimate is not read as a smaller meal.
43. As a user, I want to set daily targets for calories, protein, net carbs and fat in Food's
    settings, so that the day's numbers mean something.
44. As a user, I want the day's totals shown against my targets as both a figure and a percentage,
    so that I can read my position at a glance.
45. As a user with no targets set, I want the page to show plain totals without empty progress
    indicators, so that the feature is optional rather than a nag.
46. As a user, I want meals grouped by occasion — breakfast, lunch, dinner, snack — so that the day
    reads the way I think about it rather than as a flat list.
47. As a user, I want a meal still being estimated shown as pending and excluded from totals, with
    the exclusion disclosed, so that a slow estimate is not silently counted as zero.

## Implementation Decisions

### Storage

New migration file. **Never edit `0002_create_food_estimates.sql`** — the runner hash-checks applied
files and an edit breaks every existing install. Module SQL stays in `external-modules/food/sql/`.

`external-modules/food/sql/0003_create_food_estimate_items.sql`:

```sql
CREATE TABLE app.food_estimate_items (
  owner_user_id      uuid    NOT NULL REFERENCES app.users(id) ON DELETE CASCADE,
  meal_id            uuid    NOT NULL,
  revision           integer NOT NULL,
  item_index         integer NOT NULL,
  label              text    NOT NULL,
  portion_note       text,
  calories_kcal      numeric(8,2),
  protein_g          numeric(8,2),
  carbohydrates_g    numeric(8,2),
  fat_g              numeric(8,2),
  fiber_g            numeric(8,2),
  sugar_g            numeric(8,2),
  sodium_mg          numeric(9,2),
  created_at         timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (owner_user_id, meal_id, revision, item_index),
  FOREIGN KEY (owner_user_id, meal_id, revision)
    REFERENCES app.food_estimates (owner_user_id, meal_id, revision) ON DELETE CASCADE
);
```

Decisions embedded above, each deliberate:

- **Keyed on `(owner, meal, revision, item_index)`**, cascading from `food_estimates`. Revisions stay
  the correction unit, matching phase 1: a correction writes a new revision with a new item set
  rather than mutating rows in place, so history is preserved and the existing correction diffing in
  `store/sql.ts` extends rather than being replaced.
- **Nutrient columns stay nullable**, same as `food_estimates`. A null is "not estimated", never
  zero. Phase 1's rule that a missing nutrient is never coalesced to 0 (`domain/totals.ts`) must
  survive summation: a meal with any null in a nutrient is incomplete *for that nutrient*, exactly
  as a day containing an unestimated meal is today.
- **`food_estimates` keeps its seven nutrient columns.** They become derived — the sum of the item
  rows — written at the same time as the items, inside one transaction. Keeping them denormalised
  keeps every existing day-totals and report query working unchanged. The invariant is that they are
  written only by the summation, never by a model value.
- **RLS: owner-only**, matching `food_estimates`. Health-adjacent private data; no share path, no
  admin read.
- **`portion_note`** carries "6", "32 oz", "1 cup cooked" separately from `label` so that a future
  database lookup (#1736) has a quantity to resolve against. Nothing in this phase parses it.

### Estimator contract

`external-modules/food/src/estimator/schema.ts` currently returns one flat object with
`additionalProperties: false` and every nutrient described "for this ONE meal". It becomes an
identification-plus-estimation call returning an item array.

```ts
export interface EstimateItem {
  readonly label: string;
  readonly portionNote: string | null;
  readonly nutrientFields: NutrientFields;   // unchanged seven-field shape, nullable members
}

export interface EstimateResult {
  readonly outcome: EstimateOutcome;          // unchanged
  readonly items: readonly EstimateItem[];
  readonly missingDetails: string | null;
  readonly clarificationQuestion: string | null;
}

export function parseEstimateResult(raw: unknown): EstimateResult;
export function buildEstimatePrompt(description: string, servingNote: string | null): string;
```

- `additionalProperties: false` and the `KNOWN_FIELDS` rejection apply **per item**, not only at the
  top level. An unexpected key anywhere throws, as today.
- A single-food meal returns one item. There is no separate scalar path; one code path for all
  meals.
- Phase 1's four guards for model-authored values crossing into user data all apply per item:
  per-field unit descriptions, one worked example in the prompt, `validateNutrients` at the boundary
  in `domain/estimate.ts`, and per-item before/after diff acceptance on correction.
- **Guidance budget unchanged: under 150 words.** The worked example changes from "a bowl of oatmeal
  with a banana" as one lump to the same meal as two items. If item identification needs more than
  the budget to explain, the schema is wrong, not the prompt.
- **Determinism boundary, restated:** every number the user sees renders from the stored record.
  The model's output reaches the page only after being written and read back.

### Derivation

`external-modules/food/src/domain/totals.ts` gains meal-level summation alongside the existing
day-level summation, with the same null rule at both levels.

```ts
export function sumItems(items: readonly EstimateItem[]): NutrientFields;
export function isNutrientComplete(items: readonly EstimateItem[], field: NutrientKey): boolean;
```

Net carbs are computed, never stored: `carbohydrates_g - fiber_g`, null if either is null. Adding a
column for a value derivable from two existing columns would create a third thing to keep in sync.

### Targets

Declared as module preferences in `external-modules/food/jarvis.module.json`, rendered by the
host-owned generic module preferences page (#1725) — the same mechanism carrying the `aiEstimates`
toggle. Food does not build a settings pane.

Four optional integers: `dailyCalorieTarget`, `dailyProteinTargetG`, `dailyNetCarbTargetG`,
`dailyFatTargetG`. Unset is the default and is a supported end state, not an incomplete one — with
no targets the page shows totals without progress indicators (story 45).

**This depends on the module preferences page landing first.** If #1725 has not merged, targets wait;
per-item breakdown does not depend on it and can ship first.

### Web

`external-modules/food/src/web/root.tsx`, built from the keyline primitives. Module CSS stays
layout-only by contract — every visual decision is a host class.

| Surface | Primitive |
|---|---|
| Day calorie figure | `jds-display jds-display--xl` |
| Protein / net carbs / fat | `jds-instrument` + `jds-instrument__label` |
| Occasion headers | `jds-section-head` + `jds-section-head__rule` |
| Meal row state marker | `jds-rail` + `jds-rail-row` (3px leading band, never a border or pill) |
| Meta line separators | `jds-meta-sep` (not a bullet, not a slash) |
| Food and occasion icons | `lucide-react`, already a dependency, 14–18px |

Occasion accents come from the existing unused tokens `--bucket-morning`, `--bucket-afternoon`,
`--bucket-evening`, with `--gold` for snack. Raw CSS colours belong in `tokens.css` alone; the module
references tokens only.

Occasion is derived from consumed time, not asked for. Boundaries are a decision for the build
issue; the derivation must be pure and testable.

**Known adjacent defect, must be fixed here:** the page runs one query per mount with no polling or
invalidation (`root.tsx`), so a meal logged in Chat does not appear until reload. A day view that
silently omits a just-logged meal fails stories 42 and 47 regardless of how the totals are computed.

## Testing Decisions

Behaviour plus why each fails against a broken implementation.

1. **Meal totals equal the sum of item rows.** Store a three-item meal; read the meal back. Fails if
   any path writes a model-supplied meal total, which is the specific regression this design exists
   to prevent.
2. **A null nutrient in one item makes that nutrient incomplete for the meal**, and the meal is
   excluded from that nutrient's day total with the exclusion disclosed. Fails if summation
   coalesces null to 0 — the exact bug phase 1's `domain/totals.ts` rule was written against.
3. **An unexpected key inside an item throws.** Fails if `additionalProperties: false` was applied
   only at the top level, which is the natural mistake when converting a flat schema to a nested one.
4. **A single-food meal produces exactly one item.** Fails if a scalar fast path was kept.
5. **Correcting one item writes a new revision** whose other items are unchanged. Fails if
   correction rewrites the item set wholesale, losing the untouched items' provenance.
6. **With no targets set, no progress indicator renders** and totals still display. Fails if the UI
   divides by an absent target — the common shape of this bug is a 0%, an Infinity, or a NaN.
7. **Net carbs are null when either carbohydrates or fiber is null**, not `carbs - 0`.
8. **Playwright, on a live dev instance:** log a meal in Chat, and it appears on the Food page
   without a reload; expand it and the item rows are present. This is the phase exit criterion, not
   a nice-to-have, and it is also the regression test for the no-invalidation defect above.

Verification commands, unpiped, expected exit code 0:

```bash
pnpm verify:foundation > /tmp/vf.log 2>&1; echo "EXIT=$?"
pnpm test:e2e > /tmp/e2e.log 2>&1; echo "EXIT=$?"
```

The gate must run under the `verify-gate` skill against a scoped, freshly created gate database.
A green local gate does not include the browser suite; say which one was verified.

## Live-path gate

User-facing UI. CI-green plus review is not done. Needs installed-and-exercised proof through the
real UI on a live dev instance, recorded on the PR. Screenshots are not gate evidence — executable
assertions and bounded textual evidence only.

## Kill gate

**Owner: Ben.** Evaluated after the per-item breakdown ships and before any further Food work is
planned in detail.

The observation that ends the line: **if the item breakdown is wrong often enough that correcting it
is more work than logging the meal was, the estimation-only approach has failed.** The answer then
is not to tune the prompt — it is #1736, a real food database, or nothing.

## Out of Scope

Everything excluded by the phase 1 spec remains excluded, **except** calorie and macro targets,
which this spec brings in scope by product-owner ruling. Additionally out of scope here:

- Micronutrients of any kind, and any food-database lookup (#1736).
- Barcode scanning, restaurant menus, packaged-food catalogues.
- Weight tracking, weight-loss programs, coaching, scores, streaks, or alerts. Targets are a
  reference line, not a program.
- Charts, trends, or any multi-day visualisation.
- Editing an item's identity into a different food. Corrections adjust an existing item; replacing
  one is a re-estimate of the meal.
- Per-meal photo display on the day view.

## Further Notes

- The per-item breakdown is the prerequisite that keeps #1736 possible. A database lookup needs
  individual foods with portions to resolve; without items there is nothing to look up. That is a
  reason to do it now rather than a reason to do #1736 now.
- Estimating item by item is expected to be *more* accurate than estimating a compound meal in one
  pass, not less. This is an assumption, and test 1 plus the kill gate are how it gets checked.
- Targets are the first thing in Food that is a user preference rather than a record. If the module
  preferences page (#1725) turns out not to fit, that is a finding about the platform contract and
  belongs in a platform issue — not a Food-owned settings pane.
