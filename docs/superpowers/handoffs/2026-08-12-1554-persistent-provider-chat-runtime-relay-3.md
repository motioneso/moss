# Continuation: #1554 persistent-provider-chat-runtime (relay #3)

Branch/worktree: 1554-persistent-provider-chat-runtime (this worktree). Clean tree, nothing
committed yet. No plan-build doc written yet — still in the seams-verification step of
`plan-build` for Phase 2 (invoked, not yet produced output). Relay #2's doc (same dir, no `-3`
suffix) has full prior context; this doc only adds what changed.

**Coordinator approval to continue Phase 2 already recorded (relay #2) — do not re-escalate.**
Re-resolve coordinator fresh via `herdr pane list` before messaging (relay #2's address is dead).

## Settled this session (do not re-derive)

1. **chat-session-manager engineFactory frequency** — `ensureSession()` (~188-210) caches by
   `sessionKey` in `this.sessions` map, returns cached session (with engine) on every call after
   the first. `engineFactory` only invoked in `launchSession()` (~234) on first launch or
   `healAndRelaunch()` (~304-317) after self-heal. **Engine constructed ONCE per live session,
   reused across turns.** Pool admission intercepts only at engine-construction time
   (`createChatEngine` in `engine-selection.ts`), not per-turn. Ruling 5's "that turn runs on
   bounded-fallback" means: the admission decision made at session-launch time determines the
   engine kind for the WHOLE session's life (until a heal-and-relaunch re-attempts admission) —
   write this clarification into the plan explicitly, a reviewer will otherwise read "that turn"
   as per-turn.

2. **Pool architecture (traced, not yet written into a plan doc):**
   - `ChatEngineSelectionOpts` (`engine-selection.ts:28-50`) needs a new opt, e.g.
     `persistentPool?: PersistentRuntimePool`. `createChatEngine`'s existing branch at
     `engine-selection.ts:84-88` (`if (opts.persistentRuntimeEnabled && provider === "anthropic")`)
     changes to consult the pool; on admission-denied (cap hit, no idle victim) it falls through
     to the existing bounded-fallback branch at `:90-102` — ruling 5 satisfied for free, no new
     fallback code path needed.
   - The pool should operate at the `ProviderChatRuntime` level (`provider-runtime.ts`), NOT the
     `CliChatEngine` adapter level. `ClaudePersistentRuntimeEngine` already accepts an injected
     `runtime` (`persistent-runtime-engine.ts:41`, `ClaudePersistentRuntimeEngineOpts.runtime`) —
     the pool constructs/owns the `ProviderChatRuntime`, hands it to a freshly-constructed adapter
     per session (adapters stay 1:1 with sessions; the pool's job is capping/evicting/reaping the
     underlying OS-process-holding runtimes, not reusing adapters across sessions).
   - Use `runtime.health()` (`RuntimeHealth.state`, already includes `idle`/`in-turn`/
     `awaiting-approval`) as the single source of truth for LRU/reap decisions — poll it right
     before any kill decision (satisfies "atomic state re-check before any kill" from the plan's
     Phase 2 line 233; avoids duplicating state tracking by intercepting submitTurn/streamEvents).
   - Per-child lock: cli-runner's `Mutex` (`packages/cli-runner/src/mutex.ts`) is NOT importable
     from `packages/chat` (dependency direction is cli-runner → chat, confirmed via both
     `package.json`s: `cli-runner` depends on `@moss/chat`, not the reverse). The pool needs its
     own lightweight per-key lock, same Promise-chaining style already used in
     `chat-session-manager.ts`'s `launching`/`maintenanceMutex` fields (~164-179) — do not add a
     cross-package dependency.
   - Two composition points to wire the pool into, matching the plan's "PID-owning process" line:
     `runtime.ts`'s `createRealEngineFactory()` (~117-146, in-process/host-dev topology — no
     cli-runner sidecar) and `engine-host.ts`'s `launchOnce()` (~242-269 construction call, RPC/
     containerized topology). Each composition root constructs ONE long-lived pool instance and
     threads it into every `createChatEngine` call via the new opt.

