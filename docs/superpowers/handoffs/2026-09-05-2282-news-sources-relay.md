# 2282 News sources build lane, relay 1 (2026-09-05)

Predecessor hit the 70% context warning while verifying the spec, before writing the plan. No
code, no plan. Everything below was verified on branch `build/2282-news-sources` at e3f06586e
(main). Do NOT re-read these files to re-verify; cite them and plan.

## Task
- Brief: `~/.coord-briefs/boot-build-2282-news-sources.txt` (read it in full; it is short).
- Issue #2282. Spec `docs/superpowers/specs/2026-09-04-news-sources-subreddits-and-feed-finder.md`
  (471 lines). Sections: Decisions 1-8 at lines 62-276, Architecture 277-373, Testing 374-407,
  Exit criteria 408-434. Read ONE section at a time, only for the phase you are planning.
- Coordinator: herdr agent `coordinator` (one live). Tier sensitive. PR 2280 collision, see below.
- Plan skill: `plan-build` under `coordinated-build`. Live proof ports 3282/5282.

## Spec premise check: all current, two drifts to record in the plan
1. Spec 4 says Reddit rows need "a null recipe shape". News has NO recipe column (grep of
   `packages/news/sql` finds none). Drop that clause; do not add a recipe column.
2. Spec 8 says "first two failed refreshes keep last good behavior". Today ONE failure marks a
   source `temporarily_unavailable` (`packages/news/src/compilation/compile.ts:119-121` calls
   `repo.updateSourceHealth` per failure; `candidates.ts:305-313` skips non-healthy sources).
   The three-failure rule must apply to workaround feeds only (spec wording), ordinary feeds keep
   today's behavior. State this in the plan.

## Verified seams (file:line)
- Sports Reddit reader: `packages/sports/src/source/reddit.ts` (308 lines). Exports at lines
  14-38 (constants), 54-92 (input parsing, URLs, `sportsSourceIdentityKey` = Sports-specific,
  stays), 105-135 (types), 163-237 (link/entry/feed parsing), 238-308 (failure mapping, hop
  guard, fetch options, `readSubreddit(fetch, name)`). Imports only `isPublicFeedDocument`,
  `sanitizeFeedText` from `@moss/news`, plus Sports types `SportsSafeFetchPort`,
  `SportsWebRequestHop` (discovery.ts:41-80) and `publisherIdentity`.
- Sports call sites: `discovery.ts:30-38` (import), `:535` parseSubredditInput, `:862`
  readSubreddit; `public-source-reader.ts:41` import, `:763` redditHopGuard; `service.ts:36`
  sportsSourceIdentityKey; `icon-route.ts:6` REDDIT_ICON_HOSTS. Sports test:
  `tests/unit/sports-reddit-source.test.ts`. Sports migration shape to mirror:
  `packages/sports/sql/0213_sports_reddit_sources.sql` (icon_url check 13-15, retrieval check
  18-20, partial unique indexes 50-56).
- News package `@moss/news` exports `.`, `./settings`, `./web` (package.json). Public index
  `packages/news/src/index.ts:35` already exports `NewsAiPort, NewsSafeFetchPort,
  NewsWebSearchPort` from `discovery/ports.ts` (82 lines).
- News fetch port is URL-only: `NewsSafeFetchPort = (url) => ...` (ports.ts). The composition
  root builds it at `packages/module-registry/src/index.ts:710-731` via `fetchWebResource(url,
  {requireHttps, robots: newsRobotsGate, rateLimiter})`. Sports' port (same file 795-822) passes
  allowedHosts, requestHeaders, userAgent, allowedContentTypes, beforeRequest, maxBytes,
  rejectOversizedResponses, timeoutMs, signal, and NO robots gate. Reddit needs those options and
  no robots gate, so News needs an options-capable fetch port (new port or widened type) wired in
  buildNewsDiscoveryPorts and the worker path (index.ts:2153, :2195).
- News AI port: `NewsAiPort.generateJson` only (ports.ts:70-82); built at index.ts:754-772 with
  `generateStructured(scopedDb, {service:"module.news", ...})`, capability "json". Search port at
  index.ts:740-752 via `resolveWebSearchProvider` (`packages/web-research/src/providers.ts:155`).
  The AI layer has NO model-driven tool loop: `http-api-structured.ts:105` uses one forced tool
  for JSON output. Cheapest provider-agnostic finder: News drives the loop itself with repeated
  generateJson calls (schema: action search|fetch|done), executing web search through the
  existing NewsWebSearchPort and a News-owned GET-only fetch tool. Flag this in the plan as the
  "smallest structured-with-tools operation".
