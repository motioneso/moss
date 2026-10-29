# Module disable: pending job cancellation

Status: Draft (2026-10-28), awaiting Ben's approval

Issue: #3735. Follow-up to #3715 (`docs/superpowers/specs/2026-10-25-module-job-enqueue-design.md`),
which kept lifecycle behavior unchanged on purpose. This spec adds a policy only. No code ships
before approval.

## Problem

When an admin disables a module, the job reconciler stops the module's workers and removes its
schedules. It leaves every queued job in place. Those rows then do one of three things:

1. They sit unclaimed, because no worker is registered, until pg-boss expires them (14 days for
   unstarted rows by default).
2. They run when the module is re-enabled, with the parameters and manifest hash they were
   queued under, possibly weeks old.
3. If the user lost access instead, they fail at the trust gate after exhausting retries.

Case 2 is the surprise. A user re-enables a module and gets a burst of stale work they never
asked to run again. With #3715 a module can also queue its own follow-on jobs, so a half-finished
chain can resume without any user action.

## Verified facts

Checked against the tree at `82c49e6a7`.

| Fact                                                                                                                                                                                         | Evidence                                                                                                                                                                       |
| -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Admin disable writes status `disabled`, then sends a `reconcile` control message for the module                                                                                              | `packages/settings/src/routes-modules.ts:240-262`; `apps/api/src/server.ts:762-764`                                                                                            |
| Reconcile of a module that is not enabled calls `stopModule` and returns                                                                                                                     | `packages/module-registry/src/external/job-reconciler.ts:107-110`                                                                                                              |
| `stopModule` removes workers and schedules. It never touches job rows                                                                                                                        | `job-reconciler.ts:226-237`                                                                                                                                                    |
| "Enabled" in the reconciler is false for a hash mismatch or a missing discovery too, not only for an admin disable                                                                           | `apps/worker/src/worker-module-gate.ts:14-33`                                                                                                                                  |
| Uninstall and a dropped queue already delete the queue and its rows                                                                                                                          | `job-reconciler.ts:137-143`, `:207-216`                                                                                                                                        |
| User deactivation, reactivation and deletion send a per-user reconcile, which runs a full pass. The pass only drops that user's schedules because the user falls out of the active-user list | `packages/settings/src/routes.ts:584`, `:701`; `me-account-routes.ts:207`; `job-reconciler.ts:79-82`; `packages/settings/sql/0188_list_active_external_module_users_draft.sql` |
| Job envelope is `{actorUserId, moduleId, jobKind, manifestHash, params?}` and the queue name starts with `<moduleId>.`                                                                       | `packages/jobs/src/module-jobs.ts:58-76`                                                                                                                                       |
| Module ids contain no dot (`[a-z0-9-]`), so the `<moduleId>.` prefix is unambiguous                                                                                                          | `module-jobs.ts:31`                                                                                                                                                            |
| Trust gate refuses `not-active`, `not-discovered`, `not-enabled` and `hash-mismatch`. The queue handler turns a refusal into a thrown error, so the row retries then fails                   | `apps/worker/src/external-module-invoke.ts:159-194`; `external-module-job-handler.ts:237-239`                                                                                  |
| The gate runs once, at the start of a run. A running job is not re-checked                                                                                                                   | same files                                                                                                                                                                     |
| `boss.cancel(name, ids)` moves rows with state below `completed` (created, retry, active) to `cancelled`. It does not stop running code                                                      | `pg-boss@12.18.2 dist/plans.js:879-892`                                                                                                                                        |
| Reconcile jobs are plain `send` with a singleton key. Module queues use the standard policy, so the key does not block a new send after the old row is gone or finished                      | `job-reconciler.ts:196-204`; #3715 spec, seams table                                                                                                                           |
| A pg-boss send reusing a job id of any existing row inserts nothing (`ON CONFLICT DO NOTHING` on `(name, id)`), including a cancelled row                                                    | #3715 spec, seams table                                                                                                                                                        |
| `pgboss.job` has no RLS. All access is on the root handle, as in `hasRecentJob`                                                                                                              | `packages/jobs/src/pg-boss.ts:230-247`                                                                                                                                         |

## Job origins

All four origins write the same envelope into the same module-prefixed queues. The state a row
is in, not who queued it, decides what happens, so one sweep covers all of them.

