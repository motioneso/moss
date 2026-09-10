# Frontend exploration: Today and morning/evening briefings

Date: 2026-09-10
Scope: frontend composition, queries, settings/client state, existing interaction surfaces, and safe verification commands. This is implementation research for the approved Today, morning, and evening documents; it is not a product change or a replacement for the implementation plan.

## Reading and graph boundary

Read: `CLAUDE.md`, `docs/DEVELOPMENT_STANDARDS.md`, and the three approved specs:

- `docs/superpowers/specs/2026-09-10-today-briefings-design.md`
- `docs/superpowers/specs/2026-09-10-morning-briefing-flow.md`
- `docs/superpowers/specs/2026-09-10-evening-planning-flow.md`

The codebase-memory graph project is `home-ben-Jarv1s`, rooted at `~/Jarv1s`. Key symbols are `TodayPage` (`apps/web/src/today/today-page.tsx:92-725`), `MorningBriefingSection` (`today-page.tsx:727-750`), `EveningReviewSection`, `EveningPrepCard`, and `EveningSupportSections` (`apps/web/src/today/evening-mode.tsx`), and `BriefingActionRowsSection` (`apps/web/src/today/briefing-action-rows.tsx:70-139`). Graph traces connect Today to briefing settings, query keys, locale, task/calendar clients, Wellness clients, `ModuleTodayWidgets`, and evening helpers.

The `.superpowers/brainstorm/today-briefings-20260909` preview and bounded images in the specs are fictional study references. They are not production behavior or live-path evidence.

## Route, shell, and Today composition

`apps/web/src/app.tsx:59-61` lazy-loads Today. The index redirects to `webRoutePath("today")`; `/today` passes `me`, the Wellness gate result, and `disabledModuleIds` (`app.tsx:288-298`). It does not pass `TodayFeed`, so production Today defaults to `createEmptyTodayFeed()` unless a future caller supplies a feed.

`apps/web/src/app-route-metadata.ts:38-56` derives Today navigation from `CORE_APP_SCREENS`, keeps the topbar subtitle empty, and leaves date/time to the masthead. `CORE_APP_SCREENS.today` (`packages/shared/src/app-map-core.ts:41-48`) currently says the screen contains tasks, events, briefings, and priority cues. Any newly reachable reader/review behavior needs a truthful matching declaration in the same product PR; module-owned news, sports, calendar, Wellness, and briefings settings changes belong in their manifests, including errors/remediations.

`apps/web/src/shell/app-shell.tsx:281-287` fetches weather only on `/today` with `queryKeys.weather.today`, `getWeatherToday`, and a 30-minute stale time. `app-shell.tsx:423-427` puts `HeaderWeather` in the topbar. `HeaderWeather` (`apps/web/src/today/header-weather.tsx:32-74`) consumes `WeatherTodayDto`, renders current plus forecast tiles with locale-aware weekday labels, and links to Weather Underground. The approved prominent weather row is therefore an extension/repositioning of an existing query/component seam; `TodayPage` does not use `feed.weather`.

The selected implementation revision needs a quick shell re-read: `origin/main` contains a later app-shell restructuring that wraps navigation/content in `PageTrailProvider`, adds `TopbarTitles`/`TrailMoreButton`, and imports `BrandMark` from `@moss/ui`, while retaining the same `/today` weather query and `HeaderWeather` topbar placement and the same theme effect. `packages/shared/src/app-map-core.ts` changes between this checkout and `origin/main` add only the admin `enckeys` setting; there is no new Today/briefing screen declaration there. Slice 5 should compose against the chosen revision's topbar seams and add any new Today reader/history/settings/error declarations in the same product PR.

`TodayPage` queries and state (`today-page.tsx:99-230`):

- onboarding status gates email Reply;
- tasks/lists, calendar events, briefing definitions, evening runs, and enabled morning runs;
- medication schedule only when the Wellness gate is enabled;
- local task-details, medication, management, and check-in dialog booleans;
- a 30-second clock tick and timer refresh at the evening target boundary.

Definitions use `findDefinition`; runs use `queryKeys.briefings.runs(definitionId)`. `deriveTodayMode`, `effective*TimeZone`, `latestBriefingRunForToday`, and `latestEveningRunForToday` apply the persisted locale/time zone and local-day filtering. `selectActionRowsRun` (`evening-mode.tsx:360-366`) chooses morning payload in day mode and evening payload in evening mode, avoiding stale morning rows after the mode switch.

