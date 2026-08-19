# #1395 Settings — build lane relay 2 (2026-08-05)

Epic #1387 "UI consolidation", section 8/9. Repo `motioneso/Jarv1s`. Worktree
`.claude/worktrees/ui-1395-settings`, branch `feat/1395-ui-settings`. Coordinator pane label
"DESIGN ELEMENTS" (resolve fresh via `herdr pane list` — do not trust a stale pane id; confirm
exactly one match before messaging).

Relayed on the context-meter 70% trigger, not compaction. Prior relay doc (superseded, keep for
history only): `docs/superpowers/handoffs/2026-08-05-ui-1395-settings-relay.md`.

## Read first

1. This doc, in full (short by design).
2. Approved plan — `gh api repos/motioneso/Jarv1s/issues/comments/5195260909` — read by section.
3. Coordinator approval (4 binding overrides, wins any conflict with the plan) —
   `gh api repos/motioneso/Jarv1s/issues/comments/5195303202`.
4. D6 change list — `gh api repos/motioneso/Jarv1s/issues/comments/5195097816`.

## The four coordinator overrides (binding)

- Custom property name is **`--st-swatch`**, not `--swatch` (plan text still says `--swatch` in
  decision 5 — the override wins). Do not rename the already-merged `--tk-swatch` (tasks' var).
- `Dialog.className` is layout-only. Card and Button keep `Omit<..., "className">`.
- Do not re-title/re-scope #1416 — only record which importers this PR does/doesn't close.
- Task 2's browser-assertion kill gate is corroboration, not proof (it covers one state
  per section). State this explicitly in the PR body.

## Hard constraints — non-negotiable

