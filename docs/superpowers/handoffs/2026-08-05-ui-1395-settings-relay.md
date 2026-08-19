# #1395 Settings — build lane relay (2026-08-05)

Epic #1387 "UI consolidation", section 8/9. Repo `motioneso/Jarv1s`. Worktree
`.claude/worktrees/ui-1395-settings`, branch `feat/1395-ui-settings`. Coordinator pane label
"DESIGN ELEMENTS" (resolve fresh via `herdr pane list` — do not trust a stale pane id).

## Read these three, in this order, before doing anything else

1. Approved plan — `gh api repos/motioneso/Jarv1s/issues/comments/5195260909`
2. Coordinator approval (overrides the plan in 4 places — approval wins any conflict) —
   `gh api repos/motioneso/Jarv1s/issues/comments/5195303202`
3. D6 change list the plan was built against —
   `gh api repos/motioneso/Jarv1s/issues/comments/5195097816`

Read them by section as needed for the task at hand — do not re-read all three in full, that's
what bloated this session's context before any code landed.

## The four coordinator overrides (binding, already reflected below)

- Custom property name is **`--st-swatch`**, not `--swatch`. Do **not** rename the already-merged
  `--tk-swatch` (tasks' swatch var) — separate section, separate var.
- `Dialog.className` is **layout-only** (sizing, max-height, overflow, flex, animation). Card and
  Button keep their existing `Omit<..., "className">`.
- Do not re-title or re-scope #1416 (duplicate `Select`) — only record the fact of which
  importers this PR does/doesn't close, in the PR body and a comment on #1416.
- Task 2's capture-diff kill gate is **corroboration, not proof** (per coordinator ruling —
  browser assertions cover one state per section and not every primitive — state this
  explicitly in the PR body. Also add a **second** Task 0 baseline capture covering a **dialog**
  (delete-account), not just the appearance/theme-editor capture.

## Hard constraints — non-negotiable

- No settings information-architecture changes (#983 owns IA; dormant but this build proceeds
  anyway per D6 correction 3).
- Do not touch `packages/settings-ui`'s router/scanner/vite/priority half — only its primitives
  half (`src/index.tsx:49-165`) is in scope.
- Nothing added to `INLINE_STYLE_EXEMPT_PATHS`.
- `components-forms.css` and `command-palette.css` stay out of scope.
- No `className` prop added to `Card` or `Button`.

## Gate discipline

- `pnpm test:e2e` runs separately and unpiped: `pnpm test:e2e > /tmp/e2e.log 2>&1; echo "EXIT=$?"`
  — in the **same commit** as the conversions it protects. Grep `tests/e2e` first for assertions
  keyed to converted controls (known hotspots below).
- Never pipe a gate command through `tail`/`grep` — the pipe's exit code masks a red gate as green.
- Full gate (`scripts/run-gate.sh` / `pnpm verify:foundation`) only against a **freshly created gate
  DB you export yourself** — never the live dev DB (a July 2026 unscoped run took chat down for 90
  min). `verify:foundation` excludes `test:e2e`; CI's `Verify foundation and app` runs the browser
  suite where the local gate does not — say so in the PR body.
- Guard registration (Task 5) must be proven **red-before / green-after** on both
  `check:design-tokens` and `check:migrated-sections` — not a single green observation. Both guards
  silently `catch { continue }` on unreadable paths, so a typo'd entry still reads green.

## Shared-checkout git discipline

Never `git add -A` / `git add .`, never bare `git commit` — always explicit paths. `git diff`
any co-edited file before staging it (this worktree may be shared). After every commit,
`git show --name-only HEAD` and check the file list is exactly what you intended.

## What's done (Task 0, partially)

- Merge: fast-forwarded to `a027995a` (#1393 Tasks+Notifications merged, PR #1417). **No real
  conflict** — `packages/ui/src/styles.css`'s import list needed no union-resolution; the plan's
  contingency for that turned out unnecessary.
- Confirmed `Dialog`'s `className` prop exists and behaves as the coordinator ruling requires —
  `packages/ui/src/dialog.tsx:11,23`: `className={props.className ? \`jds-dialog ${props.className}\` : "jds-dialog"}`
  (extra class appended, not replacing `jds-dialog`).
- Recomputed guard baseline against the merged base (line-anchored `awk`/`grep -c`, not a JS
  regex — a regex attempt undercounted by matching the TS type-annotation bracket instead of the
  array literal's own `[`):
  - `MIGRATED_SECTION_CSS_FILES` (`scripts/check-design-tokens.ts`): **14** entries.
  - `MIGRATED_SECTION_PATHS` (`scripts/check-migrated-sections.ts`): **56** entries.
  - Matches the plan/approval's stated merged-base numbers exactly.
  - #1394 Modules is still in flight and will land its own entries after this PR — state Task 5's
    target as a **delta**: **+4 CSS / +31 TSX** off this 14/56 baseline, next to the recomputed
    absolute (18/87) in the PR body.

## What's NOT done yet — resume here

**Task 0 remainder** (do this first):

1. Add two new capture test blocks to `tests/e2e/capture-screens.spec.ts` (existing settings test
   is at ~lines 260-290, `test("capture: settings (profile, connected accounts, AI)")` with shots
   `11-settings-profile`, `12-settings-connected`, `13-settings-ai`, `14-settings-people`; helpers
   `baseState` at line 44, `shot` at line 80 — grep the file fresh, don't trust these line numbers
   after edits accumulate):
   - **Appearance / theme editor**: navigate to Settings → Appearance (`AppearancePane`, nav id
     `"appearance"`, one click, no sub-nav — `apps/web/src/settings/settings-page.tsx:139-144`),
     click "New theme" button (`apps/web/src/settings/settings-appearance-pane.tsx:156-170`) to open
     the theme editor (`Group title="Editor"`, lines 222-352), shot it. Use the next free shot
     number (grep all `shot(page, "...")` calls in the file first — do not reuse `11`-`14`, e.g. use
     `15-settings-appearance-editor` if free).
   - **Dialog**: from the already-captured default profile view (`11-settings-profile` —
     `DeleteAccount` is rendered inside `ProfilePane`/`settings-personal-panes.tsx:310`), click the
     "Delete account" button (`apps/web/src/settings/delete-account.tsx:106-116`, sets `open` state
     true, zero extra navigation needed) to render the `deldlg` dialog, shot it (e.g.
     `16-settings-delete-dialog`). Close it after (click Cancel / backdrop) so later tests in the
     file aren't left with an open dialog if state leaks — check whether the existing test pattern
     already isolates page state per test (likely yes, via `baseState`).
2. Run focused browser assertions to establish the Task-0 **baseline** (before any Task 3
   conversions land) — these become the "before" shots that Task 2/Task 7's diffs compare against.
3. Mark Task 0 complete, move to Task 1.

**Tasks 1-7** (full detail in the approved plan comment `5195260909` — read Task-by-task, not all
at once):

- **Task 1**: `ButtonProps.active?: boolean` in `packages/ui/src/button.tsx` → renders
  `jds-btn--active`. Regenerate catalogue (`pnpm build:ui-catalogue`), confirm `check:ui-catalogue`
  green and `OPTIONS.md` shows the flag.
- **Task 2**: Repoint `apps/web/src/settings/settings-ui.tsx` to explicit named re-exports of
  Avatar/Badge/ComingSoon/Indicator/Segmented/Select/Switch + `BadgeTone` type from `@jarv1s/ui`
  (ES module semantics: explicit named exports win over the existing `export * from
  "@jarv1s/settings-ui"` star-export for the same name — don't delete the star-export, 6 module
  packages + `task-details-dialog.tsx` still use `@jarv1s/settings-ui` primitives directly). Verify
  `pnpm typecheck` exit 0, grep confirms no settings pane imports `@jarv1s/settings-ui` directly,
  diff browser assertion results vs the Task-0 baseline (expect identical values —
  **note in the PR this is corroboration not proof**, per the coordinator ruling above).
- **Task 3**: Convert `jds-btn` (312 refs across 26 files) → `<Button>`, `jds-dialog` (30) →
  `<Dialog>`, `jds-badge` (7), `jds-iconbtn` (4), `jds-segmented` (2). `Dialog.className` (layout
  only) for `terminal-modal.tsx`'s `terminal-modal` class and `delete-account.tsx`'s `deldlg`
  class (confirmed present at `delete-account.tsx:129`). Preserve `terminal-modal.tsx`'s `isLive`
  scrim-close guard (move into the `onClose` callback) and `settings-feedback.tsx`'s
  `aria-labelledby` accessible-name contract (Dialog takes `aria-labelledby`, not `aria-label` —
  note `delete-account.tsx` currently uses `aria-label` directly on the raw `jds-dialog`, line 132,
  so check whether that file is in-scope for the `aria-labelledby` contract or is a separate case).
  Guard-6 burn-down: 5 static inline-style props → CSS classes, plus the 2 swatch sites at
  `settings-appearance-pane.tsx:286` and `:318` → `style={{["--st-swatch"]: value}}` consumed by a
  new `.theme-swatch { background: var(--st-swatch); }` CSS rule. Split into 2-3 commits by pane
  cluster.
- **Task 4**: CSS split (wellness/#1392 pattern) — visual halves of `settings.css`/
  `settings-panes.css` → `packages/ui/src/styles/components-settings-1.css`;
  `settings-panes-2.css`/`settings-panes-3.css` → `components-settings-2.css` (split to `-3` if
  over the 1000-line file-size gate). Import both at the end of `packages/ui/src/styles.css`
  (current last line is `components-tasks.css` — append after it, preserve source order). Delete
  dead selectors that only restyled `jds-btn`/`jds-dialog`, diffed against the **base commit**
  (`a027995a`) — a moved selector reads as a deletion, a known trap. Run the property-by-property
  split check: zero shared CSS properties between old layout file and new component-CSS
  destination.
- **Task 5**: Register the 4 new settings CSS files in `MIGRATED_SECTION_CSS_FILES` and all 31
  settings tsx files in `MIGRATED_SECTION_PATHS`; add `--st-swatch` (not `--swatch`) to
  `check-design-tokens.ts`'s `allowList`, regex-scoped to settings paths (do not touch
  `--tk-swatch`). **Prove it**: run both guards red (before registering, with Task 3's real
  conversions already landed) and green (after registering) — two actual runs, not one green
  observation.
- **Task 6**: Grep `tests/e2e` for assertions keyed to converted controls — known hotspots:
  `settings-modules.spec.ts:54`, `external-modules.spec.ts:40` (`label.jds-switch`),
  `settings-shell.spec.ts`, `settings-notes-people.spec.ts`, `connect-google.spec.ts`,
  `sports-settings.spec.ts`, `app-shell.spec.ts:37`. Fix breakage in the **same commit** as the
  conversion that caused it. Run `pnpm test:e2e > /tmp/e2e.log 2>&1; echo "EXIT=$?"` unpiped,
  expect `EXIT=0`.
- **Task 7 (wrap-up)**: `check:design-tokens`, `check:ui-classes`, `check:migrated-sections`,
  `check:ui-catalogue` each unpiped, `EXIT=0`. Full gate via `scripts/run-gate.sh` against a
  fresh self-exported gate DB. Browser assertion diff vs Task-0 baseline
  byte-identical; blast-radius shots show nothing beyond known live-clock noise). Banned-decl
  count 237/232/174/60 → 0/0/0/0 across the 4 settings CSS files. Live-path proof on a throwaway
  dev preview (**never** prod / 10.252): sign in, toggle a switch and confirm persistence, open
  provider-login and delete-account dialogs (render + close + terminal `isLive` guard), assign a
  theme swatch color, exercise a converted people-pane button end-to-end. Open the PR (**do not
  merge**, **do not close #1395**) with: per-file banned-decl before/after, split-check numbers,
  dead-selector burn-down vs base, capture diff (with the corroboration-not-proof caveat), guard
  counts as delta (+4/+31) *and* recomputed absolute (18/87), live-path record, a release-note
  line, the CI-runs-e2e-locally-doesn't note, and the #1416 factual note (which importers this PR
  does/doesn't close — also comment that fact on #1416 itself). Report the PR + evidence to the
  coordinator (DESIGN ELEMENTS pane) — not to Ben.

## Coordinator contact

Already sent a status/relay notice to pane label "DESIGN ELEMENTS" via
`herdr agent prompt "<resolved-pane-id>" "<message>"` (resolved fresh via `herdr pane list` at
send time — do not reuse any pane id from this doc, it reflows). At last check the coordinator
pane was mid-auto-compaction (78%) so the message is queued, not yet acted on — no reply expected
yet. On waking, re-resolve the coordinator's pane by label + confirm exactly one match before
sending anything further.

## Relay trigger note

This relay fired on the **compaction tripwire** (a compaction summary appeared in-session), not
the 70% meter warning — relay immediately per the skill, no further work in the old session.