Current main-column order is: evening primary review/support (evening only); morning prose (day only); Start here; Needs you; overnight feed items; calendar; generic module widgets; legacy feed news/interests; goals; loose ends; proactive cards. The rail contains next-event countdown, signal-bearing stat tiles, upcoming agenda, compact evening review/prep, and Wellness actions.

`kit-today.css:42-128` makes a 1220px wrap with 40px desktop padding, `minmax(0,1fr) 336px` columns, 44px gap, desktop keyline, and sticky rail. At 1080px it becomes one column; at 720px the masthead stacks and hides the clock; at 640px the rail moves before main content and Wellness is first.

## Existing briefing and action UI

`MorningBriefingSection` is deliberately a compact landing block (`today-page.tsx:727-750`): `jds-brief`, “Morning briefing”, “Your day, in focus”, freshness banner, then loading / `BriefingProse` / “Your morning briefing is not ready yet.” It has no full-reader link, overnight evidence disclosure, preparation-materials link, review tab, schedule, or accept-all action. Preserve it as the landing summary and keep the approved full reader/review in a focused component instead of expanding TodayPage.

`EveningReviewSection` (`evening-mode.tsx:137-199`) already has readable primary prose and compact rail forms, stale/loading/empty states, run date, and `BriefingFeedbackMenu`. `EveningSupportSections` renders accomplished work, carrying-forward tasks, and tomorrow events/due tasks with `BriefTaskRow`. `EveningPrepCard` (`evening-mode.tsx:205-226`) opens global chat immediately and then calls `startEveningInterview` with the latest run id (`today-page.tsx:568-580`), preserving the approved optional conversation and ordinary action permissions.

`BriefingActionRowsSection` joins frozen `BriefingActionRowDto` payloads to live `TaskDto` by id (`briefing-action-rows.tsx:47-62`). Suggested rows offer Reply/View, Accept, and Dismiss; accepted/dismissed rows show status. Triage updates tasks and invalidates task/run queries (`:70-81`). `rowsFromSuggestedTasks` (`:267-310`) reconstructs email rows before a briefing run, an important morning state. `buildReplyChatPrompt` includes only the opaque cache message id; retain this security invariant.

`BriefingFreshnessList`, `BriefingStaleBanner`, `parseBriefingFreshness`, and `formatAge` (`apps/web/src/today/briefing-freshness.tsx:15-76`) are the existing source-age presentation. Reuse its model for expanded evidence; do not duplicate age parsing. A full reader needs a disclosure control and stable association between evidence and affected schedule items.

`TaskDetailsDialog` (`apps/web/src/tasks/task-details-dialog.tsx`) is opened from Today using only a local task id. It fetches detail, subtasks, activity, and tags, seeds due/reminder inputs from persisted locale time zone, and saves through canonical task clients with invalidation. Use it for task context; keep scheduling controls in the briefing review surface rather than forking task editing.

## Chat, dialogs, and module contributions

`apps/web/src/shell/chat-controls-context.ts:3-29` exposes `openChat`, `openChatWith` (auto-send), and `openAssistantWithDraft` (editable, never auto-send). `AppShell` stores the one-shot draft and renders one `ChatDrawer` (`app-shell.tsx:91-113,318-345`). `Composer` seeds `initialText` once and focuses the textarea (`chat/composer.tsx:61-90`). Use this for user-reviewed correction/planning notes; never silently turn prose into mutations.

`ChatDrawer` already handles history, SSE records, private mode, model availability, attachments, errors, and composer controls. `packages/ui/src/dialog.tsx:14-35` supplies scrim close, `role="dialog"`, `aria-modal`, labelled title, body, and footer, but no Escape handling, focus trap, return-focus, or full-screen mobile layout. It is therefore a visual shell, not ready for the approved full-screen reader. The closest complete local pattern is `apps/web/src/shell/command-palette.tsx`: it stores the opener, focuses its input on open, closes on document-level Escape, traps Tab/Shift-Tab, and restores focus on close (`:51-53, 88-108, 141-166, 228-231, 480-518`). That behavior should either be extracted into a focused reader wrapper or deliberately reproduced there; the shared `Dialog` should not be described as already accessible for this use.

