# Continuation: #1554 persistent-provider-chat-runtime (relay #8)

Branch/worktree: 1554-persistent-provider-chat-runtime. Clean tree, all committed through
`3508dee8c`. **Decision 2 is fully built, tested, typechecked, and committed.** Plan Fable-APPROVED
(relay-7); no re-escalation needed for what's already built or for Decision 3 next.

Source of truth: `docs/superpowers/plans/2026-08-12-1554-phase2-persistent-pool.md`. Decision 2 was
lines 130-208 (done). **Decision 3 is lines 210-228 — read directly, do not re-derive.**

Root typecheck gate: `npx tsc --noEmit -p .` (repo root, unpiped, check `EXIT=$?`) — clean (EXIT=0)
as of `3508dee8c`. Most packages have no own tsconfig — never `-p packages/<name>`.

## Task 3 (Decision 2) — DONE, commit `3508dee8c`

Built exactly per relay-7 + plan lines 130-208:
- `rpc-contract.ts`: `RpcPush` is now a discriminated union (`terminalData`/`terminalExit`/
  `sessionReaped`), `ReapReason` re-exported.
- `engine-host.ts`: `CliChatEngineHost` gained `addSessionReapedListener`/`notifySessionReaped`
  (`Set<Listener>` registry, process-wide singleton).
- `connection.ts`: `serveConnection` registers a reap listener on connect (writes `sessionReaped`
  push via `safeWrite`), unregisters in `close()`.
- `chat-engine-rpc-client.ts`: `RpcConnection.routeFrame` dispatches `t === "push"` /
  `channel === "sessionReaped"` to a new `onSessionReaped?` callback on `RpcConnectionOpts`.
- `chat-session-manager.ts`: new `handleRemoteReap(sessionKey, reason)` — under
  `withMaintenanceLock`, no-ops if `sessionKey` not cached, else deletes + `revokeMcpToken?.()`.
- `runtime.ts`: `onSessionReaped` threaded through the FULL composition root (not just
  `RpcConnectionOpts`) — `createChatSessionRuntime`'s late-bound `manager` closure calls
  `manager.handleRemoteReap`, mirroring the existing `onReconcile` wiring exactly.

**Two design calls made beyond relay-7's literal text** (both smallest-reasonable extensions of its
own stated patterns, not re-litigated — see commit message for the full rationale):
1. `ReapReason` re-exported from `rpc-contract.ts` (not just `provider-runtime.ts`), because
   `packages/cli-runner` can only see `packages/chat` through the `@moss/chat/live` barrel
   (`public.ts`, which does `export * from "./rpc-contract.js"` but never touched
   `provider-runtime.ts` directly) — `engine-host.ts` needed to type against it.
2. `onSessionReaped` wired all the way through `runtime.ts`, not stopped at the
   `RpcConnectionOpts` field — relay-7 said this wiring point "mirrors how `onReconcile` is
   threaded today," and task #5 (server-side `notifySessionReaped`/pool wiring in
   `engine-host.ts`/`main.ts`) is a separate, not-yet-started task, so this client-side path had
   to be complete on its own for the channel to do anything.

Tests (all 4 plan-stated cases, plan lines 195-208), all green:
- `packages/chat/src/live/persistent-runtime-pool.test.ts` — case 1, in-process `onReap` wiring.
- `tests/unit/cli-runner-protocol.test.ts` — case 2, two tests (push delivery + close/unregister
  no-op), new `describe` block after the existing `serveConnection` block.
- `tests/unit/chat-session-manager-remote-reap.test.ts` — **new file**, cases 3 & 4. Could not
  append to `tests/unit/chat-session-manager.test.ts` (already at the exact 1000-line
  `check:file-size` cap) — split out per the repo's established convention (`-selfheal`,
  `-provider-drop`, `-surface`, etc. were all split from the same file for the same reason). Case 3
  spies `revokeBySessionId` on a real `SessionTokenRegistry` instance (not a bare mock) per the
  plan's wording. Case 4 proves no double-revoke when the pushed key isn't cached.

Also fixed as fallout of the `RpcPush` union change: `tests/unit/cli-runner-terminal-rpc.test.ts`
needed (a) a narrower `RpcPushTerminalData` type for a `.find()` result that TS couldn't narrow
through the new union member, and (b) its hand-built `CliChatEngineHost` stub needed
`addSessionReapedListener`/`notifySessionReaped` stub methods since `serveConnection` now calls the
former unconditionally on every connection. Checked the one other hand-built stub-host file in the
repo (`tests/unit/cli-runner-login-reaper-interval.test.ts`) — it never opens a real connection
(only drives `CliRunnerServer`'s login-reaper timer), so it was NOT at risk and needed no change.

Verification: `npx tsc --noEmit -p .` EXIT=0. `npx vitest run` on all touched files plus the full
`chat-session-manager*`/`persistent-runtime-pool*` suites — 159 tests, all green.

**Task-tracker note**: the task brief for this session referenced `TaskList`/`TaskGet`/`TaskUpdate`
tools to mark task #3 complete, but those tools were not present in this session's tool set (only
`TaskStop` was available). Task #3 completion is recorded here and in commit `3508dee8c` instead —
whoever owns the shared tracker should mark it done from this doc.

## Task 4 (Decision 3) — NOT STARTED, next action

Plan lines 210-228: idle-reap timer ownership. Read that range directly before touching anything.
Not investigated this session at all — no partial state, no design calls made, nothing to correct.
