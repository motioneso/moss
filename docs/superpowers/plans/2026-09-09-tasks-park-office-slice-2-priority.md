# Tasks Park Office, Slice 2: Capture and priority list

**Goal:** Finish the priority view while keeping single-title capture fast and all current Details options intact.

**Architecture / Tech Stack / Constraints:** Read the [shared plan](2026-09-09-tasks-park-office.md) and [spec](../specs/2026-09-09-tasks-park-office-design.md). Extend current capture/panels/rows; do not introduce a new form or row model.

**Entry / dependency:** Slice 1 checked and handed off on the same branch/worktree.

## Task 1: Compact capture, with safe pending and error behavior

**Files:** Modify `apps/web/src/tasks/task-capture.tsx` and scoped `tasks.css`/`kit-tasks.css`; extend `tests/e2e/tasks.spec.ts` and mock fixtures only as needed. Read `task-details-dialog.tsx`, `task-details-sections.tsx`, and `task-details-model.ts` for parity.

- [ ] Add browser assertions for title-only Enter submission, whitespace rejection, selected-list default, one request while pending, and failed creation retaining the draft. Run and identify genuine pre-existing failures versus redesign failures.
- [ ] Apply the approved compact field/Details/Add treatment using current Button/input conventions. Keep only title required. Do not expand the writing area into a notes panel or inline metadata form.
- [ ] Carry the draft title and correct list into Details. Preserve all existing fields, create/edit differences, tag assignment, subtasks, recurrence/end date, status actions, comments/activity, and timezone-aware inputs. Reuse the real dialog; do not copy the preview's form.
- [ ] Prevent duplicate in-flight capture at the submit handler if the pending button guard alone is insufficient. Successful creation clears the field and leaves it ready for the next task; failure keeps the text with a visible retryable error.
- [ ] Exercise title-only capture in List and Grid, narrow viewport capture, Escape and focus return from Details, and submit with optional metadata. Confirm no draft is silently lost during view/layout changes.

## Task 2: Park Office priority sections and row polish

**Files:** Modify `apps/web/src/tasks/task-list-view.tsx`, scoped `tasks.css`/`kit-tasks.css`; extend `tests/e2e/tasks.spec.ts`. Read-only: `packages/shared/src/tasks-view.ts`.

**Interfaces:** Keep `TaskListView`/`TaskRow` inputs and callbacks. Reuse `groupByPriority`, `listColorMap`, date formatting, effort/provenance rendering, completion, and suggested-task review.

- [ ] Add assertions for all priority levels including null, empty-group omission, due-date/title ordering, metadata, completion/reopen, and accept/dismiss for suggested tasks.
- [ ] Replace panel-heavy styling with pale sage section headings, firm rules, restrained counts, and readable row metadata. Use semantic group headings; keep row padding, check targets, and comfortable line height from the baseline.
- [ ] Retain user-owned priority and separate amber drift/due signals, source attribution, tags, effort, and subtask indicators. Do not lose information merely because it was absent in the simplified mockup.
- [ ] Check every `TaskRow` consumer before editing shared row styles. Keep compact grid rows usable while their full treatment waits for slice 3.
- [ ] Exercise long titles, many tags, missing dates/priorities, shared-list labels, and empty/nonempty collections. Avoid hover-only essential actions and preserve keyboard-operable completion/open controls.
- [ ] Run shared unit/browser/static checks plus scoped lint/format. Re-run the existing Details select-wrapper and tag-assignment regressions.

## Exit / handoff

- [ ] Priority view matches the approved Park Office composition without shrinking or inflating task density.
- [ ] Title-only creation, complete/reopen, suggested review, and the full Details workflow pass; grid behavior has not regressed.
- [ ] Record measured spacing, tested optional fields/actions, commands/exit codes, and remaining checks in the handoff. Stop here; no backend or dialog redesign is pulled into this slice.
