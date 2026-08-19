# #1427 — Close guard 4's unmeasured web CSS residue

**Date:** 2026-08-10  
**Status:** Approved by Ben's Fable delegate on 2026-08-10; no open implementation fork  
**Tracking:** [#1427](https://github.com/motioneso/moss/issues/1427), part of #1470  
**Grounded on:** `origin/main` = `ba1acd70a` (fetched 2026-08-09)

## Outcome

Every CSS file under `apps/web/src` is measured by guard 4, the current 418 banned declarations are
moved to `@moss/ui` without changing their selectors or values, and a newly added web CSS file can no
longer evade the guard by being absent from a hand-maintained registration list.

#1427 remains the roll-up. Implementation is owned by the seven ordered child tasks below; no builder
is assigned the parent as a single session.

## Current truth

The issue body was re-measured with the exact `BANNED_VISUAL_PROPERTIES` list and declaration regex
from `scripts/check-design-tokens.ts`, reading CSS blobs from `origin/main`. The count is still 418.
There are 30 CSS files under `apps/web/src`: 18 are registered, 12 are unregistered, and 9 of those 12
contain violations. The three zero-violation unregistered files are
`apps/web/src/calendar/calendar.css`, `apps/web/src/styles/index.css`, and
`apps/web/src/styles/tokens.css`.

Two paths in the live tree differ from the issue's pre-merge table:

- the global sheet is `apps/web/src/styles.css`, not `apps/web/src/styles/styles.css`;
- assistant-surface CSS is `apps/web/src/chat/assistant-surface/assistant-surface.css`.

| Current file                                                | Banned declarations | Ownership                                              |
| ----------------------------------------------------------- | ------------------: | ------------------------------------------------------ |
| `apps/web/src/styles.css`                                   |                 135 | Global base, shared legacy controls, app shell         |
| `apps/web/src/styles/kit-today-misc.css`                    |                  93 | #1390 Today                                            |
| `apps/web/src/styles/components-forms.css`                  |                  56 | Cross-cutting form primitives                          |
| `apps/web/src/styles/command-palette.css`                   |                  48 | #1390 command palette                                  |
| `apps/web/src/styles/kit-today.css`                         |                  34 | #1390 Today                                            |
| `apps/web/src/styles/components-keyline.css`                |                  22 | Cross-cutting keyline primitives                       |
| `apps/web/src/styles/kit-today-feeds.css`                   |                  20 | #1390 Today                                            |
| `apps/web/src/chat/assistant-surface/assistant-surface.css` |                   9 | #1396 assistant surface                                |
| `apps/web/src/styles/texture.css`                           |                   1 | Global texture                                         |
| **Total**                                                   |             **418** | 214 never section-owned + 204 unfinished section scope |

The current guard's default is a static `MIGRATED_SECTION_CSS_FILES` array. It includes 27 paths: 18
under `apps/web/src` and 9 package-owned news/sports screen sheets. `checkTokens` already walks all of
`apps/web/src`; guard 4 does not. A green result therefore means only that every registered file is
green, not that the web app is green.

## Locked treatment

### `styles.css`: split it; do not exempt it

`apps/web/src/styles.css` is both a global sheet and the app shell's layout sheet. That makes it a
poor candidate for moving wholesale, but not a valid permanent blind spot.

Keep its layout declarations and selectors in place. Move guard 4's banned declarations verbatim,
plus the one coupled font shorthand in this file named below, to one new
`packages/ui/src/styles/components-web.css` sheet imported by
`packages/ui/src/styles.css`. The same destination owns `texture.css`'s one banned
`background-image` declaration. The original files remain imported because they still own layout.

This follows the migration already used by calendar, chat, settings, tasks, and the other sections:
screen/app CSS keeps layout; `@moss/ui` owns colour, type, border, radius, and shadow. It also avoids
three worse outcomes:

- registering `styles.css` without splitting, which simply makes the gate red;
- exempting a 135-declaration global blind spot forever;
- moving the whole 895-line file into `packages/ui`, which would make the component package own app
  layout and needlessly change cascade position.

The move is declaration-level, not a rewrite. Do not rename a selector, change a token/value, change
markup, or introduce a component. Mixed selectors are intentionally defined once in the app layout
sheet and once in the package visual sheet. Preserve computed order for shorthand/longhand pairs such
as `border` plus `border-*` and `background` plus `background-*`; a textual move that changes the
computed style is a regression. `font: inherit` in `button.module-link` must move with that rule's
`font-weight`; leaving the later-loaded shorthand in the app sheet would reset the moved weight. The
generic `button, input, select, textarea { font: inherit; }` reset is not coupled to a moved
declaration and stays in the app sheet.

### Other residue

- Today visual declarations move into the existing
  `packages/ui/src/styles/components-moss-today.css`. Move
  `.today-feedback__status button`'s `font: inherit` with its `font-size`; leaving the shorthand in
  the later-loaded app sheet would reset the moved size.
- Assistant-surface visual declarations move into the existing
  `packages/ui/src/styles/components-chat.css`.
- Command-palette visual declarations move into a new focused
  `packages/ui/src/styles/components-command-palette.css`; do not append them to
  `components-moss.css`, which is already 860 lines.
- Form visual declarations move into the existing
  `packages/ui/src/styles/components-forms.css`.
- Keyline visual declarations move into a new
  `packages/ui/src/styles/components-keyline.css`.
- Source CSS files retain their layout declarations and existing import sites.

`packages/ui/src/styles.css` must order the new extracted sheets so the effective visual cascade
matches the current web order. Do not reorder unrelated existing imports just to make the diff look
tidy. If exact computed equivalence requires a narrower import entry, use the smallest such entry and
record why in the child PR; it does not authorize a second UI stylesheet API.

`check:ui-classes` uses a static `DEFINITION_FILES` list rather than discovering package styles.
Child E changes `scripts/check-ui-classes.ts` to discover every `*.css` file below
`packages/ui/src/styles` with the script's existing walker, while retaining the explicit web
definition files. Add focused coverage in `tests/unit/check-ui-classes.test.ts` proving that a newly
created package style file contributes a `jds-*` definition without a registration edit. This keeps
the new `components-keyline.css` definitions visible after their visual rules leave the web sheet
and prevents the next package sheet from opening the same static-list hole. Retain the web keyline
entry while that file still defines layout-only `jds-*` selectors. Form extraction must also run
this guard because it moves definition-bearing CSS, but its existing package destination is already
covered and needs no separate script change. Today, command-palette, and assistant selectors do not
use `jds-*` names.

### Graduate the app guard after the residue is gone

The final child changes guard 4's default app scope from opt-in to automatic discovery of every
`*.css` file below `apps/web/src`. This is safe only after the preceding children have removed the
residue. Keep an explicit list only for the nine migrated news/sports screen sheets outside the web
tree; `packages/ui` is intentionally not scanned because its purpose is to contain visual
declarations.

The implementation should reuse the script's existing CSS walk rather than add a glob dependency or
a parallel scanner. Preserve an explicit-file parameter for focused tests if that remains the
smallest API. Add a regression fixture proving that a new, unlisted
`apps/web/src/**/new-screen.css` with a banned declaration fails.

This closes the exact process hole that produced #1427. Adding 12 more strings to the old array would
make today's tree green while leaving tomorrow's new file invisible.

## Ordered child tasks

Each child is sized for implementation, focused verification, review preparation, and its assigned
browser proof in one agent session. The audit's oversized final workstream is split across E–G:
keyline/texture extraction, global extraction with targeted proof, then guard graduation with the
broad final browser comparison. Children merge in order because they touch the shared UI style entry
and guard registration seam. A child rebases after its predecessor; they are not parallel lanes
inside #1427.

| Order | Suggested child-issue title                                                              | Owned surfaces                                                                                                                                                                                           | Baseline / completion                               |
| ----: | ---------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------- |
|     1 | **#1427-A — Extract Today residue into `@moss/ui` and register its three layout sheets** | `kit-today.css`, `kit-today-feeds.css`, `kit-today-misc.css`, coupled `font: inherit`, `components-moss-today.css`, temporary guard registration                                                         | 147 → 0 banned declarations in the three app sheets |
|     2 | **#1427-B — Extract command-palette visual residue into `@moss/ui`**                     | `command-palette.css`, new package `components-command-palette.css`, UI style entry, temporary guard registration                                                                                        | 48 → 0 in the command-palette sheet                 |
|     3 | **#1427-C — Finish assistant-surface CSS registration**                                  | `assistant-surface.css`, package `components-chat.css`, temporary guard registration                                                                                                                     | 9 → 0 in the assistant-surface sheet                |
|     4 | **#1427-D — Move shared web form visuals under `@moss/ui`**                              | web and package `components-forms.css`, temporary guard registration                                                                                                                                     | 56 → 0 in the web form sheet                        |
|     5 | **#1427-E — Move keyline and global texture visuals under `@moss/ui`**                   | web `components-keyline.css`, `texture.css`, new package `components-keyline.css`, new package `components-web.css`, UI style entry, `scripts/check-ui-classes.ts`, its focused test, guard registration | 23 → 0 across the two app sheets                    |
|     6 | **#1427-F — Split and register global web visuals**                                      | `apps/web/src/styles.css`, coupled `font: inherit`, package `components-web.css`, UI style entry, temporary guard registration, targeted browser proof                                                   | 135 → 0 in the global app sheet                     |
|     7 | **#1427-G — Graduate guard 4 and prove the complete web CSS migration**                  | `scripts/check-design-tokens.ts`, its focused unit test, final real-tree guard run, broad browser comparison                                                                                             | all 30 app CSS files automatically measured         |

Every child body says `Part of #1427` and copies its row's owned surfaces. The parent closes only
after all seven children merge and the final zero-residue measurement is attached.

## Per-child implementation contract

1. Re-measure the owned source files before editing. If the count differs, stop and update the child
   issue rather than silently absorbing new scope.
2. Move banned declarations to the named package sheet. Child A also moves the coupled
   `.today-feedback__status button { font: inherit; }`; child F also moves the coupled
   `button.module-link { font: inherit; }`. Preserve selectors, values, comments that explain a
   non-obvious visual rule, media-query context, and cascade semantics.
3. Keep layout declarations at their existing app path. Delete an empty rule only when the move
   leaves it truly empty; do not delete or rename a class used by markup.
4. Register the now-green app source paths while the static list still exists. Child G replaces app
   registration with discovery after every app sheet is green.
5. Do not edit TS/TSX, catalogue components, design tokens, or snapshots to hide a visual change.
6. Re-measure and run the focused checks. Children A–F record their focused browser comparison in
   the PR before handing it to QA; child G records the broad final comparison before the parent
   closes.

## Acceptance

### Every child

- For children A–F, their owned app source files return zero violations from
  `checkBannedProperties` when passed explicitly.
- `pnpm check:design-tokens`, `pnpm check:ui-classes`, `pnpm check:file-size`, and
  `pnpm exec vitest run tests/unit/check-design-tokens.test.ts` pass. Child E also runs
  `pnpm exec vitest run tests/unit/check-ui-classes.test.ts` for package-style discovery.
- For children A–F, the moved selectors retain the same computed visual values at desktop and mobile
  widths. The PR records before/after screenshots from the real browser path; no intentional pixel
  change is accepted under this issue. Child G does not move CSS; it owns the focused failing guard
  fixture and the broad final browser comparison over the accumulated A–F moves.
- No class, component, markup, token value, or user-facing behavior changes.
- The package destination and every source CSS file remain below the 1000-line gate.

Focused browser proof by child:

- **A:** `/today` in light and dark mode, including the newspaper and wellness/loose-ends regions.
- **B:** command palette open in light and dark mode.
- **C:** the embedded assistant surface in light and dark mode, exercised by
  `tests/e2e/assistant-surface.spec.ts`.
- **D:** one form-heavy Settings route in light and dark mode. Specifically inspect equal-specificity
  rules from later tasks/news/sports/settings package sheets because the existing
  `components-forms.css` destination loads before them; use the narrower-import escape hatch if
  computed values would otherwise flip.
- **E:** the Job Search keyline surface plus one full-page texture check, in light and dark mode.
- **F:** auth, desktop app shell, mobile rail, and one content route in light and dark mode.
- **G:** the unlisted failing fixture, a green real-tree guard run, and a broad
  `pnpm capture:screens` comparison in light and dark mode. This is the final proof of the global
  selectors and the accumulated extraction, not a second CSS-editing session.

The work is intended to be visually inert, but the UI-consolidation D6 gate still applies: CSS
movement can change cascade without changing a test assertion, so green static checks alone are not
completion evidence.

### Parent roll-up

- The same origin/main inventory method reports **0 banned declarations across all 30 CSS files under
  `apps/web/src`**.
- A unit fixture creates an unlisted app CSS file with `color` or `background`; guard 4 finds it and
  fails without any registration edit.
- The nine non-web news/sports layout sheets remain measured explicitly.
- `packages/ui` remains excluded from guard 4, and every CSS file below its styles root is discovered
  automatically as `check:ui-classes` definition scope.
- `pnpm verify:foundation` passes under the repository's guarded verification procedure.
- Children A–F contain their focused browser evidence, child G contains its guard regression and
  broad browser evidence, and all seven are merged; only then may #1427 and
  its #1470 checklist item close.

## Non-goals

- No component creation or conversion of class strings to components.
- No redesign, selector rename, token change, typography change, or new visual treatment.
- No repo-wide CSS classifier. Automatic discovery is deliberately limited to `apps/web/src`, where
  every CSS file is a screen/app sheet; package screen sheets keep their existing explicit list.
- No rewrite of guard 4 into a CSS parser and no new dependency. The existing detector is the
  contract this issue is closing coverage around.
- No cleanup of allowed-but-visual properties outside `BANNED_VISUAL_PROPERTIES`; changing the
  locked D2 property set is a separate design decision.

## Risks and stops

- **Cascade drift:** extracted package styles load through an earlier import. Computed-style or
  screenshot drift is a blocker, not permission to tweak values until the picture looks close.
- **Shorthand drift:** moving `border`, `background`, or `font-*` away from related longhands can
  alter the result. Preserve effective order or keep the coupled declarations together in the
  visual destination.
- **Concurrent UI work:** all children touch central CSS. The coordinator collision-gates them and
  does not dispatch a later child until the earlier child is merged.
- **Count growth:** a changed baseline means new work landed in an owned source file. Re-scope the
  child explicitly; do not turn a one-session issue into an open-ended CSS cleanup.
