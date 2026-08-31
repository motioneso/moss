# Plan: fix #2149 — Approve response returns before the write it approved has happened

Branch: `fix/2149-recipe-status`. Closes #2149 ("UAT #1909: recipe rebuild confirmation leaves
recipeStatus 'missing' instead of 'feed'/'ready'"). Bug-fix to existing plumbing, not a new
feature/module — no new spec file; this plan and the handoff doc it follows
(`docs/superpowers/handoffs/2026-08-31-fix-2149-recipe-status-relay2.md`) are the design record.

## What's actually wrong (verified against current code, not the earlier race theory)

Every write tool in chat that needs the user to click Approve has this shape:

1. `confirmAndRun` (`packages/ai/src/gateway/gateway.ts:695-786`) creates the pending row, tells the
   browser "approve this?", then blocks on `await pendingResolution` (line 747) — a promise handed
   out by `ConfirmationRegistry.awaitResolution` (`packages/ai/src/gateway/confirmation-registry.ts:15-30`).
2. When the user clicks Approve, `resolveActionRequest` (`gateway.ts:511-552`) writes the row's
   status to `"confirmed"`, then calls `this.deps.confirmations.resolve(...)` (line 550) — which
   only wakes up step 1's blocked promise — and immediately returns `"resolved"` to the HTTP
   route (`packages/ai/src/routes.ts:558-589`).
3. Only after waking up does `confirmAndRun` call the tool's real handler (`runHandler`, line 776),
   which is what actually writes the database change (for #2149, `recipe_status`).

So the Approve HTTP call — and anything that reads the row right after it, including the UAT's
`confirmThroughMoss()` poll (`tests/uat/specs/1909-sports-public-source-completion.uat.spec.ts:204-243`)
— can see `"confirmed"` before the real write has committed. This is the same shape at a second
call site, `requestNativeToolPermission` (`gateway.ts:320-442`, blocks at line 414) — that path
doesn't run a handler itself (it just grants permission and returns `"allow"`), but it still uses
the same wake-up mechanism and must not be left dangling by this change.

Checked and ruled out: no `"executed"`/`"done"` status already exists —
`AiAssistantActionStatus` is exactly `"pending" | "confirmed" | "rejected" | "cancelled"`
(`packages/db/src/types.ts:263`, `packages/shared/src/ai-types.ts:161`, duplicated in both, not a
single source — out of scope to fix that duplication here).

## Fix direction

Make the Approve HTTP call wait for the woken-up call to actually finish handling the outcome
(run the handler if confirmed, emit the result, record the audit) before it responds — instead of
firing the wake-up and returning immediately. No DB schema change, no new status value, no other
module touched.

### `packages/ai/src/gateway/confirmation-registry.ts`

Add a second, independently-tracked completion signal alongside the existing outcome signal, so a
caller can wake the blocked call *and* wait for it to finish, while the woken call still reports
back when it's done — regardless of which of the two call sites above woke it.

```ts
export type ResolutionStatus = "confirmed" | "rejected" | "cancelled";
export type AwaitOutcome = ResolutionStatus | "timeout";

export class ConfirmationRegistry {
  awaitResolution(actionRequestId: string, timeoutMs: number): Promise<AwaitOutcome>; // unchanged signature/behavior

  /**
   * Wake the blocked call for this action (if one is live) and wait for it to report back via
   * markDone before resolving. Resolves to false immediately, with no wait, when no live waiter
   * existed (already timed out / already resolved / server restarted mid-wait) — same case the
   * old `resolve()` covered.
   */
  resolveAndAwaitCompletion(actionRequestId: string, status: ResolutionStatus): Promise<boolean>;

  /**
   * Called by the woken call once it has fully finished handling the outcome (denied path or
   * confirmed-and-executed path). A no-op if nothing is waiting on this id (e.g. the timeout
   * path already cleared it, or resolveAndAwaitCompletion was never called for it).
   */
  markDone(actionRequestId: string): void;

  isAwaiting(actionRequestId: string): boolean; // unchanged
}
```

Implementation notes (decisions, not code): keep the existing `waiters` map for the outcome signal
exactly as-is. Add a second `Map<string, () => void>` for completion resolvers, populated inside
`awaitResolution` (a completion promise is created alongside the outcome promise every time a call
blocks) and consumed/deleted by `markDone`. `resolveAndAwaitCompletion` calls the existing wake-up
logic (equivalent to the old `resolve()`) and, only when a live waiter was found, awaits the
completion promise before resolving `true`. Remove the old public `resolve()` method — replace its
one remaining internal use (if any) with the new pair, so there's a single path in and no
forgotten caller of the old fire-and-forget method.

### `packages/ai/src/gateway/gateway.ts`

- `resolveActionRequest` (line ~550): replace
  `this.deps.confirmations.resolve(actionRequestId, status); return "resolved";`
  with `await this.deps.confirmations.resolveAndAwaitCompletion(actionRequestId, status); return "resolved";`
  — same return value in the same cases (no live waiter still returns `"resolved"`, matching
  today's behavior; this plan doesn't change that, only adds the wait when a waiter exists).
- `confirmAndRun` (line 695-786): wrap the body from `const outcome = await pendingResolution;`
  (line 747) through both `return` statements in a `try`/`finally`, calling
  `this.deps.confirmations.markDone(action.id)` in the `finally`, so it fires on the denied path
  and the confirmed-and-executed path alike.
- `requestNativeToolPermission` (line 320-442): same wrapping around its own
  `const outcome = await pendingResolution;` (line 414) through its two returns, calling
  `this.deps.confirmations.markDone(action.id)` in a `finally`. Required — without it, an Approve
  of a native tool would hang inside `resolveAndAwaitCompletion` waiting for a `markDone` that
  never comes, since this call site currently has no such call.

No other call site awaits `pendingResolution` (confirmed by grep — only these two).

## Test plan

New test in `tests/integration/chat-mcp-transport.test.ts`, alongside the existing "write call
blocks, emits action_request, approves, executes" test (same file already wires a fake write tool,
`example.write`, through the real gateway and routes).

