# Plan — 1527-crash-shutdown-latch (spec §1140-E)

**Spec:** `docs/superpowers/specs/2026-08-10-1140-backend-low-followups.md` §1140-E
**Issue:** #1527 (`Part of #1140`)
**Tier:** routine process-lifecycle. No UAT/live-path required (no user-facing surface — see
handoff doc, confirmed by coordinator).

## Seams check (file:line citations, this branch)

- `apps/api/src/server.ts:714-734` — `handleCrash` is a plain closure declared inside the
  `if (import.meta.url === ...)` bootstrap guard. Not exported, not testable. No latch: every
  `unhandledRejection`/`uncaughtException` call re-logs, re-races a fresh `server.close()`, and
  re-calls `process.exit(1)`.
- `apps/api/src/server.ts:691-706` — `shutdownOnSignal` is already an exported, parameterized
  helper (`{ timeoutMs, exit }`) used for the clean SIGTERM/SIGINT path. This is the pattern to
  mirror for the new crash-handler factory. `tests/unit/api-signal-shutdown.test.ts` shows the
  existing test idiom (stub `close`, stub `exit`, `vi.useFakeTimers()`).
- `apps/worker/src/worker.ts:401-419` — worker's `handleCrash` is a closure inside `bootstrap()`,
  same shape and same gap: no latch, not exported, not unit-testable without spawning the binary.
  Logs via `console.error(JSON.stringify(...))` (no fastify logger available at this layer).
- `apps/worker/src/worker.ts:365-375` — `shutdown()` (the thing crash-handling races against) is
  already returned on `WorkerHandle` from `buildWorker()`, so a stub `{ shutdown }` handle is all
  the new factory needs to be unit-testable.
- `tests/integration/worker-lifecycle.test.ts` — existing worker test file already imports from
  `apps/worker/src/worker.js` and stubs `WorkerHandle`-shaped objects; confirms the import path
  (`.js` extension, ESM) and stubbing style to reuse.
- No existing `crashing`/latch variable anywhere in either file — confirmed via grep; spec's
  "add a latch" premise is current, not stale.

## Design

Two small, file-local factories (not a shared cross-package crash manager — spec forbids that).
Each returns a closure over one `crashing` boolean set **before** logging/shutdown starts, so a
second call in the same crash window is a no-op.

### `apps/api/src/server.ts` — new exported factory, replacing the inline `handleCrash`

```ts
export function createCrashHandler(
  server: {
    log: { error(obj: Record<string, unknown>, msg: string): void };
    close(cb: (err?: Error) => void): void;
  },
  opts: { timeoutMs?: number; exit?: (code: number) => never } = {}
): (label: string, err: unknown) => void;
```

- `timeoutMs` default `2000` (unchanged from current inline value — spec bans changing timeout
  durations).
- `exit` default `(code) => process.exit(code)`, overridable for tests (mirrors `shutdownOnSignal`).
- Behavior: on first call, set `crashing = true`, then `server.log.error({ err, label }, "Process
crash — exiting")`, race `server.close()` against the timeout, then `exit(1)`. Any call while
  `crashing` is already true returns immediately — no log, no second close, no second timer, no
  second exit.
- Bootstrap block (`server.ts:714-734`) shrinks to:
  ```ts
  const handleCrash = createCrashHandler(server);
  process.on("unhandledRejection", (reason) => handleCrash("unhandledRejection", reason));
  process.on("uncaughtException", (err: Error) => handleCrash("uncaughtException", err));
  ```

### `apps/worker/src/worker.ts` — new exported factory, replacing the inline `handleCrash`

```ts
export function createCrashHandler(
  handle: { shutdown(): Promise<void> },
  opts: { timeoutMs?: number; exit?: (code: number) => never; log?: (line: string) => void } = {}
): (label: string, err: unknown) => void;
```

- `timeoutMs` default `2000`, `exit` default `process.exit`, `log` default
  `(line) => console.error(line)` — injected so the test doesn't assert against stdout.
- Behavior mirrors the api factory: latch set first; on first call, format the same
  `{ level: "fatal", label, err: message, msg: "Process crash — exiting" }` JSON line via `log(...)`
  (keeps the existing non-Error-reason redaction: `err instanceof Error ? err.message : "unknown"`),
  race `handle.shutdown()` against the timeout, then `exit(1)`.
