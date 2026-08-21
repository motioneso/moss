# 1752 module discovery holder — relay 3 continuation

Spec: `docs/superpowers/specs/2026-08-19-moss-builds-modules-on-moss.md`
Plan (read from main via `git show`, NOT checked out on this branch — see note below):
`ef2fd9d74:docs/superpowers/plans/2026-08-20-1739-stage1-workshop.md` -> "Group A -- #1752"
section only.
Issue: #1752
Worktree/branch: this worktree, branch `1752-module-discovery-holder`
Coordinator: Herdr pane labeled `Coordinator` (resolve fresh with `herdr pane list` -- never
trust a saved pane number)
Risk tier: routine

**The plan file is not on this branch.** It was committed to main (`ef2fd9d74`) after this
branch's history diverged. Read it with:
`git show ef2fd9d74:docs/superpowers/plans/2026-08-20-1739-stage1-workshop.md > /tmp/stage1-workshop.md`
then read lines 78-552 (the Group A section) from that temp file. Do not try to open the path
directly on this branch -- it does not exist here.

## What "done" looks like

A module dropped into the modules folder while the API and worker are already running becomes
visible after an admin-triggered rescan, with no process restart.

## Done (committed)

- **70bbf6d4e** (Task 1): the live, rescannable holder on the API side.
  `packages/module-registry/src/node.ts` -- `createExternalModuleDiscoveryHolder()` /
  `ExternalModuleDiscoveryHolder` (`getDiscoveries()`, `getRejected()`, `rescan()`). The plan
  assumed this would start in `apps/api/src/` and later move to the shared package -- it was
  already placed directly in the shared package the first time, so **that move is not a separate
  step any more; skip it.** `apps/api/src/server.ts` builds one `externalModuleHolder` at boot;
  the three consumer functions in `external-module-tools.ts`, `external-module-web-route.ts`,
  `external-module-jobs.ts` now take `discoveries: () => readonly ExternalModuleDiscovery[]`.
- **7bf1a4cb2** (this session): `apps/worker/src/external-module-discovery.ts` --
  `buildDiscoveryLookup(holder)` returns a function that re-reads `holder.getDiscoveries()` on
  every call, replacing the worker's old frozen `Map`. Tested in
  `tests/unit/worker-external-module-discovery-lookup.test.ts` (green). **Not yet wired into
  `apps/worker/src/worker.ts`** -- that file is untouched; a partial import-only edit was made and
  reverted this session because it left unused imports and a still-referenced deleted function.
  Start the wiring fresh.

## Left to do

### Task 2 (resume here) -- wire the worker

