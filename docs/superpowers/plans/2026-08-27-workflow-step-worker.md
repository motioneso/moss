# Build plan: workflow step execution (#2014)

## Scope

Implement the worker and queue path in the approved #2014 spec. This slice owns metadata-only
step jobs, actor-scoped task execution, retry and backoff, typed edge routing, duplicate delivery
recovery, and dead-letter handling. Approval suspension/resumption and artifact storage remain
out of scope for #2015.

## Seams checked on this branch

- The workflow registry resolves a workflow id to its module and definition through
  `packages/module-registry/src/workflow-registry.ts:394-407`; its entries expose step definitions,
  retry policy, and edges through the SDK types in `packages/module-sdk/src/workflow.ts:127-134`.
- Workflow run and step tables, including `pgboss_job_id`, attempt state, and the unique step key,
  are in `packages/workflows/sql/0202_workflow_runs.sql:21-109`.
- Owner-scoped persistence and insert-or-return step creation are in
  `packages/workflows/src/repository.ts:167-196`; state transitions and parent-run locking are
  available in `packages/workflows/src/repository.ts:198-591`.
- The workflows package and manifest are registered in
  `packages/module-registry/src/index.ts:2100-2111`; built-in queues and workers are aggregated
  through `packages/module-registry/src/index.ts:2453` and `2716-2727`.
- Metadata-only payload validation and the send wrapper are in
  `packages/jobs/src/pg-boss.ts:86-134`, and actor-scoped worker context is available through
  `registerDataContextWorker` in the same module. The worker will deliberately use `boss.work`
  so bookkeeping transactions do not surround handler execution.

## Phase 1: queue contract and pure worker decisions

Files: `packages/workflows/src/jobs.ts`, `packages/workflows/src/index.ts`,
`packages/workflows/src/manifest.ts`, `packages/jobs/src/pg-boss.ts`,
`packages/module-registry/src/index.ts`, `tests/unit/workflows-jobs.test.ts`.

Decisions:

- Export `WORKFLOW_STEP_EXECUTE_QUEUE`, `WORKFLOW_STEP_DEADLETTER_QUEUE`,
  `WORKFLOW_QUEUE_DEFINITIONS`, `WorkflowStepJobPayload`, metadata validation, and one enqueue
  helper. The execute queue uses `policy: "exclusive"`, a small transport retry limit, and
  `deadLetter: "workflow.step.deadletter"`; the dead-letter queue has no retries.
- Use `singletonKey: "<stepRunId>:<attempt number>"` so a retry can be scheduled while the
  current job is still active. The helper rejects terminal, suspended, cancelled, or already
  claimed step runs and stores the returned job id when a send succeeds.
- Add `workflowRunId` and `stepRunId` to the shared payload allowlist and declare both manifest
  jobs as metadata-only.
- Wire queue definitions and `registerWorkflowWorkers` into the existing workflows registration.

Tests must fail if payloads include step content, duplicate sends are not exclusive, retry keys
collide with the active attempt, or the manifest/registry omits either queue.

Kill gate: if pg-boss rejects the queue option shape or cannot return a job id for the exclusive
send, stop this phase and record the exact error in the task record before changing the contract.

## Phase 2: worker execution and routing

Files: `packages/workflows/src/workers.ts`, `packages/workflows/src/repository.ts`,
`packages/workflows/src/index.ts`, `packages/module-registry/src/index.ts`,
`tests/unit/workflows-workers.test.ts`, `tests/integration/workflow-step-worker.test.ts`,
`tests/integration/ai-tools.test.ts`.

Public signatures:

- `registerWorkflowWorkers(boss: PgBoss, deps: WorkflowWorkerDependencies): Promise<string[]>`.
- `WorkflowWorkerDependencies` supplies `boss`, `dataContext`, optional repository, and the registry.
- `runWorkflowStep(job, deps): Promise<WorkflowStepWorkerResult>` remains exported for direct
  integration coverage with a hand-built pg-boss job.
- Repository additions are limited to the worker's missing reads and locked routing writes; all
  database work continues through `DataContextDb` and owner-scoped methods.

The worker claims and commits before invoking a task handler, invokes the handler with a fresh
owner-scoped context, then records bounded results or errors in a fresh transaction. It resolves
`always`, `onSuccess`, `onFailure`, and `resultEquals` edges under a `FOR UPDATE` parent-run lock,
creates successor step runs with conflict-ignore semantics, and enqueues only pending successors.
Repeated deliveries skip terminal handlers but re-run idempotent routing. Transport failures are
the only errors allowed to reach pg-boss; committed workflow failures return normally.

Tests cover success, bounded result, one successor, duplicate delivery, converging branches,
retry/backoff and final failure edges, missing definitions, cancelled runs, terminal-run timing,
dead-letter handling, payload keys, and owner-scoped execution. The integration test uses a real
isolated database only through the `verify-gate` procedure.

## Verification

- `pnpm format:check` exits 0.
- `pnpm lint` exits 0.
- `pnpm typecheck` exits 0.
- `scripts/run-gate.sh start` followed by `scripts/run-gate.sh wait --follow` exits 0; this is
  the only route for `pnpm verify:foundation` and database-touching integration tests.
- No live-path proof is required because this slice has no user-facing surface.
