# Sports News Sources by Sport

**Status:** Approved  
**Date:** 2026-08-25  
**Owner:** Ben  
**GitHub:** #1961

## Problem

Sports custom sources can be assigned only to followed teams and leagues. That works for targeted
coverage, but it leaves general coverage for a sport effectively ESPN-only. A broad publisher such
as FotMob cannot contribute general Soccer stories without being mislabeled as Liverpool,
Champions League, San Diego FC, or another narrow assignment. ESPN itself is an invisible always-on
provider rather than a source users can manage through the same coverage controls.

## Solution

Add Sport as a first-class news-source assignment scope alongside League and Team. A source may
target any combination of all three. Selecting Soccer for FotMob adds its headlines once to the
general Soccer news pool, where they are ranked and deduplicated with ESPN and other selected
publishers. Existing league and team assignments continue to drive narrower coverage.

Represent ESPN as a built-in source in the same source list and assignment editor. ESPN starts with
all catalog sports selected so upgrades preserve today's headline coverage. Users may narrow ESPN
to selected sports, leagues, or teams, or clear all assignments to remove ESPN headlines entirely.
This never disables ESPN-backed scores, schedules, standings, teams, or catalog data.

Sport scope is explicit. Moss does not automatically make every custom source general, and it does
not copy a sport-wide story into every league within that sport.

## User Experience

Every source, including ESPN, uses an assignment editor with three groups:

1. **Sports** — Football, Hockey, Soccer, Baseball, and Basketball, derived from the active Sports
   catalog rather than a second manually maintained list.
2. **Leagues** — the leagues and tournaments the actor follows.
3. **Teams** — the teams the actor follows.

Each option uses the existing checkbox treatment. A source summary shows its selected sports,
leagues, and teams as labeled assignments. Empty, loading, error, Retry, Rebuild, Edit, and Remove
states retain the existing polished Sports settings treatment.

ESPN appears first with a **Built-in** badge and an **Edit coverage** action. It has no URL editor,
Retry, Rebuild, or Remove action because those apply only to user-added publishers. Clearing all
ESPN assignments displays it as inactive for headlines and offers Edit coverage to restore any
scope.

The Sports news filter becomes scope-neutral rather than league-only. It can show All, a sport such
as Soccer, or an existing competition. A general Soccer headline is labeled Soccer and is never
presented as belonging to a specific league or team unless it also enters through that narrower
assignment.

## Domain Model

Treat an assignment target as a discriminated union:

- `sport`: a catalog-derived sport key such as `soccer`, `football`, `hockey`, `baseball`, or
  `basketball`;
- `follow`: an existing owner-visible Sports follow, which remains either a whole competition or a
  team within a competition.

The shared API exposes assignment targets by kind instead of encoding sports as fake follow IDs or
synthetic competitions. Preview and confirmation use the same target union, so feed and recipe
sources cannot drift between settings, chat tools, and runtime ingestion.

Treat a source as a second discriminated union:

- `builtin`: a Sports-owned provider key, initially `espn`;
- `custom`: an actor-owned validated public source.

The UI consumes one normalized source list but preserves kind-specific actions. A built-in source
is not represented as a fake custom URL and does not inherit custom-source validation or health
fields that do not apply to it.

## Storage and Security

Add an additive Sports migration. `app.sports_source_assignments` gains a nullable catalog-backed
`sport_key`; `follow_id` becomes nullable; a check constraint requires exactly one of `sport_key`
or `follow_id`. Partial unique indexes enforce one assignment per source/sport and preserve one
assignment per source/follow.

Existing rows remain follow assignments with no rewrite. The table stays owner-only with ENABLE
and FORCE RLS. Repository writes validate sport keys against the Sports catalog and re-select
follow targets through the actor-scoped data context before inserting. Foreign keys continue to
cascade follow assignments when a follow is removed; sport assignments are unaffected.

Reuse the existing owner-only `app.sports_headline_prefs` row for ESPN rather than creating a fake
custom source or a second preference system. Add a small owner-only ESPN assignment table using the
same exclusive `sport_key`/`follow_id` target shape. Resolve ESPN coverage as follows:

