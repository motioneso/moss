# Relay — w3a-audit-truth (lane A: #1256, #1252, #1251)

**Spec:** `docs/superpowers/specs/2026-08-09-wave-3-action-audit-truth.md`
**Handoff (authority doc, re-read it):** `docs/coordination/waves-3-6-prep/handoff-w3a-audit-truth.md`
**Worktree/branch:** `~/Jarv1s/.claude/worktrees/w3a-audit-truth`, branch `w3a-audit-truth`
**Coordinator label:** `Coordinator` (re-resolve pane fresh via `herdr pane list` — never reuse a
`…-N` from this doc). Coordinator was messaged (via `herdr agent prompt`) that this relay is
happening, before this doc was written.
**Risk tier:** security — Fable plan-review required at plan-ready, before coordinator approval.

## State: grounding done, plan is a DRAFT, no code written yet

Full grounding (file:line-cited, verified against this branch) for all three issues is in:
`docs/superpowers/plans/2026-08-09-wave-3-lane-a-action-audit-truth.md`

Read that file's "Grounding already done" section — trust it, don't re-derive. It covers:
- **#1256**: `/resolve` route (`packages/ai/src/routes.ts:533-553`) bypasses
  `gateway.resolveActionRequest` (`gateway.ts:425-450`, already correct). Reference impl:
  `packages/chat/src/routes.ts:346-382`.
- **#1252**: `__moduleError` sentinel — single choke point is `runHandler` in `gateway.ts:477-510`.
  Reuse `MossError` type (`packages/module-sdk/src/errors.ts:10-16`). Type change needed:
  `GatewayToolResponse` (`packages/ai/src/gateway/types.ts:53-64`) needs an `errorClass?` field.
  Three call sites to update: `gateway.ts:201, 241, 607`. No DB migration needed.
- **#1251**: only 2 of 7 `catch {}` blocks in `gateway.ts` are in scope —
  line ~416 (`runReadToolForActor`) and ~506 (`runHandler`). The other 5 are unrelated, already
  reviewed and ruled out (see plan doc for why).

That plan file's "Not yet done" section is the literal task list — copying it here would just
duplicate it, so **read it there**, don't skip it.

## What's NOT done — pick up here

1. Confirm the gateway's logger convention (no `this.deps.logger` found yet in greps so far —
   check the constructor/deps type of `AssistantToolGateway` in `gateway.ts`).
2. Find the composition root that constructs `AssistantToolGateway` and wires `packages/ai`'s
   routes (for #1256's `AiRoutesDependencies.gateway` threading) — not yet located.
3. Decide the #1256 response-shape question (additive field vs new status code for `"expired"`).
4. Finish the `plan-build`-shaped plan: task boundaries/order, exact signatures, test cases per
   spec Exit Criteria, kill gate, unpiped verification commands with expected exit codes.
5. Get Fable plan-review, then message coordinator "plan ready for
   wave-3-lane-a-action-audit-truth: <path>. Approve, or flag a fork." — **wait for approval before
   writing any code.**
6. Then: TDD build task-by-task, pre-push trio, `coordinated-wrap-up` (own gate on isolated DB,
   PR, live-path proof since #1256 is user-facing/UI-adjacent — the resolve action flowing through
   the real approve/deny UI).

## Do not re-litigate

The plan doc's grounding is verified against the actual branch as of 2026-08-09. Re-grep only if
something looks drifted, not routinely. No code has been written or committed in this lane yet —
you are starting the build fresh, not resuming mid-build.
