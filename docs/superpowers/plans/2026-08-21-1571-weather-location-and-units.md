# Plan — 1571 Weather Location and Units

Spec: docs/superpowers/specs/2026-08-17-1571-weather-location-and-units.md
Issue: #1571 (task issue confirmed in handoff)

## Seams check (verified on branch, file:line)

- packages/weather/src/weather-service.ts:63 hardcodes `"metric"` in the `fetchOpenMeteoForecast` call — confirms spec premise "always requests Celsius."
- packages/weather/src/weather-service.ts:9,83-95 — `WEATHER_LOCATION_KEY = "weather-location"`, read directly via `preferencesRepo.get`. No unit key exists anywhere (`grep -rn "weather-unit"` = no hits).
- packages/settings/src/weather-location-routes.ts — GET/PUT `/api/me/weather-location`, DTO `{lat,lon,label}`, no geocoding, no search. Confirms "coordinates only" premise.
- packages/settings/src/weather-location-tool.ts — assistant tool `weatherLocationSetInputSchema` requires `{lat,lon,label}` directly, i.e. it already invents/accepts coordinates from the model. Confirms spec item 19/decision to replace with place-text input.
- apps/web/src/settings/settings-personal-panes.tsx:330-397 — UI has three raw inputs: label, lat, lon (`type="number"`). Confirms premise; this whole block is replaced in Phase 2.
- packages/shared/src/weather-api.ts — `WeatherLocationDto {lat,lon,label}`, `WeatherTodayDto.unit: "metric"|"imperial"` already exists as the internal contract (decision: reuse, do not change the metric/imperial enum, just stop hardcoding it).
- packages/settings/src/quiet-hours-tool.ts and quiet-hours-routes.ts are the closest prior-art pair for a simple preference GET/PUT + assistant tool — used as the template for the new weather-unit routes/tool shape.
- Module dependency graph (`packages/*/package.json`): settings does NOT currently depend on `@moss/weather`; but sibling-module dependencies are precedented (e.g. `@moss/chat` depends on `@moss/calendar`/`@moss/email`/`@moss/notes`/`@moss/tasks`; `@moss/connectors` depends on `@moss/calendar`/`@moss/email`). Adding `@moss/settings -> @moss/weather` for the shared Open-Meteo geocode client is consistent with existing patterns — not a new architectural shape.
- `apps/web/src/settings/settings-ui.tsx:1` re-exports `Switch` from `@moss/ui`, already used as a boolean toggle at settings-personal-panes.tsx:407 (quiet hours enabled). This is the slide-toggle component for °F/°C — no new UI primitive needed (design-system skill: reuse only).
- `.claude/skills/coordinate/uat-trigger-map.tsv:77-80` has two `blocking` rows pointing at `tests/uat/specs/1402-weather-location-settings.uat.spec.ts` for `settings-personal-panes.tsx` and `packages/weather/**`. That spec drives the raw lat/lon inputs directly by aria-label and will break under the new UI — it is superseded, not extended.

## Determinism boundary