| Origin                    | How it gets queued                                                         | Pending forms                                            | Stopped today at disable             |
| ------------------------- | -------------------------------------------------------------------------- | -------------------------------------------------------- | ------------------------------------ |
| Scheduled                 | pg-boss cron tick inserts a row per user per schedule                      | `created` (due or delayed), `retry`                      | Schedule removed. Existing rows stay |
| Reconcile                 | One send per user per reconcile job, on every reconcile pass               | `created`, `retry`                                       | Nothing. Rows stay                   |
| Manual                    | Browser route, user session, `allowManualRun` queues                       | `created`, `retry`                                       | Route refuses (404). Rows stay       |
| Module-authored (`#3715`) | `ctx.jobs.enqueue` from a tool or job handler, actor carried from the call | `created`, `retry`. A chain also has one `active` parent | Enqueue refuses. Rows stay           |

## Queue ownership and actor boundaries

- **Queue set.** A sweep for module `M` touches queues named `M.%` only. It takes the names from
  `pgboss.queue`, not from the discovery, so a queue the manifest dropped is still covered.
- **Module check on every row.** The sweep also requires `data->>'moduleId' = M`. A row in an
  `M.` queue with another module id is left alone and logged.
- **Dead-letter queues.** A dead-letter queue declared by `M` is also named `M.%`. Its rows are
  records of failures, nothing consumes them, and the sweep skips them. They age out by
  retention.
- **Actor scope.** The module-disable sweep covers every actor. The access-loss sweep adds
  `data->>'actorUserId' = U` and touches nothing else. A user's loss of access never cancels
  another user's rows.
- **Platform queues.** Names under `system.*` and the module control queue are never swept.
- **Who may trigger it.** Only the worker's control-message handler, acting on an admin-written
  status change or a user-status change. A module cannot cancel jobs, its own or anyone's. No new
  SDK member and no new route.
- **Metadata only.** The sweep reads queue name, id, state and the two payload keys above.
  It reads no params and writes none. Logs carry module id, queue name, counts and, for the user
  sweep, the user id. They never carry params.

## Policy

### 1. What triggers a sweep

A sweep runs only on an explicit lifecycle decision, never on a condition that merely makes the
module look disabled to the reconciler.

| Event                                                    | Sweep                                    |
| -------------------------------------------------------- | ---------------------------------------- |
| Admin disables the module (status becomes `disabled`)    | Yes, all actors                          |
| User loses access (deactivated or deleted)               | Yes, that actor only (see fork 4)        |
| Hash mismatch after a core upgrade, until re-enable      | No. Transient, existing gate refuses     |
| Discovery temporarily missing (module folder unreadable) | No. Uninstall already deletes the queues |
| Draft owner stops using a draft                          | No                                       |

The reconciler cannot tell these apart from `isModuleEnabled` alone. The sweep reads the module's
status row. It runs only when the status is `disabled`. A hash mismatch leaves status `enabled`.

### 2. Which pending states are cancelled

| pg-boss state                      | Meaning                                    | Action           |
| ---------------------------------- | ------------------------------------------ | ---------------- |
| `created`                          | Waiting, including delayed (`start_after`) | Cancel           |
| `retry`                            | Failed once, waiting for the next attempt  | Cancel           |
| `active`                           | Running now                                | Leave (policy 3) |
| `completed`, `failed`, `cancelled` | Finished                                   | Leave            |

Cancel goes through `boss.cancel(queue, ids)`, with ids chosen by a query on `pgboss.job`, one
queue at a time. The sweep never issues a direct `UPDATE` on `pgboss.job`.

### 3. Active jobs

Active jobs are left to finish.

- A running invocation is already past the trust gate, is capped by the queue's timeout (at most
  ten minutes), and runs in its own lane. Cancelling its row would mark it `cancelled` while the
  code keeps writing, which hides a live run from the record.
