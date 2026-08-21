# 1752 module discovery holder — relay 4 continuation

Spec: `docs/superpowers/specs/2026-08-19-moss-builds-modules-on-moss.md`
Plan (read from main via `git show`, NOT checked out on this branch):
`ef2fd9d74:docs/superpowers/plans/2026-08-20-1739-stage1-workshop.md` -> "Group A -- #1752"
section only, Task 3 and Task 4 subsections. Get it with:
`git show ef2fd9d74:docs/superpowers/plans/2026-08-20-1739-stage1-workshop.md > /tmp/stage1-workshop.md`
then read the Task 3 / Task 4 headings inside it (search for "### Task 3" and "### Task 4").
Issue: #1752
Worktree/branch: this worktree, branch `1752-module-discovery-holder`
Coordinator: Herdr pane labeled `Coordinator` (resolve fresh with `herdr pane list` -- never
trust a saved pane number)
Risk tier: routine

## What "done" looks like

A module dropped into the modules folder while the API and worker are already running becomes
visible after an admin-triggered rescan, with no process restart.

## Done (committed)

- **70bbf6d4e** (Task 1): the live, rescannable holder on the API side.
  `packages/module-registry/src/node.ts` -- `createExternalModuleDiscoveryHolder()` /
  `ExternalModuleDiscoveryHolder` (`getDiscoveries()`, `getRejected()`, `rescan()`).
