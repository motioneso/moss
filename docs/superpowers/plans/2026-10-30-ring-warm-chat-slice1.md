# Ring warm chat, slice 1 plan

Task: #3854. Spec: `docs/superpowers/specs/2026-10-30-ring-latency-warm-chat.md`. Slice 1 only.
Slices 2 (start on press) and 3 (classifier measurement) are out of scope.

## Seams (verified in the current tree)

| Capability                                                                  | Evidence                                                                               |
| --------------------------------------------------------------------------- | -------------------------------------------------------------------------------------- |
| Session reaper skips by key and runs under the maintenance lock             | `packages/chat/src/live/chat-session-manager.ts` `reapIdle`, `startIdleReaper`         |
| `ensureSession` serializes per actor and surface                            | `chat-session-manager.ts` `ensureSession`, `launching` map                             |
| Session key is `encodeURIComponent(userId):surface`                         | `packages/chat/src/live/chat-surface.ts` `surfaceSessionKey`, `parseSurfaceSessionKey` |
| Pool sweep takes a threshold only; timer owns the interval                  | `persistent-runtime-pool.ts` `sweepIdle`, `idle-reap-timer.ts`                         |
| Pool timer is armed in both topologies                                      | `runtime.ts` (in-process), `cli-runner/src/engine-host.ts` `startIdleReapTimer`        |
| Non-session RPC verbs exist (`listLiveSessions`)                            | `chat/src/live/rpc-contract.ts`, `cli-runner/src/connection.ts`                        |
| Boot reconcile runs on first connect                                        | `runtime.ts` `connection.ensureConnected()`                                            |
| Enablement table is owner-only under forced row security                    | `packages/meetings/sql/0328_meeting_voice_recordings.sql`                              |
| Precedent for a cross-user list: a definer function granted to the app role | `packages/chat/sql/0146_private_chat_cleanup.sql`                                      |
| Chat reaches the app database through route dependencies                    | `packages/chat/src/routes.ts` `rootDb`; wired in `apps/api/src/server.ts`              |

Open question, owner builder: whether the chat engine in the cli-runner topology keys its pool by the
same session key. Confirm in `engine-host.ts` before writing task 3.

## Determinism boundary

No model output and no UI. Nothing here produces user-visible text and no model job is added. A warm
session starts no turn and spends no provider tokens.

## Tasks

### 1. Meetings: list users with hold-to-talk on

- New migration in `packages/meetings/sql/` (next free number; check `ls packages/*/sql`).
  `app.list_voice_enabled_user_ids() RETURNS TABLE(user_id uuid)`, `SECURITY DEFINER`,
  `SET search_path = app, pg_temp`, returns distinct `owner_user_id` where `disabled_at IS NULL`.
  `REVOKE ALL ... FROM PUBLIC; GRANT EXECUTE ... TO jarvis_app_runtime`. Follows 0146. It reads only
  user ids, no recording content. No bypass role is added.
- Public API in `packages/meetings/src/recording-voice-enablement.ts`:
  `listVoiceEnabledUserIds(db: Kysely<MossDatabase>): Promise<ReadonlySet<string>>`.
- Test (integration, scoped): two users, one enabled, one disabled, one never enabled. Only the enabled
  user returns. Disabling removes the user. Fails against a function that drops the `disabled_at` filter.

### 2. Chat: keep-warm port and session reaper exemption

- `ChatSessionManagerDeps.keepWarmUserIds?: () => Promise<ReadonlySet<string>>` in `chat-session-ports.ts`.
- `reapIdle` reads the set once per run (a read failure counts as an empty set and logs nothing
  private) and skips the default-surface session of any user in it.
- Test: with the set containing the user, an idle session survives `reapIdle`. Run it with the skip
  removed and watch it fail. A user outside the set still reaps. A user who leaves the set reaps on the
  next run.

### 3. Pool sweep exemption

- `PersistentRuntimePool.sweepIdle(idleThresholdMs: number, exemptKeys?: ReadonlySet<string>)`.
- `IdleReapTimerDeps.readExemptKeys?: () => Promise<ReadonlySet<string>>`, called fresh each tick.
- In-process topology: `runtime.ts` passes a reader built from the same port.
- cli-runner topology: a new non-session RPC verb `setKeepWarmKeys` (params `{ sessionKeys: string[] }`,
  result `{}`) in `rpc-contract.ts`. `connection.ts` routes it to `EngineHost.setKeepWarmKeys`, which
  stores the set and feeds `readExemptKeys`. The api pushes on connect, after each reconcile, and
  whenever the set changes (checked on the recovery tick). The set carries metadata-only ids.
- Test: an idle pooled child in the exempt set survives `sweepIdle`; remove the exemption and it must
  reap. A non-exempt child reaps. RPC round trip test for the new verb.

### 4. Recovery tick and boot prestart

- `ChatSessionManager.startKeepWarm(intervalMs = 60_000): () => void`. Each tick, under an in-flight
  guard: read the set, push it to the cli-runner (task 3), then `ensureSession` for each user without
  a live session. Errors are swallowed per user and retried next tick. Unref'd timer, folded into
  `shutdown()`.
- Boot: `createChatSessionRuntime` runs one tick after `connection.ensureConnected()` resolves (or
  immediately on the in-process path), never awaited by boot.
- No timer starts when `keepWarmUserIds` is absent, and a tick with an empty set does nothing, so users
  without hold-to-talk carry no extra process.
- Tests (fake clock): a lost session returns within one tick; an empty set launches nothing; a failing
  user does not block the others; a command racing a prestart joins one launch (assert one engine
  factory call).

### 5. Wiring and app map

- `apps/api/src/server.ts` builds `keepWarmUserIds` from the meetings public API and passes it through
  `registerChatRoutes` dependencies to `createChatSessionRuntime`. Chat imports nothing from meetings.
- Grep for the real caller of `keepWarmUserIds` and `startKeepWarm` before calling this done.
- `packages/meetings/src/recording-delivery-declarations.ts`: extend the voice feature description to
  say the main chat stays ready while hold-to-talk is on.

## Verification (unpiped)

- Scoped unit tests per file through the `verify-gate` skill. Expect exit 0.
- Scoped integration test for task 1 through `verify-gate`. Expect exit 0.
- Full gate through `verify-gate` last. Expect exit 0.
- Live proof is a later step on the dev copy, owned by the coordinator. Slice 1 is code-complete,
  unverified until it runs.

## Kill gate

If live timing on the dev copy shows the first ring command after 60 min idle still pays the cold
start, the exemption missed a path. Ben decides whether to continue to slice 2.

## Rulings ledger

- The enablement table is owner-only, so a cross-user list needs a definer function. Decided: follow 0146.
- The recovery tick is the floor guarantee, so correctness does not depend on either exemption.
