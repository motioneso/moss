# Continuation: #1554 persistent-provider-chat-runtime (relay #10)

Branch/worktree: 1554-persistent-provider-chat-runtime. Clean tree, all committed through
`853b21616`. **Task #5 is fully built, tested, typechecked, and committed.**

Source of truth: `docs/superpowers/plans/2026-08-12-1554-phase2-persistent-pool.md`. Task #5 was
"wire pool into composition points + lift `persistentRuntimeEnabled` pin" (all 4 items from the
original brief). **Task #6 (routes.ts wiring) is next.**

Root typecheck gate: `npx tsc --noEmit -p .` — clean (EXIT=0) as of `853b21616`. `.test.ts` files
ARE in project scope (confirmed: literal-typed test fixtures need `as const` or they widen to
`string` and fail typecheck, not vitest).

## Task #5 — DONE, 3 commits

- `2144e395b` — `engine-selection.ts`'s fork point now consults `AdmitCapablePool.admit()` when
  `persistentRuntimeEnabled` + a pool are supplied; `{kind:"denied"}` falls back to the bounded
  engine, `{kind:"admitted", runtime}` wraps in `ClaudePersistentRuntimeEngine`. New
  `AdmitCapablePool` interface in `persistent-runtime-pool.ts` (structural, mirrors
  `SweepIdlePool`), barrel-exported from `live/public.ts`. Test: `engine-selection.test.ts` 5/5.
- `0adb56e1f` — RPC topology. `engine-host.ts`: lifted the `persistentRuntimeEnabled: false` pin;
  new `persistentRuntimePool?: AdmitCapablePool` field on `EngineHostDeps`, kept separate from the
  pre-existing sweep-only `persistentPool?: SweepIdlePool` (a widened intersection would've broken
  `cli-runner-idle-reap-timer.test.ts`'s fake). `main.ts`: `readConfig()` gains
  `MOSS_CHAT_PERSISTENT_RUNTIME_ENABLED`/`_POOL_CAP`/`_IDLE_REAP_MINUTES` (boot-time only, no
  live-reload — cli-runner has no DB; documented deviation from Decision 4 for this one topology).
  `createCliRunner()`: forward-reference `let hostRef` resolves the pool↔host circular construction
  dep — pool's `onReap` calls `hostRef.notifySessionReaped(sessionKey, reason)`. Defaults
  `4`/`30` hardcoded (match `@moss/settings` registry; no new package dep taken). `server.ts`:
  `start()`/`stop()` unconditionally call `host.startIdleReapTimer()`/`stopIdleReapTimer()` — no-op
  safety lives in the timer method itself. Tests: `cli-runner-main-persistent-pool.test.ts` 6/6,
  `cli-runner-server-idle-reap-wiring.test.ts` 2/2 (new — `cli-runner-server.test.ts` despite its
  name never constructs a real `CliRunnerServer`, only `CliChatEngineHost` directly).
- `853b21616` — in-process topology + settings. `runtime.ts`'s `createRealEngineFactory`
  constructs/references the pool, wires `onReap` straight to `deps.mcpTokenLifecycle?.revoke` per
  plan lines ~190-193. `chat-multiplexer.ts`: added `"chat.persistent_pool_cap"`/
  `"chat.persistent_idle_reap_minutes"` to `PREAUTH_READABLE_SETTING_KEYS` (the literal bug — both
  readers existed but silently defaulted because the allowlist blocked them); readers fail-closed
  to registry defaults on ANY read error. **Documented KNOWN GAP** (comment at
  `chat-multiplexer.ts:596-609`): `resolveChatEngineFactory`'s `onPersistentReap` is left unwired
  here — `mcpTokenLifecycle` is constructed in `routes.ts`'s `wiring` closure (task #6 territory),
  unreachable from this function's `{appDb, env?, log?}` deps without adding it to `index.ts`,
  which task #5 was barred from touching (Finding B). Pool admission/cap/LRU-evict/idle-reap IS
  fully real; only revoke-on-reap is deferred — **task #6 should thread `mcpTokenLifecycle` into
  `resolveChatEngineFactory`'s deps from `index.ts`**. Tests:
  `chat-runtime-persistent-pool-wiring.test.ts`, `chat-multiplexer-persistent-pool-settings.test.ts`
  2/2 (seeds non-default values `7`/`45` — both readers fail-closed on a blocked read, so a naive
  no-throw assertion wouldn't distinguish "fixed" from "still blocked").

Fixed one regression found via full-batch run: `cli-runner-login-reaper-interval.test.ts`'s
`stubHost()` didn't implement the two new unconditional `server.ts` calls
(`startIdleReapTimer`/`stopIdleReapTimer`) — added no-op stubs, 4/4 green again.

Full regression batch: 18 test files, 151 passed / 2 skipped. `npx tsc --noEmit -p .` EXIT=0.

**Task-tracker note**: same as relay-8/9 — no `TaskGet`/`TaskUpdate` tools in this session's tool
set (only `TaskStop`). Completion recorded here and in the 3 commits above instead.

## Task #6 — NOT STARTED, next action

Wire `routes.ts` (the actual HTTP surface) to the composition work above. **Read the plan's
"Finding B" section (lines 262-302 + Fable-review addendum 415-426) before touching anything.**

**Fresh #1256 re-check as of this session (re-verify again yourself, don't trust this line's age)**:
issue #1256 ("AI assistant-actions resolve route bypasses the confirmation registry entirely") is
**OPEN**. Its branch `1256-confirmation-registry-bypass` (SHA `ecb267b822637a0b1605ddd1d45c1fa29763426d`)
exists on `origin` but has **no PR** (open or closed, confirmed via `gh pr list --search 1256`
returning `[]`) and has **not merged** into `origin/main`.

Per Finding B's protocol: (1) re-check #1256 fresh at your own start time — state above may have
changed; (2) if merged by then, rebase + re-read `routes.ts` fresh, don't reuse the plan's
pre-#1256 line citations (numbers shift); (3) if still unmerged (as now), proceed against current
`origin/main` without blocking on or coordinating merge order with #1256 — the eventual
second-to-merge PR just hits an ordinary additive rebase conflict, resolve by keeping both sides;
(4) `routes.ts` commits follow `shared-checkout` skill discipline (explicit paths only, never
`git add -A`).

Collision files (both flagged in Finding B; `index.ts` was barred from *me*, task #5 — verify
current scope before editing it):
- `packages/chat/src/routes.ts` — `wiring` closure region (plan's pre-#1256 citation: `:190-222`,
  call site `:196-300`) collides with #1256's `adoptChatGateway` field/call-site insertion
  (`:147-150`, `:254-255`).
- `packages/module-registry/src/index.ts` — also needed anyway to close the
  `onPersistentReap`/`mcpTokenLifecycle` gap noted above.

Also carry forward: `runtime.ts`'s pool/timer wiring (Decision 3 + task #5) remains dead code in
production for the in-process topology because `routes.ts` always supplies an explicit
`engineFactory` that bypasses `createChatSessionRuntime`'s own composition — confirm whether task #6
changes that, or `chat-multiplexer.ts`'s `resolveChatEngineFactory` stays the sole real in-process
root.
