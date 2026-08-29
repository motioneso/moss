# Sports Standings League Picker — Spec (#1930)

## Problem Statement

The Sports page currently puts every supported competition into one flat standings selector. As
the catalog grows, the selector becomes harder to scan, relevant leagues are buried, and users
cannot control which leagues appear. The standings table itself is useful; the problem is finding
and choosing the right league.

## Solution

Give every Sports user a curated standings picker backed by Sports settings. Settings presents the
supported competition catalog as checkboxes grouped by sport and, where useful, country. The Sports
page replaces the flat selector with a compact, accessible picker using the same hierarchy.

Competitions associated with a team or league the actor already follows are automatically included
and pinned in a top-level **Following** section. Existing follows therefore provide the favorites
behavior; this feature does not add a second favorites model. Other visible competitions come from
the actor's saved standings selection.

## User Stories

1. As a Sports user, I want to choose which supported competitions appear in standings, so that I do not have to scan irrelevant leagues.
2. As a Sports user, I want my standings choices saved to my account, so that they survive reloads and other signed-in devices.
3. As a Sports user, I want competitions grouped by sport, so that I can narrow the list quickly.
4. As a soccer follower, I want competitions grouped by country where that distinction is useful, so that similarly named domestic leagues are easy to distinguish.
5. As a Sports user, I want international and cross-country competitions placed in an appropriate non-country group, so that they are not assigned a misleading country.
6. As a Sports user, I want leagues connected to teams I follow pinned at the top, so that my most relevant standings are never buried.
7. As a Sports user, I want whole-league follows pinned at the top, so that following a league and following one of its teams behave consistently.
8. As a Sports user, I want a followed competition included even when I did not check it separately for standings, so that following something is enough to keep it readily available.
9. As a Sports user, I want each competition to appear only once in the picker, so that the hierarchy stays concise.
10. As a Sports user, I want the picker trigger to name the current competition, so that I know which standings I am viewing before opening it.
11. As a Sports user, I want choosing a competition to update the existing standings content, so that selection feels direct and predictable.
12. As a Sports user, I want the existing division, conference, or group selector to remain available, so that this redesign does not remove standings detail.
13. As a keyboard user, I want to open, navigate, select, and close the picker without a pointer, so that the control is fully usable.
14. As a screen-reader user, I want the trigger, groups, current selection, and expanded state announced clearly, so that the hierarchy is understandable.
15. As a mobile user, I want the picker to fit the standings rail without horizontal scrolling or clipped controls, so that it remains usable on a narrow screen.
16. As a Sports user, I want a clear Settings link when I have explicitly selected no competitions and follow none, so that an empty picker is recoverable.
17. As an existing Sports user, I want the current catalog to remain available until I customize it, so that shipping the feature does not silently remove leagues from my page.
18. As a Sports user, I want unsupported saved keys ignored safely if the catalog changes, so that a retired competition cannot break the picker.
19. As a Sports user, I want a failed settings save to leave my last saved selection intact and explain the failure, so that I do not lose a working configuration.
20. As a Sports user, I want loading and unavailable states to use the existing Sports visual language, so that the new control feels native to the page.

## Implementation Decisions

- Keep the feature inside the existing Sports module. The standings table, standings provider,
  lazy standings fetch, and division/conference/group selection remain unchanged.
- Add explicit display-group metadata to the canonical competition catalog: a sport label and an
  optional country/region label. Static catalog data owns this presentation fact; the UI must not
  infer countries from competition keys or provider slugs.
- Extend the authenticated Sports catalog contract with the grouping metadata needed by both
  Settings and the picker. Do not expose provider-specific grouping logic to the UI.
- Persist the actor's selected competition keys in the existing owner-private preferences store
  under a Sports-owned key. Reuse its existing RLS and data-context path; no new table or migration
  is warranted for one JSON list.
- Add a small authenticated Sports preferences contract that reads and replaces the selected
  competition-key list. Writes accept only a deduplicated array of keys present in the canonical
  catalog. Unknown keys are rejected at the trust boundary.
