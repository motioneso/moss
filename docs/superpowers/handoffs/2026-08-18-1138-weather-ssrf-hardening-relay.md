# Relay — #1138 weather SSRF hardening

**Plan (approved by Coordinator):** `docs/superpowers/plans/2026-08-18-weather-ssrf-hardening.md`
**Handoff:** `docs/coordination/handoff-1138-weather-ssrf-hardening.md`
**Status:** Plan approved. Task 1 not yet started — this relay fired on the 70% context-meter
warning during Task 1 investigation, before any code was written. No commits yet beyond the two
untracked plan/handoff docs (still uncommitted — commit them with your first task commit or
separately, your call).

## What's already confirmed (don't re-derive)

- All 4 findings verified still present on branch (see plan's Seams check section).
- Test file locations (root vitest config only picks up `tests/**/*.test.ts` — packages don't have
  their own test runners; **no `pnpm --filter @moss/weather test` script exists**):
  - `tests/unit/upgrade-check.test.ts` — existing, no-DB, mocks `fetch` via `vi.stubGlobal`. Tasks
    3+4 extend this file.
  - `tests/integration/weather.test.ts` — existing, **DB-touching** (uses
    `resetEmptyFoundationDatabase`, `createApiServer`). Do NOT run directly — needs `verify-gate`
    skill / gate-DB isolation. It already covers `fetchOpenMeteoForecast` call sites at the route
    level; your new open-meteo/ip-geocoder unit tests are additive, not a replacement.
  - No existing unit test file for `open-meteo.ts` or `ip-geocoder.ts` — create
    `tests/unit/open-meteo.test.ts` and `tests/unit/ip-geocoder.test.ts` (no DB, same pattern as
    `tests/unit/upgrade-check.test.ts`).
- **Task 1 design note (resolve this, plan was ambiguous):** `packages/weather/src/routes.ts:51`
  already has a generic `catch (error) { return handleRouteError(error, reply); }` — so a raw
  `SyntaxError` from `open-meteo.ts` doesn't crash the process, it's just not a clean "degrade to
  null" response. Two options, pick one and note it in the PR:
  (a) plan's original idea — new `WeatherUnavailableError` thrown from `open-meteo.ts`, caught
      specifically in `routes.ts` to return `{ data: null }` instead of falling through to
      `handleRouteError`'s generic mapping; or
  (b) simpler — catch the JSON-parse failure inside `weather-service.ts`'s `getWeatherForUser`
      (around `packages/weather/src/weather-service.ts:58`) and return `null`, matching the
      existing degrade pattern used by `geocodeIp` (returns `null` on failure) and by the
      `resolveLocation` fallback chain. No new error class needed.
  Recommend (b) — smaller diff, consistent with the existing null-degrade convention in this same
  file, and the plan's own Task 1 rationale ("caller ... needs to degrade") is satisfied either way.
  Still write the `WeatherUnavailableError`-style test case from the plan if you go with (b): assert
  `getWeatherForUser` resolves to `null` (not a rejection) when Open-Meteo returns unparsable JSON.

## Next concrete steps

1. Task 1 (open-meteo.ts + weather-service.ts, per design note above) — TDD, commit.
2. Task 2 (ip-geocoder.ts private-IP range fix) — TDD, commit. **This is the SECURITY-tier item.**
3. Task 3 (upgrade-check.ts AbortSignal.timeout) — TDD, commit.
4. Task 4 (upgrade-check.ts res.json() guard) — TDD, commit.
5. Pre-push trio: `pnpm format:check && pnpm lint && pnpm typecheck` (all unpiped, check exit code).
6. `coordinated-wrap-up` — PR against #1138, request security-tier QA (Opus) + Ben sign-off per
   handoff doc. Do not self-merge.

## Coordinator

Label `Coordinator`, re-resolve pane fresh via `herdr pane list` before messaging (session id
`b1aa5379-b1e8-46aa-9349-48b149a68dec` was current as of this relay, but the id itself may rotate
across coordinator relays — trust the fresh `herdr pane list` label match over this recorded id).
Collision note from handoff: #1571 (not yet queued) will later touch these same two files — land
cleanly, don't wait on it.
