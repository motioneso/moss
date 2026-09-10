# Today and morning/evening briefings implementation plan

**Goal:** Implement the approved Today page, operational morning briefing, and reflective evening
planning flow, with a complete realistic day plan, prominent weather, source-grounded news/sports,
and module quick actions. Preserve existing functionality and reuse the current plumbing.

**Architecture:** Extend the owning Today, briefings, scheduling/calendar/tasks, chat-action, and
module seams. The interactive HTML study specifies behavior and appearance; it is not a runtime
component, domain model, scheduler, or new API architecture. Production design must distinguish
source evidence, draft intent, proposed changes, and committed effects.

**Tech stack:** Existing TypeScript/React, TanStack Query, authored Moss UI/token system, Fastify
REST and shared contracts, PostgreSQL actor-scoped repositories, existing workers/tools and module
registries, Vitest, Playwright, and the repository's protected UAT workflow. No new framework or
provider-specific AI path is required by the design.

**Status:** Implementation plan complete for review. Visual and interaction approvals are recorded;
production reconciliations below are proposed implementation decisions. This planning pass changes
documentation only; implementation and product verification remain outstanding.

## Approved design and evidence

- [Today composition and weather](../specs/2026-09-10-today-briefings-design.md).
- [Evening reflection and planning](../specs/2026-09-10-evening-planning-flow.md).
- [Morning reading, review, bulk acceptance, news and sports](../specs/2026-09-10-morning-briefing-flow.md).
- [Behavior, recovery, and verification matrix](2026-09-10-today-briefings-behavior-and-verification.md).

The specs link the preserved desktop/phone images. The preview source is
`~/Jarv1s/.superpowers/brainstorm/today-briefings-20260909/`. No sample identities, hardcoded dates,
fixed time choices, fabricated reporting, or demo controls belong in the implementation.

## Scope and authority

Ben explicitly authorized a full implementation plan with low-cost agents doing detailed exploration,
and asked that the existing functionality determine what is reused, extended, or added. This session
owns research and local planning artifacts. It does not implement the feature, publish a PR, migrate
a database, provision live users, deploy, or merge.

Research is anchored to checkout `497cf0217` on September 10, 2026. This is a shared dirty detached
checkout; findings describe inspected source, not the currently deployed product. Rebase/reinspect
on the chosen implementation revision before executing slices. Do not switch/reset/stash this
checkout or sweep unrelated work into a commit.

A bounded reconciliation also inspected local `origin/main` at `27e9fef5a`. It already includes
Bone and self-hosted Archivo (`728642cd4`), newer shell navigation, and newer News/Sports work.
The detached checkout's Oat/Helvetica is not a reason to schedule a theme migration. Use the
candidate's canonical theme and module contracts, then verify the authenticated runtime. Source
history establishes reuse opportunities; it does not prove which revision is deployed.
Newer Sports already resolves permanent team identities, exposes ambiguous-follow remediations,
uses a default slate without follows, and stores owner-scoped photos. Slice 3 preserves these;
its Today scoreboard and Tonight rendering are still missing on that revision.

## Tracking and related work

A dedicated implementation task must be linked on project 2, **Issue and Roadmap Work**, before
building. Bounded read-only open-issue/title and PR searches did not identify a dedicated task/PR
for this combined redesign; they are not proof that none exists. No issue or PR was created.

Known overlapping open issues checked September 10:

