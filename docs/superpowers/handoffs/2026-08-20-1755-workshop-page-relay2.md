# Relay 2: #1755 Workshop page

Context hit the 70% warning during grounding again, before anything was tested/committed. Per the
relay rule: nothing was green yet, so nothing is committed — but the scaffolding files below
already exist on disk in this same worktree (untracked, not committed). Next session should verify
them, not recreate them from scratch.

Read first (still valid, don't re-derive):
- `docs/superpowers/handoffs/2026-08-20-1755-workshop-page-relay.md` — original grounding (module
  file layout, jds-* classes confirmed present, admin-gating plan, test harness convention).
- `docs/coordination/handoff-1755-workshop-page.md` — exit criteria and bans (fetch via
  `git show d04251c05:docs/coordination/handoff-1755-workshop-page.md`, it lives on branch
  `coord-1258-postmerge`, NOT in this worktree's tree — that's normal, don't investigate it).
- Plan Group D: `git show origin/plan/1739-stage1-workshop:docs/superpowers/plans/2026-08-20-1739-stage1-workshop.md`
  from "# Group D — #1755" to "# Group E" (line 1803-1978 currently).

Mockup: `docs/superpowers/specs/assets/2026-08-19-moss-workshop/workshop.html` (read in full,
already reflected in the files below).

## What's on disk right now (untracked, uncommitted, NOT yet tested)

- `packages/workshop/package.json` — mirrors sports' shape, deps trimmed to what workshop actually
  needs (module-sdk, module-web-sdk, shared, react-query, lucide-react, react). No fastify/kysely/pg
  — correct, since `routes: []` and no backend this pass.
- `packages/workshop/src/manifest.ts` — `WORKSHOP_MODULE_ID = "workshop"`,
  `workshopModuleManifest` with `lifecycle: "required"`, `availability.required: true` (copied
  Settings' shape since Workshop is core, not user-toggleable — reconsider if that's wrong, wasn't
  explicitly decided, my own judgment call under time pressure), one nav entry (`path: "/workshop"`,
  `icon: "wrench"`, `order: 900`, `permissionId: "workshop.view"`), one admin-scope permission
  `workshop.view` (mirrors `packages/settings/src/manifest.ts` `settings.manage` at line ~109),
  `routes: []`.
- `packages/workshop/src/index.ts` — re-exports id + manifest only (no routes/tools to export yet).
- `packages/workshop/src/web/types.ts` — stub `ModuleBuildStatus`, `ModuleBuildLogEntry`,
  `ModuleBuildSummary`, `ExternalModuleSummary` types, per the plan's Task 21 description + what
  the mockup needs to render (cost, step, log entries, progress percent, badge scope, broken
  reason). These are local placeholders only, per the original relay's stub instruction — do not
  wire them to any real endpoint this pass.

## NOT yet created — pick up here, in order

1. **`packages/workshop/src/web/workshop-groups.tsx`** (Task 21 component) and
   **`packages/workshop/src/web/workshop-page.tsx`** (Task 20 container) — neither exists yet.
   `workshop-page.tsx` renders `PageHeader` (eyebrow "Modules" + `jds-display--md` "The workshop" +
   lede) then `<WorkshopGroups builds={[]} modules={[]} />` for now (container wires real data only
   once #1752/#1753 land — explicitly deferred, say so in the PR). Use `EmptyState` from
   `@moss/ui` for the true nothing-anywhere-yet case (`packages/ui/src/empty-state.tsx`, already
   read — takes `icon`/`title`/`description`, renders `jds-empty` classes, no local wrapper needed
   this time since sports/news's local wrappers don't add anything workshop needs).
2. **`packages/workshop/src/web/workshop.css`** — layout-only module CSS (column ~920px), imported
   by workshop-page.tsx like `packages/sports/src/web/sports-page.tsx` imports its css. Do NOT
   invent new `jds-*` classes — the primitives needed are already confirmed present (see original
   relay doc's full list); this file only holds page/row layout, no color.
3. **`packages/workshop/src/web/index.tsx`** — `ModuleWebContribution` default export, copy
   `packages/sports/src/web/index.tsx`'s shape exactly: `moduleId: "workshop"`, one route
   `{ path: "/workshop", title: "The workshop", icon: "wrench", order: 900, element: <WorkshopPage /> }`.
   Literal values, not imported from manifest.ts (browser-safety rule — manifest.ts is fine to
   import here since it's pure/no node builtins, but sports.ts deliberately duplicates literals
   instead; follow that same defensive pattern for consistency, `tests/unit/module-web-scanner.test.ts`
   asserts the literals match the manifest).
4. **Failing test first**, `tests/unit/workshop-page.test.tsx` — copy the harness from
   `tests/unit/sports-page.test.tsx` lines 1-20 (renderToString + QueryClientProvider, no
   jsdom/testing-library anywhere in this repo, deliberately). Assert: renders without throwing
   given no builds/modules (empty state path). Run it, confirm it fails (module doesn't exist),
   then write workshop-page.tsx/workshop-groups.tsx/index.tsx/workshop.css above, run again, confirm
   pass, commit:
   `feat(#1755): scaffold the Workshop first-party module and page`
   (this commit should include package.json/manifest.ts/index.ts/types.ts too — they're currently
   unverified, so typecheck+test them as part of this same commit, don't commit them separately
   pre-verification).
5. **`tests/unit/workshop-groups.test.tsx`** (Task 21) — one build with `status: "building"` shows
   under "Building now" with its `step` text; assert only `jds-*` class names appear (grep the
   rendered HTML for `jds-` and diff against the confirmed-present list in the original relay doc,
   as a cheap pre-check before the real audit). Commit:
   `feat(#1755): render the Workshop's Needs you / Building now / Live groups`
6. **Register in `packages/module-registry/src/index.ts`**: add
   `import { workshopModuleManifest } from "@moss/workshop";` near the sports/news imports
   (~line 260-278), add `{ manifest: workshopModuleManifest, sqlMigrationDirectories: [], queueDefinitions: [] }`
   to the `BUILT_IN_MODULES` array (~line 1117+, weather/sports/news entries are right there for
   shape reference — weather's is the smallest, no externalSources).
   Add `"@moss/workshop": "workspace:*"` to `packages/module-registry/package.json` dependencies
   (mirrors its sports/news/weather lines) and to `apps/web/package.json` dependencies (mirrors its
   `@moss/sports` line ~22 — needed because app-shell.tsx imports `WORKSHOP_MODULE_ID` from
   `@moss/workshop` directly, confirmed apps/web depends directly on @moss/sports today even
   though nothing currently imports from it there, so this is the established pattern to follow).
   Add to root `tsconfig.json` `paths`: `"@moss/workshop":["packages/workshop/src/index.ts"]` and
   `"@moss/workshop/web":["packages/workshop/src/web/index.tsx"]` (same object as the existing
   `@moss/sports/web` entry, single-line JSON, no line breaks in that file).
7. **Admin-gating in `apps/web/src/shell/app-shell.tsx`**:
   - Import `WORKSHOP_MODULE_ID` from `@moss/workshop` (top imports, near line 62-68's `@moss/shared`
     type-only import block — this one's a value import, keep separate).
   - Add a `useMemo` filtering `props.modules` to drop the entry whose `id === WORKSHOP_MODULE_ID`
     when `!props.me.user.isInstanceAdmin`, feed that filtered array into `buildShellNavigation` at
     line ~256 (currently `buildShellNavigation(props.modules, ...)`) — ONLY that call site. Do not
     touch line ~307 (`resolvePageHeading`) or line ~425 (`CommandPalette`) — original relay doc
     scoped the gating to sidebar nav + page-level defense only, don't expand scope.
   - Page-level defense inside `workshop-page.tsx` itself (step 1 above): `useQuery` +
     `requestJson<MeResponse>("/api/me")` from `@moss/module-web-sdk`, render nothing (or an
     access-denied `EmptyState`) if `!data.user.isInstanceAdmin`. `MeResponse` type from
     `@moss/shared` (`packages/shared/src/me-api.ts`, `UserDto.isInstanceAdmin: boolean` confirmed
     at `packages/shared/src/platform-api.ts:9`).
8. **Task 24 — design-system audit**, run for real per the `design-system` skill (grep both
   `apps/web/src/styles/` and `packages/ui/src/styles/`), fix anything, commit:
   `fix(#1755): replace invented classes found by the design-system audit`
9. Note Tasks 22/23 (poll hook, wire actions to real routes) as explicitly deferred (blocked on
   #1752/#1753) in the PR body.
10. `coordinated-wrap-up` skill for the gate + live-path proof + PR.

## Traps already found, don't re-derive

- `assertModuleRegistryConsistency` (module-registry/src/index.ts ~1972) calls
  `assertAppMapDeclarations`, which requires every `navigation[]`/`settings[]` entry to have a
  non-empty `description` — already satisfied in the manifest above, just confirming so nobody
  "simplifies" it away.
- `MossModuleManifest`'s only required fields are `id`/`name`/`version`/`publisher`/`lifecycle`/
  `compatibility` — everything else (including `navigation`, `permissions`, `routes`) is optional,
  confirmed by reading the interface directly (`packages/module-sdk/src/index.ts:613`).
- Module discovery is fully automatic (`packages/settings-ui/src/scanner.ts` `scanModuleWeb` globs
  `packages/*/package.json` for a `"./web"` export) — no Vite config edit needed, confirmed by
  reading `apps/web/vite.config.ts` (only imports the plugin, no per-module registration).
- `node_modules` already installed in this worktree — do not re-run `pnpm install`.

## Coordinator / relay bookkeeping

- Coordinator label: `Coordinator` — resolve fresh by label + session id via `herdr pane list`,
  never trust a cached pane number.
- Relay trigger: context-meter 70% warning, fired again during grounding (mockup + reference-module
  reading), before any test was written or run. Per the relay skill's own guidance for this case:
  nothing was committed because nothing was green — the next session picks up mid-Task-20, not at
  its start.
