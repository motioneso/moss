# Slice 2: Conflict-aware application and automatic scheduling

**Goal:** Apply one or all selected task-block changes through existing calendar authority, with
truthful per-item results and safe retry. **Dependency:** Slice 1.

Read the [shared plan](2026-09-10-today-briefings.md), [behavior matrix](2026-09-10-today-briefings-behavior-and-verification.md),
and scheduling report. This slice owns backend behavior; UI consumes it later.

## Files

Reuse: `packages/calendar/src/calendar-write-service.ts`, `focus-time.ts`, `follow-through.ts`,
`routes.ts`, `manifest.ts`; `packages/chat/src/calendar-write-impl.ts`;
`packages/briefings/src/repository.ts`, `compose.ts`, `jobs.ts`;
`packages/ai/src/gateway/policy.ts`; `packages/module-registry/src/index.ts` composition wiring.
Extend slice-1 shared contract/repository/routes. Proposed new:
`packages/calendar/src/day-plan-apply.ts`, `day-plan-preview.ts`;
`tests/unit/day-plan-apply.test.ts`, `tests/integration/day-plan-apply.test.ts`.
Extract focused composition wiring only if necessary to avoid further growing the existing registry.

## Task 1: Preview and conflict authority

- [ ] Add `POST /api/calendar/day-plans/:id/preview` with expected revision and selected changes.
      Resolve current tasks and live-first calendar context through existing granted-account services.
- [ ] Reuse `resolveWindow`/`chooseSlot` time math where its duration/window behavior matches the
      requested task. Task effort and user adjustment determine duration; no invented time estimates.
- [ ] Treat existing calendar commitments as protected. Preparation ends before its meeting;
      follow-up comes after; travel/lunch already represented in the calendar remain busy.
- [ ] Do not invent route-based travel duration: consume explicit existing buffers or user settings.
      A missing required estimate produces a reviewable gap. New travel estimation is a separate feature.
- [ ] Detect overlaps within the proposed batch as well as against external commitments; exclude the
      same plan-owned event when checking its own unchanged/moved reservation.
- [ ] Return a concrete before/after diff, eligible item IDs, named conflicts, current revision and
      source freshness. Missing/stale calendar data cannot be interpreted as free availability.

## Task 2: Apply, retry, and reconciliation

- [ ] Add `POST /api/calendar/day-plans/:id/apply` with expected revision, operation/idempotency key,
      and an explicit reviewed set or “all eligible proposals” intent. Resolve “all” against that version:
      proposed additions only, excluding unscheduled/committed blocks and pending moves/removals.
- [ ] Resolve current actor permissions, `timeBlockMode` and gateway/action policy again. Accept All
      authorizes its displayed addition batch only. Both delete and reschedule use `calendar_management`,
      whose default is `always_confirm`. For a mixed review, obtain one additional explicit confirmation
      of the exact move/removal set and consequences before any batch write when that policy applies.
      Draft save, preview, Accept All and `timeBlockMode=auto` do not satisfy that confirmation.
- [ ] Reuse the gateway/action service to issue and validate an audited approval bound to actor,
      plan revision, operation key, exact event IDs, move instants and removal operations. Extend the
      existing action contract minimally for a batch if necessary; never add a boolean `confirmed`
      bypass. Missing/stale/revoked approval returns confirmation-required with no batch writes.
      Changed contents require renewed approval; an unchanged operation retry retains valid approval
      and acknowledged outcomes, with no per-item confirmation tour.
- [ ] Respect a user's existing explicit promotion of the action family when policy permits;
      scheduling mode alone is not that promotion. Automatic moves/removals stay proposed whenever
      current policy requires confirmation. Preserve hard writer constraints such as refusing attendee
      reschedules regardless of promotion. All UI/chat/worker callers must cross gateway authorization
      before the plan writer; direct writer access never grants permission.
- [ ] Reserve the batch/revision locally and preflight all selected items before the first provider
      write. Avoid holding a DB transaction/advisory lock while waiting on remote services.
- [ ] Call the existing create/move/delete service per eligible plan-owned block. Use stable
      actor/plan/block/operation keys. Existing title/window-derived IDs alone cannot identify successive
      revisions of the same block; add a plan operation reference through the public writer contract.
- [ ] Never move/delete an unrelated user-created event. Reuse and extend Moss provenance checks;
      verify provider identity/metadata before treating a duplicate-ID response as the same operation.
- [ ] Persist acknowledged outcomes and mirror status per item. If the network result is ambiguous,
      reconcile the deterministic provider identity before retrying. Provider success/local failure
      must remain recoverable; do not announce rollback that never happened.
- [ ] Expose operation status and retry through `GET /api/calendar/day-plans/:id/operations/:key`
      and a bounded retry action. Retry only unresolved/failed items; accepted ones remain accepted.
- [ ] Revalidate availability immediately before provider writes. Calendar free/busy is not a remote
      lock: a late external change can yield a partial batch. Return the actual outcome and conflict
      for review; never claim global remote atomicity.

## Task 3: Connect the existing automatic path once

- [ ] Refactor `buildCalendarFollowThroughPort` so time-block effects for this plan go through the
      same plan/apply service. Keep preparation-task creation and `prepTaskMode` independent.
