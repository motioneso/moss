# Phase 2: persistent-provider warm pool, cap, LRU, idle-reap

Tracking issue: #1554. Parent plan:
`docs/superpowers/plans/2026-08-10-1557-persistent-provider-chat-runtime.md` (Phase 2 scope,
lines 230-241). Phase 1 (neutral lifecycle contract, single adapter, single fork point) is already
shipped in this tree — this plan only adds pool admission, LRU eviction, idle-reap, and the
settings/token wiring those need. No function bodies below; signatures, DDL/JSON, and test cases
only, per `plan-build`.

## Seams (file:line, current tree)

- Single fork point: `packages/chat/src/live/engine-selection.ts:76-92`,
  `createChatEngine()` — `if (opts.persistentRuntimeEnabled && provider === "anthropic")`
  unconditionally constructs `ClaudePersistentRuntimeEngine`. No pool consultation today.
- `ChatEngineSelectionOpts`: `engine-selection.ts:28-50`.
- Engine constructed once per live session, reused across turns:
  `packages/chat/src/live/chat-session-manager.ts` `ensureSession()` (~188-210, cache hit on
  `this.sessions`), `launchSession()` (~234, `engineFactory` call site), `healAndRelaunch()`
  (~304-317, the only other reconstruction path). Pool admission therefore intercepts only at
  `engineFactory`/`createChatEngine` call time — no per-turn re-check needed.
