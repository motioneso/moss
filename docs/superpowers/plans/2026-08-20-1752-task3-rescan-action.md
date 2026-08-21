# 1752 Task 3 — rescan action end to end

Spec: `docs/superpowers/specs/2026-08-19-moss-builds-modules-on-moss.md`
Issue: #1752 (Part of #1752)
Risk tier: routine
Scope: only Task 3 (rescan action, plus the settings staleness gap found in relay 3). Task 4
(e2e proof) is a separate follow-up plan once this lands.

## Seams check (file:line, verified on this branch just now)

- Holder already exists and is rescannable: `packages/module-registry/src/node.ts:181-215` —
  `ExternalModuleDiscoveryHolder.rescan(): Promise<ExternalModuleLoadResult>`,
  `getDiscoveries()`, `getRejected()`.
- Worker already builds the holder and a reconciler with `reconcileAll()`:
  `apps/worker/src/worker.ts` (holder built earlier in the file per relay-3 commit 0136b5e5d);
  `ExternalModuleJobReconciler.reconcileAll()` exists at
  `packages/module-registry/src/external/job-reconciler.ts:27` — do not re-add it.
- Worker's control-queue handler is at `apps/worker/src/worker.ts:362-366` (`boss.work<ModuleControlPayload>(PLATFORM_MODULE_CONTROL_QUEUE, ...)`), immediately followed by `await externalReconciler.reconcileAll()` at line ~367 (existing boot-time call, unrelated to this task — do not remove it).
- `ModuleControlPayload` / `assertModuleControlPayload` live in `packages/jobs/src/module-jobs.ts:16-42`, currently reconcile-only.
- Settings admin routes already follow an assertAdminUser-first pattern:
  `packages/settings/src/routes-modules.ts:112-168` (PATCH `/api/admin/modules/:id`) and
  `packages/settings/src/routes-modules.ts:200-260` (POST `/api/admin/external-modules/:id`).
- Settings already sends worker signals through an injected callback, never a direct pg-boss
  call from a route body: `packages/settings/src/routes.ts:150-154`
  (`reconcileExternalModuleJobs?`), wired in `apps/api/src/server.ts:598-607`. Settings already
  imports runtime code (not just types) from `@moss/jobs` elsewhere — e.g.
  `packages/settings/src/data-export-schedule.ts:2` (`assertMetadataOnlyPayload`) — so a route
  file importing `sendModuleControl` directly is consistent with existing precedent, not a new
  pattern.
- Settings already carries `boss?: PgBoss` as an optional dependency, used directly by
  `registerDataExportAsyncRoutes` in `packages/settings/src/routes.ts:289-295` — the same shape
  this task needs for enqueueing a rescan control message.
- **Confirmed staleness gap, wider than the inherited continuation doc described.** The
  `ExternalModulesDependencies.discoveries` field
  (`packages/settings/src/routes-external-module-types.ts:58`) is a frozen array, not a getter.
  Three read sites, not the two the continuation doc named:
  - `packages/settings/src/routes-modules.ts:223` (`ext.discoveries.find(...)`)
  - `packages/settings/src/routes-module-registry.ts:69` (`(ext?.discoveries ?? []).map(...)`)
  - `packages/settings/src/routes-module-credentials.ts:58` (`ext.discoveries.find(...)`)
    All three must move to calling `ext.discoveries()` once the field becomes a function, or the
    package fails to typecheck.
- The only producer of `ExternalModulesDependencies` is `apps/api/src/server.ts:572`
  (`discoveries: externalModuleHolder.getDiscoveries()` — called once, frozen). This is the one
  production wiring line to fix.
- Test-only producers of `ExternalModulesDependencies` that construct `discoveries` as an array
  literal and must become a thunk: `tests/integration/module-enablement.test.ts:533-544`. (All
  other repo-wide `discoveries:` fixtures found by `grep -rn "discoveries:"` already use the
  `() => [...]` shape for other dependency types — job-reconciler's, worker's,
  `external-module-web-route.ts`'s — those are unrelated interfaces already function-shaped and
  need no change.)

## Decisions

### 1. `packages/jobs/src/module-jobs.ts`

Widen the payload type and its guard:

```ts
export type ModuleControlPayload =
  | { readonly moduleId: string; readonly action: "reconcile" }
  | { readonly moduleId?: undefined; readonly action: "rescan" };
```

`assertModuleControlPayload`: accept exactly one shape —

- `{ moduleId, action: "reconcile" }` with `moduleId` matching the existing slug pattern
  (2 keys), OR
- `{ action: "rescan" }` with no `moduleId` key at all (1 key).
  Reject anything else (extra keys, `moduleId` present with `action: "rescan"`, unknown action,
  non-object). This is exactly what `tests/unit/module-control-payload.test.ts` (already committed
  in `ef20ea006`) asserts.

Test: `npx vitest run tests/unit/module-control-payload.test.ts` — all 6 cases pass.
Commit: own commit, `git add packages/jobs/src/module-jobs.ts` (test file already committed).

### 2. `apps/worker/src/worker.ts` — control-queue handler

Extend the existing `boss.work<ModuleControlPayload>(PLATFORM_MODULE_CONTROL_QUEUE, ...)` handler
(current body: `assertModuleControlPayload(job.data); await reconciler.reconcileModule(job.data.moduleId);`)
to branch on `job.data.action`:

- `"reconcile"` → existing behavior unchanged (`reconciler.reconcileModule(job.data.moduleId)`).
- `"rescan"` → `await externalModuleHolder.rescan(); await reconciler.reconcileAll();` (both
  already exist; call in that order so reconciliation sees the fresh discovery list).

