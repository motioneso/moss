# Relay: #1755 Workshop page

No code committed yet — this session spent its budget on grounding (finding the exact files and
patterns to copy). That research is captured below so the next session can go straight to writing
code and tests.

Handoff doc (read this too, it has the exit criteria and bans):
`docs/coordination/handoff-1755-workshop-page.md`

Plan section (Group D only, don't read the rest of the plan):
`git show origin/plan/1739-stage1-workshop:docs/superpowers/plans/2026-08-20-1739-stage1-workshop.md`
piped to a temp file, then read from "# Group D — #1755" to "# Group E" (line ~1803-1977 in that
file as of this writing, but re-grep the heading rather than trust the line number).

Mockup to build against: `docs/superpowers/specs/assets/2026-08-19-moss-workshop/workshop.html`
(already read in full this session — three groups: "Needs you", "Building now", "Live", each row
separated by a hairline, only the "Needs you" item is a raised card).

Worktree/branch: this one, `1755-workshop-page`, off `origin/main`. `node_modules` already
installed — do not re-run `pnpm install`.

## What's decided (don't re-derive)

- **Where the module lives:** `packages/workshop/` (NOT `apps/web/src/workshop`). First-party
  modules are real workspace packages under `packages/*` with `package.json` declaring
  `"./web": "./src/web/index.tsx"` — a Vite plugin (`packages/settings-ui/src/scanner.ts`
  `scanModuleWeb`) auto-discovers any `packages/*/package.json` with that export and reads
  `src/manifest.ts` for navigation. **Copy `packages/sports/` file-for-file**, substituting
  "workshop"/"Workshop" for "sports"/"Sports": `package.json` (exports `.`, `./web`, no `./settings`
  needed unless we add settings later), `src/manifest.ts`, `src/index.ts`, `src/web/index.tsx`
  (the `ModuleWebContribution` default export, see `packages/module-web-sdk/src/index.ts` for the
  type), `src/web/<name>-page.tsx`.
- **Manifest fields:** copy `packages/sports/src/manifest.ts` shape. Workshop needs: `id:
  "workshop"`, `navigation: [{ id: "workshop", label: "The workshop", path: "/workshop", icon:
  <pick one>, order: <pick unused>, permissionId: "workshop.view" }]`, one permission
  `{ id: "workshop.view", scope: "admin", ... }` (mirrors `packages/settings/src/manifest.ts`'s
  `settings.manage` admin-scope permission — that's the only admin-scope precedent in the repo).
  **Leave `routes: []` and don't add SQL** — no backend exists yet (see stub note below).
- **Registering the module:** add an entry to the `BuiltInModuleRegistration[]` array in
  `packages/module-registry/src/index.ts` (~line 1620-1710 has the weather/sports/news entries to
  copy the shape from). Workshop's entry needs `manifest: workshopModuleManifest,
  sqlMigrationDirectories: [], queueDefinitions: []` and can omit `registerRoutes` entirely
  (optional field, confirmed in `BuiltInModuleRegistration` interface at line 624) — it will still
  show up in `GET /api/modules` via `serializeModule` in `apps/api/src/module-dto.ts`, because
  built-in modules are NOT currently filtered by permission/admin status at that layer (confirmed
  by reading `toMyModuleDto`/`serializeModule` — neither checks the actor at all for navigation).
- **Admin-only gating — there is no automatic enforcement, must be added in two places by hand:**
  1. **Sidebar visibility**: `apps/web/src/shell/app-shell.tsx` line ~255-258 computes
     `navSections` from `props.modules` via `buildShellNavigation`. `props.me` (a `MeResponse`,
     `me.user.isInstanceAdmin: boolean`) is already available in that component. Add a `useMemo`
     that filters `props.modules` to drop the module whose `id === WORKSHOP_MODULE_ID` when
     `!props.me.user.isInstanceAdmin`, and pass that filtered array into `buildShellNavigation`
     instead of `props.modules` directly. Import `WORKSHOP_MODULE_ID` from `@moss/workshop` (export
     it as a const from `src/manifest.ts` like sports does with `SPORTS_MODULE_ID`).
  2. **Page-level defense in depth**: inside the Workshop page component itself, fetch `/api/me`
     with `requestJson<MeResponse>("/api/me")` from `@moss/module-web-sdk` (confirmed exported,
     `packages/module-web-sdk/src/index.ts` line ~90) via a `useQuery`, and render nothing/an
     access-denied state if `!data.user.isInstanceAdmin`. `MeResponse` type is exported from
     `@moss/shared` (`packages/shared/src/me-api.ts`).
  3. Server-side route gating uses `assertAdminUser` from `packages/settings/src/routes.ts` line
     885 — **not needed yet** since we're not adding backend routes this pass (see stub note).
- **Data types don't exist yet** — `ModuleBuildSummary` / `ExternalModuleSummary` are NOT in
  `@moss/shared` (grepped, confirmed absent — #1752/#1753 backend hasn't landed on main). Per the
  handoff doc, **stub this**: define the two types locally in
  `packages/workshop/src/web/types.ts` for now (shape per the plan's Task 21 description — status
  enum `'awaiting_plan_approval' | 'awaiting_change' | 'planning' | 'building' | 'enabled'` plus
  whatever `ready`/`failed`/`cancelled` the mockup implies), and **do not build Task 22 (poll
  hook / `GET /api/module-builds`) or Task 23 (wire actions to real routes) at all** — those need
  the backend. Build Task 20 (scaffold, admin-gated, empty state) and Task 21 (presentational
  three-group list component taking `builds`/`modules` props, rendered with empty arrays from the
  page container) fully. State this stub clearly in the PR description per the handoff doc's
  instruction #3.
- **jds-\* classes needed for the mockup are ALL already defined** — verified with the invented-
  class audit grep against `apps/web/src/styles/` + `packages/ui/src/styles/`, zero missing:
  `jds-eyebrow[--muted]`, `jds-display[--md]`, `jds-section-head[__rule]`, `jds-card[--raised]`,
  `jds-rail-row`, `jds-rail[--gold|--accent|--line|--line-strong]`, `jds-card-title[--heavy]`,
  `jds-badge[--amber|--forest|--red][--pill]`, `jds-card__meta`, `jds-meta-sep`,
  `jds-indicator[--ready][--live]`, `jds-indicator__dot`, `jds-progress[__fill]`,
  `jds-btn[--primary|--secondary|--quiet][--sm]`. Re-run the audit yourself before calling Task 24
  done (see design-system skill), this list is just to save you re-deriving it.
- **Do NOT copy the mockup's `pv-*` classes** (`pv-page`, `pv-head`, `pv-lede`, `pv-between`,
  `pv-grow`, `pv-actions`, `pv-open`, `pv-list`, `pv-item`, `pv-log`, `pv-spacer`, `pv-note`, etc.)
  — those are static-mockup-only scaffolding from `preview.css`, not part of the real design
  system. For page/row layout, write module-local CSS (a `packages/workshop/src/web/workshop.css`,
  imported like `packages/sports/src/web/sports-page.tsx` imports its `styles/sports-*.css`) —
  CLAUDE.md's "Module CSS is layout-only by contract" invariant: raw colors/tokens only in
  `tokens.css`, layout-only here. Column width ~920px per the plan's design ruling.
- **Empty state**: use `EmptyState` from `@moss/ui` (`packages/ui/src/empty-state.tsx`, renders
  `jds-empty` classes) for the true nothing-anywhere-yet case (mirrors
  `packages/sports/src/web/sports-page.tsx` and `packages/news/src/web/news-page.tsx`'s own local
  `EmptyState` wrapper functions — check whichever you land on). Task 20's smoke test wants "renders
  empty state without throwing, given no builds and no modules" — that's this path.
- **Test convention**: this repo's React component tests use `renderToString` from
  `react-dom/server` + `@tanstack/react-query`'s `QueryClientProvider` with a **pre-primed cache**
  (no jsdom/@testing-library anywhere in the repo, deliberately — see the comment in
  `tests/unit/sports-page.test.tsx` lines 18-21). Copy that file's harness shape for the Workshop
  page/component tests, under `tests/unit/`.
- **`requestJson` fetch helper** (`@moss/module-web-sdk`) is the standard client for module `./web`
  code — see `packages/sports/src/web/sports-client.ts` for the one-liner-per-endpoint pattern.
- **Browser-safety test** (`tests/unit/module-web-browser-safety.test.ts`) walks the real import
  graph from every `./web` entry and fails if it reaches `fastify`/`kysely`/`pg`/`pg-boss`/
  `undici`/`@moss/db`. It's fully generic (auto-covers new modules) — just don't import
  `apps/web/*` or backend packages from `packages/workshop/src/web/*`.
- **`tests/unit/module-web-scanner.test.ts`** uses tmpdir fixtures, unaffected by adding a real
  package — no changes needed there.

## Not yet started

Nothing written to disk. Next session should, in order:
1. Scaffold `packages/workshop/` (Task 20): `package.json`, `src/manifest.ts`,
   `src/index.ts` (can just re-export the manifest, mirror `packages/sports/src/index.ts`),
   `src/web/index.tsx`, `src/web/workshop-page.tsx`.
2. Register in `packages/module-registry/src/index.ts`.
3. Add the two admin-gating call sites in `apps/web/src/shell/app-shell.tsx`.
4. Write the Task 20 smoke test, get it failing then passing, commit
   (`feat(#1755): scaffold the Workshop first-party module and page`).
5. Task 21: `workshop-groups.tsx` (or similar) presentational component + test, commit.
6. Task 24: run the design-system invented-class audit for real, fix anything, commit.
7. Note Tasks 22/23 as explicitly deferred (blocked on #1752/#1753) in the PR body per the handoff
   doc's own allowance for this.
8. `coordinated-wrap-up` skill for the gate + live-path proof + PR.

## Coordinator / relay bookkeeping

- Coordinator label: `Coordinator`, pane `w1:pH4` at relay time, session id
  `fbacd483-baf3-47c8-aacf-66a51c6ebd7b` — **resolve fresh by label+session id, don't trust the
  pane number**, it reflows.
- This session's pane: `w1:pH2`, label "1755 Workshop page", session id
  `a9cf529c-28d7-49cb-b046-a8d80e2c79f2`.
- Relay trigger: context-meter 70% warning fired mid-research, per the handoff doc's own rule —
  relayed immediately per instructions rather than pushing further into this window.
