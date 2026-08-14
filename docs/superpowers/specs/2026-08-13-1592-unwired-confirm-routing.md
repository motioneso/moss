# #1592 — Scope the unwired-gateway 503 to statuses that need the gateway

**Status:** Proposed (awaiting approval)
**Date:** 2026-08-13
**Owner:** Ben
**GitHub:** task #1592 · follow-up from #1256 / PR #1587 QA finding NEW-2

---

## Context

PR #1587 (#1256) closed the confirmation-registry bypass: the ai module's resolve route
`POST /api/ai/assistant-actions/:id/resolve` no longer persists a decision straight through the
repository, but routes every resolution through the chat module's live `AssistantToolGateway`.
The gateway is built inside chat's wiring closure only when both `resolveActiveModules` and
`mcpServerUrl` are supplied (`packages/chat/src/routes.ts:230-231`) and is published back to the
composition root via the `adoptChatGateway` seam (`packages/chat/src/routes.ts:267`,
`packages/module-registry/src/index.ts:2372-2375`).

When the gateway is never adopted ("unwired"), the ai route's `resolveActionRequest` closure
rejects with 503 for **every** status (`packages/module-registry/src/index.ts:1388-1393`). PR
#1587's security-tier QA recorded this as finding **NEW-2**: before #1587, `reject`/`cancel`
worked without any gateway (direct owner-scoped persist, see
`git show 2c00c3ace~1:packages/ai/src/routes.ts`); now they 503.

**Severity is non-blocking and the state is unreachable in every real deployment**:
`createApiServer` always supplies `mcpServerUrl` (`apps/api/src/server.ts:179`, env fallback to
loopback) and `ApiServerConfig.mcpServerUrl` is a required `string`
(`apps/api/src/server.ts:133`). The unwired topology exists only in test harnesses that compose
routes without chat wiring. This is a correctness / defense-in-depth fix, not an urgent one.

## Goal

Scope the fail-closed 503 to the statuses that genuinely require the gateway (`confirmed`, which
may unblock a paused tool call and cause **execution**), and restore gateway-independent behavior
for `rejected`/`cancelled` — without weakening any security property #1587 established.

## Grounded mechanism (all citations verified 2026-08-13 on this branch)

- Route handler: `packages/ai/src/routes.ts:541-574`. Body parse (`:547`, validator `:861-869`
  accepts only `confirmed | rejected | cancelled`) runs **before** the 503 dependency guard
  (`:548-550`), so unknown statuses 400 in every topology.
- Wired path: the module-registry closure defers to the per-server getter
  (`packages/module-registry/src/index.ts:2212-2216`) which holds
  `gateway.resolveActionRequest` after chat adoption.
- `AssistantToolGateway.resolveActionRequest` (`packages/ai/src/gateway/gateway.ts:433-459`):
  `confirmed` with no live confirmation waiter → `"expired"` (route → 409, fail-closed: a
  confirm only means anything while the blocked call is awaiting); otherwise an **owner-scoped,
  pending-only** UPDATE via `repository.resolveAssistantAction`
  (`packages/ai/src/repository.ts:1760-1780`, RLS-scoped `DataContextDb`, `WHERE status =
'pending'`) → `"not_found"` (404) when no row matched, else unblock the waiter and
  `"resolved"` (200).
- "Execute" is **not** an API status. Execution happens only when a confirm unblocks a live
  `ConfirmationRegistry` waiter inside the gateway. Unwired ⇒ no registry ⇒ no waiters ⇒
  execution is structurally impossible.
- The chat route `POST /api/chat/action-requests/:id/resolve` is registered only inside the
  `if (wiring)` block (`packages/chat/src/routes.ts:370-410`): unwired, that route does not
  exist (404). It is out of scope and unchanged.

## Behavior matrix (the contract)

Wired rows reflect **post-#1591** semantics (owner-scoped pre-check before liveness; see
Collision section).

| Status                    | Wired (every real deployment)                                                                                                                         | Unwired — current | Unwired — target                                                                                                                                        |
| ------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `confirmed` (may execute) | foreign / unknown / non-pending id → 404; owner pending, no live waiter → 409; owner pending, live waiter → 200, unblocks the paused call ⇒ execution | 503               | **503, unchanged** (same message). Execution is impossible without the gateway; persisting `confirmed` would create a phantom success row. Fail closed. |
| `rejected`                | owner pending → 200, persisted (unblocks waiter if live); foreign / unknown / non-pending → 404                                                       | 503               | owner pending → 200, persisted; foreign / unknown / non-pending → 404 — identical to wired (there is no waiter to unblock)                              |
| `cancelled`               | same as `rejected`                                                                                                                                    | 503               | same as `rejected`                                                                                                                                      |
| anything else             | 400 (parse precedes gateway checks)                                                                                                                   | 400               | 400, unchanged                                                                                                                                          |

