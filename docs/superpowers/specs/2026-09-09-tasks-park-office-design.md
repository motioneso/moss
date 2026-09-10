# Tasks: Park Office with Field Guide's list index

**Status:** Visual direction approved by Ben in chat on September 9, 2026. This document records that approval; the implementation plan and the code-level reconciliations below are proposed, not yet executed.

**Plan:** [Implementation plan](../plans/2026-09-09-tasks-park-office.md).

**Tracking:** [Task #2450](https://github.com/motioneso/moss/issues/2450).

## Goal

Tasks is where the user captures everything they need to do so they do not forget it, then quickly acts on what needs attention. Make that existing workflow feel finished and unmistakably Moss: a respectful national parks homage through typography, signage, color, and organization.

## Approved visual reference

Ben chose Park Office, then asked to combine it with Field Guide's list index. The combined preview received: "Yep that looks awesome."

Design-reference crops, saved with this spec so review does not depend on a running preview server:

- [Desktop priority list](assets/2026-09-09-tasks-park-office/desktop-list.png)
- [Desktop grid](assets/2026-09-09-tasks-park-office/desktop-grid.png)
- [Mobile priority list](assets/2026-09-09-tasks-park-office/mobile-list.png)

These show the upper content region, not entire pages. They are visual references, **not live-path verification evidence**. The interactive study remains at `~/Jarv1s/.superpowers/brainstorm/tasks-parks-20260909/`; direction A is the combined version. Its sample data, fixed date, simplified fields, and in-memory behavior must never become production logic.

## Locked decisions

- Bone replaces Oat for this direction. The inspected light-theme reference was `#f2eee4`; production uses the canonical theme tokens, not literal colors in Tasks CSS.
- Park Office's forest masthead, Bone title, thin decorative gold rule, and pale sage priority headers remain.
- Field Guide's quiet list index sits beside the working surface on desktop in **both** views. It becomes a compact list control on mobile.
- Keep current comfortable task-row spacing. No density redesign and no oversized capture card.
- Quick capture is one line: type a title and press Enter. No other field is required. Details remains optional and carries the draft title forward.
- Keep all existing Details capabilities, including notes/description, assignment as currently supported, list, priority, due date, reminder, effort, repeats and repeat-until, tags, subtasks, status actions, and activity/comments.
- Keep both priority list and importance/urgency grid, with the selected list/filter state retained across view switches.
- Use confident Swiss sans-serif typography and functional park-signage organization. No landscapes, park-service seals, faux official branding, heavy frames, patina, serif/mono headings, mascots, or wellness softness.
- Today, the global shell, other pages, and global theme redesign are not part of this implementation.

## Production reconciliation

The mockup establishes appearance, not a replacement domain model. These implementation choices preserve capabilities omitted from the preview.

### Lists and counts

- `TasksPage` remains the single owner of `listStates`. Reuse `deriveTaskFilters`; do not add a second filtering system for the index or grid.
- Proposed primary index behavior: clicking a list focuses that list exclusively (`{ [id]: "solo" }`); clicking All lists resets list states only. Clicking the already-selected list does not hide it.
- Preserve the current include/solo/exclude and multi-solo behavior in a secondary **List filters** menu, available on desktop and mobile. Reuse the existing menu logic. Do not silently reduce the production app to single-list selection.
- The mobile compact control offers the same primary All lists/single-list choices and access to List filters. It must represent multi-list/hidden-list states honestly, not claim a single list is selected.
- Status, tags, literal search, interpreted search, and Today `?focus=` links continue to compose with list selection. Switching List/Grid or viewport width clears none of these. No new persistence across reload is promised for filters.
- Index counts retain current semantics: top-level tasks matching status/focus and selected tags, before list selection, text search, and interpreted-search filtering. Include concise accessible explanatory text; never present these as search-result counts.
- Any masthead total is explicitly **open tasks**, meaning top-level `todo` tasks from the accessible loaded task collection, independent of filters. Hide or show a loading mark until tasks load; a query failure is not zero tasks. Visible result counts are separate.
- A new task defaults to the sole focused list where available; otherwise preserve the existing creation fallback. Do not introduce a guessed list ID or change list ownership.

### Views, rows, and details

- The visible switch is **List / Grid**, matching the approved preview. Keep persisted API values `priority` / `matrix`; no schema or preference migration.
- Priority ordering remains Critical, High, Medium, Low, Someday, No priority; due date then title within groups. Null priority remains null, not the preview's numeric zero.
- Reuse `QUADRANTS`, `quadrantOf`, and `groupTasksByQuadrant`: Do First, Schedule, Delegate, Later. Important is priority at least 4; urgent is due within 48 hours, including overdue. Keep the internal `eliminate` key and existing date/timezone behavior.
- Reuse `TaskRow`, completion, edit, and suggested-task review handlers. Retain provenance, effort, due/drift signals, tags, and subtasks wherever the existing view shows them. Compact grid metadata need not be expanded to mirror the simplified mockup.
- Keep the existing Details dialog and its create/edit semantics. This is not a new form model or a replacement dialog project.
- Gold is decorative, amber conveys ordinary drift, and red is reserved for true errors/destructive actions. Labels and state cannot rely on color alone.

### Layout and accessibility

- Order: masthead; desktop index beside task surface; compact capture; tools/active-filter chips; collection context; task groups/grid. Dialog is outside this layout.
- Start from the preview's 160px index / 32px gap on wide screens, reducing to 130px / 24px at narrower desktop widths. Use layout tokens where available. Collapse based on usable content width, including when the app's chat drawer is open; do not hide overflow to disguise clipping.
- Narrow screens use one grid column, long titles wrap, and Details/Add remain reachable without expanding the capture into a form. Retain accessible names when action text is visually abbreviated.
- Native buttons with pressed-state semantics for list choices; labeled navigation/complementary region; semantic headings for priority groups and quadrants. Do not advertise an ARIA interactive grid unless the required keyboard model exists.
- Keyboard navigation, visible focus, menu Escape/outside-click handling, dialog focus return, readable contrast, reduced motion, and 200% zoom are acceptance criteria.

## Empty, loading, and failure states

- Loading: keep the masthead/capture layout stable and use the authored `EmptyState` loading treatment; no fake task counts.
- Empty account: "No tasks yet" with quick capture still available.
- Empty filtered result, including literal search alone: "No tasks match" with an actionable way to clear applicable filters. Reset list selection separately from clearing all filters.
- An empty quadrant keeps its heading/count and a quiet "Nothing here right now" message.
- Task/list/preference fetch failures are explicit, with a retry or continued usable fallback. Never show an error as an empty success.
- Create failure keeps the draft and supports retry; view-save failure retains the last persisted view and reports the failure. Completion/review failure must not leave a false success state.
- Preserve existing Details error handling and avoid a second capture form or duplicate mutations.

## Theme readiness

At planning time, this checkout's `apps/web/src/styles/tokens.css` still declares Oat defaults and a Helvetica-based `--font-display`; neither Bone nor Archivo was found in the inspected web/shared/UI sources. The earlier live preview used Bone and Archivo. Runtime aesthetic themes can override colors via `apps/web/src/theme/theme-runtime.ts`.

Before implementation, identify the already-approved Bone/font work and the correct implementation base or theme configuration. Record the source and computed tokens. Do not silently port the mockup's downloaded font, change global theme defaults, or hardcode a Tasks-only palette to bridge the discrepancy. If the approved work is unavailable, report that dependency and agree its ownership before expanding scope. The visual target remains Bone, not Oat.

## Non-goals and completion

No new task API, database migration, list CRUD, drag-and-drop, bulk action system, font dependency, illustration, additional view, task scheduling model, or design-system rewrite. Shared data/RLS behavior remains unchanged.

Done requires the approved visual hierarchy, intact existing task capabilities, responsive and accessibility checks, truthful Tasks app-map metadata, and executable live-dev evidence recorded on the PR. Mockup checks and mocked browser tests alone are insufficient.
