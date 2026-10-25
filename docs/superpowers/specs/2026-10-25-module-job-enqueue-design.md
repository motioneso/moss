# Module job enqueue: a module starts a job on its own queue

Status: Draft (2026-10-25), awaiting Ben's approval

Issue: #3715. Blocks #3317 phase 2 generation. Consumer plan: `docs/superpowers/plans/2026-10-25-meals-build.md`, Fork A.

## Problem

A downloaded module cannot start a job from its own code. Meals writes a plan one day per job, and
each day must finish before the next starts so the no-repeat rule sees earlier days
(`docs/superpowers/specs/2026-10-09-meals-meal-planning-design.md:485`). A day takes minutes and
an invocation is capped at ten minutes (`packages/module-sdk/src/external-module.ts:94`), so one job
cannot write a week. A plan started from chat has no open page to drive the chain.

Verified against the tree at `ad69bc66e`:

| Claim                                                                 | Evidence                                                                                                                                        |
| --------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------- |
| The worker context has no jobs port                                   | `packages/module-sdk/src/worker.ts:56-179` lists every member; none enqueues                                                                    |
| The RPC host has no jobs method                                       | `packages/module-registry/src/external/worker-rpc-host.ts:210-538` dispatches attachments, notify, fetch, embed, actionPolicy, db, ai, auth, kv |
| The only runtime enqueue is the browser route                         | `sendModuleJob` has one caller, `apps/api/src/external-module-jobs.ts:69`                                                                       |
| That route needs `allowManualRun` and a live user                     | `apps/api/src/external-module-jobs.ts:52`                                                                                                       |
| That route is rate limited per user per module, 6 a minute by default | `apps/api/src/external-module-jobs.ts:27-35`                                                                                                    |
| Schedules and reconcile jobs are host-started, static params only     | `packages/module-registry/src/external/job-reconciler.ts:145-204`                                                                               |
| Tool calls and queue jobs share one RPC host                          | API tool path `apps/api/src/external-module-tools.ts:65-113`; worker path `apps/worker/src/external-module-invoke.ts:195-232`                   |

## Seams this design relies on

| Capability                                                                                                       | Citation                                                                                   |
| ---------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------ |
| Payload envelope `{actorUserId, moduleId, jobKind, manifestHash, params?}`, strict keys                          | `packages/jobs/src/module-jobs.ts:8-14`, `:58-61`                                          |
| Params checked against `paramsSchema`, 2 KiB params, 4 KiB payload                                               | `packages/jobs/src/module-jobs.ts:83-95`                                                   |
| Queue must be prefixed with the module id                                                                        | `packages/jobs/src/module-jobs.ts:70-76`                                                   |
| Advisory-lock-then-send pattern against `pgboss.job`                                                             | `packages/jobs/src/module-jobs.ts:116-125`, `packages/jobs/src/pg-boss.ts:230-247`         |
| RPC handler is built per invocation, bound to one actor and one module                                           | `worker-rpc-host.ts:154-158`, `:204-209`                                                   |
| Per-invocation call caps live in RPC memory                                                                      | `worker-rpc-host.ts:122`, `:137`, `:233-237`                                               |
| Read-risk invocations refuse mutations                                                                           | `worker-rpc-host.ts:230-232`; candidate hooks always read `external-module-tools.ts:61-64` |
| Optional injected ports (notify, attachments) on the RPC host                                                    | `worker-rpc-host.ts:168-187`                                                               |
| Worker trust gate (user active, status, both hashes)                                                             | `apps/worker/src/external-module-invoke.ts:159-194`                                        |
| Module-enabled predicate reused by the reconciler                                                                | `apps/worker/src/worker-module-gate.ts:14-33`                                              |
| API has `boss` and root db at the composition root                                                               | `apps/api/src/server.ts:455-461`, `:485-493`                                               |
| Queue job runs write-risk in a per-queue serial lane                                                             | `apps/worker/src/external-module-job-handler.ts:207-213`                                   |
| pg-boss `send` takes an explicit job `id`; insert is `ON CONFLICT DO NOTHING` on `(name, id)`                    | `pg-boss@12.18.2 dist/manager.js:438`, `dist/plans.js:455`, `:991`                         |
| Module queues use the `standard` policy, which has no unique index on `singleton_key` without `singletonSeconds` | `job-reconciler.ts:239-247`; `pg-boss dist/manager.js:653`, `dist/plans.js:464-479`        |
| pg-boss keeps finished rows 7 days and unstarted rows 14 days by default                                         | `pg-boss dist/plans.js:24-33`                                                              |
| Queue entries are spread through the validator, so a new key survives but is unchecked                           | `packages/module-registry/src/external/validate.ts:364-375`                                |
| Params DSL allows free `string` fields up to 2,048 chars                                                         | `packages/module-sdk/src/module-params.ts:9-16`                                            |

