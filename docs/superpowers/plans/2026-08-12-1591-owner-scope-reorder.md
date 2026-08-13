# Plan — #1591 owner-scope-before-liveness reorder

**Spec:** issue #1591 body is the spec (no separate spec doc — follow-up from #1256/PR #1587
security QA + Fable sign-off). **Risk tier:** security. **Branch:** `1591-owner-scope-reorder` off
`origin/main` @ `fa929d489`.

## Seams check (file:line, verified on this branch)

- Bug site: `packages/ai/src/gateway/gateway.ts:433-458`, `AssistantToolGateway.resolveActionRequest`.
  Current order for `status === "confirmed"`: line 445 checks the **unscoped**
  `this.deps.confirmations.isAwaiting(actionRequestId)` first — if false, returns `"expired"`
  immediately, before the owner-scoped DB call ever runs. Only when `isAwaiting` is true does it
  fall through to the owner-scoped `repository.resolveAssistantAction` (line 450-451), which
  returns `"not_found"` on owner mismatch. Net effect: a non-owner's confirm attempt returns
  `"expired"` (409) when no live waiter exists anywhere, but `"not_found"` (404) when a live waiter
  exists for that id under a *different* owner — leaking one bit of "does a live waiter exist for
  this id" to a non-owner via response code, confirmed present today.
- `packages/ai/src/gateway/confirmation-registry.ts:12-49` — `ConfirmationRegistry` is an in-memory
  `Map<actionRequestId, Waiter>`, no actor scoping anywhere in the class. `isAwaiting` (line 46) is
  a pure existence check on that map. Confirms the check is structurally unscoped — the fix must
  keep it that way (it can't be, DB doesn't track live-waiter state) and instead gate *when* it runs.
- `packages/ai/src/repository.ts:1723-1729` — `getAssistantAction(scopedDb, actionId)`: existing
  RLS-scoped SELECT, no status filter, already used elsewhere in the codebase (e.g. the parity test
  below). Reusable as the owner-scoped pre-check — no new repository method needed.
- `packages/ai/src/repository.ts:1760-1780` — `resolveAssistantAction(scopedDb, actionId, {status})`:
  existing RLS-scoped UPDATE, `WHERE status = 'pending'`, returns `undefined` on no match (wrong
  owner or already resolved). Unchanged — still the single place that ever persists a status change.
- `packages/ai/src/routes.ts:548-566` and `packages/chat/src/routes.ts:~380-400` both call
  `gateway.resolveActionRequest` and map `"expired"→409`, `"not_found"→404`, `"resolved"→200/204`.
  Neither route file changes — the fix is entirely inside `resolveActionRequest`.
  Reject/cancel path (`status !== "confirmed"`) never touches `isAwaiting` today (line 445's `&&`
  guards on `status === "confirmed"`) — already owner-scoped-first via the single UPDATE call, so
  it already returns uniform `"not_found"` regardless of any liveness state. **No change needed
  there.**
- `tests/integration/ai-assistant-action-resolve.test.ts:78-99` — existing test "both routes 404 an
  unknown action id" **documents the current oracle in its own comment**: "'confirmed' short-circuits
  to 409 (expired) before an existence check ever runs — reject/cancel skip the live-waiter gate
  entirely, so they're the only statuses that can reach the not-found path." That comment describes
  exactly the bug #1591 fixes and goes stale once the reorder lands — must be corrected, and the
  now-true case (confirmed + unknown id → 404) is worth asserting explicitly.
- No unit test today exercises `resolveActionRequest` with a real live waiter
  (`tests/unit/mcp-gateway-recovery.test.ts` is the closest precedent for constructing
  `AssistantToolGateway` directly with mocked `repository`/`runner` and a real `ConfirmationRegistry`
  instance — pattern confirmed at `tests/unit/mcp-gateway-recovery.test.ts:12-22`). The integration
  test file can't easily create a genuine live waiter (would require driving a real blocked MCP tool
  call), so the "live waiter vs no waiter, both non-owner, same outcome" exit criterion is proven at
  the gateway unit level instead, where `confirmations.awaitResolution(id, timeoutMs)` can register
  a real waiter directly.

## Decision

For `status === "confirmed"` only: run the owner-scoped existence+pending check
(`repository.getAssistantAction`, RLS-scoped SELECT) **before** ever branching on `isAwaiting()`.
If the row is missing, owned by someone else (RLS filters it out), or not `"pending"`, return
`"not_found"` immediately — `isAwaiting` and `resolveAssistantAction` are never called on that path.
Only an actor-owned, still-pending row reaches the liveness check, which behaves exactly as today
(`"expired"` if no live waiter, else the existing owner-scoped `resolveAssistantAction` UPDATE +
`confirmations.resolve` + `"resolved"`). This makes every non-owner outcome take the identical code
path (one SELECT, no isAwaiting call, no UPDATE) regardless of live-waiter state, closing the oracle,
while preserving the #1256 fail-closed invariant (a "confirmed" is never persisted for a dead
waiter — the liveness check still gates the actual UPDATE for an owned row).

Reject/cancel: unchanged.

## Task 1 — reorder `resolveActionRequest`

File: `packages/ai/src/gateway/gateway.ts`, `resolveActionRequest` (lines 433-458). Signature
unchanged:

```ts
async resolveActionRequest(
  actorUserId: string,
  actionRequestId: string,
  status: "confirmed" | "rejected" | "cancelled"
): Promise<"resolved" | "expired" | "not_found">
```