Locked decision — unwired `confirmed` stays **503, not 409**: 409 ("expired — ask again") would
invite a retry that can never succeed; 503 says the deployment cannot resolve confirms at all.
This also keeps the diff smallest and matches the fix the issue prescribes. It discloses nothing
(returned for every confirm regardless of id, before any lookup).

## Design

**Chosen — a gateway-owned unwired resolver, seeded as the fallback.**

`packages/ai/src/gateway/gateway.ts` exports a standalone factory (exact signature in the plan)
that returns a function with the same shape as `AssistantToolGateway["resolveActionRequest"]`:

- `confirmed` → throw `HttpError(503, "Assistant action resolution is not available")` (today's
  message, surfaced through the route's existing `handleRouteError` path).
- `rejected` / `cancelled` → the same owner-scoped, pending-only
  `repository.resolveAssistantAction` persist the gateway uses → `"not_found" | "resolved"`.
  No confirmation-registry interaction: none exists in this topology.

The module-registry ai-route closure (`packages/module-registry/src/index.ts:1388-1393`) falls
back to this resolver when the per-server getter yields `undefined`. The route-level 503 guard
(`packages/ai/src/routes.ts:548-550`) stays untouched as the floor for direct `registerAiRoutes`
callers that pass no resolver at all.

Why here: it keeps the #1587 QA-verified invariant intact — **every caller of
`repository.resolveAssistantAction` stays in `gateway.ts`** (currently exactly two:
`gateway.ts:300` YOLO auto-grant and `gateway.ts:451` gated path). The status-conditional
security decision ("confirm requires a gateway") lives beside the gateway's existing fail-closed
confirm guard where future editors of confirm semantics will see it, not in composition-root glue.

**Rejected alternative (steelmanned):** thread wiredness to the route layer and direct-persist
`rejected`/`cancelled` in `packages/ai/src/routes.ts`, restoring the pre-#1587 handler shape
scoped by status. It is a genuinely small diff, the route already holds `repository` and
`dataContext`, and reject/cancel direct-persist was never the #1256 vulnerability (declining is
always safe). Rejected because it re-opens a route-layer caller of
`repository.resolveAssistantAction` — the exact grep surface the #1587 QA used to prove the
bypass closed — and splits status-conditional security logic across two packages. One future
"make confirm work here too" edit away from re-opening #1256.

## Security invariants preserved

- Confirm/execute cannot bypass the confirmation registry: unwired confirm never persists and
  never executes (503 before any DB write); wired path unchanged.
- Owner-only RLS: the fallback persist runs through `DataContextRunner.withDataContext` with the
  caller's `actorUserId`, same as the gateway — foreign ids 404, rows untouched.
- Pending-only terminality: the `WHERE status = 'pending'` UPDATE means a resolved row can never
  be flipped, in either topology.
- No new fields on `AccessContext`; no secrets, no job payloads, no migrations, no schema change.

## Non-goals

- No change to the chat resolve route, the gateway's wired `resolveActionRequest` body, the
  `ConfirmationRegistry`, or any RLS policy.
- No change to any real-deployment behavior (the unwired topology is test-only).
- Not user-visible: release-note line is "internal correctness fix; no user-visible change".

## Collision with #1591 / PR #1613 — checked, overlap confirmed, serialize

PR #1613 ("check owner scope before confirmation liveness") edits
`packages/ai/src/gateway/gateway.ts` (`resolveActionRequest`, `:433-458`) and
`tests/integration/ai-assistant-action-resolve.test.ts`, and changes wired confirm semantics
(owner-scoped pre-check before `isAwaiting`; already-resolved confirm → 404 instead of 409).

- Same-file overlap: this design adds a sibling export to `gateway.ts`.
- Behavioral dependency: the wired rows of the matrix above assume post-#1591 ordering.
- Therefore **implementation serializes after #1591 lands on `main`** (this spec/plan proceeds
  now, per the handoff). The build starts from a rebase onto a `main` that contains #1613; the
  new tests live in a new file to avoid test-file merge friction.

## Kill gate

Single-phase change. The observation that ends the line: if unwired `rejected`/`cancelled`
cannot be delivered without modifying the wired `resolveActionRequest` body, the
`ConfirmationRegistry`, or any RLS policy, stop — that is a scope escape from a non-blocking
test-topology fix. Call: Coordinator; any security-behavior fork goes to Ben.
