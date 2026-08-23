# Relay: #1497 / #1427-A — Today CSS residue

Worktree: `~/Jarv1s/.claude/worktrees/1497-today-residue`, branch `build/1497-today-residue`
(already off current `origin/main`, clean tree — nothing committed yet, no source edits made).
Handoff doc: `docs/coordination/handoff-1497-today-residue.md` (do not edit that file — read only).
Spec: `docs/superpowers/specs/2026-08-10-css-guard-residue.md`, Child A row (table around line 141)
and the per-child contract (lines 152-203). Coordinator agent name: `coordinator` (resolve fresh —
it has already relayed once this run). GitHub issue: **#1497**, title
`[#1427-A] Extract Today residue into @moss/ui and register its layout sheets`.

## Where this stands

No plan file written yet, no code changed. This is a pre-plan research handoff — the previous
session spent its budget confirming facts so the plan can be written in one pass. Follow
`coordinated-build` (already invoked once, no need to re-read the whole skill, just resume at
step 1 "Plan").

## Decided already — do not re-litigate

**The baseline is 152, not the spec's 147.** The three Today style sheets currently carry 152
banned visual declarations, not the 147 the spec recorded when it was written. This was checked
and escalated properly: the coordinator ran it through Fable (the plan-authority for this kind of
scope question) and got a ruling back: build to 152 -> 0. The extra 5 came from an unrelated CSS
fix (#1594) that landed after the spec was written, and the acceptance target is "these three
files reach zero", not a fixed number — so the extra 5 are in scope. This is recorded as a comment
on issue #1497 already. **Do not re-measure-and-escalate this again** — just use 152 as the
starting count in the plan.

Verified by running the design-token guard directly against the three files (script only, not
piped, exit code captured properly — this is how to re-verify if the count ever needs checking
again):

```
apps/web/src/styles/kit-today.css: 34 violations
apps/web/src/styles/kit-today-feeds.css: 25 violations
apps/web/src/styles/kit-today-misc.css: 93 violations
total: 152
```

## The three files to move things out of

All fully read already — a fresh session can read them again to write the plan, no surprises
expected:

- `apps/web/src/styles/kit-today.css` (189 lines) — masthead/command-center rail, "walking the
  day" meeting list.
- `apps/web/src/styles/kit-today-feeds.css` (122 lines) — loose-ends action rows, the wellness
  rail card.
- `apps/web/src/styles/kit-today-misc.css` (329 lines) — the newspaper layout (sports/news hero
  and list rows), overnight changes, agenda-clear empty state, wellness meds card, briefing
  freshness list.

All three are imported directly by the Today page component, not through the shared style entry
file: `apps/web/src/today/today-page.tsx` lines 86-88. This matters for the plan: they load
**after** the whole `@moss/ui` package bundle (which loads once, globally, in
`apps/web/src/styles/index.css` line 10), so moving declarations into the package sheet does not
change which file's declaration wins for any *shared* selector — but see the `font: inherit` trap
below, which is the one place order does bite.

## Where things move to — already exists, already wired in

`packages/ui/src/styles/components-moss-today.css` **already exists** (282 lines) and is
**already imported** at `packages/ui/src/styles.css` line 3. It currently holds masthead/stat-tile/
agenda-row/card-header/menu/weather-chip primitives (all `.jds-*` classes, unrelated to the
Today-specific classes this task moves). The plan should **append** to this existing file, in the
same "move only the banned declarations, keep the selector, preserve the layout half at its
current path" pattern already used and proven by the command-palette move — read
`apps/web/src/styles/command-palette.css` (layout, post-move) next to
`packages/ui/src/styles/components-command-palette.css` (visual half) for the exact shape to copy.
Same selector appears in both files; each file owns a disjoint set of properties on it.

None of the Today classes being moved are `jds-*` — they're screen-local classes
(`.today-feedback`, `.cmd-next`, `.well`, `.np-hero`, etc.), same as the command-palette's
`.kbar-*` classes were. Confirmed used only in
`apps/web/src/today/{briefing-action-rows,briefing-feedback-menu,news-desk,proactive-cards,today-page}.tsx`
— no rename needed, no other consumer.

## The one real trap: `font: inherit` at kit-today.css line 25

The per-child contract explicitly calls this out: "Child A also moves the coupled
`.today-feedback__status button { font: inherit; }`." Here's *why*, worked out already so the
plan doesn't have to re-derive it: `font` is a shorthand that resets `font-family`/`font-size`/
`font-weight`/`line-height` all at once. The rule at kit-today.css:22-30 has `font: inherit`
sitting in the same block as `font-size: 11px` (banned, moving) and `color`/`border`/`background`
(also banned, moving). If `font: inherit` were left behind in the app file while `font-size: 11px`
moves to the package file, the app file's `font: inherit` — evaluated later in the effective
cascade, since `kit-today.css` loads after the whole package bundle — would silently wipe out the
package file's `font-size: 11px` back to inherited. So `font: inherit` must move to the package
file **in the same rule** as the properties it would otherwise clobber. Same idiom child F will
need later for `button.module-link { font: inherit; }` in `apps/web/src/styles.css` — not this
child's problem, just confirms the pattern is real and repeats.

## Registration (contract step 4)

`scripts/check-design-tokens.ts`, `MIGRATED_SECTION_CSS_FILES` array (starts line 89) already has
entries through child E (`components-keyline.css`, `texture.css` at the tail, lines 130-132) —
children B, C, D, E have all already merged. Append the three Today app files after that, same
comment style as the existing E entry: something like
`// #1427-A: Today residue, moved to packages/ui/src/styles/components-moss-today.css.` then the
three `apps/web/src/styles/kit-today*.css` paths.

## UAT / browser proof

Spec requires (line 187): "/today in light and dark mode, including the newspaper and
wellness/loose-ends regions." Precedent for a no-mock, real-login UAT spec against the live dev
instance: `tests/uat/specs/1112-today-masthead-oneline.uat.spec.ts` — logs in for real, no fixture
mocking, reads `JARVIS_UAT_BASE_URL`. Theme switching is real, driven by
`apps/web/src/shell/app-shell.tsx` (`data-theme` attribute, around line 285) and set via the
Settings appearance pane (`apps/web/src/settings/settings-appearance-pane.tsx`) — the plan should
route through that real UI control to flip light/dark, not fake the attribute. Check
`.claude/skills/coordinate/uat-trigger-map.tsv` — add a row for the new spec covering
`apps/web/src/today/**` and the three CSS files, in the same PR that adds the spec (the file
explains why at its own header).

## Gates to run (never piped, capture exit code)

`pnpm check:design-tokens`, `pnpm check:ui-classes`, `pnpm check:file-size`,
`pnpm exec vitest run tests/unit/check-design-tokens.test.ts`. File-size gate is 1000 lines
(`scripts/check-file-size.ts` line 6) — no file here is anywhere close, not a real risk.

## Next concrete step for whoever picks this up

1. Skip `pnpm install` — `node_modules` already present in this worktree.
2. Re-read Child A's spec section only (table + per-child contract + acceptance, already cited
   above by line number — no need to read the whole spec file).
3. Write the plan at `docs/superpowers/plans/2026-08-23-1497-today-css-residue.md` following the
   shape of `docs/superpowers/plans/2026-08-22-1501-css-keyline-texture.md` (a sibling child's
   plan for this same spec — good template for the seams-check / task breakdown / verification /
   kill-gate sections).
4. Message the coordinator with the plan pointer and **wait** for approval before touching code
   — same one-shot Fable-approval gate as the baseline question above.
5. Build, verify, live-path proof, PR, `coordinated-wrap-up`. Do not merge, do not touch
   `docs/coordination/`, do not touch the project board.
