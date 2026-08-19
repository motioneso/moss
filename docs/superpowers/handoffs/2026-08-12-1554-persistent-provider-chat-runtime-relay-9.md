# Continuation: #1554 persistent-provider-chat-runtime (relay #9)

Branch/worktree: 1554-persistent-provider-chat-runtime. Clean tree, all committed through
`772fd121b`. **Decision 3 is fully built, tested, typechecked, and committed.**

Source of truth: `docs/superpowers/plans/2026-08-12-1554-phase2-persistent-pool.md`. Decision 3 was
lines 210-228 (done). **Decision 4 (settings registry) was already committed before this session —
task #5 is next: wire the real pool into the composition points.**

Root typecheck gate: `npx tsc --noEmit -p .` (repo root, unpiped, check `EXIT=$?`) — clean (EXIT=0)
as of `772fd121b`.

## Task 4 (Decision 3) — DONE, commit `772fd121b`

Built exactly per plan lines 210-228:
- New `packages/chat/src/live/idle-reap-timer.ts`: `startIdleReapTimer(deps): () => void`.
  `IdleReapTimerDeps.readIdleReapMinutes` is called fresh on **every** tick (never snapshotted),
  `intervalMs` derived once via `computeIdleReapIntervalMs(defaultIdleReapMinutes)` =
  `min(minutes/6, 5 min)` unless overridden. In-flight guard, `unref()`, `onError` swallow —
  mirrors `CliRunnerServer`'s login-reaper (`packages/cli-runner/src/server.ts`). Exported
  `SweepIdlePool` (structural `{sweepIdle(ms): Promise<void>}`) so callers/tests don't need a real
  `PersistentRuntimePool`. Exported from `packages/chat/src/live/public.ts`.
- `packages/cli-runner/src/engine-host.ts` (RPC topology): `EngineHostDeps` gains optional
  `persistentPool?: SweepIdlePool` / `readIdleReapMinutes?: () => Promise<number>`.
  `CliChatEngineHost.startIdleReapTimer(intervalMs?)` / `.stopIdleReapTimer()` — no-op when either
  dep is absent (true today), double-start-safe (clears prior timer first).
- `packages/chat/src/live/runtime.ts` (in-process topology): `CreateChatSessionRuntimeDeps` gains
  the same two optional fields + `idleReapTimerIntervalMs?`. `createChatSessionRuntime` — itself
  the real composition-root function — **actively** starts the timer when both deps are present
  and folds the stop into the existing `shutdown()` closure alongside `stopReaper?.()` (line ~530).
  This is DISTINCT from the pre-existing §5.5 session-level reaper (`manager.startIdleReaper()`,
  reaps whole `CliChatEngine` sessions on `idleMs`) — the new timer sweeps warm
  `PersistentRuntimePool` children on the live `chat.persistent_idle_reap_minutes` setting.

