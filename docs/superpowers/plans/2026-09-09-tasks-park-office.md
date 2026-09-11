# Tasks Park Office Implementation Plan

> **For the implementing agent:** Work through one session-sized slice at a time using the checkbox steps. Read the spec and this shared header before the slice. No design-skill workflow or delegation is prescribed: Ben requested direct design collaboration. Preserve repository safety and verification rules.

**Goal:** Ship the approved Park Office Tasks design with Field Guide's list index, while preserving fast title-only capture, optional full Details, comfortable rows, and both task views.

**Architecture:** A presentation-led update to the existing React Tasks page. `TasksPage` continues to own queries, filters, and mutations. A small task-local list-navigation component projects the existing filter state into a desktop index/mobile control; existing view-model helpers, rows, capture, and dialog remain authoritative. No API, database, or preference-schema changes.

**Tech Stack:** TypeScript, React, React Router, TanStack Query, `@moss/shared`, `@moss/ui`/`jds-*`, existing Tasks kit CSS and canonical theme tokens, Vitest, Playwright.

**Spec:** [Approved direction and production reconciliation](../specs/2026-09-09-tasks-park-office-design.md).

**Status:** Plan prepared; implementation not started. Visual direction approved. Production reconciliations and this slicing await plan review. No tests in this plan have been claimed as executed against the real app.

