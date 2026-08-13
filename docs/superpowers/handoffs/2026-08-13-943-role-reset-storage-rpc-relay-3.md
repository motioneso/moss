# Relay — #943 role-reset-storage-rpc (relay 3)

**Issue:** #943 (spec = issue body). **Risk tier:** security.
**Branch/worktree:** `943-role-reset-storage-rpc`, same path (this worktree). Tree **clean**, HEAD
`c91af5157` — rebased onto `origin/main` (`198928da4`).
**Coordinator:** label `Coordinator`, session id `caef4e32-df22-4310-a42d-866771a0ba6c` —
re-resolve fresh via `herdr pane list` (label + session id), don't trust a `…-N` pane number.

## Done this relay

- Pre-push trio **green**: `pnpm format:check && pnpm lint && pnpm typecheck` (rc=0). Took 3
  attempts — prettier's markdown reflow needed two `--write` passes to converge on
  `docs/superpowers/plans/2026-08-13-943-role-reset-storage-rpc.md` (docs-only, two small commits:
  `6084bf6a5`, `c91af5157`).
- Rebased onto `origin/main` clean (`git rebase origin/main`, no conflicts). The two new upstream
  commits (`513672aa5`, `198928da4`) are docs-only spec/plan approvals for #1248 and #1495 — nowhere
  near `packages/db` or `tests/integration`, confirmed via `git show --stat`. Did **not** re-run the
  integration test per relay-2's own instruction (rebase touched nothing nearby); pre-rebase green
  stands.
- **Full gate attempt 1**: `scripts/run-gate.sh start` → DB `jarvis_gate_943_role_reset_storage_rpc`,
  log `/tmp/jarv1s-gate/943_role_reset_storage_rpc-20260813-000402.log`. **Red, rc=1** — but all 4
  failing test files (`onboarding.test.ts`, `structured-state.test.ts` ×2, `notes-write-tools.test.ts`)
  failed identically with `error: tuple concurrently updated` inside `resetEmptyFoundationDatabase`
  → `runSqlFiles` (migration SQL runner) — the known concurrent-DDL-contention signature
  (`multi-agent-pg-contention` memory), **not** a regression from this branch's change. None of the
  4 failures touch `module-storage-rpc.ts` or its test — that suite's own result from relay-2's
  earlier isolated run stands. 4-5 other lanes had gates running concurrently at the time (1489,
  1495, 1591, 1141, 1325 seen across the window).
- **Full gate attempt 2**: started, but `scripts/run-gate.sh start`'s `DROP DATABASE ... WITH
  (FORCE)` step hung (>5 min, no output, no new `.current` pointer). Killed the 3 stuck processes
  (pids 4126870/4126929/4126948) after confirming via `/proc/<pid>/cwd` they were mine, not another
  session's. Left `jarvis_gate_943_role_reset_storage_rpc` in place (not dropped) — successor's next
  `start` will DROP/CREATE it fresh anyway.
- Relayed here per the meter's 70% context warning (coordinated-build step 3) — no compaction seen.

## Not done — successor picks up here

1. **Full gate, attempt 3.** Before starting, check contention: other lanes' gates may still be
   running (`ps aux | grep -E "run-gate.sh __run|verify:foundation"`, exclude your own worktree).
   Fewer concurrent lanes reduces the DDL-lock-contention risk, but the fleet is busy overnight and
   may never hit zero — don't wait indefinitely for a perfectly clear window; a few minutes' check
   is enough, then run it anyway.
   ```bash
   scripts/run-gate.sh start
   # poll: scripts/run-gate.sh wait --timeout 500   (loop until rc != 3; use Monitor, not in-context polling)
   ```
   If it hangs again at `DROP DATABASE ... WITH (FORCE)` for >3-4 min with no log progress, that's
   likely a stale connection or catalog lock — check
   `docker exec jarv1s-postgres psql -U postgres -c "SELECT pid,state,query FROM pg_stat_activity WHERE datname LIKE 'jarvis_gate_943%';"`
   before killing anything, and only kill processes confirmed via `/proc/<pid>/cwd` to be this
   worktree's.
2. **If attempt 3 is red again with the SAME `tuple concurrently updated` signature** on files
   unrelated to `module-storage-rpc`, that's strong enough evidence of infra contention (2/2
   consistent) to note in the wrap-up report rather than keep retrying blind — but per CLAUDE.md
   ("two identical failures → stop and rethink"), do not just retry a third time hoping it clears;
   if it recurs, escalate to the coordinator with the pattern (file names, error text, concurrent
   lane count) and ask whether to proceed on a gate that's green apart from this known infra flake,
   or wait longer.
3. **If green**: `coordinated-wrap-up` — push (rebase already done, should be a clean
   fast-forward-safe push, but re-run the pre-push trio first if any new commits landed since this
   doc), open PR tagged `[SECURITY]`, note live-path UI proof doesn't apply (backend-only change),
   report PR + verified evidence (gate log path, integration test result) to coordinator. Per
   original handoff: **adversarial Opus QA + Ben's explicit merge sign-off required — no delegated
   sign-off tonight.** Building agent does not merge/board/close.
4. Drop the gate DB when fully done with it: `jarvis_gate_943_role_reset_storage_rpc`.

## Reference

- The actual fix (`packages/db/src/module-storage-rpc.ts`, commit `a46a7feb1`) and its regression
  test (`tests/integration/module-storage-rpc.test.ts`, commit `2e7a49687`) are unchanged and were
  already TDD-confirmed red→green in relay-1/2 — do not redo them.
- Plan: `docs/superpowers/plans/2026-08-13-943-role-reset-storage-rpc.md`.