No seam is assumed without a citation. The open questions below cover policy, not missing machinery.

## Decisions

1. Add `ctx.jobs.enqueue` to the worker context and a `jobs.enqueue` RPC method on the host.
2. Tool handlers and job handlers both get it, through the same RPC host. Read-risk invocations
   (read tools, candidate hooks, briefing calls) are refused.
3. A queue opts in with `allowModuleEnqueue: true`. The target must be a queue the calling module
   declares.
4. The host sets the acting user, module id and manifest hash. The module supplies queue, job kind,
   idempotency key and params, and nothing else.
5. Idempotency is a job id derived from the key. A retried parent gets `duplicate`, never a second
   job.
6. Three limits apply: per invocation, pending per user, and hourly per user. Hitting one returns
   `limited`; it does not throw.
7. No delay or start-after in v1.

## Contract

### SDK (`packages/module-sdk/src/worker.ts`)

```ts
export type ModuleJobEnqueueResult =
  | { readonly status: "enqueued" }
  | { readonly status: "duplicate" }
  | { readonly status: "limited"; readonly limit: "invocation" | "pending" | "hourly" };

export interface ModuleJobsPort {
  enqueue(input: {
    readonly queue: string;          // full declared name, e.g. "meals.generate"
    readonly jobKind: string;        // /^[a-z][a-z0-9_.-]{0,63}$/, same as module-jobs.ts:77
    readonly idempotencyKey: string; // /^[A-Za-z0-9][A-Za-z0-9_.:\/-]{0,127}$/
    readonly params?: Readonly<Record<string, unknown>>;
  }): Promise<ModuleJobEnqueueResult>;
}

// ModuleWorkerContext gains:
readonly jobs: ModuleJobsPort;
```

- The pg-boss job id is never returned. A module has no use for it, and it names a host row.
- Contract violations reject the promise with a generic RPC error. Expected outcomes resolve.

### RPC method `jobs.enqueue`

| Step | Check                                                                                            | On failure                         |
| ---- | ------------------------------------------------------------------------------------------------ | ---------------------------------- |
| 1    | Invocation risk is not `read`                                                                    | throw `forbidden_enqueue_mutation` |
| 2    | Port is wired at this construction site                                                          | throw `invalid_rpc`                |
| 3    | Params object has exactly `queue`, `jobKind`, `idempotencyKey`, optional `params`; formats match | throw `invalid_rpc`                |
| 4    | `queue` is in this module's `worker.queues` with `allowModuleEnqueue: true`                      | throw `undeclared_queue`           |
| 5    | Per-invocation counter below cap                                                                 | resolve `limited: invocation`      |
| 6    | Module live for this actor (see below)                                                           | throw `module_inactive`            |
| 7    | Envelope passes `assertModuleJobPayload`                                                         | throw `invalid_job_params`         |
| 8    | Under advisory lock: duplicate, pending and hourly checks, then send                             | see limits                         |

- Module and actor come from the RPC handler's bound input (`worker-rpc-host.ts:155-158`). Any
  `actorUserId` or `moduleId` key in the RPC params fails step 3.