Add one fixture tool to `tests/integration/fixtures/example-tool-module.ts`: `example.slowWrite`,
identical to `example.write`'s handler but with a real 20ms delay (`await new
Promise((r) => setTimeout(r, 20))`) before it pushes to `exampleToolCalls`. A real elapsed delay
is required — without one, a same-tick race can pass by accident on both the broken and fixed
code, which would make the test unable to catch a regression.

Test: **"approve response is not observed until the tool's write has actually happened"**
- Start the blocked write call (same pattern as the existing `example.write` test) using
  `example.slowWrite`.
- Wait for the `action_request` emit (same `vi.waitFor` pattern already used in this file).
- Call `gateway.resolveActionRequest(ids.userA, req.actionRequestId, "confirmed")` and await it.
- Immediately after that await returns (no `vi.waitFor`, no extra delay), assert
  `exampleToolCalls` already contains an `example.slowWrite` entry for this call.
- Why this fails today: `resolveActionRequest` currently returns as soon as the row is written and
  the waiter is signalled, well before the 20ms delayed handler runs — the assertion sees an empty
  array. Why it passes after the fix: `resolveActionRequest` now awaits `markDone`, which only
  fires after the handler (and its 20ms delay) has completed.

Second, smaller test in the same block: assert `resolveActionRequest` on a rejected/cancelled
action (no live waiter case, reusing the existing 409/expired seeding pattern from
`tests/integration/ai-assistant-action-resolve.test.ts`) still returns promptly (no hang, no
timeout-length wait) — guards against `resolveAndAwaitCompletion` accidentally waiting when there
was nothing to wait for.

## Verification

```bash
pnpm --filter @moss/ai test -- gateway 2>&1 | tee /tmp/2149-ai-gateway.log; echo "EXIT=${PIPESTATUS[0]}"
```
Expected: EXIT=0 (adjust the filter/pattern to whatever actually matches `chat-mcp-transport.test.ts`
and `confirmation-registry` once in the repo — confirm the real vitest project name before running,
don't guess it).

Then the `verify-gate` skill for the full scoped gate (never run `pnpm verify:foundation` raw), plus:
```bash
pnpm vitest run tests/uat/specs/1909-sports-public-source-completion.uat.spec.ts 2>&1 | tee /tmp/2149-uat.log; echo "EXIT=${PIPESTATUS[0]}"
```
Expected: EXIT=0, and this is the live regression proof that #2149's actual symptom (recipeStatus
reads "missing" right after approving a rebuild) is gone.

## Kill gate

If `resolveAndAwaitCompletion` deadlocks anywhere (a call site that reaches `awaitResolution` but
whose caller never lets execution continue to a `markDone`, e.g. a thrown error before the
`finally` — should be structurally impossible with `try/finally` but must be checked in the audit
path, `recordAudit`, which is fire-and-forget `void this.recordAudit(...)` and must not be awaited
inside the `finally` before calling `markDone`, or a slow audit write would reopen the same delay
on a different tool), stop and report a concrete split to the coordinator rather than half-shipping
a hang risk. Owner of that call: me, in-session, before opening the PR — this is a small enough
change to verify directly rather than deferring to QA.

## Scope

One PR, closes #2149. No `docs/coordination` changes, no repo-wide formatting. Only the two files
above plus the two test files (`chat-mcp-transport.test.ts`, `example-tool-module.ts`) and the
release note.