In `apps/worker/src/worker.ts`:
1. Import `createExternalModuleDiscoveryHolder` from `@moss/module-registry/node` (alongside the
   existing `ExternalModuleJobReconciler`, `ExternalModuleWorkerRuntime`, `resolveModulesDir` --
   remove `getExternalModuleRegistrations` from that same import, it's being replaced) and
   `buildDiscoveryLookup` from `./external-module-discovery.js`.
2. Around line 196-201: replace
   `const discoveries = getExternalModuleRegistrations({modulesDir, reservedQueueNames}).discoveries;`
   with `const externalModuleHolder = createExternalModuleDiscoveryHolder({modulesDir: externalConfig.modulesDir, reservedQueueNames});`
3. Around line 249: replace `const discoveryById = new Map(discoveries.map(...))` with
   `const getDiscoveryById = buildDiscoveryLookup(externalModuleHolder);`
4. **Three call sites use `discoveryById`, not one -- the plan only mentions the first:**
   - Line ~269: `createExternalBriefingInvoker({ discoveryById, ... })`
   - Line ~311: inline in `ExternalModuleJobReconciler`'s `isModuleEnabled` closure --
     `discoveryById.get(moduleId)`
   - Line ~339: `createExternalModuleJobHandler({ discoveryById, ... })`
   All three need to change from passing the Map to passing `getDiscoveryById` and calling it as
   a function (`getDiscoveryById(id)` instead of `discoveryById.get(id)`).
5. **That cascades into two more files the plan does not mention at all:**
   - `apps/worker/src/external-module-invoke.ts` -- `VerifiedExternalModuleInvokerDeps.discoveryById`
     is typed `ReadonlyMap<string, ExternalModuleDiscovery>` and used at
     `deps.discoveryById.get(args.moduleId)` (~line 157) and `[...deps.discoveryById.keys()]`
     (~line 160, for a rejection log's `discovered` field). Change the field to
     `getDiscoveryById: (id: string) => ExternalModuleDiscovery | undefined` and the `.get(...)`
     call to a function call. For the `.keys()` log field: either drop it, or add a second small
     injected function if the log detail is worth keeping -- your call, it's diagnostic-only, not
     load-bearing behavior.
   - `apps/worker/src/external-module-job-handler.ts` -- `ExternalModuleJobHandlerDeps.discoveryById`
     (~line 140) is just a straight pass-through to `createVerifiedExternalModuleInvoker` (~line 186).
     Same rename, same pass-through.
   - **Existing tests reference the old shape and WILL need updating:**
     `tests/unit/external-module-invocation-budget.test.ts:455` (`discoveryById: new Map(...)`),
     `tests/unit/external-module-trust-gate-logging.test.ts:94,130,134,191` (constructs
     `discoveryById: new Map(...)` and asserts a `discovered: []` field on the rejection log --
     check whether that assertion still holds once you decide what to do with the `.keys()` log
     detail above).
6. Around line 302: replace `externalBriefingManifests: discoveries.map((module) => module.manifest)`
   with `externalModuleHolder.getDiscoveries().map((module) => module.manifest)`.
7. Around line 308: fix `discoveries: () => discoveries` (closes over the frozen const -- a real
   bug the plan calls out) to `discoveries: externalModuleHolder.getDiscoveries`.
8. Run `pnpm --filter @moss/worker typecheck` then the worker's vitest suite
   (`pnpm vitest run tests/unit/ -- worker` or whatever this repo's per-package filter is -- check
   `package.json` scripts, don't guess) before committing.
9. Commit Task 2 as its own commit.

### Task 3 -- rescan action end to end

- `packages/jobs/src/module-jobs.ts` -- `ModuleControlPayload` is currently
  `{ moduleId: string; action: "reconcile" }` only (verified still true this session). Widen to a
  discriminated union adding `{ moduleId?: undefined; action: "rescan" }`; widen
  `assertModuleControlPayload` to match. No existing test file for this -- this repo centralizes
  unit tests under `tests/unit/` at repo root (see `tests/unit/external-module-jobs.test.ts` for
  the naming precedent for jobs-package tests); create
  `tests/unit/module-control-payload.test.ts` or similar, don't invent a package-local
  `packages/jobs/src/module-jobs.test.ts` (the plan suggests that path -- it's wrong, same mistake
  Task 1's plan made about test file locations).
- `apps/worker/src/worker.ts`'s `boss.work<ModuleControlPayload>(PLATFORM_MODULE_CONTROL_QUEUE, ...)`
  handler (~line 359, verified this session) -- handle the new `"rescan"` action: call
  `externalModuleHolder.rescan()` then `externalReconciler.reconcileAll()`.
  **`reconcileAll()` already exists** on `ExternalModuleJobReconciler`
  (`packages/module-registry/src/external/job-reconciler.ts:27`) -- the plan says "check whether it
  exists, add it if not"; it exists, skip that step.
- `packages/settings/src/routes-modules.ts` -- add `POST /api/admin/modules/rescan`, following the
  `assertAdminUser`-first pattern already in that file (e.g. the `/api/admin/modules/:id` PATCH
  handler). Should call `externalModuleHolder.rescan()` then enqueue a worker rescan via
  `sendJob`/`sendModuleControl` (check `packages/jobs/src/pg-boss.ts` and `module-jobs.ts` for the
  right helper once the payload type above is widened).
- **Real gap found this session, not in the plan, fix as part of this task:** in
  `apps/api/src/server.ts` around line 566-575, `registerBuiltInApiRoutes` is passed
  `externalModules: { enabled: true, discoveries: externalModuleHolder.getDiscoveries(), rejected: externalModuleHolder.getRejected(), reconcile: ... }`
  -- `.getDiscoveries()` is CALLED ONCE here, at server boot, so this is a frozen snapshot, not a
  live read. This object flows into `packages/settings/src/routes-modules.ts`'s
  `GET /api/admin/external-modules` and `POST /api/admin/external-modules/:id` routes (`ext.discoveries.find(...)`
  at routes-modules.ts:223), which is the admin's own module list page. Without a fix, an admin
  who clicks "rescan" would still see the old list on that page until a process restart --
  defeating the point of the feature for exactly the user who'd use it. Fix: widen
  `ExternalModulesDependencies.discoveries` in
  `packages/settings/src/routes-external-module-types.ts` from
  `readonly ExternalModuleDiscovery[]` to `() => readonly ExternalModuleDiscovery[]` (same pattern
  as the three consumers Task 1 already converted), update `routes-modules.ts`'s one call site
  (`ext.discoveries.find(...)` -> `ext.discoveries().find(...)`), and update server.ts's wiring to
  pass `externalModuleHolder.getDiscoveries` (the function) instead of calling it. Coordinator was
  told about this finding this session (message sent, not yet acknowledged as of this handoff --
  check for a reply before assuming silent agreement, but proceed with the fix regardless since it's
  required for the feature's own exit criteria, not a discretionary extra).
- Commit Task 3 as its own commit (or split further if it's cleaner to land the settings-package
  staleness fix separately from the new route -- either is fine, just keep commits green).

### Task 4 -- end-to-end proof

A test proving a module dropped into the modules directory while API+worker are running becomes
visible after a rescan, without a restart. Check for an existing
`apps/api/src/external-module*.e2e.test.ts` precedent (none found as of this session's grounding
pass -- the real integration convention in this repo is `tests/integration/`, run via
`test:integration`; see `tests/integration/external-modules-routes.test.ts` for the real pattern:
boots `createApiServer` for real against a temp modules dir and a real database via
`resetEmptyFoundationDatabase()` from `tests/integration/test-database.js`, signs up a user via
the better-auth cookie flow (first sign-up = admin), then drives routes with `server.inject`.
Follow that file's setup, don't invent a new harness. **This is a DB-touching test -- do not run
`test:integration` or any DB test command without the `verify-gate` skill's isolated gate DB
recipe; an unscoped run hits the live dev database.**

Also check `tests/integration/module-distribution.e2e.test.ts` -- it currently has a comment about
rescan needing a restart. That comment goes stale once this ships; leave it alone unless it's
directly in your way, not in scope to hunt down every stale comment.

### Wrap-up

Backend-only holder, no UI surface -- live-path gate does not apply (confirmed with the
coordinator's original handoff). Once Task 4 is green: `coordinated-wrap-up` -- full gate on an
isolated gate DB (use the `verify-gate` skill, never run `pnpm verify:foundation` unscoped), push,
open a PR referencing #1752, and explicitly note in the PR that #1753 and #1754 depend on the
holder API (`createExternalModuleDiscoveryHolder`, `getDiscoveries`/`rescan`) landing first.

## Ground rules (carried over)

- Work only in this worktree/branch.
- `git add` by explicit path only -- never `-A` or `.`.
- Never touch `docs/coordination/`, the project board, or merge anything.
- No secrets anywhere.
- Plain English in every status update and escalation -- no jargon, no invented shorthand. Exact
  identifiers (commit hashes, file paths, error strings) are fine when the reader needs to act on
  them directly.
- Relay again on the context-meter 70% warning or the instant a compaction summary appears --
  message the coordinator, then use the `relay` skill immediately.
- **Read the plan by section, not front-to-back.** Read this doc in full (it's short), but only
  the Group A section of the plan, and re-verify line numbers/assumptions against the actual
  branch before trusting them -- both this session and the one before it found real drift.
