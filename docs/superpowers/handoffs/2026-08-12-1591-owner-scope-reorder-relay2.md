# Relay 2 — 1591-owner-scope-reorder

**Issue:** #1591. **Risk tier:** security. **Worktree/branch:** this worktree,
`1591-owner-scope-reorder`, off `origin/main` @ `fa929d489`. **Coordinator label:** `Coordinator`
(resolve fresh via `herdr pane list` — session id `caef4e32-df22-4310-a42d-866771a0ba6c`, do not
trust a baked pane number).

## Plan approval

Fable (spec-1248) reviewed `docs/superpowers/plans/2026-08-12-1591-owner-scope-reorder.md` and
**APPROVED**, with one non-blocking note (already folded into the Task 1 commit message — see
below): the reorder makes one legitimate-owner path change — confirming an action whose row is
already resolved (status != pending) now goes 404 not_found instead of 409 expired. The common
expiry case (owned, still pending, dead waiter) is unaffected; the delta path is near-unreachable
via the UI. **State this as a known behavioral delta in the PR body** so security QA doesn't read
it as an unintended regression — do not skip this in wrap-up.

## Done (commit `42b9bd053`)

- **Task 1** — `packages/ai/src/gateway/gateway.ts`, `resolveActionRequest`: added owner-scoped
  `repository.getAssistantAction` pre-check before the `isAwaiting` liveness check, for
  `status === "confirmed"` only. Returns `"not_found"` when the row is absent or not `pending`
  under the caller's RLS scope, before ever touching the confirmation-registry liveness state.
- **Task 2** — new `tests/unit/gateway-resolve-owner-scope.test.ts` (pattern:
  `tests/unit/mcp-gateway-recovery.test.ts`). Two cases: cross-owner indistinguishability
  (call-graph assertion — `getAssistantAction` called, `resolveAssistantAction` and
  `confirmations.resolve` never called, identical whether or not a live waiter exists) + owner
  liveness regression guard (#1256 invariant: no waiter → `"expired"`, row stays pending; live
  waiter → `"resolved"`, row transitions). **Verified the oracle**: manually reverted the Task 1
  change, reran this test file, confirmed it fails (`expected 'expired' to be 'not_found'`), then
  restored the fix and confirmed green again.
- `pnpm exec tsc --noEmit` (root) is clean on the current diff.

## Not done — pick up from here

1. **Task 3** — edit `tests/integration/ai-assistant-action-resolve.test.ts` (read the plan's Task
   3 section only, not the whole plan): fix the stale comment on the existing "both routes 404 an
   unknown action id" test (lines ~79-81 — it explains why `"confirmed"` couldn't be used
   pre-#1591; update to say the reason is fixed and reject/cancel remain the simplest case). Add a
   new test in the same `describe` block: POST `status: "confirmed"` to both
   `/api/ai/assistant-actions/:unknownId/resolve` and `/api/chat/action-requests/:unknownId/resolve`
   with an unknown-but-valid-shaped UUID (reuse the existing `unknownId` constant pattern), assert
   both 404 (not 409) — the previously-unreachable case, now taking the same not-found path as
   reject/cancel. Commit this task's file(s) alone by explicit path (shared-checkout skill — this
   worktree is currently single-occupant per the last `herdr pane list` check, but re-verify).
2. **Task 4** — gate: `verify-gate` skill, isolated DB,
   `pnpm verify:foundation > /tmp/1591-gate.log 2>&1; echo "EXIT=$?"` expect `EXIT=0`. Run
   `pnpm exec tsc --noEmit` explicitly first (vitest's transform doesn't type-check) — already
   confirmed clean once on this diff, re-run after Task 3's edits.
3. Pre-push trio: `pnpm format:check && pnpm lint && pnpm typecheck`, then
   `git fetch origin main && git rebase origin/main`.
4. `coordinated-wrap-up`: clean tree, gate, push, open PR tagged `[SECURITY]`, rebased on
   `origin/main`. **PR body must state the known behavioral delta** (see Plan approval section
   above). Report PR + evidence to the coordinator. **Do not merge, close, or touch the board** —
   security-tier, needs Ben's explicit merge sign-off, no delegated sign-off tonight.

## Run-specific bans (unchanged)

- Work only in this worktree/branch; `git add` by explicit path only (shared-checkout skill).
- Never touch `docs/coordination/`, the project board, or merge anything.
- No secrets in any doc/payload/log/prompt.
- #1592 is queued behind this lane (shares `tests/integration/chat-mcp-transport.test.ts`,
  `mcp-gateway*.test.ts`) — coordinator won't spawn it until this PR lands on `main`. No action
  needed here beyond landing cleanly first.

## Relay trigger

Fired on the context-meter 70% warning, immediately after Task 1+2 landed and were verified
(commit `42b9bd053`). Real progress this leg (unlike relay 1, which produced only a plan) — build
and verify happened, not just reading. Successor should read this doc in full (short by design),
then the plan's Task 3/4 sections only, then resume via `coordinated-build` from Task 3.
