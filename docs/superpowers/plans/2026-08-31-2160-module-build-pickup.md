# Plan — #2160: module-build job pickup (stuck-in-"building" root cause)

## Root cause (evidenced from the live pg-boss queue row, not guessed)

Queried `pgboss.job` for `name='module-build'` on the shared dev database. The row backing the
PR 2101 proof's stuck build:

```
id=75669f53-...  state=completed
created_on   = 2026-08-31 20:15:17.470214+00
started_on   = 2026-08-31 20:30:17.553281+00   <- exactly 15 minutes after created_on
completed_on = 2026-08-31 20:31:14.850165+00   <- 57s after started_on
retry_count  = 1
```

`MODULE_BUILD_QUEUE`'s options (`packages/jobs/src/pg-boss.ts:71-78`) set `retryLimit`,
`deleteAfterSeconds`, `retentionSeconds` — no `heartbeatSeconds`. Per pg-boss's own docs
(`expireInSeconds` default = 15 minutes; a queue with no `heartbeatSeconds` gets no automatic
liveness check), an active job whose worker dies, hangs, or is silently outrun by a competing
claim is invisible to pg-boss until the flat 15-minute expiry fires. The proof's timeline
(job created 20:15:17, first real progress 20:30:17) matches that default exactly — the job sat
claimed-but-stalled for the full window before pg-boss's supervisor (which only runs in the worker
process, `apps/worker/src/worker.ts:196-201`) reaped and retried it, at which point it finished in
under a minute.

This is the shared queue/build-state boundary named in the exit criteria: `MODULE_BUILD_QUEUE` has
no bounded heartbeat, so any orphaned claim — regardless of which of the (possibly multiple)
worker processes connected to the shared dev database made it — is stuck for up to 15 minutes
before self-healing. No migration, no per-instance queue: this is a queue-config fix using pg-boss's
existing heartbeat/expiry mechanism.

## Decision

1. `packages/jobs/src/pg-boss.ts` — add a named constant and set it on `MODULE_BUILD_QUEUE`'s
   queue options:

   ```ts
   export const MODULE_BUILD_QUEUE_HEARTBEAT_SECONDS = 60;
   ```

   In `FOUNDATION_QUEUES` (currently lines 71-78), change the `MODULE_BUILD_QUEUE` entry's
   `options` to also include `heartbeatSeconds: MODULE_BUILD_QUEUE_HEARTBEAT_SECONDS`.

2. `apps/worker/src/worker.ts` — the existing registration at line 310-312:
   ```ts
   await boss.work<ModuleBuildPayload>(
     MODULE_BUILD_QUEUE,
     createModuleBuildWorker({ boss, sendJob, runStep: runModuleBuildStepForJob })
   );
   ```
   becomes (import `MODULE_BUILD_QUEUE_HEARTBEAT_SECONDS` alongside the existing
   `MODULE_BUILD_QUEUE` import at line 25):
   ```ts
   await boss.work<ModuleBuildPayload>(
     MODULE_BUILD_QUEUE,
     { heartbeatRefreshSeconds: MODULE_BUILD_QUEUE_HEARTBEAT_SECONDS / 3 },
     createModuleBuildWorker({ boss, sendJob, runStep: runModuleBuildStepForJob })
   );
   ```
   `heartbeatRefreshSeconds` must be less than `heartbeatSeconds` (pg-boss requirement) — dividing
   the same constant keeps both numbers derived from one source instead of two hand-picked values
   drifting apart.

Net effect: a worker that has genuinely claimed a module-build job but died, hung, or lost its
connection stops looking "in progress" after roughly a minute instead of fifteen — pg-boss's own
supervisor reaps and retries it. A worker that is actively running a step keeps renewing its
heartbeat and is not falsely reaped.

## Test case (the smallest regression check that would fail against the original bug)

`tests/unit/jobs-pg-boss.test.ts` — new test in the existing `describe` block that already asserts
`FOUNDATION_QUEUES` contents (see existing assertion at line 112):

- **Behavior:** `FOUNDATION_QUEUES.find(q => q.name === MODULE_BUILD_QUEUE)!.options.heartbeatSeconds`
  equals `MODULE_BUILD_QUEUE_HEARTBEAT_SECONDS`, and that value is well under pg-boss's 900s
  default (assert `< 300`).
- **Why it fails against the original code:** today that field is `undefined` — the assertion
  `toBe(MODULE_BUILD_QUEUE_HEARTBEAT_SECONDS)` fails, which is exactly the missing config that let
  the proof's build sit for 15 minutes.

No DB-touching test is added or changed; this is a pure unit test on the exported constant object.

## Verification

```bash
pnpm vitest run tests/unit/jobs-pg-boss.test.ts > /tmp/2160-unit.log 2>&1; echo "EXIT=$?"
```

Expected: `EXIT=0`.

Full gate and live proof happen at wrap-up via the `verify-gate` skill only (never run
`pnpm verify:foundation` directly, never pipe it).

## Kill gate

Single phase, no phase 2. If the unit test above cannot be made to fail against the current
(un-patched) `pg-boss.ts` — i.e. if `heartbeatSeconds` turns out to already flow through some other
path and the bug isn't the missing config — stop and re-open investigation with the coordinator
rather than shipping a config change that doesn't address the proven timeline. Call made by whoever
reviews this plan (coordinator) or by the build agent if the test surprises it before that review.

## Live-path proof

This is a queue-configuration change with no new user-facing surface — it changes how fast an
orphaned build recovers, not what the user does. Live proof at wrap-up: trigger a module build on
the live dev instance and confirm it still completes normally (no behavior regression for the
happy path); a live proof of the _15-minute-to-1-minute_ improvement itself is impractical to
demonstrate in one session (it requires deliberately killing a worker mid-job) and will be reported
as verified by the unit test plus code reading, not by live reproduction of the failure.
