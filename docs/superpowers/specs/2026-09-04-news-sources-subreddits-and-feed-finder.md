# News sources: subreddits, blocked-publication feed finder, and sources wording

**Status:** Proposed design

**Date:** 2026-09-04

**Owner:** Ben

**Related:** `packages/news`, the approved Sports subreddit source design dated 2026-09-03,
and the approved Web Search by Default design dated 2026-09-04.

## Context

News custom sources currently accept a publication URL or a publication name, verify a direct
homepage or discovered feed, and save the result through the existing preview and confirm flow.
The saved source is then read during the normal on-demand personalized-news compilation. The
News settings pane still calls these user choices publications, even though a source may soon be
a subreddit or a feed found through a mirror.

Sports already has a working Reddit reader. Its generic behavior is currently coupled to Sports
types, while News has its own safe-fetch and feed-collection path. Duplicating the reader would
make Reddit parsing, redirect safety, failure mapping, and outbound-link rules drift between the
two modules.

Some publication homepages reject server requests with 401, 403, 5xx, or a connection failure.
The existing flow can discover first-party feeds from a reachable homepage, but it stops when
the homepage is blocked or no discovered feed works. A bounded fallback can try the common feed
locations Moss already knows about, then ask the user's configured chat model to search for a
public workaround feed. The model must suggest candidates only; the server remains responsible
for fetching and verifying every candidate.

## Goals

- Let the News Add a source box accept `r/name`, `/r/name`, and a Reddit subreddit URL using the
  same accepted forms and safety rules as Sports.
- Read Reddit's hot Atom feed and mix its linked external articles into the main News feed.
- Reuse the generic Reddit reader through a declared public package API, with no News import of
  Sports internals and no Sports import of News internals.
- Find a working feed for a blocked publication through deterministic candidates first and a
  bounded model-assisted search second.
- Keep a workaround feed pending until the user confirms it, and retain the publication's own
  identity after confirmation.
- Mark a workaround source unhealthy after three consecutive failed refreshes and offer a
  deliberate way to find another feed.
- Rename the News settings copy from publications to sources where it describes source selection.
- Keep the app map truthful about subreddits, workaround feeds, prerequisites, and recovery.

## Non-Goals

- Reddit accounts, OAuth, API keys, private subreddit access, HTML scraping, comments, flair
  filters, search-based Reddit listings, or every-post mode.
- Offering publishers found in a subreddit as standalone News sources.
- A new News icon route or favicon lookup. The nullable icon column is stored for parity with the
  Sports source schema and remains null for Reddit in this slice.
- A new scheduler, a permanent headline table, or a second News ranking system.
- Trusting model-provided feed URLs without server verification.
- Searching for workaround feeds on a schedule, during ordinary refreshes, or without an explicit
  Add a source or Find another feed action.
- Sending the user's other sources, source preferences, credentials, or private content to the
  model.

## Resolved Decisions

### 1. Shared Reddit reader boundary

Move the generic pieces of `packages/sports/src/source/reddit.ts` into the existing News package,
under a public source API exported by `@moss/news`. News already owns the public RSS and Atom
parsers and Sports already imports those public feed helpers, so this is the smallest existing
package boundary that keeps both modules isolated. A new shared package would add a dependency
and ownership surface without buying a capability this repository lacks.

The public API owns:

- subreddit input parsing and validation
- the canonical subreddit page URL and hot-feed URL
- Reddit request headers, content types, byte cap, user agent, timeout options, and host allowlist
- failure mapping for not found, authentication required, rate limited, and unreachable results
- the exact-path and no-redirect guard
- extraction of the `[link]` anchor and filtering of Reddit-owned, image, video, gallery, poll,
  and self-post links
- Atom feed identity and linked-headline parsing

The API must use generic fetch and redirect-hop types. It must not import `SportsSafeFetchPort`,
`SportsWebRequestHop`, `publisherIdentity`, or any other Sports implementation. Sports adapts its
existing fetch function to the public API; News does the same with its fetch function. The public
API returns sanitized linked headlines with the outbound publisher label and canonical domain.

### 2. Subreddit input and retrieval

