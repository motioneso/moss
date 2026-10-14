# Pause, resume and delete reminders

Part of #3133, slice B. Base: integration/scheduled-proactive. Migration: 0313.
Approved spec: docs/superpowers/specs/2026-10-07-scheduled-tasks-and-proactive-messaging.md,
Responsibilities and user controls, Recovery and lifecycle, and Testing Decisions.

## Scope and seams

Keep slice A's list, detail pieces and per-command registry. Add pending-reminder
pause/resume in Settings and Main chat, and confirmed deletion in both. No editing,
quiet-hours exceptions, watches, recurring scheduler, or notification link changes.

Current baseline is 27c7c6266. PR #3473 is open. Read its remote branch before planning;
do not edit delivery or worker files until the coordinator confirms its merge, then
rebase on integration/scheduled-proactive and check these seams again.

- Settings already reads owner records through an authenticated actor transaction:
  packages/chat/src/reminders/routes.ts:20 and settings.ts:62.
- Independent detail pieces have a small registration list:
  apps/web/src/settings/scheduled-task-detail.tsx:9. The selected record comes from
  the refetched query, not a separate saved copy: settings-scheduled-tasks-pane.tsx:20.
- The public Settings state already includes paused:
  packages/shared/src/scheduled-tasks-api.ts:3. Storage does not:
  packages/db/src/types.ts:1022 and packages/chat/sql/0311_chat_local_clock_reminders.sql:31.
- Delivery locks the reminder row before reading state/version and holds that lock
  through message persistence: packages/chat/src/reminders/repository.ts:142 and
  deliver.ts:76. Owner cancellation uses the same lock: repository.ts:293.
- Production reminder handling runs before the model and within the stored turn:
  packages/chat/src/live/pre-model-turn.ts:33 and live/persistence.ts:519.
  Existing module-control and Main/incognito guards remain mandatory.
- Command recognition and execution already have per-command registrations:
  packages/chat/src/reminders/commands/registry.ts:7 and commands.ts:15.
- Existing delete/remove words currently cancel immediately:
  packages/chat/src/reminders/commands/cancel.ts:19. Replace those aliases with a
  separate delete request and typed confirmation; preserve explicit cancel behavior.
- Persisted assistant origin is available for a deletion question:
  packages/shared/src/chat-api.ts:275 and packages/chat/src/route-serializers.ts:156.
  A narrow query must bind confirmation to the preceding owner turn in this thread;
  assistant-only reminder arrivals must not replace that pending question.
- Shared Dialog supports safe initial focus and modal lifecycle:
  packages/ui/src/dialog.tsx:16 and docs/design-system.md:272.
- On #3473's branch, chat owns notification lifecycle checks through
  packages/chat/src/reminders/notifications.ts:isReminderNotificationActive and
  repository.ts:readNotificationResult. Use that public check; do not add chat table
  queries inside notifications. A removed reminder must fail it.

The graph search returned no reminder symbols, so current worktree source supplied
the citations. No new platform scheduler, dependency, or Settings layout is needed.

## Storage and service contracts

Add packages/chat/sql/0313_chat_reminder_controls.sql and register it in the chat
manifest and tests/integration/foundation-schema-catalog.test.ts.

DDL decisions:

- Replace chat_reminders_state_check with states queued, paused, delivered, failed,
  cancelled and expired.
- Preserve immutable identity, instruction, timing, reserved message and completed
  delivery/expiry fields. The update trigger permits queued -> paused and paused ->
  queued, incrementing version exactly once for each transition. Existing delivery,
  failure, expiration, cancel and context transitions retain their guards.
- The owner update policy and column grants permit state and version transitions,
  but never worker-only delivery. Paused reminders can also be explicitly cancelled.
- Count paused reminders against the existing 20-open-reminder limit. Pausing does
  not let an owner evade the cap or make resume exceed it.
- Grant DELETE to jarvis_app_runtime with an owner-only policy using the existing
  owner/thread predicates. Delete only the reminder row, never its source/result
  messages. Existing queued jobs then observe a missing record.
- Keep worker delivery and reserved-message insert policies restricted to queued
  records. No worker grant to resume or change instruction/identity.

Add packages/chat/src/reminders/controls.ts with shared actor-scoped operations:
pauseReminderById(scopedDb, id), resumeReminderById(scopedDb, boss, actorUserId, id),
and deleteReminderById(scopedDb, id, expectedVersion?). Each takes the existing row
lock and returns a typed outcome: changed, unchanged, missing, or not_pending.
Resume enqueues the incremented version in the same transaction. Preserve due time
and deadline: overdue resumed reminders deliver once with existing late wording,
or expire if their explicit deadline passed. Repeated resume does not enqueue again.

Deletion may remove pending and past records. A chat confirmation carries the exact
record ID/version; if that record changed while awaiting agreement, refuse and ask
again. Keep the same behavior through Settings and chat. No control creates a run.

Settings routes: POST /api/chat/scheduled-tasks/:id/pause, POST .../:id/resume,
DELETE /api/chat/scheduled-tasks/:id. Add shared route schemas and browser client
functions. Validate UUIDs and bodies; return 404 for missing/foreign rows and 409
for a pending-only action on a finished record. Exclude these mutations from model
app-action dispatch: they are Settings controls; chat uses typed owner commands.

## One implementation phase

1. After approval, implement storage, controls and actor/race tests. Update db types,
   Settings state mapping, list/wording and explicit cancellation for paused rows.
   Add a narrow controls repository if needed rather than growing unrelated files.
