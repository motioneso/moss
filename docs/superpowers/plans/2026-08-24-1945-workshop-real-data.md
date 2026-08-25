# Plan: #1945 — Workshop real data (part 1 of #1889)

Spec: `docs/specs/1945.md`. Single phase — this is deliberately the smallest useful slice of
#1889 (see spec "What this does not do").

## Seams check (file:line, verified on this branch, 2026-08-24)

- Route pattern to copy: `packages/ai/src/module-build-routes.ts:19-43`
  (`registerModuleBuildRoutes`, `AiRoutesDependencies`, `dependencies.resolveAccessContext`,
  `dependencies.dataContext.withDataContext`).
- Query fn already does the real work, owner-scoped, no extra check needed:
  `listModuleBuildsForUser` — `packages/settings/src/module-builds-repository.ts:147-159`.
- Real build row shape: `ModuleBuild` — `packages/settings/src/module-builds-repository.ts:12-25`.
- Shared contracts file to extend (not a new file): `packages/shared/src/workshop-api.ts` — has
  `moduleBuildPlanSchema` (10-29) and `approveModuleBuildResponseSchema` (62-70) already in the
  needed shape.
- Placeholder types to delete: `packages/workshop/src/web/types.ts` (whole file — invents
  `stepIndex`, `totalSteps`, `progressPercent`, `dailyLimitCents`, `log`, `approvedAt`,
  `lastRefreshedAt`, `usedByCount`, `broken`, `brokenReason`, `title`, `description` — none exist
  on the real `ModuleBuild` row or on `InstalledExternalModuleSummary`).
- Page to wire: `packages/workshop/src/web/workshop-page.tsx:22-45` (currently
  `<WorkshopGroups builds={[]} modules={[]} />`).
- Cards to rewrite: `packages/workshop/src/web/workshop-groups.tsx` (`NeedsYouCard` 23-46,
  `BuildLog`/`BuildingNowCard` 49-101, `LiveModuleRow` 103-143).
- "Live" group data: `GET /api/me/modules` already returns external modules —
  `packages/settings/src/routes-modules.ts:409-439`, DTO built by `toMyModuleDtoFromExternal`
  (`packages/settings/src/routes-serializers.ts:54-70`). Frontend caller already exists:
  `getMyModules()` — `apps/web/src/api/client.ts:381-383`.
- The "you only" vs "everyone" distinction is real data, discarded before it reaches the
  frontend today. `reconcileExternalModules` (`packages/module-registry/src/external/reconcile.ts:69-79`)
  sets `status: "draft"` + `ownerUserId` for a module active only for its builder, `status:
"enabled"` + `ownerUserId: null` once shipped. The composition root has this on hand but drops
  it: `apps/api/src/server.ts:581-594` (`listInstalledExternalModules` maps to `{ id, name,
version, hasPreferences, hasUserCredentials }` — no `status`).
- Port type to extend: `InstalledExternalModuleSummary` — declared in
  `packages/settings/src/routes-external-module-types.ts` (re-exported from `routes.ts:106-115`).
- Drift-disabled modules already go `active: false` and are excluded from the list entirely
  (`reconcile.ts` drift branch) — nothing to wire for "broken" detection; it stays out of scope.

## Decisions

1. **New route** `GET /api/ai/module-builds/mine` in `packages/ai/src/module-build-routes.ts`,
   same file and DI pattern as the approve route. Uses only `resolveAccessContext` and
   `dataContext`, both already in `AiRoutesDependencies`. Response:
   `{ builds: ModuleBuildSummary[] }`, newest first (repository already orders by
   `created_at desc`).

2. **Shared types**, added to `packages/shared/src/workshop-api.ts`:

   ```ts
   export type ModuleBuildStatus =
     | "planning" | "awaiting_plan_approval" | "building" | "awaiting_change"
     | "ready" | "failed" | "cancelled";

   export interface ModuleBuildSummary {
     readonly id: string;
     readonly status: ModuleBuildStatus;
     readonly step: string | null;
     readonly plan: ModuleBuildPlan | null;
     readonly fetchedUrls: readonly string[];
     readonly costCents: number;
     readonly error: string | null;
     readonly createdAt: string;
     readonly updatedAt: string;
   }
   export type ModuleBuildPlan = ...; // reuse the type already inferred from moduleBuildPlanSchema
                                       // if one exists in this file; otherwise add one interface,
                                       // not a duplicate of the JSON schema.
   export const listMyModuleBuildsResponseSchema = { /* object, additionalProperties: false,
     builds: array of the ModuleBuildSummary shape, nested plan mirrors moduleBuildPlanSchema */ } as const;
   export interface ListMyModuleBuildsResponse { readonly builds: readonly ModuleBuildSummary[]; }
   ```

3. **"Live" group type**, same file:

   ```ts
   export interface WorkshopLiveModuleSummary {
     readonly id: string;
     readonly name: string;
     readonly version: string;
     readonly scope: "you" | "everyone";
   }
   ```

   Built from the existing `GET /api/me/modules` response, not a new route.
   - Extend `MyModuleDto` (`packages/shared/src/platform-api-modules.ts:22-40`) with
     `readonly scope: "you" | "everyone"`.
   - `toMyModuleDto` (built-in branch, `routes-serializers.ts`): `scope: "everyone"` always (a
     built-in module is never private).
   - `toMyModuleDtoFromExternal` (`routes-serializers.ts:54-70`): `scope: module.status ===
"draft" ? "you" : "everyone"` — needs `status` added to `InstalledExternalModuleSummary`.
   - Extend `InstalledExternalModuleSummary` with `readonly status: "draft" | "enabled"` (only
     these two values ever reach this already-filtered list).
   - Extend the composition-root map (`apps/api/src/server.ts:581-594`) to pass `status:
module.status` through (the raw `module` there already has it — no new query).
   - Workshop page filters the existing `/api/me/modules` result to `lifecycle === "optional"`
     (external modules only) and maps to `WorkshopLiveModuleSummary`.

