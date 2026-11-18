# Rust Phase 5: News, Sports and Weather port plan

Part of https://github.com/motioneso/moss/issues/4027. This is a planning document. It builds
nothing. It follows the rules in `2026-11-06-rust-port-plan.md` (Phase 5) and
`2026-11-07-rust-module-packages-and-registry-design.md` (sections 5 and 7), and copies the layout
of `2026-11-11-rust-phase5-email-connectors-plan.md` and
`2026-11-11-rust-phase5-meetings-briefings-plan.md`.

Every claim about the old TypeScript app was read from the files named below. Anything marked
**Guess** is my inference and needs checking before a builder relies on it. Every other choice is
taken here as a **Decision**, with the reason. Only real product choices are left for Ben, and
they are marked **Ben**.

## 1. Summary

- Three legacy packages are in scope. **News** (`packages/news`, about 14,900 lines, 9 SQL files,
  8 owned tables) builds a personal front page from feeds, subreddits, a keyed publisher and
  described topics. **Sports** (`packages/sports`, about 22,900 lines, 12 SQL files, 6 owned
  tables) follows teams, shows scores, standings and team news, and reads publishers the person
  adds, with an isolated browser helper for pages that need one. **Weather** (`packages/weather`,
  about 1,550 lines, no SQL) shows today's weather and an hourly forecast for a saved or guessed
  place.
