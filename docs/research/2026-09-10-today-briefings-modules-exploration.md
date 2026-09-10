# Today briefings and module plumbing exploration

## Scope and evidence

This note traces existing Today module contributions, briefing sources, and the News, Sports,
Weather, and Wellness seams needed by the approved morning and evening Today flows.
It deliberately excludes the core Today layout and the scheduler/backend job implementation.
Evidence is from the current checkout at `HEAD 497cf0217`, source and tests referenced below.
The prototype constraints remain binding: fictional data/assets are suitable for a prototype only;
they are not production provenance.
The approved behavior enables Morning News and Sports by default, keeps their opt-outs independent,
lets explicit exclusions win, and keeps disabled modules from producing content or making requests.
Baseline reconciliation: this report's direct line references describe detached `HEAD 497cf0217`.
`origin/main 27e9fef5a` is newer; relevant News/Sports deltas are called out below so a future plan
base does not reimplement work already present there.

## Existing Today module contribution path

`packages/module-web-sdk/src/index.ts:25-46` defines the public browser contract:

- `ModuleWebContribution.moduleId` must match the backend manifest id.
- `routes` contains public route elements.
- `todayWidgets` contains `{slot, element}` contributions.
  `packages/settings-ui/src/scanner.ts:209-221` emits the virtual module containing
  `MODULE_WEB_ROUTES` and `MODULE_WEB_CONTRIBUTIONS` from discovered package `./web` entries.
  `apps/web/src/today/module-today-widgets.tsx:14-29` turns each contribution into a stable lazy
  component, imports its `default`, and renders every declared widget in its own fragment.
  `module-today-widgets.tsx:31-45` accepts `disabledModuleIds`, filters by module id, and gives each
  module an independent `Suspense` boundary with a null fallback.
  This is a useful isolation boundary: a module can own its API query and view, while Today only
  knows the registry and disabled ids.
  The current generic renderer passes no time zone, briefing definition, source policy, error state,
  or freshness context. Module widgets therefore use their own authenticated client/query contracts.
  `packages/news/src/web/index.tsx:14-26` registers module id `news`, `/news`, and a `brief` Today
  widget. `packages/sports/src/web/index.tsx:14-27` does the same for `sports`.
  Adding a new module contribution is consequently a public `./web` change plus manifest/app-map
  metadata and contribution tests; no per-module branch belongs in the Today renderer.
  `rg` finds only two concrete Today slots in the tree: News and Sports both declare `slot: "brief"` (`packages/news/src/web/index.tsx:25`, `packages/sports/src/web/index.tsx:26`). The host currently ignores the slot value: `module-today-widgets.tsx:18-24` maps every widget and `today-page.tsx:437` mounts the whole registry once after the calendar area. Smallest placement extension: let the existing renderer accept a slot filter and mount it at two host points—core Today quick actions beside the schedule and `brief` module widgets below—without a second registry or hard-coded News/Sports imports.

## Briefing composition and source gates

