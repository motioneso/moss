# Settings reminder list, slice A of #3133

Base: integration/scheduled-proactive. Part of #3133. No migration.

## Scope and current seams

Implement the read-only part of the approved scheduled tasks spec, using the accepted
#3101 layout with current design primitives. Settings has no scheduled tasks pane today.
Pause, resume, deletion, editing, recurring work and watches remain later slices.

- Reminder storage already holds instruction, due time, deadline, state, delivery/expiry
  timestamps and the reserved message ID: packages/db/src/types.ts:1026.
- Owner-scoped reads already use DataContextDb and explicit owner filtering:
  packages/chat/src/reminders/repository.ts:277. Settings must not use the chat list's
  ten-finished-reminder limit, since older records remain inspectable.
- HTTP authentication and actor transactions are established in
  packages/chat/src/routes.ts:684 and packages/chat/src/skills/routes.ts:35.
- Reminder requests already save atomically through decideReminderTurn:
  packages/chat/src/reminders/turn.ts:62; its only production caller is
  packages/chat/src/live/persistence.ts:519. Retain its signature and behaviour.
- Settings panes are lazy registered in apps/web/src/settings/settings-page.tsx:118.
  Core declarations supply their descriptions: packages/shared/src/app-map-core.ts:132.
- Shared RowIndex, RowButton, SectionHead, Badge, DisclosureToggle and EmptyState
  cover the list. Details are independent pieces, assembled by a small registry.
- The chat host currently opens a drawer, but has no message-target control:
  apps/web/src/shell/chat-controls-context.ts:8. View message needs a read-only
  persisted-message reader or a new drawer target seam; see the approval decision below.

## Contracts and decisions

Add packages/shared/src/scheduled-tasks-api.ts, exported from its index. Define
ScheduledTaskDto, ScheduledTaskRunDto and ListScheduledTasksResponse plus the response
and route schemas. GET /api/chat/scheduled-tasks returns the owner's reminder records.
Each record carries id, title/instruction, group (Reminders), state, dueAt, deadlineAt,
createdAt and runs. Active, paused, completed, expired, failed and cancelled are UI
states; queued maps to active and delivered to completed. Paused is renderable only,
because existing storage cannot set it until slice B.

Read in packages/chat/src/reminders/settings.ts with a separate repository query and
register in packages/chat/src/reminders/routes.ts, then one registration in routes.ts.
Join the reserved message only when it exists and is an assistant message in the same
thread. History comes from real delivery/expiry timestamps; failed records get truthful
failure guidance, without inventing an execution timestamp. Creation and cancellation
are not runs. No arbitrary finished-record truncation.

Approved View message choice: show the saved assistant body with MarkdownMessage in
shared Dialog, without explanatory copy. Open chat selects the actual conversation
that holds the message. This differs from the mockup, which opens the result in chat;
the PR must say so.

Keep Reminders as a group identity independent of delivery type, so later one-time
read checks use the same rows and group without a restructuring. Do not advertise
unsupported task kinds. Hide future timing on completed, expired and cancelled tasks.
Display saved local timing using the user's current clock/timezone preferences.

Split turn handling into commands/request.ts, commands/clock-request.ts,
commands/list.ts and commands/cancel.ts with a shared command context and one-line
registry entries in commands/registry.ts. Unsupported/main-only guard behaviour remains centralized.
Move list/cancel recognition into their command files and reuse the same registry
for recognition and execution. Keep recognition behaviour, wording, validation, capacity lock and transaction timing unchanged.

Add apps/web/src/settings/settings-scheduled-tasks-pane.tsx, task list and detail
components, with detail pieces in scheduled-task-details/instruction.tsx, timing.tsx,
status.tsx and history.tsx. A registry assembles them. Register Scheduled tasks in the
assistant settings group. Local CSS owns only layout; shared primitives own visuals.
Selection reveals details with Back to all tasks and restores focus on return.
Past tasks is collapsed by default. Refetch on focus and periodically while visible
so a delivered reminder leaves the active list. Loading, retryable error and useful
empty states use current primitives and show no fake records.

Update core settings, chat manifest feature/errors/remediations and route metadata
in the same change. Add the UAT spec and its trigger-map row.

## Determinism and risk

The list, status, timing, history and result reader render persisted records, never
model output. This slice gives the model no new jobs; existing chat reasoning and
ordinary replies stay as they are. No new prompt or model-authored stored field.
Existing reminder commands remain code-written and transaction-bound. Principal risks
are accidental command behaviour drift and showing a result outside its owner scope.
Check these through existing command tests and actor-negative integration tests.

## One delivery phase and checks

1. Add failing behaviour checks, implement read contracts/query/route and command split.
   Integration cases: empty account, exact owner list, another owner and shared-thread
   non-owner cannot see reminders, queued/delivered/expired/cancelled/failed records,
   history date and exact message association, absent/deleted messages, unchanged rows.
   Unit cases: existing command outcomes stay identical; group/state mapping and details
   omit obsolete timing; paused renders without mutation controls.
2. Implement Settings wiring and separate detail pieces. Unit/render checks cover
   loading/error/retry/empty, row selection, collapsed history/Past tasks and no controls.
3. Add tests/uat/specs/3133-settings-reminders-real.uat.spec.ts and a trigger row in
   .claude/skills/coordinate/uat-trigger-map.tsv. On an own disposable install, through
   the real UI with Claude CLI sign-in and the cheapest discovered model: fresh-account
   empty state, ordinary chat sanity reply, real reminder creation, active details,
   delivery once, Past tasks/history and View message, reload, desktop/phone and
   light/dark/Teal. No network interception. Claim/release a devports port.
4. Run scoped unit tests; run database tests only through scripts/run-gate.sh using a
   scoped package script test:integration:3133. Then run the full foundation gate by
   that same runner. Expected exit 0; wait --follow as one background command. Run
   pnpm format:check, pnpm lint, pnpm typecheck and the design checks, all unpiped with
   expected exit 0. Rebase against origin/integration/scheduled-proactive before push.
5. Commit explicit files, push, open PR against integration/scheduled-proactive with
   Part of #3133 and Release note Category: N/A. Read CI. Post bounded live proof as
   a PR comment or report code-complete, unverified. Stop all own processes and release
   ports before reporting the PR to the coordinator.

Kill gate: if the real reminder created through chat cannot be inspected with accurate
history through Settings, do not call this slice complete or add slice B controls.
The coordinator owns the decision to repair or re-slice.

## Rulings

- Boot brief limits #3133 to read-only slice A and defers management to slice B.
- One-time read checks belong under Reminders, titled by what they check.
- No notification/delivery implementation edits; #3134 owns those in parallel.
- Coordinator approved the plan and saved-message Dialog. Use MarkdownMessage with no
  explanatory copy; Open chat must open its actual thread. State the mockup deviation
  in the PR body. Prove updates through reload or periodic refresh, never fake focus.
  Declare the route in the chat manifest before starting the server.