**Tracking:** [Task #2450](https://github.com/motioneso/moss/issues/2450), on project 2, Issue and Roadmap Work. Planning documents and approved reference images are preserved on `docs/2450-tasks-park-office-plan`; this is a documentation branch, not an implementation PR. Implementation branch/worktree/PR remain to be established. All implementation slices belong to one feature branch, one worktree, and one PR; do not ship partially styled views independently.

## Session map

| Slice                                                                                    | Deliverable                                                                   | Dependency          | Session boundary                                                |
| ---------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------- | ------------------- | --------------------------------------------------------------- |
| [1: Layout and list index](2026-09-09-tasks-park-office-slice-1-layout.md)               | Masthead, shared desktop/mobile list navigation, existing views still working | Readiness checklist | Stop when selection and view persistence checks pass            |
| [2: Capture and priority list](2026-09-09-tasks-park-office-slice-2-priority.md)         | Compact capture and finished priority hierarchy with full Details retained    | Slice 1             | Stop when capture/details/priority regressions pass             |
| [3: Grid and page states](2026-09-09-tasks-park-office-slice-3-grid.md)                  | Matching four-quadrant design, responsive and failure-state parity            | Slice 2             | Stop when both views and state matrix pass                      |
| [4: Live verification and release](2026-09-09-tasks-park-office-slice-4-verification.md) | Executable live-path proof, static/CI gates, truthful handoff                 | Slice 3             | Stop at release-ready PR; merging requires the normal authority |

Each slice is one focused session, not an invitation to fill the context window. If a prerequisite changes ownership or requires backend/theme work, record it and split that dependency rather than absorbing it. Slice 4 is a real session budget for verification, not assumed-free cleanup.

## Global constraints

- Follow `CLAUDE.md` and `docs/DEVELOPMENT_STANDARDS.md`. Preserve unrelated dirty files. No branch switching, bulk staging, or destructive cleanup in the shared checkout.
- Keep all aesthetic values in canonical tokens; extend existing authored controls. Local Tasks CSS may compose layout and scoped treatments, not introduce a parallel design system.
- Bone is the approved target. Confirm the recent theme/font work before coding; this checkout still has older defaults. Do not broaden this feature into a global palette or typography migration.
- Preserve multi-list include/solo/exclude filtering through the secondary menu, all current search/tag/focus semantics, status actions, persisted view preference, and Details capabilities. The spec defines the new primary single-list shortcut.
- Production sorting/classification comes from shared helpers, never from `mockups.js`. No fixed example dates, sample identities, counts, or decorative preview controls ship.
- Update `packages/tasks/src/manifest.ts` navigation/features/errors/remediations in the same PR. Tasks is module-owned; do not add a duplicate `/tasks` declaration to `app-map-core.ts`.
- Keep Tasks-only styles scoped. `TaskRow`, kit classes, and any modified shared tokens require checking other consumers before editing.
- No dependency installs, API rewrites, migrations, database access, or deployments are part of this planning work. Ben separately authorized creating the tracking issue and committing/publishing these planning artifacts; that does not authorize implementation or merge.
- During implementation, DB-touching commands, the full foundation gate, and UAT provisioning must use the repository's protected verification procedure. Never run an unscoped foundation gate against live dev. Static and mocked tests do not prove the live path.
- Live-path evidence is assertions and bounded DOM/network/log text, not screenshots. Spec images are design references only.

## Readiness checklist

- [ ] Ben has reviewed the plan's production reconciliations, particularly retaining advanced list filtering alongside the new index.
- [ ] Link an approved design spec and GitHub task on project 2; record one branch/worktree/PR for all slices.
- [ ] Reconcile the current checkout with the existing Bone/font work. Record canonical token/font source and computed light/dark values in the handoff; do not change branches in a shared checkout.
- [ ] Confirm the available host primitives in `packages/ui/OPTIONS.md` and actual Tasks kit ownership; recheck source drift before edits.
- [ ] Record the existing row spacing, capture behavior, and Details field/action inventory as the regression baseline.

## Grounded seams and file ownership

Graph lookup failed with `Transport closed` during planning; the following seams were checked directly in source. Recheck before implementation if the base changes.

| Responsibility                                   | Existing source                                                                                       | Planned treatment                                                                              |
| ------------------------------------------------ | ----------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------- |
| Page queries, filter state, preferences, dialogs | `apps/web/src/tasks/tasks-page.tsx`                                                                   | Retain ownership; rearrange presentation; move list menu out only with the new list navigation |
| Include/solo/exclude, counts, focus, search      | `apps/web/src/tasks/task-view-model.ts`                                                               | Reuse `deriveTaskFilters`; no duplicate state or new filtering pipeline                        |
| Priority groups and row actions/metadata         | `apps/web/src/tasks/task-list-view.tsx`                                                               | Style existing panels/rows, preserving compact/full behavior                                   |
| Matrix grouping and shared rows                  | `apps/web/src/tasks/task-matrix-view.tsx`                                                             | Reuse `TaskRow`, shared quadrant metadata and grouping                                         |
| Title-only creation                              | `apps/web/src/tasks/task-capture.tsx`                                                                 | Keep current mutation, pending/error behavior and default list                                 |
| Details and field sections                       | `apps/web/src/tasks/task-details-dialog.tsx`, `task-details-sections.tsx`, `task-details-model.ts`    | Preserve; narrow fixes only for demonstrated integration regressions                           |
| Task visual styles                               | `apps/web/src/tasks/tasks.css`, `apps/web/src/styles/kit-tasks.css`                                   | Scoped authored layout/treatments; leave modal kit alone unless required                       |
| Domain ordering/classification                   | `packages/shared/src/tasks-view.ts`                                                                   | Read-only dependency; values/rules unchanged                                                   |
| App-map ownership                                | `packages/tasks/src/manifest.ts`                                                                      | Update module navigation/feature descriptions and applicable recovery metadata                 |
| Tests                                            | `tests/unit/web-task-view-model.test.ts`, `web-task-details-model.test.ts`, `tests/e2e/tasks.spec.ts` | Extend existing focused suites and mocked browser fixtures                                     |

Proposed new implementation files: `apps/web/src/tasks/task-list-navigation.tsx` (one cohesive component plus the extracted existing menu), and `tests/uat/specs/tasks-park-office.uat.spec.ts` (live proof). Avoid creating a generic navigation framework, page-state manager, or separate mobile filter model.

## Verification strategy

Start behavior changes with focused assertions that fail before the change, then implement and rerun. For visual-only changes, record measured layout/contrast/semantic assertions and review against the approved reference rather than manufacturing a meaningless failing snapshot.

Database-free baseline commands from `~/Jarv1s`:

```bash
pnpm exec vitest run tests/unit/web-task-view-model.test.ts tests/unit/web-task-details-model.test.ts
pnpm exec playwright test tests/e2e/tasks.spec.ts --project=chromium
pnpm check:design-tokens
pnpm check:ui-classes
pnpm check:file-size
pnpm typecheck
```

Use the existing `mockApi` browser fixtures; intercept any added endpoints so these tests never fall through to real task mutations. The current Playwright configuration serves local Vite on port 4173. The full repo release checks and live UAT are specified in slice 4 and are not run as part of writing this plan.

## Session handoff contract

At each stop, check off only verified steps and update a small `docs/handoffs/2026-09-09-tasks-park-office.md` with: slice status, branch/worktree/issue/PR, exact changed files, commands and exit codes, remaining failures, theme readiness, and the next unchecked task. Use `~/Jarv1s` paths. GitHub remains the source of truth for implementation status once tracking exists.

Do not mark the feature Done until all four slices pass. If code is complete but live proof is unavailable, report **code-complete, unverified**.
