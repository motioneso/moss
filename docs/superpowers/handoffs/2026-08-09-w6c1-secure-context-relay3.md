# Relay #3 — w6c1-secure-context (Phase 1 done, Phase 2 next)

**Plan (approved, build):** docs/superpowers/plans/2026-08-09-w6c1-secure-context.md — read it in
full before continuing; exact file:line seams, signatures, test cases per task.
**Issue:** #1402 lane C, Stage 1 only. **Tier:** sensitive. **Branch:** this worktree,
`w6c1-secure-context`, off `origin/main`.

## Status

Phase 1 (server-side timezone fallback) is **done, committed, and verified green**:
`82c14381f` — `packages/weather/src/{weather-service.ts,routes.ts}`,
`packages/module-registry/src/index.ts`, `tests/integration/weather.test.ts`. Task 1
(`timezone-city.ts` + unit test) was `d75fb2938`, already landed.

Verification actually run this session (isolated gate DB `jarvis_gate_w6c1secure`, created and
dropped after — never live dev DB):
- `pnpm --filter @moss/weather test` → EXIT=0
- `pnpm build:app-map` → EXIT=0 (**must run before integration tests** — missing
  `dist/app-map.json` otherwise fails every test in the file with `AVV_ERR_PLUGIN_EXEC_TIMEOUT`,
  a pre-existing env gap, not caused by this change; `verify:foundation` already chains this step)
- `pnpm vitest run tests/integration/weather.test.ts` → EXIT=0 (8 tests incl. 2 new: fallback-hit
  via `X-Timezone: Europe/London` + loopback IP asserting Open-Meteo called with London's exact
  lat/lon; unrecognized-timezone regression guard asserting `data: null` + zero fetch calls)

**Kill gate (plan lines ~173–186, owner Coordinator):** neither condition observed to hold in this
session's testing — the London fallback entry isn't misleading, and there's no evidence yet the
~70-entry cap is insufficient for a real dev-instance timezone. Per the plan, that means **proceed
to Phase 2 in the same PR**, no separate ping needed — but flagging it here since I (agent) am not
the Coordinator and didn't make this call formally, just observed nothing that trips the gate.

## Next: Phase 2 (Tasks 4–7), plan lines ~188+

- **Task 4** — `apps/web/src/api/weather-client.ts`: add `getWeatherLocationSettings()`
  (`GET /api/me/weather-location`) and `putWeatherLocationSettings(body)`
  (`PUT /api/me/weather-location`), `requestJson` pattern matching existing `getWeatherToday`.
- **Task 5** — `apps/web/src/settings/settings-personal-panes.tsx`: new
  `Group title="Weather location"` after "Location", before "Quiet hours"; 3 inputs
  (label/lat/lon per plan's decided shape), "Clear override" action, wired via
  `useQuery(queryKeys.weather.location, ...)`/`useMutation`. **Run the `design-system` skill's
  invented-class audit against `apps/web/src/settings/` before committing.** Extend
  `tests/unit/settings-personal-panes.test.tsx`.
- **Task 6** — new `tests/uat/specs/1402-weather-location-settings.uat.spec.ts` + two new rows in
  `.claude/skills/coordinate/uat-trigger-map.tsv`.
- **Task 7** — full gate + pre-push trio (`pnpm format:check && pnpm lint && pnpm typecheck`, then
  `pnpm verify:foundation` via `verify-gate` skill / isolated gate DB), rebase on `origin/main`
  before push.
- `coordinated-wrap-up`: isolated gate DB run, PR creation, live-path proof (`gh pr comment` with
  UAT output + screenshots, or explicit "code-complete, unverified"). Never merge, never touch the
  project board.

## Working rules already in force, don't rediscover

- `shared-checkout` skill before every commit (worktree may be shared) — `git status --porcelain`
  before each commit so far, only my own untracked/modified files present each time; re-check every
  time.
- Commit by **explicit path only**, never `-A` / bare commit.
- TDD, green test before commit, `Co-Authored-By: Claude <noreply@anthropic.com>` on every commit.
- No subpath package export for `@moss/weather` — internal files imported into tests via relative
  path (`../../packages/weather/src/....js`), not `@moss/weather/...`.
- `pnpm build:app-map` must run before any integration test that spins up `createApiServer` (see
  above) — not previously documented in relay #2, now confirmed.
- Hard bans unchanged: don't touch `packages/weather/src/ip-geocoder.ts`, no new outbound egress,
  don't touch `docs/coordination/`, project board, or merge.

## Live-path gate (don't lose this)

Task 6's UAT run on a live dev instance is the exit criterion — CI green alone is not "done" for
this sensitive-tier, user-facing feature. `coordinated-wrap-up` must record it or state explicitly
"code-complete, unverified".

## If you relay again

Write relay #4 the same shape — pointer to plan doc + task list state + exact next edit.