`packages/briefings/src/routes.ts:336-365` accepts `selectedToolNames`, or applies
`defaultToolNamesFor(briefingType)`, then validates read-risk tool names.
`routes.ts:404-429` rejects an empty selection, unknown/non-read tools, and duplicate names are
deduplicated. It does not check whether the selected tool's module is currently active.
Current defaults at `routes.ts:530-549` include `sports.followedFactsToday` for both morning and
evening, but omit `news.topHeadlinesToday` from morning and evening.
This is the main default migration gap for the approved independent News + Sports switches.
`packages/briefings/src/compose.ts:414-433` gathers Sports through the compact tool and emits only
sanitized `row.text`; no score object, URL, or other tool fields cross into the AI prompt.
`compose.ts:435-441` appends Goals and Sports only when their selected tool names are present.
`packages/briefings/src/external-contributions.ts:96-139` provides the module extension seam:
manifest declarations are filtered by selected tool and section before invocation, run in parallel,
sanitized/parsed, and failures are dropped so one module cannot fail the briefing.
`packages/briefings/src/compose.ts:443-461` injects those external contributions only when the
worker supplies both manifests and an invoker. A missing invoker is an intentional no-op in tests.
`packages/briefings/src/compose-shared.ts:241-250` delegates source behavior to
`isBehaviorEnabled`; absent policy defaults to enabled.
`packages/source-behaviors/src/index.ts:71-88` gives explicit overrides precedence, then manifest
defaults, while missing or coming-soon behavior is disabled. The existing briefing source policy
only has email and calendar controls (`apps/web/src/settings/settings-source-behaviors.ts:12-23`).
`packages/briefings/src/freshness.ts:27-66` records realtime captured time, connector sync time,
or vault last-write time. Unknown section keys are treated as realtime, and failed timestamp
lookups produce a null `asOf`; the version is currently 1.
The Today freshness labels (`apps/web/src/today/briefing-freshness.tsx:1-75`) know email, calendar,
vault, tasks, commitments, chats, and goals. News and Sports keys would display raw keys unless
the label map is extended.

## News: API, provider, storage, public source, consumer

The module manifest (`packages/news/src/manifest.ts:64-165`) declares default-enabled, user-toggleable
News, permissions `news.view`, `news.prefs`, and `news.credentials`, and `/api/news/overview` plus
preference, personalization, image, favicon, and refresh routes.
Its feature declarations (`manifest.ts:492-584`) include story pictures, adding a source, and
described topics with errors/remediation. These declarations must stay truthful when Today behavior
or failure states change.
The manifest assistant description (`manifest.ts:312-330`, nearby) describes the briefing read tool
as at most five short `Title — Source` facts, read-only and briefing-oriented.
`packages/news/src/briefing-tool.ts:27-39` constructs `NewsService` with a dataset client,
`NewsPrefsRepository`, and `NewsPersonalizationRepository`.
`briefing-tool.ts:41-54` asserts the gateway-scoped DB and returns `{data:{facts}}`; it throws a
composition-root error if configuration has not happened.
The dataset client is created from manifest-declared `newsfeeds` and the RSS adapter in
`packages/module-registry/src/index.ts:2264-2277`. Host pinning and TTLs therefore remain in the
manifest/provider boundary.
`packages/news/src/news-service.ts:132-170` reads preferences, exclusions, custom sources/topics,
latest snapshot, and dismissed story refs under `DataContext`, composes personalized output, calls
the stale callback when needed, and registers story feedback targets.
`news-service.ts:173-194` reuses those preferences, exclusions, snapshot, and composition for the
briefing tool, returning only five sanitized `Title — Source` strings.
The public `NewsOverviewResponse` (`packages/shared/src/news-api.ts:84-96`) includes ranked/top
stories, source groups, active topics, enabled sources, and a degraded flag.
Each `NewsHeadline` (`news-api.ts:52-75`) carries sanitized title/url/published time, an allow-listed
HTTPS or authenticated same-origin `imageUrl`, same-origin favicon, plaintext summary, and an
opaque optional feedback reference.
`packages/news/src/web/today-widget.tsx:52-103` shares the News overview query key with `/news`.
It returns null for no data/stories, caps the list, renders a photo and summary on the lead, and
source favicon/title rows plus feedback menus for the remainder.
This already satisfies the Today card's photo/prose treatment and privacy boundary. Do not send
article bodies or arbitrary remote URLs into the briefing model; use the structured headline fields.
News settings explicitly say choices shape briefings (`packages/news/src/settings/index.tsx:519-524`).
Publisher exclusions are stronger: `index.tsx:738-748` says excluded publishers never appear in
News, Today, or briefings, and the service prunes them from the current snapshot.
The missing product seam is structured News briefing output. The existing facts are intentionally
compact strings, while the approved morning prose/photos need a structured, sanitized payload or a
separate display-only read path that does not expand model input with article text.

