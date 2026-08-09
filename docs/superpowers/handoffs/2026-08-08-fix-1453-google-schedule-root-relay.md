# Relay — #1453 Google schedule-root flaky test

**Spec:** `docs/superpowers/specs/2026-08-08-non-feature-wave-2.md` (#1453 row) — approved by Ben.
**Plan:** `docs/superpowers/plans/2026-08-08-fix-1453-google-schedule-root.md`
**Handoff:** `docs/coordination/handoff-wave2-1453.md`
**Worktree/branch:** this worktree, branch `fix-1453-google-schedule-root`.
**Coordinator label:** `Coordinator` (agent name `coordinator-wave1-r2`) — exactly one pane, verify
fresh with `herdr pane list` before messaging.
**Coordinator's exact approval (already granted, do not re-ask):**
> "APPROVED. Implement exactly that one-file plan. Preserve schedule-row and exactly-one-root
> assertions, use the existing sendJob singleton pattern, run the repeated focused integration
> evidence and full isolated gate, then open the PR and report. No production changes, no #1454,
> no merge."

## Done (commit `28e85777a`)

Task 1 (the plan's only task) is implemented and committed: `tests/integration/connectors-google-schedule-root.test.ts`
rewritten to hold the fired root job active via a deferred-promise gate, then attempt a duplicate
`sendJob(boss, GOOGLE_SYNC_QUEUE, ..., { singletonKey: ids.userA })` while it's still
created/active, asserting the result is `null` — replaces the flaky fixed 1.2s sleep. Schedule-row
`toMatchObject` assertion and the exactly-one-root assertions are unchanged. Dead `waitFor` helper
removed. **Not yet run through vitest.**

## Not done — pick up here in order

1. **Run focused test**: `pnpm --filter @moss/connectors exec vitest run tests/integration/connectors-google-schedule-root.test.ts > /tmp/1453-single.log 2>&1; echo "EXIT=$?"` — confirm exact invocation against `package.json` scripts if this doesn't resolve; expect exit 0.
2. **Repeated evidence**: `pnpm vitest run --repeat=5 tests/integration/connectors-google-schedule-root.test.ts > /tmp/1453-repeat.log 2>&1; echo "EXIT=$?"` — expect exit 0 every repeat (issue's acceptance criterion b).
3. **Falsifiability check** (issue's acceptance criterion c): temporarily delete `singletonKey: ids.userA` from the test's *duplicate* `sendJob` call (the one added by this fix, not the schedule setup), rerun the focused test, confirm `expect(duplicateJobId).toBeNull()` goes red, then restore the line and confirm green again. Do not commit the red state.
4. **Pre-push trio + rebase**: `pnpm format:check && pnpm lint && pnpm typecheck`, then `git fetch origin main && git rebase origin/main`.
5. **`coordinated-wrap-up`**: full isolated gate (use the `verify-gate` skill's DB-isolated recipe — never bare `pnpm verify:foundation`), push, open PR, report PR + evidence to `coordinator-wave1-r2`. No live-path proof needed (test-only, per handoff). **Do not merge** — coordinator's call.

## Notes

- Never touch `docs/coordination/`, the board, milestones, or merge — coordinator-only.
- Do not modify/rebase any Wave 1 branch; this lane was pulled forward only to unblock Wave 1 PR
  #1473's CI check.
- `docs/superpowers/plans/...` for this fix was originally mis-written to the main tree path by
  the predecessor session — already corrected; the copy inside this worktree (committed in
  `28e85777a`) is the one that matters.
