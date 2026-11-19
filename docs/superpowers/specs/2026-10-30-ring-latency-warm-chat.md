# Ring hold-to-talk latency, phase 2: keep the main chat warm

Task: #3854. Follows `2026-10-29-ring-latency-phase1.md` (#3842). Server side only. No new screens.

## Problem

Phase 1 measured the server leg of a hold-to-talk command.

| Stage | Seconds |
| --- | --- |
| Upload and queue pickup | under 0.2 |
| Speech-to-text | 1.3 to 2.0 |
| Cold session start, on top of the model turn | about 5 |
| Model turn, warm | 3.0 to 4.5 |
| Model turn, first with tools | about 19 |
| Classifier, per tool question | 5 to 7, up to 4 questions |

A voice request runs in the owner's ordinary drawer session. That session is dropped after
`DEFAULT_IDLE_MS` (30 min) of idleness, and on every API restart. `startIdleReaper` ticks every
`idleMs`, so a session survives 30 to 60 min idle. The warm persistent runtime pool has its own
sweep (`chat.persistent_idle_reap_minutes`, default 30). After a quiet stretch the next ring command
pays the cold start.

## Goals

- A ring command after any idle period meets a ready session.
- A user without hold-to-talk carries no extra background process.
- No change to privacy, RLS or the voice request state machine.

## Design

### 1. Keep-warm set

A user is in the keep-warm set while an enabled row exists in
`app.meeting_recording_voice_enablements` (`disabled_at IS NULL`). The set is read through a
manager-side port, `keepWarmUserIds(): Promise<ReadonlySet<string>>`, wired by the composition root
from the meetings module's public API. Chat does not query meetings tables (module isolation).

### 2. Exempt from idle reaping

- `ChatSessionManager.reapIdle` skips the drawer session of any user in the keep-warm set.
- The persistent-pool sweep (`PersistentRuntimePool.sweepIdle`) takes an optional exempt-keys
  reader that the timer calls on every tick, like `readIdleReapMinutes`. In the cli-runner
  topology the api pushes the current set over the existing RPC when it changes. The plan names the
  message after reading `engine-host.ts`.
- A recovery tick every 60 s re-ensures sessions for the set. It is the floor guarantee if either
  exemption misses a case, so a lost session is back within a minute and never waits for a command.
- When a user leaves the set, the next reaper tick treats the session as ordinary again.

### 3. Prestart

- At API boot, once the cli-runner reconcile finishes, call `ensureSession` for every user in the
  keep-warm set. Failures log and retry on the next reaper tick. They never block boot.
- After a session is lost (engine crash, cli-runner restart, provider change), the 60 s recovery
  tick restores it.
- `ensureSession` already serializes per actor and surface, so a command racing a prestart joins the
  same launch.

### 4. Start on press (backup)

The phone reports a press start. The server calls `ensureSession` for that user and does nothing
else. This covers a lost session and a first-ever press, and the seconds of speech hide the launch.
It is a second slice behind a separate review, because it adds a phone to server call. The call
carries no recording content and no secrets.

### 5. Classifier

The gate asks 5 to 7 seconds per question on a sign-in CLI model. A fast configured model removes
most of that. The slice only measures: time a command with the gate on under a sign-in model and
under a fast model, and record both. Any Settings or app-map change follows the measurement.

## Cost and risk

| Item | Note |
| --- | --- |
| Idle memory | One CLI child per keep-warm user. Accepted. Single-user installs have one. |
| Provider tokens | A warm session spends none until a turn runs. |
| Stale child | A warm child can hold an expired sign-in. Recovery is the existing launch-failure path. |
| Hold-to-talk off | The user leaves the set and the session reaps normally. |

## Slices

1. Keep-warm port, reaper exemptions, boot prestart, tests.
2. Start on press.
3. Classifier measurement.

## Proof

Time at least five commands per case on the live dev copy with a real model. Case A is a session
idle past 60 min before the change, then after. Case B is a warm session. Record the numbers on the
PR. A test asserting the exemption must fail with the exemption removed.

## App map

Hold-to-talk behaviour is declared in `recording-delivery-declarations.ts`. The slice 1 PR updates
that entry to say the chat stays ready while hold-to-talk is on.