## Sports: API, provider, storage, public source, consumer

The Sports manifest (`packages/sports/src/manifest.ts:83-192`) is default-enabled, user-toggleable,
and declares source icons, subreddit/story feedback, result scorers, and source photos.
The ESPN source is manifest-backed (`manifest.ts:570-585`); `createEspnDatasetAdapter` is publicly
exported from `packages/sports/src/index.ts:25-33`.
`packages/sports/src/briefing-tool.ts:27-37` builds `SportsService` with the dataset client,
gateway-scoped DB stub, and `SportsFollowsRepository`.
`briefing-tool.ts:39-52` requires scoped DB, requires prior configuration, and invokes
`getFollowedFactsForToday` for the actor.
`sports-service.ts:792-832` lists follows, filters them against the catalog, caches a scoreboard by
competition/day, emits team facts or a count of league games, and catches all failures to return
empty facts. This gives safe degraded prose but hides the error from the caller.
The richer public DTO (`packages/shared/src/sports-api.ts:293-307`) includes hero, followed cards,
`scoreboard`, top stories, league news, standings, followed refs, active followed-league cards, and
`degraded`.
`sports-api.ts:28-36` defines game state, status, scores, and team sides. `ScoreboardGroup` at
`sports-api.ts:264-268` supports multiple competitions and games, which is enough for finals,
live scores, and an independently filtered Tonight group.
`sports-api.ts:241-262` gives followed league results (live/final, score line, status) and league
stories/photos. Active competition cards are omitted when off-season.
`packages/sports/src/web/today-widget.tsx:24-75` shares the overview query/cache with `/sports`,
refetches only while a live game exists, hides feedback-dismissed stories, orders followed teams,
and caps them at four plus league cards.
`sports/src/web/today-widget.tsx:85-142` renders a photo/prose lead and three world-of-sport story
links before followed cards; story URLs and feedback refs are already sanitized/opaque.
The current Today Sports widget does not render `data.scoreboard` and has no dedicated Tonight
section. This is the clearest approved-flow gap: reuse the overview scoreboard and existing
`packages/sports/src/web/sports-around-ticker.tsx:66-191` ordering ideas, or a small sports-local
score list, without making a second provider request.
The scoreboard cache and provider failure path support degraded output, but the widget needs an
explicit empty/error copy and a way to distinguish no games from provider failure if the design
requires recovery messaging.
On `origin/main 27e9fef5a`, the Sports API adds permanent `sourceTeamId` identity fields and
`ambiguousFollows` (`packages/shared/src/sports-api.ts:117-156,332-348` on origin/main). Its
`sports-service.ts:474-506` resolves identity once, excludes ambiguous follows from cards/scores/
briefing facts, and returns candidates for remediation. Use source ids for followed-team ordering;
do not match by the saved short `teamKey`. The same newer service uses a five-league default slate
when there are zero follows (`sports-service.ts:211-219,410-414`), so an empty follow list does not
necessarily mean an empty Sports Today widget.
The Sports widget itself is unchanged on origin/main, so the scoreboard/Tonight gap remains. The
newer custom-source photo pipeline stores owner-scoped copies and exposes same-origin photo paths
with dimensions (`source/public-source-reader.ts:283-315`); its feed → verified rule → article-share
fallback and swallowed failures are implemented in `source/photo-pass.ts:28-99`. Preserve this
provenance instead of adding another remote-image fetch. News' origin/main widget delta is only a
light favicon tile (`news/src/web/today-widget.tsx:14-44`); NewsHeadline/Overview contracts and the
photo/prose gap conclusions above remain valid. Origin/main still has the same briefing defaults.

## Weather wiring and provenance