- Treat an absent preference as the backward-compatible default: all supported competitions are
  available. Treat an explicitly saved empty list as an intentional empty selection.
- Compute visible competitions as the union of saved selections and competitions referenced by the
  actor's existing team or whole-league follows.
- Render followed competitions once in a top-level **Following** section and omit those duplicates
  from the nested remainder.
- Order **Following** deterministically using the existing follow order. Order remaining sports,
  countries/regions, and competitions by their catalog display order so the control does not invent
  a second ranking system.
- When the current competition stops being visible, fall back to the first followed competition,
  then the first configured competition. If neither exists, render a concise empty state linking to
  Sports settings.
- Replace only the league selector with a custom, dismissible picker because native select groups
  cannot represent Following → sport → optional country. Reuse the existing menu dismissal/focus
  behavior and authored design tokens; add no UI dependency and no new theme.
- Keep the picker visually subordinate to the standings content. It is navigation, not a new card,
  dashboard, or page-level redesign.
- Sports settings uses ordinary checkboxes against the supported catalog. Existing follow controls
  remain separate: follows drive Sports/news personalization and automatic pinning, while the new
  checkboxes only curate standings navigation.
- Provide honest loading, save-error, empty, hover, focus-visible, active, disabled, and selected
  states using existing JDS/Sports primitives. Motion is unnecessary beyond existing menu behavior.
- Keep all preference reads and writes inside the actor's data context. Admin status grants no
  access to another user's selection.

## Testing Decisions

- The primary seam is one authenticated browser flow, matching the agreed verification path:
  choose a bounded set of supported leagues in Sports settings, follow a team or league, navigate
  to Sports, and assert that the picker reflects the saved set with the followed competition pinned
  in **Following**. Select a league and assert that the existing standings content updates.
- The browser flow also reloads Settings and Sports to prove persistence, confirms an unchecked and
  unfollowed competition is absent, and exercises keyboard open/navigation/select/close behavior.
- Extend the existing Sports settings Playwright mock rather than creating a second test harness.
  Extend the existing mock Sports API for the page assertion so catalog, follows, preferences, and
  standings share one stateful scenario.
- Add focused route/contract tests for rejecting unknown competition keys, deduplicating or
  rejecting duplicate input consistently, distinguishing absent preferences from an explicit empty
  list, and returning only actor-owned state.
- Add one focused picker component test for hierarchy, Following pinning, de-duplication, fallback
  selection, and the empty-state Settings link. Assert accessible names and observable selection,
  not internal component state or markup shape.
- Reuse existing Sports-page standings tests for the unchanged table and division/group behavior;
  do not duplicate provider or standings-row coverage in picker tests.
- Release verification must exercise the assembled path through the real UI on a live dev instance
  and record bounded DOM/network assertions on the pull request. Unit or mocked browser tests alone
  do not satisfy the project's live-path gate.

## Out of Scope

- Adding custom leagues, arbitrary provider IDs, or any competition not already supported by the
  canonical Sports catalog.
- Changing standings data, table columns, ranking semantics, qualification markers, tournament
  fixtures, or division/conference/group behavior.
- Adding a separate favorites table, star action, or favorites settings model. Existing Sports
  follows are the source of top-level relevance.
- Changing news-follow semantics, custom sports sources, scores, schedules, team cards, or the
  Around the Leagues board.
- Adding search, drag-and-drop ordering, manual pin ordering, per-device selections, or a new UI
  library in the first version.

## Further Notes

- This spec intentionally solves #1930 as a picker/settings feature only. Open issue #1184 overlaps
  in its desire to prioritize followed leagues; the build should avoid implementing a second
  standings-priority mechanism there.
- The hierarchy is **Following → sport → optional country/region → competition**. A country/region
  level appears only when it adds real distinction; single-group sports should not gain empty
  folder depth.
- The solution preserves the Sports page's authored broadsheet character and uses the live design
  tokens. No Hallmark theme, extra decorative surface, or generated visual system is introduced.
