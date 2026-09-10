# Tasks Park Office, Slice 3: Grid and page states

**Goal:** Finish the grid and make both views coherent when empty, loading, filtered, failing, or constrained in width.

**Architecture / Tech Stack / Constraints:** Read the [shared plan](2026-09-09-tasks-park-office.md) and [spec](../specs/2026-09-09-tasks-park-office-design.md). Use existing grouping, queries, mutations, and authored state primitives; no new task logic.

**Entry / dependency:** Slice 2 verified; layout and list navigation remain shared.

## Task 1: Four-quadrant Park Office grid

**Files:** Modify `apps/web/src/tasks/task-matrix-view.tsx`, scoped `tasks.css`/`kit-tasks.css`; extend `tests/e2e/tasks.spec.ts` and `tests/unit/web-task-view-model.test.ts`. Read-only: `packages/shared/src/tasks-view.ts`.

- [ ] Add deterministic fixtures with a controlled clock covering priority 3/4, due inside/at/outside 48 hours, overdue, and no due date. Assert existing shared quadrant rules, not the mockup's fixed-day approximation.
- [ ] Apply the approved forest Do First header and quiet sage sibling headers, strong sans-serif headings, counts, and ruled task surfaces. Reuse shared quadrant titles/subtitles and compact `TaskRow`.
- [ ] Keep the index in desktop grid mode. Both views consume the same filtered tasks; sorting/classification and persisted `matrix` value are unchanged.
- [ ] Use semantic labeled sections/headings instead of an incomplete interactive-grid ARIA model. Preserve completion and opening Details. Suggested review must remain reachable; reuse existing handlers if presenting review controls in grid rather than inventing another mutation path.
- [ ] Keep empty quadrants visible with zero and quiet copy; stack to one column on narrow screens. Verify long text cannot push a quadrant or capture controls outside the viewport.

## Task 2: Honest loading, empty, and failure states

**Files:** Modify `tasks-page.tsx`, `task-list-view.tsx` only where false optimistic completion is demonstrated, and local Tasks styles; extend `tests/e2e/tasks.spec.ts` with intercepted failures. Update `packages/tasks/src/manifest.ts` errors/remediations to match actual recovery controls.

- [ ] Add failing assertions for task/list/preference fetch errors, filtered-empty literal search, create/view-save/update failure, and retry recovery. Mock network responses; never test failures by disrupting live services.
- [ ] Keep stable masthead/capture and authored loading/empty treatments. Distinguish an empty account, filtered-empty results, and failed fetch. Include literal search when deciding whether a result is filtered.
- [ ] Provide actionable retry/clear controls. Preserve drafts and unrelated filters; unavailable list data must not invent a default list. Show a persisted-view save failure without pretending the preference changed.
- [ ] Verify failed completion/review returns to honest task state. If fixing `TaskRow` optimistic state, do so once at the existing shared row/mutation seam and check both consumers; no separate grid-only fix.
- [ ] Preserve available content during background refresh failures where safe, while exposing the failure. Keep true errors distinct from amber overdue/drift styling.

## Task 3: Responsive, theme, and accessibility acceptance

**Files:** Extend existing `tests/e2e/tasks.spec.ts`; adjust local styles and affected markup only. No theme migration or new accessibility dependency.

- [ ] Check List/Grid at 320, 375, 414, 768, 1280, and 1440px, including the app's open chat drawer and 200% zoom. Check local element bounds, not just document width.
- [ ] Check Bone light theme, supported dark mode, and one existing custom theme for readable text/focus/selection and no literal-color leakage. Compare composition to the approved design; a readable but materially different Oat fallback is not a match.
- [ ] Exercise keyboard-only list selection, advanced menu, search, capture, row actions, and Details; verify Escape/focus return, accessible names, heading structure, and non-color state cues. Respect reduced motion.
- [ ] Run shared baseline checks, targeted app-map tests, scoped lint/format, and token/contrast tests where applicable. Ensure no preview-only text, hardcoded identity/date/count, comparison switcher, or demo asset ships.

## Exit / handoff

- [ ] Both views, filters, capture, Details, and state matrix pass at the required widths/themes.
- [ ] App-map recovery descriptions match visible controls. Any regression is fixed or explicitly recorded as blocking.
- [ ] Record code-complete status and the exact remaining live checks. Stop here; do not call the feature Done until slice 4 proves the assembled path.
