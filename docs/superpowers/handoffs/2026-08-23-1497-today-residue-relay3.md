# Relay: #1497 / #1427-A — Today CSS residue (relay 3)

Worktree: `~/Jarv1s/.claude/worktrees/1497-today-residue`, branch `build/1497-today-residue`.
Coordinator approved the plan (`docs/superpowers/plans/2026-08-23-1497-today-css-residue.md`)
as-is. Tasks 1-4 are built and committed. Only Task 5 (browser proof + UAT + PR) is left.

## Where this stands

Commits on this branch, newest first:
- `546873b1c` task 4 — registered the three files in `MIGRATED_SECTION_CSS_FILES`
- `b7f01d833` task 3 — kit-today-misc.css extraction (93 declarations)
- `8a1186a58` task 2 — kit-today-feeds.css extraction (25 declarations)
- `dceeb2586` task 1 — kit-today.css extraction (34 declarations)

All four `pnpm check:*` gates plus the fixture unit test already passed in this session
(design-tokens, ui-classes, file-size, `tests/unit/check-design-tokens.test.ts` — all green).
The banned-property guard (`checkBannedProperties` called directly with the three file paths)
returns 0, down from the 152 baseline. Nothing left to move; this is pure verification +
proof from here.

**One deviation from the plan worth knowing, not a blocker:** the plan's prose said "no rule
becomes empty," but a number of selectors across the three files (13 total: `.day-ev__t .ap` in
task 1; `.well__line b` and `.well__btn:hover` in task 2; 12 more in task 3 — state-color
modifiers like `.np-row__out.w/.d/.news`, `.np-row__lead.crest/.src`, `.bfresh__age--live`, etc.)
had *no* non-banned property left once the banned ones moved. Every one of those app-file rules
was pure decoration with nothing else in it, so the empty rule was deleted from the app file
rather than left as dead braces — the class stays in the markup and gets its full styling from
the moved rule in the package file. Checked TSX usage for the first case (`.ap` span in
`today-page.tsx` / `evening-mode.tsx`) before doing this; the same reasoning applies to the rest
since they're all single-purpose color/font modifiers. Every commit message documents which rules
this happened to. If the coordinator wants this called out explicitly on the PR, it already is in
the per-task commit bodies — just link them.

## Next concrete step for whoever picks this up

1. Do Task 5 exactly as the plan describes it (see the plan file's "Task 5 — browser proof"
   section): on the dev instance (`http://192.168.50.36:5173`, never `:1533`), open `/today`,
   screenshot the affected regions in light and dark mode (switch via the real Settings
   appearance pane, not a forced attribute), and confirm pixel-identical rendering to before this
   branch. Screenshots to disk, compare cropped regions only — never pull a full-page image into
   context.
2. Add the UAT spec `tests/uat/specs/1497-today-css-residue.uat.spec.ts` following the pattern in
   `tests/uat/specs/1112-today-masthead-oneline.uat.spec.ts`. Add a row to
   `.claude/skills/coordinate/uat-trigger-map.tsv` for `apps/web/src/today/**` plus the three CSS
   files, same PR.
3. Full gate via the `verify-gate` skill (never bare) before opening the PR.
4. Release note: `Category: N/A` per the plan (visually inert, nothing user-facing changed).
5. Open the PR with the live-path proof recorded (screenshots + UAT run exit code/output), per
   `coordinated-wrap-up`. Do not merge, touch the board, or touch `docs/coordination/`. Report
   completion to the coordinator (`herdr agent list` to re-resolve its pane, it was `w1:pPR`
   as of this relay but may have moved).

## Skip

- `pnpm install` — `node_modules` already present.
- Re-planning, re-reading the plan for line numbers, or re-verifying tasks 1-4 — they're done,
  committed, and gate-clean. Only Task 5 remains.
- Waiting for further coordinator sign-off on the plan itself — that already happened and covered
  the whole build, not just tasks 1-4.
