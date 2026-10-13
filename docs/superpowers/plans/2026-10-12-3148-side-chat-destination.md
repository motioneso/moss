# Send saved task results to a named side chat

Part of #3148. Base: integration/scheduled-proactive. Risk: sensitive.
Status: rebased onto 73509bac9. Rebuilt 0320 from 0319, preserving repeat advancement and task-check guards. Settings destination details added; verification and live proof remain open. One edit guidance change used to add destination while retaining both timing examples.
Worktree: ~/Jarv1s/.claude/worktrees/sched-3148-side-chat-dest.
Migration assignment: 0320, in packages/chat/sql.

## Scope and precedence

Implement the approved scheduled tasks spec's conversation identity, ordinary-chat
creation, task controls, and routing acceptance criteria. Main remains the default
even for a task created in a side chat. An explicit destination is an owned,
non-private drawer conversation. Creation and destination-only edits save without
action approval. Settings shows a non-default destination in task details.

An unavailable destination ends the firing as failed, with actionable Settings
guidance. It posts neither the private result nor a substitute result to Main.
This follows the issue's explicit prohibition on silent rerouting. A missing or
ambiguous destination at creation/edit saves nothing and names the recovery.

No navigation, new notification transport, action editor, recurrence, or source
read implementation. Do not change the scheduled-read files owned by #3151 or
the list grouping owned by #3136. Rebase on the integration branch when those
lanes land and reconcile shared enqueue call sites without adding an editor.

## Verified seams and gaps on this branch

| Capability                                 | Evidence                                                                                                                                      | Required change                                                                                    |
| ------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------- |
| Stable Main and exact owned thread lookup  | packages/chat/src/repository.ts:163 and :495                                                                                                  | Reuse Main selection and owned identities; never select by recent activity.                        |
| Creation transaction and shared enqueue    | packages/chat/src/reminders/commands/save.ts:9; packages/chat/src/reminders/deliver.ts:64                                                     | Resolve destination under owner access, then store it with the accepted record.                    |
| Reminder edits and version invalidation    | packages/chat/src/reminders/edit.ts:106 and :145                                                                                              | Extend terms and field diff; enqueue the new version through the existing helper.                  |
| Raw owner edit routing                     | packages/chat/src/live/pre-model-turn.ts:109; packages/chat/src/live/persistence.ts:215                                                       | Permit owned drawer side chats while retaining private/module refusals.                            |
| Owner source and Main-only worker policies | packages/chat/sql/0306_chat_relative_reminders.sql:128; packages/chat/sql/0311_chat_local_clock_reminders.sql:153                             | Separate the source message's identity from the delivery identity; authorize both explicitly.      |
| Delivery lock and reserved result ID       | packages/chat/src/reminders/deliver.ts:86 and :120                                                                                            | Recheck and lock the current destination before inserting the reserved message.                    |
| Committed arrival read                     | packages/chat/src/reminders/live-arrival.ts:75                                                                                                | Read the owned destination instead of requiring Main.                                              |
| Server drawer filtering                    | packages/chat/src/live/background-message-routing.ts:28                                                                                       | Route by destination identity and current selection, keeping switch/privacy guards.                |
| Browser filtering and reconnect            | apps/web/src/chat/use-chat-stream.ts:134 and :210                                                                                             | Replace blanket side-chat dropping with exact destination identity filtering.                      |
| Drawer switch binding                      | apps/web/src/chat/chat-drawer.tsx:117 and :657                                                                                                | Bind the shown owned drawer thread for Main and side chats.                                        |
| Reminder context and slot release          | packages/chat/src/reminders/repository.ts:258; packages/chat/src/live/main-reminder-context.ts:29                                             | Let a reply in the exact destination acknowledge its delivered reminders. No cross-thread context. |
| Settings DTO, serialization, detail pieces | packages/chat/src/reminders/settings.ts:39; packages/shared/src/scheduled-tasks-api.ts:32; apps/web/src/settings/scheduled-task-detail.tsx:10 | Add destination metadata and a small details piece, using existing primitives.                     |
| Real model proof                           | tests/uat/specs/3135-reminder-edits-real.uat.spec.ts:1; tests/uat/specs/real-chat-signin.ts:1                                                 | Reuse disposable provisioner, Codex sign-in and economy discovery.                                 |

The graph index did not contain the current reminder functions, so these citations
were verified in bounded reads of this worktree. Issue #3148 has no comments at
planning time. The existing Main-only restrictions are current gaps, not shipped
side-routing functionality.

