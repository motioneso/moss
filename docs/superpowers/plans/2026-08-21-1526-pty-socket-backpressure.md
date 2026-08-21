# Plan — #1526 propagate terminal socket backpressure to the PTY

**Spec:** `docs/superpowers/specs/2026-08-10-1140-backend-low-followups.md`, section 1140-D
(lines 189-232). **Tier per spec: routine infrastructure** (the earlier relay handoff flagged
"sensitive" — the spec itself says routine; going with the spec).
**Task issue:** #1526.
**Exclusive owned surface (from spec):** `packages/cli-runner/src/connection.ts`,
`packages/cli-runner/src/terminal-host.ts`, `packages/cli-runner/src/terminal-session.ts`,
`tests/unit/cli-runner-terminal-host.test.ts`, `tests/unit/cli-runner-protocol.test.ts`,
`tests/unit/cli-runner-terminal-rpc.test.ts`.

## Seams confirmed on this tree

- `packages/cli-runner/src/terminal-session.ts:33-84` — `TerminalSession` wraps `node-pty`'s
  `IPty` (`this.term`). No `pause`/`resume` today. `node-pty`'s `IPty` type has both natively
  (used elsewhere in the ecosystem; not re-verified here since we're only adding thin wrappers).
- `packages/cli-runner/src/terminal-host.ts:13-16` — `TerminalSink { data(id, bytes): void;
  exit(id, code): void }`. `open()` (`:32-59`) wires `session.onData(bytes => { ...; sink.data(id,
  bytes); })` at line 50, return value discarded.
- `packages/cli-runner/src/connection.ts:51-56` — `ByteChannel { write(buf): void; end(): void;
  on(event: "data"|"close"|"error", ...): void }`. No `drain` in the type today.
- `packages/cli-runner/src/connection.ts:102-119` — `pushSink.data`/`pushSink.exit` both call
  `safeWrite(channel, {...})` (`:482-490`), boolean result discarded by both.
- `packages/cli-runner/src/connection.ts:482-490` — `safeWrite` returns `boolean`: `true` on a
  successful `channel.write()` call, `false` only if `channel.write()` **threw**. It has no
  visibility into `write()`'s own return value today because `ByteChannel.write` is typed `void`.
- `packages/cli-runner/src/connection.ts:253,256` — the two ordinary req/response call sites:
  `if (!safeWrite(channel, ok)) close();` and the error-frame equivalent. These must keep closing
  only on the "threw" case.
- Test fakes (`tests/unit/cli-runner-protocol.test.ts:120-161`,
  `tests/unit/cli-runner-terminal-rpc.test.ts:44-76`) each define their own `FakeChannel implements
  ByteChannel` with `write(buf): void` (always succeeds, never returns `false`) and `on(event:
  "data"|"close"|"error", ...)` (no `"drain"` overload). Both need a `"drain"` overload added to
  their `on()` signature to satisfy the widened `ByteChannel` interface, plus (in the RPC file) a
  way to script one `write()` call returning `false`.
- `tests/unit/cli-runner-terminal-host.test.ts:10-25` — `fakeSession()` helper has no
  `pause`/`resume`; `TerminalHost` casts the fake through `unknown` (`asSession`), so adding
  `pause`/`resume` to the real `TerminalSession` type requires the fake to grow matching
  `vi.fn()` stubs or the cast still succeeds but assertions on `pause`/`resume` calls need them
  present on the fake object.

## Design decisions (contracts only)

### 1. `terminal-session.ts`

```ts
pause(): void;   // this.term.pause()
resume(): void;  // this.term.resume()
```
Added as two more one-line direct wrappers, same style as `resize`/`kill`.

### 2. `terminal-host.ts`

```ts
export interface TerminalSink {
  data(terminalId: string, bytes: Buffer): boolean | void; // false = caller should pause
  exit(terminalId: string, code: number): void;
}
```

`open()`'s `onData` callback (`:43-51`): after `sink.data(id, bytes)`, if the return value is
`=== false` and `this.session?.id === id` still holds, call `this.session.pause()`. (The liveness
check mirrors the existing `touch()` guard immediately above it — an evicted session's straggler
callback must not pause the CURRENT session.)

New public method:

```ts
resume(terminalId: string): void; // no-op unless this.session?.id === terminalId, else session.resume()
```

Implemented via the existing private `forId()` helper: `this.forId(terminalId)?.resume();`.

### 3. `connection.ts`

```ts
export interface ByteChannel {
  write(buf: Buffer): boolean | void; // true/false = real socket; void = existing test doubles
  end(): void;
  on(event: "data", listener: (chunk: Buffer) => void): void;
  on(event: "close" | "error", listener: () => void): void;
  on(event: "drain", listener: () => void): void;
}
```

`safeWrite` changes shape and return type:

```ts
function safeWrite(channel: ByteChannel, frame: RpcFrame): "sent" | "backpressure" | "error" {
  try {
    return channel.write(encodeFrame(frame)) === false ? "backpressure" : "sent";
  } catch {
    return "error";
  }
}
```

Call-site changes:

- Ordinary req/response sites (`:253`, `:256`, and the oversize-response site `:250`): replace
  `if (!safeWrite(...)) close();` with `if (safeWrite(...) === "error") close();` — `"backpressure"`
  falls through exactly like `"sent"` (frame is already in the OS socket buffer; not the module's
  problem).
- `pushSink.data` (`:103-110`): becomes

  ```ts
  data: (terminalId, bytes) => {
    const outcome = safeWrite(channel, { t: "push", bootId: deps.bootId, channel: "terminalData", terminalId, dataB64: bytes.toString("base64") });
    if (outcome === "error") { close(); return false; }
    if (outcome === "backpressure") { backpressureTerminalId = terminalId; return false; }
    return true;
  }
  ```

- `pushSink.exit` (`:111-118`): unchanged shape, just `if (safeWrite(...) === "error") close();` —
  backpressure is ignored for exit (one-shot message, spec says no pause/resume needed there).
- New connection-scoped `let backpressureTerminalId: string | null = null;` declared alongside
  `ownedTerminalId` (`:93`).
- In `serveConnection`, alongside the existing `channel.on("close", close)` /
  `channel.on("error", close)` (`:157-158`), register:

  ```ts
  channel.on("drain", () => {
    if (backpressureTerminalId) {
      deps.terminalHost.resume(backpressureTerminalId);
      backpressureTerminalId = null;
    }
  });
  ```

No queue, no retry, no byte copy anywhere in this design — matches the spec's explicit
prohibition.

## Determinism boundary

N/A — this is a transport-layer backpressure fix with no model involvement and no user-facing
chat surface. Not applicable to this task.

## Test plan (behavior + why each would fail against a broken implementation)

All in the three files already named as owned surface — no new files.

1. **`tests/unit/cli-runner-terminal-host.test.ts`** — add to `fakeSession()`: `pause: vi.fn()`,
   `resume: vi.fn()`.
   - New test: "a `false` return from sink.data pauses the live PTY once." `sink.data` mocked to
     return `false` once; emit one chunk; assert `made.pause` called exactly once. Fails today
     because `TerminalHost` never calls `pause` at all.
   - New test: "resume() is a no-op for an evicted terminal id." Open two sessions (second evicts
     first); call `host.resume(firstId)`; assert `made[0].resume` NOT called. Fails against a naive
     implementation that resumes whatever `this.session` currently is.
   - New test: "resume() resumes the live terminal by id." Open one session, call
     `host.resume(terminalId)`; assert `made.resume` called once. Fails if `resume()` isn't wired
     to `forId()`.

2. **`tests/unit/cli-runner-protocol.test.ts`** — extend the local `FakeChannel.on()` signature to
   accept `"drain"` (store a `drainListener`, add a `triggerDrain()` helper) — needed purely so the
   file still type-checks against the widened `ByteChannel`; existing tests need no behavior change
   since none of them script a `false`/`drain`. No new test required here per spec scope (ordinary
   frames must not close on `false`, and no test in this file currently makes `write` return
   `false` or throw — confirmed by grep, no existing coverage to preserve beyond type-compatibility).

3. **`tests/unit/cli-runner-terminal-rpc.test.ts`** — extend the local `FakeChannel`:
   - `on()` signature gains `"drain"`, stores `drainListener`, add `triggerDrain(): void`.
   - Add a `scriptedWriteResult: boolean | undefined` field; `write()` checks a settable
     "return false on next terminalData push" flag rather than a global toggle, to target only the
     PTY data push and not the `openTerminal` RpcOk frame that precedes it. Simplest shape: a
     mutable `failNextWrite = false` flag; `write()` returns `false` once when set (then clears it)
     instead of pushing to `written` — no, per spec the frame must still reach the socket buffer
     (a real `write() === false` means "accepted, buffer full", not "dropped"), so `write()` must
     still push to `written` AND return `false` the scripted time.
   - New test: "openTerminal, write, one scripted `false` on the terminalData push causes exactly
     one PTY pause; no bytes lost." Use the real `TerminalHost`/PTY (repo precedent in this file).
     After the pty echoes, assert the push frame still arrived (bytes not dropped) and that... the
     real `TerminalSession.pause()`/`resume()` call can't be spied without `makeSession` injection,
     so this test asserts on the observable behavior instead: no crash, no duplicate emission, and
     that a subsequent `triggerDrain()` doesn't throw for the same terminal. (Real-PTY pause/resume
     unit-level assertions belong in test 1, which injects `makeSession`; this file's job per spec
     is the wire-level plumbing — `false` doesn't close the connection, `drain` doesn't crash.)
   - New test: "a thrown write on `pushSink.data` still closes the connection and kills the
     connection-owned terminal." Script `write()` to throw once on the terminalData push; assert
     `channel.closed` becomes true and a subsequent `killTerminal`/any RPC on the same connection
     gets nothing further (connection already closed) — mirrors the existing close-scoping comments
     in `connection.ts:139-146`. This is the regression guard for "ordinary req/response frames
     keep close-on-error" applied to the push path specifically.