3. **OPEN — genuinely unresolved architecture question, needs a decision before the plan can be
   written (do not guess at this alone):** MCP token revoke-on-reap crosses a process boundary in
   the RPC/containerized topology.
   - `SessionTokenRegistry` (`packages/ai/src/gateway/session-tokens.ts:54`, `revokeBySessionId`
     at `:106`) is constructed exactly once, in the API process
     (`packages/chat/src/routes.ts:217`), and threaded into `ChatSessionManager` via
     `deps.mcpTokenLifecycle?.revoke` (`runtime.ts:433`). **cli-runner (`engine-host.ts`) has NO
     reference to this registry — it's a separate OS process reached only via the RPC socket.**
   - So a pool living inside `EngineHost` (RPC topology) cannot directly call
     `revokeBySessionId` on idle-timeout/LRU-evict reap the way the in-process pool trivially can
     (just take `mcpTokenLifecycle.revoke` as a constructor dep, same as `chat-session-manager`
     already does).
   - Two real options, not yet weighed against each other:
     (a) **Lazy revoke via existing self-heal** — the pool's cli-runner-side reap only kills the
     child process; the API-side `chat-session-manager.healAndRelaunch()` (~304-317) already
     revokes the token when it next discovers the engine is dead. Gap: token stays live between
     reap and next-turn-discovery. The 60-min TTL backstop
     (`session-tokens.ts:26-35`, doc comment literally says "catches tokens whose owning engine
     was orphaned") may already be the intended safety net for exactly this gap — worth reading
     as evidence this is the designed-for posture, not a bug.
     (b) **Extend the existing reconciliation loop** — `runtime.ts`'s `onReconcile` /
     `RpcReconcileDriver` / `killSession` dep (~356-440) already lets the API side list
     cli-runner's live sessions and issue kills through a driver that already routes into
     `ChatSessionManager`'s eviction+revoke path. Idle-reap could become an API-driven decision
     (poll health/lastActivity via a new RPC method, decide centrally, kill via the existing
     driver) rather than a cli-runner-internal timer — keeps revoke ownership 100% API-side
     always, but changes Phase 2's "pool ownership in the PID-owning process... idle reap" framing
     for the RPC topology specifically (LRU/cap-at-admission stays pool-side; idle-timeout-reap
     would move API-side).
   - This is a genuine fork, not a lookup — needs the same "decide and write it into the plan,
     don't leave it open" treatment as the settings-bounds question (relay #2), but it's bigger
     than that one. Recommend spending the first 15 minutes of the next session on this before
     touching the plan doc. Lean toward (b) for consistency (one revoke owner, always) unless it
     turns out the reconciliation RPC surface can't cheaply carry health/idle data — check
     `RpcReconcileDriver`'s interface (not yet read this session) before deciding.

4. **Settings/bounds decision (relay #2, reconfirmed, still stands):** add optional
   `minValue?`/`maxValue?` to `RuntimeConfigKeyEntry` (`runtime-config-keys.ts:1-12`) + a bounds
   check in `validateRuntimeValue` (`runtime-config-routes.ts:53-68`), consistent with the
   existing `enumValues?` pattern. Confirmed today: `RuntimeConfigType` already includes `"int"`
   in its union (`runtime-config-keys.ts:1`) but **zero registry entries use it yet** — no
   precedent to copy, write the bounds-check from scratch. `resolveInt` (`runtime-config-resolver.ts:74-84`)
   parses/asserts-integer but has no bounds check either — bounds enforcement belongs at the PATCH
   validation layer only (write-time), not the resolver (read-time), matching where `enumValues`
   is checked today.

## Not yet done (next steps, in order)

1. Resolve the MCP-token-revoke-on-reap architecture question above (read
   `RpcReconcileDriver`'s interface first — not yet read this session, likely in
   `packages/chat/src/live/rpc-*.ts` or `packages/cli-runner/src/*.ts`, grep for the type).
2. Read `chat-multiplexer.ts` `resolveChatEngineFactory()` (~390-508) — not yet re-read this
   session, needed to confirm the third wiring point (host-dev boot path reads the live flag and
   picks between `createRealEngineFactory` and the RPC client factory; confirm the pool threads
   through cleanly here too, or whether it's covered by #2's two composition points above).
3. Write the Phase 2 plan-build doc: child state machine section (reuse `ChildState`/`ReapReason`
   from `provider-runtime.ts`, already defined, Phase 1 shipped), pool cap+LRU section (cite the
   architecture above by file:line), idle-reap section (pending the open question), settings
   registry entries + admin PATCH bounds-check tests, e2e-P2 "reap is real" spec per the coarse
   plan's line 239-240 (`docs/superpowers/plans/2026-08-10-1557-persistent-provider-chat-runtime.md`).
   Follow `plan-build` skill rules: decisions/signatures/DDL/test-cases only, no function bodies;
   name the kill-gate observation + owner; unpiped verification commands with expected exit codes.
4. Re-resolve coordinator via fresh `herdr pane list`, message the finished plan path, **STOP for
   approval before writing any code** (hard gate).
5. TDD-build Phase 2 task-by-task, committing per task (explicit scoped `git add`, never `-A`/`.`).
6. Pre-push trio: `pnpm format:check && pnpm lint && pnpm typecheck`, then
   `git fetch origin main && git rebase origin/main`.
7. `coordinated-wrap-up`: `verify-gate` skill for the full gate, push, open PR, live-path proof
   comment (user-facing feature per CLAUDE.md), report to coordinator. Never merge/close
   issues/touch board.
8. Relay again on the next 70% context-meter warning or compaction summary.

## Phase 1 status (confirmed shipped, for context)

`provider-runtime.ts`, `persistent-stream-decoder.ts`, `claude-persistent-runtime.ts`,
`persistent-runtime-engine.ts` all exist in the tree already (`packages/chat/src/live/`), dated
today's session start — Phase 1 is built and the neutral contract (`ChildState`, `ReapReason`,
`ProviderChatRuntime`, `RuntimeHealth`) is exactly as the plan specified. Do not re-verify Phase 1
seams; only the `engine-selection.ts` construction call at `:84-88` and the RPC pin at
`engine-host.ts:252` (`persistentRuntimeEnabled: false`) are what Phase 2 touches there.

## Collision note (still binding)

Lane #1256 (worktree `.claude/worktrees/1256-confirmation-registry-bypass`) touches
`packages/chat/src/routes.ts` and `packages/module-registry/src/index.ts`. Check for conflicts
before editing those files; rebase onto origin/main before opening a PR.

## Bans (still binding)

Worktree/branch-scoped git only. Explicit-path `git add` only (never `-A`/`.`). Never touch
`docs/coordination/`, the project board, milestones, or merge. No secrets anywhere.