The Add a source box accepts:

- `r/technology`
- `/r/technology`
- `https://www.reddit.com/r/technology/...`
- `https://old.reddit.com/r/technology/...`

Names follow Reddit's existing 3 to 21 character letters, digits, and underscore rule. A
Reddit-shaped input with an invalid name returns `invalid_input` and never falls through to the
publication resolver. Other input keeps the existing News publication behavior.

The reader fetches `https://www.reddit.com/r/<name>/hot.rss`. It does not call Reddit JSON,
`about.json`, Reddit HTML, or any credentialed API. The request is pinned to `www.reddit.com`,
allows the existing Atom/XML content types, caps the response at 1 MB, and uses the descriptive
Moss user agent already used by Sports. An unexpected redirect, redirect to another host, port,
or changed path is refused.

Only the `[link]` anchor in an Atom entry's content or summary can become a headline. The URL
must be HTTP or HTTPS without credentials and must not resolve to `reddit.com`, `redd.it`,
`i.redd.it`, `v.redd.it`, or `preview.redd.it`. The resulting headline keeps the Reddit post
title and published or updated time, links to the external article, and carries the external
publisher domain for filtering and display metadata. Entries without a valid outbound article
are dropped.

The preview shows at most 10 linked articles. Each subreddit contributes at most 10 articles per
News refresh. The News Reddit refresh path uses the Sports limits: four concurrent groups, two
requests per host, 30 requests per refresh, a 6 second fetch timeout, a 12 second refresh
deadline, and one Retry-After retry when the delay is valid, at most 5 seconds, and still fits
the deadline. A Reddit 429 uses the existing rate-limited health handling and message:
`Reddit is rate limiting Moss. Headlines resume automatically.`

The Reddit feed is cached for 10 minutes, using the same stale-cache behavior as other News
source refreshes. There is no new scheduler.

### 3. News feed behavior

