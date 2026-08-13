# Relay — #943 role-reset-storage-rpc (relay 5)

**Issue:** #943 (spec = issue body). **Risk tier:** security.
**Branch/worktree:** `943-role-reset-storage-rpc`, same path (this worktree, skip `pnpm install` —
`node_modules` present). Tree **clean**, HEAD `ab0f1b225`.
**Coordinator:** name `coord-successor`, label `Coordinator`, session id
`caef4e32-df22-4310-a42d-866771a0ba6c` — re-resolve fresh via `herdr pane list` before messaging.

## Coordinator decision already received — do NOT re-ask

Escalated after 4 full-gate attempts (2/2 identical `tuple concurrently updated` DDL-contention
signature, attempts 1 and 4, on files unrelated to this branch — full evidence in
`docs/superpowers/handoffs/2026-08-13-943-role-reset-storage-rpc-relay-4.md`). Coordinator replied:

> Decision: proceed to coordinated-wrap-up. Two independent lanes tonight (this one and #1591) hit
> the identical DDL-contention signature on unrelated files during full-gate runs, while each
> branch's own tests pass 100% every attempt — corroborating box-wide `multi-agent-pg-contention`,
> not a regression. CI (isolated env) is the authoritative gate for QA, not local full-suite runs on
> a contended box. Open the PR, cite the 4 gate attempt logs + the clean isolated
> `module-storage-rpc` pass in the PR body, note the contention explicitly so QA doesn't misread it
> as a regression. Tear down `jarvis_gate_943_role_reset_storage_rpc` as part of wrap-up. Proceed.

**No further full-gate runs needed.** Resume `coordinated-wrap-up` at step 3.

## Not done — successor picks up here (coordinated-wrap-up, from step 3)

1. Pre-push trio (new commit `ab0f1b225` landed since last check at `c91af5157` — docs-only, but
   run anyway per skill):
   ```bash
   pnpm format:check && pnpm lint && pnpm typecheck
   git fetch origin main && git rebase origin/main
   ```
2. Push + open PR tagged `[SECURITY]`:
   ```bash
   git push -u origin 943-role-reset-storage-rpc
   gh pr create --base main --head 943-role-reset-storage-rpc \
     --title "[SECURITY] fix(db): #943 reset module RPC role after query()" \
     --body "…"
   ```
   PR body must state: scope (the fix in `packages/db/src/module-storage-rpc.ts` +
   `tests/integration/module-storage-rpc.test.ts`, both unchanged since relay-1/2's TDD
   red→green), **and explicitly cite the 4 gate-attempt logs + isolated `module-storage-rpc` pass**
   so QA doesn't misread the contention pattern as a regression:
   - Attempt 1: red, `tuple concurrently updated` in `resetEmptyFoundationDatabase`→`runSqlFiles`,
     4 unrelated files (`onboarding.test.ts`, `structured-state.test.ts` ×2,
     `notes-write-tools.test.ts`). Log:
     `/tmp/jarv1s-gate/943_role_reset_storage_rpc-20260813-000402.log` (may have been cleaned up by
     now — note the path anyway, or drop the reference if gone).
   - Attempt 2: hung at `DROP DATABASE ... WITH (FORCE)`, killed.
   - Attempt 3: red, unrelated React `act()` flake in `chat-drawer-surface.test.tsx`, confirmed
     non-reproducible in isolation (10/10 pass). Log:
     `/tmp/jarv1s-gate/943_role_reset_storage_rpc-20260813-004601.log`.
   - Attempt 4: red, **same** `tuple concurrently updated` signature as attempt 1, in
     `tests/integration/notes.test.ts`. `module-storage-rpc.test.ts` passed (among 190/191 passing
     files). Log: `/tmp/jarv1s-gate/943_role_reset_storage_rpc-20260813-005920.log`.
   - Corroboration: lane #1591 independently hit the same signature the same night (per
     coordinator).
   - Note live-path UI proof does not apply — backend-only change (module storage RPC role reset).
3. Drop the gate DB: `docker exec jarv1s-postgres psql -U postgres -c "DROP DATABASE IF EXISTS
   jarvis_gate_943_role_reset_storage_rpc;"`.
4. Report to coordinator (terse, result-first) via `herdr-pane-message`, re-resolving the pane
   fresh: PR link, VF_EXIT status (cite the contention-explained pattern, not a single clean run),
   live-path n/a, branch pushed + rebased sha, teardown confirmed (gate DB dropped, no dev instance
   started, worktree reapable). Then STOP — do not merge, update the board, or close the issue.
   Original handoff requires adversarial Opus QA + Ben's explicit merge sign-off first.
5. Relay to coordinator "safe to reap me" once the report lands and successor confirms driving.

## Reference

- Relay-3: attempts 1-2, pre-push/rebase detail.
- Relay-4: attempts 3-4, full escalation evidence and coordinator decision text.
- Fix commit `a46a7feb1`, test commit `2e7a49687` — unchanged, already TDD red→green confirmed.
- Plan: `docs/superpowers/plans/2026-08-13-943-role-reset-storage-rpc.md`.
