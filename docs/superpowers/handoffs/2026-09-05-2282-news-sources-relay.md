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
