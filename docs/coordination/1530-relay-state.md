# 1530 build lane — relay state

**Issue #1530 (1339-C).** Code change is done and committed. What's left is the full gate run and
the PR.

## Done (committed on this branch, `1530-permission-repair-fail-closed`, rebased on origin/main)

- Commit `ac217d2a2`: fixed `TasksCompatibilityHelper.healInstallGrantAndReread` in
  `packages/tasks/src/action-policy.ts` — wraps the single `grantInstallTimeTrustIfUnset` attempt
  in try/catch, returns `ask_each_time` immediately on rejection (no retry, no reread, no legacy
  write). Success path unchanged. New unit test file
  `tests/unit/tasks-action-policy-fallback.test.ts`, 4 cases, all passing.
- Commit `290903c64`: build plan at
  `docs/superpowers/plans/2026-08-22-1339-c-tasks-heal-fail-closed.md`.
- Verified already, outside the full gate:
  - `pnpm vitest run tests/unit/tasks-action-policy-fallback.test.ts` — 4/4 pass.
  - The two DB-backed regression suites the spec names
    (`tests/integration/tasks-action-policy-self-heal.test.ts`,
    `tests/integration/chat-action-policy-self-heal.test.ts`) — 11/11 pass, run against an isolated
    gate DB (dropped after).
  - `pnpm format:check`, `pnpm lint`, `pnpm typecheck` — all clean.
  - `git fetch origin main && git rebase origin/main` — already up to date, no conflicts.

## In progress / not done

- **Full gate (`scripts/run-gate.sh start`, i.e. `pnpm verify:foundation`) has not completed
  green.** One run was started, got through migrations and `test:uat-seed` (29/29 pass), then
  stalled inside `test:integration` for over 600 seconds at 0% CPU with no further log output —
  looked hung, not just slow. I stopped it (`scripts/run-gate.sh stop`, rc=143) and dropped its
  gate DB rather than let it sit. This has not been diagnosed — don't assume it's the known
  module-sdk-worker flake (that one fails, it doesn't hang, and it's in `test:unit` which had
  already passed by the time this run stalled).
- PR has not been opened yet.
- Live-path proof: not applicable — spec says this is internal hardening, no user-facing UI
  surface (spec lines 109-111), so no UAT/live-path proof is required for this PR.

## Next step for whoever picks this up

1. Re-run the full gate (`scripts/run-gate.sh start` → `wait` → `status`), on a fresh worktree
   `node_modules` state if suspicious. If it stalls again at the same point
   (`test:integration`, right after a `tasks.recurrence_schedule_reconciled` debug log line),
   that's a second identical failure — stop and investigate rather than retrying a third time
   (systematic-debugging). Check whether a `pg-boss` worker or a recurrence-schedule timer is
   failing to release a DB connection/holding the process open. Note: this branch's own change is
   nowhere near the recurrence-schedule code, so this looks pre-existing.
   Look for the FAIL/WARN checks the earlier boot brief mentioned when reading
   `docs/coordination/1834-handoff-1530.md` (the file was truncated in this session's read — worth
   a full read for anything about known-red suites).
2. Once the gate is green (or the hang is understood and isolated as pre-existing/unrelated), push
   and open the PR per `coordinated-wrap-up` step 3, then report to the coordinator per step 4.
3. If the hang turns out to be a pre-existing flake unrelated to this change, say so explicitly in
   the PR body and to the coordinator, with evidence (this branch's diff doesn't touch anything
   pg-boss/recurrence-related).

## Collision / scope reminders

- Do not touch broader task-sharing permission logic — that's PR #1654 / #1511 territory.
- Coordinator agent name: `coordinator` (verify with `herdr agent list` before messaging — confirm
  exactly one live agent with that name).
