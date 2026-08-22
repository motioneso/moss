# Task 19 — restart-survival proof (seam 3)

Part of #1754. Spec: `docs/superpowers/specs/2026-08-19-moss-builds-modules-on-moss.md`. Plan
section: `docs/superpowers/plans/2026-08-20-1739-stage1-workshop.md` line 1761.

Single task, no phases — this is the last task in Group C.

## What already exists (seams check, each cited)

- `MODULE_BUILD_QUEUE` and `createModuleBuildWorker` — `packages/jobs/src/module-build-jobs.ts:4,17`.
  The worker takes a `runStep: (payload) => Promise<ModuleBuildStepResult>` function; it does not
  read or write the database itself, it only decides whether to re-send the job.
- Database row functions — `packages/settings/src/module-builds-repository.ts`: `createModuleBuild`
  (`:63`, only sets `ownerUserId`/`conversationId`, always inserts `status: "planning"`),
  `getModuleBuild` (`:80`), `updateModuleBuildStatus` (`:113`, takes `status`, optional `step`).
- The resume logic — `packages/ai/src/module-build/run-build-step.ts:32` `runModuleBuildStep(deps,
build)`. It reads `build.step` (the persisted row), not the incoming job payload, which is what
  makes restart survival provable. `deps.launchLiveAgent` (`:23`) is the one piece this test fakes.
- Queue registration gap — `MODULE_BUILD_QUEUE` is missing from `FOUNDATION_QUEUES`
  (`packages/jobs/src/pg-boss.ts:37-70`, four entries, no module-build one). This is a real bug:
  without it, `resetFoundationDatabase()` never creates the queue and sending a build job fails
  today outside tests too.
- `ALLOWED_PAYLOAD_KEYS` already contains `"buildId"` and `"step"` — `packages/jobs/src/pg-boss.ts:122-123`.
  Nothing to add there.
