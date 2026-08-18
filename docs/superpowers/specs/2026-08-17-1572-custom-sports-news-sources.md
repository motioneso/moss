# Custom Sports News Sources

**Status:** Approved

**Date:** 2026-08-17

**Owner:** Ben

**GitHub:** #1572

## Problem Statement

Sports headlines currently come only from ESPN. Users may prefer local reporters, team sites,
league publications, or other public publishers, but they cannot tell Moss which sources they trust
or where each source should apply.

Users also cannot tell whether Moss can actually monitor a proposed source. A source that fails or
is unsupported must not silently disappear: the user needs a clear explanation, a useful next step,
and the ability to ask Moss for help diagnosing and correcting it.

## Solution

Add a news-source table to Sports settings. A user submits a public URL, Moss safely discovers and
previews a monitorable feed or shallow public-page source, and the user confirms it. The user then
assigns that source to any number of followed teams and leagues. Multiple sources may apply to the
same team or league, and matching stories from all active sources can appear on Today and the Sports
page.

Keep ESPN headlines enabled by default. A user may explicitly remove ESPN as a headline source;
doing so does not remove ESPN-backed scores, schedules, standings, or team catalog data. Give each
source a clear health state and safe failure details that both the settings UI and Moss can explain.

## User Stories

1. As a Sports user, I want to add a public sports publisher URL, so that Moss can use sources I
   prefer instead of relying only on ESPN headlines.
2. As a Sports user, I want Moss to determine whether a URL exposes a monitorable source, so that I
   do not need to understand RSS, Atom, or page structure.
3. As a Sports user, I want to preview the publisher and sample stories before saving it, so that I
   can confirm Moss found the source I intended.
4. As a Sports user, I want Moss to reject an unsupported source honestly, so that a saved row never
   falsely implies monitoring works.
5. As a Sports user, I want a clear distinction between an invalid URL, an unreachable site, a
   source requiring authentication, an unsupported page, and a temporary fetch failure, so that I
   know what happened.
6. As a Sports user, I want every source error to include a practical next step, so that I can fix
   the URL, retry, remove the source, or understand that the source needs future credential support.
7. As a Sports user, I want to ask Moss why a source is failing, so that I can get help without
   interpreting technical logs.
8. As a Sports user, I want Moss to report the source's last check, last success, and current safe
   failure reason, so that its answer is based on real state.
9. As a Sports user, I want Moss to help retry, replace, or remove a failing source through the
   normal action flow, so that troubleshooting can be completed in conversation.
10. As a Sports user, I want to assign a source to one or more teams I follow, so that its stories
    appear in the relevant team coverage.
11. As a Sports user, I want to assign a source to one or more leagues I follow, so that its stories
    can contribute across that league.
12. As a Sports user, I want a source to have both team and league assignments, so that one publisher
    can cover multiple parts of my interests.
13. As a Sports user, I want multiple sources assigned to the same team or league, so that I am not
    forced to choose only one publisher.
14. As a Sports user, I want source assignments limited to my followed teams and leagues, so that
    the settings use the Sports interests I already maintain.
15. As a Sports user, I want to change assignments without re-adding the source, so that I can evolve
    my coverage easily.
16. As a Sports user, I want to remove a custom source, so that it stops contributing stories to my
    Sports experience.
17. As a Sports user, I want ESPN headlines to remain enabled by default, so that adding custom
    sources does not unexpectedly reduce existing coverage.
18. As a Sports user, I want to explicitly remove ESPN headlines, so that I can choose not to receive
    ESPN news.
19. As a Sports user, I want removing ESPN headlines to leave scores, schedules, standings, and team
    lookup working, so that a news preference does not disable core sports data.
20. As a Sports user, I want stories from my active assigned sources to appear on Today, so that my
    daily view reflects my preferred coverage.
21. As a Sports user, I want those stories to appear on the Sports page, so that the full module uses
    the same source preferences.
22. As a Sports user, I want stories from multiple sources to be deduplicated and ranked together,
    so that adding coverage does not create a repetitive feed.
23. As a Sports user, I want source attribution and a working publisher link on every custom story,
    so that I know where it came from and can read the original.
