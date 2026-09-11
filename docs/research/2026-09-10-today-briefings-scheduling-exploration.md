# Today briefings scheduling and task plumbing

**Research date:** 2026-09-10

**Scope:** Existing production seams for approved Today, morning plan review, and evening planning flows. This is an implementation research note, not a product change.

## Finding

Moss has durable tasks, briefing runs, calendar cache rows, live calendar reads, a conflict-aware single-event writer, and a generic approval drawer. It does not have a durable task-block plan,
task-to-block relation, plan version, bulk apply endpoint, or provider/local transaction boundary.
The approved experience therefore needs a small plan/block authority above the existing services;
the task table cannot be that authority by itself.

The recommendation in the behavior plan to use an optimistic plan version and recheck availability
at apply time is compatible with the current storage. It is required because `app.calendar_events`
is only a cache and Google writes happen outside the database transaction. The behavior plan's
per-item applied/pending/failed reconciliation is also compatible; “all-or-nothing” can only mean
all local plan state or all preflight checks, never rollback of a provider write.

## Recommended owning module

Calendar should own durable day-plan/block tables, routes, RLS, and apply. Its manifest already owns calendar settings, `app.calendar_events`, planning/writeback declarations, and `CalendarWriteService`
(`~/Jarv1s/packages/calendar/src/manifest.ts:65-110,145-167`; `~/Jarv1s/packages/calendar/src/calendar-write-service.ts:60-82`).
Briefings should consume a structural plan-read/apply port through `ComposeDeps`, matching its existing source-context/follow-through ports (`~/Jarv1s/packages/briefings/src/compose-shared.ts:52-84`).
Calendar cannot import Tasks or Connectors under its current package boundary
(`~/Jarv1s/packages/calendar/package.json:13-23`); the composition root can inject opaque adapters,
as it does for follow-through (`~/Jarv1s/packages/module-registry/src/index.ts:1099-1137`). Briefings
should persist only a plan reference/version, not own scheduling mutations (`~/Jarv1s/packages/briefings/package.json:12-25`).

There is no local calendar writer. Definitions advertise Microsoft and Google calendars, but the live reader skips non-Google accounts and the writer requires a Google connection/token plus
`GoogleApiClient.insertEvent` (`~/Jarv1s/packages/connectors/sql/0009_connectors_module.sql:64-99`;
`~/Jarv1s/packages/connectors/src/source-context/calendar.ts:262-281`; `~/Jarv1s/packages/chat/src/calendar-write-impl.ts:32-39,69-121`).
Without writable Google, a block can remain a local proposal/unscheduled decision, never provider-scheduled.

## Approved interactions mapped to current seams

| Approved interaction                | Existing seam                                                             | Reuse/status               | Gap or implementation boundary                                                              |
| ----------------------------------- | ------------------------------------------------------------------------- | -------------------------- | ------------------------------------------------------------------------------------------- |
| Read morning/evening prose          | `BriefingsRepository.generateRun` composes and persists a run             | Reuse                      | Run DTO has prose and metadata, no plan/block projection                                    |
| Carry evening intent to morning     | Evening receives same-day morning metadata; morning can be read by UI     | Partial reuse              | Current handoff contains signal summaries only, not user-selected intent/capacity/blocks    |
| Show current commitments            | Source-context calendar is live-first with cache fallback                 | Reuse                      | Cache fallback must be marked stale; it cannot authorize a new write                        |
| Propose a task block                | `CalendarWriteService` and `resolveWindow`/`chooseSlot` support one event | Reuse math/service         | No persisted proposal or task relation; current tool immediately writes after approval      |
| Accept one block                    | Generic gateway confirmation can approve one write tool                   | Narrow reuse               | A plan review needs durable state and direct endpoint semantics                             |
| Accept all blocks                   | No batch calendar/task API exists                                         | Missing                    | Add plan-level apply with one approval and per-item reconciliation                          |
| Adjust a block                      | Calendar reschedule tool moves one event                                  | Narrow reuse               | It addresses an event ref, not a plan row; task block edits need plan version checks        |
| Remove a block while retaining task | Calendar delete removes one event                                         | Reuse provider primitive   | Need explicit plan row state so deleting a block does not archive/delete task               |
| Leave task unscheduled              | Task `do_at` can be null                                                  | Reuse field                | No reason/source/status for deliberate unscheduling; plan row should retain decision        |
| Automatic placement                 | Follow-through port creates task/event in briefing composition            | Existing but colliding     | Clarify whether auto follow-through remains active when morning review owns block decisions |
| Evening choose tomorrow             | Chat seed route starts an interview                                       | Existing entry point       | No structured plan parser or durable draft/intent contract                                  |
| Switch auto to proposals            | Settings route persists mode and policy tier                              | Reuse preference authority | Pending plan choices need mode-at-creation and must survive setting changes                 |
| Protect appointments/lunch/travel   | Live calendar read and free/busy conflict checks                          | Partial reuse              | No travel-duration/route model; semantic protection is a planner rule to add                |