2. Add commands/pause.ts, resume.ts, delete.ts and confirm-delete.ts plus one-line
   registry entries and typed plan variants. Reuse matchTarget but refuse ambiguous
   matches rather than deleting another record. Raw typed pause/resume is agreement.
   Delete/remove asks an ordinary question naming the record; exact typed yes acts,
   no declines, and revised/ambiguous/intervening owner turns invalidate agreement.
   Store the question's trusted origin with record ID/version. Recognize yes/no only
   when this thread has that pending question; ordinary yes stays ordinary chat.
   Put pending lookup/confirmation in a narrow new helper with minimal live wiring.
   Reject side chats, incognito, module-controlled turns and model-produced approval.
3. Add scheduled-task-details/controls.tsx and one detail registration. Use Button
   and Dialog, initialFocusRef on Keep task, pending disabled actions, server-derived
   state, actionable failure text and query invalidation. After deletion show the
   existing list and move focus to a surviving list heading/control. Retain current
   desktop/phone layout and verify light, dark and Teal.
4. After #3473 merge clearance and rebase, extend delivery's state/version check to
   paused and missing outcomes. Recheck immediately before the reserved message is
   inserted while holding the row lock. This serializes controls against an admitted
   firing: a control that commits first blocks the firing; a firing that owns the
   lock first completes before the control reports its actual finished state.
   Keep the pause step independent of quiet-hours policy. Verify deletion suppresses
   queued notification creation and push retries using #3473's existing public check.
5. Update packages/shared/src/app-map-core.ts and packages/chat/src/manifest.ts for
   actual controls, typed deletion agreement, pending-only limits and recovery.
   Update old tests that assert the list has no mutation controls.

Determinism boundary: UI state and all command replies derive from saved records.
The model has only two existing jobs: ordinary conversation and interpreting ordinary
non-command requests. It does not choose lifecycle targets or grant deletion authority.
No module injects turns into host chat. No new model guidance or authored user values.

## Behavioral verification and live proof

Add tests/integration/chat-reminder-controls.test.ts and unit command/UI tests.
Extend test:integration:3133 to include delivery, permissions, schema catalog and
#3473 notification regressions. Expected failures against broken enforcement:

- Paused queued job posts nothing; delete-before-job posts nothing.
- In-flight attempt delayed before lock observes committed pause/delete and posts
  nothing; a worker owning the row lock wins first without a misleading success
  acknowledgement from a later control.
- Old-version job after pause/resume does not post; new job posts once. Concurrent
  resume, duplicate new jobs and retry do not duplicate messages or notifications.
- Expired deadline on resume produces the existing expiry result, not a message.
- Foreign actors and runtime roles cannot pause/resume/delete another owner's record;
  workers cannot resume. Paused rows still count against the cap.
- Delete preserves earlier messages/effects; controls never appear as run history.
- Delete request without typed yes changes nothing, no declines, stale/foreign/side
  context and intervening turns cannot approve, and stopped/failed turns roll back.
- Settings Keep task receives initial focus; pending/error paths keep a usable control
  and correct record state; both interfaces operate the same record after reload.

Observe one race test fail with the worker state/version recheck removed, and observe
the typed-confirmation negative fail with its guard removed; restore both protections
and record the failing/passing results. Do not claim an unobserved security assertion.

Add tests/uat/specs/3133-reminder-controls-real.uat.spec.ts and blocking rows in
.claude/skills/coordinate/uat-trigger-map.tsv. Adjust slice A UAT's no-controls assertion.
Live test: real owner signup/sign-in and economy Claude model on our own disposable
from-source install; create a near-future reminder in chat, pause from Settings, wait
past its due time and assert no message, resume from chat/phone and receive it once,
open result/history, then delete another pending reminder through Settings with safe
focus. Exercise chat delete refusal and typed yes on the same record identities.
Use bounded DOM/network assertions, no interception or rewritten responses, and post
the executable evidence as a PR comment. Use devports claim sched-3133b and image tag
uat-sched-3133b; stop owned processes by PID and release the port afterward.

Commands, all unpiped, expected exit 0:

- pnpm exec vitest run tests/unit/chat-reminder-controls.test.ts tests/unit/settings-reminder-controls.test.tsx
- scripts/run-gate.sh start --gate test:integration:3133, then scripts/run-gate.sh wait --follow
- pnpm format:check; pnpm lint; pnpm typecheck; pnpm check:file-size
- scripts/run-gate.sh start, then scripts/run-gate.sh wait --follow
- JARVIS_IMAGE_TAG=uat-sched-3133b pnpm test:uat 3133-reminder-controls-real.uat.spec.ts
  (Use the real-model runner configuration established by the existing 3133 UAT.)

Kill gate: after this single phase, if real worker cancellation or typed confirmation
cannot meet these assertions, stop expansion and report to the coordinator for a
re-slice. Coordinator owns that call. No next feature phase is authorized here.

## Rulings ledger and finish

- 2026-10-11 brief: migration 0313 assigned; #3473 worker collision is a hard hold.
- 2026-10-11 Ben ruling supplied in brief: chat deletion requires owner's typed yes;
  confirmed Settings button press is agreement. No Settings editing, per accepted design.
- Proposed implementation decision for coordinator review: hard-delete reminder row,
  preserve all chat messages, and invalidate stale jobs by missing record/version.

Commit the plan before feature code, obtain coordinator approval, then build. Before
push, run required fast checks and rebase on origin/integration/scheduled-proactive.
Open PR against integration/scheduled-proactive with Part of #3133 and Release note
Category: N/A. Read CI, post live proof (or report code-complete, unverified), leave a
clean pushed branch, and report only ready-for-review or a concrete blocker.
