# Workshop D1 — private project persistence

Task: #2303, part of #2023. Design: the approved Workshop projects and supervised-builds spec.
Ben's blanket approval and explicit continuation authorize this bounded implementation.

## Seams and decisions

- `packages/db/src/data-context.ts:35` supplies the branded actor-scoped transaction.
- `packages/workflows/sql/0202_workflow_runs.sql:50` demonstrates runtime-role owner RLS.
- `packages/module-registry/src/index.ts:2354` registers Workshop; add its migration directory.
- `packages/module-sdk/src/index.ts:776` defines user export/cascade lifecycle declarations.
- Existing `packages/shared/src/workshop-api.ts` owns Workshop's public contracts. Extend it.

Own one new table, `app.workshop_projects`, under `packages/workshop/sql/0216_workshop_projects.sql`.
Fields: UUID id/owner/request key, bounded title (160 bytes), initial request and context (16 KiB
each), created/updated timestamps. Owner and request key are unique together. Owner is derived
from the transaction principal, never supplied by the caller. Force owner RLS for app and worker
roles; grant app create/read and worker read only. Account deletion cascades; user export includes
project content through the same scoped public repository.

`WorkshopProjectsRepository.create(scopedDb, input)` returns `{project, created}`. Concurrent
identical requests return one row; reusing a key with changed normalized input conflicts.
`get(scopedDb, id)` returns the owned project or null. `list(scopedDb, options)` uses a bounded
limit and a `(createdAt,id)` cursor so equal timestamps cannot omit rows. Input size and identity
checks exist in the repository and SQL. No execution status or attempt store is introduced.

This slice is the D1 persistence contract. Project routes, admin route authorization and the new
project UI are U1/D5a consumers, not implied by exporting repository methods. No project operation
calls a model, enqueues a job, accepts a revision, runs source, installs or shares a module.
Records determine all returned acknowledgements; the model has no job in this slice.

## Verification and stop condition

Add runtime-role integration coverage for concurrent replay, changed-input conflict, independent
owner keys, cross-owner get/list/write denial, worker read-only access, bounded input, stable list
pagination, export scoping and account cascade. Run through `scripts/run-gate.sh` with
`test:workshop-projects`, expected rc0. Run root/test TypeScript, scoped lint/format and app-map
build, expected rc0. The later API/UI slice must add its real request/browser assertions.

Stop this slice if the owning runtime role cannot enforce project isolation without bypassing
RLS or reading settings-owned tables; the Workshop owner must resolve that seam before consumers.
Prefer one project repository over reusing `module_builds`: a saved project must exist without an
execution record, while the existing settings build repository remains authoritative for attempts.