No new test file for this — covered by Task 4's end-to-end integration test (queues a rescan
control message and observes a newly-dropped module become active). Verify with
`pnpm --filter @moss/worker typecheck`.

### 3. `packages/settings/src/routes-external-module-types.ts`

- `ExternalModulesDependencies.discoveries`: `readonly ExternalModuleDiscovery[]` →
  `() => readonly ExternalModuleDiscovery[]`.
- Add `rescan?: () => Promise<void>` to the same interface (optional, same style as
  `moduleDistribution?`, so deployments without the holder wired degrade rather than crash —
  matches every other optional port in this file).

### 4. Call-site updates (settings package, forced by the type change)

- `packages/settings/src/routes-modules.ts:223`: `ext.discoveries.find(...)` →
  `ext.discoveries().find(...)`.
- `packages/settings/src/routes-module-registry.ts:69`: `(ext?.discoveries ?? [])` →
  `(ext?.discoveries() ?? [])`.
- `packages/settings/src/routes-module-credentials.ts:58`: `ext.discoveries.find(...)` →
  `ext.discoveries().find(...)`.

### 5. New route — `packages/settings/src/routes-modules.ts`

`POST /api/admin/modules/rescan`, placed alongside the other `/api/admin/...` module routes,
same shape as the existing admin handlers (assertAdminUser first, no request body):

```ts
server.post(
  "/api/admin/modules/rescan",
  { schema: rescanExternalModulesRouteSchema },
  async (request, reply) => {
    try {
      const accessContext = await dependencies.resolveAccessContext(request);
      await dependencies.dataContext.withDataContext(accessContext, async (scopedDb) => {
        await assertAdminUser(repository, scopedDb, accessContext.actorUserId);
      });
      const ext = dependencies.externalModules;
      await ext?.rescan?.();
      if (dependencies.boss) {
        await sendModuleControl(dependencies.boss, { action: "rescan" });
      }
      return { ok: true };
    } catch (error) {
      return handleRouteError(error, reply);
    }
  }
);
```

Import `sendModuleControl` from `@moss/jobs` at the top of `routes-modules.ts`.

New schema in `packages/shared/src/platform-api-modules.ts` (re-exported via `platform-api.ts`
already doing `export *`):

```ts
export const rescanExternalModulesRouteSchema = {
  response: {
    200: {
      type: "object",
      additionalProperties: false,
      required: ["ok"],
      properties: { ok: { type: "boolean" } }
    },
    401: errorResponseSchema,
    403: errorResponseSchema
  }
} as const;
```

### 6. `apps/api/src/server.ts` — wire the fix + the new dependency

At the `externalModules: { ... }` block passed into `registerBuiltInApiRoutes` (currently around
line 566-576):

- `discoveries: externalModuleHolder.getDiscoveries()` → `discoveries: externalModuleHolder.getDiscoveries` (pass the function, drop the call).
- add `rescan: () => externalModuleHolder.rescan().then(() => undefined)`.

No other call site in `server.ts` needs a change — every other `discoveries:` wiring already
passes `externalModuleHolder.getDiscoveries` (the function) per the seams check above.

### 7. Test fixture update

`tests/integration/module-enablement.test.ts:533-544`: `discoveries: [...]` literal →
`discoveries: () => [...]` (same array contents, wrapped in a thunk).

## Verification (Task 3 exit)

Run each unpiped, record the exit code:

```bash
npx vitest run tests/unit/module-control-payload.test.ts > /tmp/1752-t3-a.log 2>&1; echo "EXIT=$?"
# expect EXIT=0, 6 passed

pnpm --filter @moss/worker typecheck > /tmp/1752-t3-b.log 2>&1; echo "EXIT=$?"
# expect EXIT=0

pnpm --filter @moss/settings typecheck > /tmp/1752-t3-c.log 2>&1; echo "EXIT=$?"
# expect EXIT=0

pnpm --filter @moss/shared typecheck > /tmp/1752-t3-d.log 2>&1; echo "EXIT=$?"
# expect EXIT=0

pnpm typecheck > /tmp/1752-t3-e.log 2>&1; echo "EXIT=$?"
# expect EXIT=0 (catches apps/api wiring + the module-enablement.test.ts fixture)

npx vitest run tests/integration/module-enablement.test.ts > /tmp/1752-t3-f.log 2>&1; echo "EXIT=$?"
# expect EXIT=0 -- NOTE: database-touching, only run via the verify-gate skill's isolated
# gate database, never against the live dev database.
```

Lint the touched files (`pnpm lint` scoped, or full `pnpm lint` if cheap) before committing.

## Kill gate

None applicable — this is a small, already-scoped continuation task inside an approved milestone
(#1752), not a new fork. If typecheck surfaces a fourth undiscovered `discoveries` call site or a
structural conflict with `sendModuleControl`'s existing usage, stop and escalate to the
coordinator rather than improvising a workaround.

## Commits

1. `packages/jobs/src/module-jobs.ts` (+ the already-committed test, re-add to this commit's
   diff only if it needs edits; otherwise it stays as-is from `ef20ea006`).
2. `packages/settings/src/routes-external-module-types.ts`,
   `packages/settings/src/routes-modules.ts`, `packages/settings/src/routes-module-registry.ts`,
   `packages/settings/src/routes-module-credentials.ts`, `packages/shared/src/platform-api-modules.ts`,
   `apps/worker/src/worker.ts`, `apps/api/src/server.ts`,
   `tests/integration/module-enablement.test.ts` — the rescan action end to end. One commit
   unless typecheck/test iteration makes a split cleaner.