`ModuleTodayWidgets` (`apps/web/src/today/module-today-widgets.tsx:14-45`) lazily loads build-time `virtual:moss-module-web` contributions independently and filters `disabledModuleIds`. The SDK seam (`packages/module-web-sdk/src/index.ts:25-46`) exposes `todayWidgets` as slot plus React element. News and Sports declare a `brief` widget (`packages/news/src/web/index.tsx:14-26`, `packages/sports/src/web/index.tsx:15-27`). Future quick actions should use this seam and owning module metadata; Today must not import module internals.

`NewsTodayWidget` (`packages/news/src/web/today-widget.tsx:39-103`) shares the `/news` overview cache, caps at one lead plus three lines, uses supplied images, and renders nothing with no stories. `SportsTodayWidget` (`packages/sports/src/web/today-widget.tsx:24-175`) shares the `/sports` cache, polls only for live games, filters feedback-hidden stories, orders followed cards, and puts editorial lead/briefs before teams/leagues. These align with the approved compact editorial direction. `NewsDesk` is a legacy feed-shaped component and is unreachable from the production route unless a feed is supplied. Preserve module query/cache/feedback/disabled behavior while composing the new sections.

Wellness is already a rail quick action: `getMedicationSchedule` supplies counts; `MedToday` opens from Meds and can transition to `ManageMedsModal`; `CheckinModal` submits `createWellnessCheckin` and invalidates check-in/insight queries. `apps/web/src/wellness/wellness-today.tsx` includes keyboard-accessible medication rows and existing check-in states. The study's sample form is not an approved Wellness redesign.

## Query/data-flow details to preserve

The Today query keys are the shared cache boundary, not component-local constants: tasks and lists feed both task rows and `TaskDetailsDialog`; calendar feeds the main day list, next-event rail, and evening tomorrow preview; briefing definitions feed both Today mode and Briefings settings; run keys are definition-specific. A reader/review query should follow this pattern so a successful apply can invalidate the day schedule, task list, and relevant run without forcing unrelated module reloads.

`TodayPage` derives all day buckets with the persisted locale time zone. `todayEvents` filters `isToday` and sorts `byStart`; tomorrow events use `localDay`; due tasks use the same key; `upcoming` excludes already-ended events. New evidence labels, schedule changes, and earlier-run links must use the same zone instead of browser-ambient `Date` formatting.

Task completion waits for the server: `toggleMutation` calls `updateTask`, then invalidates after a 500ms delay. Action-row triage invalidates immediately on success. A review apply should leave Today unchanged until the mutation succeeds, preserve selected choices on error, and invalidate schedule/tasks/runs together on success so “accepted”, placement, and times cannot disagree.

The existing run DTO's `structuredPayload` is versioned and carries action rows/catch-up; `sourceMetadata` carries freshness. The new reader can render current prose immediately, but it cannot manufacture proposal placement, conflict identity, material contents, or change history from these fields. Those need an explicit shared response shape rather than UI-only state inferred from summary prose.

The production route currently renders News/Sports through build-time module contributions and renders legacy feed news only when a caller supplies `TodayFeed`. This is a real composition distinction: changing `NewsDesk` alone does not change the production News module widget, while changing `TodayPage` to hardcode module components would violate the module-web boundary.

The settings mutation creates a definition when absent, but throws when no read-only assistant tools are available (`settings-module-subviews.tsx:117-138`). A future “briefing unavailable” reader should distinguish that configuration error from a run not yet produced and from a source that is stale; a generic “not ready” branch would hide actionable remediation.

No client persistence exists for the approved review draft today. Task details and chat drafts are local component state, and the evening preview explicitly retains notes only in the tab. The morning product should make the same retention boundary explicit in implementation: preserve unsubmitted selections for dialog close/reopen if required, but do not claim server persistence until a route exists.

The shell's one ChatDrawer and one active surface are global. An embedded briefing conversation must use `ChatControls` or the existing drawer surface rather than mounting another SSE stream; if it needs a distinct context key, that key must be part of the existing `ChatSurface` contract and history boundary.

## Settings and public interfaces

