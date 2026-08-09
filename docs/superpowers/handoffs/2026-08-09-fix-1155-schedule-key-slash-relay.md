# Relay — fix-1155-schedule-key-slash

**Spec:** `docs/superpowers/specs/2026-08-08-non-feature-wave-2.md` (row #1155)
**Plan:** `docs/superpowers/plans/2026-08-09-fix-1155-schedule-key-slash.md`
**Branch/worktree:** `fix-1155-schedule-key-slash` at
`/home/ben/Jarv1s/.claude/worktrees/fix-1155-schedule-key-slash` (this worktree — reuse it, don't
recreate).
**Coordinator:** Herdr label `Coordinator`. Plan already approved (Opus-reviewed) with one
non-blocking note (see below) — do NOT re-plan or re-request approval.

## Done (both commits green, tree clean)

- `2dfcf60c0` — `fix(#1155): use / not : in proactive-monitoring schedule keys`
  (`packages/module-registry/src/index.ts`): exported `buildReconcileProactiveSchedule`, changed
  `scheduleKey` separator from `:` to `/` (pg-boss v12 `assertKey` rejects `:`). Mirrors the
  `job-reconciler.ts` fix from #1147.
- `91eefbf46` — `test(#1155): prove real pg-boss v12 accepts the slash-separated schedule key`
  (new file `tests/integration/module-registry-proactive-schedule.test.ts`): 3 real-pg-boss-client
  tests (schedule, persisted-key-shape, unschedule). Red/green proof already captured, per
  coordinator's explicit instruction to reverse task order (test-first, no `git stash`):
  - `/tmp/t1155-red.log` — pre-fix run: 2/3 tests fail with the real pg-boss `AssertionError` on
    the `:`-separated key (not a vitest error — this is genuine red for the right reason).
  - `/tmp/t1155-green.log` — post-fix run: 3/3 pass.
  - `/tmp/t1155-format.log`, `/tmp/t1155-lint.log`, `/tmp/t1155-typecheck.log` — pre-push trio, all
    clean (not re-verified after this doc's writing — rerun before push if stale).

Both commits verified via `git show --name-only HEAD` at commit time — each touched exactly the one
intended file.

**Coordinator's non-blocking note (already satisfied):** reverse task order so the test fails
first (write test, watch it fail with the real pg-boss error, then implement) instead of using
`git stash` to prove red — stash is discouraged in this shared checkout. Done exactly this way.

## What's left

1. **Full gate (`pnpm verify:foundation`) has flaked twice, unrelated to this change** — do not
   treat this as a code problem, but do get a genuine green before push:
   - Run 1 (`/tmp/vf-1155.log`): `rc=1`, `error: tuple concurrently updated` in
     `tests/integration/connectors-google.test.ts` during `resetEmptyFoundationDatabase`'s
     `runSqlFiles`.
   - Run 2 (`/tmp/vf-1155-retry.log`): `rc=1`, same error signature, different file —
     `tests/integration/news-discovery-repository.test.ts`. 185/186 files passed, 1871/1874 tests
     passed.
   - Neither failing file touches `packages/module-registry` or the new test file. Two different
     unrelated files failing with the identical Postgres contention signature strongly supports
     shared-cluster contention from concurrent multi-agent gate runs (see CLAUDE.md
     `multi-agent-pg-contention` memory), not a regression from this change.
   - **Next step:** check `herdr pane list` for other Wave 2 lanes' gate activity (PR1207, PR1115
     were both "working" during both prior attempts); if quieter, drop+recreate the isolated gate
     DB (`jarvis_gate_1155schedulekeyslash`, per `verify-gate` skill) and run a third time. If it
     flakes a third time on yet another unrelated file, that's further evidence of contention, not
     a blocker — consider noting it explicitly to the coordinator rather than retrying indefinitely.
2. Once gate is genuinely green (state explicitly that `test:e2e` is excluded, per `verify-gate`
   skill — this PR is non-UI so that's expected, not a gap): rerun the pre-push trio fresh
   (`pnpm format:check && pnpm lint && pnpm typecheck`), rebase on `origin/main` (should be a
   no-op — branch was confirmed up to date earlier), push, open PR.
3. Invoke `coordinated-wrap-up`: PR body states this is a non-UI backend fix
   (`packages/module-registry/src/index.ts`), so **live-path/UAT proof is not required** — say so
   explicitly. Report PR link + gate evidence to the coordinator. Do not merge, touch the board, or
   close the issue — coordinator-only.
4. Drop the isolated gate DB(s) when fully done, per `verify-gate` skill cleanup guidance.

## Task list state at relay time

Tasks #1-#4 (export, red test, fix, green test) = completed. Task #5 ("Pre-push checks, wrap-up,
PR") = in_progress, blocked only on getting one clean gate run past the contention flakiness.

## Hard bans still in force

Work only in this worktree/branch. `git add` by explicit path only. Never touch
`docs/coordination/`, project board, milestones, or merge. No secrets in any doc/payload/log/prompt.
