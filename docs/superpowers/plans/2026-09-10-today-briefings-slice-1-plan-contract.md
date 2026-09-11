# Slice 1: Durable plan contract and repository

**Goal:** Give evening intent, task-block proposals, and their calendar relationships one durable,
owner-scoped authority. No calendar writes or new screen in this slice.

**Dependency:** Review the master plan's production reconciliations; link a build task, choose the
feature worktree/revision, and reconcile module dependencies and protected migration procedure.
Read the [shared plan](2026-09-10-today-briefings.md) and [scheduling exploration](../../research/2026-09-10-today-briefings-scheduling-exploration.md).

## Files

Existing: `packages/calendar/src/index.ts`, `manifest.ts`, `routes.ts`,
`packages/shared/src/index.ts`, existing module migration registration and `DataContextDb` patterns.
Proposed new: `packages/shared/src/day-plan-api.ts`,
`packages/calendar/src/day-plan-repository.ts`, `day-plan-routes.ts`, `day-plan-model.ts`, and a new
numbered migration under `packages/calendar/sql/` (allocate its actual number at implementation).
Tests: new `tests/unit/day-plan-model.test.ts` and `tests/integration/day-plans.test.ts`.

## Task 1: Define the minimal aggregate

- [ ] Define `DayPlanDto`: id, owner-derived scope, target local date/IANA timezone, revision,
      originating run references, saved evening intent, blocks, source freshness, and apply status.
      Do not expose actor IDs in request bodies as authorization inputs.
- [ ] Typed intent contains selected priority task IDs, capacity choice, optional notes, correction
      records/provenance, and open-commitment decisions. Unavailable evening runs permit a null source
      reference. Notes are untrusted data, not executable model instructions.
- [ ] Each block has a stable ID, existing task ID, requested start/duration, actual placement,
      optional provider/calendar identity, and a pending change. Keep actual scheduled placement
      distinct from a proposed move/removal; the old event remains real until application succeeds.
- [ ] Use separate operation outcomes (`pending`, `applied`, `failed`, and a recoverable unknown
      result if a provider acknowledgement was lost) rather than proliferating combined placement states.
- [ ] Commit to leaving task status/deadline/`do_at` unchanged when editing a block. Link canonical
      tasks; never clone a task's full record into plan rows. Multiple blocks for one task need distinct
      stable block IDs; do not accidentally make task ID the event idempotency key.
- [ ] Resolve effective timezone and defaults server-side. Existing plans retain their identity when
      locale changes; the next preview reconciles dates/availability rather than rewriting instants.

## Task 2: Persist and authorize

- [ ] Add plan, block, and operation storage in the owning Calendar migration with owner-only RLS,
      runtime-safe grants, foreign-key/lifecycle rules, timestamps, revision, and appropriate unique
      keys for target-day creation and actor/plan operation idempotency.
- [ ] Require `DataContextDb` for repositories. Share visibility of a task or source calendar is not
      ownership of the user's plan or permission to write another user's provider account.
- [ ] Implement idempotent get/create, read, and version-checked draft save. Duplicate target-day
      creation returns the existing actor-owned aggregate. Concurrent writes reject stale revisions.
- [ ] Store composer-independent typed draft decisions and notes without applying calendar effects.
      A saved draft is not an accepted proposal. Preserve old scheduled state and pending changes.
- [ ] Handle missing/archived/deleted tasks and revoked calendar access explicitly; never infer
      success or cascade a block removal into task deletion. Keep provenance for archived run reads.
- [ ] Export a narrow public Calendar plan service/repository contract. Briefings will consume an
      injected port; it must not import Calendar SQL or query its tables directly.

## Task 3: Read/draft API and declarations

Proposed routes (validate consistency with existing module route conventions before registering):

| Route                                        | Contract                                                                                      |
| -------------------------------------------- | --------------------------------------------------------------------------------------------- |
| `GET /api/calendar/day-plan?date=YYYY-MM-DD` | Actor's plan/read projection for that date; no implicit provider write.                       |
| `POST /api/calendar/day-plans`               | Idempotent creation for an actor-resolved date/timezone and optional source run.              |
| `PATCH /api/calendar/day-plans/:id/draft`    | Expected revision plus typed intent/block changes; returns revised draft and committed state. |

- [ ] Validate dates, instants, durations, enum choices, task IDs, note lengths, and source-run
      ownership at the boundary. Resolve titles and permissions from canonical records.
- [ ] Document response handling for not found, invalid choice, stale revision, unavailable source,
      missing calendar grant and missing task. Error payloads contain useful public context, not provider
      credentials or raw account data.
- [ ] Register route permissions and Calendar manifest planning features/errors/remediations. Do not
      advertise batch application until slice 2 wires it; keep any existing coming-soon declaration
      truthful during intermediate commits.

## Verification and stop

- [ ] Unit checks: plan differences; committed versus pending move/remove; no-op change; date/zone
      validation; source-reference filtering; task/deadline preservation semantics.
- [ ] Protected integration checks: two-actor isolation including shared tasks/calendars; duplicate
      create; optimistic revision race; save/reload; missing run; note round-trip; task deletion; stable
      block identities; no provider call on read/draft save.
- [ ] Run scoped ESLint, formatting and root/test-aware type checks. Record commands/exit codes;
      integration commands run only through the protected isolated verification workflow.

Stop with a durable typed draft/read API and passing named checks. No batch writer, new provider,
chat transport, or UI scaffolding is included in this slice.