- Its follow-on enqueues are refused (policy in #3715, step 6), so a chain cannot extend itself.
- If it fails after the disable, pg-boss moves it to `retry`, where no worker claims it. The
  sweep therefore runs twice, at disable and again once the longest allowed invocation has
  passed (11 minutes later, sent as a control message with a start delay). The second pass
  is idempotent.
- The admin-visible consequence is bounded and stated: work already running when you disable can
  finish for up to ten minutes.

### 4. Re-enable

Re-enable restores nothing that was cancelled.

- Cancelled rows stay `cancelled`. There is no resume.
- Schedules are re-created and reconcile jobs are re-sent by the normal reconcile pass, so a
  module's regular work restarts on its own.
- A module-authored chain does not restart. A cancelled row also keeps its deterministic job id,
  so the same idempotency key cannot be enqueued again until the row ages out (7 days after
  finish). A module resumes a chain with a new key, such as one with a counter, which the #3715
  guide already requires after a failure.
- A module learns what was lost from its own state, not from a platform callback. Its reconcile
  job runs on every re-enable and can mark a half-finished plan stalled with a resume action.
  No lifecycle hook is added.

### 5. Access-loss parity

Today access loss removes the user's schedules and lets other pending rows fail at the gate
after retries. They are never run, so cancelling them early changes the outcome of no job. It
only changes how soon the row ends and what state it ends in (`cancelled`, not `failed`).

Policy: the same sweep, scoped to the actor, runs from the per-user reconcile when the user is
no longer in `list_active_external_module_users` for that module.

Edge: a user who is deactivated and then reactivated loses queued work. That also happens today,
because the gate would have failed those rows. It is stated here so it is not read as a regression.

### 6. Concurrency with enqueue

The sweep and a `ctx.jobs.enqueue` call can race. The fix reuses the #3715 lock.

- The enqueue step that checks the module is live is repeated inside the per-user advisory lock,
  reading the status row under that lock, before the send.
- The sweep takes the same lock per actor (`module-enqueue:<moduleId>:<actorUserId>`) around the
  query-and-cancel for that actor.
- The status change is committed before the control message is sent. So an enqueue that gets the
  lock after the sweep sees `disabled` and refuses. One that got it before is swept.
- The manual-run route and reconcile sends are not under that lock. Their stragglers are handled
  by the delayed second pass and, as the last line, by the trust gate.

## User-visible behavior and errors

The sweep adds no screen and no new error code. Visible changes:

| Where                                  | Change                                                                                                                                                     |
| -------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Settings, Modules, disable by an admin | The disable confirmation says waiting background jobs are cancelled, that running ones can finish, and that re-enabling does not bring cancelled ones back |
| Manual run on a disabled module        | Unchanged. 404 "Not found"                                                                                                                                 |
| Module-authored enqueue when inactive  | Unchanged. `module_inactive` from #3715                                                                                                                    |
| Module screens                         | A cancelled chain is shown by the module from its own state (for example "plan stalled, resume"). Declared in that module's manifest `features`            |

App-map entries to update in the build PR:

- The Settings Modules entry in `packages/shared/src/app-map-core.ts` (the one that begins
  "Enable or disable user-toggleable modules") gains the disable behavior above.
- The module developer guide (`docs/module-developer-guide.md`) gains a lifecycle section: what
  a sweep cancels, that active runs finish, that re-enable does not resume, the new-key rule,
  and the reconcile-job pattern for marking stalled work.
- No module manifest change is required by the platform.

## Test plan

Real pg-boss on a scratch database. Run only through the `verify-gate` skill.

| #   | Test                                                                                                                                                              | Catches                                        |
| --- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------- |
| 1   | Disable cancels `created` and `retry` rows from each origin: a due schedule row, a delayed row, a reconcile row, a manual row, a module-enqueued row              | A missed origin or state                       |
| 2   | An `active` row is not cancelled and finishes `completed`. Its follow-on enqueue is refused. If it fails after the disable, the second pass cancels the retry row | Cancelling live work, or a retry slipping past |
| 3   | Module A's disable leaves module B's rows untouched, including a module whose id shares a prefix (`meals` and `meals-extra`)                                      | Prefix match too loose                         |
| 4   | A row in an `M.` queue carrying another module id is not cancelled                                                                                                | Payload module check missing                   |
| 5   | Dead-letter queue rows and `system.*` rows are not cancelled                                                                                                      | Sweep reaching other queues                    |
| 6   | Access loss for user U cancels only U's rows and leaves user V's pending rows and schedules                                                                       | Actor scope missing                            |
| 7   | Hash mismatch with status `enabled` cancels nothing. Rows run after re-enable                                                                                     | Sweep triggered by the wrong condition         |
| 8   | Re-enable restarts schedules and reconcile jobs, runs no cancelled row, and a cancelled module-enqueued key returns `duplicate`; a new key enqueues               | Resurrection, or key reuse assumption          |
| 9   | Concurrent enqueue and disable: after both finish, no pending row exists for the module (run the interleaving both ways with a barrier)                           | Race between sweep and enqueue                 |
| 10  | Sweep is idempotent: a second run cancels nothing and does not error                                                                                              | Retry of the control message                   |
| 11  | Sweep touches only queue, id, state and the two payload keys: params are absent from its logs and from the query text                                             | Private content in logs                        |
| 12  | Disabling an already-disabled module, and a module with no queues, succeed with zero cancels                                                                      | Edge cases                                     |

Security mutation evidence. Each of these is observed failing with the protection removed, and
the run recorded in the PR:

- Test 3 and 4 with the module-id filter removed.
- Test 6 with the actor filter removed.
- Test 7 with the status check replaced by `isModuleEnabled`.
- Test 9 with the lock removed from the sweep.

Live-path proof (per the live-path gate): on a dev instance, queue a manual and a module-authored
job for a test module, disable it in Settings, confirm both end `cancelled` and the screen text
matches, then re-enable and confirm neither runs.

## Forks

Each fork gives a recommendation. Forks 1 and 4 change what users and admins experience and are
for Ben to rule on. The rest are engineering calls I would make myself.

### Fork 1: should disable cancel waiting jobs at all (Ben)

| Option                                             | For                                                                                 | Against                                                                            |
| -------------------------------------------------- | ----------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------- |
| **A. Cancel created and retry rows (recommended)** | Re-enable starts clean. No stale burst. Matches uninstall, which already drops rows | An admin who disables for a minute loses queued work                               |
| B. Leave them (today)                              | Disable then re-enable is a pause                                                   | Up to 14 days of stale work with old params. Module chains resume by themselves    |
| C. Pause and resume                                | Best of both in principle                                                           | pg-boss has no pause for single rows. Needs a new table and age rules. A new build |

Reason for A: a disable is an admin withdrawing permission to run. Work queued under that
permission should not wake up weeks later. Schedules already restart on re-enable, so regular work
is not lost. Only manual and module-authored work is.

### Fork 2: active jobs

Recommend leaving them to finish (policy 3). Alternative: refuse every further host call from a
running module after disable, so it dies at its next database or model call. That needs new state
in the RPC host and can leave a run half-written, which is worse than a bounded ten-minute tail.

### Fork 3: should the platform cancel for hash mismatch too

Recommend no. A core upgrade causes it, it clears on re-enable, and the gate already refuses the
runs. Cancelling would turn every core upgrade into mass loss of queued work.

### Fork 4: access-loss parity in the same build (Ben)

| Option                                              | For                                                                            | Against                                            |
| --------------------------------------------------- | ------------------------------------------------------------------------------ | -------------------------------------------------- |
| **A. Same build, actor-scoped sweep (recommended)** | One lifecycle story. Rows end `cancelled` fast instead of retrying and failing | A second trigger to test                           |
| B. Disable only, access loss stays as it is         | Smaller change                                                                 | Leaves a documented gap. Rows keep failing noisily |
| C. Access loss only, never disable                  | None                                                                           | Does not answer the issue                          |

Reason for A: no job outcome changes, since those rows could never run. The change is cleaner
records and no retry noise. Ben's issue asked that parity be decided explicitly, so this is the
explicit decision to rule on.

### Fork 5: how the sweep runs

Recommend the worker's control-message handler, with ids chosen by SQL and cancel through
`boss.cancel`. The alternative is the API route doing it inline when the admin clicks disable.
That ties the cancel to the HTTP request, which can fail after the status is committed. The
control message is retried by pg-boss and the sweep is idempotent.

### Fork 6: cancelled rows and idempotency keys

A cancelled row keeps its job id, so its key stays used. Recommend accepting that and requiring a
new key to resume. Deleting the row instead would remove the audit trail and is not safe to do
from a sweep with no actor context. No fork for Ben.

### Fork 7: tell modules a sweep happened

Recommend no hook. The reconcile job already runs on re-enable and the module reads its own
state. A hook adds a new SDK member and a new way to run module code during a disable.

## What does not change

- Payload envelope, trust gate, lanes, timeouts, rate limits.
- Uninstall and dropped-queue behavior (queue deletion).
- Manual-run route and enqueue refusals for inactive modules.
- No new environment variable or deployment setting, so nothing to add to dev or prod config.
- No database migration. The sweep uses `pgboss.job` through the existing root handle.

## Open questions for Ben

| #   | Question                                                                                                      | Recommendation |
| --- | ------------------------------------------------------------------------------------------------------------- | -------------- |
| 1   | Fork 1. When an admin disables a module, cancel waiting jobs for good, so re-enable does not bring them back? | Yes            |
| 2   | Fork 4. Apply the same cancel to a single user who loses access, in the same build?                           | Yes            |