> 🧠 **From Hindsight memory (Edit saved reminders in chat (#3135))** - The prior edit lane established chat editing with deterministic confirmations and the shared enqueue seam. The cited current code confirms those seams; its recorded in-flight status is not used as current status.

## Storage decision

Reuse chat_reminders.thread_id as the delivery identity. Add only a nullable
destination_title snapshot: null means Main; otherwise it holds the accepted side
chat title. A title rename does not redirect the task. Store IDs, not title lookups,
for execution. No new task table or scheduler.

Migration packages/chat/sql/0320_chat_reminder_destinations.sql will:

```sql
ALTER TABLE app.chat_reminders ADD COLUMN destination_title text;
ALTER TABLE app.chat_reminders ADD CONSTRAINT chat_reminders_destination_title_shape
  CHECK (destination_title IS NULL OR length(btrim(destination_title)) > 0);
ALTER TABLE app.chat_reminders DROP CONSTRAINT chat_reminders_thread_id_fkey;
ALTER TABLE app.chat_reminders DROP CONSTRAINT chat_reminders_source_message_id_fkey;
GRANT UPDATE (thread_id, destination_title) ON app.chat_reminders TO jarvis_app_runtime;
```

Dropping those cascading references preserves a saved task when its destination
or original source chat is deleted. Otherwise deleting a side destination that
also contains the creation turn would erase the task instead of showing failure.
The IDs remain immutable provenance/delivery references except an explicit pending
destination edit. Existing rows need no backfill: their thread is Main and their
new title is null.

Replace the insert policy to require an actor-owned user source message in an
owned, non-private drawer thread, and a current owned non-private drawer
destination. Main must be the designated Main when destination_title is null.
Sharing never grants destination authority. Validate the title against the owned
destination at acceptance, rather than accepting model-authored labels.

Replace the update trigger using the existing 0319 lifecycle, repeat and task-check rules: permit a
pending destination change only with version increment, retain all identity,
time/deadline, lifecycle, and reserved-result checks, and check the reserved
message against the current destination. Revalidate a changed destination under
owner access. Ordinary pause/cancel/failure updates must work even if that
destination no longer exists. Select and owner-control/delete policies become
owner-only, so the owner can inspect and remove failed tasks after target loss.

Replace the worker message-insert policy to require the exact current queued
reminder's reserved ID, owner, destination ID, assistant role, stored status,
deadline and current owned non-private drawer target. Retain every other check.
The application will hold a share lock on the destination row through insertion
to serialize concurrent deletion/ownership changes. These are intended controls;
their security properties must be established by negative and mutation tests.

## Contracts and determinism

New packages/chat/src/reminders/destination.ts owns resolution and acceptance:
resolveReminderDestination(scopedDb, actorUserId, request, sourceThreadId) returns
either an owned destination { threadId, title } or a refusal with recovery text.
request is omitted for Main, a named chat, explicit Main, or this chat. Duplicate
names require a more precise request and never choose by activity.

Creation recognition strips an explicit trailing delivery clause before invoking
the existing time/text recognizer, then carries the requested destination in the
same request/clock_request plan. Include normal wording such as "send it to the
Travel chat", "send the results to Travel", and "in this chat". Reminder text
which merely mentions a chat is not a routing request. Requests outside this
bounded grammar stay ordinary chat or are refused without silently saving the
wrong destination.

Extend ReminderEditTerms and its schema with destination: string | null; null
keeps the current destination. "Main" is an explicit reset. Keep compatibility
for existing persisted edit proposals with the omitted field treated as keep.
No change to action, recipient or interruption permissions. Extend the narrow
edit recognizer for explicit "send ... reminder ... to ... chat" requests.

The model has two jobs: identify the owner's reminder and extract requested
inert terms, including the destination name. It cannot choose an owner, grant
access or supply an authoritative thread ID. Keep edit guidance under 150 words,
with field descriptions and a worked example. Validate the schema, the target
and destination against the raw authenticated request, resolve the destination
through owner access, and validate the field diff under the reminder lock.
Source/tool/retrieval content cannot set a destination.

Confirmations come from accepted record values. Non-default confirmations name
the resolved chat naturally; Main stays omitted. Destination-only edits preserve
timing and text, increment version, and enqueue only queued tasks. Paused tasks
remain paused. Ambiguous reminder choices use the existing typed-choice path.

Add backgroundThreadId?: string to TranscriptRecord; committed arrivals always
carry it. Rename MainBackgroundMessage/mainThreadId routing to the destination
contract throughout its callers. Backend and browser both compare that ID with
the shown thread after asynchronous reads. Keep message/turn deduplication,
pending-switch, privacy and module-surface checks. Reconnect fetches only the
currently shown thread and merges committed background records without replacing
a live response. Hydrated messages use their stored thread ID.

ScheduledTaskDto gains an optional destination object { threadId, title } only
for non-default destinations, with matching response schema. Optional preserves
existing consumers/fixtures. Add a destination detail piece and contextual failed
delivery guidance. Use existing text, Note and detail spacing; no new CSS or
navigation. Update packages/chat/src/reminders/features.ts and manifest.ts to
describe actual supported creation, editing, delivery and recovery.

## One phase, four build tasks

1. Storage and accepted destination: add migration/types/resolver; extend the
   existing creation and edit callers, validators, agreement parsing and wording.
2. Delivery and live transcript: authorize current destination, preserve failure
   visibility, carry thread identity through listener/session/browser routing,
   reconnect and destination-scoped pending context.
3. Settings and app map: add DTO/schema metadata and destination details; update
   feature declarations, fixture expectations, schema catalogue and existing
   Main-only tests whose behavior intentionally changes.
4. Verify and prove: add tests/uat/specs/3148-side-chat-destination-real.uat.spec.ts
   and blocking entries in .claude/skills/coordinate/uat-trigger-map.tsv for the
   changed routing, destination, settings and migration surfaces.

Tests ship with each task. Commit explicit paths only. Before each commit review
the full diff of any shared file; after commit verify its path list. Keep this
tracked plan current as the small session state record.

## Checks and live proof

Add tests/unit/chat-reminder-destination.test.ts for creation clauses, inert chat
mentions, default/Main/this-chat behavior, structured destination edits, ordinary
chat pass-through and malformed/fenced JSON. Extend existing unit tests for
wording, edit diff/proposal validation, owner-only live arrival, stream identity
and Settings details. Add tests/integration/chat-reminder-destinations.test.ts:
owner side creation with default Main, explicit owned side target, destination
edit with version race, paused edit, stale selection, wrong/shared/foreign/private/
module destinations, missing target and concurrent destination change/delete,
worker policy rejection and idempotent delivery. Update the schema catalogue.

Observe owner/destination security negatives fail with the corresponding new
enforcement removed on the isolated database, then restore it and rerun. Exercise
an owner change through authorized test setup, not runtime admin bypasses.

Commands, all unpiped, expected exit 0:

- pnpm exec vitest run tests/unit/chat-reminder-destination.test.ts plus the touched reminder, browser routing and Settings unit suites.
- scripts/run-gate.sh start --gate test:integration:3148 (add the scoped package script); scripts/run-gate.sh wait --follow.
- pnpm format:check; pnpm lint; pnpm check:file-size; pnpm typecheck.
- scripts/run-gate.sh start; scripts/run-gate.sh wait --follow on the final fingerprint.
- devports claim sched-3148; JARVIS_IMAGE_TAG=uat-sched-3148 with JARVIS_UAT_CLAIMED_WEB_PORT set to the claimed port and JARVIS_UAT_REAL_CHAT_PROVIDER=codex, pnpm exec tsx tests/uat/run-uat.ts 3148-side-chat-destination-real.

Live test uses the existing disposable from-source provisioner and shared real
chat sign-in helper. It discovers the cheapest economy model and exercises real
UI turns and real queue delivery, without intercepted or rewritten responses.
Create tasks from an existing owned side chat with default and explicit targets;
edit a target before firing; verify both durable histories and IDs after reload;
check Main arrival while the side draft is focused; check side arrival alongside
a real live reply without replacement; inspect destination and failure recovery
in Settings at desktop/phone widths and light/dark/Teal states.

If #3126 prevents the UI from creating/opening a side chat, use existing side
identities for routing proof only and report exactly which navigation step could
not be demonstrated. Do not claim new-side-chat navigation acceptance. If no
real UI path can demonstrate routing, report code-complete, unverified.

Kill gate: after the first integrated proof attempt, if the economy model cannot
interpret a destination-only edit, allow at most one prompt correction. If still
unreliable, or the absent #3126 path prevents meaningful real-UI proof, stop and
ask the coordinator to rule or re-slice. No accumulating prompt patches.

## Finish and review ledger

Before push fetch/rebase origin/integration/scheduled-proactive, then run the
required checks. Push scheduled/3148-side-chat-destination and open the PR against
integration/scheduled-proactive. Body says Part of #3148; Release note Category:
N/A, because PR #3154 owns the release note. Post real proof as a PR comment,
read CI, stop all session-owned servers by PID, tear down credentials/containers,
release the claimed port, and leave this worktree clean. Report the PR and precise
verification status to coordinator. Never merge or change board/milestones.

Coordinator approval: plan commit 185e8dc31 approved. Conditions:

- Preserve the owner_user_id ON DELETE CASCADE reference; integration test owner deletion with both live and already-deleted destinations.
- After #3151 lands, retain subscribe-then-catch-up and dedupe; escalate conflicting routing changes before resolving.
- Rebuild 0320 from #3136 migration 0319 when it lands, retaining queued advancement and runs-table rules; destination checks apply on every firing.
- If context runs short, stop after tasks 1 and 2 with an open PR and state note. No handoff.
- Coordinator messages use pane w1:p19D; the inherited environment's w3:p6 value was stale.

## Finish state

Rebased onto integration head 73509bac9. Migration collisions check passed.
Migration 0320 now starts from 0319, preserving repeated firing advancement,
immutable runs, owner-runtime edits, interval/local cadence and task-check guards.
Settings exposes the accepted destination and actionable failure guidance without
changing repeat groups. The app map includes these details.

Coordinator routing conditions for the finish:

- Apply exact destination filtering to live arrivals and catch-up history.
- Keep the message ID dedupe key. A live/catch-up duplicate appears once.
- Main and side-chat results never appear in each other's transcript.
- Preserve 3136 repeat logic and both timing examples in its edit guidance.

The guidance change is used; no further prompt tuning is available. It remains
under 150 words. Focused units passed 100 tests. The scoped isolated integration
gate passed 107 tests, including repeat side delivery, deleted destinations and
mutation checks for worker insertion, destination edits, persisted-run advancement
and the one-time task-check guard. Protection removal allowed the prohibited
operations, then restoration rejected them again.

The final foundation gate, final-head live proof and CI are pending. The live spec
covers existing Conversations drawer controls, creation from a side chat, default
Main, an explicit side target, a destination-only edit, focused draft preservation,
durable distinct histories, reload, destination details at two widths and three
themes, and simulated owner deletion of a target. That deletion uses the disposable
install's owner RLS because the current drawer has no delete control. This does not
prove the unfinished #3126 accepted overlay or its full navigation acceptance.

Live setup uses the shared disposable provisioner, image tag uat-sched-3148,
a claimed port, Codex sign-in helper and one pinned economy model. No network
response rewriting. Rerun 3135 edit and 3136 repeat browser specs on the same head.
Current pane: w1:p19H. No successor or helper agent spawned.

Coordinator approved the narrow scheduled-read runner exception after 3151 merged.
Only the destination check in load changes to the existing owned-target lock.
Creation remains Main-only. Integration coverage checks side delivery and deleted
or foreign targets, with the check removed to observe failures. PR 3502 must keep
this validation in its second load immediately before posting when it lands.

Runner evidence: the Main-only version failed the available-side case. Removing
the check failed deleted and foreign cases at insertion instead of marking the
task failed. Restored owned-destination validation passed all 110 tests in the
eight-file isolated suite. Full gate and live UI proof remain pending.

The first real UI run found that send it to this chat was normalized to this.
The owner resolver honestly refused the missing target. A unit regression failed
with that value, then the parser was corrected to preserve the special phrase.
This is deterministic parsing, with no further model guidance tuning. The first
full gate was stopped with rc 143 because the proof found this correction.

Coordinator ruled that clear destination-only edits must use code ahead of the
model if the model refused. The captured assistant refusal matches the branch
entered only after a validated model response sets unsupported true. Destination
resolution and empty edits have different replies. The raw one-shot transcript
is purged by the adapter, so its original JSON cannot be quoted. Explicit named
reminder or task destination edits now reuse target matching and the existing
editor, including ambiguity, row locks and owned-target validation. Combined
edits remain on the model path. Guidance stays unchanged. Final live proof must
run two destination-only edits and one combined text and destination edit with
gpt-6-luna pinned, stopping without tuning if the combined edit fails.
