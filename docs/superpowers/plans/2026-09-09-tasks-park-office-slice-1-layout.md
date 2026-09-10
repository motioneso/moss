# Tasks Park Office, Slice 1: Layout and list index

**Goal:** The real Tasks page has the approved masthead and list index, with one shared filter state across desktop/mobile and List/Grid.

**Architecture / Tech Stack / Constraints:** Read the [shared plan](2026-09-09-tasks-park-office.md) and [spec](../specs/2026-09-09-tasks-park-office-design.md) first. This slice changes page composition and list navigation, not task rows, APIs, or theme defaults.

**Entry:** Shared readiness checklist complete. **Depends on:** no other implementation slice.

## Task 1: Establish the regression baseline

**Files:** Read `apps/web/src/tasks/tasks-page.tsx`, `task-view-model.ts`, `task-capture.tsx`, `apps/web/src/styles/kit-tasks.css`, `packages/ui/OPTIONS.md`; extend `tests/unit/web-task-view-model.test.ts` and `tests/e2e/tasks.spec.ts`. Extend `tests/e2e/mock-api.ts` only if required for fixtures already consumed by these tests.

- [ ] Record theme/font readiness and current row/capture measurements in the session handoff. If Bone work is missing, stop this implementation slice at the dependency, not at a Tasks-only color workaround.
- [ ] Run existing task unit/browser tests and record the baseline. Use two lists with distinct tasks, a subtask, suggested/done tasks, and long names/titles in browser fixtures.
- [ ] Add failing behavior assertions for direct index selection, All lists reset, retained selection across view switching, and desktop/mobile synchronization. Retain tests for multi-solo/excluded lists and count semantics; do not replace them with the mockup's simplified model.

## Task 2: Reuse filter state in the desktop index/mobile control

**Files:** Create `apps/web/src/tasks/task-list-navigation.tsx`; modify `tasks-page.tsx`, `tasks.css`, and focused tests.

**Interfaces:** Consumes actual task lists, `listStates`, `soloIds`, `listCounts`, `listCountTotal`, and parent callbacks for exclusive selection, cycle, and reset. Produces user intent only; owns no tasks/query/filter persistence. Extract the existing `ListFilterMenu` into this file so its behavior is reused rather than reimplemented.

- [ ] Add the primary All lists/single-list choices using native buttons with selected-state labels. Exclusive selection sets the existing state map to one solo ID; All lists resets only that map.
- [ ] Retain advanced include/solo/exclude and multi-solo access in List filters. Convey Only/Hidden/multiple-list state in text and accessible names. Do not make repeated primary clicks unexpectedly hide a list.
- [ ] Render the desktop index and compact mobile control from the same parent state. Hidden responsive controls must not remain keyboard-focusable. Preserve selection when resizing and when switching views.
- [ ] Reuse existing count output, expose its scope accessibly, and handle loading/failed list queries without invented names/counts. Long list names wrap or truncate with the full name accessible; many lists remain reachable by normal scrolling.
- [ ] Run the new tests and existing filter regressions. Verify quick capture still inherits exactly one solo list, with the existing fallback otherwise.

## Task 3: Compose Park Office's page header and working surface

**Files:** Modify `tasks-page.tsx`, `tasks.css`, and `apps/web/src/styles/kit-tasks.css` only where its current ownership requires it; modify `packages/tasks/src/manifest.ts`; extend `tests/e2e/tasks.spec.ts` and `tests/unit/app-map-build.test.ts` where appropriate.

- [ ] Add a semantic Tasks heading, forest-token masthead, decorative gold rule, and accurate open-task total. Count only accessible top-level todo tasks; do not render a load failure as zero.
- [ ] Move the existing segmented view switch into the masthead and label it List/Grid. Retain `priority`/`matrix` API values, pending guard, query invalidation, and persisted preference. Update old Matrix-label test selectors intentionally.
- [ ] Arrange index beside the surface, capture above filters, then active chips/results. Keep both existing view components functional. Preserve `?focus=` handling, search interpretation, tag controls, and status filters during the move.
- [ ] Scope layout to Tasks; handle reduced available width with the chat drawer open. At 320/375/768/1280/1440px check no horizontal overflow, readable heading, reachable controls, and a usable one-line input. Do not solve clipping with global overflow hiding.
- [ ] Update module app-map navigation/features for the index, compact control, and List/Grid labels without changing permissions/routes or duplicating core declarations. Only describe recovery controls actually implemented.
- [ ] Run shared baseline commands, scoped ESLint/Prettier checks for changed files, and relevant app-map unit tests. Record results and any pre-existing failures separately.

## Exit / handoff

- [ ] Both views work with direct list selection and the retained advanced menu; filters survive view/viewport changes.
- [ ] Layout matches the approved hierarchy in the canonical theme; no task spacing/domain behavior changed.
- [ ] Update the session handoff and task checkboxes. Stop here; priority-row polish belongs to slice 2. Do not merge this partial design.
