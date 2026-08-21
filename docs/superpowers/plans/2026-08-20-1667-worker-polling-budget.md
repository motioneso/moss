# Plan — #1667 module-sdk-worker + external-worker-runtime polling budget

**Type:** test-only timing fix, routine tier. No spec file (handoff explicitly waives it — the
GitHub issue body is the full scope). No user-facing surface, no UAT/live-path requirement.

## Seams check

- `tests/unit/module-sdk-worker.test.ts:41-47` — `next()` polls `messages.length` with a fixed
  `200 attempts * 5ms` budget (~1s), throws `"worker produced no protocol message"` on exhaustion.
  Confirmed present, unchanged from issue text.
- `tests/unit/external-worker-runtime.test.ts:181` — fixed `setTimeout(resolve, 20)` after
  `runtime.invoke(...)` resolves, then asserts on `logs` (populated via
  `packages/module-registry/src/external/worker-runtime.ts:413-425` `flushLogs`, called
  synchronously in the `invoke()` `finally` at line 244 — so `logs` is already populated by the
  time `invoke()` returns _for the stdout-driven path_). The actual race here is the child's
  `console.error("leak=" + …)` (test fixture, `external-worker-runtime.test.ts:61`) arriving on
  the **stderr** pipe, a separate OS pipe from the stdout RPC reply that resolves `invoke()`. This
  is a genuine delivery race between two independent pipes, not just slow cold start — confirmed
  by reading the fixture and `capture()`/`flushLogs()` wiring.

## Task 1 — module-sdk-worker.test.ts

Change the fixed attempt count to a wall-clock deadline so the effective budget is time-based
(~5s) rather than attempt-based, robust to per-attempt overhead:

```ts
const next = async () => {
  const deadline = Date.now() + 5_000;
  while (messages.length === 0 && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  if (messages.length === 0) throw new Error("worker produced no protocol message");
  return messages.shift() as Record<string, unknown>;
};
```

Test: `npx vitest run tests/unit/module-sdk-worker.test.ts` — expect exit 0, all 5 tests pass.

## Task 2 — external-worker-runtime.test.ts

Replace the fixed 20ms sleep with a bounded poll on `logs.length`, so the test waits exactly as
long as the stderr pipe actually takes (typically ms) but tolerates a slow sandbox up to 2s before
failing the same way it does today:

```ts
const deadline = Date.now() + 2_000;
while (logs.length === 0 && Date.now() < deadline) {
  await new Promise((resolve) => setTimeout(resolve, 5));
}
```

(inserted in place of `await new Promise((resolve) => setTimeout(resolve, 20));` at line 181,
directly before the existing `expect(JSON.stringify(logs)).toContain("[REDACTED]")` assertions —
those assertions are unchanged.)

Test: `npx vitest run tests/unit/external-worker-runtime.test.ts` — expect exit 0, all tests in
the file pass including "redacts learned credentials from bounded stderr".

## Kill gate

If either file still fails after these changes when run in isolation (`npx vitest run <file>`),
stop and escalate to the coordinator with the actual failure — do not keep raising numbers
speculatively. Owner: build agent (this lane).

## Verification (both files, combined — matches issue repro)

```bash
npx vitest run tests/unit/module-sdk-worker.test.ts tests/unit/external-worker-runtime.test.ts > /tmp/1667-verify.log 2>&1; echo "EXIT=$?"
```

Expected: `EXIT=0`.

Then full unit suite once, to confirm no regression elsewhere:

```bash
pnpm test:unit > /tmp/1667-full-unit.log 2>&1; echo "EXIT=$?"
```

Expected: `EXIT=0`.

## Determinism / UI boundary

N/A — no UI, no model output, no user-facing surface. Pure test-timing change.
