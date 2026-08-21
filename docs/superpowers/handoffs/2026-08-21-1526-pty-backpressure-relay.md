# Relay — 1526-pty-socket-backpressure

**Spec:** `docs/superpowers/specs/2026-08-10-1140-backend-low-followups.md`, section
"1140-D: propagate terminal socket backpressure to the PTY" (~lines 189-232). Read that section
only, not the whole file.
**Issue:** #1526. **Branch/worktree:** already checked out here, `1526-pty-socket-backpressure`.
**Coordinator:** label `Coordinator`, session id `ff54b7d3-1ff0-4fad-94ce-b8fa9062a3ad` — confirm
`herdr pane list` shows exactly one pane with that label before messaging it.
**Status:** research done, zero code written, zero commits. Go straight to `plan-build` (skip
re-reading the spec section again if this doc already covers it — it does).

## What's already confirmed true on this branch (don't re-derive)

- `packages/cli-runner/src/terminal-session.ts`: `TerminalSession` has NO `pause()`/`resume()`.
  Just `onData`, `onExit`, `write`, `resize`, `kill`, wrapping a real `node-pty` `IPty`.
- `packages/cli-runner/src/terminal-host.ts`: `TerminalHost.open()` wires `session.onData(bytes
  => { touch(); sink.data(id, bytes); })`. `TerminalSink.data(terminalId, bytes): void` — return
  value currently thrown away. No pause/resume anywhere.
- `packages/cli-runner/src/connection.ts`: `ByteChannel.write(buf): void` (real `net.Socket.write`
  return value is dropped). `pushSink.data` calls `safeWrite(channel, {...})` but the boolean
  result is discarded (data/exit pushes never close on a thrown write today — a latent bug, not
  in scope beyond what the spec asks). `safeWrite` (line ~482) only distinguishes "wrote OK" vs
  "threw" — it does not know about `write() === false` backpressure since `ByteChannel.write` is
  typed `void`. Ordinary req/response frames use `if (!safeWrite(...)) close();` — this existing
  close-on-error behavior for ordinary frames must NOT change.

## The design (worked out, not yet built)

1. **`terminal-session.ts`**: add `pause(): void { this.term.pause(); }` and
   `resume(): void { this.term.resume(); }` — direct wrappers, node-pty's `IPty` has both.
2. **`terminal-host.ts`**:
   - `TerminalSink.data(terminalId, bytes): boolean | void` (false = backpressure).
   - In `open()`'s onData callback: after calling `sink.data(id, bytes)`, if it returned exactly
     `false` AND `this.session?.id === id` still holds, call `this.session.pause()`.
   - Add `resume(terminalId: string): void` — only resumes if `this.session?.id === terminalId`
     (mirrors the existing `forId` liveness check). A drain for an evicted/killed terminal must be
     a no-op.
3. **`connection.ts`**:
   - `ByteChannel.write(buf: Buffer): boolean | void;` (permit both — real sockets return
     boolean, existing fakes return void).
   - Add `on(event: "drain", listener: () => void): void;` to the `ByteChannel` interface.
   - Change `safeWrite` to return a 3-way outcome (e.g. `"sent" | "backpressure" | "error"`):
     catches thrown write as `"error"`; otherwise returns `"backpressure"` iff `channel.write()`
     returned exactly `false`, else `"sent"`.
   - **Ordinary req/response call sites** (`ok`, `err`, hello frames): treat only `"error"` as
     close-worthy — `"backpressure"` must NOT close (spec: "must not mistake write() === false for
     data loss").
   - **`pushSink.data`**: call `safeWrite`; on `"error"` call `close()` (this already kills the
     connection-owned terminal via `ownedTerminalId`); on `"backpressure"` return `false` and
     record the terminalId in a connection-scoped variable (e.g. `backpressureTerminalId`); on
     `"sent"` return `true`.
   - **`pushSink.exit`**: same `"error"` → `close()`; ignore backpressure (one-shot message, not a
     data stream — spec doesn't ask for pause/resume on exit).
   - Register `channel.on("drain", () => { if (backpressureTerminalId) {
     deps.terminalHost.resume(backpressureTerminalId); backpressureTerminalId = null; } })` in
     `serveConnection`.

## Acceptance criteria to hit (from spec, verbatim intent)

- Fake channel returning `false` for terminal data → exactly one PTY pause, no byte retry/drop.
- Repeated PTY emissions while paused create no application-level queue (rely on node-pty's own
  `pause()` actually stopping `onData` emission — verify this empirically with a real PTY test).
- `drain` resumes only the same live terminal id that saw the `false`; a drain after
  eviction/close is a no-op for the replacement/killed terminal.
- A thrown channel write still closes the connection and kills the connection-owned terminal.
- Existing real-PTY open/write/echo/kill test in `tests/unit/cli-runner-terminal-rpc.test.ts`
  stays green (already read in full — it drives `serveConnection` through a `FakeChannel` with a
  REAL `TerminalHost`/PTY, polling for the echoed `terminalData` push).
- Run: `pnpm vitest run tests/unit/cli-runner-terminal-host.test.ts
  tests/unit/cli-runner-protocol.test.ts tests/unit/cli-runner-terminal-rpc.test.ts`

## Files already read this session (skip re-reading, just re-open if you need exact line numbers)

- `packages/cli-runner/src/terminal-session.ts` (84 lines, full)
- `packages/cli-runner/src/terminal-host.ts` (104 lines, full)
- `packages/cli-runner/src/connection.ts` (519 lines, full)
- `tests/unit/cli-runner-terminal-host.test.ts` (120 lines, full — uses a `fakeSession` helper
  with injected `makeSession`; you'll likely add a `pause`/`resume` mock there and a new test for
  the pause-on-false / resume-on-drain-if-live behavior)
- `tests/unit/cli-runner-terminal-rpc.test.ts` (215 lines, full — has the `FakeChannel` used for
  connection-level integration tests; you'll need to extend it or add a second fake channel that
  can script `write()` returning `false` once and later emit `"drain"`)

**Not yet read:** `tests/unit/cli-runner-protocol.test.ts` (540 lines) — only read the section
covering `safeWrite`/close-on-write-error for ordinary frames before touching it; don't read it
front to back.

## Live-path proof note

This is `sensitive` tier and needs the matched e2e-UAT gate per the handoff, or a real terminal
session exercised through the UI — state clearly in the wrap-up what was actually run. The
existing `cli-runner-terminal-rpc.test.ts` test already drives a REAL PTY end to end (not a mock),
which is strong evidence; decide at wrap-up time whether that satisfies "sensitive tier" or
whether a live UI terminal session is still needed.

## Next step for you

Go straight to `plan-build` using the design above (it's already decision-complete — paths,
signatures, the 3-way `safeWrite` outcome type, the pause/resume wiring). Message the coordinator
for plan approval before writing code, per `coordinated-build`.
