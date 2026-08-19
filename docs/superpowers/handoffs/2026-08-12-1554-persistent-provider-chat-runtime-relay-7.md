# Continuation: #1554 persistent-provider-chat-runtime (relay #7)

Branch/worktree: 1554-persistent-provider-chat-runtime. Clean tree, all committed through
`f3843d70c`. **No uncommitted changes exist — this checkpoint was written before any Decision-2
edits, purely from research.** Plan Fable-APPROVED, coordinator confirmed proceed-to-build. Do not
re-escalate either.

Source of truth: `docs/superpowers/plans/2026-08-12-1554-phase2-persistent-pool.md` (lines 130-208
for Decision 2). Read directly, do not re-derive.

Root typecheck gate: `npx tsc --noEmit -p .` (repo root, unpiped, check `EXIT=$?`). Most packages
have no own tsconfig — never `-p packages/<name>`.

## Task 3 (Decision 2) — design settled this session, NOT YET BUILT

Plan's `rpc-contract.ts` discriminated-union code (lines 137-163) is exact — apply verbatim,
replacing the current single `RpcPush` interface at `packages/chat/src/live/rpc-contract.ts:221-228`
(currently: one interface, `channel: "terminalData"|"terminalExit"`, optional `dataB64`/`exitCode`).
`ReapReason` import from `./provider-runtime.js` (already exports it, `provider-runtime.ts:26-33`).

**Server side — broadcast mechanism (this session's design decision, not in the plan verbatim,
resolves the plan's open "cite exact write call site" note):**

`CliChatEngineHost` (`packages/cli-runner/src/engine-host.ts`) is the one process-wide instance
shared across all accepted connections (constructed once in `main.ts:166`); `TerminalHost`'s
`pushSink`-per-open-terminal pattern (`connection.ts:98-119`) is per-connection, not process-wide,
so it doesn't fit — the pool's `onReap` fires host-side, not connection-side. Add a listener
registry to `CliChatEngineHost`, mirroring nothing exactly but consistent with its existing
per-process singleton role:

```ts
// engine-host.ts — new, near the other private Set/Map fields (~123-133)
export type SessionReapedListener = (sessionKey: string, reason: ReapReason) => void;
// on the class:
private readonly reapListeners = new Set<SessionReapedListener>();
addSessionReapedListener(listener: SessionReapedListener): () => void {
  this.reapListeners.add(listener);
  return () => this.reapListeners.delete(listener);
}
/** Called by the pool's onReap (wired in task #5, main.ts) — fans out to every connection. */
notifySessionReaped(sessionKey: string, reason: ReapReason): void {
  for (const listener of this.reapListeners) listener(sessionKey, reason);
}
```

`connection.ts`'s `serveConnection` registers on connect, unregisters on close, symmetric with how
`ownedTerminalId`/`close()` already work (~93-131):

```ts
// alongside the existing pushSink const (~102-119)
const unregisterReap = deps.host.addSessionReapedListener((sessionKey, reapReason) => {
  safeWrite(channel, { t: "push", bootId: deps.bootId, channel: "sessionReaped", sessionKey, reapReason });
});
// in close() (~121-137), alongside the existing ownedTerminalId kill:
unregisterReap();
```

`safeWrite` signature confirmed at `connection.ts:464-472`: `(channel: ByteChannel, frame: RpcFrame) => boolean`.

This gives the plan's RPC-topology test case a direct unit-test seam: construct/mock a host with
`addSessionReapedListener` capturing the registered listener, call `serveConnection`, invoke the
captured listener directly (simulating the pool's reap), assert `channel.write` was called with
`encodeFrame(...)` of the expected `sessionReaped` push. **`main.ts`'s actual wiring of
`PersistentRuntimePool`'s `onReap` to call `host.notifySessionReaped(...)` is task #5's job, not
task 3's** — task 3 only needs the registry + broadcast primitive to exist and be tested.

**Client side** (not yet started): `chat-engine-rpc-client.ts`'s `RpcConnection.routeFrame` (line
629) currently does `if (frame.t !== "ok" && frame.t !== "err") { ...drop... }` — this REJECTS any
push frame today (differs from relay-6's note; the drop happens in `routeFrame`, not because no
branch exists — confirmed by reading the file this session). Add a `frame.t === "push"` branch
BEFORE that check, handling `channel === "sessionReaped"` only (terminal pushes ride
`TerminalRpcClient`'s own separate connection per that file's own header comment — this connection
never sees `terminalData`/`terminalExit`). Add an `onSessionReaped?: (sessionKey, reason) => void`
field to `RpcConnectionOpts` (sibling to `onReconcile` at line 149), invoke it from the new push
branch. `ChatEngineRpcClient`'s constructor/wiring point (class starts line 734) is where the
manager will supply the real callback — mirrors how `onReconcile` is threaded today (grep
`onReconcile` for the exact call site before writing).

`ChatSessionManager.handleRemoteReap(sessionKey, reason)` — new method, sibling to
`reconcileLiveSessions` (`chat-session-manager.ts:814`), per plan lines 181-188 verbatim (delete
from `sessions` map if cached, revoke MCP token; no-op if not cached).

## Full remaining task list (unchanged from relay-6)

3. Decision 2 (in progress, design above)
4. Decision 3 — idle-reap timer ownership (plan lines 210-228)
5. Wire pool into composition points + lift `persistentRuntimeEnabled` pin (`engine-selection.ts`
   ~76-92, `engine-host.ts` ~252, `runtime.ts` ~117-146) — **also where task 3's
   `notifySessionReaped` wiring belongs**, plus in-process topology wiring `deps.mcpTokenLifecycle?.revoke`
   straight into the pool per plan lines 190-193.
6. `routes.ts` wiring — check lane #1256 conflict protocol first (plan's "Finding B"), use
   `shared-checkout` skill.
7. e2e-P2: `tests/integration/persistent-pool-reap.test.ts` (plan lines 345-377).
8. Pre-push trio, rebase onto `origin/main`, `verify-gate` skill, push, PR, report to coordinator
   (re-resolve fresh via `ListAgents`/`herdr pane list`).

## Next action

Build task 3 exactly as designed above: rpc-contract.ts type change → engine-host.ts registry →
connection.ts wiring → chat-engine-rpc-client.ts push branch + `onSessionReaped` opt →
`chat-session-manager.ts`'s `handleRemoteReap` → write the 4 plan-stated tests (lines 195-208) →
root typecheck → commit via `shared-checkout` discipline (multiple files, none currently known
co-edited, but diff-and-verify per skill regardless). Then task 4.