- Resolver: `packages/news/src/discovery/source-resolution.ts` (442 lines). Result type 73-82,
  `mapFetchFailure` 91-96, `resolveSourceInput` 229-284 (URL branch 243-258, name/search branch
  260-284), `verifyPublisher` 286-442 (homepage fetch 306, feed discovery loop 386-402, candidate
  build 425-440 with fields candidateId,label,canonicalDomain,homepageUrl,feedUrl,
  retrievalMethod,sampleCount,validationFingerprint,redirectNote). Finder hook point: fetch
  failure at 307-312 and "no feed verified" at 402-406.
- Collector: `packages/news/src/compilation/candidates.ts` (438). NewsCandidate 26-37,
  collectCustomSource 180-266 (feed branch 207-226 requires `samePublisher(canonicalDomain,
  finalDomain)`, where confirmed_fetch_hosts must be honored), collectCandidates 268+.
- Table `app.news_custom_sources`: `packages/news/sql/0159_news_personalization.sql:16-40`
  (retrieval_method IN feed,scrape; UNIQUE(owner_user_id, canonical_domain)); health values in
  `0204_news_source_health_states.sql:17-26` (healthy, authentication_failed,
  temporarily_unavailable, unsupported, disabled); refresh history cols `0203:29-33`.
- Migration number: highest on main is 0217. Open PRs hold 0214 (2273, 2234), 0220, 0221 (2279).
  Propose 0218 in the plan-ready message; the coordinator confirms.
- Manifest `packages/news/src/manifest.ts` (582): migrations 84-98, ownedTables 99-110,
  settings 125-135 (description says "publishers"), newsAddSourceRequirement 58-62, features
  492-535 (news.add_source, remediation configure_json_model, errors at 514-533).
- Settings copy: `packages/news/src/settings/index.tsx:523,530,537,542-543,599,608,654,659`;
  `add-source.tsx:27,30,47,164,170,203`. PrereqGate used in settings/index.tsx and
  describe-topics.tsx.
- Tests: unit in `tests/unit/news-*.test.ts` (source-resolution, candidates, compile, manifest,
  settings-pane, preview-store, personalization-repository); integration
  `tests/integration/news-personalization-*.test.ts`; e2e `tests/e2e/news-settings.spec.ts` with
  `tests/e2e/mock-news-api.ts`; UAT `tests/uat/specs/2006-news-credentialed-source.uat.spec.ts`
  as the model; trigger map `.claude/skills/coordinate/uat-trigger-map.tsv` has `packages/news/**`
  rows.

## PR 2280 collision (wider than the brief says)
2280 touches `packages/news/src/manifest.ts`, `personalization-routes.ts`, `routes.ts`,
`settings/describe-topics.tsx`, `packages/shared/src/news-api.ts`, `module-registry/src/index.ts`,
`ai/src/structured/generate-structured.ts`, `module-sdk/src/ai-capabilities.ts`,
`tests/integration/news-personalization-routes.test.ts`. Rebase when the coordinator says merged.

## Not yet looked at (read by grep, bounded)
personalization-repository.ts (insert/duplicate/health ops), personalization-routes.ts
(preview/confirm), shared news-api.ts DTOs, preview-store.ts (57 lines), rss-source.ts,
web-research tools.ts, Sports service.ts Reddit candidate mapping, dev-instance scripts and
`systemctl --user cat moss-cli-runner.service` for live proof.

## Next step
Write the plan with `plan-build`, then `herdr agent prompt coordinator "2282 plan ready: ..."`.
State doc for you: `/tmp/build-2282-state.md`. Plain English to humans, ASCII only.

## Relay 2 stop (2026-09-05): budget spent, re-slice needed

PLAIN ENGLISH RULE for whoever picks this up: every message to a human is plain English. No
jargon, no coined shorthand, ASCII punctuation only, at most one backtick per sentence.

The plan is approved with rulings: `docs/superpowers/plans/2026-09-05-2282-news-sources.md`
(coordinator rulings ledger at the end; migration number 0218 confirmed free). The successor lane
hit the 70 percent warning mid task 1.2 with no PR open, so per the brief it pushed what is green
and stopped instead of relaying. Nothing else in the plan is started.

