# Relay — 1591-owner-scope-reorder

**Issue:** #1591. **Risk tier:** security. **Worktree/branch:** this worktree,
`1591-owner-scope-reorder`, off `origin/main` @ `fa929d489`. **Coordinator label:** `Coordinator`
(resolve fresh via `herdr pane list` — session id `caef4e32-df22-4310-a42d-866771a0ba6c`, do not
trust a baked pane number).

## Done

- Plan written and committed: `docs/superpowers/plans/2026-08-12-1591-owner-scope-reorder.md`
  (commit `8a36d0e86`). Full seams check, decision, Task 1-4 breakdown, kill gate, exit criteria —
  already covers everything needed to build. Read it by section, not front-to-back.
- Messaged the `Coordinator` pane (fresh-resolved, exactly one match confirmed):
  "plan ready for 1591-owner-scope-reorder: docs/superpowers/plans/2026-08-12-1591-owner-scope-reorder.md.
  Approve, or flag a fork." Delivered and accepted (pane went idle→working).

## Not done — blocked on coordinator approval

**Do not write any code until the coordinator sends explicit "approved"** (routed via Fable review,
per the plan-authorship rule in the handoff doc — this agent must not approve its own plan). If no
reply has arrived yet, wait (check for a queued message / re-read the pane); do not start Task 1
speculatively.

Once approved, per the plan:

1. **Task 1** — reorder `resolveActionRequest` in `packages/ai/src/gateway/gateway.ts:433-458`: for
   `status === "confirmed"`, run the owner-scoped `repository.getAssistantAction` pre-check before
   `isAwaiting`/`resolveAssistantAction`. Exact body-shape steps are in the plan's Task 1 section.
2. **Task 2** — new unit test `tests/unit/gateway-resolve-owner-scope.test.ts` (pattern:
   `tests/unit/mcp-gateway-recovery.test.ts:12-22`). Two cases per plan: cross-owner
   indistinguishability (call-graph assertion) + owner-liveness regression guard.
3. **Task 3** — edit `tests/integration/ai-assistant-action-resolve.test.ts`: fix stale comment at
   lines 79-81, add new confirmed+unknown-id 404 parity test.
4. **Task 4** — gate: `verify-gate` skill, isolated DB,
   `pnpm verify:foundation > /tmp/1591-gate.log 2>&1; echo "EXIT=$?"` expect `EXIT=0`. Also run
   `pnpm exec tsc --noEmit` (or `pnpm typecheck`) explicitly on the new/edited `.ts` files before
   the first full gate attempt — vitest's transform does not type-check.
5. Pre-push trio before any push: `pnpm format:check && pnpm lint && pnpm typecheck`, then
   `git fetch origin main && git rebase origin/main`.
6. `coordinated-wrap-up`: clean tree, gate, push, open PR tagged `[SECURITY]`, rebased on
   `origin/main`. Report PR + evidence to the coordinator. **Do not merge, close, or touch the
   board** — this is security-tier and needs Ben's explicit merge sign-off, no delegated sign-off
   tonight.

## Run-specific bans (unchanged)

- Work only in this worktree/branch; `git add` by explicit path only (shared-checkout skill).
- Never touch `docs/coordination/`, the project board, or merge anything.
- No secrets in any doc/payload/log/prompt.
- Note: #1592 is queued behind this lane (shares `tests/integration/chat-mcp-transport.test.ts`,
  `mcp-gateway*.test.ts`) — coordinator won't spawn it until this PR lands on `main`. No action
  needed here beyond landing cleanly first.

## Relay trigger

This relay fired on the context-meter 70% warning (was at ~72%), zero code written yet — plan
authored/committed and coordinator messaged is the full extent of progress. The successor should
follow `coordinated-build` from step 1 (post-approval) onward, reading the plan by section per task,
not in full.