- Step 6 reuses the predicate the worker already trusts. In the worker it is
  `createIsModuleEnabled` plus `listActiveUserIds`. In the API it is `getActiveExternalModules`
  (`server.ts:489-490`). Each composition root injects it, so the RPC host stays module-agnostic.
- Step 8 runs on the root database handle, as the manual-run route does (`external-module-jobs.ts:84`).

### Host-side injection

```ts
// packages/module-registry/src/external/worker-rpc-host.ts, createExternalModuleRpcHandler input
readonly enqueueJob?: (
  access: AccessContext,
  request: {
    readonly queue: ExternalModuleQueueDeclaration;
    readonly jobKind: string;
    readonly idempotencyKey: string;
    readonly params?: Readonly<Record<string, unknown>>;
  }
) => Promise<ModuleJobEnqueueResult | { readonly status: "inactive" }>;

// packages/jobs/src/module-jobs.ts
export async function enqueueModuleJobForActor(
  boss: PgBoss,
  rootDb: Kysely<MossDatabase>,
  access: AccessContext,
  module: { readonly id: string; readonly manifestHash: string;
            readonly queueNames: readonly string[] },
  queue: ExternalModuleQueueDeclaration,
  command: { readonly jobKind: string; readonly idempotencyKey: string;
             readonly params?: Readonly<Record<string, unknown>> },
  limits: ModuleEnqueueLimits
): Promise<ModuleJobEnqueueResult>;
```

Wiring sites:

- API tool path: `apps/api/src/external-module-tools.ts:65` gains `rootDb` and the active check.
  `server.ts:455` passes `appDb`.
- Worker queue path: `VerifiedExternalModuleInvokerDeps` gains `enqueueJob`, threaded from
  `createExternalModuleJobHandler` and `worker.ts:519`.
- Briefing invoker: not wired. Its calls are read-risk.

### Manifest

- `ExternalModuleQueueDeclaration` gains `readonly allowModuleEnqueue?: boolean`
  (`packages/module-sdk/src/external-module.ts:120-131`).
- The validator (`validate.ts:331-375`) rejects a non-boolean value.
- With `allowModuleEnqueue: true` the validator also requires a `paramsSchema`, and rejects any
  `string` field anywhere in it. Allowed field types are `uuid`, `identifier`, `timestamp`,
  `boolean`, `null`, `integer`, `number`, `enum`, and arrays of those. This turns the
  metadata-only payload rule into a check for this path: module code writes these params at run
  time, so a free-text field would be one bug away from carrying private content.
- Meals needs `planId` (uuid) and `day` (integer or timestamp), so the rule costs it nothing.

## Idempotency

- Job id = name-based UUID (v5, fixed platform namespace) over
  `moduleId`, `queue`, `actorUserId` and `idempotencyKey`, joined with NUL.
- Under the lock the host checks for an existing row with that `(name, id)` in any state. A hit
  returns `duplicate`. The send itself is also `ON CONFLICT DO NOTHING`, so a race that slips past
  the check still inserts nothing.
- The duplicate check runs before the limits. A retried parent at the pending cap gets
  `duplicate`, not `limited`, so retries never read as a stalled chain.
- Keys are scoped per user. Two users with the same key get two jobs.
- The key text is hashed and never stored, logged or put in the payload.
- The dedup window is the life of the earlier row. That means up to 14 days unstarted, and
  7 days after it finishes (pg-boss defaults; module queues set no override). A key names one
  logical step, such as `plan:<planId>:day:3`. To run a step again, use a new key, for example one
  with a regeneration counter. A failed or cancelled row still blocks its key.
- The parent's own idempotency key (`external-module-job-handler.ts:205`) is not used. A key
  derived from the parent job would let a chat tool called twice start two chains.

## Limits

Constants in `worker-rpc-host.ts` beside `AI_CALLS_PER_INVOCATION_CAP`. No env var, so nothing
new is required in any deployment config.

