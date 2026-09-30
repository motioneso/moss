# Re-run a briefing from chat

- Issue: #2809
- Status: approved scope (Ben, 2026-09-29: "we need to let Moss be able to re-run briefings from chat")
- Screens: none. No mockups needed.

## Goal

The user asks Moss in chat to re-run a briefing ("re-run my evening briefing"). Moss queues one
fresh run of the user's own briefing, then checks it and tells the user when it is ready or has
failed.

## Tools

Both tools live in the briefings module (`packages/briefings/src/tools.ts`) and are declared in its
manifest.

| Tool                     | Risk  | Approval                                             | Purpose                                     |
| ------------------------ | ----- | ---------------------------------------------------- | ------------------------------------------- |
| `briefings.rerun`        | write | none; `granted_at_install` in family `briefing_runs` | Queue one manual run of an owned definition |
| `briefings.getRunStatus` | read  | none                                                 | Read one run's state; the text when ready   |

### `briefings.rerun`

- Input: `briefingType` (`morning` \| `evening` \| `weekly_review`) or `definitionId`. Exactly one.
- Target: the actor's own definition only (`owner_user_id = current actor`). A shared definition,
  another user's definition, or a missing one all return the same "no briefing" result.
- By type: the newest-updated owned definition of that type.
- Output: `status` `queued` \| `already_running`, plus `definitionId`, `briefingType`, `runId`,
  `jobId`. `runId` is null only when the running job is a scheduled fire that carries no run id.
- Payload: the existing metadata-only `BriefingRunPayload`, `runKind: "manual"`.

### In-flight rule

A second request while a run for the same definition is still queued or running must not start a
second run.

1. Look up a non-terminal job on the briefings queue whose payload contains this actor and
   definition. Found: return `already_running` with that job's run.
2. Otherwise send with the fixed singleton key `<definitionId>:key:chat-rerun`. The queue's
   `exclusive` policy keeps at most one non-terminal job per key, so two racing chat requests
   collapse to one. A null job id here means the race was lost: re-read and return
   `already_running`.
3. After a successful send, look again for an older in-flight job for the definition, skipping
   ours. Today and the schedule use other singleton keys, so one of them can land between steps 1
   and 2. Found: cancel ours and return `already_running` with the older job. Chat therefore never
   adds a second run; the Today button keeps its existing behavior.

This extends the route's `briefing_run_in_flight` rule (a repeated idempotency key) to cover any
running job for the definition, including one started from Today or by the schedule.

### `briefings.getRunStatus`

- Input: `runId` and `jobId` from `briefings.rerun`. When `runId` is null (a scheduled run already
  going), `jobId` and `definitionId` instead.
- A stored run row visible to the actor: `succeeded` is `ready` with its summary text; `failed` or
  `blocked` is `failed`.
- No row: the actor's own job for that run decides `pending` or `failed`. A job whose payload names
  another actor or run is ignored.
- By job and definition: the actor's own scheduled job for that definition decides `pending` or
  `failed`. Once the job is done or gone, the newest run of the owned definition answers.
- Nothing found: `not_found`. Missing and not-owned look the same.
- Output is marked external content, because the summary text is written from email and other
  sources.

## Services

Tools reach pg-boss only through services the chat host builds from briefings-owned factories:

- `briefingRunQueue` (write registry): find an in-flight job, send one job, cancel one job it sent.
- `briefingRunJobs` (read registry): read one job by id.

The chat package constructs both in `buildChatToolServices` / `buildChatGatewayDependencies`. No
module reads another module's tables.

## Invariants

- RLS: definition and run reads run under the actor's data context.
- Job payload stays metadata-only.
- No model or provider named; the worker's existing router writes the briefing.
- Not destructive, so no approval card (install grants normal use). The family can still be
  tightened to ask each time in settings.

## App map

Add feature `briefings.chat_rerun` to the briefings manifest with its error and remediation. The
module has no navigation entries of its own; the briefing reader lives on Today.

## Out of scope

- Moss does not speak up on its own when the run finishes. The user asks, and Moss checks.
- No change to the Today screen or the run route's behavior.