- `bootstrap()` (`worker.ts:401-434`) shrinks to:
  ```ts
  const handleCrash = createCrashHandler(handle);
  process.on("unhandledRejection", (reason) => handleCrash("unhandledRejection", reason));
  process.on("uncaughtException", (err: Error) => handleCrash("uncaughtException", err));
  ```

Both factories are named `createCrashHandler` but live in separate modules (no import between
`apps/api` and `apps/worker`) — no collision, no shared cross-package manager. SIGINT/SIGTERM
clean-exit paths in both files are untouched.

## New test file: `tests/unit/process-crash-handlers.test.ts`

Mirrors `tests/unit/api-signal-shutdown.test.ts`'s stub/fake-timer idiom. Imports
`createCrashHandler` from both `apps/api/src/server.js` and `apps/worker/src/worker.js` (aliased
`createApiCrashHandler` / `createWorkerCrashHandler` on import to disambiguate in one file).

Test cases (behavior + why each fails against the current un-latched code):

1. **api: second crash before shutdown settles is swallowed.** Stub `server.log.error`, `server.close`
   (hangs, never calls back), `exit`. Call the returned handler twice synchronously with different
   labels before advancing fake timers. Assert `log.error` called once, with the _first_ label/err.
   Advance timers to the timeout; assert `close` called once and `exit` called once with `1`.
   — Fails today: current inline code has no latch, so two calls would double-log, double-race,
   and could double-call `exit`.
2. **api: prompt close exits without waiting for the timeout.** `close` invokes its callback
   synchronously. Assert `exit(1)` resolves without needing `vi.advanceTimersByTimeAsync`.
3. **api: hanging close still exits 1 after 2s.** `close` never calls back;
   `vi.advanceTimersByTimeAsync(2000)`; assert `exit` called with `1`.
4. **worker: second crash before shutdown settles is swallowed.** Stub `handle.shutdown` (hangs),
   `log`, `exit`. Two calls, different labels/errors (one `Error`, one non-Error to check message
   redaction only fires on the first). Assert `log` called once with the first label and the
   redacted message from the first error, `exit` called once with `1`.
5. **worker: prompt shutdown exits without waiting.** `handle.shutdown()` resolves immediately;
   assert `exit(1)` without advancing timers.
6. **worker: hanging shutdown still exits 1 after 2s.** Mirrors case 3 via
   `vi.advanceTimersByTimeAsync(2000)`.

## Verification (run in this order; every command unpiped, exit code checked explicitly)

```bash
pnpm exec vitest run tests/unit/process-crash-handlers.test.ts > /tmp/1527-new.log 2>&1; echo "EXIT=$?"
# expect EXIT=0

pnpm exec vitest run tests/unit/api-signal-shutdown.test.ts > /tmp/1527-api-signal.log 2>&1; echo "EXIT=$?"
# expect EXIT=0 (unchanged behavior, still green)

pnpm exec vitest run tests/integration/worker-lifecycle.test.ts > /tmp/1527-worker-lifecycle.log 2>&1; echo "EXIT=$?"
# expect EXIT=0 (unchanged behavior, still green)

pnpm format:check > /tmp/1527-format.log 2>&1; echo "EXIT=$?"
pnpm lint > /tmp/1527-lint.log 2>&1; echo "EXIT=$?"
pnpm typecheck > /tmp/1527-typecheck.log 2>&1; echo "EXIT=$?"
# expect EXIT=0 each

# Full gate at wrap-up time, per coordinated-wrap-up's isolated-gate-DB recipe (not improvised here).
```

## Determinism boundary

N/A — no model-facing or user-facing surface. Pure process-lifecycle control flow.

## Kill gate

Single phase (task is two ~20-line factory extractions plus one new test file — does not warrant
phase-splitting). Kill condition: if making either closure deterministic under test requires
touching a file outside `apps/api/src/server.ts`, `apps/worker/src/worker.ts`,
`tests/unit/process-crash-handlers.test.ts` (the exact owned surface), stop and escalate to the
coordinator rather than expanding scope. Owner of that call: coordinator.

## Open questions

None — every assumed capability above is cited `file:line` against the current branch.