## Verification

```bash
pnpm vitest run tests/unit/cli-runner-terminal-host.test.ts tests/unit/cli-runner-protocol.test.ts tests/unit/cli-runner-terminal-rpc.test.ts > /tmp/1526-vitest.log 2>&1; echo "EXIT=$?"
```
Expected: `EXIT=0`, all three files' suites green, no test added and skipped.

```bash
pnpm tsc --noEmit -p packages/cli-runner > /tmp/1526-tsc.log 2>&1; echo "EXIT=$?"
```
Expected: `EXIT=0` — confirms `ByteChannel`/`TerminalSink` widened return types don't break any
other caller in the package (e.g. the real `net.Socket`-backed production `ByteChannel`
implementation, wherever it's constructed in `server.ts`/`main.ts`, still satisfies the interface
since real sockets return `boolean` already).

## Kill gate

None — this is a small, single-phase, low-risk infra fix (three files, additive interface
widening, no schema/migration, no user-facing surface). If the vitest run above doesn't go green
on the first real attempt, stop and re-diagnose rather than patching around it; that's the only
gate this task needs.

## Live-path

Not a user-facing UI feature — no screen, no chat surface. The real-PTY test in
`cli-runner-terminal-rpc.test.ts` (open → write → real shell echo → push frame) is the closest
thing to a live-path proof this surface has, and it already exists; the new backpressure test adds
to it rather than replacing it. State this plainly in the wrap-up: verified via real-PTY unit
test, not a live UI terminal session — this is routine infra tier per the spec, not sensitive tier.