- Precedent test pattern for a real queue + real database in this repo:
  `tests/integration/action-audit-log.test.ts:1-33` (`DataContextRunner` + `withDataContext`
  against a repository function) and `tests/integration/connectors-google-schedule-root.test.ts:47-118`
  (`createPgBossClient`, `boss.start()`, `boss.work(...)`, waiting on a resolvable promise instead
  of a helper — there is no `waitForJobToComplete` or `createTestBoss` helper in this codebase; the
  plan's Task 19 text names both and neither exists, so this plan writes the wait inline instead).

## Spec drift found, and how this plan resolves it

The plan's Task 19 test snippet (`docs/superpowers/plans/2026-08-20-1739-stage1-workshop.md:1774-1788`)
calls `createModuleBuild(db, { ownerUserId: userA.id, status: "building", step: "writing_tests" })`.
The real function only accepts `ownerUserId`/`conversationId` and always starts at
`status: "planning"`, `step: null` (`module-builds-repository.ts:28-31,63-76`). This is a small,
mechanical drift, not a fork — the test sets up its starting state with `createModuleBuild` followed
by `updateModuleBuildStatus(scopedDb, build.id, { status: "building", step: "writing_tests" })`
instead of passing status/step to `createModuleBuild`. No production signature changes.

The snippet also references `userA.id`; this codebase's fixture users are plain UUID strings
(`ids.userA` in `tests/integration/test-database.ts:35`), so the test uses `ids.userA` directly.

## Step 1 — add the missing queue

File: `packages/jobs/src/pg-boss.ts`

Add to `FOUNDATION_QUEUES` (same shape as the existing `PLATFORM_MODULE_CONTROL_QUEUE` entry,
`:62-69`):

```ts
{
  name: MODULE_BUILD_QUEUE,
  options: {
    retryLimit: 3,
    deleteAfterSeconds: 3600,
    retentionSeconds: 3600
  }
}
```

Import `MODULE_BUILD_QUEUE` from `./module-build-jobs.js`.

## Step 2 — write the failing test, then make it pass

New file: `tests/integration/module-build-restart.e2e.test.ts`

- `beforeAll`: `resetFoundationDatabase()`, `createDatabase({ connectionString:
connectionStrings.worker, maxConnections: 2 })`, `new DataContextRunner(appDb)`,
  `createPgBossClient(connectionStrings.worker)`, `boss.start()`.
- `afterAll`: `boss.stop()`, `appDb.destroy()`.
- Test body, inside `dataContext.withDataContext({ actorUserId: ids.userA, requestId: "req-1" },
async (scopedDb) => { ... })`:
  1. `const build = await createModuleBuild(scopedDb, { ownerUserId: ids.userA })`
  2. `await updateModuleBuildStatus(scopedDb, build.id, { status: "building", step:
"writing_tests" })`
  3. A local adapter `realRunModuleBuildStep = async (payload: ModuleBuildPayload) => { const row
= await getModuleBuild(scopedDb, payload.buildId); const result = await runModuleBuildStep({
launchLiveAgent: fakeLaunchLiveAgent, resolveWorkingDir: () => "/tmp/fake", recordFetchedUrl:
async () => {} }, row!); if (result.continuation) { await updateModuleBuildStatus(scopedDb,
result.continuation.buildId, { status: "building", step: result.continuation.step }); }
return result; }` — this is the "wiring" the earlier relay identified as missing everywhere
     else; it lives only in the test, matching how the spec says the real caller (Task 12-15,
     already built) is expected to compose these pieces.
  4. `fakeLaunchLiveAgent` returns `{ wroteFiles: [], testsPassing: true }` — the one faked piece.
  5. `await sendJob(boss, MODULE_BUILD_QUEUE, { actorUserId: ids.userA, buildId: build.id, step:
"writing_tests" })`.
  6. Register a worker on `boss` via `createModuleBuildWorker({ sendJob, boss, runStep:
realRunModuleBuildStep })`, `boss.work(MODULE_BUILD_QUEUE, worker)`, and wait on a resolvable
     promise that the handler resolves after `runStep` returns (same pattern as
     `connectors-google-schedule-root.test.ts:104-118`) — this proves the _first_ step ran.
  7. `await boss.stop()`; create `restartedBoss = createPgBossClient(connectionStrings.worker)`,
     `await restartedBoss.start()`.
  8. Register a second worker on `restartedBoss` the same way, `await
restartedBoss.work(MODULE_BUILD_QUEUE, worker2)`, wait for it to fire (this is the "restart":
     a fresh pg-boss connection, same database, picks up the job the first step's continuation
     re-sent).
  9. `const row = await getModuleBuild(scopedDb, build.id); expect(row!.step).toBe("writing_code")`
     — advanced past `"writing_tests"` (the next step per `nextBuildStep` in
     `run-build-step.ts:57-61`), proving the resumed step came from the database row, not from a
     restarted-from-scratch job.
  10. `await restartedBoss.stop()`.

Run: `pnpm --filter @jarvis/jobs exec vitest run ../../tests/integration/module-build-restart.e2e.test.ts`
— wait, tests live under `tests/integration`, not the package. Actual command: check
`scripts/test-integration.ts` invocation used by other e2e files in this directory (e.g. how
`module-distribution.e2e.test.ts` is run) and use the same one, scoped to this new file. Expected:
exit 0.

Commit: `git add tests/integration/module-build-restart.e2e.test.ts packages/jobs/src/pg-boss.ts`
then `git commit -m "test(#1754): prove a build resumes from its persisted step after a restart"`.

## Kill gate

None — this is the last task in Group C and does not gate further work; if the wiring above turns
out to need a production-code change beyond the queue registration (i.e. `createModuleBuildWorker`
itself needs the DB read/write, not just the test), that's a scope question for the coordinator
before continuing, not a silent expansion.

## Verification

```bash
pnpm format:check > /tmp/fmt.log 2>&1; echo "EXIT=$?"
pnpm lint > /tmp/lint.log 2>&1; echo "EXIT=$?"
pnpm typecheck > /tmp/tc.log 2>&1; echo "EXIT=$?"
```

Each expected exit 0. Full gate at wrap-up only, via the `verify-gate` skill, never run directly.
