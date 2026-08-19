# #1395 Settings relay 10 → done (Tasks 5, 6, 7 complete, PR open)

Per the coordinator's explicit instruction: this relay does NOT self-spawn a successor. Tasks 5-7
are complete. **PR #1420 is open, not merged, #1395 not closed.** The coordinator holds the merge
for a live-path walk.

## What happened this relay

**Task 5 (guard registration)** — committed `56422945`. Registered settings into all three #1387
guards:
- `check-design-tokens.ts` `MIGRATED_SECTION_CSS_FILES`: 23 → 27 (+4 layout-only settings CSS files)
- `check-ui-classes.ts` `DEFINITION_FILES`: 30 → 32 (+2 new visual CSS files —
  `components-settings-{1,2}.css`)
- `check-migrated-sections.ts` `MIGRATED_SECTION_PATHS`: 59 → 86 (+27 settings TSX files)

Real counts differ from the coordinator's rough +4/+31 estimate (which was explicitly flagged
unverified): landed at +4 CSS / **+27 TSX**, not +31. Verified via `git diff --stat
origin/main...feat/1395-ui-settings -- '*.tsx'`, excluding `packages/ui/` and `packages/settings-ui/`
(#983's territory, same treatment #1394 gave sports' CSS-only files).

**Also discovered stale**: the coordinator's brief said `check-ui-classes.test.ts` holds a second
hardcoded `DEFINITION_FILES` list that would ENOENT if only the script were edited. Checked — not
true in the current tree. The test already imports `DEFINITION_FILES` directly from the script, with
a comment citing #1393 as having fixed exactly this drift. No edit needed; skipped it.

Both required proofs done for all three guards: red-before/green-after on an injected violation, and
every added path (27 + 32 + 86) confirmed to resolve to a real file on disk.

**Task 6 (e2e)** — grepped every settings-adjacent e2e spec for class-based selectors that could
have moved in the split (`label.jds-switch`, `.set-row__desc`, `.gflow__title`, `.vroot`,
`.vault__path`, `.set-row__control`, `.pane__cardtitle`) — all confirmed still present, unchanged.
Ran `pnpm test:e2e` unpiped, separate from the gate: **90 passed, 28 skipped, 0 failed**, exit 0.

**Task 7 (gate + PR)** — used the `verify-gate` skill throughout (fresh `GATEDB` export each run,
unpiped with a `### FINAL rc=` sentinel, dropped the gate DB after). First run failed on
`format:check` (prettier) — 4 pre-existing settings files
(`settings-activity-pane.tsx`, `settings-admin-panes.tsx`, `settings-provider-login-dialog.tsx`,
`settings-voice-config-group.tsx`) had drifted out of format, unrelated to Task 5's edits. Fixed with
`prettier --write` on exactly those 4 files (whitespace/JSX-wrap only, reviewed diff, no logic
changes), committed as `9092827f`. Re-ran on a fresh gate DB: **green** — 181 test files / 1841
tests passed, 2 skipped.

Pushed the branch (`git push -u origin feat/1395-ui-settings` — first push, branch had no upstream
yet) and opened **PR #1420** with the coordinator's required body: 198/0 split-check numbers with
the 198-vs-199 normalization-difference honesty note, 1851/1851/0/0 loss-conservation numbers, the
CI-vs-local-gate e2e caveat, the browser-assertions-are-corroboration caveat, and the #1416
disposition. Also posted the #1416 disposition as a separate factual comment
(https://github.com/motioneso/Jarv1s/issues/1416#issuecomment-5197272363): confirmed
`apps/web/src/settings` sources `Select` from `@jarv1s/ui` via its local `settings-ui.tsx` barrel,
never from the duplicated `@jarv1s/settings-ui` — this PR was never one of #1416's importers, did
not re-scope the issue.

**Did not merge the PR, did not close #1395**, per the coordinator's explicit instruction — holding
for their live-path walk.

## Mid-relay correction from the coordinator

The coordinator corrected their own brief: use the project-local `verify-gate` (and
`shared-checkout`, `design-system`) skills as the authoritative procedure, not the inline gate prose
in the brief or in relay 7/8/9's docs — those skills are newer. This relay had already invoked
`verify-gate` before the correction landed, so no rework was needed. Relay 9 flagged this and was
right, per the coordinator.

## Reporting mechanism fix (read this before messaging the coordinator)

The coordinator flagged that `herdr agent prompt` with a long message lands in their pane as
`[Pasted text #N]` and does **not** submit — a prior relay's report reached them only because Ben
relayed it by hand. Verify every send:

1. `herdr agent prompt <target> <text>`
2. `herdr pane read w1:p1 --source recent --lines 8` (bounded — `recent`, not `visible`)
3. If the composer shows `[Pasted text #N]` (not empty, not the coordinator's own queued text): run
   `herdr pane send-keys w1:p1 Enter` and re-read. Repeat until empty. Two Enters is normal for a
   long message.
4. If it shows the coordinator's own text queued, that's delivered — do not resend.

Keep the actual report short enough to fit one screen; put detail in the PR body and this doc, not
the message.

## Nothing left for a successor on Tasks 5-7

All three tasks are done, committed, and gate/e2e-green. The only remaining epic-level work is the
coordinator's live-path walk-through of PR #1420, and their own merge/close decision afterward. If a
successor is spawned, its job is whatever the coordinator assigns next (likely: support the
live-path walk, or start a different section) — not to redo Tasks 5-7.

## Binding rulings — unchanged, still apply if anyone touches this branch again

`--st-swatch` not `--swatch`. `Dialog.className` layout-only. No settings IA changes (#983's
territory). `forms.css` and `command-palette.css` out of scope. `INLINE_STYLE_EXEMPT_PATHS` off
limits. The two `jds-dialog` hits in comments (`terminal-modal.tsx:32`, `settings-feedback.tsx:18`)
are legal, don't touch. Don't re-scope #1416 (disposition comment already posted, see above).

## Commits this relay

- `56422945` — Task 5 guard registration
- `9092827f` — prettier formatting fix (gate format:check)

HEAD is `9092827f`. Branch pushed, upstream set. PR: https://github.com/motioneso/Jarv1s/pull/1420
