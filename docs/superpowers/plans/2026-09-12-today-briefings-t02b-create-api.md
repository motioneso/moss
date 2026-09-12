# Task 2B: Create a saved day plan

**Revision:** R2.2-T02B-R2. Prepared for PM redispatch after read-only inspection of the interrupted
R1 checkpoint; this file authorizes no implementation by itself.

**Parent:** [#2453](https://github.com/motioneso/moss/issues/2453),
[approved R2.2 plan](2026-09-10-today-briefings.md), T02 / slice 1 task 3.
This record was prepared from merged `main` at
`da01345d3871d07f21c0956ca1135f1ab7fb6ef4`, after T01 storage and T02A saved-plan read merged.

## Authority and subdivision

T02B adds saved-plan creation and validates an optional source briefing run. It does not add draft
saving. The remaining approved T02 work stays required: revision-checked draft saving, current
task/source read enrichment, and their API acceptance. Those parts need later bounded records.
T02B does not complete T02, unblock preview/application, or expose planning controls in the UI.

The split follows the merged seams. `DayPlanRepository.createForDay` already provides actor-scoped,
idempotent creation. `BriefingsRepository.getOwnedRunById` already provides the owner-scoped source
lookup. The missing work is the authenticated HTTP contract, composition-root binding, declaration,
and focused proof. No storage or cross-module query is needed.

## Dispatch record

| Field                       | Record                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| --------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Task / revision             | #2453 / R2.2-T02B-R2: authenticated saved-plan creation with optional source-run ownership validation; adopts and corrects the preserved interrupted R1 checkpoint.                                                                                                                                                                                                                                                                                                                                                                                                           |
| Implementation owner        | Builder-C. PM owns dispatch and GitHub result collection. Only Builder-C touches the task worktree after dispatch.                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| Worktree                    | `~/Jarv1s/.claude/worktrees/2453-t02b-create-api`, dedicated to T02B. Builder-C adopts the preserved dirty R1 checkpoint only; no reset, clean, duplicate worktree or second writer is allowed.                                                                                                                                                                                                                                                                                                                                                                               |
| Branch                      | `feat/2453-t02b-create-api`, still at the exact base below with six modified and two untracked task files and no task commit at R2 preparation.                                                                                                                                                                                                                                                                                                                                                                                                                               |
| Exact build base            | `da01345d3871d07f21c0956ca1135f1ab7fb6ef4`, the merged T02A result on `main`. Re-fetch and require `origin/main` to equal this SHA immediately before dispatch; otherwise return the record to Architect for rebinding.                                                                                                                                                                                                                                                                                                                                                       |
| Bounded result              | One authenticated `POST /api/calendar/day-plans` route, request/response schemas, owner-scoped source-run validation through an injected public Briefings lookup, Calendar registration/declaration updates, and focused unit/real-API assertions.                                                                                                                                                                                                                                                                                                                            |
| Owned files                 | `packages/shared/src/day-plan-api.ts`; `packages/calendar/src/day-plan-routes.ts`; `packages/calendar/src/manifest.ts`; bounded Calendar wiring in `packages/module-registry/src/index.ts`; new `tests/unit/day-plan-create-routes.test.ts`; new `tests/integration/day-plan-create-api.test.ts`; fixture-only dependency updates in `tests/unit/calendar-briefing-settings-routes.test.ts` and `tests/unit/day-plan-routes.test.ts`; and only the `test:today-briefings` selection in `package.json`. Add an existing public export only if compilation proves it necessary. |
| Targeted local checks       | Exact commands in the section below. Root TypeScript, full regression, migration and foundation checks stay on GitHub or the protected runner.                                                                                                                                                                                                                                                                                                                                                                                                                                |
| GitHub-only checks          | Required `CI gate` on the settled pushed head, with each named prerequisite result recorded as required below.                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| Review owner                | Reviewer, independent of Builder-C. Review covers only this task's final diff, source-run trust boundary, assertions and declarations.                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| Acceptance owner / boundary | Prover, after review, fixes and PM confirmation: authenticated production API registration with real actor-scoped PostgreSQL in the protected disposable target. UI and provider proof are not applicable.                                                                                                                                                                                                                                                                                                                                                                    |
| Shared setup                | Read-only R2 inspection found no task pointer, matching log or disposable database. Reuse the protected runner procedure proven by T02A. Builder-C rechecks supported runner status before the author proof; each author/Prover proof verifies its nonempty named selection, generated application map, installed API revision, generated disposable database, fixture actors, teardown and final exit. No writable calendar account is needed.                                                                                                                               |
| Evidence / commit           | One evidence record in the T02B PR body, tied to the exact author, pushed and proof SHA; one final T02B commit after corrections; clean pushed tree before every handoff.                                                                                                                                                                                                                                                                                                                                                                                                     |
| Exclusions                  | No PATCH route, draft blocks/intent editing, canonical task/source enrichment, preview/apply/operation API, migration, provider access, worker, UI, dependency, runner change, or unrelated cleanup.                                                                                                                                                                                                                                                                                                                                                                          |
| Done / next owner           | Builder-C stops code-complete, unverified after pushing one clean task commit and gives exact evidence to PM. Reviewer reviews; Builder-C fixes; PM confirms; Prover proves; an eligible non-author merges only after the settled head is green. PM then requests the next record.                                                                                                                                                                                                                                                                                            |

PM revalidates the revision, exact base, worktree/branch ownership and protected runner after a
delay or reset and immediately before dispatch. A missing or changed field blocks dispatch.

## Adopted R1 checkpoint corrections

Builder-C preserves the interrupted tree and makes only these seven corrections:

1. Use the repository's existing JSON Schema UUID format for `sourceRunId`; remove the duplicate
   route regex and the one-use source-lookup interface while keeping the injected lookup required.
2. Make the successful unit request contain only allowed fields; test actor, owner, revision and
   draft fields separately as strict-schema failures.
3. Fix the unit fixture so an explicitly missing source run stays missing instead of falling back to
   the default present run.
4. Exercise an actual idempotent repeat in the unit test and prove the source lookup receives the
   same scoped database before creation.
5. Assert the manifest structure directly: POST path, `calendar.manage`, and planning/writeback
   remaining `coming-soon`; source-text substring checks are insufficient.
6. Give the protected integration case enough application database connections for concurrent
   same-key requests to exercise the repository conflict path rather than serialize in one pool slot.
7. Assert the created plan's empty typed intent and prove the actor-owned block rows remain exactly
   unchanged, alongside the existing operation/task/event/briefing comparisons.

The briefing-settings fixture update is retained because Calendar registration now requires the
creation repository method and source lookup. Apply the same dependency-only update to the saved-read
route fixture. No behavior or assertion outside Calendar route registration changes in either file.

## HTTP contract and technical decisions

1. Register `POST /api/calendar/day-plans`. Its body is `{ date, timeZone?, sourceRunId? }`.
   `date` is a real `YYYY-MM-DD` calendar date. `timeZone`, when present, is a valid IANA zone.
   Omitted `timeZone` uses the same composition-root resolver as T02A: actor locale, then UTC.
   `sourceRunId` is an optional UUID; omitted and explicit `null` both create without a source.
2. Return `200` with `{ plan: DayPlanDto }` for both a new aggregate and an idempotent repeat.
   The existing repository intentionally returns the settled aggregate without a created flag;
   do not widen it only to alternate between `200` and `201`.
3. Creation exposes no initial draft body. The route calls `createForDay` with the resolved
   day/zone and optional source ID; the repository supplies its existing empty typed intent and no
   blocks. Draft intent and block edits remain T02C work behind an expected revision.
4. Resolve authentication first. Actor identity comes only from the request access context. Within
   one `withDataContext` callback, validate any source ID through an injected lookup backed by the
   public `BriefingsRepository.getOwnedRunById`, then call the Calendar repository. Calendar must not
   import Briefings internals or query `app.briefing_runs`; Briefings must not query Calendar tables.
5. A malformed source UUID returns the normal public `400`. A well-formed absent source and another
   actor's source both return the same public `404` without revealing whether the run exists. Any
   persisted run owned by the actor may remain provenance regardless of age or run outcome; this
   task does not claim source freshness, successful composition, or suitability for application.
6. Validate the supplied source before resolving an idempotent repeat. A repeat with a valid source
   returns the existing plan unchanged; it does not replace that plan's original source, increment
   revision, or write intent. A repeat with an invalid or foreign source still fails at the boundary.
7. Reuse the repository's owner/day/zone uniqueness and conflict handling. Concurrent requests for
   one actor/day/zone settle on one plan at revision 1. Actor B may independently create its own plan
   for the same day/zone and cannot bind Actor A's source run.
8. Declare the POST route with `calendar.manage`. Extend that permission's description to include
   creating the actor's own saved day plan. Keep `calendar.planning` and calendar writeback marked
   coming soon: creating an empty saved aggregate does not schedule or change an event.
9. Missing or expired authentication uses the existing `401` shape. Invalid date/zone/source syntax
   returns `400`; unavailable/foreign source returns `404`; normal route errors use the existing
   shared handler. No request field accepts an actor, owner, revision, block, task, event or provider ID.

These are implementation decisions within the approved API and ownership model. No product choice
is open. If current source contradicts the named public Briefings lookup or the one-context binding,
Builder-C stops and returns the record to PM rather than adding cross-module SQL or a new service.

## Targeted local checks

Use the repository's installed tools and run exactly:

```bash
pnpm exec vitest run tests/unit/day-plan-create-routes.test.ts tests/unit/day-plan-routes.test.ts tests/unit/calendar-briefing-settings-routes.test.ts
pnpm exec eslint packages/shared/src/day-plan-api.ts packages/calendar/src/day-plan-routes.ts packages/calendar/src/manifest.ts packages/module-registry/src/index.ts tests/unit/day-plan-create-routes.test.ts tests/integration/day-plan-create-api.test.ts tests/unit/day-plan-routes.test.ts tests/unit/calendar-briefing-settings-routes.test.ts --max-warnings=0
pnpm exec prettier --check packages/shared/src/day-plan-api.ts packages/calendar/src/day-plan-routes.ts packages/calendar/src/manifest.ts packages/module-registry/src/index.ts tests/unit/day-plan-create-routes.test.ts tests/integration/day-plan-create-api.test.ts tests/unit/day-plan-routes.test.ts tests/unit/calendar-briefing-settings-routes.test.ts package.json
git diff --check
```

If compilation requires one existing export file, add it to the scoped ESLint/Prettier commands and
the evidence. Unit assertions cover schema/date/zone/source validation, authentication propagation,
default-zone forwarding, owner-scoped source lookup before creation, `200` serialization, unchanged
idempotent repeats, public errors, and zero Calendar/Briefings internal imports across the seam.
Use existing fixtures and framework; add no harness or dependency.

No separate local root typecheck, migration, application-map build, full gate, foundation gate or
T02A suite rerun is prescribed. GitHub owns complete static and regression coverage; the protected
runner owns migration, application-map generation and the one database acceptance case below.

## Narrow real-API acceptance

Create exactly one named case in `tests/integration/day-plan-create-api.test.ts`:
`live acceptance: authenticated saved day-plan creation`. Replace the package script selection with:

```json
"test:today-briefings": "pnpm db:migrate && pnpm build:app-map && tsx scripts/test-integration.ts tests/integration/day-plan-create-api.test.ts -t \"live acceptance: authenticated saved day-plan creation\""
```

Prover follows `.claude/skills/verify-gate/SKILL.md`, verifies the exact selection is nonempty and
the generated target is disposable, then runs:

```bash
scripts/run-gate.sh start --gate test:today-briefings --exclusive
scripts/run-gate.sh wait --follow
```

After the targeted checks, Builder-C runs this protected selection once as author evidence and
records its exact log, database, terminal exit and cleanup before review. After review closure and PM
confirmation, Prover independently repeats the same protected boundary on the settled pushed head.
The package script migrates the disposable database and generates the application map before the case
boots the actual API with production module registrations and fixture authentication. The case uses
real runtime-role actor contexts in the generated PostgreSQL database. Direct repository calls may
seed briefing runs and inspect before/after state; they do not replace the HTTP boundary.

Required assertions in that one case:

- Actor A creates a revision-1 empty saved plan with an owned source run. Omitted timezone follows
  stored locale; an explicit valid zone creates/selects that distinct actor/day/zone key.
- Repeating creation returns the same plan ID and revision without replacing its source or creating
  a second row. Concurrent same-key requests settle on one plan.
- Omitted and null source values work. Malformed UUID returns `400`; missing and Actor B-owned source
  IDs return the same `404` to Actor A. A persisted actor-owned non-success/older run remains a valid
  provenance reference and is not represented as fresh or successful.
- Missing and expired authentication return `401`. Caller-supplied extra actor/owner/revision/draft
  fields are rejected by the strict body schema. Actor B creates only Actor B's distinct same-day
  plan and cannot read or mutate Actor A's aggregate through creation.
- Impossible dates and invalid zones return `400`. Repeated reads through the merged T02A endpoint
  observe the created plan without mutation and preserve the resolved day/zone/source values.
- Before/after observations show only the expected actor-owned `day_plans` rows. Creation adds no
  blocks or operations and changes no briefing run, task, task date/status, cached event or provider
  state. The route has no provider-writing dependency; do not claim absence beyond this boundary.

Record installed API SHA, fixture actor/run references, generated database, successful
application-map build, exact log path, terminal exit, cleanup, assertions observed and anything
unrun. UI, worker and real-provider proof are not applicable to T02B. Reuse T02A setup procedure
only; T02A behavior evidence is not T02B acceptance.

## GitHub-only checks and evidence record

PM records the exact settled pushed SHA and required `CI gate`, plus actual outcomes for:
`Detect change scope`, `Verify docs`, `Verify static checks and unit tests`,
`Verify integration tests (1/2)`, `Verify integration tests (2/2)`,
`Verify web and browser tests`, `Compose deployment smoke`, `Prod compose deployment smoke`,
and image jobs if reported. Legitimate skips are named as skips; missing or unreported is not green.

The single PR-body evidence record contains revision, exact base/head/proof SHA, one-task commit and
file list, clean tree state, local commands and exits, remote run/job outcomes, Reviewer findings,
Prover log/exit/cleanup and observed assertions, retained evidence with its original SHA and reason,
deliberately unrun work, unresolved findings and next owner. After a fix, repeat only affected local
and live assertions; GitHub verifies the new head normally.

## Stop condition

Stop when the authenticated API can create one actor-owned empty saved plan and safely bind an
optional actor-owned briefing run, with the named local checks, review, protected API proof and
required remote checks green on the settled head. Do not merge until Prover records acceptance.
Do not begin draft saving, enrichment, preview, application, UI or the next task from this record.