Evidence: morning requires per-task decisions, bulk acceptance, and conflict/failure recovery (`~/Jarv1s/docs/superpowers/specs/2026-09-10-morning-briefing-flow.md:15-37`); evening requires
selective review/save (`~/Jarv1s/docs/superpowers/specs/2026-09-10-evening-planning-flow.md:15-31`).
The design spec asks for reuse mapping before new work (`~/Jarv1s/docs/superpowers/specs/2026-09-10-today-briefings-design.md:70-79`).

## Authoritative stores and contracts

### Tasks

`TasksRepository.create` accepts title, status, due/do times, effort, source/sourceRef, externalKey, recurrence, and suggestion metadata. An external key is idempotent per owner/source and the repository explicitly filters owner rows before reusing one (`~/Jarv1s/packages/tasks/src/repository.ts:27-55,198-255`).
The underlying foundation migration stores `do_at`, source provenance, and a per-owner
`(source, external_key)` unique index (`~/Jarv1s/packages/tasks/sql/0039_tasks_foundation.sql:44-55,80-88`).
These fields describe a task and its provenance; none points to a calendar event or plan.

The normal task REST route exposes list/create/get/patch and activity, but no scheduling relation or
plan endpoint (`~/Jarv1s/packages/tasks/src/manifest.ts:320-390`). Its assistant tools update task
fields under the `task_changes` family, default `ask_each_time`, with `trusted_auto` allowed
(`~/Jarv1s/packages/tasks/src/manifest.ts:515-528,638-679`). This is useful for task metadata but
does not provide multi-block atomicity.

The database has a `suggested` status for email staging; it is intended to become `todo` only after
user acceptance (`~/Jarv1s/packages/tasks/sql/0140_task_status_suggested.sql:1-5`). The task REST
status parser accepts only `todo|done|archived` (`~/Jarv1s/packages/tasks/src/routes.ts:880-910`).
Do not make morning scheduling depend on `suggested` unless that parser and its semantics are
deliberately extended; a proposed time block is a separate decision from accepting a task.

### Calendar reads and cache

The source-context contract returns event key, account, title, start/end, all-day, location, attendee count, flags, source, and degradation reason (`~/Jarv1s/packages/connectors/src/source-context/types.ts:85-143`).
The implementation reads each granted active Google account live, retries auth once, reports auth
gaps, and falls back to cached rows only for transient failures
(`~/Jarv1s/packages/connectors/src/source-context/calendar.ts:230-348`). This is the right read
authority for briefing display and apply-time preflight; cached data is evidence with provenance.

