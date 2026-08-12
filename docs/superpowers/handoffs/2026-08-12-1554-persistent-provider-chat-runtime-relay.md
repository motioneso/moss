# Continuation: #1554 persistent-provider-chat-runtime (relay #2)

Branch/worktree: 1554-persistent-provider-chat-runtime (this worktree). Clean tree — pure
seams-verification session, nothing to commit. No code written yet, no plan-build doc written yet.

## Coordinator approval — RECEIVED

Coordinator approved (via `ListAgents`, reply rendered oddly as a peer name, ref `[c4a50c]`,
unaddressable for follow-up — see "Coordinator address is dead" below): **continue Phase 2 under
the existing plan `docs/superpowers/plans/2026-08-10-1557-persistent-provider-chat-runtime.md`
starting at Phase 2, tracking issue is #1554 (do not reopen #1557)**. Core content unambiguous; a
trailing "Independ…" fragment was truncated and could not be recovered (4 addressing attempts
failed on the 200-char `to`-field limit — do not retry this, it's structurally unreachable).
**Do not re-escalate this question — it's answered. Proceed straight to plan-build for Phase 2.**

Coordinator address is dead: `coord-relay9` / session `0bb9f516-c026-454f-bc97-dc9faf43bd20` no
longer resolves via SendMessage ("No agent named 'coord-relay9' is reachable"). **Before your next
escalation, re-resolve the coordinator fresh via `herdr pane list` — do not reuse this name/session
id, it's stale.**

## P1.0 open question — RESOLVED by direct code read

Shipped posture is **`--no-session-persistence`** (confirmed: `claude-persistent-runtime.ts:265`,
inside `buildCommand()`; no `--session-id` flag anywhere in that 352-line file). Corroborated by a
comment in `persistent-runtime-engine.ts:45-49` ("P1.0: `--no-session-persistence` adopted").
**Consequence:** no provider-side session file ever exists to purge on any termination path — pool
eviction / idle-reap / crash-recovery code needs no separate purge step, just `reap()`. Simpler
than the spec's "fallback posture" section anticipated. Don't re-investigate this.

## Seams re-verified this session (current line numbers, ~2026-08-12)

- `packages/chat/src/live/engine-selection.ts` (113 lines) — **the single fork point (#1350)**.
  `createChatEngine()` lines ~76-92: `if (opts.persistentRuntimeEnabled && provider === "anthropic")`
  unconditionally `new ClaudePersistentRuntimeEngine(...)` — **no pool consultation, no cap check,
  no LRU, no busy-fallback**. This is exactly what Phase 2 must add, threaded through both call
  sites below without breaking the single-fork invariant.
- `packages/cli-runner/src/engine-host.ts` — RPC composition root. `launchOnce()` ~180-269 calls
  `createChatEngine(...)` at ~242 with **`persistentRuntimeEnabled: false` hardcoded at line 252**
  (comment cites #1557 Phase 1 / #1350 guard explicitly — "lifting this pin is a later-phase
  change, not an oversight"). **Phase 2 lifts this pin.** `EngineHost` already has per-sessionKey
  serialization (`enqueue`, ~140-155) and an admission mutex — possibly reusable for per-child lock.
- `packages/module-registry/src/chat-multiplexer.ts` (~390-508) — in-process root,
  `resolveChatEngineFactory()`. Reads `chat.persistent_runtime.enabled` via a **live-reader
  closure** (`createPersistentRuntimeEnabledLiveReader`, re-reads per call, not boot-snapshot) —
  the only place `persistentRuntimeEnabled` can currently be `true` in prod.
- `packages/chat/src/live/runtime.ts` (~90-146) — `createRealEngineFactory()`, same live-flag
  pattern, delegates straight to `createChatEngine()`. No pool here either.
- `packages/chat/src/live/persistent-runtime-engine.ts` (192 lines, `ClaudePersistentRuntimeEngine`)
  — single-child, single-session wrapper. **Zero pool awareness.** `kill()` → `runtime.reap("shutdown")`.
- `packages/chat/src/live/provider-runtime.ts` (83 lines) — `ReapReason` already includes
  `"lru-evict"` / `"idle-timeout"` (forward-compatible from Phase 1, don't need to touch this file).
- `packages/settings/src/runtime-config-keys.ts` (65 lines, read in full) — registry has exactly 3
  entries (`ai.embed_provider` enum, `ai.embed_model` string, `ai.brave_api_key` secret). **Zero
  "persistent" entries** — `chat.persistent_pool_cap` / `chat.persistent_idle_reap_minutes` do not
  exist. No entry uses `type: "int"` yet, so no precedent to copy.
- `packages/settings/src/runtime-config-resolver.ts` (128 lines, read in full) — `resolveInt(key)`
  exists (~74-84): asserts type, parses, checks `Number.isInteger`, **no bounds check**.
- `packages/settings/src/runtime-config-routes.ts` (146 lines, read in full) — admin GET/PUT.
  `validateRuntimeValue()` (~53-68): for `type === "int"` only checks `Number.isInteger`, **no
  min/max support at all**. `RuntimeConfigKeyEntry` (in `runtime-config-keys.ts`) has no
  `minValue`/`maxValue` fields.
  **Open design decision (unresolved, yours to make in the plan):** spec requires pool-cap
  "validated on save" (presumably ≥1). Either (a) add optional `minValue?`/`maxValue?` to
  `RuntimeConfigKeyEntry` + a bounds check in `validateRuntimeValue`, or (b) key-specific inline
  check. (a) is more consistent with the existing `enumValues?` pattern — recommend it, but decide
  and write it into the plan-build doc, don't leave it open.

## Not yet checked — do this FIRST, before plan-build

`packages/chat/src/live/chat-session-manager.ts` — need to confirm whether `engineFactory` (used at
line ~234, `this.deps.engineFactory(provider, sessionKey, { executionMode })`, then `engine.launch()`
at ~261) is invoked **once per live session** (engine cached/reused across turns) or **fresh per
turn**. This is architecturally load-bearing for Phase 2: it decides whether pool admission
(cap-check / LRU / all-busy→fallback) needs to intercept only at engine-construction time, or also
needs additional per-turn re-evaluation logic. Read roughly lines 150-270 of that file to settle it
before writing the Phase 2 plan's pool-architecture section.

## Next steps (in order)

1. Read `chat-session-manager.ts` ~150-270, settle engineFactory call frequency (above).
2. Decide the pool-cap bounds-validation approach (above) — write it as a plan decision.
3. Invoke `plan-build` for **Phase 2 only** (scope = plan lines 230-241 of
   `docs/superpowers/plans/2026-08-10-1557-persistent-provider-chat-runtime.md`: child state
   machine, warm pool cap + LRU eviction of idle-only children, all-busy⇒fallback-for-that-turn,
   idle reap, pool ownership in PID-owning process reached via `engine-selection.ts`'s single fork,
   settings registry entries + admin PATCH validation tests, e2e-P2 "reap is real" — fill pool past
   cap, verify eviction and 30-min reap via `ps` process checks not logs, reap revokes session token
   via `revokeBySessionId`). Cite all seams above by file:line in the plan; the "not yet checked"
   item above is the only real gap left.
4. Re-resolve coordinator via fresh `herdr pane list`, message the finished plan path, **STOP for
   approval before writing any code** (hard gate, not optional).
5. TDD-build Phase 2 task-by-task, committing per task (`Co-Authored-By: Claude` trailer, explicit
   scoped `git add`, never `-A`/`.`).
6. Pre-push trio before any push: `pnpm format:check && pnpm lint && pnpm typecheck` then
   `git fetch origin main && git rebase origin/main`.
7. Close out via `coordinated-wrap-up`: own gate via `verify-gate` skill, push, open PR, post
   live-path proof comment (this is a user-facing feature per CLAUDE.md — code-complete-but-
   unverified is not an acceptable final report without saying so explicitly), report PR + evidence
   to coordinator. Never merge/close issues/touch board.
8. Relay again on the next 70% context-meter warning or compaction summary — same trigger, no
   higher personal threshold.

## Collision note (still binding)

Lane #1256 (worktree `.claude/worktrees/1256-confirmation-registry-bypass`) touches
`packages/chat/src/routes.ts` and `packages/module-registry/src/index.ts`. Check for conflicts
before editing those files; rebase onto origin/main before opening a PR.

## Bans (still binding)

Worktree/branch-scoped git only. Explicit-path `git add` only (never `-A`/`.`). Never touch
`docs/coordination/`, the project board, milestones, or merge. No secrets anywhere.
