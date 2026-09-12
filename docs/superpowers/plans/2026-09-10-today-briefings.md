# Today and morning/evening briefings implementation plan

**Goal:** Implement the approved Today page, operational morning briefing, and reflective evening
planning flow, with a complete realistic day plan, prominent weather, source-grounded news/sports,
and module quick actions. The approved design determines behavior: adapt existing functionality
where needed to deliver it, while retaining authorization, canonical task meaning, and module ownership.

**Architecture:** Extend the owning Today, briefings, scheduling/calendar/tasks, chat-action, and
module seams. The interactive HTML study specifies behavior and appearance; it is not a runtime
component, domain model, scheduler, or new API architecture. Production design must distinguish
source evidence, draft intent, proposed changes, and committed effects.

**Tech stack:** Existing TypeScript/React, TanStack Query, authored Moss UI/token system, Fastify
REST and shared contracts, PostgreSQL actor-scoped repositories, existing workers/tools and module
registries, Vitest, Playwright, and the repository's protected UAT workflow. No new framework or
provider-specific AI path is required by the design.

**Revision:** R2.2 — R2 approved by Ben; verification and builder recommendations updated by his subsequent rulings.

**Status:** Approved visual/interaction scope retained. This revision makes the implementation
decisions and sequential task boundaries concrete. Ben approved R2 in the room; implementation
and task dispatch remain outstanding. R2.1 changed verification execution; R2.2 favors Muse Spark builders. Product scope and task order are unchanged. Only this master plan changes. The linked eight slice documents remain technical
reference inventories; this revision supersedes their session grouping, parallel-dispatch language,
and deferral of live proof to slice 8. No builder is dispatched by this document.

## Approved design and evidence

- [Today composition and weather](../specs/2026-09-10-today-briefings-design.md).
- [Evening reflection and planning](../specs/2026-09-10-evening-planning-flow.md).
- [Morning reading, review, bulk acceptance, news and sports](../specs/2026-09-10-morning-briefing-flow.md).
- [Behavior, recovery, and verification matrix](2026-09-10-today-briefings-behavior-and-verification.md).

The specs link the preserved desktop/phone images. The preview source is
`~/Jarv1s/.superpowers/brainstorm/today-briefings-20260909/`. No sample identities, hardcoded dates,
fixed time choices, fabricated reporting, or demo controls belong in the implementation.

## Scope and authority

