# Relay handoff — 1571 weather location + units (relay 2)

Spec: docs/superpowers/specs/2026-08-17-1571-weather-location-and-units.md
Plan: docs/superpowers/plans/2026-08-21-1571-weather-location-and-units.md
Issue: #1571
Worktree/branch: this worktree, branch `1571-weather-location-units`
Coordinator: agent name `coordinator`, confirm unique via `herdr agent list` before messaging.
This lane's agent name was `weather-1571-fc-location`; successor should pick its own name and
message the coordinator with it.

## Status

No code written yet — previous lane spent its whole window reading reference files to match
existing patterns exactly, then hit the 70% context checkpoint. Nothing to commit. Read this doc,
then go straight to TDD per `docs/superpowers/handoffs/2026-08-21-1571-weather-location-units-relay.md`
(the original relay doc — still the source of the build order and kill gate) and the plan doc
above. This doc only adds the concrete file patterns and one wiring gap the first lane found.

## What the first lane confirmed (no need to re-check)

- Tests live at repo root, NOT inside packages: `tests/unit/*.test.ts`, `tests/integration/*.test.ts`.
  Root `vitest.config.ts` `test.include` covers `tests/**/*.test.ts` (plus a few package-local
  exceptions that don't apply here). Follow `tests/unit/open-meteo.test.ts` and
  `tests/unit/weather-service.test.ts` as the templates for the new geocode unit tests.
- `packages/weather/package.json` and `packages/settings/package.json` have no `"test"` script —
  the plan doc's verification command still works because pnpm falls through to the root test
  runner; just run root vitest directly while iterating, e.g.
  `pnpm vitest run tests/unit/open-meteo-geocode.test.ts`.
- Route-shape template pair to copy exactly: `packages/settings/src/quiet-hours-routes.ts` +
  `packages/settings/src/quiet-hours-tool.ts` (GET/PUT preference pair, tool with CAS-based
  upsert via `PreferencesRepository.getWithRevision`/`upsertWithRevision`, `settingsUndoStack.push`
  on write). `weather-location-routes.ts` + `weather-location-tool.ts` are the current (soon
  superseded) location versions — same shape.
- Error handling in settings routes: wrap the handler body in try/catch and call
  `handleSettingsRouteError(error, reply)` from `packages/settings/src/route-error.ts` (not the
  bare `@moss/module-sdk` `handleRouteError` — that's only used by non-account-aware routes like
  weather's own `/api/weather/today`).
- `packages/weather/src/weather-service.ts:63` is the literal `"metric"` to replace; `sameLocation`
  helper at the bottom (lines 120-127) is what the cache-sameness check extends to include unit —
  confirms the plan's "should be a one-line-ish extension" claim.
- `packages/weather/src/open-meteo.ts` `fetchOpenMeteoForecast` already accepts a `unit` param and
  maps it to `temperature_unit` — `weather-service.ts` just needs to stop hardcoding the 3rd arg.

## One wiring gap the plan doc doesn't mention — found this lane, not yet fixed

`packages/settings/src/routes.ts`'s `SettingsRoutesDependencies` interface has NO `fetchFn` field
today, and the composition root that registers settings
(`packages/module-registry/src/index.ts`, the `BUILT_IN_MODULES` entry for `settingsModuleManifest`,
around line 1124 — `registerRoutes: (server, deps) => { registerSettingsRoutes(server, {...}) }`)
does NOT pass `fetchFn: deps.fetchFn` into that call, even though `deps.fetchFn` exists on
`BuiltInRouteDependencies` (confirmed at module-registry/src/index.ts:576) and IS already threaded
to weather's and two other route registrations (lines 1664, 1685, 1713 — grep `fetchFn` in that
file to see the existing pattern to copy).

To make search routes testable with a fake fetch (same pattern as `tests/integration/weather.test.ts`
uses via `createApiServer({ fetchFn })`), you need to:
1. Add `readonly fetchFn?: typeof fetch;` to `SettingsRoutesDependencies` in
   `packages/settings/src/routes.ts`.
2. Pass it through to `registerWeatherLocationSearchRoutes(server, { ...dependencies, fetchFn: dependencies.fetchFn })`
   inside `registerSettingsRoutes`.
3. Add `fetchFn: deps.fetchFn` to the `registerSettingsRoutes(server, {...})` call in
   `packages/module-registry/src/index.ts`'s settings `BUILT_IN_MODULES` entry (~line 1124-1160).

This is exactly what the plan doc's "Edited files" section for `routes.ts` already says to do
("thread `fetchFn` through `SettingsRoutesDependencies`") — just noting the extra step 3 in
module-registry/src/index.ts that the plan doc didn't call out by file, so the next lane doesn't
have to rediscover it.

## Build order — unchanged, follow the original relay doc + plan doc

Still Phase 1 backend, TDD, one task per commit, in this order:
1. `packages/weather/src/open-meteo-geocode.ts` + `tests/unit/open-meteo-geocode.test.ts`
2. `packages/shared/src/weather-api.ts` additions
3. `packages/settings/src/weather-location-search-routes.ts` (new) + `weather-unit-routes.ts` (new)
   + wiring (routes.ts, manifest.ts, package.json `@moss/weather` dep, and the module-registry
   fetchFn gap above)
4. `packages/weather/src/weather-service.ts` unit resolution + cache-sameness fix
5. `packages/settings/src/weather-location-tool.ts` query-based rewrite
6. Integration tests per plan doc's test list

Named kill gate (owner: coordinator) unchanged — stop after Phase 1 and escalate if Open-Meteo
geocoding doesn't return usable results, or the cache fix needs more than the described small
change.

## Process reminders (same as original relay doc)

- `superpowers:test-driven-development` already invoked once this build — re-invoke in the new
  session, follow red/green/refactor per task.
- `git add` only files for the task just completed — never `-A`.
- Pre-push trio: `pnpm format:check && pnpm lint && pnpm typecheck`, then
  `git fetch origin main && git rebase origin/main`.
- Relay again on the next 70% warning — same procedure.
- Closeout is `coordinated-wrap-up`: full gate via `verify-gate` skill, push, PR, live-path UAT
  proof as a `gh pr comment`, release note via `node scripts/append-release-note.mjs --pr <number>`,
  report to coordinator, stop. Never merge/board/milestone.
- Plain-English rule applies to every message, including to the coordinator: no invented
  shorthand, name things by what they do.
