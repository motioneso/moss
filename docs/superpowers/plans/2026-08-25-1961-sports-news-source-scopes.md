# Plan: Assign ESPN and Custom Sports News Sources by Scope (#1961)

**Status:** Approved  
**Spec:** `docs/superpowers/specs/2026-08-25-1961-sports-source-sport-scope.md` (Approved)  
**Risk tier:** high (owner-scoped RLS migration, existing production preferences, source-fetch
authorization, and shared Today/Sports composition)

## Delivery Rule

Implement the four slices below in order. Each slice must fit one agent session and leave its owned
files green. Do not merge until the final live authenticated path proves ESPN and a custom source
can be scoped, mixed, deduplicated, disabled, and restored through the real UI.

Do not add a provider framework, scheduler, priority engine, or duplicate feed pipeline. Reuse the
existing Sports source service, public-source reader, headline composition, catalog, and ESPN
dataset adapter.

## Verified Current Seams

- `packages/sports/sql/0190_sports_custom_sources.sql` already owns the FORCE-RLS
  `app.sports_headline_prefs` toggle, but runtime and settings do not use it.
- `app.sports_source_assignments` currently requires one `follow_id`; migrations `0191`-`0193`
  added runtime target/health state and repaired legacy feed targets. The next migration must be a
  new file and must preserve ENABLE plus FORCE RLS.
- `SportsSourcesRepository`, `SportsSourceService`, the source routes/client, and chat tools share
  the custom-source preview/confirmation path. Sport targets must enter there once.
- `SportsPublicSourceReader` already fetches equal request identities once, then emits headlines per
  assignment. It is the correct custom-source scope seam.
- `SportsService.getOverview` fetches ESPN headlines unconditionally for visible competitions and
  followed teams, then merges custom headlines by competition. It is already 895 lines; coverage
  matching and news grouping must move to focused helpers rather than push it over 1,000.
- Today consumes the same `/api/sports/overview` response as Sports, so one correct composition path
  covers both surfaces.
- `packages/sports/src/settings/sources.tsx` is 739 lines. The three-group assignment picker should
  move into a focused component instead of growing this file into another mixed-responsibility
  screen.

## Fixed Decisions

- Assignment targets are a discriminated union: catalog sport or owner-visible follow.
- Sport keys are derived from distinct catalog `espnSport` values and one canonical display-label
  map owned by Sports; the UI does not maintain a second source of truth.
- Scope matching is inclusive: sport covers its competitions and teams; competition covers itself
  and its teams; team covers only itself. Results are deduplicated by canonical URL.
- A canonical URL is the existing safe absolute public story URL after WHATWG URL normalization
  and fragment removal. Preserve its path and query; do not add cross-publisher matching or
  heuristic tracking-parameter stripping.
- ESPN is a virtual built-in source, not a fake row in `sports_custom_sources`.
- Reuse `sports_headline_prefs`: enabled with zero explicit scopes means all sports; enabled with
  rows means their union; disabled means no ESPN headlines. This preserves current upgrades and
  allows an explicit empty state.
- ESPN coverage controls headlines only. Scores, schedules, standings, teams, catalog data, and
  gameday structure continue using ESPN regardless of headline preference.
- A custom sport assignment emits one sport news group. It is not fanned out into every competition.
- Feed sport assignments reuse the source's verified feed request. Recipe sport assignments must
  expand and replay the saved recipe for that sport during preview, using only the source's existing
  confirmed hosts. A static recipe reuses its single request; a slotted recipe must produce bounded
  parameters and an exact replayed URL. If that proof fails, reject the preview without changing
  assignments or widening fetch authority.

## Slice 1 — Scope Contracts, Migration, and Owner-Safe Persistence

### Production

- Add migration `packages/sports/sql/0196_sports_news_source_scopes.sql`, register it in
  `packages/sports/src/manifest.ts`, and update the manifest/catalog tests.
- Extend `app.sports_source_assignments` with nullable `sport_key`, make `follow_id` nullable, and
  require exactly one target. Replace the old unique constraint with partial unique indexes for
  source/sport and source/follow. Preserve all runtime target and health columns.
- Add `app.sports_espn_source_assignments` with owner id and the same exclusive sport/follow target,
  partial uniqueness, follow cascade, bounded sport key, and owner-only ENABLE plus FORCE RLS.
- Leave existing source assignment rows untouched. Reassert RLS in the migration and add no worker
  grants.
- Extend `packages/db/src/types.ts` and `packages/shared/src/sports-sources-api.ts` with a closed
  assignment-target union and a normalized source union (`builtin` ESPN or `custom`). Keep recipe,
  opaque parameter, and private health internals server-only.
- Add `packages/sports/src/source/scope.ts` for catalog-derived sport options, target validation,
  display labels, and inclusive scope matching. This is the one pure seam shared by persistence,
  ESPN gating, composition, and UI DTO shaping.
- Extend the custom repository for sport targets. Add a focused ESPN preference repository rather
  than growing `source/repository.ts` past 1,000 lines. Validate every follow by actor-scoped
  re-selection and every sport through the catalog before writes.
- Resolve an absent ESPN preference as enabled/all-sports. Persist explicit scopes on first edit;
  clearing all deliberately sets `espn_headlines_enabled=false` and deletes stale scope rows in the
  same transaction. Restoring coverage writes the selected rows and re-enables headlines.

### Checks

- Contract tests reject empty, mixed, unknown-sport, duplicate, and over-limit target shapes.
- Integration coverage starts from migrations through `0195`, applies `0196`, and proves existing
  rows remain follow assignments with their verified target/health state intact.