**Design call made, smallest reasonable extension of the plan's own wording**: the plan says the
tick interval is "recommend `min(idleThresholdMs / 6, 5 min)`" but `createChatSessionRuntime` is
synchronous (can't `await` a live read before arming a timer). Resolved by computing the CADENCE
once from `defaultIdleReapMinutes` (falls back to 30, the registry default) while the THRESHOLD
passed to `sweepIdle()` is always the value `readIdleReapMinutes()` returns on that tick — satisfies
the plan's hard requirement (fresh-read, no boot-snapshot) while treating the interval as soft/
best-effort per the plan's own "(recommend ...)" wording. Not applicable to `engine-host.ts`, which
takes an explicit `intervalMs` param instead (its caller, task #5's `main.ts` wiring, decides).

**`main.ts` intentionally NOT touched** — `EngineHostDeps` has no real `persistentPool`/
`readIdleReapMinutes` values anywhere yet (task #5's job), so a call to `host.startIdleReapTimer()`
from `main.ts` today would be a permanently-inert no-op. Left for task #5 to wire alongside pool
construction, matching my scope boundary (task #5 was explicitly out of scope for this session).

Tests (all 3 plan-stated cases, plan lines 222-228), all green (16 new tests total):
- `packages/chat/src/live/idle-reap-timer.test.ts` — the timer's own mechanics (tick cadence
  formula, fresh-read-per-tick, in-flight guard, stop idempotency, `onError` swallow) PLUS an
  integration `describe` driving a REAL `PersistentRuntimePool` through the timer with
  `vi.useFakeTimers()`/`vi.setSystemTime(0)`: 31-min-idle reaped (`"idle-timeout"`, `onReap` fires),
  29-min-idle not reaped, 40-min in-turn not reaped.
- `tests/unit/cli-runner-idle-reap-timer.test.ts` — `CliChatEngineHost.startIdleReapTimer`'s own
  no-op/arm/double-start/stop wiring (fake pool, no real `PersistentRuntimePool`).
- `tests/unit/chat-runtime-idle-reap-timer.test.ts` — `createChatSessionRuntime`'s equivalent
  wiring, plus a fresh-read-per-tick regression case.

Verification: `npx tsc --noEmit -p .` EXIT=0. `npx vitest run` on the 3 new files (16/16 green) plus
regression run of `cli-runner-execution-mode`, `cli-runner-login-reaper-interval`,
`cli-runner-protocol`, `chat-runtime-selection`, `persistent-runtime-pool`,
`chat-session-manager-remote-reap`, `cli-runner-terminal-rpc` — 78/78 green, no regressions.

**Task-tracker note**: same gap as relay-8 — `TaskGet`/`TaskUpdate` tools were not present in this
session's tool set either (only `TaskStop`). Task #4 completion is recorded here and in commit
`772fd121b` instead.

## Task 5 — NOT STARTED, next action

Wire the real `PersistentRuntimePool` instance into the composition points, and lift the
`persistentRuntimeEnabled: false` pin. Plan sections (re-read directly, don't re-derive):
- `packages/chat/src/live/engine-selection.ts` ~76-92 — the fork point that currently ignores
  `persistentRuntimeEnabled` on the RPC path.
- `packages/cli-runner/src/engine-host.ts` ~284-ish (`launchOnce`, search `persistentRuntimeEnabled:
  false`, has a `#1557/#1350 two-composition-roots guard` comment) — the pin to lift, PLUS
  constructing the real `PersistentRuntimePool`, wiring it into the new `persistentPool`/
  `readIdleReapMinutes` `EngineHostDeps` fields added this session, and calling
  `host.startIdleReapTimer()` (and `.stopIdleReapTimer()` on shutdown) from `main.ts`. Also wire
  `pool`'s `onReap` to `host.notifySessionReaped` (Decision 2's `notifySessionReaped` doc comment
  already says "Called by the pool's `onReap` (wired in task #5, main.ts)").
- `packages/chat/src/live/runtime.ts`'s `createRealEngineFactory` ~109-147 — same
  `persistentRuntimeEnabled` live-reader pattern already used there for the in-process path; task #5
  additionally needs to construct the real pool and pass `persistentPool`/`readIdleReapMinutes` into
  `CreateChatSessionRuntimeDeps` (both added this session, currently always absent from every real
  caller) so the timer this session built actually arms in production.

**Live-read implementation for `readIdleReapMinutes` — a real gap task #5 must close**: my research
this session confirmed `RuntimeConfigResolver.resolveInt()` (the "official" registry-backed reader,
`packages/settings/src/runtime-config-resolver.ts`) has **no actor-less/background-caller precedent
anywhere in the repo** — every call site requires a real actor UUID via `withDataContext`, which
hard-throws without one. The precedent to mirror instead is `chat-multiplexer.ts`'s raw, allowlisted,
fail-closed `appDb` read (`createPersistentRuntimeEnabledLiveReader` /
`readPersistentRuntimeEnabled`, ~lines 380-410) — BUT **`"chat.persistent_idle_reap_minutes"` is NOT
currently in `PREAUTH_READABLE_SETTING_KEYS`** (`chat-multiplexer.ts:44-47`, only
`"chat.multiplexer"` and `"chat.persistent_runtime.enabled"` are listed today) — task #5 needs to add
it there (or build an equivalent allowlisted reader) before `readIdleReapMinutes` can be real. For
`engine-host.ts` (cli-runner, a SEPARATE PROCESS with no DB connection at all — confirmed via the
DB-isolation precedent noted in Decision 2's seam notes), the live read cannot go through `appDb`
directly; task #5 will need to decide how the RPC topology obtains this value live (e.g. forwarded
via `main.ts`'s existing config-read path, or a new RPC/env mechanism) — this was NOT solved this
session; the `readIdleReapMinutes: () => Promise<number>` DI shape was deliberately left
implementation-agnostic so task #5 has full freedom here.