`apps/web/src/settings/settings-module-subviews.tsx:85-230` loads briefing definitions, read-only assistant tools, source behaviors, and locale; finds morning/evening definitions; creates/updates definitions; and invalidates `queryKeys.briefings.definitions`. `briefing-settings-model.ts:9-101` provides definition lookup, default target times (07:00/19:00), time-zone defaults, source labels, and request shaping. Client calls are `listBriefingDefinitions`, `createBriefingDefinition`, `updateBriefingDefinition`, and `listBriefingRuns` (`apps/web/src/api/client.ts:997-1000,1340-1368`).

The frontend consumes shared `BriefingDefinitionDto`, `BriefingRunDto`, `BriefingActionRowDto`, `TaskDto`, `CalendarEventDto`, `LocaleSettingsDto`, and `WeatherTodayDto`. Briefings routes in `packages/briefings/src/manifest.ts:22-145` cover definitions, one-off run, and runs listing. Calendar has `calendar.briefings` and `calendar.planning` source behaviors (`packages/calendar/src/manifest.ts:100-168`), but planning is “coming-soon”. No current Today client exposes task-block proposal/acceptance; the scheduling/proposal API and action permissions must come from the owning backend slice.

No independent News/Sports morning inclusion preference exists in the current settings UI. News and Sports are user-toggleable modules with their own settings and `defaultEnabled` manifests, while the approved flow requires independent briefing opt-outs without disabling Today widgets. This likely needs a Briefings-owned preference contract and cache shared by settings and reader; never infer it from module enablement.

## Authored tokens and responsive/a11y constraints

`apps/web/src/styles/tokens.css` is authoritative for the checked-out build. This checkout is detached at `497cf0217`, before Park Press slice 1, so its source says warm oat/paper, Helvetica system stack, and `--font-display: var(--font-sans)`; it has no `apps/web/public/fonts/archivo/` directory. Git history shows `728642cd4` (2026-09-06, present on `origin/main`) adding Bone tokens (`--paper: #f2eee4`), four self-hosted Archivo weights under `/fonts/archivo/`, and `--font-display: "Archivo", var(--font-sans)`. That proves the Bone/Archivo implementation exists in the repository history, not that a target deployment serves it. Verify the deployed build through an authenticated browser: read `/api/me/themes` (`activeId`, `mode`, and custom palette), then inspect the post-`AppShell` `data-theme`/`data-color-mode` attributes, computed `--paper`/`--surface`/`--font-display`, `document.fonts.check(...)`, and the `/fonts/archivo/*.woff2` request status. Built-in dark mode maps the `dark` id to `data-theme="light"` plus `data-color-mode="dark"`; custom themes inject aesthetic variables and force light mode (`apps/web/src/shell/app-shell.tsx:253-274`, `apps/web/src/theme/theme-runtime.ts:84-109`). Live colors, active theme, and loaded font must be established from that running path before a briefing reader is judged against Bone/Archivo. Headings use `--font-display`; body/labels/data use `--font-sans` and tabular numerals; mono is retired except code blocks.

`Masthead`, `Card`, `AgendaRow`, `StatTile`, `WeatherChip`, and `Dialog` come from `@moss/ui`; visual rules are in `packages/ui/src/styles/components-moss-today.css` and related authored files. `kit-today.css`/`kit-today-feeds.css` are Today layout rules. New UI should use `jds-*` primitives, tokens, visible focus rings from `--focus-ring`, sentence-case authored empty/loading copy, and text status for stale/conflict/error states.

The full mobile treatment needs a breakpoint-specific full-screen dialog, expandable schedule, visible action footer, heading/tab semantics, Escape, focus return to the Today entry, and no trap when switching tabs. Test long task/source text and zoom; current `.loose-row__act` is non-wrapping and may need a review-specific mobile rule.

## Focused frontend slices and dependencies

These are implementation recommendations, not extra approved product design:

