# Relay 2 — 1526-pty-socket-backpressure

**Plan (approved by coordinator):** `docs/superpowers/plans/2026-08-21-1526-pty-socket-backpressure.md`
— read this, it has every remaining signature/contract decision. Don't re-derive them.
**Issue:** #1526. **Branch/worktree:** already checked out here, `1526-pty-socket-backpressure`.
**Coordinator:** label `Coordinator` — **re-resolve by label fresh via `herdr pane list`**, don't
trust any pane number in this doc (they reflow). Already told it you're relaying.
**Tier:** routine infrastructure (coordinator confirmed: spec's own tier wins over an older,
stale "sensitive" note).

## Done (committed)

- Commit `274d72c49`: `TerminalSession.pause()`/`resume()` wrappers; `TerminalHost` pauses the
  live PTY when `TerminalSink.data` returns `false`, and exposes `resume(terminalId)` (no-op for a
  non-live id). Tests green: `tests/unit/cli-runner-terminal-host.test.ts` (7/7 pass).

## In progress, NOT committed — `packages/cli-runner/src/connection.ts`

Already edited (still on disk, uncommitted):
- `ByteChannel.write` widened to `boolean | void`; added `on(event: "drain", ...)` to the
  interface.
- Added `let backpressureTerminalId: string | null = null;` in `serveConnection`, right after the
  existing `ownedTerminalId` block.

**Still to do in `connection.ts`** (all specified exactly in the plan's "3. connection.ts"
section — just implement it):
1. Rewrite `safeWrite` (currently near the bottom of the file) to return
   `"sent" | "backpressure" | "error"` instead of `boolean`.
2. Update the three ordinary req/response call sites (the OK write, the oversize-response write,
   the error-frame write — search for `safeWrite(channel,`) to close only on `"error"`, not
   `"backpressure"`.
3. Rewrite `pushSink.data` to return `true`/`false` based on the 3-way outcome, setting
   `backpressureTerminalId` on `"backpressure"` and calling `close()` on `"error"`.
4. `pushSink.exit` — same close-on-`"error"` change, ignore backpressure.
5. Register `channel.on("drain", () => { if (backpressureTerminalId) { deps.terminalHost.resume
   (backpressureTerminalId); backpressureTerminalId = null; } })` in `serveConnection`, near the
   existing `channel.on("close", close)` / `channel.on("error", close)` lines.

## Tests already written (uncommitted) — both files updated, need connection.ts above to go green

- `tests/unit/cli-runner-protocol.test.ts` — its local `FakeChannel` already updated to accept a
  `"drain"` event in `on()` plus a `triggerDrain()` helper (type-compat only, no new test — ran
  green already at last check, 20/20).
- `tests/unit/cli-runner-terminal-rpc.test.ts` — its local `FakeChannel` already updated:
  `write()` now returns `boolean`, plus `scriptNextWrite("backpressure" | "throw")` and
  `triggerDrain()` helpers. Two new tests added at the end of the file:
  - `"a false write on the terminalData push does not close the connection or drop bytes, and a
    later drain does not throw"` — **currently passes even without the connection.ts changes**
    (current code already never closes on a discarded truthy return) — this is intentional, a
    regression guard against a *wrong* implementation that treats `false` as an error, not a
    driving test. Don't be alarmed that it's already green; just don't let it start failing.
  - `"a thrown write on the terminalData push closes the connection and kills the
    connection-owned terminal"` — **currently RED** (fails: `channel.closed` stays `false`).
    This is the one connection.ts must fix.

## Next step for you

1. Finish the 5 `connection.ts` edits above (all contracts are in the plan doc, no new decisions
   needed).
2. Run `pnpm vitest run tests/unit/cli-runner-terminal-host.test.ts tests/unit/cli-runner-protocol.test.ts tests/unit/cli-runner-terminal-rpc.test.ts > /tmp/1526-vitest.log 2>&1; echo "EXIT=$?"` —
   expect `EXIT=0`, all green.
3. Run `pnpm tsc --noEmit -p packages/cli-runner > /tmp/1526-tsc.log 2>&1; echo "EXIT=$?"` — expect
   `EXIT=0`.
4. Commit `connection.ts` + the two test files together (they're one coherent change) via the
   `shared-checkout` skill's explicit-path commit procedure — confirm `git diff` on each file is
   100% your own edits first (should be, this is a solo worktree, but follow the skill anyway).
5. Go straight to `coordinated-wrap-up` — gate, push, PR, live-path note (this task has no UI
   surface; the real-PTY tests in `cli-runner-terminal-rpc.test.ts` are the live-path evidence —
   state that plainly, per the plan's "Live-path" section).
6. Report the PR to the coordinator (label `Coordinator`, re-resolved fresh) and tell it to reap
   this relay's predecessor pane once you're confirmed driving (it already knows I relayed).
