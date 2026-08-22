# 1754 build agent runner — relay 7

**Spec:** `docs/superpowers/specs/2026-08-19-moss-builds-modules-on-moss.md`.
**Plan — your scope is Group C only:** `docs/superpowers/plans/2026-08-20-1739-stage1-workshop.md`.
**Task plan (approved by the coordinator):**
`docs/superpowers/plans/2026-08-21-1754-task19-restart-survival.md`.
**Coordinator:** label `Coordinator` in Herdr — confirm fresh via `herdr pane list`, never trust a
pane id written in any doc.

## Status: Task 19, plan approved, code written, test still red — one bug left to find

The coordinator already approved the plan for Task 19 (message is in this pane's own history).
Do not re-ask for approval — go straight to fixing the failing test below.

### Files changed, not yet committed (all in this worktree, on this branch)

- `packages/jobs/src/pg-boss.ts` — moved `MODULE_BUILD_QUEUE` here (was only in
  `module-build-jobs.ts`) so `FOUNDATION_QUEUES` can reference it without a circular import;
  added an entry for it in `FOUNDATION_QUEUES` (same shape as the `PLATFORM_MODULE_CONTROL_QUEUE`
  entry). This part is done and correct — the queue registration gap the earlier relay found is
  fixed.
- `packages/jobs/src/module-build-jobs.ts` — now imports `MODULE_BUILD_QUEUE` from `./pg-boss.js`
  and re-exports it, instead of defining it locally. Done and correct; the existing unit test
  `tests/unit/jobs-module-build.test.ts` still passes (confirmed).
- `tests/integration/module-build-restart.e2e.test.ts` — new file, the restart-survival test.
  Typechecks clean (`pnpm typecheck` exit 0). **Still fails when run — currently times out at
  30 seconds** rather than passing or failing on an assertion. This is the one thing left to fix.

### The failing run and what's already ruled out

Run command (needs a scoped gate database first — see below):
```
pnpm test:integration tests/integration/module-build-restart.e2e.test.ts
```

First failure was `permission denied for table module_builds` — caused by connecting with
`connectionStrings.worker` (role `jarvis_worker_runtime`, which `packages/settings/sql/0189_module_builds.sql`
never grants). Fixed by switching every `connectionStrings.worker` in the test to
`connectionStrings.app` (role `jarvis_app_runtime`, which the migration does grant) — this matches
how every other integration test in this repo that touches app tables does it (e.g.
`tests/integration/tasks-verticals.test.ts:52-53` uses `.app` for the data context and `.worker`
only for a *second*, worker-side boss — I did not need that second boss for this test).

After that fix, the test times out after 30s inside the `it(...)` block, at the `await
firstStepDone` wait (line ~104) — the `boss.work(MODULE_BUILD_QUEUE, { pollingIntervalSeconds: 1
}, async (jobs) => {...})` handler apparently never fires, or fires but the promise never
resolves. I added `{ pollingIntervalSeconds: 1 }` to both `boss.work(...)` calls (see
`tests/integration/connectors-google-schedule-root.test.ts:113` for the precedent that pattern is
copied from) — that did NOT fix the timeout, so the polling interval was not the actual cause.

**Not yet checked, in order of suspicion:**
1. Whether `sendJob(boss, MODULE_BUILD_QUEUE, {...})` actually inserted a row into `pgboss.job` —
   query `pgboss.job` directly after `sendJob` to confirm (a payload key rejected by
   `assertMetadataOnlyPayload` would throw synchronously, so that's probably not it, but verify).
2. Whether `boss.work()` needs the queue to be created via `boss.createQueue(...)` explicitly
   before `.work()` will fire, even though `FOUNDATION_QUEUES` should have created it during
   `resetFoundationDatabase()` — check `packages/jobs/src/pg-boss.ts` around where
   `FOUNDATION_QUEUES` is consumed (search for where it loops and calls `createQueue` or
   `updateQueue`) to confirm the create actually runs for a boss client using role
   `jarvis_app_runtime`, not just `jarvis_migration_owner`.
3. Whether `realRunModuleBuildStep` itself throws inside the handler (which `boss.work` may swallow
   into a retry rather than surfacing to the test) — temporarily add a `console.error` inside the
   handler's catch path, or check `pgboss.job` for a `state = 'failed'` row with an `output` column
   after the timeout, to see if the real cause is an exception in `runModuleBuildStep` (e.g. a
   `launchLiveAgent` deps mismatch) rather than a plumbing/polling issue.

### How to re-run it

```bash
GATEDB=jarvis_gate_task19_<new-suffix>
docker exec jarv1s-postgres psql -U postgres -c "DROP DATABASE IF EXISTS $GATEDB;"
docker exec jarv1s-postgres psql -U postgres -c "CREATE DATABASE $GATEDB;"
export JARVIS_PGDATABASE=$GATEDB
pnpm test:integration tests/integration/module-build-restart.e2e.test.ts > /tmp/t19.log 2>&1; echo "EXIT=$?"
```
(`export`, never inline — see the `verify-gate` skill.) Drop the gate database when done. A
previous gate database `jarvis_gate_task19_1787349733` may still exist from this relay — drop it
too, it's stale.

### Once it passes

Commit exactly:
```bash
git add packages/jobs/src/pg-boss.ts packages/jobs/src/module-build-jobs.ts tests/integration/module-build-restart.e2e.test.ts
git commit -m "test(#1754): prove a build resumes from its persisted step after a restart"
```
(Use the `shared-checkout` skill for the actual commit — never bare `git add -A`/`git commit` in
this shared worktree.)

Task 19 is the **last task in Group C**. After it's green: run the pre-push trio
(`pnpm format:check && pnpm lint && pnpm typecheck`), rebase on `origin/main`, then
`coordinated-wrap-up` — PR + live-path proof note (this PR has no UI surface of its own, that's
#1755 — raise with the coordinator at wrap-up whether "code-complete, unverified" is the honest
status for this PR specifically, per the standing note from earlier relays).

## Reminders (unchanged from earlier relays)

- Work only in this worktree/branch; `git add` by explicit path, never `-A`.
- Never touch `docs/coordination/`, the project board, milestones, or merge — report to
  coordinator.
- Relay again at the next 70% meter warning or compaction summary. Read the plan by SECTION only.
- Pre-push trio (`pnpm format:check && pnpm lint && pnpm typecheck` + rebase on `origin/main`)
  before any push, and `coordinated-wrap-up` at the end (PR + live-path proof).
- Plain English in every message to the coordinator and in every spawn prompt — no jargon, no
  invented terms, exact names only for things Ben must act on (a command, a file, an error
  string). This is a standing rule from Ben, carried on every relay.
