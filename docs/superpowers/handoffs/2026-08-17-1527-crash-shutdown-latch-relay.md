# Relay — 1527-crash-shutdown-latch

**Spec:** `docs/superpowers/specs/2026-08-10-1140-backend-low-followups.md` §1140-E
**Issue:** #1527 (part of #1140). Tier: routine. **#1528 depends on this — do not start it.**
**Handoff doc (main only, not on this branch):**
`docs/coordination/handoff-1527-crash-shutdown-latch.md` — read via
`git show main:docs/coordination/handoff-1527-crash-shutdown-latch.md` if needed again; this file
already carries everything from it that matters for wrap-up.
**Coordinator:** label `Coordinator`, agent name `coord-post1632-take27` — re-resolve pane fresh
via `herdr pane list`, confirm exactly one `Coordinator`-labeled pane before messaging (pane ids
reflow every session).

## Done

- Plan: `docs/superpowers/plans/2026-08-17-1527-crash-shutdown-latch.md` (commit `20b3375ed`).
- Implementation (commit `b423fd415`):
  - `apps/api/src/server.ts` — exported `createCrashHandler(server, opts)`, closure-local
    `crashing` latch, replaces old inline unlatched `handleCrash`.
  - `apps/worker/src/worker.ts` — exported `createCrashHandler(handle, opts)`, same pattern,
    JSON-line logging via injectable `log`.
  - `tests/unit/process-crash-handlers.test.ts` — new, 6 tests, 6/6 green (TDD red confirmed
    first: `createCrashHandler is not a function` before implementation).
- Regression checked green: `tests/unit/api-signal-shutdown.test.ts` (2/2),
  `tests/integration/worker-lifecycle.test.ts` (13/13).
- `pnpm format:check && pnpm lint && pnpm typecheck` — all green (format required one scoped
  `prettier --write` on the plan doc + test file only, not repo-wide `pnpm format`).
- Tree clean, rebased on `origin/main` as of `c55df171a`.
- Coordinator already messaged with this status (relay-trigger notice sent before this doc).

## Left to do (coordinated-wrap-up, from step 2 onward)

1. **Full gate, isolated DB** — do NOT hand-roll:
   ```bash
   scripts/run-gate.sh start
   scripts/run-gate.sh wait      # Bash timeout 600000ms — longer than its own 540s poll
   scripts/run-gate.sh status    # expect exit 0; read the ### FINAL line, never pgrep/pipe
   ```
2. Re-run pre-push trio + fresh rebase immediately before push (already green once above, but
   re-confirm — time has passed):
   ```bash
   pnpm format:check && pnpm lint && pnpm typecheck
   git fetch origin main && git rebase origin/main
   ```
3. Push + PR:
   ```bash
   git push -u origin 1527-crash-shutdown-latch
   gh pr create --base main --head 1527-crash-shutdown-latch \
     --title "fix(#1527): make crash shutdown single-flight in api and worker" \
     --body "<scope: single-flight crash latch per spec §1140-E · link to spec section · gate exit codes · live-path: not required, no user-facing surface (stated explicitly, not omitted) · no deferred scope>"
   ```
4. **Live-path proof is explicitly NOT required** for this lane — no user-facing UI surface (pure
   process-lifecycle). State that plainly in both the PR body and the coordinator report — do not
   silently skip the section.
5. Report to coordinator (`herdr-pane-message`, re-resolve pane fresh first) — PR link, gate exit
   codes, live-path "not required — no user-facing surface", branch pushed/rebased sha, "deferred:
   none", "teardown: none started (nothing run outside the worktree)", "worktree reapable after
   merge". Then **STOP** — no board move, no issue close, no merge. Those are the coordinator's.
6. Do not start #1528 — coordinator spawns it after this PR merges.

## Notes for the successor

- `node_modules` already installed in this worktree — skip `pnpm install`.
- Both `createCrashHandler` factories are intentionally duplicated (not shared) per spec's explicit
  ban on a cross-package crash manager — this is correct, not an oversight to "DRY up".
- Nothing was started outside this worktree (no dev instance, no seeded rows) — teardown is a
  no-op, but say so explicitly in the report rather than omitting it.
