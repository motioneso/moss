# Module web registry (frontend plugin seam)

**Status:** Approved and implemented — Ben approved 2026-07-06; built and merged as PR #830
(Phase A: mechanism + sports migration), closing issue #799, part of epic #798 (module docking
seams). Extends ADR 0009 ("a module connects, never alters") to the web app.

**Grounded on:** `origin/main` @ `1c307466` (audit findings verified at `2797fc1f`; rev 2 findings
verified at `1c307466`). Re-run `pnpm audit:preflight` before building.

---

## Problem

The backend docks a module with one manifest + one `module-registry` entry. The web side is split:
**settings panes already dock automatically, but everything else is hand-wired.**

What already works (and this spec must not break): `packages/settings-ui` ships a Vite plugin
(`packages/settings-ui/src/vite.ts`) whose scanner (`scanner.ts`) AST-reads every module package's
`src/manifest.ts` at build time, maps each `settings[].entry` to a lazy component import, and emits
`virtual:jarvis-module-settings`; the settings screen renders module panes through
`ModuleSettingsRouter` (`apps/web/src/settings/settings-personal-data-panes.tsx:625-634`). The
scanner even throws on duplicate settings paths — a build-time consistency assertion. So
`settings[].entry` is load-bearing, and the repo already contains a proven pattern for zero-edit
web docking. (An earlier revision of this spec claimed the module settings panes were dead code —
that was wrong; the claim missed the virtual-module indirection.)

Everything else is hand-wired. Wellness's non-settings UI is ~3,557 LOC across
`apps/web/src/wellness/` (14 files) plus 3 CSS files, and registering it required hand-edits to
~13 shared web files:

- `apps/web/src/app.tsx` — lazy page import, `myModulesEnabled("wellness")` gate,
  `<ModuleGatedRoute>` entry, `wellnessEnabled` prop threading into `TodayPage`.
- `apps/web/src/app-route-metadata.ts` — route id/path/title/match registration.
- `apps/web/src/api/client.ts:508-597` — ~10 hand-written fetch functions.
- `apps/web/src/api/query-keys.ts:104-110` — query-key namespace.
- `apps/web/src/shell/command-palette-model.ts:36` — palette module list.
- `apps/web/src/settings/settings-module-view-model.ts:22` — `USER_TOGGLEABLE_MODULE_IDS` set.
- `apps/web/src/onboarding/section-tour-model.ts`, `section-tour-step.tsx`,
  `member-welcome-step.tsx` — tour entries.

Sports repeated the same pattern (`app.tsx`, `app-route-metadata.ts`, `api/sports-client.ts`,
`query-keys.ts:99-102`, `settings-module-view-model.ts:22`, three `styles/sports-*.css` files).
The manifest `navigation` field (`ModuleNavigationEntryManifest`,
`packages/module-sdk/src/index.ts:388-396`) is still decorative for nav/routes — the web nav is
hand-built.

## Goal

A module's entire UI — routes, nav entry, today widgets, command-palette entries, API client,
query keys, CSS — lives in `packages/<module>/` and docks into the web shell with **zero hand
edits to shared web files**, by extending the already-proven settings-ui scanner/virtual-module
mechanism. Migrating sports proves the mechanism; migrating wellness proves it scales.

## Architecture

**Extend the existing scanner, don't build a parallel registry.** An earlier revision proposed a
hand-maintained `apps/web/src/modules/registry.ts` array; rejected after review — it would
duplicate machinery the settings-ui scanner already provides (build-time discovery, lazy imports,
duplicate-path assertion, manifest watching) and reintroduce a per-module edit the scanner was
built to remove.

1. **`@jarv1s/module-web-sdk` (new, browser-safe package).** Types + a tiny shared HTTP helper;
   peer deps `react` and `@tanstack/react-query`; no node imports (same constraint as
   `@jarv1s/shared` — it will be Vite-bundled). Defines:

   ```ts
   export interface ModuleWebContribution {
     readonly moduleId: string; // must match the backend manifest id
     readonly routes?: readonly ModuleWebRoute[]; // path, title, icon, order, lazy element
     readonly todayWidgets?: readonly ModuleTodayWidget[]; // slot + lazy component
     readonly commandPaletteEntries?: readonly ModulePaletteEntry[];
     readonly onboarding?: ModuleOnboardingContribution; // tour section + welcome line
   }
   ```

   plus a `requestJson`-style fetch helper so module clients don't each reimplement error/JSON
   handling (today `packages/sports/src/settings/index.tsx` duplicates exactly that). Query-key
   conventions (`[moduleId, ...]`) are documented here too.

   Settings panes are deliberately **absent** from the contribution: settings docking already
   works via `settings[].entry` and stays untouched.

2. **Module web entry: `packages/<module>/src/web/index.ts`**, exported via a `"./web"` subpath in
   the module's `package.json` `exports` map (the proven `./settings` pattern). It exports a
   single `ModuleWebContribution` and is the ONLY module entry the web shell consumes (besides the
   scanner-consumed `./settings`). Everything web-specific moves under it:
   - `apps/web/src/sports/*` → `packages/sports/src/web/` (page, news, parts).
   - `apps/web/src/api/sports-client.ts` + the query-key namespace → the module web dir. Query
     keys stay byte-identical (`["sports", ...]` shapes) so React Query caches survive the move —
     see memory `jarv1s frontend workspace querykey`.
   - Module CSS files move into the package and are imported by the module's own components. The
     tokens rule is unchanged: raw CSS colors stay in `apps/web/src/styles/tokens.css` only;
     module CSS uses tokens and `jds-*` primitives.
   - **Server/browser split guard:** `./web` (and `./settings`) subpaths must never transitively
     import fastify/kysely/node code. Enforced by a unit test that imports each discovered `./web`
     entry under a browser-like condition set and by the existing web build in CI.