- Under FORCE RLS, prove owner isolation for custom sport assignments, ESPN preferences, and ESPN
  scope rows; foreign-owner follow ids are rejected even though FK checks bypass row visibility.
- Prove default-all, explicit subset, explicit disabled, follow cascade, partial uniqueness, and the
  shared assignment cap.

## Slice 2 — One Assignment Application Path and Normalized Source API

### Production

- Extend custom assignment preview/confirmation in `source/discovery.ts`, `source/service.ts`, and
  the preview store to accept sport targets. Feed sources reuse the verified feed request. Recipe
  sources must expand and replay their saved recipe during preview: static recipes reuse the one
  verified request, while slotted recipes persist only the bounded parameters and exact replayed
  URL proved within existing confirmed hosts. Reject an unprovable sport target atomically. Add no
  new fetch authority and do not guess from the source base URL at runtime.
- Extend source routes, shared schemas, web client, and Sports chat assignment tools to use the same
  discriminated targets. Preserve one-use actor-bound preview confirmation for custom sources.
- Add an actor-scoped ESPN coverage read/write service and REST route. ESPN scope changes need no
  external preview, but they must use the same catalog/follow validation, limits, and data context.
- Return one normalized source list with ESPN first (`kind: builtin`, Built-in label, coverage
  assignments) followed by custom publishers. Do not expose fake URL, validation, Retry, Rebuild,
  or Remove capabilities for ESPN.
- Keep export/deletion lifecycle complete for the new owner-owned preference rows and sport targets.

### Checks

- Route, client, service, and chat-tool tests cover custom sport preview/confirm plus ESPN
  read/update/default/disable behavior. Recipe coverage includes static reuse, verified slotted
  expansion, and rejection without mutation when a sport request cannot be replayed.
- Prove cross-actor, stale, replayed, unknown-sport, foreign-follow, and limit-exceeding writes make
  no change.
- Prove custom removals-only edits perform no external request and unchanged verified assignments
  retain health.
- Prove ESPN has only coverage actions while custom sources retain Retry/Rebuild/Edit/Remove.

## Slice 3 — ESPN Gating and Mixed Sport/Competition Composition

### Production

- Extend `SportsPublicSourceReader` runtime assignments with the typed sport/follow scope. Continue
  grouping equal request identities so one feed fetch can serve several scopes without duplicate
  network work or shared health state.
- Extend `headline-composition.ts` with typed sport/competition news groups, canonical-URL
  deduplication across provider/scope paths, and scope-neutral ranking inputs. Keep provider labels
  and safe public links intact.
- Move ESPN coverage resolution out of `SportsService.getOverview` into the focused scope helper.
  Gate only ESPN `headlines` dataset reads and team headline feeds; never gate non-headline ESPN
  datasets or the article-body read for an already-selected ESPN story.
- An ESPN sport assignment permits headline reads for visible competitions/teams in that sport; a
  competition or team assignment permits only that narrower path. Merge every matching ESPN and
  custom result through one news-group seam.
- Replace the league-only response/filter assumption with typed sport or competition groups. A
  custom sport-wide story appears once in its sport group; it does not acquire fake competition or
  team attribution.

### Checks

- Reader tests cover sport assignment emission, shared fetch identity, per-assignment health, and
  no fan-out duplication.
- Sports service/composition tests cover default ESPN behavior, sport/competition/team subsets,
  ESPN disabled with non-news data intact, multiple custom publishers, cross-path URL dedupe,
  labels, ranking, and fail-soft degradation.
- Today and Sports contract tests prove both surfaces receive the same mixed groups.
- Keep `sports-service.ts` below 1,000 lines and run the file-size gate on every touched large file.

## Slice 4 — Settings UI, Release Note, and Live Path

### Production

- Extract a focused source-assignment picker from `settings/sources.tsx`. Render Sports, Leagues,
  and Teams groups with existing `jds-check`, labels, loading/empty/error states, and responsive
  action layout.
- Show ESPN first with a Built-in badge, coverage summary, and Edit coverage action only. Show
  inactive headline state truthfully when all ESPN coverage is cleared.
- Use the same picker for add and edit custom-source flows. Summaries distinguish sport, league,
  and team assignments and retain current target/status/error presentation.
- Make the Sports news filter scope-neutral (`All`, sports, competitions) without inventing new
  visual primitives or colors.
- Update `docs/WHATS_NEW.md` and the PR release-note fields with plain-language Added copy.

### Checks

- Settings render tests cover ESPN default/subset/disabled states, all three picker groups,
  capability-specific actions, persisted summaries, and styled errors.
- E2E mocks isolate every Sports source/coverage endpoint and prove edits invalidate/refetch the
  normalized source list.
- Run scoped typecheck, root test TypeScript, ESLint, Prettier, design-token/class audits, and focused
  unit tests. Run DB-touching/full gates only through the repository gate workflow.
- CI must pass foundation, integration, Playwright, service worker, both compose smokes, and image
  build.
- Record live authenticated dev evidence: assign Soccer to FotMob; retain Liverpool, Champions
  League, and San Diego FC; verify mixed ESPN/FotMob Soccer news and URL dedupe; narrow ESPN; clear
  and restore ESPN; prove scores/standings remain; remove only FotMob Soccer and prove its other
  assignments remain.

## Exit Criteria

- All fourteen spec acceptance items have executable evidence.
- Migration `0196` preserves production assignments and RLS posture.
- ESPN is visible and assignable but cannot affect non-headline datasets.
- General sport news can mix ESPN and multiple custom publishers without false competition labels
  or duplicate stories.
- The full CI gate and live-path gate are green before merge.