| Limit          | Value    | Counted over                                                                                              | When hit              |
| -------------- | -------- | --------------------------------------------------------------------------------------------------------- | --------------------- |
| Per invocation | 5 calls  | Calls that pass step 4, in RPC memory                                                                     | `limited: invocation` |
| Pending        | 10 jobs  | Rows in `created`, `retry` or `active` on any of this module's queues with `data->>'actorUserId'` = actor | `limited: pending`    |
| Hourly         | 120 jobs | Rows created in the last 3,600 s on this module's queues for the actor, any state except `cancelled`      | `limited: hourly`     |

- Pending and hourly count every origin: schedules, reconcile jobs, manual runs and module
  enqueues. The thing being bounded is queue load per user, whatever started it.
- Pending bounds fan-out. Hourly bounds a runaway chain, which keeps pending at 2 but never stops.
- The advisory lock key is `module-enqueue:<moduleId>:<actorUserId>`. It serializes the count and
  the send, so two invocations at 9 pending cannot both pass.
- The running parent is `active` and counts. A Meals chain sits at 2 pending.
- On any `limited` result the host logs a warning with module id, queue, job kind and limit name.
  It never logs params. The module decides what the user sees. Meals marks the plan stalled with a
  resume action.

## Module lifecycle and pending jobs

| Event                              | Today                                                                                                                                                | With this design                                                                     |
| ---------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------ |
| Instance disable                   | Reconciler stops workers and schedules; rows stay (`job-reconciler.ts:226-237`)                                                                      | Same. Enqueue refused at step 6. Pending rows run on re-enable if params still match |
| User loses access                  | Trust gate refuses `not-active`; job fails after retries (`external-module-invoke.ts:159-161`, `external-module-job-handler.ts:237-239`)             | Same. Enqueue refused at step 6                                                      |
| Uninstall                          | `purgeModule` deletes the queues, which deletes their rows (`job-reconciler.ts:207-216`; `pg-boss dist/plans.js:434-438`)                            | Same                                                                                 |
| Queue dropped by an upgrade        | Queue deleted with its rows (`job-reconciler.ts:137-143`)                                                                                            | Same. The chain on it ends                                                           |
| Package upgrade, queue kept        | Payload hash is format-checked only (`module-jobs.ts:80`); handler re-validates params against the new schema (`external-module-job-handler.ts:198`) | Same. In-flight chains continue on new code if params still match, else fail         |
| Core upgrade moves `manifest_hash` | Gate refuses `hash-mismatch` until re-enable (`external-module-invoke.ts:181-194`)                                                                   | Same. Enqueue refused at step 6 in that window                                       |

- The deterministic id uses the queue name, not the hash, so dedup survives an upgrade.
- Module authors keep a self-enqueued queue's `paramsSchema` backward compatible, or accept that
  chains in flight across an upgrade fail. The developer guide says so.

## Security and RLS

- `pgboss` has no RLS. Enqueue and counting use the root handle, as manual run does. The module
  never sees a row, an id or a count. It sees only a status.
- The actor is never module-chosen. It comes from the authenticated tool call or the parent
  job's envelope, which the host wrote.
- A module cannot reach another module's queue. Step 4 looks up only its own declarations, and
  `assertModuleJobPayload` rechecks the prefix.
- No admin path. An admin's module enqueues as that admin, under the same limits.
- Payload stays metadata-only. No free strings, a 2 KiB cap, and the key is hashed away.
- The enqueued job passes the full trust gate when it runs. Enqueue grants no new authority, only
  a later invocation with the same actor and the same checks.

## What does not change

- Payload envelope and its validator (`module-jobs.ts:8-96`). No new payload key, so a worker one
  version behind still accepts every job.
- Manual-run route, schedules and reconcile jobs.
- Trust gate, lanes, timeouts and the AI call cap.
- `MODULE_WORKER_CONTRACT_VERSION` stays 1 (`external-module.ts:75`). The change is additive. A
  module built against the new SDK on an older host gets a generic RPC error from `jobs.enqueue`.
- A module must be rebuilt against the new SDK to get `ctx.jobs`, because `defineModuleWorker` is
  bundled into its `dist/worker.js`.

