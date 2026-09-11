# Slice 3: News, sports, weather, and contribution contracts

**Goal:** Feed the approved editorial briefing and Today modules with real existing data and correct
preference/availability semantics. This lane can begin after readiness while slices 1–2 proceed.

Read the [shared plan](2026-09-10-today-briefings.md) and
[module exploration](../../research/2026-09-10-today-briefings-modules-exploration.md).

## Files and reuse

- Briefing defaults/settings: `packages/briefings/src/routes.ts`, `manifest.ts`,
  `packages/shared/src/briefings-api.ts`, `apps/web/src/settings/settings-module-subviews.tsx`.
- News: `packages/news/src/briefing-tool.ts`, `news-service.ts`, `manifest.ts`,
  `web/today-widget.tsx`; `packages/shared/src/news-api.ts`.
- Sports: `packages/sports/src/briefing-tool.ts`, `sports-service.ts`, `manifest.ts`,
  `web/today-widget.tsx`, `web/sports-around-ticker.tsx`; `packages/shared/src/sports-api.ts`.
- Freshness/composition: `packages/briefings/src/compose-shared.ts`, `external-contributions.ts`,
  `freshness.ts`; `apps/web/src/today/briefing-freshness.tsx`.
- Weather: `packages/weather/src/weather-service.ts`, `open-meteo.ts`, `routes.ts`, `manifest.ts`;
  `packages/shared/src/weather-api.ts`.
- Boot wiring: focused News/Sports configuration in `packages/module-registry/src/index.ts`.

## Task 1: Inclusion defaults without erasing choices

- [ ] Reuse persisted per-definition `selectedToolNames` as the authoritative preference path. Add separately labelled Morning News and Morning Sports controls; these control
      briefing inclusion, not module installation or Today widgets.
- [ ] Add `news.topHeadlinesToday` to new morning defaults; retain `sports.followedFactsToday`.
      Preserve existing explicitly stored tool selections and publisher/topic exclusions. Never infer
      “missing” from false/empty without the API's explicit default rule.
- [ ] Permit explicit `selectedToolNames: []` through shared create/update schemas (currently
      `minItems: 1`), runtime parser and a new Briefings migration. The original
      `packages/briefings/sql/0015_briefings_module.sql` requires nonempty arrays; inspect the installed
      constraint (expected `briefing_definitions_selected_tool_names_check`) and replace only that
      condition without editing the applied migration. Preserve non-null/type/read-tool validation.
      Omitted create uses defaults; omitted PATCH keeps the stored list; explicit `[]` selects no tools.
      Composition may still use focus/preferences/persona and model/fallback; do not call it AI-off.
- [ ] Test a definition selecting only News/Sports with both controls off, reload, and re-enable,
      along with old explicit opt-outs and omitted default creation. Gate SQL checks through protected
      integration; route/UI unit tests alone do not prove the constraint was updated.
- [ ] Apply disabled-module/feature-grant checks before built-in tool invocation, as well as selected
      source membership. Keep stored choices available for a later deliberate module re-enable.
- [ ] Test default creation through both REST and actual Settings UI; the current UI populates from
      every read tool, which must not silently re-add deselected News/Sports on later edits.
- [ ] Distinguish “excluded by preference,” “disabled module,” “no followed teams/stories,” and
      “provider unavailable.” Exclusions should quietly omit content, not display alarming error banners.

## Task 2: Reuse data, extend briefing-safe evidence

- [ ] News: consume the existing personalized overview/service and its sanitized headline, summary,
      source, timestamp, image URL and feedback/source reference. Preserve dismissed stories, publisher
      exclusions, source/topic preferences and safe image proxy/CSP rules.
- [ ] Sports: consume existing overview scoreboards, followed refs, stories/photos and cached source
      data. Produce bounded previous-night finals, followed-team-first ordering, and notable other games
      with explainable story relevance. Do not request ESPN again from a host UI component.
- [ ] On the current-main base, use permanent `sourceTeamId` identities and preserve
      `ambiguousFollows` remediation candidates; unresolved follows must not produce cards, scores or
      briefing claims. Never infer a followed team from an ambiguous saved short `teamKey`.
      Reuse the existing five-league default slate when no teams are followed.
- [ ] Derive Tonight/live/quiet states using actor-local day boundaries and competition event
      instants. Handle games ending after midnight, postponed/cancelled games, no followed teams and
      off-season competitions. A missing provider result is not “no games.”
- [ ] Extend a typed briefing contribution/display projection with bounded facts and safe source
      references. Keep compact read tools compatible with existing callers; validate/sanitize all new
      fields before synthesis. Photos are display references, not raw image/article payloads in prompts.
- [ ] Preserve generated prose separately from canonical scores/times. Summaries must not alter
      factual numeric results or invent a “big story” unsupported by the available facts.
- [ ] Use a real photo when the source supplies one. Missing/expired/disallowed imagery uses a clean
      text layout; do not ship prototype-generated pictures as factual coverage.
- [ ] Reuse current-main Sports owner-scoped stored photo paths/dimensions and its feed → verified
      rule → article-share fallback. Keep owner checks and existing failure handling; add no second
      host image fetcher. Test ambiguous follows, default-slate ordering and inaccessible stored images.
- [ ] Add News/Sports source labels and real captured/published/synced timestamps to freshness. Do
      not label cached module data realtime merely because an unknown source key falls through today.

## Task 3: Owning Today widgets and weather

- [ ] Extend Sports' actual `web/today-widget.tsx` to render its existing scoreboard response and
      dedicated Tonight group. Retain shared overview query/cache, live-game-only polling and feedback.
- [ ] Adapt News' already photo/prose-capable widget to approved sizing/hierarchy; do not build on
      the unused host `TodayFeed`/`NewsDesk` path or duplicate the News provider service.
- [ ] Reuse `/api/weather/today`, the Open-Meteo five-day mapping and current unit/location settings.
      Add a truthful observation/cache age if needed; distinguish missing location/setup from provider
      unavailability. The Today repositioning is in slice 5, not a weather-provider rewrite.
- [ ] Check #1919 against the candidate source/runtime before allocating forecast work; five-day
      data/tiles already exist. Keep the issue state truthful rather than closing it from this research.
- [ ] Prove News and Sports late-bound tool services are configured in each production API/worker
      entry before use (#2313). Test a bypassed setup path and meaningful recoverable failure.
- [ ] Update module features/settings/errors/remediations and route metadata with every changed
      contribution. Preserve safe browser-only `./web` exports and inactive-module fail-closed behavior.

## Verification and session boundaries

- [ ] First session checkpoint: default/opt-out/inactive-module behavior passes through both route
      parsing and Settings request shaping. No new separate preference truth source.
- [ ] Second checkpoint: structured News/Sports evidence and source trust/freshness tests pass.
- [ ] Third checkpoint: scoreboard/Tonight, images, Weather states and boot wiring are exercised.

Use existing unit suites: `briefings-default-tools`, `briefings-compose`, `news-service`,
`sports-service`, `news-today-widget`, Sports widget/contribution tests, `open-meteo`,
`weather-service`, browser-safety and route-guard tests. Add focused boundary tests only where the
new behavior has no coverage. Run scoped static checks; DB tests use protected isolation. Record
actual commands and outcomes. Screenshots validate design only; live module setup proof belongs to
slice 8.
