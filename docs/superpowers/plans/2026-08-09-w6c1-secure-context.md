# Plan — w6c1-secure-context (#1402 Stage 1)

## Scope

- Issue: #1402, lane C, **STAGE 1 ONLY** (timezone floor). Stage 2 (`navigator.geolocation`) is a
  separate lane gated on Wave 6 lane A (#1403) merging — not built here.
- Spec: `docs/superpowers/specs/2026-08-09-wave-6-secure-context-and-weather.md`, lane C row.
- Risk tier: `sensitive` — standard QA + explicit invariant check + matched e2e-UAT, per-merge
  digest to Ben.
- Issue #1402's title ("no location UI, and IP detection is dead on a LAN") names two independent
  problems; this plan closes both, in two phases, because they don't share a dependency:
  - Phase 1: IP-geo has no fallback, so weather never renders when `request.ip` is a LAN/Tailscale
    address (`geocodeIp` returns `null` for private ranges — `packages/weather/src/ip-geocoder.ts:20-27`).
  - Phase 2: there is no UI to set a location manually, even though the backend routes for it are
    already built and validated.
- Owned surface (exclusive, per spec): `packages/weather`, `packages/settings`,
  `apps/web/src/settings`.
- Explicitly out of scope: stage 2 (`navigator.geolocation`), any new outbound geocoding egress,
  restyling `apps/web/src/today/header-weather.tsx` (#1390), moving weather off `/today`,
  `packages/weather/src/ip-geocoder.ts` (do not touch).

## Determinism boundary

No model turn is involved anywhere in this feature. Weather location resolution is a pure
server-side fallback chain (stored preference → IP-geo → static timezone table), and the settings
UI is a plain form bound to `useQuery`/`useMutation`, matching the existing locale/quiet-hours
panes. Nothing here renders assistant output; this section is stated to close the checklist item,
not because it's load-bearing.

## Seams check (all cited against current tree, verified this session)

- `X-Timezone` header sent by every web-app call: `apps/web/src/api/client.ts:1331-1336`
  (`Intl.DateTimeFormat().resolvedOptions().timeZone`, set when the header is absent).
- Server reads it into `request.timeZone`: `registerRequestTimeZoneHook`,
  `apps/api/src/server.ts:652-659` (validates via `isValidTimeZone`, sets on `onRequest`).
- Wellness's existing per-route wiring pattern to copy exactly:
  - Local wrapper `resolveRouteTimeZone`, `packages/wellness/src/routes.ts:506-511` (falls back to
    `request.timeZone ?? "UTC"` when the DI hook isn't supplied).
  - Registration-time DI wiring, `packages/module-registry/src/index.ts:1551-1562`, using a single
    `preferencesRepository` const shared between the route registration and the timezone resolver.
  - Shared helper `resolveRequestTimeZoneForRoute`, `packages/module-registry/src/index.ts:2065-2074`
    (header first, then stored `locale` preference, then `"UTC"` — via `resolveTimeZone` in
    `packages/shared/src/time.ts:35-40`).
- Weather's current registration block has no timezone wiring and no logger:
  `packages/module-registry/src/index.ts:1571-1580`.
- `createModuleLogger` DI precedent already used the exact same way for another built-in module:
  `logger: createModuleLogger(server.log, "sports")`,
  `packages/module-registry/src/index.ts:1600-1601`. `createModuleLogger` itself:
  `packages/module-sdk/src/logger.ts:15-17`.
- `WeatherService.resolveLocation` (private, `packages/weather/src/weather-service.ts:52-73`) and
  its caller `getWeatherForUser` (`packages/weather/src/weather-service.ts:30-49`) — current
  fallback chain is stored preference (`weather-location` key) → `geocodeIp` (cached by IP,
  `GEO_CACHE_TTL_MS`). `geocodeIp` returns `null` for `::1`, `127.0.0.1`, `10.*`, `192.168.*`,
  `172.*` (`packages/weather/src/ip-geocoder.ts:20-27`) — this is the LAN-dead-zone the issue
  reports; Tailscale-served traffic (lane A, #1403) lands in this same private-range bucket.
- `WeatherRoutesDependencies` / `registerWeatherRoutes`: `packages/weather/src/routes.ts:1-37`. No
  logger, no timezone param today.
- `/api/me/weather-location` GET/PUT already fully implemented and validated, do not touch:
  `packages/settings/src/weather-location-routes.ts:1-77` (`normalizeWeatherLocation`,
  `sanitizeWeatherLocation`, both bound `lat`/`lon`/trim+cap `label`).
- Shared DTOs already exist, no new shared types needed: `WeatherLocationDto`,
  `GetWeatherLocationResponse`, `PutWeatherLocationRequest`, `PutWeatherLocationResponse` —
  `packages/shared/src/weather-api.ts:18-29`.
- Settings UI insertion point: `ProfilePane`, `Group title="Location"` block,
  `apps/web/src/settings/settings-personal-panes.tsx:206-258`, immediately followed by
  `Group title="Quiet hours"` at 260-305. Both bind `useQuery`/`useMutation` against
  `queryKeys.settings.*` and client fns from `../api/client.js`
  (`apps/web/src/settings/settings-personal-panes.tsx:122-143` shows the exact pattern for locale
  and quiet-hours).
- Client fn pattern to mirror: `getLocaleSettings`/`putLocaleSettings`,
  `apps/web/src/api/client.ts:229-244`.
- **Resolved, not client.ts**: `apps/web/src/api/weather-client.ts:1-8` already exists, holding only
  `getWeatherToday()`, and `queryKeys.weather.location` already exists
  (`apps/web/src/api/query-keys.ts:113-115`) — grep-confirmed zero current usages, i.e. it was added
  in anticipation of this exact feature and is currently dead. Both facts argue for keeping the two
  new client fns in `weather-client.ts` under the existing `weather` query-key group, not folding
  them into the general-purpose `client.ts`. This supersedes the relay doc's lean toward
  `client.ts`— logged in the rulings ledger below.
- No manifest change needed: `packages/weather/src/manifest.ts:1-42` only declares
  `/api/weather/today`; `/api/me/weather-location` is owned by the settings module's manifest, not
  touched by this plan.
- Integration test seam to extend: `tests/integration/weather.test.ts:1-60` already stands up a real
  `createApiServer`, fakes `fetchFn` for both Open-Meteo and `ipwho.is`, and asserts on
  `GetWeatherTodayResponse`/`GetWeatherLocationResponse`. `tests/unit/settings-personal-panes.test.tsx`
  already asserts `html` contains `"Location"` and `"Quiet hours"` (renderToString-based, no test
  runner needed) — the new Group's markup will be asserted the same way.
- UAT precedent for a settings-only, non-chat surface:
  `tests/uat/specs/1264-settings-self-operation.uat.spec.ts:1-60` (`uatLevel = { level: "solo-admin",
without: [] }`, `signIn()` helper). No existing UAT spec or `uat-trigger-map.tsv` row covers
  `settings-personal-panes.tsx` today — both are new.

## Design decisions (open questions from relay, settled)

**1. Timezone → city static table.**
New file `packages/weather/src/timezone-city.ts`, exporting:

```ts
export const TIMEZONE_CITY_FALLBACK: Readonly<Record<string, WeatherLocationDto>>;
export function lookupCityForTimeZone(timeZone: string): WeatherLocationDto | null;
```

- Keyed by **exact IANA timezone id** (the same identifiers `resolveRequestTimeZoneForRoute` /
  `isValidTimeZone` already validate, e.g. `"America/New_York"`) — exact match only, no
  offset/region fuzzy matching. Deterministic and cheap to unit-test.
- Coverage: ~50–70 entries, one representative city per populous IANA zone (region capital or
  largest city — the same city the zone id is usually named after). Authored as static data, no
  network call at build or run time — satisfies the spec's no-new-egress constraint. At this size
  the file is well under the 1000-line gate.
- A miss returns `null`. `resolveLocation` then returns `null` overall, same as today's behavior
  when neither a stored preference nor IP-geo resolves — **not a regression**, just an unfilled
  fallback tier. No requirement to cover all ~430 zones `Intl.supportedValuesOf("timeZone")` lists.
- Not cached (unlike `geoCache`, which exists because IP-geo is a network call). The timezone
  lookup is an in-memory map read; no caching benefit.

**2. `createModuleLogger` threading.** Constructor injection, matching the DI shape of
`preferencesRepo`/`dataContext` and the identical precedent already in the codebase
(`packages/module-registry/src/index.ts:1600-1601`, sports). `WeatherServiceDependencies` gets a
new **required** `logger: FastifyBaseLogger` field. `registerWeatherRoutes` receives it the same
way. `resolveLocation` logs step name + outcome only (`"stored-preference" | "ip-geo" |
"timezone-fallback" | "unresolved"`) — never coordinates, IP, or user id (RLS/privacy invariant).

**3. New client fns location.** `apps/web/src/api/weather-client.ts` (not `client.ts`) — see seams
check above for the evidence (existing dead `queryKeys.weather.location`, existing dedicated
weather-client file). `getWeatherLocationSettings()` / `putWeatherLocationSettings(body)`, same
`requestJson` pattern as `getWeatherToday`.

## Tasks (TDD, green per commit)

### Phase 1 — server-side timezone fallback (closes "IP detection is dead on a LAN")

**Task 1 — `packages/weather/src/timezone-city.ts` + unit test**

- New file exporting `TIMEZONE_CITY_FALLBACK` and `lookupCityForTimeZone`.
- Test: `tests/unit/weather-timezone-city.test.ts` — known zone returns its entry; unknown zone
  (e.g. `"Etc/Unknown"`) returns `null`; every table value has `lat` in `[-90, 90]`, `lon` in
  `[-180, 180]`, non-empty `label` (guards against a typo entry silently passing).

**Task 2 — `WeatherService` timezone fallback**

- `packages/weather/src/weather-service.ts`: add required `logger: FastifyBaseLogger` to
  `WeatherServiceDependencies`; add `timeZone: string` third param to `getWeatherForUser` and
  `resolveLocation`; after `geocodeIp` returns `null`/falls through, call
  `lookupCityForTimeZone(timeZone)` before returning; log step outcome via `this.logger`.
- Test: extend `tests/integration/weather.test.ts` — signed-in user, no stored weather-location
  preference, `fetchFn` mocked so `ipwho.is` call resolves with `{ success: false }` (or request
  made with a private-range IP via `x-forwarded-for`/injected `request.ip`, matching how the
  existing suite already drives `geocodeIp`), `X-Timezone: "Europe/London"` header sent — asserts
  `GET /api/weather/today` returns non-null `data` sourced from the fallback table's London entry
  (via the Open-Meteo fake asserting the lat/lon it was called with). Second case: unrecognized
  timezone header + failed IP-geo → `data: null` (unchanged prior behavior, explicit regression
  guard).

**Task 3 — routes + module-registry wiring**

- `packages/weather/src/routes.ts`: add `logger: FastifyBaseLogger` (required) and
  `resolveRequestTimeZone?: (request: FastifyRequest, accessContext: AccessContext) => Promise<string>
| string` to `WeatherRoutesDependencies`; add local `resolveRouteTimeZone` helper mirroring
  `packages/wellness/src/routes.ts:506-511` exactly (`request.timeZone ?? "UTC"` fallback when DI
  hook absent); pass resolved tz into `service.getWeatherForUser`.
- `packages/module-registry/src/index.ts`, weather registration block (~1571-1580): hoist a single
  `preferencesRepository` const (mirroring wellness's block at 1550), pass it as both
  `preferencesRepo` and into a `resolveRequestTimeZone` closure calling
  `resolveRequestTimeZoneForRoute`; add `logger: createModuleLogger(server.log, "weather")`.
- Test: `tests/integration/weather.test.ts` case from Task 2 already exercises this end-to-end
  (server-level `inject`, real header) — no separate test needed here, this task is what makes that
  test pass.

**Phase 1 verification (unpiped, exit code recorded):**

```bash
pnpm --filter @moss/weather test > /tmp/w6c1-weather-unit.log 2>&1; echo "EXIT=$?"
pnpm vitest run tests/integration/weather.test.ts > /tmp/w6c1-weather-integration.log 2>&1; echo "EXIT=$?"
```

Expected exit code `0` for both (against a freshly created, migrated gate DB per `verify-gate`
skill / `gate-db-isolation-mandatory` — never the live dev DB).

### Kill gate (after Phase 1, before Phase 2 is built)

**Owner: Coordinator.** Stop and re-scope if either holds:

- The Task 2 integration test shows the fallback resolving to a city materially misleading for the
  common case (e.g. a timezone spanning a whole continent maps to a coastal city while most users
  of that zone are inland enough that the weather reads as obviously wrong) — table entries need
  redesign, not a UI bolt-on.
- Keeping the table under ~70 entries turns out insufficient for the LAN/Tailscale dev population
  this issue is actually about (i.e., Ben's own dev-instance timezone isn't resolvable) — this
  would mean the whole fallback-tier approach needs a different shape before Phase 2 is worth
  building on top of it.
  If neither holds, proceed to Phase 2 in the same PR — the phases are independent halves of one
  issue, not separately shippable features, so no separate PR/kill-gate ping is needed unless one of
  the above triggers.

### Phase 2 — settings UI for manual location override (closes "no location UI")

**Task 4 — client fns**

- `apps/web/src/api/weather-client.ts`: add `getWeatherLocationSettings(): Promise<GetWeatherLocationResponse>`
  (`GET /api/me/weather-location`) and `putWeatherLocationSettings(body: PutWeatherLocationRequest):
Promise<PutWeatherLocationResponse>` (`PUT /api/me/weather-location`), `requestJson` pattern
  matching `getWeatherToday`.
- Test: covered by Task 5's render/interaction test (no server involved, thin wrapper) — no
  standalone unit test for this task alone.

**Task 5 — settings UI Group**

- `apps/web/src/settings/settings-personal-panes.tsx`: new `Group title="Weather location"` after
  the existing `Group title="Location"` (timezone/region/date-format) block, before "Quiet hours".
  Fields: a manual override (lat/lon/label, or a single free-text label field submitted with
  geocoding deferred to Stage 2 — **decide the exact input shape as: reuse the already-validated
  `WeatherLocationDto` shape as-is, i.e. three inputs — label (text), lat, lon (number) — since
  Stage 2's browser geolocation is explicitly out of scope and there is no in-scope geocoding
  service to turn free text into coordinates**), a "Clear override" action (PUT `null`), wired via
  `useQuery(queryKeys.weather.location, getWeatherLocationSettings)` /
  `useMutation` calling `putWeatherLocationSettings`, `queryClient.setQueryData` on success —
  exact same shape as the existing `localeQuery`/`localeMutation` pair
  (`apps/web/src/settings/settings-personal-panes.tsx:118-131`).
- Design-system compliance: `jds-*` primitives only (`Select`/`fld`/`fld__row` classes already used
  by the sibling "Location" group), no invented classes — run the invented-class audit from the
  `design-system` skill against `apps/web/src/settings/` before committing this task.
- Test: extend `tests/unit/settings-personal-panes.test.tsx` — `html` contains `"Weather location"`;
  a second test primes `queryClient` with a non-null `GetWeatherLocationResponse` and asserts the
  rendered inputs reflect it (mirrors however the existing suite already primes `localeQuery`/
  `quietHoursQuery`, checked at Task 5 build time).

**Task 6 — UAT spec + trigger-map row**

- New `tests/uat/specs/1402-weather-location-settings.uat.spec.ts`: `uatLevel = { level:
"solo-admin", without: [] }`, `signIn()` per the `1264-settings-self-operation` pattern; navigate
  to Settings → Personal, set a manual weather location via the new Group, assert it persists across
  reload (re-fetch shows the saved value) and that `/today`'s weather section reflects the override
  (`header-weather.tsx` unchanged, just consumes `GetWeatherTodayResponse` sourced from the new
  preference — proves the wiring end-to-end without touching that file). Second case: clear the
  override, assert it reverts to fallback behavior (no crash, no stale value).
- New row in `.claude/skills/coordinate/uat-trigger-map.tsv`:
  `blocking\tapps/web/src/settings/settings-personal-panes.tsx\ttests/uat/specs/1402-weather-location-settings.uat.spec.ts`
  (also add a row for `packages/weather/**` pointing at the same spec, since Phase 1's fallback is
  exercised implicitly by the "reflects on /today" assertion).

**Phase 2 verification (unpiped, exit code recorded):**

```bash
pnpm vitest run tests/unit/settings-personal-panes.test.tsx > /tmp/w6c1-settings-unit.log 2>&1; echo "EXIT=$?"
pnpm exec tsx tests/uat/run-uat.ts tests/uat/specs/1402-weather-location-settings.uat.spec.ts > /tmp/w6c1-uat.log 2>&1; echo "EXIT=$?"
```

Expected exit code `0` for both. (Exact UAT runner invocation confirmed against
`docs/DEVELOPMENT_STANDARDS.md` / existing CI job at build time if this differs.)

### Task 7 — full gate, pre-push trio

```bash
pnpm format:check && pnpm lint && pnpm typecheck > /tmp/w6c1-pretrio.log 2>&1; echo "EXIT=$?"
pnpm verify:foundation > /tmp/w6c1-verify-foundation.log 2>&1; echo "EXIT=$?"
```

Run the second command only via the `verify-gate` skill (isolated gate DB — never the live dev DB,
per `CLAUDE.md`). Expected exit code `0` for both. Rebase on `origin/main` before push.

## Live-path gate

User-facing feature — Task 6's UAT run on a live dev instance is the exit criterion, not CI green.
`coordinated-wrap-up` records the run (`gh pr comment` with UAT output + screenshot of the new
Settings group and `/today` showing a fallback-resolved location on a simulated LAN request), or
states explicitly "code-complete, unverified" if the live run can't be completed before handoff.

## Rulings ledger

- Client-fn location resolved to `weather-client.ts`, not `client.ts` as the relay doc leaned —
  `queryKeys.weather.location` already exists and is unused, and `weather-client.ts` already exists
  as a dedicated file; both outrank the generic locale/quiet-hours precedent.
- Timezone-city table is exact-IANA-id match only, no fuzzy/offset matching, and does not aim for
  full `Intl.supportedValuesOf("timeZone")` coverage — a miss degrades to today's existing
  "no location resolved" behavior, not a new failure mode.
- `createModuleLogger` is constructor-injected as a required field, matching the sports module
  precedent exactly (`packages/module-registry/src/index.ts:1600-1601`) rather than inventing a
  per-call param shape.
- No manifest change: `/api/me/weather-location` belongs to the settings module's manifest already;
  weather's manifest only owns `/api/weather/today`.
- GitHub issue #1402's own "rank order" section (favoring more egress) is stale, pre-design-
  settlement text — the approved spec's "Design forks — settled" + Non-goals sections supersede it.
  Already flagged by relay; restated here so it isn't rediscovered.