Geocoding is deterministic place resolution via Open-Meteo's geocoding API, never an LLM guess (spec's own words). The assistant tool for location never invents coordinates and never picks among ambiguous candidates itself — ambiguity is surfaced back to the user via ordinary conversation, and a follow-up call is just a refined `query` string (no new "pick candidate N" input — keeps the tool's only job to "resolve this text to a place or report why not," under the two-job/150-word guidance rule). No model-authored value is ever persisted directly: only a candidate returned by the resolver is stored.

## Phase 1 — Backend (geocoding, unit preference, cache correctness, assistant tool)

### New files

- `packages/weather/src/open-meteo-geocode.ts`
  ```ts
  export class WeatherLocationSearchUnavailableError extends Error {}
  export interface GeocodeCandidate { readonly lat: number; readonly lon: number; readonly label: string }
  export async function searchOpenMeteoLocations(
    query: string,
    fetchFn?: typeof fetch,
    limit?: number
  ): Promise<GeocodeCandidate[]>
  ```
  Calls `https://geocoding-api.open-meteo.com/v1/search?name=<encodeURIComponent(query)>&count=10&language=en&format=json`. Empty/missing `results` -> `[]`. Non-OK response or bad JSON -> throw `WeatherLocationSearchUnavailableError`. Label built as `` `${name}${admin1 ? ", " + admin1 : ""}, ${country}` ``. Cap returned candidates to `limit` (default 5).

- `packages/settings/src/weather-location-search-routes.ts`
  ```ts
  export interface WeatherLocationSearchRoutesDependencies {
    readonly resolveAccessContext: (request: FastifyRequest) => Promise<AccessContext>;
    readonly fetchFn?: typeof fetch;
  }
  export function registerWeatherLocationSearchRoutes(server, deps): void
  ```
  `GET /api/me/weather-location/search?query=` -> auth via `resolveAccessContext` only (no data context — stateless search). Empty/missing query -> `{ candidates: [] }`. Provider failure -> 502 `{ error: "Weather location search is temporarily unavailable" }`. Success -> `{ candidates: GeocodeCandidate[] }`.

- `packages/settings/src/weather-unit-routes.ts` (mirrors quiet-hours-routes.ts shape exactly)
  ```ts
  const WEATHER_UNIT_PREFERENCE_KEY = "weather-unit"; // must match weather-service.ts's WEATHER_UNIT_KEY exactly
  export function registerWeatherUnitRoutes(server, deps: { dataContext, resolveAccessContext, preferencesRepository }): void
  ```
  `GET /api/me/weather-unit` -> `{ unit: "metric" | "imperial" }`, defaults to `"metric"` when unset (never persists the default). `PUT /api/me/weather-unit` body `{ unit }` (no null/clear state) -> upsert, return `{ unit }`.

### Edited files

- `packages/shared/src/weather-api.ts`: add `WeatherUnit = "metric" | "imperial"` (reuse in `WeatherTodayDto.unit`), `WeatherLocationCandidateDto` (= `WeatherLocationDto` shape), `SearchWeatherLocationsResponse { candidates: readonly WeatherLocationCandidateDto[] }`, `searchWeatherLocationsRouteSchema`, `WeatherUnitDto { unit: WeatherUnit }`, `GetWeatherUnitResponse`, `PutWeatherUnitRequest`/`Response`, `getWeatherUnitRouteSchema`, `putWeatherUnitRouteSchema`.
- `packages/weather/src/weather-service.ts`: add `WEATHER_UNIT_KEY = "weather-unit"`, `resolveUnit(accessContext): Promise<"metric"|"imperial">` (reads preference, validates enum, defaults `"metric"`). `getWeatherForUser` resolves both location and unit, includes unit in the cache-sameness check (extend `ResolvedLocation`/`CachedWeather` or add a sibling `unit` field compared alongside `sameLocation`), and passes the resolved unit (not the literal `"metric"`) into `fetchOpenMeteoForecast`.
- `packages/weather/src/index.ts`: export `searchOpenMeteoLocations`, `GeocodeCandidate`, `WeatherLocationSearchUnavailableError`.
- `packages/settings/src/weather-location-tool.ts`: input schema becomes `{ query: string (minLength 1) }` only. Execute: call `searchOpenMeteoLocations`; 0 results -> `HttpError(404, ...)`; >1 -> return `{ data: { status: "ambiguous", candidates } }`, no write, no undo push; exactly 1 -> existing upsert/undo-stack logic, return `{ data: { status: "saved", lat, lon, label } }`. Output schema updated to a `oneOf` of the two shapes.
- `packages/settings/src/routes.ts`: wire `registerWeatherLocationSearchRoutes` and `registerWeatherUnitRoutes` alongside the existing `registerWeatherLocationRoutes` call; thread `fetchFn` through `SettingsRoutesDependencies` (add optional field, matching the `apps/api/src/server.ts:612` `fetchFn: options.fetchFn` pattern already used for the module-distribution port).
- `packages/settings/src/manifest.ts`: add the two new routes (`GET /api/me/weather-location/search` permissionId `settings.view`; `GET`/`PUT /api/me/weather-unit` permissionId `settings.view`/`settings.write`), update `weatherLocationSetInputSchema`/`weatherLocationOutputSchema` imports (same names, new shape) and the tool's `description` text.
- `packages/settings/package.json`: add `"@moss/weather": "workspace:*"`.

### Tests (contract/integration — this phase's e2e proof)

- New: geocode unit tests for `searchOpenMeteoLocations` — no results, single result, multiple results, provider HTTP error, provider non-JSON body.
- Extend `tests/integration/weather.test.ts`: prove both `"metric"`/`"imperial"` are requested and returned end to end through `/api/weather/today`; prove a location change AND a unit change each invalidate the actor's cached weather (no stale reuse).
- Extend `tests/integration/settings-weather-location-tool.test.ts`: query-based save (unique match), ambiguous match returns candidates and does not write, no-results throws and does not write, owner scoping unchanged.
- New: `tests/integration/settings-weather-location-search.test.ts` — route contract for unique/ambiguous/no-results/provider-error.
- New: `tests/integration/settings-weather-unit.test.ts` — GET default, PUT persists, owner scoping.

Verification command (expected exit 0):
```bash
pnpm --filter @moss/weather --filter @moss/settings test > /tmp/1571-phase1.log 2>&1; echo "EXIT=$?"
```
Then the gate-DB integration run per the `verify-gate` skill recipe (not improvised).

### Kill gate (owner: coordinator, after Phase 1 lands)

End the line here — do not proceed to Phase 2 UI — if either:
1. Open-Meteo's geocoding endpoint does not return usable candidates for ordinary queries (e.g. "San Diego, CA") when called from this server (network egress, rate limit, or response-shape mismatch discovered against the live provider), or
2. the cache-invalidation fix reveals `WeatherCache` cannot be made to key on both location and unit without a deeper rework (i.e. the one-line extension above turns out not to be one line).

Escalate to the coordinator with the concrete failure instead of improvising a workaround.

## Phase 2 — Frontend + live-path proof (planned in detail only after Phase 1 is judged; sketch below for continuity)

- `apps/web/src/api/weather-client.ts`: add `searchWeatherLocations(query)`, `getWeatherUnitSettings()`, `putWeatherUnitSettings(unit)`.
- `apps/web/src/api/query-keys.ts`: add `weather.unit`.
- `apps/web/src/settings/settings-personal-panes.tsx`: replace the label/lat/lon inputs (lines ~330-397) with a free-text query field + explicit "Search" button + candidate list (button per candidate, single candidate still requires one click same as multiple) + "Currently using X" line + existing "Clear override" button; add a `Switch`-based °F/°C row reading/writing the new unit preference, invalidating `weather.today` on change (same pattern as the existing location mutation at line ~198).
- Rewrite `tests/uat/specs/1402-weather-location-settings.uat.spec.ts` -> `tests/uat/specs/1571-weather-location-and-units.uat.spec.ts` per the spec's Testing Decisions script: save a real place -> Today updates; change place -> Today updates again; ambiguous "Springfield" -> candidates shown, nothing saved until chosen; toggle °F/°C -> displayed temps change, location unchanged. `git rm` the old spec file (superseded, not kept alongside).
- Update `.claude/skills/coordinate/uat-trigger-map.tsv` lines 77-80: repoint both existing rows at the new spec filename, add a `packages/settings/**` row.
- No new assistant tool for units (spec's decisions only call out updating the *location* assistant action; adding a units tool would be scope creep not asked for).

Phase 2 e2e test: the rewritten Playwright UAT spec, run and observed passing against a live dev instance — this is also the PR's live-path proof comment.