### What is green on the branch

- Task 1.1 done: shared reader at `packages/news/src/source/reddit-reader.ts`, exported from the
  News package root (`packages/news/src/index.ts`, bottom block). Design points: fetch options
  carry `skipRobots: true` (News' fetch port in task 1.5 must honour it by dropping the robots
  gate), `RedditReaderOptions.publisherDomain` hook (default strips leading www; Sports passes
  its tldts rule so News needs no tldts), `redditHotFeedUrl` replaces `redditListingUrl`, and
  `ReadSubredditResult.feedUrl` replaces `listingUrl`. Tests: `tests/unit/news-reddit-reader.test.ts`.
- Task 1.2 done: `packages/sports/src/source/reddit.ts` is a shim (re-exports from `@moss/news`
  plus `REDDIT_ICON_HOSTS` and `sportsSourceIdentityKey`); `discovery.ts:862` passes
  `{ publisherDomain: publisherIdentity }` and reads `feedUrl`; `public-source-reader.ts:848`
  passes the same option to `parseRedditFeed`. The Sports unit test still carries the generic
  reader cases (only the `listingUrl` assertion was renamed); trimming it to identity plus
  candidate-mapping cases is optional tidy-up, not a blocker.
- Both unit files pass together: `pnpm vitest run tests/unit/news-reddit-reader.test.ts tests/unit/sports-reddit-source.test.ts` exit 0, 98 tests.

### Suggested re-slice (each fits one window)

1. Tasks 1.3 to 1.5: migration 0218, repository, options-capable News fetch port and composition
   root. Pure backend, no UI.
2. Tasks 1.6 to 1.8 plus the phase 1 e2e and UAT spec: resolver Reddit branch, collector and
   bounded refresh runner, settings wording and manifest and app map. Then the kill gate live
   proof on ports 3282 and 5282.
3. Phase 2 (deterministic feed finder) as its own lane, phase 3 (model-assisted) as another.

Open questions carried from the plan: which service or tier hint selects the user's chat model in
`resolveModelForService` (task 3.1); the fetch helper's rate-limit field is `retryAfter?: string`
on the Sports port type, confirm on the News port before task 1.5.

## Lane notes: build-2282-p1a stop (2026-09-05)

PLAIN ENGLISH RULE for whoever picks this up: every message to a human is plain English. No
jargon, no coined shorthand, ASCII punctuation only, at most one backtick per sentence.

This lane hit the 70 percent context warning during task 1.3, so per its brief it committed the
work in progress as one clearly labelled UNVERIFIED commit (`7b9f8a9c9`, pushed), did not relay,
and stopped. Nothing in it has passed a test run yet. Tasks 1.4 and 1.5 are not started. No PR is
open. Reading cost most of the budget; the successor should read only the "What the next lane
needs" list below plus the plan's task text, and build.

### What is on the branch from this lane (all unverified)

- `packages/news/sql/0218_news_source_kinds.sql`: the plan's DDL verbatim plus comments.
  Migration number 0218 was re-confirmed free at the start of this lane against origin/main and
  all 414 remote branch heads (0220 to 0223 are taken by other branches; 0218 and 0219 free).
- `packages/news/src/manifest.ts` migrations list: 0218 added at the end.
- `tests/integration/foundation-schema-catalog.test.ts`: 0218 row added after 0217.
- `packages/db/src/types.ts` `NewsCustomSourcesTable`: `retrieval_method` gains "reddit";
  new `icon_url`, `confirmed_fetch_hosts: string[]`, `consecutive_failures` (insert-optional).
- `packages/shared/src/news-api.ts`: both `retrievalMethod` type sites and both JSON schema
  enum sites gain "reddit" (a plain find and replace; 2 and 2 hits).
- `tests/integration/news-personalization-repository.test.ts`: new last describe block
  "news source kinds schema (#2282 migration 0218)" with eight cases matching the plan's list,
  each asserting on the constraint or index name so a missing one fails.

### What the next lane needs to do first (task 1.3 to green)

