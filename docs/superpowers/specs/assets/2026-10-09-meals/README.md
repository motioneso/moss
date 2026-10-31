# Meals clickable prototype

Phase 1 of `docs/superpowers/plans/2026-10-25-meals-build.md`. Every screen in the Meals spec
(`docs/superpowers/specs/2026-10-09-meals-meal-planning-design.md`) on fake data, at desktop and
phone widths. Throwaway code. Nothing in `external-modules/` imports it.

## Open it

- Open `index.html` in a browser straight from disk, or serve the folder with any static server.
- Styles load from the real tree by relative path (`apps/web/src/styles/tokens.css`,
  `packages/ui/src/styles/components-*.css`). No frozen copy, so the prototype tracks the design
  system as it changes.
- Every screen, dialog and state has its own address: `#/<route>?state=<s>&phase=<n>&theme=<t>`.

## Review tools

The floating panel, labelled as review tooling, is not product UI.

| Control    | Does                                                                         |
| ---------- | ---------------------------------------------------------------------------- |
| Screen     | Jumps to any route with a sample, dialogs included                           |
| State      | Filled in, empty, loading, failed, AI unavailable, long text                 |
| Features   | Phase 2 core planning up to phase 5 sharing; later-phase controls appear     |
| Theme      | Every shipped theme, to check contrast on each ground                        |
| Phone view | Opens the current address in a 390 px frame                                  |
| Next event | Finishes the day being written now                                           |

## Walkthrough

1. Plan. Tonight's dinner in the masthead, then the week. Start a new plan, watch days write one
   by one, stop it, retry a failed day, re-plan, swap or regenerate a meal, step between weeks.
2. Recipe. Open any meal. Change servings and units, mark it cooked with the Pantry preview, rate
   it.
3. Shopping list. Tick lines and undo a tick, add one by hand, edit amounts, mark the trip bought.
   Phase 3 adds checking a receipt against the list.
4. Pantry. Find an item, add or edit one, remove it and undo. Phase 3 adds storage grouping,
   use-by badges, restock, fridge photo and history with undo.
5. Household. First-run setup, member editor, who eats together, Favourites. Phase 4 adds what
   Moss learned and recipe import. Phase 5 adds the Kitchen invite, accept and leave.
6. Log. Today's totals against targets, quick add with a live estimate, corrections, earlier
   days.
7. Settings, from the header cog. Units, Pantry mode for new plans, the model each task uses.
   Phase 5 adds reminders and the weekly draft.

## Files

| File                 | Holds                                                  |
| -------------------- | ------------------------------------------------------ |
| `index.html`         | Static shell: navbar, top bar, main region             |
| `prototype.js`       | Router, render helpers, review tools, shared actions   |
| `fake-data.js`       | Two-person household, a stocked Pantry, last week      |
| `icons.js`           | The Lucide icons the screens use, inlined              |
| `screen-*.js`        | One file per area: plan, recipe, list, pantry, household, log, settings |
| `prototype.css`      | Layout-only `mls-` classes                             |

The plan named one `prototype.js`. The screens live in one file each instead, because together
they run past 4,000 lines and one file would not be reviewable.

## Design decisions

- The five areas sit in a segmented tab bar, following Finance. Settings opens from the header cog.
- The week stacks one section per day, with the day's meal slots side by side. That uses the width
  on desktop and keeps each day scannable on phone.
- Every dialog has its own route, so a reviewer can link straight to it.
- Tonight's masthead uses the dinner as its title. The field masthead appears only on Plan.
- Recipe pages use the compact masthead.
- Re-plan and Regenerate share one dialog. Stopping a plan keeps the days already written.
- The writing route writes the Nov 9 week. Two weeks exist, with previous and next arrows.
- Servings start at the scaled amount and step in halves.
- Bought shows ticked lines first, then the rest, each with an editable amount.
- Receipt and fridge photo readings are reviewed before the Pantry changes.
- Pantry find filters in place. An item with no amount reads "Some". Phase 3 adds a Leftovers group, listed first.
- Shared or Solo is edited inline, with its own route. A meal one person eats shows "Only Rowan"
  with no control, because the choice means nothing for one eater.
- Restrictions are labelled "Never serve".
- Removals use an undo toast, not a confirm dialog. Leaving a Kitchen is the one confirm, because
  it cannot be undone from this side.
- The menu and the drawer scrim mount only when open, mirroring how the React shell renders them.
- No explanatory or reassurance copy on screens, per the screen-copy ruling.
- Long text is a review state. It stretches names, list lines, notes and numbers on every screen.
  The data is built at load, so entering or leaving it reloads the page.

### Folded in from the competitor study

Screen behaviour only. Offline, data export, receipt text and opt-in Leftovers stay out of phase 2.

- Phone shopping mode. List rows grow to 64 px with a larger name, the whole row ticks, and each
  tick shows an undo toast. Rivals make the tick box the only target, which misses in a shop.