3. **Scanner extension: `virtual:jarvis-module-web`.** The settings-ui scanner run (which already
   walks every `@jarv1s/*` package) additionally emits a second virtual module: for each package
   whose `package.json` declares an `exports["./web"]` entry, a lazy contribution import:

   ```ts
   // generated
   export const MODULE_WEB_CONTRIBUTIONS = [
     { moduleId: "sports", load: () => import("@jarv1s/sports/web") }
     // ...
   ];
   ```

   Derived consumers in `apps/web` (each loops the generated list instead of hand-coding modules):
   - `app.tsx` renders `<ModuleGatedRoute>` per contributed route; the gate stays the existing
     generic `myModulesEnabled(moduleId)` machinery.
   - `app-route-metadata.ts` derives module route metadata entries.
   - `command-palette-model.ts` appends contributed entries.
   - `settings-module-view-model.ts` derives the toggleable-module list from the `/api/modules`
     bootstrap payload (`lifecycle === "user-toggleable"`), replacing the hardcoded
     `USER_TOGGLEABLE_MODULE_IDS`.
   - Today page renders `todayWidgets` by slot instead of importing module components directly.
   - Onboarding tour derives module sections from `onboarding` contributions.

   Route metadata (path/title/order) needed _before_ the lazy chunk loads is emitted statically by
   the scanner from the backend manifest `navigation` field — making `navigation` load-bearing.

4. **Consistency assertion (mirror the backend + scanner precedent).** Scan-time (throw, like the
   duplicate-settings-path check): every `./web` package has a manifest; no route-path or
   palette-id collisions. Test-time: every contribution's `moduleId` matches its backend manifest
   id; contributed route paths equal the manifest `navigation` paths.

## Components / phases

**Phase A — mechanism + sports (small, newest, proves everything):**

1. Create `packages/module-web-sdk` (types + `requestJson`, ~200 LOC) + tsconfig/vitest aliases.
2. Extend the settings-ui scanner to emit `virtual:jarvis-module-web`; refactor the derived
   consumers in §3. Behavior change target: **zero** — same routes, same gating, same visuals.
3. Move sports web code into `packages/sports/src/web/`, delete `apps/web/src/sports/` and
   `api/sports-client.ts`, add the `./web` export. **Today "Sports desk" caveat:** the current
   today-feed sports section (`apps/web/src/today/feed-source.ts`, `today-page.tsx`) is
   placeholder/demo-fed UI — it is not wired to sports backend data. Converting it to a
   `todayWidgets` contribution therefore includes defining the widget's data contract (fetch via
   the module's own client); this is a small, explicit behavior addition, not a byte-identical
   move. The visual-equivalence exemption for this one widget must be called out in the PR.

**Phase B — wellness migration (bulk move, same shape):** move the 14 files + 3 CSS bundles,
convert the Today check-in/meds widgets and export modal to contributions, delete the wellness
branches in the shared files. Respect the file-size gate when relocating CSS (split stays as-is).

**Phase C — cleanup:** remove any now-empty shared-file branches; grep for stranded module ids in
`apps/web/src` (CI check candidate: no module id may appear in shared web files outside generated
virtual modules).

## Non-goals

- No dynamic/remote module loading, no module federation — build-time scan + code-splitting only.
- **No changes to the settings docking machinery** (`virtual:jarvis-module-settings`,
  `ModuleSettingsRouter`) — it already works; this spec only adds a sibling virtual module.
- No redesign of any screen; this is a functionality/structure pass, pixel-identical output except
  the declared Sports-desk data wiring (design passes are separate per project practice).
- No new backend manifest fields; `navigation`/`settings` metadata shapes are unchanged.
- Chat drawer, briefings UI, and platform screens stay core (not contributions).

## Verification

- `pnpm verify:foundation` + web build + Playwright e2e (`tests/e2e/wellness.spec.ts`, sports
  specs) green with zero test-expectation changes in Phase A/B (except import paths and the
  declared Sports-desk widget).
- focused browser DOM/computed-style diff before/after each phase — identical except the declared exemption.
- New unit tests: scan-time collision assertion; contribution/manifest consistency;
  browser-safety import test; query-key byte-stability.
- Manual: disable sports for a user — nav entry, route (404 via existing guard), palette entry,
  and today widget all disappear.

## Risks / open questions

- **Bundle hygiene** is the main risk: a module package accidentally pulling server code into the
  web bundle. Mitigation: the import-condition unit test + keeping contracts in `@jarv1s/shared`
  (unchanged rule, `packages/shared/src/wellness-api.ts` documents it).
- **Scanner limits:** the scanner AST-reads manifests as literal data — manifests must stay
  literal (they are today). Contributions needing computed values live in the `./web` module, not
  the manifest.
- **Query-key stability** during the move — keys must be byte-identical or user caches invalidate.
  Covered by unit tests asserting the exact key shapes.
- Open: should `onboarding` tour contributions land in Phase A or be deferred to Phase C? Default:
  Phase C (lowest value, touches the most copy).