- [#1919: Today weather chip / five-day forecast](https://github.com/motioneso/moss/issues/1919).
- [#2313: Sports briefing setup ordering](https://github.com/motioneso/moss/issues/2313).
- [#2296: Today blocked by onboarding status](https://github.com/motioneso/moss/issues/2296).

Resolve overlap during readiness. A redesign does not automatically own unrelated onboarding
failure repair; a blocked entry path does affect live verification. Do not close these issues merely
because this plan references them.

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

## Delivery order and bounded sessions

Use one feature branch/worktree and one linked build task by default. The slices are dependency
lanes with explicit session checkpoints, not eight promises of single-session completion. Stop at
a checkpoint with its code, tests and small handoff recorded; resume in that same worktree. Do not
create a rollout service, another module system or eight speculative deployment flags.

| Slice                                                                            | Depends on                | Session checkpoints and exit evidence                                                                               |
| -------------------------------------------------------------------------------- | ------------------------- | ------------------------------------------------------------------------------------------------------------------- |
| [1. Durable plan](2026-09-10-today-briefings-slice-1-plan-contract.md)           | Readiness below           | Contract/invariants → migration/repository/RLS → draft routes and save/reload.                                      |
| [2. Apply and automatic scheduling](2026-09-10-today-briefings-slice-2-apply.md) | 1                         | Preview/conflicts → durable apply/reconciliation → existing automatic path integration and race proof.              |
| [3. Source contributions](2026-09-10-today-briefings-slice-3-sources.md)         | Readiness                 | Defaults/settings → bounded editorial evidence → real widgets/weather/boot ordering. Can proceed alongside 1–2.     |
| [4. Briefing composition](2026-09-10-today-briefings-slice-4-composition.md)     | 1–3 contracts; 2 outcomes | Plan port/payload → grounded prose/fallback → refresh/history and cross-day persistence.                            |
| [5. Today layout](2026-09-10-today-briefings-slice-5-today-layout.md)            | 1 reads, 3 widgets        | Full day composition → weather/quick actions/slots → state/accessibility parity. Final integration also consumes 4. |
| [6. Morning](2026-09-10-today-briefings-slice-6-morning.md)                      | 2, 4, 5                   | Reader/evidence → accessible shell → partial/bulk review and recovery.                                              |
| [7. Evening](2026-09-10-today-briefings-slice-7-evening.md)                      | 1–2, 4–6 shared UI        | Reflection/draft → existing chat/action channel → review/save and next-morning proof.                               |
| [8. Assembled verification](2026-09-10-today-briefings-slice-8-verification.md)  | 1–7                       | Regression/isolated integration → real UI/provider proof → review and release evidence.                             |

Parallel implementers, if used, own disjoint files. Slice 3 and slice 4 both touch Briefings contracts;
land the agreed source shape first or serialize those edits. Only the composition-root owner edits
module-registry wiring. Final integration is sequential on the same candidate revision.

Intermediate checkpoints must preserve old callers, immutable stored runs and existing settings.
Use additive contracts/migrations and tolerant reads until the new UI is wired. If review size calls
for multiple PRs, split at a tested dependency boundary and keep each PR runnable and its app map
truthful. Do not expose nonfunctional controls while dependent slices are absent.

## Build readiness and verification contract

- [ ] Review the proposed plan ownership, committed/pending distinction, retry semantics and page
      states against the approved flows. Visual approval is already recorded; do not repeat that work.
- [ ] Link the dedicated build task and related-issue overlap, establish the authorized feature
      worktree/revision, and reconcile newer main before assigning exact file ownership.
- [ ] Confirm the actual writable calendar and source setup on the authorized test target. Current
      inspected calendar writes support Google only. Preserve usable read/draft behavior without it.
- [ ] Obtain the repository's design-system and verify-gate instructions for UI/protected DB work;
      allocate new migration numbers on the candidate, never edit applied migrations.
- [ ] Name the isolated verification target, controlled clock, disposable actor/test calendar and
      required CI/live-path evidence before executing provider or database mutations.

The [behavior matrix](2026-09-10-today-briefings-behavior-and-verification.md) is the acceptance index;
each slice names file targets and focused checks. Slice 8 supplies runnable existing test commands,
protected integration requirements, responsive/accessibility coverage and actual UI proof. No
product tests, DB commands or provider mutations were run for this documentation-only plan.

At each checkpoint record revision, actual touched files, completed requirement rows, check commands
and exit codes, remaining dependencies and the next bounded action in a small task handoff. Do not
mark an implementation checkbox from exploration alone. Preserve user approvals in the specs while
recording any subsequent contract changes here and in the affected slice.

This plan deliberately reuses existing scheduling modes, calendar operations, model routing,
briefing jobs, module registries and chat. The substantial new work is the durable plan and safe
batch application, followed by the two real briefing flows. Styling alone cannot deliver the
approved behavior. Build/release status belongs to the linked issue and actual verification evidence.

## Planning review record

Four low-cost agents completed the exploration; the frontend agent reviewed its integration slices
and the scheduling agent independently reviewed the complete plan against specs and reports.
Two medium findings were resolved in the plan: the exact generation/task/run/plan commit boundary
before remote apply, and explicit gateway-backed confirmation of moves/removals under current
family policy. Slice 2 names the production call chain, local task linkage, post-commit recovery and
runnable verification cases; the morning/evening slices use the same confirmation semantics.
These are reviewed planning changes, not evidence that the product now implements them.