`app.calendar_events` has provider account, owner, title, instants, external id, and JSON metadata,
with a unique connector-account/external-id key (`~/Jarv1s/packages/calendar/sql/0011_calendar_module.sql:1-25`).
RLS allows owner/share visibility and owner-or-manage updates, while insertion requires an account
owned by the actor (`~/Jarv1s/packages/calendar/sql/0020_calendar_owner_or_share.sql:11-58`).
The repository only lists/gets/upserts/deletes cache rows; it does not model a plan
(`~/Jarv1s/packages/calendar/src/repository.ts:26-46,72-114,116-150`).

### Calendar writes

`CalendarWriteService` owns a narrow module contract for create/delete/reschedule. Create returns resolved times, conflict classification, provider/cache identifiers, and mirror status
(`~/Jarv1s/packages/calendar/src/calendar-write-service.ts:3-82`). `resolveWindow` validates local
date/RFC3339 input, clamps durations to 15–480 minutes, and resolves morning/afternoon/evening
bands; `chooseSlot` scans 15-minute candidates against busy intervals
(`~/Jarv1s/packages/calendar/src/focus-time.ts:126-161,283-321`).

The create implementation obtains a current token, performs live free/busy, filters all-day intervals, inserts a deterministic Google event, then best-effort mirrors the cache. It can require
the mirror and tags Moss-created events with `jarvisCreated` and an optional follow-through target
(`~/Jarv1s/packages/chat/src/calendar-write-impl.ts:123-240,510-535`). A Google 409 is treated as
an idempotent already-created result in the same path. The deterministic ID is keyed by actor,
requested search window, duration, and title, so retrying a proposal does not depend on a shifted
slot (`~/Jarv1s/packages/calendar/src/focus-time.ts:164-203`).

This service is reusable for plan apply, but it is not a transaction coordinator. A local DB
transaction can commit a plan row before or after the remote call; it cannot undo a successful
Google insert. Apply must therefore record each operation's provider result and make retries
idempotent, rather than promise rollback.

### Briefings and jobs

Briefing runs are the durable briefing authority. Scheduled generation takes a transaction-scoped advisory lock keyed by definition/local period, deduplicates same-day runs, composes, and persists
`source_metadata` plus `structuredPayload` (`~/Jarv1s/packages/briefings/src/repository.ts:205-301`).
The job payload is metadata-only and retry limit is zero; scheduled workers mint the run id and
notify only after a newly-created successful run (`~/Jarv1s/packages/briefings/src/jobs.ts:22-31,69-104,146-181`).
The run API accepts only an idempotency key for run-now (`~/Jarv1s/packages/shared/src/briefings-api.ts:89-109`).

Morning composition gathers current tasks/calendar and records calendar signals, source context,
gaps, freshness, and structured action payload. Evening composition records reconciliation counts,
calendar source context, and a sanitized six-item morning signal handoff
(`~/Jarv1s/packages/briefings/src/compose-evening.ts:76-100,460-475`; the signal schema is
`~/Jarv1s/packages/briefings/src/signals.ts:3-22`). There is no saved plan or user decision in this
metadata contract.

## Settings, policy, and authority

Calendar settings support independent `off|suggest|auto` modes for prep tasks and time blocks, with legacy booleans mapped into those modes (`~/Jarv1s/packages/shared/src/calendar-briefing-settings-api.ts:1-40`; `~/Jarv1s/packages/calendar/src/routes.ts:185-222`).
Changing `timeBlockMode` also sets the `calendar_writeback` family to `trusted_auto` only for
`auto`, otherwise `ask_each_time` (`~/Jarv1s/packages/calendar/src/routes.ts:154-173`).

The manifest declares `calendar_writeback` default `ask_each_time`; `calendar.createEvent` is a
write tool with `executionPolicy:auto`, user-promotable grant, and no install-time grant
(`~/Jarv1s/packages/calendar/src/manifest.ts:198-212,244-288`). The policy resolver runs writes
only when the family tier is `trusted_auto`, execution policy is auto, and the family allows it;
destructive/outbound actions always confirm (`~/Jarv1s/packages/ai/src/gateway/policy.ts:22-58`).

