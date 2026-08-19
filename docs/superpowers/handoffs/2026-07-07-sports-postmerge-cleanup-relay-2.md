# Relay handoff — sports-cleanup (#837), relay 2

**Trigger:** context-meter 70% checkpoint. Per `coordinated-build` step 3.

## Where things stand

- Worktree/branch: this worktree, `837-sports-postmerge-cleanup`, base `origin/main` @ `616b9ed1`.
- Plan: `docs/superpowers/plans/2026-07-06-sports-postmerge-cleanup.md` (approved, see relay-1 doc).
- Prior relay doc: `docs/superpowers/handoffs/2026-07-06-sports-postmerge-cleanup-relay.md`.
- **Tasks 1-3 done and committed:**
  - `bffc882b` refactor(sports): move FollowedCard to today-widget
  - `62b424d0` docs(sports): fix prettier formatting on plan doc (pre-existing issue in the
    relay-1 commit, unrelated to this task's edits — fixed inline so gates stay green)
  - `5afb540d` style(sports): tokenize sp-fc raw px literals
  - `d6e4a523` style(sports): remove dead .sp-emptyboard media query
- **Task 4 (full verification) mostly done:**
  - Full gate green: `pnpm lint && pnpm format:check && pnpm check:file-size && pnpm check:design-tokens && pnpm typecheck && pnpm test:unit` — exit 0, 271 files / 1845 tests passed.
  - Visual-verification gap confirmed real (grep for `registerMockSportsRoutes`/`sportsOverviewFixture` scoped to "today" in `tests/e2e/capture-screens.spec.ts` returns nothing).
  - Manual visual check done: wrote a scratch-only Playwright spec at
    `tests/e2e/zz-scratch-sp-fc-visual.spec.ts` (mocked sports routes + `/today`), captured
    after-tokenize screenshot, then temporarily restored `sports-1.css` to its pre-#837 content
    (`git show 616b9ed1:...`) to capture before DOM/computed-style metrics, then **restored the working tree
    file from a backup copy** (`cp /tmp/current-sports-1.css ...`) — verified `git diff` was empty
    afterward, so no working-tree corruption survived. Compared both screenshots: pixel-identical
    (only sub-pixel rounding from nearest-token mapping) — no visual regression. Scratch test file
    was deleted before this checkpoint; `git status` is clean except the pre-existing untracked
    `.claude/context-meter.log`.

## What's NOT done (next steps, in order)

1. **Check the backgrounded browser assertion run** (Task 4 Step 4, full-suite regression
   check) — I kicked it off right before this checkpoint and did not see its result. Log at
   `/tmp/capture-screens.log` (ephemeral — may not survive session handoff; just re-run
   the focused browser assertions if the log is gone). Expected: all assertions pass, no crashes
   failures.
2. **Task 4 Step 5 — pre-push trio + rebase:**
   ```bash
   pnpm format:check && pnpm lint && pnpm typecheck
   git fetch origin main && git rebase origin/main
   ```
   Expected clean (no other merged PR has touched these files since `616b9ed1`).
3. **Close out with `coordinated-wrap-up`**: clean tree, own full gate, pre-push trio + rebase,
   push, open PR, report PR + evidence to the coordinator. Do not merge, touch the board, or touch
   `docs/coordination/`.

## Run-specific bans (still binding)

- Work ONLY in this worktree/branch; `git add` by explicit path — never `-A` or repo-wide
  `pnpm format`.
- Never touch `docs/coordination/` (coordinator-only), the project board, milestones, or merge.
- No secrets in any doc, payload, log, or prompt.

## Coordinator context

- Label `Coordinator`. Mid-run, a coordinator message arrived confirming this session as
  "sports-cleanup-2" driving this worktree, and noted it was reaping an old idle pane (`w1:p97`)
  and updating its manifest. No action needed beyond normal wrap-up escalation.