## Forks

### Fork A: how a chain advances

| Option                                             | For                                                                                        | Against                                                                                                                                                                                         |
| -------------------------------------------------- | ------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **A1. `ctx.jobs.enqueue` (chosen)**                | Next day starts the moment the last ends. Works from chat. No idle cost                    | Platform change, blocks Meals phase 2                                                                                                                                                           |
| A2. Per-user cron every minute drains pending days | Ships today with no platform change. Self-healing, so a lost link restarts within a minute | One job a minute for every user with the module enabled, forever (1,440 a day each). Up to 60 s dead time per day. Every tick pays the trust gate, preference and locale reads. Job table churn |
| A3. Page drives each day through manual run        | Works today                                                                                | Dies when the tab closes. Chat plans never finish. 6 a minute cap                                                                                                                               |
| A4. One long job                                   | Simplest                                                                                   | 7 days at minutes each overruns the ten-minute ceiling                                                                                                                                          |

A2 is the strongest rival. Its self-healing is real, because a chain under A1 stops if a day fails
past its retries. A1 answers that in the module: the plan row records the stalled day and a resume
tool re-enqueues it under a new key. If the module wants healing without a click, it can still add
an hourly sweep schedule, which costs 24 jobs a day, not 1,440. A2 loses because it charges every
user a constant tax to fix one platform gap, and every future chaining module would pay it again.
It stays the fallback if A1 has not shipped when Meals phase 2 starts.

### Fork B: how a retried parent avoids a second child

| Option                                           | For                                                            | Against                                                                                                  |
| ------------------------------------------------ | -------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------- |
| **B1. Deterministic job id (chosen)**            | Uses pg-boss's own primary key. Exact, race-safe, no new table | Dedup window is pg-boss retention, not forever                                                           |
| B2. Host ledger table of used keys               | Permanent dedup. An audit trail                                | New core table, RLS classification, retention and cleanup work, for a window nobody needs past days      |
| B3. `singletonKey` alone                         | Already used by reconcile jobs                                 | No effect on a `standard` queue; nothing is unique on it (`plans.js:464-479`)                            |
| B4. `singletonKey` plus `singletonSeconds`       | Already used by manual run                                     | Time-bucketed. A retry after the window double-enqueues; a legitimate second step inside it is swallowed |
| B5. Switch module queues to the `stately` policy | Built-in uniqueness                                            | Changes behaviour for every existing module queue, and limits a key to one job per state                 |

B2's case is permanence. It loses because the only retry that matters, a pg-boss retry of the
parent, happens within minutes, and a step re-run after seven days is a new step that wants a new
key.

### Fork C: which queues a module may target

| Option                                                 | For                                                                                                                    | Against                                                                                                         |
| ------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------- |
| **C1. Per-queue opt-in `allowModuleEnqueue` (chosen)** | Least privilege. Visible in the manifest at install. Lets the validator demand a strict schema on exactly these queues | One more manifest key and validator branch                                                                      |
| C2. Any queue the module declares                      | No manifest change. The module already runs arbitrary code in its own handlers                                         | A free-text `paramsSchema` written for the browser route becomes a run-time channel for module-authored content |

C2's case is that the limits are the real guard and the flag adds surface. C1 wins on the payload
rule. The strict-schema check needs a marker for which queues it applies to, and that marker is
this flag.

### Fork D: delay or start-after

Not in v1. Meals enqueues as the last step of a day, after its writes commit (each `db.query`
RPC runs in its own data context, `worker-rpc-host.ts:321-324`). Transient failures already get
pg-boss retries. Add a bounded `delaySeconds` when a consumer needs one.

## Tests

Integration tests run on the real worker runtime and a real pg-boss, modelled on
`tests/integration/module-worker-queue-ai.test.ts`.