- **7bf1a4cb2**: `apps/worker/src/external-module-discovery.ts` -- `buildDiscoveryLookup(holder)`.
- **0136b5e5d** (Task 2, this session): worker wiring is done and committed. `worker.ts` now
  builds `externalModuleHolder = createExternalModuleDiscoveryHolder(...)` at boot and derives
  `getDiscoveryById` / `listDiscoveredModuleIds` from it on every call instead of a Map built
  once. Three call sites updated (`createExternalBriefingInvoker`, the reconciler's
  `isModuleEnabled` closure, `createExternalModuleJobHandler`), plus the two files the original
  plan didn't mention: `apps/worker/src/external-module-invoke.ts` and
  `apps/worker/src/external-module-job-handler.ts` -- both now take `getDiscoveryById: (id) =>
  ExternalModuleDiscovery | undefined` and `listDiscoveredModuleIds: () => readonly string[]`
  instead of `discoveryById: ReadonlyMap<...>`. The second function only feeds a diagnostic log
  field on trust-gate rejection (kept rather than dropped, since the log's own comments describe
  a real past incident where that detail was the only way to tell "nothing staged" from "this one
  module failed to stage").
  Also fixed a real import bug found this session: `external-module-discovery.ts` was importing
  the type `ExternalModuleDiscovery` from `@moss/module-registry/node`, but that type is only
  exported from the main package entry `@moss/module-registry` (the node-only file re-exports a
  different set of modules). This didn't show up in the file's own unit test because the test
  never ran the full workspace typecheck -- only `pnpm --filter @moss/worker typecheck` catches
  it, and I only found it by running that command, not by trusting the prior session's "tested,
  green" note.
  Six test files also needed updating to the new function-based shape, three more than the
  continuation doc I inherited expected: `tests/unit/external-module-invocation-budget.test.ts`,
  `tests/unit/external-module-trust-gate-logging.test.ts`, and three integration tests found only
  by running the typecheck: `tests/integration/job-search-worker-surface.test.ts`,
  `tests/integration/job-search.test.ts`, `tests/integration/module-worker-queue-ai.test.ts`.
  All green: `pnpm --filter @moss/worker typecheck` clean, and
  `npx vitest run tests/unit/worker-external-module-discovery-lookup.test.ts
  tests/unit/external-module-invocation-budget.test.ts
  tests/unit/external-module-trust-gate-logging.test.ts` -- 26 passed. Lint clean on all touched
  files.

## Left to do

### Task 3 (resume here) -- rescan action end to end

**In progress, not committed:** `tests/unit/module-control-payload.test.ts` is written (staged
with `git add`, not committed) but the code it tests for doesn't exist yet -- this is TDD step 2,
"confirm the test fails." Run it first:
`npx vitest run tests/unit/module-control-payload.test.ts` -- expect FAIL (rescan action not
supported yet). Then implement:

- `packages/jobs/src/module-jobs.ts` -- `ModuleControlPayload` is currently
  `{ moduleId: string; action: "reconcile" }` only. Widen to a discriminated union:
  `{ readonly moduleId: string; readonly action: "reconcile" } | { readonly moduleId?: undefined; readonly action: "rescan" }`.
  Widen `assertModuleControlPayload` to accept a rescan payload (exactly one key, `action ===
  "rescan"`, no `moduleId`) alongside the existing reconcile validation. Once green, `git add
  packages/jobs/src/module-jobs.ts tests/unit/module-control-payload.test.ts` and commit as its
  own small commit.
- `apps/worker/src/worker.ts`'s `boss.work<ModuleControlPayload>(PLATFORM_MODULE_CONTROL_QUEUE,
  ...)` handler (grep for `PLATFORM_MODULE_CONTROL_QUEUE` in that file to find the current line --
  it moved slightly during Task 2's edits) -- handle the new `"rescan"` action: call
  `externalModuleHolder.rescan()` then `externalReconciler.reconcileAll()`.
  `reconcileAll()` already exists on `ExternalModuleJobReconciler`
  (`packages/module-registry/src/external/job-reconciler.ts:27`) -- do not re-add it.
- `packages/settings/src/routes-modules.ts` -- add `POST /api/admin/modules/rescan`, following the
  `assertAdminUser`-first pattern already in that file (e.g. the `/api/admin/modules/:id` PATCH
  handler). Should call `externalModuleHolder.rescan()` then enqueue a worker rescan via
  `sendModuleControl` (from `packages/jobs/src/module-jobs.ts`, once the payload type above is
  widened).
- **Real gap, not in the original plan, fix as part of this task:** in `apps/api/src/server.ts`
  around line 566-575 (grep `registerBuiltInApiRoutes` to confirm the current line -- it may have
  moved), `externalModules: { ..., discoveries: externalModuleHolder.getDiscoveries(), ... }` --
  `.getDiscoveries()` is CALLED ONCE here at server boot, so it's a frozen snapshot passed into
  `packages/settings/src/routes-modules.ts`'s `GET /api/admin/external-modules` and
  `POST /api/admin/external-modules/:id` routes (`ext.discoveries.find(...)` around
  routes-modules.ts:223) -- the admin's own module list page. Without this fix, an admin who
  clicks "rescan" would still see the stale list on that exact page until a restart, defeating the
  feature for the one user who'd use it. Fix: widen `ExternalModulesDependencies.discoveries` in
  `packages/settings/src/routes-external-module-types.ts` from
  `readonly ExternalModuleDiscovery[]` to `() => readonly ExternalModuleDiscovery[]`, update
  `routes-modules.ts`'s call site to `ext.discoveries().find(...)`, and update `server.ts`'s
  wiring to pass `externalModuleHolder.getDiscoveries` (the function, not its result). The
  coordinator was told about this finding two sessions ago; proceed with the fix regardless of an
  explicit ack since it's required for the feature's own exit criteria.
- Commit Task 3 as its own commit (or split the settings-package staleness fix into its own commit
  if that's cleaner -- either is fine).
- **Before committing anything:** run `pnpm --filter @moss/worker typecheck`, `pnpm typecheck` (or
  at minimum `pnpm --filter <affected packages> typecheck`) and the affected unit/integration
  tests. Task 2 in this session found real drift the plan didn't predict (an import bug, three
  extra test files) purely by running the actual typecheck rather than trusting an inherited
  "tested, green" note -- do the same here, don't skip straight to committing on the strength of
  a docs claim.

### Task 4 -- end-to-end proof

A test proving a module dropped into the modules directory while API+worker are running becomes
visible after a rescan, without a restart. No existing
`apps/api/src/external-module*.e2e.test.ts` precedent -- the real integration convention in this
repo is `tests/integration/`, run via `test:integration`; see
`tests/integration/external-modules-routes.test.ts` for the real pattern: boots `createApiServer`
for real against a temp modules dir and a real database via `resetEmptyFoundationDatabase()` from
`tests/integration/test-database.js`, signs up a user via the better-auth cookie flow (first
sign-up = admin), then drives routes with `server.inject`. Follow that file's setup, don't invent
a new harness. **This is a database-touching test -- do not run `test:integration` or any database
test command without the `verify-gate` skill's isolated gate database recipe; an unscoped run hits
the live dev database.**

Also check `tests/integration/module-distribution.e2e.test.ts` -- it currently has a comment about
rescan needing a restart. That comment goes stale once this ships; leave it alone unless it's
directly in your way.

### Wrap-up

Backend-only holder, no UI surface -- live-path gate does not apply (confirmed with the
coordinator's original handoff, two relays back). Once Task 4 is green: `coordinated-wrap-up` --
full gate on an isolated gate database (use the `verify-gate` skill, never run
`pnpm verify:foundation` unscoped), push, open a PR referencing #1752, and explicitly note in the
PR that #1753 and #1754 depend on the holder API (`createExternalModuleDiscoveryHolder`,
`getDiscoveries`/`rescan`) landing first.

## Ground rules (carried over -- pass these on to every handoff doc and every prompt you give to
a spawned agent)

- Work only in this worktree/branch.
- `git add` by explicit path only -- never `-A` or `.`.
- Never touch `docs/coordination/`, the project board, or merge anything.
- No secrets anywhere.
- Plain English in every status update and escalation -- no jargon, no invented shorthand. Say
  what something does, not what the repo happens to call it. Exact identifiers (commit hashes,
  file paths, error strings) are fine when the reader needs to act on them directly.
- Relay again the instant the context meter hits its 70 percent warning, or the instant a
  compaction summary appears in your own context -- no deferral. Message the coordinator first,
  then use the relay skill immediately.
- Do not rename `getDiscoveries` or `rescan` (the public API #1753 and #1754 will build against)
  without flagging the coordinator first.
- **Read the plan by section, not front-to-back.** Read this doc in full (it's short), but only
  the Task 3 / Task 4 subsections of the plan, and re-verify line numbers/assumptions against the
  actual branch before trusting them -- every session on this task so far has found real drift
  between the plan and the branch.
