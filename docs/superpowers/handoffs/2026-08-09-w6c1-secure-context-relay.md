# Relay — w6c1-secure-context

**Spec (approved):** docs/superpowers/specs/2026-08-09-wave-6-secure-context-and-weather.md
**GitHub issue:** #1402 (lane C, **STAGE 1 ONLY** — timezone floor). Stage 2 (`navigator.geolocation`)
is a separate lane gated on Wave 6 lane A (#1403) merging — do NOT build it here.
**Risk tier:** `sensitive` — standard QA + explicit invariant check + matched e2e-UAT, per-merge
digest to Ben.
**Worktree/branch:** this worktree, `w6c1-secure-context` (off `origin/main`). Tree is clean, no
commits yet — this relay fired on the context-meter warning before any code was written (over-read
during spec/seam verification, per relay skill guidance: relay anyway, say so here).
**Coordinator:** label `Coordinator`, session id `890502d0-c97b-4ed1-aaae-8c33ec48c98f` (re-resolve
pane fresh via `herdr pane list` before messaging — never a cached `…-N`).

## Status: plan NOT started. No code written. Next step is `plan-build`.

## Verified (no drift) — spec premises hold against current branch

Spot-checked every file:line the spec cites; all still accurate (spec said
`weather-service.ts:54-73`, actually 52-73 on this branch — trivial drift, not a re-scope). No
escalation needed for the "verify spec against branch" gate.

## Seam map (traced, ready to plan against — don't re-derive via full reads)

**Timezone plumbing (zero new client/network work — satisfies spec's "no new egress" requirement):**
`X-Timezone` header (already sent by every web-app call via `requestJson` in
`apps/web/src/api/client.ts`) → `request.timeZone` (Fastify decorator, set by
`registerRequestTimeZoneHook` in `apps/api/src/server.ts` ~line 651) → `resolveRequestTimeZoneForRoute`
helper (`packages/module-registry/src/index.ts` ~line 2040-2080, validates via
`isValidTimeZone` in `packages/shared/src/time.ts`).

**Copy the wellness module's wiring pattern** for weather — `packages/wellness/src/routes.ts` has a
local `resolveRouteTimeZone` wrapper (~line 495-530) and its module-registration block in
`packages/module-registry/src/index.ts` (~1540-1585) DI-wires `resolveRequestTimeZone`. Weather's
registration block (same file, right after wellness's) currently has NO timezone wiring — add it
the same way.

**Files needing edits (server side):**
- `packages/weather/src/weather-service.ts` — `resolveLocation` (private method, lines 52-73) needs
  a third `timeZone: string` param, a fallback branch after IP-geo fails (timezone → static city
  lookup, NOT a new geocoding call — spec forbids new outbound egress), and step-name/outcome
  logging only (no coordinates/IP/user id in logs — RLS/privacy invariant). `getWeatherForUser`
  (lines 30-50) is the caller; needs to accept/pass timezone through.
- `packages/weather/src/routes.ts` — add `resolveRequestTimeZone` dependency (mirror wellness),
  pass resolved tz into `service.getWeatherForUser`.
- `packages/weather/src/ip-geocoder.ts` — do NOT touch, per spec.

**Settings UI seam (client side) — routes already fully built, this is UI + 2 fetches only:**
- `packages/settings/src/weather-location-routes.ts` — `GET`/`PUT /api/me/weather-location` already
  implemented, validated (`normalizeWeatherLocation`/`sanitizeWeatherLocation`). Do not touch.
- `apps/web/src/settings/settings-personal-panes.tsx` — `ProfilePane`, `Group title="Location"` block
  at lines 206-258 (timezone/region/date-format `Select`s), immediately followed by `Group
  title="Quiet hours"` at 260-305. Both use `useQuery`+`useMutation` against `queryKeys.settings.*`
  and client fns from `../api/client`. Add the weather-location override as a new `Group` (or extend
  "Location") following this exact pattern.
- `apps/web/src/api/client.ts` lines ~220-260 show the client-fn pattern (locale/quiet-hours). Add
  `getWeatherLocationSettings`/`putWeatherLocationSettings` here (leaning toward `client.ts` over the
  separate `apps/web/src/api/weather-client.ts`, which currently only has `getWeatherToday()` — lock
  this in during planning, not improvised mid-build).
- `packages/shared/src/weather-api.ts` — all DTOs already exist (`WeatherLocationDto`,
  `GetWeatherLocationResponse`, `PutWeatherLocationRequest`, `PutWeatherLocationResponse`). No new
  shared types needed.
- Logging: `createModuleLogger(base, module)` from `packages/module-sdk/src/logger.ts` — pino child
  logger, `module` binding. Use for `resolveLocation` step logging. Constructor-inject vs. per-call
  param not yet decided — pick one during planning.

**Explicitly out of scope / do not build:** stage 2 (`navigator.geolocation`), any new outbound
geocoding egress, restyling `apps/web/src/today/header-weather.tsx` (belongs to #1390), moving
weather off `/today`.

## Trap to flag in the plan (already caught, don't rediscover)

GitHub issue #1402's own body ranks server-egress-IP geolocation via `ipwho.is` as the top detection
option in its "Rank order, to be settled in the design pass" section — that's **stale, pre-design-
settlement text**. The approved spec's "Design forks — settled" + Non-goals sections **supersede
it** and explicitly forbid new outbound geocoding egress for stage 1. Plan against the spec, not the
issue's original ranking.

## Open design questions for `plan-build` to settle (not yet decided — do not improvise mid-code)

1. Timezone→city static lookup table: size/coverage, file location.
2. `createModuleLogger` threading into `WeatherService`: constructor injection vs. per-call param.
3. New client fns: `apps/web/src/api/client.ts` (matches locale/quiet-hours pattern — leaning this
   way) vs. `apps/web/src/api/weather-client.ts`.

## Next steps (successor, in order)

1. `[ -d node_modules ] || pnpm install` (should already exist — skip).
2. Invoke `design-system` skill (mandatory before any settings UI work per spec's Process gates) —
   not yet invoked.
3. Run `plan-build` → `docs/superpowers/plans/2026-08-09-w6c1-secure-context.md` (or similar slug),
   resolving the 3 open questions above, with file:line-cited seams (already mapped above), a kill
   gate after phase 1, e2e proof per phase. Since this is user-facing: plan must include the UAT
   spec path (`tests/uat/specs/<slug>.uat.spec.ts`) and a row in
   `.claude/skills/coordinate/uat-trigger-map.tsv`.
4. Message Coordinator: "plan ready for w6c1-secure-context: <path>. Approve, or flag a fork." STOP
   for approval before writing any code.
5. TDD build task-by-task, `Co-Authored-By: Claude` commits, path-scoped `git add` only.
6. Pre-push trio (`pnpm format:check && pnpm lint && pnpm typecheck`, rebase on `origin/main`)
   before every push.
7. `coordinated-wrap-up`: isolated gate DB, PR, live-path proof (`gh pr comment` w/ UAT + screenshots,
   or explicit "code-complete, unverified"), report to Coordinator. Never merge, never touch the
   board.

## Bans (unchanged, non-negotiable)

Work only in this worktree/branch. `git add` by explicit path only — never `-A` or repo-wide
`pnpm format`. Never touch `docs/coordination/`, the project board, milestones, or merge. No secrets
in any doc/payload/log/prompt.
