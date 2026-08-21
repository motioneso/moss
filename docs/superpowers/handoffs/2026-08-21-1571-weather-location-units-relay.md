# Relay handoff — 1571 weather location + units

Spec: docs/superpowers/specs/2026-08-17-1571-weather-location-and-units.md
Plan (approved by coordinator): docs/superpowers/plans/2026-08-21-1571-weather-location-and-units.md
Issue: #1571
Worktree/branch: this worktree, branch `1571-weather-location-units` (off origin/main)
Coordinator: agent name `coordinator` (session id `cac2ffa0-60bb-407c-9f3a-1a5fb19d6a9b`), confirm
unique via `herdr agent list` before messaging.
This lane's agent name: `weather-1571-fc-location`.

## Status

Plan approved (coordinator's own words): "Matches the spec's locked decisions -- no new provider,
no migration, independent unit/location preferences, explicit choice on ambiguous matches, and the
cache fix. Go ahead and build, starting with the backend half. Stop and flag me if you hit either
named risk (place search not returning good results, or the cache fix needing more than a small
change) -- otherwise continue straight through to the front end."

No code written yet. Only the plan doc is committed (66eb500c7). Proceed straight to build —
do not re-plan, do not re-verify the seams check (already done and cited with file:line in the
plan doc), do not message the coordinator again for approval.

## Build order (from the plan doc — read it, this is a pointer not a substitute)

Phase 1 (backend), TDD, one task per commit:
1. `packages/weather/src/open-meteo-geocode.ts` — `searchOpenMeteoLocations`, `GeocodeCandidate`,
   `WeatherLocationSearchUnavailableError`. Unit tests first (no results / one / many / HTTP error
   / bad JSON).
2. `packages/shared/src/weather-api.ts` additions (DTOs/schemas — see plan doc section "Edited
   files").
3. `packages/settings/src/weather-location-search-routes.ts` (new) + `weather-unit-routes.ts`
   (new) + wiring into `packages/settings/src/routes.ts` and `manifest.ts` + `@moss/weather`
   dependency in `packages/settings/package.json`.
4. `packages/weather/src/weather-service.ts` — stop hardcoding `"metric"`, add unit resolution,
   extend the cache-sameness check to include unit (this is the named kill-gate risk #2 — if it's
   not a small change, stop and flag the coordinator, do not push through).
5. `packages/settings/src/weather-location-tool.ts` — query-based input, ambiguity handling per
   the plan's determinism boundary (tool never picks among candidates itself).
6. Integration tests per the plan doc's test list.

Verification command from the plan doc (already correctly unpiped):
```bash
pnpm --filter @moss/weather --filter @moss/settings test > /tmp/1571-phase1.log 2>&1; echo "EXIT=$?"
```

Named kill gate (owner: coordinator) — stop after Phase 1 and escalate, do not proceed to Phase 2,
if: (1) Open-Meteo's geocoding endpoint doesn't return usable candidates for ordinary queries when
actually called, or (2) the cache-key fix needs more than the one-line extension described.

Phase 2 (frontend) is sketched in the plan doc; plan it in full only after Phase 1 is judged good.

## Process reminders

- Use `superpowers:test-driven-development` for the build itself — plan already exists, do not
  re-invoke `plan-build`.
- `git add` only the files for the task just completed — never `-A`.
- Pre-push trio before any push: `pnpm format:check && pnpm lint && pnpm typecheck`, then
  `git fetch origin main && git rebase origin/main`.
- Relay again on the next 70% context-meter warning or compaction summary — same procedure
  (commit, write a fresh relay doc, spawn successor, message coordinator to reap you).
- Closeout is `coordinated-wrap-up` — full gate via the `verify-gate` skill (never run
  `pnpm verify:foundation` unscoped), push, PR, live-path UAT proof as a `gh pr comment`, release
  note via `node scripts/append-release-note.mjs --pr <number>`, report to coordinator, stop. Never
  merge/board/milestone.
- Plain-English rule applies to every message you send, including to the coordinator: no invented
  shorthand, name things by what they do.
