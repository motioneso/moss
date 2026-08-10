# Relay #2 — w6c1-secure-context (build in progress)

**Plan (approved, build):** docs/superpowers/plans/2026-08-09-w6c1-secure-context.md — read it in
full before continuing; it has exact file:line seams, signatures, and test cases per task.
**Issue:** #1402 lane C, Stage 1 only. **Tier:** sensitive. **Branch:** this worktree,
`w6c1-secure-context`, off `origin/main`.

## Status

Coordinator approved the plan (session `9c7ffdf7-4ccc-4378-aa3e-4f2f6f43a171`, agent
`coord-waves36-r4` at time of approval — re-resolve fresh, never reuse this id). Build is
authorized. **Task 1 done and committed** (`d75fb2938`): `packages/weather/src/timezone-city.ts` +
`tests/unit/weather-timezone-city.test.ts`, both green (`pnpm vitest run
tests/unit/weather-timezone-city.test.ts` → EXIT=0).

Tracked via TaskCreate/TaskUpdate in this session (ids won't carry over — recreate or ignore,
your call): Task 1 done, Tasks 2–7 pending, in plan order.

## Next step: Task 2

Plan section "Task 2 — `WeatherService` timezone fallback" (plan doc lines ~137–149). Edit
`packages/weather/src/weather-service.ts`:
- Add required `logger: FastifyBaseLogger` to `WeatherServiceDependencies`.
- Add `timeZone: string` third param to `getWeatherForUser` and `resolveLocation`.
- After `geocodeIp` returns null/falls through, call `lookupCityForTimeZone(timeZone)` (from the
  file just built) before returning null; log step outcome only via `this.logger` — outcome string
  one of `"stored-preference" | "ip-geo" | "timezone-fallback" | "unresolved"`, **never**
  coordinates/IP/user id (RLS/privacy invariant, explicit in the plan).
- Extend `tests/integration/weather.test.ts` per the plan's two cases (fallback hit via
  `X-Timezone: "Europe/London"` + failed IP-geo; fallback miss stays `data: null`, regression
  guard).

Then Task 3 (routes.ts + module-registry.ts wiring, mirrors wellness exactly, plan lines
~151–163), then the Phase 1 verification block (plan lines ~165–171, unpiped commands, run under
`verify-gate` skill / isolated gate DB — never live dev DB), then the kill gate check (plan lines
~173–186, owner Coordinator — only escalate if one of the two named conditions holds, otherwise
proceed straight into Phase 2 same PR), then Tasks 4–7 in order.

## Working rules already in force, don't rediscover

- `shared-checkout` skill before every commit (this worktree may be shared) — checked
  `git status --porcelain` before each commit so far, only my own untracked files present each
  time; re-check every time, don't assume.
- Commit by **explicit path only**, never `-A` / bare commit.
- TDD, green test before commit, `Co-Authored-By: Claude <noreply@anthropic.com>` on every commit.
- No subpath package export for `@moss/weather` — internal files (like `timezone-city.ts`) are
  imported into tests via relative path (`../../packages/weather/src/....js`), matching the
  `sports-catalog.test.ts` convention, not `@moss/weather/...`.
- Pre-push trio + rebase on `origin/main` before push (Task 7).
- Hard bans unchanged: don't touch `packages/weather/src/ip-geocoder.ts`, no new outbound egress,
  don't touch `docs/coordination/`, project board, or merge.

## Live-path gate (don't lose this)

Task 6's UAT run on a live dev instance is the exit criterion — CI green alone is not "done" for
this sensitive-tier, user-facing feature. `coordinated-wrap-up` must record it (`gh pr comment`
with UAT output + screenshots) or state explicitly "code-complete, unverified" if it can't be
completed before your own handoff.

## If you relay again

Write relay #3 the same shape as this one — pointer to plan doc + task list state + exact next
edit, not a re-derivation of the seam map (it's already in the plan doc, cited with file:line).
