# Build plan: 1352 admission liveness

Issue: #1352
Risk: sensitive (admission/liveness correctness)

## Seams check

- `CliChatEngineHost.currentLiveKeys()` is the shared admission seam at
  `packages/cli-runner/src/engine-host.ts:340-345`; `launchOnce` consumes it at
  `:192-200` and `beginLogin` consumes it at `:553-555`.
- The server registry is `Map<sessionKey, CliChatEngine>` at
  `packages/cli-runner/src/engine-host.ts:120-132`, and successful launches register engines at
  `:280-286`; this is the engine-kind-agnostic liveness source.
- MUX enumeration is `listLiveMuxSessions` at
  `packages/chat/src/live/cli-session-lifecycle.ts:28-45`. Orphan killing remains
  `killMuxSessionByName` from `packages/chat/src/live/cli-chat-engine.ts` and is used by
  `CliChatEngineHost.startupSweep` at `packages/cli-runner/src/engine-host.ts:615-624`.
- The third engine shape is `ClaudePersistentRuntimeEngine` at
  `packages/chat/src/live/persistent-runtime-engine.ts:51-191`; `createChatEngine` selects it
  when `persistentRuntimeEnabled` is true at `packages/chat/src/live/engine-selection.ts:98-109`.
- The intentional login coupling is specified in
  `docs/superpowers/specs/2026-06-20-cli-runner-login-contract.md:572-590` and implemented by
  `beginLogin` at `packages/cli-runner/src/engine-host.ts:544-567`.

No new platform capability or dependency is required.

## Phase 1 — widen the live set and lock the regressions

Files:

- `packages/cli-runner/src/engine-host.ts`
- `tests/unit/cli-runner-server.test.ts`
- `tests/unit/cli-runner-login.test.ts` (only if the existing login-gate test needs the
  registry-only case added there)
- `docs/superpowers/specs/2026-06-20-cli-runner-rpc-contract.md`

Decisions:

1. Change `currentLiveKeys()` to return the union of MUX keys, in-flight reservations, and
   `this.engines.keys()`. Keep the existing MUX enumeration and reservation behavior unchanged;
   the registry is an additive fail-closed signal, never the sole signal.
2. Do not use `isBoundedFallbackEngine` in the admission predicate. The registry union must cover
   interactive, bounded-fallback, and persistent-runtime engines without depending on the RPC
   root's current `persistentRuntimeEnabled: false` pin.
3. Do not change `startupSweep`, `kill`, `listLiveSessions`, or any orphan-reaping helper to use
   registry keys. Add a regression that a registry-only engine is counted by admission but is not
   passed to mux orphan reaping.
4. Amend §4.1.0a's frozen definition so it says `liveKeys = MUX ENUMERATION ∪ RESERVATIONS ∪
engine-registry keys`, and changes “never the engine Map” to “never the engine Map alone,” with
   the restart/disk rationale retained.

TDD slices and failure signals:

- Red: place a registry-only engine in the host seam and assert a different-key launch is rejected;
  this fails before the widening because the old implementation sees no mux session and no
  reservation. Verify the injected engine is a `ClaudePersistentRuntimeEngine` created through
  `createChatEngine(..., { persistentRuntimeEnabled: true })`, proving the third engine shape is
  covered rather than merely a generic stub.
- Green: add the registry-key union in `currentLiveKeys()` and keep the existing launch/kill
  lifecycle intact.
- Red/green: assert a registry-only key does not cause `startupSweep` to call
  `killMuxSessionByName`; assert a real mux orphan still is killed. This protects the explicit
  separation between admission liveness and mux-scoped orphan reaping.
- Red/green: assert `beginLogin` rejects while the registry-only engine is live, documenting the
  intentional §L.6.1 coupling. Keep the existing login-in-flight and mux-live coverage.
- Observe the focused EngineHost Vitest tests pass as the phase's end-to-end server seam; no UI
  UAT applies because this is an internal RPC admission-control fix.

Kill gate: if the persistent-runtime injection cannot be exercised without changing production
construction APIs, stop after the failing test and escalate the seam choice to `Coordinator`; do
not add a factory solely to make a unit test convenient.

Verification (each command must exit 0; commands are intentionally unpiped):

- `pnpm exec vitest run tests/unit/cli-runner-server.test.ts tests/unit/cli-runner-login.test.ts`
- `pnpm format:check`
- `pnpm lint`
- `pnpm typecheck`

## Closeout

Run the coordinated-wrap-up procedure: full isolated gate per its recipe, rebase on
`origin/main`, push branch `1352-admission-liveness`, open the sensitive-tier PR, and report the
focused test plus gate evidence to `Coordinator`. Do not merge or update the board.