- RPC composition root: `packages/cli-runner/src/engine-host.ts` `launchOnce()` (~180-269),
  `createChatEngine(...)` call at ~242 with `persistentRuntimeEnabled: false` hardcoded at line
  252 (comment cites the #1557/#1350 guard explicitly as a later-phase pin). Phase 2 lifts this
  pin. Per-sessionKey serialization already exists: `enqueue()` (~140-155); `engines` Map
  (~123, all engine kinds, not pool-specific); `admissionMutex` (~129, from
  `packages/cli-runner/src/mutex.ts:7`, NOT importable into `packages/chat` — confirmed via both
  packages' `package.json` `dependencies`, cli-runner depends on `@moss/chat`, not the reverse).
- In-process composition root: `packages/chat/src/live/runtime.ts` `createRealEngineFactory()`
  (~117-146), delegates to `createChatEngine()`. No pool today.
- Live-flag read (only place `persistentRuntimeEnabled` can be `true` in prod today):
  `packages/module-registry/src/chat-multiplexer.ts` `resolveChatEngineFactory()` (~390-508),
  `createPersistentRuntimeEnabledLiveReader` — re-reads `chat.persistent_runtime.enabled` per
  call, not boot-snapshot.
- Adapter/runtime injection seam: `packages/chat/src/live/persistent-runtime-engine.ts:41`
  (`ClaudePersistentRuntimeEngineOpts.runtime`) — a pool constructs/owns a `ProviderChatRuntime`
  and hands it to a fresh `ClaudePersistentRuntimeEngine` per session; adapters stay 1:1 with
  sessions, only the underlying runtime is pooled/capped.
- State/health source of truth: `packages/chat/src/live/provider-runtime.ts:41-46`
  (`RuntimeHealth { alive; state: ChildState; turnsCompleted; lastResultAt }`), `:18-24`
  (`ChildState`), `:26-33` (`ReapReason`, already includes `"lru-evict"`/`"idle-timeout"`, Phase 1
  forward-compat, unchanged by this plan).
- No provider-side session file to purge on any termination path:
  `packages/chat/src/live/claude-persistent-runtime.ts:265` (`--no-session-persistence`),
  corroborated `persistent-runtime-engine.ts:45-49`. Reap is just `reap(reason)`, no separate
  purge step.
- MCP token registry: `packages/ai/src/gateway/session-tokens.ts:54`
  (`class SessionTokenRegistry`), `:106` (`revokeBySessionId`), `:123` (`listSessionIds`).
  Constructed exactly once, API-process-side: `packages/chat/src/routes.ts:217`
  (`const tokens = new SessionTokenRegistry();`), threaded into `ChatSessionManager` via
  `deps.mcpTokenLifecycle?.revoke` (`runtime.ts:433`). **cli-runner has no reference to this
  registry** — separate OS process reached only via the RPC socket in the containerized topology.
- Existing reconciliation path (API-side, already revokes tokens):
  `chat-session-manager.ts:814` `reconcileLiveSessions(liveKeys: Set<string>)` — for any cached
  `sessionKey` not in the cli-runner-reported live set, kills via `deps.killSession` or
  `session.engine.kill()`, deletes from `this.sessions`, and calls
  `this.deps.revokeMcpToken?.(sessionKey)` (line 846). Today this only fires "on every socket
  (re)connect AND on a detected cli-runner `bootId` change" (doc comment, line 805-806) — **not**
  on a spontaneous cli-runner-side reap event, which is the gap this plan closes (see Decision 2).
- RPC push envelope (server→client, unsolicited, already exists for one use case):
  `packages/chat/src/live/rpc-contract.ts:221-228` (`RpcPush { t: "push"; bootId; channel:
  "terminalData" | "terminalExit"; terminalId; dataB64?; exitCode? }`), `:231`
  (`RpcFrame = RpcRequest | RpcOk | RpcErr | RpcPush`). Consumed today only by
  `packages/chat/src/live/terminal-rpc-client.ts:178-181` (`frame.channel === "terminalData"`/
  `"terminalExit"` branches, `onTerminalData`/`onTerminalExit` callback registration ~122-127).
  `packages/chat/src/live/chat-engine-rpc-client.ts` has **no push handling at all today** —
  its frame handler only branches on `frame.t === "ok"` (line 643); no `"push"` case exists yet.
- Settings registry: `packages/settings/src/runtime-config-keys.ts` (65 lines) — 3 entries today,
  none `type: "int"`, no `minValue`/`maxValue` fields on `RuntimeConfigKeyEntry` (:3-13).
  `packages/settings/src/runtime-config-resolver.ts:74-84` `resolveInt()` — parses + asserts
  integer, no bounds check. `packages/settings/src/runtime-config-routes.ts:53-68`
  `validateRuntimeValue()` — for `type === "int"` only checks `Number.isInteger`, no min/max
  support.

## Decision 1 — pool shape and admission

New file `packages/chat/src/live/persistent-runtime-pool.ts`. Provider-agnostic despite the name
prefix matching the existing `persistent-runtime-engine.ts`; only Claude uses it in Phase 2
(ruling 7: no vendor names in product surfaces — internal file/type names are not a product
surface, consistent with existing `claude-persistent-runtime.ts`).

```ts
export interface PersistentRuntimePoolDeps {
  readonly cap: number; // chat.persistent_pool_cap, read once at pool construction (Decision 4)
  readonly createRuntime: (sessionKey: string, opts: EngineLaunchOpts) => ProviderChatRuntime;
  readonly onReap?: (sessionKey: string, reason: ReapReason) => void; // fires AFTER a runtime.reap() this pool initiated (idle-timeout | lru-evict), not on caller-driven kill
  readonly clock: { now(): number };
}

export type AdmitResult =
  | { readonly kind: "admitted"; readonly runtime: ProviderChatRuntime }
  | { readonly kind: "denied" }; // caller falls back to bounded engine, ruling 5

export class PersistentRuntimePool {
  constructor(deps: PersistentRuntimePoolDeps);
  /** Fail-closed admission: atomic cap-check + LRU-evict-one-idle-if-needed + construct, under
   *  a per-pool lock (single lock, not per-key — cap/evict decisions are pool-global). */
  admit(sessionKey: string): Promise<AdmitResult>;
  /** Caller-driven (session end, incognito end, explicit kill) — always allowed regardless of state. */
  release(sessionKey: string, reason: ReapReason): Promise<void>;
  /** Idle-timeout sweep, called on a fixed interval by the composition root (Decision 3). Re-checks
   *  each idle-tracked child's `health()` immediately before reaping (atomic re-check, no stale kill). */
  sweepIdle(idleThresholdMs: number): Promise<void>;
  size(): number;
}
```

Admission algorithm (stated as behavior, not code):
1. Under the pool's single lock: if current pool size `< cap`, construct via `createRuntime`,
   track it, return `admitted`.
2. Else, scan tracked runtimes' `health()` for any in `idle` state (never `in-turn` or
   `awaiting-approval` — ruling 3, awaiting-approval children are never reaped or evicted). If
   none idle, return `denied` (ruling 5 — bounded-fallback for this session's lifetime).
3. If an idle victim exists, re-check its `health()` once more immediately before evicting (atomic
   re-check requirement, plan line 233), evict the least-recently-used idle one
   (`lastResultAt` ascending), call `runtime.reap("lru-evict")`, invoke `deps.onReap`, construct
   the new runtime, return `admitted`.

**Test cases (behavior, not implementation):**
- Admit N ≤ cap sessions concurrently → all `admitted`, pool size == N, no reap calls.
- Admit cap+1 sessions where all existing are `in-turn` → `denied` for the (cap+1)th, zero reap
  calls (busy children never evicted). Fails against a broken impl that evicts a busy child.
- Admit cap+1 where one existing is `idle` → `admitted` for the (cap+1)th, exactly one
  `reap("lru-evict")` call against the idle one, `onReap` fired once. Fails against an impl that
  evicts the wrong (non-LRU) idle child when two are idle — test with two idle children at
  different `lastResultAt` and assert the older one was evicted.
- Admit cap+1 where an idle child transitions to `in-turn` between the first `health()` scan and
  the atomic re-check (simulated via a `health()` stub that changes answer on second call) →
  `denied`, zero reap calls. Fails against an impl that reaps on the stale first read.

## Decision 2 — idle-reap crosses the process boundary via a new RPC push channel

The RPC/containerized topology's cli-runner-resident pool cannot call `revokeBySessionId`
directly (API-process-only, seam above). Extend the existing `RpcPush` envelope
(`rpc-contract.ts:221-228`) rather than build a new mechanism:

```ts
// rpc-contract.ts — extend the existing union with a discriminated member, additive.
// (Fable review nit: a shared interface with optional fields lets a caller construct an
// ill-typed "terminalData" push carrying reapReason, or a "sessionReaped" push missing
// sessionKey, and the compiler would accept both. A discriminated union on `channel` makes
// both illegal at the type level instead of relying on runtime discipline.)
export interface RpcPushTerminalData {
  readonly t: "push";
  readonly bootId: string;
  readonly channel: "terminalData";
  readonly terminalId: string;
  readonly dataB64: string;
}
export interface RpcPushTerminalExit {
  readonly t: "push";
  readonly bootId: string;
  readonly channel: "terminalExit";
  readonly terminalId: string;
  readonly exitCode: number;
}
export interface RpcPushSessionReaped {
  readonly t: "push";
  readonly bootId: string;
  readonly channel: "sessionReaped";
  readonly sessionKey: string;
  readonly reapReason: ReapReason;
}
export type RpcPush = RpcPushTerminalData | RpcPushTerminalExit | RpcPushSessionReaped;
```

`terminal-rpc-client.ts:178-181`'s existing `frame.channel === "terminalData"` / `"terminalExit"`
narrowing already discriminates on this field, so widening the union does not change that call
site's behavior — only its type safety.

`engine-host.ts`'s pool wiring passes `onReap` (Decision 1) as a callback that writes an
`RpcPush { channel: "sessionReaped", sessionKey, reapReason: reason, bootId }` frame to every
connected client — same dispatch primitive `connection.ts` already uses for `terminalData`/
`terminalExit` (cite exact write call site during task-build; not yet read this session, grep
`encodeFrame` usage in `packages/cli-runner/src/connection.ts`).

Client side: `chat-engine-rpc-client.ts` currently has no `frame.t === "push"` branch at all
(only `"ok"` at line 643) — add one, mirroring `terminal-rpc-client.ts:178-181`'s pattern. On
`channel === "sessionReaped"`, invoke a new narrow method on `ChatSessionManager`:

```ts
// chat-session-manager.ts — new method, sibling to reconcileLiveSessions (:814)
/** Single-key counterpart to reconcileLiveSessions, driven by an unsolicited cli-runner push
 *  (RpcPush channel "sessionReaped") rather than a full reconnect/bootId-change reconciliation
 *  pass. Same effect as one iteration of reconcileLiveSessions's not-in-liveKeys branch for
 *  exactly this key: delete from `sessions` if cached, revoke the MCP token. No-op if the key
 *  isn't cached (already reconciled, or was never a persistent session). */
async handleRemoteReap(sessionKey: string, reason: ReapReason): Promise<void>;
```

In-process topology (no cli-runner sidecar) needs none of this — the pool there is constructed
in the same process as `SessionTokenRegistry` and takes `revokeMcpToken` as a direct
`PersistentRuntimePoolDeps.onReap` callback (no RPC hop; `runtime.ts`'s composition root wires
`deps.mcpTokenLifecycle?.revoke` straight into the pool it constructs).

**Test cases:**
- In-process pool: `sweepIdle` reaps a child past threshold → `onReap` fires synchronously →
  injected `revokeMcpToken` spy called once with the reaped `sessionKey`. Fails against an impl
  that reaps without revoking.
- RPC topology: cli-runner pool reaps a child → asserts an `RpcPush{channel:"sessionReaped"}`
  frame was written to the connection (mock connection, assert `encodeFrame` call args) — fails
  against an impl that reaps locally in cli-runner without ever notifying the API side.
- API-side client: receiving a `sessionReaped` push for a cached sessionKey → asserts
  `chatSessionManager.handleRemoteReap` was called with the right key/reason, and after it
  resolves, `revokeBySessionId` (spy on the real `SessionTokenRegistry` instance) was called
  exactly once. Fails against an impl that only updates local pool bookkeeping without touching
  the token registry.
- Push for a sessionKey NOT in `sessions` (already reconciled another way) → `handleRemoteReap`
  no-ops, `revokeBySessionId` NOT called a second time. Fails against a double-revoke bug.

## Decision 3 — idle-reap timer ownership

The pool (`PersistentRuntimePool`) does not own its own `setInterval`. `sweepIdle()` is a public
method; the composition root that constructs the pool (`engine-host.ts` for RPC topology,
`runtime.ts` for in-process) owns one timer per process, calling `pool.sweepIdle(idleThresholdMs)`
on an interval (recommend `min(idleThresholdMs / 6, 5 minutes)`, so a 30-min default reaps within
~5 min of crossing the threshold, not up to 30 min late) and reading
`chat.persistent_idle_reap_minutes` fresh on each tick (live-config, matching the existing
`persistentRuntimeEnabled` live-reader pattern at `chat-multiplexer.ts`'s
`createPersistentRuntimeEnabledLiveReader`, not a boot-snapshot).

**Test cases:**
- `sweepIdle(30 min)` with one child idle for 31 min → reaped (`reap("idle-timeout")`, `onReap`
  fires with reason `"idle-timeout"`, distinguishable from `"lru-evict"` in the push/callback
  payload).
- `sweepIdle(30 min)` with one child idle for 29 min → not reaped.
- `sweepIdle` with a child `in-turn` for 40 min (long-running turn, not idle) → not reaped
  (idle-reap keys off `ChildState === "idle"` + time-since-`lastResultAt`, never off wall-clock
  session age).

## Decision 4 — settings registry entries + bounds validation

```ts
// runtime-config-keys.ts additions
export const CHAT_PERSISTENT_POOL_CAP_CONFIG_KEY = "chat.persistent_pool_cap";
export const CHAT_PERSISTENT_IDLE_REAP_MINUTES_CONFIG_KEY = "chat.persistent_idle_reap_minutes";

// RuntimeConfigKeyEntry gains two optional fields (additive, consistent with existing enumValues?):
readonly minValue?: number;
readonly maxValue?: number;

// two new RUNTIME_CONFIG_REGISTRY entries:
{ key: CHAT_PERSISTENT_POOL_CAP_CONFIG_KEY, label: "Persistent chat pool cap", type: "int",
  description: "Max warm persistent-provider child processes held at once.",
  defaultValue: "4", envVar: "MOSS_CHAT_PERSISTENT_POOL_CAP", minValue: 1, moduleOwner: "chat" }
{ key: CHAT_PERSISTENT_IDLE_REAP_MINUTES_CONFIG_KEY, label: "Persistent chat idle reap minutes",
  type: "int", description: "Minutes an idle persistent child may sit before being reaped.",
  defaultValue: "30", envVar: "MOSS_CHAT_PERSISTENT_IDLE_REAP_MINUTES", minValue: 1,
  moduleOwner: "chat" }
```

`validateRuntimeValue()` (`runtime-config-routes.ts:53-68`) gains, for `type === "int"`: after
the existing `Number.isInteger` check, if `entry.minValue !== undefined && n < entry.minValue`
→ reject; same for `maxValue`. Values reach cli-runner via RPC launch params (per the parent
plan's Settings & Flags section), never child env — no change needed to sanitized-env handling.

**Test cases:**
- PATCH `chat.persistent_pool_cap` to `"0"` → rejected (below `minValue: 1`), existing value
  unchanged. Fails against an impl that only checks `Number.isInteger`.
- PATCH to `"8"` → accepted, `resolveInt` reads back `8`.
- PATCH to `"3.5"` → rejected (not an integer) — pre-existing check, regression guard only.

## Finding B (Fable review) — routes.ts edit scope + lane #1256 conflict protocol

**Phase 2 does edit `packages/chat/src/routes.ts`.** The pool is constructed inside
`registerChatRoutes()`'s `wiring` closure (`routes.ts:190-222`), alongside the existing
`const tokens = new SessionTokenRegistry();` at `:217`, and threaded into `createChatSessionRuntime`
via a new opt on the object returned from `wiring` (mirroring how `mcpTokenLifecycle` is threaded
today at `:272-299`) and a new field passed into `createChatSessionRuntime({...})`'s call at
`:196-300`. This is a real edit to the file, not a passthrough.

**Confirmed collision with lane #1256.** Verified by direct diff against the sibling worktree
(`git -C .claude/worktrees/1256-confirmation-registry-bypass diff origin/main --
packages/chat/src/routes.ts`; branch not pushed to `origin`, not fetchable by ref name — diff the
worktree directly). #1256 inserts:
- a new `adoptChatGateway?: (gateway: AssistantToolGateway) => void;` field into the
  `ChatRoutesDependencies` interface, current main line ~147-150.
- a call `if (wiring) dependencies.adoptChatGateway?.(wiring.gateway);` immediately before the
  `createChatSessionRuntime({...})` call, current main line ~254-255.

That call-site insertion point is the **same textual boundary** — the gap between the `wiring`
closure's close and `createChatSessionRuntime({...})`'s start — that Phase 2's pool-threading edit
also needs. Both lanes add a new dependencies-interface field and a new statement/opt in this exact
region. This is a literal-adjacency collision, not a coincidental same-file touch.

**Conflict protocol (binding, apply at build time, not now):**
1. Before starting the `routes.ts` task, re-check #1256's state: has it merged to `origin/main`
   yet? (`git fetch origin main && git log origin/main --oneline --grep=1256` or check the issue/PR
   directly — state may have changed since this plan was written.)
2. If #1256 has already merged: rebase this branch onto latest `origin/main` first, so
   `adoptChatGateway` is already present, then re-read `routes.ts` fresh (line numbers will have
   shifted) before writing Phase 2's addition. Do not reconstruct the file's shape from this plan's
   citations post-rebase — they're pre-#1256 line numbers.
3. If #1256 has not yet merged: proceed against current `origin/main` without it. Do not block on
   or coordinate merge order with lane #1256 — that's out of scope for a single build agent.
   Whichever of the two PRs merges second will hit an ordinary rebase conflict in this region at
   merge time; both edits are additive (a new interface field, a new statement before
   `createChatSessionRuntime`), not overlapping logic, so the conflict is mechanical — resolve by
   keeping both additions, don't drop either.
4. Any commit touching `routes.ts` in this shared worktree follows the `shared-checkout` skill's
   procedure (CLAUDE.md "Working in a shared checkout": "even a path-scoped commit is unsafe on a
   co-edited file") — invoke it before committing, explicit `git add packages/chat/src/routes.ts`,
   never `-A`/`.`.
5. Do not touch or remove `adoptChatGateway` or its call site if present after a rebase — that's
   #1256's surface. Phase 2 adds its own field/statement alongside it, additively.

## Determinism boundary

No model-generated lifecycle prose anywhere in this phase (ruling 6). Pool admission,
eviction, and reap are pure server-side decisions with no chat-visible text of their own; any
user-facing effect (a turn running on bounded-fallback instead of persistent) is invisible at the
product surface — same reply contract either way, per the parent plan's engine-selection
transparency requirement. No new UI in this phase.

## Finding A (Fable review) — token-revocation assertion mechanism, decided

`SessionTokenRegistry` is constructed once, in-process, inside `registerChatRoutes()`'s `wiring`
closure (`routes.ts:217`, `const tokens = new SessionTokenRegistry();`) and never exposed via any
route — `listSessionIds()` (cited by Fable at `routes.ts:297`) is called only from within that same
closure, never routed to an HTTP handler. There is no process-external way to query it, and none
should be added:

- Adding a new introspection endpoint (option (b) in Fable's review) creates a new route that
  reveals live session-token state — a new sensitive surface needing its own security posture,
  review, and RLS/ownership scoping, out of proportion to what Phase 2 needs, and in tension with
  CLAUDE.md's "Secrets never escape" invariant (session tokens should stay off any response
  surface, not gain a dedicated read path).
- It's also unnecessary: Decision 2's **third test case** (line ~202-206 above) already proves
  revocation with equivalent strength — "API-side client: receiving a `sessionReaped` push for a
  cached sessionKey → asserts `chatSessionManager.handleRemoteReap` was called ... and
  `revokeBySessionId` (spy on the real `SessionTokenRegistry` instance) was called exactly once."
  That's an in-process integration test (option (a)), asserting against the real registry
  instance, not a mock of it — the same class of evidence a Playwright-driven introspection call
  would give, without adding API surface.

**Decision: option (a).** Token revocation is proven exclusively by Decision 2's in-process
integration tests (all four test cases, line ~195-208). e2e-P2 (below) is scoped to what is
genuinely only observable from outside the process — real child-process lifetime and pool-slot
reclamation — and drops the token-revocation assertion entirely rather than reaching for
`SessionTokenRegistry` through a channel that doesn't exist. This also means e2e-P2 needs no live
dev instance or Playwright at all: nothing in Phase 2 has a UI surface (Determinism boundary,
above — "No new UI in this phase"), so the CLAUDE.md Live-Path Gate's live-UI-proof requirement
does not apply here; a Vitest integration test against a running API + real `ps` calls is the
correct and sufficient e2e for a backend-only lifecycle feature.

## e2e-P2 — "reap is real"

Vitest integration test (not Playwright — no UI surface, see Finding A above) against a running
API process with `chat.persistent_runtime.enabled=true`, `chat.persistent_pool_cap=2`,
`chat.persistent_idle_reap_minutes` set low (e.g. `1` via runtime-config PATCH for the test):
1. Start 3 concurrent chat sessions (3 distinct actors) → assert via `ps` (not logs) that exactly
   2 persistent child processes exist (matching the Claude CLI process pattern used elsewhere in
   this codebase for prod-worker identification) and the 3rd session's engine is the bounded
   fallback kind (assert via engine-selection's `isBoundedFallbackEngine` equivalent check on the
   session, not a log line).
2. Let session 1 or 2 go idle past the 1-minute threshold → assert via `ps` that its child process
   is gone within the sweep interval. (Token revocation is NOT asserted here — it's covered by
   Decision 2's in-process test cases, which run against the real `SessionTokenRegistry` instance
   and are the authoritative evidence per Finding A above.)
3. Start a 4th session → assert it is admitted as `persistent` (the reaped slot was reclaimed).

Lives at `tests/integration/persistent-pool-reap.test.ts`, following the existing per-feature
convention (e.g. `tests/integration/chat-live.test.ts`, run via `test:chat` — confirmed by reading
`package.json`'s scripts and `tests/integration/`'s listing; `packages/chat/package.json` has no
test runner of its own, only `typecheck`, and no `*.test.ts` files exist under `packages/chat` —
Fable's mechanical correction on the prior draft's `pnpm --filter @moss/chat test:e2e` command,
which does not exist). Add a `test:persistent-pool` script entry to root `package.json` alongside
the other `test:<feature>` entries, matching the existing pattern exactly:
`"test:persistent-pool": "tsx scripts/test-integration.ts tests/integration/persistent-pool-reap.test.ts"`.
`scripts/test-integration.ts` self-isolates onto a fresh `jarvis_test_<entropy>` database by
default (`createDatabaseIsolationPlan`, only passthrough-mode if `JARVIS_PGDATABASE` is already
set) — no extra isolation flag needed here, unlike e.g. `test:commitments`'s explicit
`JARVIS_PGDATABASE=` prefix.

```bash
pnpm test:persistent-pool > /tmp/e2e-p2.log 2>&1; echo "EXIT=$?"
# expected EXIT=0
```

## Kill gate

Owner: whoever runs this plan's Phase 2 build (per `coordinated-build`, report to coordinator).
Kill condition: if Decision 2's API-side client test case (revocation-on-push) cannot be made to
pass against the real `SessionTokenRegistry` instance — i.e., if the push-driven
`handleRemoteReap` path genuinely fails to reach `revokeBySessionId` in practice (e.g. push frames
prove undeliverable across a real reconnect race) — stop, do not merge, escalate the
process-boundary design back to the coordinator/spec owner rather than loosening evidence to
log-based assertion (violates plan-build Rule 6's evidence-not-logs requirement) or adding an
introspection route under time pressure (reopens the option (b) tradeoff Finding A rejected above,
without the security review that would require).

## Rulings ledger (carried from parent plan, still binding)

- Ruling 3: `awaiting-approval` children are never reaped or evicted — enforced in Decision 1's
  admission scan (only `idle` state is eviction-eligible) and Decision 3's sweep (idle-reap keys
  off `ChildState === "idle"` only).
- Ruling 5: all-busy at cap ⇒ bounded-fallback for that session-launch, no queueing, decision
  persists for the session's lifetime (not re-evaluated per turn — settled this session via
  `chat-session-manager.ts` engine-caching behavior, see Seams above).
- Ruling 6: zero model-generated lifecycle prose — reaffirmed in Determinism boundary above.
- Ruling 7: provider-agnostic naming in product surfaces; internal Phase-1-precedent file naming
  (`claude-persistent-runtime.ts`-style) is not a product surface and is not in scope for this
  ruling.
- New this plan: idle-timeout-reap and lru-evict-reap both revoke via the SAME code path
  regardless of topology (in-process direct callback vs. RPC push → `handleRemoteReap`) — one
  revoke owner always, chosen over leaving revoke to the existing reconnect/bootId-change-only
  reconciliation pass, which was found (this plan) to leave an unbounded gap between a
  spontaneous cli-runner-side reap and the next reconnect/bootId-change event.
- Fable review round 1 (2026-08-12): verdict REVISE. Core design (sessionReaped RpcPush addition)
  APPROVED as justified — reconciliation only fires on reconnect/bootId-change, an unbounded
  token-live gap otherwise, API-owned timer can't substitute since LRU-evict-on-admission is
  inherently spontaneous cli-runner-side. Defaults (pool cap 4, idle-reap 30min) and `minValue`
  bounds affirmed as fine, not over-engineering. Binding Finding A (no process-external
  `SessionTokenRegistry` query exists; `listSessionIds` is in-process-only, confirmed
  `routes.ts:297`) resolved by decision above — no new introspection route, in-process spy tests
  are the evidence, e2e-P2 narrowed to process-observable facts only. Binding Finding B (plan text
  never stated Phase 2 touches `routes.ts`, nor addressed the confirmed lane #1256 overlap) closed
  above with the exact insertion-point citations and a concrete conflict protocol. Non-blocking nit
  (discriminated `RpcPush` union over optional `terminalId`) applied in Decision 2.
- Fable review round 2 (2026-08-12): verdict APPROVE. Confirmed Finding A's in-process-spy
  approach is correct and security-sound, and Finding B's #1256 conflict protocol is workable and
  verified against the sibling worktree's actual diff. One mechanical correction, no design
  reopen: e2e-P2's verification command named a nonexistent `packages/chat` test runner
  (`pnpm --filter @moss/chat test:e2e` — no such script, no `*.test.ts` files under
  `packages/chat`). Fixed to `tests/integration/persistent-pool-reap.test.ts` via
  `scripts/test-integration.ts`, matching the existing `test:<feature>` convention. Plan cleared
  to build.
