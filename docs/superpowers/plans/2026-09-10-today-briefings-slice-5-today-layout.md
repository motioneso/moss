# Slice 5: Today composition, weather, and module placement

**Goal:** Implement the approved Today layout using real queries and authored components while
preserving existing task, action-row, chat, module, and Wellness functionality.
**Dependencies:** slice 1 read contract; slice 3 owning widgets; readiness theme/state reconciliation.

Read the [shared plan](2026-09-10-today-briefings.md) and
[frontend exploration](../../research/2026-09-10-today-briefings-frontend-exploration.md).

## Files

`apps/web/src/today/today-page.tsx`, `evening-mode.tsx`, `module-today-widgets.tsx`,
`header-weather.tsx`, `briefing-freshness.tsx`, `briefing-action-rows.tsx`;
`apps/web/src/shell/app-shell.tsx`; existing Today kit CSS;
`packages/module-web-sdk/src/index.ts`; `packages/shared/src/app-map-core.ts`.
Proposed focused files: `apps/web/src/today/day-plan.tsx`, `today-quick-actions.tsx` and a small
`day-plan-view-model.ts` only if transformation logic warrants independent verification.
Reuse existing API clients/query keys and `TaskDetailsDialog`, `MedToday`, `ManageMedsModal`,
`CheckinModal`, `Masthead`, `AgendaRow`, and existing authored button/section styles.

## Task 1: Reconcile theme and implement the complete day

- [ ] Use a candidate based on current main. Theme work `728642cd4` already adds Bone and Archivo
      on `origin/main`; this older detached checkout's Oat/Helvetica does not justify rebuilding them.
      Inspect the authenticated active theme/computed variables/fonts on the eventual live target.
- [ ] Adapt masthead assessment, schedule/preparation grid, evening recap/tomorrow, and section
      index to the approved references. Keep the full plan before News/Sports in DOM and reading order.
- [ ] Render fixed events and linked task blocks from actual plan/query data, distinguishing
      proposed, committed, unscheduled, completed and pending-effect states with text as well as color.
      Preserve explicit preparation and travel information; do not fabricate a complete schedule.
- [ ] Join stable task/calendar IDs to existing details/navigation; preserve existing email action
      rows, Reply gating/opaque references, suggested-task triage, goals and proactive capabilities.
      Choose appropriate existing expandable/secondary placement instead of silently deleting them.
- [ ] Preserve persisted locale, local-day run selection, countdown and evening-switch timers.
      Run freshness and task truth outrank an old generated narrative when state changes.
- [ ] Add reader/review entry points that connect to actual contracts in slices 6–7. Until those
      land in the feature branch, keep existing functioning entry paths; do not ship dead controls.

## Task 2: Weather and quick actions

- [ ] Reuse the shell's `queryKeys.weather.today` cache and `HeaderWeather`/`WeatherChip` data. Move
      or share presentation into the approved prominent Today row without duplicate weather polling.
- [ ] Preserve five-day forecast access and current unit/location settings. Show current conditions
      and high/low prominently; use the source-owned unavailable/loading/freshness behavior from slice 3.
- [ ] Extract only Today Wellness composition into `today-quick-actions.tsx`; keep full existing
      medication schedule/log/manage and rich check-in dialogs and their invalidation/permission paths.
- [ ] Quick actions sit beside the schedule on desktop and before it on phones. Check more than one
      contribution and retain the owning module's deeper entry path and pending/error state.
- [ ] Use existing widget `slot` metadata with a small optional filter in `ModuleTodayWidgets` to
      place editorial `brief` contributions below the plan and future quick actions in the dock. Preserve
      default rendering for callers that do not request a slot. Avoid mounting the same contribution twice.
- [ ] Filter inactive modules before lazy import/query mounting. Give module failure a local recovery
      surface, not a Today-wide error. Keep News/Sports implementation inside their public `./web` modules.

## Task 3: State and accessibility parity

- [ ] Implement the reviewed quiet/loading/source-gap/disabled/earlier-run/daytime reconciliations
      from the behavior matrix. If any new screen's treatment has not been reviewed, preserve a concrete
      reference before that UI is built; do not mark the original mockup as approving an unseen screen.
- [ ] Test keyboard reading order, long labels, 200% zoom, 320–1440 layouts, status announcements and
      visible primary controls. Keep CSS scoped to Today and canonical tokens.
- [ ] Keep `TodayPage` orchestration focused and below the repository's file-size threshold. Do not
      add a new generic dashboard engine, parallel module registry, or global frontend store.
- [ ] Update Today core app-map description/actions/errors and relevant module metadata in the same
      product PR. Do not duplicate module-owned routes under core.

## Verification and stop

- [ ] Extend existing `today-briefing-prose`, `today-evening-mode`, `today-briefing-action-rows`,
      module-widget and weather/Wellness tests with real query-mocked data and disable/failure states.
- [ ] Extend `tests/e2e/briefing-action-rows.spec.ts` and mock API wiring to ensure retained action
      rows/Reply/details remain reachable. Intercept all new endpoints; no live mutation fallthrough.
- [ ] Run scoped lint/format, root/test-aware type checks, `pnpm check:design-tokens`,
      `pnpm check:ui-classes`, and file-size checks. Review against preserved approved references.

Session checkpoints: day-plan composition; weather/quick actions/slots; state/a11y regression.
Stop with the complete real-data layout and retained features. Full morning/evening dialogs depend
on the next slices; live release proof is still outstanding.