- No settings IA changes (#983 owns IA).
- `packages/settings-ui`'s router/scanner/vite/priority half stays untouched — only the
  primitives half (`src/index.tsx:49-165`) is in scope.
- Nothing added to `INLINE_STYLE_EXEMPT_PATHS`.
- `components-forms.css` and `command-palette.css` stay out of scope.
- No `className` prop added to `Card` or `Button`.

## Gate discipline

- `pnpm test:e2e` unpiped: `pnpm test:e2e > /tmp/e2e.log 2>&1; echo "EXIT=$?"`, same commit as the
  conversion it protects.
- Never pipe a gate command through `tail`/`grep`.
- Full gate only against a freshly self-exported gate DB, never live dev DB.
- Guard registration (Task 5) needs red-before/green-after proof on both guards, two real runs.

## Shared-checkout git discipline

Never `git add -A`/`git add .`, never bare `git commit`. `git diff` any co-edited file before
staging. After every commit, `git show --name-only HEAD` and check the file list.

## What's done (commits on this branch, in order)

- `466008fe` — prior relay doc (now superseded by this one).
- `aeaaccba` — **Task 0 complete.** Added `14b-settings-appearance-editor` and
  `14c-settings-delete-dialog` capture blocks to `tests/e2e/capture-screens.spec.ts` (existing
  settings shots are `11-14`; wellness/mobile/sports already own `15-22`, hence the `14b`/`14c`
  sub-letters, matching the file's own `06b`/`10c` convention). Browser assertions ran clean,
  28/28 passed — this is the Task-0 baseline all later diffs compare against.
- `920d508f` — **Task 1 complete.** `ButtonProps.active?: boolean` added
  (`packages/ui/src/button.tsx`), renders `jds-btn--active`. Catalogue regenerated
  (`pnpm build:ui-catalogue`); `OPTIONS.md` line 42 shows it under `button` (not to be confused
  with `icon-button`'s pre-existing `active` at line 95). `check:ui-catalogue` and `pnpm typecheck`
  both green.
- `f19d1517` — **Task 2 complete.** Barrel repoint of 5 primitives (Avatar/Indicator/Segmented/
  Select/Switch) to `@jarv1s/ui`, per coordinator ruling (b) below. Badge/ComingSoon deliberately
  deferred to Task 3.
- `f8d1805b` — this doc, capturing the coordinator's ruling so it isn't re-litigated.

## Task 2 — DONE (commits `f19d1517`, `f8d1805b`). Ruling below for context/Task 3 carry-forward — do not re-litigate.

**Coordinator ruling (received, binding — do not re-open):** Option **(b)**. Full mapping and
reasoning below; treat this section as settled fact, not open discussion.

- **Correction to my own count:** 19 was a *typecheck-error* count (some lines are union types,
  multiplying). The coordinator independently verified the actual **site** count: **10
  `tone="pine"` sites across 7 files** under `apps/web/src/settings/`. **Use 10/7 in the PR body,
  not 19/12.**
- **CSS facts (coordinator-verified, not my claim — treat as ground truth):** `.jds-badge--pine` is
  defined in no CSS file anywhere. `.jds-badge--forest` (`background: var(--forest-soft)`,
  `color: var(--forest-ink)`) and `.jds-badge--solid-pine` (`background: var(--accent)`,
  `color: var(--text-on-accent)`) both exist. Today those 10 badges render with base `.jds-badge`
  only, no tone fill.
- **The mapping is `pine` → `forest`, not `solid-pine`, and it's not a taste call:**
  `packages/settings-ui/src/index.tsx:100` declares `neutral | pine | amber | red | steel`;
  `@jarv1s/ui` declares `neutral | forest | amber | red | steel` — same five-slot soft set, `pine`
  and `forest` occupy the same slot, every member shaped `--X-soft`/`--X-ink`. `solid-pine` is the
  lexically closer name but the *wrong* one: it's an accent-filled treatment, and these are quiet
  status badges ("Active", "Update Available", dot badges) that would start shouting if switched to
  solid. `packages/ui/src/badge.tsx`'s own doc comment already flags "no bare 'pine' tone, see
  #1388 D6 compat mapping" — this was anticipated at foundation; executing it, not inventing it.
- **Scope trap — do not touch `packages/settings-ui/src/index.tsx`.** Its `BadgeTone` keeps `pine`
  verbatim. Its priority half (`priority/index.tsx:203`) still uses `tone="pine"` and is out of
  scope for this issue. **Only** `apps/web/src/settings/*` call sites get renamed. State this
  explicitly in the PR body — it's the trap that would otherwise break the priority half.
- **Why (b) not (a):** Task 2's entire value is being a pure repoint with zero visual change; the
  byte-identical capture is the one clean signal proving that. Folding a colour fix into it
  destroys that signal for one commit's convenience. Repoint
  `Avatar`/`Indicator`/`Segmented`/`Select`/`Switch` now; let `Badge`/`ComingSoon` keep coming from
  the `export *` (explicit named exports shadow the star, so omitting `Badge` from the explicit
  list is mechanically correct — no separate re-export needed to "keep" it). Badge + the tone
  rename lands in **Task 3** as its own commit with its own review.
- **Kill-gate clarification (binding, applies for the rest of this build):** a pixel delta from a
  **named, understood cause** is not a trip — the plan approval already ruled capture diff is
  corroboration, not proof. The gate exists to catch **unexplained** deltas. Stopping to ask here
  was correct; going forward, an *explained* delta gets reported with its cause in the commit/PR
  body and the build continues — it does not halt for another escalation.
- **PR-body framing (use this, don't invent your own):** "10 badges that were specified with a tone
  and have been rendering untoned since the tone class never existed now render their intended
  forest tone. That is a bug fix with a visible result, not a redesign."

**What actually happened (done, in this order):**

1. Trimmed `apps/web/src/settings/settings-ui.tsx` to:
   ```tsx
   export { Avatar, Indicator, Segmented, Select, Switch } from "@jarv1s/ui";
   export * from "@jarv1s/settings-ui";
   ```
2. `cd apps/web && npx tsc --noEmit` → `EXIT=0` (direct form, not the chained script — the chained
   `pnpm typecheck` swallows all but 1 error; always use the direct form to get a true count for
   settings-scoped changes).
3. `grep -rln '@jarv1s/settings-ui' apps/web/src/settings/` → only `settings-ui.tsx` itself. No
   other settings file imports the package directly; the barrel is the sole seam.
4. Focused browser assertions → green, no failures, both Task-0 states included. Treat the clean
   28/28 run as corroboration only; do not claim broader visual equivalence.
5. Committed `f19d1517` (barrel trim) and `f8d1805b` (this doc, ruling captured). Task 2 complete.

**Carry into Task 3's plan:** Badge conversion must include renaming all 10 `tone="pine"` sites in
`apps/web/src/settings/*` to `tone="forest"`, scoped to exactly those files (not
`packages/settings-ui`), landed as its own commit with the PR-body framing above.

## Tasks 3-7 — not started, full detail in plan comment `5195260909` (read by task, not all at once)

**Start here.** Task 3 is the next unstarted work. Summarized below — still accurate (Task 2 is
now done, see above). Key points to carry forward:

- **Task 3**: Convert `jds-btn`(312)/`jds-dialog`(30)/`jds-badge`(7)/`jds-iconbtn`(4)/
  `jds-segmented`(2) to components, split 2-3 commits by pane cluster. `Dialog.className`
  (layout-only) for `terminal-modal.tsx` and `delete-account.tsx`. Preserve `terminal-modal.tsx`'s
  `isLive` scrim-close guard and `settings-feedback.tsx`'s `aria-labelledby` contract. Guard-6
  burn-down: 5 static inline-style props → CSS classes, 2 swatch sites →
  `style={{["--st-swatch"]: value}}` (not `--swatch` — coordinator override).
- **Task 4**: CSS split (wellness pattern) into `components-settings-1.css`/`-2.css`(/`-3.css` if
  over 1000 lines), imported at end of `packages/ui/src/styles.css` after `components-tasks.css`.
  Delete dead selectors diffed against base commit `a027995a` (moved ≠ deleted). Property-by-
  property split check: zero shared CSS properties between old layout file and new destination.
- **Task 5**: Register 4 new CSS files + 31 tsx files in the guard lists; add `--st-swatch` to
  `check-design-tokens.ts`'s `allowList`, scoped to settings paths. Baseline (merged,
  pre-this-PR): `MIGRATED_SECTION_CSS_FILES` 14, `MIGRATED_SECTION_PATHS` 56 — target is a
  **delta** of +4/+31 off that baseline (absolute 18/87). Prove red-before/green-after, two runs.
- **Task 6**: Fix e2e breakage same-commit as the conversion that caused it. Hotspots:
  `settings-modules.spec.ts:54`, `external-modules.spec.ts:40` (`label.jds-switch`),
  `settings-shell.spec.ts`, `settings-notes-people.spec.ts`, `connect-google.spec.ts`,
  `sports-settings.spec.ts`, `app-shell.spec.ts:37`. `pnpm test:e2e` unpiped, `EXIT=0`.
- **Task 7 (wrap-up)**: all `check:*` scripts unpiped `EXIT=0`, full gate on fresh gate DB,
  browser assertion diff vs Task-0 baseline, banned-decl 237/232/174/60 → 0/0/0/0, live-path proof
  on a throwaway dev preview (never prod/10.252), PR opened (not merged, don't close #1395) with
  full evidence per the original relay doc's Task 7 detail, plus the `#1416` factual comment and
  a note on #1416 itself. Report PR + evidence to coordinator (DESIGN ELEMENTS), not Ben.

## Coordinator contact

Two messages sent to "DESIGN ELEMENTS" before this doc's first version: the Task 2 blocker/
options, then the relay notice. The coordinator replied with the full ruling captured above
(delivered mid-relay, before a successor was spawned — this session applied it directly rather
than leaving it for the successor to pick up cold). **The successor still owes the coordinator a
short confirmation** that it has read this doc and the ruling is understood, per the coordinator's
explicit "confirm the successor picked this up" instruction — send that confirmation as your first
action after re-resolving the "DESIGN ELEMENTS" pane fresh via `herdr pane list`, before starting
Task 3.

## Relay trigger note

Fired on the context-meter 70% PostToolUse warning, mid-Task-2 (during blocker escalation). No
compaction summary seen. The coordinator's ruling arrived mid-relay-prep and was applied in the
same session before spawning a successor — Task 2 is fully done, not just ruled. Successor should
NOT re-read the full plan comment — only the Task 3 section above, and the plan comment's Task 3
detail by subsection as needed.
