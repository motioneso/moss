# #1395 Settings relay 7 → 8 handoff

Context-meter checkpoint at 74%. Tree clean except this doc. HEAD `0012dea8`.

## Read order

1. This doc
2. `gh api repos/motioneso/Jarv1s/issues/comments/5195260909 --jq .body` (plan)
3. `gh api repos/motioneso/Jarv1s/issues/comments/5195303202 --jq .body` (approval — wins on conflict)
4. Coordinator's mid-relay-7 message (not a GitHub comment — read it in this session's transcript
   if resumed via herdr-handoff continuation; otherwise ask the coordinator, pane "DESIGN ELEMENTS"
   w1:p1, to restate it). It corrected/confirmed: guard 6 = `checkInlineStyleProperties()` inside
   `scripts/check-migrated-sections.ts` (NOT a separate script — older notes conflating "guard 6"
   with guard 4/`check-design-tokens.ts` are wrong, always read the script); `opacity` is not
   banned; `INLINE_STYLE_EXEMPT_PATHS` is off-limits; the two `jds-dialog` hits in
   `terminal-modal.tsx`/`settings-feedback.tsx` are inside comments and legal (guard 5 strips
   comments first) — do not "fix" them; Task 3d/guard-5 is confirmed fully clean by the coordinator
   independently.

## Done: Tasks 0-3e

Tasks 0-3d: see relay-5/6 docs, unchanged.

**Task 3e (guard-6 inline-style burn-down), this session, commit `0012dea8` (8 files):**

The guard is `checkInlineStyleProperties()` in `scripts/check-migrated-sections.ts` — flags any
`style={{...}}` property that's in `BANNED_INLINE_STYLE_PROPERTIES` (camelCased
`BANNED_VISUAL_PROPERTIES` from `check-design-tokens.ts`). It only scans paths in
`MIGRATED_SECTION_PATHS`, which does **not yet include settings** (that's Task 5). I verified the
7 sites directly by calling `checkRawClasses`/`checkInlineStyleProperties` with the 31-file settings
list passed as the override param (both accept `migratedPaths` as a second arg) — see the ad-hoc
script pattern, now deleted, or just re-run the same call. Result: **0/0 violations**, confirming
both guard 5 (still, post-3d) and guard 6 are clean for the whole section even before registration.

Fixes, matching the plan's "7 banned props / 3 files" inventory exactly:
- `settings-appearance-pane.tsx:276,308` (2 sites, runtime swatch `background`) → both now write
  `style={{ "--st-swatch": value } as React.CSSProperties}` (no import needed — same ambient
  `React.CSSProperties` pattern as `task-list-view.tsx`'s `--tk-swatch`, which doesn't import
  `React` either). `.theme-swatch` in `settings-panes-3.css` gained `background: var(--st-swatch);`.
  `--st-swatch` added to `check-design-tokens.ts`'s `allowList` (guard 4's `var()` token walk covers
  all of `apps/web/src` regardless of migration-registration status, so this was required now, not
  deferrable to Task 5) — confirmed via `pnpm check:design-tokens` green.
- `settings-personal-data-panes.tsx:135` (static `.acct__logo` background) — the inline value
  (`var(--text-faint)`) always won over the class's `var(--surface-3)` (only one call site,
  confirmed by grep), so folded directly into `settings-panes.css`'s `.acct__logo` rule; the dead
  `--surface-3` value is gone, no behavior change.
