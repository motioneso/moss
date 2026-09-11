# Slice 6: Morning reader and task-block review

**Goal:** Ship the approved readable execution brief, source evidence, News/Sports prose, and direct
bulk/partial block acceptance. **Dependencies:** slices 2–5.

Read the [approved morning flow](../specs/2026-09-10-morning-briefing-flow.md) and shared plan.

## Files

Existing: `apps/web/src/today/today-page.tsx`, `briefing-freshness.tsx`,
`apps/web/src/api/client.ts`, shared query keys, `packages/shared/src/app-map-core.ts`;
Briefings/Calendar owning manifests. Proposed focused new components:
`apps/web/src/today/morning-briefing.tsx`, `day-plan-review.tsx`, `briefing-dialog.tsx`,
`day-plan-client.ts` (only if existing API client split conventions call for it).
Proposed tests: `tests/unit/morning-briefing.test.tsx`, `day-plan-review.test.tsx`,
`tests/e2e/today-briefings.spec.ts`; extend existing briefing API mocks.

## Task 1: Reader and evidence

- [ ] Compose the real run prose and structured source/plan projection. Show saved evening intent,
      overnight changes and why they affect the day, material links, relevant travel/weather, and enabled
      News/Sports prose/photos. Never recreate prose from fixed example strings or infer action payloads.
- [ ] Reuse freshness parsing and opaque source/material navigation. Display provenance/changed
      calendar evidence on demand; handle source/entity permission loss without leaking cached content.
- [ ] Provide News/Sports jump links and fuller coverage navigation, preserving their independent
      inclusion preferences and module-disabled precedence. A no-photo story remains readable.
- [ ] Distinguish absent configuration, pending run, failed run and delayed source. Retry uses the
      owning refresh/run path; the schedule remains usable where current source data permits.
- [ ] Provide access to dated earlier runs through existing APIs. Keep old reports read-only; do not
      let an archived action apply against its stale embedded plan revision.

## Task 2: Accessible shared briefing shell

- [ ] Implement one focused full-screen-mobile/desktop briefing wrapper using authored dialog
      styling. Existing shared `Dialog` is not accessibility-complete; reuse the Command Palette's
      Escape/focus-trap/return-focus pattern or a native dialog styled with existing primitives.
- [ ] Cover initial focus, named dialog, inert background/focus containment, Escape, explicit close,
      focus restoration after Today rerenders, scroll behavior, and an always-visible action footer.
      Avoid upgrading every unrelated shared Dialog consumer as a side effect of this task.
- [ ] The schedule is alongside reading/review on desktop and expandable on phone. Reading shows
      persisted state; review clearly shows unsaved additions/moves/removals and any intervening changes.

## Task 3: Plan review and bulk action

- [ ] Share one revision-aware draft between reader/review tabs. Close/reopen retains incomplete
      choices. A refreshed run does not erase the draft; stale plan revision produces a reviewable diff.
- [ ] Allow per-block time and placement changes: add to calendar, keep proposed, leave unscheduled;
      existing committed blocks retain actual placement until move/removal succeeds. Show the deadline
      consequence when a due task is left without time.
- [ ] Direct “Accept all time blocks” accepts eligible proposals in one activation and keeps the
      reader open on success. Retain individual review and exclude explicitly unscheduled/committed
      blocks. If other pending edits exist, show Review changes instead of silently applying them.
- [ ] A reviewed move/removal set requires one additional explicit destructive confirmation through
      the existing action policy flow before any batch effect when current policy requires it. Name the events and clarify that their
      tasks remain. Submit its bound approval with the reviewed batch; missing/stale approval retains
      the review and applies nothing. Accept All is for proposed additions and cannot authorize removal.
- [ ] Use preview/application endpoints and operation keys from slice 2. Disable impossible local
      choices for clarity, but server preflight/version/policy checks remain authoritative.
- [ ] Show per-item partial/pending/failed effects accurately. Retain unresolved choices and retry
      only those items. Never display “nothing changed” if some provider writes succeeded.
- [ ] After acknowledgement, update/invalidate current plan, calendar, task and relevant run queries
      so Today, preparation, materials and task scheduling context agree. Preserve module query caches.
- [ ] Automatic mode starts from actual committed blocks and has no extra acceptance prerequisite.
      A policy/settings change does not silently reclassify saved proposals or existing scheduled events.
- [ ] Keep all acceptance logic in the common review/action controller; don't implement separate
      per-item, bulk, and Ask Moss calendar paths with different validation.

## Verification and stop

- [ ] Unit/mock tests: readable source states, default-on/off editorial sections, materials, no evening
      intent, photo failures, bulk and partial acceptance, explicit unscheduling, pending edits, stale
      revisions, conflicts, provider partial success, retry/idempotency, settings changes and reload.
- [ ] Browser: one-click accept-all stays in reader; individual apply returns to current Today;
      updated times appear in details/materials; dialogs preserve focus; disabled modules make no source
      requests; responsive/footer checks with long content at 320/375/768/1440 and 200% zoom.
- [ ] Run scoped static checks and existing Today/action-row regressions. Keep mock evidence distinct
      from the real-path proof required in slice 8.

Session checkpoints: reader/evidence; accessible shell; selection/apply/recovery and integration.
Stop with a functioning morning flow against actual plan APIs, not simulated acceptance state.