24. As a Sports user, I want a source table showing URL, status, assignments, and actions, so that I
    can understand and manage my configuration at a glance.
25. As a Sports user, I want my sources, assignments, and health details to remain private to my
    account, so that another user cannot read or change them.
26. As a Sports user, I want to add and assign a source by chatting with Moss, so that the same
    capability is available without navigating to settings.
27. As a Sports user, I want source changes through Moss to use normal permission, confirmation,
    audit, and undo behavior, so that the assistant cannot change my coverage unexpectedly.
28. As a Moss operator, I want external source failures represented as bounded structured metadata,
    so that the UI and assistant can explain them without exposing raw external content or logs.
29. As a security reviewer, I want user-supplied URLs fetched through the existing safe outbound
    boundary, so that private networks, unsafe redirects, oversized responses, and unsupported
    content cannot be reached through Sports.
30. As a maintainer, I want custom headlines to enter the existing Sports ranking and presentation
    seam, so that Today and Sports do not grow a parallel feed implementation.

## Implementation Decisions

- Extend the existing Sports settings pane with a simple source table and Add action. Each saved row
  shows publisher label/domain, public URL, active health state, last checked/success times, assigned
  followed teams/leagues, and edit/retry/remove actions.
- The MVP accepts public URLs only. A user may submit any URL, but validation determines whether Moss
  can safely monitor it. Authenticated sources and credentials are tracked separately in #1682.
- Reuse the proven two-phase source flow: resolve and preview first, then confirm a specific
  validated candidate. A source is not persisted or described as active before confirmation.
- Reuse the provider-agnostic safe-fetch, feed discovery/parsing, shallow public-page validation,
  sanitization, and preview primitives already proven by custom News sources. Expose those primitives
  through an appropriate declared public seam rather than importing News module internals or
  duplicating a second unsafe fetcher.
- Keep Sports domain behavior in Sports: source ownership, team/league assignments, health state,
  headline routing, ranking, APIs, assistant tools, and UI remain Sports-owned. News data and ranking
  are not read or changed.
- Add Sports-owned owner-only tables for custom sources and source assignments with FORCE RLS. Add a
  new module-owned migration; do not modify an applied migration.
- A custom source stores its canonical publisher identity, homepage/feed URL, retrieval method,
  validation fingerprint, enabled state, and bounded health metadata. It never stores credentials in
  this MVP.
- Assignments reference the actor's existing followed team or league records. A source can have many
  assignments and a followed target can have many sources. Removing a follow removes its source
  assignments without deleting the source itself.
- Require at least one followed team or league assignment before a custom source contributes stories.
  An unassigned saved source remains visible in settings but inactive for feed composition.
- Model ESPN headlines as the built-in default headline source. The actor may disable/remove ESPN
  headlines explicitly. That preference affects only the ESPN headlines dataset; ESPN-backed teams,
  scores, schedules, standings, and other non-news datasets remain available.
- Fetch custom headlines through the existing Sports overview/Today composition path with the same
  bounded freshness cadence as Sports headlines. Do not add a background crawler or new scheduler
  for the MVP.
- Feed every active custom headline through the existing Sports story contract, ranking,
  attribution, safe-link, and deduplication path. Preserve the assigned competition/team scope and
  reject stories without a safe public URL.
- Treat source content as untrusted external text. Sanitize it before rendering or sending it to an
  AI capability, bound response size and item count, revalidate redirects, block non-public network
  targets, and never expose raw provider bodies or stack traces.
- Custom-source images are not required for the MVP. Stories without an approved safe image render
  through the existing image-optional card path.
- Represent source health with stable machine-readable states and reason codes plus user-facing
  messages. At minimum distinguish pending validation, healthy, temporarily failing, unsupported,
  authentication required, and disabled.
- Persist bounded observations needed for support: last checked time, last successful fetch time,
  safe failure code, and a short internal-safe summary. Do not persist raw page bodies or secrets as
  diagnostic context.
- Error messages must state what failed, whether the source remains active, and what the user can do
  next. Transport/provider failures offer retry; invalid or unsupported sources offer edit/replace;
  authentication-required errors link conceptually to the deferred authenticated-source capability.
