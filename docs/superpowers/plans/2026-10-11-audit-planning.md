# Planning journey audit repairs

Date: 2026-10-11. Baseline: `58402589d9fc0f53417553139e4e3de430f26668`.

This lane implements the approved bounded planning repairs from the Moss user experience audit.
Tracking: [task #3397](https://github.com/motioneso/moss/issues/3397). The approved umbrella plan
is committed as `f0a11eec9`; the coordinator confirmed this prerequisite before product edits.
Tests may first establish the failures against the unchanged baseline.

## Scope and ownership

- PLAN-01: Preserve the Goals route's existing array response and align its web client boundary;
  exercise the actual route schema, serialization, client and Today component together. The
  coordinator owns the client and any shared contract or manifest changes.
- PLAN-02: Preserve a selected task due/reminder day by serializing noon in the person's saved
  timezone. Reuse the existing wall-time conversion algorithm in an isolated locale helper.
  Seed recurrence from the selected local date, never the UTC representation of its timestamp.
- PLAN-04: Roll Today completion back on a rejected write, block repeated pending activation,
  show recovery feedback, and update mounted Today/Tasks rows when server status changes.
- PLAN-05: Month navigation changes exactly one month at 28/29/30/31-day boundaries in both
  directions, including year boundaries. Day/week navigation is unchanged.
- PLAN-06: Existing tags, subtasks and comments continue to save immediately. Main task fields
  remain a draft. Explain this boundary and let Cancel, Escape and backdrop dismissal request
  the same explicit discard decision when unsaved changes exist.
- PLAN-13: Exercise posting from an actual task dialog, with native click and Enter. The
  coordinator owns shared modal recovery when a focused control disables or unmounts; this
  lane does not add a competing focus handler.
- PLAN-14: Refresh task-list metadata after implicit first-list creation, including the details
  create path. Quick capture also refreshes the saved list index; #3154's separate synchronous
  submission guard remains with its existing owner.
- CORE-05: Keep unavailable-calendar preview recoverable without losing choices. A retry reads
  availability again; an unavailable response still must not apply calendar changes.
- CORE-06: Morning handoff names saved blocks and actual activation-scoped outcomes, including
  failures, unknown or pending results and required confirmation. It never claims scheduling
  merely because automatic policy was selected.

## Reserved and excluded work

PLAN-03 is reserved to [#3392](https://github.com/motioneso/moss/issues/3392), which depends on
[#3390](https://github.com/motioneso/moss/issues/3390)'s canonical locale helper. No duplicate
calendar timezone or display-format implementation is added here. The independent month-overflow
repair stays in this lane.

[#3290](https://github.com/motioneso/moss/issues/3290) owns recurrence restrictions/scheduling and
partial-save recovery; its existing parent/subtask/tag retry semantics stay intact.
[#3234](https://github.com/motioneso/moss/issues/3234) owns provider-event provenance reconciliation;
this lane only repairs preview recovery and outcome wording.

Goal next-action/review and bulk planning are product opportunities. They require a separate small
design that reuses Tasks/Calendar and a product decision before features are built. Goal-memory
ownership (#3238), new task/goal data models, full calendar-client features, Workshop, Job Search,
Finance and Food/Meals are excluded.

## Verification

1. Run focused unit regressions against the unchanged baseline and retain their failing counts.
2. Cover local-date write/read round trips in UTC, UTC+12/+13/+14 and Los Angeles DST changes;
   cover both due/reminder fields and recurrence anchors, plus invalid timezone rejection.
3. Exercise failed completion, repeated pending activation and externally refreshed status.
4. Exercise task main-field discard versus already-committed comments. Preserve failed-input
   drafts and the existing partial-save retry regression.
5. Exercise unavailable preview followed by available preview, with no calendar apply while
   unavailable; keep revision/confirmation/idempotency rules unchanged.
6. Exercise saved morning handoff with applied, failed, pending/unknown, denied and confirmation
   states, rather than only generated-proposal fixtures.
7. Run scoped lint/format, root/test/web TypeScript checks and applicable static checks. Database
   tests and the aggregate foundation gate only run through `scripts/run-gate.sh` under its skill.
8. Provide executable live UAT assertions for goals via the real API-to-UI path, selected date
   persistence, month boundaries, comment focus/Escape/opener return, discard preservation and
   first-list metadata. Do not intercept or rewrite Moss network responses or capture screenshots.

Unit fixtures establish component/contract regressions, not installed live acceptance. No live
proof, merge, production change, deployment or publication is implied by focused test success.
Until real-UI proof and independent review are recorded, report code-complete, unverified.

## Proposed follow-on capability work: PLAN-09 and PLAN-10

These are feasibility proposals, not implemented features or an approved build scope. They need
an agreed design spec and their own task/PR before implementation.

### PLAN-09: Goal → next task → review

The existing Goal public type already contains `nextSuggestedAction`, `reviewCadence`,
`nextReviewAt`, progress and blocker summaries. Goal evidence supports `sourceKind: "task"` with
`sourceRef`; Tasks already has the ordinary create/detail/status contracts. There is no writable
`goalId` on a task and no goal-specific task model is needed.

Smallest useful UI handoff:

1. Make a Today goal row open a shared goal detail/review dialog. Show its saved next action,
   progress, blocker and review date, with a clear unavailable/retry state.
2. "Add next task" opens the existing TaskDetailsDialog as a new-task draft, prefilled from the
   saved action and goal context. Creating it remains an explicit user action; no task, calendar
   placement or goal progress is silently inferred from opening the dialog.
3. After task creation, offer an explicit link to the goal using the existing goal evidence POST
   (`evidenceKind: "task"`, `sourceKind: "task"`, `sourceRef: created task id`). The UI must verify
   that task through the actor-scoped Tasks API before opening it. A task pointer is not an access
   grant. If linking fails, preserve the created task and offer recovery; never recreate or delete
   the task as rollback. The current evidence API has no idempotency token, so ambiguous responses
   must be reconciled rather than blindly reposted.
4. "Review goal" edits the existing progress, blocker, next-action and next-review fields through
   the Goal PATCH contract. Task completion is evidence, never automatic goal completion.

Public boundaries: Goal types are exported from `@moss/goals`; route handlers live in
`packages/goals/src/routes.ts`. The web client currently exposes only goal listing. Add small
client methods for the existing GET/PATCH/evidence POST, not cross-module repository imports.
The public `goalGetExecute` tool includes evidence, but HTTP GET `/api/goals/:id` currently returns
only the goal; there is no HTTP evidence-list route. A persisted list of linked tasks therefore
needs a separately approved public read endpoint or a deliberately narrower first release that
only offers task creation and manual goal review. Do not claim evidence history is already
available to this UI.

Product choices to settle: whether evidence linking belongs in the first release; whether a goal
can have one current next task or many evidence-linked tasks; what to show when no next action is
saved; whether review dates are manually chosen or advanced by an explicit cadence rule. Existing
`nextReviewAt` supports a manual first release. Automated review scheduling and memory sync remain
with the Goals owner, including #3238.

Separate follow-on PR: goal detail/review and ordinary TaskDetailsDialog handoff, client-boundary
regressions, failure/retry and no-duplicate-parent coverage, ownership/privacy tests for any new
read endpoint, authored UI/app-map updates, and installed live proof. No new task data model,
automatic scheduling or unapproved bulk operation.

### PLAN-10: Reduce repeated planning navigation

Today already opens ordinary task details from its reader, task-block review and Plan tomorrow.
Those call sites close the current modal first to respect the shared inert/focus lifecycle, but
TaskDetailsDialog close currently returns to Today rather than the prior planning context.

Smallest useful change: remember the origin and its existing opener when opening task details;
after save or the explicit discard/close decision, restore the same reader/review/Plan tomorrow
step and preserved choices. Keep only one modal mounted at a time, use the shared lifecycle, and
restore focus to the relevant task row. A failed save stays in task details. The existing Today
controllers already hold review/planning state outside those modal bodies; use them rather than
a parallel cache or separate planner.

A later optional improvement could add previous/next task controls to that same dialog for a
selected planning queue. It must show progress, preserve pending/discard decisions between tasks,
and keep each write under the existing Tasks API. Existing draft replacement and apply batches
already support one reviewed activation; retain their per-item outcomes and required move/remove
confirmation. Do not infer approval for all task edits from queue selection.

Product choices to settle: whether closing task details always resumes the origin or includes
an explicit "Back to plan" action; whether queue navigation is needed in the first release; and
which tasks enter that queue. Start with the return-to-origin fix in a separate small PR, with
keyboard/pointer, failure, discard, repeated activation, changed-plan and focus-return UAT.

## Repair verification disposition

- Implemented: PLAN-01/02/04/05/06/13/14 and CORE-05/06. PLAN-13 uses the coordinator's shared
  modal lifecycle repair. The PLAN-14 quick-capture list-index repair is included below.
- Reserved: PLAN-03 stays with #3392/#3390. PLAN-09/10 above remain proposals, not built.
- Observed baseline: 22 failing / 74 passing tests in the first bounded regression run; the
  corrected actual Goal route/client/Today seam independently failed once before the repair.
- Final component evidence covers date round trips, recurrence day anchors, month boundaries,
  mounted task refresh/failure/repeat activation, discard/partial-save retention, unavailable
  preview recovery, saved handoff outcomes, real TaskDetailsDialog pointer/Enter comment controls,
  Escape/opener return, and existing Today reader/accessibility/state behavior.
- Focused lint/format and file-size, dependency, design-token, UI-class, migrated-section,
  UI-catalogue, ambient-date and no-dev-password scans passed. The Today failure announcement
  was corrected to polite status after the existing accessibility regression rejected alert.
  New task/calendar metadata follows the registry's 240-character and transient-error rules;
  app-map generation passed with every changed feature and recovery entry present.
- Root TypeScript's initial default-heap attempt aborted from heap exhaustion; it reached no
  diagnostic verdict. Final root/tests/web checks are assigned to the coordinator's serialized
  4096 MiB queue. This lane does not claim a typecheck or aggregate-gate pass.
- Live UAT and DB/integration checks remain unrun: the supported gate launch exits 4 because
  Docker is unavailable. No direct database bypass was attempted. The authored UAT needs its
  ephemeral installed stack, capture disabled, and real browser execution before live acceptance.
- Independent review, final integrated checks, current owner-head verification and publication
  approval remain required. The honest disposition is code-complete, unverified; no merge or
  deployment is authorized by these receipts.

## Independent-review corrections

The first independent review found five interrupted-flow gaps. The bounded corrections retain
existing APIs and the reserved-owner boundaries:

- A delayed saved-locale read now updates untouched fields individually while preserving genuine
  edits. Untouched due/reminder timestamps retain their exact stored instant on save; edited date
  controls retain the selected local day. No Calendar timezone work is added.
- Main task saves and immediate comment/tag/subtask writes are mutually guarded synchronously.
  Main save and dismissal wait for immediate writes, so a delayed failure retains its input and
  the dialog. Existing partial-creation retry behavior remains covered.
- Evening activation snapshots prior per-block reports. Old same-block applied/failed/unknown
  results cannot settle a new move; only new reports count. Denial and confirmation feedback is
  activation-scoped as well, with successful reports clearing stale denial feedback.
- A failed Tasks toggle restores the latest confirmed state, including a newer server refresh.
- Completion/reopen writes use the chosen checkbox intent before the delayed list refresh. A
  subsequent failed reopen restores the last successful write rather than stale list props.

Lasting regressions observed the four task/dialog failures before correction. Three old-outcome
activation cases also failed with the activation guard removed, then passed when restored.
The saved-locale tests cover untouched dates/reminders and separately edited due/reminder controls;
write-guard tests cover delayed comment, tag and subtask failures. Final typechecks and re-review
remain required before publication; live acceptance is still Docker-blocked.

A follow-up review reproduced a late completion success overwriting a newer server reopen in
both row types. Each write now captures the observed server-status generation; success advances
the rollback baseline only when no newer authoritative status was observed. Both lasting tests
failed before this guard and passed after it, including a subsequent rejected completion.
The generation observes task identity, status and the existing server `updatedAt` version, so a
newer same-status snapshot also supersedes a pending optimistic write. A repeated unchanged
snapshot does not erase a successful local write before refresh. Both variants have row-level
regressions; the newer same-status cases also failed before the version dependency was added.

## Quick-capture first-list metadata correction

Final audit reconciliation found that the details-create regression did not cover quick
capture. The actual TaskCapture success path now invalidates the saved task-list metadata
before refreshing task rows, so implicit first-task creation exposes Personal without a reload.
The existing `tasks.list_metadata_refresh` declaration covers both create paths.

The new mounted `audit-planning-task-capture-lists.test.tsx` uses the actual component and an
active, 15-second-fresh empty list query. Before the fix, the successful first task left the
list index empty (one intended failure); rejected creation retained the title without
inventing list metadata (one passing control). After the two-line repair, both cases and
22 details regressions pass: 24/24. Scoped lint, formatting and whitespace checks pass.

The active #3154 snapshot `37492bd0be28d2a96b9b2e949cee0c47671ddb22` changes the same
file's synchronous submission guard, not its list refresh. A three-way merge of this exact
bounded repair with that owning file succeeds and retains its guard/onSettled behavior.
No admission, scheduling, API or task-model change is added here. Real installed capture
and DB persistence acceptance remain unrun; final corrected-head types and review are separate.