1. The migration drops the default on `confirmed_fetch_hosts` and requires 1 to 8 hosts, so every
   raw INSERT into that table must now supply it. Five sites still omit it and will fail:
   `tests/integration/news-revalidation.test.ts:367`, `tests/integration/news-credentials.test.ts:181`,
   `tests/integration/data-export.test.ts:377`, and two in
   `tests/integration/news-personalization-repository.test.ts` (the "custom sources and topics
   list/count" case and `seedValidationRows`). Add the column with `ARRAY['news.example.com']`
   (or the seeded domain).
2. Run the one file the plan names, unpiped, exactly as written in the plan's task 1.3
   verification line. With `JARVIS_PGDATABASE` unset (it is unset in this lane's shell) the
   runner `scripts/test-integration.ts` creates a random `jarvis_test_*` database and drops it
   after, so it never touches the live dev database; that is the project's scratch recipe for a
   single integration file. Expect several minutes; run it in the background.
3. Then `pnpm tsc --noEmit -p tsconfig.tests.json` style typecheck on the tree, lint and format
   on the changed files. Nothing here has been typechecked.
4. Rewrite the WIP commit message or add a follow-up commit once green; do not leave
   "UNVERIFIED" in the final history.

### Facts verified for tasks 1.4 and 1.5 (so the successor need not re-read)

- The web fetch helper's rate-limit field is `retryAfter?: string` (raw header value) on
  `FetchWebResourceFailure` in `packages/web-research/src/reader.ts:234-253`, alongside
  `detail?: "aborted" | "invalid_response" | "response_too_large" | "unsupported_content_type"`.
  So `NewsSafeFetchFailure` should gain `detail?: string` and `retryAfter?: string`, not
  `retryAfterMs`. The Reddit reader's `RedditFetchResult` already expects `detail?: string`.
- `RedditFetchOptions` (`packages/news/src/source/reddit-reader.ts:56-68`) is what
  `NewsFetchOptions` must accept: allowedHosts, requestHeaders, userAgent, allowedContentTypes,
  beforeRequest(hop), maxBytes, rejectOversizedResponses, timeoutMs, signal, `skipRobots: true`.
- Composition root: `buildNewsDiscoveryPorts` at `packages/module-registry/src/index.ts:710`
  returns `{ fetch, image, search, ai }`; add `fetchWithOptions` there, built like Sports' port
  at `:795-822` but with `robots: options?.skipRobots ? undefined : newsRobotsGate` and the News
  rate limiter. Consumers to thread it into: `packages/news/src/routes.ts:77`,
  `packages/news/src/personalization-routes.ts:131`, `packages/news/src/jobs.ts:100`,
  `chat-tools.ts:40`, `revalidation.ts:42`, and the internal deps of `resolveSourceInput`
  (`discovery/source-resolution.ts:232`) and `collectCandidates` (`compilation/candidates.ts:271`).
  Suggested: required on the composition-facing types, optional on the internal function deps so
  the many unit-test fakes of those functions do not all change in this slice.
- The adapter test to extend for the skipRobots assertion is
  `tests/unit/module-registry-news-discovery-adapter.test.ts`: it already captures the
  discovery object through a mocked `registerNewsRoutes`; mock `@moss/web-research`'s
  `fetchWebResource` the same way to capture the options object and assert `robots` is
  undefined when `skipRobots` is set and defined by default.
- Repository (task 1.4) call sites that must pass the new `confirmedFetchHosts` and `iconUrl`
  input fields: `packages/news/src/personalization-routes.ts:50-72` (the store interface) and
  `:277-287` (the write), `packages/news/src/credential-routes.ts:153`, and the `sourceInput`
  helper in `tests/integration/news-discovery-repository.test.ts:52`. Untargeted
  `ON CONFLICT DO NOTHING` pattern to copy: `packages/sports/src/repository.ts:55-70`.
- Adding `workaround: boolean` to `NewsCustomSourceDto` (required) touches its JSON schema at
  `packages/shared/src/news-api.ts:497-525` (add the property and the required entry, or the
  serializer drops it) and about 8 literal DTO sites in tests (typecheck lists them).
- A recording Kysely driver for repository unit tests already exists in
  `tests/unit/news-credential-repository.test.ts:44-90` (copy `makeRecordingDb`).
- The worker grant check in the repository integration test uses `has_table_privilege`, which
  column grants do not flip, so the new column grant keeps that older case green.

## Lane notes: build-2282-p1a2 stop (2026-09-05)

PLAIN ENGLISH RULE for whoever picks this up: every message to a human is plain English. No
jargon, no coined shorthand, ASCII punctuation only, at most one backtick per sentence.

Stopped at the 70 percent context warning per brief (no relay). Task 1.3 is typecheck, lint and
format green but its integration file is NOT yet proven; task 1.4 has a red unit test and no
implementation; no PR is open. Branch head is the commit that adds this section.

### Verified this lane (task 1.3)

- Commit `dea1a5047`: the five raw INSERTs now carry confirmed_fetch_hosts; two repository types
  (NewsSourceValidationState.retrievalMethod, toCustomSourceDto row) widen to "reddit". Without
  the widening tsc was red at personalization-repository.ts:279 and :330.
- `tsc --noEmit` exit 0, `tsc -p tsconfig.tests.json --noEmit` exit 0, eslint exit 0 and
  prettier --check exit 0 on every file in 7b9f8a9c9 plus dea1a5047 (prettier has no parser
  for .sql; skip that one file).
- Integration run of the one file on an isolated database: exit 1, log at /tmp/t13-2282.log.
  All 18 cases that boot the API server failed identically with Fastify
  AVV_ERR_PLUGIN_EXEC_TIMEOUT ("Plugin did not start in time") at createApiServer ready, about
  14 s each, including 10 pre-existing #953/#975 cases this branch never touched; the schema
  posture describe passed. Several other lanes were running gates at the time (herdr pane list
  showed 2280, 2279, 2294, 2234 lanes active). So the 8 new cases are unproven, not disproven.
  Next lane: rerun the exact command below when the box is quiet. If it times out again on a
  quiet box, compare the new describe's beforeEach (boss + server) with the older describes,
  which failed the same way, before blaming the migration.
- Scratch recipe used (JARVIS_PGDATABASE unset; the runner creates and drops a jarvis_test_*
  database itself, so the live dev database is never touched; run it in the background, expect
  about 5 minutes): `pnpm test:integration tests/integration/news-personalization-repository.test.ts > /tmp/t13.log 2>&1; echo "EXIT=$?"`
- Migration 0218 is not on origin/main and not applied on the dev database (the
  confirmed_fetch_hosts column is absent there). Branch was 1 commit behind origin/main at stop.

### Built this lane (task 1.4, red)

- Commit `3a3ba3258`: tests/unit/news-personalization-repository.test.ts gains a recording
  Kysely driver and two describe blocks. It fails to load until
  packages/news/src/source/workaround.ts exists. What it pins, so the implementation matches:
  - createCustomSource: SQL contains "on conflict do nothing" with no target list, and the
    columns confirmed_fetch_hosts and icon_url; parameters include the hosts array.
  - Duplicate probe after a no-row insert: for "reddit" the SQL contains lower(feed_url) and
    retrieval_method and NOT canonical_domain, parameter is the lowercased feed URL; for a
    publication it contains canonical_domain and NOT feed_url. Probe hit throws
    NewsDuplicateSourceError; probe miss throws NewsPersonalizationLimitError.
  - replaceCustomSource: SQL writes confirmed_fetch_hosts, icon_url, consecutive_failures;
    parameters include 0 and the hosts array.
  - listCustomSources DTO: retrievalMethod and workaround present; the JSON never contains
    "confirmed", "icon", "consecutive", "fingerprint" or the host list. A reddit row has
    workaround false; a feed row whose feed host is another publisher has workaround true.
  - recordWorkaroundRefreshOutcome(scopedDb, id, "success" | "failure"): exactly one query;
    success has no least( and passes 0; failure contains least(, health_status and
    temporarily_unavailable. Both contain where "id" = $n. Unscoped handle rejects first.
  - isWorkaroundFeed(canonicalDomain, feedUrl | null): false for null, same host, subdomain
    either direction, mixed case, ports and query strings, and unparseable URLs; true for a
    different publisher including suffix tricks (notexample.com, example.com.evil.com).

### What the 1.4 implementation still needs (file:line on this branch)

- packages/news/src/personalization-repository.ts: CustomSourceInput :117-124 (add
  confirmedFetchHosts, iconUrl, retrievalMethod gains "reddit"); createCustomSource :208-244
  (the targeted ON CONFLICT at :231 must become untargeted; probe at :236-241 branches);
  replaceCustomSource :246-280; listCustomSources :167-197 and toCustomSourceDto :820-847 add
  workaround via the helper; add recordWorkaroundRefreshOutcome next to updateSourceHealth :291.
- New packages/news/src/source/workaround.ts: build on publisherDomainMatches
  (personalization-domain.ts:93) in both directions, as candidates.ts:89 samePublisher does.
- packages/shared/src/news-api.ts: NewsCustomSourceDto :143-158 gains workaround: boolean;
  schema :497-525 needs the property AND the required entry or the serializer drops it.
- Callers that build the input: personalization-routes.ts:50-72 (two inline input types) and
  :277-287 (the write from the preview candidate; the candidate type at
  source-resolution.ts:425-440 has no hosts or icon yet, so for 1.4 derive hosts from the
  homepage and feed URL hosts, lowercased and deduped, and pass iconUrl null until task 1.6);
  credential-routes.ts:153 (hosts from descriptor.host and homepageUrl, iconUrl null);
  preview-store.ts:9 and publisher-connection-port.ts:14 type sites;
  tests/integration/news-discovery-repository.test.ts:52 sourceInput helper.
- compile.ts:66-75 CompilationRepository and candidates.ts:60-67 CandidateRepository Pick lists
  add "recordWorkaroundRefreshOutcome".
- Integration cases still to write in the 0218 describe of
  tests/integration/news-personalization-repository.test.ts (reuse insertSource and asActor):
  three failures flip health to temporarily_unavailable, a success resets the count, another
  owner's refresh leaves the row untouched.
- Typecheck will list the literal DTO sites in tests that need workaround added.

### Task 1.5

Unchanged from the previous lane notes above.

## Lane notes: build-2282-p1a2b stop (2026-09-05)

PLAIN ENGLISH RULE for whoever picks this up: every message to a human is plain English. No
jargon, no coined shorthand, ASCII punctuation only, at most one backtick per sentence.

Stopped at the 70 percent context warning per brief (no relay). No PR is open yet.

### Task 1.3: still unproven, never run

The box 1-minute load sat between 19 and 34 for the whole lane, so the integration run was
never started (the brief says wait under 12). Nothing about task 1.3 changed. The exact command
from the p1a2 notes still applies; the file now also carries three task 1.4 cases, so one run
proves both tasks (21 server-booting cases plus the posture describe).

### Task 1.4: built in commit `77fbe2b37`, partly verified

- Unit file tests/unit/news-personalization-repository.test.ts: 18 pass (was red).
- `tsc -p tsconfig.tests.json --noEmit`: exit 0.
- `pnpm typecheck`: exit 2, all 10 errors in tests/unit/news-compile.test.ts (lines 120, 135,
  151, 161, 168, 208, 233, 240 and two more): the deps object passed to compilePersonalizedNews
  is not assignable, "repo: CompilationRepository". The repo fake at :44-56 already has
  recordWorkaroundRefreshOutcome added; the likely remaining cause is the sources list
  (options.sources) typed without the new required DTO field workaround, or a second fake in
  that file. Read the first error in full (it is truncated at 220 chars in /tmp/t14-tsc.log).
- eslint and prettier NOT yet run on the changed files. Run both on the 16 files in the commit.
- Integration cases for the failure count written at
  tests/integration/news-personalization-repository.test.ts:935 onward (three cases), unproven.

Seams on this branch:
- packages/news/src/source/workaround.ts: isWorkaroundFeed and deriveFetchHosts (new file).
- packages/news/src/personalization-repository.ts:203 createCustomSource (untargeted conflict,
  branched probe); :328 recordWorkaroundRefreshOutcome; :880 the DTO workaround derivation
  (only a feed row can be a workaround).
- packages/shared/src/news-api.ts: NewsCustomSourceDto.workaround plus schema property and
  required entry.
- Callers now pass confirmedFetchHosts and iconUrl null: personalization-routes.ts (store
  interface and the confirm write), credential-routes.ts (adds descriptor.host).
- compile.ts CompilationRepository and candidates.ts CandidateRepository pick the new method;
  six unit fakes gained a no-op for it.

### Next lane, in order

1. Fix the news-compile.test.ts typecheck, run eslint and prettier on the changed files,
   amend nothing: add a fix commit.
2. When load is under 12, run the one integration file (background, log under /tmp), expect
   exit 0 with 21 cases plus posture. That proves 1.3 and 1.4 together.
3. Open the draft PR (Category: N/A), then task 1.5 belongs to a later lane.

### Task 1.5

Unchanged from the p1a notes above.
