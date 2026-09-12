# Task 2C: Save a day-plan draft

**Revision:** R2.2-T02C-R2. Approved task record; the bounded implementation is reviewed, acceptance-
proven and merged. This record is closed and authorizes no further implementation.

**Parent:** [#2453](https://github.com/motioneso/moss/issues/2453),
[approved R2.2 plan](2026-09-10-today-briefings.md), T02 / slice 1 task 3.
This record was finalized against merged `main` at
`8e85462e30b72e9a553c8b75f55dc1449f7fe278`, after the T02C product head
`eb735299c4b9e52a70306235c18d36887a73728e` was reviewed, proven and squash-merged.

## Authority and subdivision

T02C exposes revision-checked saving of an existing plan's typed evening intent and draft blocks.
The approved R2.2 scope is complete: it covers only the write portion of the approved T02 route set.
Current canonical task/source read enrichment remains later T02 work under a separate record.
Preview, application, provider writes, workers and every UI remain later tasks.

The merged repository already owns validation, actor scoping, task ownership, optimistic revision
checks, block replacement and transactional rollback. R2.2 reused that validation and closed the
remaining actor-owned task-reference gap in `packages/calendar/src/day-plan-repository.ts`. The
authenticated HTTP contract, route declaration and focused API proof are complete. The route calls
that repository once inside the existing actor-scoped data context; it adds no save service or
duplicate storage logic. `packages/calendar/src/day-plan-model.ts` was explicitly excluded and is
unchanged.

## Dispatch record

| Field                       | Record                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| --------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Task / revision             | #2453 / R2.2-T02C-R2: authenticated, revision-checked draft intent and block save only; completed and merged.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| Implementation owner        | Builder. PM owns dispatch and GitHub result collection. Only Builder touches the product worktree.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| Product worktree            | `~/Jarv1s/.claude/worktrees/2453-t02c-draft-api`, created clean for this task only after dispatch.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| Product branch              | `feat/2453-t02c-draft-api`, created from the exact base below.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| Exact build base            | `ef5d8eaa7598baa3a851fa854e0e9de8db4960a0`, the merged T02B result on `main`; final product head `eb735299c4b9e52a70306235c18d36887a73728e`, squash-merged to `main` at `8e85462e30b72e9a553c8b75f55dc1449f7fe278`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| Bounded result              | One authenticated `PATCH /api/calendar/day-plans/:id/draft` contract that saves typed intent and/or draft blocks through the existing repository, returns the revised stored snapshot, and declares the route and truthful saved-draft behavior.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| Bounded files               | `packages/shared/src/day-plan-api.ts`; `packages/calendar/src/day-plan-routes.ts`; `packages/calendar/src/day-plan-repository.ts` for actor-owned task-reference validation; `packages/calendar/src/manifest.ts`; new `tests/unit/day-plan-draft-routes.test.ts`; new `tests/integration/day-plan-draft-api.test.ts`; dependency-stub-only updates in `tests/unit/day-plan-routes.test.ts`, `tests/unit/day-plan-create-routes.test.ts`, and `tests/unit/calendar-briefing-settings-routes.test.ts`; only the `test:today-briefings` selection in `package.json`. `packages/calendar/src/day-plan-model.ts` was excluded and unchanged. No composition-root change was needed because its existing repository instance already exposes `saveDraft`. |
| Targeted local checks       | Product checks completed: focused draft-route/app-map tests (31/31), manifest Prettier check and `git diff --check`. Builder did not run the full gate or database acceptance locally.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| GitHub-only checks          | Required `CI gate` on the settled pushed head, with every named prerequisite outcome recorded below.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| Review owner                | Reviewer, independent of Builder. Review covers only this task's final diff, request trust boundary, revision behavior, stored-state semantics, declarations and assertions.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| Acceptance owner / boundary | Prover: authenticated production API registration with real actor-scoped PostgreSQL in the protected disposable target. No UI or provider proof applies. Acceptance is green.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| Supplemental checks         | Builder-B and Builder-C may begin their separate clean-worktree, read-only assignments only after the first pushed product head exists. They are advisory and are not prerequisites for Reviewer or Prover dispatch.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| Evidence / commit           | PR #2471 evidence was tied to the exact base, pushed head and proof SHA; one final T02C product commit was squash-merged; the product tree was clean at every handoff.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| Exclusions                  | No read enrichment, source refresh, preview, apply, operation reservation/status/retry, provider access, calendar-event mutation, worker, UI, chat, migration, dependency, runner or unrelated cleanup.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| Stop / next owner           | Task closed after review, Prover acceptance, settled CI and squash merge. Architect reconciles this docs record; no next product task is authorized from it.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |

PM revalidated this revision, exact base, worktree, owner and protected runner before dispatch. The
record is now closed; any future work requires a new approved task record.

## HTTP contract and technical decisions

1. Register `PATCH /api/calendar/day-plans/:id/draft`. The path `id` is a UUID. The body is
   `{ date, timeZone, expectedRevision, eveningIntent?, blocks? }`. `date`, `timeZone` and a positive
   integer `expectedRevision` are required. Require at least one of `eveningIntent` or `blocks` so an
   empty request cannot advance the revision without changing the draft.
2. `date` and `timeZone` identify the already-read plan and map to the repository's `localDay` and
   `timeZone`. Both are explicit on update: do not re-resolve the actor's current locale because a
   saved plan keeps its original day/zone identity after locale changes. A mismatched id/day/zone and
   another actor's id return the same public `404`.
3. Resolve authentication first. Actor identity comes only from the request access context. Call
   `DayPlanRepository.saveDraft` once inside the existing `withDataContext` callback. Do not accept
   actor, owner, source-run, operation, task facts, provider account or calendar-event identity at the
   request root.
4. Return `200` with `{ plan: DayPlanDto }` containing the new revision and stored snapshot. Invalid
   path/body/date/zone/instant/duration/enum/task syntax returns the normal public `400`; missing or
   expired authentication returns `401`; unavailable plan, block or actor-owned task returns `404`;
   a stale expected revision returns `409`. Use the existing shared error handler and messages; do
   not expose row existence, SQL, provider details or another actor's data.
5. `eveningIntent` is a patch. Omission retains intent; `null` resets it to the existing empty typed
   intent; omitted fields retain their stored values; nullable fields clear with `null`; lists clear
   with `[]`. Accept only the existing priority-task IDs, capacity, notes, correction and commitment
   fields and vocabularies. Every supplied task reference must remain actor-owned. Do not enrich or
   rewrite labels from current Tasks or Briefings reads.
6. `blocks` is a complete draft-block replacement when present. Omission retains every block; `[]`
   clears only unplaced draft blocks. Array order is the stored order. Accept the existing writable
   fields: optional stable block id, kind, actor-owned nullable task id, nullable title and nullable
   pending add/move/remove. Reject request-supplied `actualPlacement`, position, provider/calendar
   identity and unknown block fields rather than silently ignoring them.
7. A supplied existing block id updates that block only. An omitted id creates a server-generated
   stable id. A missing or foreign block id returns `404`. Omitting a block with recorded placement
   rejects the whole save with `400`; retain it with a pending removal until later application work
   succeeds. Draft add/move/remove changes never alter recorded placement.
8. Reuse the repository's compare-and-swap behavior. One of two concurrent requests using the same
   revision may succeed; the other returns `409`, and a rejected or stale save changes neither intent,
   blocks nor revision. No idempotency key is added: clients recover from an uncertain response by
   reading the current revision before deciding whether to resubmit.
9. Declare the PATCH route with `calendar.manage`. Add a saved-draft feature entry explaining that
   saves change only the local plan proposal and may fail when the plan changed, a referenced task is
   unavailable, or a placed block is removed without a pending removal. Keep planning and writeback
   marked `coming-soon`; a saved draft is not previewed, approved, scheduled or on a calendar.
10. Extend the existing route file and shared contract directly. Do not add a controller, service,
    schema library, migration or new dependency. Current task/source read enrichment remains absent
    by design and requires its own later record before this API is consumer-ready.

These decisions resolve the implementation boundary without a new product choice. If merged source
contradicts the named repository behavior or requires any file outside the bounded list, Builder
stops and returns the record to PM rather than widening the slice.

## Targeted local checks

The completed product checks were:

```bash
pnpm exec vitest run tests/unit/day-plan-draft-routes.test.ts tests/unit/app-map-contract.test.ts  # 31 tests, PASS
pnpm exec prettier --check packages/calendar/src/manifest.ts  # PASS
git diff --check
```

Unit assertions cover authentication/context forwarding; explicit day/zone and path-id forwarding;
successful intent-only, blocks-only and combined responses; omitted versus empty/reset semantics;
strict unknown/read-only fields; malformed values; missing plan/block/task; stale revision; unchanged
state on rejection; route permission/schema declarations; and unchanged GET/POST registration.
The actor-context-forwarding assertion and request-boundary coverage are retained in the product
tests. No test-only bypass, harness or dependency was committed.

No separate local root typecheck, integration run, migration, application-map build, full gate or
foundation gate is prescribed. GitHub owns full static/regression coverage; Prover owns the protected
database/API boundary below.

## Supplemental read-only assignments

After Builder pushes a clean head, PM may dispatch both without waiting for either result:

- **Builder-B:** create clean detached worktree
  `~/Jarv1s/.claude/worktrees/2453-t02c-supplement-b` at the exact pushed SHA; run
  `pnpm exec vitest run tests/unit/day-plan-draft-routes.test.ts` and `git diff --check`; inspect only
  the request-schema negatives, actor-context forwarding and revision-conflict assertions. Make no
  edits or commits; report SHA, commands, exits, finding or no finding, and tree state to PM.
- **Builder-C:** create clean detached worktree
  `~/Jarv1s/.claude/worktrees/2453-t02c-supplement-c` at the same SHA; run
  `pnpm exec vitest run tests/unit/day-plan-routes.test.ts tests/unit/day-plan-create-routes.test.ts tests/unit/calendar-briefing-settings-routes.test.ts`
  and `git diff --check`; inspect only prior GET/POST registration and dependency-stub regressions.
  Make no edits or commits; report the same evidence to PM.

Their completion cannot delay Reviewer or Prover. A concrete finding is advisory until PM routes it
to Builder under the existing fix cycle; neither supplemental owner changes code or claims acceptance.

## Narrow real-API acceptance

Create exactly one named case in `tests/integration/day-plan-draft-api.test.ts`:
`live acceptance: authenticated revision-checked day-plan draft save`. Replace only the package
script selection with:

```json
"test:today-briefings": "pnpm db:migrate && pnpm build:app-map && tsx scripts/test-integration.ts tests/integration/day-plan-draft-api.test.ts -t \"live acceptance: authenticated revision-checked day-plan draft save\""
```

After review closure, Builder fixes and PM confirmation, Prover follows
`.claude/skills/verify-gate/SKILL.md`, verifies that the named selection is nonempty and the generated
database is disposable, then runs:

```bash
scripts/run-gate.sh start --gate test:today-briefings --exclusive
scripts/run-gate.sh wait --follow
```

The case boots the actual API with production Calendar registration, fixture authentication and real
runtime-role actor contexts in generated PostgreSQL. Existing POST/GET routes may create and observe
the fixture plan; direct repository/SQL setup may seed recorded placement and inspect before/after
rows, but cannot replace the PATCH request.

Required assertions in that one case:

- Actor A saves an intent-only patch, then a block replacement, and reads the exact new revisions and
  stored values through the API. Omitted intent/blocks are retained; `null` intent and `[]` blocks
  perform their documented reset/clear behavior.
- Stable supplied block ids remain stable; missing ids receive server-generated ids. Pending add/move
  changes round-trip. A recorded placement survives a pending move/removal; omitting that placed block
  returns `400` and rolls back the complete save.
- Missing/expired authentication returns `401`. Actor B receives the same `404` for Actor A's plan as
  for an unavailable plan, including when a task is shared. Missing/foreign task and block references
  return `404`.
- Invalid path id, impossible date, invalid zone, nonpositive/fractional revision, malformed pending
  instant/duration/kind, empty request, `actualPlacement`, position and extra actor/owner/source/
  provider fields return `400` without changing the saved revision or rows.
- Two concurrent requests with one expected revision settle as one `200` and one `409`; a later stale
  request also returns `409`. A fresh API/context read shows only the winner's complete state, never a
  mixed intent/block transaction.
- Before/after observations show only expected actor-owned plan/block/revision changes. Task status,
  task dates, briefing runs, operation rows, cached calendar events and provider state remain
  unchanged. The route has no provider-writing dependency; do not claim absence outside this boundary.

Record installed API SHA, fixture actor/plan/task references, generated database, successful app-map
build, exact log path, terminal exit, cleanup, assertions observed and anything unrun. UI, worker and
real-provider proof are not applicable. Prior read/create evidence is setup context, not T02C proof.

## Closure evidence

- Reviewed and accepted product head: `eb735299c4b9e52a70306235c18d36887a73728e`.
- Product PR #2471 squash-merged to `main` at `8e85462e30b72e9a553c8b75f55dc1449f7fe278`.
- Protected acceptance log: `/tmp/jarv1s-gate/2453_t02c_draft_api-20260912-095328.log`; the named
  acceptance ran one test and exited `rc=0`. The disposable database was dropped after proof.
- Authenticated saves, actor isolation, rollback, placed-block behavior, concurrent and stale `409`
  conflicts, and missing/expired-auth `401` responses were proven.
- Product PR run `34705752035` and post-merge main run `34706804196` were green, including `CI gate`.
- Full local gate, separate migration suite, UI/provider proof and supplemental checks were unrun.
- Status: task closed, acceptance-green, post-merge-CI-green. No next product task is authorized.

## GitHub-only checks and one evidence record

The final evidence record names the exact settled pushed SHA and required `CI gate`, plus actual outcomes for:
`Detect change scope`, `Verify docs`, `Verify static checks and unit tests`,
`Verify integration tests (1/2)`, `Verify integration tests (2/2)`,
`Verify web and browser tests`, `Compose deployment smoke`, `Prod compose deployment smoke`, and
image jobs if reported. Legitimate skips are named as skips; missing or unreported is not green.

The single T02C PR-body evidence record contains revision, exact base/head/proof SHA, one-task commit
and file list, clean tree state, Builder commands/exits, supplemental reports if complete, remote
run/job outcomes, Reviewer findings, Prover target/log/exit/cleanup and observed assertions, retained
evidence with its original SHA and reason, deliberately unrun work, unresolved findings and next
owner. After a fix, repeat only affected local/live assertions; GitHub verifies the new head normally.

## Stop condition

The authenticated API revision-checks and saves one actor-owned plan's typed draft intent and blocks;
the named product checks, review, protected API proof and required remote checks are green on the
settled head. The product change is merged. Do not begin read enrichment, preview, application,
provider work, workers, UI or the next task from this record.

No Ben product decision remains open. This record is reconciled against the merged implementation and
final evidence; no further product work is authorized here.