- [ ] Break the existing composition/write transaction coupling explicitly. `generateRun` currently
      invokes `composeBriefing` under `withDataContext`, and `attachCalendarFollowThrough` can write
      a provider through its injected port. The concrete path is `repository.ts:256-268` →
      `compose.ts:549-555` (`executeAutoActions`) → `module-registry/src/index.ts:1168-1169` →
      `chat/src/calendar-write-impl.ts` token refresh/freeBusy/insertEvent/cache mirror. These are
      detached-baseline citations; recheck line positions on the candidate. Replace plan-owned automatic effects during composition
      with typed auto intents; do not invoke apply or a provider from that callback.
- [ ] Sequence worker execution as follows: compose facts/intents → persist the run and reserve its
      plan/pending operations through the public Calendar port → commit → dispatch application by IDs
      → reconcile per-item results in fresh short actor contexts. The run and reservation share the
      current transaction through public ports and commit together; no cross-module SQL is permitted.
      Only after the enclosing transaction resolves may application begin. An immutable run snapshot
      records proposed/pending state truthfully; current apply status is a separate plan projection.
- [ ] Preserve canonical automatic prep-task creation in the generation transaction through the
      injected public Tasks port, with its existing idempotency and independent `prepTaskMode` policy.
      Composition produces typed task/block intents; resolve or create the allowed canonical task first,
      obtain its real ID, and bind that ID to the plan block and pending operation before commit. Tasks,
      run and plan reservation commit atomically in that local transaction via their owning public ports.
      A rejected/failed task creation cannot leave an eligible block with a guessed or temporary task ID.
      This local DB-only phase must not invoke provider effects or a chat tool that embeds remote writes.
- [ ] On rollback, none of those new task/run/reservation rows survive and no provider call starts.
      On successful commit, application reloads the committed task/block/operation under a fresh actor
      context before writing; a now-deleted task makes that operation ineligible. If a future execution
      path cannot share the local transaction, it must durably link existing committed task IDs before
      exposing an operation as eligible, never dispatch first and repair the relation afterward.
- [ ] Make the post-commit apply entry accept actor/request and run/plan/operation identifiers, not
      `generateRun`'s transaction-scoped `DataContextDb`, a captured repository closure, or a transaction
      handle hidden in a provider callback. Read account authorization in a fresh short actor context,
      close it before remote I/O, and reconcile provider/cache outcomes in another fresh context.
      Refactor the existing writer's transaction coupling only as far as needed for this boundary.
- [ ] Use the durable pending operation plus existing worker retry/recovery path to survive a crash
      after commit but before dispatch. A duplicate scheduled-run return must still resume that run's
      unfinished operations, without recomposing or creating another block. Metadata-only job arguments
      identify the work; do not rely on fire-and-forget promises or an in-memory post-commit callback.
- [ ] Honor `off|suggest|auto`: off creates no implicit blocks; suggest persists proposals; auto
      applies only eligible authorized blocks. Policy downgrade/revocation supersedes a stale preview.
- [ ] Preserve legacy idempotency references when associating already-created Moss artifacts.
      Never guess associations from matching titles alone. Ambiguous legacy events stay fixed calendar
      context until an explicit link exists.
- [ ] Ensure worker generation and interactive acceptance cannot race to create duplicate blocks.
      Reuse the operation ledger and current plan version; keep worker payloads metadata-only.
- [ ] Update Calendar planning/writeback metadata and errors/remediations when these paths become
      active; preserve ordinary task-change and calendar-write authority boundaries.

## Verification and stop

- [ ] Unit/service fakes: bulk and partial accept; explicit unscheduling; stale version; no-op repeat;
      denied/revoked policy; whole-batch preflight conflict; per-item late conflict; duplicate provider ID;
      provider success/cache failure; response loss and retry; task/deadline retention.
- [ ] Policy checks: Accept All cannot include delete/move payloads; mixed review requires the
      additional move/removal-set confirmation exactly once under the default policy; direct apply without gateway approval, another
      actor's approval, altered event IDs, changed revision, revoked policy and unconfirmed worker changes
      fail closed when confirmation is required. A valid unchanged retry neither prompts per item nor repeats acknowledged deletes.
- [ ] Protected integration: two actors, overlapping apply requests, worker/user duplicate race,
      interrupted application reconciliation, actual local transaction outcomes, and durable reload.
- [ ] Add a worker/composition boundary check that records transaction open/close and provider-call
      order: composition makes zero calendar-provider writes; run/reservation commit precedes the first
      apply call; its provider phase receives no composition `DataContextDb`. Fail if a provider is
      invoked while a plan write transaction remains open. Cover rollback (no dispatch), crash after
      commit/before dispatch, duplicate-run recovery and provider-success/finalization-failure.
      Include prep-task-created then run-persist failure (task/reservation rollback, zero provider calls),
      successful task/run/plan commit (provider sees committed task ID), duplicate task intent and task
      deletion between commit and apply. Keep the independent `prepTaskMode` cases covered.
- [ ] Re-run `calendar-follow-through-port`, `calendar-signals-modes`, `calendar-confirmation-policy`,
      `source-context-calendar`, `gateway-action-preview` focused unit suites and the protected
      `focus-time` integration suite. Run scoped static checks; record real outcomes.

Stop when batch results are durable and truthful. No provider addition, bulk task-status endpoint,
or general-purpose workflow engine is needed.