- **Recommendation.** Port them as three registry packages, in this order: Weather first (small,
  proves the outside-fetch path end to end), then News, then Sports. Sports reuses News's feed
  reader, and its browser helper is the riskiest piece. All three port as they are, with no
  redesign (registry design section 7: "Finance, meals, wellness, sports and news port as they
  are").
- **Briefings is waiting on these.** The Rust Briefings package already lists news, sports and
  weather sections and shows them as gaps today (`modules/briefings/src/evening.rs:198-203`,
  `morning.rs:186`). Parts 7, 12 and 20 close those gaps.
- **Two platform gaps block this work.** First, the Rust fetch port only reaches exact host names
  fixed in the manifest (`rust-spike/module-host/src/manifest.rs:299-301,589`), but News and
  Sports read any public site the person adds. Part 1 adds a "public web" fetch mode. Second, no
  `browser` port exists yet (registry design 5.1 says it is built in Phase 5). Part 15 builds it.
- **New crates are needed.** The workspace lock file has no HTML or XML parser, no CSS selector
  engine, no public-suffix list, no image re-encoder and no browser-protocol client (checked in
  `rust-spike/Cargo.lock`). The legacy code uses `htmlparser2`, `css-select`, `tldts`, `sharp`
  and `playwright-core`. Ben approves a short crate list before parts 2, 15 and 17 start
  (section 7.2).
- The work splits into 27 parts (section 7). Screens are 5 separate parts, each held for Ben's
  agreement on the mockups before it is built.

## 2. What the legacy modules do

### 2.1 News

The person opens News (route `/news`) and sees a mosaic of today's stories, a lead story with art,
filters, and a story menu to hide a source or give feedback. Today shows a small News widget.

What feeds it:

- **A fixed catalog** of publishers with known feed and image hosts
  (`source/catalog.ts`, `NEWS_FETCH_HOSTS`, `NEWS_IMAGE_HOSTS`).
- **Sources the person adds.** They paste a site or feed address. Moss finds the feed, checks it,
  and shows a preview before saving (`discovery/feed-discovery.ts`, `source-resolution.ts`,
  `policy-validation.ts`, `preview-store.ts`). Subreddits are a source kind too
  (`source/reddit-reader.ts`, SQL 0218).
- **Described topics.** The person describes a topic in words. Moss finds stories for it through
  a web search port. When web search is off, the settings screen names the reason and the fix
  (`settings/describe-topics.tsx:68-72`, `routes.ts:66-68`).
- **A keyed publisher** (NewsAPI, the only entry in `PUBLISHER_CONNECTIONS`,
  `source/newsapi-connection.ts:109-115`). The person pastes their own key. It is stored
  encrypted with the label "news credential secret" and the key ring
  `JARVIS_NEWS_CREDENTIAL_SECRET_KEY` (`packages/module-registry/src/news-credential-cipher.ts`).

How a page is built: a refresh job gathers candidates from every source, filters them, asks the
person's model to rank them for relevance (`compilation/rank.ts:97`, "UNTRUSTED DATA, never
instructions"), falls back to a fixed order when the model is unavailable, and stores a
compilation snapshot. A daily job at 04:43 rechecks every saved source and topic and records its
health (`schedule.ts:16`, SQL 0161, 0204). Fetching goes through a safe fetch that refuses
non-HTTPS addresses, honours robots rules, and reports a reason when it fails
(`discovery/ports.ts`: blocked, robots, rate_limited, http_error, challenge, timeout, network,
not_https). Images and site icons are served through Moss, not linked directly
(`image-route.ts`, `favicon-route.ts`).

Files. `packages/news/src/` (`news-service.ts`, `repository.ts`, `personalization-*.ts`,
`compilation/*`, `discovery/*`, `source/*`, `credential-*.ts`, `jobs.ts`, `schedule.ts`,
`revalidation.ts`, `chat-tools.ts`, `briefing-tool.ts`, `briefing-evidence.ts`,
`approval-presentation.ts`, `story-feedback-port.ts`, `data-lifecycle.ts`), web
`web/news-page.tsx`, `news-mosaic.tsx`, `lead-art.tsx`, `today-widget.tsx`,
`story-feedback-menu.tsx`, settings `settings/index.tsx`, `add-source.tsx`,
`connect-publisher.tsx`, `describe-topics.tsx`, `story-feedback.tsx`. Specs:
`2026-07-08-news-module.md`, `2026-07-11-personalized-news-sources-topics.md`,
`2026-07-12-news-settings-dogfood-hardening.md`, `2026-07-19-1185-news-caption-excerpt.md`,
`2026-08-26-950-news-credentialed-publisher-sources.md`,
`2026-09-04-news-sources-subreddits-and-feed-finder.md`.

### 2.2 Sports

The person follows teams. The Sports page (route `/sports`) is a broadsheet grid: a ticker of
followed teams with form and the next game, scores, standings for chosen leagues, team news and a
"tonight" band. Today shows followed scores. A club followed in two competitions shows as one card
(`2026-07-08-sports-followed-team-dedupe.md`).

- **Scores, standings, rosters and news** come from ESPN's public, unofficial JSON at two hosts,
  with no key (`ESPN_FETCH_HOSTS`, `source/espn-source.ts:32`). `site.api.espn.com` serves scores,
  standings, rosters and the news list. `content.core.api.espn.com` serves the body of the one
  featured story on the overview: the id must be a bare number of four or more digits, the text is
  sanitised and clipped, and any failure falls back to the summary (`espn-source.ts:770`,
  `sports-service.ts:827`). Results and standings are cached as
  public data with a time limit (`@moss/datasets`, `sports-service.ts:168`).
- **Following clubs everywhere.** The catalog lists leagues by confederation. The follow picker
  loads one league's clubs only when opened, and a server search looks across leagues with a cap
  on uncached lookups per query (`2026-07-09-sports-federation-club-following.md`,
  `sports-service.ts:247,368-390`).
- **Publishers the person adds.** The person adds a public sports site or a subreddit and assigns
  it to teams or leagues. Moss checks it, and the person's model proposes a "recipe" that says
  where the headlines are on the page. Code checks the recipe against a strict schema before it is
  used (`source/recipe.ts`, `discovery.ts`, `public-source-reader.ts`, `service.ts`). A refresh
  never opens a browser and never fetches article bodies
  (`2026-08-23-1909-sports-public-source-completion.md`, decision 6).
- **The browser helper.** Only while the person is adding or rebuilding a source, and only when a
  plain fetch cannot see the headlines, Moss renders the page in headless Chromium. The renderer
  runs with no network at all. Every request it makes goes over a local socket to a broker that
  checks HTTPS, the allowed hosts and the address, then fetches it
  (`source/browser-sidecar.ts`, `browser-broker.ts`, `browser-protocol.ts`; in production a
  separate process with `network_mode: none`, read-only, all capabilities dropped,
  `infra/docker-compose.prod.yml:243-250`). Limits: 20 seconds, 40 requests, 4 at once, 5 pieces
  of evidence (`browser-protocol.ts:1-10`).
- **Source photos.** For a saved publisher, Moss finds where an article's lead photo lives, keeps
  a private copy in the person's vault, re-encoded (`source/photo*.ts`, `sharp`), and looks again
  at most once a day after an empty look (`photo-storage.ts`, spec
  `2026-09-04-sports-custom-source-photos-design.md`).

Files. `packages/sports/src/` (`sports-service.ts`, `repository.ts`, `follow-identity.ts`,
`followed-card.ts`, `followed-groups.ts`, `headline-composition.ts`, `news-ranking.ts`,
`standings-views.ts`, `results/*`, `source/*`, `chat-tools.ts`, `chat-targets.ts`,
`briefing-tool.ts`, `briefing-evidence.ts`, `approval-presentation.ts`, `data-lifecycle.ts`), web
`web/sports-page.tsx`, `sports-ticker.tsx`, `sports-standings*.tsx`, `sports-news.tsx`,
`sports-around-ticker.tsx`, `today-scores.tsx`, `today-widget.tsx`, `rotation-control.tsx`,
settings `settings/index.tsx`, `sources.tsx`, `source-assignment-picker.tsx`,
`source-photos.tsx`, `standings-leagues.tsx`, `story-preferences.tsx`. README lists the loader
seams. Specs: `2026-06-30-sports-module.md`, `2026-07-05-sports-editorial-redesign.md`,
`2026-07-06-sports-broadsheet-grid-design.md`, `2026-07-08-sports-followed-team-dedupe.md`,
`2026-07-09-sports-federation-club-following.md`, `2026-08-17-1572-custom-sports-news-sources.md`,
`2026-08-23-1909-sports-public-source-completion.md`, `2026-08-25-1961-sports-source-sport-scope.md`,
`2026-08-29-1930-sports-standings-picker.md`, `2026-09-03-sports-subreddit-sources-and-source-icons.md`,
`2026-09-04-sports-custom-source-photos-design.md`.

### 2.3 Weather

Today's header shows the temperature and condition for the person's place. Chat can show an
hourly forecast card. The person sets a place by name (anywhere in the world) or by "use my
location", and picks Fahrenheit or Celsius (`2026-08-17-1571-weather-location-and-units.md`).

- **Where the place comes from**, in order: the saved place, then a guess from the request's IP
  address (`ipwho.is`, cached six hours, private and non-routable addresses skipped), then a city
  for the person's saved time zone (`preferences.ts`, `ip-geocoder.ts`, `timezone-city.ts`).
- **Outside services**, all without a key: Open-Meteo forecast and geocoding, and OpenStreetMap
  Nominatim for reverse lookup (`open-meteo.ts`, `open-meteo-geocode.ts`,
  `nominatim-reverse.ts`).
- **Cache.** One answer per person for 30 minutes (`weather-service.ts:14`). The forecast is
  marked stale after two hours (`forecast/window.ts:95`).
- **Where settings live today.** The place and unit routes belong to the core Settings package,
  not Weather (`packages/settings/src/weather-location-search-routes.ts`, manifest lines
  241-287). The values are account preferences.

Files. `packages/weather/src/` (all 18 files), `packages/settings/src/weather-location-search-routes.ts`,
web `apps/web/src/today/header-weather.tsx`, `apps/web/src/settings/settings-personal-panes.tsx`,
`apps/web/src/api/weather-client.ts`. Specs: `2026-06-22-weather-real-forecast.md`,
`2026-08-09-wave-6-secure-context-and-weather.md`, `2026-08-17-1571-weather-location-and-units.md`.

## 3. Parity checklist

### 3.1 Routes

Each keeps its permission and its chat class. Part numbers refer to section 7.

| Module  | Routes                                                                                                                                                                                                                       | Permission         | Part |
| ------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------ | ---- |
| News    | `GET /api/news/catalog`, `GET/POST /api/news/prefs`, `DELETE /prefs/:id`, `GET /personalization`, `POST/DELETE /source-exclusions[/:id]`, `POST/PATCH/DELETE /topics[/:id]`, `DELETE /sources/:id`                           | view, prefs        | 3    |
| News    | `POST /api/news/sources/preview`, `POST /api/news/sources`                                                                                                                                                                   | prefs              | 4    |
| News    | `GET /api/news/overview`, `POST /api/news/refresh`, `POST /api/news/revalidation`                                                                                                                                            | view, prefs        | 5    |
| News    | `POST /api/news/sources/credentialed`, `POST/DELETE /sources/:id/credential`, `GET /api/news/credentials`                                                                                                                    | `news.credentials` | 6    |
| News    | `GET /api/news/images/:articleId`, `GET /api/news/favicon/:domain`                                                                                                                                                           | view               | 7    |
| Sports  | `GET/POST /api/sports/follows`, `POST /follows/:id/team`, `DELETE /follows/:id`, `GET/PUT /standings-preferences`                                                                                                            | view, follow       | 10   |
| Sports  | `GET /api/sports/catalog`, `GET /leagues/:competitionKey/teams`, `GET /teams/search`                                                                                                                                         | view               | 11   |
| Sports  | `GET /api/sports/overview`, `GET /standings`, `GET /results/latest`                                                                                                                                                          | view               | 12   |
| Sports  | `GET /api/sports/sources`, `PUT /sources/espn/coverage`, `POST /sources/preview`, `POST /sources`, `POST /sources/:id/assignments/preview`, `PATCH /sources/:id/assignments`, `DELETE /sources/:id`, `GET /sources/:id/icon` | view, sources      | 13   |
| Sports  | `POST /sources/:id/retry`, `POST /sources/:id/rebuild/preview`, `PATCH /sources/:id/rebuild`                                                                                                                                 | sources            | 14   |
| Sports  | `DELETE /sources/:id/photos`, `GET /headlines/:headlineId/photo`                                                                                                                                                             | view, sources      | 17   |
| Weather | `GET /api/weather/today`, `GET /api/weather/forecast`                                                                                                                                                                        | `weather.view`     | 20   |
| Weather | `GET/PUT /api/me/weather-location`, `GET /search`, `GET /reverse`, `GET/PUT /api/me/weather-unit` (moved from Settings, see 5.4)                                                                                             | as legacy          | 20   |

Source: `packages/news/src/manifest.ts:186-363`, `packages/sports/src/manifest.ts:329-590`,
`packages/weather/src/manifest.ts:79-97`, `packages/settings/src/manifest.ts:241-287`. Most
Sports source routes are blocked in chat ("external_effect") and reached through the tools in
3.5 instead. Each part re-reads its handlers for exact error bodies.

### 3.2 Background jobs

| Queue                       | What it does                                                                                                     | Payload today                                         | Part      |
| --------------------------- | ---------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------- | --------- |
| `news.refresh`              | Builds one person's front page. One per person at a time, no retry                                               | `{actorUserId, kind: "user_refresh", idempotencyKey}` | 5         |
| `news.revalidate`           | Rechecks every saved source and topic. Daily at `43 4 * * *` per person, and on demand when a refresh sees drift | `{actorUserId, kind: "revalidate", idempotencyKey}`   | 5         |
| (none in Sports or Weather) | Sports and Weather fetch on request and cache. Source health is written during the overview read                 | n/a                                                   | 11-14, 20 |

Source: `packages/news/src/jobs.ts:34-66,79-96`, `schedule.ts:16-50`. Both queues are
`exclusive` with `retryLimit: 0`. **Decision.** Rust keeps "no Sports or Weather jobs". A
scheduled Sports sync is a deferred idea in the README, not a port item.

### 3.3 Settings and preferences

- **News settings**: catalog sources on or off, added sources with health, subreddits, described
  topics (with the web-search gate), source exclusions, the keyed publisher, story feedback.
- **Sports settings**: follows (with the confederation picker and search), standings leagues,
  story preferences, added sources with assignments, sport scope and retry, source photos, ESPN
  coverage.
- **Weather settings** (in Profile today): place by name, "use my location", unit switch.
- **App map.** News, Sports and Weather declare navigation, settings and features in their
  manifests (Sports alone has about 20 feature ids, `manifest.ts:152-274`). They move into each
  `moss.module.json` in the part that builds the matching screen (registry rule 9).

### 3.4 Screens

All are approved designs already, built for the TypeScript app. Listed so none is lost.

| Screen                                            | Approved design it reproduces                                                                                                          | Part |
| ------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------- | ---- |
| News page (mosaic, lead art, filters, story menu) | `2026-07-08-news-module.md`, `2026-07-19-1185-news-caption-excerpt.md`                                                                 | 8    |
| News widget on Today                              | `web/today-widget.tsx` as shipped                                                                                                      | 8    |
| News settings                                     | `2026-07-12-news-settings-dogfood-hardening.md`, `2026-09-04-news-sources-...`                                                         | 9    |
| Sports page (broadsheet grid, ticker, standings)  | `2026-07-06-sports-broadsheet-grid-design.md`, `2026-07-05-sports-editorial-redesign.md`, `2026-08-29-1930-sports-standings-picker.md` | 18   |
| Sports scores on Today                            | `web/today-scores.tsx` as shipped                                                                                                      | 18   |
| Sports settings, including source photos          | `2026-07-12-sports-settings-dogfood-hardening.md`, `mockups/sports-source-photos.html`                                                 | 19   |
| Weather place and unit (Profile)                  | `2026-08-17-1571-weather-location-and-units.md`                                                                                        | 21   |
| Weather in the Today header, forecast chat card   | `2026-06-22-weather-real-forecast.md`, `forecast/card.tsx` as shipped                                                                  | 21   |

### 3.5 Chat tools

| Tool                                                                                                          | Risk        | Part |
| ------------------------------------------------------------------------------------------------------------- | ----------- | ---- |
| `news.heartbeatHeadlines`, `news.topHeadlinesToday`                                                           | read        | 7    |
| `news.credentialedSourceStatus`, `news.previewSource`                                                         | read        | 7    |
| `news.refreshNews`                                                                                            | write       | 7    |
| `sports.followedFactsToday`, `sports.heartbeatNextFixtures`, `sports.latestResult`                            | read        | 12   |
| `sports.followTeam`, `sports.unfollowTeam`                                                                    | write       | 12   |
| `sports.listSources`, `sports.previewSource`, `sports.previewSourceAssignments`, `sports.rebuildSourceRecipe` | read        | 14   |
| `sports.confirmSource`, `sports.confirmSourceAssignments`, `sports.confirmSourceRecipe`, `sports.retrySource` | write       | 14   |
| `sports.removeSource`                                                                                         | destructive | 14   |
| `weather.forecast`                                                                                            | read        | 20   |
| Weather place and unit tools (today in Settings: set place, search, reverse, place, unit)                     | as legacy   | 20   |

Source: `packages/news/src/manifest.ts:376-440`, `packages/sports/src/manifest.ts:602-835`,
`results/tool.ts:61`, `packages/weather/src/forecast/tool.ts:56`,
`packages/settings/src/manifest.ts` (weather presentations). Approval cards are drawn from the
stored record (`approval-presentation.ts` in News and Sports), never from model text.

### 3.6 Public API other modules call

| Provider     | Consumer       | Call                                                               | Today                                              |
| ------------ | -------------- | ------------------------------------------------------------------ | -------------------------------------------------- |
| News         | Briefings      | `news.topHeadlinesToday` (with briefing evidence)                  | `briefing-tool.ts`, `briefing-evidence.ts`         |
| Sports       | Briefings      | `sports.followedFactsToday`                                        | `briefing-tool.ts`                                 |
| Weather      | Briefings      | today's forecast (`weatherToday`, injected structurally)           | `packages/briefings/src/compose-shared.ts:114-120` |
| News         | Sports         | the shared feed and Reddit reader (moved to News in #2282)         | `packages/sports/src/source/reddit.ts`             |
| News         | Chat, Today    | heartbeat headlines                                                | `chat-tools.ts`                                    |
| Sports       | Chat           | chat targets (sports surface)                                      | `chat-targets.ts`                                  |
| Web research | News           | web search for described topics (gate when unavailable)            | `routes.ts:66-88`                                  |
| AI router    | News, Sports   | relevance ranking (News), recipe and photo-rule proposals (Sports) | `compilation/rank.ts:97`, `source/recipe.ts`       |
| All three    | Account export | data lifecycle sections                                            | `data-lifecycle.ts` in each                        |

**Decision.** The shared reader becomes a pure library crate under `modules/news/reader` with no
input or output of its own. Sports depends on it as a published crate (registry rule 3 allows
other modules' published crates). Network calls stay in each package and go through its own fetch
port, so neither package borrows the other's network rights.

### 3.7 Errors and degraded outcomes

Each stays word for word, because tests and the app read them.

- **Fetch failures** (News and Sports): blocked, robots, rate_limited (with the raw Retry-After),
  http_error (with status), challenge, timeout, network, not_https, plus the finer detail
  aborted, invalid_response, response_too_large, unsupported_content_type
  (`discovery/ports.ts:3-33`). The Rust public-web fetch (part 1) returns exactly these.
- **News**: `NEWS_CREDENTIAL_MESSAGES` (`credential-routes.ts:24,79`), log events
  `news_compile_ai_fallback`, `news_compile_relevance_degraded`, `news_revalidation_skipped`,
  `news_heartbeat_source_unavailable` (event names only, never story text), the described-topic
  web-search gate reasons.
- **Sports**: source health states (pending, healthy, and the failure states in SQL 0191 and
  0204-era columns), `recipe_missing`, `recipe_drift`, photo outcomes (`photo_last_outcome`,
  `photo_miss_streak`), browser failures cancelled, timeout, render_failed, unsupported
  (`browser-protocol.ts:41`), search `partial` when the uncached cap is hit,
  `sports_heartbeat_source_unavailable`.
- **Weather**: `weather_location_ambiguous`, `weather_intervals_unavailable`, null when no place
  resolves, stale forecast after two hours, the two remediations `weather_location` and
  `weather_retry` (`manifest.ts:65-74`).

## 4. Outside services, the browser helper, and what needs a real account

### 4.1 Every live data source

| Source                                  | Used by      | Key or account          | What a stand-in proves                                                                              | What only the live service proves                                        |
| --------------------------------------- | ------------ | ----------------------- | --------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------ |
| Catalog publisher feeds (RSS and Atom)  | News         | None                    | Parsing, sanitising, dedupe and ranking on recorded feeds; every fetch failure reason               | That today's catalog hosts still serve the same feed shapes              |
| Any site or feed the person adds        | News, Sports | None                    | Feed finding, robots rules, redirects, size and type caps, private-address refusal                  | That real publishers pass robots and challenge checks                    |
| Reddit (subreddit sources)              | News, Sports | None                    | Reader on recorded listing JSON, the robots exception, identity rule                                | Reddit's current rate limits and user-agent rules                        |
| NewsAPI (keyed publisher)               | News         | **Yes, a key**          | Key custody, the request shape, every error message, status tool                                    | That a real key works and the quota messages read right                  |
| Web search (described topics)           | News         | Depends on web research | The gate and its reasons; topic stories from a fake search result                                   | Real topic quality                                                       |
| ESPN public JSON                        | Sports       | None (unofficial)       | Scores, standings, rosters, news, search caps, time-zone day boundary, dedupe on recorded responses | That ESPN has not changed shape. It is unofficial and can change any day |
| Publisher sites rendered in the browser | Sports       | None                    | Sandbox rules, request caps, render result checks, recipe validation on local fixture pages         | That a real script-heavy publisher page yields headlines                 |
| Lead photos                             | Sports       | None                    | Photo rule, size and type caps, re-encode, vault copy, once-a-day relook on fixtures                | That real publisher photo markup is found                                |
| Open-Meteo forecast and geocoding       | Weather      | None                    | Forecast window, units, stale marking, ambiguous place on recorded replies                          | Real values for a real place                                             |
| Nominatim reverse lookup                | Weather      | None                    | Request shape, user agent, failure fallback                                                         | Real place names; the service's one-request-a-second policy              |
| ipwho.is (IP guess)                     | Weather      | None                    | Private and tailnet addresses skipped; six-hour cache                                               | Real guess quality                                                       |
| The person's model                      | News, Sports | A configured model      | Ranking fallback, recipe and photo-rule validation on canned replies                                | Ranking and recipe quality                                               |

**Decision.** Recorded responses live as fixture files beside each package's tests, with every
personal detail removed and a test that fails on any address outside `example.com` or the
service's own public host, as the stand-ins report did
(`2026-11-11-rust-phase5-standins-report.md`). The stand-ins are served by the test harness
through the host's fetch port with a test-only resolver, so the real address checks still run.

### 4.2 The browser helper

How it works today is in 2.2. **Decision.** Keep the same shape in Rust.

1. **A host `browser` port** (part 15), as the registry design names it. A package asks to render
   one HTTPS address of a host it may reach, with a request id. It gets back bounded evidence
   (rendered text and link candidates, at most 5 pieces), never a live page.
2. **The renderer has no network, enforced by the operating system.** Legacy gets this from
   Docker (`network_mode: none`, `infra/docker-compose.prod.yml:259`). Request interception alone
   is not a boundary, because Chromium has paths outside page requests (DNS prefetch, WebRTC,
   service workers, its own update and safe-browsing calls). **Decision.** The host starts
   Chromium inside a fresh network namespace that holds only a downed loopback, so the process
   cannot open any socket that leaves it. The host talks to it over
   `--remote-debugging-pipe` (two inherited file descriptors), never a TCP port. Every page request
   is paused through the debugging protocol's fetch interception and answered by the host's
   existing safe fetch (`rust-spike/module-host/src/network.rs`, DNS pinning and redirect checks),
   which runs outside the namespace. Anything the host does not answer fails, because there is no
   route out. Limits stay: 20 seconds, 40 requests, 4 at once, only document, fetch, XHR, script
   and stylesheet requests (`browser-protocol.ts:1-24`).
3. **Confirmation time only.** The port refuses calls from a job. Only a route the person
   triggered (preview or rebuild) may use it. Refresh never renders, as in legacy.
4. **Getting Chromium.** The port plan says "downloaded on demand". That is an install of a third
   party program on Ben's machine, so it needs Ben's yes (**Ben**, section 7.2). Until then the
   port reports `unsupported` and Sports falls back to plain-fetch discovery, which is today's
   behaviour when the sandbox is missing (`1909` spec, line 91-92).
5. **Isolation on a desktop.** The Rust app is leaving Docker, so the operating system boundary
   in item 2 replaces the container. **Decision.** On Linux, the host creates the network
   namespace with an unprivileged user namespace, keeps Chromium's own sandbox on, uses a
   throwaway profile, and refuses to start the browser if either the namespace or the sandbox is
   unavailable. Some distributions restrict unprivileged user namespaces (Ubuntu 24.04 does
   through AppArmor). There the port reports `unsupported` and Sports keeps plain-fetch
   discovery. It never falls back to a browser with network. macOS and Windows have no proven
   equivalent yet (**Guess**: a deny-network sandbox profile on macOS, an AppContainer without
   network rights on Windows), so the port stays `unsupported` there until a later part proves
   one.

What a stand-in proves: the intercept refuses a direct request, a private address and a host
outside the list (each seen failing with the guard removed); the operating system boundary holds,
shown by negative tests in which a fixture page tries a WebSocket, a WebRTC connection, a service
worker fetch, a DNS lookup and a link prefetch to a listener the test runs on the host, and the
listener sees nothing (seen failing when the browser is started without the namespace); caps hold; a fixture page served by
the test harness renders to the expected evidence; a job call is refused. What only a real run
proves: Chromium installs and starts on Ben's machine, and a real script-heavy publisher yields
headlines.

### 4.3 What CI proves and what needs Ben

CI proves, with no outside account: every route, tool and job above on recorded responses; the
public-web fetch guards; the browser intercept with fixture pages; row level security with two
people; no private text in logs; NewsAPI key custody with a fake key; native and WebAssembly
builds; each package's live run on the Rust server over HTTPS.

Needs Ben, or something he provides:

- A NewsAPI key (a free developer key is enough) for one live keyed-publisher pass (part 6).
- Approval of the crate list and the Chromium download (section 7.2).
- One live pass per module against the real services, from a phone or second device on the home
  network or tailnet (part 22). This is the only proof that ESPN, Reddit and the feeds still look
  like the fixtures.
- A configured model for the ranking and recipe quality pass.

## 5. Design decisions

### 5.1 Packages

Three packages, `modules/news`, `modules/sports`, `modules/weather`, each with
`moss.module.json`, `ui/`, `icons/`, `CHANGELOG.md` and a crate in `src/`. News and Sports keep
their SQL in `packages/<id>/sql` byte for byte and declare `"ledger": "core-legacy"`. Weather has
no tables. All three are registry packages from the first commit, bundled at first (registry
rule 7 and section 4.6).

### 5.2 Public web fetch (part 1)

**Decision.** Add one fetch mode, declared in the manifest as the resource `public-web` on the
`fetch` port. It is not a wildcard host. It means:

- HTTPS only, public addresses only (the host resolves the name and refuses private, loopback,
  link-local, tailnet and LAN ranges, and checks again on every redirect).
- Robots rules honoured, with the legacy per-call exception for Reddit's listing endpoint.
- Size, time and content-type caps per call, chosen by the package within host ceilings.
- The failure reasons in 3.7, never a response body in an error.
- The install review shows it as "Read public websites you add". The person sees this before
  install, as with every other port (registry design 5.4).

Fixed hosts (ESPN, Open-Meteo, Nominatim, ipwho.is, the News catalog, NewsAPI) stay declared as
exact hosts, so the review lists them by name. Only person-added sources use `public-web`.

### 5.3 Caches

- **Public data** (ESPN responses, catalog feeds, Open-Meteo replies keyed by a rounded place)
  goes into an install-wide key-value namespace, which the host already supports
  (`rust-spike/module-host/src/manifest.rs:82,431`). It holds nothing private. Time limits match
  legacy (`FEED_TTL_MS`, the ESPN dataset limits, 30 minutes for weather).
- **Anything tied to a person** (their compilation snapshot, their added sources' headlines, the
  place they saved, their IP guess) stays in their own tables or their own key-value namespace,
  owner-only.
- **Decision on the weather cache.** Legacy caches per person. Rust caches the forecast by
  rounded place install-wide (public data) and keeps the place itself per person. Same answer,
  fewer outside calls, nothing private shared.

### 5.4 Weather settings move into Weather

The place and unit routes live in core Settings today. **Decision.** Weather owns them in Rust,
at the same paths, and stores the values through the account-preferences port
(`rust-spike/module-host/src/account_preferences.rs`) under the legacy preference keys, so a
saved place survives the move. The port cannot do this yet. It only knows folder bindings and
boolean overrides (`account_preferences.rs:12`), and Weather needs a place object (latitude
within 90, longitude within 180, a label of 1 to 200 characters,
`packages/weather/src/preferences.ts:16-28`) and a unit string. **Decision.** Part 20a adds two
host binding kinds, a validated place and a unit chosen from a fixed list. The host validates
before writing, as it does for folders, so a package can never store a malformed value. Reason: module isolation, and the search and reverse routes are
outside calls that belong with the module that declares those hosts. **Guess** that the host
lets a package serve a path outside `/api/weather/`. If not, part 20b serves them under
`/api/weather/` and keeps the old paths as host aliases for the support window.

### 5.5 Model calls

News ranking and Sports recipe and photo-rule proposals go through the host's `structured`
port (it exists, `rust-spike/module-host/src/ai.rs`). No provider or model name. Every reply is
checked against the strict schema in code before use (`recipe.ts` keeps a strict and a relaxed
schema). Outside text goes in a labelled untrusted block, as legacy does.

### 5.6 Reachable from other devices

Every screen is a package screen served by the Rust server, so a phone on the home network or
tailnet reaches it over HTTPS like any other module. Two things change for other devices:

- **Weather's IP guess.** A phone on the LAN or tailnet sends a private or tailnet address, which
  legacy already skips. The person then gets the time-zone city. **Decision.** Keep that. The
  settings screen already offers "use my location", which the phone's browser can answer over
  HTTPS (the tailnet HTTPS address exists for this reason).
- **Images and photos** are served by Moss, so they load on any device without the device
  contacting a publisher.

## 6. Keeping private data private

1. **Owner-only.** All 8 News tables and all 6 Sports tables use
   `owner_user_id = app.current_actor_user_id()` (21 News and 14 Sports `USING` clauses counted in
   the SQL). The SQL stays byte for byte. No `BYPASSRLS`, no admin path. Each part with tables
   tests two people, and each policy is seen failing when removed.
2. **No private text in logs.** Headlines, story text, feed addresses the person added, topic
   descriptions, saved places, coordinates, IP addresses and NewsAPI keys never appear in logs,
   errors, activity rows or job payloads. Log events carry names and counts only (3.7). Each part
   plants a marker (a topic phrase, a feed address, a place name, a key) and searches every
   response, log line, payload and activity row. The test is first seen failing with the
   protection off.
3. **Metadata-only jobs.** The two News payloads are ids, a kind and a key. A test inspects stored
   job rows.
4. **Keys.** The NewsAPI key is brokered. The package names the credential and the host attaches
   it to `newsapi.org` only (`module-host/src/credentials.rs`). The legacy encrypted rows in
   `news_source_credentials` must still decrypt, so part 6 reads them with the legacy label and key
   ring and proves a key written by TypeScript decrypts in Rust and the reverse.
5. **Outside content is evidence, never instructions.** Feed text, recipe evidence and rendered
   pages go to the model inside the untrusted block. A model reply never widens a host list.
   Sports' recipe hosts come from the confirmed source, not the reply.
6. **The IP address** is used for one lookup and cached in memory for six hours, as legacy does,
   never stored in a table or log.
7. **Deletion and export.** Each module keeps its legacy `data-lifecycle.ts` sections. Deleting a
   Sports source removes its photos from the vault. Account delete cascades credentials.

**The determinism boundary.** Every label, health state, error, progress line and approval card
comes from stored records and code. The model has three jobs only: rank News candidates, propose a
Sports recipe, propose a Sports photo rule. Each reply passes a schema, a boundary validator, and
(for recipes) the person's confirmation of the preview before it is saved.

## 7. Build parts

Sizes are by complexity (S, M, L), not time. Each part is one builder session. Order is dependency
order. Every part has the same proof floor, written once here so the table can name only what is
special:

- **Row level security**: two people, each policy seen failing when removed (parts with tables).
- **No private text in logs**: the planted-marker test, first seen failing.
- **Both builds**: the crate builds natively and as WebAssembly, and both run its tests.
- **Live run**: the part's routes or screens exercised on the real Rust server over HTTPS, and
  from a second device when it has a screen. Results go in
  `docs/superpowers/specs/2026-11-xx-rust-phase5-<module>-report.md` with a "Not proven" list.

Parts marked **Screen** need the mockups agreed with Ben before building (repo `CLAUDE.md`,
"Design the front end before building a module"). The approved TypeScript designs exist (3.4).
**Recommendation.** For each screen part, show Ben the current TypeScript screen beside a still
of the planned Rust screen, get a yes, then build. No redesign.

### 7.1 Parts

| #   | Track    | Scope                                                                                                                                                                                                                                                                             | Size | Depends on         | Special proof                                                                                                                                                                    |
| --- | -------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---- | ------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | Platform | Host public-web fetch mode (5.2): manifest resource, address checks on every hop, robots gate with the Reddit exception, caps, the legacy failure reasons, install review wording, test-only resolver for fixtures.                                                               | M    | none               | Private, loopback, tailnet and redirect-to-private refused, each guard seen failing when removed; robots refusal; every failure reason                                           |
| 2   | News     | Shared reader crate `modules/news/reader`: RSS and Atom parsing, sanitising, Reddit listing reader, publisher identity (public suffix). Pure, no input or output. **New crates** (7.2).                                                                                           | M    | crate list         | Old-code fixture feeds parse to the same items; WebAssembly build; reviewer reads fixtures for personal data                                                                     |
| 3   | News     | Package skeleton: manifest, ledger, 8 tables, 9 SQL hashes, catalog, prefs, exclusions, topics, source delete, personalization read, data lifecycle. No network.                                                                                                                  | M    | 1                  | Route parity against old handlers                                                                                                                                                |
| 4   | News     | Adding a source: preview and save, feed finder, source resolution, policy check, preview store, subreddit sources. Uses parts 1 and 2.                                                                                                                                            | L    | 2, 3               | Each fetch failure reason reaches the preview; fixture sites with and without a feed link                                                                                        |
| 5a  | News     | Compiling the page: candidates from active sources, filters and exclusions, ranking through `structured` with the fixed-order fallback, compile snapshot, overview route.                                                                                                         | M    | 4                  | Canned model ranking and the fallback match legacy order on fixtures; speed measured against the budget                                                                          |
| 5b  | News     | Refreshing: refresh state and history, `news.refresh` and `news.revalidate` jobs, the 04:43 daily schedule per person, source health and drift.                                                                                                                                   | M    | 5a                 | Drift enqueues one revalidation; payloads metadata only; schedule fires once per person; health states from stored records                                                       |
| 6   | News     | Keyed publisher: NewsAPI connection, credential routes and messages, brokered key, legacy cipher compatibility, status tool. **Needs Ben** for one real key.                                                                                                                      | M    | 5b                 | Key never in package, logs or responses (marker key); TypeScript-written row decrypts in Rust and the reverse                                                                    |
| 7   | News     | Images and favicon routes (image host list, caps), story feedback, the five News chat tools, approval presentation, briefing evidence. Closes the Briefings news gap.                                                                                                             | M    | 5b                 | Briefings shows news instead of a gap; `refreshNews` approval card from the stored record                                                                                        |
| 8   | News     | **Screen.** News page (mosaic, lead art, filters, story menu) and the Today widget. App map entries.                                                                                                                                                                              | L    | 7, Ben's yes       | Live on desktop and phone; empty, loading and broken states                                                                                                                      |
| 9   | News     | **Screen.** News settings (sources, add source, subreddits, described topics with the web-search gate, exclusions, keyed publisher, feedback).                                                                                                                                    | M    | 6, Ben's yes       | Same live check; web-search gate shows its reason                                                                                                                                |
| 10  | Sports   | Package skeleton: manifest, ledger, 6 tables, 12 SQL hashes, follows (add, set team, remove), follow identity, standings preferences, data lifecycle. No network.                                                                                                                 | M    | none               | Whole-league dedupe rules from SQL 0185-0186; route parity                                                                                                                       |
| 11  | Sports   | ESPN source and the public cache: catalog with confederations and the full league table, lazy league rosters, cross-league search with the uncached cap and `partial`, scoreboard, standings, news list, both ESPN fetch hosts and the asset hosts.                               | L    | 1, 10              | Recorded ESPN fixtures; search cap holds; nothing personal in the install-wide cache                                                                                             |
| 12a | Sports   | Overview core: followed cards and groups, club dedupe across competitions, results, standings views, local-day boundary.                                                                                                                                                          | M    | 11                 | Liverpool-in-two-competitions shows one card; evening games land on the right local day in two time zones; speed measured against the budget                                     |
| 12b | Sports   | Overview stories and live parts: headline composition and ranking, the featured story body from the ESPN content host (bare-number id, sanitise, clip, fall back to the summary), gameday slides, live status line, tonight band.                                                 | M    | 12a                | Recorded article body is sanitised and clipped; a short or non-numeric id never reaches the fetch; a failed body fetch shows the summary; live: a real featured story body loads |
| 12c | Sports   | Sports tools `followedFactsToday`, `heartbeatNextFixtures`, `latestResult`, `followTeam`, `unfollowTeam`. Closes the Briefings sports gap.                                                                                                                                        | S    | 12b                | Tool replies match the overview on fixtures; Briefings shows sports                                                                                                              |
| 13  | Sports   | Added sources, plain fetch: list, preview, save, assignments preview and save, delete, source icons, sport scope, ESPN coverage, subreddit sources through the shared reader.                                                                                                     | M    | 2, 12a             | Each failure reason in the preview; two subreddits differing only by case are one source                                                                                         |
| 14a | Sports   | Recipes and refresh: recipe proposal through `structured`, strict schema check, refresh reader (no browser, no article bodies), health writes, drift, retry, rebuild.                                                                                                             | M    | 13                 | A model reply that names a new host is refused; refresh never renders                                                                                                            |
| 14b | Sports   | The nine source chat tools and their approval cards.                                                                                                                                                                                                                              | M    | 14a                | `removeSource` asks before deleting; approval cards come from stored records                                                                                                     |
| 15  | Platform | Host `browser` port (4.2): Chromium over its debugging protocol, pipe transport, network namespace with no route out, page-request intercept into the safe fetch, caps, job calls refused, namespace and sandbox required. **Needs Ben** for the crate and the Chromium download. | L    | 1, Ben's yes       | Off-list, private and direct requests refused; WebSocket, WebRTC, service worker, DNS and prefetch reach nothing (seen reaching the listener without the namespace); Linux only  |
| 16  | Sports   | Browser discovery: render fallback in preview and rebuild, recipe from rendered evidence, `unsupported` falls back to plain fetch.                                                                                                                                                | M    | 14a, 15            | Fixture page that hides headlines until scripts run yields a recipe; port off gives today's fallback                                                                             |
| 17  | Sports   | Source photos: photo rule proposal and check, photo pass with the deadline guard, re-encode, private vault copy, once-a-day relook, photo and delete-photos routes. **New crate** for re-encoding (7.2).                                                                          | M    | 14a                | Photo skipped near the deadline; metadata stripped by re-encode; delete removes vault files                                                                                      |
| 18  | Sports   | **Screen.** Sports page (broadsheet grid, ticker, standings and picker, team news, around ticker, rotation control) and Today scores. App map entries.                                                                                                                            | L    | 12c, Ben's yes     | Live on desktop and phone; keyboard on the ticker                                                                                                                                |
| 19  | Sports   | **Screen.** Sports settings (follows with the confederation picker and search, standings leagues, story preferences, sources and assignments, source photos).                                                                                                                     | L    | 14b, 17, Ben's yes | Same live check; the search `partial` notice shows                                                                                                                               |
| 20a | Platform | Account-preferences port: a validated place binding (latitude, longitude, label limits) and a unit binding from a fixed list, host wiring, manifest declaration.                                                                                                                  | S    | none               | Out-of-range or oversized values refused, each check seen failing when removed; one person's write never touches another's; a value written by TypeScript reads back in Rust     |
| 20b | Weather  | Package: today and forecast routes, Open-Meteo forecast and geocoding, Nominatim reverse, IP guess, time-zone city, caches (5.3), place and unit routes moved from Settings (5.4), `weather.forecast` and the place tools. Closes the Briefings weather gap.                      | M    | 1, 20a             | Saved place survives the move; tailnet address skipped; stale after two hours; Briefings shows weather                                                                           |
| 21  | Weather  | **Screen.** Place and unit in Profile, the Today header weather, the forecast chat card.                                                                                                                                                                                          | S    | 20b, Ben's yes     | "Use my location" from a phone over HTTPS                                                                                                                                        |
| 22  | All      | Remainder: registry packaging and signing for all three, upgrade check on a copy of dev data, whole-module live pass against the real services from a second device, Briefings re-proof with all three. **Needs Ben** for the real pass.                                          | M    | 1-21               | Real ESPN, feeds, Reddit, Open-Meteo pass; upgrade keeps follows, sources, topics, keys and the saved place                                                                      |

Ordering. Part 1 first. Weather (20a, 20b, 21) can run right after it and is the recommended first
proof of the fetch mode. News (2 to 9) and Sports (10 to 14b) can run side by side once part 2
lands, because Sports needs the reader. Part 15 can run beside everything once Ben approves it.
Parts 16 and 17 follow 14a. Screens follow their data parts and Ben's yes. Part 22 is last.

### 7.2 New crates and installs (Ben approves)

Recommended choices. All are pure Rust except where noted. The package-side crates must build for
`wasm32-wasip2`; the browser client runs only in the native host.

| Need                                      | Legacy library              | Recommended                                                 | Part  | Builds as              | Why this one                                                                                  |
| ----------------------------------------- | --------------------------- | ----------------------------------------------------------- | ----- | ---------------------- | --------------------------------------------------------------------------------------------- |
| HTML parser and CSS selectors             | `htmlparser2`, `css-select` | `scraper` (on `html5ever` and `selectors`)                  | 2, 14 | Native and WebAssembly | Browser-grade parsing of broken markup; the same selector syntax recipes already store        |
| XML parser                                | `htmlparser2` (XML mode)    | `quick-xml`                                                 | 2     | Native and WebAssembly | Streaming, no system libraries, tolerant enough for real RSS and Atom                         |
| Public suffix list                        | `tldts`                     | `psl` (list compiled in)                                    | 2     | Native and WebAssembly | No file or network read at run time; the list updates with the crate version                  |
| Image decode and re-encode                | `sharp`                     | `image` with only the JPEG, PNG and WebP features           | 17    | Native and WebAssembly | Decoding and re-encoding drops all metadata; no C library; features trimmed to keep size down |
| Chromium debugging-protocol client        | `playwright-core`           | No new crate: a small hand-written client over the pipe     | 15    | Native host only       | The pipe transport needs only `serde_json` and `rustix`, which are already in the lock file   |
| **Chromium itself, downloaded on demand** | bundled in the image        | A pinned Chrome for Testing build, checked against its hash | 15    | Native host only       | A third-party program on the machine. Ben decides                                             |

The builder pins exact versions when the part starts and records them in the part's report. If
a recommended crate fails the WebAssembly build or the speed budget, the builder stops at a clean
point and names the alternative (`lol_html` for HTML, `roxmltree` for XML) rather than switching
silently.

## 8. Kill gates and risks

**Kill gate after part 12c.** A person follows a club in two competitions, sees one card with
scores and standings, and Briefings shows the sports section, all on the Rust server from a phone.
Owner Ben. A miss re-plans parts 13 to 19. It is a measurement, not a no-go (the port plan treats
kill gates as measurements).

**Kill gate after part 16.** A script-heavy public publisher page yields a confirmed recipe
through the Rust browser port, with the renderer proven to have no direct network. Owner Ben. A
miss keeps plain-fetch discovery only and records browser discovery as not ported.

Risks.

- **ESPN is unofficial.** Its JSON can change without notice. Fixtures pass while the real feed
  breaks. Part 22's live pass is the only check. The legacy app carries the same risk.
- **Browser isolation without Docker.** The legacy sandbox leans on container rules. Part 15
  replaces them with a network namespace and a pipe, proves Linux only, and leaves the browser
  `unsupported` wherever that boundary cannot be built.
- **Chromium download is an install.** Without Ben's yes, Sports keeps plain-fetch discovery and
  some publishers stay unreadable, as today when the sandbox is off.
- **Public-web fetch widens the host model.** It is a new trust surface. Part 1 is security work
  and its guards must each be seen failing.
- **WebAssembly speed.** News compile and Sports overview do many parses per request. Parts 5a and
  12a measure against the speed budget and move a hot path to the native list only by measurement
  (registry rule 10).
- **Size.** The widest work is already split (5a and 5b, 12a to 12c, 14a and 14b). Parts 4 and
  11 stay L because each is one data path that cannot be finished in halves. Each part's proof
  stands on its own, so a part is done or not done, never half done.
- **Web research is not ported.** Described topics show the gate until it is, as legacy does when
  web search is off.

## 9. Not covered

- Workshop and Food (not ported, Ben's ruling). Any non-Rust work.
- The Today shell itself and Chat's own surfaces. Parts 8, 18 and 21 supply only the widgets and
  cards those surfaces host.
- Deferred Sports ideas from its README (live play-by-play, game-time notifications, a scheduled
  sync, a keyed sports source).
- Web research, which described topics depend on.
