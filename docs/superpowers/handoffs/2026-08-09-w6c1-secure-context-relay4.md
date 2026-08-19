# Relay #4 — w6c1-secure-context (Tasks 4-5 done, Task 6 next)

**Plan (approved, build):** docs/superpowers/plans/2026-08-09-w6c1-secure-context.md — read by
SECTION only (Task 6 spec, ~lines 218-229), never in full.
**Issue:** #1402 lane C, Stage 1 only. **Tier:** sensitive. **Branch:** this worktree,
`w6c1-secure-context`, off `origin/main`.

## Status

Phase 1 done (relay #3). Phase 2 Tasks 4-5 done, committed, green:
`344434564` — `feat(weather): add settings UI for manual weather location override (#1402 Task 4-5)`
covering `apps/web/src/api/weather-client.ts`, `apps/web/src/settings/settings-personal-panes.tsx`,
`tests/unit/settings-personal-panes.test.tsx`. `pnpm vitest run tests/unit/settings-personal-panes.test.tsx`
→ EXIT=0 (4 passed). Typecheck + invented-class audit both clean on this diff.

Server routes (`GET`/`PUT /api/me/weather-location`), shared types (`WeatherLocationDto` etc. in
`packages/shared/src/weather-api.ts`) already existed pre-branch — no server work was needed.

## UI shape built (Task 5) — exact aria-labels/text for Task 6's spec

New `<Group title="Weather location" desc="Override the timezone-based weather location with
exact coordinates.">` in `apps/web/src/settings/settings-personal-panes.tsx`, between "Location"
and "Quiet hours":
- Label input: `aria-label="Weather location label"`
- Latitude input: `aria-label="Weather location latitude"` (type=number)
- Longitude input: `aria-label="Weather location longitude"` (type=number)
- `Row name="Manual override" desc="Currently using {label}." | "Using automatic timezone-based
  location."` with two buttons: `Save` (disabled unless all 3 fields parse valid) and
  `Clear override` (disabled when no override set)
- Save/Clear both go through `useMutation` → `PUT /api/me/weather-location` (clear sends `null`
  body) → `onSuccess` writes `queryKeys.weather.location` cache directly (no separate refetch).

## Next: Task 6 — UAT spec + trigger-map rows

Create `tests/uat/specs/1402-weather-location-settings.uat.spec.ts`:
- `export const uatLevel = { level: "solo-admin", without: [] } as const;`
- Reuse `signIn(page)` pattern from `tests/uat/specs/moss-assistant-name.uat.spec.ts:36-49` (or
  `1264-settings-self-operation.uat.spec.ts`) — fills Email/Password, handles "Skip setup" onboarding.
- Navigate: `await page.goto(\`${requireBaseURL()}/settings?section=profile\`);` — confirmed house
  pattern (see `moss-assistant-name.uat.spec.ts:56`, `app-map-grounding.uat.spec.ts:61`), lands
  directly on `ProfilePane`.
- Test 1: fill label/lat/lon via the 3 aria-labels above, click `Save`, reload the page, assert the
  same values are still in the inputs (persistence across reload) and the "Currently using X." copy
  shows.
- Assert `/today`'s weather section reflects the override — read `apps/web/src/today/header-weather.tsx`
  (NOT YET READ this session) to find the DOM hook/text it renders for the resolved location, then
  assert on that after navigating to `/today`.
- Test 2: click `Clear override`, assert reverts to "Using automatic timezone-based location.", no
  crash, `/today` still renders (fallback, no stale value).
- `test.afterAll`/cleanup: restore whatever the seeded admin's weather location was before the spec
  ran (shared UAT DB — same pattern as `moss-assistant-name.uat.spec.ts:169-184`), since this spec
  mutates a real user row.

Then add two rows to `.claude/skills/coordinate/uat-trigger-map.tsv` (append near the bottom, after
the #1311 rows — tab-separated, 3 columns: mode / path glob / spec path):
```
blocking	apps/web/src/settings/settings-personal-panes.tsx	tests/uat/specs/1402-weather-location-settings.uat.spec.ts
blocking	packages/weather/**	tests/uat/specs/1402-weather-location-settings.uat.spec.ts
```

Run (unpiped, exit code recorded — pipe-into-tail/grep is hook-blocked in this repo):
```bash
pnpm vitest run tests/unit/settings-personal-panes.test.tsx > /tmp/w6c1-settings-unit.log 2>&1; echo "EXIT=$?"
```
Confirm the exact UAT runner invocation against `docs/DEVELOPMENT_STANDARDS.md` or an existing CI
job before running the new spec live (needs `JARVIS_UAT_BASE_URL` + a live dev instance — likely
via `verify-gate`-adjacent tooling, not the isolated gate DB).

Commit via `shared-checkout` discipline: `git status --porcelain` first, explicit paths only, diff
review before commit, `git show --name-only HEAD` after.

## Then: Task 7 + wrap-up

```bash
pnpm format:check && pnpm lint && pnpm typecheck > /tmp/w6c1-pretrio.log 2>&1; echo "EXIT=$?"
```
Then full `pnpm verify:foundation` via the **`verify-gate`** skill (isolated gate DB — never run
raw, never touch live dev DB). Rebase on `origin/main` before push.

`coordinated-wrap-up`: isolated gate DB run, push, open PR, post live-path proof (`gh pr comment`
with UAT output + screenshots of the new Settings group and `/today` showing the override), or
explicit "code-complete, unverified" if live proof isn't achievable. Report PR + evidence to the
coordinator. Never merge, never touch the project board.

## Working rules already in force, don't rediscover

- `shared-checkout` skill before every commit (worktree may be shared) — re-check
  `git status --porcelain` every time; only your own files should appear.
- Commit by explicit path only, never `-A` / bare commit.
- TDD, green test before commit, `Co-Authored-By: Claude <noreply@anthropic.com>` on every commit.
- No subpath package export for `@moss/weather` — relative-path imports into tests.
- `pnpm build:app-map` before any integration test that spins up `createApiServer`.
- Pipe-into-verification-command is hook-blocked — always `> logfile 2>&1; echo "EXIT=$?"`, never
  `| tail`/`| grep`.
- Hard bans unchanged: don't touch `packages/weather/src/ip-geocoder.ts`, no new outbound egress,
  don't touch `docs/coordination/`, project board, or merge.

## Live-path gate (don't lose this)

Task 6's UAT run on a live dev instance is the exit criterion — CI green alone is not "done" for
this sensitive-tier, user-facing feature. `coordinated-wrap-up` must record it or state explicitly
"code-complete, unverified".

## If you relay again

Write relay #5 the same shape — pointer to plan doc + task list state + exact next edit. Relay
trigger is the context-meter 70% warning, not a felt percentage.