New body shape (decision, not implementation):

1. Build `access: AccessContext` once, as today.
2. For `status === "confirmed"`: run `this.deps.runner.withDataContext(access, scopedDb =>
   this.deps.repository.getAssistantAction(scopedDb, actionRequestId))` first. If the result is
   `undefined` or its `status !== "pending"`, return `"not_found"` — do not call `isAwaiting` or
   `resolveAssistantAction`.
3. Still for `status === "confirmed"`, past that gate: keep the existing liveness check — if
   `!this.deps.confirmations.isAwaiting(actionRequestId)`, return `"expired"`.
4. Proceed to the existing `repository.resolveAssistantAction` UPDATE + `confirmations.resolve` +
   return `"resolved"`, unchanged (still re-checks `status = 'pending'` at the DB level, so a race
   between step 2's read and this UPDATE still fails closed to a legitimate `"not_found"`).
5. For `status !== "confirmed"`: unchanged, straight to the existing UPDATE call.

Keep the existing fail-closed comment (lines 438-444); add one line above the new pre-check citing
#1591 and stating the ownership-before-liveness ordering rationale.

## Task 2 — unit test: cross-owner indistinguishability (the core exit criterion)

New file `tests/unit/gateway-resolve-owner-scope.test.ts`, pattern from
`tests/unit/mcp-gateway-recovery.test.ts:12-22` (construct `AssistantToolGateway` directly, mocked
`repository`/`runner`, real `ConfirmationRegistry`).

Local fixture: an in-memory `{ id, ownerUserId, status }` row plus mocked
`getAssistantAction`/`resolveAssistantAction` that only match when the mock's `scopedDb` carries
the owning actor (simulates RLS) and, for `resolveAssistantAction`, only when `status === "pending"`.

Test cases:

- **"non-owner confirm is identical whether or not a live waiter exists"**: seed one pending row
  owned by `owner-1`. Run two sub-cases as actor `attacker-2` — (a) no waiter registered, (b)
  `confirmations.awaitResolution(row.id, 10_000)` called first to register a live waiter (don't
  await the returned promise; settle it via `confirmations.resolve` in test cleanup to avoid a
  leaked timer). Assert **both** resolve to `"not_found"`, and in both cases
  `resolveAssistantAction` and `confirmations.resolve` (the mock's, not the registry's) were never
  called and `getAssistantAction` was called exactly once — i.e. identical call graph, not just
  identical return value, for both waiter states.
- **"owner confirm still distinguishes real liveness"** (regression guard for the #1256 invariant
  this must not break): as `owner-1`, no waiter → `"expired"`, row stays `"pending"`,
  `resolveAssistantAction` never called. As `owner-1` with a registered waiter → `"resolved"`, row
  becomes `"confirmed"`, `resolveAssistantAction` called once.

Why this would fail against the current (broken) code: case (b) above hits `isAwaiting` before any
ownership check and gets a live waiter → `true` → falls through to `resolveAssistantAction`, which
the current code *does* call (returns undefined on owner mismatch, but the call graph differs from
case (a), which returns `"expired"` without calling it at all). The new test's call-graph assertion
fails on unpatched code; passes once Task 1 lands.

## Task 3 — integration test: end-to-end 404 parity + comment fix

File: `tests/integration/ai-assistant-action-resolve.test.ts`.

- Fix the stale comment on the existing "both routes 404 an unknown action id" test (lines 79-81):
  it currently asserts only `status: "rejected"` and explains why `"confirmed"` couldn't be used
  pre-fix. Update the comment to state the pre-#1591 reason has been fixed and reject/cancel remain
  the simplest case to assert.
- Add a new test in the same `describe` block: **"both routes now 404 an unknown action id with
  status=confirmed too (#1591)"** — POST `status: "confirmed"` to both
  `/api/ai/assistant-actions/:unknownId/resolve` and `/api/chat/action-requests/:unknownId/resolve`
  using an unknown-but-valid-shaped UUID (reuse the `unknownId` constant pattern from the existing
  test). Assert both return **404**, not 409 — this is the previously-impossible-to-reach case
  (confirmed + no such row) now taking the same not-found path as reject/cancel, proven through the
  real HTTP routes and real DB.

## Task 4 — gate

`verify-gate` skill, isolated gate DB, full local gate green:
```bash
pnpm verify:foundation > /tmp/1591-gate.log 2>&1; echo "EXIT=$?"
```
Expected `EXIT=0`. Pre-push trio before any push, per `coordinated-build` step 3b:
```bash
pnpm format:check && pnpm lint && pnpm typecheck
git fetch origin main && git rebase origin/main
```

## Kill gate

If satisfying the reorder requires touching any file beyond `packages/ai/src/gateway/gateway.ts`
and the two test files above (e.g. a route or schema change turns out to be needed), stop and
escalate to the coordinator before continuing — that would mean the seams check above missed
something and the scope has grown past a single-function reorder.

## Exit criteria (from handoff, restated)

- Unit test (Task 2) proves a cross-owner confirm against a live waiter and against no-waiter
  return the identical outcome and call graph.
- Integration test (Task 3) proves the same end-to-end over real HTTP + DB for the unknown-id case.
- Full gate green (Task 4).
- PR open, rebased on `origin/main`, tagged `[SECURITY]`, not merged by this agent.