There is a second path: `buildCalendarFollowThroughPort` creates prep tasks and, for `block_time`,
calls `CalendarWriteService.createEvent` directly when `calendar_writeback` is `trusted_auto`
(`~/Jarv1s/packages/module-registry/src/index.ts:1099-1175`). The production briefings worker
injects this port and the live source-context service (`~/Jarv1s/packages/module-registry/src/index.ts:1939-1978`).
This background path can write while a user is reading a briefing. The implementation spec must
choose whether it remains the source of automatic blocks or is replaced/suppressed for blocks owned
by the new plan; otherwise duplicates are possible.

The generic gateway persists one owner-scoped pending action with metadata-only input names, waits on a process-local confirmation, and runs one handler after confirmation
(`~/Jarv1s/packages/ai/src/gateway/gateway.ts:715-826`). The action table is owner-RLS and has
pending/confirmed/rejected/cancelled statuses (`~/Jarv1s/packages/ai/sql/0016_ai_assistant_actions.sql:1-140`).
It is a useful approval/audit primitive, but one action row per block would violate the approved
bulk interaction and has no durable batch/retry state. A plan-level action or endpoint should
authorize a validated batch and then use the calendar service per item.

## Minimum coherent implementation slices

1. **Plan authority and migration.** Add an owner-scoped day-plan row with version/etag, source run,
   timezone/day, mode-at-creation, and lifecycle. Add block rows keyed to plan and task, with
   requested/resolved times, decision (`proposed`, `scheduled`, `unscheduled`, pending add/move/remove),
   optional Moss calendar event id, and provider operation metadata. Keep task/deadline fields in
   `app.tasks`; use a relation for block identity and retention.
2. **Plan read/preview API.** Return the plan, task details, current calendar commitments, source
   freshness, and a change summary. Read through actor-scoped RLS. Use an opaque version/etag so old
   reading or review tabs cannot apply over newer choices.
3. **Plan edit API.** Edit one block's time/decision and explicitly mark remove/unschedule. Every
   mutation checks plan version and task ownership/visibility. Switching settings must not mutate
   saved plans; new apply resolves the current mode and policy.
4. **Apply service.** Under one local transaction, lock/check the plan version and task rows, then
   preflight live calendar availability and protected commitments. Execute provider operations using
   stable per-operation keys. Persist `applied`, `pending`, and `failed` outcomes individually; a
   provider success followed by DB failure must be recoverable by reconciliation.
5. **Briefing integration.** Persist a plan reference/version in run metadata or a structured
   payload extension, and include the durable evening intent in the morning handoff. Keep run
   generation read-only with respect to user-selected proposals unless automatic mode explicitly
   owns that path.
6. **Approval and UI clients.** Add one plan-level approval/audit action and API clients for read,
   edit, apply, retry. Invalidate Today, briefing, task, and calendar queries only after an
   acknowledged provider/local result.
7. **App-map/module declarations.** Calendar currently declares `calendar.planning` and
   `calendar.writeback` as `coming-soon` (`~/Jarv1s/packages/calendar/src/manifest.ts:145-167`);
   update the owning declarations in the same product PR when the new routes/settings ship.

## Security and concurrency rules

- Use `withDataContext`/RLS for every plan, task, and cache read; shared task visibility must not
  grant ownership of a plan or provider account. Existing task creation explicitly owner-filters
  idempotency lookup for this reason (`~/Jarv1s/packages/tasks/src/repository.ts:203-217`).
- Treat live calendar free/busy as a precondition, not a lock. Recheck immediately before each
  provider write; return named conflicts and preserve review choices when any item is blocked.
- Protect all calendar events as busy during placement. Current signal logic only infers location
  shifts and tight <=15-minute gaps; it does not calculate travel duration
  (`~/Jarv1s/packages/briefings/src/signals.ts:163-198`). Travel buffers and lunch semantics need
  an explicit planner decision.