- `settings-personal-panes.tsx:91,97,289` (3 sites) — `SaveStatusChip`'s error/idle spans both
  unconditionally set `fontSize: 12`; folded into `.psona-save__state` in `settings-panes-2.css`
  (was `12.5px`, changed to `12px` to match what was actually rendering — the inline style always
  won on specificity, so the class's old value was already dead). Error's `color: var(--danger-fg)`
  became a new `.psona-save__state--error` modifier class (verified no collision with the existing
  `.psona-save.is-dirty .psona-save__state` rule — that's a different component,
  `settings-ai-pane.tsx`, which never renders alongside this one). The quiet-hours arrow separator's
  `color: var(--text-faint)` became a new `.fld__sep` class in `settings.css`.

Verified: `pnpm check:migrated-sections` and `pnpm check:design-tokens` both green (full repo run,
not just the override-list check). `pnpm check:ui-classes` and `pnpm check:ui-catalogue` also still
green (sanity — Task 3e touches no catalogue-visible props). `npx tsc --noEmit` clean from
`apps/web/`. `npx prettier --check` clean (had to `--write` two files once, both reverified clean
after). Diffed every file against intent before committing; `git show --name-only HEAD` confirmed
the 8 files match, explicit-path commit (not `git add -A`).

**Task 3e is closed.** Guard 6 (and guard 5, re-confirmed) are both genuinely zero-violation across
all 31 settings files, pre-registration.

## Next: Task 4 — CSS split + dead-selector burn-down (NOT STARTED)

Follow the wellness pattern per decision 4 in the plan (comment 5195260909): visual halves of
`settings.css` + `settings-panes.css` → new `packages/ui/src/styles/components-settings-1.css`;
`settings-panes-2.css` + `settings-panes-3.css` → `components-settings-2.css` (split further into
`-3` if the 1000-line file gate is hit — check after the `-2`/`-3` panes move, since 3e added a few
lines to both `settings-panes-2.css` and `settings-panes-3.css`). Both new files import at the end
of `packages/ui/src/styles.css`. Rules that only restyle `jds-btn`/`jds-dialog` die outright
(component CSS already owns them), not move.

**Watch these three sites Task 3e just touched when doing the split:**
- `.theme-swatch`'s new `background: var(--st-swatch)` line (settings-panes-3.css) — moves with the
  rest of `.theme-swatch`'s visual decls to `components-settings-2.css` (or `-3`). The
  `--st-swatch` allowList entry in `check-design-tokens.ts` already has a comment anticipating this
  move — no further allowList change needed after the split, since packages/ui CSS is
  out-of-scan-root for guard 4's `var()` walk (same as `--tk-swatch`/`components-tasks.css`).
- `.psona-save__state--error` (settings-panes-2.css) — moves with `.psona-save__state`.
- `.fld__sep` (settings.css) — moves with the rest of `.fld__row`'s siblings.

After the split, run the #1392 property-by-property check: every selector present in both a layout
file and its `components-settings-*` destination must share **zero** properties.

## Then: Task 5 guard registration, Task 6 e2e, Task 7 gate + PR

Unchanged from relay 3-6 docs and the coordinator's mid-relay-7 ruling. Restating what's easy to
get wrong:

- **Registration**: recompute absolutes against current `origin/main` (`git fetch && git log
  origin/main -1`) — target is **delta +4 CSS / +31 TSX**, merged main was 14/56 as of relay 5, but
  #1394 Modules may land at 23/59 first; union-resolve `packages/ui/src/styles.css` against #1394's
  three added `@import` lines if it merged first. **`check-ui-classes.test.ts` holds a SECOND
  hardcoded `DEFINITION_FILES` list** (coordinator's addition this relay) — editing the script alone
  makes that fixture ENOENT; update both. Prove registration isn't a no-op with TWO proofs: red-
  before/green-after on an injected violation per guard, AND confirm every added path resolves to a
  real file (`test -f`) — both guards `catch { continue }` on an unreadable path.
- **Gate discipline**: never pipe through `tail`/`grep`. `pnpm verify:foundation` against a fresh
  self-exported gate DB, never live dev. Excludes `test:e2e` — run separately, unpiped:
  `pnpm test:e2e > /tmp/e2e-1395.log 2>&1; echo "EXIT=$?"`. Grep `tests/e2e` for assertions on any
  converted control (IconButton aria-label text, Segmented color-mode buttons, ButtonLink download,
  Button upload, and now the swatch/save-status/quiet-hours markup from this session).
- **PR body must state**: CI's "Verify foundation and app" runs the browser suite, local gate
  doesn't; split-check result (zero shared properties); browser assertions are corroboration not
  proof (one state/section — Switch/Segmented/Select/Badge/Avatar/Indicator/ComingSoon need the
  live-path walk or a second capture); which `#1416` importers this closes (settings panes) vs.
  doesn't (six module packages + `task-details-dialog.tsx`) — post that as a factual comment on
  #1416, do not re-scope it. **Expect the coordinator to hold the merge on the live-path walk** —
  said explicitly this relay, plan for it.

## Reminders that still apply

Never pipe gate output through `tail`/`grep`. Explicit-path commits only (never `git add -A`/bare
`git commit`); a brand-new untracked file still needs an explicit `git add`. `git diff` before,
`git show --name-only HEAD` after every commit. Re-check `herdr pane list` before any tree-wide
action. If another context-meter checkpoint hits: write+commit a handoff doc and tell the
coordinator — do not spawn a successor via the Agent tool, use `herdr-handoff`. Report to the
coordinator via `herdr-pane-message` (pane "DESIGN ELEMENTS", w1:p1) — not to Ben. Do NOT merge the
eventual PR and do NOT close the issue.
