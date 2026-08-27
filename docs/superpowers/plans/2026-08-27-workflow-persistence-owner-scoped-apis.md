# Build plan — #2013 (819-B): durable workflow persistence and owner-scoped run APIs

Approved spec: `docs/superpowers/specs/2026-07-08-workflow-layer-pg-boss.md`
(sections Data Model, Run Origins, Module Registration, Artifacts, Approval Steps, API Surface).
Detailed implementation plan: the `SPEC` comment on issue #2013.
Issue: #2013 (`task`, `fleet-run`). Parent epic #819. Branch `fleet/lane-2013`.
Risk tier: **security** — two-owner isolation is the bar this slice exists to hold.

## Scope

Create the durable store for workflow runs, the typed repository that is the only way code reaches
it, and four owner-scoped HTTP endpoints. Nothing executes a workflow: no pg-boss queue, no worker,
no vault byte write, no UI.

Out of scope, owned elsewhere: definition contracts and boot validation (#2012, already merged),
queues/worker/retries/edge routing (#2014), approval-to-continuation resume and the artifact write
port (#2015).

## Seams check — every assumed capability, cited on this branch

| Assumption                                                                     | Evidence                                                                                                       |
| ------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------- |
| `assertDataContextDb` guards the scoped handle                                 | `packages/db/src/data-context.ts:75`                                                                           |
| `withDataContext` already opens one transaction and sets the acting user in it | `packages/db/src/data-context.ts:63-65` (do **not** nest a transaction)                                        |
| `app.current_actor_user_id()` exists for row-security policies                 | `infra/postgres/migrations/0002_app_rls.sql`                                                                   |
| Roles `jarvis_app_runtime` / `jarvis_worker_runtime` exist                     | `infra/postgres/migrations/0001_app_schema.sql`                                                                |
| Manifest carries `database`, `permissions`, `routes`, `dataLifecycle`          | `packages/module-sdk/src/index.ts:632,643,646,655`                                                             |
| Every registered route must be claimed by a manifest or startup fails          | `packages/module-registry/src/route-guard.ts:223`                                                              |
| Registry rejects owned tables with no `dataLifecycle`, allowlist only shrinks  | `packages/module-registry/src/index.ts:2260-2281`                                                              |
| Cascade-to-users test walks declared tables automatically                      | `tests/integration/module-data-lifecycle-cascade.test.ts`                                                      |
| `packages/db/src/types.ts` is exempt from the file-size gate                   | `scripts/check-file-size.ts:27`                                                                                |
| Fixed test user ids for the two-owner case                                     | `tests/integration/test-database.ts:34-36` (`ids.userA`, `ids.userB`)                                          |
| Workflow definition contracts and registry from #2012 are on `main`            | commit `a7a8c8c0e`; `packages/module-sdk/src/workflow.ts`, `packages/module-registry/src/workflow-registry.ts` |

Open questions: none. No capability in this plan is uncited.

### Drift found against the issue plan (verified, not assumed)

- **Migration number.** The issue plan says `0192`. The highest number in the tree today is `0200`
  (`0200_news_source_credentials.sql`). This build uses **`0202_workflow_runs.sql`** and re-checks
  the number immediately before opening the PR.
- **Approval status values.** The issue plan says "waiting"; the approved spec's Data Model says
  `pending|approved|denied|cancelled`. The spec wins — the column value is `pending`.
- **Module id.** Spec says `workflows`. Neighbouring built-ins use both bare (`people`, `workshop`)
  and prefixed (`jarvis.commitments`) ids, so the bare `workflows` is consistent and is what the
  spec's Module Registration section names.

## Determinism boundary

No user-facing surface and no model in the loop in this slice. Every value in an API response is
read from a database row; nothing is generated. No prompt, no guidance text, no chat turn.

## Task 1 — package skeleton and workspace wiring

Files:

- `packages/workflows/package.json` — name `@moss/workflows`, private, `"type": "module"`,
  exports `.` → `./src/index.ts` and `./routes` → `./src/routes.ts`, script
  `"typecheck": "tsc --noEmit"`. Dependencies: `@moss/db`, `@moss/module-sdk`, `fastify`,
  `kysely`, `@sinclair/typebox` (workspace/version pins copied from
  `packages/commitments/package.json`). **No** `@moss/jobs`, **no** `pg-boss` — there is no queue
  work in this slice, and depending on them would invite one.
- Root `tsconfig.json` — add `"@moss/workflows"` and `"@moss/workflows/routes"` to the path
  mapping block beside the other `@moss/*` entries. No per-package tsconfig (no sibling has one).
- `pnpm install` afterwards so the workspace link exists.

Verify: `pnpm install > /tmp/w-install.log 2>&1; echo "EXIT=$?"` → `EXIT=0`.

## Task 2 — migration `packages/workflows/sql/0202_workflow_runs.sql`

DDL decisions (the decisions, not the whole file):

- Status columns are `TEXT NOT NULL` with `CHECK (col IN (...))`, **not** Postgres enums. Reason
  recorded in a comment at the top of the file: barrier joins and new states are expected in
  #2014/#2015, and a check constraint changes with a plain `ALTER`, while an enum needs a type
  migration. `packages/commitments` uses enums and `packages/wellness` uses checks; both patterns
  are live, this file picks checks deliberately.
- Bounded metadata is a database constraint, not a convention:
  `CHECK (octet_length(input_json::text) <= 8192)` and the same on `result_json`, on both
  `workflow_runs` and `workflow_step_runs`; `CHECK (char_length(error_code) <= 200)`.
- `CONSTRAINT uq_workflow_step_run UNIQUE (workflow_run_id, step_id)` — load-bearing for #2014's
  duplicate-job handling, so it lands in this migration.
- Indexes: `(owner_user_id, started_at DESC)` on runs; `(workflow_run_id)` on step runs, approvals
  and artifacts.
- Every `owner_user_id` is `uuid NOT NULL REFERENCES app.users(id) ON DELETE CASCADE`; every child
  table cascades from its parent run.

Columns exactly as the spec's Data Model section lists:

`app.workflow_runs` — `id`, `owner_user_id`, `workflow_id text`, `workflow_version integer`,
`module_id text`, `status text` in `pending|running|suspended|succeeded|failed|cancelled`,
`started_by text` in `user|module|system`, `input_json jsonb not null default '{}'::jsonb`,
`result_json jsonb not null default '{}'::jsonb`, `started_at timestamptz not null default now()`,
`completed_at timestamptz null`, `created_at`, `updated_at`.

`app.workflow_step_runs` — `id`, `workflow_run_id`, `owner_user_id`, `step_id text`, `status text`
in `pending|queued|running|suspended|succeeded|failed|cancelled`, `attempt_count integer not null
default 0`, `input_json`, `result_json`, `error_code text null`, `pgboss_job_id text null`,
`started_at timestamptz null`, `suspended_at timestamptz null`, `completed_at timestamptz null`,
`created_at`, `updated_at`, plus the unique constraint above.

`app.workflow_approvals` — `id`, `workflow_run_id`, `step_run_id`, `owner_user_id`, `status text`
in `pending|approved|denied|cancelled`, `summary text`, `details_json jsonb not null default
'{}'::jsonb`, `resolved_by_user_id uuid null references app.users(id) on delete set null`,
`created_at`, `updated_at`.

`app.workflow_artifacts` — `id`, `workflow_run_id`, `step_run_id uuid null`, `owner_user_id`,
`artifact_ref text`, `sha256 text`, `content_type text`, `size_bytes bigint`, `created_at`,
`updated_at`.

Row security on all four, following `packages/commitments/sql/0125_commitment_candidates.sql`:
`FORCE ROW LEVEL SECURITY` + `ENABLE ROW LEVEL SECURITY`; an app-role policy matching
`owner_user_id = app.current_actor_user_id()` for USING and WITH CHECK; a worker-role policy
following the same file's precedent. Grants: `INSERT, SELECT, UPDATE, DELETE` to
`jarvis_app_runtime`; `INSERT, SELECT, UPDATE` (no DELETE) to `jarvis_worker_runtime`. The worker
grants land now because #2014 needs them and a second migration purely for grants is avoidable
churn.

Never edit this file after it has been applied anywhere — the runner hash-checks applied files.

## Task 3 — Kysely types

`packages/db/src/types.ts`: four interfaces (`WorkflowRunsTable`, `WorkflowStepRunsTable`,
`WorkflowApprovalsTable`, `WorkflowArtifactsTable`) modelled on `CommitmentCandidatesTable`
(`packages/db/src/types.ts:923`) — `id` is `ColumnType<string, string | undefined, never>`, status
columns get a union alias, nullable columns get the three-argument `ColumnType`, jsonb columns use
the existing `JsonColumn` alias (`packages/db/src/types.ts:9`). Four entries added to the
`MossDatabase` registry (`packages/db/src/types.ts:1249`).

## Task 4 — `packages/workflows/src/types.ts`

Exports: the status union types, the run/step/approval/artifact row shapes, the create/transition
input shapes, and `MAX_WORKFLOW_JSON_BYTES = 8192`. The constant is exported so the repository can
reject an oversized value with a clear message naming the field, before the database raises a raw
constraint violation.

## Task 5 — `packages/workflows/src/repository.ts`

`export class WorkflowsRepository`. Every method takes the scoped handle first and opens with
`assertDataContextDb(scopedDb)`. Never a raw connection. Never a nested transaction —
`withDataContext` is already one. `FOR UPDATE` row locks where the spec asks.

Signatures (bodies written against the compiler, not here):

- `createRun(scopedDb, input: CreateRunInput): Promise<{ run: WorkflowRun; firstStepRun: WorkflowStepRun }>`
  — inserts the run (`pending`) and its first step run (`pending`) in one call. Enqueues nothing.
- `getRun(scopedDb, ownerUserId, runId): Promise<WorkflowRun | null>`
- `listRuns(scopedDb, ownerUserId, options?: { status?: WorkflowRunStatus; limit?: number }): Promise<WorkflowRun[]>`
  — limit capped at 100.
- `getRunDetail(scopedDb, ownerUserId, runId): Promise<WorkflowRunDetail | null>` — run plus step
  runs, approvals and artifact metadata.
- `createStepRun(scopedDb, input): Promise<{ stepRun: WorkflowStepRun; created: boolean }>` —
  `ON CONFLICT (workflow_run_id, step_id) DO NOTHING`, then returns the **existing** row with
  `created: false`. #2014 depends on the existing row coming back, not null.
- `markStepRunning`, `recordStepSuccess`, `recordStepFailure`, `suspendStepRun` — each refuses a
  move out of a terminal state (`succeeded`, `failed`, `cancelled`). Every move into terminal,
  suspended or cancelled clears `pgboss_job_id`, so a crashed worker cannot mistake a stale job
  for a live one.
- `setStepQueueJobId(scopedDb, stepRunId, jobId)` / `clearStepQueueJobId(scopedDb, stepRunId)`
- `incrementStepAttempt(scopedDb, stepRunId)` — bumps the counter and stamps the start time in one
  write.
- `completeRun(scopedDb, ownerUserId, runId, status, resultJson)` — terminal status, bounded
  result, completion time.
- `cancelRun(scopedDb, ownerUserId, runId): Promise<{ cancelled: boolean }>` — takes the row lock,
  then cancels the run, every non-terminal step run, and every pending approval. Cancelling an
  already-terminal run reports `cancelled: false` rather than throwing.
- `createApproval(scopedDb, input): Promise<WorkflowApproval>` — creates the `pending` approval and
  suspends its step run.
- `resolveApproval(scopedDb, actorUserId, approvalId, decision): Promise<ResolveApprovalResult>` —
  compare-and-set from `pending` only; records who resolved it; writes the bounded result
  `{ status: "approved" }` or `{ status: "denied" }` onto the step run and moves it from
  `suspended` to `queued` with the queue job id cleared. Returns a "not still waiting" outcome when
  no approval row changed, so the route can answer 409. Enqueues nothing — #2015 owns the resume.
- `recordArtifact(scopedDb, input)` / `listArtifacts(scopedDb, ownerUserId, runId)` — reference
  metadata only: vault reference, hash, content type, size. Never bytes.

Guard rails: `owner_user_id` always comes from the acting user, never from request input; nothing
in this package touches the file system; oversized input or result is rejected with an error naming
the field.

## Task 6 — `packages/workflows/src/routes.ts` and shared contracts

`export function registerWorkflowsRoutes(app: FastifyInstance, deps: WorkflowsRouteDependencies): void`,
with `deps` = `{ resolveAccessContext, dataContext, repository? }` — same shape as
`packages/commitments/src/routes.ts:12-18` minus `boss`.

- `GET /api/workflows/runs` — optional `status` query filter.
- `GET /api/workflows/runs/:id` — run with steps, approvals and artifact metadata. **404** when the
  row is not visible to the acting user; "not yours" and "does not exist" are indistinguishable.
- `POST /api/workflows/runs/:id/cancel`
- `POST /api/workflows/approvals/:id/resolve` — body `{ decision: "approve" | "deny" }`; **409**
  when the approval is no longer pending.

Redaction lives in one function, the way `safeCandidate` does at
`packages/commitments/src/routes.ts:213`. Responses never carry: the raw `artifact_ref`, artifact
bytes, or anything from `input_json.__origin` beyond bounded origin metadata. An artifact entry is
`{ id, sha256, contentType, sizeBytes }`.

No endpoint creates a workflow definition and none starts a run — starting is module/server code
per the spec.

Request/response types go in a new `packages/shared/src/workflows-api.ts`, re-exported from
`packages/shared/src/index.ts` beside the other `*-api.js` lines.

## Task 7 — `packages/workflows/src/manifest.ts`, `src/index.ts`, registry entry

`manifest.ts` exports `WORKFLOWS_MODULE_ID = "workflows"`,
`workflowsModuleSqlMigrationDirectory = fileURLToPath(new URL("../sql", import.meta.url))`, and
`workflowsModuleManifest`.

Manifest fields that boot depends on:

```
lifecycle: "required"
availability: { defaultEnabled: true, required: true }   // compat gate rejects a
                                                         // built-in not enabled by default
compatibility: { jarv1s: ">=0.0.0" }                     // field is still spelled jarv1s
database: {
  migrations: ["0202_workflow_runs.sql"],
  ownedTables: ["app.workflow_runs", "app.workflow_step_runs",
                "app.workflow_approvals", "app.workflow_artifacts"]
}
permissions: [ workflows.view, workflows.manage ]        // scope "user"
routes: [ GET /api/workflows/runs                       -> workflows.view,
          GET /api/workflows/runs/:id                   -> workflows.view,
          POST /api/workflows/runs/:id/cancel           -> workflows.manage,
          POST /api/workflows/approvals/:id/resolve     -> workflows.manage ]
dataLifecycle: {
  exportSections: [],                                    // comment: run state is machine
                                                         // bookkeeping, not user content
  deletion: { strategy: "cascade", tables: [all four] }
}
```

An endpoint missing from `routes` stops the server booting
(`packages/module-registry/src/route-guard.ts:223`) — and no test would ever see it, because the
failure happens before any route is reachable. An omitted `dataLifecycle` is rejected outright
(`packages/module-registry/src/index.ts:2260`); this module is not going on the shrinking allowlist.

Registry: add to `BUILT_IN_MODULES` in `packages/module-registry/src/index.ts` next to the
commitments entry (`:2052`), with `sqlMigrationDirectories: [workflowsModuleSqlMigrationDirectory]`,
`queueDefinitions: []`, a `registerRoutes` calling `registerWorkflowsRoutes`, and **no**
`registerWorkers`. Add `@moss/workflows` to `packages/module-registry/package.json` dependencies.

## Task 8 — update the pinned lists (read each before changing it)

- `tests/integration/foundation-schema-catalog.test.ts` — append `0202_workflow_runs.sql`.
- The module-id lists in `tests/integration/{ai,auth-settings,connectors,briefings,calendar-email,tasks,notifications}.test.ts`
  — each currently ends `"jarvis.commitments", "people", "workshop"` (e.g. `ai.test.ts:175-198`).
  Insert `"workflows"` at the position matching where the registration went, in all seven.
- `tests/unit/module-registry-lifecycle-allowlist.test.ts` — pins the skip list exactly. Nothing is
  added to it; if it goes red, the `dataLifecycle` block is missing.

## Task 9 — new tests

`tests/integration/workflows-persistence.test.ts`, modelled on `tests/integration/commitments.test.ts:1-29`
(reset the foundation database, open the app connection, everything through `withDataContext`,
fixed ids from `tests/integration/test-database.ts`). Each case, and what a broken implementation
would do:

1. Creating a run also creates its first step run, both owned by the caller — a wrong owner column
   would fail here and silently leak later.
2. Inserting the same run-and-step twice returns the first row and creates nothing new — without the
   unique constraint, #2014 would execute a step twice.
3. A step cannot move out of `succeeded`, `failed` or `cancelled` (test each direction) — a missing
   guard would let a late worker resurrect a cancelled run.
4. Reaching terminal, suspended or cancelled clears the stored queue job id — otherwise a crashed
   worker mistakes a stale job for a live one.
5. Cancelling a run cancels its unfinished steps and pending approvals; cancelling twice is
   harmless — a throw on the second call would make cancel non-idempotent for the UI.
6. Creating an approval suspends the step; resolving once succeeds and reports the step moved to
   `queued` with no queue job id; resolving again reports "not still waiting" — without the
   compare-and-set, a double-click approves twice.
7. A result over 8192 bytes is rejected with an error naming the field — otherwise the caller sees
   a raw constraint violation.
8. Artifact rows store the reference and hash and never bytes.

`tests/integration/workflows-rls.test.ts` — the two-owner case, the security bar for this slice:
user A creates a run with steps, an approval and an artifact row; user B, acting as themselves,
sees no runs in the list, gets nothing from the direct read, cannot cancel A's run, and cannot
resolve A's approval. **Assert against all four tables, not just runs** — forcing row security on
every table exists so a child table cannot become the leak.

No faked database anywhere: a unit test against a fake proves nothing about row-security rules.

## Verification (no pipes; expected exit code beside each)

Run from the repo root, each written so the exit code survives:

```bash
pnpm check:file-size > /tmp/w-size.log 2>&1;   echo "EXIT=$?"   # EXIT=0
pnpm typecheck      > /tmp/w-tsc.log 2>&1;     echo "EXIT=$?"   # EXIT=0
pnpm lint           > /tmp/w-lint.log 2>&1;    echo "EXIT=$?"   # EXIT=0
pnpm format:check   > /tmp/w-fmt.log 2>&1;     echo "EXIT=$?"   # EXIT=0
pnpm test:unit      > /tmp/w-unit.log 2>&1;    echo "EXIT=$?"   # EXIT=0
```

Anything that touches the database — the two new integration tests and the full gate — runs **only**
through the `verify-gate` skill. An unscoped run points at the live development database, and a
piped run reports a failing gate as green.

Known traps, neither of them this branch's: `tests/unit/module-sdk-worker.test.ts` fails on this
machine and passes in CI (do not bisect over it); several sessions share this checkout, so use the
`shared-checkout` skill before any commit and never stage the whole tree.

## Live proof for a slice with no screen

Nothing here is visible to a user, so there is no UI to exercise and the release note is
`Category: N/A`. The honest equivalent proof, posted on the PR: the API server boots with the new
module registered (which is itself the route-coverage and lifecycle assertion passing), the
migration applies, and the four endpoints answer correctly for their owner — including a second
user getting nothing back. If the server cannot be brought up, the status reported is
**code-complete, unverified**, never "done".

## Kill gate

If the two-owner isolation test cannot be made to pass against all four tables — that is, if a
child table leaks across owners under forced row security — stop and escalate rather than relaxing
the assertion. That is the one result that invalidates the design of this slice rather than the
code, and it is Ben's call, routed through the lane's blocked record.

## Done looks like

- Four workflow tables exist, owner-only, row security forced on every one.
- A typed repository is the only way this code reaches them, always as a specific acting user, and
  it refuses illegal state moves and oversized results.
- An owner can list runs, open one, cancel one and answer an approval over HTTP; a second user can
  do none of those things to the first user's data, proved by a test.
- An approval is recorded once and only once; a second answer gets a conflict.
- No queue, worker, pg-boss payload, vault byte or screen was added, and the gate is green.