- A plan version prevents stale tab writes. Operation keys prevent repeated apply from creating
  duplicate Moss blocks. Existing deterministic focus IDs and source/external task keys are useful
  building blocks, not a substitute for a plan relation.
- Removing a block must call the calendar delete primitive only for a plan-owned Moss event. The
  provenance predicate already requires `jarvisCreated` and matching follow-through target
  (`~/Jarv1s/packages/calendar/src/follow-through.ts:1-48`); generalize it to a plan operation
  reference before allowing removal of a block.

## Tests and commands identified but not run

No product, database, browser, or prototype checks were run. After the static gate, pure unit checks use `pnpm exec vitest run tests/unit/calendar-follow-through-port.test.ts tests/unit/calendar-signals-modes.test.ts tests/unit/calendar-confirmation-policy.test.ts tests/unit/calendar-tools-source-context.test.ts tests/unit/source-context-calendar.test.ts tests/unit/briefings-schedule.test.ts tests/unit/briefings-compose.test.ts tests/unit/gateway-action-preview.test.ts tests/unit/gateway-confirm-override.test.ts tests/unit/today-evening-mode.test.tsx tests/unit/today-briefing-prose.test.tsx tests/unit/today-briefing-action-rows.test.tsx`. Database-backed integration checks use the isolation wrapper after the protected
verify gate: `pnpm exec tsx scripts/test-integration.ts tests/integration/focus-time.test.ts
tests/integration/briefings.test.ts tests/integration/briefings-evening.test.ts
tests/integration/ai-assistant-action-resolve.test.ts`; do not use raw Vitest. Other relevant files:
`calendar-reschedule.test.ts`, `source-context-briefing.test.ts`, `chat-mcp-transport.test.ts`, and
`briefings-action-rows.test.ts`.

- `node .superpowers/brainstorm/today-briefings-20260909/check-morning.cjs` and `check-evening.cjs`
  are prototype checks only, not production proof.

New tests required by the proposed slices: two-actor plan RLS, stale version rejection, edited and
explicitly unscheduled blocks, task retention after removal, live-conflict preflight, provider
success/local failure reconciliation, repeated apply idempotency, auto-to-proposal setting changes,
evening-to-morning intent persistence, and one plan-level approval for a mixed batch.

## Questions raised by exploration

The [implementation plan](../superpowers/plans/2026-09-10-today-briefings.md) now records proposed
resolutions to these questions; this list preserves what the source alone did not decide.

1. Is a scheduled task block always a real Google event, or can it remain a local proposal after
   apply? The answer determines whether `calendarEventId` is nullable and what “scheduled” means.
2. Does `timeBlockMode=auto` continue background follow-through writes, or does the new plan service
   become the sole writer? Define ownership to avoid duplicate prep tasks/events.
3. Should a user-created calendar event ever be movable/removable from a Moss plan? Existing
   reschedule refuses events with attendees and calendar deletion is separately confirmed
   (`~/Jarv1s/packages/calendar/src/manifest.ts:291-340`).
4. What is the minimum travel buffer rule, and is lunch an ordinary busy event or a protected semantic
   commitment? Current data carries location but no route or travel duration.
5. Are evening choices durable before Finish, and if so where is the draft owned? Browser-only state
   cannot support reload or morning handoff; a server draft/plan row is needed.
6. Should task `do_at` be updated when a block moves, or should block time be independent? Updating
   it makes existing task views reflect execution time but risks conflating deadline, intent, and
   calendar placement.

The parent plan's versioning, apply-time conflict checks, per-item remote outcome, and retained
choices on failure match the repository's real authorities. Describe local transaction atomicity as
atomic plan-state/preflight, and Google changes as an idempotent saga with explicit reconciliation;
establish the durable plan/block relation and its RLS/version contract before adding Today controls.
