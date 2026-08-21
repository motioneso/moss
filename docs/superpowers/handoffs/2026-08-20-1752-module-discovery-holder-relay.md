# 1752 module discovery holder — relay continuation

Spec: `docs/superpowers/specs/2026-08-19-moss-builds-modules-on-moss.md`
Plan: `docs/superpowers/plans/2026-08-20-1739-stage1-workshop.md` -> "Group A -- #1752" section only
Issue: #1752
Worktree/branch: `~/Jarv1s/.claude/worktrees/1752-module-discovery-holder`, branch `1752-module-discovery-holder`
Coordinator: Herdr pane labeled `Coordinator` (resolve fresh with `herdr pane list` -- never trust a saved pane number)
Risk tier: routine

## What "done" looks like

A module dropped into the modules folder while the API and worker are already running becomes
visible after an admin-triggered rescan, with no process restart. #1753 and #1754 will build
against the holder API landed in Task 1 below -- do not rename `getDiscoveries` / `rescan` without
flagging the coordinator first.

## Done (Task 1, committed: 70bbf6d4e)

Added the live, rescannable holder for external modules on the API side.

- `packages/module-registry/src/node.ts` -- new `createExternalModuleDiscoveryHolder()` /
  `ExternalModuleDiscoveryHolder` interface (`getDiscoveries()`, `getRejected()`, `rescan()`).
  Wraps the existing `getExternalModuleRegistrations` scan in a mutable cell. Placed here (not a
  new `external/discovery-holder.ts` file as the plan assumed) to avoid a circular import, since
  `getExternalModuleRegistrations` itself already lives directly in `node.ts`.
- `apps/api/src/server.ts` -- removed the old `discoverExternalModules()` one-time-snapshot
  wrapper; now builds one `externalModuleHolder` at boot and every downstream consumer takes
  `externalModuleHolder.getDiscoveries` (the function, not a resolved array) or calls
  `.getDiscoveries()` / `.getRejected()` at point of use.
- `apps/api/src/external-module-tools.ts`, `external-module-web-route.ts`,
  `external-module-jobs.ts` -- the three consumer functions that used to take
  `discoveries: readonly ExternalModuleDiscovery[]` now take
  `discoveries: () => readonly ExternalModuleDiscovery[]`, calling `discoveries()` at point of use
  instead of holding a stale array.
- New test `tests/unit/external-module-discovery-holder.test.ts` (this repo centralizes ALL unit
  tests under `tests/unit/` at repo root -- no colocated `*.test.ts`, no per-package test runner;
  see `external-modules-discovery.test.ts` for the existing precedent). Proves the holder returns a
  stale snapshot until `rescan()` is called, then reflects the new module.
- Fixed 4 call sites in existing tests that passed plain arrays where the new
  `() => readonly ExternalModuleDiscovery[]` signature is now expected
  (`tests/unit/external-module-jobs.test.ts`, `tests/unit/external-module-tool-preferences.test.ts`).
- Verified green: `pnpm --filter @moss/api typecheck`, `pnpm --filter @moss/module-registry typecheck`,
  and the 4 touched vitest files (7 tests, all passing).

Read the actual commit (`git show 70bbf6d4e`) for exact code rather than re-deriving from this doc.

## Left to do

**Before starting, re-verify the plan's "Group A -- #1752" section against current branch state --
don't assume it still matches; Task 1 already needed several corrections (wrong import path, wrong
test-file convention, wrong npm scope) that the plan-writer didn't anticipate.**

### Task 2 -- worker-side wiring

`apps/worker/src/worker.ts`:
- Replace the one-time
  `const discoveries = getExternalModuleRegistrations({modulesDir, reservedQueueNames}).discoveries;`
  (around line ~196-199) with a `createExternalModuleDiscoveryHolder(...)` instance (import from
  `@moss/module-registry/node`, same as Task 1's API-side usage).
- Replace the `discoveryById` Map (around line ~247) with a small lookup helper, e.g.
  ```ts
  export function buildDiscoveryLookup(
    holder: Pick<ExternalModuleDiscoveryHolder, "getDiscoveries">
  ): (id: string) => ExternalModuleDiscovery | undefined {
    return (id) => holder.getDiscoveries().find((d) => d.id === id);
  }
  ```
  Give this its own test under `tests/unit/` (follow the real convention, not a colocated file).
- Replace `externalBriefingManifests: discoveries.map(...)` with `.getDiscoveries().map(...)`.
- Fix the existing bug where `ExternalModuleJobReconciler`'s `discoveries: () => discoveries` closes
  over an already-frozen const -- change to `discoveries: externalModuleHolder.getDiscoveries`.

### Task 3 -- rescan action end to end

- `packages/jobs/src/module-jobs.ts` -- widen `ModuleControlPayload` to a discriminated union that
  adds `{ moduleId?: undefined; action: "rescan" }`; widen `assertModuleControlPayload` to match.
- Worker's `boss.work<ModuleControlPayload>(PLATFORM_MODULE_CONTROL_QUEUE, ...)` handler -- handle
  the new `"rescan"` action: call `externalModuleHolder.rescan()` then reconcile. Check whether
  `ExternalModuleJobReconciler` has a `reconcileAll()` -- if it only exposes `reconcileModule(id)`,
  add `reconcileAll()`.
- `packages/settings/src/routes-modules.ts` -- add `POST /api/admin/modules/rescan`, following the
  existing `assertAdminUser`-first pattern at that file's lines ~81-104. Should call
  `externalModuleHolder.rescan()` then `sendJob(boss, PLATFORM_MODULE_CONTROL_QUEUE, {action: "rescan"})`.

### Task 4 -- end-to-end proof

A test proving a module dropped into the modules directory while API+worker are running becomes
visible after a rescan, without a restart. Check for an existing
`apps/api/src/external-module*.e2e.test.ts` precedent first (plan's own suggestion), or this repo's
real integration convention (`tests/integration/`, run via `test:integration`; see
`tests/integration/module-distribution.e2e.test.ts`, which currently has a comment about rescan
needing a restart -- that comment goes stale once this ships, but leave it alone unless it's
directly in your way; not in scope to hunt down every stale comment).

### Wrap-up

This is a backend-only holder with no UI surface -- live-path gate does not apply (confirmed with
the coordinator's handoff). Once Task 4 is green: `coordinated-wrap-up` -- full gate on an isolated
gate DB (use the `verify-gate` skill, never run `pnpm verify:foundation` unscoped), push, open a PR
referencing #1752, and explicitly note in the PR that #1753 and #1754 depend on the holder API
(`createExternalModuleDiscoveryHolder`, `getDiscoveries`/`rescan`) landing first.

## Ground rules (carried over from the original handoff)

- Work only in this worktree/branch.
- `git add` by explicit path only -- never `-A` or `.`.
- Never touch `docs/coordination/`, the project board, or merge anything.
- No secrets anywhere.
- Plain English in every status update and escalation -- no unexplained jargon, no invented
  shorthand. Exact identifiers (commit hashes, file paths, error strings) are fine when they're
  something the reader needs to act on directly.
- Relay again on the context-meter 70% warning or the instant a compaction summary appears --
  message the coordinator, then use the `relay` skill immediately.