Ben authorized this revision pass through PM on September 11: keep the smallest design-complete
path and do not over-engineer it. Scope is issue [#2453](https://github.com/motioneso/moss/issues/2453),
including all approved Today, morning, and evening behavior. Changing old presentation or behavior
is permitted where the new design requires it. Existing authorization, privacy, task semantics,
source choices, and the full Wellness actions remain constraints, not excuses to omit new features.
No new provider, general workflow engine, theme migration, chat transport, or preference store.

The merged source of this revision is primary-branch head
`aaeb6120267cdee28f3fc98bbf5119c35ffcc43e`. Docs PR #2454 is merged. September 10 exploration
reports describe older revisions and are background evidence only. The following bounded checks
were repeated on this exact primary revision using a fresh graph index and source inspection:

| Assumption                                         | Current source evidence                                                                                                                                                                                                                      | Consequence                                                                                                                                       |
| -------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------- |
| A shared saved plan is missing                     | No day-plan symbols in the graph; inspected Calendar/Briefings seams still expose runs, tasks and individual calendar actions.                                                                                                               | Retain one Calendar-owned plan, not a second evening store. Absence is a bounded finding, recheck touched callers at dispatch.                    |
| Generation and calendar writes share a transaction | `packages/briefings/src/jobs.ts:151` calls `generateRun` in the scoped worker; `repository.ts:256` composes before persisting; `packages/module-registry/src/index.ts:1208` creates prep tasks and calls the writer with the same scoped DB. | Keep local task/run/reservation commit before provider application; split preview, apply, recovery and automatic integration into separate tasks. |
| The current writer uses Google                     | `packages/chat/src/calendar-write-impl.ts` refreshes Google access, checks free/busy and inserts/patches/deletes events.                                                                                                                     | Reuse it; actual writable disposable account remains an operational prerequisite, not a proven test resource.                                     |
| Morning defaults need correction                   | `packages/briefings/src/routes.ts:529` includes Sports but not News; shared schema has `minItems: 1`; SQL migration 0015 has `cardinality(...) > 0`.                                                                                         | Keep explicit-empty migration, independent controls and preservation of existing choices.                                                         |
| Source setup needs worker proof                    | News/Sports late-bound briefing setters are inside route registration at registry lines 2276 and 2394.                                                                                                                                       | Exercise separate API and worker startup; do not infer worker readiness from a working page.                                                      |
| Real Today uses module contributions               | `ModuleTodayWidgets` filters disabled modules and mounts owning widgets; Sports DTO has scoreboard and ambiguous-follow data, but its Today widget does not render a Tonight group.                                                          | Extend the real widgets, retain permanent team identities, and avoid the unused host feed.                                                        |
| Theme already exists                               | `apps/web/src/styles/tokens.css` defines Bone and self-hosted Archivo for display; body retains its canonical sans stack.                                                                                                                    | Reuse exact current tokens, not a blanket all-Archivo migration; prove loaded fonts in the UI task.                                               |
| Remote protection                                  | GitHub branch rules returned required check `CI gate`.                                                                                                                                                                                       | Require that check on the settled task head; re-query protection before merge.                                                                    |

These are source findings, not product tests, a complete code audit, or live deployment evidence.
Before each task, revalidate its named seams against its recorded base. Do not silently carry old
line numbers or assume later tasks still start at this initial head.

## Tracking and readiness ownership

PM links #2453 to project 2, records approved scope and each task revision, and owns dispatch.
Only one task and one change request are active at a time. Only its assigned Builder changes the
task branch; Reviewer reviews, Builder fixes, PM confirms, then Prover records real acceptance
before merge. Corrections are folded into the task’s single final commit; every changed head
invalidates earlier review/proof for affected behavior. The next task waits for completion.

Related issues remain open on the inspected revision:

- #1919: retain the existing five-day forecast; verify its access in the weather task, no new provider.
- #2313: startup ordering is covered by the source-startup task, including News.
- #2296: a blocked Today entry blocks live proof. PM tracks any required repair separately rather
  than admitting unrelated onboarding work into this feature or calling the proof passed.

## Global implementation constraints

- Read `CLAUDE.md` and `docs/DEVELOPMENT_STANDARDS.md`; follow the actor/RLS, provider-agnostic AI,
  metadata-only worker payload, applied-migration immutability, and module-isolation invariants.
- Prefer the existing authorized action and scheduling paths. A new UI cannot bypass policy or
  reclassify a committed block as a proposal merely to match a visual example.
- Respect latest defaults: morning news AND sports included unless explicitly excluded or disabled.
  Preserve existing opt-outs. Module enablement and source/topic privacy restrictions remain
  authoritative. Defaults must not silently reinstall/re-enable modules or erase user choices.
- Keep module contributions in their owning modules. Preserve the complete Wellness medication
  and rich check-in flow; the preview's abbreviated form is not its replacement specification.
- Reconcile actual authored theme/font state with Bone/forest/Archivo references before UI work.
  Use current canonical tokens and approved primitives; no Today-only shadow palette or implicit
  global theme migration.
- Keep app-map declarations truthful in every product PR, including requirements, errors, and
  remediations. Update core declarations and the relevant owning module manifests together with
  their respective changes.
- Work in one authorized feature worktree per implementation task. Split at explicit slice
  boundaries, keep unrelated edits untouched, and preserve backwards compatibility between
  backend and frontend changes.
- A slice is complete only with the named checks. Full DB/foundation/UAT commands require the
  protected verification procedure and an isolated authorized target. Live-path proof is executable
  assertions and bounded textual evidence; prototype screenshots cannot substitute for it.

## Exploration and reuse inventory

Four `gpt-5.6-luna` agents explored separate scopes, tracing production callers, contracts, stores,
composition-root wiring, and tests. Follow-up questions reconcile conflicting or incomplete findings.

| Evidence report                                                                           | Main verified finding                                                                                                                                                                      | Plan consequence                                                                                                 |
| ----------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------- |
| [Briefing backend](../../research/2026-09-10-today-briefings-backend-exploration.md)      | Runs, scheduling, synthesis, freshness, trust boundaries, and interview startup exist. The current handoff is morning metadata into evening, not durable evening intent into next morning. | Extend composition and inject a saved-plan read port; keep immutable run snapshots separate from editable plans. |
| [Scheduling/actions](../../research/2026-09-10-today-briefings-scheduling-exploration.md) | Tasks, live calendar context, single-event create/move/delete, idempotency primitives, and approval policy exist. No task↔block relation, plan version, or bulk apply authority exists.    | Add a narrow durable day-plan aggregate and batch operation ledger; reuse the calendar writer and policy.        |
| [Frontend](../../research/2026-09-10-today-briefings-frontend-exploration.md)             | Today queries, time-aware run selection, action rows, task details, chat, weather, and Wellness are wired. Full reader/review and durable planning UI are absent.                          | Compose focused reader/review/conversation components around current queries and real contracts.                 |
| [Modules](../../research/2026-09-10-today-briefings-modules-exploration.md)               | News has real photos/summaries; Sports has a rich overview scoreboard/photos/follows; weather already fetches five days. Module widgets are wired.                                         | Extend owning widgets/source contracts. Do not rebuild feeds, ESPN/Open-Meteo adapters, or the module registry.  |

A specific distinction matters: `TodayFeed`/`NewsDesk` is an unused legacy prop path on the real
Today route. Real News/Sports arrive through module contributions. Improving only the legacy feed
would leave the actual page unchanged. Likewise, existing email action rows accept suggested
**tasks**; they are not calendar time-block proposals.

## Proposed production architecture and contract decisions

These decisions make the plan concrete for review. They do not reopen approved visual choices or
claim that the new data/transaction contracts are implemented.

1. **One plan authority in Calendar.** Add a calendar-owned, owner-scoped day plan keyed by actor,
   local date and IANA timezone, with an opaque revision and source run references. It holds typed
   evening intent (priority, capacity, notes/corrections) and task-block decisions. Child block rows
   link existing task identities to optional calendar-provider artifacts. Do not create both a
   separate “evening intent database” and a second competing day plan.
2. **Keep canonical tasks and events.** A plan block is an execution reservation, not a task. Keep
   task deadline/status/provenance in Tasks. Do not repurpose `Task.status=suggested`, `do_at`, or
   `app.calendar_events` cache rows as the proposal store. In the first implementation, block edits
   leave `do_at` and `due_at` unchanged; execution times are projected from the plan into Today and
   task scheduling context. Editing task dates remains a normal task action.
3. **Committed means real effect.** Use the existing writable calendar account/service for scheduled
   blocks. Without a supported writable account/grant, retain proposals and show the existing setup
   remediation. Do not label a purely browser/local suggestion “on calendar.” No new calendar
   provider or local-only calendar product is added by this plan.
4. **A small versioned API.** Proposed shared contract: `day-plan-api.ts`, with read/create-for-day,
   draft update, preview, apply, and operation-status/retry shapes. Requests carry stable block IDs,
   expected revision, typed decisions and an idempotency key; the server derives actor, task facts,
   policy, source availability, and provider ownership. Read responses carry plan/block states,
   protected commitment evidence, freshness, and per-item outcomes. Avoid embedding full private
   task/email/news stores in this DTO.
5. **Policy and explicit actions remain authoritative.** A direct button is an explicit user action,
   not `trusted_auto`. Reuse the existing family/permission resolver and audit record; batch
   acceptance authorizes the concrete validated addition batch once. “Accept all time blocks”
   excludes removals and pending edits to existing blocks. For a reviewed batch containing moves/removals,
   the existing `calendar_management` default `always_confirm` rule requires one additional explicit
   confirmation of that change set before any batch write. Resolve current family policy, preserving
   an existing explicit user promotion; scheduling mode alone is not a family promotion. Bind its audited approval to actor,
   plan revision and exact provider-event IDs/operations/new times. Apply validates it through the existing
   gateway/action policy authority; a draft save, preview, generic Accept All click or direct writer
   call cannot satisfy it. No per-item confirmation tour is needed for an unchanged change set. Hard attendee-reschedule restrictions still apply.
6. **One writer for automatic blocks.** Route existing calendar follow-through time-block creation
   through the plan authority, retaining its idempotency and provenance. Preserve prep-task behavior
   and its independent setting. Suppress the old parallel event-creation path for plan-owned blocks;
   do not let background composition and the review apply endpoint create the same block twice.
   Preserve `off|suggest|auto`, not just the two modes used in the mockup.
7. **Local persistence and remote outcomes are separate.** Reserve a batch/revision locally, validate
   current sources and permissions, execute provider operations outside long-lived DB transactions,
   and finalize/reconcile outcomes locally. Use per-operation stable keys, one active application
   per plan revision, and recoverable provider identifiers. No promise of remote atomic rollback.
   An interruption after provider success must reconcile before a retry can create another event.
   Existing `generateRun` composes inside `withDataContext`; changing its injected writer alone
   does not satisfy this boundary. Composition emits typed automatic intents without writing a
   provider. Retain allowed canonical prep-task creation via the public Tasks port in the local
   generation transaction, resolve real task IDs, and bind the plan blocks/operations before the
   task/run/reservation commit. Rollback means no eligible operation and no provider dispatch.
   Commit the run plus plan reservation/pending operation before application; the worker
   then invokes apply with actor/run/operation IDs, never the composition transaction's
   `DataContextDb`. Apply opens fresh short actor contexts for reads/reservation/finalization and
   performs remote I/O after those transactions close. A durable pending operation survives a crash
   between commit and dispatch and is resumed through the existing worker path.
8. **Briefing runs reference plans; they do not own mutable drafts.** Inject a public plan-read port
   into existing `ComposeDeps`; resolve evening intent for the target morning date/zone. Store a
   sanitized plan reference/revision and evidence snapshot with the run. An old run stays dated and
   read-only while current actions always address the current plan. Manual refresh uses the existing
   run job/definition routes and creates an identifiable new run, not a second scheduling system.
9. **Reuse source selection for inclusion.** Use per-definition
   `selectedToolNames` membership for independent News/Sports inclusion, with named controls in
   Briefings settings. Add News to omitted-selection defaults, keep Sports, preserve existing
   explicit tool lists and exclusions, and gate inactive modules before invoking providers. Do not
   add a parallel preference store. Permit explicit `[]` in schema, parser and a new migration so
   a definition selecting only News/Sports can turn both off; omission keeps existing default semantics.
10. **Rich display data stays separate from model prose.** Reuse News/Sports overview services and
    safe image/link contracts. Extend their briefing contribution with bounded structured evidence
    and display references; synthesize prose from allowlisted facts/summaries, not raw articles.
    Store enough provenance to explain the run, with source-owned lookup for current visibility,
    exclusions and expiring photos. No invented fallback reporting.
11. **Use the module web boundary.** Make existing widget slots useful for quick actions versus
    editorial content without a new registry. Keep News/Sports queries, feedback, polling, images,
    and provider logic inside their modules. Preserve existing Wellness dialogs through a focused
    Today quick-action composition, without broad conversion of Wellness into a new plugin.
12. **Draft retention and chat are deliberate.** Store typed plan intent/decisions server-side for
    evening-to-morning/reload. Keep incomplete free-text composer input in the existing session UI
    store for close/reopen; submit notes through the plan/normal chat action path. Reuse one existing
    chat session/transport, not a second SSE connection or a fake text-to-calendar parser. Separate
    server-saved draft intent from applying calendar effects so Cancel/Back never implies a write.

Exact names/routes below are proposed implementation targets. Existing file names in the inventory
are verified; new names should only change when a better existing seam is demonstrated and the plan
is updated consistently.

## Sequential tasks and acceptance boundaries

Each row is one session-sized implementation task and one final commit, not an invitation to build
an entire original slice. Owners below are recommendations for PM, not assignments. A task includes
its focused tests and truthful app-map changes. New test filenames below are required deliverables,
not claims that they already exist. Reuse existing tests where they cover the same assertion.

### Builder selection and observed results

Ben requests Muse Spark builders wherever practical, especially at the start. Builder-B is the
default for early, bounded tasks, starting with T01; Builder-C handles tasks with more moving parts.
The table records recommendations only: PM dispatches and records the actual owner. Architect
resolves technical decisions before dispatch rather than leaving a builder to redesign the plan.

Builder is the fallback if review shows repeated misunderstanding or more than one substantial
fix cycle. PM evaluates that evidence before reassigning; small ordinary review fixes alone are
not evidence of a model limitation. Any handover uses a pushed, clean tree and the same task record;
review, remote checks and narrow live proof remain mandatory.

PM maintains a small side log alongside the task evidence: task type, actual builder, first-pass
result, review findings, substantial fix cycles, elapsed time, observed strengths and limits.
Distinguish implementation rework from environment/CI delays or unclear requirements. Record
actual token usage only when available; do not infer token savings from elapsed time. Use these
observations to adjust later assignments without expanding product scope or starting another task.
No builder comparison result is claimed before work has been observed.

All tasks run in order. T01–T07 establish the shared saved plan and authorized effects; T08–T13
provide real sources and briefing composition; T14–T21 deliver the approved screens and handoff.
No new dead controls are exposed while a dependency is absent. A backend task is proven through
its real repository/API/worker boundary; a screen task also needs authenticated UI proof. A mock
provider test never counts as a real calendar effect. T22 checks the assembled journey, not missing
proof from earlier tasks.

| Task / recommended owner                           | Bounded change and inherited file scope                                                                                                                                           | Executable focused check                                                                                                                                                                                                  | Prover acceptance before merge                                                                                                                                                                                                       |
| -------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| T01 / Builder-B — saved plan storage               | Slice 1 tasks 1–2: minimal plan/block contract, new Calendar migration and public repository; revision-checked save/read. No routes or provider operations.                       | `pnpm exec vitest run tests/unit/day-plan-model.test.ts`; protected DB proof below covers new `tests/integration/day-plans.test.ts`.                                                                                      | Actual isolated PostgreSQL: two actors, same-day duplicate create, competing revision saves, save/reload in a fresh context, task/deadline retention, no provider call.                                                              |
| T02 / Builder-C — draft API                        | Slice 1 task 3: authorized read/create/draft routes, validation and declarations using T01.                                                                                       | `pnpm exec vitest run tests/unit/day-plan-routes.test.ts`; protected DB proof includes route assertions in `day-plans.test.ts`.                                                                                           | Authenticated real API create/save/read; another actor cannot access it; invalid dates/IDs and stale revisions fail; draft save has no calendar effect.                                                                              |
| T03 / Builder-C — preview                          | Slice 2 task 1: current calendar/task checks, stable before/after diff and conflicts; no application endpoint.                                                                    | `pnpm exec vitest run tests/unit/day-plan-preview.test.ts tests/unit/source-context-calendar.test.ts`; protected DB proof.                                                                                                | Real preview API with controlled calendar context: overlap, unavailable calendar, no feasible slot, protected preparation/travel and timezone boundary; writes remain zero. Source fixtures are labelled.                            |
| T04 / Builder-C — authorized additions             | Slice 2 task 2, additions only: operation reservation, gateway authorization and post-transaction create/finalize; Accept All excludes moves/removals.                            | `pnpm exec vitest run tests/unit/day-plan-apply.test.ts tests/unit/gateway-action-preview.test.ts`; protected DB proof adds `tests/integration/day-plan-apply.test.ts`.                                                   | Real API and disposable Google calendar: selected/all additions, denied policy, duplicate request, retained task; actual provider IDs recorded without secrets.                                                                      |
| T05 / Builder-C — recovery                         | Slice 2 task 2 recovery: status/retry, ambiguous result reconciliation, concurrent callers and late conflicts. No new scheduling path.                                            | `pnpm exec vitest run tests/unit/day-plan-apply.test.ts`; protected DB proof.                                                                                                                                             | Same real API/provider boundary with failure injection after provider success and before local finalization; restart/retry produces one event and truthful per-item results.                                                         |
| T06 / Builder-C — reviewed moves/removals          | Slice 2 task 2 remaining changes: bind existing action approval to the exact reviewed set; use the same apply service.                                                            | `pnpm exec vitest run tests/unit/day-plan-apply.test.ts tests/unit/calendar-confirmation-policy.test.ts`; protected DB proof.                                                                                             | Real API/provider: cancel, stale approval, mixed batch, one confirmed move/removal, unchanged retry; unrelated events stay protected and removed blocks retain tasks.                                                                |
| T07 / Builder-C — automatic generation             | Slice 2 task 3: compose intents, local prep-task/run/plan reservation, commit, existing worker dispatch/recovery by IDs; suppress duplicate legacy writes.                        | `pnpm exec vitest run tests/unit/calendar-follow-through-port.test.ts tests/unit/calendar-signals-modes.test.ts tests/unit/day-plan-worker.test.ts`; protected DB proof adds `tests/integration/day-plan-worker.test.ts`. | Actual worker path: rollback yields zero provider writes; commit precedes application; crash before dispatch resumes; worker/UI race creates one event. Exercise off/suggest/auto and independent prep-task setting.                 |
| T08 / Builder-B — inclusion settings               | Slice 3 task 1: independent News/Sports controls, default News addition, explicit-empty schema/parser/migration and disabled-module precedence.                                   | `pnpm exec vitest run tests/unit/briefings-default-tools.test.ts`; protected DB proof adds `tests/integration/briefing-inclusion.test.ts`; UI proof below.                                                                | Real Settings: default definition, each opt-out, both off, reload/re-enable and disabled module; verify actual stored selection and no excluded-source invocation.                                                                   |
| T09 / Builder-C — source startup                   | Slice 3 startup portion: configure existing News/Sports briefing services in both production entry paths; no source redesign.                                                     | `pnpm exec vitest run tests/unit/briefing-source-startup.test.ts`; protected DB proof where startup touches storage.                                                                                                      | Start API and worker independently; generate through worker with News/Sports selected and verify both configured; unavailable source is a specific gap, not failed Today.                                                            |
| T10 / Builder-C — editorial evidence               | Slice 3 task 2: bounded News/Sports facts, source references/photos, freshness and local-day sporting states; preserve all exclusions/ownership.                                  | `pnpm exec vitest run tests/unit/briefing-editorial-evidence.test.ts tests/unit/news-service.test.ts tests/unit/sports-service.test.ts`.                                                                                  | Actual owning source services and briefing tool output: followed teams, default slate, ambiguous follows, finals/live/tonight/quiet, expired photo and exclusions. Mark fixture cases separately from real-source fetch evidence.    |
| T11 / Builder-B — owning widgets                   | Slice 3 widget portion: compact Sports scores/Tonight and News photo/prose hierarchy using T10; preserve query cache, feedback and polling.                                       | `pnpm exec vitest run tests/unit/sports-today-widget.test.tsx tests/unit/news-today-widget.test.tsx`; UI proof.                                                                                                           | Authenticated Today shows real owning widgets, multiple scores, Tonight/quiet, source photos or clean text fallback, working feedback and disabled-module omission at phone/desktop widths.                                          |
| T12 / Builder-C — plan context in runs             | Slice 4 task 1: public injected plan-read port, versioned payload and immutable source snapshot; keep existing action rows.                                                       | `pnpm exec vitest run tests/unit/briefings-plan-context.test.ts tests/unit/briefings-compose.test.ts`; protected DB proof adds `tests/integration/briefing-plan-context.test.ts`.                                         | Actual generation loads the actor’s correct local-day plan; old runs remain unchanged; missing intent and shared-definition ownership are exercised.                                                                                 |
| T13 / Builder-C — prose and refresh                | Slice 4 tasks 2–3: grounded prose/fallback and existing refresh/history linkage; current revision conflicts preserve edits.                                                       | `pnpm exec vitest run tests/unit/briefings-compose.test.ts tests/unit/briefings-schedule.test.ts`; protected DB proof.                                                                                                    | Actual queued morning/evening runs: corrected facts, proposed versus committed effects, disabled editorials, model/source gap; refresh returns a new identifiable run and archived reports stay read-only.                           |
| T14 / Builder-B — Today composition                | Slice 5 task 1: approved assessment, full schedule/preparation before editorial sections, real plan query, task details and retained secondary actions.                           | `pnpm exec vitest run tests/unit/today-briefing-prose.test.tsx tests/unit/today-evening-mode.test.tsx tests/unit/today-briefing-action-rows.test.tsx`; UI proof.                                                          | Real Today read order and task/event links, proposed/committed/unscheduled distinction, current task truth and working email actions; no dead reader/review buttons.                                                                 |
| T15 / Builder-B — weather and quick actions        | Slice 5 task 2: prominent weather with forecast access, filtered widget placement, full existing Wellness dialogs.                                                                | `pnpm exec vitest run tests/unit/today-quick-actions.test.tsx tests/unit/weather-service.test.ts`; UI proof.                                                                                                              | Real Today at phone/desktop widths: shared weather fetch, units/location/five-day access, no-location/failure, medication log/correction and rich check-in; multiple widgets without duplicate mounting.                             |
| T16 / Builder-B — Today state coverage             | Slice 5 task 3: quiet, pending, delayed, missing/disabled sources and daytime conflict treatments from matrix; bounded local state components.                                    | `pnpm exec vitest run tests/unit/today-states.test.tsx`; UI proof.                                                                                                                                                        | Real UI with controlled states: calendar/tasks remain usable while prose fails; stale calendar blocks writes; no fabricated quiet-night certainty; long text/zoom/keyboard remain usable.                                            |
| T17 / Builder-C — reader and shared dialog         | Slice 6 tasks 1–2: grounded morning reader, source/material links and dated history in one accessible desktop/mobile shell; preserve working entry paths.                         | `pnpm exec vitest run tests/unit/morning-briefing.test.tsx`; UI proof.                                                                                                                                                    | Authenticated reader: real run/evidence/material navigation, independent editorials, stale/earlier report labels, missing-source recovery; focus containment/return, Escape and footer at all widths.                                |
| T18 / Builder-C — morning review                   | Slice 6 task 3, individual actions: one revision-aware draft/controller, time/placement choices, preview, apply and per-item recovery.                                            | `pnpm exec vitest run tests/unit/day-plan-review.test.tsx`; UI and provider proof.                                                                                                                                        | Real UI/provider: accept one, leave another, unschedule, confirmed move/remove, conflict and retry; reload and task/material times agree; close/reopen retains edits.                                                                |
| T19 / Builder-B — direct Accept All                | Slice 6 task 3 bulk action: use T18 controller from reader/review; no second mutation path.                                                                                       | `pnpm exec vitest run tests/unit/day-plan-review.test.tsx tests/unit/morning-briefing.test.tsx`; UI and provider proof.                                                                                                   | One activation accepts eligible additions and keeps reader open; explicit unscheduling respected; pending moves/other review edits show Review changes; retries do not duplicate.                                                    |
| T20 / Builder-C — evening draft                    | Slice 7 task 1 and manual review/save from task 3: freely navigable reflection/commitments/capacity/priority, shared review, durable intent; existing chat entry remains working. | `pnpm exec vitest run tests/unit/evening-planning.test.tsx`; UI and provider proof for applied changes.                                                                                                                   | Actual evening UI: inherit Today decisions, correct without completing tasks, lighter/zero-block plan, reload/resume, current scheduling mode and partial-save recovery.                                                             |
| T21 / Builder-C — evening conversation and handoff | Slice 7 task 2 and cross-day remainder: existing chat session/action transport reads and edits typed plan intent; next morning uses it.                                           | `pnpm exec vitest run tests/unit/evening-planning.test.tsx tests/unit/briefings-plan-context.test.ts`; protected DB proof; cross-day UI proof.                                                                            | Real chat, not fixed replies: save corrected intent, reload/restart, advance controlled local day, change a calendar commitment and generate morning; priority/capacity survive without repeating interview, conflicts are reviewed. |
| T22 / Builder-C — assembled acceptance coverage    | Slice 8: fill uncovered cross-task assertions only, app-map/release evidence; no new feature or broad cleanup.                                                                    | GitHub-only full gate, including static/regression checks; separate assembled UAT below.                                                                                                                                  | Prover exercises real Today → morning accept/adjust → evening → next morning at the final head and maps every acceptance row to evidence; remote `CI gate` passes.                                                                   |

The detailed slice documents supply file inventories and invariants for each row. They do not
expand its scope. T01 intentionally leaves route exposure to T02; T04 exposes additions only until
T06; all later UI uses the same apply authority. Recoverable unknown outcomes must already be
stored truthfully in T04 even though automated recovery is completed in T05. T07 is the highest-risk
bounded task: if caller revalidation shows its commit boundary cannot be changed in one session,
PM stops dispatch and Architect subdivides that task before any build, without reducing its proof.

## Executable checks and evidence per task

Use the existing runners; no new harness or test framework. Each row’s test command is run only
after its named new files exist. Do not pass a missing file and report the remaining subset as a pass.

Ben’s ruling: the full gate runs on GitHub for the pushed head, not locally. This supersedes
mandatory local full/static/type/app-map/token gate instructions in the original slice inventories.
Required coverage remains; its execution owner changes. Each task record separates **local editing
checks**, **GitHub-only checks**, and **Prover acceptance** before dispatch.

- Local editing checks: Builder runs only fast, targeted checks useful for the actual edit. The
  table’s focused commands are available for this purpose, not a mandatory second run of every CI
  suite. Scoped lint/format is appropriate; do not run repository-wide typecheck, static, foundation,
  app-map, design-token or UI-class gates locally when GitHub already covers them.
- GitHub-only checks: let the existing required `CI gate` run for the settled pushed head. It owns
  the full static, unit, migration/integration and browser coverage configured by CI. Record actual
  jobs and results; do not assume a missing/skipped assertion was covered. A failure returns to
  Builder; after a fix, GitHub checks the new head. Reviewer consumes these results without rerunning
  unchanged checks. Do not manually rerun a passing gate; a retry without code changes needs a
  recorded infrastructure failure or missing evidence.
- Protected DB proof: Prover still exercises the task’s real repository/API/worker acceptance
  boundary. This is a narrow independent proof, not a local repeat of the CI integration suite.
  Reuse the existing protection procedure in `.claude/skills/verify-gate/SKILL.md`; never run the
  full foundation gate locally. T01’s `test:today-briefings` package script is restricted to
  `pnpm db:migrate && tsx scripts/test-integration.ts tests/integration/day-plans.test.ts -t "live acceptance"`.
  Builder names the corresponding storage-boundary acceptance case explicitly. Prover invokes
  `scripts/run-gate.sh start --gate test:today-briefings` and records the isolated target, run ID
  and terminal result. For later tasks, replace this narrow script’s test selection with that task’s
  live acceptance case, rather than accumulating previously proven suites. CI remains responsible
  for full regressions. A missing case is a failure, not a passing empty selection.
- UI proof: use the existing protected `pnpm test:uat <spec-basename>` runner. The assigned Builder
  adds a focused `tests/uat/specs/2453-tNN-<behavior>.uat.spec.ts` for each UI acceptance boundary
  (T08, T11, T14–T21); execute that exact basename, for example
  `pnpm test:uat 2453-t08-inclusion.uat.spec.ts`. This provisions an isolated application and runs
  the actual UI; controlled source/model fixtures must be identified as fixtures in the evidence.
  Use a real provider account only under the next bullet. Mocked Playwright regression remains
  `pnpm exec playwright test tests/e2e/today-briefings.spec.ts --project=chromium` once created.
- Provider proof: before T04 dispatch, PM records the authorized disposable actor and writable
  Google calendar using opaque resource references. Prover verifies the installed API/web/worker
  head, then exercises each task’s API or UI path and checks actual event IDs/state. A seeded local
  calendar or intercepted HTTP response cannot satisfy this requirement. Keep credentials out of
  the plan/evidence. Missing target blocks T04 and dependent tasks; it does not justify another provider.
- T22: Prover runs `pnpm test:uat 2453-t22-today-briefings.uat.spec.ts` for the assembled journey.
  The full static/foundation/regression gate runs on GitHub only. Earlier tasks prove their narrow
  boundary; T22 verifies the combined morning-to-evening-to-next-morning journey and uncovered
  interactions, without rerunning unchanged individual proofs.
- Every change request: `gh pr checks <number> --required` must show required `CI gate` on the exact
  final commit; PM re-queries the branch rules if they change. An earlier passing head is insufficient.

### Four execution efficiencies

1. **One evidence record per task.** Builder, Reviewer and Prover share commands, outcomes and
   artifacts bound to the same exact commit and target/configuration. After a fix, record its impact
   and rerun only affected local/live checks; GitHub checks the new head normally. Retained evidence
   keeps its original SHA and an explicit reason it remains applicable; never relabel it as a new run.
2. **Reuse verified setup.** Keep the authorized disposable account/calendar and setup evidence
   when the harness supports safe reuse. Record the installed API/web/worker revision for each proof;
   refresh setup verification when configuration, grants, credentials, fixtures or environment change.
   Reset task data between proofs. Do not bypass the protected harness’s isolation or teardown to save
   provisioning time, and do not treat old account authorization as broader permission.
3. **Prepare the next record while CI runs.** PM may clarify the next task’s scope, dependencies,
   ownership and checks. No next-task build or dispatch begins before the current task is reviewed,
   proven and merged; bind the prepared record to the resulting base before dispatch.
4. **Prove the narrow boundary.** Repository/API/worker tasks need that actual boundary, screen
   tasks need the actual UI, and calendar effects need the authorized real provider. Capture sufficient
   assertions and bounded evidence once; screenshots alone are not behavioral proof. Reserve the full
   combined journey for T22, without postponing any task’s own acceptance until then.

Reviewer independently assesses the task diff and assertions, including authorization and design
fidelity; Builder resolves findings; PM confirms the reviewed task; Prover then records acceptance
at the real boundary before merge. A backend-only task has no new UI to prove: mark UI N/A and
name its real repository/API/worker proof. Do not call this evidence full feature acceptance.

One settled report per task contains: task/revision, final commit, change request, dirty-tree state,
commands and exit codes, required remote check, review outcome, Prover evidence with target and
installed revision, unresolved findings and next owner. Missing proof means code-complete,
unverified. No later task starts to hide an incomplete earlier one. Before handover, only the
assigned Builder pushes its single final commit and leaves the task tree clean; PM obtains the
next owner’s acknowledgement. No running commentary on check results.

## Approved decisions and remaining prerequisites

The twelve production decisions above are included in Ben’s R2 approval,
not open choices left to builders. Adopt the behavior matrix’s concrete quiet/loading/error,
missing-source, earlier-report, daytime-change and multiple-widget treatments using existing
authored components. This does not claim the original visual approval covered unseen screens:
if implementation requires a materially new screen, Architect preserves its reference and obtains
approval before that screen’s task. Do not turn every existing empty-state variation into a new
mockup project.

No additional product decision is presently unresolved; Ben has approved the plan. Operational prerequisites are unproven:
PM must confirm task worktree ownership, isolated verification availability, and the disposable
Google actor/calendar before their dependent tasks. Memory search returned no relevant stored
target decision; bounded searches of the Moss vault did not establish one. Plan approval is not
account authorization. No provider or DB mutation was made during this revision.

## Recommended first task record — R2.2-T01

| Required field                    | Proposed record for plan approval                                                                                                                                                                                                                                                                                                                               |
| --------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Parent / scope revision           | #2453 / R2.2-T01; Ben approved the plan; start only after PM records dispatch prerequisites.                                                                                                                                                                                                                                                                    |
| Owner                             | Builder-B; Reviewer owns review; Prover owns independent real-boundary proof; PM confirms.                                                                                                                                                                                                                                                                      |
| Chosen primary base               | `aaeb6120267cdee28f3fc98bbf5119c35ffcc43e`; revalidate after the approved docs revision merges and record the actual build base before dispatch.                                                                                                                                                                                                                |
| Worktree / branch                 | Proposed `~/Jarv1s/.claude/worktrees/2453-t01-day-plan`, branch `feat/2453-t01-day-plan`. Not created by Architect. Only Builder creates/touches this task branch.                                                                                                                                                                                              |
| Bounded deliverable               | Typed saved plan and block state, Calendar migration, public revision-checked repository. Preserve canonical task IDs/deadlines and actual versus pending placement. No HTTP routes, UI, chat or calendar writes.                                                                                                                                               |
| Owned files                       | New `packages/shared/src/day-plan-api.ts`, `packages/calendar/src/day-plan-model.ts`, `day-plan-repository.ts`, one newly numbered Calendar SQL migration; owning public exports/migration registration/manifest only as necessary; `package.json` for the single narrow DB script; `tests/unit/day-plan-model.test.ts`, `tests/integration/day-plans.test.ts`. |
| Executable checks                 | Local editing: `pnpm exec vitest run tests/unit/day-plan-model.test.ts` and scoped lint/format as useful. GitHub-only: full required `CI gate` on final head. Prover: `scripts/run-gate.sh start --gate test:today-briefings` for the named live acceptance case only; no local full gate.                                                                      |
| Assertions                        | Duplicate actor/day creation returns one plan; two contexts reject stale save; second actor cannot read/write even with a shared task; valid save survives a new context; proposed move preserves actual placement; block removal retains task/status/dates; invalid day/zone/duration rejected; no provider invocation.                                        |
| Live proof                        | Prover exercises the actual exported Calendar repository with real actor-scoped PostgreSQL contexts in the gate’s generated disposable DB. Record DB/run ID and exact tested commit, rows/outcomes without private content, and exit status. UI/provider N/A because neither is introduced.                                                                     |
| Isolation / dispatch prerequisite | Protected gate tooling exists at this base; runtime availability is not verified. PM records generated-target procedure, exclusive task ownership and actual base before dispatch. No personal calendar is required for T01.                                                                                                                                    |
| Commit / change request           | One final task commit after fixes, one PR linked to #2453. Builder pushes a clean tree; PR number and final SHA replace “pending” before review/proof.                                                                                                                                                                                                          |
| Stop / next owner                 | Stop after storage boundary passes. Reviewer → Builder fixes → PM confirmation → Prover proof → authorized merge; PM then prepares T02.                                                                                                                                                                                                                         |
| Current status                    | Plan approved; updated verification split recorded; not dispatched. No implementation/check/remote/live result is claimed.                                                                                                                                                                                                                                      |

Later task records use these same fields, substitute their own bounded row and acceptance cases,
and bind their base to the actual preceding merged result. Missing fields block dispatch. The
session-sized limit is enforced before dispatch; if a task no longer fits, revise its record rather
than silently crossing a context reset or combining it with a neighbor.

## Revision evidence

R2 reads the merged primary copy and changes only this master plan. Its evidence is bounded source,
issue-state and branch-rule inspection. The approved specs and detailed slice inventories are
unchanged. Product tests, DB/provider operations, UI proof and remote checks were not run for this
planning revision. This documentation revision is prepared for review separately from product task branches. Merge
remains pending; Ben’s R2 plan approval and subsequent verification ruling are recorded above.
This is not a build or release completion claim.