Subreddit articles are collected as custom News candidates and enter the same deterministic
filtering and ranking pipeline as every other source. Their source label is `r/technology` (using
the feed's display casing when available), so the source line names the subreddit. The article
link remains the outbound publisher URL.

Canonical story URL normalization happens before deduplication. A Reddit article that points to
the same canonical URL as a curated or other publication story is kept once, with the existing
source-priority rule deciding which candidate supplies the surviving record. No Reddit-specific
ranking boost is added.

### 4. Source persistence

Add a new News migration after the current latest migration. Never edit `0159_news_personalization.sql`
or any other applied migration. The migration:

- permits `retrieval_method = 'reddit'` alongside `feed` and `scrape`
- adds nullable `icon_url` with the same HTTPS and length bounds used by Sports
- adds `confirmed_fetch_hosts` as a bounded, lowercase, non-empty host array and backfills current
  sources from their homepage and feed hosts
- replaces the per-owner `(owner_user_id, canonical_domain)` constraint with two partial unique
  indexes: publication sources remain unique by domain, while Reddit sources are unique by
  lower-cased `feed_url`
- constrains Reddit rows to `canonical_domain = 'reddit.com'`, a Reddit hot-feed URL, a null
  recipe shape, and a Reddit homepage URL
- adds a durable consecutive failure count for workaround-feed health, bounded to the small range
  needed by the three-refresh rule

The migration preserves owner-only FORCE RLS. The existing worker grants remain limited to what
compilation needs, and the new host and icon metadata do not become export data or model input.
The News manifest lists the new migration and keeps `app.news_custom_sources` as an owned table.

For a subreddit, save `canonical_domain` as `reddit.com`, save the Reddit homepage in
`homepage_url`, save the hot feed in `feed_url`, save `retrieval_method` as `reddit`, set
`confirmed_fetch_hosts` to the Reddit host, and store `icon_url` as null. The source label keeps
Reddit's display casing, while duplicate detection is case-insensitive through the feed URL index.

### 5. Existing preview and confirm flow

The REST and assistant preview paths continue to use the same server-side preview store and
confirmation handle. A Reddit candidate carries its retrieval method and feed metadata in the
private preview record; the public response exposes only the safe display fields and sample
count. Confirmation writes the Reddit row and queues the existing News refresh.

The existing confirm tamper check remains mandatory for assistant confirmation. The preview
record, not model or browser display data, is the authority for the saved feed URL, identity,
retrieval method, and host allowlist.

### 6. Feed finder trigger and order

After the ordinary source resolver has tried the submitted homepage, its declared feed links,
and its existing supported source path, a finder runs only when the direct homepage was
unreachable or blocked by an HTTP 401, 403, 5xx, or connection failure, or when the homepage was
reachable but no discovered feed passed verification. If the ordinary resolver already produces
a verified feed or supported source candidate, the finder is not run.

The finder first builds a deduplicated, fixed deterministic list in this order:

1. `https://openrss.org/feed/<host>/`
2. `https://rss.<host>/`
3. `https://feeds.<host>/`
4. `https://<host>/feed`
5. `https://<host>/rss`
6. `https://<host>/rss.xml`
7. `https://<host>/feed.xml`
8. The common Cloudflare-blocked-host paths `/atom.xml`, `/index.xml`, `/feed/`, `/rss/`,
   `/feeds/posts/default`, `/news/rss`, and `/news/feed`

The list is capped at 16 unique HTTPS URLs. Candidate hosts are public and portless. The
existing AP News OpenRSS pattern is retained; the other paths are ordinary HTTPS candidates.

Each deterministic candidate must fetch successfully, return a supported RSS or Atom document,
contain at least three sanitized items, and have a newest item less than 14 days old at the time
of preview. The same response-size, timeout, redirect, public-host, URL, and content checks used
by the News safe-fetch path apply. A candidate that is HTML, stale, empty, truncated, private,
or otherwise unsafe is rejected and the next candidate is tried.

### 7. Model-assisted feed finder

If no deterministic candidate verifies, News may use the structured AI port with two explicit
tools:

- `web search`, implemented through the web-research module's existing search port. It therefore
  uses Brave when a Brave key is saved, or the user's model-native search when the approved Web
  Search design permits it.
- `fetch`, a News-owned GET-only tool that accepts only public hosts, rejects private and local
  addresses, limits responses to 1 MB, accepts feed or HTML content only, and times out after
  6 seconds. It returns bounded public content and response metadata, never credentials.

The structured request receives only the publication label or host and bounded public content
already fetched for this attempt. It asks for at most three candidate feed URLs for that
publication. It may use web search and fetch to investigate, but it never receives the user's
other sources, preferences, credentials, or private data.

The model phase has one shared budget of at most 8 tool calls and 30 seconds. Candidate URL
verification is still performed by the server using the deterministic verifier; verification
fetches count against the same budget and deadline. Model output is treated as untrusted data:
non-HTTPS, private, malformed, redirected, unsupported, empty, stale, and wrong-publication
candidates are discarded. A verified candidate is the only result that can reach the preview.

The existing `NewsAiPort.generateJson` contract remains the simple policy and ranking operation.
Add the smallest structured-with-tools operation needed for this finder rather than teaching all
News AI callers about tools. The composition root supplies the user's effective chat model and
the web-research search port; News sees only the capability result and the bounded tool port.

If no chat model is configured, or the effective model cannot use the active web-search engine,
the model phase is skipped. Deterministic candidates still run. If they also fail, the preview
renders the existing `PrereqGate` pattern with the new requirement text below instead of
pretending the publication had no possible workaround.

### 8. Workaround identity and health

When a candidate succeeds through a feed host different from the publication's canonical host,
the private candidate is marked as a workaround. Its saved values are:

- the publication's canonical domain and label
- the publication homepage as `homepage_url`
- the mirror or workaround feed as `feed_url`
- `retrieval_method = 'feed'`
- a deduplicated host allowlist containing the publication host and the verified feed host
- the existing validation fingerprint, derived from the verified feed and current validation
  configuration

The generalized user-source host allowlist is used wherever the static catalog's `feedHosts` is
used today. A mirror host is accepted because it is in the saved allowlist, not because the
model named it or because the source's canonical domain was changed.

The preview includes this exact notice, with values inserted only from server-verified metadata:

> `<Publication> blocks direct access. We found a working feed via <feed host>.`

The source is not saved until the user presses Add this source. The existing confirmation handle
stores the workaround marker and host allowlist, so the confirm request cannot replace the feed
with a URL that was not verified.

Compilation tracks consecutive failures for workaround feeds. A successful refresh resets the
count to zero. The first two failed refreshes keep the last good snapshot behavior and increment
the count. On the third consecutive failure, the source is marked with the existing
`temporarily_unavailable` health status and the count is retained for diagnostics. A normal
successful refresh makes the source healthy again.

When a workaround source is unhealthy, its settings row offers `Find another feed`. That explicit
action opens the existing source preview flow in replacement mode, runs the deterministic finder,
then the model phase when available, and replaces the source only after confirmation. It never
runs during a scheduled or ordinary News refresh.

The two new error or notice strings are:

1. `"<Publication> blocks direct access. We found a working feed via <feed host>."`
2. The existing prerequisite component receives `"Finding another feed needs a configured chat model."`,
   which renders with its existing Assistant settings link.

## Architecture

### Shared source API

Add the generic Reddit reader to the public exports of the News package. Keep publisher-domain
normalization and sanitized feed text in the shared News source layer. Sports replaces its local
parser and request constants with imports from that public API and keeps its existing Sports
candidate mapping, scopes, icon behavior, and refresh runner. News imports only the public API.

This is a public module seam, not a shared table or a cross-module query. Neither module reads the
other module's storage. The shared reader has no knowledge of Sports assignments or News
personalization.

### News discovery and preview

Extend source resolution to recognize the shared subreddit input before publication normalization.
The Reddit branch returns a verified source candidate with the Reddit label, homepage, hot feed,
retrieval method, sample count, and host allowlist. The publication branch retains its current
direct fetch, first-party feed discovery, policy check, and supported-source behavior, then calls
the feed finder only at the failure boundary described above.

The feed verifier is one pure policy of response checks used by deterministic candidates, model
candidate verification, and tests. It does not accept a URL merely because a model returned it.
The publication policy check still runs on the publication identity and sanitized sample titles.
For Reddit, the existing content-policy check covers the subreddit title and description; linked
article domains are not separately policy-checked during source preview.

The shared preview response gains safe optional finder metadata sufficient for the UI to render a
server-generated notice or prerequisite gate. It does not expose private model details, raw
prompts, tool transcripts, or unverified URLs. The private candidate gains the verified feed host,
confirmed host list, and workaround marker so REST and assistant confirmation behave identically.

### Storage and repository

Extend the News source input, validation state, DTO mapping, and repository write path for
`reddit`, `icon_url`, `confirmed_fetch_hosts`, and the consecutive failure count. Keep
`validation_fingerprint` module-private. The browser receives source health and safe source
identity, not host verification internals or provider identity.

The repository's duplicate handling must distinguish a Reddit duplicate from a publication
duplicate. A Reddit duplicate is found by its normalized feed URL, while publications continue to
use canonical domain. The partial indexes remain the final race-safe authority.

Health updates for a workaround use one owner-scoped repository operation that increments or
resets the failure count atomically with the health transition. It must not let one owner's
refresh update another owner's row.

### Compilation and ranking

The custom-source candidate collector branches on `retrieval_method = 'reddit'` and uses the
shared reader. It maps each linked article to a News candidate with source label `r/<name>`,
canonical source domain `reddit.com`, external article URL, and no image or summary. The ordinary
feed branch remains unchanged for publication feeds and workaround feeds.

The compiler's existing URL canonicalization and dedupe filter handles cross-source duplicates.
The Reddit candidate is then filtered for age and exclusions and passed through the existing
relevance and ranking steps. It is neither preferred nor penalized merely because it came from
Reddit.

The existing bounded refresh worker owns the News limits and cache. Reddit requests use the
Sports concurrency, budget, retry, timeout, and deadline values. A Reddit failure degrades only
that source and updates its health state; it does not make the whole News overview fail.

### Settings and app map

The existing AddSourceFlow gets a subreddit-aware label and renders the optional verified
workaround notice or prerequisite gate above the existing Add this source and Cancel controls.
The source list displays `r/<name>` and health state. A workaround source with three failed
refreshes gets Find another feed next to its existing Remove action. The existing design-system
primitives and empty, loading, and error states are reused.

The News module manifest is the owner of this module's app-map declarations. Update its settings
description, source feature description, migration list, and source feature errors and
remediations in the same implementation PR. Add the chat-model remediation at
`/settings?section=assistant`, and describe the deterministic and model-assisted feed finder.
No new top-level screen or core setting is added, so `CORE_APP_SETTINGS` remains unchanged.

The exact settings copy changes are:

- Pane helper: `Pick the publications your front page draws from, and optionally narrow it to the topics you follow. These choices also shape news in briefings.` becomes `Pick the sources your front page draws from, and optionally narrow it to the topics you follow. These choices also shape news in briefings.`
- Built-in section kicker: `Publications` becomes `Built-in sources`.
- Built-in section accessibility label: `News sources` becomes `Built-in sources`.
- Topic kicker: `Topics from your publications` becomes `Topics from your sources`.
- Topic helper: `Narrow your enabled publications to these desks. With none followed you get each publication's general front page.` becomes `Narrow your enabled sources to these desks. With none followed you get each source's general front page.`
- Personal section kicker: `Publications you add` becomes `Sources you add`.
- Personal section accessibility label: `Personalized sources` becomes `Sources you add`.
- Personal helper: `Publications you add yourself, verified before they join your feed. Verified sources contribute recent headlines to News and briefings.` becomes `Sources you add yourself, verified before they join your feed. Verified sources contribute recent headlines to News and briefings.`
- Add box label: `Publication homepage or domain` becomes `Source homepage or domain`.
- Preview policy error: `That publication isn't allowed by the content policy.` becomes `That source isn't allowed by the content policy.`
- Preview invalid-input error: `That doesn't look like a publication we can check - try a homepage link.` becomes `That doesn't look like a source we can check - try a homepage link.`
- Preview fallback: `That publication can't be added.` becomes `That source can't be added.`
- Preview request error: `Could not check that publication. Try again.` becomes `Could not check that source. Try again.`

`Excluded publishers`, publisher access-key wording, and the existing `Set it up in Assistant
settings` link remain publisher-specific where they describe a domain or a publisher credential,
not the source-selection vocabulary.

## Testing

- Shared-reader unit tests cover accepted and rejected subreddit forms, hot-feed URL construction,
  exact-path redirect guarding, request options, failure mapping for 403, 404, 429, 5xx and
  network failures, `[link]` extraction, Reddit-internal and media filtering, malformed dates,
  duplicate outbound URLs, and external publisher-domain mapping. Sports and News each verify
  their adapter uses the shared public API.
- Feed-finder unit tests use a fake fetch port to prove deterministic ordering, deduplication,
  OpenRSS rescue, common Cloudflare paths, rejection of non-feed HTML, fewer than three items,
  stale newest items, oversized responses, unsafe redirects, and private hosts. They also prove
  the model is called only after deterministic failure, returns at most three candidates, is
  bounded at eight tool calls and 30 seconds, and cannot bypass server verification.
- Finder availability tests prove a configured web-search-capable chat model can use the web
  search tool selected by the approved Web Search design, while no configured chat model skips
  the model phase and renders the existing prerequisite gate. Deterministic rescue still works in
  the latter case.
- News compilation unit tests cover ten Reddit articles per source, the Sports refresh limits and
  429 retry behavior, source-line labeling, canonical URL dedupe against a publication story,
  ordinary ranking behavior, and three-failure health transition with reset after success.
- Repository and migration tests cover the Reddit retrieval value, icon and host checks, Reddit
  shape checks, publication-domain and subreddit-feed partial uniqueness, case-insensitive
  subreddit duplicates, the workaround feed host allowlist, and owner-only RLS behavior.
- Settings copy tests assert every replacement string listed above, the subreddit preview with
  sample linked articles, the workaround notice, the no-chat-model prerequisite copy, and the
  Find another feed action.
- Browser tests add `r/technology` through a stubbed preview, confirm it, and assert the saved row
  and mixed story source line. A second journey submits a blocked publication whose deterministic
  candidate is OpenRSS, verifies the notice, confirms only after the user action, and asserts the
  saved canonical publication identity plus mirror feed host.
- Live-path proof on dev records executable assertions for owner signup, the real News settings
  path, adding `r/technology`, and adding `politico.com` and `axios.com` through the blocked-host
  finder. The evidence records exit codes and bounded DOM, network, and application-log facts on
  the pull request; screenshots are not required.

## Exit criteria

- `r/technology`, `/r/technology`, and a Reddit subreddit URL produce the same verified Reddit
  source candidate, and a confirmed source contributes no more than ten linked articles per
  refresh with the source line `r/technology`.
- Reddit self posts and Reddit-hosted media never become News headlines, while outbound article
  URLs are used for story links and cross-source canonical dedupe.
- Sports and News both consume one public shared Reddit reader, with no module-internal import
  crossing and no duplicated parser or safety policy.
- A blocked or unreachable publication is rescued by the deterministic finder when one of its
  candidates passes the three-item and fourteen-day freshness checks.
- If deterministic candidates fail, a configured chat model can use only the bounded web search
  and public GET fetch tools; every saved feed has passed the same server verifier.
- With no chat model, deterministic rescue still works and an unsuccessful model phase is shown
  through the existing prerequisite gate rather than a false generic success.
- A workaround preview identifies the publication and verified feed host, and nothing is written
  until the user confirms. The saved row preserves the publication domain and homepage while
  using the verified mirror feed and host allowlist.
- Three consecutive workaround refresh failures mark the source temporarily unavailable, and a
  successful refresh resets it. The settings row offers Find another feed and replacement still
  requires confirmation.
- The News settings screen uses the source wording listed in this spec, and the News manifest's
  settings, feature, error, remediation, migration, and data declarations match the shipped
  behavior.
- The live dev proof covers `r/technology`, `politico.com`, and `axios.com` through the real owner
  settings journey, with executable evidence recorded on the draft pull request.

## Hard invariants

- Module isolation: News and Sports communicate through declared public APIs only; neither module
  imports the other's internals or tables.
- Private by default: custom source rows, preview handles, health counters, and feed allowlists
  remain owner-scoped under FORCE RLS.
- Secrets never escape: credentials, tokens, provider identity, raw prompts, and private source
  data never enter Reddit payloads, feed-finder prompts, logs, job payloads, or browser DTOs.
- Provider-agnostic AI: News requests a structured tool-capable model and web-search capability;
  the router chooses the user's effective model and the web-research module chooses Brave or
  model-native search according to the approved Web Search design.
- Server verification is authoritative: model suggestions, browser fields, redirects, feed hosts,
  response types, size, freshness, and item counts are never trusted without server checks.
- Public fetch safety: HTTPS only, no credentials, no private hosts, no unexpected redirects,
  bounded response bodies, bounded time, bounded concurrency, and bounded request/tool counts.
- Canonical identity is preserved: Reddit sources use `reddit.com` only as their source domain;
  workaround sources retain the publication domain and homepage, with the mirror host recorded
  in the confirmed allowlist.
- No applied migration is edited. Storage changes arrive in a new News-owned SQL migration.
- A user-facing source cannot be reported as healthy after the third consecutive workaround-feed
  failure, and an unavailable source never blocks unrelated News stories.
- The app map remains truthful in the same implementation PR, including the prerequisite and
  recovery path for a failed feed finder.

## Self-review

- No placeholder issue number, URL, migration number, model name, or live-proof claim is used.
- The Reddit cache, per-source cap, and refresh limits are explicit and match the requested Sports
  behavior where the request says they must match.
- The deterministic finder precedes model search, model output is never trusted, and no-model
  behavior is distinct from deterministic rescue.
- The stored publication identity, mirror feed URL, and host allowlist are kept separate, so a
  workaround cannot silently turn into a different publisher.
- The three-failure rule is durable rather than an in-memory counter, and replacement remains a
  confirmation-gated action.
- No News icon route or unrelated source discovery feature was added to fill a gap outside this
  brief.