- ESPN enabled with no scoped rows means all catalog sports, preserving the existing default;
- ESPN enabled with scoped rows means exactly their inclusive union;
- ESPN disabled means no ESPN headlines, regardless of scoped rows.

The first coverage edit persists the chosen scopes and toggle. Both preference and assignment state
use ENABLE and FORCE RLS plus the same catalog/follow ownership validation.

## Runtime Composition

Fetch a source request once per resolved request identity even when it has several assignment
targets. Emit each fetched story into the applicable assignment scopes, then deduplicate the
combined visible result by canonical public URL before ranking.

Replace the league-only news grouping assumption at the shared composition seam with one typed
news-group scope (`sport` or `competition`). Resolve each provider against its selected scopes
before fetching or composing headlines. A sport assignment covers that sport's competition and
team headline scopes; a competition assignment covers that competition and its teams; a team
assignment covers only that team. The union is inclusive, and the final result is deduplicated by
canonical URL.

ESPN keeps its existing competition/team endpoints but only contributes headline datasets matched
by its resolved coverage. Custom team/league stories preserve their current behavior. Sport-wide
custom stories create one sport group and participate in the same attribution, safe-link, health,
Retry, cache, ranking, Today, and Sports page paths.

No custom story is copied into every competition for its sport. No source priority or replacement
rule is added: every matching provider is mixed through the same ranking and deduplication seam.

## Limits and Failure Behavior

Existing per-user source and assignment limits remain authoritative, with sport assignments
counting toward the same assignment cap. Unsupported, unhealthy, disabled, or unverified targets
do not contribute stories and retain the existing bounded reason codes and recovery actions.

Removing a sport assignment stops that source from general coverage for the sport without changing
its league or team assignments. Removing a custom source removes every assignment as today. ESPN
cannot be removed, but an explicit empty assignment set disables its headlines.

## Acceptance

1. The source list shows ESPN as Built-in plus user-added publishers.
2. Every source assignment editor shows separate Sports, Leagues, and Teams selectors.
3. Existing and new users initially receive the same ESPN headline coverage as today.
4. FotMob can target Soccer while retaining Liverpool, Champions League, and San Diego FC.
5. General Soccer news contains a ranked mix of ESPN and FotMob.
6. A FotMob story returned through multiple targets renders once by canonical URL.
7. Generic FotMob stories are labeled Soccer, not copied or mislabeled as each soccer competition.
8. Existing league and team filters retain targeted behavior.
9. Narrowing ESPN to selected scopes changes only ESPN headlines in those scopes.
10. Clearing ESPN coverage removes ESPN headlines while scores, schedules, standings, teams, and
    catalog data continue working.
11. Removing Soccer from FotMob stops its general Soccer coverage without changing other
    assignments.
12. Cross-user built-in/custom assignment reads and writes remain blocked by RLS and repository
    checks.
13. Today and Sports consume the same mixed result rather than separate implementations.
14. A live authenticated dev run proves ESPN and custom assignment edits, refresh, mixed rendering,
    deduplication, disable/restore, and removal through the real settings and Sports UI before merge.

## Verification

- Contract tests for the discriminated assignment target and invalid mixed/empty shapes.
- Migration and repository integration tests for existing-row compatibility, ESPN default versus
  explicit-empty behavior, uniqueness, limits, catalog validation, follow cascades, and FORCE-RLS
  owner isolation.
- Source-service tests for preview/confirm/retry of sport targets.
- Overview composition tests for ESPN plus multiple custom sources, scope inheritance, URL
  deduplication, labels, ESPN disable/restore, and removal without disturbing other assignments.
- Settings tests for the built-in ESPN row, kind-specific actions, three selector groups, and
  persisted selection summaries.
- Existing lint, format, type, file-size, design-token, unit, integration, Playwright, service
  worker, and compose gates.
- Live-path evidence attached to the implementation PR as required by project standards.

## Out of Scope

- Replacing ESPN for scores, schedules, standings, teams, or catalog data.
- Automatic story classification into every league or team within a selected sport.
- Publisher priority weights or exclusive-source modes.
- Authenticated/paywalled publishers, a crawler, or a new background scheduler.
- Cross-user or instance-wide source sharing.