`packages/weather/src/routes.ts:45-51` serves `/api/weather/today` through `getWeatherForUser`.
`packages/weather/src/weather-service.ts:48-82` resolves stored location, IP geolocation, or a
timezone-city fallback; resolves unit preference; caches per-user data for 30 minutes; calls the
Open-Meteo adapter; and returns null for known provider unavailability.
`packages/weather/src/open-meteo.ts:59-109` requests current conditions plus daily highs/lows for
five days, maps WMO codes, and maps days after today into `WeatherForecastDayDto`.
`packages/shared/src/weather-api.ts:7-31` already exposes current temp/condition/high-low context,
location/unit, humidity/wind, coordinates, and a forecast array. No captured-at/freshness field is
present in this DTO.
`apps/web/src/today/header-weather.tsx:32-73` maps current data and all forecast days into
`WeatherChip`; `packages/ui/src/weather-chip.tsx:3-69` accepts arbitrary day tiles.
Issue #1919 asks for this five-day extension, but the current HEAD has most of it already. Treat the
issue as stale/partially implemented: remaining work is approved Today prominence/chip treatment,
unavailable/loading copy, and deciding whether weather needs an explicit as-of timestamp.
Weather's null response currently makes the header disappear. A briefing or prominent Today card
needs a recoverable unavailable state without fabricating conditions or freshness.

## Wellness preservation and module disablement

Wellness is currently hard-coded core Today behavior, not a module web contribution.
`apps/web/src/app.tsx:162-179` derives inactive ids from `/api/me/modules`; module gating fails
closed on errors and requires an explicit active row. `today-page.tsx:437` passes ids to generic
widgets and `today-page.tsx:584-637` renders Wellness only when enabled.
The medication action uses `/api/wellness/medications/schedule` and dose logging in
`apps/web/src/wellness/wellness-today.tsx:193-242`, invalidating schedule/adherence/insight caches
after success.
The check-in component (`wellness-today.tsx:454-650`, `683-707`) supports emotion quick picks,
streak/start actions, completed-state edit/check-in-again, and the existing rich modal.
The Wellness manifest (`packages/wellness/src/manifest.ts:37-117`) is default-enabled,
user-toggleable, non-required, and declares the check-in/medication routes and permissions.
Preserve those dialogs and quick actions. Disabled Wellness must avoid mounting the components and
queries, as the existing gate does; the same active-module rule should apply to News and Sports.

## Settings, precedence, metadata, and recovery

Briefing settings (`apps/web/src/settings/settings-module-subviews.tsx:85-143`, `214-234`) load
definitions, AI read tools, and source behaviors. New definitions are populated from every read tool
returned by `listAiAssistantTools`; there are no dedicated News/Sports briefing checkboxes.
`packages/shared/src/briefings-api.ts:63-83,131-135,226-251` makes `selectedToolNames` optional on
create/update requests but currently applies `minItems: 1` whenever present; `routes.ts:404-411`
enforces the same rule. The planned contract should distinguish omitted (apply defaults) from
explicit `[]` (all selected sources off), relax this validation consistently, and make composition
produce a graceful no-source result. This permits both News/Sports toggles off even for a definition
whose only selected tools are those two.
Adding News to `defaultToolNamesFor` is necessary but insufficient for independent opt-outs. Reuse per-definition `selectedToolNames`: apply the new News default only when a create request omits the list, and preserve existing explicit lists. Add independent UI toggles that edit that list; do not introduce a redundant preference store unless later evidence requires global behavior.
Precedence should be: disabled module, explicit module/source exclusion, user opt-out, then default
enabled. Stored selected tools may remain for re-enable, but composition must skip inactive modules
and expose a stable gap/unavailable reason rather than invoke a disabled provider.
`collectExternalBriefingContributions` already demonstrates filtering before invocation and swallowing
module failures. The same principle should govern built-in News/Sports, with module-owned error text
and no secret/provider payload leakage.
Any new Today feature, error, or remediation must update the owning manifest feature metadata or
`packages/shared/src/app-map-core.ts`; module route literals are separately scan/regression tested.

## Reuse and missing work matrix