1. Add a focused Today reader beside `today-page.tsx`; keep `MorningBriefingSection` compact and add only an entry action. Consume run prose, freshness, evidence/material links, and the new review contract.
2. Add a review component/client at the owning frontend boundary for task id, proposed/current placement, accepted/proposed/unscheduled state, conflicts, and retry-safe apply. Reader and review tab must share one query/draft state so pending edits remain visible in both.
3. Reuse `TaskDetailsDialog`, `BriefTaskRow`, `AgendaRow`, and `jds-btn`; use a focused reader wrapper with the command-palette keyboard behavior. Treat the authored `Dialog` as layout/content only until Escape, focus trap, focus return, and full-screen mobile behavior are implemented. Keep TodayPage below the 1000-line maintainability threshold.
4. Add independent News/Sports briefing preferences only with a Briefings-owned contract; preserve module widgets and disabled-module filtering.
5. Reconcile prominent weather in `app-shell.tsx`/`header-weather.tsx` while preserving `/api/weather/today`, query key, locale, and settings; do not wire unused `TodayFeed.weather` without a real caller.
6. Compose News/Sports through `ModuleTodayWidgets`; add Tonight in the owning Sports contribution or a defined host slot, not as hardcoded imports in Today.
7. Keep Wellness actions/dialogs in their owning UI. The frontend depends on backend contracts for block proposals/apply/retry, conflict evidence, source/material references, earlier runs, and preferences.

## Open states: proposed reconciliations only

The approved design leaves quiet/empty days, unavailable/delayed briefings, missing sources, disabled modules, daytime conflicts, skipped evening conversations, earlier runs, and daytime changes open. These proposals are not approved UI decisions:

- Quiet day: keep masthead and “The day is clear”, show fixed commitments, collapse empty optional sections, and avoid zero-stat noise.
- Empty/loading: preserve warm authored copy and distinguish “not configured”, “waiting for a run”, and “source delayed”.
- Unavailable: keep schedule/review usable, show Try again, preserve choices, and never hide the day plan.
- Delayed source: reuse freshness UI, identify last update/affected source, and never claim unseen mail was reviewed.
- Disabled module: filter its widget and briefing contribution independently; one module must not fail the host.
- Daytime change: consider a compact “changed since morning” evidence row linking to the reader, with no automatic mutation until source/run identity exists.
- No evening plan: use calendar/tasks/deadlines without implying a conversation; offer prep only when the evening definition is enabled.
- Earlier runs: query through definitions/runs so ownership/sharing/RLS remains authoritative; do not create a browser-only archive.

## Verification patterns

Existing focused tests:

- `tests/unit/today-briefing-prose.test.tsx`: morning ordering, loading/empty/disabled, stale source, provider-gated Reply.
- `tests/unit/today-evening-mode.test.tsx`: local-time gate, run selection, ordering, clipping, persona-pending CTA.
- `tests/unit/today-briefing-action-rows.test.tsx`: joins, prompt safety, statuses, triage, provider gating.
- `tests/unit/news-today-widget.test.tsx` and Sports widget tests: no-content, cache, lead/list, feedback/live scores.
- `tests/e2e/briefing-action-rows.spec.ts` + `tests/e2e/mock-briefings-api.ts`: delayed run, ordering, controls, drawer/action request.
- `tests/uat/specs/1452-briefing-live-content.uat.spec.ts`: throwaway signup, real run, reload, rendered Today card.

No tests were run for this research-only turn. Future focused commands:

```text
pnpm exec vitest run tests/unit/today-briefing-prose.test.tsx tests/unit/today-evening-mode.test.tsx tests/unit/today-briefing-action-rows.test.tsx
pnpm exec vitest run tests/unit/news-today-widget.test.tsx
pnpm exec eslint apps/web/src/today/<touched-files>.tsx --max-warnings=0
pnpm check:design-tokens
pnpm format:check
```

Do not run `pnpm verify:foundation` or DB-touching commands without the verify-gate workflow. Before live verification, account for read-only issue #2296: an old dev watcher can leave `/api/onboarding/status` hanging and Today stuck at “Loading Moss”. Treat this as a runtime prerequisite/known overlap, not an automatic redesign fix. The live-path gate still requires owner signup through the real Settings/module path and the actual Today interaction with bounded DOM/network evidence.

## Plan handoff

Most Today plumbing is present: definitions/runs and local-day mode selection, freshness parsing, live action-row joins/triage, task details, global chat, generic module widgets, weather, and Wellness actions. The frontend gaps are the approved morning reader/review, task-block proposal/apply state, independent News/Sports briefing preferences, evidence/material links, earlier-run access, and unresolved page states. Keep new seams focused and contract-driven, preserve module ownership, and label remaining state decisions as proposals until explicitly approved.
