# Live state — Food page design pass

Updated 2026-08-19. Read this instead of re-deriving from history.

## Shipped and open

- **PR #1733**, branch `food-page-design`, worktree `~/Jarv1s/.claude/worktrees/food-page-design`.
  Applies the host design system to Food's day view (cards, stat tiles, toned badges, real empty
  states) and adds the process rule that a new module needs agreed front-end mockups before it is
  built. Typecheck, lint, prettier and the invented-class audit are all clean. **Live-path proof not
  yet done — do not merge without it.**
- **Issue #1734** — the nav groups installed modules under a section header reading "Modules".
  `apps/web/src/app-route-metadata.ts:113`, plus `aria-label="Modules"` at
  `apps/web/src/shell/app-shell.tsx:321`. Three options written up; 1 or 2 recommended.
- Ben's ruling 2026-08-19: **the word "module" appears in Settings and nowhere else.** Already
  removed from the Food page header on this branch.

## Where the design conversation got to

Ben saw a before/after preview and called the result "definitely better, but still not great".
Reference screenshots were pulled from App Store listings (MacroFactor, Cronometer, MyFitnessPal,
Lose It, Copilot, Monarch, Gentler Streak, Streaks) and sent to his MacBook. What they do that Food
does not:

1. Lead with one big number, not a date picker.
2. Show numbers against a target, not raw.
3. Give protein/carbs/fat weight and colour; demote fiber, sugar, sodium.
4. Group meals by occasion, not a flat time-ordered list.
5. Show the food photo.

Monarch is the closest visual cousin to our palette — warm cream, big display number, restrained
colour — and is the proof that calm does not have to mean flat.

### Two open decisions, both Ben's

1. **Does Food get daily targets?** Asked, not yet answered. A ring or progress bar needs a goal;
   without one the hero is a plain total and loses most of its force.
2. Nothing else is blocked on him.

## Next job: per-component meal breakdown (Ben asked 2026-08-19)

He wants a meal to break into its parts — wings x/y/z, breadsticks a/b/c, drink e/f/g, then meal
totals. **The data cannot express this today.** `app.food_estimates`
(`external-modules/food/sql/0002_create_food_estimates.sql`) is one row per meal per revision, with
seven flat nutrient columns. The estimator matches it: `ESTIMATE_SCHEMA` in
`external-modules/food/src/estimator/schema.ts` returns one flat object for the whole meal, and its
prompt says "for this ONE meal" in every field description.

What it takes:

- New migration `external-modules/food/sql/0003_*.sql` adding a per-item table (owner, meal_id,
  revision, item_index, label, portion note, the same seven nullable nutrient columns). **Never edit
  0002** — the runner hash-checks applied files.
- `ESTIMATE_SCHEMA` returns an `items` array; `parseEstimateResult` validates each item and keeps
  its "no invented fields" discipline per item.
- **Recommendation: meal totals become the sum of the items**, not a separate model estimate. One
  source of truth, no possibility of the parts disagreeing with the whole, and correcting one
  component updates the total for free.
- `domain/totals.ts`'s "never coalesce a missing nutrient to 0" rule has to survive summation: a
  meal with any unestimated item is incomplete, exactly as a day with an unestimated meal is today.
- Web: the meal row becomes expandable, components listed inside it. This is what MacroFactor and
  Cronometer do.

This is a spec change to Phase 1, not a tweak. It needs the mockups gate the same as the rest.

## Traps worth keeping

- The Food page **never refreshes** — `external-modules/food/src/web/root.tsx` runs one query per
  mount with no polling or invalidation, so a meal logged in chat does not appear until reload. This
  is what made Ben's first live test look like it had failed. Not yet filed.
- Without an AI-estimation consent record, `external-modules/food/src/tools/meals.ts` (~line 260)
  returns early and **queues nothing**, so the meal sits `pending` forever and the page shows
  "Estimating…" when nothing is running. The #1725 follow-on removes this whole path.
- The `design-system` skill's audit script greps only `apps/web/src/styles/`, but `jds-card`,
  `jds-badge`, `jds-eyebrow`, `jds-caption` and `jds-stat-tile` are defined in
  `packages/ui/src/styles/`. Audit against both or valid classes are reported as invented.
- Preview without deploying: `/tmp/food-preview/gen.mjs` renders the module's markup against the
  real host stylesheets and Playwright screenshots it. Playwright is not resolvable from `/tmp`;
  import it by absolute path from
  `/home/ben/Jarv1s/node_modules/.pnpm/playwright@1.60.0/node_modules/playwright/index.mjs`.
- `tailscale file cp <files> music-production-m1-air:` sends to Ben's MacBook.
