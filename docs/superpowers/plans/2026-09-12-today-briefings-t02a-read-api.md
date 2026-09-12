# Task 2A: Read a saved day plan

**Revision:** R2.2-T02A-R1. Prepared for PM dispatch; no implementation is authorized by this file.

**Parent:** [#2453](https://github.com/motioneso/moss/issues/2453),
[approved R2.2 plan](2026-09-10-today-briefings.md), T02 / slice 1 task 3.
The approved plan was read from fetched primary `main` at
`6286b4faf65d66914d50eb51dbb60491c7f88b3f`, not from an unmerged planning copy.

## Authority and subdivision

Ben authorized starting the next bounded task while T01's full GitHub checks run, with failures
returned to T01 for correction. PM requested this smaller record. That changes the wait-before-build
rule for this overlap; it does not waive independent review, narrow acceptance, required checks,
one final commit per task, or dependency order at merge. Only PM and Architect act during the
temporary window. Reviewer and Prover remain the independent owners and are paused.

T02A exposes only the saved-plan read. The remainder of approved T02 stays required: creation and
source-run validation, revision-checked draft saving, canonical task/source read enrichment, and
their API acceptance. PM obtains separate bounded records before dispatching those parts. T02A
does not complete T02, unblock T03, or expose planning controls in the UI. The saved snapshot is
not a current task/calendar availability projection. This is a task subdivision, not a reduction
of the approved feature.

## Dispatch record

| Field                       | Record                                                                                                                                                                                                                                                                           |
| --------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Task / revision             | #2453 / R2.2-T02A-R1: authenticated saved-plan read only.                                                                                                                                                                                                                        |
| Implementation owner        | Architect, temporary exclusive author, once PM dispatches this revision. PM owns coordination and GitHub result collection. No other agent is dispatched.                                                                                                                        |
| Worktree                    | `~/Jarv1s/.claude/worktrees/2453-t02a-read-api`, dedicated to T02A; not created during preparation.                                                                                                                                                                              |
| Branch                      | `feat/2453-t02a-read-api`, created by its assigned author at the recorded T01 base.                                                                                                                                                                                              |
| Recorded dependency         | T01 PR [#2464](https://github.com/motioneso/moss/pull/2464), branch `feat/2453-t01-day-plan`, fetched head `f55da7b873ec7095bb08c9624ab8f9530832c64c`. Its current independent review/proof and remote-green status are unresolved; this record makes no new verification claim. |
| Initial build base          | Exactly `f55da7b873ec7095bb08c9624ab8f9530832c64c`. Recheck the pushed T01 head before creating the worktree; if it changed, update this field and the recorded dependency together before dispatch.                                                                             |
| Change request              | A separate PR targeting `feat/2453-t01-day-plan` while T01 is open. Link #2453 without closing the whole feature. Record the allocated PR number in its evidence before review. Never merge T02A into T01.                                                                       |
| Bounded result              | One authenticated `GET /api/calendar/day-plan` route, its shared read contract/schema, normal module registration/permission declaration and truthful read-only feature metadata, plus focused route and real-API assertions.                                                    |
| Local checks                | The exact scoped commands below; TypeScript and the full gate remain on GitHub.                                                                                                                                                                                                  |
| GitHub-only required checks | Required `CI gate`, with each prerequisite outcome named below for the final pushed head. PM collects results.                                                                                                                                                                   |
| Review owner                | Reviewer, independent of the author; paused during the temporary window. Review cannot be replaced by Architect's checks or PM coordination.                                                                                                                                     |
| Acceptance owner / boundary | Prover, after review, fixes and PM confirmation: the real API server, authentication, production Calendar registration and actor-scoped PostgreSQL in the protected disposable target. Paused during the temporary window.                                                       |
| Shared setup                | Reuse the protected runner procedure established in T01. Each run still receives its own generated disposable DB and teardown. Record the actual DB/run ID and API revision; fixture actor references stay in evidence. No writable calendar account is needed.                  |
| Evidence / commit           | One evidence record in the T02A PR body, one final T02A commit above its recorded dependency after corrections; clean pushed tree before handover. T01 evidence stays in T01's PR.                                                                                               |
| Stop / next owner           | Author stops at code-complete, unverified and hands exact head/checks to PM. PM retains T01 failures, resumes independent review/proof when permitted, and coordinates an eligible non-author merger after all prerequisites pass. No automatic next-task dispatch.              |

PM revalidates revision, ownership, available worktree path, exact dependency head and protected
runner availability after any delay/reset and immediately before dispatch. Once created, use only
this worktree for T02A; T01 corrections remain in T01's dedicated worktree under their own dispatch.

## Read contract and implementation decisions

1. Register `GET /api/calendar/day-plan?date=YYYY-MM-DD` with optional `timeZone` identifying a
   previously saved plan's zone. Require a real calendar date, not just the existing date regex.
   Reject invalid explicit dates/zones with the existing public `400` error shape.
2. Without an explicit zone, inject the existing composition-root timezone resolver: validated
   request timezone, then actor's stored locale, then UTC. Do not import registry internals into
   Calendar or add another locale store/helper. An explicit validated zone only selects that actor's
   existing date/zone key; it never changes authorization or rewrites stored identity/instants.
3. Reuse `resolveAccessContext`, `withDataContext` and `DayPlanRepository.getForDay`. Actor identity
   comes exclusively from the authenticated request. Actor/owner IDs supplied by the caller must
   never affect lookup. Declare the route under `calendar.view` through the existing module path.
4. Return `200` with `{ plan: DayPlanDto | null }`. A missing actor/date/zone plan is `null`, including
   when another actor has a plan for the same date/zone. Do not implicitly create a plan, save a
   draft, increment revision, reserve an operation, or query another actor to distinguish absence.
   Missing or expired authentication uses the existing `401` response. Calendar is required, so
   this route cannot enter the optional-module denial state. `calendar.view` is declaration
   metadata; the HTTP path has no separately revocable runtime grant lookup. Verify that declaration
   and enforce actor isolation through request-derived identity, `DataContextDb` and RLS.
5. The response is the actor's **stored draft snapshot**: stable block IDs, saved task/run references,
   saved labels and intent, revision, actual placement and pending changes. Keep the existing
   `DayPlanDto`; add only the read query/response types and strict response schemas needed here.
   Do not expose database rows, raw legacy fields, operation payloads or connector credentials.
   Stored task/run references and labels are provenance, not current task facts, source access or
   write permission. Current canonical labels, missing-task/source handling and source-reference
   filtering remain explicit requirements of the remaining T02 before its API is consumer-ready.
6. Read keeps a recorded placement and proposed move/removal distinct. It neither promotes a
   proposal nor interprets a legacy placement without a provider reference as verified commitment.
   Fetching in another timezone must not mutate the original plan; callers can select its original
   zone explicitly. This task introduces no latest-plan fallback or date reassignment heuristic.
7. Inject the repository from the composition root using the existing public Tasks lookup contract
   required by its constructor. Reading must not call that write-validation lookup. Reuse existing
   public exports. Add no storage migration, repository rewrite, provider service or worker hook.
8. Add the Calendar route declaration and describe only saved-plan retrieval in its feature/error
   metadata. Keep existing planning/writeback coming-soon declarations truthful. No new navigation,
   UI button, create/save/apply route, source refresh or provider call belongs in this task.

## Owned files and verified seams

- `packages/shared/src/day-plan-api.ts`: read query/response contract and JSON schemas, following
  the existing `calendar-api.ts` response/error conventions; do not widen write input types.
- New `packages/calendar/src/day-plan-routes.ts`: the focused route registrar. Existing
  `packages/calendar/src/routes.ts` registers it using the same dependency pattern. Change
  `packages/calendar/src/index.ts` only if a public export is necessary.
- `packages/module-registry/src/index.ts`: bounded Calendar registration wiring only, reusing
  `resolveRequestTimeZoneForRoute` and public Tasks/repository APIs. No registry refactor.
- `packages/calendar/src/manifest.ts`: GET permission/schema and truthful saved-read feature metadata.
- New `tests/unit/day-plan-routes.test.ts` and `tests/integration/day-plan-read-api.test.ts`.
  The separate integration file keeps T01's active correction/acceptance files untouched.
- `package.json`: replace only `test:today-briefings`' selected acceptance file/filter as specified
  below. CI continues discovering all integration tests. No runner, lockfile or dependency change.

Graph discovery and bounded source reads confirmed the existing Calendar registrar is reached from
the module registry, the real integration suite boots `createApiServer` with fixture sessions, and
`getForDay` uses the scoped DB plus normalized date/zone. T01's graph line ranges can lag edits;
the current fetched source remains authoritative. This preparation did not test those behaviors.

## Targeted local checks

Create the named new test files before running these commands. Add any optional changed export
file to the scoped lint/format invocation; do not omit it from verification.

```bash
pnpm exec vitest run tests/unit/day-plan-routes.test.ts
pnpm exec eslint packages/shared/src/day-plan-api.ts packages/calendar/src/day-plan-routes.ts packages/calendar/src/routes.ts packages/calendar/src/manifest.ts packages/module-registry/src/index.ts tests/unit/day-plan-routes.test.ts tests/integration/day-plan-read-api.test.ts --max-warnings=0
pnpm exec prettier --check packages/shared/src/day-plan-api.ts packages/calendar/src/day-plan-routes.ts packages/calendar/src/routes.ts packages/calendar/src/manifest.ts packages/module-registry/src/index.ts tests/unit/day-plan-routes.test.ts tests/integration/day-plan-read-api.test.ts package.json
git diff --check
```

Unit checks cover invalid/missing date and explicit zone, absent/present plan response serialization,
actual versus pending state, and forwarding the resolved actor/zone to the existing read path.
Use the repository's existing framework; no new harness. Record commands and exit codes. No local
root typecheck, app-map build, full static/foundation gate or T01 migration-suite rerun is prescribed.

## Narrow real-API acceptance

Implement exactly one named case in `tests/integration/day-plan-read-api.test.ts`:
`live acceptance: authenticated saved day-plan read`. Set the existing package script to:

```json
"test:today-briefings": "pnpm db:migrate && tsx scripts/test-integration.ts tests/integration/day-plan-read-api.test.ts -t \"live acceptance: authenticated saved day-plan read\""
```

Use `.claude/skills/verify-gate/SKILL.md`: verify the selection exists, then execute
`scripts/run-gate.sh start --gate test:today-briefings --exclusive` and
`scripts/run-gate.sh wait --follow` through nonblocking tool execution. The runner accepts a
package-script name; do not invent filter forwarding. Capture the terminal exit status and cleanup,
not just passing-looking text. Never run DB migration/test commands against either shared database.

The case boots the actual `createApiServer` and production module registrations with real fixture
authentication and runtime-role PostgreSQL contexts. Direct repository calls are permitted for
fixture creation and before/after observations, not as a replacement for HTTP requests. Fastify
injection through the assembled server is sufficient for this backend API boundary; a route-only
stub server is unit evidence. UI, worker and real-provider proof are N/A for T02A.

Required assertions within this one case:

- Actor A reads a seeded saved plan through the GET route, including revision, nullable run/intent
  values and a recorded placement with a distinct pending move/removal; response schema retains them.
- Actor B receives only its own plan or `null` for that same date/zone, including with a shared task;
  missing and expired authentication return `401`. Caller-supplied actor/owner fields never switch
  the result. Verify that Calendar is required and the route declares `calendar.view`; there is no
  separate authenticated permission-denied response to exercise. The author records the isolation
  assertion failing under a deliberate test-only bypass of actor scoping, then removes the bypass
  and records green.
- Missing plans return `null`; malformed/impossible dates and invalid explicit zones return `400`.
  Default zone resolution follows stored locale when there is no request zone. An explicit original
  zone retrieves the same stored plan after locale changes, without rewriting date/timezone/instants.
- Repeated GETs and a fresh API/context read return the same stored revision and state. Before/after
  observations show no plan, block, operation, task/status/date or cached-event mutation. An absent
  read creates no plan. Snapshot only the relevant fixture rows; do not log private content.

Keep provider absence claims bounded: this route has no provider-writing dependency; cached-event
comparisons or a fetch interceptor alone do not prove absence across every possible transport.
No real calendar effect or freshly reconciled availability is claimed by this saved-read proof.

Author runs, if needed while editing, are implementation evidence. Prover must independently
exercise this boundary after review when participation resumes. The temporary pause does not
turn an author run into acceptance.

## GitHub-only checks and one evidence record

PM records the exact pushed SHA and required `CI gate`, plus actual results for:
`Detect change scope`, `Verify docs`, `Verify static checks and unit tests`,
`Verify integration tests (1/2)`, `Verify integration tests (2/2)`,
`Verify web and browser tests`, `Compose deployment smoke`, `Prod compose deployment smoke`.
The workflow handles pull requests without a base-branch filter, including the proposed stacked PR.
Record legitimate skips as skips; missing/unreported checks are not green. Revalidate protection
before merge. GitHub owns TypeScript, complete regressions and all configured full checks.

The T02A PR body records revision, base SHA, exact author/pushed/proof SHA, one-task diff/commit,
tree state, local commands/results, remote run IDs/jobs, independent review findings, Prover target
and API revision, proof log/exit/cleanup, deliberately unrun work and next owner. After a fix/rebase,
repeat only affected local/live assertions and let GitHub check the new head. Retained evidence keeps
its original SHA and reason for reuse; never relabel T01 evidence as T02A proof.

## Carrying forward T01 corrections

1. Keep T01 corrections on T01's branch and PR. Stop T02A editing at a clean pushed checkpoint if
   Architect is reassigned to a T01 failure; PM records the owner and next action for each task.
2. After the corrected T01 head is pushed, fetch it and replay only T02A's own commit on it using
   `git rebase --onto <new-T01-head> <recorded-old-T01-base> feat/2453-t02a-read-api` in T02A's
   worktree. Use actual verified SHAs, not the moving branch name as the old boundary. This handles
   T01's amended commit without keeping its obsolete implementation or duplicating its fixes.
3. Resolve only T02A's integration changes; a conflicting storage contract returns to PM/Architect
   for record correction. Update the dependency SHA, assess affected assertions, amend T02A's single
   commit as needed, and push with an explicit lease against its last observed pushed head.
4. T01 must pass its own independent review, acceptance and required checks and merge first.
   Fetch primary after that merge; replay only T02A's commit from its recorded T01 base onto the
   actual primary merge result, accounting for squash-merge ancestry. Retarget T02A's PR to `main`.
   Confirm its diff contains only T02A and its history contains one task commit above that base.
5. Refresh T02A's evidence for the settled head and changed inputs. Await that head's required
   GitHub checks, independent review and acceptance before an eligible non-author merges it.
   Never merge the stacked PR into T01 to bypass dependency order or use T01's green checks for T02A.

No Ben product decision is left open by this record. PM's dispatch, the temporary review/proof pause,
and both tasks' verification/merge requirements remain explicit operational gates. Preparation ran
only documentation/source checks: no product tests, DB/provider operation, live proof or merge.