- A plan change never resets the list. Ticks stay; only changed lines show "Was" or "Not needed
  now", and new lines carry a New badge. Losing ticks on a re-plan is the top rival complaint.
- Safety per meal and per eater. The recipe page names each eater's rule and the reason, with a
  one-tap Safe swap. No rival shows who a meal is unsafe for, or why.
- Mark cooked and Bought each offer one-step Undo in their toast. Full Pantry history stays in
  phase 3, so the undo covers only the last action.
- Writing a plan shows Stop, and a failed day has its own Retry. One bad day should not cost the
  whole week.
- Each meal slot shows Solo or Shared, and servings follow the eaters. Mixed households need to see
  who a meal is for before they shop.
- Pantry items sit in a visible "You have this" group on the list. Silent removal leaves people
  unsure whether the app forgot an item.
- Lock is per meal, and Regenerate leaves locked meals alone. Servings use one stepper with a reset,
  and "As written" shows the original ingredient text in one tap.

## Module classes

`prototype.css` holds only `mls-` layout classes. No `jds-*` primitive covers these.

| Class                                      | Why no primitive fits                                              |
| ------------------------------------------ | ------------------------------------------------------------------ |
| `mls-page`, `mls-grid`, `mls-rail`         | Module page column and right rail; each module owns its layout     |
| `mls-tabs`                                 | Spacing around the shared segmented control used as area tabs      |
| `mls-stack`, `-tight`, `-tiny`, `-loose`   | Vertical rhythm between sections                                   |
| `mls-row`, `-between`, `-baseline`         | Horizontal grouping with the minimum gaps                          |
| `mls-columns`, `mls-setup`                 | Favourites per member side by side; first-run form width           |
| `mls-hero`, `mls-hero__actions`, `mls-back`| Spacing around the shared masthead and its actions                 |
| `mls-planbar`, `mls-progress`, `mls-datebar` | Bar under the masthead: week arrows, writing progress, log date |
| `mls-week`, `mls-day*`, `mls-slots`, `mls-slot*` | Week grid with a column per meal slot                        |
| `mls-meal*`, `mls-fit*`, `mls-writing`, `mls-dots`, `mls-past` | One meal cell, its fit facts, writing marker, past weeks |
| `mls-safety*`, `mls-safety-list`           | Per-eater Safety reasons on the recipe page                        |
| `mls-recipe*`, `mls-ing*`, `mls-steps`, `mls-stepper*` | Recipe page: ingredients, numbered steps, servings |
| `mls-stars`, `mls-rate-row`                | Star rating rows per member                                        |
| `mls-section`, `mls-block-head`            | Shopping list and Pantry groups with a count                       |
| `mls-list`, `mls-list--shop`, `mls-line*` | List rows: check, name, amount, tools; taller rows on phone        |
| `mls-entry`, `mls-totals`, `mls-num*`      | Log entries, totals meters, tabular numbers                        |
| `mls-member`, `mls-facts`, `mls-rule*`, `mls-chips` | Household member facts and eating rules                   |
| `mls-form`, `mls-form-grid*`, `mls-inline-add`, `mls-find`, `mls-foot-start` | Dialog form layout and inline adds |
| `mls-dialog-wide`, `mls-receipt`, `mls-table-scroll`, `mls-dropzone` | Wide review dialogs and the photo drop area |
| `mls-sticky`, `mls-hide-phone`             | Phone action bar and desktop-only controls                         |
| `mls-icon`                                 | Inline icon sizing                                                 |
| `mls-toast-root`                           | Toast stack position; the shell has no toast host                  |
| `mls-review*`, `mls-phone*`                | Review tooling only                                                |

## Design-system defects found

- The field masthead has no reversed accent colour, so an accent word disappears on the field
  ground. Tonight's masthead avoids the accent.
- In `components-moss-today.css` the phone `.jds-masthead__aside { align-items: flex-start }`
  sits before the base `flex-end` rule, so the aside stays right-aligned on phone. The recipe
  masthead works around it with `mls-hero__actions`.
- `:where(label)` in `apps/web/src/styles.css` (line 130) gives every label muted colour, a
  0.84rem size, bold weight and grid display. A list row whose name and amount are labels for its
  tick box has to reset that in `prototype.css`. A row-label primitive would fix it.
- The field masthead caps its lede narrow, so a long eater list wraps mid-name on a wide screen.

## Chat

Every page action has a Chat equivalent in the spec. Chat is outside this prototype. The chat
button shows a toast.

## Test

`tests/e2e/meals-prototype-clickthrough.spec.ts` opens every route with a sample, every area in
every state including long text, every route in long text, and every area at phase 5, at 1440 px and 390 px, as one test per area and width. It
fails on a console error, a failed request, an empty main region, or a rendered `jds-`/`mls-` class
no stylesheet defines, or, in long text, a page that scrolls sideways. Set `MEALS_PROTOTYPE_SHOTS=1` to save a full-page screenshot of every visit
under `test-results/meals-prototype/`.