| Area          | Reuse now                                                            | Extend                                   | Missing/risk                                       |
| ------------- | -------------------------------------------------------------------- | ---------------------------------------- | -------------------------------------------------- |
| Today widgets | module-web scanner, lazy registry, disabled-id filter                | optional shared context only if required | no common freshness/error context                  |
| News card     | `getNewsOverview`, query key, headline photo/summary/feedback        | structured briefing-safe facts           | compact briefing tool lacks photo/prose payload    |
| Sports card   | `getSportsOverview`, query key, story/photo/followed cards           | render scoreboard + Tonight              | current widget drops `scoreboard`                  |
| Sports scores | `SportsOverviewResponse.scoreboard`, cache, ticker ordering          | filter live/final/tonight presentation   | no Today consumer or no-games/provider distinction |
| Briefings     | selected read tools, source policy, external contribution trust gate | News default and module-active gate      | no independent News/Sports settings                |
| Weather       | Open-Meteo five-day DTO and WeatherChip days                         | prominent Today state/as-of policy       | null silently removes UI; #1919 overlap            |
| Wellness      | existing rich dialogs and fail-closed gate                           | none for content contract                | avoid accidental remount/query changes             |

## Implementation slices and dependencies

1. Reuse per-definition `selectedToolNames`; add News to defaults only for omitted create lists, preserve explicit lists, and define independent toggles, exclusion semantics, and disabled-module precedence.
2. Add the News briefing-safe structured source or display payload, retaining sanitized headline
   fields and the existing compact AI tool where it remains useful.
3. Add Sports Today scoreboard rendering and Tonight filtering over the existing overview response;
   keep followed teams first and preserve photo/story feedback behavior.
4. Extend briefing freshness labels and unavailable/degraded status handling for News, Sports, and
   Weather; add manifest/app-map declarations for new errors/remediations.
5. Verify composition-root setup and worker boot ordering for both late-bound briefing services.
   Issue #2313 reports Sports invoked before `configureSportsBriefingService`; News has the same
   pattern at `news/briefing-tool.ts:25-52` and should receive the same verification.

Dependencies run from preference semantics to briefing composition, then module consumers; weather
and Wellness can proceed independently except for shared Today status conventions. The
[implementation plan](../superpowers/plans/2026-09-10-today-briefings.md) proposes source-owned
photo references, actor-local sports windows and explicit empty selections across schema/parser/SQL.

## Verification plan

Run focused unit/UI checks after each slice: `tests/unit/news-today-widget.test.tsx`,
`tests/unit/news-web-contribution.test.ts`, and `tests/unit/sports-web-contribution.test.ts`.
Cover default and update parsing in `tests/unit/briefings-default-tools.test.ts` and composition,
sanitization, source gates, and degraded gaps in `tests/unit/briefings-compose.test.ts`.
Cover News/Sports preference and provider behavior with `tests/unit/news-service.test.ts` and
`tests/unit/sports-service.test.ts`, including exclusions, follows, cached scoreboard, and failures.
Use `tests/unit/open-meteo.test.ts` and `tests/unit/weather-service.test.ts` for five-day mapping,
location/unit resolution, cache reuse, and unavailable provider behavior.
Use module browser-safety/contribution tests and route guard tests to ensure public `./web` imports
stay backend-free and inactive module routes/widgets fail closed.
Avoid broad DB/foundation tests for these slices. Add a focused boot-order regression for #2313 if
the repository's existing harness can exercise the composition root without starting infrastructure.

## Issue overlap

GitHub #1919 is largely represented in current code: five-day Open-Meteo data, DTO forecast days,
HeaderWeather mapping, and WeatherChip day tiles all exist. Audit remaining visual prominence and
freshness/unavailable behavior before reopening backend scope.
GitHub #2313 remains a real integration concern despite synchronous registry calls at
`packages/module-registry/src/index.ts:2156-2159` and `2264-2277`. The late-bound singleton can still
be called first by a worker/test path that bypasses the expected boot sequence; verify both modules,
then make the failure observable and recoverable without exposing provider details.