4. **Delete** `packages/workshop/src/web/types.ts`; update its two importers
   (`workshop-page.tsx`, `workshop-groups.tsx`) to import `ModuleBuildSummary`,
   `WorkshopLiveModuleSummary` from `@moss/shared`.

5. **`workshop-page.tsx`**: replace the hardcoded `[]`/`[]` with two `useQuery` calls — one
   hitting `GET /api/ai/module-builds/mine` via `requestJson` (same helper already used for
   `/api/me` on this page), one calling `requestJson<{modules: MyModuleDto[]}>("/api/me/modules")`
   the same direct way (this package does not import the web app's `client.ts` — keep that
   boundary). Filter the modules response to `lifecycle === "optional"` before mapping to
   `WorkshopLiveModuleSummary`.

6. **`workshop-groups.tsx`** rewrite, real fields only:
   - `NeedsYouCard`: title = `build.plan?.whatItDoes ?? "New module"`, meta =
     `build.plan?.whenItRuns ?? null`. Buttons stay visual-only (button wiring is out of scope,
     per spec).
   - `BuildingNowCard`: drop `stepIndex`/`totalSteps`/`progressPercent` (no such fields). Replace
     `BuildLog` (took `ModuleBuildLogEntry[]`) with a plain list over `build.fetchedUrls` (one
     `<li>` per URL). Replace the daily-limit line with `build.plan?.roughCost.budgetCents` when
     the plan is present, else omit the spend line entirely.
   - `LiveModuleRow`: drop `description`/`broken`/`brokenReason` (no such fields; drift-disabled
     modules never reach this list — see seams). Render `mod.name` and a single "Live · you only"
     / "Live · everyone" badge from `mod.scope`. Keep the two non-wired buttons visual-only.

## Test cases (written first)

- `packages/ai/src/module-build-routes.test.ts` (new): `GET /api/ai/module-builds/mine` returns
  only the caller's own builds — seed two owners' builds, assert the response has exactly the
  requesting user's rows and none of the other owner's. This is what proves "no extra check
  needed" rather than assuming it.
- `packages/settings/src/routes-serializers.test.ts` (new, or extend if one exists next to
  `routes-serializers.ts` — check first): `toMyModuleDtoFromExternal` returns `scope: "you"` for
  a `status: "draft"` input and `scope: "everyone"` for `status: "enabled"`; `toMyModuleDto`
  (built-in) always returns `scope: "everyone"`.
- `packages/workshop/src/web/workshop-groups.test.tsx` (new): given a `ModuleBuildSummary` with
  `plan: null` (still planning), `NeedsYouCard`/`BuildingNowCard` render without throwing and
  without showing any placeholder text that isn't backed by real data.

## Live end-to-end proof (this phase's e2e test)

Extend the existing live proof pattern at `tests/live/workshop-1888-uat.spec.ts` (which already
signs in, opens chat, and gets a plan card) into a new `tests/live/workshop-1945-uat.spec.ts`:
sign in, ask Moss to build a module, click "Build it" on the resulting plan card, then navigate to
`/workshop` and assert:

- the build appears in a "Building now" or "Needs you" group (not the empty state), and
- if the account already has an external module installed, at least one "Live" row renders with a
  real "Live · you only" or "Live · everyone" badge (skip this assertion if none exist — do not
  invent one).

Run against the live dev instance (per `docs/DEVELOPMENT_STANDARDS.md` → Live-Path Gate), output
and exit code posted as the PR's `LIVE-PATH PROOF` comment.

## Verification (unpiped, exit code checked, expect 0)

```bash
pnpm --filter @moss/ai test -- module-build-routes > /tmp/1945-ai-test.log 2>&1; echo "EXIT=$?"
pnpm --filter @moss/settings test -- routes-serializers > /tmp/1945-settings-test.log 2>&1; echo "EXIT=$?"
pnpm --filter @moss/workshop test > /tmp/1945-workshop-test.log 2>&1; echo "EXIT=$?"
pnpm format:check > /tmp/1945-format.log 2>&1; echo "EXIT=$?"
pnpm lint > /tmp/1945-lint.log 2>&1; echo "EXIT=$?"
pnpm typecheck > /tmp/1945-typecheck.log 2>&1; echo "EXIT=$?"
```

Full gate (`pnpm verify:foundation`) only through the `verify-gate` skill, not run directly.

## Kill gate

If the new `GET /api/ai/module-builds/mine` route cannot be exercised live (dev instance
unreachable, or the route errors against real data) after one focused debugging pass, stop and
report **code-complete, unverified** in the PR rather than spending further budget chasing it.
Owner of this call: whoever is building this lane.

## Determinism boundary

No model output reaches this page. Every field the page shows comes from a database row written
by the build job or the module registry, read back through a plain REST route — never from a
model turn at render time. This phase adds no new model call.

## Out of scope (confirmed against the spec, not re-litigated here)

Navigate-after-approval, polling + notifications, and Stop / Ask-for-a-change / Turn-on-for-
everyone button wiring are #1889 gaps 2-4, tracked as a separate piece. Do not build them here.
