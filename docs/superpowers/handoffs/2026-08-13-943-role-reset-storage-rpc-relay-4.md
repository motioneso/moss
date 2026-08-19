# Relay — #943 role-reset-storage-rpc (relay 4, escalation)

**Issue:** #943 (spec = issue body). **Risk tier:** security.
**Branch/worktree:** `943-role-reset-storage-rpc`, same path (this worktree). Tree **clean**, HEAD
`d7a4bc08e` — rebased onto `origin/main`, pre-push trio green (unchanged since relay-3).
**Coordinator:** label `Coordinator`, session id `caef4e32-df22-4310-a42d-866771a0ba6c` (re-resolved
via `herdr pane list` this relay — unchanged from relay-3).

## Status: escalating per CLAUDE.md "two identical failures → stop and rethink"

Four full-gate attempts total (2 this relay). Evidence now shows a consistent, reproducible
pattern that is infra contention, not a regression from this branch's change.

| # | Result | Signature | File(s) | Notes |
|---|--------|-----------|---------|-------|
| 1 (relay-3) | RED | `error: tuple concurrently updated` in `resetEmptyFoundationDatabase` → `runSqlFiles` | `onboarding.test.ts`, `structured-state.test.ts` ×2, `notes-write-tools.test.ts` | 4-5 concurrent lanes at the time |
| 2 (relay-3) | HUNG | `DROP DATABASE ... WITH (FORCE)` never returned | — | killed after >5min, pids confirmed mine via `/proc/<pid>/cwd` |
| 3 (this relay) | RED | React `act()` timing flake, unrelated to DB | `tests/unit/chat-drawer-surface.test.tsx` ("resets state on a flip in both directions") | Failed in `test:unit`, before the chain ever reaches `test:integration`. Re-ran the file **in isolation**: 10/10 pass, exit 0 — confirmed non-reproducible flake, not caused by this branch |
| 4 (this relay) | RED | **Same** `error: tuple concurrently updated` in `resetEmptyFoundationDatabase` → `runSqlFiles` | `tests/integration/notes.test.ts` | `test:unit` (555/555) and `test:uat-seed` (12/12) passed this time; 3 concurrent lanes running gates at the time (1487, 1274, 1248) |

**This branch's diff is 3 non-doc lines of surface area:** `packages/db/src/module-storage-rpc.ts`
(the fix) and `tests/integration/module-storage-rpc.test.ts` (its regression test) — confirmed via
`git diff origin/main...HEAD --stat`. Neither file, nor `notes.test.ts`/`onboarding.test.ts`/etc.,
has any relationship to this change. In every attempt that reached `test:integration`,
`module-storage-rpc.test.ts` itself was among the passing files (never named in any failure list) —
consistent with relay-1/2's earlier isolated red→green TDD confirmation of that test.

**2/2 consistent identical-signature evidence** (attempts 1 and 4) of the known
`multi-agent-pg-contention` DDL-lock-contention issue (concurrent worktrees running migrations
against the shared dev Postgres during an overnight fleet with several lanes gating at once).
Attempts 2 and 3 are separate, already-explained anomalies (a hang, and an isolation-confirmed
unrelated flake) — not additional instances of this signature.

## Decision needed from coordinator

Per the original relay-3 handoff, I'm not retrying blind a 5th time. Two options:

1. **Proceed on the strength of this evidence** — treat the branch as gate-clean apart from a
   known, reproducible infra flake that never touches this branch's own code or test, and move to
   `coordinated-wrap-up` (push, open PR `[SECURITY]`, note the gate evidence + isolated
   `module-storage-rpc` pass explicitly in the PR instead of a single clean full-gate run).
2. **Wait for a quieter window** and attempt a 5th full gate run once fewer lanes are gating
   concurrently (fleet was still running 3 other gates as of this relay — may not clear overnight).

Awaiting coordinator direction before proceeding either way.

## Not done

- Gate DB `jarvis_gate_943_role_reset_storage_rpc` left in place (kept on failure by
  `run-gate.sh` design, for debuggability) — will drop once this relay's question is resolved and
  no further gate runs are needed.
- Push / PR / wrap-up not started — waiting on coordinator direction above.
- Per original handoff: adversarial Opus QA + Ben's explicit merge sign-off still required before
  merge, regardless of which option the coordinator picks. Building agent does not merge/board/close.

## Reference

- Relay-3 doc: `docs/superpowers/handoffs/2026-08-13-943-role-reset-storage-rpc-relay-3.md` (attempts
  1-2, pre-push/rebase detail).
- The actual fix (`packages/db/src/module-storage-rpc.ts`, commit `a46a7feb1`) and its regression
  test (`tests/integration/module-storage-rpc.test.ts`, commit `2e7a49687`) are unchanged and
  already TDD-confirmed red→green — do not redo them.
- Gate logs: attempt 3 `/tmp/jarv1s-gate/943_role_reset_storage_rpc-20260813-004601.log`, attempt 4
  `/tmp/jarv1s-gate/943_role_reset_storage_rpc-20260813-005920.log`.
- Plan: `docs/superpowers/plans/2026-08-13-943-role-reset-storage-rpc.md`.