| #   | Behaviour                                                                                                                                                      | A broken build fails because                                                    |
| --- | -------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------- |
| 1   | A job handler enqueues the next step. The new row's `actorUserId` is the parent's                                                                              | Taking the actor from params, or from a host default, writes a different id     |
| 2   | A tool call enqueues. The row carries the tool caller's id                                                                                                     | API wiring missing, or bound to the wrong access context                        |
| 3   | RPC params with an extra `actorUserId` are rejected and nothing is inserted                                                                                    | A permissive params parser lets the module pick the actor                       |
| 4   | Enqueue to another module's queue, or to an undeclared or non-opted-in queue, throws and inserts nothing                                                       | Lookup by name across all discoveries, or ignoring the flag                     |
| 5   | Params that fail `paramsSchema` throw and insert nothing                                                                                                       | Validation skipped on this path                                                 |
| 6   | Parent enqueues, then throws. pg-boss retries it. Exactly one child row exists, and the second call returns `duplicate`                                        | A random id, or `singletonKey` without seconds on a standard queue, inserts two |
| 7   | At 10 pending, a retried parent's repeat call returns `duplicate`, not `limited`                                                                               | Limits checked before the duplicate check                                       |
| 8   | Same key from two users makes two jobs                                                                                                                         | Actor left out of the id derivation                                             |
| 9   | With 10 pending for the actor, the 11th call returns `limited: pending`. **Must be observed failing with the pending check removed; record the run in the PR** | The limit is not enforced                                                       |
| 10  | Another user's pending jobs do not count toward this actor                                                                                                     | Count not filtered by actor                                                     |
| 11  | 121st job in an hour returns `limited: hourly`                                                                                                                 | Rate not enforced, or window wrong                                              |
| 12  | 6th call in one invocation returns `limited: invocation`; a new invocation starts at zero                                                                      | Counter shared across invocations, or absent                                    |
| 13  | Two concurrent invocations at 9 pending: one `enqueued`, one `limited`                                                                                         | Count and send not under one lock                                               |
| 14  | A read-risk tool and a candidate hook are refused                                                                                                              | Risk gate missing on the new method                                             |
| 15  | Disabled module, or actor without access, throws `module_inactive` and inserts nothing                                                                         | Step 6 skipped on one composition root                                          |
| 16  | After a package upgrade that keeps the queue and schema, a pending child runs. After one that breaks the schema, it fails with the params message              | Hash compared on the payload, or schema not rechecked                           |
| 17  | Job data has exactly the envelope keys; the key text appears nowhere in the row                                                                                | Key stored in payload or singleton key                                          |
| 18  | Validator: non-boolean flag rejected; flag without `paramsSchema` rejected; a `string` field rejected; a valid entry survives `validateExternalModuleManifest` | Spread-through validation lets bad entries pass (`validate.ts:364`)             |

Live-path proof belongs to the Meals PR: a plan started from chat, page closed, finishes every
day on a dev instance.

## App map

No core app-map change. The platform adds no screen, setting or user-facing error. Meals declares
its own "plan stalled" error and resume remediation in its manifest `features` in its own PR.
`docs/module-developer-guide.md` gains a `ctx.jobs` section covering the flag, key rules, limits
and the upgrade caveat.

## Open questions

**Decided by Ben, 2026-10-25.**

- Q1: approved as written. 5 per invocation, 10 pending, 120 an hour.
- Q2: separate later issue (#3735). This work does not cancel pending jobs.
- Q3 and Q4 stay deferred.

| #   | Question                                                                                                                                                                                    | Owner              |
| --- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------ |
| 1   | Approve the numbers: 5 per invocation, 10 pending, 120 an hour                                                                                                                              | Ben                |
| 2   | Should disabling a module, or losing access, cancel that user's pending jobs instead of letting them fail at the gate after retries? Applies to all job origins, so it may be its own issue | Ben                |
| 3   | When third-party modules arrive, do these limits move into the manifest as declared quotas, clamped by the host, as the AI cap comment anticipates (`worker-rpc-host.ts:118-121`)?          | Platform, deferred |
| 4   | Should the strict no-free-string schema rule later apply to every queue, not just opted-in ones? It would break any installed module whose manual-run queue takes a string                  | Platform, deferred |