- Add an actor-scoped read assistant tool for listing and inspecting Sports source status. Moss uses
  this structured state to explain failures and recommend recognized recovery actions rather than
  guessing from raw logs.
- Add Sports-specific write assistant tools for previewing/confirming a public source, changing its
  assignments, retrying validation/fetch, disabling ESPN headlines, and removing a source. Reuse the
  existing Sports permission, action-family confirmation, audit, and undo infrastructure.
- Settings and chat share the same preview/confirmation state and application services so that a
  source previewed in one surface can be completed consistently and validation behavior cannot
  drift.
- Apply existing source and personalization limits to bound per-user sources, assignments, preview
  candidates, fetched items, and diagnostic output. Exact limits may follow existing custom News
  source defaults unless Sports usage proves a different bound is required.
- Include custom Sports sources and assignments in user export and deletion lifecycle handling.
  Health metadata may be exported only as safe metadata; no fetched article bodies are user-owned
  export data.

## Testing Decisions

- The primary acceptance test uses the live authenticated Sports workflow, the highest existing
  seam: add a public URL, preview and confirm it, assign it to followed teams/leagues, and verify its
  stories appear on both Today and the Sports page.
- In the same live path, assign multiple sources to one target and verify both can contribute without
  duplicate stories; verify ESPN headlines remain until explicitly removed.
- Exercise a failing or unsupported URL and assert that settings show a clear cause and next action.
  Ask Moss why it failed and verify Moss cites the saved status/timestamps, explains the same cause
  in plain language, and offers the recognized recovery action.
- Test external behavior rather than implementation details. A good test proves that a validated,
  assigned source affects user-visible stories and that a failure is understandable and recoverable;
  it does not assert private helper call order.
- Add focused contract/integration coverage for preview/confirm, duplicate detection, source and
  assignment limits, many-to-many assignments, follow removal, ESPN headline disablement, health
  transitions, retry, deletion, export, and owner-scoped RLS.
- Add safe-fetch/security coverage for private-network targets, DNS/redirect rebinding, unsupported
  schemes and content types, excessive bodies, timeouts, malformed feeds, unsafe links, and
  sanitized external text.
- Add Sports service coverage proving custom and ESPN headlines share ranking/deduplication, only
  assigned sources contribute, league and team assignments scope stories correctly, and
  non-headline ESPN datasets survive ESPN headline removal.
- Add assistant gateway coverage proving the read diagnostic tool is actor-scoped and bounded, and
  every source mutation obeys permission, confirmation, audit, and undo rules.
- Reuse prior art from Sports settings/follows e2e tests, Sports overview/ranking tests, the Sports
  external dataset adapter tests, News custom-source preview/confirm and RSS tests, safe outbound
  fetch tests, and structured assistant error-tool tests.
- Live-path evidence on the implementation PR must include the successful source flow, multiple
  assignments, multiple sources on one target, ESPN retained and explicitly removed, one supported
  recovery flow, and confirmation that News and other modules are unchanged.

## Out of Scope

- Usernames, passwords, API keys, cookies, OAuth, or any other publisher credentials; tracked in
  #1682.
- Paywall, robots, authentication, or access-control bypass.
- Changes to the News module's sources, ranking, settings, or displayed stories.
- Replacing ESPN as the provider for teams, scores, schedules, or standings.
- A general-purpose web crawler or unrestricted scraping engine.
- Background continuous crawling or a new scheduling subsystem.
- Multiple source priority tiers or manual ranking weights.
- Cross-user source sharing or an instance-wide source catalog.
- Custom publisher images when they cannot pass existing safe-image policy.

## Further Notes

- "Remove ESPN" in this spec means removing ESPN from the actor's headline mix. It does not remove
  the provider seam that currently powers non-news Sports data.
- The important support contract is shared structured state: the settings UI and Moss must explain
  the same failure and recovery path, not maintain separate error vocabularies.
- Accepting any submitted URL is not the same as supporting any site. Moss must validate capability
  and say no clearly when a public source cannot be monitored safely.
